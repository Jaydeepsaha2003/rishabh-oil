// One database, written out as portable SQL.
// -----------------------------------------------------------------------------
// The desktop app talks to Turso; the website talks to a local SQLite file.
// Both are the same engine, so a snapshot taken from one restores into the
// other verbatim — which is the whole point: the mill records its day in the
// desktop app, and the website is brought up to date by carrying one file
// across.
//
// SQL text rather than a .db file, deliberately. Producing a real .db would
// need the NATIVE libsql driver, and db.ts imports '@libsql/client/web' on
// purpose because the native addon is what crashed fresh machines on first
// launch (see the note at the top of db.ts). A dump is pure JavaScript, so it
// works on every machine the app is installed on, and the server — which does
// have the native driver — rebuilds a real database from it.
import { gzipSync } from 'node:zlib'
import type { Client, ResultSet } from '@libsql/client/web'
import { getClient } from './db'

// SQL-literal encoding: NULL, numbers as-is, strings quoted with doubled
// quotes, buffers as X'..' hex.
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const buf = v instanceof ArrayBuffer ? new Uint8Array(v) : v
    return `X'${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}'`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

// Every CREATE gets IF NOT EXISTS so the same dump can be replayed onto a
// database that already has the schema, not only onto an empty file.
function idempotent(sql: string): string {
  return sql.replace(
    /^\s*CREATE\s+(UNIQUE\s+|TEMP\s+|TEMPORARY\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?!IF\s+NOT\s+EXISTS)/i,
    (_m, mod: string | undefined, kind: string) => `CREATE ${mod || ''}${kind} IF NOT EXISTS `
  )
}

// SQLite's own bookkeeping, and libSQL's. Never copied: sqlite_sequence is
// handled separately below, and the rest belong to whichever engine is holding
// the file.
function internal(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('libsql_') || name === '_litestream_seq'
}

export interface SnapshotMeta {
  at: string
  tables: number
  rows: number
  bytes: number
}

export interface Snapshot extends SnapshotMeta {
  sql: string
}

// Rows per INSERT. One statement per row is 40,000 statements on a database
// this size, and the restore has to parse every one of them; batching cuts
// that by two orders of magnitude while keeping each statement small enough to
// read in a text editor when something needs checking by hand.
const ROWS_PER_INSERT = 200

// Rows per round trip. A whole table in one SELECT is the obvious way to write
// this, and it is what breaks first: against Turso the result comes back over
// HTTP as a single response, so the largest table sets a ceiling on how big the
// mill's database can get before a snapshot stops working. Reading it in pages
// removes the ceiling, and costs a handful of extra round trips on a job that
// is run by hand a few times a month.
const READ_PAGE = 2000

// The alias the rowid is read under. Long and unlovely on purpose: it must not
// collide with a real column, because it is stripped from the INSERT and a
// collision would drop a column's data.
const RID = '__snapshot_rowid'

interface Page {
  columns: string[]
  rows: Record<string, unknown>[]
}

// Keyset pagination rather than LIMIT/OFFSET: OFFSET re-scans everything it
// skips, so the last page of a large table costs as much as the whole table,
// and the order is only stable while nothing is being written.
//
// A table declared WITHOUT ROWID has no rowid to key on. There are none in
// this schema, but a snapshot must not silently skip a table if one is ever
// added, so that case falls back to reading it in one go.
async function* readTable(c: Client, table: string): AsyncGenerator<Page> {
  let after: unknown = 0
  for (;;) {
    let res: ResultSet
    try {
      res = await c.execute({
        sql: `SELECT rowid AS ${RID}, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${READ_PAGE}`,
        args: [after as number]
      })
    } catch {
      const all = await c.execute(`SELECT * FROM "${table}"`)
      if (all.rows.length) {
        yield { columns: all.columns, rows: all.rows as unknown as Record<string, unknown>[] }
      }
      return
    }
    if (!res.rows.length) return
    const columns = res.columns.filter((x) => x !== RID)
    const rows = res.rows as unknown as Record<string, unknown>[]
    after = rows[rows.length - 1][RID]
    yield { columns, rows }
    if (res.rows.length < READ_PAGE) return
  }
}

export async function dumpSql(): Promise<Snapshot> {
  const c = getClient()
  const at = new Date().toISOString()
  const out: string[] = [
    `-- Rishabh Oil database snapshot, taken ${at}`,
    '-- Restore it from Settings -> Database on the website, or by hand:',
    '--   sqlite3 restored.db < this-file.sql',
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;'
  ]

  // Tables before the indexes, views and triggers that depend on them.
  const master = await c.execute(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
  )
  const tables: string[] = []
  for (const r of master.rows) {
    const name = String(r.name)
    if (internal(name)) continue
    out.push(`${idempotent(String(r.sql))};`)
    if (String(r.type) === 'table') tables.push(name)
  }

  let rows = 0
  for (const table of tables) {
    let wrote = 0
    const at = out.length
    // Placeholder for the row count, which is only known once the table has
    // been read. Written back below rather than counted twice.
    out.push('')

    for await (const page of readTable(c, table)) {
      wrote += page.rows.length
      const cols = page.columns.map((x) => `"${x}"`).join(', ')
      for (let i = 0; i < page.rows.length; i += ROWS_PER_INSERT) {
        const slice = page.rows.slice(i, i + ROWS_PER_INSERT)
        const tuples = slice
          .map((row) => `(${page.columns.map((col) => lit(row[col])).join(', ')})`)
          .join(',\n  ')
        out.push(`INSERT INTO "${table}" (${cols}) VALUES\n  ${tuples};`)
      }
    }

    if (wrote) out[at] = `-- ${table}: ${wrote} rows`
    else out.splice(at, 1)
    rows += wrote
  }

  // AUTOINCREMENT counters. Without these a restored database hands the next
  // record an id that a deleted one already used, and every reference written
  // against the old id now points at the new record. sqlite_sequence only
  // exists once something is declared AUTOINCREMENT, so its absence is normal
  // rather than an error.
  try {
    const seq = await c.execute('SELECT name, seq FROM sqlite_sequence')
    if (seq.rows.length) {
      out.push('-- AUTOINCREMENT high-water marks')
      for (const r of seq.rows) {
        out.push(
          `DELETE FROM sqlite_sequence WHERE name = ${lit(r.name)};` +
            ` INSERT INTO sqlite_sequence (name, seq) VALUES (${lit(r.name)}, ${lit(r.seq)});`
        )
      }
    }
  } catch {
    // No AUTOINCREMENT table in this database.
  }

  out.push('COMMIT;')
  const sql = out.join('\n')
  return { sql, at, tables: tables.length, rows, bytes: Buffer.byteLength(sql, 'utf8') }
}

export interface GzSnapshot extends SnapshotMeta {
  // Gzipped SQL, base64 so it survives the JSON trip to the browser. The
  // renderer turns it straight back into a Blob and saves it.
  gz: string
  gzBytes: number
  fileName: string
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export async function snapshotGz(): Promise<GzSnapshot> {
  const snap = await dumpSql()
  // Level 9: this runs once, by hand, and every megabyte saved is a megabyte
  // that does not have to be uploaded again from the mill's connection.
  const buf = gzipSync(Buffer.from(snap.sql, 'utf8'), { level: 9 })
  return {
    at: snap.at,
    tables: snap.tables,
    rows: snap.rows,
    bytes: snap.bytes,
    gz: buf.toString('base64'),
    gzBytes: buf.length,
    fileName: `rishabh-snapshot-${stamp()}.sql.gz`
  }
}
