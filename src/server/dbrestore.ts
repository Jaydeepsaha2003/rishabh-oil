// Replacing the website's database with a snapshot taken from Turso.
// -----------------------------------------------------------------------------
// The website runs off a local SQLite file. Everything the mill records goes
// into the desktop app's Turso database, so the website's file is a copy that
// goes stale the moment it is made. This is how it is brought up to date: an
// admin downloads a snapshot from the desktop app and uploads it here.
//
// It is done as ONE TRANSACTION on the live connection — drop everything,
// replay the snapshot, commit — rather than by building a new file and moving
// it into place. Two reasons, and the second is the one that decided it:
//
//   1. SQLite's DDL is transactional. DROP TABLE and CREATE TABLE roll back
//      like anything else, so a snapshot that fails halfway leaves the
//      database exactly as it was. There is no window in which the site has
//      half a database.
//
//   2. Swapping the file cannot be made reliable here. The connection would
//      have to be closed for the rename, and db.ts's revision watcher polls on
//      a timer — it reopens the database within milliseconds, so the file is
//      never actually free. (Windows then refuses the rename outright; Linux
//      allows it and silently leaves the watcher reading a file nobody can
//      find any more, which is worse.)
//
// Before any of that, a copy of the current database is taken, so a restore
// can be undone even after it has committed.
import { type Client } from '@libsql/client'
import { gunzipSync } from 'node:zlib'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getClient } from '../main/db'
import { runStartupTasks } from '../main/bootstrap'

// Tables that must be present for a file to be this application's database.
// Deliberately short and central: enough that another SQLite file cannot pass,
// not so many that a legitimate older snapshot is rejected for missing
// something added last month.
const REQUIRED_TABLES = ['users', 'products', 'orders', 'sales', 'app_settings']

// How many replaced databases to keep. Each is a full copy, so this is disk
// space against being able to go back — three is more than anyone has needed
// and still a fraction of the account's quota.
const KEEP_BACKUPS = 3

function configuredUrl(): string {
  return String(process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || '')
}

// Where the live database actually is, or null when this deployment runs
// against a cloud database instead — in which case there is no file to
// replace and restoring here would be meaningless.
export function livePath(): string | null {
  const url = configuredUrl()
  if (!url.startsWith('file:')) return null
  return url.slice('file:'.length)
}

function sizeOf(path: string): number {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(path + suffix).size
    } catch {
      // -wal/-shm are absent between checkpoints; that is not an error.
    }
  }
  return total
}

function backupDir(live: string): string {
  const dir = join(dirname(live), 'replaced')
  mkdirSync(dir, { recursive: true })
  return dir
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

export interface DbStatus {
  // Restoring is only possible against a local file.
  supported: boolean
  path: string | null
  bytes: number
  tables: number
  rows: number
  // Newest first.
  restorePoints: { name: string; bytes: number; at: string }[]
}

// A count of everything, so the page can show what is there now beside what
// arrived in the file being uploaded.
async function countAll(c: Client): Promise<{ tables: number; rows: number }> {
  const names = await userTables(c)
  if (!names.length) return { tables: 0, rows: 0 }
  // One statement rather than one per table: eighty round trips to answer a
  // number on a settings page is eighty too many.
  const union = names.map((n) => `SELECT COUNT(*) AS k FROM "${n}"`).join(' UNION ALL ')
  const res = await c.execute(union)
  let rows = 0
  for (const r of res.rows) rows += Number(r.k) || 0
  return { tables: names.length, rows }
}

async function userTables(c: Client): Promise<string[]> {
  const res = await c.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'`
  )
  return res.rows.map((r) => String(r.name))
}

export async function dbStatus(): Promise<DbStatus> {
  const live = livePath()
  const counted = await countAll(getClient()).catch(() => ({ tables: 0, rows: 0 }))
  if (!live) {
    return { supported: false, path: null, bytes: 0, ...counted, restorePoints: [] }
  }
  const dir = join(dirname(live), 'replaced')
  const points = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith(basename(live) + '.'))
        .map((f) => {
          const st = statSync(join(dir, f))
          return { name: f, bytes: st.size, at: st.mtime.toISOString() }
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1))
    : []
  return { supported: true, path: live, bytes: sizeOf(live), ...counted, restorePoints: points }
}

export interface RestoreReport {
  tables: number
  rows: number
  bytes: number
  replacedBackup: string
  tookMs: number
  before: { tables: number; rows: number }
}

// Everything that can be checked without touching the database, checked before
// anything is dropped. A transaction would roll back a bad snapshot anyway,
// but rolling back a restore of the whole database takes as long as doing it,
// and "that is not the right file" is worth saying in a second rather than a
// minute.
function readSnapshot(buf: Buffer): string {
  // Gzip's magic number. The desktop app always sends compressed, but a file
  // someone has already unzipped by hand should still work.
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
  let text: string
  try {
    text = (gz ? gunzipSync(buf) : buf).toString('utf8')
  } catch {
    throw new Error('That file is not readable — the download may have been cut short.')
  }
  if (!/CREATE\s+TABLE/i.test(text)) {
    throw new Error('That is not a snapshot. Upload the .sql.gz file the app gives you.')
  }
  // Every snapshot this app writes ends with COMMIT, so one that does not
  // stopped early — and half a database is the one thing this must never load.
  // Checked before the table list below, so a download that was cut short is
  // reported as what it is rather than as a file missing whichever table the
  // cut happened to land in front of.
  if (!/COMMIT\s*;\s*$/i.test(text)) {
    throw new Error('The snapshot is incomplete — it ends mid-file. Download it again.')
  }
  const missing = REQUIRED_TABLES.filter(
    (t) => !new RegExp(`CREATE\\s+TABLE(\\s+IF\\s+NOT\\s+EXISTS)?\\s+"?${t}"?\\b`, 'i').test(text)
  )
  if (missing.length) {
    throw new Error(`The snapshot has no ${missing.join(', ')} table — it is not this app's database.`)
  }
  if (!/INSERT\s+INTO/i.test(text)) {
    throw new Error('The snapshot holds a schema but no data — nothing would be restored.')
  }
  return text
}

