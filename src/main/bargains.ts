import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// bargains/orders still carry a foreign key to the legacy oil_types table, but
// the app now picks oils from products. Mirror the product row into oil_types
// (same id) so the FK is satisfied for any product chosen.
export async function ensureOilType(productId: number): Promise<void> {
  if (!productId) return
  await getClient().execute({
    sql: `INSERT OR IGNORE INTO oil_types (id, code, name, active)
          SELECT id, COALESCE(code, name, 'GEN'), COALESCE(name, code, 'PRODUCT'), 1
          FROM products WHERE id = ?`,
    args: [productId]
  })
}

// "DD-MM" from an ISO date string. e.g. 2025-06-13 -> "13-06".
function dayMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (m) return `${m[3]}-${m[2]}`
  const d = new Date(dateStr)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function listBargains(): Promise<Row[]> {
  // loaded_qty = total dispatched across this bargain's orders; balance = qty − loaded.
  const res = await getClient().execute({
    sql: `
    SELECT b.*, s.name AS supplier_name, s.supplier_type AS supplier_type,
           br.name AS broker_name,
           o.code AS oil_code, o.name AS oil_name,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0) AS loaded_qty,
           b.qty
             - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
             - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0) AS balance_qty
    FROM bargains b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN products o ON o.id = b.oil_type_id
    LEFT JOIN brokers br ON br.id = b.broker_id
    WHERE b.company_id = ?
    ORDER BY b.id DESC
  `,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

// Format: OIL/DD-MM/PARTYNAME(no spaces, upper)/SERIAL.
// Serial is a continuous running number across all bargains.
async function nextBargainNo(
  oilTypeId: number,
  supplierId: number,
  bargainDate: string
): Promise<string> {
  const c = getClient()
  const oilRes = await c.execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [oilTypeId]
  })
  const oil = (
    oilRes.rows.length ? String(oilRes.rows[0].code || oilRes.rows[0].name || 'OIL') : 'OIL'
  )
    .replace(/\s+/g, '')
    .toUpperCase()

  const supRes = await c.execute({
    sql: 'SELECT name FROM suppliers WHERE id = ?',
    args: [supplierId]
  })
  const party = (supRes.rows.length ? String(supRes.rows[0].name || 'PARTY') : 'PARTY')
    .replace(/\s+/g, '')
    .toUpperCase()

  // Serial resets every calendar month PER COMPANY: max trailing serial among
  // this company's bargains in the month + 1, two-digit padded.
  const monthKey = String(bargainDate).slice(0, 7) // yyyy-mm
  const existing = await c.execute({
    sql: 'SELECT bargain_no FROM bargains WHERE substr(bargain_date, 1, 7) = ? AND company_id = ?',
    args: [monthKey, getActiveCompanyId()]
  })
  let maxSeq = 0
  for (const r of existing.rows) {
    const parts = String(r.bargain_no).split('/')
    const n = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(n) && n > maxSeq) maxSeq = n
  }
  const serial = String(maxSeq + 1).padStart(2, '0')
  return `${oil}/${dayMonth(bargainDate)}/${party}/${serial}`
}

// Bargain (landed) rate = base rate (ex duty) + customs duty.
function landedRate(v: Row): number {
  return (Number(v.base_rate) || 0) + (Number(v.duty) || 0)
}

export async function createBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  const qty = Number(v.qty) || 0
  const rate = landedRate(v)
  const total = qty * rate
  const bargain_no = await nextBargainNo(
    Number(v.oil_type_id),
    Number(v.supplier_id),
    String(v.bargain_date)
  )
  // The legacy oil_types FK is still enforced; mirror the chosen product into it.
  await ensureOilType(Number(v.oil_type_id))
  const res = await getClient().execute({
    sql: `INSERT INTO bargains
      (company_id, bargain_no, bargain_date, supplier_id, broker_id, oil_type_id, bargain_type, qty, opening_qty, uom,
       base_rate, duty, rate_per_uom, allowed_shortage_pct, rate_expiry_date, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || 'EX',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'MT',
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
  await ensureOilType(Number(v.oil_type_id))
  await getClient().execute({
    sql: `UPDATE bargains SET
      bargain_date = ?, supplier_id = ?, broker_id = ?, oil_type_id = ?, bargain_type = ?,
      qty = ?, opening_qty = ?, uom = ?, base_rate = ?, duty = ?, rate_per_uom = ?,
      allowed_shortage_pct = ?, rate_expiry_date = ?, total_amount = ?
      WHERE id = ?`,
    args: [
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || 'EX',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'MT',
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
  const c = getClient()
  // Block deletion if any purchase invoice is linked (it carries financial data).
  const ord = await c.execute({
    sql: 'SELECT COUNT(*) AS n FROM orders WHERE bargain_id = ?',
    args: [id]
  })
  if (Number(ord.rows[0].n) > 0) {
    throw new Error('This bargain has purchases linked to it. Delete those purchases first.')
  }
  // Clean up loose tankers (and their gate entries) before removing the bargain,
  // otherwise the foreign-key constraints reject the delete.
  await c.execute({
    sql: 'DELETE FROM gate_entries WHERE tanker_id IN (SELECT id FROM purchase_tankers WHERE bargain_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM purchase_tankers WHERE bargain_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bargains WHERE id = ?', args: [id] })
  return { id }
}
