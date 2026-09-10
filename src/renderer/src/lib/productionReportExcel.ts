// The Complete Production Report, in the mill's own layout.
// -----------------------------------------------------------------------------
// Written cell by cell rather than through exportRowsToExcel, because this is
// not a table. It is the hand sheet:
//
//   1    COMPLETE PRODUCTION REPORT                       <- title band
//   2    period · batches · made · consumed               <- subtitle
//   3    (spacer)
//   4    PRODUCTION | RAW ......... | INTERMEDIATE .... | FINISHED ....
//   5    Date Qty Product Ratio Total | one column per product
//   6    Opening Stock      what was in the tanks when the period opened
//   7    Receipts           what came in during it
//   8    Total before Pn.   what there was to draw on
//   9    (spacer)
//   10+  the days that RAN, a line per batch, the date printed once
//   ..   PRODUCTION TOTAL — what was made, and what each column consumed
//
// The generic exporter draws a header and then rows. It has no way to say
// "these eleven columns are RAW", and no way to put three summary rows between
// the header and the body — which is the part of this sheet that makes it
// readable, because it is what the consumption below is checked against.
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { downloadWorkbook } from '@/lib/excel'
import { formatNum } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Cell = { consumed: number; produced: number; loss: number }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Three decimals where they exist and NOTHING at zero — the hand sheet leaves
// an untouched cell empty, and on a thirty-column grid that blankness is what
// lets the eye find the figures. A general format of 0.000 fills the sheet
// with noughts and hides them.
//
// TWO formats, chosen per cell, because Excel prints the decimal separator for
// an optional-digit placeholder even when no digit follows it: `#,##0.###` puts
// "2." on screen for the value 2. There is no number format that can say "a
// point only if something comes after it" — the test has to be made where the
// value is known, which is here.
const QTY_DEC = '#,##0.###;-#,##0.###;'
const QTY_INT = '#,##0;-#,##0;'
const isWhole = (v: number): boolean => Math.abs(v - Math.round(v)) < 0.0005
const qtyFmt = (v: number): string => (isWhole(v) ? QTY_INT : QTY_DEC)

// Value and format together, so no call site can set one and forget the other.
function putQty(cell: ExcelJS.Cell, v: number): void {
  cell.value = v
  cell.numFmt = qtyFmt(v)
}

// One typeface for the whole sheet. Left to Excel's own default a file picks
// up whatever the reader's template says, and a report that renders in Aptos
// on one desk and Calibri on the next is not a formatted document.
const FONT = 'Calibri'

const FOREST = 'FF0B3D2E'
const LIME = 'FFC7F03F'
const INK = 'FF1F2937'
const MUTED = 'FF7C8A82'
const GRID = 'FFDCE7DB'
const RULE = 'FF9FB4A6'
const HEAD_BG = 'FFEAF0E9'
const ZEBRA = 'FFF7FAF6'

// The bands, in the hand sheet's order and its colours: raw yellow,
// intermediate blue. The last two follow the app's palette rather than
// inventing more.
const BANDS: { key: string; label: string; fill: string; ink: string; tint: string }[] = [
  { key: 'raw', label: 'RAW', fill: 'FFFFF200', ink: 'FF5A4C00', tint: 'FFFFFDEB' },
  { key: 'intermediate', label: 'INTERMEDIATE', fill: 'FF5B9BD5', ink: 'FFFFFFFF', tint: 'FFEFF6FC' },
  { key: 'finished', label: 'FINISHED', fill: 'FFD9C2E9', ink: 'FF3B2153', tint: 'FFF9F5FC' },
  { key: 'by-product', label: 'BY-PRODUCT', fill: 'FFE8C89A', ink: 'FF3D2C00', tint: 'FFFDF8EF' },
  { key: 'waste', label: 'WASTE', fill: 'FFE0AFA0', ink: 'FF4A2018', tint: 'FFFCF4F1' }
]
const BAND_ORDER = BANDS.map((b) => b.key)
const bandOf = (cat: string): (typeof BANDS)[number] =>
  BANDS.find((b) => b.key === cat) || {
    key: cat,
    label: String(cat || '—').toUpperCase(),
    fill: 'FF94A3B8',
    ink: 'FFFFFFFF',
    tint: 'FFF7F9FB'
  }

