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

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export async function listProduction(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT p.*, pr.name AS product_name, pr.category AS product_category
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    ORDER BY p.prod_date DESC, p.id DESC
  `)
  return toPlain(res)
}

export async function getProductionItems(productionId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT i.*, pr.name AS product_name, pr.category AS product_category
          FROM production_items i
          LEFT JOIN products pr ON pr.id = i.product_id
          WHERE i.production_id = ?
          ORDER BY i.id`,
    args: [productionId]
  })
  return toPlain(res)
}

// Create a production run: store output, then consume each formulation component
// (component % of the output qty) — this is what draws down raw/intermediate stock.
export async function createProduction(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const productId = n(v.product_id)
  const qty = n(v.qty)

  const ins = await c.execute({
    sql: 'INSERT INTO production (prod_date, product_id, qty, uom, note) VALUES (?, ?, ?, ?, ?)',
    args: [v.prod_date, productId, qty, v.uom || 'ton', v.note || null]
  })
  const id = Number(ins.lastInsertRowid)

  // Find the product's formulation and record consumption.
  const fRes = await c.execute({
    sql: 'SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1',
    args: [productId]
  })
  if (fRes.rows.length) {
    const fid = Number(fRes.rows[0].id)
    const items = await c.execute({
      sql: 'SELECT product_id, qty FROM formulation_items WHERE formulation_id = ?',
      args: [fid]
    })
    for (const it of items.rows) {
      const consume = (qty * n(it.qty)) / 100
      await c.execute({
        sql: 'INSERT INTO production_items (production_id, product_id, qty) VALUES (?, ?, ?)',
        args: [id, Number(it.product_id), consume]
      })
    }
  }
  return { id }
}

export async function deleteProduction(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM production WHERE id = ?', args: [id] })
  return { id }
}
