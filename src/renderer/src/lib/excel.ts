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
}

// Generic styled .xlsx export used by the Excel buttons across the app. A bold
// header band, optional title, per-column width/alignment/number-format, and a
// frozen header row. Downloads immediately in the browser.
export async function exportRowsToExcel(opts: {
  filename: string
  sheetName?: string
  columns: ExcelColumn[]
  rows: Row[]
  title?: string
}): Promise<void> {
  const { filename, columns, rows } = opts
  const sheetName = (opts.sheetName || 'Sheet1').slice(0, 31)
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)

  const headerRowIdx = opts.title ? 2 : 1
  if (opts.title) {
    ws.mergeCells(1, 1, 1, columns.length)
    const t = ws.getCell(1, 1)
    t.value = opts.title
    t.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
    ws.getRow(1).height = 22
  }

  ws.columns = columns.map((c) => ({ width: c.width ?? Math.max(12, Math.min(40, c.header.length + 4)) }))

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

  rows.forEach((r, ri) => {
    const row = ws.getRow(headerRowIdx + 1 + ri)
    columns.forEach((c, ci) => {
      const raw = c.value ? c.value(r) : r[c.key]
      const cell = row.getCell(ci + 1)
      cell.value = raw == null ? '' : (raw as ExcelJS.CellValue)
      if (c.numFmt) cell.numFmt = c.numFmt
      if (c.align) cell.alignment = { horizontal: c.align }
    })
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
