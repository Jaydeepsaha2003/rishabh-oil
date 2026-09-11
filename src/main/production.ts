import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId, companiesOfFactory, factoryOfCompanies } from './company'
import { stockMap, productStockAvailable, stockLevels } from './stock'
import { visibleFromFor } from './access-gate'
import { ppFreeByProduct, ppTotalsBothByProduct, drawPp, reversePpDraws } from './stockopenings'
// One copy of the recipe arithmetic, shared with the entry sheet in the
// renderer. It used to live only here, so the sheet previewed one set of
// numbers and this posted another.
import { expandBatchWithOutputPp, expandRecipe, expandRecipeWithPp, recipeTor } from '../renderer/src/lib/recipeMath'

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

// How much of the blend one batch needs, as a % of the output — the
// recipe-wide (uniform) TOR, shared by every input line that doesn't carry
// its own.
//
// By-product and loss percentages are taken OFF THE OIL THAT GOES IN, the way
// a refinery quotes them: 5% FFA gives 5.7% fatty acid, plus 1% dead loss, so
// 6.7% of the input never becomes product and the yield is 93.3%. Producing
// 100 MT therefore takes 100 / 0.933 = 107.18 MT, not 106.7.
//
// A recipe with no by-products and no loss comes out at exactly 100%, which is
// how every recipe behaved before any of this existed.
// Re-exported so callers already importing them from this module keep
// working; the implementations now live in lib/recipeMath.
export { expandRecipe, recipeTor }

// Which lines a batch is expanded from, and which saved version they are.
//
// `pinned` is the version the batch was RUN on. Honoured whenever it is still
// there, because a batch is a record of what happened, and re-expanding an
// old run against a recipe edited last week would rewrite what the mill
// consumed in a month that is closed. Re-expansion still happens — a
// corrected quantity has to redistribute — but against the recipe that batch
// actually used.
//
// Falling back, in order: the recipe's latest version, then its live lines
// for a recipe saved by a build that had no versions. Wrapped, because a
// database mid-upgrade must still be able to record production.
export async function recipeSnapshot(
  fid: number,
  pinned = 0
): Promise<{ versionId: number; items: Row[] }> {
  const c = getClient()
  if (!fid) return { versionId: 0, items: [] }
  const parse = (raw: unknown): Row[] => {
    try {
      const v = JSON.parse(String(raw || '[]'))
      return Array.isArray(v) ? (v as Row[]) : []
    } catch {
      return []
    }
  }
  try {
    if (pinned) {
      const v = await c.execute({
        sql: 'SELECT id, items_json FROM formulation_versions WHERE id = ? AND formulation_id = ?',
        args: [n(pinned), fid]
      })
      if (v.rows.length) return { versionId: n(v.rows[0].id), items: parse(v.rows[0].items_json) }
    }
    const latest = await c.execute({
      sql: 'SELECT id, items_json FROM formulation_versions WHERE formulation_id = ? ORDER BY version DESC LIMIT 1',
      args: [fid]
    })
    if (latest.rows.length) return { versionId: n(latest.rows[0].id), items: parse(latest.rows[0].items_json) }
  } catch {
    // No versions table yet. The live lines below are exactly what this
    // module read before versioning existed.
  }
  const items = await c.execute({
    sql: 'SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?',
    args: [fid]
  })
  return { versionId: 0, items: toPlain(items) }
}

