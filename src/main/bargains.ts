import type { ResultSet } from '@libsql/client'
import { getClient } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// Indian financial year (Apr–Mar). e.g. 2025-06-13 -> "25-26".
function financialYear(dateStr: string): string {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const startYear = m >= 4 ? y : y - 1
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`
}

export async function listBargains(): Promise<Row[]> {
  // loaded_qty = total dispatched across this bargain's orders; balance = qty − loaded.
  const res = await getClient().execute(`
    SELECT b.*, s.name AS supplier_name, o.code AS oil_code, o.name AS oil_name,
           COALESCE((SELECT SUM(ordered_qty) FROM orders WHERE bargain_id = b.id), 0) AS loaded_qty,
           b.qty - COALESCE((SELECT SUM(ordered_qty) FROM orders WHERE bargain_id = b.id), 0) AS balance_qty
    FROM bargains b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN products o ON o.id = b.oil_type_id
    ORDER BY b.id DESC
  `)
  return toPlain(res)
}

async function nextBargainNo(oilTypeId: number, bargainDate: string): Promise<string> {
  const c = getClient()
  const oilRes = await c.execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [oilTypeId]
  })
  const code = oilRes.rows.length
    ? String(oilRes.rows[0].code || oilRes.rows[0].name || 'GEN')
    : 'GEN'
  const prefix = `${code}/${financialYear(bargainDate)}/`
  const existing = await c.execute({
    sql: 'SELECT bargain_no FROM bargains WHERE bargain_no LIKE ?',
    args: [`${prefix}%`]
  })
  let maxSeq = 0
  for (const r of existing.rows) {
    const n = parseInt(String(r.bargain_no).split('/')[2] ?? '0', 10)
    if (!Number.isNaN(n) && n > maxSeq) maxSeq = n
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`
}

// Bargain (landed) rate = base rate (ex duty) + customs duty.
function landedRate(v: Row): number {
  return (Number(v.base_rate) || 0) + (Number(v.duty) || 0)
}

export async function createBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  const qty = Number(v.qty) || 0
  const rate = landedRate(v)
  const total = qty * rate
  const bargain_no = await nextBargainNo(Number(v.oil_type_id), String(v.bargain_date))
  const res = await getClient().execute({
    sql: `INSERT INTO bargains
      (bargain_no, bargain_date, supplier_id, oil_type_id, bargain_type, qty, opening_qty, uom,
       base_rate, duty, rate_per_uom, allowed_shortage_pct, rate_expiry_date, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      Number(v.oil_type_id),
      v.bargain_type || 'Ex',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'ton',
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== ''
        ? Number(v.allowed_shortage_pct)
        : null,
      v.rate_expiry_date || null,
      total
    ]
  })
  return { id: Number(res.lastInsertRowid), bargain_no }
}

export async function updateBargain(id: number, v: Row): Promise<{ id: number }> {
  const qty = Number(v.qty) || 0
  const rate = landedRate(v)
  const total = qty * rate
  await getClient().execute({
    sql: `UPDATE bargains SET
      bargain_date = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      qty = ?, opening_qty = ?, uom = ?, base_rate = ?, duty = ?, rate_per_uom = ?,
      allowed_shortage_pct = ?, rate_expiry_date = ?, total_amount = ?
      WHERE id = ?`,
    args: [
      v.bargain_date,
      Number(v.supplier_id),
      Number(v.oil_type_id),
      v.bargain_type || 'Ex',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'ton',
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== ''
        ? Number(v.allowed_shortage_pct)
        : null,
      v.rate_expiry_date || null,
      total,
      id
    ]
  })
  return { id }
}

export async function deleteBargain(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM bargains WHERE id = ?', args: [id] })
  return { id }
}
