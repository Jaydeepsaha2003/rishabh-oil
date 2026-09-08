import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDownLeft, ArrowLeft, Beaker, Boxes, CalendarDays, CheckCircle2, ChevronRight, Factory, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { RowActions } from '@/components/ui/row-actions'
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { expandRecipe } from '@/lib/recipeMath'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { Pagination, usePaged } from '@/components/Pagination'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The sheet's columns, written once so the header strip and the rows cannot
// drift apart. Product gets the most room because it is the field being
// searched; "draws from stock" is a read-out, so it takes what is left.
const SHEET_COLS =
  'grid grid-cols-[2.25rem_minmax(0,1.5fr)_minmax(0,1fr)_9rem_minmax(0,1.4fr)_2.25rem] gap-3'

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// The register's chrome on the website. A sticky header composites each of
// its own cells, so the forest is set on every one of them rather than on the
// row alone.
const PD_HEAD = __WEB__
  ? '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&>th]:!h-auto [&>th]:!bg-[#0B3D2E] [&>th]:!py-2.5 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-white'
  : ''

export function Production(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('production')
  const [rows, setRows] = useState<Row[]>([])
  // Production is the FACTORY's: a batch is run on the plant floor, and which
  // company's books it was booked under does not change that it happened or
  // that its output landed in the same tank. The company filter is a
  // breakdown of the site, not a different register.
  const [factoryName, setFactoryName] = useState('')
  const [prodFilter, setProdFilter] = useState(0)
  // Recipe OR its sub-category in one control: a mill reads "which recipe" and
  // "which kind of recipe" as the same question asked at two zooms, and two
  // dropdowns for it would take a third of the row.
  const [recipeFilter, setRecipeFilter] = useState('')
  // No company filter: a batch belongs to the plant floor, and the register is
  // the factory's. Which books it was costed into is not a way anyone wants to
  // read a production log.
  const visible = rows.filter(
    (r) =>
      (!prodFilter || Number(r.product_id) === prodFilter) &&
      (!recipeFilter ||
        (recipeFilter.startsWith('sub:')
          ? String(r.subcategory_id ?? '') === recipeFilter.slice(4)
          : String(r.formulation_id ?? '') === recipeFilter))
  )
  // Only what has actually been produced — a picker offering every product in
  // the masters would be mostly dead options on a page about batches that ran.
  const prodOptions = [...new Map(rows.filter((r) => r.product_id).map((r) => [Number(r.product_id), String(r.product_name || '')])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  // A batch whose formulation was later deleted keeps its id and loses its
  // name — the LEFT JOIN has nothing to give. Left as-is those became blank,
  // unreadable rows in the dropdown, so they are named after the id and marked
  // removed: the batches are still real and still need to be reachable.
  const recipeOptions = [...new Map(rows.filter((r) => r.formulation_id).map((r) => [String(r.formulation_id), String(r.formulation_name || '').trim() || `Recipe #${r.formulation_id} — removed`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const subOptions = [...new Map(rows.filter((r) => r.subcategory_id).map((r) => [String(r.subcategory_id), String(r.subcategory_name || '')])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const anyFilter = !!(prodFilter || recipeFilter)
  const paged = usePaged(visible)
  // Days the reader has OPENED, by their own date — every day starts folded.
  //
  // A period of production is a list of days, and the question asked of this
  // screen is almost always "what happened on one of them". Opening all of
  // them by default meant scrolling past every batch of every other day to
  // reach it. Tracking the open ones (rather than the shut ones, as this did
  // before) also means a day added later arrives folded like the rest instead
  // of springing open on its own.
  //
  // The band keeps showing the day's batch count and total while it is shut,
  // so nothing is hidden that was being read — only the batches behind it.
  const [openDays, setOpenDays] = useState<Set<string>>(() => new Set())
  function toggleDay(day: string): void {
    setOpenDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }
  const [products, setProducts] = useState<Row[]>([])
  const [formulations, setFormulations] = useState<Row[]>([])
  const [stock, setStock] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)

  // A day's production is entered as a SHEET, not one run at a time: the mill
  // runs several batches a day and re-opening the form for each of them made
  // the common case the slow one. One date at the top, a row per batch, and a
  // single save that posts them IN ORDER — order matters, because a batch can
  // consume what an earlier batch in the same list produced.
  const [building, setBuilding] = useState(false)
  // Set while altering an existing run: the sheet then holds exactly one row
  // and saves through production.update, keeping the run's id.
  const [editingId, setEditingId] = useState<number | null>(null)
  const [sheetDate, setSheetDate] = useState<string>(todayISO())
  const [runs, setRuns] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  // Per-row outcome of the last save attempt, so a part-posted sheet says
  // exactly which batches went in and which still need attention.
  const [results, setResults] = useState<Record<number, string>>({})
  const keyRef = useRef(1)

  const load = useCallback(async () => {
    setLoading(true)
    const [p, pr, f, s, fac] = await Promise.all([
      window.api.production.list(),
      window.api.data.list('products'),
      window.api.formulations.list(),
      window.api.stock.list(),
      window.api.factory.active().catch(() => null)
    ])
    setFactoryName(String(fac?.name || ''))
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

  // What a run can produce: a finished or intermediate product that is
  // WEIGHED. A recipe yields tonnes off the refining line, so a product counted
  // in pieces — a carton, a pouch — has no business being offered here. It was,
  // which is how CARTON,POUCH,500MLX32,DALDA came to sit in this list beside
  // the oils. Anything with no unit on record is MT, which is the default and
  // what every product already carried.
  const outputs = products.filter(
    (p) =>
      (p.category === 'finished' || p.category === 'intermediate') &&
      String(p.uom || 'MT').toUpperCase() !== 'PCS'
  )

  const recipesFor = (productId: unknown): Row[] =>
    formulations.filter((x) => String(x.product_id) === String(productId ?? ''))

  // `_mat` and `_cat` narrow the product picker and are never saved: save()
  // builds its payload field by field, so they cannot leak into a batch, and
  // sheetShape() leaves them out so narrowing a list is not an unsaved change.
  const blankRun = (): Row => ({
    key: keyRef.current++,
    _mat: '',
    _cat: '',
    product_id: '',
    formulation_id: null,
    qty: '',
    items: []
  })

  function patchRun(i: number, patch: Row): void {
    setRuns((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  // A product can have more than one formulation; the newest is the default and
  // the picker only appears once there is a real choice.
  async function chooseProduct(i: number, v: string): Promise<void> {
    const matches = recipesFor(v)
    const fid = matches.length ? Number(matches[0].id) : null
    patchRun(i, { product_id: v, formulation_id: fid, items: [] })
    if (fid) {
      const items = await window.api.formulations.items(fid)
      patchRun(i, { items })
    }
  }

  async function chooseRecipe(i: number, fid: number): Promise<void> {
    patchRun(i, { formulation_id: fid, items: [] })
    const items = await window.api.formulations.items(fid)
    patchRun(i, { items })
  }

  // Called by both openers once their state is in place — anything typed
  // after this counts as a change.
  function markSheetClean(date: string, list: Row[]): void {
    baselineRef.current = JSON.stringify({
      d: date,
      r: list.map((r) => [String(r.product_id ?? ''), String(r.formulation_id ?? ''), String(r.qty ?? '')])
    })
  }

  function openAdd(): void {
    setEditingId(null)
    editBaseRef.current = null
    const first = blankRun()
    setSheetDate(todayISO())
    setRuns([first])
    setResults({})
    markSheetClean(todayISO(), [first])
    setBuilding(true)
  }

  // The run being edited, as it stands on the books. Stock as at the run's own
  // date ALREADY contains it, so the projection has to take it back out before
  // showing what the edited quantity would do — otherwise "current stock" is
  // the figure after this very run and the effect is counted twice.
  const editBaseRef = useRef<{ items: Row[]; qty: number } | null>(null)

  async function openEdit(row: Row): Promise<void> {
    setEditingId(Number(row.id))
    setSheetDate(String(row.prod_date || todayISO()).slice(0, 10))
    setResults({})
    const fid = row.formulation_id ? Number(row.formulation_id) : null
    const items = fid ? await window.api.formulations.items(fid) : []
    editBaseRef.current = { items, qty: Number(row.qty) || 0 }
    const pr = products.find((x) => String(x.id) === String(row.product_id))
    const only = {
      key: keyRef.current++,
      // Opened at the product's own category and sub-category, so the two
      // steps read as where this batch already is rather than as empty
      // filters over a product that is somehow set.
      _mat: String(pr?.material_type || ''),
      _cat: String(pr?.category || ''),
      product_id: String(row.product_id ?? ''),
      formulation_id: fid,
      qty: String(row.qty ?? ''),
      items
    }
    setRuns([only])
    // An edit opens already filled in — that is not a change yet.
    markSheetClean(String(row.prod_date || todayISO()).slice(0, 10), [only])
    setBuilding(true)
  }

  // Stock AS AT the sheet's date, not as at today.
  //
  // A back-dated run has to be judged against the tanks as they stood on the
  // day it ran. Read against today's figure, a day's production that has since
  // been drawn on shows its inputs already negative — SHEA at -31.305 before
  // the run has taken anything — and the whole projection is wrong by whatever
  // has happened since.
  //
  // stock.list({ to }) with no `from` is the closing balance at that date (see
  // stockLevels in src/main/stock.ts), which is exactly the baseline wanted.
  // Today's date returns today's figure, so a same-day sheet is unchanged.
  const [asAtStock, setAsAtStock] = useState<Record<number, number> | null>(null)
  useEffect(() => {
    if (!building) {
      setAsAtStock(null)
      return
    }
    let alive = true
    const day = String(sheetDate || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    void window.api.stock
      .list({ to: day })
      .then((rows) => {
        if (!alive) return
        const m: Record<number, number> = {}
        for (const l of rows) m[l.id as number] = Number(l.stock) || 0
        // And if a run is being edited, undo what it already did: its inputs
        // go back into the tanks, its outputs come out. What is left is the
        // stock the run was recorded against.
        const base = editBaseRef.current
        if (base) {
          for (const line of expandRecipe(base.items, base.qty)) {
            const pid = Number(line.product_id)
            if (!pid) continue
            const amt = Number(line.qty) || 0
            if (line.kind === 'input') m[pid] = (m[pid] ?? 0) + amt
            else if (line.kind === 'output') m[pid] = (m[pid] ?? 0) - amt
          }
          const outPid = Number(editingId ? runs[0]?.product_id : 0)
          if (outPid) m[outPid] = (m[outPid] ?? 0) - base.qty
        }
        setAsAtStock(m)
      })
      .catch(() => {
        // Fall back to the live figure rather than an empty projection.
        if (alive) setAsAtStock(null)
      })
    return () => {
      alive = false
    }
    // runs[0].product_id is read only to undo the edited run's own output, and
    // that product cannot change without the sheet being reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, sheetDate, editingId])

  // What the whole sheet does to stock, walked IN ORDER so a batch can be fed
  // by one above it. Only 'input' lines consume; 'output' lines (recovered
  // fatty acid) add back, and 'loss' lines are simply gone.
  const projection = ((): {
    perRun: { consumes: Row[]; produces: Row[] }[]
    net: Row[]
    short: Row[]
  } => {
    const bal: Record<number, number> = { ...(asAtStock ?? stock) }
    const perRun: { consumes: Row[]; produces: Row[] }[] = []
    const touched = new Set<number>()
    for (const r of runs) {
      const q = Number(r.qty) || 0
      const items: Row[] = Array.isArray(r.items) ? r.items : []
      const consumes: Row[] = []
      const produces: Row[] = []
      // expandRecipe, not the raw percentages.
      //
      // This used to be `(q * it.qty) / 100`, which ignored the TOR multiplier,
      // the recipe's dead loss, and the fatty acid an auto-calculated input
      // recovers. A 100 MT batch on a 106.952% recipe previewed as drawing
      // exactly 100 of CPO and recovering nothing, then posted 106.952 and a
      // fatty-acid credit. Same function as the main process now, so the sheet
      // shows what the save will actually write.
      const nameOf = (pid: number): string =>
        String(items.find((it) => Number(it.product_id) === pid)?.product_name ?? '') ||
        String(products.find((pp) => Number(pp.id) === pid)?.name ?? `#${pid}`)
      for (const line of expandRecipe(items, q)) {
        const pid = Number(line.product_id)
        if (!pid) continue
        const amt = Number(line.qty) || 0
        if (line.kind === 'input') {
          const src = items.find((it) => Number(it.product_id) === pid && String(it.kind) === 'input')
          consumes.push({ product_id: pid, name: nameOf(pid), pct: Number(src?.qty) || 0, amt })
          bal[pid] = (bal[pid] ?? 0) - amt
          touched.add(pid)
        } else if (line.kind === 'output') {
          produces.push({ product_id: pid, name: nameOf(pid), amt })
          bal[pid] = (bal[pid] ?? 0) + amt
          touched.add(pid)
        }
        // A 'loss' line is deliberately NOT a stock movement. src/main/stock.ts
        // counts only kind 'input' and 'output', so dead loss never appears in
        // a balance — showing it here would put DEAD LOSS on the projection
        // sinking further below zero on every run, which is not what the Stock
        // register will say.
      }
      const outPid = Number(r.product_id)
      if (outPid && q > 0) {
        produces.push({ product_id: outPid, name: products.find((p) => Number(p.id) === outPid)?.name, amt: q })
        bal[outPid] = (bal[outPid] ?? 0) + q
        touched.add(outPid)
      }
      perRun.push({ consumes, produces })
    }
    const net = Array.from(touched).map((pid) => ({
      product_id: pid,
      name: products.find((p) => Number(p.id) === pid)?.name ?? `#${pid}`,
      // The SAME baseline `bal` was seeded from, or the two disagree and the
      // Effect column — which is after minus before — reports the difference
      // between two different starting points instead of what this sheet does.
      // On an edit that came out as exactly zero: `before` was the live figure
      // (which already contains the run) and `after` was the run reversed out
      // and re-applied, so the two landed on the same number.
      before: (asAtStock ?? stock)[pid] ?? 0,
      after: bal[pid] ?? 0
    }))
    net.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return { perRun, net, short: net.filter((x) => x.after < -1e-9) }
  })()

  // ------------------------------------------------------- unsaved changes
  //
  // What the sheet looked like when it opened. Comparing against a snapshot
  // rather than "has anything been typed" is what makes this work for an
  // EDIT, which opens already filled in — that is not a change yet.
  const baselineRef = useRef('')
  const sheetShape = JSON.stringify({
    d: sheetDate,
    r: runs.map((r) => [String(r.product_id ?? ''), String(r.formulation_id ?? ''), String(r.qty ?? '')])
  })
  const dirty = building && !saving && sheetShape !== baselineRef.current

  // A browser refresh or a closed tab can only be intercepted here, and the
  // dialog is the BROWSER's own — no page can replace it with its own modal.
  // Leaving by the sheet's own Back button is ours, and that one asks
  // properly (see the dialog at the foot of this file).
  useEffect(() => {
    if (!__WEB__ || !dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const [leaveOpen, setLeaveOpen] = useState(false)
  // Every way out of the sheet goes through here, so none of them can quietly
  // drop a half-typed day's batches.
  function leaveSheet(): void {
    if (dirty) setLeaveOpen(true)
    else setBuilding(false)
  }
  function discardAndLeave(): void {
    setLeaveOpen(false)
    baselineRef.current = ''
    setBuilding(false)
  }
  async function saveAndLeave(): Promise<void> {
    setLeaveOpen(false)
    await save()
  }

  const ready = runs.filter((r) => r.product_id && Number(r.qty) > 0)

  async function save(): Promise<void> {
    if (!ready.length) {
      toast.error('Add at least one batch — a product and a quantity')
      return
    }
    setSaving(true)
    const outcome: Record<number, string> = {}
    try {
      if (editingId) {
        const r = runs[0]
        await window.api.production.update(editingId, {
          prod_date: sheetDate,
          product_id: Number(r.product_id),
          qty: Number(r.qty),
          formulation_id: r.formulation_id || null
        })
        toast.success('Production updated')
        setBuilding(false)
        await load()
        return
      }
      // Posted one after another, in the order they are listed, because a
      // batch may consume the output of one above it. A row that fails leaves
      // the ones already posted alone and stays on the sheet with its reason.
      let done = 0
      let failed = 0
      const survivors: Row[] = []
      for (const r of runs) {
        if (!r.product_id || !(Number(r.qty) > 0)) {
          survivors.push(r)
          continue
        }
        try {
          await window.api.production.create({
            prod_date: sheetDate,
            product_id: Number(r.product_id),
            qty: Number(r.qty),
            formulation_id: r.formulation_id || null
          })
          done++
        } catch (e) {
          failed++
          outcome[r.key as number] = (e as Error).message
          survivors.push(r)
        }
      }
      setResults(outcome)
      if (done) toast.success(`${done} batch${done === 1 ? '' : 'es'} recorded`)
      if (failed) {
        toast.error(`${failed} could not be recorded — left on the sheet`)
        setRuns(survivors.length ? survivors : [blankRun()])
        await load()
        return
      }
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
        {/* The app keeps its page header. The website gets a bar of its own,
            pinned: this sheet is several screens long once a few batches are
            on it, Back is the only way out, and the date and the ready count
            are what the whole sheet posts under — they belong where they stay
            in view rather than in a card that scrolls away. */}
        {!__WEB__ && (
          <PageHeader
            leading={
              <Button variant="outline" size="sm" className="gap-1.5" onClick={leaveSheet}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            }
            title={editingId ? 'Alter production run' : 'Record production'}
            subtitle={
              editingId
                ? 'The recipe is re-applied from the quantity you set'
                : "A day's batches, one row each — stock is drawn from each formula"
            }
          />
        )}
        {__WEB__ && (
          <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 bg-[#0B3D2E] px-5 py-3 text-white shadow-[0_8px_20px_-12px_rgba(10,31,23,0.55)]">
            <div className="flex min-w-0 items-center gap-3.5">
              <button
                type="button"
                className="inline-flex h-[38px] shrink-0 cursor-pointer items-center gap-2 rounded-[4px] border-[1.5px] border-[#C7F03F]/70 px-3.5 text-[13px] font-extrabold uppercase tracking-[.04em] text-[#C7F03F] transition-colors hover:bg-[#C7F03F] hover:text-[#12280B]"
                onClick={leaveSheet}
              >
                <ArrowLeft className="h-[19px] w-[19px]" /> Back
              </button>
              <div className="min-w-0">
                <div className="text-[16px] font-bold tracking-[-0.02em]">
                  {editingId ? 'Alter production run' : 'Record production'}
                </div>
                <div className="mt-0.5 text-[12px] font-semibold text-[#8FBFA8]">
                  {editingId
                    ? 'The recipe is re-applied from the quantity you set'
                    : "A day's batches, one row each — stock is drawn from each formula"}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {/* The real picker, wearing the bar's chip. Moving the date up
                  here left the website with no way to change it at all — the
                  card it used to live in is hidden on this build — so the chip
                  had to become the control rather than a read-out of it.

                  Still no forward-dating: a batch is something that has been
                  run, and recording one for a future date takes stock out of
                  the tanks on a day that has not happened. The bound here is a
                  courtesy; createProduction refuses it whatever the form
                  sends. */}
              <span className="flex items-center gap-1.5 rounded-[3px] border border-white/15 bg-white/[0.08] pr-3">
                <DatePicker
                  min={minDate}
                  max={todayISO()}
                  value={sheetDate}
                  onChange={(v) => setSheetDate(v)}
                  className="!h-auto !w-auto !justify-start !gap-2 !rounded-[3px] !border-0 !bg-transparent !px-3 !py-2 !text-[13px] !font-bold !tabular-nums !text-white !shadow-none hover:!bg-white/10 hover:!text-white [&>svg]:!mr-0 [&>svg]:!h-[17px] [&>svg]:!w-[17px] [&>svg]:!text-[#8FBFA8] [&>svg]:!opacity-100"
                />
                {!editingId && <span className="text-[10.5px] font-semibold text-[#8FBFA8]">applies to every row</span>}
              </span>
              <span
                className={cn(
                  'flex items-center gap-2 rounded-[3px] border px-3 py-2 text-[12px] font-extrabold',
                  ready.length
                    ? 'border-[#C7F03F]/35 bg-[#C7F03F]/15 text-[#C7F03F]'
                    : 'border-[#E2A84A]/50 bg-[#E2A84A]/20 text-[#F0C98A]'
                )}
              >
                {ready.length ? <CheckCircle2 className="h-[17px] w-[17px]" /> : <AlertTriangle className="h-[17px] w-[17px]" />}
                {editingId
                  ? '1 run'
                  : `${ready.length} batch${ready.length === 1 ? '' : 'es'} ready · ${formatNum(ready.reduce((t, r) => t + (Number(r.qty) || 0), 0))} MT`}
              </span>
            </div>
          </div>
        )}
        <div className={cn('flex flex-col gap-4 px-4 py-5', __WEB__ && '!gap-3.5 !py-4')}>
          {/* The date and the ready count moved into the bar above, so this
              card is only the picker itself — and on the website it is not
              needed at all. */}
          <Card className={cn('p-4', __WEB__ && '!hidden')}>
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Date {!editingId && <span className="text-[10px] font-normal normal-case text-muted-foreground">(applies to every row)</span>}</Label>
                <div className="w-48">
                  {/* No forward-dating. A batch is something that has been
                      run — recording one for a future date takes stock out of
                      the tanks on a day that has not happened, and every
                      balance between now and then reads wrong until it does.
                      A courtesy only: the main process refuses it whatever the
                      form sends (see addProduction). */}
                  <DatePicker min={minDate} max={todayISO()} value={sheetDate} onChange={(v) => setSheetDate(v)} />
                </div>
              </div>
              {!editingId && (
                <div className="text-[12px] text-muted-foreground">
                  {ready.length} batch{ready.length === 1 ? '' : 'es'} ready ·{' '}
                  {formatNum(ready.reduce((t, r) => t + (Number(r.qty) || 0), 0))} MT
                </div>
              )}
            </div>
          </Card>

          {/* No overflow-hidden: the product picker renders inline on a plain
              page, and clipping the card clipped the open list. The header and
              footer strips carry their own rounding instead. */}
          <Card
            className={cn(
              'p-0',
              __WEB__ &&
                '!rounded-[4px] !border-[#D6E2D6] !shadow-none [&_input]:!h-11 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[15px] [&_input]:!font-bold [&_input]:!tabular-nums [&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]]:!font-bold'
            )}
          >
            <div className={cn(SHEET_COLS, 'items-center rounded-t-xl border-b bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground', __WEB__ && '!rounded-t-[4px] !border-b-[#DCE7DB] !bg-[#EAF0E9] !px-3.5 !py-3 !text-[11.5px] !font-extrabold !tracking-[.09em] !text-[#33473E]')}>
              <span>#</span>
              <span>Product produced</span>
              <span>Recipe</span>
              <span className="text-right">Quantity (MT)</span>
              <span>Draws from stock</span>
              <span />
            </div>
            {runs.map((r, i) => {
              const recipes = recipesFor(r.product_id)
              const pr = projection.perRun[i]
              const err = results[r.key as number]
              return (
                <div
                  key={r.key as number}
                  className={cn(
                    SHEET_COLS,
                    'items-start border-b px-3 py-2.5 last:border-0',
                    err ? 'bg-red-50' : i % 2 === 1 && 'bg-muted/20',
                    // A row that was refused carries a red edge as well as a
                    // tint — on a sheet of a dozen batches the tint alone is
                    // easy to scroll past.
                    __WEB__ && '!items-start !border-b-[#EAF0E9] !border-l-[3px] !px-3.5 !py-3.5',
                    __WEB__ && (err ? '!border-l-[#B3261E] !bg-[#FDF3F2]' : '!border-l-transparent'),
                    __WEB__ && !err && (i % 2 === 1 ? '!bg-[#FBFDFA]' : '!bg-white')
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground',
                      __WEB__ && '!mt-2 !h-[26px] !w-[26px] !text-[11.5px] !font-bold',
                      __WEB__ && (err ? '!bg-[#F7E0DE] !text-[#8C2F26]' : '!bg-[#EAF0E9] !text-[#33473E]')
                    )}
                  >
                    {i + 1}
                  </span>
                  <div>
                    {/* Category, then sub-category, then the product. Every
                        list is built from the products this page will actually
                        accept — a weighed finished or intermediate good — so a
                        step never offers a route that ends in an empty list,
                        and no product can be filtered out of reach.

                        The sub-category step appears only once a category is
                        picked: on its own it would offer the same three stages
                        against everything at once, which is the list this was
                        meant to cut down. */}
                    {__WEB__ && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <Select
                          value={String(r._mat || 'all')}
                          onValueChange={(v) => {
                            const next = v === 'all' ? '' : v
                            const keep = outputs.some(
                              (p) => String(p.id) === String(r.product_id) && (!next || String(p.material_type) === next)
                            )
                            patchRun(i, {
                              _mat: next,
                              _cat: '',
                              ...(keep ? {} : { product_id: '', formulation_id: null, items: [] })
                            })
                          }}
                        >
                          <SelectTrigger className="!h-9 !rounded-[4px] !border-[#DCE7DB] !bg-[#F7FAF6] !text-[12px] !font-bold">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All categories</SelectItem>
                            {[...new Set(outputs.map((p) => String(p.material_type || '')).filter(Boolean))]
                              .sort()
                              .map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {!!r._mat && (
                          <Select
                            value={String(r._cat || 'all')}
                            onValueChange={(v) => {
                              const next = v === 'all' ? '' : v
                              const keep = outputs.some(
                                (p) => String(p.id) === String(r.product_id) && (!next || String(p.category) === next)
                              )
                              patchRun(i, {
                                _cat: next,
                                ...(keep ? {} : { product_id: '', formulation_id: null, items: [] })
                              })
                            }}
                          >
                            <SelectTrigger className="!h-9 !rounded-[4px] !border-[#DCE7DB] !bg-[#F7FAF6] !text-[12px] !font-bold">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All sub-categories</SelectItem>
                              {[
                                ...new Set(
                                  outputs
                                    .filter((p) => String(p.material_type || '') === String(r._mat))
                                    .map((p) => String(p.category || ''))
                                    .filter(Boolean)
                                )
                              ]
                                .sort()
                                .map((c) => (
                                  <SelectItem key={c} value={c}>{CAT_LABEL[c] ?? c}</SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}
                    <Select value={String(r.product_id ?? '')} onValueChange={(v) => void chooseProduct(i, v)}>
                      {/* Amber while empty: it is the field every other
                          column on the row waits on, so an unset one is a
                          prompt rather than a blank. */}
                      <SelectTrigger className={cn(__WEB__ && !r.product_id && '!border-[#E3C58C] !text-[#5A6B62]')}>
                        <SelectValue placeholder="Finished good or intermediate" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {outputs
                          .filter((p) => !__WEB__ || !r._mat || String(p.material_type || '') === String(r._mat))
                          .filter((p) => !__WEB__ || !r._cat || String(p.category || '') === String(r._cat))
                          .map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.name} · {CAT_LABEL[p.category] ?? p.category}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {err && (
                      <p className={cn('mt-1 text-[11px] leading-snug text-red-700', __WEB__ && '!mt-2 !flex !items-start !gap-1.5 !text-[11.5px] !font-bold !leading-snug !text-[#8C2F26]')}>
                        {__WEB__ && <AlertTriangle className="h-4 w-4 shrink-0 text-[#B3261E]" />}
                        {err}
                      </p>
                    )}
                  </div>
                  <div>
                    {recipes.length > 1 ? (
                      <Select
                        value={String(r.formulation_id ?? '')}
                        onValueChange={(v) => void chooseRecipe(i, Number(v))}
                      >
                        <SelectTrigger className={cn(__WEB__ && !r.formulation_id && '!border-[#E3C58C] !text-[#5A6B62]')}>
                          <SelectValue placeholder="Choose a recipe" />
                        </SelectTrigger>
                        <SelectContent>
                          {recipes.map((f) => (
                            <SelectItem key={f.id} value={String(f.id)}>
                              {f.name || `Recipe #${f.id}`} · TOR {formatNum(f.tor)}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className={cn('flex h-9 items-center text-[12px] text-muted-foreground', __WEB__ && '!h-11 !flex-col !items-start !justify-center')}>
                        {!r.product_id ? (
                          <span className={cn('italic opacity-70', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>pick a product first</span>
                        ) : recipes.length === 1 ? (
                          <>
                            <span className={cn('truncate', __WEB__ && '!w-full !text-[12.5px] !font-extrabold !text-[#0A1F17]')} title={String(recipes[0].name || '')}>
                              {recipes[0].name || `Recipe #${recipes[0].id}`}
                            </span>
                            {/* The multiplier the batch is struck on. It is
                                what turns the quantity into the draw beside
                                it, and the only recipe fact worth the row. */}
                            {__WEB__ && (
                              <span className="mt-1 text-[12.5px] font-bold tabular-nums text-[#33473E]">
                                TOR {formatNum(recipes[0].tor)}%
                              </span>
                            )}
                          </>
                        ) : (
                          <span className={cn('italic opacity-70', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>no recipe — nothing consumed</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <Input
                      type="number"
                      className="pr-9 text-right tabular-nums"
                      placeholder="0.000"
                      value={String(r.qty ?? '')}
                      onChange={(e) => patchRun(i, { qty: e.target.value })}
                      // Enter on the last row opens the next one, so a day's
                      // batches can be typed straight through without reaching
                      // for the mouse between each.
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || editingId) return
                        if (i !== runs.length - 1) return
                        if (!r.product_id || !(Number(r.qty) > 0)) return
                        e.preventDefault()
                        setRuns((prev) => [...prev, blankRun()])
                      }}
                    />
                    <span className={cn('pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground', __WEB__ && '!text-[11px] !font-bold !text-[#5A6B62]')}>
                      MT
                    </span>
                  </div>
                  <div className={cn('pt-1 text-[11px] leading-relaxed text-muted-foreground', __WEB__ && '!pt-0')}>
                    {!pr || !pr.consumes.length ? (
                      <span className={cn('italic opacity-70', __WEB__ && '!flex !h-11 !items-center !text-[12px] !font-semibold !not-italic !text-[#5A6B62] !opacity-100')}>
                        {r.product_id ? 'nothing consumed' : 'shows once a product and a quantity are set'}
                      </span>
                    ) : __WEB__ ? (
                      (() => {
                        // A bar per component, scaled against the largest draw
                        // on this batch, and RED when the tank cannot cover it.
                        // The figures alone said what came out; they never said
                        // whether it was there to come out.
                        const maxAmt = Math.max(1e-9, ...pr.consumes.map((cc) => Number(cc.amt) || 0))
                        return (
                          <>
                            {pr.consumes.map((cc, k) => {
                              const after = projection.net.find((x) => String(x.product_id) === String(cc.product_id))
                              const short = after ? Number(after.after) < -1e-9 : false
                              return (
                                <div key={k} className="flex items-center gap-2.5 py-[3px]">
                                  <span className="w-[78px] shrink-0 truncate text-[11.5px] font-bold text-[#33473E]" title={cc.name}>
                                    {cc.name}
                                  </span>
                                  <span className="h-[5px] min-w-[24px] flex-1 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                                    <span
                                      className="block h-full"
                                      style={{
                                        width: `${((Number(cc.amt) || 0) / maxAmt) * 100}%`,
                                        background: short ? '#B3261E' : '#12855A'
                                      }}
                                    />
                                  </span>
                                  <span className="shrink-0 whitespace-nowrap text-[12.5px] font-bold tabular-nums">
                                    {formatNum(cc.amt)}
                                  </span>
                                </div>
                              )
                            })}
                            {/* Recovered by-product goes back IN. Netting it
                                silently against the draws made a recipe look
                                cheaper on stock than it is.
                                The batch's OWN output is in `produces` too and
                                is filtered out here — it is the thing being
                                made, not something recovered alongside it. */}
                            {(() => {
                              const recovered = (pr.produces ?? []).filter(
                                (pp) => String(pp.product_id) !== String(r.product_id)
                              )
                              if (!recovered.length) return null
                              return (
                                <div className="mt-1.5 flex items-center gap-2 border-t border-t-[#EAF0E9] pt-1.5">
                                  <ArrowDownLeft className="h-[15px] w-[15px] shrink-0 text-[#0B6B45]" />
                                  <span className="text-[11px] font-bold text-[#0B6B45]">
                                    {recovered.map((pp) => `${pp.name} ${formatNum(pp.amt)}`).join(', ')} added back
                                  </span>
                                </div>
                              )
                            })()}
                          </>
                        )
                      })()
                    ) : (
                      pr.consumes.map((cc, k) => (
                        <div key={k} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate">{cc.name}</span>
                          <span className="shrink-0 tabular-nums text-foreground">{formatNum(cc.amt)}</span>
                        </div>
                      ))
                    )}
                  </div>
                  {!editingId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn('mt-1 h-7 w-7 text-muted-foreground hover:text-red-600', __WEB__ && '!mt-2 !h-[30px] !w-[30px] !rounded-[3px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !text-[#B3261E] hover:!bg-[#FBE9E7]')}
                      title="Remove this row"
                      onClick={() =>
                        setRuns((prev) => {
                          const next = prev.filter((_, idx) => idx !== i)
                          return next.length ? next : [blankRun()]
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )
            })}
            {!editingId && (
              <div className={cn('flex items-center justify-between gap-2 rounded-b-xl bg-muted/30 px-3 py-2', __WEB__ && '!flex-wrap !gap-3 !rounded-b-[4px] !border-t !border-t-[#E4ECE3] !bg-[#F7FAF6] !px-3.5 !py-3')}>
                <Button
                  type="button"
                  size="sm"
                  className={cn('h-8 gap-1.5 bg-emerald-600 text-[12px] font-semibold text-white hover:bg-emerald-700', __WEB__ && '!h-[38px] !gap-2 !rounded-[3px] !bg-[#0B3D2E] !px-3.5 !text-[12.5px] !font-extrabold !text-[#C7F03F] hover:!bg-[#0F4A38]')}
                  onClick={() => setRuns((prev) => [...prev, blankRun()])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add another batch
                </Button>
                <span className={cn('text-[11px] text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}>
                  {runs.length} row{runs.length === 1 ? '' : 's'} · they post in this order, so one batch
                  can feed the next
                </span>
              </div>
            )}
          </Card>

          {/* What the sheet does to the tanks as a whole. Walked in order, so a
              batch fed by one above it reads correctly instead of looking short. */}
          {projection.net.length > 0 && (
            <Card
              className={cn(
                'p-0',
                __WEB__ && '!overflow-hidden !rounded-[4px] !shadow-none',
                // The card itself turns when something goes below zero — it is
                // the one thing on this sheet that is a warning rather than a
                // reading.
                __WEB__ && (projection.short.length ? '!border-[#F0D6D4]' : '!border-[#D6E2D6]')
              )}
            >
              <div
                className={cn(
                  'border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                  __WEB__ && '!flex !flex-wrap !items-center !justify-between !gap-3 !px-4 !py-3 !text-[11px] !font-extrabold !tracking-[.14em]',
                  __WEB__ &&
                    (projection.short.length
                      ? '!border-b-[#F0D6D4] !bg-[#FDF3F2] !text-[#8C2F26]'
                      : '!border-b-[#E4ECE3] !bg-[#F7FAF6] !text-[#33473E]')
                )}
              >
                <span className={cn(__WEB__ && '!flex !items-center !gap-2')}>
                  {__WEB__ && <Boxes className="h-[18px] w-[18px]" />}
                  Stock after the whole sheet
                </span>
                {__WEB__ && projection.short.length > 0 && (
                  <span className="flex items-center gap-1.5 rounded-[2px] bg-[#B3261E] px-2.5 py-1.5 text-[11.5px] font-extrabold normal-case tracking-normal text-white">
                    <AlertTriangle className="h-[15px] w-[15px]" />
                    {projection.short.length} below zero
                  </span>
                )}
              </div>
              {/* A divider on every cell but the first, so the three money
                  columns each have a rule to follow down. Set on the table so
                  the header and the rows cannot line up differently. */}
              <Table className={cn(__WEB__ && '[&_tr>*+*]:!border-l [&_tr>*+*]:!border-l-[#E4ECE3]')}>
                <TableHeader>
                  <TableRow className={cn(__WEB__ && '!border-b-[#DCE7DB] !bg-[#EAF0E9] hover:!bg-[#EAF0E9] [&>th]:!h-auto [&>th]:!py-3 [&>th]:!text-[11.5px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.09em] [&>th]:!text-[#33473E]')}>
                    <TableHead>Product</TableHead>
                    {/* Named by the day it is read on, because on a back-dated
                        sheet "current" is not today. */}
                    <TableHead className="text-right">
                      {__WEB__
                        ? sheetDate === todayISO()
                          ? 'Current stock'
                          : `Stock on ${formatDate(sheetDate)}`
                        : 'Now'}
                    </TableHead>
                    {/* Effect, not "used": this column carries both directions
                        — what a batch draws out AND what it puts back, the
                        recovered fatty acid and the output itself included. */}
                    <TableHead className="text-right">{__WEB__ ? 'Effect' : 'Change'}</TableHead>
                    <TableHead className="text-right">{__WEB__ ? 'After production' : 'After'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projection.net.map((x) => {
                    const change = Number(x.after) - Number(x.before)
                    return (
                      <TableRow
                        key={x.product_id as number}
                        className={cn(
                          __WEB__ && '!border-b-[#EAF0E9] !border-l-[3px] [&>td]:!py-2.5',
                          __WEB__ && (Number(x.after) < -1e-9 ? '!border-l-[#B3261E] !bg-[#FDF7F6]' : '!border-l-transparent !bg-white')
                        )}
                      >
                        <TableCell className={cn('font-medium', __WEB__ && '!text-[13px] !font-extrabold')}>{x.name}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', __WEB__ && '!whitespace-nowrap !text-[13px] !font-semibold', __WEB__ && (Number(x.before) < -1e-9 ? '!text-[#B3261E]' : '!text-[#33473E]'))}>{formatNum(x.before)}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            change < 0 ? 'text-red-700' : 'text-emerald-700',
                            __WEB__ && '!whitespace-nowrap !text-[13px] !font-bold',
                            __WEB__ && (change < 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]')
                          )}
                        >
                          {change > 0 ? '+' : ''}
                          {formatNum(change)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold tabular-nums',
                            Number(x.after) < -1e-9 && 'text-red-600',
                            __WEB__ && '!whitespace-nowrap !text-[14px] !font-bold',
                            __WEB__ && (Number(x.after) < -1e-9 ? '!text-[#B3261E]' : '!text-[#0A1F17]')
                          )}
                        >
                          {formatNum(x.after)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {projection.short.length > 0 && (
                <p className={cn('border-t bg-amber-50 px-3 py-2 text-[11px] text-amber-900', __WEB__ && '!flex !items-start !gap-2.5 !border-t-[#F0E4CB] !bg-[#FFFBF2] !px-4 !py-3 !text-[12.5px] !font-bold !leading-relaxed !text-[#8A5300]')}>
                  {__WEB__ && <AlertTriangle className="h-[19px] w-[19px] shrink-0 text-[#C2700A]" />}
                  <span>
                    {projection.short.map((sh) => sh.name).join(', ')} would go below zero. It can still be recorded —
                    the Stock register will show the shortage in red.
                  </span>
                </p>
              )}
            </Card>
          )}

          {/* Pinned, and carrying what the sheet is about to do. Batches post
              in the order listed, which matters when one feeds the next — and
              that was written nowhere. */}
          <div
            className={cn(
              'flex justify-end gap-2',
              __WEB__ &&
                '!sticky !bottom-0 !z-10 !items-center !gap-2.5 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-4 !py-3.5 !shadow-[0_-6px_18px_-8px_rgba(10,31,23,0.28)]'
            )}
          >
            {__WEB__ && (
              <span
                className={cn(
                  'mr-auto flex items-center gap-2 text-[12px] font-bold',
                  ready.length ? 'text-[#5A6B62]' : 'text-[#8A5300]'
                )}
              >
                {ready.length ? (
                  <CheckCircle2 className="h-[17px] w-[17px] shrink-0 text-[#12855A]" />
                ) : (
                  <AlertTriangle className="h-[17px] w-[17px] shrink-0 text-[#C2700A]" />
                )}
                {!ready.length
                  ? 'Add at least one batch — a product and a quantity'
                  : editingId
                    ? 'The recipe re-applies from the quantity above; the run keeps its id.'
                    : 'Batches post in the order listed — a later one can consume what an earlier one produced.'}
              </span>
            )}
            <Button
              variant="outline"
              onClick={leaveSheet}
              disabled={saving}
              className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !ready.length}
              className={cn(__WEB__ && '!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38] disabled:!bg-[#C3D2C6] disabled:!text-[#F1F5EF]')}
            >
              {__WEB__ && !saving && <CheckCircle2 className="h-[19px] w-[19px]" />}
              {saving
                ? 'Saving…'
                : editingId
                  ? 'Save changes'
                  : `Record ${ready.length} batch${ready.length === 1 ? '' : 'es'}`}
            </Button>
          </div>
        </div>

        {/* Leaving with something typed and nothing saved.
            A browser refresh cannot be caught with a dialog of our own — that
            one is the browser's, raised by the beforeunload guard above. This
            is for every exit the page itself owns: Back, and Cancel. */}
        <Dialog open={leaveOpen} onOpenChange={(o) => !o && setLeaveOpen(false)}>
          <DialogContent
            className={cn(
              'max-w-md',
              __WEB__ && '!gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!hidden'
            )}
          >
            <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left')}>
              {__WEB__ && (
                <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Production</div>
              )}
              <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>
                Leave without recording?
              </DialogTitle>
            </DialogHeader>
            <p className={cn('text-[12px] text-muted-foreground', __WEB__ && '!px-5 !py-4 !text-[13px] !font-semibold !leading-relaxed !text-[#33473E]')}>
              {ready.length
                ? `${ready.length} batch${ready.length === 1 ? '' : 'es'} on this sheet ${ready.length === 1 ? 'has' : 'have'} not been recorded. Nothing has been drawn from stock yet — leaving now discards ${ready.length === 1 ? 'it' : 'them'}.`
                : 'This sheet has not been recorded. Nothing has been drawn from stock yet — leaving now discards what you have typed.'}
            </p>
            <DialogFooter className={cn('gap-2', __WEB__ && '!flex-wrap !border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5')}>
              <Button
                variant="outline"
                onClick={() => setLeaveOpen(false)}
                className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
              >
                Keep editing
              </Button>
              <Button
                variant="outline"
                onClick={discardAndLeave}
                className={cn(__WEB__ && '!h-12 !rounded-[4px] !border-[1.5px] !border-[#F0D6D4] !bg-[#FDF3F2] !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#B3261E] hover:!bg-[#FBE9E7]')}
              >
                Discard
              </Button>
              {/* Only offered when there is something recordable — a half-typed
                  row cannot be saved, and a button that fails on click is worse
                  than one that is not there. */}
              {ready.length > 0 && (
                <Button
                  onClick={() => void saveAndLeave()}
                  disabled={saving}
                  className={cn(__WEB__ && '!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]')}
                >
                  {__WEB__ && <CheckCircle2 className="h-[18px] w-[18px]" />}
                  Record {ready.length} batch{ready.length === 1 ? '' : 'es'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Production"
        subtitle={factoryName ? `Daily production runs — ${factoryName}` : 'Daily production runs'}
        hint="Every batch run at this factory, whichever company booked it — production is work on the plant floor, and its output lands in one set of tanks. Recording a run consumes the formula's input products from stock and adds the produced output. The formula must total 100%."
        actions={
          <div className="flex items-center gap-2">
            {__WEB__ && prodOptions.length > 1 && (
              <Select value={prodFilter ? String(prodFilter) : 'all'} onValueChange={(v) => setProdFilter(v === 'all' ? 0 : Number(v))}>
                <SelectTrigger className="h-9 w-[11rem] text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  {prodOptions.map(([id, name]) => (
                    <SelectItem key={id} value={String(id)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {__WEB__ && (recipeOptions.length > 1 || subOptions.length > 0) && (
              <Select value={recipeFilter || 'all'} onValueChange={(v) => setRecipeFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="h-9 w-[12rem] text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Beaker className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All recipes</SelectItem>
                  {subOptions.map(([id, name]) => (
                    <SelectItem key={`sub-${id}`} value={`sub:${id}`}>{name} — whole group</SelectItem>
                  ))}
                  {recipeOptions.map(([id, name]) => (
                    <SelectItem key={`f-${id}`} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {__WEB__ && anyFilter && (
              <Button
                size="sm"
                variant="ghost"
                className="!h-9 !px-2.5 !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !text-[#5A6B62]"
                onClick={() => {
                  setProdFilter(0)
                  setRecipeFilter('')
                }}
              >
                Clear
              </Button>
            )}
            {/* The site, stated rather than chosen. There is one register per
                factory now, so a picker here would have nothing to pick. */}
            {__WEB__ && !!factoryName && (
              <span className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-3 text-xs font-semibold text-foreground">
                <Factory className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {factoryName}
              </span>
            )}
            <ExcelButton
              filename={`production-${todayISO()}`}
              sheetName="Production"
              title="Production runs"
              columns={[
                { header: 'Date', key: 'prod_date', value: (r) => formatDate(r.prod_date) },
                { header: 'Booked by', key: 'company_name', value: (r) => r.company_name || '' },
                { header: 'Product', key: 'product_name', value: (r) => r.product_name || '' },
                { header: 'Category', key: 'product_category', value: (r) => CAT_LABEL[r.product_category] ?? r.product_category ?? '' },
                { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
                { header: 'UOM', key: 'uom', value: (r) => r.uom || '' }
              ]}
              rows={visible}
            />
            <Button
              size="sm"
              className={cn(__WEB__ && '!gap-2 !bg-[#C7F03F] !px-4 !font-extrabold !text-[#12280B] hover:!bg-[#B8E32E]')}
              onClick={openAdd}
              disabled={outputs.length === 0}
            >
              <Plus className="h-4 w-4" />
              Record production
            </Button>
          </div>
        }
      />
      <div className={cn('px-4 py-6', __WEB__ && '!py-4')}>
        <div className={cn('rounded-lg border bg-card', __WEB__ && '!overflow-x-auto !rounded-[4px] !border-[#D6E2D6] !bg-white')}>
          <Table className={cn(__WEB__ && '!min-w-[840px]')}>
            <TableHeader>
              <TableRow className={cn(PD_HEAD)}>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">
                  <span className={cn(__WEB__ && '!text-[#C7F03F]')}>Qty</span>
                </TableHead>
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
                  <TableCell colSpan={5} className={cn('py-10 text-center text-muted-foreground', __WEB__ && '!py-12')}>
                    {__WEB__ ? (
                      <span className="flex flex-col items-center gap-2.5">
                        <Factory className="h-[30px] w-[30px] text-[#C3D2C6]" />
                        <span className="text-[13px] font-bold text-[#5A6B62]">No production recorded yet.</span>
                        <Button
                          className="!mt-1 !h-[42px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[13px] !font-extrabold !text-[#C7F03F] hover:!bg-[#0F4A38]"
                          onClick={openAdd}
                          disabled={outputs.length === 0}
                        >
                          <Plus className="h-[19px] w-[19px]" /> Record the first batch
                        </Button>
                      </span>
                    ) : (
                      'No production recorded yet.'
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                paged.pageRows.map((row, ri) => {
                  // A day's batches band together under one date, with the
                  // day's own count and total, and the band folds them away.
                  // A mill runs several batches a day: the flat list repeated
                  // the date on every one of them without ever saying what the
                  // day came to, and a busy week ran off the screen.
                  const day = String(row.prod_date).slice(0, 10)
                  const startsDay =
                    ri === 0 || String(paged.pageRows[ri - 1].prod_date).slice(0, 10) !== day
                  const dayRows = startsDay
                    ? paged.pageRows.filter((r) => String(r.prod_date).slice(0, 10) === day)
                    : []
                  // Only the website bands its rows, so only the website can
                  // fold them: the desktop list has no band to click.
                  const shut = __WEB__ && !openDays.has(day)
                  return (
                  <Fragment key={row.id as number}>
                    {__WEB__ && startsDay && (
                      <TableRow
                        // Anywhere on the band folds it, because a band that
                        // is one wide strip and only clickable on its left
                        // eighth reads as broken. The real control is the
                        // button below — it is what a keyboard reaches and
                        // what a screen reader is told about — and this is a
                        // convenience laid over it.
                        onClick={() => toggleDay(day)}
                        className="!cursor-pointer !select-none !border-b-[#DCE7DB] !bg-[#EFF5EC] hover:!bg-[#E6EFE2] [&>td]:!py-2"
                      >
                        <TableCell className="!font-bold">
                          <button
                            type="button"
                            aria-expanded={!shut}
                            title={shut ? 'Show this day’s batches' : 'Hide this day’s batches'}
                            // Or the row's own handler fires straight after
                            // this one and folds the day back the way it was.
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleDay(day)
                            }}
                            className="flex items-center gap-2 rounded-[3px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B3D2E]"
                          >
                            <ChevronRight
                              className={cn(
                                'h-[17px] w-[17px] shrink-0 text-[#0B3D2E] transition-transform',
                                !shut && 'rotate-90'
                              )}
                            />
                            <CalendarDays className="h-[17px] w-[17px] shrink-0 text-[#0B3D2E]" />
                            <span className="text-[13px] font-bold tabular-nums">{formatDate(row.prod_date)}</span>
                          </button>
                        </TableCell>
                        <TableCell className="!text-[11.5px] !font-bold !text-[#5A6B62]">
                          {dayRows.length} batch{dayRows.length === 1 ? '' : 'es'}
                          {shut && <span className="!ml-1.5 !text-[#8FA79B]">· hidden</span>}
                        </TableCell>
                        <TableCell />
                        <TableCell className="!text-right !text-[13px] !font-bold !tabular-nums">
                          {formatNum(dayRows.reduce((t, r) => t + (Number(r.qty) || 0), 0))}{' '}
                          <span className="text-[10px] font-semibold text-[#5A6B62]">{row.uom || 'MT'}</span>
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    )}
                  {!shut && (
                  <TableRow
                    className={cn(__WEB__ && '!border-b-[#EAF0E9] !bg-white hover:!bg-[#F7FAF6] [&>td]:!py-2.5')}
                  >
                    <TableCell className={cn(__WEB__ && '!text-[13.5px] !font-bold !tabular-nums !text-[#33473E]')}>
                      {formatDate(row.prod_date)}
                    </TableCell>
                    <TableCell className={cn('font-medium', __WEB__ && '!text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                      {row.product_name}
                      {row.formulation_name && (
                        <div className={cn('text-xs font-normal text-muted-foreground', __WEB__ && '!mt-0.5 !text-[12px] !font-bold !text-[#33473E]')}>
                          {row.formulation_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.product_category === 'finished' ? 'success' : 'secondary'}
                        className={cn(
                          __WEB__ && '!rounded-[2px] !border !px-2 !py-1 !text-[10.5px] !font-extrabold !uppercase !tracking-[.06em]',
                          __WEB__ &&
                            (row.product_category === 'finished'
                              ? '!border-[#BFE3CB] !bg-[#E9F5EE] !text-[#0B6B45]'
                              : '!border-[#DCE7DB] !bg-[#EAF0E9] !text-[#33473E]')
                        )}
                      >
                        {CAT_LABEL[row.product_category] ?? row.product_category}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn('text-right tabular-nums', __WEB__ && '!whitespace-nowrap !text-[14px] !font-bold')}>
                      {formatNum(row.qty)} <span className={cn(__WEB__ && '!text-[10.5px] !font-semibold !text-[#5A6B62]')}>{row.uom}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* A mistyped batch can be corrected rather than deleted
                          and re-entered — the recipe is re-applied from the
                          quantity you set, and the run keeps its id. */}
                      {__WEB__ ? (
                        <div className="flex justify-end">
                          <RowActions
                            actions={[
                              { label: 'Edit this run', icon: Pencil, onClick: () => void openEdit(row) },
                              {
                                label: 'Delete this run — returns its stock',
                                icon: Trash2,
                                danger: true,
                                onClick: () => del(row)
                              }
                            ]}
                          />
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit this run" onClick={() => void openEdit(row)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Delete this run" onClick={() => del(row)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  )}
                  </Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
          <Pagination {...paged} label="runs" className="border-t px-3" />
        </div>
      </div>
    </>
  )
}