export async function listProduction(forModule?: string): Promise<Row[]> {
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const from = await visibleFromFor('production', forModule)
  // Straight off the batch's own factory. It used to be found by asking which
  // companies belong to the site — the same answer, but indirect, and it made
  // production look like a company fact when it is a plant-floor one. Older
  // rows written before the column existed are still reached through their
  // company, so nothing disappears while a database is mid-upgrade.
  const fid = await factoryOfCompanies([getActiveCompanyId()])
  const cids = await companiesOfFactory()
  const ph = cids.map(() => '?').join(', ')
  const where = fid
    ? `(p.factory_id = ? OR (p.factory_id IS NULL AND p.company_id IN (${ph})))`
    : `p.company_id IN (${ph})`
  const scopeArgs = fid ? [fid, ...cids] : cids
  const res = await getClient().execute({
    args: from ? [...scopeArgs, from] : scopeArgs,
    sql: `
    SELECT p.*, pr.name AS product_name, pr.category AS product_category, f.name AS formulation_name,
           sc.name AS subcategory_name, f.subcategory_id,
           co.name AS company_name,
           -- Which version of the recipe this batch was run on, and whether
           -- that is still the current one. A batch costed on a superseded
           -- recipe is not wrong; it is history, and the register should be
           -- able to say so rather than leaving the reader to wonder why two
           -- runs of the same recipe consumed different amounts.
           fv.version AS recipe_version, fv.saved_at AS recipe_saved_at,
           (SELECT MAX(version) FROM formulation_versions WHERE formulation_id = p.formulation_id) AS recipe_latest_version
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN formulations f ON f.id = p.formulation_id
    LEFT JOIN formulation_versions fv ON fv.id = p.formulation_version_id
    LEFT JOIN formulation_subcategories sc ON sc.id = f.subcategory_id
    LEFT JOIN companies co ON co.id = p.company_id
    WHERE ${where}${from ? ' AND p.prod_date >= ?' : ''}
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

// ---------------------------------------------------------------------------
// The Complete Production Report.
//
// The shape the mill already keeps by hand: products across the top in their
// category bands, days down the side, and in the body what each batch
// CONSUMED of every material. Beside each batch, what it made, and the recipe
// ratio it was made on — 85:15 — with the parts named, because a bare ratio
// says nothing about which 85 and which 15.
//
// Assembled in ONE call rather than a batch list plus a fetch per batch: a
// month is 30-odd batches with five lines each, and 30 round trips through the
// IPC bridge to draw one screen is what makes a report feel broken.
//
// The opening / receiving band comes from stockLevels, not from its own SQL.
// It has to be the same figure the Book Stock register shows for the same
// period, and the only way to guarantee that is to ask the same function.
export async function productionReport(
  range?: { from?: string; to?: string },
  companyIds?: number[]
): Promise<{
  from: string
  to: string
  products: Row[]
  batches: Row[]
}> {
  const c = getClient()
  const from = String(range?.from || '')
  const to = String(range?.to || '')

  // Same factory scope listProduction uses: the batch's own factory, falling
  // back to its company for rows written before the column existed.
  const fid = await factoryOfCompanies([getActiveCompanyId()])
  const cids = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!cids.length) cids.push(...(await companiesOfFactory()))
  const ph = cids.map(() => '?').join(', ')
  const scope = fid
    ? `(p.factory_id = ? OR (p.factory_id IS NULL AND p.company_id IN (${ph})))`
    : `p.company_id IN (${ph})`
  const scopeArgs: unknown[] = fid ? [fid, ...cids] : [...cids]

  const bounds: string[] = []
  if (from) {
    bounds.push('AND p.prod_date >= ?')
    scopeArgs.push(from)
  }
  if (to) {
    bounds.push('AND p.prod_date <= ?')
    scopeArgs.push(to)
  }

  const prodRes = await c.execute({
    sql: `SELECT p.id, p.prod_date, p.qty, p.uom, p.note, p.kind, p.product_id, p.sale_id,
                 p.formulation_id, p.formulation_version_id,
                 pr.name AS product_name, pr.category AS product_category, pr.uom AS product_uom,
                 -- A formulation's own name is often null, so the recipe is
                 -- named by what it makes; the version is what the ratio is
                 -- read off, and whether it is still current is worth saying
                 -- next to a ratio somebody may be checking against today's.
                 f.name AS formulation_name,
                 fv.version AS recipe_version,
                 (SELECT MAX(version) FROM formulation_versions WHERE formulation_id = p.formulation_id)
                   AS recipe_latest_version,
                 co.name AS company_name
            FROM production p
            LEFT JOIN products pr ON pr.id = p.product_id
            LEFT JOIN formulations f ON f.id = p.formulation_id
            LEFT JOIN formulation_versions fv ON fv.id = p.formulation_version_id
            LEFT JOIN companies co ON co.id = p.company_id
           WHERE ${scope} ${bounds.join(' ')}
           ORDER BY p.prod_date, p.id`,
    args: scopeArgs as never[]
  })
  const prods = toPlain(prodRes)

  // Every line of every batch in the period, in one query. Keyed by batch so
  // the assembly below is a lookup rather than a scan per row.
  const byBatch = new Map<number, Row[]>()
  if (prods.length) {
    const ids = prods.map((x) => n(x.id))
    const iph = ids.map(() => '?').join(', ')
    const itemsRes = await c.execute({
      sql: `SELECT i.production_id, i.product_id, i.qty, i.kind,
                   pr.name AS product_name, pr.category AS product_category
              FROM production_items i
              LEFT JOIN products pr ON pr.id = i.product_id
             WHERE i.production_id IN (${iph})
             ORDER BY i.id`,
      args: ids as never[]
    })
    for (const it of toPlain(itemsRes)) {
      const k = n(it.production_id)
      const list = byBatch.get(k)
      if (list) list.push(it)
      else byBatch.set(k, [it])
    }
  }

  // The ratio, per recipe VERSION rather than per recipe — two batches of the
  // same product a month apart can honestly show different ratios, and that is
  // the whole point of pinning the version. Cached because a month of DALDA is
  // twenty batches on one version and there is no reason to read it twenty
  // times.
  const ratioCache = new Map<string, { ratio: string; parts: Row[] }>()
  const ratioFor = async (fid2: number, versionId: number): Promise<{ ratio: string; parts: Row[] }> => {
    if (!fid2) return { ratio: '', parts: [] }
    const key = `${fid2}|${versionId}`
    const hit = ratioCache.get(key)
    if (hit) return hit
    const snap = await recipeSnapshot(fid2, versionId).catch(() => ({ versionId: 0, items: [] as Row[] }))
    // Only the INPUTS carry the ratio. A loss line is a percentage of the
    // batch and a by-product line is what comes off it; neither is part of
    // "85:15", and including them turns every ratio into nonsense.
    const inputs = snap.items.filter((x) => String(x.kind || 'input') === 'input')
    const total = inputs.reduce((a, x) => a + n(x.qty), 0)
    const names = new Map<number, string>()
    if (inputs.length) {
      const pids = inputs.map((x) => n(x.product_id)).filter((x) => x > 0)
      if (pids.length) {
        const nres = await c.execute({
          sql: `SELECT id, name FROM products WHERE id IN (${pids.map(() => '?').join(', ')})`,
          args: pids as never[]
        })
        for (const r of nres.rows) names.set(n(r.id), String(r.name || ''))
      }
    }
    // 85 and 15, not 85.0 and 15.0 — the parts are whole numbers in every
    // recipe on the books, and a ratio is read, not calculated with.
    const trim = (v: number): string =>
      Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
    const parts = inputs.map((x) => ({
      product_id: n(x.product_id),
      name: names.get(n(x.product_id)) || `#${n(x.product_id)}`,
      part: n(x.qty),
      pct: total > 0 ? Math.round((n(x.qty) / total) * 10000) / 100 : 0
    }))
    const out = { ratio: parts.map((x) => trim(x.part)).join(':'), parts }
    ratioCache.set(key, out)
    return out
  }

  const batches: Row[] = []
  for (const b of prods) {
    const items = byBatch.get(n(b.id)) || []
    // Recirculation writes no lines on purpose — it is the same oil in and
    // out — so it has no ratio and no consumption. It still gets a row,
    // because the report is a record of what the plant DID and a day the
    // machine only turned over is part of that.
    const recirc = String(b.kind || 'batch') === 'recirculation'
    const { ratio, parts } = recirc
      ? { ratio: '', parts: [] as Row[] }
      : await ratioFor(n(b.formulation_id), n(b.formulation_version_id))

    // One entry per product this batch touched: what it took and what it gave
    // back. A loss line counts as consumed — dead loss leaves the floor as
    // surely as an input does.
    // `consumed` is inclusive of the loss, because that is the figure the
    // mill's own sheet totals — 131.499 consumed against 130 made is the
    // 1.499 that died. `loss` is carried separately anyway so the grid can
    // tint it and so the row can be checked: inputs = made + by-product +
    // loss, which is the identity that says a batch was entered honestly.
    const cells: Record<string, { consumed: number; produced: number; loss: number }> = {}
    const touch = (pid: number): { consumed: number; produced: number; loss: number } => {
      const k = String(pid)
      if (!cells[k]) cells[k] = { consumed: 0, produced: 0, loss: 0 }
      return cells[k]
    }
    let totalConsumed = 0
    let totalLoss = 0
    for (const it of items) {
      const kind = String(it.kind || 'input')
      const q = n(it.qty)
      const cell = touch(n(it.product_id))
      if (kind === 'output') cell.produced += q
      else {
        cell.consumed += q
        totalConsumed += q
        if (kind === 'loss') {
          cell.loss += q
          totalLoss += q
        }
      }
    }
    // The batch's own output, under its own column, so a FINISHED band cell
    // shows what was actually made that day rather than only what was eaten.
    if (!recirc) touch(n(b.product_id)).produced += n(b.qty)

    batches.push({
      id: n(b.id),
      date: String(b.prod_date || '').slice(0, 10),
      kind: String(b.kind || 'batch'),
      from_sale: !!b.sale_id,
      product_id: n(b.product_id),
      product_name: String(b.product_name || ''),
      product_category: String(b.product_category || ''),
      qty: n(b.qty),
      uom: String(b.uom || b.product_uom || 'MT'),
      note: b.note == null ? '' : String(b.note),
      company_name: String(b.company_name || ''),
      recipe_name: String(b.formulation_name || b.product_name || ''),
      recipe_version: n(b.recipe_version),
      recipe_latest_version: n(b.recipe_latest_version),
      ratio,
      ratio_parts: parts,
      total_consumed: Math.round(totalConsumed * 1000) / 1000,
      total_loss: Math.round(totalLoss * 1000) / 1000,
      cells
    })
  }

  // Columns. Every product the register knows for this period, carrying its
  // opening and receipts so the band above the grid can be drawn — and its
  // own unit, because a PCS product must never be totalled into a tonnage.
  const levels = await stockLevels({ from, to }, cids).catch(() => [] as Row[])
  const products = levels.map((r) => ({
    id: n(r.id),
    name: String(r.name || ''),
    category: String(r.category || ''),
    material_type: String(r.material_type || ''),
    uom: String(r.uom || 'MT'),
    opening: n(r.opening),
    received: n(r.received),
    produced: n(r.produced),
    consumed: n(r.consumed),
    closing: n(r.stock),
    // Whether the register carries a balance for it at all — see below.
    in_stock: true
  }))

  // A product a batch TOUCHED but the register does not carry.
  //
  // stockLevels honours "Show in stock", and DEAD LOSS is switched off there
  // for good reason — it is a hole, not a tank. But it is a real consumption
  // line on nearly every batch, so without this its cells landed in the grid
  // with no column to sit under and read as `#77`. Anything a batch consumed
  // or produced gets a column here, marked so the band above it can leave the
  // opening/receiving cells blank rather than print a misleading zero.
  const known = new Set(products.map((x) => x.id))
  const extraIds: number[] = []
  for (const b of batches) {
    for (const pid of Object.keys(b.cells as Record<string, unknown>)) {
      const id = n(pid)
      if (id && !known.has(id)) {
        known.add(id)
        extraIds.push(id)
      }
    }
  }
  if (extraIds.length) {
    const eres = await c.execute({
      sql: `SELECT id, name, category, material_type, uom FROM products
             WHERE id IN (${extraIds.map(() => '?').join(', ')})`,
      args: extraIds as never[]
    })
    for (const r of toPlain(eres)) {
      products.push({
        id: n(r.id),
        name: String(r.name || ''),
        category: String(r.category || ''),
        material_type: String(r.material_type || ''),
        uom: String(r.uom || 'MT'),
        opening: 0,
        received: 0,
        produced: 0,
        consumed: 0,
        closing: 0,
        in_stock: false
      })
    }
  }

  return { from, to, products, batches }
}

