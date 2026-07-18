import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const k of res.columns) o[k] = (r as Row)[k]
    return o
  })
}

const n = (v: unknown): number => Number(v) || 0

// Total consignment qty already drawn into the books for a supplier+product in
// the active company — i.e. booked via consignment purchase invoices.
async function invoicedMap(companyId: number): Promise<Map<string, number>> {
  const res = await getClient().execute({
    sql: `SELECT supplier_id, oil_type_id AS product_id, COALESCE(SUM(ordered_qty), 0) AS q
          FROM orders WHERE company_id = ? AND is_consignment = 1
          GROUP BY supplier_id, oil_type_id`,
    args: [companyId]
  })
  const m = new Map<string, number>()
  for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
  return m
}

// Consigned qty still lying at our place (deposited − invoiced) for a
// supplier+product in the active company.
export async function consignmentAvailable(supplierId: number, productId: number): Promise<number> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const dep = await c.execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?',
    args: [cid, supplierId, productId]
  })
  const inv = await c.execute({
    sql: 'SELECT COALESCE(SUM(ordered_qty), 0) AS q FROM orders WHERE company_id = ? AND is_consignment = 1 AND supplier_id = ? AND oil_type_id = ?',
    args: [cid, supplierId, productId]
  })
  return n(dep.rows[0]?.q) - n(inv.rows[0]?.q)
}

// Individual deposit lots for the active company.
export async function listConsignment(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT cs.*, s.name AS supplier_name, p.code AS product_code, p.name AS product_name
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?
          ORDER BY cs.id DESC`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

// Consigned stock rolled up per supplier+product: deposited, invoiced, balance.
export async function consignmentSummary(): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const dep = await getClient().execute({
    sql: `SELECT cs.supplier_id, cs.product_id, cs.uom,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 SUM(cs.qty) AS deposited
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?
          GROUP BY cs.supplier_id, cs.product_id`,
    args: [cid]
  })
  const inv = await invoicedMap(cid)
  return toPlain(dep).map((d) => {
    const invoiced = inv.get(`${d.supplier_id}:${d.product_id}`) || 0
    return { ...d, invoiced, balance: n(d.deposited) - invoiced }
  })
}

export async function createConsignment(v: Row): Promise<{ id: number }> {
  if (!v.supplier_id || !v.product_id) throw new Error('Supplier and product are required')
  if (n(v.qty) <= 0) throw new Error('Quantity must be greater than zero')
  const res = await getClient().execute({
    sql: `INSERT INTO consignment_stock (company_id, supplier_id, product_id, qty, uom, deposit_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      n(v.supplier_id),
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      v.deposit_date,
      v.note ? String(v.note).trim() : null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Editing a lot can't drop the supplier+product's deposited total below what
// has already been invoiced from it.
export async function updateConsignment(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Consignment entry not found')
  const row = cur.rows[0]
  const newQty = n(v.qty)
  if (newQty <= 0) throw new Error('Quantity must be greater than zero')
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  // available already reflects the current qty; adding the delta must stay ≥ 0
  if (avail + (newQty - n(row.qty)) < -1e-6) {
    throw new Error('Cannot reduce below the quantity already invoiced from this stock')
  }
  await c.execute({
    sql: `UPDATE consignment_stock SET qty = ?, uom = ?, deposit_date = ?, note = ? WHERE id = ?`,
    args: [newQty, v.uom || 'MT', v.deposit_date, v.note ? String(v.note).trim() : null, id]
  })
  return { id }
}

export async function deleteConsignment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const row = cur.rows[0]
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  // Removing this lot drops availability by its qty; it can't go negative.
  if (avail - n(row.qty) < -1e-6) {
    throw new Error('Cannot delete — part of this stock has already been invoiced')
  }
  await c.execute({ sql: 'DELETE FROM consignment_stock WHERE id = ?', args: [id] })
  return { id }
}
