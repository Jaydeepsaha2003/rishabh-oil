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
  const sold = await sumMap(
    "SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status = 'done' AND company_id = ? GROUP BY product_id"
  )

  return products.rows.map((p) => {
    const id = Number(p.id)
    const rec = received.get(id) || 0
    const prod = produced.get(id) || 0
    const cons = consumed.get(id) || 0
    const sld = sold.get(id) || 0
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
      stock: rec + prod - cons - sld
    }
  })
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
