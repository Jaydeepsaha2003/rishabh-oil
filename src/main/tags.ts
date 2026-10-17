import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
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

const n = (v: unknown): number => Number(v) || 0

/**
 * A TAG IS THE MILL'S OWN WORD FOR SOMETHING THE SOFTWARE HAS NO FIELD FOR.
 *
 * "Disputed", "Rate to be revised", "Gujarat lot", "Check with Banerjee" — the
 * reasons a particular bill is not like the others are endless and none of
 * them are worth a column. They are worth a label the desk can invent on the
 * spot, put on anything, and then filter by.
 *
 * WHAT CAN BE TAGGED. Anything that is a transaction with a page of its own:
 * a purchase, a sale invoice, a letter of credit, a discounted bill, a trading
 * deal, and a voucher in the day book. They share one table rather than each
 * carrying a tags column, because a tag is a thing in its own right — renamed
 * once and renamed everywhere — and because the next thing worth tagging then
 * costs a single line here, which is exactly what trading cost.
 *
 * WHAT A REF IS. Text, not a number, because the things being tagged are not
 * all keyed the same way: a purchase and an LC are rows with ids, and a sale
 * INVOICE is a group of rows sharing a string. Stringifying an id is lossless;
 * forcing a group into an integer column is not.
 */
export type TagEntity = 'order' | 'sale' | 'lc' | 'bd' | 'trading' | 'voucher'

const ENTITIES: TagEntity[] = ['order', 'sale', 'lc', 'bd', 'trading', 'voucher']

function entityOf(v: unknown): TagEntity {
  const want = String(v || '').trim().toLowerCase()
  const hit = ENTITIES.find((e) => e === want)
  if (!hit) throw new Error(`${want || 'that'} is not something this app tags`)
  return hit
}

// Trimmed, squeezed and capped. A tag is a label somebody reads in a chip —
// leading spaces and double spaces are typing, not meaning, and a tag longer
// than a chip can hold is a note that belongs in the remarks.
const clean = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)

const refOf = (v: unknown): string => String(v ?? '').trim()

export async function ensureTagTables(): Promise<void> {
  const c = getClient()
  await c.execute(
    `CREATE TABLE IF NOT EXISTS tags (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       company_id INTEGER,
       name TEXT NOT NULL,
       colour TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       created_by TEXT
     )`
  )
  // Per BOOK, not per site: KR FOODS and KR FINMARK keep separate books and a
  // label invented for one is not automatically the other's business. Compared
  // case-insensitively so "Disputed" and "disputed" cannot both exist.
  await c.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(company_id, TRIM(UPPER(name)))'
  )
  await c.execute(
    `CREATE TABLE IF NOT EXISTS tag_links (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tag_id INTEGER NOT NULL REFERENCES tags(id),
       entity TEXT NOT NULL,
       ref TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       created_by TEXT
     )`
  )
  await c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_links ON tag_links(tag_id, entity, ref)')
  await c.execute('CREATE INDEX IF NOT EXISTS idx_tag_links_ref ON tag_links(entity, ref)')
}

/** Every tag in this book, with how many things wear it. */
export async function listTags(companyId?: number): Promise<Row[]> {
  await ensureTagTables()
  const cid = n(companyId) || getActiveCompanyId()
  const res = await getClient().execute({
    args: [cid],
    sql: `SELECT t.id, t.name, t.colour, t.created_by, t.created_at,
                 (SELECT COUNT(*) FROM tag_links l WHERE l.tag_id = t.id) AS used,
                 (SELECT GROUP_CONCAT(DISTINCT l.entity) FROM tag_links l WHERE l.tag_id = t.id) AS used_on
            FROM tags t
           WHERE t.company_id = ?
           ORDER BY used DESC, TRIM(UPPER(t.name))`
  })
  return toPlain(res)
}

export async function createTag(a: { name: string; colour?: string; companyId?: number }): Promise<Row> {
  await ensureTagTables()
  const c = getClient()
  const cid = n(a.companyId) || getActiveCompanyId()
  const name = clean(a.name)
  if (!name) throw new Error('A tag needs a name')
  const dup = await c.execute({
    sql: 'SELECT id, name FROM tags WHERE company_id = ? AND TRIM(UPPER(name)) = TRIM(UPPER(?))',
    args: [cid, name]
  })
  // Not an error. Somebody typing a tag that already exists means the tag they
  // want — hand it back rather than refusing a name they cannot see yet.
  if (dup.rows.length) return toPlain(dup)[0]
  const res = await c.execute({
    sql: 'INSERT INTO tags (company_id, name, colour, created_by) VALUES (?, ?, ?, ?)',
    args: [cid, name, a.colour ? String(a.colour).slice(0, 16) : null, getCurrentUser().username || null]
  })
  return { id: Number(res.lastInsertRowid || 0), name, colour: a.colour || null, used: 0 }
}

