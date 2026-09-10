// The Complete Production Report, in the mill's own layout.
// -----------------------------------------------------------------------------
// Written cell by cell rather than through exportRowsToExcel, because this is
// not a table. It is the hand sheet:
//
//   row 1   PRODUCTION | RAW ............ | INTERMEDIATE ..... | FINISHED ....
//   row 2   Date Qty Product Ratio Formulation Total | one product per column
//   row 3   op.        <- what was in the tanks when the period opened
//   row 4   receiving  <- what came in during it
//   row 5   total      <- what there was to consume
//   row 6   (blank)
//   row 7+  one row per DAY of the period, a line per batch, date printed once
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

const INK = 'FF1F2937'
const GRID = 'FFD8DEE9'
const RULE = 'FFB6C2D4'

// The bands, in the hand sheet's order and its colours: raw yellow,
// intermediate blue. The last two follow the app's palette rather than
// inventing more.
const BANDS: { key: string; label: string; fill: string; ink: string; tint: string }[] = [
  { key: 'raw', label: 'RAW', fill: 'FFFFF200', ink: 'FF5A4C00', tint: 'FFFFFEF0' },
  { key: 'intermediate', label: 'INTERMEDIATE', fill: 'FF5B9BD5', ink: 'FFFFFFFF', tint: 'FFF2F7FC' },
  { key: 'finished', label: 'FINISHED', fill: 'FFD9C2E9', ink: 'FF3B2153', tint: 'FFFAF6FD' },
  { key: 'by-product', label: 'BY-PRODUCT', fill: 'FFE8C89A', ink: 'FF3D2C00', tint: 'FFFDF9F1' },
  { key: 'waste', label: 'WASTE', fill: 'FFE0AFA0', ink: 'FF4A2018', tint: 'FFFCF5F2' }
]
const BAND_ORDER = BANDS.map((b) => b.key)
const bandOf = (cat: string): (typeof BANDS)[number] =>
  BANDS.find((b) => b.key === cat) || { key: cat, label: String(cat || '—').toUpperCase(), fill: 'FF94A3B8', ink: 'FFFFFFFF', tint: 'FFF8FAFC' }

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
    // gate times, one line further down the stack.
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    )
  }
  return out
}

// "85 is RPO-N" / "15 is HO-PANGHAT" — column G of the hand sheet, one part
// per line inside the one cell.
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
const LEFT_W = [12, 10, 22, 10, 22, 11]

