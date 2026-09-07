import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ArrowRight, Beaker, Calculator, CheckCircle2, Flame, Info, Layers, Package, Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
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
import { ColumnFilter } from '@/components/ui/column-filter'
import { RowActions } from '@/components/ui/row-actions'
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
    formulaText: 'text-sky-800',
    // Website tones. Inputs are what the batch draws in, so they take the
    // page's own forest; by-products come back out as stock and read green;
    // loss is written off and reads red. Sky/emerald/rose belonged to the
    // desktop app.
    webHead: '!border-b-[#E4ECE3] !bg-[#F7FAF6] !text-[#0A1F17]',
    webIcon: '!text-[#0B3D2E]',
    webAccent: '!border-l-[#0B3D2E]',
    webCalcBox: '!border-[#D6E2D6] !bg-[#F7FAF6]',
    webFormula: '!text-[#33473E]',
    webAdd: '!border-[#0B3D2E] !bg-[#0B3D2E] !text-[#C7F03F] hover:!bg-[#0F4A38]',
    step: '2',
    webStep: '!bg-[#0B3D2E] !text-[#C7F03F]',
    webCount: '!border-[#0B6B45] !bg-[#0B6B45] !text-white'
  },
  {
    kind: 'output' as const,
    title: 'By-products',
    // What these are, rather than where they end up: the inputs already
    // recover a by-product automatically, and this section is the manual
    // one kept for recipes booked before that existed.
    subtitle: 'Recovered alongside the output',
    add: 'Add by-product',
    icon: Sparkles,
    grad: 'from-emerald-600 to-emerald-500',
    accent: 'border-emerald-400',
    calcBox: 'border-emerald-200 bg-emerald-50/60',
    formulaText: 'text-emerald-800',
    // Blue, not green. Green already means "the sale side" across this app,
    // and on this page it is the colour the AUTO by-product wears — the one
    // each input recovers from its own FFA. This section is the manual
    // alternative, and two different things sharing one colour on one screen
    // is what makes a reader stop and check which is which.
    webHead: '!border-b-[#C6DAF0] !bg-[#F4F8FD] !text-[#1B4E82]',
    webIcon: '!text-[#1B4E82]',
    webAccent: '!border-l-[#1B4E82]',
    webCalcBox: '!border-[#C6DAF0] !bg-[#F4F8FD]',
    webFormula: '!text-[#1B4E82]',
    webAdd: '!border-[#C6DAF0] !bg-white !text-[#1B4E82] hover:!bg-[#F4F8FD]',
    step: '3',
    webStep: '!bg-[#1B4E82] !text-white',
    webCount: '!border-[#1B4E82] !bg-[#1B4E82] !text-white'
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
    formulaText: 'text-rose-800',
    webHead: '!border-b-[#F0D6D4] !bg-[#FDF3F2] !text-[#8C2F26]',
    webIcon: '!text-[#8C2F26]',
    webAccent: '!border-l-[#B3261E]',
    webCalcBox: '!border-[#F0D6D4] !bg-[#FDF3F2]',
    webFormula: '!text-[#8C2F26]',
    webAdd: '!border-[#E3A79A] !bg-white !text-[#8C2F26] hover:!bg-[#FDF3F2]',
    step: '3',
    webStep: '!bg-[#8C2F26] !text-white',
    webCount: '!border-[#8C2F26] !bg-[#8C2F26] !text-white'
  }
]

// Tile tone per line kind, for the calculator's per-product requirement grid.
const KIND_TILE: Record<string, { box: string; label: string }> = {
  input: { box: __WEB__ ? 'border-[#C7F03F]/30 bg-[#C7F03F]/10' : 'border-sky-400/30 bg-sky-400/10', label: 'Needs' },
  output: { box: __WEB__ ? 'border-[#7FD3A2]/40 bg-[#7FD3A2]/15' : 'border-emerald-400/30 bg-emerald-400/10', label: 'Yields' },
  loss: { box: __WEB__ ? 'border-[#F8B4AE]/40 bg-[#F8B4AE]/15' : 'border-rose-400/30 bg-rose-400/10', label: 'Loses' }
}

// The editor's step cards on the website: a tinted title strip over a white
// body, one field height throughout.
const FM_CARD = __WEB__ ? '!rounded-[4px] !border-[#D6E2D6] !bg-white !shadow-none' : ''
const FM_CARD_FIELDS = __WEB__
  ? // 13px small caps. They name the fields the whole recipe is typed into,
    // and started at 10px — the least readable text on a page of 13px
    // inputs. Uppercase to match every other field label in the app, with
    // the tracking opened back up: caps need the extra letter-spacing that
    // mixed case does not.
    '[&_label]:!text-[12.5px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.07em] [&_label]:!text-[#5A6B62] [&_input]:!h-10 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!text-[12.5px] [&_input]:!font-semibold [&_[data-slot=select-trigger]]:!h-10 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!text-[12.5px] [&_[data-slot=select-trigger]]:!font-bold'
  : ''

const round2 = (v: number): number => Math.round(v * 100) / 100

// What a recipe's quantities are called on screen.
//
// This form defaulted new recipes to "ton" while every other screen in the app
// — and the backend's own default — says MT. They are the same unit; only the
// label differed. New recipes are MT, and a recipe already stored as "ton" is
// SHOWN as MT without its row being rewritten, so nothing saved has to change
// for the two to agree.
function uomLabel(v: unknown): string {
  const t = String(v || '').trim().toLowerCase()
  return !t || t === 'ton' || t === 'tons' || t === 'tonne' || t === 'tonnes' ? 'MT' : String(v)
}

// FFA% x (1 + loss multiplier%) — e.g. 5% FFA x 1.10 = 5.5%.
// Full precision — feeds the TOR multiplier math below, which the backend
// (src/main/production.ts) also does at full precision. Rounding this to 2dp
// before it's divided into a multiplier and then multiplied by a blend share
// throws off the final TOR by more than a rounding error should (a 65% share
// alone turns a 0.003 rounding slip into +0.2), so it's kept raw here and only
// rounded at the edges: once for the by-product's own displayed/saved % (see
// autoCalcPct), and via formatNum wherever a figure is actually shown.
// The register's chrome on the website. A sticky header composites each of
// its own cells, so the forest is set on every one of them rather than on the
// row alone — a tint on the row shows through as a pale block.
const FM_HEAD = __WEB__
  ? // [&_button] as well as [&>th]: Tailwind's preflight sets
    // text-transform:none on every <button>, so a th's own `uppercase` never
    // reaches a label wrapped in a column-filter trigger — the filtered
    // columns would read "Output product" beside an unfiltered "LINES".
    '!border-b-0 !bg-[#0B3D2E] hover:!bg-[#0B3D2E] [&>th]:!h-auto [&>th]:!bg-[#0B3D2E] [&>th]:!py-2.5 [&>th]:!text-[11px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.1em] [&>th]:!text-white [&_button]:!text-[11px] [&_button]:!font-extrabold [&_button]:!uppercase [&_button]:!tracking-[.1em] [&_button]:!text-white'
  : ''
const FM_ROW = __WEB__
  ? '!border-b-[#EAF0E9] !bg-white hover:!bg-[#F7FAF6] [&>td]:!py-2.5'
  : ''
const FM_CHIP = __WEB__
  ? '!h-9 !rounded-[4px] !px-3.5 !text-[11.5px] !font-extrabold !tracking-[.04em]'
  : ''

function rawFattyAcidPct(it: Row): number {
  const ffa = Number(it.ffa_pct) || 0
  const loss = Number(it.loss_multiplier_pct) || 0
  return ffa * (1 + loss / 100)
}

// The rounded, user-facing version — this is what a by-product line's own
// qty field shows and saves as its % of input, so it deliberately IS rounded
// (a clean percentage, not an internal ratio component).
function autoCalcPct(it: Row): number {
  return round2(rawFattyAcidPct(it))
}

// An input's own TOR multiplier — for a blend of differing-quality raw oils,
// each ingredient needs its own answer rather than one shared across the
// whole blend: 1 / (1 - FFA% x (1 + loss%) - dead loss%). Dead
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

// One sub-category in the manage dialog: rename it, note what it means, retire it, or
// delete it outright when nothing points at it.
//
// Retiring rather than deleting is the default for one in use, because a deleted
// sub-category would leave its recipes classified as nothing — silently, and
// with no way to tell them from recipes never classified at all.
function SubcatRow({ row, onDone }: { row: Row; onDone: () => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(String(row.name ?? ''))
  const [note, setNote] = useState(String(row.note ?? ''))
  const [busy, setBusy] = useState(false)
  const used = Number(row.in_use) || 0
  const active = Number(row.active) === 1
  const dirty = name !== String(row.name ?? '') || note !== String(row.note ?? '')

  async function save(next?: { active?: boolean }): Promise<void> {
    setBusy(true)
    try {
      await window.api.formulationSubcategory.save({
        id: Number(row.id),
        name,
        note,
        active: next?.active ?? active
      })
      await onDone()
    } catch (e) {
      toast.error((e as Error).message)
      setName(String(row.name ?? ''))
      setNote(String(row.note ?? ''))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await window.api.formulationSubcategory.delete(Number(row.id))
      toast.success(`Sub-category "${row.name}" deleted`)
      await onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        // A left stripe carries the state, so in-use and retired read apart at a
        // glance without a badge on every row.
        'group relative overflow-hidden rounded-xl border bg-white pl-3.5 pr-2.5 py-2.5 shadow-sm transition-colors',
        active ? 'border-[#e0d8bd] hover:border-[#c9c0a2]' : 'border-dashed border-[#d9d2b8] bg-[#faf8f1]',
        __WEB__ && '!rounded-[4px] !py-2 !pl-4 !pr-3 !shadow-none',
        __WEB__ && (active ? '!border-[#D6E2D6] hover:!border-[#C3D2C6]' : '!border-[#DCE7DB] !bg-[#F7FAF6]')
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          active ? 'bg-gradient-to-b from-[#1a2c56] to-[#2c4a8c]' : 'bg-[#d9d2b8]',
          __WEB__ && '!w-[3px] !bg-none',
          __WEB__ && (active ? '!bg-[#0B3D2E]' : '!bg-[#C3D2C6]')
        )}
      />
      <div className="flex items-center gap-2">
        <input
          className={cn(
            'min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[14px] font-semibold outline-none transition-colors',
            'hover:border-[#e0d8bd] focus:border-[#1a2c56] focus:bg-white focus:ring-2 focus:ring-[#1a2c56]/15',
            active ? 'text-[#1a2c56]' : 'text-muted-foreground line-through decoration-muted-foreground/40',
            __WEB__ && '!rounded-[4px] !px-2.5 !py-1.5 !text-[13px] !font-bold hover:!border-[#C3D2C6] focus:!border-[#0B3D2E] focus:!ring-[#0B3D2E]/15',
            __WEB__ && (active ? '!text-[#0A1F17]' : '!text-[#5A6B62]')
          )}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => dirty && void save()}
          disabled={busy}
        />

        {/* The count says what it is counting. A bare "0" beside a switch and a
            bin was the one thing on this row nobody could read. */}
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums',
            used > 0 ? 'bg-[#1a2c56]/8 text-[#1a2c56]' : 'bg-muted text-muted-foreground',
            __WEB__ && '!rounded-[2px] !px-2 !py-1 !text-[11px] !font-bold',
            __WEB__ && (used > 0 ? '!bg-[#EAF0E9] !text-[#33473E]' : '!bg-[#F1F5EF] !text-[#8FA79B]')
          )}
          title={
            used === 0
              ? 'No recipe is in this sub-category yet'
              : used === 1
                ? 'One recipe is in this sub-category'
                : `${used} recipes are in this sub-category`
          }
        >
          {used === 0 ? 'unused' : `${used} ${used === 1 ? 'recipe' : 'recipes'}`}
        </span>

        <div className={cn('flex shrink-0 items-center gap-1.5 rounded-full border border-[#e0d8bd] bg-[#fffdf4] pl-2.5 pr-1.5 py-1', __WEB__ && '!rounded-[3px] !border-[#C3D2C6] !bg-white !py-1.5 !pl-2.5 !pr-2')}>
          <span className={cn('text-[10px] font-bold uppercase tracking-wider', active ? 'text-[#1a2c56]' : 'text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.08em]', __WEB__ && (active ? '!text-[#0B6B45]' : '!text-[#8FA79B]'))}>
            {active ? 'In use' : 'Retired'}
          </span>
          <Switch
            checked={active}
            disabled={busy}
            onCheckedChange={(v) => void save({ active: v })}
            title={active ? 'Retire it — hidden from the picker, recipes keep it' : 'Bring it back into the picker'}
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 shrink-0 transition-opacity',
            used > 0 ? 'cursor-not-allowed opacity-25' : 'opacity-40 hover:bg-rose-50 hover:text-rose-700 hover:opacity-100',
            __WEB__ && '!h-9 !w-9 !rounded-[4px]',
            __WEB__ && (used > 0 ? '!opacity-25' : '!text-[#8FA79B] !opacity-100 hover:!bg-[#FDF3F2] hover:!text-[#B3261E]')
          )}
          disabled={busy}
          title={
            used > 0
              ? `${used} ${used === 1 ? 'recipe uses' : 'recipes use'} this — retire it instead`
              : 'Delete this sub-category'
          }
          onClick={remove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* The note only takes space once it has something to say — a permanently
          empty second field doubled the height of every row. */}
      <input
        className={cn(
          'mt-0.5 w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[11.5px] italic text-muted-foreground outline-none transition-colors',
          'placeholder:not-italic hover:border-[#e0d8bd] focus:border-[#1a2c56] focus:bg-white focus:not-italic focus:ring-2 focus:ring-[#1a2c56]/15'
        )}
        placeholder="Add a note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => dirty && void save()}
        disabled={busy}
      />
    </div>
  )
}

