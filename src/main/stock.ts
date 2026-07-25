import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Stock per product is derived from movements (no stored balance), scoped to
// the ACTIVE COMPANY:
//   + raw received on purchase orders   (orders.received_qty where status='received', by oil_type_id)
//   + produced output                   (production.qty)
//   − consumed in production            (production_items.qty)
//   − sold (fulfilled)                  (sales.qty where status='done')
export async function stockLevels(): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const sumMap = async (sql: string): Promise<Map<number, number>> => {
    const res = await c.execute({ sql, args: [cid] })
    const m = new Map<number, number>()
    for (const r of res.rows) m.set(Number(r.pid), Number(r.q) || 0)
    return m
  }

  const products = await c.execute(
    'SELECT id, code, name, category, active FROM products ORDER BY category, name'
  )
  const received = await sumMap(
    "SELECT oil_type_id AS pid, SUM(received_qty) AS q FROM orders WHERE status = 'received' AND company_id = ? GROUP BY oil_type_id"
  )
  const produced = await sumMap(
    'SELECT product_id AS pid, SUM(qty) AS q FROM production WHERE company_id = ? GROUP BY product_id'
  )
  const consumed = await sumMap(
    `SELECT i.product_id AS pid, SUM(i.qty) AS q FROM production_items i
     JOIN production p ON p.id = i.production_id WHERE p.company_id = ? GROUP BY i.product_id`
  )
  // Every dispatched sale draws stock — including OFF-STOCK (track_stock = 0)
  // ones. Off-stock only means the not-enough-stock guard was skipped at
  // dispatch; the goods still physically left, so stock must reflect it (and may
  // go negative). track_stock therefore gates the guard, never the movement.
  const sold = await sumMap(
    "SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status = 'done' AND company_id = ? GROUP BY product_id"
  )
  // Inter-company transfers: in = received from another company, out = sent away.
  const transferredIn = await sumMap(
    'SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE to_company_id = ? GROUP BY product_id'
  )
  const transferredOut = await sumMap(
    'SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE from_company_id = ? GROUP BY product_id'
  )

  return products.rows.map((p) => {
    const id = Number(p.id)
    const rec = received.get(id) || 0
    const prod = produced.get(id) || 0
    const cons = consumed.get(id) || 0
    const sld = sold.get(id) || 0
    const tIn = transferredIn.get(id) || 0
    const tOut = transferredOut.get(id) || 0
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      active: p.active,
      received: rec,
      produced: prod,
      consumed: cons,
      sold: sld,
      transferred_in: tIn,
      transferred_out: tOut,
      stock: rec + prod + tIn - cons - sld - tOut
    }
  })
}

// Weighted-average cost (₹ per stock unit) for every product, for valuing the
// physical count. Raw products are valued at the weighted-average landed rate of
// their received purchases; produced goods (intermediate / finished) at the
// input cost consumed to make them, spread over the quantity produced. Because a
// produced good may itself be made from other produced goods, we resolve the
// costs iteratively over a few passes so intermediate→finished chains settle.
export async function productValuationRates(): Promise<Map<number, number>> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const cost = new Map<number, number>()

  // Raw / purchased: weighted average of adjusted landed rate over received qty.
  const raw = await c.execute({
    sql: `SELECT oil_type_id AS pid, SUM(adjusted_rate * received_qty) AS v, SUM(received_qty) AS q
          FROM orders WHERE status = 'received' AND company_id = ?
          GROUP BY oil_type_id`,
    args: [cid]
  })
  for (const r of raw.rows) {
    const q = Number(r.q) || 0
    if (q > 0) cost.set(Number(r.pid), (Number(r.v) || 0) / q)
  }

  // Production batches (output product + qty) and the inputs each consumed.
  const batches = await c.execute({
    sql: 'SELECT id, product_id, qty FROM production WHERE company_id = ?',
    args: [cid]
  })
  const items = await c.execute({
    sql: `SELECT i.production_id AS bid, i.product_id AS pid, i.qty AS qty
          FROM production_items i JOIN production p ON p.id = i.production_id
          WHERE p.company_id = ?`,
    args: [cid]
  })
  const itemsByBatch = new Map<number, Array<{ pid: number; qty: number }>>()
  for (const it of items.rows) {
    const bid = Number(it.bid)
    if (!itemsByBatch.has(bid)) itemsByBatch.set(bid, [])
    itemsByBatch.get(bid)!.push({ pid: Number(it.pid), qty: Number(it.qty) || 0 })
  }
  // Group batches by output product.
  const byOutput = new Map<number, Array<{ qty: number; items: Array<{ pid: number; qty: number }> }>>()
  for (const b of batches.rows) {
    const pid = Number(b.product_id)
    if (!byOutput.has(pid)) byOutput.set(pid, [])
    byOutput.get(pid)!.push({ qty: Number(b.qty) || 0, items: itemsByBatch.get(Number(b.id)) || [] })
  }
  // Iterate so multi-stage (raw→intermediate→finished) costs propagate.
  for (let pass = 0; pass < 5; pass++) {
    for (const [outPid, bs] of byOutput) {
      let inCost = 0
      let outQty = 0
      for (const b of bs) {
        for (const it of b.items) inCost += it.qty * (cost.get(it.pid) || 0)
        outQty += b.qty
      }
      if (outQty > 0) cost.set(outPid, inCost / outQty)
    }
  }
  return cost
}