// Create a production run: store output, then consume each formulation component
// (component % of the output qty) — this is what draws down raw/intermediate stock.
// Oil put back through the plant to keep it turning, and taken off again.
//
// Not a batch, and deliberately not built like one: no recipe is resolved, no
// stock is checked, and no production_items are written. The row exists to
// SAY the plant ran — the same oil went in and came back out — and every
// stock query filters it out of Produced and Consumed alike, reporting it
// instead as the paired +N -N it is.
//
// Writing zero items rather than a matching pair is the safer of the two: a
// pair would cancel only as long as every reader adds both columns, and a
// report that reads one of them without the other would show output that was
// never made.
async function recordRecirculation(v: Row, id = 0): Promise<{ id: number }> {
  const c = getClient()
  const productId = n(v.product_id)
  const qty = n(v.qty)
  if (!productId) throw new Error('Pick the oil that was put through the machine')
  if (qty <= 0) throw new Error('Recirculated quantity must be greater than zero')
  const day = String(v.prod_date || '').slice(0, 10)
  if (day && day > new Date().toISOString().slice(0, 10)) {
    throw new Error('Recirculation cannot be dated in the future')
  }
  if (id) {
    await c.execute({
      sql: `UPDATE production
               SET prod_date = ?, product_id = ?, qty = ?, uom = ?, note = ?,
                   formulation_id = NULL, formulation_version_id = NULL
             WHERE id = ?`,
      args: [v.prod_date, productId, qty, v.uom || 'MT', v.note || null, n(id)]
    })
    // A row that used to be a batch and is being corrected to a recirculation
    // must lose the lines it drew, or the inputs stay consumed forever — PP
    // included, or a vessel this run drew from stays short after the batch
    // that drew it no longer exists.
    await reversePpDraws(n(id))
    await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [n(id)] })
    return { id: n(id) }
  }
  const ins = await c.execute({
    sql: `INSERT INTO production (company_id, factory_id, prod_date, product_id, qty, uom, note, kind)
          VALUES (?, (SELECT factory_id FROM companies WHERE id = ?), ?, ?, ?, ?, ?, 'recirculation')`,
    args: [getActiveCompanyId(), getActiveCompanyId(), v.prod_date, productId, qty, v.uom || 'MT', v.note || null]
  })
  return { id: Number(ins.lastInsertRowid) }
}