export function Formulation(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  // openEdit reads the product list to seed each line's category picker, and
  // it is called from an event handler rather than from a render — a ref is
  // what makes the current list reachable there without adding it to a
  // dependency list that would reload the page.
  const productsRef = useRef<Row[]>([])
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState<Row | null>(null)
  const [building, setBuilding] = useState(false)
  const [form, setForm] = useState<Row>({ product_id: '', name: '', uom: 'MT', subcategory_id: '' })
  // The sub-categories a recipe can belong to. Two recipes can both output DALDA and be
  // entirely different jobs — one on recovered oil, one on RPS — and the output
  // product cannot say which.
  const [subcats, setSubcats] = useState<Row[]>([])
  const [subcatOpen, setSubcatOpen] = useState(false)
  const [newSubcat, setNewSubcat] = useState('')
  const [subcatFilter, setSubcatFilter] = useState('all')
  // Search over the two things a recipe is known by — what it makes, and what
  // it is called. A book of recipes grows past a screen and the sub-category
  // chips only narrow it to a family.
  const [query, setQuery] = useState('')
  // Per-column filters, the same Excel-style funnels every other register in
  // the app carries. Empty = no filter, matching ColumnFilter's convention.
  const [prodCol, setProdCol] = useState<string[]>([])
  const [catCol, setCatCol] = useState<string[]>([])
  const [recipeCol, setRecipeCol] = useState<string[]>([])
  const [subCol, setSubCol] = useState<string[]>([])

  // Recipes the sub-category filter lets through. Unclassified is its own choice
  // rather than being lumped in with "all", because finding the recipes nobody
  // has classified yet is the first thing anyone wants from this.
  const baseRows = (
    subcatFilter === 'all'
      ? rows
      : subcatFilter === 'none'
        ? rows.filter((r) => !r.subcategory_id)
        : rows.filter((r) => String(r.subcategory_id ?? '') === subcatFilter)
  ).filter((r) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return [r.product_name, r.name, r.subcategory_name].some((f) => String(f || '').toLowerCase().includes(q))
  })

  // ------------------------------------------------------------ the funnels
  // What each column filters ON, and what it shows in the tick list. The two
  // differ: sub-category ticks by id, because two sub-categories can be
  // renamed to the same words, and a recipe with no name is still a value
  // worth filtering to.
  type ColKey = 'product' | 'category' | 'recipe' | 'sub'
  const colKeyOf: Record<ColKey, (r: Row) => string> = {
    product: (r) => String(r.product_name ?? ''),
    category: (r) => String(r.product_category ?? ''),
    recipe: (r) => String(r.name ?? ''),
    sub: (r) => String(r.subcategory_id ?? '')
  }
  const colLabelOf: Record<ColKey, (r: Row) => string> = {
    product: (r) => String(r.product_name || '—'),
    category: (r) => String(CAT_LABEL[String(r.product_category)] ?? r.product_category ?? '—'),
    recipe: (r) => String(r.name || 'No recipe name'),
    sub: (r) => String(r.subcategory_name || 'Not classified')
  }
  const colValues: Record<ColKey, string[]> = { product: prodCol, category: catCol, recipe: recipeCol, sub: subCol }

  // A row passes every funnel except the one being opened. Leaving that one
  // out is what stops a column's own options shifting under the cursor while
  // it is being ticked.
  function passesCols(r: Row, except: ColKey | null): boolean {
    return (Object.keys(colValues) as ColKey[]).every(
      (k) => k === except || colValues[k].length === 0 || colValues[k].includes(colKeyOf[k](r))
    )
  }

  function colOptions(k: ColKey): { value: string; label: string; count: number }[] {
    const seen = new Map<string, { value: string; label: string; count: number }>()
    baseRows
      .filter((r) => passesCols(r, k))
      .forEach((r) => {
        const v = colKeyOf[k](r)
        const hit = seen.get(v)
        if (hit) hit.count += 1
        else seen.set(v, { value: v, label: colLabelOf[k](r), count: 1 })
      })
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }

  const shownRows = baseRows.filter((r) => passesCols(r, null))

  // A sub-category change moves the chips, the counts and the badges on the recipes,
  // so both lists are re-read rather than only the one that was edited.
  async function reloadAfterSubcats(): Promise<void> {
    await loadSubcats()
    await load()
  }

  async function addSubcat(): Promise<void> {
    const name = newSubcat.trim()
    if (!name) return
    try {
      await window.api.formulationSubcategory.save({ name })
      setNewSubcat('')
      toast.success(`Sub-category "${name}" added`)
      await reloadAfterSubcats()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const loadSubcats = useCallback(async (): Promise<void> => {
    try {
      setSubcats(await window.api.formulationSubcategory.list())
    } catch {
      // A missing sub-category list must never stop the recipes themselves loading.
      setSubcats([])
    }
  }, [])
  useEffect(() => {
    void loadSubcats()
  }, [loadSubcats])
  const [items, setItems] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [f, p] = await Promise.all([
      window.api.formulations.list(),
      window.api.data.list('products')
    ])
    setRows(f)
    const live = p.filter((x) => x.active)
    setProducts(live)
    productsRef.current = live
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const outputs = products.filter((p) => p.category === 'finished' || p.category === 'intermediate')

  function openAdd(): void {
    setEditing(null)
    setForm({ product_id: '', name: '', uom: 'MT', subcategory_id: '' })
    // A new recipe starts with a 1% dead loss line already on it.
    //
    // Every recipe in this book carries one, an auto-calculated input cannot
    // be saved without one (see save()), and 1% is what they are all set to
    // — so starting at zero meant every new recipe was refused on its first
    // save until the line was added by hand. The product is left for the
    // user unless the book has an obvious loss product to name.
    const lossProduct = productsRef.current.find((pr) => {
      const nm = String(pr.name || '').trim().toLowerCase()
      return nm === 'loss' || nm === 'dead loss' || nm.startsWith('dead loss')
    })
    const startItems = [
      { product_id: '', qty: '', kind: 'input' },
      {
        product_id: lossProduct ? String(lossProduct.id) : '',
        _cat: String(lossProduct?.category || ''),
        _mat: String(lossProduct?.material_type || ''),
        qty: '1',
        kind: 'loss'
      }
    ]
    setItems(startItems)
    // The pre-filled dead-loss line is what the editor STARTS as, not
    // something the user typed — so it must not count as a change.
    markRecipeClean({ product_id: '', name: '', uom: 'MT', subcategory_id: '' }, startItems)
    setBuilding(true)
  }

  async function openEdit(row: Row): Promise<void> {
    setEditing(row)
    const openForm = {
      product_id: String(row.product_id ?? ''),
      name: row.name ?? '',
      uom: row.uom ?? 'MT',
      subcategory_id: row.subcategory_id ? String(row.subcategory_id) : ''
    }
    setForm(openForm)
    const its = await window.api.formulations.items(row.id as number)
    const openItems =
      its.length
        ? its.map((i) => ({
            product_id: String(i.product_id),
            // UI only, and never saved: save() builds its payload from an
            // explicit whitelist, so this rides along on the row without
            // reaching the API. Seeded from the product already picked, so
            // reopening a recipe shows the category it was chosen from
            // rather than resetting every line to "All".
            _cat: String(productsRef.current.find((pr) => String(pr.id) === String(i.product_id))?.category || ''),
            _mat: String(productsRef.current.find((pr) => String(pr.id) === String(i.product_id))?.material_type || ''),
            qty: i.qty,
            kind: String(i.kind || 'input'),
            auto_calc: !!i.auto_calc,
            ffa_pct: i.ffa_pct ?? '',
            loss_multiplier_pct: i.loss_multiplier_pct ?? '',
            byproduct_product_id: i.byproduct_product_id ? String(i.byproduct_product_id) : ''
          }))
        : [{ product_id: '', qty: '', kind: 'input' }]
    setItems(openItems)
    markRecipeClean(openForm, openItems)
    setBuilding(true)
  }

  // ------------------------------------------------------- unsaved changes
  //
  // What the editor looked like when it opened. A snapshot rather than "has
  // anything been typed", because an EDIT opens already filled in — that is
  // not a change yet.
  //
  // `_cat` and `_mat` are left out on purpose: they are the two picker
  // filters, they are never saved, and narrowing a dropdown to find a product
  // is not an edit to the recipe.
  const baselineRef = useRef('')
  function recipeShape(f: Row, list: Row[]): string {
    return JSON.stringify({
      p: String(f.product_id ?? ''),
      n: String(f.name ?? ''),
      u: String(f.uom ?? ''),
      s: String(f.subcategory_id ?? ''),
      i: list.map((it) => [
        String(it.product_id ?? ''),
        String(it.qty ?? ''),
        String(it.kind ?? 'input'),
        it.auto_calc ? 1 : 0,
        String(it.ffa_pct ?? ''),
        String(it.loss_multiplier_pct ?? ''),
        String(it.byproduct_product_id ?? '')
      ])
    })
  }
  function markRecipeClean(f: Row, list: Row[]): void {
    baselineRef.current = recipeShape(f, list)
  }
  const dirty = building && !saving && recipeShape(form, items) !== baselineRef.current

  // A refresh or a closed tab can only be caught here, and the dialog raised
  // is the BROWSER's own — no page may replace it with its own. Leaving by the
  // editor's Back or Cancel is ours, and asks properly.
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
  // Every way out of the editor goes through here, so none of them can
  // quietly drop a half-built recipe.
  function leaveEditor(): void {
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

  // ---------------------------------------------------------------- the URL
  //
  // The recipe editor is a page in its own right — several screens long, and
  // the one people sit in — but it lived only in component state, so a
  // refresh dropped them back to the register having lost their place. On the
  // website it now writes itself into the address bar and reads itself back.
  //
  // The parameter is read during the FIRST RENDER, not in an effect. Effects
  // run after mount, and `building` is false then — so the effect that keeps
  // the URL in step would delete ?edit before the effect that restores it
  // ever saw it. Reading it here, once, takes it out of that race.
  const [pendingEdit, setPendingEdit] = useState<string | null>(() =>
    __WEB__ ? new URLSearchParams(window.location.search).get('edit') : null
  )

  // replaceState, not pushState: this is the same page with something open on
  // it, not a new entry in the history. Browser Back still leaves Formulation
  // rather than toggling the editor shut, which is what the Back button in the
  // bar above is for.
  useEffect(() => {
    if (!__WEB__) return
    // Hold off while a restore is still owed — the URL is the instruction at
    // that point, not something to be overwritten from state that has not
    // caught up with it yet.
    if (pendingEdit) return
    const url = new URL(window.location.href)
    if (building) url.searchParams.set('edit', editing?.id ? String(editing.id) : 'new')
    else url.searchParams.delete('edit')
    const next = url.pathname + url.search
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(window.history.state, '', next)
    }
  }, [building, editing, pendingEdit])

  // Reopen whatever the URL named, once the register and the product list it
  // needs have arrived. Clearing pendingEdit hands the URL back to the effect
  // above, which keeps it in step from then on.
  useEffect(() => {
    if (!__WEB__ || !pendingEdit || loading || !products.length) return
    if (pendingEdit === 'new') {
      if (outputs.length) openAdd()
      setPendingEdit(null)
      return
    }
    const row = rows.find((r) => String(r.id) === pendingEdit)
    // A recipe that is gone — deleted, or on another company's books — just
    // drops the parameter rather than leaving a dead link in the address bar.
    if (row) void openEdit(row)
    setPendingEdit(null)
  }, [pendingEdit, loading, rows, products, outputs])

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
  // its own FFA/loss inputs (Fatty Acid being the standing example).
  // Turning auto-calc on immediately writes the computed % into qty; turning
  // it off just freezes qty at whatever it last was, editable again by hand.
  //
  // An INPUT line's auto-calc is different: its qty is the blend SHARE (e.g.
  // 65%), typed by hand either way — auto-calc instead gives that one
  // ingredient its own TOR multiplier (see inputTorMultiplier above), for a
  // blend of raw oils where each is its own quality rather than one shared
  // loss across the whole blend.
  function toggleItemAutoCalc(idx: number): void {
    // Switching the calculator on for an INPUT makes "By-product goes to"
    // required — save() refuses without it. The answer is Fatty Acid on every
    // recipe in this book, so it is filled in rather than left as a blank the
    // save will bounce on. Only when it is still empty: a line that already
    // names something else keeps it.
    const fatty = productsRef.current.find((pr) => {
      const nm = String(pr.name || '').trim().toLowerCase()
      return nm === 'fatty acid' || nm === 'fatty oil' || nm.startsWith('fatty acid')
    })
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it
        if (it.auto_calc) return { ...it, auto_calc: false }
        if (String(it.kind || 'input') === 'input') {
          return {
            ...it,
            auto_calc: true,
            byproduct_product_id: it.byproduct_product_id || (fatty ? String(fatty.id) : '')
          }
        }
        return { ...it, auto_calc: true, qty: String(autoCalcPct(it)) }
      })
    )
  }
  function setItemFormula(idx: number, key: 'ffa_pct' | 'loss_multiplier_pct', value: string): void {
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


  // The per-product requirement behind the TOR calculator: how much of
  // each input this batch size draws, what each throws off as fatty acid,
  // and what is lost. Lifted out of the table it used to be computed
  // inside, so the app's table and the website's grouped panel render the
  // same figures instead of each doing the arithmetic itself.
  type TorRow = {
    key: string
    kind: string
    name: string
    share: number | null
    q: number
    fattyYield: number | null
    multiplier: number | null
    auto?: boolean
    // Set only on the synthetic row for the batch itself, which the
    // calculator adds to "Is yielded" — it is not a formulation line.
    isBatch?: boolean
  }

  function torRequirement(): {
    rows: { key: string; kind: string; name: string; share: number | null; q: number; fattyYield: number | null; multiplier: number | null; auto?: boolean }[]
    fattyYieldTotal: number
    inputTotal: number
    deadLossTotal: number
    net: number
  } {
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
    const inputTotal = rows.filter((r) => r.kind === 'input').reduce((s, r) => s + r.q, 0)
    const deadLossTotal = rows.filter((r) => r.kind === 'loss').reduce((s, r) => s + r.q, 0)
    return {
      rows,
      fattyYieldTotal,
      inputTotal,
      deadLossTotal,
      net: inputTotal - fattyYieldTotal - deadLossTotal
    }
  }

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
        // Dropped from the formula, so nothing new carries one.
        moisture_pct: null,
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
        subcategory_id: form.subcategory_id ? Number(form.subcategory_id) : null,
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
  // Rendered by BOTH returns below.
  //
  // The recipe form returns early, so a dialog declared only in the list return
  // does not exist while the form is open — and the form carries its own
  // "Manage sub-categories" link, which therefore did nothing at all. Held in a
  // variable rather than written twice, so the two can never drift apart.
  // Kept deliberately plain: a name, a note, and whether it is still in use. The
  // count is the important column — nobody should rename or retire one without
  // seeing what it carries.
  const manageSubcats = (
    <Dialog open={subcatOpen} onOpenChange={setSubcatOpen}>
      <DialogContent
        // Capped to the window and scrolled inside, so a long list never pushes
        // the panel — or its close button — off the screen.
        //
        // [&>button] reaches the built-in corner ✕, which is a plain child of
        // DialogContent and would otherwise be near-invisible on the navy header.
        className={cn(
          'flex max-h-[88dvh] w-[min(94vw,37rem)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 [&>button]:top-5 [&>button]:text-white [&>button]:opacity-70 [&>button]:hover:opacity-100',
          __WEB__ && '!w-[min(94vw,40rem)] !rounded-[4px] !border-0'
        )}
        onEscapeKeyDown={() => {}}
        onInteractOutside={() => {}}
      >
        <DialogHeader className={cn('shrink-0 space-y-0 bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-5 py-4 pr-14 text-left', __WEB__ && '!bg-[#0B3D2E] !bg-none')}>
          <div className="flex items-start gap-3">
            <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/15', __WEB__ && '!mt-0 !h-9 !w-9 !rounded-[4px]')}>
              <Layers className={cn('h-4 w-4 text-white', __WEB__ && '!h-4 !w-4')} />
            </span>
            <div className="min-w-0">
              {__WEB__ && (
                <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Formulation</div>
              )}
              <DialogTitle className={cn('text-white', __WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em]')}>Recipe sub-categories</DialogTitle>
              <p className={cn('mt-1 text-[11.5px] leading-snug text-white/70', __WEB__ && '!mt-1.5 !text-[11.5px] !font-semibold !leading-relaxed !text-[#8FBFA8]')}>
                What a recipe is built on, as against what it makes. One name each, so
                &ldquo;recovered-oil&rdquo; stays one thing instead of three spellings of itself.
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className={cn('min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-[#fffdf4] px-4 py-4', __WEB__ && '!space-y-2.5 !bg-[#F1F5EF] !p-3')}>
          {subcats.map((sc) => (
            <SubcatRow key={String(sc.id)} row={sc} onDone={reloadAfterSubcats} />
          ))}
          {!subcats.length && (
            <div className={cn('rounded-xl border border-dashed border-[#d9d2b8] bg-white/60 px-4 py-10 text-center', __WEB__ && '!rounded-[4px] !border-[#C3D2C6] !bg-white')}>
              <Layers className={cn('mx-auto h-5 w-5 text-muted-foreground/50', __WEB__ && '!h-6 !w-6 !text-[#C3D2C6]')} />
              <p className={cn('mt-2 text-[13px] font-medium text-[#1a2c56]', __WEB__ && '!mt-2.5 !text-[12.5px] !font-bold !text-[#0A1F17]')}>No sub-categories yet</p>
              <p className={cn('mt-0.5 text-[11.5px] text-muted-foreground', __WEB__ && '!mt-1 !text-[11.5px] !font-semibold !text-[#5A6B62]')}>Add the first one below.</p>
            </div>
          )}
        </div>

        {/* Add and Close share the footer, so the scrolling list gets the height
            instead of an entry field that is only used now and then. */}
        <DialogFooter className={cn('shrink-0 gap-2 border-t border-[#e0d8bd] bg-[#f1ecd9] px-4 py-3 sm:justify-between', __WEB__ && '!gap-2 !border-t-[#D6E2D6] !bg-white !px-3 !py-2.5')}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              className={cn(
                'h-9 min-w-0 flex-1 rounded-md border border-[#d9d2b8] bg-white px-2.5 text-[13px] outline-none focus:border-[#1a2c56] focus:ring-2 focus:ring-[#1a2c56]/15',
                __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12.5px] !font-semibold focus:!border-[#0B3D2E] focus:!ring-[#0B3D2E]/15'
              )}
              placeholder="Add a sub-category…"
              value={newSubcat}
              onChange={(e) => setNewSubcat(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addSubcat()
              }}
            />
            <Button
              className={cn('h-9 shrink-0 bg-[#1a2c56] hover:bg-[#24407e]', __WEB__ && '!h-10 !gap-1.5 !rounded-[4px] !bg-[#0B3D2E] !px-3 !text-[12px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] hover:!bg-[#0F4A38]')}
              onClick={addSubcat}
              disabled={!newSubcat.trim()}
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          <Button
            variant="outline"
            className={cn('h-9 shrink-0 bg-white', __WEB__ && '!h-10 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-4 !text-[12px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
            onClick={() => setSubcatOpen(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (building) {
    return (
      <>
        {/* The app keeps its page header. The website gets a bar of its
            own, pinned to the top: this form is several screens long, Back is
            the only way out of it, and the blend verdict — the one thing that
            decides whether it can be saved at all — belongs where it stays in
            view while the lines below it are edited. */}
        {!__WEB__ && (
          <PageHeader
            title={editing ? 'Edit formulation' : 'New formulation'}
            subtitle="Compose a finished good or intermediate from other products"
            actions={
              <Button variant="ghost" size="sm" onClick={leaveEditor}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            }
          />
        )}
        {__WEB__ && (
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3.5 gap-y-2 bg-[#0B3D2E] px-5 py-3 text-white shadow-[0_8px_20px_-12px_rgba(10,31,23,0.55)]">
            <button
              type="button"
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[4px] border-[1.5px] border-[#C7F03F]/70 px-3.5 text-[13px] font-extrabold uppercase tracking-[.04em] text-[#C7F03F] transition-colors hover:bg-[#C7F03F] hover:text-[#12280B]"
              onClick={leaveEditor}
            >
              <ArrowLeft className="h-[19px] w-[19px]" /> Back
            </button>
            <div className="h-6 w-px bg-white/20" />
            <div className="min-w-0">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                {editing ? 'Edit formulation' : 'New formulation'}
              </div>
              <div className="mt-1 truncate text-[15px] font-bold tracking-[-0.02em]">
                {products.find((pr) => String(pr.id) === String(form.product_id))?.name || 'Pick an output product'}
                {form.name ? <span className="ml-2 text-[13px] font-semibold text-[#8FBFA8]">{String(form.name)}</span> : null}
              </div>
            </div>
            <span
              className={cn(
                'ml-auto flex shrink-0 items-center gap-2 rounded-[3px] border px-3 py-2 text-[12px] font-bold tabular-nums',
                balanced ? 'border-[#C7F03F]/40 bg-[#C7F03F]/15 text-[#C7F03F]' : 'border-[#F8B4AE]/40 bg-[#B3261E]/30 text-[#FFC4BE]'
              )}
            >
              {balanced ? <Beaker className="h-4 w-4" /> : <Flame className="h-4 w-4" />}
              Input blend {formatNum(blendPct)}%{balanced ? '' : ' · must be 100%'}
            </span>
          </div>
        )}
        <div className={cn('px-4 py-6', __WEB__ && '!px-3 !py-4')}>
          <div className={cn('mx-auto max-w-6xl space-y-5', __WEB__ && '!max-w-none !space-y-3.5')}>
            {/* Output product header — no overflow-hidden here: the Output
                product dropdown opens INSIDE this card, and clipping the
                card would clip its panel along with it. */}
            <div className={cn('rounded-2xl border shadow-sm', FM_CARD, FM_CARD_FIELDS)}>
              <div
                className={cn(
                  'flex items-center gap-3 rounded-t-2xl bg-gradient-to-r from-[#1a2c56] to-[#2c4a8c] px-5 py-4 text-white',
                  __WEB__ && '!gap-2 !rounded-none !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !bg-none !px-3 !py-2 !text-[#0A1F17]'
                )}
              >
                {/* Numbered, because this card decides what everything below
                    it is a recipe FOR — pick the output last and the
                    percentages underneath have nothing to be percentages of. */}
                {__WEB__ && (
                  <span className="rounded-[2px] bg-[#0B3D2E] px-2 py-1 text-[10.5px] font-extrabold text-[#C7F03F]">1</span>
                )}
                <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15', __WEB__ && '!h-7 !w-7 !rounded-[3px] !bg-[#EAF0E9]')}>
                  <Beaker className={cn('h-5 w-5', __WEB__ && '!h-4 !w-4 !text-[#0B3D2E]')} />
                </span>
                <div className="min-w-0">
                  <div className={cn('text-[15px] font-bold', __WEB__ && '!text-[12.5px] !font-extrabold !uppercase !tracking-[.11em]')}>
                    {__WEB__ ? 'What it makes' : editing ? 'Edit formulation' : 'New formulation'}
                  </div>
                  {!__WEB__ && <div className="text-[11px] text-white/70">Compose a finished good or intermediate from other products</div>}
                </div>
              </div>
              <div className={cn('grid gap-3 rounded-b-2xl bg-card p-5 sm:grid-cols-2', __WEB__ && '!gap-3.5 !rounded-none !p-3')}>
                <div className="flex flex-col gap-1.5">
                  <Label>Output product *</Label>
                  <Select
                    value={String(form.product_id)}
                    onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}
                  >
                    <SelectTrigger className={cn('h-10', __WEB__ && '!h-11 !text-[15px] !font-bold')}>
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
                    className={cn('h-10', __WEB__ && '!h-11 !text-[15px] !font-bold')}
                    value={form.name ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. standard recipe"
                  />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <Label>Sub-category</Label>
                    <button
                      type="button"
                      className={cn(
                        'text-[11px] font-medium text-sky-700 hover:underline',
                        // Sky blue is not a colour this page uses. Green, and
                        // sized to sit level with the label beside it.
                        __WEB__ && '!text-[12.5px] !font-extrabold !text-[#0B6B45] hover:!underline'
                      )}
                      onClick={() => setSubcatOpen(true)}
                    >
                      Manage sub-categories
                    </button>
                  </div>
                  <Select
                    value={form.subcategory_id ? String(form.subcategory_id) : 'none'}
                    onValueChange={(v) => setForm((p) => ({ ...p, subcategory_id: v === 'none' ? '' : v }))}
                  >
                    <SelectTrigger className={cn('h-10', __WEB__ && '!h-11 !text-[15px] !font-bold')}>
                      <SelectValue placeholder="Not classified" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not classified</SelectItem>
                      {subcats
                        .filter((sc) => Number(sc.active) === 1 || String(sc.id) === String(form.subcategory_id))
                        .map((sc) => (
                          <SelectItem key={String(sc.id)} value={String(sc.id)}>
                            {String(sc.name)}
                            {Number(sc.active) === 1 ? '' : ' (retired)'}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <span className={cn('text-[11px] leading-snug text-muted-foreground', __WEB__ && '!text-[12px] !font-semibold !leading-relaxed !text-[#5A6B62]')}>
                    What this recipe is built on, as against what it produces &mdash; so a recipe fed
                    by SHEA can still be tracked as recovered-oil. Production and stock can then be
                    read by sub-category.
                  </span>
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
                <div
                  key={sec.kind}
                  className={cn(
                    'rounded-2xl border shadow-sm',
                    FM_CARD,
                    FM_CARD_FIELDS,
                    __WEB__ && sec.kind === 'output' && '!border-[#C6DAF0]'
                  )}
                >
                  <div
                    className={cn(
                      'flex items-center gap-2.5 rounded-t-2xl bg-gradient-to-r px-4 py-3 text-white',
                      sec.grad,
                      __WEB__ && '!rounded-none !border-b !bg-none !px-3 !py-2',
                      __WEB__ && sec.webHead
                    )}
                  >
                    {/* Numbered like the card above it, so the three cards
                        read as steps 1–2–3 rather than as three lists that
                        happen to sit under each other. By-products has no
                        number: it is optional, and only appears at all once a
                        manual one has been added. */}
                    {/* Loss is the last step, so its number moves when the
                        optional by-products card appears above it. */}
                    {__WEB__ && !!sec.step && (
                      <span className={cn('rounded-[2px] px-2 py-1 text-[10.5px] font-extrabold leading-none', sec.webStep)}>
                        {sec.kind === 'loss' ? (hasManualByproduct ? '4' : '3') : sec.step}
                      </span>
                    )}
                    <sec.icon className={cn('h-4 w-4 shrink-0', __WEB__ && cn('!h-4 !w-4', sec.webIcon))} />
                    <div className="flex-1 min-w-0">
                      <div className={cn('text-[13px] font-bold uppercase tracking-wide', __WEB__ && '!text-[12.5px] !font-extrabold !tracking-[.11em]')}>{sec.title}</div>
                      <div className={cn('text-[10px] text-white/75', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !normal-case !text-[#5A6B62]')}>{sec.subtitle}</div>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'border-transparent bg-white/20 text-white',
                        __WEB__ && cn('!rounded-[2px] !border !px-2 !py-1 !text-[11px] !font-extrabold !tabular-nums', sec.webCount)
                      )}
                    >
                      {secItems.length}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      className={cn(
                        'h-7 bg-white/90 text-[#1a2c56] hover:bg-white',
                        __WEB__ && cn('!h-9 !gap-1.5 !rounded-[4px] !border !px-3 !text-[11.5px] !font-extrabold !uppercase !tracking-[.04em]', sec.webAdd)
                      )}
                      onClick={() => addItem(sec.kind)}
                    >
                      <Plus className="h-3.5 w-3.5" /> {sec.add}
                    </Button>
                  </div>
                  <div className={cn('space-y-2 rounded-b-2xl bg-muted/20 p-3', __WEB__ && '!space-y-2.5 !rounded-none !bg-white !p-3')}>
                    {secItems.length === 0 ? (
                      <p className={cn('px-2 py-4 text-center text-xs text-muted-foreground', __WEB__ && '!rounded-[4px] !border !border-dashed !border-[#C3D2C6] !py-6 !text-[12px] !font-semibold !text-[#5A6B62]')}>None yet.</p>
                    ) : (
                      secItems.map(({ it, idx }) => (
                        <div
                          key={idx}
                          className={cn(
                            'rounded-xl border-l-4 bg-card p-3 shadow-sm transition-shadow hover:shadow-md',
                            sec.accent,
                            __WEB__ && cn('!rounded-[4px] !border !border-[#D6E2D6] !border-l-[4px] !bg-[#F7FAF6] !p-3.5 !shadow-none hover:!shadow-none', sec.webAccent)
                          )}
                        >
                          <div className={cn('flex items-center gap-2', __WEB__ && '!flex-wrap !gap-2')}>
                            {/* Category first, then the product it narrows to.
                                One list of every product in the book made
                                picking a raw oil a scroll past every finished
                                good; choosing the category first cuts it to
                                the handful that could belong on this line.
                                It is a filter, not a field — nothing about it
                                is saved, and clearing it puts the whole list
                                back. */}
                            {/* Two steps, in the Products page's own words.
                                SUB-CATEGORY is raw / intermediate / finished
                                — what stage the goods are at. CATEGORY is OIL,
                                PACKAGING, FATTY and the rest, off the
                                Categories master. Products calls them that way
                                round, and this picker used to call the first
                                one "Category", which is the other page's name
                                for the second.
                                The category step appears only once a
                                sub-category is chosen: on its own it would
                                offer OIL against every stage at once, which is
                                the list this was meant to cut down. Both are
                                built from the products actually present, so a
                                stage nothing lives at is never offered and no
                                product can be filtered out of reach. */}
                            {__WEB__ && (
                              <div className="w-[165px] shrink-0">
                                <Select
                                  value={String(it._cat || 'all')}
                                  onValueChange={(v) => {
                                    const next = v === 'all' ? '' : v
                                    setItems((prev) =>
                                      prev.map((row, i2) => {
                                        if (i2 !== idx) return row
                                        // The old category may not exist at the
                                        // new stage, and the picked product may
                                        // not either — a product left set but
                                        // invisible reads as an empty line that
                                        // saves the old value anyway.
                                        const keep = products.some(
                                          (pr) => String(pr.id) === String(row.product_id) && (!next || String(pr.category) === next)
                                        )
                                        return { ...row, _cat: next, _mat: '', product_id: keep ? row.product_id : '' }
                                      })
                                    )
                                  }}
                                >
                                  <SelectTrigger className="!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12.5px] !font-bold">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="all">All sub-categories</SelectItem>
                                    {[...new Set(products.map((pr) => String(pr.category || '')).filter(Boolean))]
                                      .sort()
                                      .map((c) => (
                                        <SelectItem key={c} value={c}>
                                          {CAT_LABEL[c] ?? c}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            {__WEB__ && !!it._cat && (
                              <div className="w-[165px] shrink-0">
                                <Select
                                  value={String(it._mat || 'all')}
                                  onValueChange={(v) => {
                                    const next = v === 'all' ? '' : v
                                    setItems((prev) =>
                                      prev.map((row, i2) => {
                                        if (i2 !== idx) return row
                                        const keep = products.some(
                                          (pr) => String(pr.id) === String(row.product_id) && (!next || String(pr.material_type) === next)
                                        )
                                        return { ...row, _mat: next, product_id: keep ? row.product_id : '' }
                                      })
                                    )
                                  }}
                                >
                                  <SelectTrigger className="!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12.5px] !font-bold">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="all">All categories</SelectItem>
                                    {[
                                      ...new Set(
                                        products
                                          .filter((pr) => String(pr.category || '') === String(it._cat))
                                          .map((pr) => String(pr.material_type || ''))
                                          .filter(Boolean)
                                      )
                                    ]
                                      .sort()
                                      .map((m) => (
                                        <SelectItem key={m} value={m}>
                                          {m}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            <div className={cn('flex-1', __WEB__ && '!min-w-[220px]')}>
                              <Select
                                value={String(it.product_id)}
                                onValueChange={(v) => setItem(idx, 'product_id', v)}
                              >
                                <SelectTrigger className={cn('h-9', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12.5px] !font-bold')}>
                                  <SelectValue placeholder="Select product" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(() => {
                                    const cat = String(it._cat || '')
                                    const mat = String(it._mat || '')
                                    const shown = products.filter(
                                      (pr) => (!cat || String(pr.category) === cat) && (!mat || String(pr.material_type) === mat)
                                    )
                                    if (__WEB__ && shown.length === 0) {
                                      return (
                                        <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                                          No products here.
                                        </div>
                                      )
                                    }
                                    // The name alone. It used to append the
                                    // category and sub-category, which on a
                                    // product called DEAD LOSS in the DEAD LOSS
                                    // category read "DEAD LOSS · DEAD LOSS · RAW"
                                    // — and the two pickers to the left of this
                                    // one already say which category is in view.
                                    return shown.map((pr) => (
                                      <SelectItem key={pr.id} value={String(pr.id)}>
                                        {pr.name}
                                      </SelectItem>
                                    ))
                                  })()}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="relative w-32 shrink-0">
                              <Input
                                type="number"
                                className={cn(
                                  'h-9 pr-6 text-right font-semibold tabular-nums',
                                  sec.kind === 'output' && it.auto_calc && 'bg-muted/60 text-muted-foreground',
                                  __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !pr-7 !text-[13px] !font-bold',
                                  __WEB__ && sec.kind === 'output' && !!it.auto_calc && '!bg-[#F1F5EF] !text-[#5A6B62]'
                                )}
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
                                className={cn(
                                  'h-9 w-9 shrink-0',
                                  // On the website it carries a switch beside
                                  // the icon: a lone icon button that fills in
                                  // when active reads as "pressed", not as
                                  // "on", and this one decides whether three
                                  // more fields exist.
                                  __WEB__ && '!h-10 !w-auto !shrink-0 !gap-2 !rounded-[4px] !border !px-2.5',
                                  __WEB__ &&
                                    (it.auto_calc
                                      ? '!border-[#0B3D2E] !bg-[#F7FAF6] !text-[#0B3D2E] hover:!bg-[#EAF0E9]'
                                      : '!border-[#C3D2C6] !bg-white !text-[#5A6B62] hover:!bg-[#F7FAF6]')
                                )}
                                title={
                                  it.auto_calc
                                    ? sec.kind === 'input'
                                      ? 'Auto-calculated TOR multiplier — click to turn off'
                                      : 'Auto-calculated — click to enter the % by hand instead'
                                    : sec.kind === 'input'
                                      ? "Give this ingredient its own TOR multiplier from FFA % and its loss multiplier — dead loss always comes from the recipe's own Loss line below"
                                      : 'Auto-calculate from FFA % and its loss multiplier'
                                }
                                onClick={() => toggleItemAutoCalc(idx)}
                              >
                                <Calculator className={cn('h-4 w-4', __WEB__ && '!h-4 !w-4')} />
                                {__WEB__ && (
                                  <span
                                    className={cn(
                                      'flex h-5 w-[34px] items-center rounded-[2px] p-0.5 transition-colors',
                                      it.auto_calc ? 'justify-end bg-[#0B3D2E]' : 'justify-start bg-[#C3D2C6]'
                                    )}
                                  >
                                    <span className="h-4 w-4 rounded-[2px] bg-white" />
                                  </span>
                                )}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn('h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10', __WEB__ && '!h-10 !w-11 !rounded-[4px] !text-[#8FA79B] hover:!bg-[#FDF3F2] hover:!text-[#B3261E]')}
                              onClick={() => removeItem(idx)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {/* Four fields that were each a different colour — amber,
                              rose, cyan, emerald — with a coloured dot beside every
                              label. Four hues on four inputs of one formula says
                              they are four different KINDS of thing, which they are
                              not: they are all percentages feeding one multiplier.
                              One ground, one label style, and the answer at the end
                              in the section's own colour. */}
                          {(sec.kind === 'output' || sec.kind === 'input') && it.auto_calc && (
                            <div
                              className={cn(
                                'mt-2.5 grid gap-2.5 rounded-lg border p-2.5',
                                sec.kind === 'input' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2',
                                sec.calcBox,
                                __WEB__ && cn('!mt-3 !gap-3 !overflow-hidden !rounded-[4px] !bg-white !p-3', sec.webCalcBox)
                              )}
                            >
                              <div className="flex flex-col gap-0.5">
                                <Label className={cn('flex items-center gap-1 text-[10px] font-semibold text-amber-800', __WEB__ && '!text-[11.5px] !font-extrabold !uppercase !tracking-[.07em] !text-[#5A6B62]')}>
                                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500', __WEB__ && '!hidden')} /> Oil FFA %
                                </Label>
                                <Input
                                  type="number"
                                  className={cn('h-8 border-amber-200 bg-amber-50/60 text-right focus-visible:ring-amber-400', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12.5px] !font-semibold !tabular-nums')}
                                  value={it.ffa_pct ?? ''}
                                  onChange={(e) => setItemFormula(idx, 'ffa_pct', e.target.value)}
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <Label className={cn('flex items-center gap-1 text-[10px] font-semibold text-rose-800', __WEB__ && '!text-[11.5px] !font-extrabold !uppercase !tracking-[.07em] !text-[#5A6B62]')}>
                                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500', __WEB__ && '!hidden')} /> Loss multiplier % (the "1 +")
                                </Label>
                                <Input
                                  type="number"
                                  className={cn('h-8 border-rose-200 bg-rose-50/60 text-right focus-visible:ring-rose-400', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12.5px] !font-semibold !tabular-nums')}
                                  value={it.loss_multiplier_pct ?? ''}
                                  onChange={(e) => setItemFormula(idx, 'loss_multiplier_pct', e.target.value)}
                                />
                              </div>
                              {sec.kind === 'input' && (
                                <div className="flex flex-col gap-0.5">
                                  <Label className={cn('flex items-center gap-1 text-[10px] font-semibold text-emerald-800', __WEB__ && '!text-[11.5px] !font-extrabold !uppercase !tracking-[.07em] !text-[#5A6B62]')}>
                                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500', __WEB__ && '!hidden')} /> By-product goes to *
                                  </Label>
                                  <Select
                                    value={it.byproduct_product_id ? String(it.byproduct_product_id) : ''}
                                    onValueChange={(v) => setItem(idx, 'byproduct_product_id', v)}
                                  >
                                    <SelectTrigger className={cn('h-8 border-emerald-200 bg-emerald-50/60 text-xs', __WEB__ && '!h-10 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[12px] !font-semibold')}><SelectValue placeholder="e.g. Fatty Acid" /></SelectTrigger>
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
                              {/* The website substitutes THIS line's own numbers
                                  into the formula rather than printing it in the
                                  abstract — a reader checking a 1.3569 multiplier
                                  wants to see the 23 and the 1.10 that made it,
                                  not a rule they then have to apply themselves.
                                  Full bleed and dark, so it reads as the line's
                                  answer rather than as a caption. */}
                              {sec.kind === 'input' ? (
                                <div
                                  className={cn(
                                    'col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2.5 py-1.5 sm:col-span-3',
                                    __WEB__ && '!-mx-3 !-mb-3 !mt-0.5 !gap-3 !rounded-none !bg-[#0B3D2E] !px-3 !py-2.5'
                                  )}
                                >
                                  <span className={cn('text-[11px]', sec.formulaText, __WEB__ && '!min-w-0 !text-[12px] !font-bold !tabular-nums !text-white')}>
                                    {__WEB__
                                      ? `1 ÷ (1 − ${formatNum(it.ffa_pct ?? 0)}% × ${(1 + (Number(it.loss_multiplier_pct) || 0) / 100).toFixed(2)} − ${formatNum(lossPct)}%)`
                                      : "1 ÷ (1 − FFA % × (1 + loss %) − recipe's dead loss %) = this ingredient's own TOR multiplier"}
                                  </span>
                                  <span className={cn('rounded-full bg-sky-600 px-2.5 py-0.5 text-[12px] font-bold tabular-nums text-white', __WEB__ && '!ml-auto !shrink-0 !rounded-[2px] !bg-[#12855A] !px-2.5 !py-1.5 !text-[13px] !text-white')}>
                                    ×{inputTorMultiplier(it, lossPct).toFixed(4)}
                                  </span>
                                </div>
                              ) : (
                                <div
                                  className={cn(
                                    'col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white/70 px-2.5 py-1.5',
                                    __WEB__ && '!-mx-3 !-mb-3 !mt-0.5 !gap-3 !rounded-none !bg-[#1B4E82] !px-3 !py-2.5'
                                  )}
                                >
                                  <span className={cn('text-[11px] text-emerald-800', __WEB__ && '!text-[12px] !font-bold !tabular-nums !text-white')}>
                                    {__WEB__
                                      ? `${formatNum(it.ffa_pct ?? 0)}% × ${(1 + (Number(it.loss_multiplier_pct) || 0) / 100).toFixed(2)} = % of input`
                                      : 'FFA % × (1 + loss %) = % of input'}
                                  </span>
                                  <span className={cn('rounded-full bg-emerald-600 px-2.5 py-0.5 text-[12px] font-bold tabular-nums text-white', __WEB__ && '!ml-auto !shrink-0 !rounded-[2px] !bg-[#0B3D2E] !px-2.5 !py-1.5 !text-[13px] !text-white')}>
                                    {formatNum(autoCalcPct(it))}%
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                    {/* Why one Loss line moves every ingredient's multiplier.
                        Dead loss is the recipe's own shared figure, not a
                        per-input one — which is not obvious from a card that
                        looks exactly like Inputs, and is the question this
                        section raises most often. */}
                    {__WEB__ && sec.kind === 'loss' && secItems.length > 0 && (
                      <p className="rounded-[4px] border border-[#F0D9AE] bg-[#FFFBF2] px-3.5 py-2.5 text-[12px] font-semibold leading-relaxed text-[#8A5300]">
                        Dead loss isn&apos;t per-input — it&apos;s the recipe&apos;s own shared Loss line total, so it
                        raises every ingredient&apos;s multiplier.
                      </p>
                    )}
                    {/* The only way in to a manual by-product. The By-products
                        card is hidden until a recipe has one, so without this
                        a recipe that needs a hand-entered by-product had no
                        control anywhere to add it. */}
                    {__WEB__ && sec.kind === 'loss' && !hasManualByproduct && (
                      <button
                        type="button"
                        className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[4px] border border-dashed border-[#A9BFB2] text-[12.5px] font-extrabold uppercase tracking-[.05em] text-[#1B4E82] transition-colors hover:border-solid hover:border-[#1B4E82] hover:bg-[#F4F8FD]"
                        onClick={() => addItem('output')}
                      >
                        <Sparkles className="h-[18px] w-[18px]" /> Add a manual by-product
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {/* TOR calculator — the mass balance, and what it means for a real batch. */}
            {/* The website's calculator: a white card whose ANSWER sits in a
                forest block at the top, then the working underneath as a
                ruled table. It used to be one dark panel throughout, which
                made the figure you came for — total oil required — no louder
                than the eleven numbers explaining it. The app keeps its
                single dark table. */}
            {__WEB__ && (() => {
              const req = torRequirement()
              const batchQty = Number(torQty) || 0
              const uom = uomLabel(form.uom)
              const outName = products.find((pr) => String(pr.id) === String(form.product_id))?.name || 'the output'

              // One flat table, not three banded groups. What a reader is
              // actually comparing is a line against another line — how much
              // of this against how much of that — and a heading every few
              // rows kept breaking the column they were reading down. The
              // kind each line belongs to moves into a column of its own and
              // a mark down the left edge, which separates them without
              // interrupting anything.
              const TYPES: Record<string, { label: string; mark: string; fg: string; bg: string }> = {
                input: { label: 'IN', mark: '#12855A', fg: '#0B6B45', bg: '#FFFFFF' },
                loss: { label: 'LOSS', mark: '#B3261E', fg: '#8C2F26', bg: '#FDF3F2' },
                output: { label: 'BY-PROD', mark: '#1B4E82', fg: '#1B4E82', bg: '#F4F8FD' },
                batch: { label: 'MADE', mark: '#C7F03F', fg: '#0B6B45', bg: '#F4FBF6' }
              }
              const ins = req.rows.filter((r) => r.kind === 'input')
              // The batch itself is not a formulation line, but it is the
              // largest thing the recipe yields and reads as missing when the
              // by-products beneath it are listed and it is not.
              const rows: TorRow[] = [
                ...ins,
                ...req.rows.filter((r) => r.kind === 'loss'),
                {
                  key: 'batch',
                  kind: 'batch',
                  name: outName,
                  share: null,
                  q: batchQty,
                  fattyYield: null,
                  multiplier: null,
                  isBatch: true
                },
                ...req.rows.filter((r) => r.kind === 'output')
              ]
              // Bars are scaled against the LARGEST share, not against 100 —
              // a blend of 80/15/5 read as three stubs when every bar was a
              // fraction of a hundred.
              const maxShare = Math.max(1, ...ins.map((r) => Number(r.share) || 0))
              const balances = Math.abs(req.net - batchQty) < 0.005
              // Three decimals throughout, padded. formatNum drops trailing
              // zeros, so a column of it reads 100, 27.778, 5.348 — three
              // different widths, and the decimal points do not line up. A
              // working-out table is read down its columns.
              const f3 = (v: number | null | undefined): string =>
                v == null || Number.isNaN(v)
                  ? '—'
                  : v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
              const COLS =
                // Gridlines on every cell but the first, so the ruler
                // itself carries them and the header, the rows and the NET
                // line cannot disagree about where a column starts.
                'grid grid-cols-[58px_minmax(130px,1.5fr)_minmax(96px,1fr)_104px_100px_92px] items-center gap-0 px-3.5 [&>*+*]:border-l [&>*+*]:border-l-[#E4ECE3] [&>*+*]:pl-2.5 [&>*]:pr-2.5'

              return (
                <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                  {/* The answer, and the batch it is an answer for, on one
                      line. The quantity is typed here rather than somewhere
                      above, because changing it is the whole point of the
                      calculator. */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-[#0B3D2E] px-4 py-3.5 text-white">
                    <span className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.14em]">
                      <Calculator className="h-[18px] w-[18px] text-[#C7F03F]" /> TOR calculator
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-[9px] font-extrabold uppercase tracking-[.13em] text-[#8FBFA8]">Produce</span>
                      <Input
                        type="number"
                        className="!h-[38px] !w-[82px] !rounded-[3px] !border-white/25 !bg-white/10 !px-2.5 !text-right !text-[15px] !font-bold !tabular-nums !text-white"
                        value={torQty}
                        onChange={(e) => setTorQty(e.target.value)}
                      />
                      <span className="text-[10.5px] font-extrabold text-[#8FBFA8]">{uom}</span>
                    </span>
                    <ArrowRight className="h-[19px] w-[19px] shrink-0 text-[#5C7A6C]" />
                    <span className="flex items-baseline gap-2 border-l-[3px] border-l-[#C7F03F] pl-3">
                      <span className="text-[26px] font-bold leading-none tracking-[-0.035em] tabular-nums text-[#C7F03F]">
                        {f3((batchQty * tor) / 100)}
                      </span>
                      <span className="text-[10.5px] font-extrabold text-[#8FBFA8]">{uom} total oil</span>
                    </span>
                    <span className="flex items-baseline gap-2 border-l border-l-white/[.14] pl-3.5">
                      <span className="text-[20px] font-bold leading-none tracking-[-0.03em] tabular-nums">
                        {f3(tor)}%
                      </span>
                      <span className="text-[10.5px] font-extrabold text-[#8FBFA8]">TOR / 100</span>
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <div className="min-w-[660px]">
                      <div
                        className={cn(
                          COLS,
                          'h-[36px] border-b border-b-[#DCE7DB] border-l-[3px] border-l-transparent bg-[#EAF0E9] text-[9px] font-extrabold uppercase tracking-[.11em] text-[#33473E]'
                        )}
                      >
                        <span />
                        <span>Product</span>
                        <span>Share</span>
                        <span className="text-right">Quantity</span>
                        <span className="text-right">Fatty yield</span>
                        <span className="text-right">Multiplier</span>
                      </div>

                      {rows.length === 0 ? (
                        <div className="px-3.5 py-6 text-center text-[12px] font-semibold text-[#5A6B62]">
                          Add an input with a share and the working appears here.
                        </div>
                      ) : (
                        rows.map((r) => {
                          const t = TYPES[r.kind] || TYPES.input
                          const note = r.isBatch
                            ? 'the batch itself'
                            : r.kind === 'loss'
                              ? 'struck on the total oil'
                              : r.kind === 'output'
                                ? 'recovered'
                                : r.auto
                                  ? 'own multiplier'
                                  : ''
                          return (
                            <div
                              key={r.key}
                              className={cn(COLS, 'min-h-[42px] border-b border-b-[#EAF0E9] py-2')}
                              style={{ borderLeft: `3px solid ${t.mark}`, background: t.bg }}
                            >
                              <span
                                className="text-[9px] font-extrabold tracking-[.09em]"
                                style={{ color: t.fg }}
                              >
                                {t.label}
                              </span>
                              <span className="min-w-0 truncate text-[12.5px] font-extrabold text-[#0A1F17]" title={r.name}>
                                {r.name}
                                {note && <span className="text-[11px] font-semibold text-[#5A6B62]"> {note}</span>}
                              </span>
                              <span>
                                {r.share != null ? (
                                  <span className="flex items-center gap-2">
                                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                                      <span
                                        className="block h-full"
                                        style={{
                                          width: `${(Number(r.share) / maxShare) * 100}%`,
                                          background: '#12855A'
                                        }}
                                      />
                                    </span>
                                    <span className="flex-none text-[12px] font-bold tabular-nums text-[#33473E]">
                                      {f3(r.share)}%
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-[11px] font-semibold text-[#A8B8AE]">—</span>
                                )}
                              </span>
                              <span
                                className="whitespace-nowrap text-right text-[14.5px] font-bold tabular-nums"
                                style={{ color: r.kind === 'loss' ? '#8C2F26' : '#0A1F17' }}
                              >
                                {f3(r.q)}
                              </span>
                              <span className="whitespace-nowrap text-right text-[13.5px] font-bold tabular-nums text-[#1B4E82]">
                                {r.fattyYield != null ? f3(r.fattyYield) : '—'}
                              </span>
                              {/* Only an INPUT has a multiplier. A dead-loss
                                  line is a percentage struck on the total, not
                                  something multiplied up from a share, and the
                                  figure sitting there read as one more input
                                  carrying its own rate. */}
                              <span className="text-right text-[13px] font-semibold tabular-nums text-[#5A6B62]">
                                {r.kind === 'input' && r.multiplier != null ? `${f3(r.multiplier)}x` : '—'}
                              </span>
                            </div>
                          )
                        })
                      )}

                      {/* Does the mass balance? In minus what is lost and what
                          is recovered should be the batch, and if it is not
                          the recipe is wrong somewhere above. */}
                      <div
                        className={cn(COLS, 'border-l-[3px] border-l-transparent border-t-2 border-t-[#C7F03F] bg-[#EFF5EC] py-2.5')}
                      >
                        <span className="text-[9px] font-extrabold tracking-[.09em] text-[#5A6B62]">NET</span>
                        <span className="min-w-0 truncate text-[12px] font-bold text-[#33473E]">
                          {f3(req.inputTotal)} in − {f3(req.deadLossTotal)} lost − {f3(req.fattyYieldTotal)} recovered
                        </span>
                        <span />
                        <span className="whitespace-nowrap text-right text-[15.5px] font-bold tabular-nums">
                          {f3(req.net)}
                        </span>
                        <span className="col-span-2 flex items-center justify-end gap-1.5 text-right">
                          {balances ? (
                            <>
                              <CheckCircle2 className="h-4 w-4 text-[#0B6B45]" />
                              <span className="text-[11px] font-extrabold text-[#0B6B45]">balances</span>
                            </>
                          ) : (
                            <>
                              <AlertTriangle className="h-4 w-4 text-[#C2700A]" />
                              <span className="whitespace-nowrap text-[11px] font-extrabold text-[#8A5300]">
                                off by {f3(Math.abs(req.net - batchQty))}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Where the TOR came from. One line under the working
                      rather than a paragraph over it — the figures above have
                      already said what the answer is. */}
                  <div className="flex items-start gap-2.5 border-t border-t-[#E4ECE3] bg-[#F7FAF6] px-4 py-3">
                    <Info className="h-4 w-4 flex-none text-[#5A6B62]" />
                    <span className="text-[11.5px] font-semibold leading-relaxed text-[#33473E]">
                      {hasPerInputAutoCalc ? (
                        <>
                          Each input carries its own multiplier, so the total is every share × its own —
                          summed, <b className="text-[#0A1F17]">{formatNum(tor)}%</b> makes{' '}
                          {formatNum(batchQty)} {uom} of {outName}.
                        </>
                      ) : offInput > 0 ? (
                        <>
                          {formatNum(offInput)}% comes off the oil going in, so 100 ÷{' '}
                          {((100 - offInput) / 100).toFixed(4)} ={' '}
                          <b className="text-[#0A1F17]">{formatNum(tor)}%</b> has to be put in.
                        </>
                      ) : (
                        <>Nothing is lost — the blend goes in one for one with the output.</>
                      )}
                    </span>
                  </div>
                </div>
              )
            })()}
            {!__WEB__ && (
            <div className={cn('overflow-hidden rounded-2xl border border-[#2c4a8c] shadow-lg', __WEB__ && '!rounded-[4px] !border-[#0B3D2E] !shadow-none')}>
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2 bg-gradient-to-r from-[#0f1c3d] to-[#1a2c56] px-5 py-3 text-white',
                  __WEB__ && '!gap-2 !border-b !border-b-white/10 !bg-[#072B20] !bg-none !px-4 !py-2.5'
                )}
              >
                <Calculator className={cn('h-4 w-4 shrink-0 text-amber-400', __WEB__ && '!h-4 !w-4 !text-[#C7F03F]')} />
                <span className={cn('text-[13px] font-bold uppercase tracking-widest', __WEB__ && '!text-[11px] !font-extrabold !tracking-[.14em]')}>TOR Calculator</span>
                <span
                  className={cn(
                    'ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tabular-nums',
                    balanced ? 'border-emerald-400 bg-emerald-400/10 text-emerald-300' : 'border-rose-400 bg-rose-400/10 text-rose-300',
                    __WEB__ && '!rounded-[3px] !px-2.5 !py-1.5 !text-[11.5px] !font-bold',
                    __WEB__ &&
                      (balanced
                        ? '!border-[#C7F03F]/40 !bg-[#C7F03F]/15 !text-[#C7F03F]'
                        : '!border-[#F8B4AE]/40 !bg-[#B3261E]/30 !text-[#FFC4BE]')
                  )}
                >
                  Input blend {formatNum(blendPct)}% {balanced ? '✓' : '· must be 100%'}
                </span>
              </div>
              <div className={cn('bg-gradient-to-b from-[#1a2c56] to-[#132247] p-5 text-white', __WEB__ && '!bg-[#0B3D2E] !bg-none !p-5')}>
                <p className={cn('text-[12px] leading-relaxed text-white/70', __WEB__ && '!text-[12px] !font-semibold !text-[#8FBFA8]')}>
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

                <div className={cn('mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-black/20 p-4', __WEB__ && '!mt-4 !gap-3.5 !rounded-[4px] !border !border-white/10 !bg-[#072B20] !p-3')}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-white/60">Produce</span>
                    <Input
                      type="number"
                      className="h-11 w-28 border-white/20 bg-white/10 text-center text-lg font-bold tabular-nums text-white"
                      value={torQty}
                      onChange={(e) => setTorQty(e.target.value)}
                    />
                    <span className="text-[11px] uppercase tracking-wide text-white/60">{uomLabel(form.uom)}</span>
                  </div>
                  <ArrowRight className="h-5 w-5 shrink-0 text-white/40" />
                  <div className="flex items-baseline gap-2 rounded-xl bg-amber-400/15 px-4 py-2">
                    <span className="text-[11px] uppercase tracking-wide text-amber-300">Total oil required</span>
                    <span className="text-2xl font-black tabular-nums text-amber-300">
                      {formatNum(((Number(torQty) || 0) * tor) / 100)}
                    </span>
                    <span className="text-[11px] text-amber-300/80">{uomLabel(form.uom)}</span>
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
                          const { rows, fattyYieldTotal, inputTotal, deadLossTotal, net } = torRequirement()
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
                                  {formatNum(r.q)} <span className="font-normal text-white/60">{uomLabel(form.uom)}</span>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-emerald-300">
                                  {r.fattyYield != null ? `${formatNum(r.fattyYield)} ${uomLabel(form.uom)}` : '—'}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums text-white/60">{r.multiplier != null ? `×${r.multiplier.toFixed(4)}` : '—'}</td>
                              </tr>
                            )
                          })
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
                                  <span className="text-amber-300">{formatNum(net)} {uomLabel(form.uom)}</span>
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
            )}

            {/* Pinned to the bottom of the window on the website. A recipe
                with a dozen lines runs well past a screen, and Save sat at the
                far end of it. */}
            <div
              className={cn(
                'flex justify-end gap-2 pb-2',
                __WEB__ &&
                  '!sticky !bottom-0 !z-10 !gap-2 !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3 !py-2.5 !pb-3.5 !shadow-[0_-6px_18px_-8px_rgba(10,31,23,0.28)]'
              )}
            >
              {/* What still stands between this recipe and a save, said where
                  the save button is rather than only when it is refused. */}
              {__WEB__ && !balanced && (
                <span className="mr-auto flex items-center gap-2 text-[12px] font-bold text-[#8A5300]">
                  <Flame className="h-4 w-4 shrink-0 text-[#C2700A]" />
                  The input blend totals {formatNum(blendPct)}% — it must be 100%
                </span>
              )}
              <Button
                variant="outline"
                onClick={leaveEditor}
                disabled={saving}
                className={cn(__WEB__ && '!h-[42px] !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-6 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
              >
                Cancel
              </Button>
              <Button
                onClick={save}
                disabled={saving}
                className={cn(
                  'bg-[#1a2c56] hover:bg-[#24407e]',
                  __WEB__ && '!h-[42px] !rounded-[4px] !bg-[#0B3D2E] !px-7 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]'
                )}
              >
                {saving ? 'Saving…' : 'Save formulation'}
              </Button>
            </div>
          </div>
        </div>
        {manageSubcats}

        {/* Leaving with a recipe half-built.
            A browser refresh cannot be caught with a dialog of our own — that
            one is the browser's, raised by the beforeunload guard above. This
            is for the exits the page itself owns: Back, and Cancel. */}
        <Dialog open={leaveOpen} onOpenChange={(o) => !o && setLeaveOpen(false)}>
          <DialogContent
            className={cn(
              'max-w-md',
              __WEB__ && '!gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!hidden'
            )}
          >
            <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-4 !py-4 !text-left')}>
              {__WEB__ && (
                <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Formulation</div>
              )}
              <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white')}>
                Leave without saving?
              </DialogTitle>
            </DialogHeader>
            <p className={cn('text-[12px] text-muted-foreground', __WEB__ && '!px-4 !py-4 !text-[12.5px] !font-semibold !leading-relaxed !text-[#33473E]')}>
              {editing
                ? 'Your changes to this recipe have not been saved. Leaving now puts it back the way it was.'
                : 'This recipe has not been saved. Leaving now discards it.'}
            </p>
            <DialogFooter className={cn('gap-2', __WEB__ && '!flex-wrap !border-t !border-t-[#D6E2D6] !bg-white !px-4 !py-2.5')}>
              <Button
                variant="outline"
                onClick={() => setLeaveOpen(false)}
                className={cn(__WEB__ && '!h-[42px] !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !px-4 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]')}
              >
                Keep editing
              </Button>
              <Button
                variant="outline"
                onClick={discardAndLeave}
                className={cn(__WEB__ && '!h-[42px] !rounded-[4px] !border-[1.5px] !border-[#F0D6D4] !bg-[#FDF3F2] !px-4 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#B3261E] hover:!bg-[#FBE9E7]')}
              >
                Discard
              </Button>
              {/* Only offered when the recipe would actually save. The blend
                  must total 100% — a Save button that bounces on click is
                  worse than one that is not there, and the bar behind this
                  dialog already says what is missing. */}
              {balanced && (
                <Button
                  onClick={() => void saveAndLeave()}
                  disabled={saving}
                  className={cn(__WEB__ && '!h-[42px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]')}
                >
                  {saving ? 'Saving…' : 'Save formulation'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  // ---- list ----
  // Waiting on the recipe the URL named.
  //
  // Without this the register renders first, for the moment it takes the
  // recipe list and the products to arrive, and is then thrown away when the
  // editor opens over it. That flash of a list nobody asked for is what reads
  // as a glitch on refresh. A frame in the editor's own shape holds the space
  // instead, so the page arrives as the thing that was asked for.
  if (__WEB__ && pendingEdit) {
    return (
      <>
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3.5 gap-y-2 bg-[#0B3D2E] px-5 py-3 text-white shadow-[0_8px_20px_-12px_rgba(10,31,23,0.55)]">
          <span className="inline-flex h-10 items-center gap-2 rounded-[4px] border-[1.5px] border-[#C7F03F]/40 px-3.5 text-[13px] font-extrabold uppercase tracking-[.04em] text-[#C7F03F]/60">
            <ArrowLeft className="h-[19px] w-[19px]" /> Back
          </span>
          <div className="h-6 w-px bg-white/20" />
          <div className="min-w-0">
            <div className="text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              {pendingEdit === 'new' ? 'New formulation' : 'Edit formulation'}
            </div>
            <div className="mt-1 text-[15px] font-bold tracking-[-0.02em] text-[#8FBFA8]">Opening…</div>
          </div>
        </div>
        <div className="space-y-3.5 px-4 py-4">
          {[168, 260, 148].map((h, i) => (
            <div
              key={i}
              className="animate-pulse rounded-[4px] border border-[#D6E2D6] bg-white"
              style={{ height: h }}
            />
          ))}
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Formulation"
        subtitle="Recipes for finished goods and intermediates"
        hint="Inputs are the blend that goes in and total 100% (100% CPO base, or 70/30 of two oils). By-products and loss are percentages of that oil — 5.7% fatty acid and 1% dead loss leave 93.3% becoming RPO. TOR (Total Oil Required) follows: 100 ÷ 0.933 = 107.18%, so 100 MT of RPO draws 107.18 MT of CPO and throws off 6.11 MT of fatty acid. Inputs are consumed from stock, by-products land in stock, loss is written off."
        actions={
          <Button
            size="sm"
            className={cn(__WEB__ && '!gap-2 !bg-[#C7F03F] !px-3 !font-extrabold !text-[#12280B] hover:!bg-[#B8E32E]')}
            onClick={openAdd}
            disabled={outputs.length === 0}
          >
            <Plus className="h-4 w-4" />
            New formulation
          </Button>
        }
      />
      <div className="px-4 py-6">
        {/* Sub-category filter. Counts on each chip so it is obvious at a glance how
            much of the book is still unclassified. */}
        {rows.length > 0 && (
          <div className={cn('mb-4 flex flex-wrap items-center gap-2', __WEB__ && '!mb-3 !gap-2')}>
            <span className={cn('text-[10px] font-bold uppercase tracking-widest text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]')}>Sub-category</span>
            {[
              { key: 'all', label: 'All', count: rows.length },
              { key: 'none', label: 'Not classified', count: rows.filter((r) => !r.subcategory_id).length },
              ...subcats
                .filter((sc) => Number(sc.active) === 1)
                .map((sc) => ({
                  key: String(sc.id),
                  label: String(sc.name),
                  count: rows.filter((r) => String(r.subcategory_id ?? '') === String(sc.id)).length
                }))
            ].map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setSubcatFilter(o.key)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors',
                  subcatFilter === o.key
                    ? 'border-[#1a2c56] bg-[#1a2c56] text-white'
                    : 'text-muted-foreground hover:bg-muted',
                  FM_CHIP,
                  __WEB__ &&
                    (subcatFilter === o.key
                      ? '!border-[#0B3D2E] !bg-[#0B3D2E] !text-white'
                      : '!border-[#C3D2C6] !bg-white !text-[#33473E] hover:!bg-[#F7FAF6]')
                )}
              >
                {o.label}
                <span
                  className={cn(
                    'ml-1.5 tabular-nums opacity-70',
                    __WEB__ && '!ml-2 !rounded-[2px] !px-1.5 !py-0.5 !text-[10.5px] !opacity-100',
                    __WEB__ && (subcatFilter === o.key ? '!bg-[#C7F03F]/20 !text-[#C7F03F]' : '!bg-[#DCE7DB] !text-[#33473E]')
                  )}
                >
                  {o.count}
                </span>
              </button>
            ))}
            {/* Search beside the chips, as the other registers have it:
                the chips narrow to a family, this finds one recipe. */}
            {__WEB__ && (
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5A6B62]" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search output product or recipe name…"
                  className="!h-9 !rounded-[4px] !border-[#C3D2C6] !pl-9 !text-[12.5px]"
                />
              </div>
            )}
            <button
              type="button"
              className={cn(
                'ml-auto text-[11px] font-medium text-sky-700 hover:underline',
                __WEB__ &&
                  '!ml-0 !flex !h-9 !shrink-0 !items-center !gap-2 !rounded-[4px] !border !border-[#C3D2C6] !bg-white !px-3.5 !text-[12px] !font-extrabold !text-[#0B6B45] hover:!bg-[#F7FAF6] hover:!no-underline'
              )}
              onClick={() => setSubcatOpen(true)}
            >
              {__WEB__ && <Layers className="h-[18px] w-[18px]" />}
              Manage sub-categories
            </button>
          </div>
        )}
        {outputs.length === 0 && (
          <div className={cn('mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800', __WEB__ && '!rounded-[4px] !border-[#F0D9AE] !border-l-[3px] !border-l-[#C2700A] !bg-[#FFFBF2] !text-[12px] !font-bold !text-[#8A5300]')}>
            Add finished or intermediate products first (Products page) to build a formulation.
          </div>
        )}
        <div className={cn('rounded-lg border bg-card', __WEB__ && '!overflow-x-auto !rounded-[4px] !border-[#D6E2D6] !bg-white')}>
          <Table className={cn(__WEB__ && '!min-w-[1180px]')}>
            <TableHeader>
              <TableRow className={cn(FM_HEAD)}>
                <TableHead>
                  {__WEB__ ? (
                    <ColumnFilter label="Output product" options={colOptions('product')} value={prodCol} onApply={setProdCol} onDark />
                  ) : (
                    'Output product'
                  )}
                </TableHead>
                <TableHead>
                  {__WEB__ ? (
                    <ColumnFilter label="Category" options={colOptions('category')} value={catCol} onApply={setCatCol} onDark />
                  ) : (
                    'Category'
                  )}
                </TableHead>
                <TableHead>
                  {__WEB__ ? (
                    <ColumnFilter label="Recipe" options={colOptions('recipe')} value={recipeCol} onApply={setRecipeCol} onDark />
                  ) : (
                    'Recipe'
                  )}
                </TableHead>
                {/* Beside Recipe, and in the SAME position as its cell below —
                    the header sat one column further right, which shifted every
                    value from here to Loss out of its heading. */}
                <TableHead>
                  {__WEB__ ? (
                    <ColumnFilter label="Sub-category" options={colOptions('sub')} value={subCol} onApply={setSubCol} onDark />
                  ) : (
                    'Sub-category'
                  )}
                </TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">By-products</TableHead>
                <TableHead className="text-right">Loss</TableHead>
                <TableHead className="text-right"><span className={cn(__WEB__ && '!text-[#C7F03F]')}>TOR (per 100)</span></TableHead>
                <TableHead className="w-[90px] text-right"><span className={cn(__WEB__ && '!text-white')}>Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : shownRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    {rows.length ? 'No recipe matches these filters.' : 'No formulations yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                shownRows.map((row) => (
                  <TableRow
                    key={row.id as number}
                    className={cn(FM_ROW, __WEB__ && '!cursor-pointer')}
                    onClick={__WEB__ ? () => void openEdit(row) : undefined}
                  >
                    <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{row.product_name ?? '—'}</TableCell>
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
                    <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-[12px] !font-bold !text-[#33473E]')}>
                      {row.name || (__WEB__ ? <span className="!font-semibold !text-[#A8B8AE]">—</span> : '—')}
                    </TableCell>
                    <TableCell>
                      {row.subcategory_name ? (
                        <Badge
                          variant="muted"
                          className={cn(__WEB__ && '!rounded-[2px] !border !border-[#C6DAF0] !bg-[#EAF0FA] !px-2 !py-1 !text-[10.5px] !font-extrabold !uppercase !tracking-[.05em] !text-[#1B4E82]')}
                        >
                          {String(row.subcategory_name)}
                        </Badge>
                      ) : (
                        <span className={cn('text-[12px] italic text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !text-[#A8B8AE]')}>Not classified</span>
                      )}
                    </TableCell>
                    <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[12.5px] !font-bold')}>{row.item_count}</TableCell>
                    <TableCell className={cn('text-right tabular-nums text-emerald-700', __WEB__ && (Number(row.byproduct_pct) ? '!text-[12.5px] !font-bold !text-[#0B6B45]' : '!text-[12.5px] !font-semibold !text-[#C3D2C6]'))}>
                      {Number(row.byproduct_pct) ? `${formatNum(row.byproduct_pct)}%` : '—'}
                    </TableCell>
                    <TableCell className={cn('text-right tabular-nums text-amber-700', __WEB__ && (Number(row.loss_pct) ? '!text-[12.5px] !font-bold !text-[#8A5300]' : '!text-[12.5px] !font-semibold !text-[#C3D2C6]'))}>
                      {Number(row.loss_pct) ? `${formatNum(row.loss_pct)}%` : '—'}
                    </TableCell>
                    {(() => {
                      // The blend must total 100%; TOR is derived from it.
                      const ok = Math.abs(Number(row.blend_pct || 0) - 100) < 0.01
                      // How far past 100 this recipe has to reach. A TOR is
                      // only ever ≥ 100, so the digits alone make 101.0% and
                      // 129.1% look alike at a glance — the bar is the excess,
                      // scaled against 30 points of it, and takes the same
                      // green / amber / red the figure does.
                      const over = Math.max(0, Number(row.tor || 0) - 100)
                      const torFg = over > 20 ? '#B3261E' : over > 0 ? '#8A5300' : '#0B6B45'
                      const torBg = over > 20 ? '#B3261E' : over > 0 ? '#C2700A' : '#12855A'
                      return (
                        <TableCell
                          className={cn('text-right font-semibold tabular-nums', ok ? 'text-[#1a2c56]' : 'text-red-600', __WEB__ && '!text-right')}
                          title={
                            ok
                              ? 'Total oil required to produce 100 of the output'
                              : `The input blend totals ${formatNum(row.blend_pct)}% — it must be 100%`
                          }
                        >
                          {__WEB__ ? (
                            <>
                              <div
                                className="whitespace-nowrap text-[14.5px] font-bold tracking-[-0.02em] tabular-nums"
                                style={{ color: ok ? torFg : '#B3261E' }}
                              >
                                {formatNum(row.tor)}%
                              </div>
                              <div className="mt-1.5 h-1 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                                <div
                                  className="ml-auto h-full"
                                  style={{ width: `${Math.min(100, (over / 30) * 100)}%`, background: ok ? torBg : '#B3261E' }}
                                />
                              </div>
                            </>
                          ) : (
                            `${formatNum(row.tor)}%`
                          )}
                        </TableCell>
                      )
                    })()}
                    {/* The buttons keep their own clicks: a row that opens
                        the recipe must not also open it on the way to Delete. */}
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {/* One ⋮ rather than two boxed icons. The row itself
                          already opens the recipe, so Edit beside it was the
                          same action twice — and a red bin sitting permanently
                          in every row is a lot of weight for the one action
                          nobody wants to hit by accident. */}
                      {__WEB__ ? (
                        <div className="flex justify-end">
                          <RowActions
                            actions={[
                              { label: 'Edit this formulation', icon: Pencil, onClick: () => void openEdit(row) },
                              { label: 'Delete this formulation', icon: Trash2, danger: true, onClick: () => void del(row) }
                            ]}
                          />
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(row)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {/* What the filters actually left. A register that can be narrowed
              three ways should say how much of it is on screen. */}
          {__WEB__ && !loading && shownRows.length > 0 && (
            <div className="flex items-center gap-2 border-t border-t-[#EAF0E9] px-4 py-3">
              <Beaker className="h-[18px] w-[18px] shrink-0 text-[#A8B8AE]" />
              <span className="text-[12px] font-semibold text-[#5A6B62]">
                {shownRows.length === rows.length
                  ? `${rows.length} formulation${rows.length === 1 ? '' : 's'}`
                  : `${shownRows.length} of ${rows.length} formulations shown`}
              </span>
            </div>
          )}
        </div>
      </div>
      {manageSubcats}
    </>
  )
}
