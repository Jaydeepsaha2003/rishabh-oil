// COMMENTS ON A SALES INVOICE, and the REJECT REASONS kept as favourites.
// A comment is a note on the invoice (all its lines, keyed by invoice_group):
// who wrote it and when. Nothing posted changes. Favourite reject reasons are
// one shared list, offered in the Reject window's dropdown.
import { getClient } from './db'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function ensure(): Promise<void> {
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS sale_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_group TEXT NOT NULL,
    body TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  await c.execute('CREATE INDEX IF NOT EXISTS idx_sale_comments_group ON sale_comments(invoice_group)')
  await c.execute(`CREATE TABLE IF NOT EXISTS sale_reject_reasons (
    reason TEXT PRIMARY KEY COLLATE NOCASE,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
}

/** Every comment, newest first, grouped by invoice — the list shows a count and the latest. */
export async function listSaleComments(): Promise<Row[]> {
  await ensure()
  const r = await getClient().execute('SELECT id, invoice_group, body, created_by, created_at FROM sale_comments ORDER BY id DESC')
  return r.rows.map((x) => ({ ...(x as unknown as Row) }))
}

export async function addSaleComment(group: string, body: string): Promise<{ id: number }> {
  await ensure()
  const g = String(group || '').trim()
  const b = String(body || '').trim().slice(0, 2000)
  if (!g) throw new Error('No invoice picked')
  if (!b) throw new Error('Write the comment first')
  const r = await getClient().execute({
    sql: 'INSERT INTO sale_comments (invoice_group, body, created_by) VALUES (?, ?, ?)',
    args: [g, b, getCurrentUser().username || null]
  })
  return { id: Number(r.lastInsertRowid) }
}

/** A comment goes only at the hand of whoever wrote it (or an admin). */
export async function deleteSaleComment(id: number): Promise<{ id: number }> {
  await ensure()
  const c = getClient()
  const row = (await c.execute({ sql: 'SELECT created_by FROM sale_comments WHERE id = ?', args: [Number(id)] })).rows[0] as unknown as Row | undefined
  if (!row) return { id }
  const me = getCurrentUser()
  if (String(row.created_by || '') !== String(me.username || '')) {
    const { assertAdmin } = await import('./access-gate')
    await assertAdmin('Deleting somebody else\'s comment').catch(() => {
      throw new Error('Only the person who wrote a comment (or an admin) can delete it')
    })
  }
  await c.execute({ sql: 'DELETE FROM sale_comments WHERE id = ?', args: [Number(id)] })
  return { id }
}

export async function listRejectReasons(): Promise<string[]> {
  await ensure()
  const r = await getClient().execute('SELECT reason FROM sale_reject_reasons ORDER BY reason COLLATE NOCASE')
  return r.rows.map((x) => String((x as unknown as Row).reason))
}

/** Star / un-star a reason. */
export async function setRejectReasonFav(reason: string, on: boolean): Promise<string[]> {
  await ensure()
  const t = String(reason || '').trim().slice(0, 300)
  if (!t) throw new Error('Write the reason first')
  if (on) await getClient().execute({ sql: 'INSERT OR IGNORE INTO sale_reject_reasons (reason, created_by) VALUES (?, ?)', args: [t, getCurrentUser().username || null] })
  else await getClient().execute({ sql: 'DELETE FROM sale_reject_reasons WHERE reason = ?', args: [t] })
  return listRejectReasons()
}