// Expand a recipe PP-aware: how much of each auto-calculated input is drawn
// from Without-FFA PP, from With-FFA PP/Raw, and the movement lines either
// way. Read-only — deciding this needs no production id yet, since it never
// writes anything; see drawPpForBatch for the part that actually does.
//
// PP is used before Raw, Without-FFA before With-FFA: Without-FFA is oil that
// has already shed its fatty acid at an earlier stage, so drawing on it costs
// nothing further, while With-FFA PP still owes the recipe's FFA loss exactly
// as Raw does. A component whose recipe line is not auto-calculated has no
// FFA of its own to split and never touches PP here, whatever the product's
// PP holds — the same behaviour expandRecipeWithPp already gives it.
async function expandRecipeForBatch(
  items: Row[],
  outputQty: number,
  outputProductId = 0
): Promise<{
  lines: { product_id: number; qty: number; kind: string }[]
  draws: { product_id: number; fromFree: number; fromFfa: number; gross: number; fattyAcid: number }[]
  ownPp: { without: number; with: number }
}> {
  const autoCalcInputs = items
    .filter((it) => String(it.kind || 'input') === 'input' && it.auto_calc)
    .map((it) => n(it.product_id))
  const freeByProduct = autoCalcInputs.length ? await ppFreeByProduct(autoCalcInputs) : {}
  // The product's OWN vessels come first — oil already made, standing part-way
  // through the plant. Only what they cannot supply is a recipe problem.
  const pools = outputProductId ? (await ppTotalsBothByProduct([outputProductId]))[outputProductId] : undefined
  const r = expandBatchWithOutputPp(items, outputQty, pools || {}, freeByProduct, outputProductId)
  return { lines: r.lines, draws: r.draws, ownPp: { without: r.plan.fromPpFree, with: r.plan.ppWithUsed } }
}

