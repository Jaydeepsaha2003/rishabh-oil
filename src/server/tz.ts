// The mill's clock, not the host's.
//
// Everything this server writes with a date on it — the time a tanker crossed
// the barrier, the default date on a voucher, "today" in a register — is meant
// to be Indian wall-clock, because that is the clock the person entering it is
// looking at.
//
// src/main is shared with the desktop app, where `new Date()` already IS
// Indian local time because the machine is in India. On Hostinger the process
// runs in UTC, so the very same code stamped gate entries five and a half
// hours behind: a tanker in at 09:53 was recorded as 04:23, and an entry made
// between midnight and 05:30 IST was dated to the day before — which is worse
// than a wrong time, because it lands the row in the previous day's register.
//
// Set once for the whole process rather than patched into each helper:
// seventeen files under src/main call todayISO() and a dozen more reach for
// `new Date()` directly, and fixing them one at a time would have missed one.
//
// Imported first by index.ts so it runs before anything else is required.
// Node applies a TZ change on assignment, and nothing under src/main evaluates
// a date at module scope, so there is no clock read before this line.
//
// APP_TZ is the escape hatch if the business ever runs somewhere else. It is
// deliberately NOT `process.env.TZ ||` — Hostinger sets TZ=UTC itself, and
// deferring to it is the whole bug.
process.env.TZ = process.env.APP_TZ || 'Asia/Kolkata'

export function serverClock(): string {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  return `${process.env.TZ} (UTC${sign}${hh}:${mm}) — ${d.toString().slice(16, 21)}`
}