export async function renameTag(id: number, name: string, colour?: string): Promise<{ id: number }> {
  await ensureTagTables()
  const c = getClient()
  const next = clean(name)
  if (!next) throw new Error('A tag needs a name')
  const cur = await c.execute({ sql: 'SELECT company_id FROM tags WHERE id = ?', args: [n(id)] })
  if (!cur.rows.length) throw new Error('No such tag')
  const cid = n((cur.rows[0] as unknown as Row).company_id)
  const clash = await c.execute({
    sql: 'SELECT id FROM tags WHERE company_id = ? AND TRIM(UPPER(name)) = TRIM(UPPER(?)) AND id <> ?',
    args: [cid, next, n(id)]
  })
  if (clash.rows.length) throw new Error(`There is already a tag called ${next}`)
  await c.execute({
    sql: 'UPDATE tags SET name = ?, colour = COALESCE(?, colour) WHERE id = ?',
    args: [next, colour ? String(colour).slice(0, 16) : null, n(id)]
  })
  return { id: n(id) }
}

/** Removing a tag removes it from everything it was on — that is what it means. */
export async function deleteTag(id: number): Promise<{ id: number; removed: number }> {
  await ensureTagTables()
  const c = getClient()
  const used = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM tag_links WHERE tag_id = ?', args: [n(id)] })
  await c.execute({ sql: 'DELETE FROM tag_links WHERE tag_id = ?', args: [n(id)] })
  await c.execute({ sql: 'DELETE FROM tags WHERE id = ?', args: [n(id)] })
  return { id: n(id), removed: n((used.rows[0] as unknown as Row)?.n) }
}

/**
 * The tags on a set of things, in one call.
 *
 * A register draws a hundred rows and each of them may wear a tag; asking once
 * per row is a hundred round trips to paint one screen. Keyed by ref so the
 * caller can look each row up directly.
 */
export async function tagsFor(entity: string, refs: unknown[], companyId?: number): Promise<Record<string, Row[]>> {
  await ensureTagTables()
  const e = entityOf(entity)
  const list = (Array.isArray(refs) ? refs : []).map(refOf).filter(Boolean)
  if (!list.length) return {}
  const cid = n(companyId) || getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT l.ref, t.id, t.name, t.colour
            FROM tag_links l JOIN tags t ON t.id = l.tag_id
           WHERE l.entity = ? AND t.company_id = ?
             AND l.ref IN (${list.map(() => '?').join(',')})
           ORDER BY TRIM(UPPER(t.name))`,
    args: [e, cid, ...list]
  })
  const out: Record<string, Row[]> = {}
  for (const r of toPlain(res)) {
    const k = String(r.ref)
    if (!out[k]) out[k] = []
    out[k].push({ id: n(r.id), name: String(r.name), colour: r.colour ?? null })
  }
  return out
}

/** Replace the whole set of tags on one thing. */
export async function setTags(entity: string, ref: unknown, tagIds: unknown[]): Promise<{ tags: number }> {
  await ensureTagTables()
  const c = getClient()
  const e = entityOf(entity)
  const key = refOf(ref)
  if (!key) throw new Error('Nothing to tag')
  const ids = Array.from(new Set((Array.isArray(tagIds) ? tagIds : []).map(n).filter((x) => x > 0)))
  await c.execute({ sql: 'DELETE FROM tag_links WHERE entity = ? AND ref = ?', args: [e, key] })
  const who = getCurrentUser().username || null
  for (const id of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO tag_links (tag_id, entity, ref, created_by) VALUES (?, ?, ?, ?)',
      args: [id, e, key, who]
    })
  }
  return { tags: ids.length }
}

/** Everything wearing one tag, so a tag can be read as a list of its own. */
export async function tagContents(tagId: number): Promise<Row[]> {
  await ensureTagTables()
  const res = await getClient().execute({
    sql: `SELECT entity, ref, created_at, created_by FROM tag_links
           WHERE tag_id = ? ORDER BY entity, created_at DESC`,
    args: [n(tagId)]
  })
  return toPlain(res)
}