const ddmmyyyy = (iso: string): string => {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-')
  return y ? `${d}-${m}-${y}` : ''
}

// Only the days that carry something.
//
// Every day of the range used to get a row, which suits a one-month sheet and
// falls apart on a financial year: 01-09-2026 to 31-03-2027 drew two hundred
// blank lines, most of them dates that have not happened yet. A future date on
// a production report is not a fact about an idle day, it is noise.
//
// So the rows come from the batches themselves. Which also means no date
// arithmetic and no timezone to get wrong — the earlier version built each day
// with toISOString() and opened a September sheet on 31 August.
function daysWithWork(batches: Row[]): string[] {
  const seen = new Set<string>()
  for (const b of batches) {
    const d = String(b.date || '').slice(0, 10)
    if (d) seen.add(d)
  }
  return [...seen].sort()
}

// The formulation, worked out.
// -----------------------------------------------------------------------------
// The comment on a Ratio cell used to be three loose sentences — the parts, the
// percentages, the recipe version — and it read as a footnote. What the reader
// actually wants from "48:2:50" is the arithmetic: which oils, in what
// proportion, and how many tonnes of each that came to on THIS batch. So it is
// laid out as a small table, in a fixed-width face so the columns line up, and
// footed with the totals the row can be checked against.
//
//   DALDA — 48:2:50
//
//   PART            %        MT
//   RPO-N        48.00    62.400
//   FATTY OIL     2.00     2.600
//   IVF          50.00    65.000
//                       --------
//   consumed              130.000
//   dead loss               1.499
//
//   Recipe DALDA v3 — superseded, latest is v5
//
// Returned as rich-text runs so the heading and the totals can carry their own
// weight, plus the line count and the longest line, which is what sizes the
// comment box (see resizeNotes — ExcelJS gives every box the same 97.8×59.1pt
// and long text is simply clipped).
const NOTE_MONO = 'Consolas'

function ratioNote(b: Row): { texts: ExcelJS.RichText[]; lines: number; cols: number } | null {
  const parts = (b.ratio_parts || []) as Row[]
  if (!parts.length) return null
  const cells = (b.cells || {}) as Record<string, { consumed: number }>

  const pad = (v: string, w: number): string => v.padEnd(w, ' ')
  const num = (v: string, w: number): string => v.padStart(w, ' ')
  const mt3 = (v: number): string => v.toFixed(3)
  const W_MT = 9
  const wName = Math.max(4, ...parts.map((x) => String(x.name).length))

  const head = `${String(b.product_name || '')} — ${String(b.ratio || '')}`
  const table: string[] = [`${pad('PART', wName)}  ${num('%', 6)}  ${num('MT', W_MT)}`]
  for (const x of parts) {
    const mt = n(cells[String(x.product_id)]?.consumed)
    table.push(
      `${pad(String(x.name), wName)}  ${num(n(x.pct).toFixed(2), 6)}  ${num(mt ? mt3(mt) : '—', W_MT)}`
    )
  }
  const foot: string[] = [`${pad('', wName)}  ${num('', 6)}  ${num('─'.repeat(W_MT), W_MT)}`]
  foot.push(`${pad('consumed', wName)}  ${num('', 6)}  ${num(mt3(n(b.total_consumed)), W_MT)}`)
  if (n(b.total_loss) > 0.0005) {
    foot.push(`${pad('dead loss', wName)}  ${num('', 6)}  ${num(mt3(n(b.total_loss)), W_MT)}`)
  }
  const ver = n(b.recipe_version)
    ? `Recipe ${String(b.recipe_name || '')} v${n(b.recipe_version)}${
        n(b.recipe_latest_version) > n(b.recipe_version)
          ? ` — superseded, latest is v${n(b.recipe_latest_version)}`
          : ''
      }`
    : ''

  const texts: ExcelJS.RichText[] = [
    { text: `${head}\n\n`, font: { name: FONT, size: 10, bold: true, color: { argb: 'FF0B3D2E' } } },
    {
      text: `${table[0]}\n`,
      font: { name: NOTE_MONO, size: 9, bold: true, color: { argb: 'FF5A6B62' } }
    },
    {
      text: `${table.slice(1).join('\n')}\n`,
      font: { name: NOTE_MONO, size: 9, color: { argb: INK } }
    },
    {
      text: `${foot.join('\n')}\n`,
      font: { name: NOTE_MONO, size: 9, bold: true, color: { argb: INK } }
    }
  ]
  if (ver) {
    texts.push({ text: `\n${ver}`, font: { name: FONT, size: 9, italic: true, color: { argb: MUTED } } })
  }

  const all = [head, '', ...table, ...foot, ...(ver ? ['', ver] : [])]
  return { texts, lines: all.length, cols: Math.max(...all.map((l) => l.length)) }
}

