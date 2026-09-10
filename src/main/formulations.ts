import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getCurrentUser } from './currentUser'
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

// The local clock, to the second.
//
// NOT SQLite's datetime('now'), which is always UTC whatever the process
// timezone is — the same trap that stamped gate entries 09:53 IST as 04:23
// and put anything entered before 05:30 on the day before. "Edited at" is a
// human fact and has to read in the mill's own time.
function nowStamp(): string {
  const d = new Date()
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// One line of a recipe, reduced to the fields that decide what a batch
// consumes. Anything else about the row — its id, the order it was typed in —
// is not part of what makes two versions the same recipe.
function itemShape(it: Row): Row {
  return {
    product_id: n(it.product_id),
    qty: n(it.qty),
    kind: it.kind === 'output' || it.kind === 'loss' ? String(it.kind) : 'input',
    auto_calc: it.auto_calc ? 1 : 0,
    ffa_pct: it.ffa_pct == null || it.ffa_pct === '' ? null : n(it.ffa_pct),
    loss_multiplier_pct:
      it.loss_multiplier_pct == null || it.loss_multiplier_pct === '' ? null : n(it.loss_multiplier_pct),
    moisture_pct: it.moisture_pct == null || it.moisture_pct === '' ? null : n(it.moisture_pct),
    byproduct_product_id: n(it.byproduct_product_id) || null
  }
}

// Keep a copy of the recipe as it now stands, and stamp the header with when
// and by whom.
//
// Skipped when nothing actually changed: opening a recipe to look at it and
// pressing Save should not mint a version, or the history becomes a list of
// people who pressed a button and the one edit that mattered is lost in it.
// The header counts as part of the recipe here — renaming it or moving it to
// another sub-category is a change worth a line in the history, even though
// it consumes nothing different.
async function snapshotFormulation(formulationId: number, note: string): Promise<number | null> {
  const c = getClient()
  const id = n(formulationId)
  if (!id) return null
  const head = await c.execute({ sql: 'SELECT * FROM formulations WHERE id = ?', args: [id] })
  if (!head.rows.length) return null
  const f = toPlain(head)[0]
  const items = await c.execute({
    sql: `SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id
          FROM formulation_items WHERE formulation_id = ? ORDER BY id`,
    args: [id]
  })
  const shaped = toPlain(items).map(itemShape)
  const json = JSON.stringify(shaped)
  const fingerprint = JSON.stringify({
    p: n(f.product_id),
    nm: String(f.name || ''),
    u: String(f.uom || ''),
    s: n(f.subcategory_id),
    i: shaped
  })

  const last = await c.execute({
    sql: 'SELECT id, version, fingerprint FROM formulation_versions WHERE formulation_id = ? ORDER BY version DESC LIMIT 1',
    args: [id]
  })
  if (last.rows.length && String(last.rows[0].fingerprint) === fingerprint) {
    return Number(last.rows[0].id)
  }

  const version = last.rows.length ? Number(last.rows[0].version) + 1 : 1
  const who = getCurrentUser().username || 'system'
  const at = nowStamp()
  const res = await c.execute({
    sql: `INSERT INTO formulation_versions
            (formulation_id, version, saved_at, saved_by, product_id, name, uom, subcategory_id, items_json, fingerprint, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, version, at, who, n(f.product_id), f.name ?? null, f.uom ?? null, n(f.subcategory_id) || null, json, fingerprint, note || null]
  })
  await c.execute({
    sql: 'UPDATE formulations SET updated_at = ?, updated_by = ? WHERE id = ?',
    args: [at, who, id]
  })
  return Number(res.lastInsertRowid)
}

// The edit history of one recipe, newest first, with what each version cost
// per 100 of output so two of them can be compared without reading the JSON.
//
// runs is why this matters: a version with batches behind it is history, and
// editing the recipe again cannot reach them.
export async function listFormulationVersions(formulationId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT v.id, v.version, v.saved_at, v.saved_by, v.name, v.uom, v.note, v.items_json,
                 (SELECT COUNT(*) FROM production p WHERE p.formulation_version_id = v.id) AS runs
            FROM formulation_versions v
           WHERE v.formulation_id = ?
           ORDER BY v.version DESC`,
    args: [n(formulationId)]
  })
  return toPlain(res).map((v) => {
    let items: Row[] = []
    try {
      items = JSON.parse(String(v.items_json || '[]')) as Row[]
    } catch {
      items = []
    }
    // items_json is not handed to the UI — it is the machine's copy, and a
    // recipe's worth of JSON in every row of a history list is noise.
    const { items_json: _drop, ...rest } = v
    return { ...rest, tor: recipeTor(items), lines: items.length }
  })
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
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id) AS total_qty,
      -- When this recipe was last changed, and how many versions of it there
      -- have been. A recipe that has never been edited shows one version and
      -- no edit stamp, which is the honest answer rather than a made-up one.
      (SELECT COUNT(*) FROM formulation_versions v WHERE v.formulation_id = f.id) AS version_count,
      (SELECT COUNT(*) FROM production p WHERE p.formulation_id = f.id) AS run_count
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
  await snapshotFormulation(id, 'Recipe created')
  return { id }
}

export async function updateFormulation(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE formulations SET product_id = ?, name = ?, uom = ?, subcategory_id = ? WHERE id = ?',
    args: [n(v.product_id), v.name || null, v.uom || 'MT', n(v.subcategory_id) || null, id]
  })
  await writeItems(id, v.items)
  // After the lines are written, so the copy is of what was actually saved
  // rather than of what was asked for.
  await snapshotFormulation(id, String(v.change_note || '').trim() || 'Recipe edited')
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
