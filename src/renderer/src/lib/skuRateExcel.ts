import ExcelJS from 'exceljs'
import { downloadWorkbook } from './excel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Column layout of the SKU rate card (1-indexed for exceljs).
const COL = { pid: 1, sku: 2, pack: 3, mtPerCase: 4, perCase: 5, perMt: 6, note: 7 }

// One case in MT, from the pack definition. 1 L is counted as 1 KG, matching how
// the packed SKU registers convert.
export function caseMT(r: Row): number {
  const size = Number(r.unit_size) > 0 ? Number(r.unit_size) : Number(r.base_per_pouch) || 0
  const uom = String(Number(r.unit_size) > 0 ? r.unit_uom : r.base_uom || 'KG').toUpperCase()
  const perUnit = uom === 'MT' ? size : uom === 'G' ? size / 1_000_000 : size / 1000
  const perBox = Number(r.pouches_per_box) > 0 ? Number(r.pouches_per_box) : 1
  return perUnit * perBox
}

// Build and download a PROTECTED rate card. The SKUs are already listed; only
// "Rate per case", "Rate per MT" and "Note" can be typed into. Whichever rate is
// left blank is derived on import from the other, using MT per case.
export async function downloadSkuRateExcel(
  rows: Row[],
  bargain: { bargainNo: string; qty: number; uom: string; customer?: string }
): Promise<void> {
  const { bargainNo, uom } = bargain
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('SKU rates', { views: [{ state: 'frozen', ySplit: 4 }] })
  ws.columns = [{ width: 8 }, { width: 34 }, { width: 14 }, { width: 13 }, { width: 16 }, { width: 16 }, { width: 26 }]

  ws.mergeCells(1, 1, 1, COL.note)
  const t = ws.getCell(1, 1)
  t.value = `Sales bargain ${bargainNo} — SKU rate card`
  t.font = { bold: true, size: 13, color: { argb: 'FF1F2937' } }
  ws.getRow(1).height = 22

  // Identity of the bargain this card belongs to. Locked by the sheet
  // protection below and checked on import, so a card cannot be filled in for
  // one bargain and uploaded against another.
  const idCells: [number, string, string | number][] = [
    [1, 'Bargain no', bargainNo],
    [3, 'Tonnage', `${bargain.qty} ${uom || 'MT'}`],
    [5, 'Customer', bargain.customer || '—']
  ]
  for (const [col, label, value] of idCells) {
    const l = ws.getCell(2, col)
    l.value = label
    l.font = { size: 9, bold: true, color: { argb: 'FF6B7280' } }
    l.protection = { locked: true }
    const v = ws.getCell(2, col + 1)
    v.value = value
    v.font = { size: 11, bold: true, color: { argb: 'FF1F2937' } }
    v.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } }
    v.protection = { locked: true }
  }
  ws.getRow(2).height = 18

  ws.mergeCells(3, 1, 3, COL.note)
  const h = ws.getCell(3, 1)
  h.value =
    `Fill either rate — the other is worked out from MT per case. Rates are in ${uom || 'MT'} terms. ` +
    'Leave both blank to remove a SKU from the card.'
  h.font = { size: 10, color: { argb: 'FF6B7280' } }

  const headers: Record<number, string> = {
    [COL.pid]: 'SKU id',
    [COL.sku]: 'SKU',
    [COL.pack]: 'Pack',
    [COL.mtPerCase]: 'MT per case',
    [COL.perCase]: 'Rate per case',
    [COL.perMt]: 'Rate per MT',
    [COL.note]: 'Note'
  }
  const hr = ws.getRow(4)
  for (let c = 1; c <= COL.note; c++) {
    const cell = hr.getCell(c)
    cell.value = headers[c] || ''
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    const fillable = c === COL.perCase || c === COL.perMt || c === COL.note
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillable ? 'FF047857' : 'FF334155' } }
    cell.alignment = { vertical: 'middle', horizontal: c >= COL.mtPerCase && c <= COL.perMt ? 'right' : 'left', wrapText: true }
    cell.protection = { locked: true }
  }
  hr.height = 28
  ws.getCell(3, 1).protection = { locked: true }

  rows.forEach((r, i) => {
    const rowNo = 5 + i
    const row = ws.getRow(rowNo)
    const size = Number(r.unit_size) > 0 ? `${r.unit_size} ${r.unit_uom || ''}`.trim() : ''
    row.getCell(COL.pid).value = Number(r.packaging_id) || 0
    row.getCell(COL.sku).value = String(r.name || '')
    row.getCell(COL.pack).value = size
    row.getCell(COL.mtPerCase).value = caseMT(r)
    row.getCell(COL.perCase).value = r.rate_per_case == null ? null : Number(r.rate_per_case)
    row.getCell(COL.perMt).value = r.rate_per_mt == null ? null : Number(r.rate_per_mt)
    row.getCell(COL.note).value = ''

    for (let c = 1; c <= COL.note; c++) {
      const cell = row.getCell(c)
      const fillable = c === COL.perCase || c === COL.perMt || c === COL.note
      cell.protection = { locked: !fillable }
      if (c === COL.mtPerCase) cell.numFmt = '#,##0.00000'
      if (c === COL.perCase || c === COL.perMt) cell.numFmt = '#,##0.00'
      if (c === COL.sku) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }
        cell.font = { bold: true }
      }
      if (fillable) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } }
        const edge = { style: 'thin' as const, color: { argb: 'FF10B981' } }
        cell.border = { top: edge, left: edge, bottom: edge, right: edge }
      }
      if (c === COL.pid) cell.font = { color: { argb: 'FF94A3B8' }, size: 9 }
    }
  })

  ws.getColumn(COL.pid).hidden = true
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: false,
    insertRows: false,
    deleteRows: false,
    sort: false
  })

  downloadWorkbook(await wb.xlsx.writeBuffer(), `sku-rates-${bargainNo.replace(/[\\/\\\\:*?"<>|]/g, '-')}.xlsx`)
}

