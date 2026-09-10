// The Complete Production Report, in the mill's own layout.
// -----------------------------------------------------------------------------
// Written cell by cell rather than through exportRowsToExcel, because this is
// not a table. It is the hand sheet:
//
//   1    COMPLETE PRODUCTION REPORT                       <- title band
//   2    period · batches · made · consumed               <- subtitle
//   3    (spacer)
//   4    PRODUCTION | RAW ......... | INTERMEDIATE .... | FINISHED ....
//   5    Date Qty Product Ratio Formulation Total | one product per column
//   6    op.        what was in the tanks when the period opened
//   7    receiving  what came in during it
//   8    total      what there was to consume
//   9    (spacer)
//   10+  every DAY of the period, a line per batch, the date printed once
//   ..   PRODUCTION TOTAL — what was made, and what each column consumed
//
// The generic exporter draws a header and then rows. It has no way to say
// "these eleven columns are RAW", and no way to put three summary rows between
// the header and the body — which is the part of this sheet that makes it
// readable, because it is what the consumption below is checked against.
import ExcelJS from 'exceljs'
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
const QTY = '#,##0.###;-#,##0.###;'

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

// Every day from..to inclusive, because a blank Tuesday is a fact about the
// month. Bounded so a range typed by hand as ten years cannot try to write
// four thousand rows.
function daysBetween(from: string, to: string): string[] {
  if (!from || !to || to < from) return []
  const out: string[] = []
  const end = new Date(`${to}T00:00:00`)
  for (let d = new Date(`${from}T00:00:00`); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
    // Built from the LOCAL parts, never toISOString(). The Date is local
    // midnight, so toISOString converts it to UTC and hands back the day
    // BEFORE: a September sheet opened on 31-08 and stopped on 29-09, losing
    // its last day and gaining one that belongs to August. Same trap as the
    // gate times, one layer further down.
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    )
  }
  return out
}

const isSunday = (iso: string): boolean => new Date(`${iso}T00:00:00`).getDay() === 0

// "85 is RPO-N" / "15 is HO-PANGHAT" — the Formulation column of the hand
// sheet, one part per line inside the one cell.
function ratioLines(b: Row): string {
  const parts = (b.ratio_parts || []) as Row[]
  return parts.map((x) => `${formatNum(n(x.part))} is ${String(x.name)}`).join('\n')
}

// The same thing with the arithmetic behind it, for the comment on the ratio
// cell: the percentages, because 48:2:50 is not obviously a half-and-half
// blend, and the recipe version, because two batches a month apart can
// honestly carry different ratios.
function ratioNote(b: Row): string {
  const parts = (b.ratio_parts || []) as Row[]
  if (!parts.length) return ''
  const pct = parts.map((x) => `${String(x.name)} ${n(x.pct)}%`).join(' · ')
  const ver = n(b.recipe_version)
    ? `\n\nRecipe ${String(b.recipe_name || '')} v${n(b.recipe_version)}${
        n(b.recipe_latest_version) > n(b.recipe_version)
          ? ` — superseded, latest is v${n(b.recipe_latest_version)}`
          : ''
      }`
    : ''
  return `${ratioLines(b)}\n\n${pct}${ver}`
}

