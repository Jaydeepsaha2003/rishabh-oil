import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getClient } from './db'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// SQL-literal encoding for the dump: NULL, numbers as-is, strings quoted with
// doubled quotes, buffers as X'..' hex.
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const buf = v instanceof ArrayBuffer ? new Uint8Array(v) : v
    return `X'${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}'`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

// One full-database dump per day, on the first launch of the day: schema plus
// every row as portable SQL, written to <userData>/backup. The same day's file
// is replaced when re-run; anything older than 7 days is pruned.
export async function dailyBackup(dirOverride?: string): Promise<{ file: string; skipped: boolean }> {
  const dir = dirOverride || join(app.getPath('userData'), 'backup')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `rishabh-oil-backup-${todayISO()}.sql`)
  if (existsSync(file)) return { file, skipped: true }

  const c = getClient()
  const out: string[] = [
    `-- Rishabh Oil full backup, taken ${new Date().toISOString()}`,
    '-- Restore into an empty SQLite database: sqlite3 restored.db < thisfile.sql',
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;'
  ]

  const master = await c.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  )
  const tables: string[] = []
  for (const r of master.rows) {
    out.push(`${String(r.sql).replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')};`)
    if (String(r.type) === 'table') tables.push(String(r.name))
  }

  for (const table of tables) {
    const res = await c.execute(`SELECT * FROM "${table}"`)
    if (!res.rows.length) continue
    const cols = res.columns.map((x) => `"${x}"`).join(', ')
    out.push(`-- ${res.rows.length} rows`)
    for (const row of res.rows) {
      const vals = res.columns.map((col) => lit((row as Record<string, unknown>)[col])).join(', ')
      out.push(`INSERT INTO "${table}" (${cols}) VALUES (${vals});`)
    }
  }
  out.push('COMMIT;')
  writeFileSync(file, out.join('\n'), 'utf-8')

  // Keep a rolling week of dailies.
  const keep = 7
  const olds = readdirSync(dir)
    .filter((f) => /^rishabh-oil-backup-\d{4}-\d{2}-\d{2}\.sql$/.test(f))
    .sort()
  for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
    try {
      unlinkSync(join(dir, f))
    } catch {
      /* a locked old backup is not worth failing startup over */
    }
  }
  console.log(`[backup] daily backup written: ${file}`)
  return { file, skipped: false }
}