// The write half: actually take `draws` off PP, oldest vessel first (see
// stockopenings' drawPp) — called once the production row exists, since each
// draw is logged against its id for a later edit or delete to reverse.
// Whatever the FFA-bearing part could not find in With-FFA PP is left to come
// off Raw exactly as it always has — the shortage check elsewhere reads the
// combined figure and does not care which sub-bucket a draw came out of.
async function drawPpForBatch(
  productionId: number,
  draws: { product_id: number; fromFree: number; fromFfa: number }[]
): Promise<void> {
  for (const d of draws) {
    if (d.fromFree > 0.0005) await drawPp(productionId, d.product_id, 'without', d.fromFree)
    if (d.fromFfa > 0.0005) await drawPp(productionId, d.product_id, 'with', d.fromFfa)
  }
}

export async function createProduction(v: Row): Promise<{ id: number }> {
  if (String(v.kind || 'batch') === 'recirculation') return recordRecirculation(v)
  const c = getClient()
  const productId = n(v.product_id)
  const qty = n(v.qty)
  if (!productId) throw new Error('Select a product to produce')
  if (qty <= 0) throw new Error('Production quantity must be greater than zero')

  // A batch cannot be dated in the future.
  //
  // Production consumes its components from stock the moment it is saved,
  // so a forward-dated batch draws raw material out of the tanks on a day
  // that has not happened and leaves every balance between now and then
  // reading wrong. The date picker greys those days out, but that is a
  // courtesy — this is the rule, and it applies to an edit as much as to a
  // new batch, or a saved run could simply be moved forward afterwards.
  const prodDay = String(v.prod_date || '').slice(0, 10)
  if (prodDay && prodDay > new Date().toISOString().slice(0, 10)) {
    throw new Error('Production cannot be dated in the future')
  }

  // Resolve the recipe first so we can check raw/intermediate stock BEFORE
  // writing anything — production consumes each component (its % of the output).
  // A product can have more than one formulation (e.g. a CPO-based recipe and
  // a SHEA-based one for the same RPO) — the caller picks which; falling back
  // to the most recently created one when none is given keeps every existing
  // caller working unchanged.
  let fid = n(v.formulation_id)
  if (fid) {
    const owner = await c.execute({ sql: 'SELECT product_id FROM formulations WHERE id = ?', args: [fid] })
    if (!owner.rows.length || Number(owner.rows[0].product_id) !== productId) {
      throw new Error("That recipe doesn't belong to the selected product")
    }
  } else {
    const fRes = await c.execute({
      sql: 'SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1',
      args: [productId]
    })
    fid = fRes.rows.length ? Number(fRes.rows[0].id) : 0
  }
  const snap = await recipeSnapshot(fid)
  let lines: { product_id: number; qty: number; kind: string }[] = []
  let draws: { product_id: number; fromFree: number; fromFfa: number }[] = []
  // What this batch took out of the PRODUCT'S OWN vessels, drawn down after
  // the row exists so each take is logged against it and an edit can put it
  // back.
  let ownPp = { without: 0, with: 0 }
  if (fid) {
    const expanded = await expandRecipeForBatch(snap.items, qty, productId)
    lines = expanded.lines
    draws = expanded.draws
    ownPp = expanded.ownPp
  }
  const consumption = lines.filter((l) => l.kind === 'input')

  // A batch whose inputs are short is RECORDED, not refused.
  //
  // It used to throw, which sounds prudent but made the ordinary case
  // impossible: a mill entering a month of runs has no opening tank figures in
  // yet, so the first batch is always "short" and nothing can be entered at
  // all. It also contradicted the entry sheet, which shows the projected
  // shortfall before you save and says it can still be recorded.
  //
  // The shortage is not hidden — the sheet shows it in amber beforehand, the
  // Stock register shows a negative balance in red with the date it went
  // under, and it is logged here. Same reasoning as deleteProduction.
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
      console.warn(`[production] batch recorded with short inputs: ${detail}`)
    }
  }

  const ins = await c.execute({
    sql: `INSERT INTO production (company_id, factory_id, prod_date, product_id, qty, uom, note, formulation_id, formulation_version_id)
          VALUES (?, (SELECT factory_id FROM companies WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`,
    // The version is stamped now so a later edit to the recipe cannot reach
    // this batch. See recipeSnapshot.
    args: [getActiveCompanyId(), getActiveCompanyId(), v.prod_date, productId, qty, v.uom || 'MT', v.note || null, fid || null, snap.versionId || null]
  })
  const id = Number(ins.lastInsertRowid)

  if (draws.length) await drawPpForBatch(id, draws)
  // The product's own vessels, drawn after the input ones so both are logged
  // against this run and reverse together.
  if (ownPp.without > 0.0005) await drawPp(id, productId, 'without', ownPp.without)
  if (ownPp.with > 0.0005) await drawPp(id, productId, 'with', ownPp.with)

  for (const l of lines) {
    await c.execute({
      sql: 'INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)',
      args: [id, l.product_id, l.qty, l.kind]
    })
  }
  return { id }
}

