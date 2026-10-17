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
const clean = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase()

/**
 * WHAT THE CODE ASKS FOR, AND WHAT IT ACTUALLY POSTS TO.
 *
 * Half this app posts by NAME. A purchase writes to `{OIL} PUR A/C`, GST to
 * `GST INPUT A/C`, an LC to `HDFCBANK A/C` — getOrCreateAccount looks the name
 * up and makes it if it is not there. That is why renaming a ledger was
 * refused in Masters: rename HDFCBANK A/C and the next purchase quietly opens
 * a SECOND account under the old name, leaving the history behind in the first.
 *
 * This table is the one thing that makes a rename safe. It says "postings
 * addressed to X go to Y", and getOrCreateAccount reads it before it touches
 * ledger_accounts. Rename a ledger and a row is written here at the same time,
 * so every future posting follows the ledger to its new name instead of
 * re-creating the old one.
 *
 * It also does the other half of the job on its own: point the app's postings
 * at a DIFFERENT existing ledger without renaming anything.
 *
 * Per book, because two companies can keep their own names for the same thing
 * — and a row with no company is the fallback for every book, which is how a
 * site-wide rename is expressed.
 */
/**
 * Renames recorded before the redirect was made site-wide covered only the
 * company they were made in. Widen them once: the ledger they point at is the
 * same row in every book. A name that already has a site-wide rule keeps it.
 * Only ledger_map changes — no voucher is touched.
 */
export async function widenRenameRedirects(): Promise<number> {
  await ensureLedgerMap()
  const r = await getClient().execute(`UPDATE ledger_map SET company_id = NULL
     WHERE company_id IS NOT NULL AND note LIKE 'renamed from %'
       AND NOT EXISTS (SELECT 1 FROM ledger_map g WHERE g.company_id IS NULL AND g.posts_as = ledger_map.posts_as)
       AND id = (SELECT MIN(m.id) FROM ledger_map m WHERE m.posts_as = ledger_map.posts_as AND m.note LIKE 'renamed from %')`)
  return Number(r.rowsAffected || 0)
}

export async function ensureLedgerMap(): Promise<void> {
  const c = getClient()
  await c.execute(
    `CREATE TABLE IF NOT EXISTS ledger_map (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       company_id INTEGER,
       posts_as TEXT NOT NULL,
       use_name TEXT NOT NULL,
       note TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       created_by TEXT
     )`
  )
  await c.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_map ON ledger_map(COALESCE(company_id, 0), posts_as)'
  )
}

/**
 * The name a posting should really use.
 *
 * The book's own rule first, then the one that covers every book, then the
 * name as given. Chained redirects are NOT followed: a rename rewrites the
 * rows that pointed at the old name (see renameLedger), so one hop is always
 * the whole answer — and a map that followed chains could be walked into a
 * ring by two renames in opposite directions.
 */
export async function resolveAccountName(name: string, companyId?: number): Promise<string> {
  const asked = clean(name)
  if (!asked) return String(name || '')
  try {
    const cid = n(companyId) || getActiveCompanyId()
    const res = await getClient().execute({
      sql: `SELECT use_name, company_id FROM ledger_map
             WHERE posts_as = ? AND (company_id = ? OR company_id IS NULL)
             ORDER BY company_id IS NULL
             LIMIT 1`,
      args: [asked, cid]
    })
    const hit = String((res.rows[0] as unknown as Row)?.use_name || '').trim()
    return hit || String(name || '')
  } catch {
    // No table yet — a books file older than this. The name as asked for is
    // exactly what every posting used before, so nothing changes.
    return String(name || '')
  }
}

/** Every redirect in force, with what it points at. */
export async function listLedgerMap(companyId?: number): Promise<Row[]> {
  await ensureLedgerMap()
  const cid = n(companyId) || getActiveCompanyId()
  const res = await getClient().execute({
    args: [cid],
    sql: `SELECT m.id, m.company_id, m.posts_as, m.use_name, m.note, m.created_at, m.created_by,
                 (SELECT a.id FROM ledger_accounts a WHERE TRIM(UPPER(a.name)) = TRIM(UPPER(m.use_name))) AS account_id
            FROM ledger_map m
           WHERE m.company_id = ? OR m.company_id IS NULL
           ORDER BY m.posts_as`
  })
  return toPlain(res)
}

