import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId, companiesOfFactory, factoryOfCompanies } from './company'
import { stockMap, productStockAvailable } from './stock'
import { visibleFromFor } from './access-gate'
// One copy of the recipe arithmetic, shared with the entry sheet in the
// renderer. It used to live only here, so the sheet previewed one set of
// numbers and this posted another.
import { expandRecipe, recipeTor } from '../renderer/src/lib/recipeMath'

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
           co.name AS company_name
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN formulations f ON f.id = p.formulation_id
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

// Create a production run: store output, then consume each formulation component
// (component % of the output qty) — this is what draws down raw/intermediate stock.
export async function createProduction(v: Row): Promise<{ id: number }> {
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
  const lines: { product_id: number; qty: number; kind: string }[] = []
  if (fid) {
    const items = await c.execute({
      sql: 'SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?',
      args: [fid]
    })
    lines.push(...expandRecipe(toPlain(items), qty))
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
    sql: `INSERT INTO production (company_id, factory_id, prod_date, product_id, qty, uom, note, formulation_id)
          VALUES (?, (SELECT factory_id FROM companies WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
    args: [getActiveCompanyId(), getActiveCompanyId(), v.prod_date, productId, qty, v.uom || 'MT', v.note || null, fid || null]
  })
  const id = Number(ins.lastInsertRowid)

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
  const cur = await c.execute({ sql: 'SELECT id FROM production WHERE id = ?', args: [n(id)] })
  if (!cur.rows.length) throw new Error('Production run not found')

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

  const lines: { product_id: number; qty: number; kind: string }[] = []
  if (fid) {
    const items = await c.execute({
      sql: 'SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?',
      args: [fid]
    })
    lines.push(...expandRecipe(toPlain(items), qty))
  }

  await c.execute({
    sql: `UPDATE production SET prod_date = ?, product_id = ?, qty = ?, uom = ?, note = ?, formulation_id = ?
           WHERE id = ?`,
    args: [v.prod_date, productId, qty, v.uom || 'MT', v.note || null, fid || null, n(id)]
  })
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
  await c.execute({ sql: 'DELETE FROM production_items WHERE production_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM production WHERE id = ?', args: [id] })
  return { id }
}
