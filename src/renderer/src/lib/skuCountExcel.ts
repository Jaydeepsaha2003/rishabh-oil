import ExcelJS from 'exceljs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Column layout of the packed-SKU count sheet (1-indexed for exceljs).
const COL = { sid: 1, sku: 2, pack: 3, opening: 4, packed: 5, despatch: 6, system: 7, counted: 8, mt: 9, note: 10 }

// Build and download a PROTECTED .xlsx for counting a day's packed SKU closing
// stock. Only "Counted closing (pcs)" and "Note" are editable; everything else,
// including the tonnage formula, is locked. The SKU column is highlighted so the
// counter can read down it, and every row keeps its SKU id for a safe re-import.
export async function downloadSkuCountExcel(rows: Row[], date: string, packMT: (r: Row) => number): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Packed SKU count', { views: [{ state: 'frozen', ySplit: 2 }] })

  ws.columns = [
    { width: 8 },
    { width: 34 },
    { width: 14 },
    { width: 14 },
    { width: 13 },
    { width: 13 },
    { width: 16 },
    { width: 20 },
    { width: 15 },
    { width: 26 }
  ]

  ws.mergeCells(1, 1, 1, COL.note)
  const title = ws.getCell(1, 1)
  title.value = `Packed SKU closing stock — ${date}`
  title.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
  ws.getRow(1).height = 24

  const headers: Record<number, string> = {
    [COL.sid]: 'SKU id',
    [COL.sku]: 'SKU',
    [COL.pack]: 'Pack size',
    [COL.opening]: 'Opening (pcs)',
    [COL.packed]: 'Packed in',
    [COL.despatch]: 'Despatch',
    [COL.system]: 'System closing (pcs)',
    [COL.counted]: 'Counted closing (pcs)',
    [COL.mt]: 'Counted (MT)',
    [COL.note]: 'Note'
  }
  const hr = ws.getRow(2)
  for (let c = 1; c <= COL.note; c++) {
    const cell = hr.getCell(c)
    cell.value = headers[c] || ''
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      // The two fillable columns get a different header colour.
      fgColor: { argb: c === COL.counted || c === COL.note ? 'FF047857' : 'FF334155' }
    }
    cell.alignment = { vertical: 'middle', horizontal: c >= COL.opening && c <= COL.mt ? 'right' : 'left', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } }
    cell.protection = { locked: true }
  }
  hr.height = 30

  rows.forEach((r, i) => {
    const rowNo = 3 + i
    const row = ws.getRow(rowNo)
    // Pieces → MT for this SKU, so one piece's tonnage can drive the formula.
    const onHand = Number(r.on_hand) || 0
    const perPiece = onHand !== 0 ? packMT(r) / onHand : packMT({ ...r, on_hand: 1 })

    row.getCell(COL.sid).value = Number(r.id) || 0
    row.getCell(COL.sku).value = String(r.name || '')
    row.getCell(COL.pack).value = String(r.pack_label || '')
    row.getCell(COL.opening).value = Number(r.opening) || 0
    row.getCell(COL.packed).value = Number(r.added_on ?? r.added) || 0
    row.getCell(COL.despatch).value = Number(r.sold_on ?? r.sold) || 0
    row.getCell(COL.system).value = onHand
    // Pre-filled with the system figure so an untouched row changes nothing.
    row.getCell(COL.counted).value = onHand
    row.getCell(COL.mt).value = { formula: `H${rowNo}*${perPiece}` }
    row.getCell(COL.note).value = ''

    for (let c = 1; c <= COL.note; c++) {
      const cell = row.getCell(c)
      const fillable = c === COL.counted || c === COL.note
      cell.protection = { locked: !fillable }
      if (c >= COL.opening && c <= COL.mt) cell.numFmt = '#,##0.000'
      if (c === COL.sku) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }
        cell.font = { bold: true }
      }
      if (fillable) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } }
        const edge = { style: 'thin' as const, color: { argb: 'FF10B981' } }
        cell.border = { top: edge, left: edge, bottom: edge, right: edge }
      }
      if (c === COL.sid) cell.font = { color: { argb: 'FF94A3B8' }, size: 9 }
    }
  })

  const last = 2 + rows.length
  const totalRow = ws.getRow(last + 1)
  totalRow.getCell(COL.sku).value = 'TOTAL'
  totalRow.getCell(COL.counted).value = { formula: `SUM(H3:H${last})` }
  totalRow.getCell(COL.mt).value = { formula: `SUM(I3:I${last})` }
  for (let c = 1; c <= COL.note; c++) {
    const cell = totalRow.getCell(c)
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } }
    cell.protection = { locked: true }
    if (c >= COL.opening && c <= COL.mt) cell.numFmt = '#,##0.000'
  }

  ws.getColumn(COL.sid).hidden = true
  // Sheet protection with a blank password: the fillable cells stay editable,
  // everything else is read-only so the layout survives the round trip.
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
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
  a.download = `packed-sku-count-${date}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

export interface SkuCountRow {
  id: number
  name: string
  counted: number
  note: string
}

// Read a filled-in count sheet back. Rows are matched on the hidden SKU id and
// fall back to the SKU name, so a re-saved copy still imports.
export async function parseSkuCountExcel(file: File): Promise<SkuCountRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.worksheets[0]
  if (!ws) return []

  let headerRowNo = -1
  const idx: Record<string, number> = {}
  ws.eachRow((row, rowNo) => {
    if (headerRowNo > 0) return
    const texts: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      texts[colNo] = String(cell.text || '').trim().toLowerCase()
    })
    if (texts.some((t) => t && t.includes('counted closing'))) {
      headerRowNo = rowNo
      texts.forEach((t, colNo) => {
        if (!t) return
        if (t.includes('sku id')) idx.id = colNo
        else if (t === 'sku') idx.name ??= colNo
        else if (t.includes('counted closing')) idx.counted = colNo
        else if (t.includes('note')) idx.note = colNo
      })
    }
  })
  if (headerRowNo < 0 || !idx.counted) return []

  const out: SkuCountRow[] = []
  ws.eachRow((row, rowNo) => {
    if (rowNo <= headerRowNo) return
    const name = idx.name ? String(row.getCell(idx.name).text || '').trim() : ''
    if (!name || name.toUpperCase() === 'TOTAL') return
    const raw = String(row.getCell(idx.counted).text ?? '').trim().replace(/,/g, '')
    if (raw === '') return
    const counted = Number(raw)
    if (!Number.isFinite(counted)) return
    out.push({
      id: idx.id ? Number(row.getCell(idx.id).text) || 0 : 0,
      name,
      counted,
      note: idx.note ? String(row.getCell(idx.note).text || '').trim() : ''
    })
  })
  return out
}
