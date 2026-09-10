import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Undo2, ArrowLeft, ArrowRight, AlertTriangle, BarChart3, Boxes, Building2, CalendarDays, CheckCircle2, ChevronDown, ClipboardList, Clock, DoorOpen, Eye, MinusCircle, Package,
  FileText, FlaskConical, History, IndianRupee, Info, Landmark, Lock, Pencil, Plus, ScrollText, Search, Trash2, Truck, type LucideIcon,
  Check
} from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { TdsExplainer, type TdsParty } from '@/components/TdsExplainer'
import { QualityUnit } from '@/components/QualityUnit'
import { guessUnit } from '@/lib/qualityUnits'
import { PhotoUpload, checkPhoto, prettyBytes } from '@/components/PhotoUpload'
import { FyPicker } from '@/components/FyPicker'
import { ExcelButton } from '@/components/ExcelButton'
import { Pagination, usePaged } from '@/components/Pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { Tooltip, TooltipContent, TooltipTrigger, InfoTip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { ColumnFilter } from '@/components/ui/column-filter'
import { RowActions } from '@/components/ui/row-actions'
import { GateEntriesDialog } from '@/components/GateEntriesDialog'
import { HistoryDialog, useHistoryDialog } from '@/components/HistoryDialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate, formatDateShort, formatINR, formatNum, todayISO } from '@/lib/format'

// Same function under a second name. The Orders component shadows `formatINR`
// with a masking version for the readings desk (see MONEY_MASK below), and an
// initializer cannot reference the name it is shadowing — so it reaches the
// real one through here.
const rupees = formatINR
// What the lab sees instead of a value.
const MONEY_MASK = '*****'
import { cn } from '@/lib/utils'
import { computeMoney, computeShortage } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { isManufacturingParty } from '@/lib/constants'
import { useEntryWindow } from '@/lib/useEntryWindow'
import { loadUser } from '@/lib/session'
import { moduleScope } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TANKER_STAGES = ['supplier_factory', 'loaded', 'transit', 'outside_factory', 'inside_factory', 'empty']
const TANKER_LABEL: Record<string, string> = {
  supplier_factory: 'To be loaded',
  loaded: 'Loaded',
  transit: 'In transit',
  outside_factory: 'Outside factory',
  inside_factory: 'Inside factory',
  empty: 'Empty'
}

// The journey, for the drawer's rail. Each stage knows the column that stamps
// it, so the rail can show what has already happened rather than only where
// you are — a tanker at Empty should still show the day it was loaded.
const TANKER_STAGE_RAIL: {
  key: string
  label: string
  dateKey: string
  icon: React.ComponentType<{ className?: string }>
}[] = [
  { key: 'supplier_factory', label: 'To be loaded', dateKey: 'created_at', icon: Truck },
  { key: 'loaded', label: 'Loaded', dateKey: 'loaded_date', icon: Package },
  { key: 'transit', label: 'In transit', dateKey: 'transit_date', icon: Truck },
  { key: 'outside_factory', label: 'Outside', dateKey: 'outside_factory_date', icon: DoorOpen },
  { key: 'inside_factory', label: 'Inside', dateKey: 'inside_factory_date', icon: Building2 },
  { key: 'empty', label: 'Empty', dateKey: 'empty_date', icon: Check }
]

// Read an image file and return a downscaled JPEG data URL so weighment-slip
// photos stay small enough to live in the cloud DB (works for all users).
function fileToCompressedDataUrl(file: File, maxDim = 1280, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('That file is not a valid image'))
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Image processing is not supported'))
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function nextTankerStage(status: string): string | null {
  const i = TANKER_STAGES.indexOf(status)
  return i >= 0 && i < TANKER_STAGES.length - 1 ? TANKER_STAGES[i + 1] : null
}

