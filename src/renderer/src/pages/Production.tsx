import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
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

export function Production(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('production')
  const [rows, setRows] = useState<Row[]>([])
  const paged = usePaged(rows)
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

  const blankRun = (): Row => ({
    key: keyRef.current++,
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

  function openAdd(): void {
    setEditingId(null)
    setSheetDate(todayISO())
    setRuns([blankRun()])
    setResults({})
    setBuilding(true)
  }

  async function openEdit(row: Row): Promise<void> {
    setEditingId(Number(row.id))
    setSheetDate(String(row.prod_date || todayISO()).slice(0, 10))
    setResults({})
    const fid = row.formulation_id ? Number(row.formulation_id) : null
    const items = fid ? await window.api.formulations.items(fid) : []
    setRuns([
      {
        key: keyRef.current++,
        product_id: String(row.product_id ?? ''),
        formulation_id: fid,
        qty: String(row.qty ?? ''),
        items
      }
    ])
    setBuilding(true)
  }

  // What the whole sheet does to stock, walked IN ORDER so a batch can be fed
  // by one above it. Only 'input' lines consume; 'output' lines (recovered
  // fatty acid) add back, and 'loss' lines are simply gone.
  const projection = ((): {
    perRun: { consumes: Row[]; produces: Row[] }[]
    net: Row[]
    short: Row[]
  } => {
    const bal: Record<number, number> = { ...stock }
    const perRun: { consumes: Row[]; produces: Row[] }[] = []
    const touched = new Set<number>()
    for (const r of runs) {
      const q = Number(r.qty) || 0
      const items: Row[] = Array.isArray(r.items) ? r.items : []
      const consumes: Row[] = []
      const produces: Row[] = []
      for (const it of items) {
        const amt = (q * Number(it.qty)) / 100
        const pid = Number(it.product_id)
        if (String(it.kind) === 'input') {
          consumes.push({ product_id: pid, name: it.product_name, pct: Number(it.qty), amt })
          if (pid) {
            bal[pid] = (bal[pid] ?? 0) - amt
            touched.add(pid)
          }
        } else if (String(it.kind) === 'output' && pid) {
          produces.push({ product_id: pid, name: it.product_name, amt })
          bal[pid] = (bal[pid] ?? 0) + amt
          touched.add(pid)
        }
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
      before: stock[pid] ?? 0,
      after: bal[pid] ?? 0
    }))
    net.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return { perRun, net, short: net.filter((x) => x.after < -1e-9) }
  })()

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
        <PageHeader
          leading={
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBuilding(false)}>
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
        <div className="flex flex-col gap-4 px-4 py-5">
          <Card className="p-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Date {!editingId && <span className="text-[10px] font-normal normal-case text-muted-foreground">(applies to every row)</span>}</Label>
                <div className="w-48">
                  <DatePicker min={minDate} value={sheetDate} onChange={(v) => setSheetDate(v)} />
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
          <Card className="p-0">
            <div className={cn(SHEET_COLS, 'items-center rounded-t-xl border-b bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground')}>
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
                    err ? 'bg-red-50' : i % 2 === 1 && 'bg-muted/20'
                  )}
                >
                  <span className="mt-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div>
                    <Select value={String(r.product_id ?? '')} onValueChange={(v) => void chooseProduct(i, v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Finished good or intermediate" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {outputs.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name} · {CAT_LABEL[p.category] ?? p.category}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {err && <p className="mt-1 text-[11px] leading-snug text-red-700">{err}</p>}
                  </div>
                  <div>
                    {recipes.length > 1 ? (
                      <Select
                        value={String(r.formulation_id ?? '')}
                        onValueChange={(v) => void chooseRecipe(i, Number(v))}
                      >
                        <SelectTrigger>
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
                      <div className="flex h-9 items-center text-[12px] text-muted-foreground">
                        {!r.product_id ? (
                          <span className="italic opacity-70">pick a product first</span>
                        ) : recipes.length === 1 ? (
                          <span className="truncate" title={String(recipes[0].name || '')}>
                            {recipes[0].name || `Recipe #${recipes[0].id}`}
                          </span>
                        ) : (
                          <span className="italic opacity-70">no recipe — nothing consumed</span>
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
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                      MT
                    </span>
                  </div>
                  <div className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {!pr || !pr.consumes.length ? (
                      <span className="italic opacity-70">
                        {r.product_id ? 'nothing consumed' : 'shows once a product and a quantity are set'}
                      </span>
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
                      className="mt-1 h-7 w-7 text-muted-foreground hover:text-red-600"
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
              <div className="flex items-center justify-between gap-2 rounded-b-xl bg-muted/30 px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5 bg-emerald-600 text-[12px] font-semibold text-white hover:bg-emerald-700"
                  onClick={() => setRuns((prev) => [...prev, blankRun()])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add another batch
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {runs.length} row{runs.length === 1 ? '' : 's'} · they post in this order, so one batch
                  can feed the next
                </span>
              </div>
            )}
          </Card>

          {/* What the sheet does to the tanks as a whole. Walked in order, so a
              batch fed by one above it reads correctly instead of looking short. */}
          {projection.net.length > 0 && (
            <Card className="p-0">
              <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Stock after the whole sheet
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Now</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">After</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projection.net.map((x) => {
                    const change = Number(x.after) - Number(x.before)
                    return (
                      <TableRow key={x.product_id as number}>
                        <TableCell className="font-medium">{x.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(x.before)}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            change < 0 ? 'text-red-700' : 'text-emerald-700'
                          )}
                        >
                          {change > 0 ? '+' : ''}
                          {formatNum(change)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold tabular-nums',
                            Number(x.after) < -1e-9 && 'text-red-600'
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
                <p className="border-t bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                  {projection.short.map((s) => s.name).join(', ')} would go below zero. It can still be
                  recorded — the Stock register will show the shortage in red.
                </p>
              )}
            </Card>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBuilding(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !ready.length}>
              {saving
                ? 'Saving…'
                : editingId
                  ? 'Save changes'
                  : `Record ${ready.length} batch${ready.length === 1 ? '' : 'es'}`}
            </Button>
          </div>
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
                      {/* A mistyped batch can be corrected rather than deleted
                          and re-entered — the recipe is re-applied from the
                          quantity you set, and the run keeps its id. */}
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Alter this run"
                          onClick={() => void openEdit(row)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          title="Delete this run"
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
          <Pagination {...paged} label="runs" className="border-t px-3" />
        </div>
      </div>
    </>
  )
}