// The snapshot supplies its own PRAGMA and its own BEGIN/COMMIT. They are
// stripped so the whole restore can run inside ONE transaction of ours,
// together with the drops that have to happen in the same breath.
//
// Removed only from where the snapshot actually writes them: the header,
// which is everything before the first CREATE TABLE and so cannot contain
// data, and the single COMMIT that ends the file. Stripping every line that
// merely READS as one of these would also rewrite a piece of data that happens
// to look like it — a remark typed across two lines with COMMIT; alone on the
// second — and silently corrupt the row it belongs to.
function body(sql: string): string {
  const firstCreate = sql.search(/CREATE\s+TABLE/i)
  if (firstCreate < 0) return sql
  const head = sql
    .slice(0, firstCreate)
    .replace(/^\s*(PRAGMA\s+foreign_keys\s*=\s*OFF|BEGIN(\s+\w+)?\s+TRANSACTION)\s*;\s*$/gim, '')
  const rest = sql.slice(firstCreate).replace(/\s*COMMIT\s*;\s*$/i, '\n')
  return head + rest
}

// Everything a fresh connection to a local file needs. Per-CONNECTION rather
// than stored in the file, so it has to be redone after a swap exactly as
// src/server/index.ts does it on start — which is why that file calls this one
// rather than keeping its own copy of the list.
export async function applyFilePragmas(c: Client): Promise<void> {
  await c.execute('PRAGMA busy_timeout = 5000').catch(() => {})
  await c.execute('PRAGMA journal_mode = WAL').catch(() => {})
  await c.execute('PRAGMA synchronous = NORMAL').catch(() => {})
  await c.execute('PRAGMA foreign_keys = ON').catch(() => {})
}

export async function restoreFromDump(buf: Buffer): Promise<RestoreReport> {
  const started = Date.now()
  const live = livePath()
  if (!live) {
    throw new Error(
      'This site runs against a cloud database, not a local file, so there is nothing here to replace.'
    )
  }
  const sql = readSnapshot(buf)

  const c = getClient()
  const before = await countAll(c).catch(() => ({ tables: 0, rows: 0 }))

  // ---- the copy you can go back to ----------------------------------------
  // Taken after a checkpoint so the single file is complete on its own, and by
  // copying rather than moving: the live connection stays open throughout, and
  // reading a file that is open is allowed everywhere.
  await c.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {})
  const keptName = `${basename(live)}.${stamp()}`
  copyFileSync(live, join(backupDir(live), keptName))

  // ---- drop what is there, load what arrived, in one transaction ----------
  const existing = await c.execute(
    `SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END`
  )
  const drops = existing.rows
    .map((r) => {
      const kind = String(r.type).toUpperCase()
      return kind === 'TABLE' || kind === 'VIEW' || kind === 'INDEX' || kind === 'TRIGGER'
        ? `DROP ${kind} IF EXISTS "${String(r.name)}";`
        : ''
    })
    .filter(Boolean)
    .join('\n')

  // Outside the transaction, because SQLite ignores this pragma inside one.
  // Off for the duration: the drops and the reload both move through states
  // where a reference is briefly unsatisfied.
  await c.execute('PRAGMA foreign_keys = OFF').catch(() => {})
  try {
    await c.executeMultiple(`BEGIN TRANSACTION;\n${drops}\n${body(sql)}\nCOMMIT;`)
  } catch (e) {
    // The transaction is left open by a failed script; closing it is what puts
    // the database back. The copy above is the safety net if even this fails.
    await c.execute('ROLLBACK').catch(() => {})
    await c.execute('PRAGMA foreign_keys = ON').catch(() => {})
    throw new Error(
      `The snapshot could not be loaded (${(e as Error).message}). Nothing was changed — ` +
        'the database is exactly as it was.'
    )
  }
  await c.execute('PRAGMA foreign_keys = ON').catch(() => {})
  await c.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {})

  // ---- what landed --------------------------------------------------------
  const after = await countAll(c)
  // The same migrations the server runs at start. A snapshot carries the
  // schema it was taken with, so if the desktop app is a version behind this
  // one, this is what brings the difference across.
  await runStartupTasks()

  // ---- prune --------------------------------------------------------------
  try {
    const dir = backupDir(live)
    const olds = readdirSync(dir)
      .filter((f) => f.startsWith(basename(live) + '.'))
      .sort()
    for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) {
      rmSync(join(dir, f), { force: true })
    }
  } catch {
    // Running out of old copies to delete is not a failed restore.
  }

  return {
    tables: after.tables,
    rows: after.rows,
    bytes: sizeOf(live),
    replacedBackup: keptName,
    tookMs: Date.now() - started,
    before
  }
}
