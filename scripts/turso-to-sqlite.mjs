// Copy the Turso database into a local SQLite file, verbatim.
//
// Same engine at both ends — libSQL IS SQLite — so this is a copy, not a
// translation: every table, every column, every index, every row, unchanged.
// That is the whole reason SQLite was the right target. A MySQL migration would
// have been a rewrite of 867 query sites; this is a transfer.
//
// It also closes the gap a blank file has. src/main/index.ts runs about twenty
// runOnce migrations at Electron startup — the ones that created stock_openings,
// sku_openings, gate_entry_sales, bd_payment_ins, bd_linked_orders and
// products.uom. The web server does not run that block, so a database built from
// scratch would be missing them. Copying the SCHEMA from the source, which has
// already had them applied, brings them across with everything else.
//
//   node --env-file=.env scripts/turso-to-sqlite.mjs [--out data/rishabh.db] [--force]
//
// Read-only against Turso. It never writes to the source.
import { createClient } from '@libsql/client'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const force = argv.includes('--force')
const outPath = resolve(process.cwd(), flag('out', 'data/rishabh.db'))

const sourceUrl =
  process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL
const sourceToken =
  process.env.MAIN_VITE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN

if (!sourceUrl) {
  console.error('No source database. Set TURSO_DATABASE_URL (run with --env-file=.env).')
  process.exit(1)
}
if (sourceUrl.startsWith('file:')) {
  console.error(`Source is already a local file (${sourceUrl}). Nothing to copy.`)
  process.exit(1)
}

// A destination that already holds data is not overwritten by accident: this
// script exists to seed a new database, and re-running it on a live one would
// discard whatever the website has recorded since.
if (existsSync(outPath) && !force) {
  const size = statSync(outPath).size
  console.error(
    `${outPath} already exists (${(size / 1048576).toFixed(2)} MB).\n` +
      'Pass --force to replace it. Anything the website has written since the last copy will be lost.'
  )
  process.exit(1)
}

mkdirSync(dirname(outPath), { recursive: true })
if (existsSync(outPath) && force) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(outPath + suffix)
    } catch {
      // -wal/-shm may not exist; the main file's failure surfaces on open.
    }
  }
}

const src = createClient({ url: sourceUrl, authToken: sourceToken })
const dst = createClient({ url: `file:${outPath}` })

const internal = (name) =>
  name.startsWith('sqlite_') || name.startsWith('libsql_') || name === '_litestream_seq'

async function main() {
  console.log(`source : ${sourceUrl.replace(/\/\/([^.]{0,8})[^/]*/, '//$1…')}`)
  console.log(`target : ${outPath}\n`)

  // --- schema, tables before the things that depend on them -----------------
  const schema = await src.execute(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
  )
  const objects = schema.rows.filter((r) => !internal(String(r.name)))
  const tables = objects.filter((r) => String(r.type) === 'table').map((r) => String(r.name))

  // Foreign keys off for the duration: the copy walks tables alphabetically, so
  // a child row can legitimately arrive before its parent.
  await dst.execute('PRAGMA foreign_keys = OFF')

  let made = 0
  for (const o of objects) {
    try {
      await dst.execute(String(o.sql))
      made++
    } catch (e) {
      console.error(`  ! could not create ${o.type} ${o.name}: ${e.message}`)
    }
  }
  console.log(`schema : ${made} of ${objects.length} objects created (${tables.length} tables)\n`)

  // --- rows ------------------------------------------------------------------
  let copiedTotal = 0
  const mismatches = []
  for (const table of tables) {
    const info = await dst.execute(`PRAGMA table_info("${table}")`)
    const cols = info.rows.map((r) => String(r.name))
    if (!cols.length) continue

    const data = await src.execute(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`)
    if (!data.rows.length) continue

    const placeholders = cols.map(() => '?').join(', ')
    const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`

    // Batched, and inside a transaction per batch: one statement per row over
    // 7,894 rows is slow enough to look broken.
    const BATCH = 400
    for (let i = 0; i < data.rows.length; i += BATCH) {
      const slice = data.rows.slice(i, i + BATCH)
      await dst.batch(
        slice.map((row) => ({ sql, args: cols.map((c) => row[c] ?? null) })),
        'write'
      )
    }

    // Counted at both ends rather than assumed.
    const after = await dst.execute(`SELECT COUNT(*) AS k FROM "${table}"`)
    const got = Number(after.rows[0].k)
    if (got !== data.rows.length) mismatches.push(`${table}: source ${data.rows.length}, target ${got}`)
    copiedTotal += got
    console.log(`  ${table.padEnd(30)} ${String(got).padStart(6)}`)
  }

  await dst.execute('PRAGMA foreign_keys = ON')

  // --- server pragmas, set once and stored in the file ----------------------
  // WAL lets readers carry on while a write is in flight, which is what a web
  // server does all day. It is a property of the database file, so setting it
  // here means the server never has to.
  const jm = await dst.execute('PRAGMA journal_mode = WAL')
  console.log(`\njournal mode : ${jm.rows[0] ? Object.values(jm.rows[0])[0] : 'unknown'}`)

  const size = existsSync(outPath) ? statSync(outPath).size : 0
  console.log(`rows copied  : ${copiedTotal.toLocaleString()}`)
  console.log(`file size    : ${(size / 1048576).toFixed(2)} MB`)

  if (mismatches.length) {
    console.error('\nROW COUNT MISMATCHES:')
    for (const m of mismatches) console.error(`  ${m}`)
    process.exit(1)
  }
  console.log('\nevery table matched its source count.')
  console.log(`\nPoint the server at it:  TURSO_DATABASE_URL=file:${outPath.replace(/\\/g, '/')}`)
}

main().catch((e) => {
  console.error('copy failed:', e.message)
  process.exit(1)
})
