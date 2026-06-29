import { getClient } from './db'
import { stockLevels } from './stock'

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
  const saved = await getClient().execute({
    sql: 'SELECT * FROM stock_counts WHERE count_date = ?',
    args: [date]
  })
  const byProduct = new Map<number, Row>()
  for (const r of saved.rows) byProduct.set(Number(r.product_id), r as unknown as Row)
  return levels.map((l) => {
    const s = byProduct.get(Number(l.id))
    return {
      product_id: l.id,
      code: l.code,
      name: l.name,
      category: l.category,
      book_qty: l.stock,
      actual_qty: s && s.actual_qty != null ? Number(s.actual_qty) : null,
      actual_value: s && s.actual_value != null ? Number(s.actual_value) : null,
      note: s ? s.note : null
    }
  })
}

// Saved actual counts for a date (for read-only history / dashboards).
export async function listStockCounts(date: string): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT sc.*, p.code, p.name, p.category
          FROM stock_counts sc LEFT JOIN products p ON p.id = sc.product_id
          WHERE sc.count_date = ? ORDER BY p.category, p.name`,
    args: [date]
  })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

export async function saveStockCounts(date: string, items: Row[]): Promise<{ count: number }> {
  const c = getClient()
  let count = 0
  for (const it of items || []) {
    const hasActual = it.actual_qty !== '' && it.actual_qty != null
    const hasValue = it.actual_value !== '' && it.actual_value != null
    if (!hasActual && !hasValue) continue
    await c.execute({
      sql: `INSERT INTO stock_counts (count_date, product_id, book_qty, actual_qty, actual_value, note)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(count_date, product_id) DO UPDATE SET
              book_qty = excluded.book_qty,
              actual_qty = excluded.actual_qty,
              actual_value = excluded.actual_value,
              note = excluded.note`,
      args: [
        date,
        n(it.product_id),
        n(it.book_qty),
        hasActual ? n(it.actual_qty) : 0,
        hasValue ? n(it.actual_value) : null,
        it.note || null
      ]
    })
    count++
  }
  return { count }
}
