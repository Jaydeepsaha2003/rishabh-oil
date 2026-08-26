import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'

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

// Packed finished stock, one row per packaging (SKU). On-hand is a lightweight,
// manually-maintained count that is interlinked with sales: every dispatched
// PACKED sale of a packaging reduces its on-hand automatically.
//   on_hand (units) = SUM(manual adjustments) − SUM(units sold on packed sales)
// where units sold = boxes × pouches_per_box + loose pouches.
// When `date` is given the row is a DAY REGISTER for that date (mirrors the
// mill's production & despatch sheet): opening b/f + packed in − despatched =
// closing. Without a date the row carries the running to-date figures.
export async function listSkuStock(date?: string): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const d = date ? String(date).slice(0, 10) : null
  const round = (x: number): number => Math.round((x + Number.EPSILON) * 1e6) / 1e6
  const res = await c.execute({
    sql: `
    SELECT pk.id, pk.name, pk.box_label, pk.pouch_label, pk.pouches_per_box,
           pk.base_per_pouch, pk.base_uom, pk.unit_size, pk.unit_uom,
           -- What this SKU packs: the linked finished product, else the short
           -- name typed on the SKU. Used to filter the packed-stock list.
           COALESCE(pr.name, pk.product_label) AS product_name,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?), 0) AS added,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?), 0) AS sold,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       AND (? IS NULL OR substr(adj_date, 1, 10) < ?)), 0) AS added_before,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       AND (? IS NULL OR substr(s.sale_date, 1, 10) < ?)), 0) AS sold_before,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       AND substr(adj_date, 1, 10) = ?), 0) AS added_on,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       AND substr(s.sale_date, 1, 10) = ?), 0) AS sold_on
    FROM packagings pk
    LEFT JOIN products pr ON pr.id = pk.product_id
    WHERE pk.active = 1
    ORDER BY pk.name COLLATE NOCASE ASC`,
    args: [cid, cid, cid, d, d, cid, d, d, cid, d, cid, d]
  })
  return toPlain(res).map((r) => {
    const opening = round(n(r.added_before) - n(r.sold_before))
    const addedOn = round(n(r.added_on))
    const soldOn = round(n(r.sold_on))
    return {
      ...r,
      opening,
      added_on: addedOn,
      sold_on: soldOn,
      // Day view: closing for that date. Otherwise the running balance.
      on_hand: d ? round(opening + addedOn - soldOn) : round(n(r.added) - n(r.sold))
    }
  })
}

// Where each figure on the packed-SKU register comes from.
//
// The register shows a number per SKU per day and nothing about how it got
// there, so a despatch of 34,000 is unarguable and unexplainable at the same
// time. This returns the parts: despatches split by the customer who took them,
// and packing entries with their dates and notes.
//
// Fetched for EVERY SKU in one pair of queries rather than per SKU on hover --
// a tooltip must not cost a round trip, and forty of them must not cost forty.
export async function skuMovementBreakdown(date?: string): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const d = date ? String(date).slice(0, 10) : null

  // Despatches, by SKU and by customer. Pieces are boxes x per-box + loose.
  const disp = await c.execute({
    sql: `SELECT s.packaging_id AS sku, s.invoice_no, s.sale_date, s.customer,
                 SUM(s.boxes * pk.pouches_per_box + s.pouches) AS pieces, SUM(s.boxes) AS boxes
          FROM sales s JOIN packagings pk ON pk.id = s.packaging_id
          WHERE s.sale_type = 'PACKED' AND s.status = 'done' AND s.company_id = ?
            AND (? IS NULL OR substr(s.sale_date, 1, 10) = ?)
          GROUP BY s.packaging_id, s.invoice_group, s.customer
          ORDER BY s.sale_date, s.invoice_no`,
    args: [cid, d, d]
  })

  // Packing/correction entries, by SKU.
  const packed = await c.execute({
    sql: `SELECT packaging_id AS sku, adj_date, delta, note
          FROM sku_adjustments
          WHERE company_id = ? AND (? IS NULL OR substr(adj_date, 1, 10) = ?)
          ORDER BY adj_date, id`,
    args: [cid, d, d]
  })

  const bySku = new Map<number, Row>()
  const slot = (id: number): Row => {
    const cur = bySku.get(id) || { sku: id, despatch: [] as Row[], packed_in: [] as Row[] }
    bySku.set(id, cur)
    return cur
  }
  for (const r of toPlain(disp)) slot(n(r.sku)).despatch.push(r)
  for (const r of toPlain(packed)) slot(n(r.sku)).packed_in.push(r)
  return Array.from(bySku.values())
}

// Add (delta > 0) or remove (delta < 0) packed units for one SKU, logged by
// date so the on-hand reflects when packing/shrinkage happened.
export async function adjustSkuStock(
  packagingId: number,
  delta: number,
  note?: string,
  date?: string
): Promise<{ id: number; on_hand: number }> {
  const c = getClient()
  const pid = n(packagingId)
  const d = n(delta)
  if (!pid) throw new Error('Select an SKU')
  if (d === 0) throw new Error('Enter a quantity to add or remove')
  const pkg = await c.execute({ sql: 'SELECT id FROM packagings WHERE id = ?', args: [pid] })
  if (!pkg.rows.length) throw new Error('SKU not found')
  const adjDate = (date && String(date).slice(0, 10)) || todayISO()
  await c.execute({
    sql: `INSERT INTO sku_adjustments (company_id, packaging_id, delta, adj_date, note)
          VALUES (?, ?, ?, ?, ?)`,
    args: [getActiveCompanyId(), pid, d, adjDate, note ? String(note).trim() : null]
  })
  const rows = await listSkuStock()
  const cur = rows.find((r) => Number(r.id) === pid)
  return { id: pid, on_hand: cur ? Number(cur.on_hand) : 0 }
}