// Does this product have an active formulation (recipe)? A finished good with a
// formulation is treated as made-to-order: dispatching it consumes its inputs.
// Alter a run that has already been recorded.
//
// Rebuilt rather than patched: the recipe decides every line, so a changed
// quantity or a different recipe means a new set of lines. The id is kept, so
// anything already pointing at this run still finds it.
//
// Like deleteProduction, this does NOT refuse a change that leaves a product
// short — correcting a wrongly typed batch should not require unpicking the
// dispatches behind it. The resulting shortage goes to the log, and the Stock
// register shows it in red.
export async function updateProduction(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({
    sql: "SELECT id, formulation_id, formulation_version_id, COALESCE(kind, 'batch') AS kind FROM production WHERE id = ?",
    args: [n(id)]
  })
  if (!cur.rows.length) throw new Error('Production run not found')
  // A recirculation stays a recirculation on edit unless the caller says
  // otherwise: it has no recipe to re-apply, and silently turning one back
  // into a batch would draw raw material for oil that was never made.
  const wasRecirc = String(cur.rows[0].kind) === 'recirculation'
  if (String(v.kind || (wasRecirc ? 'recirculation' : 'batch')) === 'recirculation') {
    return recordRecirculation(v, n(id))
  }
  const wasFid = n(cur.rows[0].formulation_id)
  const wasVersion = n(cur.rows[0].formulation_version_id)

  const productId = n(v.product_id)
  const qty = n(v.qty)
  if (!productId) throw new Error('Select a product to produce')
  if (qty <= 0) throw new Error('Production quantity must be greater than zero')

  // A batch cannot be dated in the future.
  //
  // Production consumes its components from stock the moment it is saved,
  // so a forward-dated batch draws raw material out of the tanks on a day
  // that has not happened and leaves every balance between now and then
  // reading wrong. The date picker greys those days out, but that is a
  // courtesy — this is the rule, and it applies to an edit as much as to a
  // new batch, or a saved run could simply be moved forward afterwards.
  const prodDay = String(v.prod_date || '').slice(0, 10)
  if (prodDay && prodDay > new Date().toISOString().slice(0, 10)) {
    throw new Error('Production cannot be dated in the future')
  }

  let fid = n(v.formulation_id)
  if (fid) {
    const owner = await c.execute({ sql: 'SELECT product_id FROM formulations WHERE id = ?', args: [fid] })
    if (!owner.rows.length || Number(owner.rows[0].product_id) !== productId) {
      throw new Error("That recipe doesn't belong to the selected product")
    }
  } else {
    const fRes = await c.execute({
      sql: 'SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1',
      args: [productId]
    })
    fid = fRes.rows.length ? Number(fRes.rows[0].id) : 0
  }

  // The version this batch was run on, unless the recipe itself has been
  // switched to a different one — that is a deliberate re-costing, and takes
  // the new recipe as it stands today.
  const snap = await recipeSnapshot(fid, fid && fid === wasFid ? wasVersion : 0)

  // Put back whatever this run drew off PP BEFORE re-expanding the recipe —
  // the vessels have to be back at their pre-this-run balance before asking
  // how much Without-FFA PP is free to draw again, or an edit that keeps the
  // same quantity would find its own earlier draw and refuse to take it a
  // second time.
  await reversePpDraws(n(id))

  let lines: { product_id: number; qty: number; kind: string }[] = []
  let draws: { product_id: number; fromFree: number; fromFfa: number }[] = []
  // What this batch took out of the PRODUCT'S OWN vessels, drawn down after
  // the row exists so each take is logged against it and an edit can put it
  // back.
  let ownPp = { without: 0, with: 0 }
  if (fid) {
    const expanded = await expandRecipeForBatch(snap.items, qty, productId)
    lines = expanded.lines
    draws = expanded.draws
    ownPp = expanded.ownPp
  }

  await c.execute({
    sql: `UPDATE production SET prod_date = ?, product_id = ?, qty = ?, uom = ?, note = ?, formulation_id = ?, formulation_version_id = ?
           WHERE id = ?`,
    args: [v.prod_date, productId, qty, v.uom || 'MT', v.note || null, fid || null, snap.versionId || null, n(id)]
  })
  if (draws.length) await drawPpForBatch(n(id), draws)
  // The product's own vessels, drawn after the input ones so both are logged
  // against this run and reverse together.
  if (ownPp.without > 0.0005) await drawPp(n(id), productId, 'without', ownPp.without)
  if (ownPp.with > 0.0005) await drawPp(n(id), productId, 'with', ownPp.with)
  await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [n(id)] })
  for (const l of lines) {
    await c.execute({
      sql: 'INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)',
      args: [n(id), l.product_id, l.qty, l.kind]
    })
  }

  const left = await productStockAvailable(productId)
  if (left < -1e-6) {
    const nameRow = await c.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [productId] })
    console.warn(
      `[production] run ${id} altered — ${String(nameRow.rows[0]?.name || 'product')} is now short by ` +
        `${(Math.round(-left * 1000) / 1000).toFixed(3)}.`
    )
  }
  return { id: n(id) }
}