// No Formulation column. It spelled the ratio out in a 26-wide column beside
// a Ratio cell whose comment says the same thing and more — the percentages and
// the recipe version too — so it was 26 characters of width and a three-line row
// height spent on a duplicate. The comment is the one place it lives now.
// Qty is now Output and Total is now TOR, both the mill's own words for them.
// Comments is new: a batch carries a note, and recirculation — the same oil
// round again, no ratio and no consumption — had been squeezed into the Product
// cell in brackets, which put a remark inside a name.
const LEFT = ['Date', 'Output', 'Product', 'Ratio', 'TOR', 'Comments'] as const
const LEFT_W = [13, 11, 24, 13, 11, 26]
// Which of those are right-aligned. Spelled out rather than tested by index —
// the old code asked `i === 1 || i === 5` on a five-item list, so Total's
// heading sat left over a column of right-aligned figures.
const LEFT_RIGHT = new Set([1, 4])

// Row numbers, named. Computing them inline is how a title block gets added
// and the freeze pane silently ends up one row out.
const R_TITLE = 1
const R_SUB = 2
const R_BAND = 4
const R_HEAD = 5
const R_OPEN = 6
const R_RECV = 7
const R_AVAIL = 8
const R_BODY = 10

// The width of a product column, and how many wrapped lines the longest name
// in the catalogue needs at that width. Excel wraps on spaces, so this does the
// same rather than dividing by a character count — "COTTON SEED OIL" takes two
// lines at width 11, not two-and-a-bit.
const PROD_W = 11.5

function wrapLines(text: string, width: number): number {
  const cap = Math.max(4, Math.floor(width))
  let lines = 1
  let used = 0
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    // A word longer than the column takes as many lines as it needs on its own.
    const own = Math.ceil(word.length / cap)
    if (own > 1) {
      lines += (used ? 1 : 0) + own - 1
      used = word.length % cap || cap
      continue
    }
    if (!used) used = word.length
    else if (used + 1 + word.length <= cap) used += 1 + word.length
    else {
      lines++
      used = word.length
    }
  }
  return lines
}

const headLines = (cols: Row[], width: number): number =>
  Math.max(2, ...cols.map((p) => wrapLines(`${String(p.name)}${String(p.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`, width)))

// Give each comment a box that fits what is in it.
// -----------------------------------------------------------------------------
// ExcelJS writes every comment shape with the same hard-coded
// `width:97.8pt;height:59.1pt` (see lib/xlsx/xform/comment/vml-shape-xform.js),
// which is about four short lines — so a formulation table is simply clipped,
// and there is no API to say otherwise. The sizes are in the VML drawing, so
// they are patched in the finished file: unzip, rewrite the one part, zip again.
//
// Shapes carry their own 0-based row and column in <x:ClientData>, so each is
// matched to the note that was put there rather than trusting document order.
async function resizeNotes(
  buf: ArrayBuffer,
  sizes: Map<string, { w: number; h: number }>
): Promise<ArrayBuffer> {
  try {
    const zip = await JSZip.loadAsync(buf)
    const name = Object.keys(zip.files).find((f) => /vmlDrawing\d*\.vml$/i.test(f))
    if (!name) return buf
    const xml = await zip.file(name)!.async('string')
    let touched = 0
    const next = xml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (block) => {
      const row = /<x:Row>(\d+)<\/x:Row>/.exec(block)?.[1]
      const col = /<x:Column>(\d+)<\/x:Column>/.exec(block)?.[1]
      const size = row != null && col != null ? sizes.get(`${row}:${col}`) : undefined
      if (!size) return block
      touched++
      return block.replace(
        /width:[\d.]+pt;height:[\d.]+pt/,
        `width:${size.w}pt;height:${size.h}pt`
      )
    })
    if (!touched) return buf
    zip.file(name, next)
    return (await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })) as ArrayBuffer
  } catch {
    // A comment at the default size is a great deal better than a download
    // that failed, so this never takes the report down with it.
    return buf
  }
}

