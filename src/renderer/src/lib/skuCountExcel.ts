import ExcelJS from 'exceljs'
import { downloadWorkbook } from './excel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Nought shows as nothing. Used on the column the counter fills and the two
// derived from it, so an uncounted row reads as empty rather than as zero
// stock — and so a viewer that has not recalculated the formulas yet does not
// show a column of 0.000 either.
const BLANK_ZERO = '#,##0.000;-#,##0.000;'
const PLAIN = '#,##0.000'

// Column layout of the packed-SKU count sheet (1-indexed for exceljs).
//
// Read left to right it is the day's arithmetic: what was left last night, what
// went out today, what the software therefore expects, and — the one thing the
// counter fills — what is actually on the floor. The difference and its tonnage
// compute themselves, so the sheet shows the consequence of the figure before it
// is ever uploaded.
const COL = {
  sid: 1,
  sku: 2,
  pack: 3,
  lastClose: 4,
  dispatch: 5,
  expected: 6,
  counted: 7,
  packedToday: 8,
  mt: 9,
  note: 10
}

// Column letter for a 1-indexed column, so a formula can never drift out of
// step with COL above. Writing "G3-F3" by hand is how a sheet quietly starts
// subtracting the wrong column the moment a column is inserted.
function colLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

// Build and download a PROTECTED .xlsx for counting a day's packed SKU closing
// stock. Only "Counted closing (pcs)" and "Note" are editable; everything else,
// including the tonnage formula, is locked. The SKU column is highlighted so the
// counter can read down it, and every row keeps its SKU id for a safe re-import.
export async function downloadSkuCountExcel(rows: Row[], date: string, packMT: (r: Row) => number): Promise<void> {
  const L = Object.fromEntries(Object.entries(COL).map(([k, v]) => [k, colLetter(v)])) as Record<
    keyof typeof COL,
    string
  >
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Packed SKU count', { views: [{ state: 'frozen', ySplit: 2 }] })

  ws.columns = [
    { width: 8 },
    { width: 34 },
    { width: 14 },
    { width: 18 },
    { width: 14 },
    { width: 17 },
    { width: 21 },
    { width: 16 },
    { width: 16 },
    { width: 26 }
  ]

  ws.mergeCells(1, 1, 1, COL.note)
  const title = ws.getCell(1, 1)
  title.value =
    `Packed SKU — closing stock for ${date}   ·   fill only the green column, in the SKU's own unit`
  title.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
  ws.getRow(1).height = 24

  const headers: Record<number, string> = {
    [COL.sid]: 'SKU id',
    [COL.sku]: 'SKU',
    [COL.pack]: 'Pack size',
    [COL.lastClose]: 'Last day closing',
    [COL.dispatch]: 'Dispatched today',
    [COL.expected]: 'Expected before packing',
    [COL.counted]: "Today's closing  ← FILL",
    [COL.packedToday]: 'Packed today',
    [COL.mt]: 'MT off the tank',
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
    cell.alignment = { vertical: 'middle', horizontal: c >= COL.lastClose && c <= COL.mt ? 'right' : 'left', wrapText: true }
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

    const lastClose = Number(r.opening) || 0
    const dispatched = Number(r.sold_on ?? r.sold) || 0

    row.getCell(COL.sid).value = Number(r.id) || 0
    row.getCell(COL.sku).value = String(r.name || '')
    row.getCell(COL.pack).value = String(r.pack_label || '')
    row.getCell(COL.lastClose).value = lastClose
    row.getCell(COL.dispatch).value = dispatched
    // What the floor would hold if nothing were packed today. Anything above
    // this is today's packing; the sheet works that out rather than asking for
    // it, because a counter can count a shelf and cannot count a day's output.
    row.getCell(COL.expected).value = {
      formula: `${L.lastClose}${rowNo}-${L.dispatch}${rowNo}`
    }
    // Left EMPTY on purpose. A pre-filled figure is one somebody has to notice
    // is wrong; an empty cell is one they have to fill. Uploading skips a blank
    // row entirely, so counting half the shelves and uploading touches only the
    // half that was counted.
    row.getCell(COL.counted).value = null
    // Both derived columns stay blank until a count is typed. Without the
    // guard an empty cell reads as nought, and the sheet would open showing
    // "packed today: −51,120" against every SKU.
    row.getCell(COL.packedToday).value = {
      formula: `IF(${L.counted}${rowNo}="","",${L.counted}${rowNo}-${L.expected}${rowNo})`
    }
    row.getCell(COL.mt).value = {
      formula: `IF(${L.packedToday}${rowNo}="","",${L.packedToday}${rowNo}*${perPiece})`
    }
    row.getCell(COL.note).value = ''

    for (let c = 1; c <= COL.note; c++) {
      const cell = row.getCell(c)
      const fillable = c === COL.counted || c === COL.note
      cell.protection = { locked: !fillable }
      if (c >= COL.lastClose && c <= COL.mt) {
        cell.numFmt = c === COL.counted || c === COL.packedToday || c === COL.mt ? BLANK_ZERO : PLAIN
      }
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
  totalRow.getCell(COL.counted).value = { formula: `SUM(${L.counted}3:${L.counted}${last})` }
  totalRow.getCell(COL.packedToday).value = { formula: `SUM(${L.packedToday}3:${L.packedToday}${last})` }
  totalRow.getCell(COL.mt).value = { formula: `SUM(${L.mt}3:${L.mt}${last})` }
  for (let c = 1; c <= COL.note; c++) {
    const cell = totalRow.getCell(c)
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } }
    cell.protection = { locked: true }
    if (c >= COL.lastClose && c <= COL.mt) {
      cell.numFmt = c === COL.counted || c === COL.packedToday || c === COL.mt ? BLANK_ZERO : PLAIN
    }
  }

  // Says out loud what uploading will do, on the sheet itself — the tonnage is
  // the part that leaves the plant tank, and it should not be a surprise.
  const foot = ws.getRow(last + 3)
  foot.getCell(COL.sku).value =
    `On upload: Packed today is added to each SKU, and the MT in column ${L.mt} comes off the finished-oil tank. ` +
    'A row left blank is skipped — nothing changes for that SKU.'
  foot.getCell(COL.sku).font = { italic: true, size: 10, color: { argb: 'FF475569' } }
  ws.mergeCells(last + 3, COL.sku, last + 3, COL.note)

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

  downloadWorkbook(await wb.xlsx.writeBuffer(), `packed-sku-count-${date}.xlsx`)
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
    const isCountCol = (t: string): boolean =>
      t.includes('counted closing') || t.includes("today's closing")
    if (texts.some((t) => t && isCountCol(t))) {
      headerRowNo = rowNo
      texts.forEach((t, colNo) => {
        if (!t) return
        if (t.includes('sku id')) idx.id = colNo
        else if (t === 'sku') idx.name ??= colNo
        else if (isCountCol(t)) idx.counted = colNo
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