export interface SkuRateRow {
  packaging_id: number
  name: string
  rate_per_case: number | null
  rate_per_mt: number | null
}

// Read a filled card back. Whichever rate is missing is derived from the other
// via MT per case, so the sheet can be filled in whichever unit was negotiated.
export interface ParsedRateCard {
  // The bargain the sheet was generated for, read back from its locked cell.
  bargainNo: string
  rows: SkuRateRow[]
}

export async function parseSkuRateExcel(file: File): Promise<ParsedRateCard> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.worksheets[0]
  if (!ws) return { bargainNo: '', rows: [] }

  // The identity row: find the "Bargain no" label and take the cell beside it.
  let bargainNo = ''
  ws.eachRow((row) => {
    if (bargainNo) return
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      if (String(cell.text || '').trim().toLowerCase() === 'bargain no') {
        bargainNo = String(row.getCell(colNo + 1).text || '').trim()
      }
    })
  })

  let headerRowNo = -1
  const idx: Record<string, number> = {}
  ws.eachRow((row, rowNo) => {
    if (headerRowNo > 0) return
    const texts: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNo) => {
      texts[colNo] = String(cell.text || '').trim().toLowerCase()
    })
    if (texts.some((t) => t && t.includes('rate per case'))) {
      headerRowNo = rowNo
      texts.forEach((t, colNo) => {
        if (!t) return
        if (t.includes('sku id')) idx.pid = colNo
        else if (t === 'sku') idx.name ??= colNo
        else if (t.includes('mt per case')) idx.mt = colNo
        else if (t.includes('rate per case')) idx.perCase = colNo
        else if (t.includes('rate per mt')) idx.perMt = colNo
      })
    }
  })
  if (headerRowNo < 0 || !idx.perCase || !idx.perMt) return { bargainNo, rows: [] }

  const num = (cell: unknown): number | null => {
    const raw = String(cell ?? '').trim().replace(/,/g, '')
    if (raw === '') return null
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  const out: SkuRateRow[] = []
  ws.eachRow((row, rowNo) => {
    if (rowNo <= headerRowNo) return
    const name = idx.name ? String(row.getCell(idx.name).text || '').trim() : ''
    if (!name) return
    const pid = idx.pid ? Number(row.getCell(idx.pid).text) || 0 : 0
    if (!pid) return
    const mtPerCase = idx.mt ? Number(String(row.getCell(idx.mt).text || '').replace(/,/g, '')) || 0 : 0
    let perCase = num(row.getCell(idx.perCase).text)
    let perMt = num(row.getCell(idx.perMt).text)
    // Derive the one that was left blank.
    if (perCase != null && perMt == null && mtPerCase > 0) perMt = Math.round((perCase / mtPerCase) * 100) / 100
    if (perMt != null && perCase == null && mtPerCase > 0) perCase = Math.round(perMt * mtPerCase * 100) / 100
    out.push({ packaging_id: pid, name, rate_per_case: perCase, rate_per_mt: perMt })
  })
  return { bargainNo, rows: out }
}