// Current stock of one product for a specific company (used to validate
// transfers in either direction, independent of the active company).
async function productStockForCompany(companyId: number, productId: number): Promise<number> {
  const c = getClient()
  const one = async (sql: string): Promise<number> => {
    const r = await c.execute({ sql, args: [companyId, productId] })
    return Number(r.rows[0]?.q) || 0
  }
  const rec = await one("SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND company_id = ? AND oil_type_id = ?")
  const prod = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?')
  const cons = await one('SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE p.company_id = ? AND i.product_id = ?')
  const sld = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND company_id = ? AND product_id = ?")
  const tIn = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?')
  const tOut = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?')
  return rec + prod + tIn - cons - sld - tOut
}

// Party-wise breakdown per product for the active company: who we RECEIVED
// each raw product from (suppliers, on received purchases) and who we
// DISPATCHED each product to (customers, on done stock-tracked sales). Used for
// the hover detail on the Stock page's Receipt / Dispatch columns.
export async function stockPartyBreakdown(): Promise<Record<number, { receipt: Row[]; dispatch: Row[] }>> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const out: Record<number, { receipt: Row[]; dispatch: Row[] }> = {}
  const ensure = (pid: number): { receipt: Row[]; dispatch: Row[] } => (out[pid] ??= { receipt: [], dispatch: [] })

  const rec = await c.execute({
    sql: `SELECT o.oil_type_id AS pid, COALESCE(s.name, 'Unknown') AS party, SUM(o.received_qty) AS qty
          FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
          WHERE o.status = 'received' AND o.company_id = ?
          GROUP BY o.oil_type_id, s.name
          HAVING SUM(o.received_qty) > 0
          ORDER BY qty DESC`,
    args: [cid]
  })
  for (const r of rec.rows) ensure(Number(r.pid)).receipt.push({ party: String(r.party), qty: Number(r.qty) || 0 })

  const disp = await c.execute({
    sql: `SELECT s.product_id AS pid, COALESCE(cu.name, s.customer, 'Unknown') AS party, SUM(s.qty) AS qty
          FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
          WHERE s.status = 'done' AND s.company_id = ?
          GROUP BY s.product_id, COALESCE(cu.name, s.customer)
          HAVING SUM(s.qty) > 0
          ORDER BY qty DESC`,
    args: [cid]
  })
  for (const r of disp.rows) ensure(Number(r.pid)).dispatch.push({ party: String(r.party), qty: Number(r.qty) || 0 })

  return out
}

// Available stock of ONE product in the ACTIVE company, using the same formula
// as stockLevels. A specific sale or production run can be excluded from the
// maths so an edit/toggle/delete doesn't count its own (pre-change) effect.
export async function productStockAvailable(
  productId: number,
  opts: { excludeSaleId?: number; excludeProductionId?: number } = {}
): Promise<number> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const one = async (sql: string, args: number[]): Promise<number> => {
    const r = await c.execute({ sql, args })
    return Number(r.rows[0]?.q) || 0
  }
  const exP = opts.excludeProductionId
  const exS = opts.excludeSaleId
  const rec = await one(
    "SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND company_id = ? AND oil_type_id = ?",
    [cid, productId]
  )
  const prod = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?${exP ? ' AND id <> ?' : ''}`,
    exP ? [cid, productId, exP] : [cid, productId]
  )
  const cons = await one(
    `SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE p.company_id = ? AND i.product_id = ?${exP ? ' AND p.id <> ?' : ''}`,
    exP ? [cid, productId, exP] : [cid, productId]
  )
  const sld = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND company_id = ? AND product_id = ?${exS ? ' AND id <> ?' : ''}`,
    exS ? [cid, productId, exS] : [cid, productId]
  )
  const tIn = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?', [cid, productId])
  const tOut = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?', [cid, productId])
  return rec + prod + tIn - cons - sld - tOut
}