// Whole days between two YYYY-MM-DD dates (toISO − fromISO).
function dayDiff(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO.slice(0, 10)}T00:00:00`).getTime()
  const b = new Date(`${toISO.slice(0, 10)}T00:00:00`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

// Delay status for a tanker that hasn't reached Empty yet, based on the
// expected delivery date computed from the port's transit days. Once the
// tanker has actually reached Outside factory, the delay is FIXED to how long
// that outward trip really took (outside factory date − loaded date, against
// the source's transit-day benchmark) — it stops growing with today's date,
// so a tanker sitting Inside factory doesn't keep racking up "delayed" days
// for time that was never spent in transit. Only a tanker still en route
// (no outside factory date yet) falls back to comparing against today.
// `kind` is for the website, which draws these as chips and needs to know
// which of the five states it is looking at without parsing the sentence.
// `label` and `tone` are what the desktop app has always rendered.
type TankerDelay = {
  label: string
  tone: string
  kind: 'late' | 'today' | 'good' | 'eta' | 'unset'
  eta?: string
  inDays?: number
}
function tankerDelay(row: Row): TankerDelay | null {
  if (!['transit', 'outside_factory', 'inside_factory'].includes(String(row.status))) return null
  const exp = String(row.expected_delivery_date || '').slice(0, 10)
  if (!exp) {
    // No ETA without a source to carry transit days — say why, rather than
    // just showing nothing under the stage badge.
    return row.source_id
      ? null
      : { label: 'No ETA — set a source (Edit)', tone: 'text-muted-foreground italic', kind: 'unset' }
  }
  const outsideDate = String(row.outside_factory_date || '').slice(0, 10)
  const days = dayDiff(exp, outsideDate || todayISO())
  if (days > 0) return { label: `Delayed ${days} day${days === 1 ? '' : 's'}`, tone: 'text-red-600', kind: 'late' }
  if (days === 0)
    return outsideDate
      ? { label: 'On time', tone: 'text-emerald-600', kind: 'good' }
      : { label: 'Due today', tone: 'text-amber-600', kind: 'today' }
  return outsideDate
    ? { label: `Arrived ${-days}d early`, tone: 'text-emerald-600', kind: 'good' }
    : { label: `ETA ${formatDate(exp)} · ${-days}d`, tone: 'text-muted-foreground', kind: 'eta', eta: exp, inDays: -days }
}

// The tone of each state, as INK rather than as a chip.
//
// The stage badge above it is already a chip, so a second pill directly under
// it made every cell in this column two stacked boxes — and the one that
// mattered least, "ETA in 2 days", was drawn as loudly as the one that
// mattered most. Colour carries the verdict perfectly well without a box
// around it: dark red reads as late from across the room, and the cell stops
// competing with the stage it belongs to.
//
// Each colour is dark enough to be read as text on white, and each is the
// tone this palette already uses for that meaning elsewhere — the same green
// as the stage chip's ink, the same amber as a warning row, the same violet
// as the neutral ETA had.
const ETA_TONE: Record<TankerDelay['kind'], string> = {
  late: 'text-[#B3261E]',
  today: 'text-[#8A5300]',
  good: 'text-[#0B6B45]',
  eta: 'text-[#3D3179]',
  unset: 'text-[#8FA79B] italic'
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant = status === 'empty' || status === 'received' ? 'success' : status === 'loaded' ? 'warning' : 'secondary'
  const label = TANKER_LABEL[status] ?? (status === 'received' ? 'Completed' : status)
  if (__WEB__) {
    // The handoff's stage chip: a bordered pill with an icon that says where
    // the tanker physically is. "To be loaded" is the one stage nothing has
    // happened in yet, so it stays neutral; everything from Loaded onwards is
    // green, because the tanker is moving.
    const started = status !== 'supplier_factory'
    const Ico =
      status === 'empty' || status === 'received'
        ? CheckCircle2
        : status === 'transit'
          ? Truck
          : status === 'supplier_factory'
            ? Clock
            : Package
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[2px] border px-2.5 py-[5px] text-[12px] font-extrabold tracking-[.03em]',
          started ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]' : 'border-[#C3D2C6] bg-[#EAF0E9] text-[#33473E]'
        )}
      >
        <Ico className="h-4 w-4 shrink-0" />
        {label}
      </span>
    )
  }
  return <Badge variant={variant}>{label}</Badge>
}

// Movement-overview columns. Confirming loading jumps straight to transit, so
// 'loaded' looks transient — but Undo from In transit parks a tanker there and
// refuses to go back further, so it IS a resting state. Without a column of its
// own such a tanker was counted under "To be loaded" while its own row badge
// said Loaded.
const PIVOT_STAGES = [
  { key: 'supplier_factory', label: 'To be loaded' },
  { key: 'loaded', label: 'Loaded' },
  { key: 'transit', label: 'In transit' },
  { key: 'outside_factory', label: 'Outside factory' },
  { key: 'inside_factory', label: 'Inside factory' },
  { key: 'empty', label: 'Empty' }
]

// The stage a tanker is in as of `asOf` (its current/last stage on that date),
// so each tanker is counted once — a tanker in transit is NOT also "to be loaded".
// First day of the current month, YYYY-MM-DD.
function monthStartISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// What an incoming load is tested on when the sample is drawn. Seeded on every
// empty-stage form so the four are asked for by name rather than remembered;
// the row is dropped on save if it is left blank, so a load that was not
// tested for one of them stores nothing rather than a blank reading.
// The stage forms, as a right-hand drawer.
//
// They were centred modals, which is the wrong shape for this work: moving a
// tanker on is done against the register — you check the row you came from,
// the gate figure, the bargain balance — and a box in the middle of the screen
// covers exactly that. A panel down the right edge leaves the register beside
// it, which is how the handoff draws every one of these.
//
// Built by overriding the Dialog rather than introducing a Sheet: the content,
// the focus trap, the escape key and the six call sites all stay as they are,
// and only where the panel sits changes.
const TK_DRAWER = __WEB__
  ? cn(
      '!left-auto !right-0 !top-0 !bottom-0 !translate-x-0 !translate-y-0',
      '!h-screen !max-h-screen !max-w-none',
      '!grid-rows-[auto_1fr_auto] !gap-0 !rounded-none !border-0 !bg-[#F1F5EF] !p-0',
      '!shadow-[-16px_0_40px_rgba(10,31,23,.22)]',
      'data-[state=open]:!slide-in-from-right-1/2 data-[state=closed]:!slide-out-to-right-1/2',
      // The close button is a direct child of DialogContent, so it lands on
      // the forest head wearing the default near-black — invisible until you
      // hover it. It is the only direct-child button here.
      '[&>button]:!right-[18px] [&>button]:!top-[18px] [&>button]:!text-white/60 [&>button]:!opacity-100 hover:[&>button]:!text-white'
    )
  : ''

// Width is per stage, not one figure for all six. 700px was chosen for the
// shortest form, which left Empty — gate figure, received quantity, shortage
// and the technical-parameter grid — folding itself into a column too narrow
// to read, and left the two-field stages looking like a slot. Both stay capped
// at the viewport so the register is still visible beside the panel.
const TK_WIDE = __WEB__ ? '!w-[min(100vw,880px)]' : ''
const TK_NARROW = __WEB__ ? '!w-[min(100vw,790px)]' : ''

// The forest head: what stage this is, which tanker, and the load in one line.
const TK_HEAD = __WEB__ ? '!m-0 !space-y-0 !bg-[#0B3D2E] !px-[26px] !pb-[18px] !pt-5 !text-left' : ''
const TK_KICKER = __WEB__ ? 'text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]' : ''
const TK_TITLE = __WEB__ ? '!mt-[5px] !text-[22px] !font-extrabold !leading-none !tracking-[-0.02em] !text-white' : ''
const TK_SUB = __WEB__ ? 'mt-[7px] text-[12.5px] font-semibold text-[#8FBFA8]' : ''

// The scrolling middle, and the section cards inside it.
const TK_BODY = __WEB__
  ? '!m-0 !min-h-0 !gap-3 !overflow-y-auto !bg-[#F1F5EF] !px-[22px] !py-4'
  : ''
const TK_CARD = __WEB__ ? 'rounded-[4px] border border-[#D6E2D6] bg-white' : ''
// A stage's fields sit ON something. Two bare inputs floating on the panel's
// wash read as a form that has not finished loading, which is exactly how the
// short stages looked — most of the panel was empty ground with a pair of
// boxes near the top and nothing to say where the form ended.
const TK_SECT = __WEB__ ? '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !p-[18px]' : ''
const TK_CARD_HEAD = __WEB__
  ? 'border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]'
  : ''
// One rule for every control in the drawer, so a Select, a date and a text box
// are the same object at the same height — 46px, as the handoff draws them.
const TK_FIELDS = __WEB__
  ? cn(
      '[&_label]:!text-[11px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.11em] [&_label]:!text-[#5A6B62]',
      '[&_input]:!h-[46px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[13.5px] [&_input]:!font-bold [&_input]:!text-[#0A1F17]',
      '[&_[data-slot=select-trigger]]:!h-[46px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]]:!font-bold',
      '[&_[data-slot=date-picker]]:!h-[46px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
    )
  : ''
// Save and Cancel pinned to the bottom edge, not floating after the last
// field — these forms are long enough to scroll past them.
const TK_FOOT = __WEB__
  ? '!m-0 !border-t !border-t-[#D6E2D6] !bg-white !px-[22px] !py-3.5 [&_button]:!h-[42px] [&_button]:!rounded-[4px] [&_button]:!px-5 [&_button]:!text-[13px] [&_button]:!font-extrabold'
  : ''

// What was recorded at a stage, for reading back.
//
// A tanker's history was only ever visible as a date under a step on the rail.
// Someone moving a load on wants the rest of it — which bargain it was booked
// against, what it weighed, who is carrying it, what the gate said — and the
// only way to see any of that was to leave the drawer for the register, losing
// the form. These are the facts each stage captured, read straight off the row.
//
// Read-only by construction: it returns strings. There is no path from here to
// a write, which is the point — an earlier stage is history, and correcting it
// is Edit's job, not something to be done in passing while moving a tanker on.
function stageFacts(row: Row, key: string): { k: string; v: string }[] {
  const q = (v: unknown, u?: unknown): string =>
    Number(v) ? `${formatNum(Number(v))} ${String(u || row.uom || 'MT')}` : ''
  const txt = (v: unknown): string => String(v ?? '').trim()
  const out: { k: string; v: string }[] = []
  const add = (k: string, v: string): void => {
    if (v) out.push({ k, v })
  }

  if (key === 'supplier_factory') {
    add('Sent on', row.created_at ? formatDate(String(row.created_at).slice(0, 10)) : '')
    add('Tanker', txt(row.tanker_no))
    add('Supplier', txt(row.supplier_name))
    add('Product', txt(row.oil_code || row.oil_name))
    add('Bargain', txt(row.bargain_no))
  } else if (key === 'loaded') {
    add('Loaded on', row.loaded_date ? formatDate(row.loaded_date) : '')
    add('Tanker', txt(row.tanker_no))
    add('Bargain', txt(row.bargain_no))
    add('Loaded qty', q(row.loaded_qty))
    add('Payment', row.payment_mode === 'supplier_finance' ? 'Supplier financed' : row.payment_mode === 'pending' ? 'Not decided' : 'Paid by us')
    add('Extra bargain', txt(row.extra_bargain_no))
  } else if (key === 'transit') {
    add('In transit on', row.transit_date ? formatDate(row.transit_date) : '')
    add('Source / port', txt(row.source_name))
    add('Transporter', txt(row.transporter_name))
    if (Number(row.transport_rate_per_ton) > 0) {
      add('Freight rate', `${formatINR(row.transport_rate_per_ton)}/${String(row.uom || 'MT')}`)
      const basis = row.received_qty != null ? Number(row.received_qty) : Number(row.loaded_qty) || 0
      add('Freight', basis ? `≈ ${formatINR(Number(row.transport_rate_per_ton) * basis)}` : '')
    }
    add('No freight because', txt(row.freight_remark))
  } else if (key === 'outside_factory') {
    add('Outside on', row.outside_factory_date ? formatDate(row.outside_factory_date) : '')
    add('Gate entry', txt(row.gate_entry_no))
    add('Gate register no', txt(row.gate_ref_no))
  } else if (key === 'inside_factory') {
    add('Inside on', row.inside_factory_date ? formatDate(row.inside_factory_date) : '')
    add('Gate entry', txt(row.gate_entry_no))
  } else if (key === 'empty') {
    add('Empty on', row.empty_date ? formatDate(row.empty_date) : '')
    add('Received qty', q(row.received_qty))
    add('Gate weighed', q(row.gate_qty))
    const short = (Number(row.loaded_qty) || 0) - (Number(row.received_qty) || 0)
    if (Number(row.received_qty) > 0 && short > 1e-6) add('Shortage', q(short))
    add('Replacement', txt(row.last_replacement))
  }
  return out
}

// The floor under a stage's date: the latest date already stamped at any
// EARLIER stage. A tanker loaded on 27-08 can be marked in transit today, or
// backdated to any day from 27-08 on — but never to the 26th, because it was
// not on the road before it was filled.
//
// Derived by walking the order rather than written out per field. The drawer
// kept four hand-maintained fallback chains and they had drifted apart: Empty's
// omitted transit_date, so a tanker that went straight from transit to empty
// was floored at its LOADED date and would happily take a day before it set
// off; and Loaded carried no floor at all. src/main/orders.ts walks this same
// order in assertStageDateOrder, so a date the picker allows is now exactly a
// date the server accepts — the two cannot drift again.
//
// Takes the MAXIMUM of the earlier dates, not the nearest one. On a tanker
// whose stages were stamped out of order historically, the nearest could be
// earlier than one before it, and the floor has to clear them all.
const STAGE_DATE_ORDER: Array<[string, string]> = [
  ['loaded_date', 'loaded'],
  ['transit_date', 'in transit'],
  ['outside_factory_date', 'outside factory'],
  ['inside_factory_date', 'inside factory'],
  ['empty_date', 'empty']
]

function stageFloor(row: Row | null | undefined, dateKey: string): { iso: string; label: string } | null {
  if (!row) return null
  const i = STAGE_DATE_ORDER.findIndex(([k]) => k === dateKey)
  if (i <= 0) return null
  let best: { iso: string; label: string } | null = null
  for (let k = 0; k < i; k++) {
    const [key, label] = STAGE_DATE_ORDER[k]
    const v = String(row[key] || '').slice(0, 10)
    if (!v) continue
    if (!best || v > best.iso) best = { iso: v, label }
  }
  return best
}

// The line under a stage date saying what bounds it, so a greyed-out day in the
// calendar reads as a rule rather than as the control being broken.
function StageDateNote({ row, dateKey }: { row: Row | null | undefined; dateKey: string }): React.JSX.Element | null {
  if (!__WEB__) return null
  const floor = stageFloor(row, dateKey)
  return (
    <span className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
      {floor
        ? `Any day from ${formatDate(floor.iso)} (${floor.label}) up to today.`
        : 'Backdating is allowed, up to today.'}
    </span>
  )
}

const TANKER_QUALITY_DEFAULTS = ['FFA', 'Colour', 'Moisture', 'Melting point'] as const

function stageAsOf(t: Row, asOf: string): string {
  const on = (d: unknown): boolean => {
    const s = String(d || '').slice(0, 10)
    return !!s && s <= asOf
  }
  if (on(t.empty_date)) return 'empty'
  if (on(t.inside_factory_date)) return 'inside_factory'
  if (on(t.outside_factory_date)) return 'outside_factory'
  if (on(t.transit_date)) return 'transit'
  // Loaded but not yet sent on its way — reached by undoing In transit, which
  // clears transit_date and leaves loaded_date standing. loaded_date alone will
  // not do: the column is NOT NULL and is stamped when the tanker is first sent
  // to the supplier, so a tanker that has never been loaded has one too. A
  // confirmed loaded_qty is what actually marks loading as done.
  if (on(t.loaded_date) && Number(t.loaded_qty) > 0) return 'loaded'
  return 'supplier_factory'
}

function MoneyRow({ label, value, strong, title }: { label: string; value: string; strong?: boolean; title?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between py-1.5 text-sm', __WEB__ && '!gap-3 !py-[5px]')} title={title}>
      <span
        className={cn(
          strong ? 'font-semibold text-foreground' : 'text-muted-foreground',
          title && 'cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4',
          __WEB__ &&
            cn(
              '!min-w-0 !text-[12.5px] !leading-[1.45]',
              strong ? '!font-extrabold !text-[#0A1F17]' : '!font-semibold !text-[#33473E]',
              title && '!decoration-[#C3B78F]'
            )
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          strong ? 'font-semibold tabular-nums' : 'tabular-nums',
          __WEB__ &&
            cn(
              'doc-ref !shrink-0 !whitespace-nowrap',
              strong ? '!text-[13.5px] !font-bold !text-[#0A1F17]' : '!text-[13px] !font-bold !text-[#33473E]'
            )
        )}
      >
        {value}
      </span>
    </div>
  )
}

// Small labeled fact card for a detail dialog's key figures — an icon +
// muted caption + the value, so a handful of facts read at a glance instead
// of as a stack of plain label/value lines.
// One foldable section of the purchase panel. The panel used to be a single
// stack with Gate entries and History behind buttons that CLOSED it and opened
// a dialog of their own — so reading the trail meant losing the invoice you
// were reading it about. They are sections here instead, and each one's
// contents are mounted only while it is open, so nothing is fetched until it
// is actually asked for.
//
// The desktop app keeps the panel it has: it renders the children with no
// chrome at all, which is exactly what it had before.
function DrawerSection({
  icon: Icon,
  title,
  defaultOpen = false,
  children
}: {
  icon: LucideIcon
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  if (!__WEB__) return <>{children}</>
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-2.5 text-left transition-colors hover:bg-[#F7FAF6]',
          open && 'rounded-b-none'
        )}
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-[#12855A] transition-transform', !open && '-rotate-90')} />
        <Icon className="h-4 w-4 shrink-0 text-[#8AA096]" />
        <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">{title}</span>
      </button>
      {open && (
        <div className="min-w-0 space-y-3 rounded-b-[4px] border border-t-0 border-[#D6E2D6] bg-[#F7FAF6] p-3">
          {children}
        </div>
      )}
    </div>
  )
}

function InfoTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }): React.JSX.Element {
  return (
    // The website stacks the icon+label over the value rather than putting the
    // icon beside both — at two tiles to a row the value gets the full width,
    // which is what a supplier name or a tanker list actually needs.
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2',
        // min-w-0: a grid item's automatic minimum is its CONTENT, so a value
        // that does not wrap pushes the tile wider than its column and the
        // text runs out past the border — which is what a two-bargain invoice
        // did to this tile.
        __WEB__ && '!min-w-0 !flex-col !gap-1.5 !rounded-[4px] !border-[#D6E2D6] !bg-white !px-3.5 !py-3'
      )}
    >
      <div className={cn(__WEB__ && 'flex items-center gap-1.5')}>
        <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground', __WEB__ && '!mt-0 !h-4 !w-4 !text-[#8AA096]')} />
        {__WEB__ && (
          <span className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7C9188]">{label}</span>
        )}
      </div>
      <div className="min-w-0">
        {!__WEB__ && <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>}
        {/* Wraps rather than truncates on the website. These tiles hold the
            things the invoice is looked up by — the bargain it draws on, the
            tankers on it — and half of one behind an ellipsis is no more use
            than none of it. Two tiles to a row stretch to match, so the grid
            stays square. */}
        <div
          className={cn(
            'truncate text-sm font-medium',
            __WEB__ && '!overflow-visible !whitespace-normal !break-words !text-[15px] !font-bold !leading-snug !tracking-[-0.01em]'
          )}
          title={value}
        >
          {value}
        </div>
      </div>
    </div>
  )
}

// Label-over-value, for a fact sitting inside a grid alongside others — a
// row-style label-left/value-right control (MoneyRow) squeezed into a narrow
// grid cell wraps its label and value onto separate lines that no longer
// line up with the cell next to it. Stacking removes that fight for width.
function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-sm" title={value}>{value}</div>
    </div>
  )
}

// Small-caps field label on the Purchase entries filter card. Named rather
// than repeated inline because it has to stay identical across DATE,
// CATEGORY and the receipt-date toggle — a label a shade off its neighbours
// is the thing that makes a filter bar look assembled rather than designed.
// ---------------------------------------------------------------------------
// New purchase / Alter purchase invoice, on the website.
//
// The page was the app's oldest surface and still wore it: a cornflower title
// bar, a cream parchment shell, dotted-underline section rules and a navy save
// button — the Tally skin the rest of the site has already left behind. The
// arithmetic, the field order and every control are the ones that were here;
// only the surface changes, and only on the website.
const NP_BAR = __WEB__
  ? '!flex !h-[62px] !flex-nowrap !items-center !gap-4 !rounded-none !bg-[#0B3D2E] !px-[22px] !py-0 !text-white'
  : ''
const NP_BACK = __WEB__
  ? '!h-[38px] !gap-2 !rounded-[3px] !bg-white/10 !pl-2 !pr-3 !text-[12.5px] !font-extrabold !text-white hover:!bg-white/[.18] hover:!no-underline'
  : ''
const NP_TITLE = __WEB__ ? '!text-[16.5px] !font-extrabold !normal-case !tracking-[-0.02em] !text-white' : ''
const NP_REF = __WEB__ ? 'doc-ref !text-[12.5px] !font-semibold !text-[#8FBFA8]' : ''

// The shell. No card around the whole page any more — the two columns are the
// page, on the site's own ground.
const NP_SHELL = __WEB__ ? '!rounded-none !border-0 !bg-transparent !shadow-none' : ''
const NP_GRID = __WEB__ ? '!gap-3.5 !px-[22px] !py-3.5 xl:!grid-cols-[minmax(0,1fr)_360px]' : ''

// A section: white, hairline, with a headed strip rather than a dotted rule.
const NP_CARD = __WEB__ ? '!rounded-[4px] !border-[#D6E2D6] !bg-white !p-0' : ''
const NP_CARD_HEAD = __WEB__
  ? '!m-0 !flex !items-center !gap-[9px] !rounded-t-[3px] !border-0 !border-b !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[18px] !py-[13px] !text-[11.5px] !font-extrabold !uppercase !tracking-[.14em] !text-[#0A1F17]'
  : ''
const NP_CARD_BODY = __WEB__ ? '!gap-[18px] !p-[18px]' : ''

// One rule for every control on the page, so a Select, a date, a number and a
// text box are the same 46px object. The label rule has to be !important:
// the section already carries a [&_label] rule of its own.
const NP_FIELDS = __WEB__
  ? cn(
      '[&_label]:!text-[10.5px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.12em] [&_label]:!text-[#5A6B62]',
      '[&_input]:!h-[46px] [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[13.5px] [&_input]:!font-bold [&_input]:!text-[#0A1F17]',
      '[&_[data-slot=select-trigger]]:!h-[46px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[13.5px] [&_[data-slot=select-trigger]]:!font-bold',
      '[&_[data-slot=date-picker]]:!h-[46px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13.5px] [&_[data-slot=date-picker]]:!font-bold',
      '[&_textarea]:!rounded-[4px] [&_textarea]:!border-[#C3D2C6] [&_textarea]:!bg-white [&_textarea]:!px-[13px] [&_textarea]:!py-3 [&_textarea]:!text-[13px] [&_textarea]:!font-semibold'
    )
  : ''
// The line of help under a field.
const NP_NOTE = __WEB__ ? '!text-[11.5px] !font-semibold !leading-[1.5] !text-[#5A6B62]' : ''

// The summary rail: cream, so the figures read as the answer rather than as
// one more panel of inputs.
const NP_RAIL = __WEB__
  ? '!rounded-[4px] !border-[#E8E1CB] !bg-[#FDFBF3] !p-0 xl:!top-[14px]'
  : ''
const NP_RAIL_HEAD = __WEB__
  ? '!m-0 !flex !items-center !gap-[9px] !border-0 !border-b !border-b-[#E8E1CB] !px-[18px] !py-[14px] !text-[11.5px] !font-extrabold !uppercase !tracking-[.14em] !text-[#0A1F17]'
  : ''
const NP_RAIL_SECT = __WEB__ ? 'border-b border-b-[#EFE8D6] px-[18px] py-3' : ''
// Small inputs living inside the rail (rate adjustment, round off) wear its
// own border rather than the form's, so they read as part of the tally.
const NP_RAIL_INPUT = __WEB__
  ? '!h-[34px] !rounded-[3px] !border-[#C3B78F] !bg-white !text-right !text-[12.5px] !font-bold !text-[#0A1F17]'
  : ''

const PO_LABEL = '!text-[10.5px] !font-extrabold !tracking-[.13em] !text-[#5A6B62]'

// The tanker group bands ("Loaded & received within…" / "Loaded outside…")
// collapse on the website. The band stays a <div> rather than becoming a
// <button> so the desktop app's markup and styling are untouched — it gets
// the button's keyboard and screen-reader behaviour from these props instead,
// and on desktop it gets nothing at all.
function groupToggleProps(open: boolean, toggle: () => void): React.HTMLAttributes<HTMLDivElement> {
  if (!__WEB__) return {}
  return {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    onClick: toggle,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    }
  }
}

function GroupChevron({ open, tone }: { open: boolean; tone: string }): React.JSX.Element | null {
  if (!__WEB__) return null
  return (
    <ChevronDown
      className={cn('ml-auto h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')}
      style={{ color: tone }}
    />
  )
}

interface OrdersProps {
  focusId?: number | null
  onFocusHandled?: () => void
  onBack?: () => void
  backLabel?: string
}

export function Orders({ focusId, onFocusHandled, onBack, backLabel }: OrdersProps = {}): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('orders')
  // The readings desk: may record technical parameters against a purchase and
  // nothing else. For them the page is Purchase entries alone, with the flask
  // as its only control — every other button, tab and row menu is not
  // rendered. Not disabled: not there. The server refuses the writes anyway
  // (access-gate.ts, scope 'readings'); this keeps the screen honest about it.
  const readingsOnly = moduleScope(loadUser(), 'orders') === 'readings'
  // EVERY rupee figure on this page goes through this name, and for the
  // readings desk it prints ***** instead.
  //
  // Done by SHADOWING the import rather than by masking at each call site, and
  // that is deliberate: this page prints money in NINETY places. The register
  // column and its total, the freight popover, and the whole of the detail
  // drawer — which opens on a row click, so the readings desk reaches it. A
  // control that depends on remembering to wrap each of ninety calls leaks the
  // first time somebody adds the ninety-first. This way a new rupee figure
  // anywhere in the component is masked without being thought about.
  //
  // The quantity columns are left alone: a lab reading is taken against a
  // weight, and it is the rates and values the desk is not to see.
  //
  // NOTE what this is and is not. It is a screen control. The figures are
  // still in the payload the server sent, so somebody who opens devtools can
  // read them — withholding them properly means not selecting them for this
  // user in listOrders, which is a server change and a separate one.
  const formatINR = readingsOnly ? (): string => MONEY_MASK : rupees
  // Which tab, kept in the URL. A refresh used to land back on Tanker
  // movement whatever you were looking at, which on a page reached by reload
  // rather than by clicking is most of the time. In the address it also means
  // a link to Purchase entries actually opens Purchase entries.
  //
  // Website only: the desktop app has one window and no address bar to keep it
  // in, and it does not reload.
  const TABS = ['tankers', 'purchases', 'unmapped']
  const [tab, setTab] = useState<string>(() => {
    if (!__WEB__) return 'tankers'
    const t = new URLSearchParams(window.location.search).get('tab')
    return t && TABS.includes(t) ? t : 'tankers'
  })
  useEffect(() => {
    if (!__WEB__) return
    const url = new URL(window.location.href)
    // The default is the bare path — a ?tab=tankers on every visit is noise in
    // an address someone might copy.
    if (tab === 'tankers') url.searchParams.delete('tab')
    else url.searchParams.set('tab', tab)
    window.history.replaceState(null, '', url.toString())
  }, [tab])
  // Invoices with no live bargain link, and the mapping dialog state.
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCompany, setActiveCompany] = useState<number>(0)
  const [unmapped, setUnmapped] = useState<Row[]>([])
  const unmappedPaged = usePaged(unmapped)
  const [mapRow, setMapRow] = useState<Row | null>(null)
  const [mapLines, setMapLines] = useState<Row[]>([])
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapWarn, setMapWarn] = useState<string | null>(null)
  const [mapping, setMapping] = useState(false)

  const [rows, setRows] = useState<Row[]>([])
  // The purchase already booked under this invoice number, if any. Trimmed and
  // case-insensitive, scoped to the loaded register (already this company), so
  // the warning and the refusal on save agree on what a duplicate is.
  function invoiceClash(no: unknown, selfId: unknown): Row | null {
    const want = String(no || '').trim().toUpperCase()
    if (!want) return null
    return (
      rows.find(
        (r) => String(r.invoice_no || '').trim().toUpperCase() === want && Number(r.id) !== Number(selfId || 0)
      ) || null
    )
  }
  const [tankers, setTankers] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [sources, setSources] = useState<Row[]>([])
  const [transporters, setTransporters] = useState<Row[]>([])
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pivotStart, setPivotStart] = useState(monthStartISO())
  const [pivotEnd, setPivotEnd] = useState(todayISO())
  // Clicking a pivot count filters the tanker list below to that oil × stage.
  const [pivotSel, setPivotSel] = useState<{ oil: string; stage: string } | null>(null)
  // Collapse state for the two tanker group cards. Website only — the desktop
  // app renders both open with no toggle, exactly as it always has.
  const [tmInOpen, setTmInOpen] = useState(true)
  const [tmOutOpen, setTmOutOpen] = useState(true)
  // The stage summary cards start closed: the matrix right below them carries
  // the same numbers broken down by oil, so they are a glance, not the page.
  const [kpiOpen, setKpiOpen] = useState(false)
  // Category filter for the whole tab — the pivot and the tanker list below it.
  // Empty = every category.
  const [tmCategory, setTmCategory] = useState<string[]>([])
  const tmCategories = useMemo(
    () => Array.from(new Set(tankers.map((t) => String(t.product_category || '')).filter(Boolean))).sort(),
    [tankers]
  )
  // The movement views can look across companies: 'active' shows the company
  // you are in, 'all' or a company id widens the lens.
  const [moveCompany, setMoveCompany] = useState('active')
  const [allTankers, setAllTankers] = useState<Row[]>([])
  // Free-text search over the movement views. Applied to moveTankers rather
  // than to one table, so the pivot counts, its Excel and the lists under it
  // all answer the same question — a count you cannot reconcile with the list
  // below it is worse than no search at all.
  const [moveSearch, setMoveSearch] = useState('')
  const moveTankers = useMemo(() => {
    const base = allTankers.length ? allTankers : tankers
    const cid = moveCompany === 'active' ? String(activeCompany) : moveCompany
    // A tanker only belongs to a company once an invoice books it there —
    // until then it is just a vehicle in the yard, and which set of books it
    // will be billed into is exactly what has not been decided yet. So an
    // unbilled tanker shows under EVERY company; once billed it settles into
    // the invoice's company and shows only there.
    const scoped =
      moveCompany === 'all' ? base : base.filter((t) => !t.order_id || String(t.company_id) === cid)
    const q = moveSearch.trim().toLowerCase()
    if (!q) return scoped
    // Every term has to match somewhere, so "rj09 mahuwa" narrows instead of
    // widening — the way anyone types two things they remember about a load.
    const terms = q.split(/\s+/)
    return scoped.filter((t) => {
      const hay = [
        t.tanker_no, t.gate_tanker_no, t.supplier_name, t.bargain_no, t.extra_bargain_no,
        t.oil_code, t.oil_name, t.invoice_no, t.transporter_name, t.source_name, t.gate_entry_no
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return terms.every((w) => hay.includes(w))
    })
  }, [moveCompany, tankers, allTankers, activeCompany, moveSearch])

  const inCategory = useCallback(
    (t: Row): boolean => !tmCategory.length || tmCategory.includes(String(t.product_category || '')),
    [tmCategory]
  )

  const [loadingOpen, setLoadingOpen] = useState(false)
  const [loadingForm, setLoadingForm] = useState<Row>({ tanker_count: 1, factory_entry_date: todayISO() })
  const [loadingRows, setLoadingRows] = useState<Row[]>([{}])
  const [actionRow, setActionRow] = useState<Row | null>(null)
  const [actionForm, setActionForm] = useState<Row>({})
  // Loading more than the bargain balance: the excess is either booked as a new
  // bargain (optional rate) or allocated to an existing next bargain.
  // Which earlier step of the rail is being read back, if any.
  const [railPeek, setRailPeek] = useState<string | null>(null)
  const [excess, setExcess] = useState<
    { qty: number; balance: number; mode: 'new' | 'existing' | 'expand'; diffRate: boolean; rate: string; targetBargainId: string } | null
  >(null)
  const [detailRow, setDetailRow] = useState<Row | null>(null)
  // The purchase whose barrier events are being read. A purchase reaches its
  // gate entries through its TANKERS, so this passes the order id and lets the
  // main process walk that link.
  const [gateOrder, setGateOrder] = useState<Row | null>(null)
  const [viewTankerRow, setViewTankerRow] = useState<Row | null>(null)
  // Tanker-count + quantity report, grouped by product/oil.
  const [reportOpen, setReportOpen] = useState(false)
  const [repFrom, setRepFrom] = useState('')
  const [repTo, setRepTo] = useState('')
  const [gateEntries, setGateEntries] = useState<Row[]>([])
  const [editTanker, setEditTanker] = useState<Row | null>(null)
  const [editTankerForm, setEditTankerForm] = useState<Row>({})

  const [formPage, setFormPage] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [form, setForm] = useState<Row>({})
  const [products, setProducts] = useState<Row[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
    const [o, pt, ptAll, b, s, src, tr, cfg, ge, um, co, act, prod] = await Promise.all([
      window.api.orders.list(),
      window.api.tankers.list(),
      // Every company's tankers, always — an unbilled tanker isn't tied to a
      // company yet, so both the movement register and the booking picker
      // need to see across all of them (each filters down its own way).
      window.api.tankers.list(true),
      window.api.bargains.list(undefined, undefined, undefined, 'orders'),
      window.api.data.list('suppliers'),
      window.api.data.list('sources'),
      window.api.data.list('transporters'),
      window.api.settings.all(),
      window.api.gate.list(),
      window.api.orders.unmapped(),
      window.api.company.list(),
      window.api.company.getActive(),
      window.api.data.list('products')
    ])
    setRows(o)
    setTankers(pt)
    setAllTankers(ptAll)
    setBargains(b)
    setSuppliers(s)
    setSources(src.filter((x) => x.active))
    setTransporters(tr.filter((x) => x.active))
    setSettings(cfg)
    setGateEntries(ge)
    setUnmapped(um)
    setCompanies(co.filter((x) => x.active))
    setActiveCompany(Number(act?.id) || 0)
    setProducts(prod.filter((x) => x.active))
    setLoading(false)
  }, [])

  const [mapConfirm, setMapConfirm] = useState(false)
  // Bargains this invoice could be mapped to: same supplier, same product.
  const mapBargains = useMemo(
    () =>
      mapRow
        ? bargains.filter(
            (b) =>
              String(b.supplier_id) === String(mapRow.supplier_id) &&
              String(b.oil_type_id) === String(mapRow.oil_type_id)
          )
        : [],
    [bargains, mapRow]
  )
  const mapAllocated = mapLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
  const mapRemaining = (Number(mapRow?.ordered_qty) || 0) - mapAllocated
  const mapBargainValue = mapLines.reduce((sum, l) => {
    const b = bargains.find((x) => String(x.id) === String(l.bargain_id))
    return sum + (Number(b?.rate_per_uom) || 0) * (Number(l.qty) || 0)
  }, 0)
  const mapValueDiff = (Number(mapRow?.taxable_value) || 0) - mapBargainValue

  function openMap(row: Row): void {
    setMapRow(row)
    // Start with the whole invoice on one bargain; more can be added.
    setMapLines([{ bargain_id: '', qty: String(Number(row.ordered_qty) || 0), top_up: false }])
    setMapError(null)
    setMapWarn(null)
    setMapConfirm(false)
  }

  async function saveMapping(force: boolean): Promise<void> {
    if (!mapRow) return
    setMapError(null)
    if (mapLines.some((l) => !l.bargain_id)) return setMapError('Every line needs a bargain')
    if (mapLines.some((l) => (Number(l.qty) || 0) <= 0)) return setMapError('Every line needs a quantity')
    if (Math.abs(mapRemaining) > 0.0001) {
      return setMapError(
        mapRemaining > 0
          ? `${formatNum(mapRemaining)} ${mapRow.uom} of this invoice is still unallocated`
          : `The bargain quantities are ${formatNum(-mapRemaining)} ${mapRow.uom} more than the invoice`
      )
    }
    // Value mismatch is a warning, not a block: confirm on the second press.
    if (Math.abs(mapValueDiff) > 1 && !force && !mapConfirm) {
      setMapConfirm(true)
      setMapWarn(
        `The bargains price this invoice ${formatINR(Math.abs(mapValueDiff))} ${mapValueDiff > 0 ? 'lower' : 'higher'} than it was booked. Press Assign again to map it anyway.`
      )
      return
    }
    setMapping(true)
    try {
      const res = await window.api.orders.map(
        Number(mapRow.id),
        mapLines.map((l) => ({
          bargain_id: Number(l.bargain_id),
          qty: Number(l.qty) || 0,
          top_up: !!l.top_up
        })),
        true
      )
      const topped = (res.toppedUp || [])
        .map((t) => `${t.bargain_no} +${formatNum(t.qty)}`)
        .join(', ')
      toast.success(`Invoice ${mapRow.invoice_no} mapped${topped ? ` · raised ${topped}` : ''}`)
      setMapRow(null)
      await load()
    } catch (e) {
      const msg = (e as Error).message
      setMapError(msg.startsWith('VALUE_MISMATCH') ? 'The invoice value does not match the chosen bargains' : msg)
    } finally {
      setMapping(false)
    }
  }

  // Total gate-received qty for a tanker — completed weighments only; a pending
  // arrival (no weight yet) doesn't count. Null when nothing is completed.
  function gateQtyFor(tankerId: unknown): number | null {
    const list = gateEntries.filter(
      (g) => Number(g.tanker_id) === Number(tankerId) && String(g.status || 'completed') === 'completed'
    )
    if (!list.length) return null
    return list.reduce((s, g) => s + (Number(g.received_qty) || 0), 0)
  }

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Deep-link from Ledgers: open the booking invoice view for a specific order
  // once its data has loaded.
  useEffect(() => {
    if (!focusId) return
    const row = rows.find((r) => Number(r.id) === Number(focusId))
    if (!row) return
    openEditPurchase(row)
    setTab('purchases')
    onFocusHandled?.()
  }, [focusId, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // Oil-type × stage status matrix — each tanker counted ONCE in its current
  // stage as of the "To" date. Empty (finished) tankers are shown only if they
  // were emptied within [From, To]; in-progress tankers always show current stage.
  const pivot = useMemo(() => {
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    const dstr = (d: unknown): string => String(d || '').slice(0, 10)
    type Item = { bargain_no: string; supplier_name: string; tanker_no: string }
    type Cell = { count: number; qty: number; items: Item[] }
    const map = new Map<string, { label: string; cells: Record<string, Cell>; total: number }>()
    const totals: Record<string, number> = {}
    let grand = 0
    for (const t of moveTankers) {
      if (!inCategory(t)) continue
      const created = dstr(t.created_at)
      if (created && created > end) continue // didn't exist yet
      const stage = stageAsOf(t, end)
      // finished tankers only count if emptied within the window
      if (stage === 'empty') {
        const ed = dstr(t.empty_date)
        if (!(ed >= start && ed <= end)) continue
      }
      const key = String(t.oil_code || t.oil_name || '—')
      const label = key
      if (!map.has(key)) map.set(key, { label, cells: {}, total: 0 })
      const row = map.get(key)!
      const cell = (row.cells[stage] ??= { count: 0, qty: 0, items: [] })
      cell.count += 1
      cell.qty += Number(t.loaded_qty) || Number(t.received_qty) || 0
      cell.items.push({
        bargain_no: String(t.bargain_no || '—'),
        supplier_name: String(t.supplier_name || '—'),
        tanker_no: String(t.tanker_no || '')
      })
      row.total += 1
      totals[stage] = (totals[stage] || 0) + 1
      grand += 1
    }
    const rows = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
    return { rows, totals, grand }
  }, [moveTankers, pivotStart, pivotEnd, inCategory])

  // The pivot as Excel rows: one line per oil with its stage counts, then a line
  // per party under it — the breakdown the UI only shows on hover. Detail rows
  // are put on outline level 1 so Excel can collapse each oil.
  const pivotSheetRows = useMemo(() => {
    const out: Row[] = []
    for (const row of pivot.rows) {
      const r: Row = { oil: row.label, is_group: true, total: row.total }
      for (const st of PIVOT_STAGES) r[st.key] = row.cells[st.key]?.count || 0
      out.push(r)
      // party × stage under this oil
      const byParty = new Map<string, Row>()
      for (const st of PIVOT_STAGES) {
        for (const it of row.cells[st.key]?.items || []) {
          const k = it.supplier_name
          if (!byParty.has(k)) {
            const blank: Row = { oil: row.label, party: k, is_group: false, total: 0, tankers: [] as string[] }
            for (const x of PIVOT_STAGES) blank[x.key] = 0
            byParty.set(k, blank)
          }
          const pr = byParty.get(k) as Row
          pr[st.key] = (Number(pr[st.key]) || 0) + 1
          pr.total = (Number(pr.total) || 0) + 1
          ;(pr.tankers as string[]).push(`${it.tanker_no || '—'} (${it.bargain_no})`)
        }
      }
      for (const pr of Array.from(byParty.values()).sort((a, b) => String(a.party).localeCompare(String(b.party)))) {
        out.push({ ...pr, tanker_list: (pr.tankers as string[]).join(', ') })
      }
    }
    const grand: Row = { oil: 'GRAND TOTAL', is_group: true, total: pivot.grand }
    for (const st of PIVOT_STAGES) grand[st.key] = pivot.totals[st.key] || 0
    out.push(grand)
    return out
  }, [pivot])

  // The tanker list below the pivot follows the same date range — a tanker
  // belongs to the window if its loaded (or gate-entry) date falls within it.
  // When a pivot count is clicked, the list instead shows EXACTLY the tankers
  // that count includes (same oil × stage-as-of-window-end membership rule).
  const visibleTankers = useMemo(() => {
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    if (pivotSel) {
      return moveTankers.filter((t) => {
        if (!inCategory(t)) return false
        const created = String(t.created_at || '').slice(0, 10)
        if (created && created > end) return false
        const stage = stageAsOf(t, end)
        if (stage !== pivotSel.stage) return false
        if (stage === 'empty') {
          const ed = String(t.empty_date || '').slice(0, 10)
          if (!(ed >= start && ed <= end)) return false
        }
        return String(t.oil_code || t.oil_name || '—') === pivotSel.oil
      })
    }
    return moveTankers.filter((t) => {
      if (!inCategory(t)) return false
      // A tanker still short of Empty is outstanding work, not "history" —
      // it stays visible regardless of the date window (and so does its
      // delay flag) until it actually reaches Empty.
      if (String(t.status) !== 'empty') return true
      // Same rule the pivot above it uses: a finished tanker belongs to the
      // window by the day it was actually EMPTIED (received), not the day it
      // was loaded — filtering by loaded_date here let the pivot's count
      // include a tanker (loaded before the window, received inside it)
      // while this list silently dropped it, so the two disagreed.
      const d = String(t.empty_date || '').slice(0, 10)
      return !!d && d >= start && d <= end
    })
  }, [moveTankers, pivotStart, pivotEnd, pivotSel, inCategory])
  // Split of the SAME set above — not a wider query — by whether the tanker
  // was also LOADED inside the window. Together these two always add up to
  // visibleTankers.length; nothing outside that count is pulled in.
  const [inLoadedRangeTankers, outOfRangeTankers] = useMemo(() => {
    if (pivotSel) return [visibleTankers, [] as Row[]]
    const start = pivotStart
    const end = pivotEnd < pivotStart ? pivotStart : pivotEnd
    const inR: Row[] = []
    const outR: Row[] = []
    for (const t of visibleTankers) {
      const d = String(t.loaded_date || '').slice(0, 10)
      const loadedInRange = !!d && d >= start && d <= end
      ;(loadedInRange ? inR : outR).push(t)
    }
    return [inR, outR]
  }, [visibleTankers, pivotStart, pivotEnd, pivotSel])
  const tankerPaged = usePaged(inLoadedRangeTankers)
  const outOfRangePaged = usePaged(outOfRangeTankers)

  // What to call the second band.
  //
  // "Loaded outside 01-09-2026 – 09-09-2026" told you which window these
  // tankers were NOT loaded in, which is the one thing you already knew from
  // the band above. What is worth saying is which month they WERE loaded in —
  // these are the loads that crossed a month boundary, and naming the month
  // makes that a fact rather than an exclusion.
  //
  // One month gets its name; several get "Other months", with the actual list
  // on hover so nothing is lost. The year is added only when it differs from
  // the window's own, since "August" inside a September 2026 window needs no
  // year and "August 2025" very much does.
  // What to call the first band.
  //
  // "Loaded & received within 01-09-2026 – 09-09-2026" spelled out a window
  // that the filter strip directly above it already states, twice, in the two
  // date boxes it was read from. When the window sits inside one month the
  // month IS the answer — this is the month's own invoicing — and the sibling
  // band below already reads "August transit", so the two now name themselves
  // the same way.
  //
  // A window spanning several months keeps the range: there is no one month to
  // name, and "invoicing" alone would not say which.
  const inRangeLabel = useMemo(() => {
    const a = String(pivotStart || '').slice(0, 7)
    const b = String(pivotEnd || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(a) || a !== b) return ''
    const [y, mo] = a.split('-')
    const name = new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'long' })
    // The year only when it is not the current one — "September invoicing" for
    // this year's, "September 2025 invoicing" for an old window somebody has
    // scrolled back to.
    return y === String(new Date().getFullYear()) ? `${name} invoicing` : `${name} ${y} invoicing`
  }, [pivotStart, pivotEnd])

  const outOfRangeMonth = useMemo(() => {
    const keys = new Set<string>()
    for (const t of outOfRangeTankers) {
      const d = String(t.loaded_date || '').slice(0, 10)
      if (/^\d{4}-\d{2}/.test(d)) keys.add(d.slice(0, 7))
    }
    const list = Array.from(keys).sort()
    const named = (k: string): string => {
      const [y, mo] = k.split('-')
      const name = new Date(Number(y), Number(mo) - 1, 1).toLocaleString('en-GB', { month: 'long' })
      return y === String(pivotEnd || '').slice(0, 4) ? name : `${name} ${y}`
    }
    if (list.length === 0) return { label: '', full: '' }
    if (list.length === 1) return { label: named(list[0]), full: named(list[0]) }
    return { label: 'Other months', full: list.map(named).join(', ') }
  }, [outOfRangeTankers, pivotEnd])

  // Shared row markup for the tanker list — used for both the in-range table
  // and the out-of-range one below it, so the two stay visually identical.
  function renderTankerRow(row: Row): React.JSX.Element {
    const next = nextTankerStage(row.status)
    // Compact rows: the handoff drew these at 72px, but with three lines of
    // detail in the first cell they were already tall enough — the extra
    // padding just cost a tanker or two off the visible list.
    return <TableRow key={row.id} className={cn(__WEB__ && '[&>td]:!py-2')}>
      <TableCell><div className={cn('font-medium', __WEB__ && '!text-[13px] !font-extrabold !text-[#0A1F17]', !String(row.tanker_no || '').trim() && 'italic text-muted-foreground')}>{String(row.tanker_no || '').trim() || 'No number yet'}</div><div className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-0.5 !whitespace-nowrap !text-[11.5px] !font-semibold !text-[#5A6B62]')}>{row.status === 'supplier_factory' ? `Entered ${formatDate(row.loaded_date)}` : `Loaded ${formatDate(row.loaded_date)}`}</div>{!!row.gate_entry_no && (
          <div className={cn('mt-0.5 text-[11px] text-sky-700', __WEB__ && '!text-[11.5px] !font-semibold !text-[#1B4E82]')}>
            Gate {row.gate_entry_no}
            {row.gate_tanker_no && String(row.gate_tanker_no).trim() !== String(row.tanker_no || '').trim()
              ? ` · vehicle ${row.gate_tanker_no}`
              : ''}
            {Number(row.gate_qty) > 0 ? ` · weighed ${formatNum(row.gate_qty)}` : ''}
          </div>
        )}{!!row.last_replacement && (
          <div className={cn('mt-0.5 text-[11px] text-amber-700', __WEB__ && '!text-[11.5px] !font-semibold !text-[#8A5300]')} title="Tanker replaced en route">
            Replaced: {row.last_replacement}
          </div>
        )}</TableCell>
      <TableCell>
        <div className={cn(__WEB__ && 'text-[13px] font-extrabold text-[#0B3D2E]')}>{row.supplier_name}</div>
        <div className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#33473E]')}>
          {row.bargain_no}
          {row.extra_bargain_no && (
            <span title={`Split: ${formatNum((Number(row.loaded_qty) || 0) - (Number(row.extra_qty) || 0))} ${row.uom} + ${formatNum(row.extra_qty)} ${row.uom} excess`}>
              {' '}+ {row.extra_bargain_no} <span className="text-sky-600">(split)</span>
            </span>
          )}
        </div>
      </TableCell>
      {/* Loaded qty, payment and invoice all say the same thing when they are
          empty: this step has not happened yet. So an unfilled one steps back
          to grey rather than shouting in the same weight as a real figure. */}
      <TableCell
        className={cn(
          'text-right tabular-nums',
          __WEB__ && (Number(row.loaded_qty) > 0 ? '!text-[13.5px] !font-bold' : '!text-[13.5px] !text-[#A8B8AE]')
        )}
      >
        {Number(row.loaded_qty) > 0 ? `${formatNum(row.loaded_qty)} ${row.uom}` : 'Not loaded'}
      </TableCell>
      <TableCell>{row.payment_mode === 'pending' ? <span className={cn('text-muted-foreground', __WEB__ && '!text-[11px] !font-extrabold !text-[#A8B8AE]')}>Not decided</span> : row.payment_mode === 'supplier_finance' ? <Badge variant="warning" className={cn(__WEB__ && '!whitespace-nowrap !rounded-[2px] !border-0 !bg-[#FFEDD0] !px-2 !py-1 !text-[11px] !font-extrabold !tracking-[.03em] !text-[#8A5300]')}>Supplier financed</Badge> : <Badge variant="muted" className={cn(__WEB__ && '!whitespace-nowrap !rounded-[2px] !border-0 !bg-[#EAF0E9] !px-2 !py-1 !text-[11px] !font-extrabold !tracking-[.03em] !text-[#33473E]')}>Paid by us</Badge>}</TableCell>
      <TableCell className={cn(__WEB__ && (row.invoice_no ? '!whitespace-nowrap !text-[12.5px] !font-bold' : ''))}>
        {row.invoice_no || <span className={cn('text-muted-foreground', __WEB__ && '!text-[12.5px] !text-[#A8B8AE]')}>Not entered</span>}
      </TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
        {(() => {
          const d = tankerDelay(row)
          if (!d) return null
          if (!__WEB__) return <div className={cn('mt-1 text-[11px] font-medium', d.tone)}>{d.label}</div>
          return (
            <div className="mt-1">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-extrabold tracking-[.01em]',
                  ETA_TONE[d.kind]
                )}
              >
                {d.kind === 'late' ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : d.kind === 'good' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                )}
                {d.kind === 'eta' ? (
                  <>
                    {/* The word is the label, the date and the count are the
                        answer — so the label steps back a shade rather than
                        being set in a different hue, which would have made
                        three colours out of one line. */}
                    <span className="font-bold opacity-70">ETA</span>
                    <span className="doc-ref">{formatDate(d.eta || '')}</span>
                    {/* How many days that is — the date alone makes you count,
                        and counting is the whole question. */}
                    <span>· {d.inDays}d</span>
                  </>
                ) : (
                  d.label
                )}
              </span>
            </div>
          )
        })()}
      </TableCell>
      {/* Moving the tanker on is the only action worth a real button — undo,
          edit, replace and delete all sit behind the ⋮, which keeps this
          column narrow and gives the table's own data the width. */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {next && (
            <Button
              size="sm"
              variant="outline"
              className={cn(
                // The one action on the row that moves the tanker on. The
                // handoff fills it forest/lime, but repeated down every row
                // that turns the Action column into a wall of dark blocks —
                // so it wears a light green tint instead, which still reads
                // as the row's one button without shouting over the data.
                __WEB__ && '!h-[30px] !gap-1.5 !rounded-[3px] !border-[#BFE3CB] !bg-[#E9F5EE] !px-2.5 !text-[11.5px] !font-extrabold !tracking-[.02em] !text-[#0B6B45] hover:!bg-[#DCEFE4] hover:!text-[#0B3D2E]'
              )}
              onClick={() => openTankerAction(row)}
            >
              {__WEB__ && <ArrowRight className="h-4 w-4" />}
              {TANKER_LABEL[next]}
            </Button>
          )}
          <RowActions
            actions={[
              { label: 'View tanker', icon: Eye, onClick: () => setViewTankerRow(row) },
              ...(TANKER_STAGES.indexOf(String(row.status)) > TANKER_STAGES.indexOf('loaded')
                ? [{
                    label: `Undo — back to ${TANKER_LABEL[TANKER_STAGES[TANKER_STAGES.indexOf(String(row.status)) - 1]]}`,
                    icon: Undo2,
                    onClick: () => void revertTanker(row)
                  }]
                : []),
              { label: 'Edit stage entries', icon: Pencil, onClick: () => openEditTanker(row) },
              ...(row.status === 'transit'
                ? [{ label: 'Replace tanker', icon: Truck, onClick: () => openReplaceTanker(row) }]
                : []),
              {
                label: 'Delete tanker',
                icon: Trash2,
                danger: true,
                onClick: () => void deleteTanker(row),
                disabled: !!row.order_id,
                disabledReason: 'Billed on a purchase invoice — delete that invoice first'
              }
            ]}
          />
        </div>
      </TableCell>
    </TableRow>
  }

  function tankerTableHeader(): React.JSX.Element {
    // One rule for all seven headings on the website — the handoff's
    // #EAF0E9 strip in wide-tracked small caps. Drawn tighter than the
    // handoff's 40px: these headings repeat above every group card, so the
    // height is paid several times down the page.
    const th = cn(
      'text-[10px] font-semibold uppercase tracking-wide',
      __WEB__ && '!h-[30px] !py-0 !text-[10px] !font-extrabold !tracking-[.08em] !text-[#33473E]'
    )
    return <TableHeader><TableRow className={cn('bg-muted/60', __WEB__ && '!border-b-[#D6E2D6] !bg-[#EAF0E9] hover:!bg-[#EAF0E9]')}>
      <TableHead className={th}>Tanker</TableHead><TableHead className={th}>Supplier / bargain</TableHead><TableHead className={cn(th, 'text-right')}>Loaded qty</TableHead>
      <TableHead className={th}>Payment</TableHead><TableHead className={th}>Invoice</TableHead><TableHead className={th}>Stage</TableHead><TableHead className={cn(th, 'text-right')}>Action</TableHead>
    </TableRow></TableHeader>
  }
  // A tanker's governing EX/DLD condition — its own choice when one was made
  // when it was sent to the supplier, otherwise its bargain's. Mirrors
  // tankerIsEx() in the backend, which is what actually posts the freight and
  // the shortage penalty.
  function condIsEx(t: Row): boolean {
    const own = String(t.condition ?? '').trim().toUpperCase()
    if (own) return own !== 'DLD' && own !== 'DELIVERED'
    return !['DLD', 'DELIVERED'].includes(String(t.bargain_type || '').toUpperCase())
  }

  // What to show as the invoice's condition. A tanker-based purchase is
  // governed per tanker, so it's read off the tankers rather than off the
  // invoice's own frozen bargain_type — that copy is taken when the invoice is
  // booked and can end up disagreeing with the bargain it points at.
  function invoiceCondition(row: Row): string {
    const list = tankers.filter((t) => Number(t.order_id) === Number(row.id))
    if (!list.length) {
      return ['DLD', 'DELIVERED'].includes(String(row.bargain_type || '').toUpperCase())
        ? 'DLD — delivered'
        : 'EX — ex-works'
    }
    const ex = list.filter((t) => condIsEx(t)).length
    if (ex === list.length) return 'EX — ex-works'
    if (ex === 0) return 'DLD — delivered'
    return `Mixed — ${ex} EX, ${list.length - ex} DLD`
  }

  // Purchase entries filters: a date range on the invoice date, and the product
  // category. Both narrow the list the page shows and exports.
  const [poFrom, setPoFrom] = useState('')
  const [poTo, setPoTo] = useState('')
  // Free text over the entries register. Sits with the date and category
  // rules rather than after the column filters, so the column dropdowns
  // offer values from what the search left — the same way they already
  // narrow to what the date range left.
  const [poSearch, setPoSearch] = useState('')
  // Empty = every category.
  const [poCategory, setPoCategory] = useState<string[]>([])
  // ON by default: also pull in a purchase whose invoice date is outside the
  // window but a tanker on it was received inside it. Switching it off goes
  // back to strictly the invoice date.
  const [poIncludeReceipt, setPoIncludeReceipt] = useState(true)
  // Excel-style per-column filters on the Purchase entries table. Empty = that
  // column isn't filtering. Keyed by the column's own field so one state object
  // covers every column instead of a useState each.
  const [poCols, setPoCols] = useState<Record<string, string[]>>({})
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (!globalRangeAppliesTo(globalRange, 'orders')) return
    setPoFrom(globalRange.from); setPoTo(globalRange.to)
    setRepFrom(globalRange.from); setRepTo(globalRange.to)
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const poCategories = useMemo(
    () => Array.from(new Set(rows.map((r) => String(r.product_category || '')).filter(Boolean))).sort(),
    [rows]
  )
  // The Purchase entries columns that carry an Excel-style header filter, and
  // how each one reads its value off a row. Money/quantity columns format the
  // same way the cell does, so the dropdown lists exactly what's on screen.
  // The deductible on one tanker: shortage beyond the agreed tolerance, valued
  // at the tanker's own bargain rate. Computed live rather than read from the
  // stored shortage_charge_amount, because that column is only written when a
  // tanker is emptied through the current code path — tankers emptied earlier
  // carry 0 and would silently read as "nothing to deduct".
  //
  // Shared by the invoice View and the Purchases list so the two can never
  // disagree: the list used to read the stored figure while the View computed
  // it, which is exactly how a purchase could show a deductible in its detail
  // and an unflagged EX chip in the table.
  function tankerDeduct(t: Row, orderRow: Row): {
    t: Row
    loaded: number
    rec: number | null
    shortage: number | null
    allowedAmt: number
    deductible: number | null
    extraQty: number
    primaryQty: number
    primaryRate: number
    extraRate: number
    bargainRate: number
    deductibleValue: number | null
  } {
    const loaded = Number(t.loaded_qty) || 0
    const rec = t.status === 'empty' && t.received_qty != null ? Number(t.received_qty) : null
    const shortage = rec != null ? Math.max(0, loaded - rec) : null
    // Per tanker, matching the backend: its own EX/DLD choice when one was
    // made, else its bargain's. Deliberately NOT the invoice's frozen
    // bargain_type, which can disagree with the bargain it points at.
    const rowIsEx = condIsEx(t)
    // An order- or bargain-specific override wins if set, otherwise the
    // company-wide default — NOT a bare 0%, which would flag any shortage at
    // all as deductible whenever neither override was set.
    const pct = Number(
      t.order_allowed_shortage_pct ?? orderRow.allowed_shortage_pct ?? t.allowed_shortage_pct ?? settings.allowed_shortage_pct ?? 0
    )
    const allowedAmt = loaded > 0 ? (loaded * pct) / 100 : 0
    const deductible = rowIsEx && shortage != null && shortage > allowedAmt ? shortage - allowedAmt : null
    // Priced at the tanker's own bargain rate, not the invoice rate. A tanker
    // split across two bargains blends both by the qty each carries, so the
    // second bargain's rate is not silently dropped.
    const extraQty = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
    const primaryQty = Math.max(0, loaded - extraQty)
    const primaryRate = Number(t.bargain_rate) || 0
    const extraRate = Number(t.extra_bargain_rate) || 0
    const bargainRate = loaded > 0 ? (primaryQty * primaryRate + extraQty * extraRate) / loaded : primaryRate
    return {
      t, loaded, rec, shortage, allowedAmt, deductible,
      extraQty, primaryQty, primaryRate, extraRate, bargainRate,
      deductibleValue: deductible != null ? deductible * bargainRate : null
    }
  }

  // Summed across an invoice's tankers.
  function orderDeductValue(r: Row): number {
    return tankers
      .filter((t) => Number(t.order_id) === Number(r.id))
      .reduce((sum, t) => sum + (tankerDeduct(t, r).deductibleValue ?? 0), 0)
  }

  // Freight on a purchase, and the part of it to be taken back by debit note.
  // Two figures only: what the transporter earned, and what comes off it for
  // the shortage beyond tolerance. The netting itself is unchanged — the ledger
  // already carries freight less shortage — so this is the paperwork view of the
  // same deduction.
  // Who carried this invoice and at what rate. Per tanker, because every
  // vehicle is priced on its own rate.
  function poCarriers(r: Row): { tanker: string; name: string; rate: number }[] {
    return tankers
      .filter((t) => Number(t.order_id) === Number(r.id))
      .map((t) => ({
        tanker: String(t.tanker_no || ''),
        name: String(t.transporter_name || ''),
        rate: Number(t.transport_rate_per_ton) || 0
      }))
  }

  function poFreight(r: Row): { freight: number; deduct: number } {
    return {
      freight: Math.round((Number(r.tanker_freight_total) || 0) * 100) / 100,
      deduct: Math.round(orderDeductValue(r) * 100) / 100
    }
  }

  const PO_COLUMNS: { key: string; label: string; of: (r: Row) => string }[] = useMemo(
    () => [
      { key: 'invoice_no', label: 'Invoice', of: (r) => String(r.invoice_no || '') },
      { key: 'supplier_name', label: 'Supplier', of: (r) => String(r.supplier_name || '') },
      { key: 'product_category', label: 'Category', of: (r) => String(r.product_category || '') },
      { key: 'oil_label', label: 'Product', of: (r) => String(r.oil_code || r.oil_name || '') },
      { key: 'tanker_count', label: 'Tankers', of: (r) => String(Number(r.tanker_count) || 0) },
      { key: 'ordered_qty', label: 'Quantity', of: (r) => `${formatNum(r.ordered_qty)} ${r.uom || ''}`.trim() },
      { key: 'net_amount', label: 'Net amount', of: (r) => formatINR(r.net_amount) },
      {
        // Matches exactly what the cell shows — the condition, flagged when a
        // debit note is due. A filter offering values the column never displays
        // hides rows that visibly say otherwise.
        key: 'shortage',
        label: 'Freight',
        of: (r) => {
          const cond = invoiceCondition(r).split(' — ')[0].split(' ')[0]
          return Number(r.tanker_shortage_charged) > 0 ? `${cond} · Dr note due` : cond
        }
      },
      { key: 'status', label: 'Status', of: (r) => (r.status === 'received' ? 'Completed' : 'In process') }
    ],
    // The Freight column reads the tankers behind each invoice, so the memo has
    // to rebuild when they load — otherwise the dropdown offers a condition
    // worked out from an empty tanker list while the cell shows the real one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tankers]
  )

  // Rows that pass every filter EXCEPT this column's own — so each dropdown
  // lists the values still reachable given the other filters, the way Excel
  // narrows its lists, instead of always offering the whole table.
  function poColOptions(key: string): { value: string; label: string; count: number }[] {
    const col = PO_COLUMNS.find((c) => c.key === key)
    if (!col) return []
    // Counted, not just collected — the panel shows how many rows sit behind
    // each value, and the walk that finds the values is already doing the work.
    const seen = new Map<string, number>()
    for (const r of poBaseRows) {
      let ok = true
      for (const other of PO_COLUMNS) {
        if (other.key === key) continue
        const sel = poCols[other.key]
        if (sel?.length && !sel.includes(other.of(r))) { ok = false; break }
      }
      if (ok) {
        const v = col.of(r)
        seen.set(v, (seen.get(v) || 0) + 1)
      }
    }
    return Array.from(seen.keys())
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((v) => ({ value: v, label: v || '(blank)', count: seen.get(v) || 0 }))
  }

  // Everything the date/category/trading rules allow — the pool the column
  // filters then narrow, and the pool their dropdowns are built from.
  const poTerms = useMemo(
    () => poSearch.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [poSearch]
  )

  // Bargain numbers by invoice. The order row carries none of its own — a
  // purchase reaches its bargain through its tankers — so the search box could
  // not find an invoice by the one number a supplier is most likely to quote.
  //
  // Built once here rather than scanned per row: this register holds hundreds
  // of invoices and hundreds of tankers, and matching inside the filter would
  // be a full pass over the second for every one of the first.
  const bargainNoByOrder = useMemo(() => {
    const m = new Map<number, string>()
    for (const t of tankers) {
      const oid = Number(t.order_id)
      if (!oid) continue
      const nos = [String(t.bargain_no || ''), String(t.extra_bargain_no || '')].filter(Boolean)
      if (!nos.length) continue
      m.set(oid, `${m.get(oid) || ''} ${nos.join(' ')}`.trim())
    }
    return m
  }, [tankers])

  const poBaseRows = useMemo(
    () =>
      rows
        .map((r): Row => {
          const d = String(r.order_date || '').slice(0, 10)
          const invoicedInRange = (!poFrom || d >= poFrom) && (!poTo || d <= poTo)
          // The invoice date alone can sit days before the tanker actually
          // arrives and gets weighed — so a purchase also belongs to the
          // window if any of its tankers was RECEIVED (reached Empty) inside
          // it, even when the invoice itself was raised outside the range.
          const receivedInRange =
            poIncludeReceipt &&
            !invoicedInRange &&
            tankers.some((t) => {
              if (Number(t.order_id) !== Number(r.id)) return false
              const rd = String(t.empty_date || '').slice(0, 10)
              if (!rd) return false
              if (poFrom && rd < poFrom) return false
              if (poTo && rd > poTo) return false
              return true
            })
          return { ...r, _shownForReceipt: receivedInRange, _inWindow: invoicedInRange || receivedInRange }
        })
        .filter((r) => {
          if (!r._inWindow) return false
          // Trading is a pass-through deal booked and tracked on its own page —
          // it never touches this supplier's regular purchase relationship, so
          // it does not belong in this register.
          if (Number(r.is_trading) === 1) return false
          if (poCategory.length && !poCategory.includes(String(r.product_category || ''))) return false
          if (poTerms.length) {
            const hay = [
              r.invoice_no,
              r.supplier_name,
              r.oil_code,
              r.oil_name,
              r.product_category,
              r.tanker_nos,
              bargainNoByOrder.get(Number(r.id)) || ''
            ]
              .join(' ')
              .toLowerCase()
            // Every term has to match somewhere, so "deepchand 510" narrows
            // instead of widening — the way anyone types two things they
            // remember about an invoice.
            if (!poTerms.every((t) => hay.includes(t))) return false
          }
          return true
        }),
    [rows, tankers, poFrom, poTo, poCategory, poIncludeReceipt, poTerms, bargainNoByOrder]
  )

  const filteredOrders = useMemo(
    () =>
      poBaseRows.filter((r) =>
        PO_COLUMNS.every((c) => {
          const sel = poCols[c.key]
          return !sel?.length || sel.includes(c.of(r))
        })
      ),
    [poBaseRows, poCols, PO_COLUMNS]
  )
  const orderPaged = usePaged(filteredOrders)

  // Row fields derived from a bargain (auto or manual pick).
  function bargainDefaults(b: Row): Row {
    return {
      bargain_id: b.id,
      supplier_id: b.supplier_id,
      oil_type_id: b.oil_type_id,
      supplier_name: b.supplier_name,
      oil_label: String(b.oil_code || b.oil_name || ''),
      uom: b.uom,
      balance_qty: b.balance_qty,
      // default the condition (EX/DLD) from the bargain; user can toggle it
      condition: ['DLD', 'Delivered'].includes(String(b.bargain_type)) ? 'DLD' : 'EX'
    }
  }

  function selectLoadingBargain(index: number, id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    setLoadingRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...bargainDefaults(b) } : row))
    )
  }

  // Distinct oils that actually have bargains (route step 1).
  const bargainOils = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bargains) {
      const id = String(b.oil_type_id)
      if (!m.has(id)) m.set(id, String(b.oil_code || b.oil_name || '—'))
    }
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [bargains])

  // Suppliers with bargains for the picked oil (route step 2). Suppliers marked
  // "Direct purchase" in the master never receive a tanker, so they are left out.
  function suppliersForOil(oilId: string): { id: string; name: string }[] {
    const m = new Map<string, string>()
    const direct = new Set(
      suppliers.filter((s) => s.skip_tanker_stages).map((s) => String(s.id))
    )
    for (const b of bargains.filter((x) => String(x.oil_type_id) === oilId)) {
      if (direct.has(String(b.supplier_id))) continue
      m.set(String(b.supplier_id), String(b.supplier_name || '—'))
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // Bargains matching the dialog-level oil + supplier picks, oldest first.
  function routeBargains(picks: Row): Row[] {
    if (!picks.oil_pick || !picks.supplier_pick) return []
    return bargains
      .filter((b) => String(b.oil_type_id) === picks.oil_pick && String(b.supplier_id) === picks.supplier_pick)
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }

  // Oil picked once for the whole dialog — reset supplier and row bargains.
  function pickOil(oilId: string): void {
    setLoadingForm((p) => ({ ...p, oil_pick: oilId, supplier_pick: '', auto_bargain_id: '' }))
    setLoadingRows((current) =>
      current.map((row) => ({ ...row, bargain_id: '', supplier_name: '', balance_qty: undefined }))
    )
  }

  // Supplier picked once — auto-select the OLDEST bargain (preferring balance
  // left) and apply it to every tanker row; each row stays changeable.
  function pickSupplier(supplierId: string): void {
    const candidates = routeBargains({ oil_pick: loadingForm.oil_pick, supplier_pick: supplierId })
    const pick = candidates.find((b) => Number(b.balance_qty) > 0.005) || candidates[0]
    setLoadingForm((p) => ({ ...p, supplier_pick: supplierId, auto_bargain_id: pick ? String(pick.id) : '' }))
    if (pick) {
      setLoadingRows((current) => current.map((row) => ({ ...row, ...bargainDefaults(pick) })))
    }
  }

  function setTankerCount(value: string): void {
    const count = Math.max(1, Math.min(20, Number(value) || 1))
    // new rows inherit the dialog's auto-picked bargain
    const auto = bargains.find((b) => String(b.id) === String(loadingForm.auto_bargain_id))
    setLoadingForm((p) => ({ ...p, tanker_count: count }))
    setLoadingRows((current) =>
      Array.from({ length: count }, (_, i) => current[i] || (auto ? bargainDefaults(auto) : {}))
    )
  }

  async function createTanker(): Promise<void> {
    if (loadingRows.some((row) => !row.bargain_id)) {
      toast.error('Select the bargain for every tanker (the tanker number can be set at loading)')
      return
    }
    try {
      for (const row of loadingRows) {
        await window.api.tankers.create({
          ...row,
          condition: row.condition || 'EX',
          transporter_id: row.transporter_id ? Number(row.transporter_id) : null,
          factory_entry_date: loadingForm.factory_entry_date
        })
      }
      toast.success(`${loadingRows.length} tanker${loadingRows.length === 1 ? '' : 's'} sent to supplier — ready to be loaded`)
      setLoadingOpen(false)
      setLoadingForm({ tanker_count: 1, factory_entry_date: todayISO() })
      setLoadingRows([{}])
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function deleteTanker(row: Row): Promise<void> {
    if (!window.confirm(`Delete tanker ${row.tanker_no}?`)) return
    try {
      await window.api.tankers.remove(row.id)
      toast.success('Tanker deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openTankerAction(row: Row): void {
    const target = nextTankerStage(row.status)
    if (!target) return
    // Invoice gate: after loading, billing is mandatory before moving further.
    if (target === 'outside_factory' && !row.order_id) {
      toast.error(`Tanker ${row.tanker_no} is not billed yet — create the purchase invoice first`)
      return
    }
    const next: Row = {}
    if (target === 'loaded') Object.assign(next, {
      loaded_date: todayISO(),
      loaded_qty: '',
      payment_mode: 'paid_by_us',
      source_id: row.source_id ? String(row.source_id) : '',
      tanker_no: String(row.tanker_no || ''),
      bargain_id: String(row.bargain_id || '')
    })
    if (target === 'transit')
      Object.assign(next, {
        transit_date: todayISO(),
        // Whatever was picked at loading, so this step confirms rather than asks
        // again — and an untouched field can no longer blank it.
        source_id: row.source_id ? String(row.source_id) : '',
        transporter_id: row.transporter_id ? String(row.transporter_id) : '',
        // Whatever is already on the tanker wins; otherwise the transporter
        // master's default rate, so the common case is one keystroke.
        transport_rate_per_ton:
          row.transport_rate_per_ton ??
          transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton ??
          ''
      })
    if (target === 'outside_factory') next.outside_factory_date = todayISO()
    if (target === 'inside_factory') next.inside_factory_date = todayISO()
    if (target === 'empty') Object.assign(next, {
      empty_date: todayISO(),
      // prefill with the gate-received qty so the gate cross-check passes
      received_qty: gateQtyFor(row.id) ?? row.loaded_qty,
      transporter_id: row.transporter_id || '',
      // What was agreed when the tanker set off wins. Only fall back to the
      // transporter master's default for a tanker that reached transit before
      // the rate was asked for there — otherwise this asked again from blank
      // and the freight came out at zero.
      transport_rate_per_ton:
        Number(row.transport_rate_per_ton) > 0
          ? row.transport_rate_per_ton
          : transporters.find((x) => x.id === row.transporter_id)?.default_rate_per_ton || ''
    })
    setActionForm(next)
    setExcess(null)
    setActionRow(row)
  }

  // Step a tanker BACK one stage (mistake correction, e.g. Outside factory
  // pressed too early). The abandoned stage's date is cleared server-side.
  async function revertTanker(row: Row): Promise<void> {
    const idx = TANKER_STAGES.indexOf(String(row.status))
    const prev = idx > 0 ? TANKER_STAGES[idx - 1] : null
    if (!prev) return
    if (!confirm(`Move tanker ${row.tanker_no || ''} back from ${TANKER_LABEL[String(row.status)]} to ${TANKER_LABEL[prev]}?`)) return
    try {
      await window.api.tankers.revert(Number(row.id))
      toast.success(`Back to ${TANKER_LABEL[prev]}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Swap the physical vehicle mid-transit (accident, breakdown) — the bargain
  // and financials on this tanker stay put, only the number changes and
  // whatever quantity was lost comes off what it's now expected to deliver.
  const [replaceRow, setReplaceRow] = useState<Row | null>(null)
  const [replaceForm, setReplaceForm] = useState<Row>({})
  const [replaceSaving, setReplaceSaving] = useState(false)
  const [replaceError, setReplaceError] = useState<string | null>(null)

  function openReplaceTanker(row: Row): void {
    setReplaceRow(row)
    setReplaceForm({ new_tanker_no: '', loss_qty: '', reason: '', date: todayISO() })
    setReplaceError(null)
  }

  async function saveReplaceTanker(): Promise<void> {
    if (!replaceRow) return
    if (!String(replaceForm.new_tanker_no || '').trim()) return setReplaceError('Enter the replacement tanker number')
    setReplaceSaving(true)
    setReplaceError(null)
    try {
      await window.api.tankers.replace(Number(replaceRow.id), {
        new_tanker_no: replaceForm.new_tanker_no,
        loss_qty: Number(replaceForm.loss_qty) || 0,
        reason: replaceForm.reason || null,
        date: replaceForm.date || todayISO()
      })
      toast.success(`Tanker replaced with ${replaceForm.new_tanker_no}`)
      setReplaceRow(null)
      load()
    } catch (e) {
      setReplaceError((e as Error).message)
    } finally {
      setReplaceSaving(false)
    }
  }

  // Freight typed on the invoice's own tanker list. Held per tanker id while
  // it is being typed, then written through the SAME backend call the tanker
  // dialog saves with — so every guard it carries still applies (the bargain
  // balance, the gate weighment match, and the transporter-ledger re-post once
  // a tanker is emptied). Nothing is written unless the number changed.
  const [tdsOpen, setTdsOpen] = useState(false)
  const [freightDraft, setFreightDraft] = useState<Record<string, string>>({})
  const [freightSaving, setFreightSaving] = useState('')

  async function saveFreightRate(t: Row): Promise<void> {
    const key = String(t.id)
    const typed = freightDraft[key]
    if (typed === undefined) return
    const drop = (): void =>
      setFreightDraft((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    const want = typed === '' ? 0 : Number(typed)
    if (!Number.isFinite(want)) return
    if (Math.abs(want - (Number(t.transport_rate_per_ton) || 0)) < 1e-9) {
      drop()
      return
    }
    setFreightSaving(key)
    try {
      await window.api.tankers.update(Number(t.id), { transport_rate_per_ton: want })
      drop()
      await load()
      toast.success(
        `Freight on ${t.tanker_no || 'the tanker'} set to ${formatINR(want)}/${t.uom || 'MT'}`
      )
    } catch (e) {
      // What was typed STAYS in the box on a failure, so nothing is lost and
      // the reason is on screen. The entry window refuses an edit whose tanker
      // was loaded outside it, and that is worth reading rather than being
      // silently reverted to the old rate.
      toast.error((e as Error).message)
    } finally {
      setFreightSaving('')
    }
  }

  function openEditTanker(row: Row): void {
    setEditTanker(row)
    setEditTankerForm({
      tanker_no: row.tanker_no || '',
      bargain_id: String(row.bargain_id || ''),
      loaded_date: row.loaded_date || '',
      loaded_qty: row.loaded_qty ?? '',
      payment_mode: row.payment_mode || 'pending',
      transit_date: row.transit_date || '',
      source_id: row.source_id ? String(row.source_id) : '',
      outside_factory_date: row.outside_factory_date || '',
      inside_factory_date: row.inside_factory_date || '',
      empty_date: row.empty_date || '',
      received_qty: row.received_qty ?? '',
      transporter_id: row.transporter_id ? String(row.transporter_id) : '',
      transport_rate_per_ton: row.transport_rate_per_ton ?? '',
      krfl_weighment_doc_no: row.krfl_weighment_doc_no || '',
      outside_weighment_doc_no: row.outside_weighment_doc_no || '',
      // Blank = follow the bargain, which is what an un-overridden tanker does.
      condition: row.condition || ''
    })
  }

  // Within the 1 MT gate buffer a shortfall is allowed, but only after the user
  // explicitly confirms the variance. Returns false when the user backs out.
  function confirmGateVariance(tankerId: unknown, receivedQty: number): boolean {
    const gq = gateQtyFor(tankerId)
    if (gq == null || !(receivedQty > 0)) return true
    const diff = Math.abs(gq - receivedQty)
    if (diff <= 0.005 || diff > 1) return true // exact match, or blocked by the backend anyway
    return window.confirm(
      `Received qty (${formatNum(receivedQty)}) differs from the gate weighment (${formatNum(gq)}) by ${formatNum(diff)} MT.\n\nThis is within the allowed 1 MT buffer — save anyway?`
    )
  }

  async function saveEditTanker(): Promise<void> {
    if (!editTanker) return
    const recv = Number(editTankerForm.received_qty)
    if (recv > 0 && !confirmGateVariance(editTanker.id, recv)) return
    try {
      await window.api.tankers.update(editTanker.id, {
        ...editTankerForm,
        bargain_id: editTankerForm.bargain_id ? Number(editTankerForm.bargain_id) : null,
        source_id: editTankerForm.source_id ? Number(editTankerForm.source_id) : null,
        transporter_id: editTankerForm.transporter_id ? Number(editTankerForm.transporter_id) : null
      })
      toast.success('Tanker updated')
      setEditTanker(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const [photoBusy, setPhotoBusy] = useState('')

  // The technical readings, on their own panel.
  //
  // They used to live at the bottom of the Empty form, which is the wrong
  // moment for them: the tanker is being received, the gate figure is being
  // checked and the shortage settled, and a lab result that may not be back
  // yet was sitting in the middle of it — so it was skipped, and there was
  // nothing anywhere afterwards to say it had been. On the register it can be
  // seen missing and filled in whenever the sample comes back.
  const [qualityFor, setQualityFor] = useState<Row | null>(null)
  // One block of readings per tanker on the invoice that has reached Empty.
  const [qualitySets, setQualitySets] = useState<{ tanker: Row; rows: Row[] }[]>([])
  const [qualityBusy, setQualityBusy] = useState(false)

  async function openQuality(order: Row): Promise<void> {
    setQualityFor(order)
    setQualitySets([])
    const emptied = tankersForBooking.filter(
      (t) => Number(t.order_id) === Number(order.id) && String(t.status) === 'empty'
    )
    // No tanker at all — a consignment invoice — so the readings belong to the
    // invoice itself. One block, labelled as such.
    if (!emptied.length && !Number(order.tanker_count) && String(order.status) === 'received') {
      const saved = await window.api.orderQuality.list(Number(order.id)).catch(() => [] as Row[])
      setQualitySets([
        {
          tanker: { id: 0, order_level: true, tanker_no: 'This invoice', received_qty: order.ordered_qty, uom: order.uom },
          rows: saved.length
            ? // unit_touched on a SAVED row: the unit it was stored with is a
              // deliberate answer, so renaming the reading afterwards must not
              // let the name-guess quietly overwrite it.
              saved.map((q: Row) => ({
                name: String(q.name || ''),
                value: String(q.value ?? ''),
                unit: q.unit == null ? '%' : String(q.unit),
                unit_touched: true
              }))
            : // A fresh sheet takes the guess for each default parameter, so
              // Melting point already reads in degrees before anyone types.
              TANKER_QUALITY_DEFAULTS.map((name) => ({ name, value: '', unit: guessUnit(name) }))
        }
      ])
      return
    }
    const sets = await Promise.all(
      emptied.map(async (t) => {
        const saved = await window.api.tankers.quality(Number(t.id)).catch(() => [] as Row[])
        return {
          tanker: t,
          rows: saved.length
            ? // unit_touched on a SAVED row: the unit it was stored with is a
              // deliberate answer, so renaming the reading afterwards must not
              // let the name-guess quietly overwrite it.
              saved.map((q: Row) => ({
                name: String(q.name || ''),
                value: String(q.value ?? ''),
                unit: q.unit == null ? '%' : String(q.unit),
                unit_touched: true
              }))
            : // A fresh sheet takes the guess for each default parameter, so
              // Melting point already reads in degrees before anyone types.
              TANKER_QUALITY_DEFAULTS.map((name) => ({ name, value: '', unit: guessUnit(name) }))
        }
      })
    )
    setQualitySets(sets)
  }

  function setQualityRow(si: number, ri: number, patch: Row): void {
    // Typing "Melting point" proposes °C, "Colour" proposes a bare figure.
    // A guess, not a rule — and abandoned the moment the desk picks a unit
    // itself, so renaming a reading afterwards cannot undo that choice.
    if (patch.name !== undefined) {
      setQualitySets((prev) =>
        prev.map((x, i) =>
          i === si
            ? {
                ...x,
                rows: x.rows.map((r: Row, j: number) =>
                  j === ri && !r.unit_touched ? { ...r, unit: guessUnit(String(patch.name)) } : r
                )
              }
            : x
        )
      )
    }
    setQualitySets((p) =>
      p.map((set, i) => (i === si ? { ...set, rows: set.rows.map((r, j) => (j === ri ? { ...r, ...patch } : r)) } : set))
    )
  }

  async function saveQuality(): Promise<void> {
    if (!qualityFor) return
    setQualityBusy(true)
    try {
      for (const set of qualitySets) {
        if (set.tanker.order_level) await window.api.orderQuality.save(Number(qualityFor.id), set.rows)
        else await window.api.tankers.saveQuality(Number(set.tanker.id), set.rows)
      }
      setQualityFor(null)
      await load()
      toast.success(qualitySets.length === 1 ? 'Readings saved' : `Readings saved for ${qualitySets.length} tankers`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setQualityBusy(false)
    }
  }

  async function onWeighmentPhoto(field: string, file: File | undefined): Promise<void> {
    if (!file) return
    // The control checks too, so this can only be reached by a caller that
    // skipped it — but a size limit that lives in one place only is a size
    // limit waiting to be bypassed.
    const problem = checkPhoto(file)
    if (problem) {
      toast.error(problem)
      return
    }
    setPhotoBusy(field)
    try {
      const url = await fileToCompressedDataUrl(file)
      setActionForm((p) => ({ ...p, [field]: url }))
      // What it came in at and what is actually kept. A 1.8 MB photo becoming
      // 240 KB is worth saying: it explains why the picture on screen is not
      // the full-resolution one, before somebody reports that as a fault.
      const kept = Math.round((url.length * 3) / 4)
      toast.success(
        `Slip attached — ${prettyBytes(file.size)} photo shrunk to about ${prettyBytes(kept)}.`
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPhotoBusy('')
    }
  }

  async function advanceTanker(): Promise<void> {
    if (!actionRow) return
    const target = nextTankerStage(actionRow.status)
    if (!target) return
    if (target === 'loaded' && !String(actionForm.tanker_no || '').trim()) {
      toast.error('Enter the tanker number')
      return
    }
    if (target === 'loaded' && Number(actionForm.loaded_qty) <= 0) {
      toast.error('Enter the actual loaded quantity')
      return
    }
    if (target === 'transit' && !actionForm.source_id) {
      toast.error('Select the source / port')
      return
    }
    if (target === 'empty' && !confirmGateVariance(actionRow.id, Number(actionForm.received_qty))) {
      return
    }
    if (target === 'empty' && !['DLD', 'Delivered'].includes(String(actionRow.bargain_type)) && !actionForm.transporter_id) {
      toast.error('Select a transporter')
      return
    }
    // More qty on the truck than the bargain has left: pause and ask before
    // booking the excess as a fresh bargain line (rate confirmed by the user).
    if (target === 'loaded' && !excess) {
      const b = bargains.find((x) => String(x.id) === String(actionForm.bargain_id))
      const balance = Math.max(Number(b?.balance_qty) || 0, 0)
      const over = (Number(actionForm.loaded_qty) || 0) - balance
      if (b && over > 1e-6) {
        setExcess({
          qty: Math.round(over * 1000) / 1000,
          balance,
          mode: 'new',
          diffRate: false,
          rate: String(b.rate_per_uom ?? ''),
          targetBargainId: ''
        })
        return
      }
    }
    // Excess allocated to an existing bargain requires that choice.
    if (target === 'loaded' && excess && excess.mode === 'existing' && !excess.targetBargainId) {
      toast.error('Select the next bargain for the excess quantity')
      return
    }
    try {
      await window.api.tankers.advance(actionRow.id, target, {
        ...actionForm,
        loaded_qty: Number(actionForm.loaded_qty) || 0,
        allow_excess: !!excess,
        expand_bargain: !!excess && excess.mode === 'expand',
        excess_rate: excess && excess.mode === 'new' && excess.diffRate && Number(excess.rate) > 0 ? Number(excess.rate) : null,
        extra_bargain_id: excess && excess.mode === 'existing' && excess.targetBargainId ? Number(excess.targetBargainId) : null,
        bargain_id: actionForm.bargain_id ? Number(actionForm.bargain_id) : null,
        source_id: actionForm.source_id ? Number(actionForm.source_id) : null,
        transporter_id: actionForm.transporter_id ? Number(actionForm.transporter_id) : null,
        received_qty: Number(actionForm.received_qty) || 0,
        transport_rate_per_ton: Number(actionForm.transport_rate_per_ton) || 0,
        krfl_weighment_doc_no: actionForm.krfl_weighment_doc_no || null,
        krfl_weighment_photo: actionForm.krfl_weighment_photo || null,
        outside_weighment_doc_no: actionForm.outside_weighment_doc_no || null,
        outside_weighment_photo: actionForm.outside_weighment_photo || null
      })
      if (target === 'loaded' && excess) {
        toast.success(
          excess.mode === 'existing'
            ? `Loading confirmed — extra ${formatNum(excess.qty)} allocated to the selected bargain`
            : excess.mode === 'expand'
              ? `Loading confirmed — bargain increased by ${formatNum(excess.qty)}`
              : `Loading confirmed — extra ${formatNum(excess.qty)} added as a new bargain`
        )
      } else {
        toast.success(target === 'loaded' ? 'Loading confirmed — mark it In transit when it sets off' : `Tanker moved to ${TANKER_LABEL[target]}`)
      }
      setActionRow(null)
      setExcess(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Supplier-first invoice booking: pick the supplier, then choose from ALL its
  // unbilled loaded tankers. The bargain details follow from the chosen tankers.
  function choosePurchaseSupplier(id: string): void {
    const s = suppliers.find((x) => String(x.id) === id)
    if (!s) return
    setForm((p) => ({
      ...p,
      supplier_id: s.id,
      supplier_name: s.name,
      bargain_id: '',
      bargain_type: '',
      bargain_rate: '',
      oil_type_id: '',
      oil_label: '',
      invoice_rate: '',
      invoice_rate_touched: false,
      gst_pct: s.gst_pct ?? 0,
      tds_pct: s.tds_pct ?? 0,
      tds_threshold: s.tds_threshold ?? 0,
      tds_above_only: !!s.tds_above_only,
      adds_interest: !!s.adds_interest,
      interest_pct: s.interest_pct ?? 0,
      interest_days: s.interest_days ?? 0
    }))
    setSelected([])
    setLotIds([])
    setLotBargains({})
    setBgLines([{ bargain_id: '', qty: '' }])
    setBgTouched(false)
  }

  function choosePurchaseBargain(id: string, keepSelection = false): void {
    const b = bargains.find((x) => String(x.id) === id)
    if (!b) return
    const supplier = suppliers.find((x) => x.id === b.supplier_id)
    setForm((p) => ({
      ...p,
      bargain_id: b.id,
      supplier_id: b.supplier_id,
      oil_type_id: b.oil_type_id,
      bargain_type: b.bargain_type,
      bargain_rate: b.rate_per_uom,
      supplier_name: b.supplier_name,
      oil_label: String(b.oil_code || b.oil_name || ''),
      uom: b.uom,
      // follow the bargain's rate unless the user typed one themselves
      invoice_rate: p.invoice_rate_touched && p.invoice_rate ? p.invoice_rate : b.rate_per_uom,
      gst_pct: supplier?.gst_pct ?? 0,
      tds_pct: supplier?.tds_pct ?? 0,
      tds_threshold: supplier?.tds_threshold ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      adds_interest: !!supplier?.adds_interest,
      interest_pct: supplier?.interest_pct ?? 0,
      interest_days: supplier?.interest_days ?? 0
    }))
    if (!keepSelection) setSelected([])
  }

  function openNewPurchase(): void {
    setEditing(null)
    setForm({ company_id: String(activeCompany || ''), invoice_no: '', order_date: todayISO(), is_registered_transporter: true, transporter_id: '', gst_type: 'CGST_SGST', allowed_shortage_pct: '', round_off: '', round_off_manual: false, rate_round_off: '0', charge_interest: false, interest_touched: false, remarks: '', freight_paid_to_supplier: false, bargain_interest: {} })
    setSelected([])
    setLotIds([])
    setLotBargains({})
    setBgLines([{ bargain_id: '', qty: '' }])
    setBgTouched(false)
    setError(null)
    setFormPage(true)
    setTab('purchases')
  }

  // Whatever has been written against the bargains this invoice was drawn
  // against -- the bargain's own remarks and every quantity adjustment note.
  // Fetched when the details dialog opens, not with the register, so a page
  // refresh does not pay for notes nobody has asked to see.
  const [bargainNotes, setBargainNotes] = useState<Row[] | null>(null)
  useEffect(() => {
    if (!detailRow?.id) {
      setBargainNotes(null)
      return
    }
    let live = true
    setBargainNotes(null)
    window.api.orders
      .bargainNotes(Number(detailRow.id))
      .then((r) => { if (live) setBargainNotes(r) })
      .catch(() => { if (live) setBargainNotes([]) })
    return () => { live = false }
  }, [detailRow?.id])

  // Who did what to one purchase invoice.
  const hist = useHistoryDialog()
  const openHistory = (row: Row): void =>
    hist.open({
      entity: 'Purchase',
      id: Number(row.id),
      title: String(row.invoice_no || 'this purchase'),
      subtitle: `${row.supplier_name || '—'} · ${formatDate(row.invoice_date || row.order_date)} · ${formatINR(row.total_amount ?? row.amount)}`
    })

  function openEditPurchase(row: Row): void {
    const supplier = suppliers.find((x) => x.id === row.supplier_id)
    setEditing(row)
    setForm({
      company_id: String(row.company_id || activeCompany || ''),
      bargain_id: row.bargain_id,
      supplier_id: row.supplier_id,
      oil_type_id: row.oil_type_id,
      bargain_type: row.bargain_type,
      bargain_rate: row.bargain_rate,
      supplier_name: row.supplier_name,
      oil_label: String(row.oil_code || row.oil_name || ''),
      uom: row.uom,
      // direct/consignment invoices carry their own quantity (no tankers)
      ordered_qty: row.ordered_qty,
      invoice_no: row.invoice_no,
      order_date: row.order_date,
      invoice_rate: row.invoice_rate,
      gst_pct: row.gst_pct,
      gst_type: row.gst_type || 'CGST_SGST',
      tds_pct: supplier?.tds_pct ?? row.tds_pct,
      tds_threshold: supplier?.tds_threshold ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      adds_interest: !!supplier?.adds_interest,
      // prefer the values stored on the invoice; fall back to the supplier's
      interest_pct: Number(row.interest_pct) > 0 ? row.interest_pct : (supplier?.interest_pct ?? 0),
      interest_days: Number(row.interest_days) > 0 ? row.interest_days : (supplier?.interest_days ?? 0),
      additional_interest: row.additional_interest ?? '',
      // Replaced by the saved per-bargain overrides once they load, if any.
      bargain_interest: {},
      charge_interest: Number(row.interest_pct) > 0 && Number(row.interest_days) > 0,
      interest_touched: true,
      transporter_id: row.transporter_id || '',
      is_registered_transporter: !!row.is_registered_transporter,
      allowed_shortage_pct: row.allowed_shortage_pct ?? '',
      // Blank when the row predates the field — that reproduces the whole-rupee
      // ceiling it was actually struck on, so opening an old purchase to look
      // at it cannot re-price it.
      rate_round_off: row.rate_round_off ?? '',
      round_off: row.round_off ?? '',
      // Whether it was typed by hand is RECORDED on the invoice, not guessed
      // from "the value isn't zero" — that old guess froze a figure correct
      // for the OLD totals the moment anything else was edited, so the net
      // stopped landing on a whole rupee. Auto now keeps itself right, and a
      // real manual override is both respected and visibly flagged.
      round_off_manual: Number(row.round_off_manual) === 1,
      remarks: row.remarks ?? '',
      freight_paid_to_supplier: !!row.freight_paid_to_supplier,
      // the saved invoice rate is a deliberate choice — never auto-overwrite it
      invoice_rate_touched: true
    })
    setSelected(tankers.filter((x) => x.order_id === row.id).map((x) => Number(x.id)))
    setError(null)
    setFormPage(true)
    setTab('purchases')
  }

  useEffect(() => {
    if (!form.supplier_id || !form.order_date) return
    let active = true
    window.api.orders.fyTaxable(Number(form.supplier_id), String(form.order_date), Number(editing?.id || 0))
      .then((value) => active && setForm((p) => ({ ...p, tds_prior: value })))
    return () => { active = false }
  }, [form.supplier_id, form.order_date, editing])

  // Booking sees EVERY company's tankers, not just the one being booked into.
  // Which company a tanker ends up in is decided by the invoice that bills it
  // ("Book into company" moves it), so pre-filtering the picker by company
  // would hide the very tankers the user is choosing between. Tankers already
  // billed elsewhere are excluded downstream in selectableTankers, so only
  // genuinely unbilled ones cross over.
  const tankersForBooking = allTankers.length ? allTankers : tankers

  const selectableTankers = useMemo(
    () => tankersForBooking.filter((x) =>
      String(x.supplier_id) === String(form.supplier_id || '') &&
      x.status !== 'supplier_factory' &&
      Number(x.loaded_qty) > 0 &&
      (x.order_id == null || x.order_id === editing?.id)
    ),
    [tankersForBooking, form.supplier_id, editing]
  )
  // Only suppliers that actually have billable tankers appear in the picker
  // (plus the invoice's own supplier when editing). Trading suppliers are left
  // out — a pass-through deal is booked on the Trading screen, not here — but
  // the invoice's own supplier always stays listed, so an invoice already
  // booked against one still opens and edits normally.
  const invoiceSuppliers = useMemo(() => {
    const billable = new Set(
      tankersForBooking
        .filter((x) =>
          x.status !== 'supplier_factory' &&
          Number(x.loaded_qty) > 0 &&
          (x.order_id == null || x.order_id === editing?.id))
        .map((x) => String(x.supplier_id))
    )
    return suppliers.filter((s) => {
      const isCurrent = String(s.id) === String(form.supplier_id || '')
      if (!isCurrent && !isManufacturingParty(s)) return false
      return billable.has(String(s.id)) || !!s.skip_tanker_stages || isCurrent
    })
  }, [suppliers, tankersForBooking, editing, form.supplier_id])
  // A supplier flagged "Direct purchase" in the master keeps its goods at our
  // site already, so there is no send-to-supplier → transit → outside → inside
  // → empty cycle: the invoice is booked in one step against a bargain with the
  // quantity typed in by hand. Invoices already booked that way stay in this
  // mode when reopened.
  const directMode = useMemo(
    () =>
      !!editing?.is_consignment ||
      !!suppliers.find((s) => String(s.id) === String(form.supplier_id || ''))?.skip_tanker_stages,
    [suppliers, form.supplier_id, editing]
  )
  // Trading: bought from one party and sold straight to another. No bargain,
  // no tanker, and (on the backend) never counted in stock — a standalone mode,
  // not a variant of the direct/consignment flow above (that one still assumes
  // real consignment stock, which a Trading purchase has none of).
  const isTrading = !!(editing ? editing.is_trading : form.is_trading)
  // Consignment tankers logged for this supplier that no purchase has drawn yet
  // — the purchase form offers these first, then a bargain is assigned to them.
  const [lots, setLots] = useState<Row[]>([])
  const [lotIds, setLotIds] = useState<number[]>([])
  useEffect(() => {
    if (!formPage || !directMode || !form.supplier_id) { setLots([]); return }
    let active = true
    window.api.consignment
      .lots(Number(form.supplier_id))
      .then((rows) => { if (active) setLots(rows) })
      .catch(() => { if (active) setLots([]) })
    return () => { active = false }
  }, [formPage, directMode, form.supplier_id, editing])
  // Reopening a direct purchase: restore how its quantity was drawn.
  useEffect(() => {
    if (!formPage || !editing?.is_consignment) { setBgLines([{ bargain_id: '', qty: '' }]); return }
    let active = true
    window.api.orders
      .bargainLines(Number(editing.id))
      .then((rows) => {
        if (!active) return
        setBgLines(
          rows.length
            ? rows.map((r) => ({ bargain_id: String(r.bargain_id), qty: String(r.qty) }))
            : [{ bargain_id: String(editing.bargain_id || ''), qty: String(editing.ordered_qty || '') }]
        )
      })
      .catch(() => {})
    return () => { active = false }
  }, [formPage, editing])
  // Per-bargain interest overrides saved on the invoice being edited, so an
  // edit doesn't silently drop them back to the invoice-wide figures.
  useEffect(() => {
    if (!formPage || !editing?.id) return
    let active = true
    window.api.orders
      .bargainInterest(Number(editing.id))
      .then((rows) => {
        if (!active || !rows.length) return
        const map: Record<string, { additional_interest?: string; interest_days?: string }> = {}
        for (const r of rows) {
          map[String(r.bargain_id)] = {
            additional_interest: Number(r.additional_interest) ? String(r.additional_interest) : '',
            interest_days: Number(r.interest_days) ? String(r.interest_days) : ''
          }
        }
        setForm((p) => ({ ...p, bargain_interest: map }))
      })
      .catch(() => {})
    return () => { active = false }
  }, [formPage, editing])
  // Tankers already on the invoice being edited are not "pending", so pull the
  // invoice's own lots in separately and pre-tick them.
  const [ownLots, setOwnLots] = useState<Row[]>([])
  useEffect(() => {
    if (!formPage || !editing?.is_consignment) { setOwnLots([]); return }
    let active = true
    window.api.consignment
      .list()
      .then((rows) => {
        if (!active) return
        const mine = rows.filter((r) => Number(r.order_id) === Number(editing.id))
        setOwnLots(mine)
        setLotIds(mine.map((r) => Number(r.id)))
        // Bring back each tanker's saved bargain split.
        const saved: Record<number, Row> = {}
        for (const r of mine) {
          saved[Number(r.id)] = {
            bargain_id: r.bargain_id ? String(r.bargain_id) : '',
            extra_bargain_id: r.extra_bargain_id ? String(r.extra_bargain_id) : '',
            extra_qty: r.extra_qty != null ? String(r.extra_qty) : '',
            split: !!r.extra_bargain_id
          }
        }
        setLotBargains(saved)
      })
      .catch(() => { if (active) setOwnLots([]) })
    return () => { active = false }
  }, [formPage, editing])
  // What this party is holding with us, per product — shown the moment the
  // party is picked so the user knows how much can be invoiced.
  const [partyStockAll, setPartyStockAll] = useState<Row[]>([])
  useEffect(() => {
    if (!formPage || !directMode) { setPartyStockAll([]); return }
    let active = true
    window.api.consignment
      .summary()
      .then((rows) => { if (active) setPartyStockAll(rows) })
      .catch(() => { if (active) setPartyStockAll([]) })
    return () => { active = false }
  }, [formPage, directMode, editing])
  const partyStock = useMemo(
    () =>
      partyStockAll
        .filter((r) => String(r.supplier_id) === String(form.supplier_id || '') && Number(r.balance) > 1e-6)
        .sort((a, b) => Number(b.balance) - Number(a.balance)),
    [partyStockAll, form.supplier_id]
  )
  // Available balance of the product being invoiced.
  const directAvailable = useMemo(() => {
    if (!directMode || !form.oil_type_id) return null
    const row = partyStockAll.find(
      (r) =>
        String(r.supplier_id) === String(form.supplier_id || '') &&
        String(r.product_id) === String(form.oil_type_id)
    )
    return row ? Number(row.balance) || 0 : 0
  }, [directMode, partyStockAll, form.supplier_id, form.oil_type_id])

  // How the typed quantity is drawn from bargains: one line per bargain, the
  // same bargain twice simply means more quantity on it.
  const [bgLines, setBgLines] = useState<Row[]>([{ bargain_id: '', qty: '' }])
  // Once the user changes a line by hand the FIFO fill stops overwriting it.
  const [bgTouched, setBgTouched] = useState(false)
  const editBgLines: typeof setBgLines = (next) => {
    setBgTouched(true)
    setBgLines(next)
  }
  const bgAllocated = bgLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
  const bgAlloc = useMemo(() => {
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    for (const l of bgLines) {
      const qty = Number(l.qty) || 0
      if (!l.bargain_id || qty <= 0) continue
      const b = bargains.find((x) => String(x.id) === String(l.bargain_id))
      const k = String(l.bargain_id)
      const cur = m.get(k) || { bargain_id: Number(l.bargain_id), bargain_no: String(b?.bargain_no || '—'), rate: Number(b?.rate_per_uom) || 0, qty: 0 }
      cur.qty += qty
      m.set(k, cur)
    }
    return Array.from(m.values())
  }, [bgLines, bargains])

  // Picking a product from the stock panel sets it on the invoice and clears any
  // bargain lines that belonged to the previous product.
  function chooseDirectProduct(p: Row): void {
    setForm((f) => ({
      ...f,
      oil_type_id: p.product_id,
      oil_label: String(p.product_code || p.product_name || ''),
      uom: p.uom || f.uom || 'MT',
      bargain_id: '',
      bargain_rate: '',
      invoice_rate: f.invoice_rate_touched ? f.invoice_rate : ''
    }))
    setBgLines([{ bargain_id: '', qty: '' }])
  }

  // Every pending tanker of the supplier — the tankers come first and the
  // bargain is assigned afterwards, so these are NOT pre-filtered by product.
  const pickableLots = useMemo(
    () =>
      [...ownLots, ...lots.filter((l) => !ownLots.some((o) => Number(o.id) === Number(l.id)))].sort((a, b) =>
        String(a.deposit_date || '').localeCompare(String(b.deposit_date || ''))
      ),
    [lots, ownLots]
  )
  const chosenLots = useMemo(
    () => pickableLots.filter((l) => lotIds.includes(Number(l.id))),
    [pickableLots, lotIds]
  )
  const lotQty = chosenLots.reduce((s, l) => s + Number(l.qty || 0), 0)
  // Per-tanker bargain assignment, keyed by lot id: a tanker draws on one
  // bargain, or is split across two (extra_qty on the second).
  const [lotBargains, setLotBargains] = useState<Record<number, Row>>({})
  const setLotBargain = (id: number, patch: Row): void =>
    setLotBargains((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch } }))
  // What each bargain ends up drawing across every ticked tanker.
  const lotAlloc = useMemo(() => {
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    const add = (id: unknown, qty: number): void => {
      if (!id || qty <= 1e-9) return
      const b = bargains.find((x) => String(x.id) === String(id))
      const k = String(id)
      const cur = m.get(k) || {
        bargain_id: Number(id),
        bargain_no: String(b?.bargain_no || '—'),
        rate: Number(b?.rate_per_uom) || 0,
        qty: 0
      }
      cur.qty += qty
      m.set(k, cur)
    }
    for (const l of chosenLots) {
      const a = lotBargains[Number(l.id)] || {}
      const qty = Number(l.qty) || 0
      const extra = a.extra_bargain_id ? Number(a.extra_qty) || 0 : 0
      add(a.bargain_id, qty - extra)
      add(a.extra_bargain_id, extra)
    }
    return Array.from(m.values())
  }, [chosenLots, lotBargains, bargains])
  // Tankers still missing a bargain, or with an impossible split.
  const lotIssues = useMemo(
    () =>
      chosenLots
        .filter((l) => {
          const a = lotBargains[Number(l.id)] || {}
          const qty = Number(l.qty) || 0
          const extra = a.extra_bargain_id ? Number(a.extra_qty) || 0 : 0
          if (!a.bargain_id && extra < qty - 1e-6) return true
          if (extra > qty + 1e-6) return true
          if (a.extra_bargain_id && String(a.extra_bargain_id) === String(a.bargain_id)) return true
          return false
        })
        .map((l) => String(l.tanker_no || l.id)),
    [chosenLots, lotBargains]
  )
  // One invoice covers one product; the ticked tankers decide which bargains fit.
  const lotProducts = useMemo(
    () => Array.from(new Set(chosenLots.map((l) => String(l.product_id)))),
    [chosenLots]
  )
  const lotProductId = lotProducts.length === 1 ? lotProducts[0] : ''
  const mixedLotProducts = lotProducts.length > 1
  // Open bargains of that supplier (plus whichever one this invoice already
  // uses), narrowed to the product of the tankers that have been ticked.
  // Bargains of this party + product with balance left, oldest first — the
  // order the quantity is drawn in.
  const fifoBargains = useMemo(() => {
    const pid = String(form.oil_type_id || '')
    return bargains
      .filter(
        (b) =>
          String(b.supplier_id) === String(form.supplier_id || '') &&
          (!pid || String(b.oil_type_id) === pid) &&
          Number(b.balance_qty) > 1e-6
      )
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }, [bargains, form.supplier_id, form.oil_type_id])
  const fifoKey = fifoBargains.map((b) => `${b.id}:${b.balance_qty}`).join('|')

  // Fill the quantity from the oldest bargains first. Anything the balances
  // cannot cover is left on the last line, where it shows as over-balance.
  const fifoFill = useCallback((qty: number): Row[] => {
    const out: Row[] = []
    let left = qty
    for (const b of fifoBargains) {
      if (left <= 1e-6) break
      const take = Math.min(left, Number(b.balance_qty) || 0)
      if (take <= 1e-6) continue
      out.push({ bargain_id: String(b.id), qty: String(Math.round(take * 1000) / 1000) })
      left -= take
    }
    if (left > 1e-6 && out.length) {
      const last = out[out.length - 1]
      last.qty = String(Math.round(((Number(last.qty) || 0) + left) * 1000) / 1000)
    }
    return out
  }, [fifoBargains])

  useEffect(() => {
    if (!formPage || !directMode || bgTouched || editing) return
    const q = Number(form.ordered_qty) || 0
    const next = q > 0 ? fifoFill(q) : []
    setBgLines(next.length ? next : [{ bargain_id: '', qty: '' }])
  }, [formPage, directMode, bgTouched, editing, form.ordered_qty, form.oil_type_id, fifoKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const directBargains = useMemo(() => {
    const pid = lotProductId || String(form.oil_type_id || '')
    return bargains
      .filter(
        (b) =>
          String(b.supplier_id) === String(form.supplier_id || '') &&
          (!pid || String(b.oil_type_id) === pid) &&
          (Number(b.balance_qty) > 0 ||
            String(b.id) === String(form.bargain_id || '') ||
            bgLines.some((l) => String(l.bargain_id) === String(b.id)))
      )
      // Oldest first: the same order the quantity is drawn in.
      .sort((a, b) => {
        const d = String(a.bargain_date || '').localeCompare(String(b.bargain_date || ''))
        return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0)
      })
  }, [bargains, form.supplier_id, form.bargain_id, form.oil_type_id, form.ordered_qty, lotProductId, bgLines])
  // Resolved against the SAME list the picker offers from.
  //
  // This read `tankers`, which is scoped to the active company, while the
  // checkboxes above are built from tankersForBooking — every company's
  // tankers, because a bargain is general and any company's tanker can be
  // billed on it. Tick one that is not in the active company and it resolved
  // to nothing: the summary showed "Tankers 1" off selected.length while
  // Total loaded quantity stayed 0 MT, the bargain never followed the first
  // tanker, so the rate never auto-filled, and every figure below it — taxable
  // value, GST, net — was struck on a quantity of zero.
  const chosenTankers = useMemo(
    () => tankersForBooking.filter((x) => selected.includes(Number(x.id))),
    [tankersForBooking, selected]
  )
  // The invoice's bargain follows the first selected tanker automatically.
  useEffect(() => {
    if (!formPage) return
    const first = chosenTankers[0]
    if (!first) return
    if (String(form.bargain_id || '') !== String(first.bargain_id)) {
      choosePurchaseBargain(String(first.bargain_id), true)
    }
  }, [formPage, chosenTankers, form.bargain_id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Same for a consignment invoice: it follows the first tanker's bargain.
  const firstLotBargain =
    chosenLots
      .map((l) => {
        const a = lotBargains[Number(l.id)] || {}
        return a.bargain_id || a.extra_bargain_id || ''
      })
      .find((x) => !!x) || bgLines.find((l) => !!l.bargain_id)?.bargain_id || ''
  useEffect(() => {
    if (!formPage || !directMode || !firstLotBargain) return
    if (String(form.bargain_id || '') !== String(firstLotBargain)) {
      choosePurchaseBargain(String(firstLotBargain), true)
    }
  }, [formPage, directMode, firstLotBargain, form.bargain_id]) // eslint-disable-line react-hooks/exhaustive-deps
  const mixedRates = useMemo(
    () => new Set(chosenTankers.map((x) => Number(x.bargain_rate) || 0)).size > 1,
    [chosenTankers]
  )
  // Per-bargain quantity shares across the selected tankers — a split tanker
  // contributes to BOTH its primary and its excess bargain. More than one entry
  // means the invoice spans multiple bargain rates.
  const rateAlloc = useMemo(() => {
    // Consignment tankers carry their own per-bargain split; a typed-quantity
    // invoice carries it on the invoice itself.
    if (directMode && chosenLots.length) return lotAlloc
    if (directMode && bgAlloc.length) return bgAlloc
    const m = new Map<string, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
    const add = (id: unknown, no: unknown, rate: number, qty: number): void => {
      if (!id || qty <= 0) return
      const k = String(id)
      const cur = m.get(k) || { bargain_id: Number(id), bargain_no: String(no || '—'), rate, qty: 0 }
      cur.qty += qty
      m.set(k, cur)
    }
    for (const t of chosenTankers) {
      const loaded = Number(t.loaded_qty) || 0
      const extra = t.extra_bargain_id ? Number(t.extra_qty) || 0 : 0
      add(t.bargain_id, t.bargain_no, Number(t.bargain_rate) || 0, loaded - extra)
      if (extra > 0) add(t.extra_bargain_id, t.extra_bargain_no, Number(t.extra_bargain_rate) || 0, extra)
    }
    return Array.from(m.values())
  }, [chosenTankers, directMode, chosenLots, lotAlloc, bgAlloc])
  const bgRemaining = (Number(form.ordered_qty) || 0) - bgAllocated
  const directBalance = useMemo(() => {
    if (!directMode || !form.bargain_id) return null
    const b = bargains.find((x) => String(x.id) === String(form.bargain_id))
    return b ? Number(b.balance_qty) || 0 : null
  }, [directMode, bargains, form.bargain_id])
  // Direct purchases add up the consignment tankers they draw; with no tankers
  // logged the quantity is typed in instead.
  const totalQty = directMode || isTrading
    ? Number(form.ordered_qty) || 0
    : chosenTankers.reduce((sum, x) => sum + Number(x.loaded_qty || 0), 0)
  // Quantity-weighted average bargain rate across the allocation. Rounded to
  // paise — it is written into the rate FIELDS, and a raw float average put
  // something like 128781.58844765343 in front of the user. The taxable value
  // is summed from each bargain's own line rate, not from this, so rounding
  // it changes nothing that is actually billed.
  const blendedRate = useMemo(() => {
    const q = rateAlloc.reduce((s, a) => s + a.qty, 0)
    if (q <= 0) return 0
    return Math.round((rateAlloc.reduce((s, a) => s + a.rate * a.qty, 0) / q) * 100) / 100
  }, [rateAlloc])
  // Multi-bargain invoices price at the blended (weighted-average) rate — both
  // the bargain rate (interest/final basis) and the default invoice rate.
  useEffect(() => {
    if (!formPage || rateAlloc.length < 2 || blendedRate <= 0) return
    setForm((p) => {
      const next: Row = { ...p }
      let changed = false
      if (Math.abs((Number(p.bargain_rate) || 0) - blendedRate) > 1e-6) {
        next.bargain_rate = blendedRate
        changed = true
      }
      if (!p.invoice_rate_touched && Math.abs((Number(p.invoice_rate) || 0) - blendedRate) > 1e-6) {
        next.invoice_rate = blendedRate
        changed = true
      }
      return changed ? next : p
    })
  }, [formPage, rateAlloc.length, blendedRate])
  const financedCount = chosenTankers.filter((x) => x.payment_mode === 'supplier_finance').length
  // Transporter is already chosen during tanker movement — reuse it here.
  const tankerTransporterIds = Array.from(
    new Set(chosenTankers.map((x) => x.transporter_id).filter(Boolean).map(String))
  )
  const tankerTransporterId = tankerTransporterIds.length === 1 ? tankerTransporterIds[0] : ''
  const tankerTransporterName =
    chosenTankers.find((x) => String(x.transporter_id) === tankerTransporterId)?.transporter_name || ''
  useEffect(() => {
    if (tankerTransporterId && String(form.transporter_id || '') !== tankerTransporterId) {
      setForm((p) => ({ ...p, transporter_id: tankerTransporterId }))
    }
  }, [tankerTransporterId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Per-bargain additional interest / interest days, keyed by bargain id. An
  // entry left blank simply inherits the invoice-wide figure, so this stays
  // empty for the ordinary single-rate invoice.
  const bargainInterest: Record<string, { additional_interest?: string; interest_days?: string }> =
    form.bargain_interest || {}
  function setBargainInterest(bargainId: number, field: 'additional_interest' | 'interest_days', value: string): void {
    setForm((p) => ({
      ...p,
      bargain_interest: {
        ...(p.bargain_interest || {}),
        [String(bargainId)]: { ...((p.bargain_interest || {})[String(bargainId)] || {}), [field]: value }
      }
    }))
  }
  // The per-line figures actually used for pricing — a blank override falls
  // back to the invoice-wide value, matching applyBargainInterestOverrides in
  // the main process.
  const lineInterestOf = useCallback(
    (bargainId: number): { additionalInterest: number; interestDays: number } => {
      const o = (form.bargain_interest || {})[String(bargainId)] || {}
      const addl = o.additional_interest != null && o.additional_interest !== ''
        ? Number(o.additional_interest) || 0
        : Number(form.additional_interest) || 0
      const days = o.interest_days != null && o.interest_days !== ''
        ? Number(o.interest_days) || 0
        : Number(form.interest_days) || 0
      return { additionalInterest: addl, interestDays: days }
    },
    [form.bargain_interest, form.additional_interest, form.interest_days]
  )
  // Anything the invoice rate carries above the blended bargain rate is
  // supplier freight billed inside the rate — it lands on every bargain line.
  // Mirrors computeMoney, paisa guard included.
  const ratePremium = useMemo(() => {
    if (rateAlloc.length < 2 || blendedRate <= 0) return 0
    const d = Math.round(((Number(form.invoice_rate) || 0) - blendedRate) * 100) / 100
    return Math.abs(d) < 0.01 ? 0 : d
  }, [rateAlloc.length, blendedRate, form.invoice_rate])
  // Blank means the figure was never stated, which is the old always-round-up
  // rule — every purchase entered before this was struck that way, so they
  // reproduce exactly. A typed 0 is the new default: bill the exact rate.
  const rateRoundOff =
    form.rate_round_off != null && form.rate_round_off !== '' ? Number(form.rate_round_off) : null
  const billedRate = useCallback(
    (raw: number): number =>
      rateRoundOff == null ? Math.ceil(raw) : Math.round((raw + rateRoundOff) * 100) / 100,
    [rateRoundOff]
  )
  // What one bargain's line actually prices at, per unit: its own rate, its own
  // interest (shared %, its own days), its own additional interest and any
  // freight premium, at whatever the rate is billed at.
  // Shared by the form panel and the summary so the two can never disagree.
  const lineFiguresOf = useCallback(
    (bargainId: number, rate: number): { perUnitInterest: number; additionalInterest: number; lineRate: number } => {
      const eff = lineInterestOf(bargainId)
      const perUnitInterest = form.charge_interest
        ? rate * (1 + (Number(form.gst_pct) || 0) / 100) * ((Number(form.interest_pct) || 0) / 100) * (eff.interestDays / 365)
        : 0
      return {
        perUnitInterest,
        additionalInterest: eff.additionalInterest,
        lineRate: billedRate(rate + perUnitInterest + eff.additionalInterest + ratePremium)
      }
    },
    [lineInterestOf, form.charge_interest, form.gst_pct, form.interest_pct, ratePremium, billedRate]
  )
  const calc = useMemo(() => computeMoney({
    orderedQty: totalQty,
    rateRoundOff,
    invoiceRate: Number(form.invoice_rate) || 0,
    bargainRate: Number(form.bargain_rate) || 0,
    gstPct: Number(form.gst_pct) || 0,
    tdsPct: form.tds_above_only ? 0 : Number(form.tds_pct) || 0,
    addsInterest: !!form.charge_interest,
    interestPct: Number(form.interest_pct) || 0,
    interestDays: Number(form.interest_days) || 0,
    additionalInterest: Number(form.additional_interest) || 0,
    tdsThreshold: Number(form.tds_threshold) || 0,
    tdsPctAbove: Number(form.tds_pct) || 0,
    tdsPrior: Number(form.tds_prior) || 0,
    lines: rateAlloc.map((a) => ({ rate: a.rate, qty: a.qty, ...lineInterestOf(a.bargain_id) })),
    roundOff: Number(form.round_off) || 0
  }), [form, totalQty, rateAlloc, lineInterestOf])

  // What the explainer needs to redo the arithmetic on screen: where this
  // supplier stood in the year BEFORE this invoice (orders:fyTaxable already
  // fetches it into form.tds_prior, pooled across linked parties), the slab off
  // its master, and this invoice's taxable value. One party, one line — a
  // purchase invoice has a single supplier, unlike a trading deal.
  const tdsParties = useMemo<TdsParty[]>(() => {
    if (!(Number(form.tds_pct) > 0)) return []
    return [
      {
        partyId: Number(form.supplier_id) || 0,
        name: String(form.supplier_name || 'Supplier'),
        pct: Number(form.tds_pct) || 0,
        // Purchases withhold on the goods alone, same as sales. GST is the
        // government's money passing through; withholding on it is tax on tax.
        on: 'taxable' as const,
        gstPct: Number(form.gst_pct) || 0,
        roundOff: Number(form.round_off) || 0,
        invoices: [
          {
            id: Number(editing?.id) || 0,
            label: String(form.invoice_no || 'This invoice'),
            taxable: calc.taxableValue
          }
        ],
        posted: calc.tdsAmount,
        threshold: Number(form.tds_threshold) || 0,
        aboveOnly: !!form.tds_above_only
      }
    ]
  }, [form, editing, calc.taxableValue, calc.tdsAmount])

  // Default the per-invoice interest toggle: ON when the supplier charges
  // interest AND the purchase is supplier-financed. A manual flip sticks.
  useEffect(() => {
    if (!formPage || editing || form.interest_touched) return
    const on = !!form.adds_interest && selected.length > 0 && financedCount === selected.length
    if (!!form.charge_interest !== on) {
      setForm((p) => ({ ...p, charge_interest: on }))
    }
  }, [formPage, editing, form.interest_touched, form.adds_interest, form.charge_interest, financedCount, selected.length])

  // Auto round-off to the nearest rupee (Tally style). It rounds the total
  // excluding TDS — the figure on the supplier's physical invoice — which does
  // not depend on the round off itself. Deriving it from the net (as before)
  // fed the value back into its own TDS base and oscillated without settling,
  // so whichever value the loop was passing through at Save got stored. A
  // manual edit overrides it; clearing the field brings the auto value back.
  useEffect(() => {
    if (!formPage || form.round_off_manual) return
    // Round the base to PAISA first. GST can carry a third decimal (5% of an
    // odd taxable value lands on .xx5), and deriving the round off from that
    // un-rounded figure leaves a half-paisa tail — which then surfaced as an
    // invoice total one paisa off a whole rupee.
    const total = Math.round(calc.totalExclTds * 100) / 100
    if (!Number.isFinite(total) || total <= 0) return
    const auto = Math.round(total) - total
    const val = Math.abs(auto) < 0.005 ? '' : auto.toFixed(2)
    if (String(form.round_off ?? '') !== val) {
      setForm((p) => ({ ...p, round_off: val }))
    }
  }, [calc.totalExclTds, form.round_off_manual, form.round_off, formPage])

  // Tally's accept shortcut, on the purchase form only.
  useEffect(() => {
    if (!formPage) return
    function onKey(e: KeyboardEvent): void {
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        if (!saving) void savePurchase()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formPage, saving, form, selected, bgLines])

  async function savePurchase(): Promise<void> {
    if (!form.company_id) return setError('Choose the company this purchase belongs to')
    if (!form.supplier_id) return setError('Select the supplier')
    if (isTrading) {
      if (!form.oil_type_id) return setError('Choose the product being invoiced')
      if (totalQty <= 0) return setError('Enter the quantity being invoiced')
    } else if (directMode) {
      if (!form.oil_type_id) return setError('Choose the product being invoiced')
      if (totalQty <= 0) return setError('Enter the quantity being invoiced')
      if (directAvailable != null && totalQty > directAvailable + 1e-6) {
        return setError(
          `Only ${formatNum(directAvailable)} ${form.uom || 'MT'} is available from this party for that product`
        )
      }
      if (bgLines.some((l) => !l.bargain_id)) return setError('Every bargain line needs a bargain')
      if (Math.abs(bgRemaining) > 1e-6) {
        return setError(
          bgRemaining > 0
            ? `${formatNum(bgRemaining)} ${form.uom || 'MT'} of this invoice is not drawn from any bargain`
            : `The bargain quantities are ${formatNum(-bgRemaining)} ${form.uom || 'MT'} more than the invoice`
        )
      }
      if (!form.bargain_id) return setError('Choose the bargain this quantity is drawn from')
    } else {
      if (!selected.length) return setError('Select at least one loaded tanker')
      if (!form.bargain_id) return setError('Select at least one loaded tanker')
    }
    if (!String(form.invoice_no || '').trim()) return setError('Invoice number is required')
    {
      const hit = invoiceClash(form.invoice_no, editing?.id)
      if (hit) {
        return setError(
          `Purchase invoice ${String(form.invoice_no).trim()} is already booked — ` +
            `${String(hit.supplier_name || hit.supplier || 'another supplier')}` +
            `${hit.order_date ? `, ${formatDate(hit.order_date)}` : ''}.`
        )
      }
    }
    if (Number(form.invoice_rate) <= 0) return setError('Invoice rate must be greater than zero')
    setSaving(true)
    setError(null)
    const payload: Row = {
      ...form,
      ordered_qty: totalQty,
      invoice_rate: Number(form.invoice_rate),
      bargain_rate: Number(form.bargain_rate),
      gst_pct: Number(form.gst_pct) || 0,
      tds_pct: Number(form.tds_pct) || 0,
      company_id: Number(form.company_id) || undefined,
      tanker_ids: directMode || isTrading ? [] : selected,
      is_consignment: !isTrading && directMode,
      is_trading: isTrading,
      bargain_id: isTrading ? null : form.bargain_id,
      consignment_lot_ids: [],
      bargain_lines: !isTrading && directMode
        ? bgLines
            .filter((l) => l.bargain_id && (Number(l.qty) || 0) > 0)
            .map((l) => ({ bargain_id: Number(l.bargain_id), qty: Number(l.qty) || 0 }))
        : [],
      // Only meaningful once the invoice spans more than one bargain; a single
      // bargain uses the invoice-wide figures alone.
      bargain_interest: rateAlloc.length > 1
        ? rateAlloc
            .map((a) => {
              const o = (form.bargain_interest || {})[String(a.bargain_id)] || {}
              return {
                bargain_id: a.bargain_id,
                additional_interest: o.additional_interest ?? '',
                interest_days: o.interest_days ?? ''
              }
            })
            .filter((o) => o.additional_interest !== '' || o.interest_days !== '')
        : [],
      transporter_id: directMode || isTrading || !form.transporter_id ? null : Number(form.transporter_id),
      allowed_shortage_pct:
        form.allowed_shortage_pct === '' || form.allowed_shortage_pct == null
          ? null
          : Number(form.allowed_shortage_pct),
      round_off: Number(form.round_off) || 0,
      // Sent through as-is: '' keeps the legacy whole-rupee ceiling on a record
      // that was struck that way, a number states the adjustment.
      rate_round_off: form.rate_round_off ?? '',
      round_off_manual: form.round_off_manual ? 1 : 0,
      financed_by_party: !directMode && !isTrading && selected.length > 0 && financedCount === selected.length,
      payment_date: form.order_date
    }
    try {
      if (editing) {
        await window.api.orders.update(editing.id, payload)
        toast.success('Purchase updated')
      } else {
        await window.api.orders.create(payload)
        toast.success('Purchase invoice created')
      }
      setFormPage(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function deletePurchase(row: Row): Promise<void> {
    if (!window.confirm(`Delete purchase ${row.invoice_no}? Its tankers will return to the loaded queue.`)) return
    try {
      await window.api.orders.remove(row.id)
      toast.success('Purchase deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Tanker count + quantity per product (oil), within an optional loaded-date range.
  const tankerReport = useMemo(() => {
    const inRange = tankers.filter((t) => {
      const d = String(t.loaded_date || '').slice(0, 10)
      if (repFrom && (!d || d < repFrom)) return false
      if (repTo && (!d || d > repTo)) return false
      return Number(t.loaded_qty) > 0 || !!d
    })
    const m = new Map<string, { count: number; loaded: number; received: number }>()
    for (const t of inRange) {
      const k = String(t.oil_code || t.oil_name || '—')
      if (!m.has(k)) m.set(k, { count: 0, loaded: 0, received: 0 })
      const g = m.get(k)!
      g.count += 1
      g.loaded += Number(t.loaded_qty) || 0
      g.received += Number(t.received_qty) || 0
    }
    const rows = [...m.entries()]
      .map(([oil, g]) => ({ oil, ...g }))
      .sort((a, b) => a.oil.localeCompare(b.oil))
    const grand = rows.reduce(
      (s, r) => ({ count: s.count + r.count, loaded: s.loaded + r.loaded, received: s.received + r.received }),
      { count: 0, loaded: 0, received: 0 }
    )
    return { rows, grand }
  }, [tankers, repFrom, repTo])

  const target = actionRow ? nextTankerStage(actionRow.status) : null
  const shortage = actionRow ? computeShortage({
    orderedQty: Number(actionRow.loaded_qty) || 0,
    receivedQty: Number(actionForm.received_qty) || 0,
    allowedPct: Number(
      actionRow.order_allowed_shortage_pct ??
        actionRow.allowed_shortage_pct ??
        settings.allowed_shortage_pct ??
        0
    ),
    bargainRate: Number(actionRow.bargain_rate) || 0,
    transportRatePerTon: Number(actionForm.transport_rate_per_ton) || 0
  }) : null

  return (
    <>
      {!formPage && (
        <PageHeader
          title="Purchases"
          hint="Tanker lifecycle: To be loaded → Loaded → In transit → Outside factory → Inside factory → Empty. Pick the transporter when sending tankers to the supplier. At Empty, record received qty plus the KRFL and outside-factory weighment slips."
          actions={
            <div className="flex gap-2">
              <ExcelButton
                filename={`purchases-tankers-${todayISO()}`}
                sheetName="Purchases"
                title="Purchase tankers"
                columns={[
                  { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
                  { header: 'Loaded date', key: 'loaded_date', value: (r) => formatDate(r.loaded_date) },
                  { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                  { header: 'Bargain', key: 'bargain_no', value: (r) => r.bargain_no || '' },
                  { header: 'Loaded qty', key: 'loaded_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.loaded_qty) || 0 },
                  { header: 'Received qty', key: 'received_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.received_qty) || 0 },
                  { header: 'UOM', key: 'uom', value: (r) => r.uom || '' },
                  { header: 'Payment', key: 'payment_mode', value: (r) => (r.payment_mode === 'supplier_finance' ? 'Supplier financed' : r.payment_mode === 'paid_by_us' ? 'Paid by us' : 'Not decided') },
                  { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                  { header: 'Stage', key: 'status', value: (r) => r.status || '' }
                ]}
                rows={visibleTankers}
              />
              {!readingsOnly && (<>
              <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
                <BarChart3 className="h-4 w-4" /> Report
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLoadingOpen(true)}>
                <Truck className="h-4 w-4" /> Send tankers to supplier
              </Button>
              <Button
                size="sm"
                // The page's primary action, so it wears the theme's own
                // accent rather than the default near-black — which on the
                // website read as just another dark control. Height comes
                // from PageHeader's cluster rule, so it matches its
                // neighbours; the colour is what makes it primary.
                className={cn(__WEB__ && '!rounded-[4px] !bg-[#C7F03F] !px-4 !text-[13px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#b3d936]')}
                onClick={openNewPurchase}
              >
                <Plus className="h-4 w-4" /> New purchase
              </Button>
              </>)}
            </div>
          }
        />
      )}

      {formPage ? (
        <div className={cn('px-4 py-4', __WEB__ && '!p-0')}>
          <div className={cn('rounded-md border border-[#d9d2b8] bg-[#fffdf4] shadow-lg', NP_SHELL)}>
          <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md bg-[#dce6f5] px-4 py-2 text-[#1a2c56]', NP_BAR)}>
            <button
              className={cn('inline-flex cursor-pointer items-center gap-1.5 text-[12px] font-medium hover:underline', NP_BACK)}
              onClick={() => { if (onBack) { onBack() } else { setFormPage(false) } }}
            >
              <ArrowLeft className={cn('h-3.5 w-3.5', __WEB__ && '!h-[18px] !w-[18px]')} />{' '}
              {__WEB__ ? 'BACK' : onBack ? `Back to ${backLabel || 'previous page'}` : 'Back'}
            </button>
            <div className={cn('h-4 border-l border-[#1a2c56]/30', __WEB__ && '!h-[26px] !border-l-[#C7F03F]/20')} />
            {/* On the website the name of the thing sits above what it is —
                the title, then the kicker underneath, the way every other
                header on the site is built. */}
            <div className={cn(__WEB__ && 'min-w-0')}>
              <h2 className={cn('text-[13px] font-bold uppercase tracking-widest', NP_TITLE)}>
                {editing ? 'Alter purchase invoice' : 'Purchase invoice'}
              </h2>
              {__WEB__ && (
                <div className="mt-[2px] whitespace-nowrap text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#8FBFA8]">
                  {editing ? 'Purchases · amend' : 'Purchases · create'}
                </div>
              )}
            </div>
            <span className={cn('ml-auto text-[11px] font-medium', __WEB__ && cn(NP_REF, '!ml-auto !shrink-0'))}>
              {form.invoice_no ? `No ${form.invoice_no}` : 'No: not yet given'}
              {form.order_date ? ` · ${formatDate(form.order_date)}` : ''}
              {isTrading ? ' · trading, no bargain/stock' : directMode ? ' · direct, no tanker movement' : ''}
            </span>
          </div>

          <div className={cn('grid gap-4 p-4 xl:grid-cols-[1fr_360px]', NP_GRID)}>
            <div className={cn('space-y-4', __WEB__ && '!space-y-3')}>
              <section
                className={cn(
                  'rounded border border-[#e5dfc8] bg-white p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground',
                  __WEB__ && cn(NP_CARD, NP_FIELDS)
                )}
              >
                <h3
                  className={cn(
                    'mb-3 border-b border-dotted border-[#e5dfc8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]',
                    NP_CARD_HEAD
                  )}
                >
                  {__WEB__ && <ScrollText className="h-[19px] w-[19px] text-[#33473E]" />}
                  Invoice details
                </h3>
                <div className={cn('grid gap-4 md:grid-cols-3', NP_CARD_BODY)}>
                  <div className="flex flex-col gap-1.5">
                    <Label>Book into company *</Label>
                    <Select
                      value={String(form.company_id || '')}
                      onValueChange={(v) => setForm((p) => ({ ...p, company_id: v }))}
                    >
                      <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                      <SelectContent>
                        {companies.map((cm) => (
                          <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {String(form.company_id || '') !== String(activeCompany) && !!form.company_id && (
                      <span className="text-[11px] font-medium text-amber-700">
                        This invoice and its tankers will move to{' '}
                        {companies.find((cm) => String(cm.id) === String(form.company_id))?.name}.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label>Supplier *</Label>
                    <Select
                      value={String(form.supplier_id || '')}
                      onValueChange={(v) => choosePurchaseSupplier(v)}
                      disabled={!!editing}
                    >
                      <SelectTrigger><SelectValue placeholder="Select the supplier — its loaded tankers appear below" /></SelectTrigger>
                      <SelectContent>
                        {invoiceSuppliers.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.name}
                            {s.skip_tanker_stages ? ' · direct' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className={cn('text-[11px] text-muted-foreground', NP_NOTE)}>
                      {isTrading
                        ? 'Trading purchase — no bargain, no tanker; not counted in stock.'
                        : directMode
                          ? 'Direct-purchase supplier — pick the bargain and quantity below; no tankers are involved.'
                          : form.bargain_id
                            ? `Bargain ${bargains.find((b) => String(b.id) === String(form.bargain_id))?.bargain_no || ''} — taken from the selected tankers.`
                            : 'The bargain is picked up automatically from the tankers you select.'}
                    </span>
                  </div>
                  {/* Off the website's purchase form.
                      
                      Trading has a page of its own now — the back-to-back buy
                      and sell belong together on one screen, which is what
                      Trading does and what this tick never could. Left here it
                      was a switch on the wrong form: it hid the tanker picker,
                      changed what the summary meant, and took the invoice out
                      of stock, all from a checkbox above the invoice number.
                      
                      Only the CONTROL goes. is_trading and everything it
                      drives stay exactly as they are, so a trading invoice
                      already on the books still opens, still reads as trading
                      and still saves — it was disabled on an edit anyway. The
                      desktop app keeps the tick. */}
                  {!__WEB__ && (
                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <label
                      className={cn(
                        'flex items-center gap-2 text-[13px]',
                        !!editing && 'opacity-50',
                        __WEB__ &&
                          cn(
                            '!items-start !gap-[11px] !rounded-[4px] !border !px-[14px] !py-3',
                            isTrading ? '!border-[#BFE3CB] !bg-[#F7FBF4]' : '!border-[#E4ECE3] !bg-[#FBFDFA]'
                          )
                      )}
                    >
                      <input
                        type="checkbox"
                        className={cn(
                          'h-4 w-4',
                          __WEB__ && '!mt-[3px] !h-[18px] !w-[18px] !shrink-0 !accent-[#0B3D2E]'
                        )}
                        checked={isTrading}
                        disabled={!!editing}
                        onChange={(e) => setForm((p) => ({ ...p, is_trading: e.target.checked }))}
                      />
                      {__WEB__ ? (
                        <span className="min-w-0">
                          <span
                            className={cn(
                              'block text-[12.5px] font-extrabold',
                              isTrading ? 'text-[#0A1F17]' : 'text-[#5A6B62]'
                            )}
                          >
                            Trading purchase
                          </span>
                          <span
                            className={cn(
                              'mt-[3px] block text-[11.5px] font-semibold leading-[1.5]',
                              isTrading ? 'text-[#0B6B45]' : 'text-[#8CA396]'
                            )}
                          >
                            Bought to resell straight through — no bargain is drawn down and stock is not affected.
                          </span>
                        </span>
                      ) : (
                        'Trading purchase — bought to resell straight through, no bargain, does not affect stock'
                      )}
                    </label>
                  </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <Label>Invoice number *</Label>
                    {(() => {
                      const hit = invoiceClash(form.invoice_no, editing?.id)
                      return (
                        <>
                          <Input
                            className={cn('doc-ref', hit && 'border-rose-400 focus-visible:ring-rose-300')}
                            value={form.invoice_no || ''}
                            onChange={(e) => setForm((p) => ({ ...p, invoice_no: e.target.value }))}
                          />
                          {hit && (
                            <span className="text-[11px] font-medium leading-snug text-rose-600">
                              Already booked — {String(hit.supplier_name || hit.supplier || 'another supplier')}
                              {hit.order_date ? `, ${formatDate(hit.order_date)}` : ''}. Two purchases cannot share one
                              invoice number.
                            </span>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Purchase date *</Label>
                    <DatePicker min={minDate} value={form.order_date || ''} onChange={(v) => setForm((p) => ({ ...p, order_date: v }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Bargain rate *</Label>
                    <Input type="number" step="0.01" value={form.invoice_rate ?? ''} onChange={(e) => setForm((p) => ({ ...p, invoice_rate: e.target.value, invoice_rate_touched: true }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST %</Label>
                    <Input type="number" value={form.gst_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>GST type</Label>
                    <Select value={form.gst_type || 'CGST_SGST'} onValueChange={(v) => setForm((p) => ({ ...p, gst_type: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CGST_SGST">CGST + SGST (intra-state)</SelectItem>
                        <SelectItem value="IGST">IGST (inter-state)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>TDS %</Label>
                    <Input type="number" value={form.tds_pct ?? ''} onChange={(e) => setForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    {/* Read-only on purpose — it comes off the tankers. The
                        padlock says so without a sentence. */}
                    <div
                      className={cn(
                        'flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm',
                        __WEB__ && '!h-[46px] !gap-[9px] !rounded-[4px] !border-[#E4ECE3] !bg-[#F7FAF6] !px-[13px] !text-[13.5px] !font-bold !text-[#0A1F17]'
                      )}
                    >
                      {__WEB__ && <Lock className="h-[18px] w-[18px] shrink-0 text-[#8CA396]" />}
                      {tankerTransporterName || (
                        <span className="text-muted-foreground">
                          {directMode || isTrading
                            ? 'Not applicable — direct purchase'
                            : chosenTankers.length
                              ? 'Supplier-delivered / from tankers'
                              : 'Select tankers first'}
                        </span>
                      )}
                    </div>
                    <span className={cn('text-[11px] text-muted-foreground', NP_NOTE)}>
                      {directMode || isTrading ? 'No tanker movement, so no transporter.' : 'Taken from the selected tankers.'}
                    </span>
                  </div>
                  {/* Freight per vehicle. Every tanker carries its own rate, so
                      one field on the invoice could never show it — this lists
                      them, and the pencil opens that tanker to change it. Only
                      an EX tanker has freight of ours to price. */}
                  {!directMode && !isTrading && chosenTankers.length > 0 && (
                    <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
                      <Label>Transporter rate per {form.uom || 'MT'} (EX tankers)</Label>
                      <div className={cn('overflow-hidden rounded-md border', __WEB__ && '!overflow-visible !rounded-none !border-0 !space-y-2')}>
                        {chosenTankers.map((t, i) => {
                          const ex = condIsEx(t)
                          const rate = Number(t.transport_rate_per_ton) || 0
                          // Freight is earned on what ARRIVED, so the
                          // received qty is the basis — but only once there
                          // IS one. A tanker not yet weighed in carries 0,
                          // not null, so `!= null` priced a 30.41 MT load at
                          // zero and showed the freight as about Rs 0.00
                          // beside a real rate. The loaded qty stands in
                          // until the weighbridge answers, which is what the
                          // tanker dialog's own estimate already did.
                          const basis = Number(t.received_qty) > 0 ? Number(t.received_qty) : Number(t.loaded_qty) || 0
                          return (
                            <div
                              key={String(t.id)}
                              className={cn(
                                'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]',
                                i % 2 === 1 && 'bg-muted/30',
                                // Each tanker is its own card on the website;
                                // a zebra-striped list of three rows read as a
                                // table that had lost its header.
                                __WEB__ &&
                                  '!gap-x-[11px] !rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-[13px] !py-[11px] !text-[12.5px] !font-semibold'
                              )}
                            >
                              <span className={cn('min-w-0 shrink-0 font-medium', __WEB__ && 'doc-ref !text-[13.5px] !font-bold !text-[#0A1F17]')}>{t.tanker_no || '—'}</span>
                              <span
                                className={cn(
                                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                                  ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                                )}
                              >
                                {ex ? 'EX' : 'DLD'}
                              </span>
                              <span className="min-w-0 truncate text-muted-foreground">{t.transporter_name || (ex ? 'No transporter set' : '—')}</span>
                              {/* The rate is edited HERE, not only behind
                                  the pencil. It was a read-only figure whose
                                  only way in was a pencil that opens the
                                  whole tanker — six sections of stage dates
                                  and weighments, to change one number
                                  printed right there. Saved on blur or
                                  Enter through the same guarded backend call
                                  the dialog uses; Escape puts it back. */}
                              <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                                {ex ? (
                                  <>
                                    <Input
                                      type="number"
                                      step="any"
                                      aria-label={`Freight rate for ${t.tanker_no || 'this tanker'}`}
                                      placeholder="Rate"
                                      disabled={freightSaving === String(t.id)}
                                      className={cn(
                                        'h-7 w-24 text-right',
                                        !(rate > 0) && 'border-rose-400',
                                        __WEB__ && '!h-[30px] !w-[92px] !rounded-[4px] !text-[12.5px] !font-bold'
                                      )}
                                      value={freightDraft[String(t.id)] ?? (rate > 0 ? String(rate) : '')}
                                      onChange={(e) =>
                                        setFreightDraft((prev) => ({ ...prev, [String(t.id)]: e.target.value }))
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault()
                                          void saveFreightRate(t)
                                        }
                                        if (e.key === 'Escape') {
                                          setFreightDraft((prev) => {
                                            const next = { ...prev }
                                            delete next[String(t.id)]
                                            return next
                                          })
                                        }
                                      }}
                                      onBlur={() => void saveFreightRate(t)}
                                    />
                                    <span className="text-[11px] text-muted-foreground">
                                      /{t.uom || 'MT'}
                                      {rate > 0 && basis > 0 && (
                                        <>
                                          {' '}
                                          ≈ {formatINR(rate * basis)}
                                          {!(Number(t.received_qty) > 0) && ' on loaded'}
                                        </>
                                      )}
                                    </span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground">supplier pays</span>
                                )}
                              </span>
                              <button
                                type="button"
                                title={`Edit ${t.tanker_no || 'this tanker'}`}
                                className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() => openEditTanker(t)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                      <span className={cn('text-[11px] text-muted-foreground', NP_NOTE)}>
                        Agreed when the tanker goes In transit. Freight is priced on the received quantity.
                      </span>
                    </div>
                  )}
                  <div className={cn('flex flex-col gap-1.5', !tankerTransporterId && 'opacity-50')}>
                    <Label>Allowed shortage %</Label>
                    <Input
                      type="number"
                      value={form.allowed_shortage_pct ?? ''}
                      disabled={!tankerTransporterId}
                      placeholder={tankerTransporterId ? `default ${settings.allowed_shortage_pct ?? '0.2'}` : 'No transporter — N/A'}
                      onChange={(e) => setForm((p) => ({ ...p, allowed_shortage_pct: e.target.value }))}
                    />
                    <span className={cn('text-[11px] text-muted-foreground', NP_NOTE)}>Shortage tolerance before the transporter is charged.</span>
                  </div>

                  {/* Interest changes the rate the invoice is struck at, so
                      the panel takes the tone of whether it is on — the same
                      green the site uses for a live figure. */}
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-4 rounded-lg border px-3 py-2 md:col-span-3',
                      __WEB__ &&
                        cn(
                          '!gap-x-4 !gap-y-3 !rounded-[4px] !border !px-[14px] !py-[13px]',
                          form.charge_interest ? '!border-[#BFE3CB] !bg-[#F7FBF4]' : '!border-[#E4ECE3] !bg-[#FBFDFA]'
                        )
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <Switch
                        checked={!!form.charge_interest}
                        onCheckedChange={(v) =>
                          setForm((p) => ({ ...p, charge_interest: v, interest_touched: true }))
                        }
                      />
                      <div className="flex items-center gap-1.5">
                        <span className={cn('text-sm font-medium', __WEB__ && '!whitespace-nowrap !text-[13px] !font-extrabold !text-[#0A1F17]')}>Supplier interest</span>
                        <InfoTip text="Interest = BG rate incl. GST × Int% × days ÷ 365; the adjusted invoice rate is BG rate + interest. Defaults ON when the supplier charges interest and the tankers are supplier-financed." />
                      </div>
                    </div>
                    <div className={cn('ml-auto flex items-center gap-2', !form.charge_interest && 'opacity-50')}>
                      <Label className="text-xs">Int %</Label>
                      <Input
                        type="number"
                        className="h-8 w-20 text-right"
                        disabled={!form.charge_interest}
                        value={form.interest_pct ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, interest_pct: e.target.value }))}
                      />
                      {/* Days and additional interest move into the per-bargain
                          panel below once the invoice spans several bargains —
                          shown in both places they read as duplicates. */}
                      {rateAlloc.length < 2 && (
                        <>
                          <Label className="text-xs">Days</Label>
                          <Input
                            type="number"
                            className="h-8 w-20 text-right"
                            disabled={!form.charge_interest}
                            value={form.interest_days ?? ''}
                            onChange={(e) => setForm((p) => ({ ...p, interest_days: e.target.value }))}
                          />
                        </>
                      )}
                    </div>
                    {rateAlloc.length < 2 ? (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <Label className="text-xs">Additional interest (₹/{form.uom || 'MT'})</Label>
                          <InfoTip text="A manual per-unit interest you can add on top; it is included in the adjusted invoice rate (and therefore the taxable value, GST and net)." />
                        </div>
                        <Input
                          type="number"
                          className="h-8 w-24 text-right"
                          placeholder="0"
                          value={form.additional_interest ?? ''}
                          onChange={(e) => setForm((p) => ({ ...p, additional_interest: e.target.value }))}
                        />
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        Days &amp; additional interest are set per bargain below.
                      </span>
                    )}
                  </div>

                  {/* Two bargains on one invoice are two different deals — each
                      can carry its own additional interest and its own days,
                      added straight into THAT bargain's rate. Left blank, a
                      bargain just inherits the invoice-wide figures above. */}
                  {rateAlloc.length > 1 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 md:col-span-3">
                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                          Per-bargain interest
                        </span>
                        <InfoTip text="Set against one bargain, these replace the invoice-wide additional interest / days for that bargain's quantity only. Leave a box empty to inherit the shared value." />
                      </div>
                      <div className="grid gap-2">
                        {rateAlloc.map((a) => {
                          const { lineRate } = lineFiguresOf(a.bargain_id, a.rate)
                          return (
                            <div key={a.bargain_id} className="flex flex-wrap items-center gap-2 rounded-md bg-card px-2.5 py-2">
                              <div className="min-w-[13rem] flex-1">
                                <div className="text-xs font-medium">{a.bargain_no}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {formatINR(a.rate)} · {formatNum(a.qty)} {form.uom || 'MT'}
                                </div>
                              </div>
                              <Label className="text-[11px] text-muted-foreground">Addl. int (₹/{form.uom || 'MT'})</Label>
                              <Input
                                type="number"
                                className="h-8 w-24 text-right"
                                placeholder={String(Number(form.additional_interest) || 0)}
                                value={bargainInterest[String(a.bargain_id)]?.additional_interest ?? ''}
                                onChange={(e) => setBargainInterest(a.bargain_id, 'additional_interest', e.target.value)}
                              />
                              <Label className="text-[11px] text-muted-foreground">Days</Label>
                              <Input
                                type="number"
                                className="h-8 w-20 text-right"
                                disabled={!form.charge_interest}
                                placeholder={String(Number(form.interest_days) || 0)}
                                value={bargainInterest[String(a.bargain_id)]?.interest_days ?? ''}
                                onChange={(e) => setBargainInterest(a.bargain_id, 'interest_days', e.target.value)}
                              />
                              <div className="ml-auto text-right">
                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Line rate</div>
                                <div className="text-xs font-semibold tabular-nums">{formatINR(lineRate)}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {Number(form.bargain_rate) > 0 && Number(form.invoice_rate) > Number(form.bargain_rate) && (
                    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 md:col-span-3">
                      <div className="flex items-center gap-2.5">
                        <Switch
                          checked={!!form.freight_paid_to_supplier}
                          onCheckedChange={(v) => setForm((p) => ({ ...p, freight_paid_to_supplier: v }))}
                        />
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">Transporter charges paid to supplier</span>
                          <InfoTip text={`Invoice rate is ${formatINR(Number(form.invoice_rate) - Number(form.bargain_rate))}/${form.uom || 'MT'} above the bargain rate. ON: that difference is kept as per-${form.uom || 'MT'} freight data on this invoice's tankers and NO transporter ledger is posted — the supplier already paid the transporter.`} />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5 md:col-span-3">
                    <Label>Remarks</Label>
                    <textarea
                      rows={2}
                      className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Optional notes about this invoice"
                      value={form.remarks ?? ''}
                      onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))}
                    />
                  </div>
                </div>
                <div
                  className={cn(
                    'mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800',
                    __WEB__ &&
                      '!m-[18px] !mt-0 !flex !items-start !gap-2.5 !rounded-[4px] !border-[#BFE3CB] !border-l-4 !border-l-[#12855A] !bg-[#E9F5EE] !px-[14px] !py-3 !text-[12.5px] !font-bold !leading-[1.5] !text-[#0B6B45]'
                  )}
                >
                  {__WEB__ && <Landmark className="mt-[1px] h-[18px] w-[18px] shrink-0" />}
                  Saving the purchase automatically posts its payable amount to the supplier ledger.
                </div>
              </section>

              {isTrading ? (
                <section className="rounded border border-teal-300 bg-teal-50/40 p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                  <div className="mb-3 flex items-center justify-between gap-3 border-b border-dotted border-teal-200 pb-1.5">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-teal-900">Trading — no bargain, no stock</h3>
                    <Badge className="bg-teal-600 hover:bg-teal-600">Trading</Badge>
                  </div>
                  {!form.supplier_id ? (
                    <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                      Select the supplier first.
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Product *</Label>
                        <Select
                          value={String(form.oil_type_id || '')}
                          onValueChange={(v) => setForm((p) => ({ ...p, oil_type_id: v }))}
                          disabled={!!editing}
                        >
                          <SelectTrigger><SelectValue placeholder="Select the product" /></SelectTrigger>
                          <SelectContent className="max-h-64">
                            {products.map((p) => (
                              <SelectItem key={String(p.id)} value={String(p.id)}>{p.code || p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Quantity to invoice * ({form.uom || 'MT'})</Label>
                        <Input
                          type="number"
                          value={form.ordered_qty ?? ''}
                          placeholder="0.000"
                          onChange={(e) => setForm((p) => ({ ...p, ordered_qty: e.target.value }))}
                        />
                      </div>
                      <div className="md:col-span-2 rounded-md border border-teal-200 bg-white/60 px-3 py-2 text-xs text-teal-900">
                        Bought from this supplier, resold straight to a customer — no bargain is drawn and this quantity never enters or leaves stock.
                      </div>
                    </div>
                  )}
                </section>
              ) : directMode ? (
                <section className="rounded border border-violet-300 bg-violet-50/40 p-4 [&_label]:text-[10px] [&_label]:uppercase [&_label]:tracking-wide [&_label]:text-muted-foreground">
                  <div className="mb-3 flex items-center justify-between gap-3 border-b border-dotted border-violet-200 pb-1.5">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-violet-900">Direct purchase — no tanker movement</h3>
                    <Badge className="bg-violet-600 hover:bg-violet-600">Direct</Badge>
                  </div>
                  {!form.supplier_id ? (
                    <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                      Select the supplier first.
                    </div>
                  ) : (
                    <>
                    {/* Available stock as chips, then product + quantity. */}
                    {partyStock.length === 0 ? (
                      <div className="mb-3 rounded-lg border border-dashed bg-white/60 px-3 py-3 text-center text-xs text-muted-foreground">
                        No stock logged for this party yet.
                      </div>
                    ) : (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-violet-900/70">
                          Available
                        </span>
                        {partyStock.map((p) => {
                          const picked = String(form.oil_type_id || '') === String(p.product_id)
                          return (
                            <button
                              key={String(p.product_id)}
                              type="button"
                              onClick={() => chooseDirectProduct(p)}
                              className={cn(
                                'rounded-md border bg-white px-2.5 py-1 text-[12px] transition',
                                picked ? 'border-violet-500 ring-1 ring-violet-300' : 'hover:bg-muted/40'
                              )}
                            >
                              <span className="font-medium">{p.product_code || p.product_name}</span>
                              <span className="ml-1.5 font-bold tabular-nums text-emerald-700">
                                {formatNum(p.balance)}
                              </span>
                              <span className="ml-0.5 text-[10px] text-muted-foreground">{p.uom || 'MT'}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    <div className="mb-3 grid gap-4 md:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label>Product *</Label>
                        <Select
                          value={String(form.oil_type_id || '')}
                          onValueChange={(v) => {
                            const p = partyStock.find((x) => String(x.product_id) === v)
                            if (p) chooseDirectProduct(p)
                          }}
                          disabled={!!editing}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={partyStock.length ? 'Select the product' : 'No stock for this party'} />
                          </SelectTrigger>
                          <SelectContent>
                            {partyStock.map((p) => (
                              <SelectItem key={String(p.product_id)} value={String(p.product_id)}>
                                {p.product_code || p.product_name} · {formatNum(p.balance)} {p.uom || 'MT'} available
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Quantity to invoice * ({form.uom || 'MT'})</Label>
                        <Input
                          type="number"
                          value={form.ordered_qty ?? ''}
                          placeholder="0.000"
                          onChange={(e) => setForm((p) => ({ ...p, ordered_qty: e.target.value }))}
                        />
                        {directAvailable != null && (
                          <span
                            className={cn(
                              'text-[11px]',
                              totalQty > directAvailable + 1e-6 ? 'font-medium text-red-600' : 'text-muted-foreground'
                            )}
                          >
                            {totalQty > directAvailable + 1e-6
                              ? `Only ${formatNum(directAvailable)} available`
                              : `${formatNum(directAvailable - totalQty)} ${form.uom || 'MT'} left after this`}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Step 3 — which bargains that quantity is drawn from. */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-violet-900">Draw it from</span>
                      {!bgTouched && bgAlloc.length > 0 && (
                        <Badge variant="secondary" className="font-normal">oldest bargain first</Badge>
                      )}
                      {totalQty > 0 && (
                        <span className="text-[11px] text-violet-800/80">
                          {formatNum(bgAllocated)} of {formatNum(totalQty)} {form.uom || 'MT'} allocated
                          {Math.abs(bgRemaining) > 1e-6 && (
                            <b>
                              {' '}
                              · {bgRemaining > 0 ? `${formatNum(bgRemaining)} still to allocate` : `${formatNum(-bgRemaining)} over`}
                            </b>
                          )}
                        </span>
                      )}
                    </div>
                    {totalQty <= 0 ? (
                      <div className="rounded-lg border border-dashed bg-white/60 px-3 py-3 text-center text-xs text-muted-foreground">
                        Enter a quantity to see the bargains.
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {bgLines.map((line, index) => {
                          const bg = bargains.find((b) => String(b.id) === String(line.bargain_id))
                          const bal = bg ? Number(bg.balance_qty) || 0 : 0
                          const qty = Number(line.qty) || 0
                          return (
                            <div
                              key={index}
                              className="grid gap-2 rounded-lg border bg-white p-2.5 md:grid-cols-[minmax(0,1fr)_7rem_auto]"
                            >
                              <div className="flex min-w-0 flex-col gap-1">
                                <Label className="text-[11px] text-muted-foreground">Bargain</Label>
                                <Select
                                  value={String(line.bargain_id || '')}
                                  onValueChange={(v) =>
                                    editBgLines((p) => p.map((x, i) => (i === index ? { ...x, bargain_id: v } : x)))
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue
                                      placeholder={directBargains.length ? 'Select bargain' : 'No open bargain for this product'}
                                    />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {directBargains.map((b) => (
                                      <SelectItem key={b.id} value={String(b.id)}>
                                        {b.bargain_no} · {formatDate(b.bargain_date)} · bal {formatNum(b.balance_qty)}{' '}
                                        {b.uom} @ {formatINR(b.rate_per_uom)}
                                        {Number(b.balance_qty) + 1e-6 >= totalQty ? ' · covers it' : ''}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <Label className="text-[11px] text-muted-foreground">Qty</Label>
                                <Input
                                  type="number"
                                  className="h-8 text-right text-xs"
                                  value={line.qty ?? ''}
                                  onChange={(e) =>
                                    editBgLines((p) => p.map((x, i) => (i === index ? { ...x, qty: e.target.value } : x)))
                                  }
                                />
                              </div>
                              <div className="flex items-end gap-2">
                                <div className="min-w-[8.5rem] pb-1 text-[11px] leading-tight">
                                  {bg ? (
                                    <>
                                      <div className="tabular-nums text-muted-foreground">
                                        {formatINR(Number(bg.rate_per_uom) * qty)}
                                      </div>
                                      <div className={cn(qty > bal + 1e-6 ? 'font-medium text-red-600' : 'text-muted-foreground')}>
                                        {qty > bal + 1e-6
                                          ? `${formatNum(qty - bal)} over its balance`
                                          : `balance left ${formatNum(bal - qty)}`}
                                      </div>
                                    </>
                                  ) : (
                                    <span className="text-muted-foreground">pick a bargain</span>
                                  )}
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive"
                                  disabled={bgLines.length === 1}
                                  onClick={() => editBgLines((p) => p.filter((_, i) => i !== index))}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => editBgLines((p) => [...p, { bargain_id: '', qty: '' }])}
                          >
                            <Plus className="h-4 w-4" /> Add another bargain
                          </Button>
                          {bgTouched && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() => {
                                const next = fifoFill(Number(form.ordered_qty) || 0)
                                setBgLines(next.length ? next : [{ bargain_id: '', qty: '' }])
                                setBgTouched(false)
                              }}
                            >
                              Refill oldest first
                            </Button>
                          )}
                          {Math.abs(bgRemaining) > 1e-6 && bgLines.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() =>
                                editBgLines((p) =>
                                  p.map((x, i) =>
                                    i === p.length - 1 ? { ...x, qty: String((Number(x.qty) || 0) + bgRemaining) } : x
                                  )
                                )
                              }
                            >
                              Put the remaining {formatNum(Math.abs(bgRemaining))} on the last line
                            </Button>
                          )}
                          {bgAlloc.length > 1 && (
                            <span className="text-[11px] text-muted-foreground">
                              {bgAlloc.length} bargains — the invoice prices at the weighted-average rate{' '}
                              {formatINR(Number(form.bargain_rate) || 0)}/{form.uom || 'MT'}.
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    </>
                  )}
                </section>
              ) : (
              <section className={cn('rounded border border-[#e5dfc8] bg-white p-4', __WEB__ && cn(NP_CARD, '!p-[18px]'))}>
                <div
                  className={cn(
                    'mb-3 flex items-center justify-between border-b border-dotted border-[#e5dfc8] pb-1.5',
                    __WEB__ &&
                      '!-mx-[18px] !-mt-[18px] !mb-[14px] !items-start !gap-3 !rounded-t-[3px] !border-b !border-solid !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[18px] !py-[13px]'
                  )}
                >
                  <div className={cn(__WEB__ && 'min-w-0')}>
                    <h3
                      className={cn(
                        'text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]',
                        __WEB__ && '!flex !items-center !gap-[9px] !text-[11.5px] !font-extrabold !tracking-[.14em] !text-[#0A1F17]'
                      )}
                    >
                      {__WEB__ && <Truck className="h-[19px] w-[19px] text-[#33473E]" />}
                      Tankers on this invoice
                    </h3>
                    <p className={cn('text-xs text-muted-foreground', __WEB__ && cn(NP_NOTE, '!mt-[5px]'))}>All the supplier&apos;s unbilled loaded tankers — tick the ones covered by this invoice.</p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn(
                      __WEB__ &&
                        cn(
                          '!shrink-0 !rounded-[2px] !border !px-2.5 !py-[5px] !text-[11px] !font-extrabold !tracking-[.05em]',
                          selected.length
                            ? '!border-[#BFE3CB] !bg-[#E9F5EE] !text-[#0B6B45]'
                            : '!border-[#DCE7DB] !bg-[#EAF0E9] !text-[#5A6B62]'
                        )
                    )}
                  >
                    {selected.length} selected
                  </Badge>
                </div>
                {!form.supplier_id ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">Select the supplier to see all its loaded tankers.</div>
                ) : selectableTankers.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No unbilled loaded tankers for this supplier.</div>
                ) : (
                  <div className="grid gap-2">
                    {mixedRates && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        The selected tankers come from bargains with different rates — the invoice uses the first tanker&apos;s bargain rate, so adjust the invoice rate if needed.
                      </div>
                    )}
                    {selectableTankers.map((tanker) => {
                      const checked = selected.includes(Number(tanker.id))
                      return (
                        <label
                          key={tanker.id}
                          className={cn(
                            'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition',
                            checked ? 'border-amber-400 bg-amber-50' : 'hover:bg-muted/40',
                            // A picked tanker is marked down its left edge as
                            // well as tinted — running an eye down the rail is
                            // faster than reading six tick boxes.
                            __WEB__ &&
                              cn(
                                '!gap-[13px] !rounded-[4px] !border !border-l-[3px] !px-[14px] !py-[13px]',
                                checked
                                  ? '!border-[#E8DFC0] !border-l-[#C7F03F] !bg-[#FDFBF3]'
                                  : '!border-[#E4ECE3] !border-l-transparent !bg-white hover:!bg-[#FBFDFA]'
                              )
                          )}
                        >
                          <input
                            type="checkbox"
                            className={cn('h-4 w-4 accent-amber-500', __WEB__ && '!h-[18px] !w-[18px] !shrink-0 !accent-[#0B3D2E]')}
                            checked={checked}
                            onChange={(e) => setSelected((p) => e.target.checked ? [...p, Number(tanker.id)] : p.filter((id) => id !== Number(tanker.id)))}
                          />
                          <div className="min-w-0 flex-1">
                            <div className={cn('font-medium', __WEB__ && 'doc-ref !text-[14.5px] !font-bold !tracking-[-0.01em] !text-[#0A1F17]')}>{tanker.tanker_no}</div>
                            <div className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-1 !truncate !text-[11.5px] !font-semibold !text-[#5A6B62]')}>
                              {tanker.bargain_no} · {tanker.oil_code || tanker.oil_name} · Loaded {formatDate(tanker.loaded_date)} · {tanker.payment_mode === 'supplier_finance' ? 'Supplier financed' : 'Paid by us'}
                            </div>
                          </div>
                          <div className={cn('font-medium tabular-nums', __WEB__ && 'doc-ref !shrink-0 !text-[14.5px] !font-bold !tracking-[-0.02em] !text-[#0A1F17]')}>{formatNum(tanker.loaded_qty)} {tanker.uom}</div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>
              )}
            </div>

            <aside className={cn('h-fit rounded border border-[#d9d2b8] bg-[#f7f2e2] p-4 xl:sticky xl:top-6', NP_RAIL)}>
              <h3
                className={cn(
                  'mb-2 border-b border-[#d9d2b8] pb-1.5 text-[11px] font-bold uppercase tracking-widest text-[#1a2c56]',
                  NP_RAIL_HEAD
                )}
              >
                {__WEB__ && <IndianRupee className="h-[18px] w-[18px] text-[#8A5300]" />}
                Purchase summary
              </h3>
              {/* Every band below is one question: how much is on the invoice,
                  what rate it is struck at, what tax does to it, and what is
                  left to pay. The rules between them are the bands. */}
              <div className={cn(__WEB__ && NP_RAIL_SECT)}>
              {isTrading ? (
                <>
                  <MoneyRow label="Purchase type" value="Trading — no bargain, no stock" />
                  <MoneyRow label="Quantity invoiced" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                </>
              ) : directMode ? (
                <>
                  <MoneyRow label="Purchase type" value="Direct — no tanker movement" />
                  {directAvailable != null && (
                    <MoneyRow
                      label="Available from party"
                      value={`${formatNum(directAvailable)} ${form.uom || 'MT'}`}
                    />
                  )}
                  {bgAlloc.length > 1 && <MoneyRow label="Bargains drawn" value={String(bgAlloc.length)} />}
                  <MoneyRow label="Quantity invoiced" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                </>
              ) : (
                <>
                  <MoneyRow label="Tankers" value={String(selected.length)} />
                  <MoneyRow label="Total loaded quantity" value={`${formatNum(totalQty)} ${form.uom || 'MT'}`} strong />
                  <MoneyRow label="Paid by us" value={String(selected.length - financedCount)} />
                  <MoneyRow label="Supplier financed" value={String(financedCount)} />
                </>
              )}
              </div>
              <div className={cn('my-3 border-t', __WEB__ && '!hidden')} />
              <div className={cn(__WEB__ && NP_RAIL_SECT)}>
              {rateAlloc.length > 1 ? (
                rateAlloc.map((a, i) => (
                  <MoneyRow
                    key={a.bargain_no}
                    label={`Bargain rate ${i + 1}`}
                    title={`${a.bargain_no} · ${formatNum(a.qty)} ${form.uom || 'MT'}`}
                    value={formatINR(a.rate)}
                  />
                ))
              ) : (
                <MoneyRow label="Bargain rate" value={formatINR(Number(form.bargain_rate) || 0)} />
              )}
              {/* Interest, per bargain when the invoice spans more than one.
                  Quoted PER UNIT like every other rate row in this block — the
                  line total is on hover. Hidden entirely when it works out to
                  nothing, so a 0%/0-day invoice carries no empty row. */}
              {rateAlloc.length > 1
                ? rateAlloc.map((a, i) => {
                    const { perUnitInterest } = lineFiguresOf(a.bargain_id, a.rate)
                    if (perUnitInterest <= 0) return null
                    const eff = lineInterestOf(a.bargain_id)
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-int`}
                        label={`Interest ${i + 1} @ ${Number(form.interest_pct) || 0}% · ${eff.interestDays}d`}
                        title={`${a.bargain_no} — per ${form.uom || 'MT'} · ${formatNum(a.qty)} ${form.uom || 'MT'} = ${formatINR(perUnitInterest * a.qty)}`}
                        value={formatINR(perUnitInterest)}
                      />
                    )
                  })
                : !!form.charge_interest && calc.interestPerUnit > 0 && (
                    <MoneyRow
                      label={`Interest @ ${Number(form.interest_pct) || 0}% · ${Number(form.interest_days) || 0}d`}
                      title={`Per ${form.uom || 'MT'} · ${formatNum(totalQty)} ${form.uom || 'MT'} = ${formatINR(calc.interestPerUnit * totalQty)}`}
                      value={formatINR(calc.interestPerUnit)}
                    />
                  )}
              {/* Additional interest — the value shown is that bargain's rate
                  WITH its own additional interest folded in, so the running
                  per-unit rate is readable line by line. */}
              {rateAlloc.length > 1
                ? rateAlloc.map((a, i) => {
                    const { additionalInterest } = lineFiguresOf(a.bargain_id, a.rate)
                    if (additionalInterest <= 0) return null
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-addl`}
                        label={`Additional interest ${i + 1} (${formatINR(additionalInterest)}/${form.uom || 'MT'})`}
                        title={`${a.bargain_no} — bargain rate ${formatINR(a.rate)} plus ${formatINR(additionalInterest)}/${form.uom || 'MT'}`}
                        value={formatINR(a.rate + additionalInterest)}
                      />
                    )
                  })
                : Number(form.additional_interest) > 0 && (
                    <MoneyRow
                      label={`Additional interest (${formatINR(Number(form.additional_interest))}/${form.uom || 'MT'})`}
                      title={`Bargain rate ${formatINR(Number(form.bargain_rate) || 0)} plus ${formatINR(Number(form.additional_interest))}/${form.uom || 'MT'}`}
                      value={formatINR((Number(form.bargain_rate) || 0) + (Number(form.additional_interest) || 0))}
                    />
                  )}
              {/* Freight the supplier billed inside the rate — shown on its own
                  row so a premium that reaches every line is never invisible. */}
              {ratePremium !== 0 && (
                <MoneyRow
                  label={`Freight in invoice rate (${formatINR(ratePremium)}/${form.uom || 'MT'})`}
                  title={`Invoice rate ${formatINR(Number(form.invoice_rate) || 0)} less the blended bargain rate ${formatINR(blendedRate)} — applied to every bargain line`}
                  value={formatINR(ratePremium * totalQty)}
                />
              )}
              {/* T1, T2 … — each bargain's finished per-unit rate (whole rupee,
                  as the supplier bills it). The average below is these
                  weighted by quantity, which is what the invoice charges. */}
              {rateAlloc.length > 1 && (
                <>
                  <div className="border-t" />
                  {rateAlloc.map((a, i) => {
                    const { lineRate } = lineFiguresOf(a.bargain_id, a.rate)
                    return (
                      <MoneyRow
                        key={`${a.bargain_no}-t`}
                        label={`T${i + 1} (${a.bargain_no})`}
                        title={`Final rate per ${form.uom || 'MT'} · ${formatNum(a.qty)} ${form.uom || 'MT'} = ${formatINR(lineRate * a.qty)}`}
                        value={formatINR(lineRate)}
                        strong
                      />
                    )
                  })}
                </>
              )}
              {/* The adjusted rate is billed at the whole rupee, rounded UP —
                  that is how the supplier invoices it, and the taxable value is
                  struck on the rounded figure. Rounding it silently made the
                  column stop adding up: bargain 1,28,100.00 plus interest
                  829.14 read as 1,28,930.00, with the 86 paise nowhere. The
                  rounding now has its own line, so the arithmetic on screen is
                  the arithmetic that was done. */}
              {/* The rate used to be rounded UP to the whole rupee, always,
                  because that is how the supplier bills — but not every
                  supplier does, and it moved the invoice by a few rupees with
                  nothing to argue with. It is a figure now: nil unless somebody
                  says otherwise, typed if the supplier billed some other
                  adjustment, and one click away if they did round up. */}
              {(() => {
                const r2 = (v: number): number => Math.round(v * 100) / 100
                const exact = r2(
                  (Number(form.bargain_rate) || 0) +
                    (Number(calc.interestPerUnit) || 0) +
                    (Number(form.additional_interest) || 0) +
                    ratePremium
                )
                if (exact <= 0) return null
                const toWhole = r2(Math.ceil(exact) - exact)
                const applied = r2((Number(calc.adjustedRate) || 0) - exact)
                const legacy = rateRoundOff == null
                return (
                  <div className={cn('flex items-center justify-between gap-2 py-1.5 text-sm', __WEB__ && '!items-start !gap-2.5 !py-[5px]')}>
                    <span
                      className={cn('min-w-0 text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !leading-[1.45] !text-[#33473E]')}
                      title={`Exact ${formatINR(exact)} per ${form.uom || 'MT'}. Nil bills that rate as it stands. Type an amount, or use ↑ to round up to the whole rupee the way the supplier does.`}
                    >
                      Rate adjustment{' '}
                      <span className="text-[11px]">
                        {legacy
                          ? `(rounded up, +${formatINR(applied)})`
                          : `per ${form.uom || 'MT'}`}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {toWhole > 0.004 && r2(rateRoundOff ?? -1) !== toWhole && (
                        <Button
                          type="button"
                          variant="outline"
                          className={cn('h-7 bg-white px-1.5 text-[11px]', __WEB__ && '!h-[34px] !gap-1 !rounded-[3px] !border-[#C3B78F] !px-[9px] !text-[11.5px] !font-bold !text-[#8A5300]')}
                          title={`Round up to ${formatINR(Math.ceil(exact))} — the whole rupee`}
                          onClick={() => setForm((p) => ({ ...p, rate_round_off: String(toWhole) }))}
                        >
                          ↑ {formatINR(toWhole)}
                        </Button>
                      )}
                      <Input
                        type="number"
                        className={cn('h-7 w-24 text-right', __WEB__ && cn(NP_RAIL_INPUT, '!w-[88px]'))}
                        placeholder="0.00"
                        value={form.rate_round_off ?? ''}
                        onChange={(e) => setForm((p) => ({ ...p, rate_round_off: e.target.value }))}
                      />
                    </div>
                  </div>
                )
              })()}
              <MoneyRow
                label={rateAlloc.length > 1 ? 'Adjusted invoice rate (avg)' : 'Adjusted invoice rate'}
                title={
                  rateAlloc.length > 1
                    ? `Quantity-weighted average across ${rateAlloc.length} bargains`
                    : `x ${formatNum(totalQty)} ${form.uom || 'MT'} = ${formatINR(calc.taxableValue)}`
                }
                value={formatINR(calc.adjustedRate)}
                strong
              />
              </div>
              <div className={cn('my-2 border-t', __WEB__ && '!hidden')} />
              <div className={cn(__WEB__ && NP_RAIL_SECT)}>
              <MoneyRow label="Taxable value" value={formatINR(calc.taxableValue)} />
              {form.gst_type === 'IGST' ? (
                <MoneyRow label={`IGST${form.gst_pct ? ` @ ${form.gst_pct}%` : ''}`} value={formatINR(calc.gstAmount)} />
              ) : (
                <>
                  <MoneyRow label={`CGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                  <MoneyRow label={`SGST${form.gst_pct ? ` @ ${(Number(form.gst_pct) || 0) / 2}%` : ''}`} value={formatINR(calc.gstAmount / 2)} />
                </>
              )}
              <div className="border-t" />
              <MoneyRow label="Total value (excl. TDS)" value={formatINR(calc.taxableValue + calc.gstAmount)} strong />
              <div className={cn('flex items-center justify-between py-1.5 text-sm', __WEB__ && '!gap-2.5 !py-[5px]')}>
                <span className={cn('text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')} title="Applied to the total excluding TDS. TDS is then deducted on the rounded figure. Auto-rounds to the nearest rupee; type to override, clear to go back to auto.">
                  Round off {form.round_off_manual ? '(manual)' : '(auto)'}
                </span>
                <Input
                  type="number"
                  className={cn('h-7 w-28 text-right', __WEB__ && cn(NP_RAIL_INPUT, '!w-[96px]'))}
                  placeholder="0.00"
                  value={form.round_off ?? ''}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      round_off: e.target.value,
                      round_off_manual: e.target.value !== ''
                    }))
                  }
                />
              </div>
              <MoneyRow label="Total after round off" value={formatINR(calc.roundedTotal)} strong />
              {/* The label used to read "on the rounded total", which is
                  what it WAS struck on before the basis was corrected to the
                  taxable value. The figure has been right since; the caption
                  was still describing the old rule, so a correct TDS read as
                  a wrong one — 0.1% of the 44,54,305 total is 4,454.31, and
                  nothing on the rail explained why 3,047.40 was posted. The
                  supplier's slab is the reason, and the icon now shows it. */}
              <div className={cn('flex items-center justify-between py-1.5 text-sm', __WEB__ && '!gap-2.5 !py-[5px]')}>
                <span className={cn('flex items-center gap-1.5 text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>
                  TDS (on the taxable value)
                  <button
                    type="button"
                    title="How this TDS was worked out"
                    className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    onClick={() => setTdsOpen(true)}
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </span>
                <span className={cn('tabular-nums', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>
                  − {formatINR(calc.tdsAmount)}
                </span>
              </div>
              </div>
              <div className={cn('my-2 border-t-2 border-[#1a2c56]', __WEB__ && '!hidden')} />
              {/* The answer, on the forest band — the one figure somebody
                  scrolls this rail to find. */}
              <div
                className={cn(
                  'flex items-center justify-between text-[15px] font-bold text-[#1a2c56]',
                  __WEB__ && '!gap-3 !bg-[#0B3D2E] !px-[18px] !py-[15px] !text-[12.5px] !font-extrabold !text-white'
                )}
              >
                <span>Net purchase amount</span>
                <span className={cn('tabular-nums', __WEB__ && 'doc-ref !whitespace-nowrap !text-[17px] !font-bold !tracking-[-0.03em] !text-[#C7F03F]')}>{formatINR(calc.netAmount)}</span>
              </div>
              <div className={cn(__WEB__ && 'px-[18px] py-[14px]')}>
              {error && <p className={cn('mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700', __WEB__ && '!mt-0 !mb-2.5 !rounded-[4px] !border-[#F0AFAA] !bg-[#FDF3F2] !text-[12.5px] !font-bold !text-[#8C2F26]')}>{error}</p>}
              {/* What is still missing, or what saving will do. The page used
                  to answer that only by refusing to save. */}
              {__WEB__ && (() => {
                const need: string[] = []
                if (!String(form.invoice_no || '').trim()) need.push('invoice number')
                if (!(Number(form.invoice_rate) > 0)) need.push('bargain rate')
                if (!isTrading && !directMode && !selected.length) need.push('at least one tanker')
                if (!form.supplier_id) need.push('supplier')
                const ok = need.length === 0
                return (
                  <div className="mb-2.5 flex items-start gap-2">
                    {ok ? (
                      <CheckCircle2 className="mt-[1px] h-[17px] w-[17px] shrink-0 text-[#0B6B45]" />
                    ) : (
                      <AlertTriangle className="mt-[1px] h-[17px] w-[17px] shrink-0 text-[#8A5300]" />
                    )}
                    <span
                      className={cn(
                        'text-[11.5px] font-bold leading-[1.5]',
                        ok ? 'text-[#0B6B45]' : 'text-[#8A5300]'
                      )}
                    >
                      {ok
                        ? editing
                          ? `Saving amends invoice ${form.invoice_no} and reposts it to the ledger.`
                          : `Saving posts ${formatINR(calc.netAmount)} to the supplier ledger.`
                        : `${need.length} required: ${need.join(', ')}`}
                    </span>
                  </div>
                )
              })()}
              <div className={cn('mt-4 grid grid-cols-2 gap-2', __WEB__ && '!mt-0 !grid-cols-[1fr_1.4fr] !gap-[9px]')}>
                <Button
                  variant="outline"
                  className={cn('bg-white', __WEB__ && '!h-[46px] !rounded-[4px] !border-[1.5px] !border-[#C3B78F] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-[#33473E] hover:!bg-[#F7F2E2]')}
                  onClick={() => setFormPage(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  className={cn('bg-[#1a2c56] hover:bg-[#24407e]', __WEB__ && '!h-[46px] !gap-[7px] !rounded-[4px] !bg-[#0B3D2E] !text-[12.5px] !font-extrabold !uppercase !tracking-[.04em] !text-[#C7F03F] hover:!bg-[#0F5138]')}
                  onClick={savePurchase}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : editing ? 'Save changes' : 'Accept purchase'}
                </Button>
              </div>
              <p className={cn('mt-2 text-center text-[10px] text-muted-foreground', __WEB__ && '!text-[11px] !font-semibold !text-[#8A7A4E]')}>Ctrl+A accepts, like Tally.</p>
              </div>
            </aside>
          </div>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-6 pt-3">
          <Tabs value={readingsOnly ? 'purchases' : tab} onValueChange={setTab}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              {/* Website: the handoff's underline tabs — a bar under the live
                  one rather than a pill, with the count as a chip beside the
                  label. The desktop app keeps the pill list. */}
              <TabsList
                className={cn(
                  __WEB__ &&
                    '!h-auto !gap-6 !rounded-none !border-b !border-[#D6E2D6] !bg-transparent !p-0 [&>button]:!h-[52px] [&>button]:!rounded-none [&>button]:!border-b-[3px] [&>button]:!border-transparent [&>button]:!bg-transparent [&>button]:!px-0 [&>button]:!text-[14.5px] [&>button]:!font-semibold [&>button]:!text-[#5A6B62] [&>button]:!shadow-none [&>button[data-state=active]]:!border-[#0B3D2E] [&>button[data-state=active]]:!font-extrabold [&>button[data-state=active]]:!text-[#0A1F17]'
                )}
              >
              <TabsTrigger value="tankers" className={cn(readingsOnly && '!hidden')}>
                Tanker movement
                {/* The count the page is actually showing — the two group
                    cards below always add up to exactly this. It used to be
                    the whole register for the active company, which ignored
                    the date range, the category, the strip's own company
                    picker and the search box, so it sat there disagreeing
                    with every number underneath it. Rendered even at 0, so a
                    filter that matches nothing says so instead of the badge
                    quietly vanishing. */}
                {__WEB__ && (
                  <span
                    title="Tankers matching the filters below"
                    className={cn(
                      'ml-2 rounded-[2px] px-1.5 py-[3px] text-[12px] font-extrabold',
                      tab === 'tankers' ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#33473E]'
                    )}
                  >
                    {visibleTankers.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="purchases">Purchase entries</TabsTrigger>
              <TabsTrigger value="unmapped" className={cn(readingsOnly && '!hidden')}>
                Unmapped invoices
                {unmapped.length > 0 && (
                  <span
                    className={cn(
                      'ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white',
                      // On the website the count reads as a chip like the
                      // others, not an alert pip.
                      __WEB__ && '!ml-2 !rounded-[2px] !bg-[#FFEDD0] !px-1.5 !py-[3px] !text-[12px] !font-extrabold !text-[#8A5300]'
                    )}
                  >
                    {unmapped.length}
                  </span>
                )}
              </TabsTrigger>
              </TabsList>
              {/* Filters live on the tab row, for the entries tab only. */}
              {tab === 'purchases' && (
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-2.5 py-1',
                    // The handoff's filter card. One height for every control
                    // on it — the pickers arrive at 28px and 32px otherwise —
                    // with the Switch excluded, since it is a button too and
                    // a 36px-tall toggle is a different control entirely.
                    __WEB__ &&
                      '!w-full !gap-x-3 !gap-y-2 !rounded-[4px] !border-[#D6E2D6] !bg-white !px-[18px] !py-3 [&_input]:!h-9 [&_input]:!rounded-[4px] [&_input]:!border-input [&_input]:!text-[12.5px] [&_button:not([role=switch])]:!h-9 [&_button:not([role=switch])]:!rounded-[4px] [&_button:not([role=switch])]:!text-[12.5px] [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[12.5px]'
                  )}
                >
                  <div className={cn('relative w-full sm:w-64', __WEB__ && 'sm:!w-72')}>
                    <Search className={cn('pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground', __WEB__ && '!left-3 !h-4 !w-4 !text-[#8AA096]')} />
                    <Input
                      type="search"
                      className={cn('h-8 pl-8 text-[11px]', __WEB__ && '!pl-9')}
                      placeholder="Search invoice, bargain, supplier, product, tanker…"
                      value={poSearch}
                      onChange={(e) => setPoSearch(e.target.value)}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className={cn('shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70', __WEB__ && PO_LABEL)}>
                      Date
                    </span>
                    <FyPicker from={poFrom} to={poTo} onRange={(f, t) => { setPoFrom(f); setPoTo(t) }} className="h-8 w-28 shrink-0 text-[11px]" />
                    <DatePicker value={poFrom} onChange={(v) => setPoFrom(v || '')} max={poTo || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                    <span className={cn('shrink-0 text-[10px] text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>to</span>
                    <DatePicker value={poTo} onChange={(v) => setPoTo(v || '')} min={poFrom || undefined} className="h-7 w-[9.5rem] shrink-0 text-[11px]" />
                  </div>
                  {/* Category is off the website's filter bar — the search box
                      beside it already matches on product, and dropping it
                      pulls the whole strip back onto one line. The desktop app
                      keeps it; the filtering below is untouched either way,
                      and simply never has a category to apply here. */}
                  {!__WEB__ && (
                    <>
                      <div className="h-5 border-l" />
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                          Category
                        </span>
                        <MultiSelectFilter
                          options={poCategories.map((cat) => ({ value: cat, label: cat.toUpperCase() }))}
                          value={poCategory}
                          onApply={setPoCategory}
                          allLabel="All categories"
                          className="h-7 w-[11.5rem] shrink-0 text-[11px]"
                        />
                      </div>
                    </>
                  )}
                  <div className="h-5 shrink-0 border-l" />
                  <div className="flex shrink-0 items-center gap-1.5" title="When on, a purchase also shows if a tanker on it was received in this window — even if the invoice itself was raised outside it.">
                    <Switch checked={poIncludeReceipt} onCheckedChange={setPoIncludeReceipt} className="shrink-0" />
                    <span className={cn('shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70', __WEB__ && PO_LABEL)}>
                      Include by receipt date
                    </span>
                  </div>
                  {(poFrom || poTo || poCategory.length > 0 || poSearch) && (
                    <>
                      <div className="h-5 shrink-0 border-l" />
                      <button
                        type="button"
                        className={cn(
                          'shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground',
                          __WEB__ && '!px-3 !text-[12.5px] !font-extrabold !tracking-[.06em] !text-[#0B6B45] hover:!text-[#0B3D2E]'
                        )}
                        onClick={() => { setPoFrom(''); setPoTo(''); setPoCategory([]); setPoSearch('') }}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <TabsContent value="tankers" className="space-y-5">
              <div className={cn('overflow-hidden rounded-xl border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                {/* Title and filters share one line, controls pushed right —
                    the strip below the heading cost two rows of height for
                    something the eye reads as part of the same header. */}
                <div
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3',
                    __WEB__ && '!items-center !gap-x-5 !gap-y-3 !border-[#EAF0E9] !px-[18px] !py-3'
                  )}
                >
                  <div className={cn(__WEB__ && 'shrink-0')}>
                    <h3 className={cn('font-medium', __WEB__ && '!text-[17px] !font-extrabold !tracking-[-0.02em]')}>
                      Tanker movement by oil type
                    </h3>
                    <p className={cn('text-xs text-muted-foreground', __WEB__ && '!mt-0.5 !text-[12px] !font-medium !text-[#5A6B62]')}>
                      Status as of {formatDate(pivotEnd)} · each tanker in its current stage · hover a count for tankers &amp; qty
                    </p>
                  </div>
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-2',
                      // One height for every control on the row, and the
                      // labels to one size — a search, a select and a date
                      // picker each default differently otherwise.
                      __WEB__ &&
                        // flex-1 with a zero basis, so the group stays on the
                        // heading's line and wraps *within itself* when the
                        // window narrows — at its natural width the parent's
                        // flex-wrap would drop the whole strip to line two.
                        // gap-y is halved because the zero-height break item
                        // sits on a wrap line of its own, so the row gap is
                        // paid twice between the two visible rows.
                        '!ml-auto !justify-end !gap-x-2 !gap-y-1 sm:!min-w-0 sm:!flex-1 [&_input]:!h-8 [&_input]:!rounded-[4px] [&_input]:!border-input [&_input]:!bg-white [&_input]:!text-[12px] [&_[data-slot=select-trigger]]:!h-8 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-input [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12px] [&_[data-slot=date-picker]]:!h-8 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-input [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[12px] [&>span]:!text-[10px] [&>span]:!font-extrabold [&>span]:!tracking-[.1em] [&>span]:!text-[#5A6B62] [&>button]:!h-8 [&>button]:!rounded-[4px] [&>button]:!text-[12px]'
                    )}
                  >
                    <div className={cn('relative w-full sm:w-60', __WEB__ && 'sm:!w-56')}>
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="search"
                        className="h-8 pl-8 text-[11px]"
                        placeholder="Search tanker, party, bargain, invoice…"
                        value={moveSearch}
                        onChange={(e) => setMoveSearch(e.target.value)}
                      />
                    </div>
                    <div className={cn('h-5 shrink-0 border-l', __WEB__ && '!hidden')} />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Company
                    </span>
                    <Select value={moveCompany} onValueChange={setMoveCompany} showCheckbox>
                      <SelectTrigger className="h-8 w-[11rem] text-[11px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active company</SelectItem>
                        <SelectItem value="all">All companies</SelectItem>
                        {companies.map((cm) => (
                          <SelectItem key={String(cm.id)} value={String(cm.id)}>{cm.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* A deliberate line break rather than letting flex-wrap
                        decide: a full-basis, zero-height item can share a line
                        with nothing, so search + company stay up beside the
                        heading and category + the date range always start a
                        second row. Renders as an inert hidden div on desktop,
                        which keeps its single-row strip intact. */}
                    <div className={__WEB__ ? 'h-0 w-full' : 'hidden'} />
                    <div className={cn('h-5 shrink-0 border-l', __WEB__ && '!hidden')} />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                      Category
                    </span>
                    <MultiSelectFilter
                      options={tmCategories.map((c) => ({ value: c, label: c.toUpperCase() }))}
                      value={tmCategory}
                      onApply={setTmCategory}
                      allLabel="All categories"
                      className="h-8 w-[10.5rem] text-[11px]"
                    />
                    <div className={cn('h-5 shrink-0 border-l', __WEB__ && '!hidden')} />
                    <span className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground/70">From</span>
                    <DatePicker max={pivotEnd} value={pivotStart} onChange={(v) => setPivotStart(v || todayISO())} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
                    {/* Sits between the two date pickers, so it wants the same
                        caps treatment the sibling FROM/COMPANY labels get —
                        those are spans and this one is a Label, which the
                        container's [&>span] rule cannot reach. */}
                    <Label className={cn('text-xs text-muted-foreground', __WEB__ && '!text-[10px] !font-extrabold !uppercase !tracking-[.1em] !text-[#5A6B62]')}>To</Label>
                    <DatePicker min={pivotStart} max={todayISO()} value={pivotEnd} onChange={(v) => setPivotEnd(v || todayISO())} className="h-8 w-[9.5rem] shrink-0 text-[11px]" />
                    {(pivotStart !== monthStartISO() || pivotEnd !== todayISO()) && (
                      <Button variant="ghost" size="sm" onClick={() => { setPivotStart(monthStartISO()); setPivotEnd(todayISO()) }}>This month</Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 text-[11px]"
                      title="Widen the range to browse old (already Empty) tankers too — in-progress tankers show regardless"
                      onClick={() => { setPivotStart('2000-01-01'); setPivotEnd(todayISO()) }}
                    >
                      View all history
                    </Button>
                    <ExcelButton
                      filename={`tanker-movement-${pivotEnd}`}
                      sheetName="Tanker movement"
                      title={`Tanker movement by oil type — as on ${formatDate(pivotEnd)}`}
                      columns={[
                        { header: 'Oil type', key: 'oil' },
                        { header: 'Party', key: 'party', value: (r) => r.party || '' },
                        ...PIVOT_STAGES.map((st) => ({
                          header: st.label,
                          key: st.key,
                          align: 'right' as const,
                          numFmt: '#,##0',
                          value: (r: Row) => Number(r[st.key]) || 0
                        })),
                        { header: 'Total', key: 'total', align: 'right' as const, numFmt: '#,##0', value: (r) => Number(r.total) || 0 },
                        { header: 'Tankers', key: 'tanker_list', value: (r) => r.tanker_list || '' }
                      ]}
                      rows={pivotSheetRows}
                      isGroup={(r) => !!r.is_group}
                      outlineDetail
                    />
                  </div>
                </div>
                {/* Stage cards — the handoff's summary strip above the matrix.
                    Counts and quantities are the pivot's own, totalled across
                    oils, so these can never disagree with the table below.
                    A stage with nothing in it greys out rather than
                    disappearing: "none in transit" is worth seeing. */}
                {__WEB__ && (
                  <div className="border-b border-[#EAF0E9]">
                    <button
                      type="button"
                      aria-expanded={kpiOpen}
                      onClick={() => setKpiOpen((o) => !o)}
                      className="flex w-full items-center gap-1.5 px-[18px] py-2 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62] hover:bg-[#F7FAF6]"
                    >
                      <ChevronDown className={cn('h-4 w-4 shrink-0 text-[#12855A] transition-transform', !kpiOpen && '-rotate-90')} />
                      Stage summary
                      <span className="ml-1 rounded-[2px] bg-[#EAF0E9] px-1.5 py-[2px] text-[11px] font-extrabold tracking-normal text-[#33473E]">
                        {visibleTankers.length}
                      </span>
                    </button>
                    {kpiOpen && (
                      <div className="flex flex-wrap gap-2 px-[18px] pb-[18px] pt-1">
                        {PIVOT_STAGES.map((s) => {
                          const count = pivot.totals[s.key] || 0
                          const qty = pivot.rows.reduce((t, r) => t + (r.cells[s.key]?.qty || 0), 0)
                          const live = count > 0
                          const accent = s.key === 'supplier_factory' ? '#C2700A' : s.key === 'empty' ? '#0B3D2E' : '#12855A'
                          return (
                            <div
                              key={s.key}
                              className={cn(
                                'flex min-w-[150px] flex-1 flex-col gap-2 rounded-[4px] border p-3.5',
                                live ? 'border-[#D6E2D6] bg-white' : 'border-[#E4ECE3] bg-[#F7FAF6]'
                              )}
                              style={{ borderTop: `3px solid ${live ? accent : '#E4ECE3'}` }}
                            >
                              <div className="text-[10.5px] font-extrabold uppercase leading-[1.25] tracking-[.1em] text-[#33473E]">
                                {s.label}
                              </div>
                              <div className="flex items-baseline gap-1.5">
                                <span
                                  className={cn('text-[30px] font-bold leading-none tracking-[-0.04em] tabular-nums', live ? 'text-[#0A1F17]' : 'text-[#C3D2C6]')}
                                >
                                  {count}
                                </span>
                                <span className="text-[11.5px] font-semibold text-[#7C9188]">
                                  {count === 1 ? 'tanker' : 'tankers'}
                                </span>
                              </div>
                              <div className={cn('text-[11.5px] font-semibold tabular-nums', live ? 'text-[#5A6B62]' : 'text-[#C3D2C6]')}>
                                {qty > 0 ? `${formatNum(qty)} MT` : '— MT'}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                  {/* The handoff puts this matrix under a forest header with
                      the Total column picked out in lime — the one column the
                      eye should land on. */}
                  <TableHeader className={cn('bg-amber-50', __WEB__ && '!bg-[#0B3D2E]')}><TableRow className={cn(__WEB__ && 'hover:!bg-[#0B3D2E]')}>
                    <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!h-9 !text-[11px] !font-extrabold !tracking-[.1em] !text-[#DCEFE4]')}>Oil type</TableHead>
                    {PIVOT_STAGES.map((s) => <TableHead key={s.key} className={cn('text-center text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!h-9 !text-[11px] !font-extrabold !tracking-[.1em] !text-[#DCEFE4]')}>{s.label}</TableHead>)}
                    <TableHead className={cn('text-center text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!h-9 !text-[11px] !font-extrabold !tracking-[.1em] !text-[#C7F03F]')}>Total</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {pivot.rows.length === 0 ? (
                      <TableRow><TableCell colSpan={PIVOT_STAGES.length + 2} className="py-8 text-center text-muted-foreground">
                        {moveSearch.trim()
                          ? `Nothing matches “${moveSearch.trim()}” in this period.`
                          : 'No tankers to show for this period.'}
                      </TableCell></TableRow>
                    ) : (
                      <>
                        {pivot.rows.map((row) => (
                          <TableRow key={row.label} className={cn(__WEB__ && '[&>td]:!h-9 [&>td]:!py-1')}>
                            <TableCell className="font-medium">{row.label}</TableCell>
                            {PIVOT_STAGES.map((s) => {
                              const cell = row.cells[s.key]
                              return (
                                <TableCell key={s.key} className="text-center tabular-nums">
                                  {cell && cell.count > 0 ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setPivotSel((p) =>
                                              p && p.oil === row.label && p.stage === s.key ? null : { oil: row.label, stage: s.key }
                                            )
                                          }
                                          className={cn(
                                            'cursor-pointer rounded px-1.5 py-0.5 font-medium underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:bg-sky-100',
                                            pivotSel && pivotSel.oil === row.label && pivotSel.stage === s.key && 'bg-sky-600 text-white no-underline hover:bg-sky-600'
                                          )}
                                          title="Show these tankers below"
                                        >
                                          {cell.count}
                                        </button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <div className="mb-1 font-semibold">{row.label} · {s.label}</div>
                                        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                                          <span className="text-muted-foreground">Tankers</span>
                                          <span className="text-right font-medium">{cell.count}</span>
                                          <span className="text-muted-foreground">Qty</span>
                                          <span className="text-right font-medium">{formatNum(cell.qty)}</span>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              )
                            })}
                            <TableCell className="text-center font-semibold tabular-nums">{row.total}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow
                          className={cn(
                            'bg-muted/40',
                            __WEB__ && '!border-t-2 !border-t-[#C7F03F] !bg-[#F1F5EF] hover:!bg-[#F1F5EF] [&>td]:!h-[42px] [&>td]:!text-[14px]'
                          )}
                        >
                          <TableCell className={cn('font-semibold', __WEB__ && '!text-[13.5px] !font-extrabold')}>Total</TableCell>
                          {PIVOT_STAGES.map((s) => (
                            <TableCell
                              key={s.key}
                              className={cn(
                                'text-center font-semibold tabular-nums',
                                // A zero is a fact, not a figure to read — it
                                // steps back so the live counts carry the row.
                                __WEB__ && '!font-bold',
                                __WEB__ && !(pivot.totals[s.key] || 0) && '!text-[#8AA096]'
                              )}
                            >
                              {pivot.totals[s.key] || 0}
                            </TableCell>
                          ))}
                          <TableCell className={cn('text-center font-semibold tabular-nums', __WEB__ && '!font-bold !text-[#0B3D2E]')}>
                            {pivot.grand}
                          </TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
              {pivotSel && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                  <span>
                    Showing <b>{visibleTankers.length}</b> tanker{visibleTankers.length === 1 ? '' : 's'} — <b>{pivotSel.oil}</b> · {PIVOT_STAGES.find((s) => s.key === pivotSel.stage)?.label || pivotSel.stage}
                  </span>
                  <Button variant="outline" size="sm" className="h-7 border-sky-300 bg-white text-sky-900" onClick={() => setPivotSel(null)}>
                    Clear
                  </Button>
                </div>
              )}
              <div className={cn('overflow-hidden rounded-xl border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                {/* This card + the "Loaded outside" one below it split the
                    SAME pivot total between them by loaded date — their two
                    badge counts always add up to the pivot's grand total,
                    never more. */}
                {!pivotSel && (
                  <div
                    {...groupToggleProps(tmInOpen, () => setTmInOpen((o) => !o))}
                    className={cn(
                      'flex items-center gap-1.5 border-b bg-emerald-50 px-3 py-2',
                      // The handoff's group header: a coloured left edge, the
                      // title, and the count as a chip. On the website the
                      // whole band is the collapse toggle. Drawn well under
                      // the handoff's 56px — it repeats twice down the page
                      // and is a divider, not a heading anyone reads twice.
                      __WEB__ && '!min-h-[38px] !gap-2 !border-l-4 !border-l-[#C7F03F] !border-b-[#0B3D2E] !bg-[#0B3D2E] !px-[18px] !py-1.5 !cursor-pointer !select-none hover:!bg-[#0F4A38]'
                    )}
                  >
                    <CalendarDays className={cn('h-3.5 w-3.5 text-emerald-600', __WEB__ && '!h-4 !w-4 !text-[#C7F03F]')} />
                    <span className={cn('text-xs font-semibold text-emerald-800', __WEB__ && '!text-[13.5px] !font-extrabold !tracking-[-0.01em] !text-white')}>
                      {__WEB__ && inRangeLabel ? (
                        inRangeLabel
                      ) : (
                        <>Loaded &amp; received within {formatDate(pivotStart)} – {formatDate(pivotEnd)}</>
                      )}
                    </span>
                    <Badge
                      variant="success"
                      className={cn('text-[10px]', __WEB__ && '!rounded-[2px] !border-0 !bg-[#C7F03F]/20 !px-2 !py-0 !text-[11.5px] !font-extrabold !text-[#C7F03F]')}
                    >
                      {inLoadedRangeTankers.length}
                    </Badge>
                    <GroupChevron open={tmInOpen} tone="#8FBFA8" />
                  </div>
                )}
                {/* Forced open when a pivot cell is selected: that hides the
                    band above, which is the only way back out of a collapse. */}
                {(!__WEB__ || !!pivotSel || tmInOpen) && (
                  <>
                    <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                      {tankerTableHeader()}
                      <TableBody>
                        {loading ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                          : inLoadedRangeTankers.length === 0 ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{tankers.length === 0 ? 'No tankers yet. Add the first loaded tanker.' : pivotSel ? 'No tankers match the selected cell.' : 'No tankers in this date range.'}</TableCell></TableRow>
                            : tankerPaged.pageRows.map(renderTankerRow)}
                      </TableBody>
                    </Table>
                    <Pagination {...tankerPaged} label="tankers" className="border-t px-3" />
                  </>
                )}
              </div>
              {/* The rest of the SAME pivot-counted set — received in this
                  window, but loaded before/after it. Not a wider historical
                  query: card above + this card always total the pivot's own
                  grand total, no more. */}
              {outOfRangeTankers.length > 0 && (
                <div className={cn('overflow-hidden rounded-xl border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                  <div
                    {...groupToggleProps(tmOutOpen, () => setTmOutOpen((o) => !o))}
                    className={cn(
                      'flex items-center gap-1.5 border-b bg-amber-50 px-3 py-2',
                      __WEB__ && '!min-h-[38px] !gap-2 !border-l-4 !border-l-[#C2700A] !border-b-[#0B3D2E] !bg-[#0B3D2E] !px-[18px] !py-1.5 !cursor-pointer !select-none hover:!bg-[#0F4A38]'
                    )}
                  >
                    <CalendarDays className={cn('h-3.5 w-3.5 text-amber-600', __WEB__ && '!h-4 !w-4 !text-[#E9A23B]')} />
                    <span
                      className={cn('text-xs font-semibold text-amber-800', __WEB__ && '!text-[13.5px] !font-extrabold !tracking-[-0.01em] !text-white')}
                      title={
                        __WEB__ && outOfRangeMonth.label !== outOfRangeMonth.full
                          ? `Loaded in ${outOfRangeMonth.full}`
                          : undefined
                      }
                    >
                      {/* The window is already stated by the band above and by
                          the filter strip; repeating it here just to say these
                          loads were NOT in it added a date range to a heading
                          whose whole job is the month. */}
                      {__WEB__ && outOfRangeMonth.label ? (
                        `${outOfRangeMonth.label} transit`
                      ) : (
                        <>Loaded outside {formatDate(pivotStart)} – {formatDate(pivotEnd)}</>
                      )}
                    </span>
                    <Badge
                      variant="warning"
                      className={cn('text-[10px]', __WEB__ && '!rounded-[2px] !border-0 !bg-[#E9A23B]/20 !px-2 !py-0 !text-[11.5px] !font-extrabold !text-[#F0C083]')}
                    >
                      {outOfRangeTankers.length}
                    </Badge>
                    <GroupChevron open={tmOutOpen} tone="#8FBFA8" />
                  </div>
                  {(!__WEB__ || tmOutOpen) && (
                    <>
                      <Table className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3">
                        {tankerTableHeader()}
                        <TableBody>{outOfRangePaged.pageRows.map(renderTankerRow)}</TableBody>
                      </Table>
                      <Pagination {...outOfRangePaged} label="tankers" className="border-t px-3" />
                    </>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="purchases">
              <div className={cn('overflow-hidden rounded-xl border bg-card', __WEB__ && '!rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">
                  {/* Dark fill on the THEAD, not the row — see Sales.tsx. */}
                  <TableHeader className={cn('bg-[#1a2c56] [&_th]:text-white', __WEB__ && '!bg-[#0B3D2E]')}><TableRow className={cn('border-b-2 border-[#1a2c56]/30', __WEB__ && '!border-b-0 hover:!bg-[#0B3D2E]')}>
                    {PO_COLUMNS.map((c) => (
                      <TableHead
                        key={c.key}
                        className={cn(
                          c.key === 'tanker_count' && 'text-center',
                          (c.key === 'ordered_qty' || c.key === 'net_amount') && 'text-right',
                          c.key === 'shortage' && 'w-[130px]',
                          __WEB__ && '!h-10 !text-[12.5px] !font-extrabold !tracking-[-0.01em]'
                        )}
                      >
                        <ColumnFilter
                          label={c.label}
                          options={poColOptions(c.key)}
                          value={poCols[c.key] ?? []}
                          onDark
                          onApply={(v) => setPoCols((p) => ({ ...p, [c.key]: v }))}
                          align={c.key === 'net_amount' || c.key === 'ordered_qty' ? 'end' : 'start'}
                        />
                      </TableHead>
                    ))}
                    <TableHead className={cn('w-[34px] !px-0', __WEB__ && '!h-10')} />
                    <TableHead className={cn('text-right', __WEB__ && '!h-10 !text-[12.5px] !font-extrabold !tracking-[-0.01em]')}>Actions</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {/* Totals for exactly the rows the filters left — sits under
                        the header so the figure is read before scrolling. */}
                    {!loading && filteredOrders.length > 0 && (
                      <TableRow
                        className={cn(
                          'border-b-2 border-amber-400 bg-amber-50 hover:bg-amber-50',
                          // Lime rule and a pale ground on the website: the
                          // totals band the handoff puts under the header.
                          __WEB__ && '!border-b-2 !border-b-[#C7F03F] !bg-[#F1F5EF] hover:!bg-[#F1F5EF] [&>td]:!h-[44px] [&>td]:!text-[13.5px] [&>td]:!text-[#0A1F17]'
                        )}
                      >
                        <TableCell className={cn('font-semibold text-amber-900', __WEB__ && '!font-extrabold !text-[#0A1F17]')}>
                          Total
                          <span className={cn('ml-1.5 font-normal text-amber-800/70', __WEB__ && '!font-semibold !text-[#5A6B62]')}>
                            ({filteredOrders.length} invoice{filteredOrders.length === 1 ? '' : 's'})
                          </span>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                        <TableCell className={cn('text-center font-semibold tabular-nums text-amber-900', __WEB__ && '!font-bold !text-[#0A1F17]')}>
                          {filteredOrders.reduce((t, r) => t + (Number(r.tanker_count) || 0), 0)}
                        </TableCell>
                        <TableCell className={cn('text-right font-semibold tabular-nums text-amber-900', __WEB__ && '!font-bold !text-[#0A1F17]')}>
                          {formatNum(filteredOrders.reduce((t, r) => t + (Number(r.ordered_qty) || 0), 0))}
                        </TableCell>
                        <TableCell className={cn('text-right font-semibold tabular-nums text-amber-900', __WEB__ && '!text-[14px] !font-bold !tracking-[-0.02em] !text-[#0A1F17]')}>
                          {formatINR(filteredOrders.reduce((t, r) => t + (Number(r.net_amount) || 0), 0))}
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    )}
                    {loading ? <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                      : filteredOrders.length === 0 ? <TableRow><TableCell colSpan={10} className="py-10 text-center text-muted-foreground">{rows.length ? 'No purchase entry matches these filters.' : 'No purchase entries yet.'}</TableCell></TableRow>
                        : orderPaged.pageRows.map((row) => <TableRow
                          key={row.id}
                          // Amber left edge on anything still in process, so the
                          // open work is findable down a long page without
                          // reading the Status column on every row.
                          style={__WEB__ && row.status !== 'received' ? { borderLeft: '3px solid #C2700A' } : undefined}
                          // The whole row opens the detail drawer. The Freight
                          // and Actions cells stop the click themselves, so a
                          // popover or the ⋮ menu still does its own thing.
                          onClick={__WEB__ ? () => setDetailRow(row) : undefined}
                          className={cn('hover:bg-amber-50', __WEB__ && '!cursor-pointer !border-b-[#EAF0E9] hover:!bg-[#F7FAF6] [&>td]:!py-2 [&>td]:!text-[13px]')}
                        >
                          <TableCell>
                            <div className={cn('font-medium', __WEB__ && '!text-[13.5px] !font-bold !tracking-[-0.01em]')}>{row.invoice_no}</div>
                            <div className={cn('text-[11px] text-muted-foreground', __WEB__ && '!mt-0.5 !text-[12px] !font-semibold !tabular-nums !text-[#5A6B62]')}>{formatDate(row.order_date)}</div>
                            {row._shownForReceipt && (
                              <div
                                className="text-[10px] text-sky-600"
                                title="Invoiced outside this date range, but a tanker on it was received within it"
                              >
                                shown for receipt date
                              </div>
                            )}
                          </TableCell>
                          <TableCell className={cn(__WEB__ && '!text-[13.5px] !font-bold')}>{row.supplier_name}</TableCell>
                          <TableCell className={cn('uppercase text-muted-foreground', __WEB__ && '!text-inherit')}>
                            {__WEB__ ? (
                              <span className="rounded-[2px] bg-[#EAF0E9] px-2 py-1 text-[11.5px] font-extrabold uppercase tracking-[.05em] text-[#33473E]">
                                {row.product_category || '—'}
                              </span>
                            ) : (row.product_category || '—')}
                          </TableCell>
                          <TableCell className={cn('font-medium', __WEB__ && '!text-[13.5px] !font-bold')}>{row.oil_code || row.oil_name || '—'}</TableCell>
                          <TableCell className="text-center">
                            {/* The vehicles behind the count, on hover.
                                tanker_nos is already a GROUP_CONCAT on the
                                order (see listOrders), so this costs nothing —
                                and "which lorries were these?" was otherwise a
                                trip into the gate entries. */}
                            {__WEB__ ? (() => {
                              const nos = String(row.tanker_nos || '')
                                .split(',')
                                .map((x) => x.trim())
                                .filter(Boolean)
                              const chip = (
                                <span
                                  className={cn(
                                    'inline-flex h-6 min-w-[30px] items-center justify-center rounded-[2px] border px-1.5 text-[12.5px] font-bold tabular-nums',
                                    nos.length
                                      ? 'cursor-help border-[#BFE3CB] bg-[#F4FBF6] text-[#0B6B45]'
                                      : 'border-[#C3D2C6] text-[#8FA79B]'
                                  )}
                                >
                                  {row.tanker_count || 0}
                                </span>
                              )
                              if (!nos.length) return chip
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>{chip}</TooltipTrigger>
                                  {/* The vehicles listed one per line rather than run
                                      together in a sentence: a comma-separated string of
                                      registration numbers is unreadable at four or more,
                                      and the point of the hover is to check one against a
                                      document. */}
                                  <TooltipContent className="!max-w-none !bg-[#0A1F17] !p-0">
                                    <div className="border-b border-b-white/10 px-3 py-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8FBFA8]">
                                      {nos.length} tanker{nos.length === 1 ? '' : 's'} · {row.invoice_no || 'this invoice'}
                                    </div>
                                    <div className="px-3 py-2">
                                      {nos.map((no, i) => (
                                        <div
                                          key={`${no}-${i}`}
                                          className="doc-ref flex items-center gap-2 whitespace-nowrap py-[3px] text-[12.5px] font-bold text-white"
                                        >
                                          <span className="w-[14px] shrink-0 text-right text-[10px] font-semibold text-[#8FBFA8]">
                                            {i + 1}
                                          </span>
                                          {no}
                                        </div>
                                      ))}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              )
                            })() : <Badge variant="secondary">{row.tanker_count || 0}</Badge>}
                          </TableCell>
                          <TableCell className={cn('text-right tabular-nums', __WEB__ && '!text-[13.5px] !font-semibold')}>
                            {formatNum(row.ordered_qty)} <span className={cn(__WEB__ && '!text-[11.5px] !font-medium !text-[#7C9188]')}>{row.uom}</span>
                          </TableCell>
                          <TableCell className={cn('text-right font-medium tabular-nums', __WEB__ && '!text-[13.5px] !font-bold !tracking-[-0.02em]')}>{formatINR(row.net_amount)}</TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {(() => {
                              const f = poFreight(row)
                              const cond = invoiceCondition(row)
                              const label = cond.split(' — ')[0]
                              const due = f.deduct > 0
                              if (f.freight <= 0 && f.deduct <= 0 && !cond) return <span className="text-muted-foreground">—</span>
                              return (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={due ? 'Debit note due — click for the figures' : 'Click for the freight figures'}
                                      className={cn(
                                        'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                                        due
                                          ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300 hover:bg-rose-200'
                                          : label.startsWith('EX')
                                            ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                                            : 'bg-slate-200 text-slate-700 hover:bg-slate-300',
                                        // Same chip shape as Category, with the
                                        // debit-note and EX cases keeping their
                                        // own colour — that distinction is the
                                        // point of the column.
                                        __WEB__ && '!rounded-[2px] !px-2 !py-1 !text-[11px] !font-extrabold !tracking-[.06em]',
                                        __WEB__ && !due && !label.startsWith('EX') && '!bg-[#EAF0E9] !text-[#33473E] hover:!bg-[#DFE9DE]',
                                        // Blue, not amber. Amber is this page's
                                        // "needs attention" colour and the Status
                                        // chip in the very next column uses it for
                                        // In process — two amber chips side by side
                                        // read as one thought. EX is a freight TERM,
                                        // a neutral fact about the contract, so it
                                        // gets a colour that claims nothing. Red
                                        // stays reserved for a debit note due, which
                                        // is the one thing in this column that does
                                        // need attention.
                                        __WEB__ && !due && label.startsWith('EX') && '!bg-[#E7F0FA] !text-[#1B4E82] hover:!bg-[#D8E7F6]'
                                      )}
                                    >
                                      {label}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="end" className="w-64 p-3 text-[12px]">
                                    <div className="mb-1.5 border-b pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                                      {cond}
                                    </div>
                                    {poCarriers(row).map((cr, i) => (
                                      <div key={i} className="flex items-baseline justify-between gap-3 py-0.5">
                                        <span className="min-w-0 truncate">{cr.name || 'No transporter set'}</span>
                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                          {cr.rate > 0 ? `${formatINR(cr.rate)}/${row.uom || 'MT'}` : '—'}
                                        </span>
                                      </div>
                                    ))}
                                    <div className="mt-1 flex justify-between border-t pt-1.5 font-semibold">
                                      <span>Deductible</span>
                                      <span className={cn('tabular-nums', due && 'text-rose-700')}>
                                        {due ? formatINR(f.deduct) : '—'}
                                      </span>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )
                            })()}
                          </TableCell>
                          <TableCell>
                            {__WEB__ ? (
                              (() => {
                                const done = row.status === 'received'
                                const Icon = done ? CheckCircle2 : Clock
                                return (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1.5 rounded-[2px] border px-2.5 py-1 text-[12px] font-extrabold',
                                      done
                                        ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                        : 'border-[#F0D9AE] bg-[#FFEDD0] text-[#8A5300]'
                                    )}
                                  >
                                    <Icon className="h-3.5 w-3.5" />
                                    {done ? 'Completed' : 'In process'}
                                  </span>
                                )
                              })()
                            ) : (
                              <Badge variant={row.status === 'received' ? 'success' : 'warning'}>
                                {row.status === 'received' ? 'Completed' : 'In process'}
                              </Badge>
                            )}
                          </TableCell>
                          {/* The lab readings, as one glyph. No heading: the
                              column is a 22px square and any word would be
                              wider than it. Hover says what it means; the
                              panel it opens says the rest. */}
                          <TableCell className="w-[34px] !px-0 text-center" onClick={(e) => e.stopPropagation()}>
                            {(() => {
                              // A consignment invoice has no tanker; the unit
                              // is the invoice itself, once it is received.
                              const noTankers = !Number(row.tanker_count)
                              const emptied = noTankers
                                ? (String(row.status) === 'received' ? 1 : 0)
                                : Number(row.empty_tankers) || 0
                              const done = noTankers
                                ? (Number(row.quality_on_order) > 0 ? 1 : 0)
                                : Number(row.quality_tankers) || 0
                              if (!emptied) {
                                return (
                                  <span className="text-[#D6E2D6]" title="No tanker on this invoice has been emptied yet">
                                    ·
                                  </span>
                                )
                              }
                              const complete = done >= emptied
                              return (
                                <button
                                  type="button"
                                  title={
                                    complete
                                      ? `Technical parameters recorded for ${emptied === 1 ? 'the tanker' : `all ${emptied} tankers`}. Click to view or change.`
                                      : `Technical parameters missing on ${emptied - done} of ${emptied} tanker${emptied === 1 ? '' : 's'}. Click to enter them.`
                                  }
                                  onClick={() => void openQuality(row)}
                                  className={cn(
                                    'inline-flex h-[22px] w-[22px] items-center justify-center rounded-[3px] border transition-colors',
                                    complete
                                      ? 'border-[#BFE3CB] bg-[#EAF6EC] text-[#0B6B45] hover:bg-[#DCEFE1]'
                                      : 'border-[#F0E4CB] bg-[#FFF4E0] text-[#C2700A] hover:bg-[#FFE9C7]'
                                  )}
                                >
                                  <FlaskConical className="h-[13px] w-[13px]" />
                                </button>
                              )
                            })()}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}><div className="flex justify-end">
                            {!readingsOnly && (
                            <RowActions
                              actions={[
                                { label: 'View details', icon: Eye, onClick: () => setDetailRow(row) },
                                { label: 'Gate entries — what came through the barrier', icon: DoorOpen, onClick: () => setGateOrder(row) },
                                { label: 'Edit purchase', icon: Pencil, onClick: () => openEditPurchase(row) },
                                { label: 'History — who did what', icon: History, onClick: () => openHistory(row) },
                                { label: 'Delete purchase', icon: Trash2, danger: true, onClick: () => deletePurchase(row) }
                              ]}
                            />
                            )}
                          </div></TableCell>
                        </TableRow>)}
                  </TableBody>
                </Table>
                <Pagination {...orderPaged} label="invoices" className={cn('border-t px-3', __WEB__ && '!border-t-[#EAF0E9] !px-[18px] !py-2.5')} />
              </div>
            </TabsContent>

            <TabsContent value="unmapped" className="space-y-4">
              <div className="overflow-hidden rounded-xl border-2 border-red-200 bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-3">
                  <div>
                    <h3 className="font-medium text-red-900">Unmapped invoices</h3>
                    <p className="text-xs text-red-800/80">
                      Purchase invoices with no live bargain behind them — usually because the bargain was deleted.
                      Assign one or more bargains so the bargain register counts them again.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ExcelButton
                      filename={`unmapped-invoices-${todayISO()}`}
                      sheetName="Unmapped"
                      title="Unmapped purchase invoices"
                      columns={[
                        { header: 'Invoice', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                        { header: 'Date', key: 'order_date', value: (r) => formatDate(r.order_date) },
                        { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                        { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
                        { header: 'Qty', key: 'ordered_qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.ordered_qty) || 0 },
                        { header: 'Rate', key: 'invoice_rate', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.invoice_rate) || 0 },
                        { header: 'Taxable value', key: 'taxable_value', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.taxable_value) || 0 },
                        { header: 'Tankers', key: 'tanker_nos', value: (r) => r.tanker_nos || '' },
                        { header: 'Reason', key: 'reason', value: (r) => (Number(r.was_linked) === 1 ? 'Bargain deleted' : 'Never linked') }
                      ]}
                      rows={unmapped}
                    />
                    <Badge variant={unmapped.length ? 'destructive' : 'success'}>
                      {unmapped.length ? `${unmapped.length} to map` : 'All mapped'}
                    </Badge>
                  </div>
                </div>
                <Table
                  className="text-[12px] [&_td]:px-3 [&_td]:py-2 [&_th]:h-9 [&_th]:px-3"
                  wrapperClassName="max-h-[65vh] overflow-auto"
                >
                  <TableHeader className="sticky top-0 z-10">
                    <TableRow className="bg-muted">
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Invoice</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Date</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Supplier</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Product</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Qty</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Rate</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Taxable value</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Tankers</TableHead>
                      <TableHead className="text-[10px] font-semibold uppercase tracking-wide">Why</TableHead>
                      <TableHead className="text-right text-[10px] font-semibold uppercase tracking-wide">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow><TableCell colSpan={10} className="py-12 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                    ) : unmapped.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                          Every purchase invoice is linked to a bargain.
                        </TableCell>
                      </TableRow>
                    ) : (
                      unmappedPaged.pageRows.map((r, i) => (
                        <TableRow key={r.id as number} className={cn('border-b', i % 2 === 1 && 'bg-muted/30')}>
                          <TableCell className="font-medium">{r.invoice_no}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDate(r.order_date)}</TableCell>
                          <TableCell>{r.supplier_name}</TableCell>
                          <TableCell>{r.product_code || r.product_name}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatNum(r.ordered_qty)} {r.uom}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatINR(r.invoice_rate)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{formatINR(r.taxable_value)}</TableCell>
                          <TableCell className="max-w-[160px] truncate text-muted-foreground">
                            {r.tanker_nos || (Number(r.is_trading) === 1 ? 'trading' : Number(r.is_consignment) === 1 ? 'consignment' : '—')}
                          </TableCell>
                          <TableCell>
                            <Badge variant={Number(r.was_linked) === 1 ? 'destructive' : 'warning'}>
                              {Number(r.was_linked) === 1 ? 'Bargain deleted' : 'Never linked'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" onClick={() => openMap(r)}>Assign bargains</Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <Pagination {...unmappedPaged} label="invoices" className="border-t px-3" />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={loadingOpen} onOpenChange={setLoadingOpen}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>Send tankers to supplier — to be loaded</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Pick the oil and supplier once — the oldest open bargain is auto-selected for every tanker (changeable per tanker). Loaded quantity and payment are entered after loading.
          </p>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label>Oil *</Label>
              <Select value={String(loadingForm.oil_pick || '')} onValueChange={pickOil}>
                <SelectTrigger><SelectValue placeholder="Select oil" /></SelectTrigger>
                <SelectContent>
                  {bargainOils.map(([id, label]) => (
                    <SelectItem key={id} value={id}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Supplier *</Label>
              <Select value={String(loadingForm.supplier_pick || '')} onValueChange={pickSupplier} disabled={!loadingForm.oil_pick}>
                <SelectTrigger><SelectValue placeholder={loadingForm.oil_pick ? 'Select supplier' : 'Pick oil first'} /></SelectTrigger>
                <SelectContent>
                  {suppliersForOil(String(loadingForm.oil_pick || '')).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Number of tankers</Label>
              <Input type="number" min="1" max="20" value={loadingForm.tanker_count} onChange={(e) => setTankerCount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Tanker placement date</Label>
              <DatePicker value={loadingForm.factory_entry_date || ''} onChange={(v) => setLoadingForm((p) => ({ ...p, factory_entry_date: v }))} />
            </div>
          </div>
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {loadingRows.map((row, index) => (
              <div
                key={index}
                className="grid items-start gap-3 rounded-lg border p-3 md:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.5fr)_5.5rem_minmax(0,1.2fr)]"
              >
                <div className="flex h-9 items-center justify-center rounded-md bg-muted text-sm font-semibold md:mt-[26px]">
                  {index + 1}
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Tanker number</Label>
                  <Input placeholder="optional — set at loading" value={row.tanker_no || ''} onChange={(e) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, tanker_no: e.target.value } : item))} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Bargain (oldest auto) *</Label>
                  <Select
                    value={String(row.bargain_id || '')}
                    onValueChange={(value) => selectLoadingBargain(index, value)}
                    disabled={!loadingForm.oil_pick || !loadingForm.supplier_pick}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={loadingForm.supplier_pick ? 'Select bargain' : 'Pick oil & supplier above'} />
                    </SelectTrigger>
                    <SelectContent className="w-[min(30rem,85vw)]">
                      {routeBargains(loadingForm).map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Condition</Label>
                  <div className="flex h-9 rounded-md border p-0.5">
                    {['EX', 'DLD'].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, condition: c } : item))}
                        className={cn(
                          'flex-1 rounded text-xs font-semibold transition-colors',
                          (row.condition || 'EX') === c ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label>Transporter</Label>
                  <Select value={String(row.transporter_id || '')} onValueChange={(value) => setLoadingRows((current) => current.map((item, i) => i === index ? { ...item, transporter_id: value } : item))}>
                    <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                    <SelectContent>
                      {transporters.map((tr) => (
                        <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setLoadingOpen(false)}>Cancel</Button><Button onClick={createTanker}>Send {loadingRows.length} tanker{loadingRows.length === 1 ? '' : 's'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!actionRow} onOpenChange={(open) => { if (!open) { setActionRow(null); setExcess(null); setRailPeek(null) } }}>
        <DialogContent
          className={cn(
            'max-h-[92vh] w-[calc(100vw-2rem)] overflow-y-auto',
            target === 'empty' ? 'sm:max-w-3xl' : 'sm:max-w-2xl',
            TK_DRAWER,
            target === 'empty' ? TK_WIDE : TK_NARROW
          )}
        >
          <DialogHeader className={cn(TK_HEAD)}>
            {/* pr-12 keeps the name clear of the close button in the corner. */}
            <div className={cn(__WEB__ && 'pr-12')}>
              {__WEB__ && <div className={TK_KICKER}>{target ? TANKER_LABEL[target] : 'Tanker'}</div>}
              <DialogTitle className={cn(TK_TITLE, __WEB__ && 'doc-ref')}>
                {__WEB__
                  ? String(actionRow?.tanker_no || '').trim() || 'Tanker'
                  : target
                    ? `Move ${String(actionRow?.tanker_no || '').trim() || 'tanker'} to ${TANKER_LABEL[target]}`
                    : 'Update tanker'}
              </DialogTitle>
              {__WEB__ && !!actionRow && (
                <div className={TK_SUB}>
                  {[
                    String(actionRow.supplier_name || ''),
                    String(actionRow.oil_type_name || actionRow.product_name || ''),
                    Number(actionRow.loaded_qty) ? `${formatNum(actionRow.loaded_qty)} ${String(actionRow.uom || 'MT')}` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
            {/* The whole journey, with this stage lit. A tanker moves through
                six of these and the form never said which one you were in, or
                what had already been stamped.

                Centred on a continuous track, not left-aligned under a
                per-step underline. The underline version broke into six
                separate dashes with gaps between them, and the dates were
                pushed right by a hardcoded icon offset while the labels above
                them were not — so no date sat under the step it belonged to.
                Here the dot IS the centre: label and date hang beneath it, and
                the label box has a floor so a name that wraps to two lines
                ("To be loaded") does not shove its own date out of line with
                the other five. */}
            {__WEB__ && !!actionRow && (
              <div className="mt-[18px] border-t border-t-white/[.13] pt-4">
                <div className="no-scrollbar flex items-start overflow-x-auto">
                  {TANKER_STAGE_RAIL.map((st, i) => {
                    const done = !!String(actionRow[st.dateKey] || '').trim()
                    const here = target === st.key
                    // Each half-track is owned by the step it touches: the one
                    // on the left reports the step BEFORE it, the one on the
                    // right reports this step. Every joint therefore gets its
                    // colour from the stage that has to be stamped to cross it.
                    const prevDone =
                      i > 0 && !!String(actionRow[TANKER_STAGE_RAIL[i - 1].dateKey] || '').trim()
                    const seg = (on: boolean, show: boolean): React.JSX.Element => (
                      <span
                        className={cn(
                          'h-[2px] flex-1',
                          !show ? 'bg-transparent' : on ? 'bg-[#8FBFA8]/45' : 'bg-white/[.13]'
                        )}
                      />
                    )
                    // A stage already stamped can be read back. The one
                    // being filled in cannot — that is the form below — and a
                    // stage that has not happened has nothing to show.
                    const readable = done && !here
                    return (
                      <div
                        key={st.key}
                        role={readable ? 'button' : undefined}
                        tabIndex={readable ? 0 : undefined}
                        aria-expanded={readable ? railPeek === st.key : undefined}
                        title={readable ? `See what was recorded at ${st.label}` : undefined}
                        onClick={readable ? () => setRailPeek((v) => (v === st.key ? null : st.key)) : undefined}
                        onKeyDown={
                          readable
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  setRailPeek((v) => (v === st.key ? null : st.key))
                                }
                              }
                            : undefined
                        }
                        className={cn(
                          'flex min-w-[92px] flex-1 flex-col items-center rounded-[3px] pt-0.5 transition-colors',
                          readable && 'cursor-pointer hover:bg-white/[.07]',
                          railPeek === st.key && 'bg-white/[.10]'
                        )}
                      >
                        <span className="flex w-full items-center">
                          {seg(prevDone, i > 0)}
                          <span
                            className={cn(
                              'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
                              here
                                ? 'border-[#C7F03F] bg-[#C7F03F] text-[#0B3D2E] shadow-[0_0_0_4px_rgba(199,240,63,.16)]'
                                : done
                                  ? 'border-[#8FBFA8]/70 bg-[#8FBFA8]/15 text-[#8FBFA8]'
                                  : 'border-white/20 bg-transparent text-white/30'
                            )}
                          >
                            {done && !here ? <Check className="h-3.5 w-3.5" /> : <st.icon className="h-3.5 w-3.5" />}
                          </span>
                          {seg(done, i < TANKER_STAGE_RAIL.length - 1)}
                        </span>
                        <span
                          className={cn(
                            'mt-2 flex min-h-[26px] items-start justify-center px-1.5 text-center text-[10.5px] font-extrabold leading-[1.25]',
                            here ? 'text-white' : done ? 'text-[#8FBFA8]' : 'text-white/35'
                          )}
                        >
                          {st.label}
                        </span>
                        <span
                          className={cn(
                            'doc-ref whitespace-nowrap text-[10px] font-semibold',
                            done ? 'text-[#8FBFA8]/85' : 'text-white/25'
                          )}
                        >
                          {done ? formatDateShort(actionRow[st.dateKey]) : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </DialogHeader>
          {/* The scrolling middle. Every stage's fields go through one
              wrapper so a Select, a date and a text box are the same 46px
              object wherever they appear — the drawer must not look like six
              different forms. */}
          <div
            className={cn(
              __WEB__ && cn(TK_BODY, TK_FIELDS, 'grid content-start'),
              // Reading an earlier stage HIDES the live form rather than
              // sitting above it. Shown together, the editable fields below
              // read as part of the history panel — you appear to be editing
              // the stage you asked to look at. The panel is the first child,
              // so everything after it goes; nothing is unmounted, so the
              // half-typed form comes back untouched on the way out.
              __WEB__ && !!railPeek && '[&>*:not(:first-child)]:!hidden'
            )}
          >
          {/* Reading back an earlier stage. Deliberately unlike the form under
              it — no controls, a plain grid of what was written — so there is
              never a question of whether typing here would change anything. */}
          {__WEB__ && !!actionRow && !!railPeek && (() => {
            const st = TANKER_STAGE_RAIL.find((x) => x.key === railPeek)
            const facts = stageFacts(actionRow, railPeek)
            return (
              <div className="rounded-[4px] border border-[#C3D2C6] bg-[#EFF5EC]">
                <div className="flex items-center gap-2 border-b border-b-[#D6E2D6] px-4 py-2.5">
                  {st && <st.icon className="h-4 w-4 shrink-0 text-[#0B6B45]" />}
                  <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]">
                    {st?.label}
                  </span>
                  <span className="rounded-[2px] border border-[#C3D2C6] bg-white px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[.08em] text-[#5A6B62]">
                    Read only
                  </span>
                  <button
                    type="button"
                    className="ml-auto cursor-pointer text-[11.5px] font-extrabold text-[#0B6B45] hover:underline"
                    onClick={() => setRailPeek(null)}
                  >
                    Back to {target ? TANKER_LABEL[target] : 'the form'}
                  </button>
                </div>
                {facts.length === 0 ? (
                  <div className="px-4 py-3 text-[12.5px] font-semibold text-[#5A6B62]">
                    Nothing was recorded at this stage beyond its date.
                  </div>
                ) : (
                  <div className="grid gap-x-5 gap-y-2.5 px-4 py-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr))]">
                    {facts.map((f) => (
                      <div key={f.k} className="min-w-0">
                        <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{f.k}</div>
                        <div className="doc-ref mt-[3px] truncate text-[13px] font-bold text-[#0A1F17]" title={f.v}>
                          {f.v}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="border-t border-t-[#D6E2D6] px-4 py-2 text-[11.5px] font-semibold text-[#5A6B62]">
                  History. To change any of it, close this and use Edit on the tanker&apos;s row.
                </div>
              </div>
            )
          })()}
          {target === 'loaded' && actionRow && <div className="grid gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Tanker number *{String(actionRow.tanker_no || '').trim() ? '' : ' (set it now)'}</Label>
              <Input
                placeholder="e.g. RJ04GD0469"
                value={actionForm.tanker_no ?? ''}
                onChange={(e) => setActionForm((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Bargain (auto-selected — change if needed)</Label>
              <Select
                value={String(actionForm.bargain_id || '')}
                onValueChange={(v) => { setExcess(null); setActionForm((p) => ({ ...p, bargain_id: v })) }}
              >
                <SelectTrigger><SelectValue placeholder="Select bargain" /></SelectTrigger>
                <SelectContent>
                  {bargains
                    .filter(
                      (b) =>
                        String(b.supplier_id) === String(actionRow.supplier_id) &&
                        String(b.oil_type_id) === String(actionRow.oil_type_id)
                    )
                    .sort((a, b) => String(a.bargain_no || '').localeCompare(String(b.bargain_no || '')))
                    .map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">{actionRow.supplier_name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Loaded date</Label>
                <DatePicker
                  value={actionForm.loaded_date || ''}
                  max={todayISO()}
                  onChange={(v) => setActionForm((p) => ({ ...p, loaded_date: v }))}
                />
                <StageDateNote row={actionRow} dateKey="loaded_date" />
              </div>
              <div className="flex flex-col gap-1.5"><Label>Actual loaded quantity *</Label><Input type="number" value={actionForm.loaded_qty || ''} onChange={(e) => { setExcess(null); setActionForm((p) => ({ ...p, loaded_qty: e.target.value })) }} /></div>
            </div>
            {excess && (() => {
              // Other open bargains (same supplier + oil) that can absorb the excess.
              const nextBargains = bargains.filter(
                (b) =>
                  String(b.supplier_id) === String(actionRow.supplier_id) &&
                  String(b.oil_type_id) === String(actionRow.oil_type_id) &&
                  String(b.id) !== String(actionForm.bargain_id) &&
                  Number(b.balance_qty) >= excess.qty - 1e-6
              )
              return (
                <div className="space-y-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                  <p>
                    This bargain has only <b>{formatNum(excess.balance)} {actionRow.uom}</b> left. Choose where the extra{' '}
                    <b>{formatNum(excess.qty)} {actionRow.uom}</b> should go:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'new' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'new' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Book as a new bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'existing' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'existing' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Use the next available bargain
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcess((p) => (p ? { ...p, mode: 'expand' } : p))}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium',
                        excess.mode === 'expand' ? 'border-amber-500 bg-amber-100' : 'border-amber-300 bg-white'
                      )}
                    >
                      Add to this bargain
                    </button>
                  </div>

                  {excess.mode === 'expand' ? (
                    <p className="text-[11px]">
                      This bargain will be increased by <b>{formatNum(excess.qty)} {actionRow.uom}</b> (at its own rate) so the full load stays on it. The top-up is logged as an Addition on the bargain.
                    </p>
                  ) : excess.mode === 'new' ? (
                    <>
                      <p className="text-[11px]">A new bargain line will be created for {actionRow.supplier_name}.</p>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={excess.diffRate}
                          onCheckedChange={(v) => setExcess((p) => (p ? { ...p, diffRate: v } : p))}
                        />
                        <span>A different rate applies to the extra quantity</span>
                      </div>
                      {excess.diffRate && (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-amber-900">Rate for the extra qty (per {actionRow.uom})</Label>
                          <Input
                            type="number"
                            className="bg-white"
                            value={excess.rate}
                            onChange={(e) => setExcess((p) => (p ? { ...p, rate: e.target.value } : p))}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-amber-900">Next bargain for the excess</Label>
                      {nextBargains.length === 0 ? (
                        <p className="text-[11px]">
                          No other open bargain for {actionRow.supplier_name} has {formatNum(excess.qty)} {actionRow.uom} free — book it as a new bargain instead.
                        </p>
                      ) : (
                        <Select
                          value={excess.targetBargainId}
                          onValueChange={(v) => setExcess((p) => (p ? { ...p, targetBargainId: v } : p))}
                        >
                          <SelectTrigger className="bg-white"><SelectValue placeholder="Select bargain" /></SelectTrigger>
                          <SelectContent>
                            {nextBargains
                              .sort((a, b) => String(a.bargain_date || '').localeCompare(String(b.bargain_date || '')))
                              .map((b) => (
                                <SelectItem key={b.id} value={String(b.id)}>
                                  {b.bargain_no} · BAL {formatNum(b.balance_qty)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label>Source / port</Label>
              <Select value={String(actionForm.source_id || '')} onValueChange={(value) => setActionForm((p) => ({ ...p, source_id: value }))}>
                <SelectTrigger><SelectValue placeholder="Where it loads from" /></SelectTrigger>
                <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)]">
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={String(source.id)}>
                      <span className="block truncate">{source.name} · {source.transit_days}d</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><Label>Payment arrangement</Label>
              <Select value={actionForm.payment_mode || 'paid_by_us'} onValueChange={(value) => setActionForm((p) => ({ ...p, payment_mode: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                  <SelectItem value="supplier_finance">Supplier financed — pay later</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              This records the loading only. Sending it on its way is the next step, In transit, which asks for the transporter
              rate and works the expected delivery out from the source&rsquo;s transit days. A purchase invoice is not required
              first.
            </p>
          </div>}
          {target === 'transit' && actionRow && (() => {
            // The freight rate is agreed when the tanker sets off, so it is
            // asked for here rather than weeks later at Empty. Only an EX load
            // is ours to pay, so only EX makes it compulsory.
            const ex = condIsEx(actionRow)
            return (
              <div className="grid gap-3">
                <div className={cn('grid grid-cols-2 gap-3', __WEB__ && cn(TK_SECT, '!gap-4'))}>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transit date</Label>
                    <DatePicker
                      value={actionForm.transit_date || ''}
                      min={stageFloor(actionRow, 'transit_date')?.iso}
                      max={todayISO()}
                      onChange={(v) => setActionForm((p) => ({ ...p, transit_date: v }))}
                    />
                    <StageDateNote row={actionRow} dateKey="transit_date" />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label>Source / port</Label>
                    <Select value={String(actionForm.source_id || '')} onValueChange={(v) => setActionForm((p) => ({ ...p, source_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)]">
                        {sources.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            <span className="block truncate">{s.name} · {s.transit_days}d</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className={cn('grid grid-cols-2 gap-3 rounded-lg border p-3', __WEB__ && cn(TK_SECT, '!gap-4'))}>
                  {/* Who pays. On the website it is a banded strip across the
                      top of the card rather than a line of small print inside
                      it — EX and DLD change what this card is FOR, and the
                      rate below is required in one case and not the other. */}
                  <div
                    className={cn(
                      'col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]',
                      __WEB__ &&
                        cn(
                          // Bleeds to the card's edges, so it is a band across
                          // the top rather than a tinted box floating inside a
                          // white one.
                          '!-mx-[18px] !-mt-[18px] !gap-x-2.5 !rounded-t-[3px] !border-b !px-[18px] !py-3 !text-[12.5px] !font-semibold',
                          ex ? '!border-b-[#F0E4CB] !bg-[#FFFBF2]' : '!border-b-[#E4ECE3] !bg-[#F7FAF6]'
                        )
                    )}
                  >
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                        ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700',
                        __WEB__ &&
                          cn(
                            '!rounded-[2px] !px-[7px] !py-[3px] !text-[10px] !font-extrabold !tracking-[.06em]',
                            ex
                              ? '!border !border-[#F0E4CB] !bg-[#FFF4E0] !text-[#8A5300]'
                              : '!border !border-[#DCE7DB] !bg-[#EAF0E9] !text-[#33473E]'
                          )
                      )}
                    >
                      {ex ? 'EX' : 'DLD'}
                    </span>
                    <span className={cn('text-muted-foreground', __WEB__ && (ex ? '!text-[#8A5300]' : '!text-[#5A6B62]'))}>
                      {ex
                        ? 'We pay the freight on this tanker — enter the rate, or 0 with a reason.'
                        : 'The supplier carries the freight — the rate is only for the record.'}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    <Select
                      value={String(actionForm.transporter_id || '')}
                      onValueChange={(v) => {
                        const tr = transporters.find((x) => String(x.id) === v)
                        setActionForm((p) => ({
                          ...p,
                          transporter_id: v,
                          transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || ''
                        }))
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>
                      Transporter rate / {actionRow.uom || 'MT'}
                      {ex && <span className="ml-1 text-rose-600">*</span>}
                    </Label>
                    <Input
                      type="number"
                      className={cn(ex && !(Number(actionForm.transport_rate_per_ton) > 0) && !String(actionForm.freight_remark || '').trim() && 'border-rose-400')}
                      placeholder={ex ? 'Rate, or 0' : 'Optional'}
                      value={actionForm.transport_rate_per_ton ?? ''}
                      onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))}
                    />
                    {Number(actionForm.transport_rate_per_ton) > 0 && Number(actionRow.loaded_qty) > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        ≈ {formatINR(Number(actionForm.transport_rate_per_ton) * Number(actionRow.loaded_qty))} on{' '}
                        {formatNum(actionRow.loaded_qty)} {actionRow.uom || 'MT'} loaded — settles on the received qty.
                      </span>
                    )}
                  </div>
                  {/* Zero freight has to be explained. And it has a consequence
                      worth stating here, where the decision is made: with no
                      freight there is nothing to dock a shortage from. */}
                  {ex && !(Number(actionForm.transport_rate_per_ton) > 0) && (
                    <div className="col-span-2 flex flex-col gap-1.5">
                      <Label>
                        Why is there no freight?<span className="ml-1 text-rose-600">*</span>
                      </Label>
                      <Input
                        value={actionForm.freight_remark ?? ''}
                        placeholder="e.g. supplier's own lorry — freight is in the invoice rate"
                        onChange={(e) => setActionForm((p) => ({ ...p, freight_remark: e.target.value }))}
                      />
                      <span className={cn('text-[11px] text-muted-foreground', __WEB__ && '!text-[11.5px] !font-semibold !leading-[1.5] !text-[#8A5300]')}>
                        No shortage charge will be raised on this tanker — there is no freight to dock it from.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
          {/* One date each. On the website they sit on a card like every other
              stage, and the field is held to a sensible width — a lone input
              stretched across 790px of panel is not a form, it is a search
              box. The note says what stamping the date actually does. */}
          {target === 'outside_factory' && (
            <div className={cn(__WEB__ && TK_SECT)}>
              <div className={cn('flex flex-col gap-1.5', __WEB__ && 'max-w-[300px]')}>
                <Label>Outside factory date</Label>
                <DatePicker
                  value={actionForm.outside_factory_date || ''}
                  min={stageFloor(actionRow, 'outside_factory_date')?.iso}
                  max={todayISO()}
                  onChange={(v) => setActionForm({ outside_factory_date: v })}
                />
                <StageDateNote row={actionRow} dateKey="outside_factory_date" />
              </div>
              {__WEB__ && (
                <p className="mt-3 text-[12px] font-semibold leading-[1.5] text-[#5A6B62]">
                  The day the tanker reached the factory gate and joined the queue outside. Nothing is weighed
                  or received yet.
                </p>
              )}
            </div>
          )}
          {target === 'inside_factory' && (
            <div className={cn(__WEB__ && TK_SECT)}>
              <div className={cn('flex flex-col gap-1.5', __WEB__ && 'max-w-[300px]')}>
                <Label>Inside factory date</Label>
                <DatePicker
                  value={actionForm.inside_factory_date || ''}
                  min={stageFloor(actionRow, 'inside_factory_date')?.iso}
                  max={todayISO()}
                  onChange={(v) => setActionForm({ inside_factory_date: v })}
                />
                <StageDateNote row={actionRow} dateKey="inside_factory_date" />
              </div>
              {__WEB__ && (
                <p className="mt-3 text-[12px] font-semibold leading-[1.5] text-[#5A6B62]">
                  The day it was called in off the queue. The received quantity is settled at Empty, against
                  the gate weighment.
                </p>
              )}
            </div>
          )}
          {target === 'empty' && actionRow && shortage && <div className="grid gap-4">
            {(() => {
              const gq = gateQtyFor(actionRow.id)
              const hasPending = gateEntries.some(
                (g) => Number(g.tanker_id) === Number(actionRow.id) && g.status === 'pending'
              )
              return gq == null ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {hasPending
                    ? `Tanker ${actionRow.tanker_no} arrived at the gate but its weight is still pending. Complete the weighment in Gate Entry first — this step is blocked until then.`
                    : `No gate entry recorded for tanker ${actionRow.tanker_no}. Record the gate receipt in Gate Entry first — this step is blocked until then.`}
                </div>
              ) : (
                <div className="rounded-md bg-muted px-3 py-2 text-sm">
                  Gate received qty: <span className="font-semibold tabular-nums">{formatNum(gq)} {actionRow.uom}</span>
                  <span className="text-muted-foreground"> — the received quantity must match this.</span>
                </div>
              )
            })()}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Empty date</Label>
                <DatePicker
                  value={actionForm.empty_date || ''}
                  min={stageFloor(actionRow, 'empty_date')?.iso}
                  max={todayISO()}
                  onChange={(v) => setActionForm((p) => ({ ...p, empty_date: v }))}
                />
                <StageDateNote row={actionRow} dateKey="empty_date" />
              </div>
              <div className="flex flex-col gap-1.5"><Label>Received quantity</Label><Input type="number" value={actionForm.received_qty || ''} onChange={(e) => setActionForm((p) => ({ ...p, received_qty: e.target.value }))} /></div>
            </div>
            {(() => {
              // Both of these are settled when the tanker is sent In transit, so
              // here they are a read-back rather than a question. A tanker that
              // reached transit before the rate was asked for there has nothing
              // to show, so those stay editable — otherwise the load could never
              // be completed.
              const agreed = Number(actionRow.transport_rate_per_ton) > 0
              const tName = transporters.find((x) => String(x.id) === String(actionForm.transporter_id))?.name || ''
              return (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Transporter</Label>
                    {agreed ? (
                      <div className="flex h-10 items-center rounded-md border bg-muted/50 px-3 text-sm">{tName || '—'}</div>
                    ) : (
                      <Select value={String(actionForm.transporter_id || '')} onValueChange={(v) => {
                        const tr = transporters.find((x) => String(x.id) === v)
                        setActionForm((p) => ({ ...p, transporter_id: v, transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || '' }))
                      }}><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger><SelectContent>{transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}</SelectContent></Select>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Transport rate / {actionRow.uom}</Label>
                    {agreed ? (
                      <>
                        <div className="flex h-10 items-center justify-between rounded-md border bg-muted/50 px-3 text-sm tabular-nums">
                          <span>{formatINR(actionRow.transport_rate_per_ton)}</span>
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">set at In transit</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground">Change it on the tanker&apos;s Edit form if it was agreed differently.</span>
                      </>
                    ) : (
                      <>
                        <Input type="number" value={actionForm.transport_rate_per_ton || ''} onChange={(e) => setActionForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} />
                        <span className="text-[11px] text-muted-foreground">No rate was captured at In transit for this tanker — enter it here.</span>
                      </>
                    )}
                  </div>
                </div>
              )
            })()}
            <div className={cn('grid gap-3 rounded-lg border p-3', __WEB__ && cn(TK_SECT, '!gap-4'))}>
              <div className={cn('text-sm font-medium', __WEB__ && '!text-[11px] !font-extrabold !uppercase !tracking-[.13em] !text-[#0A1F17]')}>
                KRFL weighment slip
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label>Doc number</Label><Input value={actionForm.krfl_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} /></div>
                <PhotoUpload
                  label="Photo of the slip"
                  value={actionForm.krfl_weighment_photo || ''}
                  busy={photoBusy === 'krfl_weighment_photo'}
                  onPick={(f) => void onWeighmentPhoto('krfl_weighment_photo', f)}
                  onClear={() => setActionForm((p) => ({ ...p, krfl_weighment_photo: '' }))}
                />
              </div>
            </div>
            <div className={cn('grid gap-3 rounded-lg border p-3', __WEB__ && cn(TK_SECT, '!gap-4'))}>
              <div className={cn('text-sm font-medium', __WEB__ && '!text-[11px] !font-extrabold !uppercase !tracking-[.13em] !text-[#0A1F17]')}>
                Outside factory weighment slip
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label>Doc number</Label><Input value={actionForm.outside_weighment_doc_no || ''} onChange={(e) => setActionForm((p) => ({ ...p, outside_weighment_doc_no: e.target.value }))} /></div>
                <PhotoUpload
                  label="Photo of the slip"
                  value={actionForm.outside_weighment_photo || ''}
                  busy={photoBusy === 'outside_weighment_photo'}
                  onPick={(f) => void onWeighmentPhoto('outside_weighment_photo', f)}
                  onClear={() => setActionForm((p) => ({ ...p, outside_weighment_photo: '' }))}
                />
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3"><MoneyRow label="Loaded" value={`${formatNum(actionRow.loaded_qty)} ${actionRow.uom}`} /><MoneyRow label="Shortage" value={`${formatNum(shortage.actualShortage)} ${actionRow.uom}`} /><MoneyRow label="Freight" value={formatINR(shortage.transportAmount)} /></div>
          </div>}
          </div>
          <DialogFooter className={cn(TK_FOOT)}><Button variant="outline" onClick={() => { setActionRow(null); setExcess(null); setRailPeek(null) }}>Cancel</Button>
          {__WEB__ && !!railPeek ? (
            // Confirm would advance the tanker, which is not what somebody
            // reading its history is asking for. The primary action while
            // peeking is the way back to the form.
            <Button onClick={() => setRailPeek(null)}>
              <ArrowLeft className="h-4 w-4" /> Back to {target ? TANKER_LABEL[target] : 'the form'}
            </Button>
          ) : (
          <Button
            onClick={advanceTanker}
            disabled={target === 'transit' && !!actionRow && condIsEx(actionRow) && !(Number(actionForm.transport_rate_per_ton) > 0) && !String(actionForm.freight_remark || '').trim()}
            title={
              target === 'transit' && !!actionRow && condIsEx(actionRow) && !(Number(actionForm.transport_rate_per_ton) > 0) && !String(actionForm.freight_remark || '').trim()
                ? 'Enter the transporter rate, or put 0 and say why there is no freight'
                : undefined
            }
          >{excess ? (excess.mode === 'existing' ? 'Allocate & confirm' : 'Add bargain & confirm') : 'Confirm'}</Button>
          )}</DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Technical parameters for an invoice, one block per emptied tanker.
          Same drawer shape as the stage forms — something is being recorded
          against a row that stays visible behind. */}
      <Dialog open={!!qualityFor} onOpenChange={(o) => { if (!o && !qualityBusy) setQualityFor(null) }}>
        <DialogContent className={cn('max-h-[92vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg', TK_DRAWER, TK_NARROW)}>
          <DialogHeader className={cn(TK_HEAD)}>
            <div className={cn(__WEB__ && 'pr-12')}>
              {__WEB__ && <div className={TK_KICKER}>Technical parameters</div>}
              <DialogTitle className={cn(TK_TITLE, __WEB__ && 'doc-ref')}>
                {String(qualityFor?.invoice_no || 'Invoice')}
              </DialogTitle>
              {__WEB__ && !!qualityFor && (
                <div className={TK_SUB}>
                  {[
                    String(qualityFor.supplier_name || ''),
                    String(qualityFor.oil_code || qualityFor.oil_name || ''),
                    qualitySets.length
                      ? qualitySets[0]?.tanker.order_level
                        ? 'consignment — readings on the invoice'
                        : `${qualitySets.length} tanker${qualitySets.length === 1 ? '' : 's'} emptied`
                      : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          </DialogHeader>

          <div className={cn(__WEB__ && cn(TK_BODY, TK_FIELDS, 'grid content-start'))}>
            {qualitySets.length === 0 && (
              <div className={cn('rounded-lg border p-4 text-center text-sm text-muted-foreground', __WEB__ && cn(TK_SECT, '!text-[12.5px] !font-semibold !text-[#8FA79B]'))}>
                {qualityFor &&
                (Number(qualityFor.empty_tankers) > 0 ||
                  (!Number(qualityFor.tanker_count) && String(qualityFor.status) === 'received'))
                  ? 'Loading…'
                  : 'No tanker on this invoice has been emptied yet — readings are taken from the load once it is in.'}
              </div>
            )}
            {qualitySets.map((set, si) => (
              <div key={String(set.tanker.id)} className={cn('grid gap-3 rounded-lg border p-3', __WEB__ && cn(TK_SECT, '!gap-3'))}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={cn('text-[11px] font-bold uppercase tracking-widest text-muted-foreground', __WEB__ && 'doc-ref !text-[13.5px] !font-bold !normal-case !tracking-normal !text-[#0A1F17]')}>
                      {String(set.tanker.tanker_no || 'Tanker')}
                    </div>
                    {__WEB__ && (
                      <div className="mt-0.5 text-[11.5px] font-semibold text-[#5A6B62]">
                        {Number(set.tanker.received_qty)
                          ? `${formatNum(set.tanker.received_qty)} ${String(set.tanker.uom || 'MT')} received`
                          : `${formatNum(set.tanker.loaded_qty)} ${String(set.tanker.uom || 'MT')} loaded`}
                        {set.tanker.empty_date ? ` · emptied ${formatDate(set.tanker.empty_date)}` : ''}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={cn('h-7 gap-1 px-2 text-[11px]', __WEB__ && '!h-8 !rounded-[3px] !text-[11.5px] !font-bold')}
                    onClick={() =>
                      setQualitySets((p) => p.map((x, i) => (i === si ? { ...x, rows: [...x.rows, { name: '', value: '', unit: '%' }] } : x)))
                    }
                  >
                    <Plus className="h-3.5 w-3.5" /> Add reading
                  </Button>
                </div>
                {/* Anything left blank is not saved — "not tested" and "tested
                    at nothing" are different answers. */}
                <div className="grid gap-2">
                  {set.rows.map((q: Row, ri: number) => (
                    <div key={ri} className="flex items-center gap-2">
                      <Input
                        value={String(q.name ?? '')}
                        placeholder="Parameter"
                        onChange={(e) => setQualityRow(si, ri, { name: e.target.value })}
                        className={cn('h-9 flex-1 text-[13px]', __WEB__ && '!h-[42px]')}
                      />
                      <div className="relative w-44 shrink-0">
                        <Input
                          value={String(q.value ?? '')}
                          placeholder="—"
                          inputMode="decimal"
                          onChange={(e) => setQualityRow(si, ri, { value: e.target.value })}
                          className={cn('h-9 pr-[82px] text-right text-[13px]', __WEB__ && '!h-[42px] !pr-[82px]')}
                        />
                        <QualityUnit
                          value={String(q.unit ?? '%')}
                          onChange={(v) => setQualityRow(si, ri, { unit: v, unit_touched: true })}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-destructive"
                        title="Remove this reading"
                        onClick={() =>
                          setQualitySets((p) => p.map((x, i) => (i === si ? { ...x, rows: x.rows.filter((_, j) => j !== ri) } : x)))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {__WEB__ && qualitySets.length > 0 && (
              <p className="text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
                Each reading carries its own unit — click the one beside a value to change it between %, degrees, a
                lab unit, or a bare figure.
              </p>
            )}
          </div>

          <DialogFooter className={cn(TK_FOOT)}>
            <Button variant="outline" onClick={() => setQualityFor(null)} disabled={qualityBusy}>Cancel</Button>
            <Button onClick={() => void saveQuality()} disabled={qualityBusy || qualitySets.length === 0}>
              {qualityBusy ? 'Saving…' : 'Save readings'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign bargains to an unmapped invoice */}
      <Dialog open={!!mapRow} onOpenChange={(o) => !o && setMapRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Assign bargains — invoice {mapRow?.invoice_no}</DialogTitle>
          </DialogHeader>
          {mapRow && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-muted/40 p-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-[11px] text-muted-foreground">Supplier</div>
                  <div className="font-medium">{mapRow.supplier_name}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Product</div>
                  <div className="font-medium">{mapRow.product_code || mapRow.product_name}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Invoice quantity</div>
                  <div className="font-medium tabular-nums">
                    {formatNum(mapRow.ordered_qty)} {mapRow.uom}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Taxable value</div>
                  <div className="font-medium tabular-nums">{formatINR(mapRow.taxable_value)}</div>
                </div>
              </div>

              {/* One line per bargain. The same bargain can be added twice — the
                  quantities are merged when it is saved. */}
              <div className="space-y-2">
                {mapLines.map((line, index) => {
                  const bg = bargains.find((b) => String(b.id) === String(line.bargain_id))
                  const balance = bg ? Number(bg.balance_qty) || 0 : 0
                  const qty = Number(line.qty) || 0
                  const short = qty - balance
                  return (
                    <div key={index} className="grid gap-2 rounded-lg border p-2.5 md:grid-cols-[minmax(0,1fr)_7rem_auto]">
                      <div className="flex min-w-0 flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">Bargain</Label>
                        <Select
                          value={String(line.bargain_id || '')}
                          onValueChange={(v) =>
                            setMapLines((p) => p.map((x, i) => (i === index ? { ...x, bargain_id: v } : x)))
                          }
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder={mapBargains.length ? 'Select bargain' : 'No bargain for this supplier & product'} />
                          </SelectTrigger>
                          <SelectContent>
                            {mapBargains.map((b) => (
                              <SelectItem key={b.id} value={String(b.id)}>
                                {b.bargain_no} · {formatDate(b.bargain_date)} · bal {formatNum(b.balance_qty)} {b.uom} @{' '}
                                {formatINR(b.rate_per_uom)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">Qty ({mapRow.uom})</Label>
                        <Input
                          type="number"
                          className="h-9 text-right"
                          value={line.qty ?? ''}
                          onChange={(e) =>
                            setMapLines((p) => p.map((x, i) => (i === index ? { ...x, qty: e.target.value } : x)))
                          }
                        />
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="min-w-[9rem] pb-1 text-[11px] leading-tight">
                          {bg ? (
                            <>
                              <div className="tabular-nums text-muted-foreground">
                                {formatINR(Number(bg.rate_per_uom) * qty)}
                              </div>
                              {short > 0.0001 ? (
                                <label className="mt-0.5 flex cursor-pointer items-start gap-1.5 text-amber-800">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5 h-3 w-3 accent-amber-600"
                                    checked={!!line.top_up}
                                    onChange={(e) =>
                                      setMapLines((p) =>
                                        p.map((x, i) => (i === index ? { ...x, top_up: e.target.checked } : x))
                                      )
                                    }
                                  />
                                  <span>
                                    {formatNum(short)} over balance — add it to the bargain
                                  </span>
                                </label>
                              ) : (
                                <div className="text-muted-foreground">
                                  balance left {formatNum(balance - qty)}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">pick a bargain</span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive"
                          disabled={mapLines.length === 1}
                          onClick={() => setMapLines((p) => p.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMapLines((p) => [...p, { bargain_id: '', qty: '', top_up: false }])}
                >
                  <Plus className="h-4 w-4" /> Add another bargain
                </Button>
              </div>

              {/* Quantity and value reconciliation */}
              <div className="rounded-lg border">
                <MoneyRow
                  label="Allocated quantity"
                  value={`${formatNum(mapAllocated)} of ${formatNum(mapRow.ordered_qty)} ${mapRow.uom}`}
                  strong
                />
                {Math.abs(mapRemaining) > 0.0001 && (
                  <MoneyRow
                    label={mapRemaining > 0 ? 'Still to allocate' : 'Over-allocated by'}
                    value={`${formatNum(Math.abs(mapRemaining))} ${mapRow.uom}`}
                  />
                )}
                <div className="mx-3 border-t" />
                <MoneyRow label="Value at bargain rates" value={formatINR(mapBargainValue)} />
                <MoneyRow label="Invoice taxable value" value={formatINR(mapRow.taxable_value)} />
                <MoneyRow label="Difference" value={formatINR(mapValueDiff)} strong />
              </div>

              {Math.abs(mapValueDiff) > 1 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Values do not match.</span> The invoice was booked at{' '}
                  {formatINR(mapRow.taxable_value)} but these bargains price it at {formatINR(mapBargainValue)} — a
                  difference of {formatINR(mapValueDiff)}. That is normal when the invoice carries interest or freight;
                  check it before saving.
                </div>
              )}
              {mapWarn && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {mapWarn}
                </div>
              )}
              {mapError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {mapError}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMapRow(null)} disabled={mapping}>
              Cancel
            </Button>
            <Button onClick={() => saveMapping(false)} disabled={mapping}>
              {mapping ? 'Saving…' : Math.abs(mapValueDiff) > 1 ? 'Check and assign' : 'Assign bargains'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace a tanker mid-transit (accident/breakdown) */}
      <Dialog open={!!replaceRow} onOpenChange={(open) => !open && setReplaceRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Replace tanker {replaceRow?.tanker_no}</DialogTitle>
          </DialogHeader>
          {replaceRow && (
            <div className="grid gap-3">
              <p className="text-[12px] text-muted-foreground">
                Bargain, financials and the invoice link stay on this record — only the vehicle number changes, and
                any quantity lost comes off what it's now expected to deliver ({formatNum(replaceRow.loaded_qty)} {replaceRow.uom} loaded so far).
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>Replacement tanker number *</Label>
                <Input value={replaceForm.new_tanker_no ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, new_tanker_no: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity lost ({replaceRow.uom})</Label>
                  <Input type="number" value={replaceForm.loss_qty ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, loss_qty: e.target.value })} placeholder="0" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={replaceForm.date || ''} onChange={(v) => setReplaceForm({ ...replaceForm, date: v })} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Reason</Label>
                <Input value={replaceForm.reason ?? ''} onChange={(e) => setReplaceForm({ ...replaceForm, reason: e.target.value })} placeholder="e.g. accident en route" />
              </div>
              {Number(replaceForm.loss_qty) > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  New expected quantity: {formatNum(Math.max(0, Number(replaceRow.loaded_qty) - Number(replaceForm.loss_qty)))} {replaceRow.uom}
                </div>
              )}
              {replaceError && <p className="text-sm text-destructive">{replaceError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceRow(null)} disabled={replaceSaving}>Cancel</Button>
            <Button onClick={() => void saveReplaceTanker()} disabled={replaceSaving}>{replaceSaving ? 'Saving…' : 'Replace tanker'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <HistoryDialog target={hist.target} onClose={hist.close} />

      {/* Edit all stage entries of a tanker */}
      <Dialog open={!!editTanker} onOpenChange={(open) => !open && setEditTanker(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit tanker {editTanker?.tanker_no} — {TANKER_LABEL[String(editTanker?.status)] ?? editTanker?.status}</DialogTitle>
          </DialogHeader>
          {editTanker && (() => {
            const eIdx = TANKER_STAGES.indexOf(String(editTanker.status))
            const eGate = gateQtyFor(editTanker.id)
            return (
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>Tanker number</Label>
                    <Input value={editTankerForm.tanker_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, tanker_no: e.target.value }))} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>{editTanker.extra_bargain_id ? 'Bargain (primary)' : 'Bargain'}</Label>
                    <Select value={String(editTankerForm.bargain_id || '')} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, bargain_id: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select bargain" /></SelectTrigger>
                      <SelectContent>
                        {bargains
                          .filter((b) => String(b.supplier_id) === String(editTanker.supplier_id) && String(b.oil_type_id) === String(editTanker.oil_type_id))
                          .map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · BAL {formatNum(b.balance_qty)}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* EX/DLD decides who bears the freight and who carries the
                    shortage beyond tolerance, so it's correctable here rather
                    than only at send-to-supplier time. */}
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-1">
                    Condition
                    <InfoTip text="EX — we bear the freight and the supplier owes us shortage beyond tolerance. DLD — the supplier delivers, so no freight of ours and no shortage deduction. 'Follow bargain' uses whatever this tanker's bargain says." />
                  </Label>
                  <div className="flex h-9 w-fit rounded-md border p-0.5">
                    {[
                      { v: '', label: 'Follow bargain' },
                      { v: 'EX', label: 'EX' },
                      { v: 'DLD', label: 'DLD' }
                    ].map((c) => (
                      <button
                        key={c.v || 'inherit'}
                        type="button"
                        onClick={() => setEditTankerForm((p) => ({ ...p, condition: c.v }))}
                        className={cn(
                          'rounded px-3 text-xs font-semibold transition-colors',
                          String(editTankerForm.condition || '') === c.v
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {!String(editTankerForm.condition || '') && (
                    <span className="text-[11px] text-muted-foreground">
                      Following the bargain — currently{' '}
                      <b>{['DLD', 'DELIVERED'].includes(String(editTanker.bargain_type || '').toUpperCase()) ? 'DLD' : 'EX'}</b>
                    </span>
                  )}
                </div>

                {!!editTanker.extra_bargain_id && (() => {
                  const loaded = Number(editTankerForm.loaded_qty ?? editTanker.loaded_qty) || 0
                  const extra = Number(editTanker.extra_qty) || 0
                  const primary = Math.max(0, loaded - extra)
                  return (
                    <div className="overflow-hidden rounded-md border border-sky-200">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-sky-50 text-left text-sky-900">
                            <th className="px-3 py-1.5 font-semibold">Bargain</th>
                            <th className="px-3 py-1.5 font-semibold">Share</th>
                            <th className="px-3 py-1.5 text-right font-semibold">Qty ({editTanker.uom})</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b bg-card">
                            <td className="px-3 py-1.5 font-medium">{editTanker.bargain_no}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">Primary</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(primary)}</td>
                          </tr>
                          <tr className="border-b bg-card">
                            <td className="px-3 py-1.5 font-medium">{editTanker.extra_bargain_no || `Bargain #${editTanker.extra_bargain_id}`}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">Excess</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(extra)}</td>
                          </tr>
                          <tr className="bg-sky-50/60 font-semibold text-sky-900">
                            <td className="px-3 py-1.5" colSpan={2}>Total loaded</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatNum(loaded)}</td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="border-t bg-sky-50 px-3 py-1.5 text-[11px] text-sky-900">
                        The excess allocation stays on {editTanker.extra_bargain_no || 'its bargain'} when you edit — changing the loaded qty adjusts only the primary share.
                      </p>
                    </div>
                  )
                })()}

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>{eIdx <= 0 ? 'Tanker placement date' : 'Loaded date'}</Label>
                    <DatePicker value={editTankerForm.loaded_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, loaded_date: v }))} />
                  </div>
                  {eIdx >= 2 && (
                    <div className="flex flex-col gap-1.5">
                      <Label>Loaded qty ({editTanker.uom})</Label>
                      <Input type="number" value={editTankerForm.loaded_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, loaded_qty: e.target.value }))} />
                    </div>
                  )}
                </div>

                {eIdx >= 2 && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Payment</Label>
                      <Select value={editTankerForm.payment_mode || 'paid_by_us'} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, payment_mode: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="paid_by_us">Payment done by us</SelectItem>
                          <SelectItem value="supplier_finance">Supplier financed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Transit date</Label>
                      <DatePicker value={editTankerForm.transit_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, transit_date: v }))} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Source / port</Label>
                      <Select value={String(editTankerForm.source_id || '')} onValueChange={(v) => setEditTankerForm((p) => ({ ...p, source_id: v }))}>
                        <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          {sources.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name} · {s.transit_days}d</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {eIdx >= 2 && (
                  <div className="grid gap-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      <span className="font-medium">Freight</span>
                      <span className="text-muted-foreground">
                        Agreed when the tanker goes In transit; change it here if it was settled differently. Priced on the
                        received quantity.
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label>Transporter</Label>
                        <Select value={String(editTankerForm.transporter_id || '')} onValueChange={(v) => {
                          const tr = transporters.find((x) => String(x.id) === v)
                          setEditTankerForm((p) => ({
                            ...p,
                            transporter_id: v,
                            transport_rate_per_ton: p.transport_rate_per_ton || tr?.default_rate_per_ton || ''
                          }))
                        }}>
                          <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                          <SelectContent className="max-h-72">
                            {transporters.map((tr) => <SelectItem key={tr.id} value={String(tr.id)}>{tr.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label>Transport rate / {editTanker.uom}</Label>
                        <Input type="number" value={editTankerForm.transport_rate_per_ton ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, transport_rate_per_ton: e.target.value }))} />
                        {Number(editTankerForm.transport_rate_per_ton) > 0 && (
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            ≈ {formatINR(
                              Number(editTankerForm.transport_rate_per_ton) *
                                (Number(editTankerForm.received_qty) > 0
                                  ? Number(editTankerForm.received_qty)
                                  : Number(editTanker.loaded_qty) || 0)
                            )}
                            {Number(editTankerForm.received_qty) > 0 ? ' on the received qty' : ' on the loaded qty (until weighed in)'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {eIdx >= 3 && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>Outside factory date</Label>
                      <DatePicker value={editTankerForm.outside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, outside_factory_date: v }))} />
                    </div>
                    {eIdx >= 4 && (
                      <div className="flex flex-col gap-1.5">
                        <Label>Inside factory date</Label>
                        <DatePicker value={editTankerForm.inside_factory_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, inside_factory_date: v }))} />
                      </div>
                    )}
                  </div>
                )}

                {eIdx >= 5 && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label>Empty date</Label>
                        <DatePicker value={editTankerForm.empty_date || ''} onChange={(v) => setEditTankerForm((p) => ({ ...p, empty_date: v }))} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Received qty {eGate != null ? `(gate: ${formatNum(eGate)})` : ''}</Label>
                        <Input type="number" value={editTankerForm.received_qty ?? ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, received_qty: e.target.value }))} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label>KRFL weighment doc no</Label>
                        <Input value={editTankerForm.krfl_weighment_doc_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, krfl_weighment_doc_no: e.target.value }))} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Outside factory weighment doc no</Label>
                        <Input value={editTankerForm.outside_weighment_doc_no || ''} onChange={(e) => setEditTankerForm((p) => ({ ...p, outside_weighment_doc_no: e.target.value }))} />
                      </div>
                    </div>
                  </>
                )}

                <p className="text-[11px] text-muted-foreground">
                  Changing quantities revalidates the bargain balance{eIdx >= 5 ? ', re-matches the gate weight and recalculates freight/shortage on the linked purchase' : ''}.
                </p>
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTanker(null)}>Cancel</Button>
            <Button onClick={saveEditTanker}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Asked for on the Sales side first — "display nicely the whole
          calculations of the TDS on a icon click as per threshold or how the
          calculation is going". The same question gets asked of a purchase,
          and more often, because the purchase slab is the one that runs out
          mid-invoice. */}
      <TdsExplainer
        open={tdsOpen}
        onClose={() => setTdsOpen(false)}
        side="purchase"
        dealDate={String(form.order_date || '')}
        parties={tdsParties}
      />

      <Dialog open={!!viewTankerRow} onOpenChange={(open) => !open && setViewTankerRow(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>{String(viewTankerRow?.tanker_no || '').trim() || 'Tanker'}</span>
              {viewTankerRow && <StatusBadge status={String(viewTankerRow.status || '')} />}
            </DialogTitle>
          </DialogHeader>
          {viewTankerRow && (() => {
            const t = viewTankerRow
            const invoiceCompany = t.order_id
              ? companies.find((c) => Number(c.id) === Number(t.invoice_company_id))
              : null
            return (
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <InfoTile icon={Building2} label="Supplier" value={t.supplier_name || '—'} />
                  <InfoTile icon={Boxes} label="Product" value={t.oil_code || t.oil_name || '—'} />
                  <InfoTile
                    icon={ScrollText}
                    label="Bargain"
                    value={t.bargain_no ? `${t.bargain_no}${t.extra_bargain_no ? ` + ${t.extra_bargain_no}` : ''}` : '—'}
                  />
                  <InfoTile icon={CalendarDays} label="Source" value={t.source_name || '—'} />
                </div>

                <div className="rounded-xl border">
                  <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                    <Boxes className="h-3.5 w-3.5 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Quantity</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-4">
                    <Fact label="Loaded" value={`${formatNum(t.loaded_qty)} ${t.uom || 'MT'}`} />
                    <Fact label="Received" value={t.received_qty != null ? `${formatNum(t.received_qty)} ${t.uom || 'MT'}` : '—'} />
                    {Number(t.extra_qty) > 0 && (
                      <Fact label="Split to extra bargain" value={`${formatNum(t.extra_qty)} ${t.uom || 'MT'}`} />
                    )}
                    {Number(t.loss_qty) > 0 && (
                      <Fact label="Lost (replaced)" value={`${formatNum(t.loss_qty)} ${t.uom || 'MT'}`} />
                    )}
                  </div>
                </div>

                <div className="rounded-xl border">
                  <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                    <CalendarDays className="h-3.5 w-3.5 text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Timeline</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
                    <Fact label="Loaded" value={t.loaded_date ? formatDate(t.loaded_date) : '—'} />
                    <Fact label="In transit" value={t.transit_date ? formatDate(t.transit_date) : '—'} />
                    <Fact label="Expected delivery" value={t.expected_delivery_date ? formatDate(t.expected_delivery_date) : '—'} />
                    <Fact label="Outside factory" value={t.outside_factory_date ? formatDate(t.outside_factory_date) : '—'} />
                    <Fact label="Inside factory" value={t.inside_factory_date ? formatDate(t.inside_factory_date) : '—'} />
                    <Fact label="Empty" value={t.empty_date ? formatDate(t.empty_date) : '—'} />
                  </div>
                </div>

                {(() => {
                  // Read-only freight picture for this tanker. Shown for every EX
                  // load even before a transporter is attached, so a missing rate
                  // is visible here rather than only surfacing at Empty.
                  const ex = condIsEx(t)
                  const rate = Number(t.transport_rate_per_ton) || 0
                  const rec = t.received_qty != null ? Number(t.received_qty) : null
                  const basisQty = rec != null ? rec : Number(t.loaded_qty) || 0
                  if (!ex && !t.transporter_name && !(Number(t.transport_amount) > 0)) return null
                  return (
                    <div className="rounded-xl border">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-slate-50 px-3 py-2">
                        <Truck className="h-3.5 w-3.5 text-slate-500" />
                        <span className="text-xs font-semibold text-slate-700">Transport</span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', ex ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700')}>
                          {ex ? 'EX — ours to pay' : 'DLD — supplier pays'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3 p-3">
                        <Fact label="Transporter" value={t.transporter_name || (ex ? 'Not set' : '—')} />
                        <Fact
                          label={`Rate / ${t.uom || 'MT'}`}
                          value={rate > 0 ? formatINR(rate) : ex ? 'Not set' : '—'}
                        />
                        <Fact
                          label="Freight amount"
                          value={Number(t.transport_amount) > 0 ? formatINR(t.transport_amount) : '—'}
                        />
                        {Number(t.shortage_charge_amount) > 0 && (
                          <Fact label="Less shortage charged" value={formatINR(t.shortage_charge_amount)} />
                        )}
                        {rate > 0 && (
                          <div className="col-span-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                            {/* Spelling out the basis, since freight is priced on
                                what arrived and that is not obvious from a total. */}
                            {formatNum(basisQty)} {t.uom || 'MT'} {rec != null ? 'received' : 'loaded'} × {formatINR(rate)} ={' '}
                            <span className="font-semibold tabular-nums text-foreground">{formatINR(basisQty * rate)}</span>
                            {rec == null && ' — settles on the received qty once weighed in'}
                            {rec != null && Number(t.shortage_charge_amount) > 0 && (
                              <> , less {formatINR(t.shortage_charge_amount)} shortage = <span className="font-semibold tabular-nums text-foreground">{formatINR(basisQty * rate - Number(t.shortage_charge_amount))}</span> earned</>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {t.gate_entry_no && (
                  <div className="rounded-xl border">
                    <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                      <DoorOpen className="h-3.5 w-3.5 text-slate-500" />
                      <span className="text-xs font-semibold text-slate-700">Gate</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 p-3">
                      <Fact label="Gate entry" value={t.gate_entry_no} />
                      <Fact label="Gate date" value={t.gate_date ? formatDate(t.gate_date) : '—'} />
                      {t.gate_tanker_no && String(t.gate_tanker_no).trim() !== String(t.tanker_no || '').trim() && (
                        <Fact label="Vehicle at gate" value={t.gate_tanker_no} />
                      )}
                      {Number(t.gate_qty) > 0 && <Fact label="Weighed" value={`${formatNum(t.gate_qty)} ${t.uom || 'MT'}`} />}
                    </div>
                  </div>
                )}

                {t.last_replacement && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <span className="font-semibold">Replaced:</span> {t.last_replacement}
                  </p>
                )}

                {/* Whether — and under which company — this tanker has actually
                    been billed. A tanker isn't anyone's company until an
                    invoice books it there, so this is the one place that
                    matters, not the raw company_id column. */}
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                    t.order_id ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-dashed bg-muted/30 text-muted-foreground'
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  {t.order_id ? (
                    <span>
                      Invoiced as <span className="font-semibold">{t.invoice_no}</span>
                      {t.invoice_date && <> on {formatDate(t.invoice_date)}</>}
                      {invoiceCompany && <> under <span className="font-semibold">{invoiceCompany.name}</span></>}
                    </span>
                  ) : (
                    <span>Not yet invoiced — not tied to any company until it is.</span>
                  )}
                </div>
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>

      <GateEntriesDialog
        open={!!gateOrder}
        onClose={() => setGateOrder(null)}
        heading={`Purchase ${String(gateOrder?.invoice_no || '')}`}
        subheading={String(gateOrder?.supplier_name || gateOrder?.supplier || '') || undefined}
        query={{ orderId: Number(gateOrder?.id) || 0 }}
      />

      <Dialog open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
        {/* min-w-0 down this whole chain, not just max-w-2xl on the dialog
            itself — a plain grid/flex item defaults to min-width:auto (its
            content's own preferred width), so the wide nowrap tanker table
            deep inside was pushing every ancestor open past the dialog's
            edge instead of triggering its own overflow-x-auto scrollbar. */}
        <DialogContent
          className={cn(
            'max-h-[85vh] w-[calc(100vw-2rem)] max-w-4xl min-w-0 overflow-y-auto',
            // A right-hand drawer on the website rather than a centred box:
            // the panel is a tall stack of cards, which reads better in a
            // column against the edge than as a wide dialog floating over the
            // register. Header and footer are pinned; only the middle scrolls.
            __WEB__ &&
              '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[660px] !max-w-[95vw] !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100'
          )}
        >
          <DialogHeader className={cn(__WEB__ && '!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-4 !text-left')}>
            {__WEB__ && (
              <div className="text-[12px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Purchase</div>
            )}
            <DialogTitle className={cn('flex flex-wrap items-center gap-2', __WEB__ && '!mt-1.5 !gap-2.5')}>
              <span className={cn(__WEB__ && '!text-[22px] !font-bold !tracking-[-0.02em] !text-white')}>
                {__WEB__ ? detailRow?.invoice_no : `Purchase ${detailRow?.invoice_no}`}
              </span>
              {detailRow && (__WEB__ ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[.05em]',
                    detailRow.status === 'received' ? 'bg-[#C7F03F] text-[#12280B]' : 'bg-[#FFEDD0] text-[#8A5300]'
                  )}
                >
                  {detailRow.status === 'received' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                  {detailRow.status === 'received' ? 'Completed' : 'In process'}
                </span>
              ) : (
                <Badge variant={detailRow.status === 'received' ? 'success' : 'warning'} className="text-[10px]">
                  {detailRow.status === 'received' ? 'Completed' : 'In process'}
                </Badge>
              ))}
            </DialogTitle>
          </DialogHeader>
          {detailRow && <div className={cn('grid min-w-0 gap-3', __WEB__ && '!min-h-0 !content-start !gap-3.5 !overflow-y-auto !px-[22px] !py-[18px]')}>
            <DrawerSection icon={FileText} title="Purchase details" defaultOpen>
            {/* The bargain this invoice was drawn against, and everything
                written against it. A note explaining why a bargain's quantity
                moved is the reason the invoice looks the way it does, and it
                used to be readable only from the bargain register. */}
            {!!bargainNotes?.length && (
              <div className={cn('rounded-xl border', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !border-l-4 !border-l-[#C2700A] !bg-white')}>
                <div className={cn('flex items-center gap-1.5 border-b bg-amber-50 px-3 py-2', __WEB__ && '!gap-2 !border-b-[#F0E4CB] !bg-[#FFFBF2] !px-3.5 !py-2.5')}>
                  <ScrollText className={cn('h-3.5 w-3.5 text-amber-700', __WEB__ && '!h-[18px] !w-[18px] !text-[#C2700A]')} />
                  <span className={cn('text-xs font-semibold text-amber-900', __WEB__ && '!text-[11px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8A5300]')}>
                    Bargain{bargainNotes.length > 1 ? 's' : ''} &amp; notes
                  </span>
                </div>
                <div className="divide-y">
                  {bargainNotes.map((b) => {
                    const adj = (b.adjustments || []) as Row[]
                    // The bargain's remarks accumulate each adjustment note as
                    // it is made, so showing both would print every note twice.
                    // The adjustments below are the dated, signed record, so the
                    // remarks line keeps only what is not already in one.
                    const noteTexts = new Set(adj.map((a) => String(a.note || '').trim()).filter(Boolean))
                    const extra = String(b.remarks || '')
                      .split('\n')
                      .map((l) => l.trim())
                      .filter((l) => l && !noteTexts.has(l))
                    return (
                      <div key={String(b.id)} className="px-3 py-2 text-[13px]">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="font-medium">{b.bargain_no || 'No bargain no'}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatDate(b.bargain_date)} · {formatNum(b.qty)} {b.uom || 'MT'} @ {formatINR(b.rate_per_uom)}
                          </span>
                          {b.rate_expiry_date && (
                            <span className="text-[11px] text-muted-foreground">
                              expires {formatDate(b.rate_expiry_date)}
                            </span>
                          )}
                        </div>
                        {/* The note itself, not a footnote to the line above
                            it: "Rs 3000/- Interest add" changes what the rate
                            beside it means, so it is set to be read. */}
                        {extra.length > 0 && (
                          <div className={cn('mt-1 text-[12px] text-muted-foreground', __WEB__ && '!mt-1.5 !text-[12.5px] !font-bold !text-[#8A5300]')}>
                            {extra.join(' · ')}
                          </div>
                        )}
                        {adj.length > 0 && (
                          <div className="mt-1.5 space-y-1">
                            {adj.map((a, i) => (
                              <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                                <span className="shrink-0 tabular-nums text-muted-foreground">{formatDate(a.adj_date)}</span>
                                <span
                                  className={cn(
                                    'shrink-0 font-semibold tabular-nums',
                                    Number(a.delta) < 0 ? 'text-rose-700' : 'text-emerald-700'
                                  )}
                                >
                                  {Number(a.delta) > 0 ? '+' : ''}
                                  {formatNum(a.delta)} {b.uom || 'MT'}
                                </span>
                                <span className="min-w-0 text-muted-foreground">{a.note || 'No reason given'}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {!extra.length && !adj.length && (
                          <div className="mt-1 text-[12px] text-muted-foreground">Nothing written against this bargain.</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {(() => {
              // Who carried it and at what rate — nothing else. The amounts live
              // on each tanker's own Transport panel further down.
              const carriers = poCarriers(detailRow)
              if (!carriers.length) return null
              return (
                <div className={cn('rounded-xl border', __WEB__ && '!overflow-hidden !rounded-[4px] !border-[#D6E2D6] !bg-white')}>
                  <div className={cn('flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2', __WEB__ && '!gap-2 !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-3.5 !py-2.5')}>
                    <Truck className={cn('h-3.5 w-3.5 text-slate-500', __WEB__ && '!h-[18px] !w-[18px] !text-[#33473E]')} />
                    <span className={cn('text-xs font-semibold text-slate-700', __WEB__ && '!text-[11px] !font-extrabold !uppercase !tracking-[.12em] !text-[#33473E]')}>Transporter</span>
                  </div>
                  <div className="divide-y">
                    {carriers.map((cr, i) => (
                      <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                        {carriers.length > 1 && (
                          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{cr.tanker || '—'}</span>
                        )}
                        <span className="min-w-0 truncate">{cr.name || 'Not set'}</span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {cr.rate > 0 ? (
                            <>
                              {formatINR(cr.rate)}
                              <span className="text-[11px] text-muted-foreground">/{detailRow.uom || 'MT'}</span>
                            </>
                          ) : (
                            <span className="text-[12px] font-semibold text-rose-700">Rate not set</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
            <div className={cn('grid grid-cols-3 gap-2', __WEB__ && '!grid-cols-2 !gap-2.5')}>
              <InfoTile icon={Building2} label="Supplier" value={detailRow.supplier_name || '—'} />
              <InfoTile icon={CalendarDays} label="Purchase date" value={formatDate(detailRow.order_date)} />
              <InfoTile icon={Truck} label="Tankers" value={detailRow.tanker_nos || '—'} />
              <InfoTile icon={Boxes} label="Total quantity" value={`${formatNum(detailRow.ordered_qty)} ${detailRow.uom}`} />
              {/* The bargain rate, not invoice_rate — this summary already
                  states it in the "Bargain & notes" note above, and the two
                  can genuinely differ (a supplier billing above bargain with
                  freight folded in). Showing invoice_rate under a "Bargain
                  rate" label would misstate it whenever they don't match. */}
              <InfoTile icon={IndianRupee} label="Bargain rate" value={`${formatINR(detailRow.bargain_rate)} / ${detailRow.uom}`} />
              {/* EX vs DLD decides who carries the shortage beyond tolerance —
                  the same flag the deductible column below is driven by, so
                  it's named here rather than left to be inferred from it. */}
              <InfoTile icon={FileText} label="Condition" value={invoiceCondition(detailRow)} />
              {/* The two numbers this invoice is actually looked up by outside
                  the system: the bargain it draws on, and the number in the
                  gate's own paper register. Both were only reachable by
                  scrolling to the tanker cards below, or not shown at all. */}
              {(() => {
                const mine = tankers.filter((t) => Number(t.order_id) === Number(detailRow.id))
                const bargains = [
                  ...new Set(
                    mine
                      .flatMap((t) => [String(t.bargain_no || ''), String(t.extra_bargain_no || '')])
                      .filter(Boolean)
                  )
                ]
                const manuals = [...new Set(mine.map((t) => String(t.gate_ref_no || '')).filter(Boolean))]
                // The note itself stays in the Bargains & notes card above,
                // which carries it in bold beside that bargain's date, quantity
                // and rate. Repeating it here said the same thing twice, three
                // lines apart.
                return (
                  <>
                    <InfoTile
                      icon={ScrollText}
                      label={bargains.length > 1 ? 'Bargains' : 'Bargain no'}
                      value={bargains.length ? bargains.join(' + ') : 'Not linked'}
                    />
                    <InfoTile
                      icon={ClipboardList}
                      label={manuals.length > 1 ? 'Manual gate nos' : 'Manual gate no'}
                      value={manuals.length ? manuals.join(', ') : '—'}
                    />
                  </>
                )
              })()}
            </div>
            <div
              className={cn(
                'flex items-center justify-between rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 px-4 py-3 text-white shadow-sm',
                __WEB__ && '!rounded-[4px] !bg-[#C7F03F] !bg-none !px-[18px] !py-4 !text-[#12280B] !shadow-none'
              )}
            >
              <span className={cn('flex items-center gap-1.5 text-sm font-medium text-indigo-50', __WEB__ && '!gap-2 !text-[12px] !font-extrabold !uppercase !tracking-[.1em] !text-[#2E4A0B]')}>
                <IndianRupee className={cn('h-4 w-4', __WEB__ && '!h-5 !w-5')} /> Net amount
              </span>
              <span className={cn('text-lg font-bold tabular-nums', __WEB__ && '!text-[24px] !font-bold !tracking-[-0.035em] !text-[#12280B]')}>{formatINR(detailRow.net_amount)}</span>
            </div>
            {detailRow.remarks && (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Remarks:</span> {detailRow.remarks}
              </p>
            )}
            {(() => {
              // Same "deductible" rule shown on the Pur BG tanker breakdown —
              // an EX bargain puts shortage beyond the allowed tolerance on
              // the supplier, so it's surfaced here too rather than only
              // being visible by going back to the bargain screen.
              const list = tankers.filter((t) => Number(t.order_id) === Number(detailRow.id))
              if (!list.length) return null
              // Whether ANY tanker on the invoice is EX decides whether the
              // Deductible columns appear at all; each row then uses its own
              // condition (see condIsEx) for its own figure.
              const isEx = list.some((t) => condIsEx(t))
              // adjusted_rate, not the raw invoice_rate field — it's the rate
              // that actually lands on the invoice per unit once interest and
              // any rate adjustment are folded in (see orders.ts: "the rate
              // actually charged"). The deductible itself is unaffected — it's
              // priced at bargainRate regardless, deliberately.
              const invoiceRate = Number(detailRow.adjusted_rate) || 0
              const rows = list.map((t) => tankerDeduct(t, detailRow))
              const anyPending = rows.some((r) => r.t.status !== 'empty')
              const tot = rows.reduce(
                (s, r) => ({
                  loaded: s.loaded + r.loaded,
                  rec: s.rec + (r.rec ?? 0),
                  shortage: s.shortage + (r.shortage ?? 0),
                  allowed: s.allowed + r.allowedAmt,
                  deductibleValue: s.deductibleValue + (r.deductibleValue ?? 0)
                }),
                { loaded: 0, rec: 0, shortage: 0, allowed: 0, deductibleValue: 0 }
              )
              const totDeductible = isEx && tot.shortage > tot.allowed ? tot.shortage - tot.allowed : null
              // The website draws one card per tanker instead of the wide
              // table: in a 660px drawer that table could only ever be a
              // horizontal scroll, and the figures that matter — shortage
              // against allowance — are a comparison, which reads better as a
              // bar than as two columns the eye has to hop between.
              if (__WEB__) {
                return (
                  <div className="min-w-0">
                    <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#7C9188]">
                      Tanker-wise shortage
                    </div>
                    <div className="flex flex-col gap-2.5">
                      {rows.map((r) => {
                        const ex = condIsEx(r.t)
                        // Two different questions, and they were being asked
                        // as one. `exceeds` is arithmetic — did the shortage
                        // pass the tolerance. `over` is money — does anyone
                        // owe for it, which only happens on an EX bargain.
                        // On DLD they diverge, and reading `deductible != null`
                        // as "within tolerance" made a DLD tanker that WAS
                        // over its allowance claim the opposite.
                        const exceeds = r.shortage != null && r.shortage > r.allowedAmt + 1e-9
                        const over = ex && exceeds
                        // Nothing weighed yet leaves the bar empty rather than
                        // full — an unmeasured tanker is not a perfect one.
                        const pct =
                          r.shortage == null ? 0 : r.allowedAmt > 0 ? Math.min(100, (r.shortage / r.allowedAmt) * 100) : r.shortage > 0 ? 100 : 0
                        return (
                          <div key={r.t.id as number} className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                            <div className="flex items-center justify-between gap-3 border-b border-[#EAF0E9] px-3.5 py-3">
                              <div className="min-w-0">
                                <div className="text-[15px] font-bold">{r.t.tanker_no}</div>
                                {r.t.transporter_name && (
                                  <div className="mt-0.5 text-[12px] font-medium text-[#7C9188]">{r.t.transporter_name}</div>
                                )}
                                {/* Gate, manual number and the bargain THIS tanker
                                    was drawn against, on one line. They are the
                                    three references someone reads together when
                                    they are chasing a vehicle, and stacking them
                                    made three lines of a card that only has
                                    four. It wraps rather than clipping when a
                                    split bargain makes the line too long. */}
                                {(!!r.t.gate_entry_no || !!r.t.bargain_no) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-bold leading-snug">
                                    {!!r.t.gate_entry_no && (
                                      <span className="flex items-center gap-1.5 text-[#0B6B45]">
                                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Gate {r.t.gate_entry_no}
                                      </span>
                                    )}
                                    {!!r.t.gate_ref_no && (
                                      <span className="font-semibold text-[#5A6B62]">· Manual {r.t.gate_ref_no}</span>
                                    )}
                                    {!!r.t.bargain_no && (
                                      <span className="font-semibold text-[#33473E]">
                                        {String(r.t.bargain_no)}
                                        {r.t.extra_bargain_no ? ` + ${String(r.t.extra_bargain_no)}` : ''}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <span
                                className={cn(
                                  'shrink-0 rounded-[2px] px-2.5 py-1 text-[11px] font-extrabold tracking-[.06em]',
                                  condIsEx(r.t) ? 'bg-[#FFEDD0] text-[#8A5300]' : 'bg-[#E3EEF5] text-[#255B7A]'
                                )}
                                title={
                                  String(r.t.condition ?? '').trim()
                                    ? 'Set on this tanker when it was sent to the supplier'
                                    : `From the bargain (${r.t.bargain_no || 'its bargain'}) — not overridden on this tanker`
                                }
                              >
                                {condIsEx(r.t) ? 'EX' : 'DLD'}
                              </span>
                            </div>
                            {(r.t.loaded_date || r.t.empty_date) && (
                              <div className="grid grid-cols-2 border-b border-[#EAF0E9]">
                                <div className="border-r border-[#EAF0E9] px-3.5 py-2.5">
                                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">Loaded</div>
                                  <div className="mt-1 text-[13.5px] font-semibold tabular-nums">{r.t.loaded_date ? formatDate(r.t.loaded_date) : '—'}</div>
                                </div>
                                <div className="px-3.5 py-2.5">
                                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">Received</div>
                                  <div className="mt-1 text-[13.5px] font-semibold tabular-nums">{r.t.empty_date ? formatDate(r.t.empty_date) : '—'}</div>
                                </div>
                              </div>
                            )}
                            <div className="grid grid-cols-4 border-b border-[#EAF0E9]">
                              {[
                                { k: `Loaded ${detailRow.uom || 'MT'}`, v: formatNum(r.loaded), tone: '' },
                                { k: 'Received', v: r.rec != null ? formatNum(r.rec) : '—', tone: '' },
                                { k: 'Shortage', v: r.shortage != null ? formatNum(r.shortage) : '—', tone: over ? 'text-[#B3261E]' : '' },
                                { k: 'Allowed', v: formatNum(r.allowedAmt), tone: 'text-[#5A6B62]' }
                              ].map((c, i) => (
                                <div key={c.k} className={cn('px-3 py-3', i < 3 && 'border-r border-[#EAF0E9]')}>
                                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">{c.k}</div>
                                  <div className={cn('mt-1 text-[15px] font-bold tabular-nums', c.tone)}>{c.v}</div>
                                </div>
                              ))}
                            </div>
                            <div className="border-b border-[#EAF0E9] px-3.5 py-3">
                              <div className="h-2 overflow-hidden rounded-[2px] bg-[#EAF0E9]">
                                <div
                                  className={cn('h-full', over ? 'bg-[#B3261E]' : ex ? 'bg-[#12855A]' : 'bg-[#8AA096]')}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              {/* The tolerance verdict is an EX story: on a DLD
                                  bargain the supplier delivers to our gate and
                                  shortage is never charged back, so quoting an
                                  allowance there implies a deduction that does
                                  not exist either way it lands. */}
                              <div
                                className={cn(
                                  'mt-2 flex items-center gap-1.5 rounded-[3px] border px-2.5 py-2 text-[12px] font-bold',
                                  r.shortage == null || !ex
                                    ? 'border-[#E4ECE3] bg-[#F7FAF6] text-[#5A6B62]'
                                    : over
                                      ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]'
                                      : 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                )}
                              >
                                {r.shortage == null ? (
                                  <><Clock className="h-4 w-4 shrink-0" /> Not weighed yet.</>
                                ) : !ex ? (
                                  <>
                                    <Truck className="h-4 w-4 shrink-0" />
                                    DLD — {formatNum(r.shortage)} {detailRow.uom || 'MT'} not charged to transporter
                                  </>
                                ) : over ? (
                                  <><AlertTriangle className="h-4 w-4 shrink-0" /> Shortage {formatNum(r.shortage)} {detailRow.uom || 'MT'} exceeds the {formatNum(r.allowedAmt)} {detailRow.uom || 'MT'} allowance</>
                                ) : (
                                  <><CheckCircle2 className="h-4 w-4 shrink-0" /> Within the {formatNum(r.allowedAmt)} {detailRow.uom || 'MT'} allowance</>
                                )}
                              </div>
                            </div>
                            <div className="grid grid-cols-2">
                              <div className="border-r border-[#EAF0E9] px-3.5 py-3">
                                <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">Bargain rate</div>
                                <div className="mt-1 text-[14px] font-bold tabular-nums">{formatINR(r.bargainRate)}</div>
                                {r.extraQty > 0 && (
                                  <div className="mt-1 text-[11.5px] font-medium text-[#7C9188]">
                                    {formatNum(r.primaryQty)} @ {formatINR(r.primaryRate)} + {formatNum(r.extraQty)} @ {formatINR(r.extraRate)}
                                  </div>
                                )}
                              </div>
                              <div className="px-3.5 py-3">
                                <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7C9188]">Invoice rate</div>
                                <div className="mt-1 text-[14px] font-bold tabular-nums">{formatINR(invoiceRate)}</div>
                              </div>
                            </div>
                            {r.deductible != null && (
                              <div className="flex items-center justify-between gap-3 border-t border-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-3">
                                <span className="flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]">
                                  <MinusCircle className="h-[18px] w-[18px]" />
                                  Deductible {formatNum(r.deductible)} {detailRow.uom || 'MT'}
                                </span>
                                <span className="text-[17px] font-bold tracking-[-0.02em] tabular-nums text-[#B3261E]">
                                  {r.deductibleValue != null ? formatINR(r.deductibleValue) : '—'}
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {isEx && totDeductible != null && rows.length > 1 && (
                      <div className="mt-2.5 flex items-start gap-2.5 rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-3 text-[12.5px] font-semibold leading-relaxed text-[#8C2F26]">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#B3261E]" />
                        <div>
                          <span className="font-extrabold">
                            {formatNum(totDeductible)} {detailRow.uom || 'MT'} deductible across this invoice — {formatINR(tot.deductibleValue)}
                          </span>{' '}
                          — shortage beyond the allowed tolerance, valued at each tanker&apos;s own bargain rate; deduct from what&apos;s owed to the supplier.
                        </div>
                      </div>
                    )}
                  </div>
                )
              }
              return (
                <div className="min-w-0">
                  <div className="min-w-0 overflow-hidden rounded-xl border">
                    <div className="flex items-center gap-1.5 border-b bg-slate-50 px-3 py-2">
                      <Truck className="h-4 w-4 text-slate-500" />
                      <span className="text-[13px] font-semibold text-slate-700">Tanker-wise shortage</span>
                    </div>
                    <div className="min-w-0 overflow-x-auto">
                      <table className="w-full whitespace-nowrap text-[13px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2">
                        <thead>
                          <tr className="border-b bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <th>Tanker</th>
                            <th>Loaded date</th>
                            <th>Received date</th>
                            <th className="text-right">Loaded</th>
                            <th className="text-right">Received</th>
                            <th className="text-right">Shortage</th>
                            <th className="text-right">Allowed MT</th>
                            <th>Cond.</th>
                            <th className="text-right">Bargain rate</th>
                            <th className="text-right">Invoice rate</th>
                            {isEx && <th className="text-right">Deductible</th>}
                            {isEx && <th className="text-right">Deductible ₹</th>}
                            {anyPending && <th>Stage</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr
                              key={r.t.id as number}
                              className={cn('border-b last:border-0', r.deductible != null ? 'bg-red-50/70' : 'hover:bg-muted/20')}
                            >
                              <td className="font-medium">
                                {r.t.tanker_no}
                                {r.t.transporter_name && (
                                  <div className="text-[11px] font-normal text-muted-foreground">{r.t.transporter_name}</div>
                                )}
                                {r.t.gate_entry_no && (
                                  <div className="text-[11px] font-normal text-muted-foreground">Gate {r.t.gate_entry_no}</div>
                                )}
                              </td>
                              <td className="text-slate-700">{r.t.loaded_date ? formatDate(r.t.loaded_date) : '—'}</td>
                              <td className="text-slate-700">{r.t.empty_date ? formatDate(r.t.empty_date) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{formatNum(r.loaded)}</td>
                              <td className="text-right tabular-nums text-foreground">{r.rec != null ? formatNum(r.rec) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{r.shortage != null ? formatNum(r.shortage) : '—'}</td>
                              <td className="text-right tabular-nums text-foreground">{formatNum(r.allowedAmt)}</td>
                              <td>
                                <span
                                  className={cn(
                                    'rounded px-2 py-0.5 text-[11px] font-semibold',
                                    condIsEx(r.t) ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'
                                  )}
                                  title={
                                    String(r.t.condition ?? '').trim()
                                      ? 'Set on this tanker when it was sent to the supplier'
                                      : `From the bargain (${r.t.bargain_no || 'its bargain'}) — not overridden on this tanker`
                                  }
                                >
                                  {condIsEx(r.t) ? 'EX' : 'DLD'}
                                </span>
                              </td>
                              <td className="text-right tabular-nums text-foreground">
                                {formatINR(r.bargainRate)}
                                {r.extraQty > 0 && (
                                  <div className="text-[11px] font-normal text-muted-foreground">
                                    {formatNum(r.primaryQty)} @ {formatINR(r.primaryRate)}
                                    {r.t.bargain_no ? ` (${r.t.bargain_no})` : ''} + {formatNum(r.extraQty)} @ {formatINR(r.extraRate)}
                                    {r.t.extra_bargain_no ? ` (${r.t.extra_bargain_no})` : ''}
                                  </div>
                                )}
                              </td>
                              <td className="text-right tabular-nums text-foreground">{formatINR(invoiceRate)}</td>
                              {isEx && (
                                <td className="text-right font-semibold tabular-nums text-red-600">
                                  {r.deductible != null ? formatNum(r.deductible) : ''}
                                </td>
                              )}
                              {isEx && (
                                <td className="text-right font-semibold tabular-nums text-red-600">
                                  {r.deductibleValue != null ? formatINR(r.deductibleValue) : ''}
                                </td>
                              )}
                              {anyPending && (
                                <td><StatusBadge status={String(r.t.status || '')} /></td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                        {rows.length > 1 && (
                          <tfoot>
                            <tr className="border-t-2 border-amber-400 bg-amber-50 font-semibold text-amber-900">
                              <td colSpan={3}>Total</td>
                              <td className="text-right tabular-nums">{formatNum(tot.loaded)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.rec)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.shortage)}</td>
                              <td className="text-right tabular-nums">{formatNum(tot.allowed)}</td>
                              <td />
                              <td />
                              <td />
                              {isEx && (
                                <td className="text-right tabular-nums text-red-600">
                                  {totDeductible != null ? formatNum(totDeductible) : ''}
                                </td>
                              )}
                              {isEx && (
                                <td className="text-right tabular-nums text-red-600">
                                  {totDeductible != null ? formatINR(tot.deductibleValue) : ''}
                                </td>
                              )}
                              {anyPending && <td />}
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                  {isEx && totDeductible != null && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <span className="font-semibold">
                          {formatNum(totDeductible)} {detailRow.uom || 'MT'} deductible — {formatINR(tot.deductibleValue)}
                        </span>{' '}
                        — shortage beyond the allowed tolerance, valued at each tanker&apos;s own bargain rate; deduct
                        from what&apos;s owed to the supplier.
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}
            </DrawerSection>
            {/* Mounted only while open, so the gate register and the audit
                trail are fetched the first time each is asked for rather than
                on every panel that is opened. */}
            <DrawerSection icon={DoorOpen} title="Gate entries">
              <GateEntriesDialog open inline query={{ orderId: Number(detailRow.id) || 0 }} />
            </DrawerSection>
            <DrawerSection icon={History} title="History">
              <HistoryDialog
                inline
                target={{
                  entity: 'Purchase',
                  id: Number(detailRow.id),
                  title: String(detailRow.invoice_no || 'this purchase')
                }}
              />
            </DrawerSection>
          </div>}
          {/* Pinned footer. Edit is the only thing left here — Gate entries and
              History used to sit beside it and CLOSED this panel to open a
              dialog of their own, so reading the trail cost you the invoice you
              were reading it about. They are sections above now. */}
          {__WEB__ && detailRow && (
            <div className="flex gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
              <button
                type="button"
                onClick={() => setDetailRow(null)}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[4px] border-[1.5px] border-[#C3D2C6] text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#EAF0E9]"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => { const r = detailRow; setDetailRow(null); openEditPurchase(r) }}
                className="flex h-11 flex-[1.4] items-center justify-center gap-2 rounded-[4px] bg-[#0B3D2E] text-[13px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] transition-colors hover:bg-[#0F4A38]"
              >
                <Pencil className="h-[18px] w-[18px]" /> Edit this purchase
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-muted-foreground" /> Tankers by product</DialogTitle>
          </DialogHeader>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Loaded from</Label>
              <DatePicker value={repFrom} onChange={setRepFrom} max={repTo || undefined} className="w-40" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">To</Label>
              <DatePicker value={repTo} onChange={setRepTo} min={repFrom || undefined} className="w-40" />
            </div>
            {(repFrom || repTo) && (
              <Button variant="ghost" size="sm" onClick={() => { setRepFrom(''); setRepTo('') }}>Clear</Button>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Tankers</TableHead>
                  <TableHead className="text-right">Loaded qty</TableHead>
                  <TableHead className="text-right">Received qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tankerReport.rows.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No tankers in this range.</TableCell></TableRow>
                ) : (
                  <>
                    {tankerReport.rows.map((r) => (
                      <TableRow key={r.oil}>
                        <TableCell className="font-medium">{r.oil}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(r.loaded)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(r.received)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 border-amber-500 bg-amber-100 hover:bg-amber-100">
                      <TableCell className="font-bold uppercase tracking-wide text-amber-900">Grand total</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{tankerReport.grand.count}</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tankerReport.grand.loaded)}</TableCell>
                      <TableCell className="text-right font-bold tabular-nums text-amber-900">{formatNum(tankerReport.grand.received)}</TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Counts every tanker (any stage) for the active company; filter by loaded date. Loaded = dispatched quantity, Received = weighed-in at gate.</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