export async function productHasFormulation(productId: number): Promise<boolean> {
  const r = await getClient().execute({
    sql: 'SELECT 1 FROM formulations WHERE product_id = ? AND active = 1 LIMIT 1',
    args: [productId]
  })
  return r.rows.length > 0
}

// Resolve a product's active formulation into absolute component quantities for
// a given output qty (formulation_items.qty is a PERCENTAGE of the output).
// Empty when the product has no active formulation.
export async function formulationConsumption(
  productId: number,
  qty: number
): Promise<{ product_id: number; qty: number; kind: string }[]> {
  const c = getClient()
  const fRes = await c.execute({
    sql: 'SELECT id FROM formulations WHERE product_id = ? AND active = 1 ORDER BY id DESC LIMIT 1',
    args: [productId]
  })
  if (!fRes.rows.length) return []
  const items = await c.execute({
    sql: 'SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?',
    args: [Number(fRes.rows[0].id)]
  })
  // Every line comes back with what it is, so callers can draw the inputs and
  // still post the by-products the batch throws off.
  return expandRecipe(toPlain(items), qty)
}

// Remove the auto-production(s) linked to a sale (used when a dispatch is
// reversed, edited or deleted). Bypasses the manual-delete guard on purpose.
export async function deleteSaleProductions(saleId: number): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM production_items WHERE production_id IN (SELECT id FROM production WHERE sale_id = ?)',
    args: [saleId]
  })
  await c.execute({ sql: 'DELETE FROM production WHERE sale_id = ?', args: [saleId] })
}

