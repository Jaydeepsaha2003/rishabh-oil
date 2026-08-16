import ExcelJS from 'exceljs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

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
}

// One tab of a workbook.
export type ExcelSheet = {
  sheetName?: string
  title?: string
  columns: ExcelColumn[]
  rows: Row[]
  // Rows matching this get a tinted, bold-ish treatment — used to make the
  // parent rows stand out when a sheet interleaves parents and their detail.
  isGroup?: (row: Row) => boolean
  // When set alongside isGroup, detail rows are put on outline level 1 so Excel
  // shows the +/− handles in the margin and each parent can be collapsed.
  outlineDetail?: boolean
}

function writeSheet(wb: ExcelJS.Workbook, spec: ExcelSheet, index: number): void {
  const { columns, rows } = spec
  const ws = wb.addWorksheet((spec.sheetName || `Sheet${index + 1}`).slice(0, 31))

  const headerRowIdx = spec.title ? 2 : 1
  if (spec.title) {
    ws.mergeCells(1, 1, 1, columns.length)
    const t = ws.getCell(1, 1)
    t.value = spec.title
    t.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
    ws.getRow(1).height = 22
  }

  // Placeholder widths — replaced by real autofit below once every cell is
  // written, so the pass measures what actually landed in the column rather
  // than guessing from the header alone.
  ws.columns = columns.map((c) => ({ width: c.width ?? Math.max(10, Math.min(40, c.header.length + 4)) }))

  const hr = ws.getRow(headerRowIdx)
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { vertical: 'middle', horizontal: c.align ?? 'left', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } }
  })
  hr.height = 20
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }]
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: columns.length }
  }

  rows.forEach((r, ri) => {
    const row = ws.getRow(headerRowIdx + 1 + ri)
    const group = spec.isGroup ? spec.isGroup(r) : false
    // Detail rows sit one level in, so Excel groups them under their parent.
    if (spec.outlineDetail && spec.isGroup) row.outlineLevel = group ? 0 : 1
    columns.forEach((c, ci) => {
      const raw = c.value ? c.value(r) : r[c.key]
      const cell = row.getCell(ci + 1)
      cell.value = raw == null ? '' : (raw as ExcelJS.CellValue)
      if (c.numFmt) cell.numFmt = c.numFmt
      if (c.align) cell.alignment = { horizontal: c.align }
      if (group) {
        cell.font = { bold: true, color: { argb: 'FF1F2937' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } }
      }
      if (c.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.fill } }
      const condFill = c.fillFor ? c.fillFor(r) : undefined
      if (condFill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: condFill } }
    })
  })

  // Autofit: size each column to whatever actually landed in it — the header,
  // or its widest cell, whichever is longer — so nothing reads cramped or
  // truncated. An explicit `width` still acts as a floor, not a ceiling.
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
    ws.getColumn(ci + 1).width = Math.max(c.width ?? 0, Math.min(48, maxLen + 3))
  })
}

// Generic styled .xlsx export used by the Excel buttons across the app. A bold
// header band, optional title, per-column width/alignment/number-format, and a
// frozen header row. Pass `extraSheets` for a workbook with more than one tab —
// e.g. a register summary plus its line-by-line detail. Downloads immediately.
export async function exportRowsToExcel(opts: {
  filename: string
  sheetName?: string
  columns: ExcelColumn[]
  rows: Row[]
  title?: string
  isGroup?: (row: Row) => boolean
  outlineDetail?: boolean
  extraSheets?: ExcelSheet[]
}): Promise<void> {
  const { filename } = opts
  const wb = new ExcelJS.Workbook()
  writeSheet(
    wb,
    {
      sheetName: opts.sheetName || 'Sheet1',
      title: opts.title,
      columns: opts.columns,
      rows: opts.rows,
      isGroup: opts.isGroup,
      outlineDetail: opts.outlineDetail
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
