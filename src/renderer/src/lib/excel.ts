import ExcelJS from 'exceljs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// House palette, matching the app's own navy/amber register styling so a
// downloaded sheet reads as the same document as the screen it came from.
const NAVY = 'FF1A2C56'
const NAVY_DARK = 'FF14213D'
const GRID = 'FFD8DEE9'
const ZEBRA = 'FFF7F9FC'
const GROUP_FILL = 'FFE8EEF7'
const TOTAL_FILL = 'FFFDF3D7'
const TOTAL_LINE = 'FFD9A82B'
const INK = 'FF1F2937'
const MUTED = 'FF64748B'

// Number formats with a third section, so a zero prints as an en-dash instead
// of a wall of "0.000" — the single biggest readability win on a stock or
// money register. Negatives stay parenthesised the way accounts expect.
export const NUM_QTY = '#,##0.000;(#,##0.000);"–"'
export const NUM_MONEY = '#,##0.00;(#,##0.00);"–"'
export const NUM_INT = '#,##0;(#,##0);"–"'

export type ExcelColumn = {
  header: string
  key: string
  width?: number
  align?: 'left' | 'right' | 'center'
  numFmt?: string
  // Optional accessor — defaults to row[key].
  value?: (row: Row) => unknown
  // Solid fill (ARGB hex, e.g. 'FFC6EFCE' for light green) applied to every
  // cell in this column — wins over the group-row tint so a column can stay
  // highlighted even on the bold LC summary row.
  fill?: string
  // Per-row conditional fill (e.g. green only where Status = "Settled") —
  // wins over both the static `fill` above and the group-row tint.
  fillFor?: (row: Row) => string | undefined
  // Override the header band's default navy/white for just this column —
  // e.g. to colour-code a group of columns (all the date fields one tint,
  // all the calculated amounts another) against the client's own template.
  headerFill?: string
  headerTextColor?: string
  // Include this column in the footer TOTAL row. On a sheet that interleaves
  // parents and their detail (isGroup set), only the parent rows are summed —
  // the detail is a breakdown OF the parent, so adding both would double it.
  total?: 'sum'
  // Draw a heavier left rule before this column, to separate a block of
  // columns (e.g. the closing balance from the flows that produced it).
  divider?: boolean
}

// One tab of a workbook.
export type ExcelSheet = {
  sheetName?: string
  title?: string
  // Small grey line under the title — period covered, company, row count…
  subtitle?: string
  columns: ExcelColumn[]
  rows: Row[]
  // Rows matching this get a tinted, bold-ish treatment — used to make the
  // parent rows stand out when a sheet interleaves parents and their detail.
  isGroup?: (row: Row) => boolean
  // When set alongside isGroup, detail rows are put on outline level 1 so Excel
  // shows the +/− handles in the margin and each parent can be collapsed.
  outlineDetail?: boolean
  // Keep this many leading columns on screen when scrolling right (the product
  // name, typically) — the header row is always frozen.
  freezeCols?: number
  totalLabel?: string
}

// Excel rejects : \ / ? * [ ] in a tab name and silently corrupts the file
// rather than complaining, so they are stripped rather than passed through.
function safeSheetName(name: string, index: number): string {
  const clean = String(name || '').replace(/[:\\/?*[\]]/g, ' ').trim()
  return (clean || `Sheet${index + 1}`).slice(0, 31)
}

// Cap the autofit so one long free-text cell can't push a column off the page.
function fitWidth(len: number): number {
  return Math.min(48, len + 3)
}

function thinBorder(): Partial<ExcelJS.Borders> {
  return {
    top: { style: 'hair', color: { argb: GRID } },
    left: { style: 'hair', color: { argb: GRID } },
    bottom: { style: 'hair', color: { argb: GRID } },
    right: { style: 'hair', color: { argb: GRID } }
  }
}

