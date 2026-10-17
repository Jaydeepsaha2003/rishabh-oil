// What a PP figure is made of.
// -----------------------------------------------------------------------------
// The opening sheet takes PP — the oil already in process on the morning the
// books start — as one number. The plant has never counted it as one number:
// it counts the vessels and adds them up.
//
//     BLEACHER          6.000
//     Deo Feed Tms      2.500
//     Deo Scr          32.000
//     Post Bleacher     3.500
//     ----------------------
//     Total            53.000  MT PP
//
// Redesigned to the Stock handoff, and one thing changed with it. The first
// version listed EVERY stage the site knows against every product, so a
// thirty-product sheet meant thirty dialogs of mostly-blank rows, and a cross
// had to reach across products to decide whether a stage could go. Now a
// product's breakdown holds only the vessels that product is actually sitting
// in: you add the ones it is in, and the cross takes a line off THIS product
// and touches nothing else. Which gives the rule that was asked for by
// construction — a stage keeps its quantity wherever one stands against it,
// because nothing but this product's own list is ever edited here.
//
// The names still belong to the site: whatever anybody has typed is offered as
// a suggestion, so the same vessel is not spelled three ways.
//
// EDITED AS A DRAFT, saved in one go. The dialog was writing on every keypress
// before, which meant Cancel could not put anything back.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Layers, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useDrawerEscape } from '@/lib/escape'
import { MixDrawer } from '@/pages/Production'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const EMPTY_ITEMS: Row[] = []

export type PpFfa = 'with' | 'without' | null
export type PpLine = {
  reference?: string
  stage_id?: number
  stage?: string
  name?: string
  qty: number
  ffa: PpFfa
  formulation_id?: number | null
  // Y/N — does production use this vessel? Absent reads as Y.
  in_use?: boolean
}
type Draft = { reference?: string; stage: string; stage_id: number; qty: string; ffa: boolean; formulation_id: string; use: boolean }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

// The plant writes 2:50 for two and a half tonnes — a colon where the rest of
// the app writes a point. Accepted as typed rather than rejected, because the
// figure is being copied off a sheet that spells it that way.
export function parsePpQty(v: string): string {
  return String(v ?? '')
    .replace(/[^0-9.:]/g, '')
    .replace(/:/g, '.')
    .replace(/(\..*)\./g, '$1')
}

export function ppTotals(draft: Draft[]): { total: number; withFfa: number; without: number; held: number } {
  let total = 0
  let withFfa = 0
  let held = 0
  for (const l of draft) {
    const q = n(l.qty)
    if (!q) continue
    total += q
    if (l.ffa) withFfa += q
    if (!l.use) held += q
  }
  return { total: r3(total), withFfa: r3(withFfa), without: r3(total - withFfa), held: r3(held) }
}

