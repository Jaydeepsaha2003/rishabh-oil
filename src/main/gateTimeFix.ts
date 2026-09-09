import { getClient } from './db'

// Repairing the gate times the website wrote while the server ran in UTC.
//
// gate.ts stamps entry_time and out_time off the process clock. src/main is
// shared with the desktop app, where that clock is a machine in India; on
// Hostinger the process ran in UTC, so every time written through the website
// came out 5h30 behind — 09:53 IST stored as 04:23 — and an entry made between
// midnight and 05:30 IST was filed under the previous day. src/server/tz.ts
// stops it happening again. This puts right what was already written.
//
// WHICH ROWS. Not "everything since the site went live", which would also
// catch the rows typed on the desktop app in that period and push those five
// and a half hours into the future. created_at is the discriminator:
// SQLite's datetime('now') is UTC whatever the process timezone is, so it is
// the one clock in the table that was never wrong.
//
//   auto-stamped by a UTC process  ->  entry_time == created_at        (diff 0)
//   auto-stamped by an IST process ->  entry_time == created_at + 5:30 (diff 330)
//   typed, or corrected afterwards ->  anything else
//
// Only the first is touched. The other two are already right, and the third
// is somebody's deliberate correction, which must not be moved. The two
// populations sit 330 minutes apart, so a three-minute tolerance separates
// them with no room for argument.
//
// THE OUT TIME has no created_at of its own — it is stamped by a later UPDATE.
// It is shifted only on a row whose IN is a confirmed UTC stamp, i.e. a row
// this server created: no screen in the app can send an out time, so it is
// always the process clock, and the process that wrote the row is the process
// that closed it. A row whose IN does not qualify keeps its out time and is
// reported instead, because there is nothing here that could prove it wrong.
//
// Every change is written to gate_time_utc_fix_log before it is applied, so
// this is reversible from the database alone.

const SHIFT_MIN = 330 // IST is UTC+05:30
const TOL_MIN = 3

const pad = (v: number): string => String(v).padStart(2, '0')

// A 'YYYY-MM-DD HH:MM' pair read as an instant in UTC. The dates in this table
// are wall-clock strings with no zone, so this is a comparison frame, not a
// claim about what they mean.
function stampMs(date: unknown, time: unknown): number | null {
  const d = String(date || '').slice(0, 10)
  const t = String(time || '').slice(0, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return null
  const ms = Date.parse(`${d}T${t}:00Z`)
  return Number.isFinite(ms) ? ms : null
}

// created_at is written by SQLite as 'YYYY-MM-DD HH:MM:SS' in UTC; a row
// restored from elsewhere may carry the ISO form instead.
function createdMs(v: unknown): number | null {
  const raw = String(v || '').trim().replace(' ', 'T').replace(/Z$/, '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null
  const ms = Date.parse(`${raw.slice(0, 16)}:00Z`)
  return Number.isFinite(ms) ? ms : null
}

function split(ms: number): { date: string; time: string } {
  const d = new Date(ms)
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
}

export type GateTimeChange = {
  id: number
  gate_entry_no: string
  created_at: string
  old_entry: string
  new_entry: string
  old_out: string
  new_out: string
  /** Set when the corrected row still reads out-before-in — a hand-edited
   *  entry time on a row this server closed. Reported, never "fixed". */
  warn?: string
}

export type GateTimeReport = {
  scanned: number
  utcStamped: GateTimeChange[]
  /** Rows with an out time whose IN did not qualify, so the out was left
   *  alone. Listed so the decision is visible rather than silent. */
  outLeftAlone: { id: number; gate_entry_no: string; out: string; diffMin: number }[]
}

/** Read-only. Works out what would change and why. */
export async function planGateTimeFix(): Promise<GateTimeReport> {
  const res = await getClient().execute(
    `SELECT id, gate_entry_no, entry_date, entry_time, out_date, out_time, created_at
       FROM gate_entries
      WHERE entry_time IS NOT NULL AND TRIM(entry_time) <> ''
      ORDER BY id`
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = res.rows as unknown as Record<string, any>[]
  const out: GateTimeReport = { scanned: rows.length, utcStamped: [], outLeftAlone: [] }

  for (const r of rows) {
    const created = createdMs(r.created_at)
    const stamp = stampMs(r.entry_date, r.entry_time)
    if (created == null || stamp == null) continue
    const diff = Math.round((stamp - created) / 60000)
    const outMs = stampMs(r.out_date, r.out_time)

    if (Math.abs(diff) > TOL_MIN) {
      if (outMs != null) {
        out.outLeftAlone.push({
          id: Number(r.id),
          gate_entry_no: String(r.gate_entry_no || ''),
          out: `${r.out_date} ${String(r.out_time).slice(0, 5)}`,
          diffMin: diff
        })
      }
      continue
    }

    const ne = split(stamp + SHIFT_MIN * 60000)
    const no = outMs == null ? null : split(outMs + SHIFT_MIN * 60000)
    const change: GateTimeChange = {
      id: Number(r.id),
      gate_entry_no: String(r.gate_entry_no || ''),
      created_at: String(r.created_at || ''),
      old_entry: `${r.entry_date} ${String(r.entry_time).slice(0, 5)}`,
      new_entry: `${ne.date} ${ne.time}`,
      old_out: outMs == null ? '' : `${r.out_date} ${String(r.out_time).slice(0, 5)}`,
      new_out: no == null ? '' : `${no.date} ${no.time}`
    }
    // Both halves move by the same amount, so this can only fire where the
    // entry time was edited by hand after the fact. Worth saying out loud.
    if (no != null && `${no.date} ${no.time}` < `${ne.date} ${ne.time}`) {
      change.warn = 'out is before in even after the shift — entry time looks hand-edited'
    }
    out.utcStamped.push(change)
  }
  return out
}

/** Applies the plan, logging every original value first. */
export async function applyGateTimeFix(): Promise<GateTimeReport> {
  const c = getClient()
  const plan = await planGateTimeFix()
  if (!plan.utcStamped.length) return plan

  await c.execute(`CREATE TABLE IF NOT EXISTS gate_time_utc_fix_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gate_id INTEGER NOT NULL,
    gate_entry_no TEXT,
    created_at_utc TEXT,
    old_entry TEXT, new_entry TEXT,
    old_out TEXT, new_out TEXT,
    note TEXT,
    fixed_at TEXT DEFAULT (datetime('now'))
  )`)

  for (const ch of plan.utcStamped) {
    // The record of what it was goes in first. If the update below fails, the
    // log has a row the table does not match, which is noisy and recoverable;
    // the other order loses the original.
    await c.execute({
      sql: `INSERT INTO gate_time_utc_fix_log
              (gate_id, gate_entry_no, created_at_utc, old_entry, new_entry, old_out, new_out, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ch.id,
        ch.gate_entry_no,
        ch.created_at,
        ch.old_entry,
        ch.new_entry,
        ch.old_out || null,
        ch.new_out || null,
        ch.warn || null
      ]
    })
    const [nd, nt] = ch.new_entry.split(' ')
    if (ch.new_out) {
      const [od, ot] = ch.new_out.split(' ')
      await c.execute({
        sql: 'UPDATE gate_entries SET entry_date = ?, entry_time = ?, out_date = ?, out_time = ? WHERE id = ?',
        args: [nd, nt, od, ot, ch.id]
      })
    } else {
      await c.execute({
        sql: 'UPDATE gate_entries SET entry_date = ?, entry_time = ? WHERE id = ?',
        args: [nd, nt, ch.id]
      })
    }
  }
  return plan
}
