import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getSetting } from './repos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Stock per product is derived from movements (no stored balance), scoped to
// the ACTIVE COMPANY:
//   + raw received on purchase orders   (orders.received_qty where status='received', by oil_type_id)
//   + produced output                   (production.qty)
//   − consumed in production            (production_items.qty)
//   − sold (fulfilled)                  (sales.qty where status='done')
// Book stock per product. With a range, the register becomes a period view:
// opening = every movement strictly before `from`, the flow columns cover only
// [from, to], and stock (closing) = opening + the period's net. Without a range
// it is the lifetime view it always was (opening 0, flows all-time).
export async function stockLevels(
  range?: { from?: string; to?: string },
  companyIds?: number[]
): Promise<Row[]> {
  const c = getClient()
  // One company, several, or all — no selection means the active company, so
  // every existing caller keeps its behaviour.
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!cidList.length) cidList.push(getActiveCompanyId())
  const ph = cidList.map(() => '?').join(', ')
  const from = String(range?.from || '')
  const to = String(range?.to || '')

  // Each movement source with its effective date. Note the sold query counts
  // OFF-STOCK (track_stock = 0) sales too: off-stock only means the
  // not-enough-stock guard was skipped at dispatch; the goods still physically
  // left, so stock must reflect it (and may go negative). Trading purchases/
  // sales (affects_stock = 0) are the one true exclusion: goods bought and
  // sold straight through, on our books but never on our floor.
  const SOURCES = {
    received: {
      base: `SELECT oil_type_id AS pid, SUM(received_qty) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id IN (${ph})`,
      // Dated when the oil actually landed — the day the tanker was emptied,
      // which is what received_date records. Stock is a physical register, so
      // a tanker invoiced at the end of one month and emptied in the next is
      // that next month's receipt. (Falls back to the invoice date for an
      // older row that never got an emptied date written to it.)
      //
      // A consignment or direct purchase has no tanker journey at all — the
      // goods are already standing at our site and the invoice is what draws
      // them into our books, so that is the day they land. Its received_date
      // is only ever a stamp of when the invoice happened to be booked, which
      // would otherwise drag a July draw into August.
      date: `CASE WHEN COALESCE(is_consignment, 0) = 1
                  THEN order_date
                  ELSE COALESCE(received_date, order_date) END`,
      group: 'GROUP BY oil_type_id'
    },
    produced: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM production WHERE company_id IN (${ph})`,
      date: 'prod_date',
      group: 'GROUP BY product_id'
    },
    // A by-product line ('output', e.g. fatty acid off a refining batch) is
    // made by the batch just as the main product is, so it adds to stock.
    // Dead loss ('loss') is neither consumed nor produced — it just goes.
    byProduct: {
      base: `SELECT i.product_id AS pid, SUM(i.qty) AS q FROM production_items i
             JOIN production p ON p.id = i.production_id
             WHERE i.kind = 'output' AND p.company_id IN (${ph})`,
      date: 'p.prod_date',
      group: 'GROUP BY i.product_id'
    },
    consumed: {
      base: `SELECT i.product_id AS pid, SUM(i.qty) AS q FROM production_items i
             JOIN production p ON p.id = i.production_id
             WHERE i.kind = 'input' AND p.company_id IN (${ph})`,
      date: 'p.prod_date',
      group: 'GROUP BY i.product_id'
    },
    sold: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status = 'done' AND COALESCE(affects_stock, 1) = 1 AND company_id IN (${ph})`,
      date: 'COALESCE(unloaded_date, sale_date)',
      group: 'GROUP BY product_id'
    },
    transferredIn: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE to_company_id IN (${ph})`,
      date: 'transfer_date',
      group: 'GROUP BY product_id'
    },
    transferredOut: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE from_company_id IN (${ph})`,
      date: 'transfer_date',
      group: 'GROUP BY product_id'
    },
    // A return REVERSES the movement that first booked the goods, so each one
    // is netted off the column it came from rather than inflating the other
    // side: a sales return reduces Dispatch, a purchase return reduces Receipt.
    // Only real returns move goods — a credit note to a supplier or a debit
    // note to a customer is a rate/claim adjustment, money only — and a note
    // with no item lines moves nothing at all.
    returnedIn: {
      base: `SELECT ni.product_id AS pid, SUM(ni.qty) AS q
             FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
             WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
               AND ni.product_id IS NOT NULL AND nt.company_id IN (${ph})`,
      date: 'nt.note_date',
      group: 'GROUP BY ni.product_id'
    },
    returnedOut: {
      base: `SELECT ni.product_id AS pid, SUM(ni.qty) AS q
             FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
             WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier'
               AND ni.product_id IS NOT NULL AND nt.company_id IN (${ph})`,
      date: 'nt.note_date',
      group: 'GROUP BY ni.product_id'
    }
  } as const

  const slice = async (
    src: { base: string; date: string; group: string },
    kind: 'period' | 'opening'
  ): Promise<Map<number, number>> => {
    if (kind === 'opening' && !from) return new Map()
    let sql = src.base
    const args: (string | number)[] = [...cidList]
    if (kind === 'opening') {
      sql += ` AND ${src.date} < ?`
      args.push(from)
    } else {
      if (from) {
        sql += ` AND ${src.date} >= ?`
        args.push(from)
      }
      if (to) {
        sql += ` AND ${src.date} <= ?`
        args.push(to)
      }
    }
    const res = await c.execute({ sql: `${sql} ${src.group}`, args })
    const m = new Map<number, number>()
    for (const r of res.rows) m.set(Number(r.pid), Number(r.q) || 0)
    return m
  }

  const keys = Object.keys(SOURCES) as (keyof typeof SOURCES)[]
  const [products, ...maps] = await Promise.all([
    c.execute('SELECT id, code, name, category, material_type, active FROM products ORDER BY category, name'),
    ...keys.map((k) => slice(SOURCES[k], 'period')),
    ...keys.map((k) => slice(SOURCES[k], 'opening'))
  ])
  const period = Object.fromEntries(keys.map((k, i) => [k, maps[i] as Map<number, number>]))
  const opening = Object.fromEntries(keys.map((k, i) => [k, maps[keys.length + i] as Map<number, number>]))

  return products.rows.map((p) => {
    const id = Number(p.id)
    const g = (m: Record<string, Map<number, number>>, k: string): number => m[k].get(id) || 0
    const open =
      g(opening, 'received') + g(opening, 'produced') + g(opening, 'byProduct') + g(opening, 'transferredIn') -
      g(opening, 'consumed') - g(opening, 'sold') - g(opening, 'transferredOut') +
      g(opening, 'returnedIn') - g(opening, 'returnedOut')
    const rec = g(period, 'received') - g(period, 'returnedOut')
    // A by-product of someone else's batch is produced stock all the same, so
    // it lands in the same column rather than needing one of its own.
    const prod = g(period, 'produced') + g(period, 'byProduct')
    const cons = g(period, 'consumed')
    const sld = g(period, 'sold') - g(period, 'returnedIn')
    const tIn = g(period, 'transferredIn')
    const tOut = g(period, 'transferredOut')
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      material_type: p.material_type,
      active: p.active,
      opening: open,
      received: rec,
      produced: prod,
      consumed: cons,
      sold: sld,
      transferred_in: tIn,
      transferred_out: tOut,
      stock: open + rec + prod + tIn - cons - sld - tOut
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
          FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ?
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
  // Only what the batch actually consumed carries cost into the output — a
  // by-product line is something the batch made, not something it used up.
  const items = await c.execute({
    sql: `SELECT i.production_id AS bid, i.product_id AS pid, i.qty AS qty
          FROM production_items i JOIN production p ON p.id = i.production_id
          WHERE i.kind = 'input' AND p.company_id = ?`,
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
  const rec = await one("SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND oil_type_id = ?")
  const prod = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?')
  // By-products of other batches count as produced; only 'input' is consumed.
  const byProd = await one("SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'output' AND p.company_id = ? AND i.product_id = ?")
  const cons = await one("SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'input' AND p.company_id = ? AND i.product_id = ?")
  const sld = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND product_id = ?")
  const tIn = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?')
  const tOut = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?')
  // Returns, same rule as stockLevels: a sales return comes back in, a purchase
  // return goes back out. Kept in step here or the dispatch guard would
  // disagree with the register it is meant to protect.
  const retIn = await one(`SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
                           WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND nt.company_id = ? AND ni.product_id = ?`)
  const retOut = await one(`SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
                            WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier' AND nt.company_id = ? AND ni.product_id = ?`)
  return rec + prod + byProd + tIn - cons - sld - tOut + retIn - retOut
}

// Party-wise breakdown per product for the active company: who we RECEIVED
// each raw product from (suppliers, on received purchases) and who we
// DISPATCHED each product to (customers, on done stock-tracked sales). Used for
// the hover detail on the Stock page's Receipt / Dispatch columns.
export async function stockPartyBreakdown(
  companyIds?: number[],
  range?: { from?: string; to?: string }
): Promise<Record<number, { receipt: Row[]; dispatch: Row[] }>> {
  const c = getClient()
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!cidList.length) cidList.push(getActiveCompanyId())
  const ph = cidList.map(() => '?').join(', ')
  const multi = cidList.length > 1
  // The split must cover the SAME period the register shows, or the hover would
  // contradict the row it belongs to. Dates match stockLevels exactly.
  const from = String(range?.from || '')
  const to = String(range?.to || '')
  const bounds = (dateExpr: string): { sql: string; args: string[] } => {
    const parts: string[] = []
    const args: string[] = []
    if (from) {
      parts.push(`AND ${dateExpr} >= ?`)
      args.push(from)
    }
    if (to) {
      parts.push(`AND ${dateExpr} <= ?`)
      args.push(to)
    }
    return { sql: parts.join(' '), args }
  }
  // Same date rule stockLevels uses for its own Receipt column — a tanker
  // purchase counts on the day it was actually emptied, a consignment/direct
  // one on its invoice date. Without this, a receipt that the register places
  // in this period (by received_date) could still be filtered out of the
  // party breakdown here (still going by order_date alone), leaving the cell
  // with a total but no names to show for it on hover.
  const recDateExpr = `CASE WHEN COALESCE(o.is_consignment, 0) = 1
                             THEN o.order_date
                             ELSE COALESCE(o.received_date, o.order_date) END`
  const recB = bounds(recDateExpr)
  const dispB = bounds('COALESCE(s.unloaded_date, s.sale_date)')
  const out: Record<number, { receipt: Row[]; dispatch: Row[] }> = {}
  const ensure = (pid: number): { receipt: Row[]; dispatch: Row[] } => (out[pid] ??= { receipt: [], dispatch: [] })

  // With more than one company in view, the party rows say whose books each
  // figure belongs to.
  const rec = await c.execute({
    sql: `SELECT o.oil_type_id AS pid, COALESCE(s.name, 'Unknown') AS party, co.name AS company, SUM(o.received_qty) AS qty
          FROM orders o
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1 AND o.company_id IN (${ph}) ${recB.sql}
          GROUP BY o.oil_type_id, s.name, o.company_id
          HAVING SUM(o.received_qty) > 0
          ORDER BY qty DESC`,
    args: [...cidList, ...recB.args]
  })
  for (const r of rec.rows)
    ensure(Number(r.pid)).receipt.push({
      party: multi ? `${r.party} · ${r.company || ''}` : String(r.party),
      qty: Number(r.qty) || 0
    })

  const disp = await c.execute({
    sql: `SELECT s.product_id AS pid, COALESCE(cu.name, s.customer, 'Unknown') AS party, co.name AS company, SUM(s.qty) AS qty
          FROM sales s
          LEFT JOIN customers cu ON cu.id = s.customer_id
          LEFT JOIN companies co ON co.id = s.company_id
          WHERE s.status = 'done' AND COALESCE(s.affects_stock, 1) = 1 AND s.company_id IN (${ph}) ${dispB.sql}
          GROUP BY s.product_id, COALESCE(cu.name, s.customer), s.company_id
          HAVING SUM(s.qty) > 0
          ORDER BY qty DESC`,
    args: [...cidList, ...dispB.args]
  })
  for (const r of disp.rows)
    ensure(Number(r.pid)).dispatch.push({
      party: multi ? `${r.party} · ${r.company || ''}` : String(r.party),
      qty: Number(r.qty) || 0
    })

  // Note returns move stock, so the register's Receipt and Dispatch figures are
  // already NET of them. Without these lines the hover listed only the sales
  // (or purchases) and never added up to the cell above it. They come back
  // signed negative, which is also how they read: goods going the other way.
  const noteB = bounds('nt.note_date')
  const noteSide = async (
    noteType: 'credit' | 'debit',
    partyType: 'customer' | 'supplier',
    master: string
  ): Promise<Row[]> => {
    const res = await c.execute({
      sql: `SELECT ni.product_id AS pid, COALESCE(m.name, 'Unknown') AS party, co.name AS company,
                   nt.note_no AS note_no, SUM(ni.qty) AS qty
            FROM note_items ni
            JOIN notes nt ON nt.id = ni.note_id
            LEFT JOIN ${master} m ON m.id = nt.party_id
            LEFT JOIN companies co ON co.id = nt.company_id
            WHERE nt.note_type = ? AND nt.party_type = ? AND ni.product_id IS NOT NULL
              AND nt.company_id IN (${ph}) ${noteB.sql}
            GROUP BY ni.product_id, m.name, nt.company_id, nt.note_no
            HAVING SUM(ni.qty) > 0
            ORDER BY qty DESC`,
      args: [noteType, partyType, ...cidList, ...noteB.args]
    })
    return res.rows as unknown as Row[]
  }
  for (const r of await noteSide('credit', 'customer', 'customers'))
    ensure(Number(r.pid)).dispatch.push({
      party: `${multi ? `${r.party} · ${r.company || ''}` : String(r.party)} — return ${r.note_no}`,
      qty: -(Number(r.qty) || 0),
      isReturn: true
    })
  for (const r of await noteSide('debit', 'supplier', 'suppliers'))
    ensure(Number(r.pid)).receipt.push({
      party: `${multi ? `${r.party} · ${r.company || ''}` : String(r.party)} — return ${r.note_no}`,
      qty: -(Number(r.qty) || 0),
      isReturn: true
    })

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
    "SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND oil_type_id = ?",
    [cid, productId]
  )
  const prod = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?${exP ? ' AND id <> ?' : ''}`,
    exP ? [cid, productId, exP] : [cid, productId]
  )
  const byProd = await one(
    `SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'output' AND p.company_id = ? AND i.product_id = ?${exP ? ' AND p.id <> ?' : ''}`,
    exP ? [cid, productId, exP] : [cid, productId]
  )
  const cons = await one(
    `SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'input' AND p.company_id = ? AND i.product_id = ?${exP ? ' AND p.id <> ?' : ''}`,
    exP ? [cid, productId, exP] : [cid, productId]
  )
  const sld = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND product_id = ?${exS ? ' AND id <> ?' : ''}`,
    exS ? [cid, productId, exS] : [cid, productId]
  )
  const tIn = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?', [cid, productId])
  const tOut = await one('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?', [cid, productId])
  // Returns, same rule as stockLevels — the availability guard has to see the
  // same balance the Stock page shows, or a dispatch would be refused (or
  // allowed) on a figure nobody can reconcile.
  const retIn = await one(
    `SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND nt.company_id = ? AND ni.product_id = ?`,
    [cid, productId]
  )
  const retOut = await one(
    `SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
     WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier' AND nt.company_id = ? AND ni.product_id = ?`,
    [cid, productId]
  )
  return rec + prod + byProd + tIn - cons - sld - tOut + retIn - retOut
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

  // A rejected invoice will never actually ship — it stays on record for the
  // Credit Note against it, but shouldn't keep demanding production for
  // something that's never going out.
  const pending = await num(
    "SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status != 'done' AND COALESCE(affects_stock, 1) = 1 AND rejected_at IS NULL AND company_id = ? GROUP BY product_id",
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

// stock.ts had no row-shaping helper because everything above it returns
// hand-built objects; these registers hand their columns straight back.
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// ---------------------------------------------------------------------------
// Movement registers: the same period the Book Stock register covers, but one
// line per physical document instead of one per product. Two of them —
// everything that came IN, and everything that went OUT — with the vehicle,
// the bill and both weights, which is what a gate/lorry register is checked
// against.
export async function stockRegisters(
  companyIds?: number[],
  range?: { from?: string; to?: string }
): Promise<{ receipts: Row[]; dispatches: Row[] }> {
  const c = getClient()
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!cidList.length) cidList.push(getActiveCompanyId())
  const ph = cidList.map(() => '?').join(', ')
  const from = String(range?.from || '')
  const to = String(range?.to || '')
  const bounds = (dateExpr: string): { sql: string; args: string[] } => {
    const parts: string[] = []
    const args: string[] = []
    if (from) {
      parts.push(`AND ${dateExpr} >= ?`)
      args.push(from)
    }
    if (to) {
      parts.push(`AND ${dateExpr} <= ?`)
      args.push(to)
    }
    return { sql: parts.join(' '), args }
  }

  // Same receipt date rule stockLevels and the party breakdown use, so a line
  // here always lands in the period its quantity was counted in.
  const recDateExpr = `CASE WHEN COALESCE(o.is_consignment, 0) = 1
                             THEN o.order_date
                             ELSE COALESCE(o.received_date, o.order_date) END`
  const recB = bounds(recDateExpr)

  // A purchase arrives one of two ways: as tankers booked against the order —
  // then the vehicle, its loading date and its own two weights are what the
  // register wants — or as a consignment/direct receipt with no vehicle behind
  // it at all, which still has to appear or the register would not tie back to
  // the stock figure. Hence the two halves.
  const recTankers = await c.execute({
    sql: `SELECT ${recDateExpr} AS received_date,
                 pt.loaded_date AS loaded_date,
                 COALESCE(sp.name, s2.name, 'Unknown') AS party,
                 tr.name AS transporter,
                 o.invoice_no AS bill_no,
                 pt.tanker_no AS vehicle_no,
                 p.name AS oil_type,
                 pt.loaded_qty AS dispatch_qty,
                 CASE WHEN pt.status = 'empty' THEN pt.received_qty ELSE NULL END AS received_qty,
                 pt.condition AS tanker_condition,
                 b.bargain_type AS bargain_type,
                 o.allowed_shortage_pct AS order_pct,
                 b.allowed_shortage_pct AS bargain_pct,
                 co.name AS company
          FROM purchase_tankers pt
          JOIN orders o ON o.id = pt.order_id
          LEFT JOIN bargains b ON b.id = pt.bargain_id
          LEFT JOIN suppliers sp ON sp.id = pt.supplier_id
          LEFT JOIN suppliers s2 ON s2.id = o.supplier_id
          LEFT JOIN transporters tr ON tr.id = COALESCE(pt.transporter_id, o.transporter_id)
          LEFT JOIN products p ON p.id = COALESCE(pt.oil_type_id, o.oil_type_id)
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1
            AND o.company_id IN (${ph}) ${recB.sql}`,
    args: [...cidList, ...recB.args]
  })
  const recDirect = await c.execute({
    sql: `SELECT ${recDateExpr} AS received_date,
                 o.loaded_date AS loaded_date,
                 COALESCE(s.name, 'Unknown') AS party,
                 tr.name AS transporter,
                 o.invoice_no AS bill_no,
                 o.tanker_no AS vehicle_no,
                 p.name AS oil_type,
                 o.ordered_qty AS dispatch_qty,
                 o.received_qty AS received_qty,
                 NULL AS tanker_condition,
                 COALESCE(b.bargain_type, o.bargain_type) AS bargain_type,
                 o.allowed_shortage_pct AS order_pct,
                 b.allowed_shortage_pct AS bargain_pct,
                 co.name AS company
          FROM orders o
          LEFT JOIN bargains b ON b.id = o.bargain_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN transporters tr ON tr.id = o.transporter_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1
            AND o.company_id IN (${ph}) ${recB.sql}
            AND NOT EXISTS (SELECT 1 FROM purchase_tankers pt WHERE pt.order_id = o.id)`,
    args: [...cidList, ...recB.args]
  })

  const dispB = bounds('COALESCE(s.unloaded_date, s.sale_date)')
  const disp = await c.execute({
    sql: `SELECT s.loaded_date AS loaded_date,
                 COALESCE(s.unloaded_date, s.sale_date) AS received_date,
                 COALESCE(cu.name, s.customer, 'Unknown') AS party,
                 tr.name AS transporter,
                 s.invoice_no AS bill_no,
                 -- The vehicle that carried it out. Gate Out links to a sale by
                 -- INVOICE GROUP, not sale_id — joining on gate_entries.sale_id
                 -- matched nothing at all (it is null on every gate row), which
                 -- is why this column came out empty in the register.
                 (SELECT ge.tanker_no FROM gate_entries ge
                   WHERE ge.direction = 'out' AND ge.invoice_group = s.invoice_group
                     AND s.invoice_group IS NOT NULL
                   ORDER BY ge.id DESC LIMIT 1) AS vehicle_no,
                 p.name AS oil_type,
                 s.qty AS dispatch_qty,
                 -- What the transporter delivered, captured when the invoice was
                 -- marked Unloaded; the gate register is the fallback for a
                 -- vehicle weighed at the yard instead.
                 COALESCE(
                   s.received_qty,
                   (SELECT ge.received_qty FROM gate_entries ge
                     WHERE ge.direction = 'out' AND ge.invoice_group = s.invoice_group
                       AND s.invoice_group IS NOT NULL AND ge.received_qty > 0
                     ORDER BY ge.id DESC LIMIT 1)
                 ) AS received_qty,
                 co.name AS company
          FROM sales s
          LEFT JOIN customers cu ON cu.id = s.customer_id
          LEFT JOIN transporters tr ON tr.id = s.transporter_id
          LEFT JOIN products p ON p.id = s.product_id
          LEFT JOIN companies co ON co.id = s.company_id
          WHERE s.status = 'done' AND COALESCE(s.affects_stock, 1) = 1
            AND s.company_id IN (${ph}) ${dispB.sql}`,
    args: [...cidList, ...dispB.args]
  })

  // Shortage the supplier wears. Same rule the purchase screens show: only an
  // EX load puts the loss on the supplier (on DLD the transporter or we do), and
  // only the part beyond the agreed tolerance counts. The tolerance falls back
  // order -> bargain -> the company default, and `??` is deliberate so an
  // explicit 0% is honoured rather than treated as "not set".
  const defaultPct = Number((await getSetting('allowed_shortage_pct')) ?? 0) || 0
  const isEx = (tankerCondition: unknown, bargainType: unknown): boolean => {
    const own = String(tankerCondition ?? '').trim().toUpperCase()
    if (own) return own !== 'DLD' && own !== 'DELIVERED'
    return !['DLD', 'DELIVERED'].includes(String(bargainType ?? '').trim().toUpperCase())
  }
  const withDeductible = (r: Row): Row => {
    const loaded = Number(r.dispatch_qty) || 0
    const rec = r.received_qty == null ? null : Number(r.received_qty)
    if (rec == null || loaded <= 0 || !isEx(r.tanker_condition, r.bargain_type)) return { ...r, deductible: null }
    const pct = Number(r.order_pct ?? r.bargain_pct ?? defaultPct) || 0
    const allowed = (loaded * pct) / 100
    const shortage = Math.max(0, loaded - rec)
    return { ...r, deductible: shortage > allowed ? Math.round((shortage - allowed) * 1000) / 1000 : null }
  }

  // Note returns move stock, so they belong in these registers too — as
  // NEGATIVE lines, which is what they are: goods travelling the other way. A
  // credit note to a customer comes back off dispatch, a debit note to a
  // supplier comes back off receipt. Without them the register totals were
  // gross while the Book Stock figures they are checked against were net.
  const noteB = bounds('nt.note_date')
  const noteLines = async (
    noteType: 'credit' | 'debit',
    partyType: 'customer' | 'supplier',
    master: string
  ): Promise<Row[]> => {
    const res = await c.execute({
      sql: `SELECT nt.note_date AS received_date, NULL AS loaded_date,
                   COALESCE(m.name, 'Unknown') AS party, NULL AS transporter,
                   nt.note_no AS bill_no, NULL AS vehicle_no,
                   p.name AS oil_type,
                   -ni.qty AS dispatch_qty, NULL AS received_qty,
                   co.name AS company, nt.against_ref AS against_ref,
                   1 AS is_return
            FROM note_items ni
            JOIN notes nt ON nt.id = ni.note_id
            LEFT JOIN ${master} m ON m.id = nt.party_id
            LEFT JOIN products p ON p.id = ni.product_id
            LEFT JOIN companies co ON co.id = nt.company_id
            WHERE nt.note_type = ? AND nt.party_type = ? AND ni.product_id IS NOT NULL
              AND ni.qty > 0 AND nt.company_id IN (${ph}) ${noteB.sql}`,
      args: [noteType, partyType, ...cidList, ...noteB.args]
    })
    return toPlain(res)
  }

  // Newest first, the way every other register on the page reads.
  const bySeq = (a: Row, b: Row): number =>
    String(b.received_date || b.loaded_date || '').localeCompare(String(a.received_date || a.loaded_date || ''))
  const receipts = [
    ...toPlain(recTankers).map(withDeductible),
    ...toPlain(recDirect).map(withDeductible),
    // A purchase return carries no deductible — nothing was short-delivered.
    ...(await noteLines('debit', 'supplier', 'suppliers')).map((r) => ({ ...r, deductible: null }))
  ].sort(bySeq)
  const dispatches = [...toPlain(disp), ...(await noteLines('credit', 'customer', 'customers'))].sort(bySeq)
  return { receipts, dispatches }
}
