import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDrawerEscape } from '@/lib/escape'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDownLeft, ArrowLeft, Beaker, Boxes, CalendarDays, CheckCircle2, ChevronRight, ChevronsDownUp, ChevronsUpDown, Factory, Layers, Pencil, Plus, RefreshCw, Sigma, StickyNote, Trash2, X, History as HistoryIcon } from 'lucide-react'
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
import { useIsMobile } from '@/lib/useIsMobile'
import { ProductionMobile } from './ProductionMobile'
import { ExcelButton } from '@/components/ExcelButton'
import { PeriodChip } from '@/components/PeriodChip'
import { RecordHistory, useRecordHistory } from '@/components/RecordHistory'
import { BatchMixHover } from '@/components/BatchMixHover'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { errText, formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  expandBatchWithOutputPp,
  expandRecipe,
  expandRecipeWithPp,
  inputFattyAcidPct,
  inputTorMultiplier,
  recipeTor,
  uniformRecipeTor
} from '@/lib/recipeMath'
import { InfoTip } from '@/components/ui/tooltip'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { Pagination, usePaged } from '@/components/Pagination'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The sheet's columns, written once so the header strip and the rows cannot
// drift apart. Product gets the most room because it is the field being
// searched; "draws from stock" is a read-out, so it takes what is left.
const SHEET_COLS =
  'grid grid-cols-[4rem_minmax(0,1.5fr)_minmax(0,1fr)_9rem_minmax(0,1.4fr)_2.25rem] gap-3'

// EACH RUN'S NUMBER WITHIN ITS DAY — #1, #2, #3 — for reading which batch ran
// first. `_no` is the stored day_no, or, for a run saved before numbering (or
// made automatically by a dispatch), its place in the day by entry order;
// `_noSet` says which. Within a day the register then reads #1 first.
function numberRuns(list: Row[]): Row[] {
  const byDay = new Map<string, Row[]>()
  for (const r of list) {
    const d = String(r.prod_date || '').slice(0, 10)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d)!.push(r)
  }
  const out: Row[] = []
  for (const day of byDay.values()) {
    const entry = [...day].sort((a, b) => Number(a.id) - Number(b.id))
    entry.forEach((r, i) => {
      const set = Number(r.day_no) > 0
      out.push({ ...r, _no: set ? Number(r.day_no) : i + 1, _noSet: set })
    })
  }
  return out.sort((a, b) => {
    const da = String(a.prod_date || '').slice(0, 10)
    const db = String(b.prod_date || '').slice(0, 10)
    if (da !== db) return da < db ? 1 : -1
    return Number(a._no) - Number(b._no) || Number(a.id) - Number(b.id)
  })
}

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

// A MIX COMPOSED FOR ONE BATCH.
//
// With formulation-based production switched off (Settings → Production), a
// run is not struck on a saved recipe. The floor writes the mix here, for this
// batch and no other — and sees, as it types, exactly what the saved-recipe
// path would have shown: the blend, the TOR it works out to, and what the
// quantity on the sheet will actually draw out of the tanks.
//
// NOT A SECOND KIND OF ARITHMETIC. recipeTor and expandRecipe are the same two
// functions the posted batch is expanded with, called here on the same shape
// of line, so the preview cannot describe one thing and the save do another.
// What a line IS, said in colour before it is said in words: a 3px edge down
// the card and a chip that matches it. A line left on the wrong kind — dead
// loss sitting as an input — is the one mistake this window exists to prevent,
// and it is visible here without reading a single figure.
const MIX_KIND: Record<string, { label: string; edge: string; bg: string; fg: string }> = {
  input: { label: 'Input', edge: '#8C2F26', bg: '#FDF3F2', fg: '#8C2F26' },
  loss: { label: 'Dead loss', edge: '#C2700A', bg: '#FFF4E0', fg: '#8A5300' },
  output: { label: 'By-product', edge: '#0B6B45', bg: '#E9F5EE', fg: '#0B6B45' }
}
// A batch's typed note, without the "PP Recirculation — …" line the server
// appends after it (production.ts, ppRunNote).
const mixNoteOf = (v: unknown): string => String(v || '').replace(/\s*(?:·\s*)?PP Recirculation —[^·]*/g, '').trim()
const mixKind = (k: unknown): (typeof MIX_KIND)['input'] => MIX_KIND[String(k || 'input')] || MIX_KIND.input