// Transfers involving the active company (either direction), newest first.
export async function listStockTransfers(): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT t.*, p.code AS product_code, p.name AS product_name,
                 fc.name AS from_company_name, tc.name AS to_company_name
          FROM stock_transfers t
          LEFT JOIN products p ON p.id = t.product_id
          LEFT JOIN companies fc ON fc.id = t.from_company_id
          LEFT JOIN companies tc ON tc.id = t.to_company_id
          WHERE t.from_company_id = ? OR t.to_company_id = ?
          ORDER BY t.id DESC`,
    args: [cid, cid]
  })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const k of res.columns) o[k] = (r as Row)[k]
    o.direction = Number(o.from_company_id) === cid ? 'out' : 'in'
    return o
  })
}

// Move stock FROM the active company TO another company.
export async function createStockTransfer(v: Row): Promise<{ id: number }> {
  const from = getActiveCompanyId()
  const to = Number(v.to_company_id) || 0
  const productId = Number(v.product_id) || 0
  const qty = Number(v.qty) || 0
  if (!to || to === from) throw new Error('Choose a different destination company')
  if (!productId) throw new Error('Select a product')
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const avail = await productStockForCompany(from, productId)
  if (qty > avail + 1e-6) throw new Error(`Only ${avail.toFixed(3)} in stock to transfer`)
  const res = await getClient().execute({
    sql: `INSERT INTO stock_transfers (from_company_id, to_company_id, product_id, qty, uom, transfer_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [from, to, productId, qty, v.uom || 'MT', v.transfer_date, v.note ? String(v.note).trim() : null]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Reverse a transfer — only if the destination still holds enough to give back.
export async function deleteStockTransfer(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM stock_transfers WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const t = cur.rows[0]
  const destStock = await productStockForCompany(Number(t.to_company_id), Number(t.product_id))
  if (destStock - Number(t.qty) < -1e-6) {
    throw new Error('Cannot reverse — the destination company has already used this stock')
  }
  await c.execute({ sql: 'DELETE FROM stock_transfers WHERE id = ?', args: [id] })
  return { id }
}

export async function stockMap(): Promise<Record<number, number>> {
  const levels = await stockLevels()
  const out: Record<number, number> = {}
  for (const l of levels) out[l.id as number] = l.stock as number
  return out
}

// "Produce more" signal per finished product:
//   demand  = pending (undelivered) sales qty + remaining sales-bargain commitments
//   shortfall = demand − finished stock
//   raw_short = even producing the shortfall, some formula component is short on stock
export async function productionNeeds(): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const levels = await stockLevels()
  const stockOf: Record<number, number> = {}
  for (const l of levels) stockOf[l.id as number] = l.stock as number

  const num = async (sql: string, key: string): Promise<Map<number, number>> => {
    const r = await c.execute({ sql, args: [cid] })
    const m = new Map<number, number>()
    for (const row of r.rows) m.set(Number(row[key]), Number(row.q) || 0)
    return m
  }

  const pending = await num(
    "SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status != 'done' AND company_id = ? GROUP BY product_id",
    'pid'
  )

  // Remaining per sales bargain → summed per product.
  const bargains = await c.execute({
    sql: 'SELECT id, product_id, qty FROM sales_bargains WHERE company_id = ?',
    args: [cid]
  })
  const soldByB = await num(
    'SELECT sales_bargain_id AS bid, SUM(qty) AS q FROM sales WHERE sales_bargain_id IS NOT NULL AND company_id = ? GROUP BY sales_bargain_id',
    'bid'
  )
  const contractRemaining = new Map<number, number>()
  for (const b of bargains.rows) {
    const pid = Number(b.product_id)
    const rem = Math.max(0, (Number(b.qty) || 0) - (soldByB.get(Number(b.id)) || 0))
    contractRemaining.set(pid, (contractRemaining.get(pid) || 0) + rem)
  }

  // Formulations + items, to test whether raw can cover the shortfall.
  const forms = await c.execute('SELECT id, product_id FROM formulations')
  const formByProduct = new Map<number, number>()
  for (const f of forms.rows) formByProduct.set(Number(f.product_id), Number(f.id))
  const itemsRes = await c.execute('SELECT formulation_id, product_id, qty FROM formulation_items')
  const itemsByForm = new Map<number, { product_id: number; qty: number }[]>()
  for (const it of itemsRes.rows) {
    const fid = Number(it.formulation_id)
    const arr = itemsByForm.get(fid) || []
    arr.push({ product_id: Number(it.product_id), qty: Number(it.qty) || 0 })
    itemsByForm.set(fid, arr)
  }

  const out: Row[] = []
  for (const l of levels) {
    if (l.category !== 'finished') continue
    const id = l.id as number
    const demand = (pending.get(id) || 0) + (contractRemaining.get(id) || 0)
    const shortfall = demand - (l.stock as number)
    if (shortfall <= 1e-9) continue
    // Can current raw/intermediate stock produce the shortfall?
    let rawShort = false
    const fid = formByProduct.get(id)
    if (fid) {
      for (const it of itemsByForm.get(fid) || []) {
        const need = (shortfall * it.qty) / 100
        if ((stockOf[it.product_id] || 0) < need - 1e-9) rawShort = true
      }
    }
    out.push({
      id,
      name: l.name,
      stock: l.stock,
      demand,
      shortfall,
      raw_short: rawShort
    })
  }
  return out
}
