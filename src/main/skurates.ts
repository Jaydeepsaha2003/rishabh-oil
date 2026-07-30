// Per-SKU selling rates on a sales bargain. The rate card is filled from a
// downloaded sheet and then offered when a sale line on that bargain picks a SKU.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const k of res.columns) o[k] = (r as Row)[k]
    return o
  })
}
const n = (v: unknown): number => Number(v) || 0

// Every SKU the bargain could be priced in, with whatever rate is on record.
// A bargain tied to a product only offers that product's SKUs; one without a
// product offers them all, so nothing is unreachable.
export async function listSkuRates(salesBargainId: number): Promise<Row[]> {
  const c = getClient()
  const bg = await c.execute({
    sql: 'SELECT id, bargain_no, product_id, rate, uom, customer_id FROM sales_bargains WHERE id = ? LIMIT 1',
    args: [salesBargainId]
  })
  if (!bg.rows.length) throw new Error('That sales bargain no longer exists')
  const productId = n(bg.rows[0].product_id)
  const customerId = n(bg.rows[0].customer_id)
  const res = await c.execute({
    sql: `SELECT pk.id AS packaging_id, pk.name, pk.unit_size, pk.unit_uom,
                 pk.base_per_pouch, pk.base_uom, pk.pouches_per_box, pk.product_id,
                 r.rate_per_case, r.rate_per_mt, r.updated_at
          FROM packagings pk
          LEFT JOIN sales_bargain_sku_rates r
            ON r.packaging_id = pk.id AND r.sales_bargain_id = ?
          WHERE pk.active = 1 AND (? = 0 OR pk.product_id IS NULL OR pk.product_id = ?)
          ORDER BY pk.name`,
    args: [salesBargainId, productId, productId]
  })
  let rows = toPlain(res)
  // When the bargain's customer has SKUs linked to them, the rate card narrows
  // to those — that is the point of the linking. No links (or no overlap with
  // the product's SKUs) falls back to the full list so nothing ever vanishes.
  if (customerId) {
    const links = await c.execute({
      sql: 'SELECT packaging_id FROM packaging_parties WHERE customer_id = ?',
      args: [customerId]
    })
    const linked = new Set(links.rows.map((r) => Number(r.packaging_id)))
    if (linked.size) {
      const own = rows.filter((r) => linked.has(Number(r.packaging_id)))
      if (own.length) rows = own
    }
  }
  return rows
}

// The customers linked to one packed SKU.
export async function listPackagingParties(packagingId: number): Promise<number[]> {
  const res = await getClient().execute({
    sql: 'SELECT customer_id FROM packaging_parties WHERE packaging_id = ?',
    args: [packagingId]
  })
  return res.rows.map((r) => Number(r.customer_id))
}

// Replace the customer links for one packed SKU.
export async function setPackagingParties(packagingId: number, customerIds: number[]): Promise<{ count: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM packaging_parties WHERE packaging_id = ?', args: [packagingId] })
  const ids = Array.from(new Set((customerIds || []).map(Number).filter((x) => x > 0)))
  for (const cid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO packaging_parties (packaging_id, customer_id) VALUES (?, ?)',
      args: [packagingId, cid]
    })
  }
  return { count: ids.length }
}

// Replace the card for one bargain. A row with neither rate is removed, so
// clearing a SKU in the sheet clears it here too.
export async function saveSkuRates(
  salesBargainId: number,
  rows: unknown
): Promise<{ saved: number; cleared: number }> {
  const c = getClient()
  const bg = await c.execute({
    sql: 'SELECT id FROM sales_bargains WHERE id = ? LIMIT 1',
    args: [salesBargainId]
  })
  if (!bg.rows.length) throw new Error('That sales bargain no longer exists')
  let saved = 0
  let cleared = 0
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = raw as Row
    const pid = n(r.packaging_id)
    if (!pid) continue
    const perCase = r.rate_per_case === '' || r.rate_per_case == null ? null : n(r.rate_per_case)
    const perMt = r.rate_per_mt === '' || r.rate_per_mt == null ? null : n(r.rate_per_mt)
    if ((perCase == null || perCase <= 0) && (perMt == null || perMt <= 0)) {
      const del = await c.execute({
        sql: 'DELETE FROM sales_bargain_sku_rates WHERE sales_bargain_id = ? AND packaging_id = ?',
        args: [salesBargainId, pid]
      })
      cleared += del.rowsAffected || 0
      continue
    }
    await c.execute({
      sql: `INSERT INTO sales_bargain_sku_rates (sales_bargain_id, packaging_id, rate_per_case, rate_per_mt, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT (sales_bargain_id, packaging_id)
            DO UPDATE SET rate_per_case = excluded.rate_per_case,
                          rate_per_mt = excluded.rate_per_mt,
                          updated_at = datetime('now')`,
      args: [salesBargainId, pid, perCase, perMt]
    })
    saved++
  }
  return { saved, cleared }
}
