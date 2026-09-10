// The Complete Production Report.
// -----------------------------------------------------------------------------
// The sheet the mill already keeps by hand, rebuilt off the books: products
// across the top in their category bands, the days of the month down the side,
// and in the body what each batch CONSUMED of every material. Beside each
// batch, what it made and the recipe ratio it was made on — 85:15 — with the
// parts named behind the cell, because a bare ratio never says WHICH 85.
//
// Every day in the range gets a row whether the plant ran or not. That is the
// point of a month sheet: a blank Tuesday is a fact about the month, and a
// register that silently skips it cannot be checked against a diary.
//
// A day the plant ran several batches gets one row per batch, with the date
// printed once. Which is how the hand sheet does it — three lines under
// 01-09-2026 — and it is what keeps a batch's consumption on the same line as
// the ratio that produced it.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Info, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { exportRowsToExcel, NUM_QTY, type ExcelColumn } from '@/lib/excel'
import { formatNum } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Cell = { consumed: number; produced: number; loss: number }
type Report = { from: string; to: string; products: Row[]; batches: Row[] }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The bands, in the order the hand sheet runs them, each with the tint it uses
// there: raw yellow, intermediate blue. The rest follow the app's own palette
// rather than inventing more colours.
const BANDS: { key: string; label: string; head: string; cell: string }[] = [
  { key: 'raw', label: 'RAW', head: 'bg-[#FBEF7A] text-[#5A4C00]', cell: 'bg-[#FEFCE9]' },
  { key: 'intermediate', label: 'INTERMEDIATE', head: 'bg-[#6E97C9] text-white', cell: 'bg-[#F2F7FC]' },
  { key: 'finished', label: 'FINISHED', head: 'bg-[#0B3D2E] text-white', cell: 'bg-[#F6FAF6]' },
  { key: 'by-product', label: 'BY-PRODUCT', head: 'bg-[#C9A66E] text-[#3D2C00]', cell: 'bg-[#FDF9F1]' },
  { key: 'waste', label: 'WASTE', head: 'bg-[#B9836E] text-white', cell: 'bg-[#FCF5F2]' }
]
const bandOf = (cat: string): (typeof BANDS)[number] =>
  BANDS.find((b) => b.key === cat) || { key: cat, label: cat.toUpperCase(), head: 'bg-slate-600 text-white', cell: 'bg-slate-50' }

// First and last day of the month a date falls in — the report's natural
// period, and what the hand sheet is.
function monthOf(iso: string): { from: string; to: string } {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date()
  const y = d.getFullYear()
  const m = d.getMonth()
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return {
    from: `${y}-${p2(m + 1)}-01`,
    to: `${y}-${p2(m + 1)}-${p2(new Date(y, m + 1, 0).getDate())}`
  }
}

