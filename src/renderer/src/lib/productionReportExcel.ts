// The Complete Production Report, as a workbook.
// -----------------------------------------------------------------------------
// The sheet the mill keeps by hand: products across the top in their category
// bands, one row per batch down the side, and in the body what each batch
// consumed of every material. Beside each batch what it made, and the recipe
// ratio it was made on — 85:15 — carried as a real Excel COMMENT on the ratio
// cell rather than as a column of its own, which is how column G of the hand
// sheet works.
//
// Download-only, deliberately. A 36-column grid is a spreadsheet's job, not a
// web page's: the reader wants to freeze panes, sort it, and set it beside
// last month's, and every one of those is something Excel already does better
// than any table this app could draw.
import { exportRowsToExcel, NUM_QTY, type ExcelColumn } from '@/lib/excel'
import { formatNum } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Cell = { consumed: number; produced: number; loss: number }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The band tints, in Excel's ARGB — raw yellow and intermediate blue are the
// hand sheet's own colours. A merged RAW / INTERMEDIATE banner cannot be
// expressed through the generic exporter, so the header colour carries it.
const BAND_FILL: Record<string, string> = {
  raw: 'FFFBEF7A',
  intermediate: 'FF6E97C9',
  finished: 'FF0B3D2E',
  'by-product': 'FFC9A66E',
  waste: 'FFB9836E'
}
const BAND_INK: Record<string, string> = {
  raw: 'FF5A4C00',
  intermediate: 'FFFFFFFF',
  finished: 'FFFFFFFF',
  'by-product': 'FF3D2C00',
  waste: 'FFFFFFFF'
}
const BAND_ORDER = ['raw', 'intermediate', 'finished', 'by-product', 'waste']

const ddmmyyyy = (iso: string): string => {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-')
  return y ? `${d}-${m}-${y}` : ''
}

// "80 is SHEA / 15 is RPS / 5 is FATTY OIL" — column G of the hand sheet,
// which is what the ratio's comment has to say. The percentages follow because
// a three-part ratio of 48:2:50 is not obviously a half-and-half blend, and
// the recipe version follows that because two batches a month apart can
// honestly carry different ratios.
function ratioNote(b: Row): string {
  const parts = (b.ratio_parts || []) as Row[]
  if (!parts.length) return ''
  const head = parts.map((x) => `${formatNum(n(x.part))} is ${String(x.name)}`).join('\n')
  const pct = parts.map((x) => `${String(x.name)} ${n(x.pct)}%`).join(' · ')
  const ver = n(b.recipe_version)
    ? `\n\nRecipe ${String(b.recipe_name || '')} v${n(b.recipe_version)}${
        n(b.recipe_latest_version) > n(b.recipe_version)
          ? ` — superseded, latest is v${n(b.recipe_latest_version)}`
          : ''
      }`
    : ''
  return `${head}\n\n${pct}${ver}`
}

// Returns how many batch rows were written, so the caller can say so — or 0
// when there was no production, which is not an error and should not be
// reported as one.
export async function downloadProductionReport(
  range: { from: string; to: string } | undefined,
  companyIds: number[],
  stamp: string
): Promise<number> {
  const data = await window.api.production.report(range, companyIds)
  const batches = data.batches || []
  if (!batches.length) return 0

  // Only the products this period actually moved. The full catalogue is 36
  // columns and most of it empty in any one month, and an empty column in a
  // spreadsheet is a column somebody has to scroll past.
  const used = new Set<string>()
  for (const b of batches) {
    for (const [k, v] of Object.entries((b.cells || {}) as Record<string, Cell>)) {
      if (n(v.consumed) || n(v.produced)) used.add(k)
    }
  }
  const columns = (data.products || [])
    .filter((p) => used.has(String(p.id)))
    .sort(
      (a, b) =>
        (BAND_ORDER.indexOf(String(a.category)) + 1 || 99) - (BAND_ORDER.indexOf(String(b.category)) + 1 || 99) ||
        String(a.name).localeCompare(String(b.name))
    )

  const ranged = !!(range?.from || range?.to)
  const cols: ExcelColumn[] = [
    { header: 'Date', key: 'date', width: 12, value: (r) => ddmmyyyy(String(r.date)) },
    { header: 'Made', key: 'qty', width: 11, align: 'right', numFmt: NUM_QTY, total: 'sum', value: (r) => n(r.qty) },
    { header: 'Product', key: 'product_name', width: 24, value: (r) => String(r.product_name || '') },
    {
      header: 'Ratio',
      key: 'ratio',
      width: 12,
      divider: true,
      value: (r) => String(r.ratio || ''),
      note: (r) => ratioNote(r)
    },
    {
      header: 'Total consumed',
      key: 'total_consumed',
      width: 15,
      align: 'right',
      numFmt: NUM_QTY,
      total: 'sum',
      value: (r) => n(r.total_consumed)
    },
    {
      header: 'Recipe',
      key: 'recipe',
      width: 22,
      divider: true,
      value: (r) =>
        n(r.recipe_version) ? `${String(r.recipe_name || '')} v${n(r.recipe_version)}` : String(r.recipe_name || '')
    },
    ...columns.map(
      (c, i): ExcelColumn => ({
        header: `${String(c.name)}${String(c.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`,
        key: `p${c.id}`,
        width: 13,
        align: 'right',
        numFmt: NUM_QTY,
        total: 'sum',
        // A heavier rule where one band ends and the next begins.
        divider: i > 0 && String(columns[i - 1].category) !== String(c.category),
        headerFill: BAND_FILL[String(c.category)] || 'FF475569',
        headerTextColor: BAND_INK[String(c.category)] || 'FFFFFFFF',
        value: (r) => {
          const v = ((r.cells || {}) as Record<string, Cell>)[String(c.id)]
          if (!v) return 0
          // One column per product cannot hold two figures, so the SIGN
          // separates them: made positive, consumed negative. Which also makes
          // the column total the product's net movement for the period.
          return n(v.produced) ? n(v.produced) : -n(v.consumed)
        }
      })
    )
  ]

  const made = batches.reduce((a, b) => a + n(b.qty), 0)
  const eaten = batches.reduce((a, b) => a + n(b.total_consumed), 0)
  const real = batches.filter((b) => String(b.kind) !== 'recirculation').length
  const period = ranged
    ? `${ddmmyyyy(String(range?.from || ''))} to ${ddmmyyyy(String(range?.to || ''))}`
    : 'all production on the books'

  await exportRowsToExcel({
    filename: `production-report-${range?.from || 'start'}-to-${range?.to || 'date'}-${stamp}`,
    sheetName: 'Production report',
    title: 'Complete production report',
    subtitle:
      `${real} batch${real === 1 ? '' : 'es'} · ${formatNum(made)} MT made from ${formatNum(eaten)} MT consumed · ` +
      `${period} · a positive figure was MADE and a negative one CONSUMED · ` +
      'the ratio cell carries its recipe as a comment',
    // Date, Made, Product, Ratio, Total consumed — the block that says WHICH
    // batch a row is, kept on screen while the reader scrolls right through
    // thirty product columns.
    freezeCols: 5,
    totalLabel: 'TOTAL',
    columns: cols,
    rows: batches
  })
  return batches.length
}
