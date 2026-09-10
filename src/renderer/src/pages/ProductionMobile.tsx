// Mobile Production — website only (see the fork in Production.tsx).
//
// Built to the "Production — mobile" screen of the handoff: the four figures
// in a forest header, the recirculation card at the top of the list, the
// register grouped by day, and two write flows behind bottom sheets.
//
// The recipe arithmetic is lib/recipeMath's, the same module the desktop
// sheet and the main process use — the batch preview here previews what the
// server will actually post, or it is worse than no preview.
//
// SCOPE: one batch at a time. The desktop sheet enters a whole day's runs
// together with a running stock projection down the side, which is a
// spreadsheet and belongs on a screen that can hold one. Everything it can
// record, this can record — one row per visit rather than ten.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  X
} from 'lucide-react'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { expandRecipe, recipeTor } from '@/lib/recipeMath'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const round3 = (v: number): number => Math.round(v * 1000) / 1000
const isRecirc = (r: Row): boolean => String(r.kind || 'batch') === 'recirculation'

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

export function ProductionMobile(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [recipes, setRecipes] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState('')
  const [query, setQuery] = useState('')
  const [sheet, setSheet] = useState<null | { kind: 'batch'; row?: Row } | { kind: 'recirc'; row?: Row }>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setFailed('')
    try {
      const [r, p, f] = await Promise.all([
        window.api.production.list(),
        window.api.data.list('products'),
        window.api.formulations.list()
      ])
      setRows(Array.isArray(r) ? r : [])
      setProducts(Array.isArray(p) ? p.filter((x: Row) => n(x.active) !== 0) : [])
      setRecipes(Array.isArray(f) ? f : [])
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.product_name, r.formulation_name, r.subcategory_name, r.note].some((f) => s(f).toLowerCase().includes(q))
    )
  }, [rows, query])

  // Grouped by day, newest first — the register is read as "what did we run
  // on Tuesday", never as one long list.
  const days = useMemo(() => {
    const by = new Map<string, Row[]>()
    for (const r of visible) {
      const d = s(r.prod_date).slice(0, 10)
      if (!by.has(d)) by.set(d, [])
      ;(by.get(d) as Row[]).push(r)
    }
    return [...by.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, runs]) => ({
        date,
        runs,
        // Recirculation is excluded from the day's total for the same reason
        // it is excluded from Produced: nothing was made.
        total: runs.filter((r) => !isRecirc(r)).reduce((a, r) => a + n(r.qty), 0),
        batches: runs.filter((r) => !isRecirc(r)).length,
        recircs: runs.filter(isRecirc).length
      }))
  }, [visible])

  const kpis = useMemo(() => {
    const batches = visible.filter((r) => !isRecirc(r))
    const recircs = visible.filter(isRecirc)
    const total = batches.reduce((a, r) => a + n(r.qty), 0)
    return [
      { k: 'Produced', v: formatNum(round3(total)), fg: 'text-white' },
      { k: 'Batches', v: String(batches.length), fg: 'text-white' },
      { k: 'Days', v: String(days.length), fg: 'text-white' },
      {
        k: 'Recirculations',
        v: String(recircs.length),
        fg: recircs.length ? 'text-[#BBD5F2]' : 'text-[#C7F03F]'
      }
    ]
  }, [visible, days])

  if (sheet) {
    return sheet.kind === 'recirc' ? (
      <RecircSheet
        row={sheet.row}
        products={products}
        onClose={() => setSheet(null)}
        onSaved={async () => {
          setSheet(null)
          await load()
        }}
      />
    ) : (
      <BatchSheet
        row={sheet.row}
        products={products}
        recipes={recipes}
        onClose={() => setSheet(null)}
        onSaved={async () => {
          setSheet(null)
          await load()
        }}
      />
    )
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-4 pb-3.5 pt-3 text-white">
        <div className="min-w-0">
          <div className="text-[19px] font-extrabold tracking-[-0.02em]">Production</div>
          <div className="mt-0.5 text-[11.5px] font-bold text-[#8FBFA8]">
            {visible.length} run{visible.length === 1 ? '' : 's'}
            {query ? ' · filtered' : ''}
          </div>
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
            placeholder="Product, recipe or note"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} className="shrink-0 text-[#5A6B62]">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-24 pt-3">
        {/* The reason this page has a second write flow at all: when the mill
            stands idle the plant is still turning, and until now there was
            nowhere to say so. */}
        <button
          type="button"
          onClick={() => setSheet({ kind: 'recirc' })}
          className="flex items-center gap-3 rounded-[4px] border-[1.5px] border-[#7FA8D4] bg-[#EAF0FA] px-3.5 py-3 text-left shadow-[0_0_0_3px_rgba(127,168,212,.2)]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px] bg-[#1B4E82]">
            <RefreshCw className="h-[22px] w-[22px] text-white" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-extrabold text-[#1B4E82]">Record a recirculation</span>
            <span className="mt-0.5 block text-[11.5px] font-semibold leading-snug text-[#2B5C8F]">
              Plant kept turning while idle — no stock moves
            </span>
          </span>
          <ChevronRight className="h-[22px] w-[22px] shrink-0 text-[#1B4E82]" />
        </button>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-14 text-[12.5px] font-bold text-[#5A6B62]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the register…
          </div>
        ) : failed ? (
          <div className="rounded-[4px] border border-[#F0C8C4] bg-[#FDF3F2] px-4 py-8 text-center text-[12.5px] font-bold text-[#B3261E]">
            {failed}
          </div>
        ) : days.length === 0 ? (
          <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-12 text-center">
            <Inbox className="mx-auto h-7 w-7 text-[#C3D2C6]" />
            <p className="mt-2.5 text-[12.5px] font-bold text-[#0A1F17]">
              {query ? 'Nothing matches that.' : 'No production recorded yet.'}
            </p>
          </div>
        ) : (
          days.map((d) => (
            <div key={d.date} className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <CalendarDays className="h-[17px] w-[17px] shrink-0 text-[#0B3D2E]" />
                <span className="text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatDate(d.date)}</span>
                <span className="h-px min-w-3 flex-1 bg-[#DCE7DB]" />
                <span className="whitespace-nowrap text-[13px] font-bold tabular-nums text-[#0A1F17]">
                  {formatNum(round3(d.total))} MT
                </span>
              </div>
              <div className="-mt-1 text-[11px] font-bold text-[#5A6B62]">
                {d.batches} batch{d.batches === 1 ? '' : 'es'}
                {d.recircs ? ` · ${d.recircs} recirculation${d.recircs === 1 ? '' : 's'}` : ''}
              </div>

              {d.runs.map((r) => {
                const rec = isRecirc(r)
                return (
                  <button
                    key={String(r.id)}
                    type="button"
                    onClick={() => setSheet(rec ? { kind: 'recirc', row: r } : { kind: 'batch', row: r })}
                    className={cn(
                      'w-full overflow-hidden rounded-[4px] border border-l-[3px] bg-white text-left',
                      rec ? 'border-[#C6DAF0] border-l-[#1B4E82]' : 'border-[#D6E2D6] border-l-[#12855A]'
                    )}
                  >
                    <div className="flex flex-col gap-2 px-3.5 pb-2.5 pt-3">
                      <div className="flex items-start gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">
                            {s(r.product_name) || '—'}
                          </div>
                          <div
                            className={cn(
                              'mt-1 text-[11.5px] font-bold leading-snug',
                              r.formulation_name ? 'text-[#33473E]' : 'text-[#A8B8AE]'
                            )}
                          >
                            {rec ? s(r.note) || 'No reason recorded' : s(r.formulation_name) || 'No recipe'}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={cn('text-[15px] font-bold tabular-nums', rec ? 'text-[#1B4E82]' : 'text-[#0A1F17]')}>
                            {formatNum(r.qty)}
                          </div>
                          <div className="mt-0.5 text-[10px] font-extrabold text-[#5A6B62]">{s(r.uom || 'MT')}</div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'rounded-[2px] border px-2 py-1 text-[10.5px] font-extrabold tracking-[.04em]',
                            r.product_category === 'finished'
                              ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                              : 'border-[#DCE7DB] bg-[#EAF0E9] text-[#33473E]'
                          )}
                        >
                          {CAT_LABEL[s(r.product_category)] || s(r.product_category) || '—'}
                        </span>
                        {rec ? (
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-1 text-[10px] font-extrabold uppercase tracking-[.07em] text-[#1B4E82]">
                            <RefreshCw className="h-3 w-3" /> Recirculation
                          </span>
                        ) : null}
                        {!rec && Number(r.recipe_version) > 0 && Number(r.recipe_latest_version) > Number(r.recipe_version) ? (
                          <span className="whitespace-nowrap rounded-[2px] border border-[#F0D9AE] bg-[#FFFBF2] px-1.5 py-1 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#8A5300]">
                            v{r.recipe_version} of {r.recipe_latest_version}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {rec ? (
                      <div className="flex items-center gap-2.5 border-t border-t-[#DCE7F5] bg-[#F4F8FD] px-3.5 py-2.5">
                        <span className="text-[12px] font-bold tabular-nums text-[#1B4E82]">
                          +{formatNum(r.qty)} −{formatNum(r.qty)}
                        </span>
                        <span className="min-w-0 text-[11px] font-bold leading-snug text-[#2B5C8F]">
                          the balance ends where it started
                        </span>
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        <button
          type="button"
          onClick={() => setSheet({ kind: 'batch' })}
          className="flex h-[50px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13.5px] font-extrabold text-[#C7F03F]"
        >
          <Plus className="h-5 w-5" /> Record production
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Oil put through the plant to keep it turning.
function RecircSheet({
  row,
  products,
  onClose,
  onSaved
}: {
  row?: Row
  products: Row[]
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [date, setDate] = useState(s(row?.prod_date).slice(0, 10) || todayISO())
  const [productId, setProductId] = useState(s(row?.product_id))
  const [qty, setQty] = useState(row ? String(row.qty ?? '') : '')
  const [note, setNote] = useState(s(row?.note))
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)

  const product = products.find((p) => String(p.id) === productId)
  const uom = s(product?.uom || row?.uom || 'MT')
  const q = Number(qty) || 0

  async function save(): Promise<void> {
    if (!productId) {
      toast.error('Pick the oil that was put through the machine')
      return
    }
    if (!(q > 0)) {
      toast.error('Enter how much was recirculated')
      return
    }
    setSaving(true)
    try {
      const payload = {
        kind: 'recirculation',
        prod_date: date,
        product_id: Number(productId),
        qty: q,
        uom,
        note: note || null
      }
      if (row) await window.api.production.update(n(row.id), payload)
      else await window.api.production.create(payload)
      toast.success('Recirculation recorded — no stock moved')
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      eyebrow="Production"
      title={row ? 'Edit recirculation' : 'Record a recirculation'}
      blurb="Oil put through the plant to keep it turning while the mill is idle. It draws no raw material and makes nothing — the register carries it so the week can be explained, and no balance moves."
      tone="blue"
      onClose={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Record"
      saveIcon={<RefreshCw className="h-[19px] w-[19px]" />}
      requirement={!productId ? 'Pick the oil.' : !(q > 0) ? 'Enter the quantity.' : ''}
    >
      <Field label="Date">
        <input
          type="date"
          value={date}
          max={todayISO()}
          onChange={(e) => setDate(e.target.value)}
          className="h-12 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[14px] font-semibold tabular-nums text-[#0A1F17] outline-none"
        />
      </Field>

      <Field label="Which oil *">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="flex h-12 w-full items-center justify-between gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-left"
        >
          <span className={cn('min-w-0 truncate text-[13.5px] font-bold', productId ? 'text-[#0A1F17]' : 'text-[#8FA79B]')}>
            {productId ? s(product?.name) : 'Pick the oil'}
          </span>
          <ChevronRight className={cn('h-5 w-5 shrink-0 text-[#5A6B62] transition-transform', picking && 'rotate-90')} />
        </button>
        {picking ? (
          <div className="mt-1.5 max-h-64 overflow-y-auto rounded-[4px] border border-[#C3D2C6] bg-white">
            {products.map((p) => (
              <button
                key={String(p.id)}
                type="button"
                onClick={() => {
                  setProductId(String(p.id))
                  setPicking(false)
                }}
                className={cn(
                  'flex h-12 w-full items-center border-b border-b-[#EAF0E9] px-3 text-left text-[13px] font-bold last:border-b-0',
                  String(p.id) === productId ? 'bg-[#EFF5EC] text-[#0B6B45]' : 'text-[#0A1F17]'
                )}
              >
                {s(p.name)}
                <span className="ml-2 text-[11px] font-semibold text-[#5A6B62]">
                  {CAT_LABEL[s(p.category)] || s(p.category)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </Field>

      <Field label="Quantity *">
        <div className="flex items-center gap-2.5">
          <input
            value={qty}
            inputMode="decimal"
            placeholder="0.000"
            onChange={(e) => setQty(e.target.value)}
            className="h-12 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-right text-[15px] font-bold tabular-nums text-[#0A1F17] outline-none"
          />
          <span className="shrink-0 text-[12.5px] font-extrabold text-[#5A6B62]">{uom}</span>
        </div>
        {/* What the register will say, before it says it. */}
        <div className="mt-2.5 flex items-center gap-2.5 rounded-[4px] border border-[#C6DAF0] bg-[#EAF0FA] px-3 py-2.5">
          <RefreshCw className="h-[17px] w-[17px] shrink-0 text-[#1B4E82]" />
          <span className="min-w-0 text-[11.5px] font-bold leading-snug text-[#1B4E82]">
            The register will show{' '}
            <span className="tabular-nums">
              +{q > 0 ? formatNum(q) : '0'} −{q > 0 ? formatNum(q) : '0'}
            </span>{' '}
            — the balance ends where it started.
          </span>
        </div>
      </Field>

      <Field label="Note">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why the plant was run — e.g. shut down 3 days"
          className="h-12 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
        />
      </Field>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// One batch: product, recipe, quantity — and what that will draw.
function BatchSheet({
  row,
  products,
  recipes,
  onClose,
  onSaved
}: {
  row?: Row
  products: Row[]
  recipes: Row[]
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [date, setDate] = useState(s(row?.prod_date).slice(0, 10) || todayISO())
  const [productId, setProductId] = useState(s(row?.product_id))
  const [recipeId, setRecipeId] = useState(s(row?.formulation_id))
  const [qty, setQty] = useState(row ? String(row.qty ?? '') : '')
  const [note, setNote] = useState(s(row?.note))
  const [items, setItems] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)

  // Only what a refining line can make: finished or intermediate, and
  // WEIGHED — anything counted in PCS has no business here. The desktop
  // sheet draws its list the same way.
  const outputs = useMemo(
    () =>
      products.filter(
        (p) => ['finished', 'intermediate'].includes(s(p.category)) && s(p.uom).toUpperCase() !== 'PCS'
      ),
    [products]
  )
  const forProduct = useMemo(
    () => recipes.filter((f) => String(f.product_id) === productId),
    [recipes, productId]
  )
  const product = products.find((p) => String(p.id) === productId)
  const uom = s(product?.uom || row?.uom || 'MT')
  const q = Number(qty) || 0

  // A product with exactly one recipe needs no picker; more than one and the
  // choice decides what gets drawn, so it must be made deliberately.
  useEffect(() => {
    if (!productId) return
    if (forProduct.length === 1) setRecipeId(String(forProduct[0].id))
    else if (!forProduct.some((f) => String(f.id) === recipeId)) setRecipeId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, recipes])

  useEffect(() => {
    if (!recipeId) {
      setItems([])
      return
    }
    let live = true
    window.api.formulations
      .items(Number(recipeId))
      .then((its) => {
        if (live) setItems(Array.isArray(its) ? its : [])
      })
      .catch(() => {
        if (live) setItems([])
      })
    return () => {
      live = false
    }
  }, [recipeId])

  // What the server will post, computed with the server's own function.
  const draw = useMemo(() => {
    if (!items.length || !(q > 0)) return []
    return expandRecipe(items, q)
  }, [items, q])
  const nameOf = (id: unknown): string => s(products.find((p) => String(p.id) === s(id))?.name) || '—'

  async function save(): Promise<void> {
    if (!productId) {
      toast.error('Pick what was produced')
      return
    }
    if (!(q > 0)) {
      toast.error('Enter the quantity produced')
      return
    }
    setSaving(true)
    try {
      const payload = {
        prod_date: date,
        product_id: Number(productId),
        qty: q,
        uom,
        note: note || null,
        formulation_id: recipeId ? Number(recipeId) : null
      }
      if (row) await window.api.production.update(n(row.id), payload)
      else await window.api.production.create(payload)
      toast.success(row ? 'Run updated' : 'Production recorded')
      await onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen
      eyebrow="Production"
      title={row ? 'Alter this run' : 'Record production'}
      blurb={
        row
          ? 'The recipe this batch was RUN ON is re-applied from the quantity you set — an edit to the recipe since cannot reach it.'
          : 'One batch. Its recipe decides what comes out of the tanks, so the draw below is what will actually be posted.'
      }
      tone="green"
      onClose={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Save"
      saveIcon={<Save className="h-[19px] w-[19px]" />}
      requirement={!productId ? 'Pick the product.' : !(q > 0) ? 'Enter the quantity.' : ''}
    >
      <Field label="Date">
        <input
          type="date"
          value={date}
          max={todayISO()}
          onChange={(e) => setDate(e.target.value)}
          className="h-12 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[14px] font-semibold tabular-nums text-[#0A1F17] outline-none"
        />
      </Field>

      <Field label="Produced *">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="flex h-12 w-full items-center justify-between gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-left"
        >
          <span className={cn('min-w-0 truncate text-[13.5px] font-bold', productId ? 'text-[#0A1F17]' : 'text-[#8FA79B]')}>
            {productId ? s(product?.name) : 'Pick the product'}
          </span>
          <ChevronRight className={cn('h-5 w-5 shrink-0 text-[#5A6B62] transition-transform', picking && 'rotate-90')} />
        </button>
        {picking ? (
          <div className="mt-1.5 max-h-64 overflow-y-auto rounded-[4px] border border-[#C3D2C6] bg-white">
            {outputs.map((p) => (
              <button
                key={String(p.id)}
                type="button"
                onClick={() => {
                  setProductId(String(p.id))
                  setPicking(false)
                }}
                className={cn(
                  'flex h-12 w-full items-center border-b border-b-[#EAF0E9] px-3 text-left text-[13px] font-bold last:border-b-0',
                  String(p.id) === productId ? 'bg-[#EFF5EC] text-[#0B6B45]' : 'text-[#0A1F17]'
                )}
              >
                {s(p.name)}
                <span className="ml-2 text-[11px] font-semibold text-[#5A6B62]">
                  {CAT_LABEL[s(p.category)] || s(p.category)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </Field>

      {forProduct.length > 1 ? (
        <Field label="Recipe *">
          <div className="flex flex-col gap-1.5">
            {forProduct.map((f) => (
              <button
                key={String(f.id)}
                type="button"
                onClick={() => setRecipeId(String(f.id))}
                className={cn(
                  'flex min-h-12 items-center gap-2.5 rounded-[4px] border px-3 py-2 text-left',
                  String(f.id) === recipeId ? 'border-[#0B3D2E] bg-[#EFF5EC]' : 'border-[#C3D2C6] bg-white'
                )}
              >
                <span className="min-w-0 flex-1 text-[12.5px] font-bold text-[#0A1F17]">
                  {s(f.name) || 'Unnamed recipe'}
                </span>
                <span className="shrink-0 text-[11.5px] font-bold tabular-nums text-[#5A6B62]">
                  TOR {formatNum(f.tor)}
                </span>
              </button>
            ))}
          </div>
        </Field>
      ) : null}

      <Field label={`Quantity produced * (${uom})`}>
        <input
          value={qty}
          inputMode="decimal"
          placeholder="0.000"
          onChange={(e) => setQty(e.target.value)}
          className="h-12 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-right text-[15px] font-bold tabular-nums text-[#0A1F17] outline-none"
        />
      </Field>

      {draw.length ? (
        <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
          <div className="flex items-center gap-2 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-3.5 py-2.5">
            <span className="flex-1 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
              What this draws
            </span>
            <span className="text-[11px] font-bold tabular-nums text-[#5A6B62]">
              TOR {formatNum(round3(recipeTor(items)))}
            </span>
          </div>
          {draw.map((l, i) => (
            <div key={i} className="flex items-center gap-2.5 border-b border-b-[#EAF0E9] px-3.5 py-2.5 last:border-b-0">
              <span
                className={cn(
                  'w-[34px] shrink-0 text-[9.5px] font-extrabold tracking-[.07em]',
                  l.kind === 'input' ? 'text-[#0B6B45]' : l.kind === 'loss' ? 'text-[#8C2F26]' : 'text-[#8A5300]'
                )}
              >
                {l.kind === 'input' ? 'IN' : l.kind === 'loss' ? 'LOSS' : 'OUT'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#0A1F17]">
                {nameOf(l.product_id)}
              </span>
              <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#0A1F17]">
                {formatNum(round3(l.qty))}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <Field label="Note">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything to record against this batch"
          className="h-12 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#8FA79B]"
        />
      </Field>
    </Screen>
  )
}

// ---------------------------------------------------------------------------
function Screen({
  eyebrow,
  title,
  blurb,
  tone,
  children,
  onClose,
  onSave,
  saving,
  saveLabel,
  saveIcon,
  requirement
}: {
  eyebrow: string
  title: string
  blurb: string
  tone: 'blue' | 'green'
  children: React.ReactNode
  onClose: () => void
  onSave: () => void
  saving: boolean
  saveLabel: string
  saveIcon: React.ReactNode
  requirement: string
}): React.JSX.Element {
  const blue = tone === 'blue'
  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
      <div className="shrink-0 bg-[#0B3D2E] px-3 pb-3.5 pt-2 text-white">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] active:bg-white/10"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">{eyebrow}</div>
            <div className="mt-0.5 truncate text-[18px] font-extrabold tracking-[-0.02em]">{title}</div>
          </div>
          {blue ? (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] bg-white/10">
              <RefreshCw className="h-5 w-5 text-[#BBD5F2]" />
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[11.5px] font-semibold leading-relaxed text-[#8FBFA8]">{blurb}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-6 pt-3.5">{children}</div>

      <div className="shrink-0 border-t border-[#D6E2D6] bg-white px-4 pb-6 pt-2.5">
        {requirement ? (
          <div className="mb-2 flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-[17px] w-[17px] shrink-0 text-[#8A5300]" />
            <span className="text-[11.5px] font-bold leading-snug text-[#8A5300]">{requirement}</span>
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
            disabled={saving || !!requirement}
            onClick={onSave}
            className={cn(
              'flex h-[50px] flex-[1.3] items-center justify-center gap-2 rounded-[4px] text-[13px] font-extrabold uppercase tracking-[.03em]',
              saving || requirement
                ? 'bg-[#DCE7DB] text-[#8FA79B]'
                : blue
                  ? 'bg-[#1B4E82] text-white'
                  : 'bg-[#0B3D2E] text-[#C7F03F]'
            )}
          >
            {saving ? <Loader2 className="h-[19px] w-[19px] animate-spin" /> : saveIcon}
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[12.5px] font-extrabold text-[#0A1F17]">{label}</div>
      {children}
    </div>
  )
}