// (Re)create the auto-production for a dispatched sale: consumes the finished
// product's formulation inputs and outputs the dispatched qty. No stock guard
// here — the caller decides whether to enforce raw availability. A no-op when
// the product has no formulation.
export async function createSaleProduction(
  saleId: number,
  productId: number,
  qty: number,
  prodDate: string,
  uom: string
): Promise<void> {
  const c = getClient()
  await deleteSaleProductions(saleId)
  const consumption = await formulationConsumption(productId, qty)
  if (!consumption.length) return
  const ins = await c.execute({
    sql: `INSERT INTO production (company_id, factory_id, prod_date, product_id, qty, uom, note, sale_id)
          VALUES (?, (SELECT factory_id FROM companies WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
    args: [getActiveCompanyId(), getActiveCompanyId(), prodDate, productId, qty, uom || 'MT', 'Auto — finished dispatch', saleId]
  })
  const id = Number(ins.lastInsertRowid)
  for (const cn of consumption) {
    await c.execute({
      sql: 'INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)',
      args: [id, cn.product_id, cn.qty, cn.kind]
    })
  }
}

export async function deleteProduction(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT product_id FROM production WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const productId = Number(cur.rows[0].product_id)
  // Deleting a run is ALLOWED even when it leaves the product short.
  //
  // It used to be refused whenever the output had already been dispatched or
  // eaten by a later batch, which is the common case while a month's runs are
  // still being entered: a wrongly typed batch could not be taken out until
  // every dispatch behind it was reversed first. Correcting an entry should
  // not require unpicking the documents downstream of it.
  //
  // What the shortage becomes is written to the log, and the Stock register
  // shows a negative balance in red with the date it went under — so the
  // consequence stays visible instead of being enforced here.
  const without = await productStockAvailable(productId, { excludeProductionId: id })
  if (without < -1e-6) {
    const nameRow = await c.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [productId] })
    const label = String(nameRow.rows[0]?.name || 'product')
    console.warn(
      `[production] run ${id} deleted — ${label} is now short by ${(Math.round(-without * 1000) / 1000).toFixed(3)}. ` +
        'Enter the missing production or the opening stock to clear it.'
    )
  }
  // Put back whatever this run drew off PP — a deleted run means the oil was
  // never actually taken, so the vessel it came from has to read as if it
  // never had been.
  await reversePpDraws(id)
  await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM production WHERE id = ?', args: [id] })
  return { id }
}