function hair(): Partial<ExcelJS.Borders> {
  const c = { argb: GRID }
  return {
    top: { style: 'hair', color: c },
    left: { style: 'hair', color: c },
    bottom: { style: 'hair', color: c },
    right: { style: 'hair', color: c }
  }
}

// Returns how many batch rows were written — 0 when there was no production,
// which is not an error and must not download an empty workbook to prove it.
export async function downloadProductionReport(
  range: { from: string; to: string } | undefined,
  companyIds: number[],
  stamp: string
): Promise<number> {
  const data = await window.api.production.report(range, companyIds)
  const batches = data.batches || []
  if (!batches.length) return 0

  // EVERY product, not only the ones this period touched.
  //
  // It used to drop the untouched ones, which read as tidier and was wrong: a
  // column that is empty this month is the fact that nothing was drawn from
  // that tank, and two months of the report have to line up column for column
  // or they cannot be set side by side. The hand sheet lists the whole
  // catalogue for the same reason.
  const cols = (data.products || [])
    .slice()
    .sort(
      (a, b) =>
        (BAND_ORDER.indexOf(String(a.category)) + 1 || 99) - (BAND_ORDER.indexOf(String(b.category)) + 1 || 99) ||
        String(a.name).localeCompare(String(b.name))
    )

  // The period. With no range the report covers everything on the books, so
  // the day rows run from the first batch to the last rather than nowhere.
  const from = String(range?.from || batches[0]?.date || '').slice(0, 10)
  const to = String(range?.to || batches[batches.length - 1]?.date || '').slice(0, 10)

  const made = batches.reduce((a, b) => a + n(b.qty), 0)
  const eatenAll = batches.reduce((a, b) => a + n(b.total_consumed), 0)
  const real = batches.filter((b) => String(b.kind) !== 'recirculation').length

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Rishabh Oil'
  wb.created = new Date()
  const N = LEFT.length + cols.length
  const ws = wb.addWorksheet('Production report', {
    views: [{ state: 'frozen', xSplit: LEFT.length, ySplit: R_HEAD, showGridLines: false }],
    // A month of production across thirty products is a landscape page, and
    // one nobody should have to set up again every time they print it.
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      // The band and the column names repeat on every page, or page two is
      // thirty columns of unlabelled numbers.
      printTitlesRow: `${R_BAND}:${R_HEAD}`
    }
  })
  ws.columns = [...LEFT_W.map((w) => ({ width: w })), ...cols.map(() => ({ width: PROD_W }))]

  const solid = (cell: ExcelJS.Cell, argb: string): void => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
  }

  // ------------------------------------------------------------- the title --
  const title = ws.getRow(R_TITLE)
  title.height = 28
  ws.mergeCells(R_TITLE, 1, R_TITLE, N)
  const tc = title.getCell(1)
  tc.value = 'COMPLETE PRODUCTION REPORT'
  tc.font = { name: FONT, bold: true, size: 15, color: { argb: LIME } }
  solid(tc, FOREST)
  tc.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

  const sub = ws.getRow(R_SUB)
  sub.height = 18
  ws.mergeCells(R_SUB, 1, R_SUB, N)
  const sc = sub.getCell(1)
  sc.value =
    `${ddmmyyyy(from)} to ${ddmmyyyy(to)}  ·  ${real} batch${real === 1 ? '' : 'es'}  ·  ` +
    `${formatNum(made)} MT made from ${formatNum(eatenAll)} MT consumed  ·  quantities in MT`
  sc.font = { name: FONT, bold: true, size: 9.5, color: { argb: 'FF33473E' } }
  solid(sc, HEAD_BG)
  sc.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
  ws.getRow(3).height = 6

  // -------------------------------------------------------------- the bands --
  const rBand = ws.getRow(R_BAND)
  rBand.height = 20
  ws.mergeCells(R_BAND, 1, R_BAND, LEFT.length)
  const prod = rBand.getCell(1)
  prod.value = 'PRODUCTION'
  prod.font = { name: FONT, bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
  solid(prod, FOREST)
  prod.alignment = { horizontal: 'center', vertical: 'middle' }

  let c = LEFT.length + 1
  while (c <= N) {
    const band = bandOf(String(cols[c - LEFT.length - 1].category))
    let end = c
    while (end < N && bandOf(String(cols[end - LEFT.length].category)).key === band.key) end++
    if (end > c) ws.mergeCells(R_BAND, c, R_BAND, end)
    const cell = rBand.getCell(c)
    cell.value = band.label
    cell.font = { name: FONT, bold: true, size: 11, color: { argb: band.ink } }
    solid(cell, band.fill)
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { left: { style: 'medium', color: { argb: 'FFFFFFFF' } } }
    c = end + 1
  }

  // ------------------------------------------------------- the column names --
  // The hand sheet has none over the left block — it does not need them, the
  // reader wrote it — but a generated file does.
  const rHead = ws.getRow(R_HEAD)
  // Sized to the names it actually has to hold, now that they are printed the
  // right way up. Wrapped at the column's own width, so the tallest name is
  // what sets the row — a fixed height either clips COTTON SEED OIL or leaves
  // a band of white above CPO.
  rHead.height = Math.min(60, 13 * headLines(cols, PROD_W) + 8)
  const headBorder = (left?: boolean): Partial<ExcelJS.Borders> => ({
    ...hair(),
    bottom: { style: 'medium', color: { argb: RULE } },
    left: left ? { style: 'thin', color: { argb: RULE } } : hair().left
  })
  LEFT.forEach((h, i) => {
    const cell = rHead.getCell(i + 1)
    cell.value = h
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: 'FF33473E' } }
    solid(cell, HEAD_BG)
    cell.alignment = { horizontal: LEFT_RIGHT.has(i) ? 'right' : 'left', vertical: 'bottom' }
    cell.border = headBorder()
  })
  cols.forEach((p, i) => {
    const cell = rHead.getCell(LEFT.length + 1 + i)
    const band = bandOf(String(p.category))
    cell.value = `${String(p.name)}${String(p.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`
    cell.font = { name: FONT, bold: true, size: 9, color: { argb: INK } }
    solid(cell, band.tint)
    // Printed horizontally and wrapped, not turned on its side. Rotated text
    // reads at a tilt and cannot be scanned across a row of thirty columns —
    // the eye has to travel to each one and turn. Two or three short lines in
    // an 11-character column costs a taller header row and nothing else.
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = headBorder(i > 0 && String(cols[i - 1].category) !== String(p.category))
  })

  // --------------------------------------------- what there was to consume --
  // Straight off stockLevels, so these three lines are the same figures the
  // Book Stock register shows for the period.
  // Named in full and all three bold. "op." and "receiving" were the hand
  // sheet's own shorthand, which is fine in a book somebody keeps themselves
  // and not in a file that gets mailed on. The third says what it is the total
  // OF — what there was to draw on before a single batch ran.
  // The LABEL is bold; the figures beside it are not. Bold everywhere is bold
  // nowhere — see the note on the body rows below.
  const avail: [number, string, (p: Row) => number][] = [
    [R_OPEN, 'Opening Stock', (p) => n(p.opening)],
    [R_RECV, 'Receipts', (p) => n(p.received)],
    [R_AVAIL, 'Total before Pn.', (p) => Math.round((n(p.opening) + n(p.received)) * 1000) / 1000]
  ]
  for (const [rn, label, pick] of avail) {
    const row = ws.getRow(rn)
    row.height = 16
    // "Total before Pn." is wider than the Date column, and Qty carries
    // nothing on these three rows, so the label gets both.
    ws.mergeCells(rn, 1, rn, 2)
    // Only the last of the three closes the block off.
    const under = rn === R_AVAIL ? { bottom: { style: 'medium' as const, color: { argb: RULE } } } : {}
    for (let i = 1; i <= LEFT.length; i++) {
      const cell = row.getCell(i)
      if (i === 1) {
        cell.value = label
        cell.font = { name: FONT, bold: true, size: 10, color: { argb: 'FF33473E' } }
      }
      solid(cell, rn === R_AVAIL ? HEAD_BG : 'FFFCFDFB')
      cell.alignment = { horizontal: 'left', vertical: 'middle', indent: i === 1 ? 1 : 0 }
      cell.border = { ...hair(), ...under }
    }
    cols.forEach((p, i) => {
      const cell = row.getCell(LEFT.length + 1 + i)
      // A product the register carries no balance for — DEAD LOSS is a hole,
      // not a tank — gets a dash, never a zero it never had. And a genuine nil
      // is left EMPTY rather than written as 0: the hand sheet's blankness is
      // what lets the eye find the figures on a thirty-column grid.
      const q = pick(p)
      if (p.in_stock === false) cell.value = '—'
      else if (Math.abs(q) > 0.0005) putQty(cell, q)
      cell.font = { name: FONT, size: 10, color: { argb: p.in_stock === false ? MUTED : INK } }
      cell.alignment = { horizontal: p.in_stock === false ? 'center' : 'right', vertical: 'middle' }
      solid(cell, rn === R_AVAIL ? bandOf(String(p.category)).tint : 'FFFCFDFB')
      cell.border = {
        ...hair(),
        ...under,
        left:
          i > 0 && String(cols[i - 1].category) !== String(p.category)
            ? { style: 'thin', color: { argb: RULE } }
            : hair().left
      }
    })
  }
  ws.getRow(R_AVAIL + 1).height = 6

  // -------------------------------------------------------------- the body --
  const byDay = new Map<string, Row[]>()
  for (const b of batches) {
    const k = String(b.date)
    const l = byDay.get(k)
    if (l) l.push(b)
    else byDay.set(k, [b])
  }

  // Where each comment goes and how big its box has to be, keyed by the VML's
  // own 0-based row:column. Applied to the finished file by resizeNotes.
  const noteSizes = new Map<string, { w: number; h: number }>()

  let r = R_BODY
  let written = 0
  let dayIndex = 0
  for (const day of daysWithWork(batches)) {
    const lines = byDay.get(day) || []
    // Banded by DAY and not by row, so a day with three batches reads as one
    // block rather than as a stripe through the middle of one.
    const bg = dayIndex % 2 === 1 ? ZEBRA : 'FFFFFFFF'
    lines.forEach((b, li) => {
      const row = ws.getRow(r)
      // One line per batch now that Formulation has gone — nothing in the left
      // block wraps any more.
      row.height = 16

      const put = (
        i: number,
        value: unknown,
        opts: Partial<ExcelJS.Font> & { align?: 'left' | 'right'; wrap?: boolean } = {}
      ): void => {
        const cell = row.getCell(i)
        // Never clears what is already there: the quantity cells are written by
        // putQty first (value AND format together) and then styled through
        // here with an empty value.
        if (value !== '' && value != null) cell.value = value as ExcelJS.CellValue
        cell.font = { name: FONT, size: 10, color: { argb: INK }, ...opts }
        cell.alignment = { horizontal: opts.align ?? 'left', vertical: 'top', wrapText: !!opts.wrap, indent: i === 1 ? 1 : 0 }
        solid(cell, bg)
        cell.border = hair()
      }

      // BOLD IS FOR THE DATE AND ITS FIRST LINE, and for nothing else in the
      // body. Every figure used to be bold — Output, Product, Ratio and TOR on
      // all of them — which is bold everywhere and therefore emphasis nowhere:
      // a day with four batches read as four equally shouted rows. Now the eye
      // finds where each day starts and reads the rest plain.
      const lead = li === 0
      // Printed once per day, as on the hand sheet — three lines under
      // 01-09-2026, not the date typed three times.
      put(1, lead ? ddmmyyyy(day) : '', { bold: lead })
      if (b) putQty(row.getCell(2), n(b.qty))
      put(2, '', { bold: lead, align: 'right' })
      put(3, b ? String(b.product_name) : '', { bold: lead })
      put(4, b ? String(b.ratio || '') : '', { bold: lead })
      // The comment as well as the cell: the cell carries the ratio, the
      // comment names the parts, their percentages and the recipe version. It
      // is the only place the formulation is written now.
      // The comment as well as the column: the column carries the parts, the
      // comment adds the percentages and which recipe version they came off.
      if (b && b.ratio) {
        const note = ratioNote(b)
        if (note) {
          row.getCell(4).note = { texts: note.texts, margins: { insetmode: 'auto' } }
          // Sized from the text itself. 5.1pt a character in 9pt Consolas and
          // 12.2pt a line, with a margin, then capped so a long recipe cannot
          // produce a box that covers the sheet.
          noteSizes.set(`${r - 1}:3`, {
            w: Math.min(420, Math.max(150, Math.round(note.cols * 5.1 + 22))),
            h: Math.min(300, Math.max(70, Math.round(note.lines * 12.2 + 16)))
          })
        }
      }
      if (b && n(b.total_consumed)) putQty(row.getCell(5), n(b.total_consumed))
      put(5, '', { bold: lead, align: 'right' })
      // Recirculation is the same oil round again — no ratio, no consumption —
      // and it used to be appended to the product name in brackets, which put a
      // remark inside a name. It belongs here, beside whatever the operator
      // typed on the batch.
      put(
        6,
        b ? [String(b.kind) === 'recirculation' ? 'Recirculation' : '', String(b.note || '')].filter(Boolean).join(' · ') : '',
        { bold: lead, italic: String(b?.kind) === 'recirculation' }
      )

      const cells = (b?.cells || {}) as Record<string, Cell>
      cols.forEach((p, i) => {
        const cell = row.getCell(LEFT.length + 1 + i)
        const v = cells[String(p.id)]
        const eaten = n(v?.consumed)
        const outp = n(v?.produced)
        // CONSUMPTION, positive, exactly as the hand sheet has it — 35 and 15
        // under the two oils that went into the batch. What the batch MADE is
        // in the Qty column and deliberately not repeated here.
        //
        // A by-product is the one thing the hand sheet has no place for, and it
        // comes off nearly every batch: it goes in negative, so it reads as the
        // opposite of a consumption. The batch's OWN output is skipped — it is
        // already in the Qty column, and writing it here too put -92.415 under
        // RPO-B on the very row whose Qty said it had made 92.415.
        //
        // Which means a column here totals CONSUMPTION, not net movement:
        // IVF's column shows the 104.646 that went into DALDA and not the
        // 108.5 that was made of it. The Stock flow register is where net
        // movement is read; this sheet answers what each batch ate.
        const ownOutput = !!b && Number(p.id) === Number(b.product_id)
        let colour = INK
        if (eaten) {
          putQty(cell, eaten)
          // Dead loss in red — the one consumption nothing came back from, and
          // on a wide grid it should be findable at a glance.
          if (n(v?.loss) >= eaten - 0.0005) colour = 'FF8C2F26'
        } else if (outp && !ownOutput) {
          putQty(cell, -outp)
          colour = 'FF0B6B45'
        }
        cell.font = { name: FONT, size: 10, color: { argb: colour } }
        cell.alignment = { horizontal: 'right', vertical: 'top' }
        solid(cell, bg)
        cell.border = {
          ...hair(),
          left:
            i > 0 && String(cols[i - 1].category) !== String(p.category)
              ? { style: 'thin', color: { argb: RULE } }
              : hair().left
        }
      })

      if (b) written++
      r++
    })
    dayIndex++
  }

  // --------------------------------------------------------- the total --
  // Summed from the rows above rather than from stockLevels, so the sheet can
  // be checked by adding it up — which is the whole reason somebody downloads
  // it rather than reading the register.
  //
  // The QTY cell must not be merged away. The first version of this row
  // stretched its label across the first five columns, which swallowed Qty —
  // so the sheet totalled everything the period CONSUMED and never once said
  // how much it had MADE, which is the figure the report is named after.
  const foot = ws.getRow(r + 1)
  foot.height = 21
  const paint = (cell: ExcelJS.Cell, align: 'left' | 'right'): void => {
    cell.font = { name: FONT, bold: true, size: 10.5, color: { argb: 'FFFFFFFF' } }
    solid(cell, FOREST)
    cell.alignment = { horizontal: align, vertical: 'middle', indent: align === 'left' ? 1 : 0 }
    cell.border = { top: { style: 'medium', color: { argb: RULE } } }
  }
  const flab = foot.getCell(1)
  flab.value = 'PRODUCTION TOTAL'
  paint(flab, 'left')
  const fqty = foot.getCell(2)
  putQty(fqty, made)
  paint(fqty, 'right')
  fqty.font = { name: FONT, bold: true, size: 11, color: { argb: LIME } }
  // What the Qty beside it is a total OF, so nobody has to count the rows.
  ws.mergeCells(r + 1, 3, r + 1, 4)
  const fcnt = foot.getCell(3)
  // The period is already on the subtitle line; repeating it here only cost a
  // column that the Total needs.
  fcnt.value = `${written} batch${written === 1 ? '' : 'es'}`
  paint(fcnt, 'left')
  const ftot = foot.getCell(5)
  putQty(ftot, eatenAll)
  paint(ftot, 'right')
  // The Comments column carries nothing to total, but it is part of the band
  // and an unpainted cell would leave a white notch in it.
  paint(foot.getCell(6), 'left')
  cols.forEach((p, i) => {
    const cell = foot.getCell(LEFT.length + 1 + i)
    let eaten = 0
    let outp = 0
    for (const b of batches) {
      const v = ((b.cells || {}) as Record<string, Cell>)[String(p.id)]
      eaten += n(v?.consumed)
      // Skipped in the body, so skipped here — a total has to be the sum of
      // the column above it or the sheet cannot be checked by adding it up.
      if (Number(p.id) !== Number(b.product_id)) outp += n(v?.produced)
    }
    const net = eaten - outp
    if (Math.abs(net) > 0.0005) putQty(cell, net)
    paint(cell, 'right')
  })

  // How to read the sheet, below the total where it cannot be mistaken for
  // data.
  const legend = ws.getRow(r + 3)
  legend.height = 28
  ws.mergeCells(r + 3, 1, r + 3, Math.min(N, LEFT.length + 10))
  const lc = legend.getCell(1)
  lc.value =
    'Output is what the batch MADE; the product columns are what it CONSUMED, and a by-product coming back off a batch ' +
    'is negative. TOR is consumption including dead loss, which is why it exceeds the quantity made. ' +
    'Opening Stock / Receipts / Total before Pn. are the same figures the Book Stock register shows for this period. ' +
    'Hover a Ratio cell for the formulation worked out — each part, its percentage, the tonnes it came to on that batch, ' +
    'and the recipe version it was run on. ' +
    'Only days with production are listed; a product with no column figure was not drawn on this period.'
  lc.font = { name: FONT, italic: true, size: 9, color: { argb: MUTED } }
  lc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 }

  ws.autoFilter = { from: { row: R_HEAD, column: 1 }, to: { row: r - 1, column: N } }

  // Written, then the comment boxes are grown to fit their contents — see
  // resizeNotes for why that cannot be asked for up front.
  const buf = await resizeNotes((await wb.xlsx.writeBuffer()) as ArrayBuffer, noteSizes)
  downloadWorkbook(buf, `production-report-${from || 'start'}-to-${to || 'date'}-${stamp}`)
  return written
}