/**
 * RENAMING A LEDGER THE APP POSTS TO.
 *
 * Two writes, and both are needed:
 *   the account itself takes the new name, so every statement, report and
 *   balance already posted follows it — they point at the row, not the word;
 *   and a redirect is written, so the next posting that asks for the OLD name
 *   lands on the same row instead of opening a second account under it.
 *
 * Anything that already pointed at the old name is re-pointed, so two renames
 * in a row leave one hop rather than a chain — and the redirect a rename would
 * create BACK to the new name is dropped, because a name cannot redirect to
 * itself.
 */
export async function renameLedger(
  accountId: number,
  newName: string,
  companyId?: number
): Promise<{ id: number; from: string; to: string }> {
  await ensureLedgerMap()
  const c = getClient()
  const cid = n(companyId) || getActiveCompanyId()
  const cur = await c.execute({ sql: 'SELECT id, name FROM ledger_accounts WHERE id = ?', args: [n(accountId)] })
  if (!cur.rows.length) throw new Error('No such ledger')
  const from = String((cur.rows[0] as unknown as Row).name || '')
  // UPPER CASE, BECAUSE THAT IS HOW EVERY LEDGER IS STORED.
  //
  // getOrCreateAccount uppercases what it is asked for and then looks the row
  // up by exact name. A ledger saved in mixed case would not be found by it —
  // and INSERT OR IGNORE would quietly open a second account beside it, which
  // is the precise failure this whole mechanism exists to prevent.
  const to = String(newName ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
  if (!to) throw new Error('A ledger needs a name')
  if (clean(to) === clean(from)) return { id: n(accountId), from, to: from }
  const clash = await c.execute({
    sql: 'SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ? AND id <> ?',
    args: [clean(to), n(accountId)]
  })
  if (clash.rows.length) {
    throw new Error(`There is already a ledger called ${to} — move the postings instead of renaming onto it`)
  }

  await c.execute({ sql: 'UPDATE ledger_accounts SET name = ? WHERE id = ?', args: [to, n(accountId)] })
  // Everything that pointed at the old name follows it.
  await c.execute({
    sql: 'UPDATE ledger_map SET use_name = ? WHERE TRIM(UPPER(use_name)) = ?',
    args: [to, clean(from)]
  })
  // And the old name itself becomes a redirect — for EVERY book, not just the
  // one the rename was made in. The ledger row is shared: renaming it renamed
  // it for both companies, so a redirect kept to one of them left the other
  // posting to the old name, which opened a fresh empty ledger under it and
  // split that party's balance in two (KR FINMARK's DIL EXIM and LEGACY
  // settlements, re-posted, went exactly there).
  void cid
  await c.execute({
    sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
          VALUES (NULL, ?, ?, ?, ?)
          ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name`,
    args: [clean(from), to, `renamed from ${from}`, getCurrentUser().username || null]
  })
  // A redirect from the NEW name to itself is noise, and would be a ring if
  // the ledger were ever renamed back.
  await c.execute({
    sql: 'DELETE FROM ledger_map WHERE posts_as = ? AND TRIM(UPPER(use_name)) = ?',
    args: [clean(to), clean(to)]
  })
  return { id: n(accountId), from, to }
}

/** Point what the app posts as one name at a different ledger entirely. */
export async function setLedgerMap(a: {
  postsAs: string
  useName: string
  companyId?: number
  note?: string
}): Promise<{ id: number }> {
  await ensureLedgerMap()
  const c = getClient()
  const cid = n(a.companyId) || getActiveCompanyId()
  const from = clean(a.postsAs)
  const to = String(a.useName ?? '').trim().replace(/\s+/g, ' ')
  if (!from || !to) throw new Error('Both the posted name and the ledger to use are needed')
  if (clean(to) === from) {
    // Not an error — it is how a redirect is cleared.
    await c.execute({ sql: 'DELETE FROM ledger_map WHERE company_id = ? AND posts_as = ?', args: [cid, from] })
    return { id: 0 }
  }
  const res = await c.execute({
    sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name, note = excluded.note`,
    args: [cid, from, to, a.note ? String(a.note).slice(0, 200) : null, getCurrentUser().username || null]
  })
  return { id: Number(res.lastInsertRowid || 0) }
}

/** Take a redirect off — postings addressed to that name go back to it. */
export async function dropLedgerMap(id: number): Promise<{ id: number }> {
  await ensureLedgerMap()
  await getClient().execute({ sql: 'DELETE FROM ledger_map WHERE id = ?', args: [n(id)] })
  return { id: n(id) }
}
