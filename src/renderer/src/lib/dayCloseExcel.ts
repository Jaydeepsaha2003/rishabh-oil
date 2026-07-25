import ExcelJS from 'exceljs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

// Column layout of the day-close template (1-indexed for exceljs).
const COL = { pid: 1, product: 2, category: 3, book: 4, rate: 5, actual: 6, value: 7, note: 8 }

// Build and download a PROTECTED .xlsx day-close template for one section.
// Only the "Actual Qty" and "Note" cells are editable; everything else (incl.
// the auto-valued "Actual Value" formula) is locked. The Product column is
// highlighted so the counter can read down it easily.
export async function downloadDayCloseExcel(
  rows: Row[],
  section: { key: string; title: string },
  date: string
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(section.title, {
    views: [{ state: 'frozen', ySplit: 2 }]
  })

  ws.columns = [
    { width: 10 },
    { width: 34 },
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 16 },
    { width: 18 },
    { width: 28 }
  ]

  // Title band.
  ws.mergeCells(1, 1, 1, 8)
  const title = ws.getCell(1, 1)
  title.value = `Day close — ${section.title}   |   Date: ${date}`
  title.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
  title.alignment = { vertical: 'middle' }
  ws.getRow(1).height = 24

  // Header row.
  const headers = ['Product ID', 'Product', 'Category', 'Book Qty', 'Rate (₹/unit)', 'Actual Qty', 'Actual Value (₹)', 'Note']
  const hr = ws.getRow(2)
  headers.forEach((h, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = h
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { vertical: 'middle', horizontal: i >= 3 ? 'right' : 'left', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } }
  })
  hr.height = 22

  rows.forEach((r, idx) => {
    const excelRow = idx + 3
    const row = ws.getRow(excelRow)
    row.getCell(COL.pid).value = Number(r.product_id)
    row.getCell(COL.product).value = r.name
    row.getCell(COL.category).value = CAT_LABEL[r.category] || r.category
    row.getCell(COL.book).value = Number(r.book_qty) || 0
    row.getCell(COL.rate).value = Number(r.rate) || 0
    // Actual Qty is left blank for the counter.
    row.getCell(COL.actual).value = r.actual_qty != null && r.actual_qty !== '' ? Number(r.actual_qty) : null
    // Actual Value = Actual Qty × Rate, as a live (locked) formula.
    row.getCell(COL.value).value = { formula: `F${excelRow}*E${excelRow}`, result: 0 }
    row.getCell(COL.note).value = r.note ?? null

    // Number formats.
    row.getCell(COL.book).numFmt = '#,##0.000'
    row.getCell(COL.rate).numFmt = '#,##0.00'
    row.getCell(COL.actual).numFmt = '#,##0.000'
    row.getCell(COL.value).numFmt = '#,##0.00'

    // Lock everything, then unlock the two fillable columns.
    for (let c = 1; c <= 8; c++) row.getCell(c).protection = { locked: true }
    row.getCell(COL.actual).protection = { locked: false }
    row.getCell(COL.note).protection = { locked: false }

    // Highlight the Product column.
    row.getCell(COL.product).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }
    row.getCell(COL.product).font = { bold: true, color: { argb: 'FF92400E' } }
    // Tint the fillable Actual Qty cell so it's obvious where to type.
    row.getCell(COL.actual).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } }

    // Right-align the numeric columns.
    for (const c of [COL.pid, COL.book, COL.rate, COL.actual, COL.value]) {
      row.getCell(c).alignment = { horizontal: 'right' }
    }
  })

  // Lock the header/title too.
  for (const rn of [1, 2]) {
    for (let c = 1; c <= 8; c++) ws.getRow(rn).getCell(c).protection = { locked: true }
  }

  // Protect the sheet: allow selecting cells and auto-filter, block structural edits.
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    deleteRows: false,
    sort: false,
    autoFilter: false
  })

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `day-close-${section.key}-${date}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

// Read a filled .xlsx day-close template back into { product_id, actual_qty, note }
// rows, matching by Product ID (falling back to Product name).
export async function parseDayCloseExcel(
  file: File
): Promise<Array<{ product_id?: number; name?: string; actual_qty?: string; note?: string }>> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.worksheets[0]
  if (!ws) return []

  // Locate the header row (the one containing "Product").
  let headerRowNo = -1
  const headerIdx: Record<string, number> = {}
  ws.eachRow((row, rowNo) => {
    if (headerRowNo > 0) return
    const texts: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      texts[colNo] = String(cell.text || '').trim().toLowerCase()
    })
    if (texts.some((t) => t && t.includes('product'))) {
      headerRowNo = rowNo
      texts.forEach((t, colNo) => {
        if (!t) return
        if (t.includes('product id') || t.includes('productid')) headerIdx.pid = colNo
        else if (t.includes('product') || t === 'name') headerIdx.name ??= colNo
        else if (t.includes('actual qty') || t.includes('actual quantity')) headerIdx.qty = colNo
        else if (t.includes('note')) headerIdx.note = colNo
      })
    }
  })
  if (headerRowNo < 0) return []

  const out: Array<{ product_id?: number; name?: string; actual_qty?: string; note?: string }> = []
  ws.eachRow((row, rowNo) => {
    if (rowNo <= headerRowNo) return
    const get = (col?: number): string => (col ? String(row.getCell(col).text || '').trim() : '')
    const pid = get(headerIdx.pid)
    const name = get(headerIdx.name)
    const qty = get(headerIdx.qty)
    const note = get(headerIdx.note)
    if (!pid && !name) return
    out.push({
      product_id: pid ? Number(pid) : undefined,
      name: name || undefined,
      actual_qty: qty || undefined,
      note: note || undefined
    })
  })
  return out
}
