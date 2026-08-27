import { getClient } from './db'
import { stockLevels, productValuationRates } from './stock'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// The day-close sheet: every product with its computed book qty merged with any
// actual count already saved for that date.
export async function stockCountSheet(date: string): Promise<Row[]> {
  const levels = await stockLevels()
  const rates = await productValuationRates()
  const saved = await getClient().execute({
    sql: 'SELECT * FROM stock_counts WHERE count_date = ? AND company_id = ?',
    args: [date, getActiveCompanyId()]
  })
  const byProduct = new Map<number, Row>()
  for (const r of saved.rows) byProduct.set(Number(r.product_id), r as unknown as Row)
  return levels.map((l) => {
    const s = byProduct.get(Number(l.id))
    // Use the snapshot rate saved with a prior count if present, otherwise the
    // current weighted-average cost. Actual value is always rate × actual qty.
    const rate =
      s && s.rate != null && Number(s.rate) > 0 ? Number(s.rate) : rates.get(Number(l.id)) || 0
    const actualQty = s && s.actual_qty != null ? Number(s.actual_qty) : null
    return {
      product_id: l.id,
      code: l.code,
      name: l.name,
      category: l.category,
      book_qty: l.stock,
      rate,
      book_value: (Number(l.stock) || 0) * rate,
      actual_qty: actualQty,
      actual_value: actualQty != null ? actualQty * rate : null,
      // PP — presentation stock, counted next to the physical figure.
      pp_qty: s && s.pp_qty != null ? Number(s.pp_qty) : null,
      note: s ? s.note : null
    }
  })
}

// The last count taken BEFORE this date, for the days the plant is shut.
//
// A factory standing idle for a few days has the same physical stock each
// morning, and re-typing the whole sheet to say "unchanged" is both tedious and
// the likeliest place to introduce a typo. This hands back the most recent
// earlier count so the sheet can be filled from it; the figures land in the
// form unsaved, so they can be adjusted and are only recorded when saved.
//
// Deliberately the most recent EARLIER count, not literally yesterday: a
// shutdown spans several days, and the last real count may be further back.
export async function previousStockCount(
  date: string
): Promise<{ source_date: string | null; items: Row[] }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const prev = await c.execute({
    sql: `SELECT MAX(count_date) AS d FROM stock_counts
          WHERE company_id = ? AND count_date < ?`,
    args: [cid, String(date).slice(0, 10)]
  })
  const src = prev.rows[0]?.d ? String(prev.rows[0].d) : null
  if (!src) return { source_date: null, items: [] }
  const res = await c.execute({
    sql: `SELECT product_id, actual_qty, pp_qty, note FROM stock_counts
          WHERE company_id = ? AND count_date = ?`,
    args: [cid, src]
  })
  return {
    source_date: src,
    items: res.rows.map((r) => ({
      product_id: Number(r.product_id),
      actual_qty: r.actual_qty == null ? null : Number(r.actual_qty),
      pp_qty: r.pp_qty == null ? null : Number(r.pp_qty),
      note: r.note ?? null
    }))
  }
}

// Saved actual counts for a date (for read-only history / dashboards).
export async function listStockCounts(date: string): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT sc.*, p.code, p.name, p.category
          FROM stock_counts sc LEFT JOIN products p ON p.id = sc.product_id
          WHERE sc.count_date = ? AND sc.company_id = ? ORDER BY p.category, p.name`,
    args: [date, getActiveCompanyId()]
  })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

export async function saveStockCounts(date: string, items: Row[]): Promise<{ count: number }> {
  const c = getClient()
  // Value the count with the current weighted-average cost — actual value is
  // never hand-typed; it is rate × actual qty and the rate is snapshotted.
  const rates = await productValuationRates()
  let count = 0
  for (const it of items || []) {
    const hasActual = it.actual_qty !== '' && it.actual_qty != null
    const hasPp = it.pp_qty !== '' && it.pp_qty != null
    // A row counts as entered when either figure is given.
    if (!hasActual && !hasPp) continue
    const pid = n(it.product_id)
    const actualQty = n(it.actual_qty)
    const rate = rates.get(pid) || 0
    await c.execute({
      sql: `INSERT INTO stock_counts (company_id, count_date, product_id, book_qty, actual_qty, rate, actual_value, pp_qty, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(company_id, count_date, product_id) DO UPDATE SET
              book_qty = excluded.book_qty,
              actual_qty = excluded.actual_qty,
              rate = excluded.rate,
              actual_value = excluded.actual_value,
              pp_qty = excluded.pp_qty,
              note = excluded.note`,
      args: [
        getActiveCompanyId(),
        date,
        pid,
        n(it.book_qty),
        actualQty,
        rate,
        actualQty * rate,
        hasPp ? n(it.pp_qty) : null,
        it.note || null
      ]
    })
    count++
  }
  return { count }
}
