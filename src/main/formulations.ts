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
      sc.name AS subcategory_name,
      (SELECT COUNT(*) FROM formulation_items WHERE formulation_id = f.id) AS item_count,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'input') AS blend_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'output') AS byproduct_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'loss') AS loss_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id) AS total_qty
    FROM formulations f
    LEFT JOIN products p ON p.id = f.product_id
    LEFT JOIN formulation_subcategories sc ON sc.id = f.subcategory_id
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
    sql: 'INSERT INTO formulations (product_id, name, uom, subcategory_id, active) VALUES (?, ?, ?, ?, 1)',
    args: [n(v.product_id), v.name || null, v.uom || 'MT', n(v.subcategory_id) || null]
  })
  const id = Number(res.lastInsertRowid)
  await writeItems(id, v.items)
  return { id }
}

export async function updateFormulation(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE formulations SET product_id = ?, name = ?, uom = ?, subcategory_id = ? WHERE id = ?',
    args: [n(v.product_id), v.name || null, v.uom || 'MT', n(v.subcategory_id) || null, id]
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

// The sub-categories a recipe can belong to. A managed list, so "recovered-oil" stays
// one thing rather than becoming three spellings of itself.
//
// in_use lets the manage dialog say what a name is carrying before anybody
// retires or renames it — a count is the difference between an informed change
// and a surprise.
export async function listFormulationSubcategories(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT sc.*,
      (SELECT COUNT(*) FROM formulations f WHERE f.subcategory_id = sc.id) AS in_use
    FROM formulation_subcategories sc
    ORDER BY sc.active DESC, sc.sort_order, UPPER(TRIM(sc.name))
  `)
  return toPlain(res)
}

export async function saveFormulationSubcategory(v: Row): Promise<{ id: number }> {
  const name = String(v?.name || '').trim()
  if (!name) throw new Error('Give the sub-category a name')
  const c = getClient()
  const id = n(v?.id)

  // The unique index would refuse it anyway; caught here so the message says
  // which name it collided with rather than surfacing a constraint error.
  const clash = await c.execute({
    sql: `SELECT id, name FROM formulation_subcategories
           WHERE UPPER(TRIM(name)) = UPPER(TRIM(?)) AND id <> ?`,
    args: [name, id]
  })
  if (clash.rows.length) {
    throw new Error(`"${String(clash.rows[0].name)}" already exists — one name per sub-category.`)
  }

  if (id) {
    await c.execute({
      sql: 'UPDATE formulation_subcategories SET name = ?, note = ?, active = ? WHERE id = ?',
      args: [name, v?.note ? String(v.note).trim() : null, v?.active === false ? 0 : 1, id]
    })
    return { id }
  }
  const res = await c.execute({
    sql: `INSERT INTO formulation_subcategories (name, note, sort_order, active)
          VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM formulation_subcategories), 1)`,
    args: [name, v?.note ? String(v.note).trim() : null]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Deleting a sub-category that recipes still point at would leave them classified as
// nothing, silently. Retiring it instead keeps the history readable and takes
// it out of the picker — which is what "we do not run that one any more"
// actually means.
export async function deleteFormulationSubcategory(id: number): Promise<{ id: number }> {
  const c = getClient()
  const used = await c.execute({
    sql: 'SELECT COUNT(*) AS c FROM formulations WHERE subcategory_id = ?',
    args: [n(id)]
  })
  const count = n((used.rows[0] as Row).c)
  if (count > 0) {
    throw new Error(
      `${count} ${count === 1 ? 'recipe uses' : 'recipes use'} this sub-category. Retire it instead, ` +
        'or move those recipes first — deleting it would leave them classified as nothing.'
    )
  }
  await c.execute({ sql: 'DELETE FROM formulation_subcategories WHERE id = ?', args: [n(id)] })
  return { id: n(id) }
}
