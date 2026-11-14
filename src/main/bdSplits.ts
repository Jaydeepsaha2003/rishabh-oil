import { getClient } from './db'
import { getCurrentUser } from './currentUser'

// A SPLIT WORKED ON A BILL'S INTEREST, KEPT (the + on a serviced-interest
// period or leg). A record only: it says how the user chose to see the
// principal or the days in parts, shown under the period — no voucher, and
// the interest due is unchanged. One per stretch; saving again replaces it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

async function ensure(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS bd_interest_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bd_id INTEGER NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    mode TEXT NOT NULL,
    parts TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  )`)
}

export async function listBdSplits(bdId: number): Promise<Row[]> {
  await ensure()
  const r = await getClient().execute({ sql: 'SELECT * FROM bd_interest_splits WHERE bd_id = ? ORDER BY from_date, id', args: [n(bdId)] })
  return r.rows.map((x) => {
    const row = { ...(x as unknown as Row) }
    try {
      row.parts = JSON.parse(String(row.parts || '[]'))
    } catch {
      row.parts = []
    }
    return row
  })
}

export async function saveBdSplit(v: Row): Promise<{ id: number }> {
  await ensure()
  const bdId = n(v.bd_id)
  const from = String(v.from_date || '').slice(0, 10)
  const to = String(v.to_date || '').slice(0, 10)
  const mode = v.mode === 'dates' ? 'dates' : 'amount'
  if (!bdId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Which period is this split for?')
  const parts = (Array.isArray(v.parts) ? v.parts : [])
    .map((p: Row) => ({ label: String(p.label || '').slice(0, 80), value: n(p.value), interest: n(p.interest) }))
    .filter((p: Row) => p.value > 0)
  if (parts.length < 2 || parts.length > 3) throw new Error('A split has 2 or 3 parts, each more than zero')
  const c = getClient()
  const bd = await c.execute({ sql: 'SELECT id FROM bill_discountings WHERE id = ?', args: [bdId] })
  if (!bd.rows.length) throw new Error('That bill no longer exists')
  await c.execute({ sql: 'DELETE FROM bd_interest_splits WHERE bd_id = ? AND from_date = ? AND to_date = ?', args: [bdId, from, to] })
  const ins = await c.execute({
    sql: 'INSERT INTO bd_interest_splits (bd_id, from_date, to_date, mode, parts, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [bdId, from, to, mode, JSON.stringify(parts), getCurrentUser().username || null]
  })
  return { id: Number(ins.lastInsertRowid) }
}

export async function deleteBdSplit(id: number): Promise<{ id: number }> {
  await ensure()
  await getClient().execute({ sql: 'DELETE FROM bd_interest_splits WHERE id = ?', args: [n(id)] })
  return { id: n(id) }
}
