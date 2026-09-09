// Read-only. Says which gate times the UTC fix would move, and why.
//
//   node --env-file=.env scripts/gate-time-audit.mjs
//   node scripts/gate-time-audit.mjs "file:some/copy.db"
//
// The repair itself is a runOnce migration (gate_time_utc_fix_v1, see
// src/main/gateTimeFix.ts) because the rows that need it are on the server.
// This is the same classification with nothing written, so it can be pointed
// at a copy of the server's file first and the count checked before a restart.
//
// It reports three groups:
//
//   UTC-stamped   entry_time == created_at. Written by a process running in
//                 UTC, i.e. the website before the timezone was pinned. These
//                 are wrong by 5h30 and are what the fix moves.
//   IST-stamped   entry_time == created_at + 5:30. The desktop app, on a
//                 machine in India. Already right. Untouched.
//   typed         Neither. A time keyed in by hand, or corrected afterwards on
//                 the edit form. Somebody's own figure. Untouched.

import { createClient } from '@libsql/client'

const SHIFT_MIN = 330
const TOL_MIN = 3

const url = process.argv[2] || process.env.TURSO_DATABASE_URL
if (!url) {
  console.error('No database. Pass one as an argument, or set TURSO_DATABASE_URL.')
  process.exit(1)
}
const client = createClient({
  url,
  authToken: url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN
})

const pad = (v) => String(v).padStart(2, '0')

const stampMs = (date, time) => {
  const d = String(date || '').slice(0, 10)
  const t = String(time || '').slice(0, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return null
  const ms = Date.parse(`${d}T${t}:00Z`)
  return Number.isFinite(ms) ? ms : null
}

const createdMs = (v) => {
  const raw = String(v || '').trim().replace(' ', 'T').replace(/Z$/, '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null
  const ms = Date.parse(`${raw.slice(0, 16)}:00Z`)
  return Number.isFinite(ms) ? ms : null
}

const split = (ms) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const res = await client.execute(
  `SELECT id, gate_entry_no, entry_date, entry_time, out_date, out_time, created_at
     FROM gate_entries
    WHERE entry_time IS NOT NULL AND TRIM(entry_time) <> ''
    ORDER BY id`
)

const utc = []
const ist = []
const typed = []
const outLeftAlone = []
let dayMoved = 0

for (const r of res.rows) {
  const created = createdMs(r.created_at)
  const stamp = stampMs(r.entry_date, r.entry_time)
  if (created == null || stamp == null) continue
  const diff = Math.round((stamp - created) / 60000)
  const outMs = stampMs(r.out_date, r.out_time)
  const row = {
    id: Number(r.id),
    no: String(r.gate_entry_no || ''),
    in: `${r.entry_date} ${String(r.entry_time).slice(0, 5)}`,
    out: outMs == null ? '' : `${r.out_date} ${String(r.out_time).slice(0, 5)}`,
    created: String(r.created_at || ''),
    diff
  }
  if (Math.abs(diff) <= TOL_MIN) {
    row.newIn = split(stamp + SHIFT_MIN * 60000)
    row.newOut = outMs == null ? '' : split(outMs + SHIFT_MIN * 60000)
    if (row.newIn.slice(0, 10) !== row.in.slice(0, 10)) dayMoved += 1
    if (row.newOut && row.newOut < row.newIn) row.warn = 'out before in after the shift'
    utc.push(row)
  } else if (Math.abs(diff - SHIFT_MIN) <= TOL_MIN) {
    ist.push(row)
  } else {
    typed.push(row)
    if (outMs != null) outLeftAlone.push(row)
  }
}

console.log(`\nGate entries with a time: ${res.rows.length}\n`)
console.log(`  UTC-stamped (WOULD BE FIXED) : ${utc.length}`)
console.log(`  IST-stamped (already right)  : ${ist.length}`)
console.log(`  typed by hand (left alone)   : ${typed.length}`)
if (dayMoved) console.log(`\n  ${dayMoved} of the fixed rows also move to the NEXT DAY (stamped before 05:30 IST).`)
if (outLeftAlone.length)
  console.log(`  ${outLeftAlone.length} row(s) carry an out time whose IN did not qualify — out left as it is.`)

if (utc.length) {
  console.log('\nWhat would change:\n')
  console.table(
    utc.map((r) => ({
      'gate no': r.no,
      'in (now)': r.in,
      'in (fixed)': r.newIn,
      'out (now)': r.out || '—',
      'out (fixed)': r.newOut || '—',
      note: r.warn || ''
    }))
  )
} else {
  console.log('\nNothing to fix in this database.\n')
}

const warn = utc.filter((r) => r.warn)
if (warn.length) {
  console.log(`\n${warn.length} row(s) still read out-before-in after the shift — the entry time on`)
  console.log('those was almost certainly edited by hand. Worth a look before or after.\n')
}
