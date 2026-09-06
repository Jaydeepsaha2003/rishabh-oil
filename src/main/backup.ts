import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dumpSql } from './dbsnapshot'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// One full-database dump per day, on the first launch of the day: schema plus
// every row as portable SQL, written to <userData>/backup. The same day's file
// is replaced when re-run; anything older than 7 days is pruned.
//
// The dump itself is dbsnapshot.ts's, the same one Settings -> Database hands
// you to download. Two copies of "write this database out as SQL" is one copy
// too many: the daily backup and the snapshot you actually restore from must
// be the same bytes, or the one that is never tested is the one you need.
export async function dailyBackup(dirOverride?: string): Promise<{ file: string; skipped: boolean }> {
  const dir = dirOverride || join(app.getPath('userData'), 'backup')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, `rishabh-oil-backup-${todayISO()}.sql`)
  if (existsSync(file)) return { file, skipped: true }

  const snap = await dumpSql()
  writeFileSync(file, snap.sql, 'utf-8')

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
  console.log(`[backup] daily backup written: ${file} (${snap.rows} rows)`)
  return { file, skipped: false }
}