export function MixDrawer({
  open,
  onClose,
  products,
  stock,
  ppWithout,
  ppWith,
  outputProductId,
  items,
  outputName,
  outputQty,
  uom,
  onApply,
  note = '',
  // MASTER MODE. The same recipe editor, but saving a reusable formulation to
  // the master rather than a one-off batch mix: it grows a name, its heading
  // and its button say so, and it is what the PP breakdown opens so a
  // formulation can be built with its real lines on the spot.
  master = false,
  nameValue = '',
  onNameChange,
  saving = false,
  readOnly = false,
  onSaveForFuture
}: {
  open: boolean
  onClose: () => void
  products: Row[]
  /** Book stock per product — what the tanks say before this batch draws. */
  stock: Record<number, number>
  /**
   * PP — oil already in process — in its two kinds, per product.
   *
   * W/O FFA has had its free fatty acid stripped already, so a batch drawing
   * on it loses nothing to FFA and recovers none; With FFA has not, and sheds
   * its FFA on the way through exactly as raw oil does. The sheet below has
   * always read these; the drawer did not, so it showed a batch drawing its
   * whole requirement out of the yard while the save quietly took most of it
   * out of the vessels.
   */
  ppWithout: Record<number, number>
  ppWith: Record<number, number>
  /** The product being made — its own vessels are drawn before any recipe. */
  outputProductId: number
  items: Row[]
  outputName: string
  outputQty: number
  uom: string
  /** The note this one-off mix carries — why it was mixed this way. */
  note?: string
  onApply: (lines: Row[], note?: string) => void
  master?: boolean
  nameValue?: string
  onNameChange?: (v: string) => void
  saving?: boolean
  readOnly?: boolean
  onSaveForFuture?: (lines: Row[]) => void
}): React.JSX.Element | null {
  const overlay = useRef<HTMLDivElement>(null)
  useDrawerEscape(open, overlay, () => { if (!saving) onClose() })
  const [lines, setLines] = useState<Row[]>([])
  const [mixNote, setMixNote] = useState('')
  useEffect(() => {
    if (open) setMixNote(note)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    if (items.length) {
      setLines(
        items.map((it) => {
          // Opened at the material's own family, so the two steps read as
          // where this line already is rather than as empty filters over
          // something that is somehow set.
          const pr = products.find((p2) => String(p2.id) === String(it.product_id))
          return { ...it, _mat: String(pr?.material_type || ''), _cat: String(pr?.category || '') }
        })
      )
      return
    }
    // A NEW MIX ALREADY HAS ITS DEAD LOSS.
    //
    // Every recipe on the books carries one, and an FFA input without one is
    // refused — it is the shared assumption every multiplier is struck
    // against, not an optional extra. Starting at 1% is what the master's own
    // recipes use; it is a line like any other and can be changed or removed.
    const dead = products.find((p2) => /dead\s*loss/i.test(String(p2.name || '')))
    setLines([
      { product_id: '', qty: '', kind: 'input', _mat: '', _cat: '' },
      {
        product_id: dead ? String(dead.id) : '',
        qty: '1',
        kind: 'loss',
        _mat: String(dead?.material_type || ''),
        _cat: String(dead?.category || '')
      }
    ])
  }, [open, items, products])
  if (!open) return null

  const clean = lines
    .filter((l) => Number(l.qty) > 0 && (String(l.kind) === 'loss' || Number(l.product_id) > 0))
    .map((l) => ({
      product_id: Number(l.product_id) || 0,
      qty: Number(l.qty) || 0,
      kind: String(l.kind || 'input'),
      auto_calc: l.auto_calc ? 1 : 0,
      ffa_pct: l.ffa_pct === '' || l.ffa_pct == null ? null : Number(l.ffa_pct),
      loss_multiplier_pct:
        l.loss_multiplier_pct === '' || l.loss_multiplier_pct == null ? null : Number(l.loss_multiplier_pct),
      moisture_pct: l.moisture_pct === '' || l.moisture_pct == null ? null : Number(l.moisture_pct),
      byproduct_product_id: Number(l.byproduct_product_id) || null
    }))
  const inputs = clean.filter((l) => l.kind === 'input')
  const blend = inputs.reduce((t, l) => t + l.qty, 0)
  const tor = clean.length ? recipeTor(clean) : 0
  // THE SAME CALL THE SHEET AND THE SAVE MAKE.
  //
  // expandRecipe alone is the recipe's arithmetic — right for the TOR and the
  // derivation above, and wrong for "what will this draw", because it knows
  // nothing of the vessels. expandBatchWithOutputPp is what the projection on
  // the sheet uses and what createProduction posts, so the three now agree to
  // the gramme.
  const ownPools =
    outputProductId > 0
      ? { without: ppWithout[outputProductId] || 0, with: ppWith[outputProductId] || 0 }
      : {}
  const freeByProduct: Record<number, number> = {}
  for (const l of clean) {
    if (l.kind === 'input' && l.auto_calc) freeByProduct[l.product_id] = ppWithout[l.product_id] || 0
  }
  const expanded =
    outputQty > 0 && clean.length
      ? expandBatchWithOutputPp(clean, outputQty, ownPools, freeByProduct, outputProductId)
      : { lines: [], draws: [], plan: null as unknown as ReturnType<typeof expandBatchWithOutputPp>['plan'] }
  const draws = expanded.lines
  // How each input's gross splits between the two kinds of vessel oil and the
  // yard, keyed by product so a row can say where its oil is coming from.
  const split = new Map<number, { fromFree: number; fromFfa: number }>()
  for (const d of expanded.draws) split.set(Number(d.product_id), { fromFree: d.fromFree, fromFfa: d.fromFfa })
  const plan = expanded.plan
  const nameOf = (id: unknown): string =>
    String(products.find((p2) => String(p2.id) === String(id))?.name || '')
  // The categories on the master, and the sub-categories inside one of them.
  const cats = [...new Set(products.map((p2) => String(p2.material_type || '')).filter(Boolean))].sort()
  const subCats = (mat: string): string[] =>
    [
      ...new Set(
        products
          .filter((p2) => !mat || String(p2.material_type || '') === mat)
          .map((p2) => String(p2.category || ''))
          .filter(Boolean)
      )
    ].sort()
  // What one line may pick from, narrowed by its own two steps and in name
  // order — a list of two hundred materials is only findable sorted.
  const materialsFor = (l: Row): Row[] =>
    products
      .filter((p2) => !l._mat || String(p2.material_type || '') === String(l._mat))
      .filter((p2) => !l._cat || String(p2.category || '') === String(l._cat))
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  // A line needs a product unless it is dead loss, which is a percentage of
  // the batch rather than something drawn out of a tank.
  // An auto-calculated input with nowhere to put its fatty acid recovers
  // nothing, and the batch quietly loses it — the master refuses to save such
  // a recipe, so this refuses to apply such a mix.
  const orphanFatty = clean.some((l) => l.kind === 'input' && l.auto_calc && !Number(l.byproduct_product_id))
  // The dead loss every multiplier is struck against. Left out, each FFA input
  // is worked out on a yield of its own alone and the whole mix comes out
  // short — the master refuses such a recipe for the same reason.
  const deadLossPct = clean.filter((l) => l.kind === 'loss').reduce((t, l) => t + l.qty, 0)
  const missingDeadLoss = clean.some((l) => l.kind === 'input' && l.auto_calc) && deadLossPct <= 0
  // THE INPUTS SHARE OUT THE BATCH. Together they can come to 100 at most —
  // past it the shares no longer describe one batch. The server holds the
  // same line (production.ts, assertMixBlend).
  const overBlend = blend > 100.0005
  // A MIX FOR ONE BATCH IS WRITTEN IN HUNDREDTHS. Its inputs share the batch
  // out exactly — 65 : 25 : 10 — so short of 100 it is not finished: some of
  // the batch would be made of nothing. A saved formulation (master) keeps
  // its own parts as before.
  const underBlend = !master && blend > 0 && blend < 99.9995
  const ready =
    inputs.length > 0 &&
    blend > 0 &&
    !overBlend &&
    !underBlend &&
    !orphanFatty &&
    !missingDeadLoss &&
    lines.every((l) => !Number(l.qty) || Number(l.product_id) > 0) &&
    // A master formulation needs a name to be saved under; a batch mix does not.
    (!master || nameValue.trim().length > 0)

  const set = (i: number, patch: Row): void =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const blankLine = (): Row => ({ product_id: '', qty: '', kind: 'input', _mat: '', _cat: '' })
  const insertAt = (i: number): void =>
    setLines((prev) => [...prev.slice(0, i), blankLine(), ...prev.slice(i)])

  // The hairline between two cards, with the + on it. Quiet enough to ignore
  // and always drawn rather than shown on hover — this drawer is used on a
  // touch screen as readily as a mouse, and a hover-only control does not
  // exist there at all.
  const inserter = (i: number): React.JSX.Element => (
    <button
      key={`ins-${i}`}
      type="button"
      onClick={() => insertAt(i)}
      title="Add a line here"
      className="group flex h-[18px] w-full items-center gap-2 px-1"
    >
      <span className="h-px flex-1 bg-[#DCE7DB] transition-colors group-hover:bg-[#0B6B45]" />
      <span className="flex h-[16px] w-[16px] flex-none items-center justify-center rounded-full border border-[#C3D2C6] bg-white text-[#8CA396] transition-colors group-hover:border-[#0B6B45] group-hover:text-[#0B6B45]">
        <Plus className="h-[11px] w-[11px]" />
      </span>
      <span className="h-px flex-1 bg-[#DCE7DB] transition-colors group-hover:bg-[#0B6B45]" />
    </button>
  )

  const FIELD =
    'h-10 w-full rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[12.5px] font-semibold text-[#0A1F17] outline-none focus:border-[#0B3D2E]'

  // Each input's share of the blend, with a colour that is the same in the
  // bar, its legend and the ingredient's own row.
  const SHARE_COLORS = ['#0B6B45', '#1B4E82', '#8A5CC4', '#C2700A', '#2F8F83', '#B3261E', '#6B7B72']
  const inputShares = inputs.map((l, k) => ({
    l,
    k,
    share: blend > 0 ? (l.qty / blend) * 100 : 0,
    color: SHARE_COLORS[k % SHARE_COLORS.length]
  }))
  const lossLines = clean.filter((l) => l.kind === 'loss')
  const outLines = clean.filter((l) => l.kind === 'output')
  const catOf = (id: unknown): string => {
    const pr = products.find((p2) => String(p2.id) === String(id))
    if (!pr) return ''
    return [String(pr.material_type || ''), CAT_LABEL[String(pr.category || '')] ?? String(pr.category || '')].filter(Boolean).join(' · ')
  }

  return (
    <div
      // A dialog in its own right. This matters when it is opened over the PP
      // breakdown to build a master formulation: its dropdowns portal into the
      // NEAREST role="dialog", and without this they landed in the breakdown
      // dialog underneath — at a lower layer than this z-95 drawer — so the
      // open list sat hidden behind the drawer and could not be clicked. Marked
      // as the dialog here, the lists portal into this drawer and open in front.
      ref={overlay}
      aria-label={readOnly ? 'View formulation' : master ? 'New formulation' : 'Make formulation'}
      role="dialog"
      aria-modal="true"
      // Above the PP breakdown (z-80) when it is opened from there to build a
      // master formulation; its own layer otherwise.
      className={cn('fixed inset-0 flex justify-end', master ? 'z-[95]' : 'z-[70]')}
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-full w-[min(100%,880px)] flex-col bg-[#F1F5EF] shadow-[0_0_60px_rgba(10,31,23,.4)]">
        <div className="flex-none bg-[#0B3D2E] px-[22px] py-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
            {readOnly ? 'Formulation' : master ? 'New formulation' : 'Make formulation'}
          </div>
          {/* A formulation being READ is its name — so the name is the title,
              not a greyed-out box that looks like it wants typing into. */}
          {master && readOnly ? (
            <div className="mt-1 text-[18px] font-extrabold tracking-[-0.01em] text-white">{nameValue || 'Formulation'}</div>
          ) : null}
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 text-white">
            <span className={cn('font-bold tracking-[-0.01em]', master && readOnly ? 'text-[13px] text-[#B7D6C4]' : 'text-[15px]')}>
              {master && readOnly ? 'Makes ' : ''}
              {outputName || 'This batch'}
            </span>
            {outputQty > 0 && (
              <span className="doc-ref text-[12.5px] font-bold text-[#C7F03F]">
                {formatNum(outputQty)} {uom}
              </span>
            )}
          </div>
          {!readOnly && (
            <p className="mt-1 text-[11.5px] font-medium leading-[1.5] text-[#B7D6C4]">
              {master
                ? onSaveForFuture
                  ? 'Use for this PP, or save to Formulations.'
                  : 'Reusable formulation'
                : 'For this batch only — nothing is added to the Formulation master.'}
            </p>
          )}
          {master && !readOnly && (
            <input
              autoFocus
              value={nameValue}
              onChange={(e) => onNameChange?.(e.target.value)}
              placeholder={`Name this formulation of ${outputName || 'the oil'}`}
              className="mt-3 h-10 w-full rounded-[4px] border border-white/25 bg-white/10 px-3 text-[13.5px] font-semibold text-white outline-none placeholder:text-[#8FBFA8] focus:border-[#C7F03F]"
            />
          )}
        </div>

        <fieldset disabled={readOnly || saving} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-[22px] py-4">
          {/* THE ANSWER FIRST. What the recipe comes to — the blend, the shared
              loss, the TOR — and what it is made of, as one bar, before any
              line of it. It is what the drawer is opened to find out. */}
          <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div className="grid grid-cols-2 sm:grid-cols-4">
              {[
                {
                  k: 'Blend',
                  v: `${formatNum(blend)}`,
                  unit: 'parts',
                  sub: overBlend
                    ? `over 100 — take ${formatNum(Math.round((blend - 100) * 1000) / 1000)} off`
                    : underBlend
                      ? `must be 100 — add ${formatNum(Math.round((100 - blend) * 1000) / 1000)}`
                      : blend > 0 && Math.abs(blend - 100) > 0.0005
                        ? 'not 100 — shares read against the blend'
                        : 'the inputs together',
                  warn: blend > 0 && Math.abs(blend - 100) > 0.0005,
                  bad: overBlend || underBlend
                },
                { k: 'Dead loss', v: `${formatNum(deadLossPct)}`, unit: '%', sub: 'of the batch, shared by every input' },
                { k: 'TOR', v: `${formatNum(tor)}`, unit: '%', sub: `oil needed per 100 of ${outputName || 'output'}`, strong: true },
                {
                  k: 'Inputs',
                  v: String(inputs.length),
                  unit: inputs.length === 1 ? 'oil' : 'oils',
                  sub: `${inputs.filter((l) => l.auto_calc).length} worked out from FFA`
                }
              ].map((t, ti) => (
                <div
                  key={t.k}
                  className="min-w-0 px-4 py-3"
                  style={{
                    borderLeft: ti % 2 ? '1px solid #EAF0E9' : undefined,
                    borderTop: ti > 1 ? '1px solid #EAF0E9' : undefined,
                    background: 'bad' in t && t.bad ? '#FDF3F2' : t.strong ? '#F4FAF2' : undefined,
                    boxShadow: 'bad' in t && t.bad ? 'inset 0 -2px 0 #B3261E' : undefined
                  }}
                >
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#8CA396]">{t.k}</div>
                  <div className="mt-0.5 flex items-baseline gap-1">
                    <span className={cn('doc-ref text-[20px] font-bold tabular-nums tracking-[-0.03em]', 'bad' in t && t.bad ? 'text-[#B3261E]' : t.strong ? 'text-[#0B6B45]' : 'text-[#0A1F17]')}>
                      {t.v}
                    </span>
                    <span className="text-[11px] font-bold text-[#5A6B62]">{t.unit}</span>
                  </div>
                  <div className={cn('mt-0.5 overflow-hidden text-[10.5px] font-semibold leading-snug [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]', 'bad' in t && t.bad ? '!font-bold text-[#B3261E]' : t.warn ? 'text-[#8A5300]' : 'text-[#8CA396]')} title={t.sub}>
                    {t.sub}
                  </div>
                </div>
              ))}
            </div>
            {inputShares.length > 0 && (
              <div className="border-t border-t-[#EAF0E9] px-4 py-3">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#EAF0E9]">
                  {inputShares.map((s) => (
                    <div key={s.k} title={`${nameOf(s.l.product_id)} ${formatNum(s.share)}%`} style={{ width: `${s.share}%`, background: s.color }} />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {inputShares.map((s) => (
                    <span key={s.k} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[#33473E]">
                      <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
                      {nameOf(s.l.product_id) || `#${s.l.product_id}`}
                      <span className="tabular-nums text-[#5A6B62]">{formatNum(s.share)}%</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {readOnly ? (
            /* READ, NOT EDITED. A formulation opened to look at is a sheet: one
               row per ingredient with its share and the working that gives its
               multiplier, not a stack of greyed-out controls. */
            <div className="mt-3 overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div
                className="grid items-center bg-[#0B3D2E]"
                style={{ gridTemplateColumns: 'minmax(0,1fr) 70px 72px 86px 104px' }}
              >
                {(['Ingredient', 'Parts', 'Share', 'Multiplier', 'Oil needed'] as const).map((h, hi) => (
                  <div
                    key={h}
                    className="px-3 py-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FBFA8]"
                    style={{ textAlign: hi === 0 ? 'left' : 'right' }}
                  >
                    {h}
                  </div>
                ))}
              </div>
              {inputs.map((l, li) => {
                const lost = l.auto_calc ? inputFattyAcidPct(l) : 0
                const mult = l.auto_calc ? inputTorMultiplier(l, deadLossPct) : uniformRecipeTor(clean) / 100
                const y = l.auto_calc ? 100 - lost - deadLossPct : 100 - deadLossPct
                const share = inputShares.find((s) => s.l === l)
                return (
                  <div key={li} style={{ borderTop: li ? '1px solid #EAF0E9' : 'none' }}>
                    <div className="grid items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) 70px 72px 86px 104px' }}>
                      <div className="min-w-0 px-3 pt-2.5">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 flex-none rounded-[2px]" style={{ background: share?.color }} />
                          <span className="truncate text-[13px] font-bold text-[#0A1F17]">{nameOf(l.product_id) || `#${l.product_id}`}</span>
                        </div>
                        <div className="ml-[18px] truncate text-[10.5px] font-semibold text-[#8CA396]">{catOf(l.product_id)}</div>
                      </div>
                      <div className="px-3 pt-2.5 text-right text-[12.5px] font-semibold tabular-nums text-[#33473E]">{formatNum(l.qty)}</div>
                      <div className="px-3 pt-2.5 text-right text-[12.5px] font-semibold tabular-nums text-[#33473E]">{formatNum(share?.share || 0)}%</div>
                      <div className="px-3 pt-2.5 text-right text-[12.5px] font-bold tabular-nums text-[#0B6B45]">×{mult.toFixed(4)}</div>
                      <div className="px-3 pt-2.5 text-right text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatNum(l.qty * mult)}</div>
                    </div>
                    <div className="px-3 pb-2.5 pl-[30px] pt-1 text-[11px] font-medium leading-[1.5] text-[#5A6B62]">
                      {l.auto_calc ? (
                        <>
                          Yield worked out from FFA: {formatNum(Number(l.ffa_pct) || 0)}% FFA × (1 + {formatNum(Number(l.loss_multiplier_pct) || 0)}%)
                          {Number(l.moisture_pct) ? ` + ${formatNum(Number(l.moisture_pct))}% moisture` : ''} = {formatNum(lost)}% lost, so it yields{' '}
                          <b className="text-[#33473E]">{formatNum(y)}%</b>
                          {Number(l.byproduct_product_id) ? <> · the fatty acid comes back as <b className="text-[#33473E]">{nameOf(l.byproduct_product_id)}</b></> : null}
                        </>
                      ) : (
                        <>Shares the recipe&rsquo;s yield: 100 − {formatNum(deadLossPct)}% dead loss = <b className="text-[#33473E]">{formatNum(y)}%</b></>
                      )}
                    </div>
                  </div>
                )
              })}
              <div
                className="grid items-center"
                style={{ gridTemplateColumns: 'minmax(0,1fr) 104px', background: '#EFF5EC', borderTop: '1px solid #DCE7DB' }}
              >
                <div className="px-3 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
                  TOR — oil needed per 100 of {outputName || 'output'}
                </div>
                <div className="px-3 py-2 text-right text-[13.5px] font-extrabold tabular-nums text-[#0B6B45]">{formatNum(tor)}</div>
              </div>
              {[...lossLines, ...outLines].map((l, li) => {
                const tone = mixKind(l.kind)
                return (
                  <div key={`x${li}`} className="flex items-center gap-2.5 px-3 py-2" style={{ borderTop: '1px solid #EAF0E9' }}>
                    <span
                      className="flex-none rounded-[3px] px-1.5 py-[2px] text-[9.5px] font-extrabold uppercase tracking-[.1em]"
                      style={{ background: tone.bg, color: tone.fg }}
                    >
                      {tone.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#0A1F17]">{nameOf(l.product_id) || '—'}</span>
                    <span className="text-[12.5px] font-bold tabular-nums text-[#33473E]">{formatNum(l.qty)}%</span>
                    <span className="w-[86px] text-right text-[11px] font-semibold text-[#8CA396]">of the batch</span>
                  </div>
                )
              })}
            </div>
          ) : (
          <>
          <div className="mt-3 flex flex-col gap-2">
            {lines.map((l, i) => {
              const isLoss = String(l.kind) === 'loss'
              const kindTone = mixKind(l.kind)
              const isInput = String(l.kind || 'input') === 'input'
              // An input wears its colour from the blend bar above, and its
              // place among the inputs, so the bar and the card read as one.
              const share = isInput ? inputShares.find((s) => String(s.l.product_id) === String(l.product_id) && Number(l.product_id) > 0) : undefined
              const inputNo = isInput ? lines.slice(0, i + 1).filter((x) => String(x.kind || 'input') === 'input').length : 0
              return (
                <Fragment key={`line-${i}`}>
                {i > 0 && inserter(i)}
                <div
                  className="relative rounded-[6px] border border-[#D6E2D6] bg-white shadow-[0_1px_2px_rgba(10,31,23,.04)]"
                  style={{ borderLeft: `4px solid ${share?.color || kindTone.edge}` }}
                >
                  {isInput && (
                    <span
                      className="absolute -left-[13px] top-[18px] flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-white text-[10.5px] font-extrabold text-white shadow-[0_1px_3px_rgba(10,31,23,.25)]"
                      style={{ background: share?.color || kindTone.edge }}
                      title={share ? `Input ${inputNo} · ${formatNum(share.share)}% of the blend` : `Input ${inputNo}`}
                    >
                      {inputNo}
                    </span>
                  )}
                  {/* ONE ROW PER LINE: what it is, which material, how much.
                      The category and sub-category are there to narrow the
                      material list, so they sit under it as small helpers
                      rather than as two more boxes of the same weight. */}
                  <div className="grid grid-cols-[118px_minmax(0,1fr)_132px_40px] items-start gap-2 py-2.5 pl-4 pr-2.5">
                    <Select
                      value={String(l.kind || 'input')}
                      onValueChange={(kind) => {
                        // A guess, and only into an empty box: the loss line
                        // is booked against a product like any other, and
                        // every recipe on the books uses the same one.
                        const guess =
                          kind === 'loss' && !Number(l.product_id)
                            ? products.find((p2) => /dead\s*loss/i.test(String(p2.name || '')))
                            : null
                        set(i, guess ? { kind, product_id: String(guess.id) } : { kind })
                      }}
                    >
                      <SelectTrigger
                        className="!h-10 !rounded-[4px] !border-[#C3D2C6] !text-[12px] !font-extrabold"
                        style={{ color: kindTone.fg, background: kindTone.bg }}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="input">Input</SelectItem>
                        <SelectItem value="loss">Dead loss</SelectItem>
                        <SelectItem value="output">By-product</SelectItem>
                      </SelectContent>
                    </Select>

                    <div className="min-w-0">
                      <Select
                        value={String(l.product_id ?? '')}
                        onValueChange={(v) => {
                          // DEAD LOSS is never something a batch draws in. Left
                          // on Input it joins the blend — 101 parts instead of
                          // 100 — and every multiplier is struck without the
                          // shared loss, which is the one mistake this drawer
                          // can make quietly. So naming it settles the kind.
                          const pr = products.find((p2) => String(p2.id) === String(v))
                          const dead = /dead\s*loss/i.test(String(pr?.name || ''))
                          set(i, dead ? { product_id: v, kind: 'loss', auto_calc: 0 } : { product_id: v })
                        }}
                      >
                        <SelectTrigger
                          className={cn(
                            '!h-10 !justify-between !rounded-[4px] !px-3 !text-left !text-[12.5px] !font-bold [&>span]:!text-left',
                            Number(l.product_id) ? '!border-[#C3D2C6]' : '!border-[#E3C58C] !text-[#5A6B62]'
                          )}
                        >
                          <SelectValue placeholder={isLoss ? 'Booked against…' : 'Which material…'} />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          {materialsFor(l).map((p2) => (
                            <SelectItem key={String(p2.id)} value={String(p2.id)}>
                              {String(p2.name || '')} · {CAT_LABEL[String(p2.category || '')] ?? String(p2.category || '')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Select
                          value={String(l._mat || 'all')}
                          onValueChange={(v) => {
                            const next = v === 'all' ? '' : v
                            // A narrowing that would hide the material already
                            // picked clears it, so the box can never show a
                            // name the list below no longer offers.
                            const keep = products.some(
                              (p2) =>
                                String(p2.id) === String(l.product_id) &&
                                (!next || String(p2.material_type || '') === next)
                            )
                            set(i, { _mat: next, _cat: '', ...(keep ? {} : { product_id: '' }) })
                          }}
                        >
                          <SelectTrigger className="!h-7 !w-auto !min-w-[118px] !gap-1 !rounded-[3px] !border-[#DCE7DB] !bg-[#F7FAF6] !px-2 !text-[11px] !font-bold !text-[#5A6B62]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All categories</SelectItem>
                            {cats.map((m) => (
                              <SelectItem key={m} value={m}>
                                {m}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={String(l._cat || 'all')}
                          onValueChange={(v) => {
                            const next = v === 'all' ? '' : v
                            const keep = products.some(
                              (p2) =>
                                String(p2.id) === String(l.product_id) &&
                                (!next || String(p2.category || '') === next)
                            )
                            set(i, { _cat: next, ...(keep ? {} : { product_id: '' }) })
                          }}
                          disabled={!l._mat}
                        >
                          <SelectTrigger
                            className={cn(
                              '!h-7 !w-auto !min-w-[128px] !gap-1 !rounded-[3px] !border-[#DCE7DB] !bg-[#F7FAF6] !px-2 !text-[11px] !font-bold !text-[#5A6B62]',
                              !l._mat && '!opacity-50'
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All sub-categories</SelectItem>
                            {subCats(String(l._mat || '')).map((cx) => (
                              <SelectItem key={cx} value={cx}>
                                {CAT_LABEL[cx] ?? cx}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* WHAT IS ACTUALLY IN THE TANK. Not a blocker — the
                            count may simply be behind the floor — but worth
                            knowing before a batch is struck on it. */}
                        {Number(l.product_id) > 0 &&
                          (() => {
                            const bal = Number(stock[Number(l.product_id)] ?? 0)
                            const short = bal < -0.0005
                            return (
                              <span className="ml-auto text-[10.5px] font-semibold" style={{ color: short ? '#B3261E' : '#8CA396' }}>
                                in stock {formatNum(bal)} {uom}
                                {short ? ' — already negative' : ''}
                              </span>
                            )
                          })()}
                      </div>
                    </div>

                    {/* PARTS, NOT PER CENT — and the per cent said out loud.
                        A blend is written in parts (65 : 25 : 10); the line
                        under the box states the share that part comes to. A
                        loss or a by-product is already a % of the batch. */}
                    <div>
                      <div className="relative">
                        <input
                          type="number"
                          value={String(l.qty ?? '')}
                          onChange={(e) => set(i, { qty: e.target.value })}
                          placeholder="0"
                          className={cn(
                            FIELD,
                            'pr-12 text-right tabular-nums',
                            (overBlend || underBlend) && !isLoss && String(l.kind) !== 'output' && Number(l.qty) > 0 && '!border-[#B3261E] !bg-[#FDF3F2]'
                          )}
                        />
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-[#8CA396]">
                          {isLoss || String(l.kind) === 'output' ? '%' : 'parts'}
                        </span>
                      </div>
                      <div className="mt-1 text-right text-[10.5px] font-bold tabular-nums text-[#5A6B62]">
                        {isLoss || String(l.kind) === 'output'
                          ? 'of the batch'
                          : blend > 0 && Number(l.qty) > 0
                            ? `${formatNum((Number(l.qty) / blend) * 100)}% of the blend`
                            : 'share of the blend'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                      aria-label="Remove this line"
                      className="flex h-10 w-10 flex-none items-center justify-center rounded-[4px] border border-[#E4ECE3] bg-white text-[#8C2F26] hover:border-[#F0D6D4] hover:bg-[#FDF3F2]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* THE OIL THAT NEVER ARRIVES. An input carrying its own FFA
                      yields less than its share says, and the saved recipes
                      model that per line — one tidy row, the working beside it. */}
                  {isInput && (
                    <div
                      className="border-t border-t-[#EFF3EE] px-2.5 py-2"
                      style={{ background: l.auto_calc ? '#FBF8EF' : '#FBFCFA' }}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <label className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#33473E]">
                          <input
                            type="checkbox"
                            checked={!!l.auto_calc}
                            onChange={(e) => {
                              // The same default the Formulation master
                              // offers, and only into an empty box.
                              const fatty = products.find((p2) => {
                                const nm = String(p2.name || '').trim().toLowerCase()
                                return nm === 'fatty acid' || nm === 'fatty oil' || nm.startsWith('fatty acid')
                              })
                              set(
                                i,
                                e.target.checked
                                  ? {
                                      auto_calc: 1,
                                      byproduct_product_id: l.byproduct_product_id || (fatty ? String(fatty.id) : '')
                                    }
                                  : { auto_calc: 0 }
                              )
                            }}
                            className="h-3.5 w-3.5"
                          />
                          Yield from FFA
                        </label>
                        {!l.auto_calc ? (
                          <span className="text-[10.5px] font-semibold text-[#8CA396]">
                            Off — shares the recipe&rsquo;s yield. Turn on for an oil carrying free fatty acid.
                          </span>
                        ) : (
                          <>
                            {(
                              [
                                { k: 'ffa_pct', label: 'FFA' },
                                { k: 'loss_multiplier_pct', label: 'Loss ×' },
                                { k: 'moisture_pct', label: 'Moisture' }
                              ] as const
                            ).map((f) => (
                              <span key={f.k} className="flex items-center gap-1 text-[11px] font-bold text-[#5A6B62]">
                                {f.label}
                                <span className="relative">
                                  <input
                                    type="number"
                                    value={String(l[f.k] ?? '')}
                                    onChange={(e) => set(i, { [f.k]: e.target.value })}
                                    className="h-8 w-[74px] rounded-[3px] border border-[#C3D2C6] bg-white pl-2 pr-5 text-right text-[12px] tabular-nums outline-none focus:border-[#0B3D2E]"
                                  />
                                  <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-[#8CA396]">%</span>
                                </span>
                              </span>
                            ))}
                            {/* WHERE THE FATTY ACID GOES — recovered, not
                                destroyed, and it needs a product to come back
                                as, defaulted to the one the master uses. */}
                            <span className="flex min-w-[200px] flex-1 items-center gap-1.5 text-[11px] font-bold text-[#5A6B62]">
                              Recovers as
                              <span className="min-w-0 flex-1">
                                <Select
                                  value={l.byproduct_product_id ? String(l.byproduct_product_id) : ''}
                                  onValueChange={(v) => set(i, { byproduct_product_id: v })}
                                >
                                  <SelectTrigger
                                    className={cn(
                                      '!h-8 !rounded-[3px] !bg-white !text-[12px] !font-bold',
                                      Number(l.byproduct_product_id) ? '!border-[#C3D2C6]' : '!border-[#E3C58C]'
                                    )}
                                  >
                                    <SelectValue placeholder="e.g. Fatty Acid" />
                                  </SelectTrigger>
                                  <SelectContent className="max-h-64">
                                    {products
                                      .slice()
                                      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
                                      .map((p2) => (
                                        <SelectItem key={String(p2.id)} value={String(p2.id)}>
                                          {String(p2.name || '')} ·{' '}
                                          {CAT_LABEL[String(p2.category || '')] ?? String(p2.category || '')}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                              </span>
                            </span>
                          </>
                        )}
                      </div>
                      {/* THE WORKING, in one line, with the answer at the end. */}
                      {!!l.auto_calc &&
                        (() => {
                          const ffa = Number(l.ffa_pct) || 0
                          const lm = Number(l.loss_multiplier_pct) || 0
                          const mo = Number(l.moisture_pct) || 0
                          const lost = ffa * (1 + lm / 100) + mo
                          const y = 100 - lost - deadLossPct
                          return (
                            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[11px] font-semibold tabular-nums text-[#5A6B62]">
                              <span>
                                lost {formatNum(ffa)} × (1 + {formatNum(lm)}%){mo ? ` + ${formatNum(mo)}` : ''} = <b className="text-[#33473E]">{formatNum(lost)}%</b>
                              </span>
                              <span className="text-[#C3D2C6]">·</span>
                              <span>
                                yield 100 − {formatNum(lost)} − {formatNum(deadLossPct)} = <b className="text-[#33473E]">{formatNum(y)}%</b>
                              </span>
                              <span className="ml-auto rounded-[3px] bg-[#E9F5EE] px-1.5 py-[1px] text-[12px] font-extrabold text-[#0B6B45]">
                                ×{y > 0 ? (100 / y).toFixed(4) : '—'}
                              </span>
                            </div>
                          )
                        })()}
                    </div>
                  )}
                  {isLoss && (
                    <div className="border-t border-t-[#EFF3EE] px-2.5 py-1.5 text-[10.5px] font-semibold text-[#8A5300]">
                      A share of the batch, not oil drawn from a tank — every input&rsquo;s multiplier is struck against it.
                    </div>
                  )}
                </div>
                </Fragment>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() => setLines((prev) => [...prev, { product_id: '', qty: '', kind: 'input', _mat: '', _cat: '' }])}
            className="mt-2.5 flex h-10 w-full items-center justify-center gap-1.5 rounded-[4px] border border-dashed border-[#C3D2C6] bg-white text-[12.5px] font-extrabold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            <Plus className="h-4 w-4" /> Add a line
          </button>
          </>
          )}

          {/* THE MIX'S NOTE. A one-off mix has no recipe name to explain
              itself, so it says in words why it was run this way — and the
              Production register shows it beside "Mix for this batch". */}
          {!master && (readOnly ? !!note.trim() : true) && (
            <div className="mt-4 overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div className="flex items-center gap-2 border-b border-b-[#EAF0E9] px-4 py-2.5">
                <span className="text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">Remarks for this batch</span>
                {!readOnly && <span className="text-[10.5px] font-semibold text-[#A8B8AE]">optional · shown when you hover its Type</span>}
              </div>
              {readOnly ? (
                <div className="px-4 py-3 text-[12.5px] font-semibold leading-relaxed text-[#33473E] [overflow-wrap:anywhere]">{note}</div>
              ) : (
                <div className="px-4 py-3">
                  <textarea
                    rows={2}
                    value={mixNote}
                    maxLength={500}
                    onChange={(e) => setMixNote(e.target.value)}
                    placeholder="Why this mix — e.g. tank 3 short of CPO, topped up with RPS"
                    className="w-full resize-none rounded-[4px] border border-[#C3D2C6] bg-white px-3 py-2 text-[12.5px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#9FB3A6] focus:border-[#0B3D2E]"
                  />
                </div>
              )}
            </div>
          )}

          {/* WHAT IT COMES TO. The same two functions the save uses, so the
              figures here are the figures that will be booked. */}
          {(!readOnly || (outputQty > 0 && draws.length > 0)) && (
          <div className="mt-4 overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
            <div className="border-b border-b-[#EAF0E9] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">
              {readOnly ? 'What this batch draws' : 'How it works out'}
            </div>

            {/* BAND 2 — HOW THAT MULTIPLIER IS STRUCK.
                The row already states a TOR and the sheet already states what
                will be drawn. What neither shows is the WORKING, and the
                working is what somebody questioning a figure is asking for. */}
            {inputs.length > 0 && !readOnly && (
              <div>
                {inputs.some((l) => !l.auto_calc) && (
                  <div className="px-4 pt-2.5 text-[10.5px] font-semibold text-[#5A6B62]">
                    inputs without their own FFA share the recipe multiplier{' '}
                    <b className="tabular-nums text-[#33473E]">{formatNum(uniformRecipeTor(clean))}%</b>
                  </div>
                )}
                <div className="px-4 py-2.5">
                  <div className="overflow-hidden rounded-[3px]" style={{ border: '1px solid #DCE7DB' }}>
                    <div
                      className="grid items-center"
                      style={{ gridTemplateColumns: 'minmax(0,1fr) 74px 148px 96px 116px', background: '#0B3D2E' }}
                    >
                      {(['Input', 'Parts', 'Its yield', 'Multiplier', 'Oil needed'] as const).map((h, hi) => (
                        <div
                          key={h}
                          style={{
                            padding: '6px 9px',
                            fontSize: 9,
                            fontWeight: 800,
                            letterSpacing: '.12em',
                            textTransform: 'uppercase',
                            color: '#8FBFA8',
                            textAlign: hi === 0 ? 'left' : 'right'
                          }}
                        >
                          {h}
                        </div>
                      ))}
                    </div>
                    {inputs.map((l, li) => {
                      const lost = l.auto_calc ? inputFattyAcidPct(l) : 0
                      const mult = l.auto_calc
                        ? inputTorMultiplier(l, deadLossPct)
                        : uniformRecipeTor(clean) / 100
                      const y = l.auto_calc ? 100 - lost - deadLossPct : 100 - deadLossPct
                      return (
                        <div
                          key={li}
                          className="grid items-center"
                          style={{
                            gridTemplateColumns: 'minmax(0,1fr) 74px 148px 96px 116px',
                            background: li % 2 ? '#F7FAF6' : '#fff',
                            borderTop: li ? '1px solid #EAF0E9' : 'none'
                          }}
                        >
                          <div className="truncate px-[9px] py-[6px] text-[11.5px] font-bold text-[#0A1F17]">
                            {nameOf(l.product_id) || `#${l.product_id}`}
                          </div>
                          <div className="px-[9px] py-[6px] text-right text-[11.5px] tabular-nums text-[#33473E]">
                            {formatNum(l.qty)}
                          </div>
                          <div className="px-[9px] py-[6px] text-right text-[11px] tabular-nums text-[#5A6B62]">
                            {l.auto_calc
                              ? `100 − ${formatNum(lost)} − ${formatNum(deadLossPct)} = ${formatNum(y)}`
                              : `shared — 100 − ${formatNum(deadLossPct)} = ${formatNum(y)}`}
                          </div>
                          <div className="px-[9px] py-[6px] text-right text-[11.5px] font-bold tabular-nums text-[#0B6B45]">
                            ×{mult.toFixed(4)}
                          </div>
                          <div className="px-[9px] py-[6px] text-right text-[12px] font-bold tabular-nums text-[#0A1F17]">
                            {formatNum(l.qty * mult)}
                          </div>
                        </div>
                      )
                    })}
                    <div
                      className="grid items-center"
                      style={{
                        gridTemplateColumns: 'minmax(0,1fr) 74px 148px 96px 116px',
                        background: '#EFF5EC',
                        borderTop: '1px solid #DCE7DB'
                      }}
                    >
                      <div
                        className="truncate px-[9px] py-[7px] text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E]"
                        style={{ gridColumn: 'span 4' }}
                      >
                        TOR — oil needed per 100 of {outputName || 'output'}
                      </div>
                      <div className="px-[9px] py-[7px] text-right text-[12.5px] font-extrabold tabular-nums text-[#0B6B45]">
                        {formatNum(tor)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {outputQty > 0 && draws.length > 0 ? (
              <div className="flex flex-col">
                {/* WHAT THE VESSELS ARE ALREADY HOLDING.
                    Said before the draws, because it changes every figure
                    under it: the part of this batch that is finished out of
                    the product's own PP makes nothing new — the oil is already
                    inside its stock — so only the remainder goes through the
                    recipe at all. */}
                {!!plan && Number(plan.fromPpFree) + Number(plan.ppWithUsed) > 0.0005 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-b-[#F1F5EF] bg-[#F7FAF6] px-4 py-2">
                    <span className="rounded-[2px] bg-[#EAF0FA] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#1B4E82]">
                      from its own PP
                    </span>
                    {Number(plan.fromPpFree) > 0.0005 && (
                      <span className="text-[11.5px] font-semibold text-[#33473E]">
                        W/O FFA <b className="tabular-nums">{formatNum(plan.fromPpFree)}</b> {uom}
                      </span>
                    )}
                    {Number(plan.ppWithUsed) > 0.0005 && (
                      <span className="text-[11.5px] font-semibold text-[#33473E]">
                        With FFA <b className="tabular-nums">{formatNum(plan.ppWithUsed)}</b> {uom}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-[11px] font-medium text-[#5A6B62]">
                      only <b className="tabular-nums text-[#33473E]">{formatNum(plan.fromRecipe)} {uom}</b> is made from
                      the recipe
                    </span>
                  </div>
                )}
                {draws.map((d, i) => {
                  const sp = split.get(Number(d.product_id))
                  const free = Number(sp?.fromFree) || 0
                  return (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 border-b border-b-[#F1F5EF] px-4 py-2 last:border-b-0"
                  >
                    <span
                      className={cn(
                        'rounded-[2px] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-[.06em]',
                        d.kind === 'input'
                          ? 'bg-[#FDECEA] text-[#8C2F26]'
                          : d.kind === 'loss'
                            ? 'bg-[#FFF4E0] text-[#8A5300]'
                            : d.kind === 'pp_equiv'
                              ? 'bg-[#EAF0FA] text-[#1B4E82]'
                              : 'bg-[#EAF6EC] text-[#0B6B45]'
                      )}
                    >
                      {d.kind === 'input'
                        ? 'draws'
                        : d.kind === 'loss'
                          ? 'loss'
                          : d.kind === 'pp_equiv'
                            ? 'in the PP'
                            : 'gives'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-[#0A1F17]">
                      {nameOf(d.product_id) || `#${d.product_id}`}
                    </span>
                    {/* An input part-supplied from W/O-FFA PP says so on its
                        own line: that part is taken one for one and sheds no
                        fatty acid, which is why the gross beside it is smaller
                        than the recipe alone would ask for. */}
                    {free > 0.0005 && (
                      <span className="text-[10.5px] font-semibold text-[#1B4E82]">
                        {formatNum(free)} of it from W/O FFA PP
                      </span>
                    )}
                    <span
                      className={cn(
                        'doc-ref text-[13px] font-bold tabular-nums',
                        d.kind === 'pp_equiv' ? 'text-[#5A6B62]' : 'text-[#0A1F17]'
                      )}
                    >
                      {formatNum(d.qty)} {uom}
                    </span>
                  </div>
                  )
                })}
                {/* The lines that only RESTATE what the vessel oil already is
                    — shown because the sheet shows them, and left grey because
                    nothing moves for them: that stock came out when the PP was
                    made. */}
                {draws.some((d) => d.kind === 'pp_equiv') && (
                  <div className="px-4 py-2 text-[10.5px] font-medium leading-[1.5] text-[#5A6B62]">
                    The <b>in the PP</b> rows are what the vessel oil already IS by this formulation, not a second draw
                    — that stock left the tanks when the PP was made.
                  </div>
                )}
              </div>
            ) : (
              <div className="px-4 py-5 text-center text-[12px] font-semibold text-[#8CA396]">
                {outputQty > 0
                  ? 'Add a line with a quantity to see what it draws.'
                  : 'Type the batch quantity on the sheet to see what it draws.'}
              </div>
            )}
          </div>
          )}
        </fieldset>

        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#D6E2D6] bg-white px-[22px] py-4">
          <span
            className="flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] font-semibold"
            style={{ color: ready ? '#0B6B45' : '#8A5300' }}
          >
            {ready ? (
              <CheckCircle2 className="h-4 w-4 flex-none" />
            ) : (
              <AlertTriangle className="h-4 w-4 flex-none" />
            )}
            {readOnly ? 'Read only' : ready
              ? master
                ? 'Ready'
                : 'Ready — this batch will be booked on these lines.'
              : master && !nameValue.trim()
                ? 'Name the formulation to save it.'
                : inputs.length === 0 || blend <= 0
                  ? 'Add at least one input with a quantity.'
                  : overBlend
                    ? `The inputs come to ${formatNum(blend)} parts — they cannot be more than 100.`
                  : underBlend
                    ? `The inputs come to ${formatNum(blend)} parts — a batch's mix must come to exactly 100.`
                  : missingDeadLoss
                    ? 'Add a dead loss line — every input worked out from FFA is struck against it.'
                    : orphanFatty
                      ? 'Say which product the recovered fatty acid becomes, on every FFA input.'
                      : 'Every line with a quantity needs a material against it.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {master && onSaveForFuture && !readOnly && <button type="button" disabled={!ready || saving}
            onClick={() => onSaveForFuture(clean)} className="h-10 rounded-md border border-[#C3D2C6] bg-white px-4 text-xs font-bold disabled:opacity-40">Save for future</button>}
          {!readOnly &&           <button
            type="button"
            disabled={!ready || saving}
            onClick={() => onApply(clean, mixNote.trim())}
            className={cn(
              'h-10 rounded-[4px] px-4 text-[12px] font-extrabold',
              'flex items-center gap-[7px]',
              ready ? 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]' : 'bg-[#C3D2C6] text-[#F1F5EF]'
            )}
          >
            <Beaker className="h-[17px] w-[17px]" />
            {master ? (saving ? 'Saving…' : onSaveForFuture ? 'Use now' : 'Save formulation') : 'USE THIS MIX'}
          </button>}
        </div>
      </div>
    </div>
  )
}

// HOW THE RECIPE ARRIVES AT ITS MULTIPLIER.
//
// The row already states a TOR and the sheet already states what will be
// drawn. What neither shows is the WORKING, and the working is what somebody
// questioning a figure is asking for. So this window is the derivation and
// nothing else: no tonnage, no draw, no outcome — the steps that turn a blend
// and its FFA into the multiplier every batch on this recipe is struck on.
function RecipeMathDialog({
  open,
  onClose,
  recipe,
  items,
  outputName
}: {
  open: boolean
  onClose: () => void
  recipe: Row | null
  items: Row[]
  outputName: string
}): React.JSX.Element | null {
  if (!open || !recipe) return null
  const inputs = items.filter((it) => String(it.kind || 'input') === 'input')
  const losses = items.filter((it) => String(it.kind || '') === 'loss')
  const deadLoss = losses.reduce((t, it) => t + (Number(it.qty) || 0), 0)
  const uniform = uniformRecipeTor(items)
  const tor = recipeTor(items)
  const blend = inputs.reduce((t, it) => t + (Number(it.qty) || 0), 0)
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const nameOf = (it: Row): string => String(it.product_name || `#${it.product_id}`)
  // Each input's own line of working, worked out with the same functions the
  // batch is posted with so the steps cannot describe one thing and the save
  // do another.
  const steps = inputs.map((it) => {
    const share = Number(it.qty) || 0
    const auto = !!it.auto_calc
    const ffa = auto ? inputFattyAcidPct(it) : 0
    const yieldPct = auto ? 100 - ffa - deadLoss : 100 - deadLoss
    const mult = auto ? inputTorMultiplier(it, deadLoss) : uniform / 100
    return { it, share, auto, ffa, yieldPct, mult, contributes: share * mult }
  })
  const H = 'px-3 py-2 text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]'
  const C = 'px-3 py-2 text-[12px] tabular-nums'
  const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }): React.JSX.Element => (
    <div className="mt-3 overflow-hidden rounded-[4px] border border-[#DCE7DB] bg-white first:mt-0">
      <div className="flex items-center gap-2 border-b border-b-[#EAF0E9] bg-[#F7FAF6] px-3.5 py-2">
        <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] font-extrabold text-[#C7F03F]">
          {n}
        </span>
        <span className="text-[10px] font-extrabold uppercase tracking-[.11em] text-[#0A1F17]">{title}</span>
      </div>
      {children}
    </div>
  )

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[88vh] w-[760px] max-w-full flex-col overflow-hidden rounded-[6px] bg-white shadow-[0_24px_60px_rgba(10,31,23,.28)]">
        <div className="flex flex-none items-start gap-3 border-b border-b-[#E4ECE3] px-[22px] py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-extrabold tracking-[-0.01em] text-[#0A1F17]">
              {String(recipe.name || `Recipe #${recipe.id}`)}
            </div>
            <div className="mt-0.5 text-[12px] font-semibold text-[#5A6B62]">
              How the multiplier for {outputName || 'this oil'} is worked out
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] text-[#5A6B62] hover:bg-[#F7FAF6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#FBFCFA] px-[22px] py-4">
          <Step n={1} title="The loss every input carries">
            <div className="px-3.5 py-3 text-[12px] font-semibold leading-[1.6] text-[#33473E]">
              {deadLoss > 0.0005 ? (
                <>
                  The recipe declares a shared dead loss of{' '}
                  <span className="doc-ref font-bold text-[#0A1F17]">{formatNum(deadLoss)}%</span>. On its own that
                  would make one multiplier for the whole blend:
                  <div className="doc-ref mt-1.5 text-[12.5px] font-bold text-[#0A1F17]">
                    100 ÷ (100 − {formatNum(deadLoss)}) = {formatNum(r3(uniform / 100))}  → {' '}
                    {formatNum(r3(uniform))}%
                  </div>
                </>
              ) : (
                <>This recipe declares no shared dead loss, so nothing is taken off before each input&rsquo;s own FFA.</>
              )}
            </div>
          </Step>

          <Step n={2} title="Then each input's own rate, because FFA differs">
            <div className="px-3.5 pt-3 text-[12px] font-semibold leading-[1.6] text-[#33473E]">
              A raw oil carrying more free fatty acid gives back less, so an input marked auto-calculated is worked out
              on its own yield rather than the blend&rsquo;s.
            </div>
            <table className="mt-2 w-full">
              <thead className="bg-[#F7FAF6]">
                <tr>
                  <th className={cn(H, 'text-left')}>Input</th>
                  <th className={cn(H, 'text-right')}>Share</th>
                  <th className={cn(H, 'text-right')}>FFA</th>
                  <th className={cn(H, 'text-left')}>Its yield</th>
                  <th className={cn(H, 'text-left')}>Its multiplier</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((st, k) => (
                  <tr key={k} className="border-t border-t-[#EAF0E9]">
                    <td className={cn(C, 'font-bold text-[#0A1F17]')}>{nameOf(st.it)}</td>
                    <td className={cn(C, 'text-right font-semibold text-[#5A6B62]')}>
                      {formatNum(st.share)}
                      {blend > 0 ? ` / ${formatNum(blend)}` : ''}
                    </td>
                    <td className={cn(C, 'text-right font-semibold text-[#5A6B62]')}>
                      {st.auto ? `${formatNum(r3(st.ffa))}%` : '\u2014'}
                    </td>
                    <td className={cn(C, 'doc-ref text-[11.5px] font-semibold text-[#5A6B62]')}>
                      100 − {st.auto ? `${formatNum(r3(st.ffa))} \u2212 ` : ''}
                      {formatNum(deadLoss)} = {formatNum(r3(st.yieldPct))}
                    </td>
                    <td className={cn(C, 'doc-ref text-[11.5px] font-bold text-[#0A1F17]')}>
                      100 ÷ {formatNum(r3(st.yieldPct))} = {formatNum(r3(st.mult))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Step>

          <Step n={3} title="Each share at its own rate, added up">
            <table className="w-full">
              <thead className="bg-[#F7FAF6]">
                <tr>
                  <th className={cn(H, 'text-left')}>Input</th>
                  <th className={cn(H, 'text-left')}>Share × its multiplier</th>
                  <th className={cn(H, 'text-right')}>Contributes</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((st, k) => (
                  <tr key={k} className="border-t border-t-[#EAF0E9]">
                    <td className={cn(C, 'font-bold text-[#0A1F17]')}>{nameOf(st.it)}</td>
                    <td className={cn(C, 'doc-ref text-[11.5px] font-semibold text-[#5A6B62]')}>
                      {formatNum(st.share)} × {formatNum(r3(st.mult))}
                    </td>
                    <td className={cn(C, 'doc-ref text-right text-[12.5px] font-bold text-[#0A1F17]')}>
                      {formatNum(r3(st.contributes))}%
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-t-[#DCE7DB] bg-[#EFF5EC]">
                  <td className={cn(C, 'text-[10.5px] font-extrabold uppercase tracking-[.09em] text-[#0A1F17]')} colSpan={2}>
                    TOR — the oil needed per 100 of {outputName || 'output'}
                  </td>
                  <td className={cn(C, 'doc-ref text-right text-[13.5px] font-bold text-[#0B6B45]')}>
                    {formatNum(r3(tor))}%
                  </td>
                </tr>
              </tbody>
            </table>
          </Step>

          <Step n={4} title="And how a batch reads it">
            <div className="px-3.5 py-3">
              {/* Written as formulae on purpose. The figures for THIS batch are
                  already on the row and in Draws from stock; repeating them
                  here would make the window a second answer to check rather
                  than the working behind the first. */}
              <div className="doc-ref text-[12px] font-bold leading-[1.9] text-[#0A1F17]">
                <div>
                  each input drawn <span className="text-[#8CA396]">=</span> batch quantity × its contribution ÷ 100
                </div>
                {steps.some((st) => st.auto && Number(st.it.byproduct_product_id) > 0) && (
                  <div>
                    fatty acid recovered <span className="text-[#8CA396]">=</span> that input&rsquo;s draw × its FFA ÷ 100
                  </div>
                )}
                {deadLoss > 0.0005 && (
                  <div>
                    dead loss <span className="text-[#8CA396]">=</span> total drawn in × {formatNum(deadLoss)} ÷ 100
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] font-semibold leading-[1.5] text-[#5A6B62] [text-wrap:pretty]">
                The quantities these come to for the batch you are entering are on the row itself, under Draws from
                stock. PP is settled separately and is not part of this working.
              </p>
            </div>
          </Step>
        </div>

        <div className="flex flex-none justify-end border-t border-t-[#E4ECE3] bg-white px-[22px] py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-[4px] border border-[#C3D2C6] bg-white px-[18px] text-[12.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

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
  // '' is everything. The register holds two kinds of entry that look alike on
  // a row and mean opposite things about stock, so being able to see one
  // without the other is the whole point of naming them in a column.
  const [typeFilter, setTypeFilter] = useState<'' | 'batch' | 'recirculation'>('')
  // WHO DID WHAT TO A RUN, AND WHEN — the activity trail for one entry, behind
  // its ⋮. Above the phone fork below, like every hook here.
  const hist = useRecordHistory()
  const openHistory = (row: Row): void =>
    hist.open({
      activity: { entity: 'Production', id: Number(row.id) },
      kicker: String(row.kind || 'batch') === 'recirculation' ? 'Recirculation' : 'Production run',
      title: `${String(row.product_name || 'Run')} · ${formatDate(row.prod_date)}`,
      subtitle: [
        row._no ? `#${String(row._no)}` : '',
        row.formulation_name ? String(row.formulation_name) : row.custom_items_json ? 'Mix for this batch' : '',
        `${formatNum(Number(row.qty) || 0)} ${String(row.uom || 'MT')}`
      ]
        .filter(Boolean)
        .join(' · ')
    })
  // THE PERIOD THE REGISTER SHOWS. Alt+F2 sets it from anywhere — for every
  // page, or for this one — and the header's period chip sets it here. Empty
  // is every date, which is where the page opens until a period is chosen.
  const globalRange = useGlobalDateRange()
  const [dateFrom, setDateFrom] = useState(() => (globalRangeAppliesTo(globalRange, 'production') ? globalRange.from : ''))
  const [dateTo, setDateTo] = useState(() => (globalRangeAppliesTo(globalRange, 'production') ? globalRange.to : ''))
  useEffect(() => {
    if (!globalRangeAppliesTo(globalRange, 'production')) return
    setDateFrom(globalRange.from)
    setDateTo(globalRange.to)
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps
  // Oil run back through the plant to keep it turning. Its own small dialog
  // rather than a row on the batch sheet: it shares only the date and the
  // product with a batch, and everything the sheet does around those — the
  // recipe, the stock draw, the shortfall warning — has no meaning here.
  const [recircOpen, setRecircOpen] = useState(false)
  // Writing a heel out of a vessel: which product, which vessel, how much and
  // — required — why.
  const [deadOpen, setDeadOpen] = useState(false)
  const [dead, setDead] = useState<Row>({
    // 'writeoff' — the oil is gone. 'move' — it is still oil, just not this
    // oil: a shea heel that will never finish as RPO is often good feedstock
    // for something else, and saying so used to mean writing it off here and
    // re-counting it there, two corrections with nothing joining them.
    mode: 'writeoff',
    category: '',
    product_id: '',
    stage_id: '',
    qty: '',
    note: '',
    to_category: '',
    to_product_id: '',
    to_stage_id: ''
  })
  const [deadVessels, setDeadVessels] = useState<Row[]>([])
  // Where a moved heel can land. Empty vessels are kept — an empty one is the
  // commonest destination — so this is a different list from the one above.
  const [deadReceivers, setDeadReceivers] = useState<Row[]>([])
  const [deadLog, setDeadLog] = useState<Row[]>([])
  const [deadSaving, setDeadSaving] = useState(false)
  // The vessels standing for whichever product is picked, and what has already
  // been written off it.
  useEffect(() => {
    const pid = Number(dead.product_id) || 0
    if (!deadOpen || !pid) {
      setDeadVessels([])
      setDeadLog([])
      return
    }
    let alive = true
    void Promise.all([
      window.api.stockOpening.ppVessels(pid).catch(() => [] as Row[]),
      window.api.stockOpening.ppWriteoffs(pid).catch(() => [] as Row[])
    ]).then(([v, w]) => {
      if (!alive) return
      setDeadVessels(v)
      setDeadLog(w)
    })
    return () => {
      alive = false
    }
  }, [deadOpen, dead.product_id])
  useEffect(() => {
    const pid = Number(dead.to_product_id) || 0
    if (!deadOpen || dead.mode !== 'move' || !pid) {
      setDeadReceivers([])
      return
    }
    let alive = true
    void window.api.stockOpening
      .ppReceivers(pid)
      .catch(() => [] as Row[])
      .then((v) => alive && setDeadReceivers(v))
    return () => {
      alive = false
    }
  }, [deadOpen, dead.mode, dead.to_product_id])
  const isMobile = useIsMobile()
  // Which row has its working open, by index — not a copy of the row, because
  // the sheet is still being edited underneath and the window has to show what
  // is typed now rather than what was typed when it opened.
  const [mathRow, setMathRow] = useState<number | null>(null)
  const [recirc, setRecirc] = useState<Row>({ prod_date: todayISO(), product_id: '', qty: '', note: '' })
  const [recircSaving, setRecircSaving] = useState(false)
  // What the entry will read as, and what is still missing — both shown on
  // the form rather than discovered after pressing Record.
  const ledgerPair = (() => {
    const q = Number(recirc.qty) || 0
    return q > 0 ? `+${formatNum(q)} −${formatNum(q)}` : '+N −N'
  })()
  const recircMissing = !recirc.product_id
    ? 'the oil'
    : !(Number(recirc.qty) > 0)
      ? 'the quantity'
      : ''
  // No company filter: a batch belongs to the plant floor, and the register is
  // the factory's. Which books it was costed into is not a way anyone wants to
  // read a production log.
  const visible = rows.filter(
    (r) =>
      (!dateFrom || String(r.prod_date || '').slice(0, 10) >= dateFrom) &&
      (!dateTo || String(r.prod_date || '').slice(0, 10) <= dateTo) &&
      (!typeFilter || String(r.kind || 'batch') === typeFilter) &&
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
  const anyFilter = !!(prodFilter || recipeFilter || typeFilter)
  // What the register currently adds up to.
  //
  // Off `visible`, which is the filtered set — NOT paged.pageRows. A total
  // that only counted the page on screen would change when you turned to page
  // two, which is the one thing a total must never do.
  //
  // Grouped by unit rather than summed flat. This page can only produce MT
  // today (outputs excludes PCS, and every non-PCS product is MT), so in
  // practice it renders as one figure — but the rows carry their own uom, and
  // adding tonnes to tins because a historical row disagreed is not a mistake
  // worth leaving open.
  const totals = useMemo(() => {
    const byUom = new Map<string, number>()
    const days = new Set<string>()
    let recirc = 0
    // The TONNAGE recirculated, not just how many entries there were. The day
    // bands add every row they hold, so without this the bands and the grand
    // total disagreed by exactly this figure and nothing on screen said why.
    const recircByUom = new Map<string, number>()
    for (const r of visible) {
      // A recirculation made nothing — the same oil went in and came back
      // out — so it is counted BESIDE the total, never inside it.
      if (String(r.kind || 'batch') === 'recirculation') {
        recirc += 1
        const ru = String(r.uom || 'MT')
        recircByUom.set(ru, (recircByUom.get(ru) || 0) + (Number(r.qty) || 0))
        days.add(String(r.prod_date).slice(0, 10))
        continue
      }
      const u = String(r.uom || 'MT')
      byUom.set(u, (byUom.get(u) || 0) + (Number(r.qty) || 0))
      days.add(String(r.prod_date).slice(0, 10))
    }
    return {
      byUom: [...byUom.entries()].sort((a, b) => b[1] - a[1]) as [string, number][],
      days: days.size,
      batches: visible.length - recirc,
      recirc,
      recircByUom: [...recircByUom.entries()].sort((a, b) => b[1] - a[1]) as [string, number][],
      // Everything on the sheet, which is what the day bands add up to.
      allByUom: (() => {
        const m = new Map(recircByUom)
        for (const [u, q] of byUom) m.set(u, (m.get(u) || 0) + q)
        return [...m.entries()].sort((a, b) => b[1] - a[1]) as [string, number][]
      })()
    }
  }, [visible])

  // Record the recirculation. Deliberately the only write on this page that
  // does not touch stock: createProduction sees kind and takes the short
  // path — no recipe, no draw, no items.
  async function saveRecirculation(): Promise<void> {
    const pid = Number(recirc.product_id)
    const qty = Number(recirc.qty)
    if (!pid) {
      toast.error('Pick the oil that was put through the machine')
      return
    }
    if (!(qty > 0)) {
      toast.error('Enter how much was recirculated')
      return
    }
    setRecircSaving(true)
    try {
      const prod = products.find((x) => Number(x.id) === pid)
      await window.api.production.create({
        kind: 'recirculation',
        prod_date: recirc.prod_date,
        product_id: pid,
        qty,
        uom: String(prod?.uom || 'MT'),
        note: recirc.note || null
      })
      toast.success('Recirculation recorded — no stock moved')
      setRecircOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRecircSaving(false)
    }
  }

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
  // EVERY DAY ON THIS PAGE, AND WHETHER THEY ARE ALL OPEN.
  //
  // Folding is per day, which is right when you are looking for one of them
  // and wrong when you want to read the lot — an eleven-day page is eleven
  // clicks either way. One control does both, and says which way it is about
  // to go rather than making that guessable from a chevron.
  //
  // BELOW openDays, and it has to stay below it. `allOpen` reads openDays
  // through a callback, which is deferred as far as the compiler is concerned
  // — but .every() runs it on the spot, so above the useState this threw
  // "Cannot access 'openDays' before initialization" and took the whole page
  // down with it. Nothing in the types can catch that; only the order can.
  const pageDays = useMemo(
    () => [...new Set(paged.pageRows.map((r) => String(r.prod_date).slice(0, 10)))],
    [paged.pageRows]
  )
  const allOpen = pageDays.length > 0 && pageDays.every((d) => openDays.has(d))
  function toggleAllDays(): void {
    setOpenDays((prev) => {
      if (allOpen) {
        // Only this page's days close — a day left open on another page was
        // opened deliberately and is none of this button's business.
        const next = new Set(prev)
        for (const d of pageDays) next.delete(d)
        return next
      }
      return new Set([...prev, ...pageDays])
    })
  }
  function toggleDay(day: string): void {
    setOpenDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }
  const [products, setProducts] = useState<Row[]>([])
  // The unit the recirculation is entered in — the oil's own, off the master.
  const recircUom = String(
    products.find((x) => String(x.id) === String(recirc.product_id))?.uom || 'MT'
  )
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

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
    const [p, pr, f, s, fac] = await Promise.all([
      window.api.production.list(),
      window.api.data.list('products'),
      window.api.formulations.list(),
      window.api.stock.list(),
      window.api.factory.active().catch(() => null)
    ])
    setFactoryName(String(fac?.name || ''))
    setRows(numberRuns(p))
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
  // WHICH WAY BATCHES ARE ENTERED HERE.
  //
  // ON (the default, and what every mill on the books does today) a batch is
  // struck on a saved recipe. OFF, the sheet asks for the mix itself — see
  // MixDrawer. Read once at mount; changing it is a Settings act, not
  // something the floor flips mid-sheet.
  const [recipeMode, setRecipeMode] = useState(true)
  useEffect(() => {
    void window.api.settings
      .get('production_formulation_mode')
      .then((v) => setRecipeMode(v !== '0'))
      .catch(() => setRecipeMode(true))
  }, [])
  // Which row's mix is open in the drawer. -1 is closed; a row index is the
  // batch being composed.
  const [mixRow, setMixRow] = useState(-1)

  const blankRun = (): Row => ({
    key: keyRef.current++,
    _mat: '',
    _cat: '',
    product_id: '',
    formulation_id: null,
    qty: '',
    items: [],
    // Set once a mix has been composed for this row: the same `items` shape,
    // but belonging to the batch rather than to a recipe in the master.
    custom: false,
    // Its number within the day. Suggested while _noAuto holds; typing in the
    // box makes it the desk's own, and the sheet then leaves it alone.
    day_no: '',
    _noAuto: true
  })

  function patchRun(i: number, patch: Row): void {
    setRuns((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  // A product can have more than one formulation; the newest is the default and
  // the picker only appears once there is a real choice.
  async function chooseProduct(i: number, v: string): Promise<void> {
    // With the master switched off there is no recipe to find — and a mix
    // written for the product that WAS on this row must not survive the
    // change, or a batch of one thing gets booked on the recipe for another.
    if (!recipeMode) {
      patchRun(i, { product_id: v, formulation_id: null, items: [], custom: false })
      return
    }
    const matches = recipesFor(v)
    const fid = matches.length ? Number(matches[0].id) : null
    patchRun(i, { product_id: v, formulation_id: fid, items: [], custom: false })
    if (fid) {
      const items = await window.api.formulations.items(fid)
      patchRun(i, { items })
    }
  }

  async function chooseRecipe(i: number, fid: number): Promise<void> {
    // `custom: false` is the whole point of this line: a recipe chosen after a
    // mix was written replaces it, and leaving the flag set would book the mix
    // while the row showed the recipe.
    patchRun(i, { formulation_id: fid, items: [], custom: false })
    const items = await window.api.formulations.items(fid)
    patchRun(i, { items })
  }

  // Called by both openers once their state is in place — anything typed
  // after this counts as a change.
  function markSheetClean(date: string, list: Row[]): void {
    baselineRef.current = JSON.stringify({
      d: date,
      r: list.map((r) => [String(r.product_id ?? ''), String(r.formulation_id ?? ''), String(r.qty ?? ''), String(r.day_no ?? '')])
    })
  }

  // The next free number on a day: one past the highest the register already
  // shows for it (numbered or by entry order), leaving out the run being edited.
  const nextNoFor = (day: string, exceptId?: number | null): number =>
    rows
      .filter((r) => String(r.prod_date || '').slice(0, 10) === day && Number(r.id) !== Number(exceptId || 0))
      .reduce((m, r) => Math.max(m, Number(r._no) || 0), 0) + 1

  // Suggested numbers follow the sheet: the day it is for, and the rows on it.
  // A number the desk typed is kept and the suggestions count on past it.
  const typedNos = runs.map((r) => (r._noAuto ? '' : String(r.day_no ?? ''))).join('|')
  useEffect(() => {
    if (!building || editingId) return
    setRuns((prev) => {
      let next = nextNoFor(sheetDate)
      let changed = false
      const out = prev.map((r) => {
        if (!r._noAuto) {
          next = Math.max(next, (Number(r.day_no) || 0) + 1)
          return r
        }
        const want = String(next++)
        if (String(r.day_no) === want) return r
        changed = true
        return { ...r, day_no: want }
      })
      return changed ? out : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, editingId, sheetDate, runs.length, typedNos, rows])

  function openAdd(): void {
    setEditingId(null)
    editBaseRef.current = null
    // Numbered here rather than by the effect, so the suggestion is part of
    // the sheet as it opened and not taken for an unsaved change.
    const first = { ...blankRun(), day_no: String(nextNoFor(todayISO())) }
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
    // A batch booked on its own mix carries it; that is what an edit re-opens
    // and re-expands, exactly as a saved recipe's pinned version would be.
    let own: Row[] = []
    try {
      const raw = JSON.parse(String(row.custom_items_json || 'null'))
      if (Array.isArray(raw)) own = raw as Row[]
    } catch {
      own = []
    }
    const items = own.length ? own : fid ? await window.api.formulations.items(fid) : []
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
      formulation_id: own.length ? null : fid,
      qty: String(row.qty ?? ''),
      items,
      custom: own.length > 0,
      // The mix's own note, without the PP line the server writes after it.
      note: mixNoteOf(row.note),
      // The number it has — or, saved before numbering, its place in the day,
      // which the save then keeps.
      day_no: String(row._no ?? ''),
      _noAuto: false
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

  // Every auto-calculated input any run on the sheet currently names — what
  // PP to fetch a balance for. Recomputed as items load in, one recipe at a
  // time, per row.
  const ppInputIds = useMemo(() => {
    const ids = new Set<number>()
    for (const r of runs) {
      // THE PRODUCT BEING MADE, as well as what the recipe consumes.
      //
      // This collected inputs only, which is right for PP used as an input
      // substitute — shea in a vessel saving shea from the yard. It misses the
      // commoner case entirely: the vessels holding the thing being MADE. RPO
      // part-way through the plant is RPO, and its own balances were never
      // fetched, so the sheet drew the full recipe against oil it already had.
      if (Number(r.product_id) > 0) ids.add(Number(r.product_id))
      const items: Row[] = Array.isArray(r.items) ? r.items : []
      for (const it of items) {
        if (String(it.kind || 'input') === 'input' && it.auto_calc) ids.add(Number(it.product_id))
      }
    }
    return Array.from(ids)
      .filter((x) => x > 0)
      .sort((a, b) => a - b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(runs.map((r) => (Array.isArray(r.items) ? r.items : []).map((it: Row) => it.product_id))),
    JSON.stringify(runs.map((r) => r.product_id))
  ])

  // Both PP buckets, standing right now, for every input the sheet might draw
  // on — the same figures createProduction/updateProduction actually draw
  // against. Editing a run that already took some off PP gives that back
  // here first, exactly as asAtStock gives back the run's own Raw
  // consumption above, so the preview shows what a SAVE would do, not what
  // this run already did last time.
  const [ppPools, setPpPools] = useState<{ without: Record<number, number>; with: Record<number, number> } | null>(
    null
  )
  useEffect(() => {
    if (!building) {
      setPpPools(null)
      return
    }
    if (!ppInputIds.length) {
      setPpPools({ without: {}, with: {} })
      return
    }
    let alive = true
    void (async () => {
      try {
        // Against the sheet's own date: a batch dated before the PP count in
        // force draws nothing from it, and the preview must say the same.
        const totals = await window.api.stockOpening.ppFreeTotals(ppInputIds, undefined, sheetDate || undefined)
        const without: Record<number, number> = {}
        const withFfa: Record<number, number> = {}
        for (const pid of ppInputIds) {
          without[pid] = Number(totals[pid]?.without) || 0
          withFfa[pid] = Number(totals[pid]?.with) || 0
        }
        if (editingId) {
          const draws = await window.api.production.ppDraws(editingId).catch(() => [])
          for (const d of draws) {
            if (d.ffa === 'without') without[d.product_id] = (without[d.product_id] || 0) + Number(d.qty)
            else if (d.ffa === 'with') withFfa[d.product_id] = (withFfa[d.product_id] || 0) + Number(d.qty)
          }
        }
        if (alive) setPpPools({ without, with: withFfa })
      } catch {
        if (alive) setPpPools({ without: {}, with: {} })
      }
    })()
    return () => {
      alive = false
    }
  }, [building, editingId, ppInputIds, sheetDate])

  // What the whole sheet does to stock, walked IN ORDER so a batch can be fed
  // by one above it. Only 'input' lines consume; 'output' lines (recovered
  // fatty acid) add back, and 'loss' lines are simply gone.
  const projection = ((): {
    perRun: { consumes: Row[]; produces: Row[]; heldPp?: number }[]
    net: Row[]
    short: Row[]
  } => {
    const bal: Record<number, number> = { ...(asAtStock ?? stock) }
    // WHAT THE PP STANDS FOR, AS AN ADJUSTMENT.
    //
    // Borrowed from the Book Register's Adjusted column, which sits beside the
    // opening rather than inside it: a restatement of a figure, not a movement
    // of its own. Here it says what oil the vessel draw IS — the formulation's
    // shea, RPS and fatty oil on the plus side, the product's own PP on the
    // minus — so the column always nets to zero. Nothing in it touches a
    // balance; `bal` never sees it.
    const adj: Record<number, number> = {}
    // The other side of the same pair: the finished oil the vessel gave back.
    // It is no more a real production than the draw was a real consumption —
    // the oil was already inside the product's stock figure, standing in a
    // vessel — so it belongs in the adjustment beside the minus, not on its
    // own as though the plant had made something new.
    const adjBack: Record<number, number> = {}
    const perRun: { consumes: Row[]; produces: Row[]; heldPp?: number }[] = []
    const touched = new Set<number>()
    // Depleted as the sheet's runs are walked, top to bottom — exactly like
    // `bal` above, and for the same reason: a batch further down the sheet
    // sees the PP one above it already drew, not the balance as it stood
    // when the sheet opened. Without-FFA is preferred, oldest vessel first,
    // then With-FFA, then Raw — see stockopenings' drawPp for why.
    const ppWithout: Record<number, number> = { ...(ppPools?.without ?? {}) }
    const ppWith: Record<number, number> = { ...(ppPools?.with ?? {}) }
    for (const r of runs) {
      const q = Number(r.qty) || 0
      const items: Row[] = Array.isArray(r.items) ? r.items : []
      const consumes: Row[] = []
      const produces: Row[] = []
      // expandRecipeWithPp, not the raw percentages.
      //
      // This used to be `(q * it.qty) / 100`, which ignored the TOR multiplier,
      // the recipe's dead loss, and the fatty acid an auto-calculated input
      // recovers. A 100 MT batch on a 106.952% recipe previewed as drawing
      // exactly 100 of CPO and recovering nothing, then posted 106.952 and a
      // fatty-acid credit. Same function as the main process now, so the sheet
      // shows what the save will actually write — PP included, once ppPools
      // has loaded; before that it runs with an empty pool, which is the same
      // arithmetic expandRecipe always gave.
      const nameOf = (pid: number): string =>
        String(items.find((it) => Number(it.product_id) === pid)?.product_name ?? '') ||
        String(products.find((pp) => Number(pp.id) === pid)?.name ?? `#${pid}`)
      const freeByProduct: Record<number, number> = {}
      for (const it of items) {
        if (String(it.kind || 'input') === 'input' && it.auto_calc) {
          freeByProduct[Number(it.product_id)] = ppWithout[Number(it.product_id)] || 0
        }
      }
      // THE PRODUCT'S OWN PP FIRST.
      //
      // PP is part of the product's own stock — RPO opening at 75.15 is 22.15
      // in tanks plus 53 standing in vessels — so finishing oil that is
      // already in that figure makes nothing new. expandBatchWithOutputPp
      // takes what the vessels can supply, gives the recipe only what is left,
      // and returns the consuming half of the pair as an input line against
      // the product itself. The projection then nets to zero on its own,
      // because it is reading the very lines the save will write.
      const outPidForPp = Number(r.product_id) || 0
      // With-FFA vessel oil waits for its formulation — the server's
      // expandRecipeForBatch holds it back, so the preview does too, and says
      // how much is waiting.
      const heldPp = outPidForPp ? ppWith[outPidForPp] || 0 : 0
      const ownPools = outPidForPp ? { without: ppWithout[outPidForPp] || 0, with: 0 } : {}
      const { lines, draws, plan } = expandBatchWithOutputPp(items, q, ownPools, freeByProduct, outPidForPp)
      // WHAT THE VESSEL OIL STANDS FOR.
      //
      // A batch supplied out of the product's own PP draws none of the
      // formulation's components — the vessel already holds them, blended —
      // so their rows sat at a bare 0 and the recipe looked ignored. It was
      // not: the PP was drawn at the recipe's own TOR, and this is the split
      // of that draw, the shea, RPS and fatty oil the vessel oil IS. Shown,
      // never moved: the stock came out when the PP was made, and taking it a
      // second time would be counting the same oil twice.
      const viaPp: Record<number, number> = {}
      {
        // Read off the batch's OWN lines rather than expanded a second time,
        // so the sheet cannot show one split and the save write another.
        for (const l of lines) {
          if (l.kind !== 'pp_equiv') continue
          const pid = Number(l.product_id)
          const qty = Number(l.qty) || 0
          viaPp[pid] = (viaPp[pid] || 0) + qty
          adj[pid] = (adj[pid] || 0) + qty
          touched.add(pid)
        }
        // The other half of the restatement: the vessel oil those components
        // are standing in for. The two cancel exactly — the same oil, said
        // two ways.
        if (outPidForPp && plan.ppWithUsed > 0.0005) {
          adj[outPidForPp] = (adj[outPidForPp] || 0) - plan.ppWithUsed
          touched.add(outPidForPp)
        }
      }
      // And what came back out of the vessel as finished oil — both the
      // one-for-one W/O-FFA draw and whatever the with-FFA oil yielded.
      if (outPidForPp) {
        const back = plan.fromPpFree + plan.finishedFromWith
        if (back > 0.0005) {
          adjBack[outPidForPp] = (adjBack[outPidForPp] || 0) + back
          touched.add(outPidForPp)
        }
      }
      if (outPidForPp) {
        ppWithout[outPidForPp] = Math.max(0, (ppWithout[outPidForPp] || 0) - plan.fromPpFree)
        ppWith[outPidForPp] = Math.max(0, (ppWith[outPidForPp] || 0) - plan.ppWithUsed)
      }
      for (const line of lines) {
        const pid = Number(line.product_id)
        if (!pid) continue
        const amt = Number(line.qty) || 0
        if (line.kind === 'input') {
          const src = items.find((it) => Number(it.product_id) === pid && String(it.kind) === 'input')
          consumes.push({
            product_id: pid,
            name: nameOf(pid),
            pct: Number(src?.qty) || 0,
            amt,
            // What this component would have been, had the oil not already
            // been standing in the vessel. Display only — see viaPp above.
            via_pp: pid === Number(r.product_id) ? 0 : viaPp[pid] || 0,
            // The product consuming itself is not a recipe component — it is
            // the oil coming out of its own vessels, and saying so stops it
            // reading as a strange new ingredient.
            fromOwnPp: pid === Number(r.product_id),
            // WHICH KIND of PP it came out of. The two behave differently and
            // the row has to be able to say which, by name and by figure:
            // W/O-FFA oil is adjusted straight back and costs the balance
            // nothing, while oil still carrying its FFA goes through the
            // recipe on the way and the balance falls by what it sheds.
            ownPpFree: pid === Number(r.product_id) ? plan.fromPpFree : 0,
            ownPpWith: pid === Number(r.product_id) ? plan.ppWithUsed : 0
          })
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
      // Where each input's draw actually came from — PP before Raw, Without
      // before With, in the order drawPpForBatch takes it for real. Every
      // draw is checked against With-FFA PP even where it was not auto-calc
      // and drew no Without-FFA free share, matching the server exactly.
      for (const d of draws) {
        const pid = Number(d.product_id)
        const cc = consumes.find((x) => x.product_id === pid)
        if (!cc) continue
        const fromWithFfa = Math.min(ppWith[pid] || 0, d.fromFfa)
        const fromRaw = Math.max(0, d.fromFfa - fromWithFfa)
        cc.pp = { free: d.fromFree, withFfa: fromWithFfa, raw: fromRaw }
        ppWithout[pid] = Math.max(0, (ppWithout[pid] || 0) - d.fromFree)
        ppWith[pid] = Math.max(0, (ppWith[pid] || 0) - fromWithFfa)
      }
      const outPid = Number(r.product_id)
      if (outPid && q > 0) {
        produces.push({ product_id: outPid, name: products.find((p) => Number(p.id) === outPid)?.name, amt: q })
        bal[outPid] = (bal[outPid] ?? 0) + q
        touched.add(outPid)
      }
      perRun.push({ consumes, produces, heldPp })
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
      after: bal[pid] ?? 0,
      adj: adj[pid] ?? 0,
      adj_back: adjBack[pid] ?? 0
    }))
    net.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return { perRun, net, short: net.filter((x) => x.after < -1e-9) }
  })()

  // Nothing to restate on an ordinary sheet, so the Adj. column is not there
  // at all rather than a row of dashes on every batch that never touched PP.
  const anyAdj = projection.net.some(
    (x) => Math.abs(Number(x.adj) || 0) > 0.0005 || Math.abs(Number(x.adj_back) || 0) > 0.0005
  )

  // ------------------------------------------------------- unsaved changes
  //
  // What the sheet looked like when it opened. Comparing against a snapshot
  // rather than "has anything been typed" is what makes this work for an
  // EDIT, which opens already filled in — that is not a change yet.
  const baselineRef = useRef('')
  const sheetShape = JSON.stringify({
    d: sheetDate,
    r: runs.map((r) => [String(r.product_id ?? ''), String(r.formulation_id ?? ''), String(r.qty ?? ''), String(r.day_no ?? '')])
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
          formulation_id: r.custom ? null : r.formulation_id || null,
          // Sent only when the batch is on its own mix. The server reads these
          // as the recipe and skips every lookup — see customMixOf.
          custom_items: r.custom ? r.items : undefined,
          // Every batch carries its remarks — a saved recipe's as much as a
          // one-off mix's.
          note: String(r.note || ''),
          day_no: Number(r.day_no) || null
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
            formulation_id: r.custom ? null : r.formulation_id || null,
            custom_items: r.custom ? r.items : undefined,
            note: String(r.note || ''),
            day_no: Number(r.day_no) || null
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


  // Phone. Below the entry sheet, so a day's batches half-entered are not
  // thrown away because the window was narrowed mid-entry.
  if (__WEB__ && isMobile && !building) return <ProductionMobile />

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
                ? 'The recipe it was run on is re-applied from the quantity you set'
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
                    ? 'The recipe it was run on is re-applied from the quantity you set'
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
                  {(() => {
                    // Already used that day — by a saved run, or by another
                    // row on this sheet. Said, not refused: renumbering two
                    // runs passes through a moment where both share one.
                    const no = Number(r.day_no) || 0
                    const clash = no
                      ? rows.find(
                          (x) =>
                            String(x.prod_date || '').slice(0, 10) === sheetDate &&
                            Number(x.id) !== Number(editingId || 0) &&
                            Number(x._no) === no
                        ) || runs.find((x, j) => j !== i && Number(x.day_no) === no)
                      : undefined
                    return (
                      <label
                        className="relative block"
                        title={
                          clash
                            ? `#${no} is already used on ${formatDate(sheetDate)}${clash.product_name ? ` by ${String(clash.product_name)}` : ' by another row on this sheet'}`
                            : 'This run’s number for the day — suggested; change it to put the day in the order it ran'
                        }
                      >
                        <span className={cn('pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] font-bold text-muted-foreground', __WEB__ && '!text-[13px] !text-[#8CA396]')}>
                          #
                        </span>
                        <input
                          inputMode="numeric"
                          aria-label="Run number for the day"
                          value={String(r.day_no ?? '')}
                          onChange={(e) => patchRun(i, { day_no: e.target.value.replace(/[^0-9]/g, '').slice(0, 4), _noAuto: false })}
                          className={cn(
                            'h-9 w-full rounded-md border bg-background pl-5 pr-1 text-center text-[13px] font-semibold tabular-nums outline-none focus:border-primary',
                            // Doubled up to outrank the sheet's own input rules.
                            clash && '[&&]:!border-[#E3C58C] [&&]:!bg-[#FFFBF2]'
                          )}
                        />
                      </label>
                    )
                  })()}
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
                  <div className={cn(__WEB__ && 'flex items-start gap-2')}>
                    {/* The working, on demand.
                        The row states a TOR and a set of draws — the answer
                        with none of the arithmetic. This opens the arithmetic
                        for the quantity actually typed, which is what somebody
                        questioning a figure is asking for. Disabled until
                        there is a recipe AND a quantity, because there is no
                        working to show without both. */}
                    {__WEB__ && (
                      <button
                        type="button"
                        onClick={() => setMathRow(i)}
                        disabled={!r.formulation_id && !r.custom}
                        title={
                          r.formulation_id || r.custom
                            ? 'Show how this mix works out its multiplier'
                            : recipeMode
                              ? 'Pick a recipe first'
                              : 'Make the formulation first'
                        }
                        className="order-2 flex h-11 w-9 flex-none items-center justify-center rounded-[4px] border border-[#C3D2C6] bg-white text-[#33473E] transition-colors hover:bg-[#F7FAF6] disabled:cursor-not-allowed disabled:border-[#E4ECE3] disabled:text-[#C3D2C6]"
                      >
                        <Sigma className="h-[17px] w-[17px]" />
                      </button>
                    )}
                    <div className={cn(__WEB__ && 'order-1 min-w-0 flex-1')}>
                    {/* TWO WAYS TO STRIKE A BATCH, ON TWO LINES.
                        A saved recipe on the first, the mix written for this
                        batch alone on the second — and only ever one of them
                        in force: composing a mix drops the recipe, picking a
                        recipe drops the mix. A cell that leaves both looking
                        live is the one that gets a batch struck on two
                        recipes. */}
                    <div className={cn(r.custom && 'opacity-55')} title={r.custom ? 'Replaced by the mix below — pick a recipe here to go back to it' : undefined}>
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
                              {f.name || `Recipe #${f.id}`}
                              {f.subcategory_name ? ` · ${String(f.subcategory_name)}` : ''} · TOR {formatNum(f.tor)}%
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
                              {recipes[0].subcategory_name ? (
                                <span className="font-semibold text-muted-foreground"> · {String(recipes[0].subcategory_name)}</span>
                              ) : null}
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
                          <span className={cn('italic opacity-70', __WEB__ && '!text-[12px] !font-semibold !text-[#5A6B62]')}>
                            {recipeMode ? 'no recipe — nothing consumed' : 'no saved recipe for this product'}
                          </span>
                        )}
                      </div>
                    )}
                    </div>

                    {/* THE SECOND ROW. Offered whichever way the setting is
                        turned: with formulation-based production ON it is the
                        exception — this one batch ran differently — and with
                        it OFF it is the ordinary path. Once a mix is written
                        it states what it came to, which is the one recipe fact
                        the row is worth. */}
                    <button
                      type="button"
                      onClick={() => setMixRow(i)}
                      disabled={!r.product_id}
                      title={
                        !r.product_id
                          ? 'Pick a product first'
                          : r.custom
                            ? 'Change the mix written for this batch'
                            : 'Write a mix for this batch alone — it replaces the recipe above'
                      }
                      className={cn(
                        'mt-1.5 flex h-11 w-full flex-col items-start justify-center rounded-[4px] border px-3 text-left transition-colors',
                        r.custom
                          ? 'border-[#0B3D2E] bg-[#F1F5EF] hover:bg-[#EAF0E9]'
                          : 'border-dashed border-[#E3C58C] bg-[#FFFBF2] hover:bg-[#FFF4E0]',
                        !r.product_id && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      {r.custom ? (
                        <>
                          <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-[#0A1F17]">
                            <Beaker className="h-3.5 w-3.5 text-[#0B6B45]" /> Mix for this batch
                          </span>
                          <span className="mt-0.5 text-[12px] font-bold tabular-nums text-[#33473E]">
                            {(r.items as Row[]).filter((x) => String(x.kind || 'input') === 'input').length} inputs ·
                            TOR {formatNum(recipeTor(r.items as Row[]))}%
                          </span>
                        </>
                      ) : (
                        <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-[#8A5300]">
                          <Beaker className="h-4 w-4" /> Make formulation
                        </span>
                      )}
                    </button>
                    </div>
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
                              // Which stock this draw actually comes from —
                              // PP before Raw, Without-FFA before With — only
                              // shown once ppPools has loaded AND some of the
                              // draw genuinely came off PP; an ordinary batch
                              // with no PP standing looks exactly as it always
                              // has.
                              const pp = cc.pp as { free: number; withFfa: number; raw: number } | undefined
                              const fromPp = pp ? pp.free + pp.withFfa : 0
                              const parts: string[] = []
                              if (pp && pp.free > 0.0005) parts.push(`${formatNum(pp.free)} PP, no FFA`)
                              if (pp && pp.withFfa > 0.0005) parts.push(`${formatNum(pp.withFfa)} PP, with FFA`)
                              if (pp && fromPp > 0.0005 && pp.raw > 0.0005) parts.push(`${formatNum(pp.raw)} Raw`)
                              const via = Number(cc.via_pp) || 0
                              // The component is not drawn, but the recipe did
                              // apply to it — so the row shows what the vessel
                              // oil stands for rather than a bare zero, in the
                              // violet PP carries everywhere else. Not struck
                              // through: a figure with a line through it reads
                              // as cancelled, and this one is the recipe doing
                              // its work. What it is NOT is a draw, and the
                              // Adj. column below is where that is settled.
                              const standsFor = via > 0.0005 && Math.abs(Number(cc.amt) || 0) < 0.0005
                              return (
                                <div key={k} className="py-[3px]">
                                  <div className="flex items-center gap-2.5">
                                    <span
                                      className={cn(
                                        'w-[78px] shrink-0 truncate text-[11.5px] font-bold',
                                        // The product's own vessels, not a
                                        // component: violet, the colour PP
                                        // carries on the opening sheet.
                                        cc.fromOwnPp ? 'text-[#3D3179]' : 'text-[#33473E]'
                                      )}
                                      title={cc.fromOwnPp ? `${cc.name} — finished out of its own PP vessels` : cc.name}
                                    >
                                      {cc.fromOwnPp ? `${cc.name} · PP` : cc.name}
                                    </span>
                                    <span className="h-[5px] min-w-[24px] flex-1 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                                      <span
                                        className={cn('block h-full', standsFor && 'opacity-55')}
                                        style={{
                                          width: `${(((standsFor ? via : Number(cc.amt)) || 0) / maxAmt) * 100}%`,
                                          background: short ? '#B3261E' : standsFor || cc.fromOwnPp ? '#3D3179' : '#12855A'
                                        }}
                                      />
                                    </span>
                                    <span
                                      className={cn(
                                        'shrink-0 whitespace-nowrap text-[12.5px] font-bold tabular-nums',
                                        standsFor && '!text-[#3D3179]'
                                      )}
                                    >
                                      {formatNum(standsFor ? via : cc.amt)}
                                    </span>
                                  </div>
                                  {parts.length > 0 && (
                                    <div className="ml-[90px] mt-[1px] text-[10px] font-semibold text-[#5A6B62]">
                                      {parts.join(' + ')}
                                    </div>
                                  )}
                                  {standsFor && (
                                    <div className="ml-[90px] mt-[1px] text-[10px] font-semibold text-[#3D3179]">
                                      what the PP holds — an adjustment, not a draw
                                    </div>
                                  )}
                                  {/* WHY THIS DRAW DOES NOT COST WHAT IT SAYS.
                                      One line, because it is read at the moment
                                      somebody is looking at a number and asking
                                      whether the stock can stand it. The full
                                      account — that the batch adds this oil and
                                      takes it straight back, the same +/- a
                                      recirculation is — sits on the ⓘ for
                                      whoever wants it. */}
                                  {cc.fromOwnPp &&
                                    (() => {
                                      // NAMED, NOT DESCRIBED. "Already in this
                                      // stock" was true of both kinds of PP and
                                      // told you neither which one this was nor
                                      // how much. The figure and the kind are
                                      // the two things being asked.
                                      const free = Number(cc.ownPpFree) || 0
                                      const withF = Number(cc.ownPpWith) || 0
                                      const both = free > 0.0005 && withF > 0.0005
                                      return (
                                        <div className="ml-[90px] mt-[1px] flex items-center gap-1 text-[10px] font-bold text-[#3D3179]">
                                          <RefreshCw className="h-[11px] w-[11px] shrink-0" />
                                          <span>
                                            {both ? (
                                              <>
                                                Hence{' '}
                                                <span className="doc-ref tabular-nums">{formatNum(free)}</span> MT from
                                                PP without FFA is adjusted straight back, and{' '}
                                                <span className="doc-ref tabular-nums">{formatNum(withF)}</span> MT with
                                                FFA goes through the recipe
                                              </>
                                            ) : withF > 0.0005 ? (
                                              <>
                                                Hence <span className="doc-ref tabular-nums">{formatNum(withF)}</span>{' '}
                                                MT is from PP with FFA — run through the recipe, so only what it sheds
                                                comes off
                                              </>
                                            ) : (
                                              <>
                                                Hence <span className="doc-ref tabular-nums">{formatNum(free)}</span> MT
                                                is from PP without FFA — adjusted straight back, nothing off the
                                                balance
                                              </>
                                            )}
                                          </span>
                                          <InfoTip
                                            text={
                                              withF > 0.0005
                                                ? "PP is already counted inside this product's stock, standing in a vessel. The batch produces it and draws it straight back, so the two cancel. Oil still carrying its FFA goes through the recipe on the way, so the closing balance falls only by what refining sheds — nothing new is taken out of the tanks."
                                                : "PP is already counted inside this product's stock, standing in a vessel. The batch produces it and draws it straight back, so the two cancel exactly and the closing balance is unchanged — the same +/− a recirculation is. Nothing new is taken out of the tanks."
                                            }
                                          />
                                        </div>
                                      )
                                    })()}
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
                    {/* WITH-FFA OIL WAITING FOR ITS FORMULATION. Held back, not
                        drawn — said here so a batch that could have used the
                        vessels does not look as if it simply forgot them. */}
                    {Number(pr?.heldPp) > 0.0005 && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-[#FFF9EC] px-2 py-1.5 text-[10.5px] font-semibold leading-[1.45] text-[#7A4E00] [text-wrap:pretty]">
                        <Layers className="mt-px h-[12px] w-[12px] shrink-0 text-[#8A5300]" />
                        <span>
                          <b className="tabular-nums">{formatNum(Number(pr?.heldPp))}</b> MT of{' '}
                          {String(products.find((p) => Number(p.id) === Number(r.product_id))?.name || 'this oil')} PP with FFA is
                          waiting for its formulation, so this batch leaves it in the vessels. Name it on the PP breakdown in
                          Opening stock and it counts as the oils it is made of.
                        </span>
                      </div>
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
                  {/* REMARKS, on every batch — why it ran, what was odd about
                      it. Shown when the register's Type is hovered. A batch
                      on its own mix shares this with the mix's note. */}
                  <label className="flex items-center gap-2" style={{ gridColumn: '2 / -1' }}>
                    <StickyNote className="h-3.5 w-3.5 flex-none text-[#8CA396]" />
                    <textarea
                      rows={1}
                      maxLength={500}
                      aria-label="Remarks for this batch"
                      value={String(r.note ?? '')}
                      onChange={(e) => patchRun(i, { note: e.target.value })}
                      placeholder="Remarks — optional, shown when the Type is hovered"
                      className="min-h-[34px] w-full resize-none rounded-[4px] border border-[#DCE7DB] bg-[#FBFDFA] px-2.5 py-[7px] text-[12.5px] font-semibold leading-[1.4] text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#9FB3A6] focus:border-[#0B3D2E] focus:bg-white"
                    />
                  </label>
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
                    {/* The Book Register's Adjusted column, in the same role it
                        plays there: a restatement beside the figure, not a
                        movement of its own. Only present when a batch is
                        supplied from the product's own PP — an ordinary sheet
                        has nothing to restate and keeps the three columns it
                        always had. */}
                    {anyAdj && (
                      <TableHead className="text-right">
                        <span className="inline-flex items-center gap-1.5">
                          Adj. ({runs[0]?.uom || 'MT'})
                          {__WEB__ && (
                            <InfoTip text="The batch restated, not moved. The PP drawn shows minus and the finished oil it gave back shows plus — neither is real, because the oil was already inside the product's stock, standing in a vessel. Beside them, what that PP IS by the formulation: the shea, RPS and fatty oil it already holds. Those cancel the PP drawn exactly — the same oil, said two ways — and they left the tanks when the PP was made." />
                          )}
                        </span>
                      </TableHead>
                    )}
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
                        {anyAdj &&
                          (() => {
                            // Both halves of the pair, stacked: the vessel oil
                            // drawn and the finished oil it gave back. Neither
                            // is a movement — the batch produced nothing new,
                            // it finished oil the balance already held — so
                            // they sit here together rather than one of them
                            // passing for a real production.
                            const out = Number(x.adj) || 0
                            const back = Number(x.adj_back) || 0
                            const hasOut = Math.abs(out) > 0.0005
                            const hasBack = Math.abs(back) > 0.0005
                            return (
                              <TableCell
                                className={cn(
                                  'text-right tabular-nums',
                                  __WEB__ && '!whitespace-nowrap !text-[13px] !font-bold !text-[#3D3179]'
                                )}
                              >
                                {!hasOut && !hasBack ? (
                                  <span className="font-semibold text-[#B3C0B8]">—</span>
                                ) : (
                                  <div className="flex flex-col items-end gap-[2px]">
                                    {hasBack && (
                                      <span className="flex items-baseline justify-end gap-1.5">
                                        <span className="text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8478C4]">
                                          produced
                                        </span>
                                        +{formatNum(back)}
                                      </span>
                                    )}
                                    {hasOut && (
                                      <span className="flex items-baseline justify-end gap-1.5">
                                        {hasBack && (
                                          <span className="text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8478C4]">
                                            from PP
                                          </span>
                                        )}
                                        {out > 0 ? '+' : ''}
                                        {formatNum(out)}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </TableCell>
                            )
                          })()}
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
                  {/* THE SHEET'S NET EFFECT ON STOCK — every draw and every
                      return added together. What goes in either comes back out
                      as the product and its by-products or it is lost, so on a
                      sheet in one unit this is the batch's loss: −1.147 on a run
                      that burnt 1.147 MT. Only the Effect column is added — the
                      stock figures are of different products and have no total. */}
                  {projection.net.length > 1 &&
                    (() => {
                      const net = Math.round(projection.net.reduce((t, x) => t + (Number(x.after) - Number(x.before)), 0) * 1000) / 1000
                      return (
                        <TableRow
                          className={cn(
                            'bg-muted/40 font-semibold hover:bg-muted/40',
                            __WEB__ && '!border-t !border-t-[#BFE3CB] !border-l-[3px] !border-l-transparent !bg-[#F1F9F3] hover:!bg-[#F1F9F3] [&>td]:!py-2.5'
                          )}
                        >
                          <TableCell className={cn(__WEB__ && '!text-[12px] !font-extrabold !uppercase !tracking-[.08em] !text-[#0B6B45]')}>
                            <span className="inline-flex items-center gap-1.5">
                              Total
                              {__WEB__ && (
                                <InfoTip text="Every draw and every return on this sheet added together. What goes in comes back out as the product and its by-products, or it is lost — so in one unit this is the sheet's loss." />
                              )}
                            </span>
                          </TableCell>
                          <TableCell />
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              net < 0 ? 'text-red-700' : 'text-emerald-700',
                              __WEB__ && '!whitespace-nowrap !text-[14px] !font-extrabold',
                              __WEB__ && (net < 0 ? '!text-[#B3261E]' : '!text-[#0B6B45]')
                            )}
                          >
                            {net > 0 ? '+' : ''}
                            {formatNum(net)}
                          </TableCell>
                          {anyAdj && <TableCell />}
                          <TableCell />
                        </TableRow>
                      )
                    })()}
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

      {/* The recipe's own arithmetic for the row it was opened from. Read out
          of `runs` live, so editing the quantity behind it and reopening
          always shows the sheet as it stands. */}
      {/* The mix for one batch. Mounted against the LIVE row, so the
          quantity typed on the sheet is what the preview expands. */}
      <MixDrawer
        open={mixRow >= 0 && !!runs[mixRow]}
        onClose={() => setMixRow(-1)}
        products={products}
        stock={stock}
        ppWithout={ppPools?.without || {}}
        ppWith={ppPools?.with || {}}
        outputProductId={Number(runs[mixRow]?.product_id) || 0}
        items={mixRow >= 0 && Array.isArray(runs[mixRow]?.items) ? (runs[mixRow].items as Row[]) : []}
        outputName={String(
          products.find((pp) => String(pp.id) === String(runs[mixRow]?.product_id))?.name || ''
        )}
        outputQty={Number(runs[mixRow]?.qty) || 0}
        uom={String(products.find((pp) => String(pp.id) === String(runs[mixRow]?.product_id))?.uom || 'MT')}
        note={String(runs[mixRow]?.note || '')}
        onApply={(lines, note) => {
          patchRun(mixRow, { items: lines, custom: true, formulation_id: null, note: note || '' })
          setMixRow(-1)
        }}
      />
      {mathRow != null && runs[mathRow] && (
        <RecipeMathDialog
          open
          onClose={() => setMathRow(null)}
          recipe={
            formulations.find((f) => Number(f.id) === Number(runs[mathRow]?.formulation_id)) ||
            (runs[mathRow]?.custom ? { id: 0, name: 'Mix for this batch' } : null)
          }
          items={Array.isArray(runs[mathRow]?.items) ? (runs[mathRow].items as Row[]) : []}
          outputName={String(
            products.find((pp) => Number(pp.id) === Number(runs[mathRow]?.product_id))?.name || ''
          )}
        />
      )}
      </>
    )
  }

  return (
    <>
      <RecordHistory target={hist.target} onClose={hist.close} />
      <PageHeader
        // No company picker: a batch is run on the plant floor and its output
        // lands in one set of tanks, whichever books happen to be selected.
        // Offering the choice there implied the run was filed under whichever
        // company was showing, which is not what the page records.
        factoryScoped
        title="Production"
        subtitle={factoryName ? `Daily production runs — ${factoryName}` : 'Daily production runs'}
        hint="Every batch run at this plant, whichever company booked it — production is work on the plant floor, and its output lands in one set of tanks. Recording a run consumes the formula's input products from stock and adds the produced output. The formula must total 100%."
        actions={
          // `contents`: each control wraps on its own in the header row, so
          // the bell stays beside Record production instead of on a line alone.
          <div className="contents">
            <PeriodChip
              from={dateFrom}
              to={dateTo}
              onChange={(f, t2) => {
                setDateFrom(f)
                setDateTo(t2)
              }}
            />
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
                  setTypeFilter('')
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
                { header: 'Run no.', key: 'day_no', align: 'right', value: (r) => Number(r._no) || '' },
                // Without this a recirculation exports as a 20 MT production
                // run, which is the one thing it is not.
                { header: 'Entry', key: 'kind', value: (r) => (String(r.kind || 'batch') === 'recirculation' ? 'Recirculation' : 'Production') },
                // The PLANT, not the books. A run belongs to the floor it was
                // run on; which company happened to be selected when it was
                // recorded says nothing about the batch.
                { header: 'Plant', key: 'plant', value: () => factoryName || '' },
                { header: 'Product', key: 'product_name', value: (r) => r.product_name || '' },
                { header: 'Category', key: 'product_category', value: (r) => CAT_LABEL[r.product_category] ?? r.product_category ?? '' },
                { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
                { header: 'UOM', key: 'uom', value: (r) => r.uom || '' }
              ]}
              rows={visible}
            />
            {/* The plant does not stop when the mill does. Blue, because it
                is the one action on this page that records something which is
                NOT production — the colour says so before the label is
                read. The badge counts what is in view. */}
            <Button
              size="sm"
              variant="outline"
              className={cn('relative gap-1.5', __WEB__ && '!relative !gap-2 !border-[1.5px] !border-[#7FA8D4] !bg-[#EAF0FA] !px-3 !font-extrabold !text-[#1B4E82] hover:!bg-[#DCE8F7]')}
              onClick={() => {
                setRecirc({ prod_date: todayISO(), product_id: '', qty: '', note: '' })
                setRecircOpen(true)
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Recirculation
              {__WEB__ && totals.recirc > 0 && (
                <span className="absolute -right-2 -top-2 flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-[#1B4E82] px-1.5 text-[10.5px] font-bold tabular-nums text-white">
                  {totals.recirc}
                </span>
              )}
            </Button>
            {/* A heel that is never coming back. Violet, the colour PP
                carries everywhere else, because this acts on a vessel rather
                than on a batch. */}
            <Button
              size="sm"
              variant="outline"
              className={cn('gap-1.5', __WEB__ && '!gap-2 !border-[1.5px] !border-[#C7BCF0] !bg-[#F1EEFB] !px-3 !font-extrabold !text-[#3D3179] hover:!bg-[#E7E1F8]')}
              onClick={() => {
                setDead({ category: '', product_id: '', stage_id: '', qty: '', note: '' })
                setDeadOpen(true)
              }}
            >
              <Layers className="h-4 w-4" />
              Write off PP
            </Button>
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
                {/* PRODUCTION OR RECIRCULATION.
                    The two are the same shape on a row and opposite in what
                    they do to stock, so the distinction earns a column rather
                    than a chip tucked beside a product name. The filter lives
                    in the header because that is the column it filters — and
                    everything downstream reads the filtered rows, so the
                    totals follow it without being told to. */}
                <TableHead className={cn(__WEB__ && '!py-1.5')}>
                  {__WEB__ ? (
                    <select
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value as '' | 'batch' | 'recirculation')}
                      title="Show only one kind of entry"
                      className={cn(
                        'h-[26px] cursor-pointer rounded-[3px] border px-1.5 text-[10px] font-extrabold uppercase tracking-[.11em] outline-none',
                        typeFilter
                          ? 'border-[#C7F03F] bg-[#0B3D2E] text-[#C7F03F]'
                          : 'border-transparent bg-transparent text-[#8FBFA8] hover:border-[#C7F03F]/40'
                      )}
                    >
                      <option value="">Type · all</option>
                      <option value="batch">Production</option>
                      <option value="recirculation">Recirculation</option>
                    </select>
                  ) : (
                    'Type'
                  )}
                </TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">
                  <span className={cn(__WEB__ && '!text-[#C7F03F]')}>Qty</span>
                </TableHead>
                <TableHead className="w-[60px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* First row in the body, so it sits directly under the header
                  and stays there whichever page you are on. */}
              {__WEB__ && !loading && visible.length > 0 && (
                <TableRow className="!border-b-[#C3D2C6] !border-t-2 !border-t-[#C7F03F] !bg-[#EFF5EC] hover:!bg-[#EFF5EC] [&>td]:!py-2.5">
                  <TableCell colSpan={4} className="!text-[11px] !font-extrabold !uppercase !tracking-[.11em] !text-[#0B3D2E]">
                    {/* The control belongs WITH the days it folds. In the page
                        header it was the sixth thing in a row of filters and
                        pickers, where nobody looking at a stack of folded
                        bands would think to reach for it. */}
                    {pageDays.length > 1 && (
                      <button
                        type="button"
                        onClick={toggleAllDays}
                        title={allOpen ? 'Fold every day on this page' : 'Open every day on this page'}
                        className="mr-2.5 inline-flex h-[26px] items-center gap-1.5 rounded-[3px] border border-[#C3D2C6] bg-white px-2.5 align-middle text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#33473E] transition-colors hover:bg-[#F7FAF6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B3D2E]"
                      >
                        {allOpen ? (
                          <ChevronsDownUp className="h-[13px] w-[13px]" />
                        ) : (
                          <ChevronsUpDown className="h-[13px] w-[13px]" />
                        )}
                        {allOpen ? 'Collapse all' : 'Expand all'}
                      </button>
                    )}
                    Total
                    <span className="ml-2 font-bold normal-case tracking-normal text-[#5A6B62]">
                      {totals.batches} batch{totals.batches === 1 ? '' : 'es'}
                      {/* What the figure is MADE of, since the figure itself is
                          now a single total. A reader who wants the produced
                          tonnage on its own filters the Type column to
                          Production and this total answers that instead. */}
                      {totals.recirc
                        ? ` + ${totals.recirc} recirculation${totals.recirc === 1 ? '' : 's'}`
                        : ''}
                      {totals.days > 1 ? ` across ${totals.days} days` : ''}
                      {/* Said out loud, because a total that silently answers a
                          narrower question than the reader thinks is worse than
                          no total at all. */}
                      {anyFilter ? ' · filtered' : ''}
                      {dateFrom || dateTo
                        ? ` · ${dateFrom ? formatDate(dateFrom) : '…'} → ${dateTo ? formatDate(dateTo) : '…'}`
                        : ''}
                    </span>
                  </TableCell>
                  {/* The figure sits on a lighter ground than the band it is
                      in — the total is what the row is FOR, and lifting it out
                      of the wash reads as a figure rather than as more of the
                      label. */}
                  <TableCell className="!bg-[#F8FCF5] !text-right !text-[13.5px] !font-bold !tabular-nums !tracking-[-0.02em] !text-[#0A1F17]">
                    {/* ONE FIGURE, and it is the total — what every day band
                        below adds up to. Splitting it into produced and all-in
                        put two numbers where the reader wanted one; what the
                        total is made of is said in words beside the label,
                        which is where an explanation belongs. */}
                    {totals.allByUom.map(([u, q]) => (
                      <span key={u} className="ml-2 whitespace-nowrap">
                        {formatNum(q)} <span className="text-[10.5px] font-semibold text-[#5A6B62]">{u}</span>
                      </span>
                    ))}
                  </TableCell>
                  <TableCell />
                </TableRow>
              )}
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className={cn('py-10 text-center text-muted-foreground', __WEB__ && '!py-12')}>
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
              ) : visible.length === 0 ? (
                // Runs exist, just none in this period or behind these filters
                // — said, with the way out, rather than a blank table.
                <TableRow>
                  <TableCell colSpan={6} className={cn('py-10 text-center text-muted-foreground', __WEB__ && '!py-12')}>
                    <span className="flex flex-col items-center gap-2">
                      <CalendarDays className="h-[28px] w-[28px] text-[#C3D2C6]" />
                      <span className="text-[13px] font-bold text-[#5A6B62]">
                        No run {dateFrom && dateFrom === dateTo ? `on ${formatDate(dateFrom)}` : dateFrom || dateTo ? `between ${dateFrom ? formatDate(dateFrom) : 'the start'} and ${dateTo ? formatDate(dateTo) : 'today'}` : 'matches these filters'}
                        {anyFilter && (dateFrom || dateTo) ? ' with these filters' : ''}.
                      </span>
                      <span className="flex items-center gap-2">
                        {(dateFrom || dateTo) && (
                          <Button size="sm" variant="outline" className="!h-8 !text-[12px] !font-extrabold" onClick={() => { setDateFrom(''); setDateTo('') }}>
                            Show every date
                          </Button>
                        )}
                        {anyFilter && (
                          <Button size="sm" variant="ghost" className="!h-8 !text-[12px] !font-extrabold" onClick={() => { setProdFilter(0); setRecipeFilter(''); setTypeFilter('') }}>
                            Clear filters
                          </Button>
                        )}
                      </span>
                    </span>
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
                          <span className="inline-flex items-center gap-1.5">
                            {dayRows.length} batch{dayRows.length === 1 ? '' : 'es'}
                            {/* A RECIRCULATION IS HIDING IN THERE.
                                It is the one entry on this register that moves
                                no stock, so it is also the one a folded day can
                                conceal completely — the band's own total does
                                not count it, and nothing else on the band says
                                it happened. A pulsing dot, in the blue this
                                page already gives recirculation, so a day worth
                                opening looks different from a day that is not. */}
                            {dayRows.some((x) => String(x.kind || 'batch') === 'recirculation') && (
                              <span
                                title={`${dayRows.filter((x) => String(x.kind || 'batch') === 'recirculation').length} recirculation on this day. It is IN the figure beside it — this band adds every entry it holds — but it moves no stock, so the Total produced row above leaves it out and states it separately.`}
                                className="inline-flex items-center gap-1"
                              >
                                <span className="relative flex h-[7px] w-[7px]">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#1B4E82] opacity-70" />
                                  <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-[#1B4E82]" />
                                </span>
                                {/* Spelled out. "RECIRC" saves six characters
                                    in a cell with room to spare and costs the
                                    reader the one word that says what it is. */}
                                <span className="!text-[10.5px] !font-extrabold !uppercase !tracking-[.06em] !text-[#1B4E82]">
                                  {(() => {
                                    const k = dayRows.filter(
                                      (x) => String(x.kind || 'batch') === 'recirculation'
                                    ).length
                                    return k > 1 ? `${k} recirculations` : 'recirculation'
                                  })()}
                                </span>
                              </span>
                            )}
                            {shut && <span className="!ml-0.5 !text-[#8FA79B]">· hidden</span>}
                          </span>
                        </TableCell>
                        <TableCell />
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
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        {/* Faint and dotted while it is only the entry order —
                            a run saved before numbering, or made by a dispatch. */}
                        <span
                          title={
                            row._noSet
                              ? `Run #${row._no} of ${formatDate(row.prod_date)}`
                              : `Not numbered — #${row._no} is its place in the day by entry order. Edit the run to give it a number.`
                          }
                          className={cn(
                            'inline-flex min-w-[2.1rem] justify-center rounded-[3px] border px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums',
                            row._noSet ? 'border-[#C3D2C6] bg-[#EAF0E9] text-[#0B3D2E]' : 'border-dashed border-[#DCE7DB] bg-transparent text-[#8CA396]'
                          )}
                        >
                          #{row._no}
                        </span>
                        {formatDate(row.prod_date)}
                      </span>
                    </TableCell>
                    <TableCell className={cn('font-medium', __WEB__ && '!text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                      {row.product_name}
                      {/* Said on the row, because a 20 MT line that moved no
                          stock is otherwise indistinguishable from a 20 MT
                          batch that moved a great deal of it. */}
                      {String(row.kind || 'batch') === 'recirculation' && (
                        <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#1B4E82]">
                          <RefreshCw className="h-3 w-3" /> Recirculation
                        </span>
                      )}
                      {!row.formulation_name && !!row.custom_items_json && (
                        <div className={cn('text-xs font-normal text-muted-foreground', __WEB__ && '!mt-0.5 !flex !flex-wrap !items-center !gap-1.5 !text-[12px] !font-bold !text-[#33473E]')}>
                          <span className="inline-flex items-center gap-1 rounded-[2px] border border-[#C3D2C6] bg-[#F1F5EF] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#33473E]">
                            <Beaker className="h-3 w-3" /> Mix for this batch
                          </span>
                          {!!mixNoteOf(row.note) && (
                            <span
                              className={cn('inline-flex min-w-0 items-start gap-1', __WEB__ && '!text-[11.5px] !font-semibold !text-[#5A6B62]')}
                              title={mixNoteOf(row.note)}
                            >
                              <StickyNote className="mt-px h-3 w-3 flex-none text-[#A8B8AE]" />
                              <span className="[overflow-wrap:anywhere]">{mixNoteOf(row.note)}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {row.formulation_name && (
                        <div className={cn('text-xs font-normal text-muted-foreground', __WEB__ && '!mt-0.5 !flex !flex-wrap !items-center !gap-1.5 !text-[12px] !font-bold !text-[#33473E]')}>
                          {row.formulation_name}
                          {/* The recipe's sub-category — Fatty Oil, Recovered
                              Oil — beside its name, since two recipes can
                              share a name and differ only in their group. */}
                          {!!String(row.subcategory_name || '').trim() && (
                            <span
                              className="inline-flex items-center rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#1B4E82]"
                              title="Sub-category of the recipe"
                            >
                              {String(row.subcategory_name)}
                            </span>
                          )}
                          {/* Only when the recipe has moved on since. A batch
                              costed on a superseded version is not wrong — it
                              is what was actually run — but two runs of "the
                              same" recipe consuming different amounts needs
                              an explanation on the row, not in someone's
                              memory. */}
                          {__WEB__ && Number(row.recipe_version) > 0 && Number(row.recipe_latest_version) > Number(row.recipe_version) ? (
                            <span
                              title={`Run on version ${row.recipe_version} of this recipe, saved ${formatDate(String(row.recipe_saved_at || '').slice(0, 10))}. The recipe has since been edited — this batch keeps what it was run on.`}
                              className="rounded-[2px] border border-[#F0D9AE] bg-[#FFFBF2] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#8A5300]"
                            >
                              v{row.recipe_version} of {row.recipe_latest_version}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    {/* Named on every row, both ways round — a register where
                        only the odd one is labelled leaves the reader deciding
                        whether the blank ones are ordinary or just unmarked. */}
                    <TableCell>
                      {String(row.kind || 'batch') === 'recirculation' ? (
                        <BatchMixHover row={row} remarks={mixNoteOf(row.note)} mix={false}>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#1B4E82]">
                            <RefreshCw className="h-3 w-3" /> Recirculation
                            {!!mixNoteOf(row.note) && <StickyNote className="h-3 w-3 text-[#1B4E82]" />}
                          </span>
                        </BatchMixHover>
                      ) : (
                        // Rest on it for the run's short formulation.
                        <BatchMixHover row={row} remarks={mixNoteOf(row.note)}>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border border-[#BFE3CB] bg-[#F4FBF6] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em] text-[#0B6B45] underline decoration-[#8FBFA8] decoration-dotted underline-offset-2">
                            Production
                            {/* A run with remarks says so, so nobody has to hover every row to find them. */}
                            {!!mixNoteOf(row.note) && <StickyNote className="h-3 w-3 text-[#0B6B45]" />}
                          </span>
                        </BatchMixHover>
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
                              { label: 'History of this run', icon: HistoryIcon, onClick: () => openHistory(row) },
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
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="History of this run" onClick={() => openHistory(row)}>
                            <HistoryIcon className="h-4 w-4" />
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
      {/* WRITE A HEEL OUT OF A VESSEL.
          Not a batch and not a loss on a recipe — oil that is simply never
          coming back, taken out of PP so no future run is offered stock that
          does not exist. The reason is required: a quantity that vanished with
          no explanation is the one an auditor always asks about. */}
      <Dialog open={deadOpen} onOpenChange={(o) => !o && setDeadOpen(false)}>
        <DialogContent
          className={cn(
            'max-w-md',
            __WEB__ &&
              '!w-[min(94vw,620px)] !max-w-none !gap-0 !overflow-hidden !rounded-[6px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!right-[22px] [&>button]:!top-[22px] [&>button]:!text-white [&>button]:!opacity-80'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#3D3179] !px-[22px] !py-[18px] !pr-16 !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#C7BCF0]">Partly processed</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-extrabold !tracking-[-0.02em] !text-white')}>
              {dead.mode === 'move' ? 'Move a heel to another oil' : 'Write off dead stock'}
            </DialogTitle>
            <p className={cn('mt-1 text-[12px] text-muted-foreground', __WEB__ && '!mt-2 !text-[11.5px] !font-semibold !leading-relaxed !text-[#C7BCF0]')}>
              {dead.mode === 'move'
                ? 'Oil that will not finish as this product but is still good feedstock for another. It leaves one oil’s PP and arrives in the other’s, unchanged — the site holds the same tonnage either way. Nothing is produced and no recipe runs.'
                : 'A heel that cannot be finished — settled sludge, a tank bottom, oil gone off. It leaves PP for good and the oil’s stock falls by it. Nothing is produced and no recipe runs.'}
            </p>
          </DialogHeader>

          <div className={cn('grid gap-3 py-2', __WEB__ && '!flex !flex-col !gap-4 !px-[22px] !py-[18px]')}>
            {/* WHICH OF THE TWO THINGS THIS IS.
                Everything below is the same until the end — pick the vessel,
                pick how much — and only the last step differs: gone, or gone
                somewhere. Asking first means the form never has to be re-read
                after the choice is made. */}
            <div className="inline-flex gap-[3px] self-start rounded-[4px] border border-[#DCE7DB] bg-[#EAF0E9] p-[3px]">
              {[
                { v: 'writeoff', label: 'Write off' },
                { v: 'move', label: 'Move to another oil' }
              ].map((o) => {
                const on = String(dead.mode || 'writeoff') === o.v
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() =>
                      setDead((p2) => ({ ...p2, mode: o.v, to_category: '', to_product_id: '', to_stage_id: '' }))
                    }
                    className={cn(
                      'flex h-9 items-center rounded-[2px] px-4 text-[12.5px] font-extrabold transition-colors',
                      on ? 'bg-[#3D3179] text-white' : 'text-[#5A6B62] hover:text-[#0A1F17]'
                    )}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>

            {/* SUB-CATEGORY FIRST, then the oil — the same order every other
                product picker on this page asks in. The full list runs to
                forty-odd names; narrowing it first is how somebody finds the
                one they mean without reading all of them. */}
            <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
              <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                Sub-category <span className="text-[#B3261E]">*</span>
              </Label>
              <Select
                value={String(dead.category || '')}
                onValueChange={(v) => setDead((p2) => ({ ...p2, category: v, product_id: '', stage_id: '', qty: '' }))}
                panelClassName={__WEB__ ? '!rounded-[4px] !border-[#C3D2C6] !normal-case' : undefined}
              >
                <SelectTrigger className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13.5px] !font-bold')}>
                  <SelectValue placeholder="Pick the sub-category" />
                </SelectTrigger>
                <SelectContent className={cn(__WEB__ && '!max-h-[180px] !p-1.5')}>
                  {[...new Set(products.map((x) => String(x.category || '')).filter(Boolean))].sort().map((c) => (
                    <SelectItem key={c} value={c} className={cn(__WEB__ && '!h-10 !text-[13px] !font-semibold')}>
                      {CAT_LABEL[c] ?? c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
              <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                Which oil <span className="text-[#B3261E]">*</span>
              </Label>
              <Select
                disabled={!dead.category}
                value={String(dead.product_id || '')}
                onValueChange={(v) => setDead((p2) => ({ ...p2, product_id: v, stage_id: '', qty: '' }))}
                panelClassName={__WEB__ ? '!rounded-[4px] !border-[#C3D2C6] !normal-case' : undefined}
              >
                <SelectTrigger className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13.5px] !font-bold')}>
                  <SelectValue placeholder={dead.category ? 'Pick the oil' : 'Pick a sub-category first'} />
                </SelectTrigger>
                <SelectContent className={cn(__WEB__ && '!max-h-[180px] !p-1.5')}>
                  {products
                    .filter((x) => !dead.category || String(x.category || '') === String(dead.category))
                    .map((x) => (
                      <SelectItem key={String(x.id)} value={String(x.id)} className={cn(__WEB__ && '!h-10 !text-[13px] !font-semibold')}>
                        {String(x.name)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* ALWAYS PRESENT, so the sheet keeps its height.
                Rendering this only after an oil was picked left the dialog two
                fields tall, with nothing under the dropdown to open into — so
                the list flipped up and covered the header. A form that changes
                height as it is filled also moves the buttons under the
                cursor. */}
            <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
                <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                  Which vessel <span className="text-[#B3261E]">*</span>
                </Label>
                {!dead.product_id ? (
                  <div className="flex min-h-[92px] items-center rounded-[4px] border border-dashed border-[#C3D2C6] bg-white px-3.5 text-[12.5px] font-semibold text-[#8FA79B]">
                    Pick the oil above and its vessels appear here.
                  </div>
                ) : deadVessels.length === 0 ? (
                  <div className="flex min-h-[92px] items-center rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 text-[12.5px] font-semibold text-[#5A6B62]">
                    Nothing is standing in PP for this oil.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {deadVessels.map((v) => {
                      const on = String(dead.stage_id) === String(v.stage_id)
                      return (
                        <button
                          key={String(v.stage_id)}
                          type="button"
                          onClick={() => setDead((p2) => ({ ...p2, stage_id: String(v.stage_id) }))}
                          className={cn(
                            'flex items-center gap-2.5 rounded-[4px] border px-3.5 py-2.5 text-left transition-colors',
                            on ? 'border-[#3D3179] bg-[#F1EEFB]' : 'border-[#C3D2C6] bg-white hover:bg-[#F7FAF6]'
                          )}
                        >
                          <span className="text-[13px] font-bold text-[#0A1F17]">{String(v.vessel)}</span>
                          <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">
                            {String(v.ffa) === 'without' ? 'no FFA' : 'with FFA'}
                          </span>
                          <span className="doc-ref ml-auto text-[13.5px] font-bold tabular-nums">
                            {formatNum(Number(v.qty) || 0)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
            </div>

            {!!dead.stage_id && (
              <>
                <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
                  <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                    Quantity to write off <span className="text-[#B3261E]">*</span>
                  </Label>
                  <div className="flex items-center gap-2.5">
                    <Input
                      type="number"
                      inputMode="decimal"
                      placeholder="0.000"
                      value={String(dead.qty ?? '')}
                      onChange={(e) => setDead((p2) => ({ ...p2, qty: e.target.value }))}
                      className={cn(__WEB__ && '!h-[46px] !flex-1 !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[14px] !font-bold')}
                    />
                    {/* Closing a vessel out is commoner than trimming it. */}
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !px-3.5 !text-[12px] !font-extrabold !text-[#3D3179]')}
                      onClick={() =>
                        setDead((p2) => ({
                          ...p2,
                          qty: String(deadVessels.find((v) => String(v.stage_id) === String(p2.stage_id))?.qty ?? '')
                        }))
                      }
                    >
                      All of it
                    </Button>
                  </div>
                </div>
                {dead.mode === 'move' && (
                  <>
                    <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
                      <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                        Into which oil <span className="text-[#B3261E]">*</span>
                      </Label>
                      <div className="grid grid-cols-2 gap-2.5">
                        <Select
                          value={String(dead.to_category || '')}
                          onValueChange={(v) =>
                            setDead((p2) => ({ ...p2, to_category: v, to_product_id: '', to_stage_id: '' }))
                          }
                          panelClassName={__WEB__ ? '!rounded-[4px] !border-[#C3D2C6] !normal-case' : undefined}
                        >
                          <SelectTrigger className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13.5px] !font-bold')}>
                            <SelectValue placeholder="Sub-category" />
                          </SelectTrigger>
                          <SelectContent className={cn(__WEB__ && '!max-h-[180px] !p-1.5')}>
                            {[...new Set(products.map((x) => String(x.category || '')).filter(Boolean))].sort().map((c) => (
                              <SelectItem key={c} value={c} className={cn(__WEB__ && '!h-10 !text-[13px] !font-semibold')}>
                                {CAT_LABEL[c] ?? c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          disabled={!dead.to_category}
                          value={String(dead.to_product_id || '')}
                          onValueChange={(v) => setDead((p2) => ({ ...p2, to_product_id: v, to_stage_id: '' }))}
                          panelClassName={__WEB__ ? '!rounded-[4px] !border-[#C3D2C6] !normal-case' : undefined}
                        >
                          <SelectTrigger className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13.5px] !font-bold')}>
                            <SelectValue placeholder={dead.to_category ? 'The oil' : 'Sub-category first'} />
                          </SelectTrigger>
                          <SelectContent className={cn(__WEB__ && '!max-h-[180px] !p-1.5')}>
                            {products
                              .filter(
                                (x) =>
                                  String(x.category || '') === String(dead.to_category) &&
                                  String(x.id) !== String(dead.product_id)
                              )
                              .map((x) => (
                                <SelectItem key={String(x.id)} value={String(x.id)} className={cn(__WEB__ && '!h-10 !text-[13px] !font-semibold')}>
                                  {String(x.name)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* WHERE IT LANDS. A vessel row carries one FFA class, so
                        one already holding the other kind is shown disabled
                        rather than left to fail on save — tipping with-FFA oil
                        into a without-FFA vessel would relabel what was
                        already standing there. */}
                    {!!dead.to_product_id && (
                      <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
                        <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                          Into which vessel <span className="text-[#B3261E]">*</span>
                        </Label>
                        {deadReceivers.length === 0 ? (
                          <div className="flex min-h-[60px] items-center rounded-[4px] border border-[#DCE7DB] bg-white px-3.5 text-[12.5px] font-semibold text-[#5A6B62]">
                            This site has no vessels set up yet.
                          </div>
                        ) : (
                          <div className="flex max-h-[176px] flex-col gap-1.5 overflow-y-auto">
                            {deadReceivers.map((v) => {
                              const srcFfa = String(
                                deadVessels.find((x) => String(x.stage_id) === String(dead.stage_id))?.ffa || ''
                              )
                              const held = Number(v.qty) || 0
                              const clash = held > 0.0005 && String(v.ffa || '') !== srcFfa
                              const on = String(dead.to_stage_id) === String(v.stage_id)
                              return (
                                <button
                                  key={String(v.stage_id)}
                                  type="button"
                                  disabled={clash}
                                  title={
                                    clash
                                      ? 'That vessel already holds oil of the other FFA class — pick an empty one, or one holding the same kind'
                                      : undefined
                                  }
                                  onClick={() => setDead((p2) => ({ ...p2, to_stage_id: String(v.stage_id) }))}
                                  className={cn(
                                    'flex items-center gap-2.5 rounded-[4px] border px-3.5 py-2.5 text-left transition-colors',
                                    clash
                                      ? 'cursor-not-allowed border-[#E4ECE3] bg-[#F7FAF6] opacity-55'
                                      : on
                                        ? 'border-[#3D3179] bg-[#F1EEFB]'
                                        : 'border-[#C3D2C6] bg-white hover:bg-[#F7FAF6]'
                                  )}
                                >
                                  <span className="text-[13px] font-bold text-[#0A1F17]">{String(v.vessel)}</span>
                                  {held > 0.0005 ? (
                                    <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">
                                      {String(v.ffa) === 'without' ? 'no FFA' : String(v.ffa) === 'with' ? 'with FFA' : 'unclassified'}
                                    </span>
                                  ) : (
                                    <span className="rounded-[2px] bg-[#E9F5EE] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">
                                      empty
                                    </span>
                                  )}
                                  <span className="doc-ref ml-auto text-[13.5px] font-bold tabular-nums text-[#5A6B62]">
                                    {held > 0.0005 ? formatNum(held) : '—'}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
                  <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                    Why{' '}
                    {dead.mode === 'move' ? (
                      <span className="font-semibold text-[#5A6B62]">(optional)</span>
                    ) : (
                      <span className="text-[#B3261E]">*</span>
                    )}
                  </Label>
                  <Input
                    placeholder={
                      dead.mode === 'move'
                        ? 'e.g. will not finish as RPO — good feedstock for the RPS line'
                        : 'e.g. settled sludge at the bottom of the vessel, not recoverable'
                    }
                    value={String(dead.note ?? '')}
                    onChange={(e) => setDead((p2) => ({ ...p2, note: e.target.value }))}
                    className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13.5px] !font-semibold')}
                  />
                </div>
              </>
            )}

            {deadLog.length > 0 && (
              <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">
                  What has left these vessels
                </div>
                <div className="max-h-[150px] overflow-y-auto">
                  {deadLog.map((w) => (
                    <div key={String(w.id)} className="border-b border-b-[#EFF3EE] px-4 py-2.5 last:border-b-0">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 text-[12px]">
                        <span className={cn('doc-ref font-bold', w.to_product_id ? 'text-[#3D3179]' : 'text-[#8C2F26]')}>
                          -{formatNum(Number(w.qty) || 0)}
                        </span>
                        <span className="font-bold text-[#33473E]">{String(w.vessel || '')}</span>
                        {/* A row carrying a destination is a move, not a loss
                            — the oil is still on site, under another name. */}
                        {!!w.to_product_id && (
                          <span className="rounded-[2px] bg-[#F1EEFB] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em] text-[#3D3179]">
                            moved to {String(w.to_product || 'another oil')}
                            {w.to_vessel ? ` · ${String(w.to_vessel)}` : ''}
                          </span>
                        )}
                        <span className="ml-auto whitespace-nowrap text-[11px] font-semibold text-[#5A6B62]">
                          {String(w.written_by_name || 'system')} · {String(w.created_at || '').slice(0, 10)}
                        </span>
                      </div>
                      <div className="mt-1 text-[11.5px] font-semibold text-[#33473E]">{String(w.note || '')}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className={cn(__WEB__ && '!flex !items-center !gap-3 !border-t !border-t-[#D6E2D6] !bg-white !px-[22px] !py-[15px] sm:!justify-start')}>
            {__WEB__ && (
              <span className="text-[12.5px] font-bold text-[#5A6B62]">
                {!dead.stage_id
                  ? !dead.category
                    ? 'Pick the sub-category.'
                    : !dead.product_id
                      ? 'Pick the oil.'
                      : 'Pick the vessel.'
                  : !(Number(dead.qty) > 0)
                    ? 'Enter a quantity.'
                    : dead.mode === 'move'
                      ? !dead.to_product_id
                        ? 'Pick the oil it is going into.'
                        : !dead.to_stage_id
                          ? 'Pick the vessel it is going into.'
                          : `${formatNum(Number(dead.qty))} moves to ${
                              products.find((x) => String(x.id) === String(dead.to_product_id))?.name || 'the other oil'
                            } — the site's total PP does not change.`
                      : !String(dead.note || '').trim()
                        ? 'Say why.'
                        : `${formatNum(Number(dead.qty))} leaves PP for good.`}
              </span>
            )}
            <div className={cn(__WEB__ && 'ml-auto flex gap-2.5')}>
              <Button variant="outline" onClick={() => setDeadOpen(false)} disabled={deadSaving}>
                Cancel
              </Button>
              <Button
                disabled={
                  deadSaving ||
                  !dead.stage_id ||
                  !(Number(dead.qty) > 0) ||
                  (dead.mode === 'move'
                    ? !dead.to_product_id || !dead.to_stage_id
                    : !String(dead.note || '').trim())
                }
                className={cn(__WEB__ && '!bg-[#3D3179] !font-extrabold !text-white hover:!bg-[#332968]')}
                onClick={async () => {
                  setDeadSaving(true)
                  try {
                    if (dead.mode === 'move') {
                      await window.api.stockOpening.movePp(
                        Number(dead.product_id),
                        Number(dead.stage_id),
                        Number(dead.qty),
                        Number(dead.to_product_id),
                        Number(dead.to_stage_id),
                        String(dead.note || '')
                      )
                      toast.success(
                        `${formatNum(Number(dead.qty))} moved to ${
                          products.find((x) => String(x.id) === String(dead.to_product_id))?.name || 'the other oil'
                        }`
                      )
                    } else {
                      await window.api.stockOpening.writeOffPp(
                        Number(dead.product_id),
                        Number(dead.stage_id),
                        Number(dead.qty),
                        String(dead.note)
                      )
                      toast.success(`${formatNum(Number(dead.qty))} written off`)
                    }
                    setDeadOpen(false)
                    await load()
                  } catch (e) {
                    toast.error(errText(e))
                  } finally {
                    setDeadSaving(false)
                  }
                }}
              >
                {deadSaving
                  ? dead.mode === 'move'
                    ? 'Moving…'
                    : 'Writing off…'
                  : dead.mode === 'move'
                    ? 'Move'
                    : 'Write off'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recirculation, to the handoff's own design.
          A dialog rather than a page: it asks three things, and the answer to
          all three is on the shift supervisor's slip. The blue band under the
          quantity is the point of the whole screen — it says what the register
          will read BEFORE the button is pressed, because "records something
          that moves no stock" is a claim worth showing rather than trusting. */}
      <Dialog open={recircOpen} onOpenChange={(o) => !o && setRecircOpen(false)}>
        <DialogContent
          className={cn(
            'max-w-md',
            __WEB__ &&
              '!w-[min(94vw,640px)] !max-w-none !gap-0 !overflow-hidden !rounded-[6px] !border-0 !bg-[#F1F5EF] !p-0 !shadow-[0_24px_60px_rgba(10,31,23,.32)] [&>button]:!right-[22px] [&>button]:!top-[22px] [&>button]:!flex [&>button]:!h-9 [&>button]:!w-9 [&>button]:!items-center [&>button]:!justify-center [&>button]:!rounded-[3px] [&>button]:!bg-white/10 [&>button]:!text-white [&>button]:!opacity-100 [&>button]:hover:!bg-white/20 [&>button>svg]:!h-5 [&>button>svg]:!w-5'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !pr-16 !text-left')}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Production</div>
            )}
            <DialogTitle className={cn(__WEB__ && '!mt-1 !text-[19px] !font-extrabold !tracking-[-0.02em] !text-white')}>
              Record a recirculation
            </DialogTitle>
            <p
              className={cn(
                'mt-1 text-[12px] text-muted-foreground',
                __WEB__ && '!mt-2 !max-w-[520px] !text-[11.5px] !font-semibold !leading-relaxed !text-[#8FBFA8]'
              )}
            >
              Oil put through the plant to keep it turning while the mill is idle. It draws no raw material and
              makes nothing — the register shows it as {ledgerPair} against the oil, and no balance moves.
            </p>
          </DialogHeader>

          <div className={cn('grid gap-3 py-2', __WEB__ && '!flex !flex-col !gap-4 !bg-[#F1F5EF] !px-[22px] !py-[18px]')}>
            {/* Date and oil share a row: one is nearly always today and the
                other is the only real choice on the form. */}
            <div className={cn('grid gap-3', __WEB__ && '!flex !flex-wrap !gap-3.5')}>
              <div className={cn('flex flex-col gap-1.5', __WEB__ && '!min-w-[180px] !flex-1 !gap-0')}>
                <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>Date</Label>
                <DatePicker
                  min={minDate}
                  max={todayISO()}
                  value={String(recirc.prod_date || '')}
                  onChange={(v) => setRecirc((p2) => ({ ...p2, prod_date: v }))}
                  className={cn(__WEB__ && '!h-[46px] !w-full !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[14px] !font-semibold')}
                />
              </div>
              <div className={cn('flex flex-col gap-1.5', __WEB__ && '!min-w-[180px] !flex-1 !gap-0')}>
                <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                  Which oil <span className="text-[#B3261E]">*</span>
                </Label>
                {/* The app's own Select, not the handoff's hand-rolled panel:
                    this dialog clips its overflow, and an absolutely
                    positioned list inside it would be cut off at the edge. */}
                <Select
                  value={String(recirc.product_id || '')}
                  onValueChange={(v) => setRecirc((p2) => ({ ...p2, product_id: v }))}
                  // Dressed like the dialog it opens in: square corners, the
                  // form's own border, and a lift that reads as floating above
                  // the sheet rather than as another box drawn on it.
                  panelClassName={
                    __WEB__
                      ? '!rounded-[4px] !border-[#C3D2C6] !normal-case !shadow-[0_16px_36px_rgba(10,31,23,.22)]'
                      : undefined
                  }
                >
                  <SelectTrigger
                    className={cn(
                      __WEB__ &&
                        cn(
                          '!h-[46px] !rounded-[4px] !bg-white !px-3 !text-[13.5px] !font-bold',
                          recirc.product_id ? '!border-[#C3D2C6] !text-[#0A1F17]' : '!border-[#F0D9AE] !text-[#8FA79B]'
                        )
                    )}
                  >
                    <SelectValue placeholder="Pick the oil" />
                  </SelectTrigger>
                  {/* Capped so the list stays inside the sheet. The panel
                      escapes the dialog's clipping on purpose — otherwise it
                      would be cut off at the edge — but a products list this
                      long then ran past the bottom of the dialog and over the
                      backdrop, which reads as the dropdown having got loose. */}
                  <SelectContent className={cn(__WEB__ && '!max-h-[210px] !p-1.5')}>
                    {products.map((x) => (
                      <SelectItem
                        key={String(x.id)}
                        value={String(x.id)}
                        className={cn(__WEB__ && '!h-10 !rounded-[3px] !text-[13px] !font-semibold')}
                      >
                        {String(x.name)} · {CAT_LABEL[String(x.category)] ?? String(x.category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
              <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>
                Quantity <span className="text-[#B3261E]">*</span>
              </Label>
              <div className={cn(__WEB__ && '!flex !items-center !gap-3')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  placeholder="0.000"
                  className={cn(
                    'text-right tabular-nums',
                    __WEB__ && '!h-[46px] !min-w-0 !flex-1 !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[15px] !font-bold'
                  )}
                  value={String(recirc.qty ?? '')}
                  onChange={(e) => setRecirc((p2) => ({ ...p2, qty: e.target.value }))}
                />
                {__WEB__ && (
                  <span className="shrink-0 text-[12.5px] font-extrabold text-[#5A6B62]">{recircUom}</span>
                )}
              </div>
              {/* What the register will say, said first. */}
              <div
                className={cn(
                  'mt-2 flex items-center gap-2.5 rounded-[4px] border border-[#C6DAF0] border-l-4 border-l-[#1B4E82] bg-[#EAF0FA] px-3.5 py-2.5',
                  __WEB__ && '!mt-2.5'
                )}
              >
                <RefreshCw className="h-[18px] w-[18px] shrink-0 text-[#1B4E82]" />
                <span className="min-w-0 text-[12px] font-bold leading-snug text-[#1B4E82]">
                  The register will show <span className="tabular-nums">{ledgerPair}</span> against the oil — the
                  balance ends exactly where it started.
                </span>
              </div>
            </div>

            <div className={cn('flex flex-col gap-1.5', __WEB__ && '!gap-0')}>
              <Label className={cn(__WEB__ && '!mb-[7px] !text-[12.5px] !font-extrabold !text-[#0A1F17]')}>Note</Label>
              <Input
                className={cn(__WEB__ && '!h-[46px] !rounded-[4px] !border-[#C3D2C6] !bg-white !px-3 !text-[13px] !font-semibold')}
                placeholder="Why the plant was run — e.g. shut down 3 days"
                value={String(recirc.note ?? '')}
                onChange={(e) => setRecirc((p2) => ({ ...p2, note: e.target.value }))}
              />
            </div>
          </div>

          {/* What is still missing, or what is about to be recorded — in the
              footer beside the button that does it, rather than as a toast
              after it has been pressed. */}
          <DialogFooter
            className={cn(
              __WEB__ && '!flex-wrap !items-center !gap-3 !border-t !border-t-[#D6E2D6] !bg-white !px-[22px] !py-3.5 sm:!justify-start'
            )}
          >
            {__WEB__ && (
              <div
                className={cn(
                  'flex min-w-0 items-center gap-2 text-[12.5px] font-bold',
                  recircMissing ? 'text-[#8A5300]' : 'text-[#0B6B45]'
                )}
              >
                {recircMissing ? (
                  <AlertTriangle className="h-[18px] w-[18px] shrink-0" />
                ) : (
                  <CheckCircle2 className="h-[18px] w-[18px] shrink-0" />
                )}
                <span className="leading-snug">
                  {recircMissing
                    ? `Enter ${recircMissing}.`
                    : `Records against ${String(products.find((x) => String(x.id) === String(recirc.product_id))?.name || '')} — no stock moves.`}
                </span>
              </div>
            )}
            <div className={cn(__WEB__ && '!ml-auto !flex !gap-2.5')}>
              <Button
                variant="outline"
                onClick={() => setRecircOpen(false)}
                className={cn(
                  __WEB__ &&
                    '!h-[46px] !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !bg-white !px-5 !text-[12.5px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E]'
                )}
              >
                Cancel
              </Button>
              <Button
                disabled={recircSaving || !!recircMissing}
                onClick={() => void saveRecirculation()}
                className={cn(
                  'gap-1.5',
                  __WEB__ &&
                    cn(
                      '!h-[46px] !gap-2 !rounded-[4px] !px-[22px] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em]',
                      recircMissing
                        ? '!bg-[#C3D2C6] !text-[#F1F5EF]'
                        : '!bg-[#0B3D2E] !text-[#C7F03F] hover:!bg-[#0F4A38]'
                    )
                )}
              >
                <RefreshCw className="h-4 w-4" /> {recircSaving ? 'Recording…' : 'Record'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  )
}
