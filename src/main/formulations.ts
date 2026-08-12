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

export async function listFormulations(): Promise<Row[]> {
  // blend_pct is the input mix, which must total 100%. TOR (Total Oil
  // Required) is what actually has to go in for 100 of output — 100% plus
  // whatever the batch gives back as by-products and loses. A recipe with
  // neither has a TOR of 100%.
  const res = await getClient().execute(`
    SELECT f.*, p.name AS product_name, p.category AS product_category,
      (SELECT COUNT(*) FROM formulation_items WHERE formulation_id = f.id) AS item_count,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'input') AS blend_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'output') AS byproduct_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'loss') AS loss_pct,
      -- TOR: by-products and loss come off the oil going in, so the yield is
      -- (100 − their total)% and the requirement is 100 ÷ that yield.
      -- 5.7% fatty + 1% loss -> 100/0.933 = 107.18%.
      CASE
        WHEN (SELECT COALESCE(SUM(qty), 0) FROM formulation_items
              WHERE formulation_id = f.id AND kind IN ('output', 'loss')) BETWEEN 0.000001 AND 99.999999
        THEN 10000.0 / (100 - (SELECT COALESCE(SUM(qty), 0) FROM formulation_items
                               WHERE formulation_id = f.id AND kind IN ('output', 'loss')))
        ELSE 100
      END AS tor,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id) AS total_qty
    FROM formulations f
    LEFT JOIN products p ON p.id = f.product_id
    ORDER BY f.id DESC
  `)
  return toPlain(res)
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
    await c.execute({
      sql: 'INSERT INTO formulation_items (formulation_id, product_id, qty, kind) VALUES (?, ?, ?, ?)',
      args: [formulationId, pid, n(it.qty), kind]
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
