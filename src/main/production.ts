import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { stockMap, productStockAvailable } from './stock'
import { visibleFromFor } from './access-gate'

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
function uniformRecipeTor(items: Row[]): number {
  const kindOf = (it: Row): string => String(it.kind || 'input')
  const sum = (kind: string): number =>
    items.filter((it) => kindOf(it) === kind).reduce((s, it) => s + n(it.qty), 0)
  const lossPct = sum('output') + sum('loss')
  // A recipe claiming to lose everything (or more) has no sane answer; leave
  // it at 100% rather than dividing by zero or going negative.
  if (lossPct <= 0 || lossPct >= 100) return 100
  return (100 * 100) / (100 - lossPct)
}

// A single input's own fatty-acid loss — FFA% x (1 + loss multiplier%) +
// moisture% — as a % of THAT INPUT's own quantity, not of the output.
function inputFattyAcidPct(it: Row): number {
  const ffa = n(it.ffa_pct)
  const lossMultiplier = n(it.loss_multiplier_pct)
  const moisture = n(it.moisture_pct)
  return ffa * (1 + lossMultiplier / 100) + moisture
}

// A single input's OWN TOR multiplier, when a blend mixes raw oils of
// differing quality and each needs its own answer rather than one shared
// across the whole blend — e.g. SHEA at 23% FFA needs far more raw material
// per unit of output than RPS at 0.15% FFA does. Dead loss is NOT per-input —
// it's the recipe's own shared 'loss' line total, the same standing
// assumption for every ingredient (see sharedDeadLossPct below).
// multiplier = 1 / (1 - (FFA% x (1 + loss multiplier%) + moisture%) - dead loss%)
function inputTorMultiplier(it: Row, sharedDeadLossPct: number): number {
  const yieldPct = 100 - inputFattyAcidPct(it) - sharedDeadLossPct
  // No sane answer if this ingredient claims to lose everything (or more).
  if (yieldPct <= 0) return 1
  return 100 / yieldPct
}

// The recipe's total oil required, per 100 of output. When every input shares
// one recipe-wide loss (the original model), this is exactly the uniform
// TOR. When one or more inputs carry their own auto-calculated multiplier
// (a blend of differing-quality raw oils), each of those takes its own share
// x its own multiplier instead of the shared one, and the total is the sum —
// a recipe with no such inputs collapses back to the plain uniform figure.
export function recipeTor(items: Row[]): number {
  const kindOf = (it: Row): string => String(it.kind || 'input')
  const inputs = items.filter((it) => kindOf(it) === 'input')
  const blend = inputs.reduce((s, it) => s + n(it.qty), 0)
  const uniformTor = uniformRecipeTor(items)
  if (blend <= 0) return uniformTor
  const sharedDeadLossPct = items.filter((it) => kindOf(it) === 'loss').reduce((s, it) => s + n(it.qty), 0)
  const total = inputs.reduce((s, it) => {
    const mult = it.auto_calc ? inputTorMultiplier(it, sharedDeadLossPct) : uniformTor / 100
    return s + n(it.qty) * mult
  }, 0)
  return total
}

// Turn a recipe into the real quantities for one batch. Input lines are shares
// of the blend and total 100% (100% CPO, or 70/30 of two oils); each takes its
// own share x its own TOR multiplier when it has one (see recipeTor above),
// or the recipe's shared multiplier otherwise. By-products and loss are
// percentages of the input, riding on the recipe's shared multiplier either way.
//
// The fatty acid an auto-calculated input throws off is a REAL by-product,
// not just a yield reduction — whichever product that input names
// (byproduct_product_id) gets a synthetic output line for it, merged by
// product with anything else already landing there (a manual by-product line
// pointing at the same product, or another input recovering into it too).
export function expandRecipe(
  items: Row[],
  outputQty: number
): { product_id: number; qty: number; kind: string }[] {
  const kindOf = (it: Row): string => String(it.kind || 'input')
  const blend = items
    .filter((it) => kindOf(it) === 'input')
    .reduce((s, it) => s + n(it.qty), 0)
  const uniformTor = uniformRecipeTor(items)
  // A loss or manual by-product line is a % OF THE INPUT, so it has to ride
  // on what the recipe ACTUALLY draws in — recipeTor, not the uniform
  // figure. Those two only coincide when no input carries its own
  // auto-calculated multiplier; once one does (a blend of differing-quality
  // raw oils), uniformTor is the wrong, smaller number and understates the
  // loss (e.g. 1.01% instead of the correct 1.2375 on a 123.75% TOR).
  const tor = recipeTor(items)
  const sharedDeadLossPct = items.filter((it) => kindOf(it) === 'loss').reduce((s, it) => s + n(it.qty), 0)

  const lines = items.map((it) => {
    const kind = kindOf(it)
    let pct: number
    if (kind === 'input') {
      // Guard a malformed recipe whose blend doesn't total 100 — scale by the
      // share it actually has rather than dividing by zero.
      const mult = it.auto_calc ? inputTorMultiplier(it, sharedDeadLossPct) : uniformTor / 100
      pct = blend > 0 ? n(it.qty) * mult : 0
    } else {
      // Off the input, so it rides on the recipe's real total TOR.
      pct = (tor * n(it.qty)) / 100
    }
    return { product_id: Number(it.product_id), qty: (outputQty * pct) / 100, kind }
  })

  const byproductAdds = new Map<number, number>()
  for (const it of items) {
    if (kindOf(it) !== 'input' || !it.auto_calc || !n(it.byproduct_product_id)) continue
    const mult = inputTorMultiplier(it, sharedDeadLossPct)
    const pct = blend > 0 ? n(it.qty) * mult : 0
    const inputQty = (outputQty * pct) / 100
    const fattyAcidQty = (inputQty * inputFattyAcidPct(it)) / 100
    const pid = n(it.byproduct_product_id)
    byproductAdds.set(pid, (byproductAdds.get(pid) || 0) + fattyAcidQty)
  }
  for (const [pid, qty] of byproductAdds) {
    const existing = lines.find((l) => l.kind === 'output' && l.product_id === pid)
    if (existing) existing.qty += qty
    else lines.push({ product_id: pid, qty, kind: 'output' })
  }
  return lines
}

export async function listProduction(forModule?: string): Promise<Row[]> {
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const from = await visibleFromFor('production', forModule)
  const res = await getClient().execute({
    args: from ? [getActiveCompanyId(), from] : [getActiveCompanyId()],
    sql: `
    SELECT p.*, pr.name AS product_name, pr.category AS product_category, f.name AS formulation_name
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN formulations f ON f.id = p.formulation_id
    WHERE p.company_id = ?${from ? ' AND p.prod_date >= ?' : ''}
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
    sql: 'INSERT INTO production (company_id, prod_date, product_id, qty, uom, note, formulation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [getActiveCompanyId(), v.prod_date, productId, qty, v.uom || 'MT', v.note || null, fid || null]
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
    sql: 'INSERT INTO production (company_id, prod_date, product_id, qty, uom, note, sale_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [getActiveCompanyId(), prodDate, productId, qty, uom || 'MT', 'Auto — finished dispatch', saleId]
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
