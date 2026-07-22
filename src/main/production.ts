import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { stockMap, productStockAvailable } from './stock'

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
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT p.*, pr.name AS product_name, pr.category AS product_category
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.company_id = ?
    ORDER BY p.prod_date DESC, p.id DESC
  `
  })
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
  if (!productId) throw new Error('Select a product to produce')
  if (qty <= 0) throw new Error('Production quantity must be greater than zero')

  // Resolve the recipe first so we can check raw/intermediate stock BEFORE
  // writing anything — production consumes each component (its % of the output).
  const fRes = await c.execute({
    sql: 'SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1',
    args: [productId]
  })
  const consumption: { product_id: number; qty: number }[] = []
  if (fRes.rows.length) {
    const fid = Number(fRes.rows[0].id)
    const items = await c.execute({
      sql: 'SELECT product_id, qty FROM formulation_items WHERE formulation_id = ?',
      args: [fid]
    })
    for (const it of items.rows) {
      consumption.push({ product_id: Number(it.product_id), qty: (qty * n(it.qty)) / 100 })
    }
  }

  // Block production that would drive any component's stock negative.
  if (consumption.length) {
    const [levels, names] = await Promise.all([
      stockMap(),
      c.execute('SELECT id, name FROM products')
    ])
    const nameOf = new Map<number, string>()
    for (const r of names.rows) nameOf.set(Number(r.id), String(r.name || ''))
    const short = consumption
      .map((cn) => ({ ...cn, avail: levels[cn.product_id] || 0 }))
      .filter((cn) => cn.qty > cn.avail + 1e-6)
    if (short.length) {
      const detail = short
        .map((s) => `${nameOf.get(s.product_id) || 'component'} (need ${s.qty.toFixed(3)}, have ${Math.max(s.avail, 0).toFixed(3)})`)
        .join('; ')
      throw new Error(`Not enough input stock to produce this batch: ${detail}. Produce or purchase those first.`)
    }
  }

  const ins = await c.execute({
    sql: 'INSERT INTO production (company_id, prod_date, product_id, qty, uom, note) VALUES (?, ?, ?, ?, ?, ?)',
    args: [getActiveCompanyId(), v.prod_date, productId, qty, v.uom || 'MT', v.note || null]
  })
  const id = Number(ins.lastInsertRowid)

  for (const cn of consumption) {
    await c.execute({
      sql: 'INSERT INTO production_items (production_id, product_id, qty) VALUES (?, ?, ?)',
      args: [id, cn.product_id, cn.qty]
    })
  }
  return { id }
}

export async function deleteProduction(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT product_id FROM production WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const productId = Number(cur.rows[0].product_id)
  // Removing this run takes its output back out of stock. If the output has
  // since been sold or consumed by a later production, that would go negative.
  // (Reversing the consumption only adds raw stock back, so it's always safe.)
  const without = await productStockAvailable(productId, { excludeProductionId: id })
  if (without < -1e-6) {
    throw new Error(
      "Can't delete this production — its output has already been sold or used in a later batch. Reverse those first."
    )
  }
  await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM production WHERE id = ?', args: [id] })
  return { id }
}