function thin(): Partial<ExcelJS.Borders> {
  const c = { argb: GRID }
  return { top: { style: 'hair', color: c }, left: { style: 'hair', color: c }, bottom: { style: 'hair', color: c }, right: { style: 'hair', color: c } }
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

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Rishabh Oil'
  wb.created = new Date()
  const ws = wb.addWorksheet('Production report', {
    views: [{ state: 'frozen', xSplit: LEFT.length, ySplit: 2, showGridLines: false }]
  })
  const N = LEFT.length + cols.length
  ws.columns = [
    ...LEFT_W.map((w) => ({ width: w })),
    ...cols.map(() => ({ width: 12 }))
  ]

  // ---------------------------------------------------------------- row 1 --
  // PRODUCTION over the left block, then one merged banner per band.
  const r1 = ws.getRow(1)
  r1.height = 20
  ws.mergeCells(1, 1, 1, LEFT.length)
  const prod = r1.getCell(1)
  prod.value = 'PRODUCTION'
  prod.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
  prod.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D2E' } }
  prod.alignment = { horizontal: 'center', vertical: 'middle' }

  let c = LEFT.length + 1
  while (c <= N) {
    const band = bandOf(String(cols[c - LEFT.length - 1].category))
    let end = c
    while (end < N && bandOf(String(cols[end - LEFT.length].category)).key === band.key) end++
    if (end > c) ws.mergeCells(1, c, 1, end)
    const cell = r1.getCell(c)
    cell.value = band.label
    cell.font = { bold: true, size: 11, color: { argb: band.ink } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: band.fill } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { left: { style: 'thin', color: { argb: RULE } } }
    c = end + 1
  }

  // ---------------------------------------------------------------- row 2 --
  // The column names. The hand sheet has none over C..H — it does not need
  // them, the reader wrote it — but a generated file does.
  const r2 = ws.getRow(2)
  r2.height = 30
  LEFT.forEach((h, i) => {
    const cell = r2.getCell(i + 1)
    cell.value = h
    cell.font = { bold: true, size: 9.5, color: { argb: 'FF33473E' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0E9' } }
    cell.alignment = { horizontal: i === 1 || i === 5 ? 'right' : 'left', vertical: 'bottom' }
    cell.border = thin()
  })
  cols.forEach((p, i) => {
    const cell = r2.getCell(LEFT.length + 1 + i)
    const band = bandOf(String(p.category))
    cell.value = `${String(p.name)}${String(p.uom || 'MT') === 'PCS' ? ' (PCS)' : ''}`
    cell.font = { bold: true, size: 9, color: { argb: INK } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: band.tint } }
    // Turned on its side, so a 22-character product name does not force a
    // 22-character column on a sheet thirty columns wide.
    cell.alignment = { horizontal: 'left', vertical: 'bottom', textRotation: 90, wrapText: false }
    cell.border = { ...thin(), left: i > 0 && String(cols[i - 1].category) !== String(p.category) ? { style: 'thin', color: { argb: RULE } } : thin().left }
  })

  // ------------------------------------------------------- rows 3, 4, 5 --
  // What there WAS to consume, before a single batch is listed. Straight off
  // stockLevels, so these three lines are the same figures the Book Stock
  // register shows for the period.
  const band3: [string, (p: Row) => number, boolean][] = [
    ['op.', (p) => n(p.opening), false],
    ['receiving', (p) => n(p.received), false],
    ['total', (p) => n(p.opening) + n(p.received), true]
  ]
  band3.forEach(([label, pick, bold], ri) => {
    const row = ws.getRow(3 + ri)
    row.height = 15
    const lab = row.getCell(1)
    lab.value = label
    lab.font = { bold, size: 10, color: { argb: 'FF33473E' } }
    lab.alignment = { horizontal: 'left', vertical: 'middle' }
    for (let i = 2; i <= LEFT.length; i++) row.getCell(i).border = thin()
    lab.border = thin()
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
      cell.font = { bold, size: 10, color: { argb: p.in_stock === false ? 'FF9AA5B1' : INK } }
      cell.alignment = { horizontal: 'right', vertical: 'middle' }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bandOf(String(p.category)).tint } }
      cell.border = bold ? { ...thin(), bottom: { style: 'thin', color: { argb: RULE } } } : thin()
    })
  })

  // -------------------------------------------------------------- the body --
  // Row 6 is left blank, as on the hand sheet: it separates what there was to
  // consume from the consuming of it.
  const byDay = new Map<string, Row[]>()
  for (const b of batches) {
    const k = String(b.date)
    const l = byDay.get(k)
    if (l) l.push(b)
    else byDay.set(k, [b])
  }

  let r = 7
  let written = 0
  for (const day of daysBetween(from, to)) {
    const list = byDay.get(day) || []
    // A day the plant did not run still gets its row, with only the date on
    // it. That is the point of a month sheet.
    const lines = list.length ? list : [null]
    lines.forEach((b, li) => {
      const row = ws.getRow(r)
      row.height = b && b.ratio_parts?.length > 1 ? 13 * Math.min(4, b.ratio_parts.length) : 15

      const date = row.getCell(1)
      // Printed once per day, as on the hand sheet — three lines under
      // 01-09-2026, not the date typed three times.
      date.value = li === 0 ? ddmmyyyy(day) : ''
      date.font = { size: 10, bold: li === 0, color: { argb: INK } }
      date.alignment = { horizontal: 'left', vertical: 'top' }

      const qty = row.getCell(2)
      if (b) {
        qty.value = n(b.qty)
        qty.numFmt = QTY
        qty.font = { bold: true, size: 10, color: { argb: INK } }
      }
      qty.alignment = { horizontal: 'right', vertical: 'top' }

      const name = row.getCell(3)
      name.value = b
        ? `${String(b.product_name)}${String(b.kind) === 'recirculation' ? '  (recirculation)' : ''}`
        : ''
      name.font = { size: 10, color: { argb: INK } }
      name.alignment = { horizontal: 'left', vertical: 'top' }

      const ratio = row.getCell(4)
      ratio.value = b ? String(b.ratio || '') : ''
      ratio.font = { bold: true, size: 10, color: { argb: INK } }
      ratio.alignment = { horizontal: 'left', vertical: 'top' }
      // The comment as well as the column: the column carries the parts, the
      // comment adds the percentages and which recipe version they came off.
      if (b && b.ratio) {
        const note = ratioNote(b)
        if (note) ratio.note = { texts: [{ text: note }], margins: { insetmode: 'auto' } }
      }

      const formula = row.getCell(5)
      formula.value = b ? ratioLines(b) : ''
      formula.font = { size: 9.5, color: { argb: 'FF475569' } }
      formula.alignment = { horizontal: 'left', vertical: 'top', wrapText: true }

      const total = row.getCell(6)
      if (b && n(b.total_consumed)) {
        total.value = n(b.total_consumed)
        total.numFmt = QTY
        total.font = { bold: true, size: 10, color: { argb: INK } }
      }
      total.alignment = { horizontal: 'right', vertical: 'top' }

      for (let i = 1; i <= LEFT.length; i++) row.getCell(i).border = thin()

      const cells = (b?.cells || {}) as Record<string, Cell>
      cols.forEach((p, i) => {
        const cell = row.getCell(LEFT.length + 1 + i)
        const v = cells[String(p.id)]
        const eaten = n(v?.consumed)
        const made = n(v?.produced)
        // CONSUMPTION, positive, exactly as the hand sheet has it — 35 and 15
        // under the two oils that went into the batch. What the batch MADE is
        // in the Qty column and deliberately not repeated here.
        //
        // A by-product is the one thing the hand sheet has no place for, and
        // it comes off nearly every batch: it goes in negative, so it reads as
        // the opposite of a consumption. The batch's OWN output is skipped —
        // it is already in the Qty column, and writing it here too put -92.415
        // under RPO-B on the very row whose Qty said it had made 92.415.
        //
        // Which means a column here totals CONSUMPTION, not net movement:
        // IVF's column shows the 104.646 that went into DALDA and not the
        // 108.5 that was made of it, because what was made is on its own rows
        // in the Qty column. The Stock flow register is where net movement is
        // read; this sheet answers what each batch ate.
        const ownOutput = !!b && Number(p.id) === Number(b.product_id)
        if (eaten) {
          cell.value = eaten
          cell.numFmt = QTY
          cell.font = { size: 10, color: { argb: n(v?.loss) >= eaten - 0.0005 ? 'FF8C2F26' : INK } }
        } else if (made && !ownOutput) {
          cell.value = -made
          cell.numFmt = QTY
          cell.font = { size: 10, color: { argb: 'FF0B6B45' } }
        }
        cell.alignment = { horizontal: 'right', vertical: 'top' }
        cell.border = { ...thin(), left: i > 0 && String(cols[i - 1].category) !== String(p.category) ? { style: 'thin', color: { argb: RULE } } : thin().left }
      })

      if (b) written++
      r++
    })
  }

  // ------------------------------------------------------------- the total --
  // Summed from the rows above rather than from stockLevels, so the sheet can
  // be checked by adding it up — which is the whole reason somebody downloads
  // it rather than reading the register.
  const foot = ws.getRow(r + 1)
  foot.height = 17
  ws.mergeCells(r + 1, 1, r + 1, 5)
  const flab = foot.getCell(1)
  flab.value = `TOTAL — ${written} batch${written === 1 ? '' : 'es'} in ${ddmmyyyy(from)} to ${ddmmyyyy(to)}`
  flab.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
  flab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D2E' } }
  flab.alignment = { horizontal: 'left', vertical: 'middle' }
  const ftot = foot.getCell(6)
  ftot.value = batches.reduce((a, b) => a + n(b.total_consumed), 0)
  ftot.numFmt = QTY
  ftot.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
  ftot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D2E' } }
  ftot.alignment = { horizontal: 'right', vertical: 'middle' }
  cols.forEach((p, i) => {
    const cell = foot.getCell(LEFT.length + 1 + i)
    let eaten = 0
    let made = 0
    for (const b of batches) {
      const v = ((b.cells || {}) as Record<string, Cell>)[String(p.id)]
      eaten += n(v?.consumed)
      // Skipped in the body, so skipped here — a total has to be the sum of
      // the column above it or the sheet cannot be checked by adding it up.
      if (Number(p.id) !== Number(b.product_id)) made += n(v?.produced)
    }
    const net = eaten - made
    if (Math.abs(net) > 0.0005) {
      cell.value = net
      cell.numFmt = QTY
    }
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3D2E' } }
    cell.alignment = { horizontal: 'right', vertical: 'middle' }
  })

  // A last line saying how to read the sheet, below the total where it cannot
  // be mistaken for data.
  const legend = ws.getRow(r + 3)
  ws.mergeCells(r + 3, 1, r + 3, Math.min(N, LEFT.length + 8))
  const lc = legend.getCell(1)
  lc.value =
    'Figures in the product columns are what each batch CONSUMED. A by-product coming back off a batch is negative. ' +
    'Qty is what the batch made. The Ratio cell carries its recipe as a comment.'
  lc.font = { italic: true, size: 9, color: { argb: 'FF64748B' } }
  lc.alignment = { horizontal: 'left', vertical: 'middle' }

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: r - 1, column: N } }

  downloadWorkbook(
    await wb.xlsx.writeBuffer(),
    `production-report-${from || 'start'}-to-${to || 'date'}-${stamp}`
  )
  return written
}