function writeSheet(wb: ExcelJS.Workbook, spec: ExcelSheet, index: number): void {
  const { columns, rows } = spec
  const ws = wb.addWorksheet(safeSheetName(spec.sheetName || '', index), {
    views: [{ showGridLines: false }]
  })
  const lastCol = columns.length

  // Title block, then a thin spacer so the header band doesn't collide with it.
  let cursor = 0
  if (spec.title) {
    cursor += 1
    if (lastCol > 1) ws.mergeCells(cursor, 1, cursor, lastCol)
    const t = ws.getCell(cursor, 1)
    t.value = spec.title
    t.font = { bold: true, size: 15, color: { argb: NAVY } }
    t.alignment = { vertical: 'middle' }
    ws.getRow(cursor).height = 24
  }
  if (spec.subtitle) {
    cursor += 1
    if (lastCol > 1) ws.mergeCells(cursor, 1, cursor, lastCol)
    const s = ws.getCell(cursor, 1)
    s.value = spec.subtitle
    s.font = { size: 9.5, color: { argb: MUTED } }
    s.alignment = { vertical: 'middle' }
    ws.getRow(cursor).height = 15
  }
  if (cursor > 0) {
    cursor += 1
    ws.getRow(cursor).height = 6
  }
  const headerRowIdx = cursor + 1

  // Placeholder widths — replaced by real autofit below once every cell is
  // written, so the pass measures what actually landed in the column rather
  // than guessing from the header alone.
  ws.columns = columns.map((c) => ({ width: c.width ?? Math.max(10, Math.min(40, c.header.length + 4)) }))

  const hr = ws.getRow(headerRowIdx)
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true, size: 10, color: { argb: c.headerTextColor ?? 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.headerFill ?? NAVY } }
    cell.alignment = { vertical: 'middle', horizontal: c.align ?? 'left', wrapText: true }
    cell.border = {
      bottom: { style: 'thin', color: { argb: NAVY_DARK } },
      left: c.divider ? { style: 'thin', color: { argb: 'FFFFFFFF' } } : undefined,
      right: { style: 'hair', color: { argb: 'FF3E5480' } }
    }
  })
  hr.height = 26

  ws.views = [
    {
      state: 'frozen',
      xSplit: spec.freezeCols && spec.freezeCols > 0 ? spec.freezeCols : undefined,
      ySplit: headerRowIdx,
      showGridLines: false
    }
  ]
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: lastCol }
  }

  // Banding counts DETAIL rows only, so the stripes alternate evenly between
  // the tinted parents instead of being knocked out of step by them.
  let detailSeen = 0
  rows.forEach((r, ri) => {
    const row = ws.getRow(headerRowIdx + 1 + ri)
    const group = spec.isGroup ? spec.isGroup(r) : false
    if (!group) detailSeen += 1
    const banded = !group && detailSeen % 2 === 0
    // Detail rows sit one level in, so Excel groups them under their parent.
    if (spec.outlineDetail && spec.isGroup) row.outlineLevel = group ? 0 : 1
    row.height = group ? 18 : 16
    columns.forEach((c, ci) => {
      const raw = c.value ? c.value(r) : r[c.key]
      const cell = row.getCell(ci + 1)
      cell.value = raw == null ? '' : (raw as ExcelJS.CellValue)
      if (c.numFmt) cell.numFmt = c.numFmt
      cell.alignment = { horizontal: c.align ?? 'left', vertical: 'middle' }
      cell.border = thinBorder()
      if (c.divider) cell.border = { ...cell.border, left: { style: 'thin', color: { argb: 'FFB6C2D4' } } }
      cell.font = { size: 10, color: { argb: INK } }
      // Zebra banding on the detail rows only — a group row carries its own
      // tint, and striping it too would flatten the distinction.
      if (group) {
        cell.font = { size: 10, bold: true, color: { argb: NAVY } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_FILL } }
      } else if (banded) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }
      }
      if (c.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.fill } }
      const condFill = c.fillFor ? c.fillFor(r) : undefined
      if (condFill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: condFill } }
    })
  })

  // Footer TOTAL — only when a column asked for one. Sums the parent rows on a
  // parent/detail sheet (see ExcelColumn.total) and every row otherwise.
  const wantsTotal = columns.some((c) => c.total === 'sum')
  if (wantsTotal && rows.length > 0) {
    const summable = spec.isGroup ? rows.filter((r) => spec.isGroup!(r)) : rows
    const tr = ws.getRow(headerRowIdx + 1 + rows.length)
    tr.height = 20
    tr.outlineLevel = 0
    let labelled = false
    columns.forEach((c, ci) => {
      const cell = tr.getCell(ci + 1)
      if (c.total === 'sum') {
        const sum = summable.reduce((acc, r) => {
          const v = Number(c.value ? c.value(r) : r[c.key])
          return acc + (Number.isFinite(v) ? v : 0)
        }, 0)
        cell.value = sum
        if (c.numFmt) cell.numFmt = c.numFmt
      } else if (!labelled) {
        // First non-summed column carries the word, so it sits at the left.
        cell.value = spec.totalLabel || 'TOTAL'
        labelled = true
      }
      cell.alignment = { horizontal: c.align ?? 'left', vertical: 'middle' }
      cell.font = { size: 10, bold: true, color: { argb: INK } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } }
      cell.border = {
        top: { style: 'double', color: { argb: TOTAL_LINE } },
        bottom: { style: 'thin', color: { argb: TOTAL_LINE } },
        left: c.divider ? { style: 'thin', color: { argb: 'FFB6C2D4' } } : { style: 'hair', color: { argb: GRID } },
        right: { style: 'hair', color: { argb: GRID } }
      }
    })
  }

  // Autofit: size each column to whatever actually landed in it — the header,
  // or its widest cell, whichever is longer — so nothing reads cramped or
  // truncated. An explicit `width` still acts as a floor, not a ceiling. The
  // title/subtitle are excluded on purpose: they are merged across the sheet,
  // so measuring them would stretch column A to the width of the whole line.
  columns.forEach((c, ci) => {
    let maxLen = c.header.length
    rows.forEach((r) => {
      const raw = c.value ? c.value(r) : r[c.key]
      if (raw == null || raw === '') return
      const display =
        typeof raw === 'number' && c.numFmt
          ? raw.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : String(raw)
      if (display.length > maxLen) maxLen = display.length
    })
    ws.getColumn(ci + 1).width = Math.max(c.width ?? 0, fitWidth(maxLen))
  })

  // Printable out of the box: landscape, scaled to one page wide, with the
  // title and header band repeated on every page and the page number footed.
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `1:${headerRowIdx}`
  }
  ws.headerFooter = { oddFooter: '&L&"Calibri,Italic"&9&F&C&"Calibri,Italic"&9Page &P of &N&R&"Calibri,Italic"&9&D' }
}