const LEFT = ['Date', 'Qty', 'Product', 'Ratio', 'Formulation', 'Total'] as const
const LEFT_W = [13, 10, 24, 11, 26, 11]

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

  // Only what this period moved. The whole catalogue is thirty-six columns and
  // most of it empty in any one month, and an empty column in a spreadsheet is
  // a column somebody has to scroll past.
  const used = new Set<string>()
  for (const b of batches) {
    for (const [k, v] of Object.entries((b.cells || {}) as Record<string, Cell>)) {
      if (n(v.consumed) || n(v.produced)) used.add(k)
    }
  }
  const cols = (data.products || [])
    .filter((p) => used.has(String(p.id)))
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
  ws.columns = [...LEFT_W.map((w) => ({ width: w })), ...cols.map(() => ({ width: 11.5 }))]

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
  rHead.height = 64
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
    cell.alignment = { horizontal: i === 1 || i === 5 ? 'right' : 'left', vertical: 'bottom' }
    cell.border = headBorder()
  })
  cols.forEach((p, i) => {
    const cell = rHead.getCell(LEFT.length + 1 + i)
    const band = bandOf(String(p.category))
    cell.value = `${String(p.name)}${String(p.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`
    cell.font = { name: FONT, bold: true, size: 9, color: { argb: INK } }
    solid(cell, band.tint)
    // Turned on its side, so a 24-character product name does not force a
    // 24-character column on a sheet thirty columns wide.
    cell.alignment = { horizontal: 'left', vertical: 'bottom', textRotation: 90 }
    cell.border = headBorder(i > 0 && String(cols[i - 1].category) !== String(p.category))
  })

  // --------------------------------------------- what there was to consume --
  // Straight off stockLevels, so these three lines are the same figures the
  // Book Stock register shows for the period.
  const avail: [number, string, (p: Row) => number, boolean][] = [
    [R_OPEN, 'op.', (p) => n(p.opening), false],
    [R_RECV, 'receiving', (p) => n(p.received), false],
    [R_AVAIL, 'total', (p) => n(p.opening) + n(p.received), true]
  ]
  for (const [rn, label, pick, bold] of avail) {
    const row = ws.getRow(rn)
    row.height = 16
    const under = bold ? { bottom: { style: 'medium' as const, color: { argb: RULE } } } : {}
    for (let i = 1; i <= LEFT.length; i++) {
      const cell = row.getCell(i)
      if (i === 1) {
        cell.value = label
        cell.font = { name: FONT, bold, size: 10, color: { argb: 'FF33473E' } }
      }
      solid(cell, bold ? HEAD_BG : 'FFFCFDFB')
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
      else if (Math.abs(q) > 0.0005) {
        cell.value = q
        cell.numFmt = QTY
      }
      cell.font = { name: FONT, bold, size: 10, color: { argb: p.in_stock === false ? MUTED : INK } }
      cell.alignment = { horizontal: p.in_stock === false ? 'center' : 'right', vertical: 'middle' }
      solid(cell, bold ? bandOf(String(p.category)).tint : 'FFFCFDFB')
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

  let r = R_BODY
  let written = 0
  let dayIndex = 0
  for (const day of daysBetween(from, to)) {
    const list = byDay.get(day) || []
    // A day the plant did not run still gets its row, with only the date on
    // it. That is the point of a month sheet.
    const lines: (Row | null)[] = list.length ? list : [null]
    // Banded by DAY and not by row, so a day with three batches reads as one
    // block rather than as a stripe through the middle of one.
    const bg = dayIndex % 2 === 1 ? ZEBRA : 'FFFFFFFF'
    const sunday = isSunday(day)
    lines.forEach((b, li) => {
      const row = ws.getRow(r)
      const parts = (b?.ratio_parts || []) as Row[]
      row.height = Math.max(16, Math.min(4, parts.length) * 12.5)

      const put = (
        i: number,
        value: unknown,
        opts: Partial<ExcelJS.Font> & { align?: 'left' | 'right'; wrap?: boolean } = {}
      ): void => {
        const cell = row.getCell(i)
        if (value !== '' && value != null) cell.value = value as ExcelJS.CellValue
        cell.font = { name: FONT, size: 10, color: { argb: INK }, ...opts }
        cell.alignment = { horizontal: opts.align ?? 'left', vertical: 'top', wrapText: !!opts.wrap, indent: i === 1 ? 1 : 0 }
        solid(cell, bg)
        cell.border = hair()
      }

      // Printed once per day, as on the hand sheet — three lines under
      // 01-09-2026, not the date typed three times. A day with nothing on it
      // is greyed, and an idle Sunday is named, so a gap in the month reads as
      // a closed day rather than as a missing entry.
      put(1, li === 0 ? `${ddmmyyyy(day)}${!list.length && sunday ? '  (Sun)' : ''}` : '', {
        bold: li === 0 && !!list.length,
        color: { argb: list.length ? INK : MUTED },
        size: list.length ? 10 : 9.5
      })
      put(2, b ? n(b.qty) : '', { bold: true, align: 'right' })
      row.getCell(2).numFmt = QTY
      put(
        3,
        b ? `${String(b.product_name)}${String(b.kind) === 'recirculation' ? '  (recirculation)' : ''}` : '',
        { bold: !!b }
      )
      put(4, b ? String(b.ratio || '') : '', { bold: true })
      // The comment as well as the column: the column carries the parts, the
      // comment adds the percentages and which recipe version they came off.
      if (b && b.ratio) {
        const note = ratioNote(b)
        if (note) row.getCell(4).note = { texts: [{ text: note }], margins: { insetmode: 'auto' } }
      }
      put(5, b ? ratioLines(b) : '', { size: 9, color: { argb: 'FF546A5F' }, wrap: true })
      put(6, b && n(b.total_consumed) ? n(b.total_consumed) : '', { bold: true, align: 'right' })
      row.getCell(6).numFmt = QTY

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
          cell.value = eaten
          cell.numFmt = QTY
          // Dead loss in red — the one consumption nothing came back from, and
          // on a wide grid it should be findable at a glance.
          if (n(v?.loss) >= eaten - 0.0005) colour = 'FF8C2F26'
        } else if (outp && !ownOutput) {
          cell.value = -outp
          cell.numFmt = QTY
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
  fqty.value = made
  fqty.numFmt = QTY
  paint(fqty, 'right')
  fqty.font = { name: FONT, bold: true, size: 11, color: { argb: LIME } }
  // What the Qty beside it is a total OF, so nobody has to count the rows.
  const fcnt = foot.getCell(3)
  fcnt.value = `${written} batch${written === 1 ? '' : 'es'}`
  paint(fcnt, 'left')
  ws.mergeCells(r + 1, 4, r + 1, 5)
  const fper = foot.getCell(4)
  fper.value = `${ddmmyyyy(from)} to ${ddmmyyyy(to)}`
  paint(fper, 'left')
  const ftot = foot.getCell(6)
  ftot.value = eatenAll
  ftot.numFmt = QTY
  paint(ftot, 'right')
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
    if (Math.abs(net) > 0.0005) {
      cell.value = net
      cell.numFmt = QTY
    }
    paint(cell, 'right')
  })

  // How to read the sheet, below the total where it cannot be mistaken for
  // data.
  const legend = ws.getRow(r + 3)
  legend.height = 28
  ws.mergeCells(r + 3, 1, r + 3, Math.min(N, LEFT.length + 10))
  const lc = legend.getCell(1)
  lc.value =
    'Qty is what the batch MADE; the product columns are what it CONSUMED, and a by-product coming back off a batch ' +
    'is negative. Total is consumption including dead loss, which is why it exceeds the quantity made. ' +
    'op. / receiving / total above the days are the same figures the Book Stock register shows for this period. ' +
    'The Ratio cell carries its recipe as a comment.'
  lc.font = { name: FONT, italic: true, size: 9, color: { argb: MUTED } }
  lc.alignment = { horizontal: 'left', vertical: 'top', wrapText: true, indent: 1 }

  ws.autoFilter = { from: { row: R_HEAD, column: 1 }, to: { row: r - 1, column: N } }

  downloadWorkbook(
    await wb.xlsx.writeBuffer(),
    `production-report-${from || 'start'}-to-${to || 'date'}-${stamp}`
  )
  return written
}
