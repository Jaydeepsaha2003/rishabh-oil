import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { recipeTor } from './production'

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

export async function listFormulations(): Promise<Row[]> {
  // blend_pct is the input mix, which must total 100%. TOR (Total Oil
  // Required) is what actually has to go in for 100 of output — 100% plus
  // whatever the batch gives back as by-products and loses. A recipe with
  // neither has a TOR of 100%. Computed in JS (via recipeTor, shared with
  // production.ts) rather than SQL, since a blend of differing-quality raw
  // oils can carry its own TOR multiplier per input line instead of one
  // shared across the whole blend.
  const res = await getClient().execute(`
    SELECT f.*, p.name AS product_name, p.category AS product_category,
      (SELECT COUNT(*) FROM formulation_items WHERE formulation_id = f.id) AS item_count,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'input') AS blend_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'output') AS byproduct_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'loss') AS loss_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id) AS total_qty
    FROM formulations f
    LEFT JOIN products p ON p.id = f.product_id
    ORDER BY f.id DESC
  `)
  const rows = toPlain(res)
  if (!rows.length) return rows
  const itemsRes = await getClient().execute(
    `SELECT formulation_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id
     FROM formulation_items WHERE formulation_id IN (${rows.map((r) => n(r.id)).join(',')})`
  )
  const itemsByFormulation = new Map<number, Row[]>()
  for (const it of toPlain(itemsRes)) {
    const fid = n(it.formulation_id)
    if (!itemsByFormulation.has(fid)) itemsByFormulation.set(fid, [])
    itemsByFormulation.get(fid)!.push(it)
  }
  return rows.map((r) => ({ ...r, tor: recipeTor(itemsByFormulation.get(n(r.id)) || []) }))
}

export async function getFormulationItems(formulationId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT i.*, p.name AS product_name, p.category AS product_category
          FROM formulation_items i
          LEFT JOIN products p ON p.id = i.product_id
          WHERE i.formulation_id = ?
          ORDER BY i.id`,
    args: [formulationId]
  })
  return toPlain(res)
}

async function writeItems(formulationId: number, items: Row[]): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM formulation_items WHERE formulation_id = ?', args: [formulationId] })
  for (const it of items || []) {
    const pid = n(it.product_id)
    if (!pid) continue
    const kind = it.kind === 'output' || it.kind === 'loss' ? String(it.kind) : 'input'
    // The inputs behind an auto-calculated % (e.g. Fatty Acid = FFA% x (1 +
    // loss%) + moisture%) ride along with the computed qty, so the recipe
    // still explains itself next time it's opened — only kept when auto_calc
    // is actually on, never for a plain hand-typed %. An INPUT line's
    // recovered fatty acid also names which product it lands in as stock.
    const autoCalc = it.auto_calc ? 1 : 0
    await c.execute({
      sql: `INSERT INTO formulation_items (formulation_id, product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        formulationId,
        pid,
        n(it.qty),
        kind,
        autoCalc,
        autoCalc && it.ffa_pct != null && it.ffa_pct !== '' ? n(it.ffa_pct) : null,
        autoCalc && it.loss_multiplier_pct != null && it.loss_multiplier_pct !== '' ? n(it.loss_multiplier_pct) : null,
        autoCalc && it.moisture_pct != null && it.moisture_pct !== '' ? n(it.moisture_pct) : null,
        autoCalc && kind === 'input' && n(it.byproduct_product_id) ? n(it.byproduct_product_id) : null
      ]
    })
  }
}

export async function createFormulation(v: Row): Promise<{ id: number }> {
  const res = await getClient().execute({
    sql: 'INSERT INTO formulations (product_id, name, uom, active) VALUES (?, ?, ?, 1)',
    args: [n(v.product_id), v.name || null, v.uom || 'MT']
  })
  const id = Number(res.lastInsertRowid)
  await writeItems(id, v.items)
  return { id }
}

export async function updateFormulation(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE formulations SET product_id = ?, name = ?, uom = ? WHERE id = ?',
    args: [n(v.product_id), v.name || null, v.uom || 'MT', id]
  })
  await writeItems(id, v.items)
  return { id }
}

export async function deleteFormulation(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM formulation_items WHERE formulation_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM formulations WHERE id = ?', args: [id] })
  return { id }
}