// Generic styled .xlsx export used by the Excel buttons across the app. A bold
// header band, optional title/subtitle, per-column width/alignment/number
// format, zebra-striped rows, an optional footer total, a frozen header row and
// print-ready page setup. Pass `extraSheets` for a workbook with more than one
// tab — e.g. a register summary plus its line-by-line detail. Downloads
// immediately.
export async function exportRowsToExcel(opts: {
  filename: string
  sheetName?: string
  columns: ExcelColumn[]
  rows: Row[]
  title?: string
  subtitle?: string
  isGroup?: (row: Row) => boolean
  outlineDetail?: boolean
  freezeCols?: number
  totalLabel?: string
  extraSheets?: ExcelSheet[]
}): Promise<void> {
  const { filename } = opts
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Rishabh Oil'
  wb.created = new Date()
  writeSheet(
    wb,
    {
      sheetName: opts.sheetName || 'Sheet1',
      title: opts.title,
      subtitle: opts.subtitle,
      columns: opts.columns,
      rows: opts.rows,
      isGroup: opts.isGroup,
      outlineDetail: opts.outlineDetail,
      freezeCols: opts.freezeCols,
      totalLabel: opts.totalLabel
    },
    0
  )
  ;(opts.extraSheets || []).forEach((sh, i) => writeSheet(wb, sh, i + 1))
  // Show the outline expanded, with the +/− summary handles above each group.
  wb.eachSheet((ws) => {
    ws.properties.outlineLevelRow = 1
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false }
  })

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