// Every day from..to inclusive. Bounded so a range typed by hand as ten years
// cannot try to draw four thousand rows.
function daysBetween(from: string, to: string): string[] {
  if (!from || !to || to < from) return []
  const out: string[] = []
  const end = new Date(`${to}T00:00:00`)
  for (let d = new Date(`${from}T00:00:00`); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

const ddmmyyyy = (iso: string): string => {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-')
  return y ? `${d}-${m}-${y}` : ''
}

// A quantity as the sheet prints it: blank at zero, three decimals otherwise.
// A wall of 0.000 is what makes a 36-column grid unreadable.
const q = (v: number): string => (Math.abs(v) < 0.0005 ? '' : formatNum(Math.round(v * 1000) / 1000))

// "80 is SHEA, 15 is RPS, 5 is FATTY OIL" — column G of the hand sheet, which
// is what the ratio's comment has to say.
function ratioNote(b: Row): string {
  const parts = (b.ratio_parts || []) as Row[]
  if (!parts.length) return ''
  const head = parts.map((x) => `${formatNum(n(x.part))} is ${String(x.name)}`).join('\n')
  const pct = parts.map((x) => `${String(x.name)} ${n(x.pct)}%`).join(' · ')
  const ver = n(b.recipe_version)
    ? `\n\nRecipe ${String(b.recipe_name || '')} v${n(b.recipe_version)}${
        n(b.recipe_latest_version) > n(b.recipe_version) ? ` (superseded — latest is v${n(b.recipe_latest_version)})` : ''
      }`
    : ''
  return `${head}\n\n${pct}${ver}`
}

export function ProductionReport({
  companyIds = [],
  companyPicker
}: {
  companyIds?: number[]
  companyPicker?: React.ReactNode
}): React.JSX.Element {
  const [range, setRange] = useState(() => monthOf(''))
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [dlBusy, setDlBusy] = useState(false)
  // 36 columns is most of the catalogue and most of it empty in any one month.
  // On by default: the reader wants the month's own materials, and the full
  // catalogue is one click away when the sheet has to line up with last
  // month's.
  const [onlyUsed, setOnlyUsed] = useState(true)

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true)
      try {
        setData(await window.api.production.report(range, companyIds))
      } catch (e) {
        toast.error((e as Error).message)
        setData(null)
      } finally {
        setLoading(false)
      }
    },
    [range, companyIds]
  )

  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const batches = data?.batches || []

  // Which columns carry anything at all this period — a movement in the body,
  // or an opening the band above it needs to show.
  const used = useMemo(() => {
    const s = new Set<string>()
    for (const b of batches) {
      for (const [k, v] of Object.entries((b.cells || {}) as Record<string, Cell>)) {
        if (n(v.consumed) || n(v.produced)) s.add(k)
      }
    }
    return s
  }, [batches])

  const columns = useMemo(() => {
    const all = (data?.products || []).filter((p) => !onlyUsed || used.has(String(p.id)))
    const order = BANDS.map((b) => b.key)
    return [...all].sort(
      (a, b) =>
        (order.indexOf(String(a.category)) + 1 || 99) - (order.indexOf(String(b.category)) + 1 || 99) ||
        String(a.name).localeCompare(String(b.name))
    )
  }, [data, onlyUsed, used])

  // The band header: one merged cell per category, spanning its columns.
  const spans = useMemo(() => {
    const out: { band: (typeof BANDS)[number]; span: number }[] = []
    for (const c of columns) {
      const band = bandOf(String(c.category))
      const last = out[out.length - 1]
      if (last && last.band.key === band.key) last.span++
      else out.push({ band, span: 1 })
    }
    return out
  }, [columns])

  // One row per day, and within a day one per batch. A day with no batch still
  // gets its row.
  const lines = useMemo(() => {
    const byDay = new Map<string, Row[]>()
    for (const b of batches) {
      const k = String(b.date)
      const l = byDay.get(k)
      if (l) l.push(b)
      else byDay.set(k, [b])
    }
    const out: { date: string; batch: Row | null; first: boolean; count: number }[] = []
    for (const d of daysBetween(range.from, range.to)) {
      const list = byDay.get(d) || []
      if (!list.length) out.push({ date: d, batch: null, first: true, count: 0 })
      else list.forEach((b, i) => out.push({ date: d, batch: b, first: i === 0, count: list.length }))
    }
    return out
  }, [batches, range])

  // Column footers: what the period consumed and made of each product, off the
  // batches themselves rather than off stockLevels — this is the production
  // report, so its totals must be the sum of the rows above them or the sheet
  // cannot be checked by adding it up.
  const foot = useMemo(() => {
    const m: Record<string, Cell> = {}
    for (const b of batches) {
      for (const [k, v] of Object.entries((b.cells || {}) as Record<string, Cell>)) {
        if (!m[k]) m[k] = { consumed: 0, produced: 0, loss: 0 }
        m[k].consumed += n(v.consumed)
        m[k].produced += n(v.produced)
        m[k].loss += n(v.loss)
      }
    }
    return m
  }, [batches])

  const totalMade = batches.reduce((a, b) => a + n(b.qty), 0)
  const totalConsumed = batches.reduce((a, b) => a + n(b.total_consumed), 0)
  const ranBatches = batches.filter((b) => String(b.kind) !== 'recirculation').length

  async function download(): Promise<void> {
    if (!batches.length) {
      toast.error('No production in this period')
      return
    }
    setDlBusy(true)
    try {
      const cols: ExcelColumn[] = [
        { header: 'Date', key: 'date', width: 12, value: (r) => ddmmyyyy(String(r.date)) },
        { header: 'Made', key: 'qty', width: 11, align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => n(r.qty) },
        { header: 'Product', key: 'product_name', width: 22, value: (r) => String(r.product_name || '') },
        {
          header: 'Ratio',
          key: 'ratio',
          width: 12,
          divider: true,
          value: (r) => String(r.ratio || ''),
          // Column G of the hand sheet, as a real Excel comment rather than a
          // column of its own — which is what was asked for, and it keeps the
          // sheet the same width as theirs.
          note: (r) => ratioNote(r)
        },
        { header: 'Total consumed', key: 'total_consumed', width: 15, align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => n(r.total_consumed) },
        { header: 'Recipe', key: 'recipe', width: 20, divider: true, value: (r) => (n(r.recipe_version) ? `${String(r.recipe_name || '')} v${n(r.recipe_version)}` : String(r.recipe_name || '')) },
        ...columns.map(
          (c, i): ExcelColumn => ({
            header: `${String(c.name)}${String(c.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`,
            key: `p${c.id}`,
            width: 13,
            align: 'right',
            numFmt: NUM_QTY,
            total: 'sum',
            // A heavier rule where one band ends and the next begins, and the
            // band's own tint on the header — the merged RAW / INTERMEDIATE
            // banner cannot be expressed through this exporter, so the colour
            // carries it.
            divider: i > 0 && String(columns[i - 1].category) !== String(c.category),
            headerFill: EXCEL_BAND[String(c.category)] || 'FF475569',
            headerTextColor: EXCEL_BAND_INK[String(c.category)] || 'FFFFFFFF',
            value: (r) => {
              const v = ((r.cells || {}) as Record<string, Cell>)[String(c.id)]
              if (!v) return 0
              // Made shows positive, consumed negative — on one line per
              // batch there is no room for two columns per product, and the
              // sign is how the hand sheet's reader tells them apart.
              return n(v.produced) ? n(v.produced) : -n(v.consumed)
            }
          })
        )
      ]
      await exportRowsToExcel({
        filename: `production-report-${range.from}-to-${range.to}`,
        sheetName: 'Production report',
        title: 'Complete production report',
        subtitle:
          `${ranBatches} batch${ranBatches === 1 ? '' : 'es'} · ${formatNum(totalMade)} MT made from ` +
          `${formatNum(totalConsumed)} MT consumed · ${ddmmyyyy(range.from)} to ${ddmmyyyy(range.to)} · ` +
          'a positive figure was MADE, a negative one CONSUMED · the ratio cell carries the recipe as a comment',
        freezeCols: 5,
        totalLabel: 'TOTAL',
        columns: cols,
        rows: batches
      })
      toast.success(`Exported ${batches.length} production row${batches.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDlBusy(false)
    }
  }

  const LEFT = 5 // sticky left-block columns, for the colSpan arithmetic below

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 px-3 py-2',
          __WEB__ && '!gap-[9px] !rounded-[4px] !border-[#DCE7DB] !bg-[#F4F8F3] !px-[13px] !py-[11px]'
        )}
      >
        {companyPicker}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">From</span>
          <div className="w-36"><DatePicker value={range.from} onChange={(v) => setRange((p) => ({ ...p, from: v }))} max={range.to || undefined} /></div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">To</span>
          <div className="w-36"><DatePicker value={range.to} onChange={(v) => setRange((p) => ({ ...p, to: v }))} min={range.from || undefined} /></div>
        </div>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setRange(monthOf(''))}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          This month
        </Button>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-white px-3 text-[12.5px] font-semibold">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
          Only products used
          <span className="text-[11px] font-medium text-muted-foreground">
            {columns.length}/{(data?.products || []).length}
          </span>
        </label>
        <Button size="sm" className="ml-auto h-9" disabled={dlBusy || !batches.length} onClick={() => void download()}>
          {dlBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
          Download
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-[12px] text-muted-foreground">
        <span>
          <b className="text-foreground">{ranBatches}</b> batch{ranBatches === 1 ? '' : 'es'}
        </span>
        <span>
          made <b className="text-foreground">{formatNum(totalMade)}</b> MT
        </span>
        <span>
          from <b className="text-foreground">{formatNum(totalConsumed)}</b> MT consumed
        </span>
        <span className="text-[11px]">
          Consumed is plain; <span className="font-bold text-[#0B6B45]">+made</span> is green. The ratio carries the recipe — hover it.
        </span>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 rounded-lg border px-4 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Building the report…
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border" style={{ maxHeight: '72vh' }}>
          <table className="w-max border-collapse text-[12px]">
            <thead className="sticky top-0 z-20">
              {/* The category banner — RAW, INTERMEDIATE — merged over its own
                  columns, which is the first thing the eye needs on a grid
                  this wide. */}
              <tr>
                <th colSpan={LEFT} className="sticky left-0 z-30 border-b border-r bg-[#0B3D2E] px-2 py-1 text-left text-[11px] font-extrabold uppercase tracking-wide text-white">
                  Production
                </th>
                {spans.map((s, i) => (
                  <th key={`${s.band.key}-${i}`} colSpan={s.span} className={cn('border-b border-r px-2 py-1 text-center text-[10.5px] font-extrabold uppercase tracking-wide', s.band.head)}>
                    {s.band.label}
                  </th>
                ))}
                {!columns.length && <th className="border-b px-3 py-1 text-left text-[11px] font-semibold text-muted-foreground">No product columns</th>}
              </tr>
              <tr className="bg-white">
                {['Date', 'Made', 'Product', 'Ratio', 'Consumed'].map((h, i) => (
                  <th
                    key={h}
                    className={cn(
                      'sticky z-30 whitespace-nowrap border-b border-r bg-[#EAF0E9] px-2 py-1.5 text-left text-[10.5px] font-extrabold uppercase tracking-wide text-[#33473E]',
                      i === 0 && 'left-0',
                      (h === 'Made' || h === 'Consumed') && 'text-right'
                    )}
                    style={i === 0 ? undefined : { left: undefined }}
                  >
                    {h}
                  </th>
                ))}
                {columns.map((c) => (
                  <th
                    key={c.id}
                    title={`${String(c.name)} · ${String(c.category)} · counted in ${String(c.uom || 'MT')}${c.in_stock ? '' : ' · no stock balance carried'}`}
                    className={cn('max-w-[86px] border-b border-r px-1.5 py-1.5 text-right align-bottom text-[10.5px] font-bold leading-tight', bandOf(String(c.category)).cell)}
                  >
                    <span className="block truncate">{String(c.name)}</span>
                    {String(c.uom || 'MT') === 'PCS' && <span className="block text-[9px] font-semibold text-muted-foreground">PCS</span>}
                  </th>
                ))}
              </tr>
              {/* op. / receiving / total — the band the hand sheet carries above
                  the days, so the reader can see what there WAS to consume. */}
              {(
                [
                  ['op.', (c: Row) => n(c.opening)],
                  ['receiving', (c: Row) => n(c.received)],
                  ['total', (c: Row) => n(c.opening) + n(c.received)]
                ] as const
              ).map(([label, pick], ri) => (
                <tr key={label} className="bg-[#FBFDFA]">
                  <th colSpan={LEFT} className={cn('sticky left-0 z-30 whitespace-nowrap border-r bg-[#FBFDFA] px-2 py-1 text-left text-[11px] font-bold text-[#33473E]', ri === 2 && 'border-b-2 border-b-[#C3D2C6]')}>
                    {label}
                  </th>
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        'doc-ref whitespace-nowrap border-r px-1.5 py-1 text-right text-[11.5px] font-semibold tabular-nums',
                        ri === 2 ? 'border-b-2 border-b-[#C3D2C6] font-bold text-[#0A1F17]' : 'text-[#33473E]',
                        bandOf(String(c.category)).cell
                      )}
                    >
                      {/* A product the register carries no balance for — DEAD
                          LOSS — gets a dash, not a zero it never had. */}
                      {c.in_stock ? q(pick(c)) : <span className="text-muted-foreground/60">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {lines.map((ln, i) => {
                const b = ln.batch
                const cells = (b?.cells || {}) as Record<string, Cell>
                const recirc = b && String(b.kind) === 'recirculation'
                return (
                  <tr key={`${ln.date}-${b?.id ?? 'x'}`} className={cn(i % 2 === 1 && 'bg-muted/20', !b && 'text-muted-foreground/70')}>
                    <td className={cn('sticky left-0 z-10 whitespace-nowrap border-r border-t bg-white px-2 py-1 font-semibold tabular-nums', i % 2 === 1 && '!bg-[#F7F9F6]')}>
                      {/* Printed once per day, as on the hand sheet. */}
                      {ln.first ? ddmmyyyy(ln.date) : ''}
                    </td>
                    <td className="doc-ref whitespace-nowrap border-r border-t px-2 py-1 text-right font-bold tabular-nums">
                      {b ? q(n(b.qty)) : ''}
                    </td>
                    <td className="max-w-[200px] truncate border-r border-t px-2 py-1 font-semibold">
                      {b ? String(b.product_name) : ''}
                      {recirc && <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9.5px] font-bold uppercase text-amber-800">recirc</span>}
                      {b?.from_sale && <span className="ml-1.5 rounded bg-slate-200 px-1 py-0.5 text-[9.5px] font-bold uppercase text-slate-700">sale</span>}
                    </td>
                    <td className="whitespace-nowrap border-r border-t px-2 py-1">
                      {b && b.ratio ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-help items-center gap-1 font-bold text-[#0A1F17] underline decoration-dotted decoration-from-font underline-offset-2">
                              {String(b.ratio)}
                              <Info className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs whitespace-pre-line text-left text-[11.5px] leading-relaxed">
                            {ratioNote(b)}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="doc-ref whitespace-nowrap border-r border-t px-2 py-1 text-right tabular-nums">
                      {b ? q(n(b.total_consumed)) : ''}
                    </td>
                    {columns.map((c) => {
                      const v = cells[String(c.id)]
                      const made = n(v?.produced)
                      const eaten = n(v?.consumed)
                      const isLoss = n(v?.loss) > 0 && Math.abs(n(v?.loss) - eaten) < 0.0005
                      return (
                        <td
                          key={c.id}
                          className={cn(
                            'doc-ref whitespace-nowrap border-r border-t px-1.5 py-1 text-right text-[11.5px] tabular-nums',
                            made ? 'bg-[#F0FAF3] font-bold text-[#0B6B45]' : isLoss ? 'text-[#8C2F26]' : 'text-[#1F2937]'
                          )}
                          title={
                            made || eaten
                              ? `${String(c.name)} — ${made ? `made ${formatNum(made)}` : `${isLoss ? 'dead loss' : 'consumed'} ${formatNum(eaten)}`} ${String(c.uom || 'MT')}`
                              : undefined
                          }
                        >
                          {made ? `+${q(made)}` : q(eaten)}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {!lines.length && (
                <tr>
                  <td colSpan={LEFT + columns.length} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Pick a period to report on.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="sticky bottom-0 z-20">
              {(
                [
                  ['consumed', (v: Cell) => n(v.consumed)],
                  ['produced', (v: Cell) => n(v.produced)]
                ] as const
              ).map(([label, pick]) => (
                <tr key={label} className="bg-[#EAF0E9]">
                  <th colSpan={LEFT} className="sticky left-0 z-30 whitespace-nowrap border-r border-t-2 border-t-[#C3D2C6] bg-[#EAF0E9] px-2 py-1 text-left text-[11px] font-extrabold uppercase text-[#33473E]">
                    {label} this period
                  </th>
                  {columns.map((c) => {
                    const v = foot[String(c.id)]
                    return (
                      <td key={c.id} className="doc-ref whitespace-nowrap border-r border-t-2 border-t-[#C3D2C6] px-1.5 py-1 text-right text-[11.5px] font-bold tabular-nums text-[#0A1F17]">
                        {v ? q(pick(v)) : ''}
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr className="bg-[#0B3D2E] text-white">
                <th colSpan={LEFT} className="sticky left-0 z-30 whitespace-nowrap border-r border-[#1B5C46] bg-[#0B3D2E] px-2 py-1.5 text-left text-[11px] font-extrabold uppercase">
                  closing
                </th>
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={cn(
                      'doc-ref whitespace-nowrap border-r border-[#1B5C46] px-1.5 py-1.5 text-right text-[11.5px] font-bold tabular-nums',
                      n(c.closing) < -0.0005 ? 'text-[#FFB4AB]' : 'text-[#C7F03F]'
                    )}
                  >
                    {c.in_stock ? q(n(c.closing)) : <span className="text-white/40">—</span>}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// The band tints again, in Excel's ARGB — the header of each product column is
// coloured by its band, since a merged banner row cannot be expressed through
// the generic exporter.
const EXCEL_BAND: Record<string, string> = {
  raw: 'FFFBEF7A',
  intermediate: 'FF6E97C9',
  finished: 'FF0B3D2E',
  'by-product': 'FFC9A66E',
  waste: 'FFB9836E'
}
const EXCEL_BAND_INK: Record<string, string> = {
  raw: 'FF5A4C00',
  intermediate: 'FFFFFFFF',
  finished: 'FFFFFFFF',
  'by-product': 'FF3D2C00',
  waste: 'FFFFFFFF'
}