// AN NBFC IS ITS TERMS; A RECIPE IS ITS RATIO.
//
// "SHEA BASED" alone does not separate the two shea recipes this product has
// — one on the recovered-oil line, one on the fatty-oil line, with different
// yields. Named the way the plant refers to them: the recipe, the line it
// belongs to, and what it costs in oil per hundred out.
function recipeLabel(f: Row): string {
  return [
    String(f.name || `Recipe #${f.id}`),
    String(f.subcategory_name || '').trim(),
    Number(f.tor) > 0 ? `TOR ${formatNum(Math.round(Number(f.tor) * 10) / 10)}%` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

const draftFrom = (lines: PpLine[]): Draft[] =>
  lines.map((l) => ({
    reference: l.reference,
    stage: String(l.stage ?? l.name ?? ''),
    stage_id: n(l.stage_id),
    qty: l.qty == null || l.qty === 0 ? '' : String(l.qty),
    // A line stored before the toggle became two-state reads as W/O FFA — the
    // side it would have been counted on anyway.
    ffa: l.ffa === 'with',
    formulation_id: l.formulation_id ? String(l.formulation_id) : '',
    use: l.in_use !== false
  }))

export function PpBreakdown({
  product,
  open,
  onOpenChange,
  onSaved,
  version
}: {
  product: Row | null
  open: boolean
  onOpenChange: (v: boolean) => void
  // The fingerprint the sheet loaded with. Handed to the save so a breakdown
  // typed on a stale page cannot replace vessel lines it never saw — this
  // dialog REPLACES a product's vessels wholesale, so a stale save silently
  // deletes any tank the page does not know about.
  version?: string
  // Handed the new total and lines so the sheet can update that one row
  // without reloading — it holds an unsaved draft of every other row.
  onSaved: (productId: number, total: number, lines: PpLine[]) => void
}): React.JSX.Element | null {
  const overlay = useRef<HTMLDivElement>(null)
  useDrawerEscape(open, overlay, () => { if (!busy) onOpenChange(false) })
  const [draft, setDraft] = useState<Draft[]>([])
  const [known, setKnown] = useState<string[]>([])
  // The recipes this product can be made to. Oil counted WITH its FFA is the
  // blend on the way to the product, not the product — naming the recipe is
  // what lets the register restate it as the oils that went into it.
  const [recipes, setRecipes] = useState<Row[]>([])
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  // Create a formulation for this product without leaving the breakdown — the
  // list it is chosen from can be empty, and sending the user to the
  // Formulations page and back loses the vessels they were part-way through.
  const [newOpen, setNewOpen] = useState(false)
  const [viewRecipe, setViewRecipe] = useState<{name:string;items:Row[]} | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  // The material list the recipe editor picks from. Loaded when the dialog
  // opens so the New-formulation drawer has something to offer.
  const [products, setProducts] = useState<Row[]>([])

  const lines: PpLine[] = useMemo(
    () => (Array.isArray(product?.pp_lines) ? (product?.pp_lines as PpLine[]) : []),
    [product]
  )
  const pid = n(product?.id)
  const uom = String(product?.uom || 'MT')

  const loadRecipes = useCallback(async (): Promise<void> => {
    if (!pid) return
    try {
      // Include the hidden one-offs: a recipe built here is kept off the
      // Formulations tab, but it must still be pickable on the very breakdown
      // that made it, so this list is the one place they are shown.
      const r = await window.api.formulations.list({ includeHidden: true })
      setRecipes(r.filter((f) => Number(f.product_id) === pid && f.active !== false))
    } catch {
      setRecipes([])
    }
  }, [pid])

  useEffect(() => {
    if (!open || !pid) return
    void loadRecipes()
    void window.api.data
      .list('products')
      .then((pr) => setProducts(pr.filter((x) => x.active)))
      .catch(() => setProducts([]))
  }, [open, pid, loadRecipes])

  // Save the recipe built in the New-formulation drawer as a real formulation
  // against this oil, then pick it straight away — its actual lines are on the
  // master from the moment it is created, exactly as the Formulations page
  // would have written them.
  const createRecipe = useCallback(
    async (recipeLines: Row[], future = false): Promise<void> => {
      const name = newName.trim()
      if (!pid || !name) return
      setCreating(true)
      try {
        // Hidden: a one-off built to restate this vessel, not a master recipe —
        // so it never shows on the Formulations tab (it stays pickable here).
        const res = await window.api.formulations.create({ product_id: pid, name, uom, items: recipeLines, hidden: !future })
        await loadRecipes()
        const newId = String(res?.id || '')
        if (newId && !future) setDraft((d) => d.map((x) => (x.ffa ? { ...x, formulation_id: newId } : x)))
        setNewName('')
        setNewOpen(false)
        toast.success(future ? `Saved "${name}" to Formulations` : `Using "${name}" for this PP`)
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setCreating(false)
      }
    },
    [newName, pid, uom, loadRecipes]
  )

  const loadKnown = useCallback(async (): Promise<void> => {
    try {
      const st = await window.api.stockOpening.ppStages()
      setKnown(st.filter((x) => x.active !== false).map((x) => String(x.name)))
    } catch {
      // The suggestions are a convenience. A dialog that will not open because
      // the dictionary could not be read is worse than one with no dictionary.
      setKnown([])
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setDraft(draftFrom(lines))
    setAdding('')
    void loadKnown()
  }, [open, lines, loadKnown])

  const sums = ppTotals(draft)
  const before = r3(lines.reduce((a, l) => a + n(l.qty), 0))
  const shifted = Math.abs(sums.total - before) > 0.0005
  const wanted = adding.trim()
  const dupe = !!wanted && draft.some((l) => l.stage.toLowerCase() === wanted.toLowerCase())

  // Suggestions the site already knows and this product is not already in.
  const suggestions = known.filter(
    (k) => !draft.some((l) => l.stage.toLowerCase() === k.toLowerCase())
  )

  function addStage(): void {
    if (!wanted || dupe) return
    setDraft((d) => [...d, { stage: wanted, stage_id: 0, qty: '', ffa: false, formulation_id: '', use: true }])
    setAdding('')
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.api.stockOpening.savePp(
        pid,
        draft
          .filter((l) => l.stage.trim())
          .map((l) => ({
            stage: l.stage.trim(),
            stage_id: l.stage_id || undefined,
            qty: l.qty,
            ffa: l.ffa ? 'with' : 'without',
            // Only meaningful on a with-FFA line; the server drops it on the
            // other kind rather than storing a recipe that means nothing.
            formulation_id: l.ffa && l.formulation_id ? Number(l.formulation_id) : null,
            in_use: l.use
          })),
        undefined,
        version
      )
      onSaved(
        pid,
        res.total,
        res.saved_lines as PpLine[] || draft
          .filter((l) => l.stage.trim() && Math.abs(n(l.qty)) > 0.0005)
          .map((l) => ({
            stage: l.stage.trim(),
            name: l.stage.trim(),
            qty: r3(n(l.qty)),
            ffa: (l.ffa ? 'with' : 'without') as PpFfa,
            formulation_id: l.ffa && l.formulation_id ? Number(l.formulation_id) : null,
            in_use: l.use
          }))
      )
      toast.success(
        res.lines
          ? `PP for ${String(product?.name || '')} is ${formatNum(res.total)} ${uom} across ${res.lines} vessel${res.lines === 1 ? '' : 's'}`
          : `Breakdown cleared — PP for ${String(product?.name || '')} is back to a figure typed on the sheet`
      )
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  // The with-FFA lines, and the one recipe they agree on. A sheet that
  // predates this choice can hold two different answers; the panel shows the
  // first and setting it writes the same one to every line, so the
  // disagreement can only be resolved, never deepened.
  const withFfaLines = draft.filter((l) => l.ffa && Math.abs(n(l.qty)) > 0.0005)
  const chosenRecipe = withFfaLines.find((l) => l.formulation_id)?.formulation_id || ''
  const chosen = recipes.find((f) => String(f.id) === chosenRecipe)

  const problem = dupe
    ? `${wanted} is already on this breakdown.`
    : draft.length === 0
      ? 'Saving with no stages puts PP back to blank.'
      : ''
  const reqFg = dupe ? '#B3261E' : draft.length === 0 ? '#8A5300' : '#0B6B45'

  const GRID = 'minmax(140px,1fr) 108px 148px 84px 34px'

  return (
    <div
      ref={overlay}
      role="dialog"
      aria-modal="true"
      aria-label="PP vessel breakdown"
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div
        className="flex max-h-full w-[min(100%,880px)] flex-col overflow-hidden rounded-2xl bg-white"
        style={{ boxShadow: '0 24px 60px rgba(10,31,23,.34)' }}
      >
        <div className="flex flex-none items-start justify-between gap-3.5 px-[22px] pt-5">
          <div className="min-w-0">
            <div className="text-[18px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">
              PP vessels — {String(product?.name || '')}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] hover:bg-[#F1F5EF]"
          >
            <X className="h-[21px] w-[21px] text-[#5A6B62]" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-[22px] pb-3 text-xs font-semibold text-[#5A6B62]">
          <Layers className="h-4 w-4" /> Opening stock <span className="text-[#C3D2C6]">/</span> {draft.length} vessels
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4">
          <div className="overflow-hidden rounded-md border border-[#E4ECE3]">
            <div
              className="grid h-[34px] items-center border-b border-b-[#E4ECE3] bg-[#F7FAF6] text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="px-3.5">Vessel / Reference</span>
              <span className="px-2 text-right">Qty {uom}</span>
              <span className="px-2 text-center">FFA</span>
              <span
                className="px-1 text-center"
                title="Y: production uses this vessel — W/O FFA oil is taken one for one, With FFA oil with a formulation is read as its ingredients. N: held — it stays this product's PP and no batch touches it."
              >
                Use in prod.
              </span>
              <span />
            </div>

            {draft.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-[26px]">
                <Layers className="h-[26px] w-[26px] text-[#C3D2C6]" />
                <span className="text-[12.5px] font-bold text-[#5A6B62]">No stages yet</span>
                <span className="max-w-[340px] text-center text-[12px] font-medium leading-[1.5] text-[#5A6B62]">
                  Add the vessels this product is sitting in. With no stages, PP stays a figure typed straight onto
                  the sheet.
                </span>
              </div>
            ) : (
              draft.map((l, i) => (
                <div key={`${l.stage}-${i}`} className="border-b border-b-[#EFF3EE] last:border-b-0">
                <div
                  className="grid min-h-[45px] items-center"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className="truncate px-3.5 text-[13px] font-bold text-[#0A1F17]" title={l.stage}>
                    <span className="block text-[10px] font-semibold text-[#5A6B62]">{l.reference || 'NEW'}</span>
                    {l.stage}
                  </span>
                  <div className="px-2">
                    <input
                      inputMode="decimal"
                      placeholder="0"
                      aria-label={`${l.stage} quantity`}
                      className="doc-ref h-[34px] w-full rounded-[4px] border border-[#DCE7DB] bg-white px-[9px] text-right text-[13px] font-semibold tabular-nums text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6] focus:border-[#5B4BA8]"
                      value={l.qty}
                      onChange={(e) => {
                        const v = parsePpQty(e.target.value)
                        setDraft((d) => d.map((x, k) => (k === i ? { ...x, qty: v } : x)))
                      }}
                    />
                  </div>
                  {/* Two states, one of them always on. "Not stated" was a
                      third state nobody chose on purpose — every line is
                      either carrying its free fatty acid or it is not, and the
                      counter knows which. */}
                  <div className="flex justify-center gap-[5px] px-2">
                    {(
                      [
                        { on: l.ffa, label: 'With FFA', bg: '#FFF9E0', bd: '#E8D9A0', fg: '#8A5300', v: true },
                        { on: !l.ffa, label: 'W/O FFA', bg: '#E9F5EE', bd: '#BFE3CB', fg: '#0B6B45', v: false }
                      ] as const
                    ).map((b) => (
                      <button
                        key={b.label}
                        type="button"
                        onClick={() => setDraft((d) => d.map((x, k) => (k === i ? { ...x, ffa: b.v } : x)))}
                        className="flex h-8 min-w-[64px] items-center justify-center rounded-[4px] border text-[11px] font-extrabold transition-colors"
                        style={
                          b.on
                            ? { background: b.bg, borderColor: b.bd, color: b.fg }
                            : { background: '#fff', borderColor: '#DCE7DB', color: '#5A6B62' }
                        }
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  {/* Y/N: whether production may use this vessel at all. */}
                  <div className="flex justify-center gap-[3px] px-1">
                    {(
                      [
                        { v: true, label: 'Y', on: l.use, bg: '#E9F5EE', bd: '#BFE3CB', fg: '#0B6B45', tip: 'Production uses this vessel' },
                        { v: false, label: 'N', on: !l.use, bg: '#FDF3F2', bd: '#F0D6D4', fg: '#B3261E', tip: 'Held — no batch uses this vessel' }
                      ] as const
                    ).map((b) => (
                      <button
                        key={b.label}
                        type="button"
                        title={b.tip}
                        aria-pressed={b.on}
                        aria-label={`${l.stage}: ${b.tip}`}
                        onClick={() => setDraft((d) => d.map((x, k) => (k === i ? { ...x, use: b.v } : x)))}
                        className="flex h-7 w-8 items-center justify-center rounded-[4px] border text-[11px] font-extrabold transition-colors"
                        style={
                          b.on
                            ? { background: b.bg, borderColor: b.bd, color: b.fg }
                            : { background: '#fff', borderColor: '#DCE7DB', color: '#8CA396' }
                        }
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-center pr-2">
                    <button
                      type="button"
                      title={`Take ${l.stage} off this product's breakdown`}
                      onClick={() => setDraft((d) => d.filter((_, k) => k !== i))}
                      className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#8CA396] hover:bg-[#FDF3F2] hover:text-[#B3261E]"
                    >
                      <X className="h-[19px] w-[19px]" />
                    </button>
                  </div>
                </div>
                </div>
              ))
            )}

            {/* WHAT THIS OIL IS ON ITS WAY TO BEING — ASKED ONCE.
                It was a strip under every with-FFA line, which asked the same
                question five times and answered it with the same sentence five
                times. A product is made to ONE recipe; the vessels are just
                where it happens to be standing. So it is one choice, applied
                to every with-FFA vessel on the sheet. */}
            {withFfaLines.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-b-[#EFF3EE] bg-[#FFFDF4] px-3.5 py-3">
                <Layers className="h-[16px] w-[16px] shrink-0 text-[#8A5300]" />
                <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#8A5300]">
                  Formulation
                </span>
                {recipes.length === 0 ? (
                  // A recipe cannot be chosen from an empty list, and an empty
                  // dropdown reads as a broken one. Say which product has none.
                  <span className="min-w-0 flex-1 text-[12px] font-semibold text-[#8A5300] [text-wrap:pretty]">
                    No formulation yet
                  </span>
                ) : (
                  <select
                    value={chosenRecipe}
                    onChange={(e) => {
                      const v = e.target.value
                      setDraft((d) => d.map((x) => (x.ffa ? { ...x, formulation_id: v } : x)))
                    }}
                    className="h-9 min-w-[260px] max-w-full flex-1 rounded-[4px] border border-[#E8D9A0] bg-white px-2.5 text-[12.5px] font-bold text-[#0A1F17] outline-none focus:border-[#8A5300]"
                  >
                    <option value="">Select formulation</option>
                    {recipes.map((f) => (
                      <option key={String(f.id)} value={String(f.id)}>
                        {recipeLabel(f)}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" disabled={!chosenRecipe || viewLoading} title="View formulation" aria-label="View formulation"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[#C7B47A] bg-white text-[#8A5300] hover:bg-[#FFF9E0] disabled:opacity-40"
                  onClick={async () => {
                    setViewLoading(true)
                    try { setViewRecipe({name:String(chosen?.name || `Recipe #${chosenRecipe}`),items:await window.api.formulations.items(Number(chosenRecipe))}) }
                    catch (e) { toast.error((e as Error).message) }
                    finally { setViewLoading(false) }
                  }}><Eye className="h-4 w-4" /></button>
                {/* Build one without leaving — the list this restates the oil
                    against can be empty, or missing the recipe just needed. The
                    full recipe editor opens, and saves a real formulation. */}
                <button
                  type="button"
                  onClick={() => {
                    setNewName('')
                    setNewOpen(true)
                  }}
                  className="flex h-9 flex-none items-center gap-1.5 rounded-[4px] border border-[#C7B47A] bg-white px-3 text-[12px] font-extrabold text-[#8A5300] hover:bg-[#FFF9E0]"
                >
                  <Plus className="h-[15px] w-[15px]" />
                  New formulation
                </button>
                {chosenRecipe ? (
                  <span className="w-full text-[11px] font-semibold text-[#9A7430]">{formatNum(sums.withFfa)} {uom} allocated to ingredients</span>
                ) : (
                  // What leaving it blank MEANS — the oil is not lost, it waits.
                  <span className="w-full text-[11px] font-semibold text-[#9A7430] [text-wrap:pretty]">
                    Until a formulation is named, production leaves these {formatNum(sums.withFfa)} {uom} in the vessels — no
                    batch uses them.
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center gap-2.5 bg-white px-3.5 py-3">
              <input
                list="pp-stage-names"
                placeholder="Add a vessel — e.g. Post Bleacher"
                aria-label="Add a stage"
                maxLength={60}
                className="h-[42px] min-w-0 flex-1 rounded-md border border-[#DCE7DB] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6] focus:border-[#5B4BA8]"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addStage()
                  }
                }}
              />
              {/* Whatever the site has been calling its vessels, so the same
                  tank is not spelled three ways across thirty products. */}
              <datalist id="pp-stage-names">
                {suggestions.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={addStage}
                disabled={!wanted || dupe}
                className="flex h-[42px] flex-none items-center gap-[7px] rounded-md border bg-white px-[15px] text-[12.5px] font-extrabold disabled:cursor-not-allowed"
                style={{
                  borderColor: wanted && !dupe ? '#5B4BA8' : '#DCE7DB',
                  color: wanted && !dupe ? '#3D3179' : '#8CA396'
                }}
              >
                <Plus className="h-[18px] w-[18px]" />
                Add vessel
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3.5 rounded-md border border-[#E4ECE3] bg-[#F7FAF6] p-[15px]">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#3D3179]">Total PP</div>
              <div className="mt-1.5 text-[12px] font-semibold text-[#5A6B62]">
                With FFA <span className="doc-ref tabular-nums">{formatNum(sums.withFfa)}</span>
                &nbsp;&nbsp; W/O FFA <span className="doc-ref tabular-nums">{formatNum(sums.without)}</span>
                {sums.held > 0.0005 && (
                  <>
                    &nbsp;&nbsp;{' '}
                    <span className="text-[#B3261E]">
                      Held (N) <span className="doc-ref tabular-nums">{formatNum(sums.held)}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="ml-auto flex flex-none items-baseline gap-1.5">
              <span className="doc-ref text-[26px] font-bold tracking-[-0.03em] text-[#0A1F17] tabular-nums">
                {formatNum(sums.total)}
              </span>
              <span className="text-[11.5px] font-bold text-[#5A6B62]">{uom}</span>
            </div>
          </div>

          {/* What saving will actually move. The figure on the sheet is the
              opening this product contributes, so a breakdown that changes it
              changes the register — worth saying before the button is pressed
              rather than after. */}
          {shifted && (
            <div className="mt-3 flex items-start gap-[9px] rounded-[4px] border border-[#D6CEF5] border-l-4 border-l-[#5B4BA8] bg-[#EDE9FB] px-[13px] py-[11px]">
              <Layers className="mt-px h-[17px] w-[17px] flex-none text-[#5B4BA8]" />
              <span className="text-[12px] font-semibold leading-[1.5] text-[#3D3179]">
                {draft.length === 0
                  ? 'PP breakdown cleared'
                  : `PP: ${formatNum(before)} → ${formatNum(sums.total)} ${uom}`}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] bg-white px-[22px] py-4">
          <span className="min-w-0 flex-1 text-[12px] font-semibold" style={{ color: reqFg }}>
            {problem || (
              <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                {/* What is being saved, as a figure rather than as the start of
                    a sentence. */}
                <span className="text-[#33473E]">
                  <b className="doc-ref text-[14px] font-bold tracking-[-0.02em] text-[#0A1F17]">
                    {formatNum(sums.total)} {uom}
                  </b>{' '}
                  across {draft.length} stage{draft.length === 1 ? '' : 's'}
                </span>
                {/* The split the toggles decide, kept apart from the total so
                    it reads as a breakdown of it and not as more of it. */}
                {(sums.withFfa > 0.0005 || sums.without > 0.0005) && (
                  <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                    {sums.withFfa > 0.0005 && (
                      <>
                        <span className="doc-ref tabular-nums">{formatNum(sums.withFfa)}</span> with FFA
                      </>
                    )}
                    {sums.withFfa > 0.0005 && sums.without > 0.0005 && ' \u00b7 '}
                    {sums.without > 0.0005 && (
                      <>
                        <span className="doc-ref tabular-nums">{formatNum(sums.without)}</span> without
                      </>
                    )}
                  </span>
                )}
                {/* The recipe as a chip, because it is a NAME — a thing picked
                    from a list — not another clause in the sentence. */}
                {chosen && (
                  <span className="inline-flex items-center gap-1.5 rounded-[3px] bg-[#FFF4E0] px-2 py-[3px] text-[11px] font-extrabold text-[#8A5300]">
                    <Layers className="h-3 w-3" />
                    {String(chosen.name || `Recipe #${chosen.id}`)}
                  </span>
                )}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-[42px] flex-none rounded-[4px] border border-[#C3D2C6] bg-white px-[18px] text-[12.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            // A duplicate sitting UNSENT in the add box blocks the Add button
            // and nothing else. The breakdown itself is valid, and refusing to
            // save it because of text nobody has added yet is the dialog
            // arguing with the reader about something it has not accepted.
            disabled={busy || !pid}
            className={cn(
              'h-[42px] flex-none rounded-[4px] px-[18px] text-[12.5px] font-extrabold',
              busy ? 'bg-[#C3D2C6] text-[#F1F5EF]' : 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]'
            )}
          >
            {busy ? 'Saving…' : 'Save breakdown'}
          </button>
        </div>
      </div>

      {/* The full recipe editor, opened to build a real formulation for this
          oil on the spot — saved to the master and picked as its "made to". */}
      <MixDrawer
        open={newOpen || !!viewRecipe}
        onClose={() => {
          if (creating) return
          setNewOpen(false)
          setViewRecipe(null)
          setNewName('')
        }}
        master
        readOnly={!!viewRecipe}
        nameValue={viewRecipe?.name || newName}
        onNameChange={setNewName}
        saving={creating}
        products={products}
        stock={{}}
        ppWithout={{}}
        ppWith={{}}
        outputProductId={pid}
        items={viewRecipe?.items || EMPTY_ITEMS}
        outputName={String(product?.name || '')}
        outputQty={0}
        uom={uom}
        onApply={(recipeLines) => void createRecipe(recipeLines)}
        onSaveForFuture={(recipeLines) => void createRecipe(recipeLines, true)}
      />
    </div>
  )
}
