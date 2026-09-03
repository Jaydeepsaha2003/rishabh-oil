import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { getCurrentUser } from './currentUser'

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

// A period, however it was asked for.
//
// A single date is just the period from that day to that day, so the day sheet
// and a date range are one code path rather than two — which matters because
// the register and its own hover have to agree about which movements are in
// view, and two code paths is how they stop agreeing.
export type SkuWhen = string | { from?: string; to?: string } | undefined

function span(when?: SkuWhen): { from: string | null; to: string | null; ranged: boolean } {
  if (!when) return { from: null, to: null, ranged: false }
  if (typeof when === 'string') {
    const d = String(when).slice(0, 10)
    return d ? { from: d, to: d, ranged: true } : { from: null, to: null, ranged: false }
  }
  const from = when.from ? String(when.from).slice(0, 10) : ''
  const to = when.to ? String(when.to).slice(0, 10) : ''
  // One open end is an ordinary request — "everything up to the 15th", "from
  // the 1st onward" — and both still describe a period.
  return { from: from || null, to: to || null, ranged: !!(from || to) }
}

// Packed finished stock, one row per packaging (SKU). On-hand is a lightweight,
// manually-maintained count that is interlinked with sales: every dispatched
// PACKED sale of a packaging reduces its on-hand automatically.
//   on_hand (units) = SUM(manual adjustments) − SUM(units sold on packed sales)
// where units sold = boxes × pouches_per_box + loose pouches.
// When `date` is given the row is a DAY REGISTER for that date (mirrors the
// mill's production & dispatch sheet): opening b/f + packed in − dispatched =
// closing. Without a date the row carries the running to-date figures.
export async function listSkuStock(when?: SkuWhen): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const { from, to, ranged } = span(when)
  const round = (x: number): number => Math.round((x + Number.EPSILON) * 1e6) / 1e6

  // The date predicates are BUILT rather than null-guarded. `? IS NULL OR ...`
  // triples the arguments and, worse, quietly does the wrong thing for a
  // one-ended range: "up to the 15th" has nothing before it, so its opening is
  // nil, where a null guard would hand back every row ever entered.
  const args: (string | number | null)[] = []
  const before = (col: string): string => {
    if (!ranged) return '' // all-time: opening is unused, and this is what it always returned
    if (!from) return 'AND 1 = 0'
    args.push(from)
    return `AND substr(${col}, 1, 10) < ?`
  }
  const within = (col: string): string => {
    if (!ranged) return 'AND 1 = 0' // all-time reads `added`/`sold` instead
    const parts: string[] = []
    if (from) {
      args.push(from)
      parts.push(`AND substr(${col}, 1, 10) >= ?`)
    }
    if (to) {
      args.push(to)
      parts.push(`AND substr(${col}, 1, 10) <= ?`)
    }
    return parts.join(' ')
  }
  // Assembled in the order the SQL below consumes them.
  args.push(cid)
  args.push(cid)
  args.push(cid)
  const beforeAdj = before('adj_date')
  args.push(cid)
  const beforeSale = before('s.sale_date')
  args.push(cid)
  const withinAdj = within('adj_date')
  args.push(cid)
  const withinSale = within('s.sale_date')

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
                       ${beforeAdj}), 0) AS added_before,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       ${beforeSale}), 0) AS sold_before,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       ${withinAdj}), 0) AS added_on,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       ${withinSale}), 0) AS sold_on
    FROM packagings pk
    LEFT JOIN products pr ON pr.id = pk.product_id
    WHERE pk.active = 1
    ORDER BY pk.name COLLATE NOCASE ASC`,
    args
  })
  // Only worth replaying the history when something is actually negative, but
  // that is not known until the rows are mapped -- and the check is one query
  // either way, so it is simply always done.
  const runs = await negativeRuns(cid, to)
  return toPlain(res).map((r) => {
    const opening = round(n(r.added_before) - n(r.sold_before))
    const addedOn = round(n(r.added_on))
    const soldOn = round(n(r.sold_on))
    const onHand = ranged ? round(opening + addedOn - soldOn) : round(n(r.added) - n(r.sold))
    const run = onHand < -1e-6 ? runs.get(n(r.id)) : undefined
    return {
      ...r,
      opening,
      added_on: addedOn,
      sold_on: soldOn,
      // Day view: closing for that date. Otherwise the running balance.
      on_hand: onHand,
      negative_since: run?.negative_since ?? null,
      negative_trigger: run?.negative_trigger ?? null
    }
  })
}

// How long a SKU has been below zero.
//
// "Closing −97" says a count is wrong; it does not say WHEN it went wrong, and
// that is the only thing that helps -- the day it first went under is the day
// whose paperwork has the answer, and everything after it is just the same
// error being carried forward. So the balance is replayed day by day from the
// first movement, and what comes back is the start of the run it is CURRENTLY
// in: not the first time it ever dipped, but the last time it went under
// without coming back.
//
// One query for every SKU, and the walk is in JS -- SQLite window functions
// would do it too, but not legibly, and this runs over a few hundred rows.
async function negativeRuns(cid: number, upto: string | null): Promise<Map<number, Row>> {
  const c = getClient()
  const res = await c.execute({
    sql: `
    SELECT sku, d, SUM(adj) AS adj, SUM(sale) AS sale FROM (
      SELECT packaging_id AS sku, substr(adj_date, 1, 10) AS d, SUM(delta) AS adj, 0 AS sale
        FROM sku_adjustments
       WHERE company_id = ? AND (? IS NULL OR substr(adj_date, 1, 10) <= ?)
       GROUP BY packaging_id, d
      UNION ALL
      SELECT s.packaging_id, substr(s.sale_date, 1, 10), 0,
             SUM(s.boxes * pk.pouches_per_box + s.pouches)
        FROM sales s JOIN packagings pk ON pk.id = s.packaging_id
       WHERE s.sale_type = 'PACKED' AND s.status = 'done' AND s.company_id = ?
         AND (? IS NULL OR substr(s.sale_date, 1, 10) <= ?)
       GROUP BY s.packaging_id, substr(s.sale_date, 1, 10)
    )
    GROUP BY sku, d
    ORDER BY sku, d`,
    args: [cid, upto, upto, cid, upto, upto]
  })

  const byS = new Map<number, Row[]>()
  for (const r of toPlain(res)) {
    const k = n(r.sku)
    byS.set(k, [...(byS.get(k) || []), r])
  }

  const out = new Map<number, Row>()
  for (const [sku, days] of byS) {
    let bal = 0
    let since: string | null = null
    let trigger: Row | null = null
    for (const day of days) {
      const before = bal
      bal = Math.round((bal + n(day.adj) - n(day.sale)) * 1e6) / 1e6
      if (bal < -1e-6) {
        // Only the START of a run is recorded; a day that was already negative
        // did not push it under, it inherited it.
        if (since === null) {
          since = String(day.d)
          trigger = { ...day, before }
        }
      } else {
        since = null
        trigger = null
      }
    }
    if (since) out.set(sku, { negative_since: since, negative_trigger: trigger })
  }
  return out
}

// Where each figure on the packed-SKU register comes from.
//
// The register shows a number per SKU per day and nothing about how it got
// there, so a dispatch of 34,000 is unarguable and unexplainable at the same
// time. This returns the parts: dispatches split by the customer who took them,
// and packing entries with their dates and notes.
//
// Fetched for EVERY SKU in one pair of queries rather than per SKU on hover --
// a tooltip must not cost a round trip, and forty of them must not cost forty.
export async function skuMovementBreakdown(when?: SkuWhen): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const { from, to } = span(when)

  // Exactly the period the register is showing. A hover that covered a
  // different stretch from the cell it explains is the same fault the bulk
  // register had, where a Receipt of 0 carried a tooltip listing 159.675 MT.
  const bounds = (col: string): { sql: string; args: string[] } => {
    const parts: string[] = []
    const args: string[] = []
    if (from) {
      parts.push(`AND substr(${col}, 1, 10) >= ?`)
      args.push(from)
    }
    if (to) {
      parts.push(`AND substr(${col}, 1, 10) <= ?`)
      args.push(to)
    }
    return { sql: parts.join(' '), args }
  }
  const dispB = bounds('s.sale_date')
  const adjB = bounds('adj_date')

  // Dispatches, by SKU and by customer. Pieces are boxes x per-box + loose.
  const disp = await c.execute({
    sql: `SELECT s.packaging_id AS sku, s.invoice_no, s.sale_date, s.customer,
                 SUM(s.boxes * pk.pouches_per_box + s.pouches) AS pieces, SUM(s.boxes) AS boxes
          FROM sales s JOIN packagings pk ON pk.id = s.packaging_id
          WHERE s.sale_type = 'PACKED' AND s.status = 'done' AND s.company_id = ?
            ${dispB.sql}
          GROUP BY s.packaging_id, s.invoice_group, s.customer
          ORDER BY s.sale_date, s.invoice_no`,
    args: [cid, ...dispB.args]
  })

  // Packing / correction entries, by SKU. `kind` is NULL on everything entered
  // before it was asked for, so it falls back to the old guess from the sign --
  // which is right for the negatives and merely unproven for the positives.
  const packed = await c.execute({
    sql: `SELECT packaging_id AS sku, adj_date, delta, note, created_by, created_at,
                 COALESCE(kind, CASE WHEN delta < 0 THEN 'correction' ELSE 'packing' END) AS kind,
                 kind AS kind_stated
          FROM sku_adjustments
          WHERE company_id = ? ${adjB.sql}
          ORDER BY adj_date, id`,
    args: [cid, ...adjB.args]
  })

  const bySku = new Map<number, Row>()
  const slot = (id: number): Row => {
    const cur = bySku.get(id) || { sku: id, dispatch: [] as Row[], packed_in: [] as Row[] }
    bySku.set(id, cur)
    return cur
  }
  for (const r of toPlain(disp)) slot(n(r.sku)).dispatch.push(r)
  for (const r of toPlain(packed)) slot(n(r.sku)).packed_in.push(r)
  return Array.from(bySku.values())
}

// Add (delta > 0) or remove (delta < 0) packed units for one SKU, logged by
// date so the on-hand reflects when packing/shrinkage happened.
// Every hand entry against one SKU, newest first.
//
// The Update dialog is where these are made, so it is where they have to be
// visible: an SKU reading 1,548 with no way to see the four entries behind it
// is a figure nobody can check. Each row carries the bulk oil it represents AND
// whether that oil actually moved, because those are not the same thing —
// packing draws oil out of the plant tank, a correction only moves pieces on
// the shelf. A +1,000 packing followed by a -1,000 correction nets to nil on
// the shelf and still leaves the tank 15 MT down, and that is invisible unless
// the list says so on the row.
export async function listSkuAdjustments(packagingId: number): Promise<Row[]> {
  const pid = n(packagingId)
  if (!pid) return []
  // The same piece -> MT conversion the stock register uses for packedOut, so
  // the figure here is the one the bulk tank actually saw.
  const MT = `
    CASE
      WHEN COALESCE(pk.unit_size, 0) > 0 THEN
        CASE UPPER(COALESCE(pk.unit_uom, 'KG'))
          WHEN 'GM' THEN pk.unit_size / 1000.0
          WHEN 'G' THEN pk.unit_size / 1000.0
          WHEN 'ML' THEN pk.unit_size / 1000.0
          WHEN 'QUINTAL' THEN pk.unit_size * 100.0
          WHEN 'MT' THEN pk.unit_size * 1000.0
          WHEN 'TON' THEN pk.unit_size * 1000.0
          WHEN 'KL' THEN pk.unit_size * 1000.0
          ELSE pk.unit_size
        END
      ELSE
        CASE UPPER(COALESCE(pk.base_uom, 'KG'))
          WHEN 'GM' THEN pk.base_per_pouch / 1000.0
          WHEN 'G' THEN pk.base_per_pouch / 1000.0
          WHEN 'ML' THEN pk.base_per_pouch / 1000.0
          WHEN 'QUINTAL' THEN pk.base_per_pouch * 100.0
          WHEN 'MT' THEN pk.base_per_pouch * 1000.0
          WHEN 'TON' THEN pk.base_per_pouch * 1000.0
          WHEN 'KL' THEN pk.base_per_pouch * 1000.0
          ELSE pk.base_per_pouch
        END
    END / 1000.0`
  const res = await getClient().execute({
    sql: `SELECT a.id, a.delta, a.adj_date, a.note, a.created_by, a.created_at,
                 COALESCE(a.kind, CASE WHEN a.delta < 0 THEN 'correction' ELSE 'packing' END) AS kind,
                 a.delta * (${MT}) AS mt,
                 pr.name AS product_name
          FROM sku_adjustments a
          JOIN packagings pk ON pk.id = a.packaging_id
          LEFT JOIN products pr ON pr.id = pk.product_id
          WHERE a.packaging_id = ? AND a.company_id = ?
          ORDER BY a.adj_date DESC, a.id DESC`,
    args: [pid, getActiveCompanyId()]
  })
  return toPlain(res).map((r) => ({
    ...r,
    mt: Math.round(n(r.mt) * 1000) / 1000,
    // Only a packing entry moves oil between the tank and the shelf; see the
    // packedOut source in stock.ts, which filters on exactly this.
    moves_bulk: String(r.kind) === 'packing'
  }))
}

// Remove one hand entry.
//
// Scoped to the active company so a row on the other company's books can never
// be reached by id, and it deletes ONLY the adjustment — a dispatch is a sale
// and is undone by editing the invoice, not from here.
export async function deleteSkuAdjustment(id: number): Promise<{ id: number; packaging_id: number }> {
  const c = getClient()
  const rid = n(id)
  if (!rid) throw new Error('Nothing to remove')
  const res = await c.execute({
    sql: 'SELECT id, packaging_id FROM sku_adjustments WHERE id = ? AND company_id = ?',
    args: [rid, getActiveCompanyId()]
  })
  if (!res.rows.length) throw new Error('That entry is not on this company\'s books')
  const pkg = n((res.rows[0] as unknown as Row).packaging_id)
  await c.execute({ sql: 'DELETE FROM sku_adjustments WHERE id = ?', args: [rid] })
  return { id: rid, packaging_id: pkg }
}

export async function adjustSkuStock(
  packagingId: number,
  delta: number,
  note?: string,
  date?: string,
  kind?: string
): Promise<{ id: number; on_hand: number }> {
  const c = getClient()
  const pid = n(packagingId)
  const d = n(delta)
  if (!pid) throw new Error('Select an SKU')
  if (d === 0) throw new Error('Enter a quantity to add or remove')
  const pkg = await c.execute({ sql: 'SELECT id FROM packagings WHERE id = ?', args: [pid] })
  if (!pkg.rows.length) throw new Error('SKU not found')
  const adjDate = (date && String(date).slice(0, 10)) || todayISO()
  // A correction has to say why -- an unexplained hand-typed fix to a stock
  // figure is the thing the indication exists to catch.
  const k = String(kind) === 'correction' ? 'correction' : 'packing'
  if (k === 'correction' && !String(note || '').trim()) {
    throw new Error('Say what is being corrected — a correction without a reason cannot be checked later')
  }
  await c.execute({
    sql: `INSERT INTO sku_adjustments (company_id, packaging_id, delta, adj_date, note, kind, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      pid,
      d,
      adjDate,
      note ? String(note).trim() : null,
      k,
      getCurrentUser().username || null
    ]
  })
  const rows = await listSkuStock()
  const cur = rows.find((r) => Number(r.id) === pid)
  return { id: pid, on_hand: cur ? Number(cur.on_hand) : 0 }
}
