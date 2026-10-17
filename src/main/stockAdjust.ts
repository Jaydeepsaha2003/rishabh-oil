import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// A HAND ADJUSTMENT TO A PRODUCT'S BOOK STOCK.
//
// Book stock is worked out from what moved — received, produced, consumed,
// dispatched. Some of what happens on a floor is none of those: a tank found
// short on a dip, a spill, oil found in a line, a figure entered wrong months
// ago. This is where that is said, with a quantity (plus or minus), a date and
// a reason, against the company whose books it belongs to. Each one lands in
// the register's Adjusted column and in Closing, and the hover names it.
//
// A row is never edited: a wrong one is removed (kept, marked deleted, with who
// and when) and entered again, so the trail says what was done.

let ready = false
export async function ensureStockAdjustments(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS stock_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    adj_date TEXT NOT NULL,
    qty REAL NOT NULL,
    note TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    deleted_by TEXT
  )`)
  await getClient().execute(
    'CREATE INDEX IF NOT EXISTS idx_stock_adj_product ON stock_adjustments(product_id, company_id, adj_date)'
  )
  ready = true
}

/** Every adjustment on one product, newest first — removed ones included, marked. */
export async function listStockAdjustments(productId: number, companyIds?: number[]): Promise<Row[]> {
  await ensureStockAdjustments()
  const ids = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!ids.length) ids.push(getActiveCompanyId())
  const res = await getClient().execute({
    sql: `SELECT a.*, c.name AS company_name
            FROM stock_adjustments a
            LEFT JOIN companies c ON c.id = a.company_id
           WHERE a.product_id = ? AND a.company_id IN (${ids.map(() => '?').join(',')})
           ORDER BY a.adj_date DESC, a.id DESC`,
    args: [n(productId), ...ids]
  })
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}

export async function addStockAdjustment(v: {
  product_id: number
  qty: number
  date?: string
  note: string
  company_id?: number
}): Promise<{ id: number }> {
  await ensureStockAdjustments()
  const pid = n(v.product_id)
  const qty = Math.round(n(v.qty) * 1000) / 1000
  const note = String(v.note || '').trim()
  if (!pid) throw new Error('Pick the product to adjust')
  if (!qty) throw new Error('Enter the quantity to add or take off')
  if (!note) throw new Error('Say why — an adjustment without a reason cannot be checked later')
  const date = String(v.date || '').slice(0, 10) || todayISO()
  if (date > todayISO()) throw new Error('An adjustment cannot be dated in the future')
  const c = getClient()
  const p = await c.execute({ sql: 'SELECT id FROM products WHERE id = ?', args: [pid] })
  if (!p.rows.length) throw new Error('That product no longer exists')
  const cid = n(v.company_id) || getActiveCompanyId()
  // The register starts on the day the opening stock was counted, and that
  // count already holds everything before it — an adjustment dated earlier
  // would be on file but in no figure.
  const { bookOpeningDate } = await import('./stock')
  const opened = await bookOpeningDate(cid)
  if (opened && date < opened)
    throw new Error(`The books opened on ${opened.split('-').reverse().join('-')} — date the adjustment on or after it`)
  const r = await c.execute({
    sql: `INSERT INTO stock_adjustments (company_id, product_id, adj_date, qty, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [cid, pid, date, qty, note, getCurrentUser().username || null]
  })
  return { id: Number(r.lastInsertRowid) }
}

/** Removed, not erased: the row stays, marked, so the trail still shows it. */
export async function deleteStockAdjustment(id: number): Promise<{ id: number }> {
  await ensureStockAdjustments()
  const rid = n(id)
  if (!rid) throw new Error('Nothing to remove')
  const c = getClient()
  const r = await c.execute({ sql: 'SELECT id, deleted_at FROM stock_adjustments WHERE id = ?', args: [rid] })
  if (!r.rows.length) throw new Error('That adjustment no longer exists')
  if ((r.rows[0] as unknown as Row).deleted_at) throw new Error('That adjustment is already removed')
  await c.execute({
    sql: "UPDATE stock_adjustments SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?",
    args: [getCurrentUser().username || null, rid]
  })
  return { id: rid }
}
