// Work assignments — the day's checklist, and what the admin makes of it.
// -----------------------------------------------------------------------------
// One board a day for the whole site. Every active login gets a list of the
// processes the pages THEY can reach are responsible for, ticks them off as the
// day goes, and the admin either approves each tick or sends it back with a
// note saying what needs fixing. The person who owns the task is told, answers
// on the task itself, and re-ticks. Nothing leaves the day until it is
// approved.
//
// THE LIST BUILDS ITSELF FROM ACCESS. A checklist maintained by hand drifts
// from what people actually do within a month — somebody moves desk, their
// pages change, and the list still asks them for a stock count they can no
// longer reach. So the processes hang off MODULE keys, and who gets which is
// read from the same `users.permissions` the sidebar is built from. A scoped
// grant (orders limited to `readings`) sees only that scope's processes, which
// is what stops the lab being asked to confirm rates.
//
// MATERIALISED, NEVER DERIVED LIVE. The rows for a day are written into
// work_tasks, not computed on read, because a list computed from today's
// access would silently rewrite what last Tuesday asked for — and a task
// somebody was sent back on would vanish from the day it was raised the moment
// their pages changed.
//
// TODAY grows; the past does not move. Give somebody a new page at eleven and
// its processes join their list this afternoon, which is what you want — the
// responsibility is theirs from the moment it is granted. Take a page away and
// what was already asked of them stays: it may already be ticked, it may be
// mid-review, and a checklist that deletes its own history is one nobody can
// be held to. Past days are never touched at all.
//
// BY SITE, NOT BY COMPANY. One factory, one team, one board — a weighbridge
// operator does not have a different day depending on which company's books
// happen to be selected.
import { getClient, todayISO } from './db'
import { companiesOfFactory, factoryOfCompanies, getActiveCompanyId } from './company'
import { hasWorkAccess, parsePerms } from '../renderer/src/lib/userRights'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

async function plain(sql: string, args: unknown[] = []): Promise<Row[]> {
  const res = await getClient().execute({ sql, args: args as never[] })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// Local wall-clock, never datetime('now').
//
// SQLite's now is UTC, and IST is UTC+5:30 — so a task ticked at 02:00 local
// stamps 20:30 the previous day, which reads on the board as work done before
// the day began and lands on the wrong side of the cut-off. The stamp is made
// here, in the timezone the mill is standing in.
export function localStamp(): string {
  const d = new Date()
  const p = (x: number): string => String(x).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

// 'HH:MM' off a stored stamp, for the board.
export const clockOf = (stamp: unknown): string => {
  const t = s(stamp).slice(11, 16)
  return /^\d{2}:\d{2}$/.test(t) ? t : ''
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// A day named explicitly, or none. The fallback is no longer simply "today" —
// see workingDayISO — so the two callers resolve it themselves.
const namedDay = (date?: string): string => {
  const d = s(date).slice(0, 10)
  return DATE_RE.test(d) ? d : ''
}

// The states, and the only moves allowed between them.
//
//   pending ──tick──▶ done ──approve──▶ approved
//                      │
//                      └──send back──▶ fixes ──re-tick──▶ redone ──approve──▶ approved
//
// Approved is the only state that counts as finished. A task ticked Done is
// still outstanding until it clears review, which is the whole point: the tick
// is a claim, not a completion.
export const WORK_STATES = ['pending', 'done', 'fixes', 'redone', 'approved'] as const
const REVIEWABLE = new Set(['done', 'redone'])

// THE SITE'S CUT-OFF, AND THE ONES THAT DIFFER FROM IT.
//
// One time for the whole day is the default and still the common case — but a
// weighbridge that closes at six and a billing desk that closes at nine are
// not the same day, and holding them to one deadline makes the board lie about
// one of them. So this is the fallback, and a login may carry its own
// (users.work_cutoff / users.work_cutoff_day), set by an admin.
//
// Which DAY'S board is open stays site-wide: the team works one day at a time
// and materialising a different date per person would give two people on the
// same shift different boards. A person's own cut-off decides only whether
// THEY are late.
const CUTOFF_KEY = 'work.cutoff'
const CUTOFF_DAY_KEY = 'work.cutoff_day'
const CUTOFF_DEFAULT = '18:30'

// WHICH DAY THE CLOCK BELONGS TO.
//
// A mill does not stop at midnight. Where the day's work is closed off at
// 01:00 or 02:00, that hour belongs to the day BEFORE it — the shift that
// started yesterday morning. Held as a time alone, 02:00 read as two in the
// morning of the day the work was raised, so a board finished at 23:50 was
// marked late and everything after midnight was judged against a deadline
// that had passed twenty-two hours earlier.
//
// So the cut-off carries the day it falls on: 'same' for a deadline inside
// the working day, 'next' for one in the small hours after it.
export type CutoffDay = 'same' | 'next'

export async function workCutoff(): Promise<string> {
  const r = await plain('SELECT value FROM app_settings WHERE key = ?', [CUTOFF_KEY])
  const v = s(r[0]?.value).trim()
  return /^\d{2}:\d{2}$/.test(v) ? v : CUTOFF_DEFAULT
}

export async function workCutoffDay(): Promise<CutoffDay> {
  const r = await plain('SELECT value FROM app_settings WHERE key = ?', [CUTOFF_DAY_KEY])
  return s(r[0]?.value).trim() === 'next' ? 'next' : 'same'
}

/** One login's effective cut-off: their own if they carry one, else the site's. */
export function resolveCutoff(
  u: Row,
  siteCutoff: string,
  siteDay: CutoffDay
): { cutoff: string; day: CutoffDay; own: boolean } {
  const own = s(u?.work_cutoff).trim()
  if (!/^\d{2}:\d{2}$/.test(own)) return { cutoff: siteCutoff, day: siteDay, own: false }
  return { cutoff: own, day: s(u?.work_cutoff_day) === 'next' ? 'next' : 'same', own: true }
}

/**
 * Give one login a cut-off of its own, or hand it back to the site's.
 *
 * An empty time clears the override — which is not the same as setting it to
 * whatever the site says today, because the site's may change tomorrow and a
 * login on the default is meant to follow it.
 */
export async function setUserWorkCutoff(
  targetId: number,
  hhmm: string,
  day: string | undefined,
  adminId?: number
): Promise<{ id: number; cutoff: string; cutoff_day: CutoffDay; own: boolean }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change a cut-off')
  const uid = n(targetId)
  if (!uid) throw new Error('Whose cut-off?')
  // Exists and is loadable, or the override would hang off nothing.
  await loadUser(uid)
  const v = s(hhmm).trim()
  if (v && !/^\d{2}:\d{2}$/.test(v)) throw new Error('Give the cut-off as HH:MM')
  const d: CutoffDay = s(day) === 'next' ? 'next' : 'same'
  await getClient().execute({
    sql: 'UPDATE users SET work_cutoff = ?, work_cutoff_day = ? WHERE id = ?',
    args: [v || null, v ? d : null, uid] as never[]
  })
  const site = await workCutoff()
  const siteDay = await workCutoffDay()
  const r = resolveCutoff({ work_cutoff: v, work_cutoff_day: v ? d : null }, site, siteDay)
  return { id: uid, cutoff: r.cutoff, cutoff_day: r.day, own: r.own }
}

/**
 * WHICH DAY'S BOARD IS THE OPEN ONE.
 *
 * With a same-day cut-off this is simply today, and nothing below applies.
 *
 * With a next-day cut-off the working day outlives the calendar day: set to
 * 02:00 next day, the day raised on Monday morning stays open until two on
 * Tuesday morning. Without this the board would roll over at midnight and the
 * night shift would arrive to a fresh, empty list with their real deadline
 * still two hours away — and the work they were in the middle of would be
 * filed under a day they had to go looking for.
 *
 * So before the cut-off the open board is still YESTERDAY's; after it, today's.
 * Tasks for the new day are materialised the first time the board is opened
 * past the cut-off, which is exactly when that day's work begins.
 */
export async function workingDayISO(): Promise<string> {
  if ((await workCutoffDay()) !== 'next') return todayISO()
  const cut = await workCutoff()
  const clock = localStamp().slice(11, 16)
  if (clock >= cut) return todayISO()
  const d = new Date(`${todayISO()}T00:00:00`)
  d.setDate(d.getDate() - 1)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function setWorkCutoff(
  hhmm: string,
  adminId?: number,
  day?: string
): Promise<{ cutoff: string; cutoff_day: CutoffDay }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change the cut-off')
  const v = s(hhmm).trim()
  if (!/^\d{2}:\d{2}$/.test(v)) throw new Error('Give the cut-off as HH:MM')
  const c = getClient()
  await c.execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [CUTOFF_KEY, v]
  })
  // Left out of the call, the day it already had stands — an older client
  // saving only a time must not silently move the deadline back a day.
  const d: CutoffDay = day === undefined ? await workCutoffDay() : s(day) === 'next' ? 'next' : 'same'
  await c.execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [CUTOFF_DAY_KEY, d]
  })
  return { cutoff: v, cutoff_day: d }
}

// ---------------------------------------------------------------- access ----
// The same three shapes `users.permissions` has been written in over the life
// of the app, read the way lib/userRights.ts reads them for the screen. A
// fourth reading of this would be a fourth chance to disagree with the sidebar
// about what somebody can reach, so the rules are stated once, here, for the
// server: an array of keys, a map of key -> 'read'|'write', or a map of
// key -> { view, create, edit, delete, scope }.
type Grant = { module: string; scope: string }

// A PAGE SPLIT INTO SECTIONS IS STILL ONE PAGE OF ACCESS.
//
// Treasury is three jobs — the LC desk, the discounting decision, collections
// — granted separately, and the checklist has to be able to ask them
// separately too. But the two grants are not independent, and the rest of the
// app already knows it (access-rules.ts modulePerm, modules.ts permLevel):
//
//   · a login holding the PAGE and no section reaches every section, which is
//     how everybody saved before the split kept working — so it is asked every
//     section's lines;
//   · a login holding ANY section reaches the page, which is what makes
//     Treasury appear in their sidebar at all — so it is asked the page's own
//     lines too.
//
// Without this the split would silently take work off a board: a login with
// the old Treasury grant would be asked nothing once its line moved to the LC
// section, and would never know.
const SECTION_PARENT: Record<string, string> = {
  treasuryLc: 'treasury',
  treasuryBd: 'treasury',
  treasuryTracker: 'treasury'
}

function grantsOf(user: Row): Grant[] | 'ALL' {
  if (s(user.role) === 'admin') return 'ALL'
  let perms: unknown = {}
  try {
    perms = typeof user.permissions === 'string' ? JSON.parse(s(user.permissions) || '{}') : user.permissions || {}
  } catch {
    return []
  }
  const out: Grant[] = []
  if (Array.isArray(perms)) {
    for (const k of perms as unknown[]) {
      const [mod, scope] = s(k).split(':')
      if (mod) out.push({ module: mod, scope: s(scope) })
    }
    return withSections(out)
  }
  if (!perms || typeof perms !== 'object') return []
  for (const [key, v] of Object.entries(perms as Record<string, unknown>)) {
    if (v === 'write' || v === 'read') {
      out.push({ module: key, scope: '' })
      continue
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      // A grant with nothing ticked is not a grant. This is what keeps a login
      // that was given a page and then had every right removed off the board
      // rather than on it with a list it cannot act on.
      if (!(o.view || o.create || o.edit || o.delete)) continue
      out.push({ module: key, scope: s(o.scope) })
    }
  }
  return withSections(out)
}

/** Fill in the page↔section grants the rest of the app already infers. */
function withSections(list: Grant[]): Grant[] {
  const held = new Set(list.map((g) => g.module))
  const out = [...list]
  for (const [section, parent] of Object.entries(SECTION_PARENT)) {
    // The page implies each of its sections…
    if (held.has(parent) && !held.has(section)) out.push({ module: section, scope: '' })
    // …and any section implies the page.
    if (held.has(section) && !held.has(parent)) out.push({ module: parent, scope: '' })
  }
  return out
}

// ONE VOICE FOR THE WHOLE CHECKLIST.
//
// Lines are typed by whoever is at the keyboard, and they arrive in whatever
// case that keyboard was in: "CHECK THE TOTAL STOCK SECTION" on the same board
// as "View the receiving stocks" reads as two lists written by two people
// rather than one day's work.
//
// So every line is read out in capitals. It is the plainest rule there is —
// no acronym list to keep, no proper noun to guess at, nothing that can be
// mangled — and a checklist is a set of instructions, which is one of the few
// places capitals genuinely help: each line is scanned, not read.
//
// It applies to the LINE, not to its note. A title is a handful of words; a
// note is a sentence explaining how to do the thing, and a paragraph in
// capitals is markedly harder to read than one that is not.
export function lineCase(text: string): string {
  return s(text).toUpperCase()
}

// ------------------------------------------------------------- catalogue ----
export async function listWorkProcesses(): Promise<Row[]> {
  return (
    await plain(
      `SELECT id, module, scope, title, detail, sort_order, active, user_id
         FROM work_processes ORDER BY module, sort_order, id`
    )
  ).map((r) => ({
    ...r,
    id: n(r.id),
    // Read out in the case the board reads in. The row itself is left as it
    // was typed — this is how it is shown, not a rewrite of what was said.
    title: lineCase(s(r.title)),
    // The note is left exactly as it was written — see lineCase.
    detail: s(r.detail),
    // 0 means everyone who can open the page, which is nearly every line.
    user_id: n(r.user_id) || 0,
    active: n(r.active) === 1
  }))
}

// EDITING THE CATALOGUE IS EDITING TOMORROW, AND AS MUCH OF TODAY AS IS STILL
// UNTOUCHED.
//
// A task row carries its own title and detail, copied when the day was
// materialised, so a line reworded in March still reads on the January board
// as what was actually asked. That is right for history and wrong for the hour
// after an admin fixes a typo — so a change is carried forward onto the rows
// it can still honestly claim to describe: today onwards, never ticked, and
// still coming from this process.
async function carryToOpenTasks(processId: number, title: string, detail: string | null): Promise<void> {
  await getClient().execute({
    sql: `UPDATE work_tasks SET title = ?, detail = ?, updated_at = ?
           WHERE process_id = ? AND kind = 'auto' AND state = 'pending' AND work_date >= ?`,
    // Not today: the earliest day anybody could still have open — see
    // openFloorISO. A next-day cut-off is still working yesterday.
    args: [title, detail, localStamp(), n(processId), await openFloorISO()] as never[]
  })
}

/** Take a line off the boards that are still only WAITING on it. */
async function withdrawUntouched(processId: number): Promise<void> {
  await getClient().execute({
    sql: `DELETE FROM work_tasks
           WHERE process_id = ? AND kind = 'auto' AND state = 'pending' AND work_date >= ?
             AND id NOT IN (SELECT task_id FROM work_notes)`,
    args: [n(processId), await openFloorISO()] as never[]
  })
}

/**
 * Add a line to a page's checklist, or change one already on it.
 *
 * Admin only, asserted here and not merely on the screen: the whole team's day
 * is built from this table.
 */
export async function saveWorkProcess(v: Row, adminId?: number): Promise<{ id: number }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change the task list')
  const module = s(v.module).trim()
  const title = lineCase(s(v.title).trim()).slice(0, 300)
  if (!module) throw new Error('Which page is this line for?')
  if (!title) throw new Error('Say what needs doing')
  const scope = s(v.scope).trim()
  const detail = s(v.detail).trim().slice(0, 2000) || null
  // Left out means ON — a line is being written to be asked, and a caller that
  // simply did not mention it must not end up with one nobody ever sees.
  const active = v.active == null ? 1 : v.active === false || n(v.active) === 0 ? 0 : 1
  // Whose line it is, or nobody's — which means everybody's. A login that
  // cannot open the page is refused here rather than accepted into a line that
  // would then reach no one at all.
  const owner = n(v.user_id) || 0
  if (owner) {
    const u = await loadUser(owner)
    const held = grantsOf(u)
    const ok =
      held === 'ALL' ||
      (held as Grant[]).some((g) => g.module === module && (scope ? g.scope === scope : g.scope === ''))
    if (!ok) {
      throw new Error(
        `${s(u.full_name) || s(u.username)} cannot open that page, so this line would reach nobody`
      )
    }
  }
  const id = n(v.id)

  // Same page, same desk, same words is the same line — said plainly here
  // rather than left to a UNIQUE violation nobody can read.
  // Compared without regard to case, because case is no longer what the
  // reader sees: a line stored in capitals from before and the same line typed
  // again in sentence case are the same line, and letting both stand would put
  // the identical job on the board twice.
  const clash = await plain(
    'SELECT id FROM work_processes WHERE module = ? AND scope = ? AND UPPER(title) = UPPER(?) AND id <> ?',
    [module, scope, title, id]
  )
  if (clash.length) throw new Error('That line is already on this page')

  if (id) {
    // Where it sits in the list is not sent by the editor — the arrows own
    // that, and a rename must not quietly restack the page.
    const cur = (await plain('SELECT sort_order, module, scope, user_id FROM work_processes WHERE id = ?', [id]))[0]
    if (!cur) throw new Error('That line is no longer on the list')
    const order = v.sort_order == null ? n(cur.sort_order) : n(v.sort_order)
    // Narrowed to a desk, or moved to another page, it is now asked of
    // different people — and today's rows were already written for the old
    // ones. Wording follows a row; WHOSE row it is cannot, so the untouched
    // ones are withdrawn and the next board read writes them for whoever the
    // line reaches now.
    // Handed to a different person — or handed to one at all, or handed back
    // to the page — is the same kind of change as moving it to another page:
    // today's untouched rows were written for whoever it used to reach.
    const moved =
      s(cur.module) !== module || s(cur.scope) !== scope || n(cur.user_id) !== owner
    await getClient().execute({
      sql: `UPDATE work_processes SET module = ?, scope = ?, title = ?, detail = ?, sort_order = ?, active = ?, user_id = ?
             WHERE id = ?`,
      args: [module, scope, title, detail, order, active, owner || null, id] as never[]
    })
    await carryToOpenTasks(id, title, detail)
    // Switched off it stops being asked; moved, it is asked of somebody else.
    // Either way today's untouched rows go and the next board read writes
    // whatever the line now calls for. A tick, a note or a review is
    // somebody's work and stays exactly where it is.
    if (moved || !active) await withdrawUntouched(id)
    return { id }
  }

  // A new line lands at the end of its page.
  const last = await plain('SELECT MAX(sort_order) AS m FROM work_processes WHERE module = ?', [module])
  const order = v.sort_order == null ? n(last[0]?.m) + 10 : n(v.sort_order)
  const res = await getClient().execute({
    sql: `INSERT INTO work_processes (module, scope, title, detail, sort_order, active, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(module, scope, title) DO UPDATE SET
            detail = excluded.detail, sort_order = excluded.sort_order, active = excluded.active,
            user_id = excluded.user_id`,
    args: [module, scope, title, detail, order, active, owner || null] as never[]
  })
  return { id: Number(res.lastInsertRowid) || 0 }
}

export async function removeWorkProcess(id: number, adminId?: number): Promise<{ id: number; retired: boolean }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change the task list')
  const pid = n(id)
  if (!pid) throw new Error('Which line?')
  // Today's untouched rows go either way: the line is not being asked for any
  // more, and a checklist that keeps asking after it was deleted is worse than
  // one that forgets.
  await withdrawUntouched(pid)
  // Retired rather than deleted wherever a day already asked for it — deleting
  // would take the task, its notes and the fact it was ever approved with it.
  const used = await plain('SELECT COUNT(*) AS k FROM work_tasks WHERE process_id = ?', [pid])
  if (n(used[0]?.k) > 0) {
    await getClient().execute({ sql: 'UPDATE work_processes SET active = 0 WHERE id = ?', args: [pid] })
    return { id: pid, retired: true }
  }
  await getClient().execute({ sql: 'DELETE FROM work_processes WHERE id = ?', args: [pid] })
  return { id: pid, retired: false }
}

/**
 * The order one page asks its lines in.
 *
 * Written as a fresh run of 10s rather than by swapping two numbers, so a list
 * edited for years cannot end up with ties that leave the order to be decided
 * by insertion id.
 */
export async function reorderWorkProcesses(ids: number[], adminId?: number): Promise<{ ok: true }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change the task list')
  const list = (Array.isArray(ids) ? ids : []).map(n).filter(Boolean)
  let order = 0
  for (const id of list) {
    order += 10
    await getClient().execute({
      sql: 'UPDATE work_processes SET sort_order = ? WHERE id = ?',
      args: [order, id] as never[]
    })
  }
  return { ok: true }
}

/**
 * IS THIS DAY STILL OPEN TO THIS LOGIN?
 *
 * The calendar says a day ended at midnight. The cut-off says otherwise, and
 * the cut-off is the one the work is measured against: a login that closes at
 * 13:00 THE NEXT DAY is still working Monday at eleven on Tuesday morning, and
 * a line written for them at eleven belongs on the Monday board they are
 * actually filling in.
 *
 * So a past day is not automatically finished. It is finished when the deadline
 * for it has passed, and that deadline is per login, because the cut-off is.
 */
function dayStillOpenFor(u: Row, date: string, siteCutoff: string, siteDay: CutoffDay): boolean {
  const day = s(date).slice(0, 10)
  const today = todayISO()
  if (!day || day > today) return false
  if (day === today) return true
  const r = resolveCutoff(u, siteCutoff, siteDay)
  // Where the deadline actually falls: the same evening, or the next day.
  const dueDate = r.day === 'next' ? dayPlusISO(day, 1) : day
  const now = localStamp().slice(0, 16).replace('T', ' ')
  return `${dueDate} ${r.cutoff}` >= now
}

// Days forward from a YYYY-MM-DD, month ends and leap years included. The
// LOCAL day, like everything else here — see todayISO.
function dayPlusISO(date: string, k: number): string {
  const d = new Date(`${s(date)}T00:00:00`)
  d.setDate(d.getDate() + k)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// The earliest day any login could still have open. Every place that writes
// onto "the open boards" uses this as its floor rather than today, or a
// next-day cut-off would be told its own board no longer counts.
async function openFloorISO(): Promise<string> {
  const anyNext = await plain(
    "SELECT 1 AS k FROM users WHERE active = 1 AND work_cutoff_day = 'next' LIMIT 1"
  )
  const siteNext = (await workCutoffDay()) === 'next'
  return anyNext.length || siteNext ? dayPlusISO(todayISO(), -1) : todayISO()
}

// ------------------------------------------------------- the day's board ----
// Write the rows this day needs, if they are not there already.
//
// Insert-or-ignore against (work_date, user_id, process_id): opening the board
// twice does not double it, a task already ticked is never touched, and a
// process granted since this morning is added. Only TODAY is materialised, so
// opening a past day shows what that day actually held rather than what
// today's access would have asked of it.
async function ensureDay(date: string): Promise<void> {
  // The future is never written: a board for a day that has not happened would
  // be a checklist nobody could have done anything about.
  if (!date || date > todayISO()) return
  const c = getClient()
  const cid = getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const users = await plain(
    'SELECT id, username, full_name, role, permissions, work_cutoff, work_cutoff_day FROM users WHERE active = 1 ORDER BY id'
  )
  const procs = (await listWorkProcesses()).filter((p) => p.active)
  const siteCutoff = await workCutoff()
  const siteDay = await workCutoffDay()

  for (const u of users) {
    // A DAY IS FINISHED WHEN ITS CUT-OFF HAS PASSED, NOT AT MIDNIGHT.
    //
    // This used to return at the top unless the date was today, so a line
    // written this morning never reached the board somebody was still filling
    // in under a next-day cut-off — it showed in the catalogue, it reached
    // nobody, and nothing on the screen said why. Now the question is asked
    // per login, which is the only way to ask it: the cut-off is theirs.
    if (!dayStillOpenFor(u, date, siteCutoff, siteDay)) continue
    const grants = grantsOf(u)
    // An admin holds every page and is the one doing the reviewing — a
    // checklist of the whole app against their own name is not a day's work,
    // it is the app's table of contents.
    if (grants === 'ALL') continue
    const byModule = new Map<string, Set<string>>()
    for (const g of grants) {
      if (!byModule.has(g.module)) byModule.set(g.module, new Set())
      byModule.get(g.module)!.add(g.scope)
    }
    for (const p of procs) {
      // A line handed to one person is asked of that person only. The grant
      // check below still runs, so naming somebody narrows the reach and can
      // never widen it past what their access allows.
      const only = n(p.user_id)
      if (only && only !== n(u.id)) continue
      const scopes = byModule.get(s(p.module))
      if (!scopes) continue
      const want = s(p.scope)
      // An unscoped process belongs to an unscoped grant; a scoped one belongs
      // only to the grant that carries its scope.
      const matched = want ? scopes.has(want) : scopes.has('')
      if (!matched) continue
      await c
        .execute({
          sql: `INSERT INTO work_tasks
                  (factory_id, company_id, work_date, user_id, module, process_id, title, detail, kind, state, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'pending', ?)
                ON CONFLICT(work_date, user_id, process_id) DO NOTHING`,
          args: [
            fid || null,
            cid,
            date,
            n(u.id),
            s(p.module),
            n(p.id),
            s(p.title),
            s(p.detail) || null,
            localStamp()
          ] as never[]
        })
        .catch((e) => {
          // A day that cannot be materialised must still be readable — the
          // board falls back to whatever rows are already there.
          //
          // But it is SAID now. Swallowed in silence, a line that never
          // reached somebody's board looked exactly like a line that was
          // never written: the screen showed it in the catalogue, the person
          // never saw it, and there was nothing anywhere to explain the gap.
          console.error(
            `[work] could not put line ${n(p.id)} "${s(p.title)}" on ${date} for user ${n(u.id)}:`,
            (e as Error)?.message || e
          )
        })
    }
  }
}

/** The whole board for one day: people, their tasks, and every note on them. */
export async function listWorkBoard(date?: string, viewerId?: number): Promise<Row> {
  const day = namedDay(date) || (await workingDayISO())
  await ensureDay(day)
  const cid = getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const scope = fid ? await companiesOfFactory(fid) : [cid]
  const ph = scope.map(() => '?').join(', ')

  // Who is asking, and whether they see the whole site's board or only their
  // own row. The client already hides Review board and Team progress from
  // anyone but an admin — this is what keeps another desk's outstanding work
  // out of the PAYLOAD as well, not merely off the screen. No viewerId at all
  // (an internal caller) reads as admin: generous rather than silently empty,
  // which would be the worse failure to ship unnoticed.
  const vid = n(viewerId)
  const viewerRow = vid ? (await plain('SELECT role FROM users WHERE id = ?', [vid]))[0] : null
  const viewerIsAdmin = !vid || !viewerRow || s(viewerRow.role) === 'admin'

  const [users, tasks, notes, cutoff, cutoffDay] = await Promise.all([
    // Fetched in full regardless of who is asking — needed to resolve names
    // on notes and tasks (an admin's send-back note on a non-admin's own task
    // still needs the admin's name), and trimmed to what is actually RETURNED
    // further down.
    plain(
      `SELECT id, username, full_name, role, active, permissions, work_cutoff, work_cutoff_day
         FROM users ORDER BY id`
    ),
    plain(
      `SELECT * FROM work_tasks
        WHERE work_date = ? AND (${fid ? 'factory_id = ?' : `company_id IN (${ph})`})${
          viewerIsAdmin ? '' : ' AND user_id = ?'
        }
        ORDER BY user_id, module, id`,
      viewerIsAdmin ? (fid ? [day, fid] : [day, ...scope]) : (fid ? [day, fid, vid] : [day, ...scope, vid])
    ),
    plain(
      `SELECT wn.*, u.full_name, u.username
         FROM work_notes wn
         JOIN work_tasks wt ON wt.id = wn.task_id
         LEFT JOIN users u ON u.id = wn.user_id
        WHERE wt.work_date = ?${viewerIsAdmin ? '' : ' AND wt.user_id = ?'}
        ORDER BY wn.id`,
      viewerIsAdmin ? [day] : [day, vid]
    ),
    workCutoff(),
    workCutoffDay()
  ])
  // Which closed days this viewer may work on, and what is waiting on an
  // admin. Both sides of the same question, so the board can offer the ask and
  // the answer in one place.
  const [dayRequests, myOpenDays, openDay] = await Promise.all([
    dayRequestsFor(viewerIsAdmin, vid),
    vid ? openDays(vid) : Promise.resolve([] as string[]),
    workingDayISO()
  ])

  const nameOf = new Map(users.map((u) => [n(u.id), s(u.full_name) || s(u.username)]))
  const byTask = new Map<number, Row[]>()
  for (const m of notes) {
    const k = n(m.task_id)
    if (!byTask.has(k)) byTask.set(k, [])
    byTask.get(k)!.push({
      id: n(m.id),
      user_id: n(m.user_id),
      who: s(m.full_name) || s(m.username) || `#${n(m.user_id)}`,
      role: s(m.role),
      kind: s(m.kind),
      text: s(m.text),
      at: clockOf(m.created_at),
      created_at: s(m.created_at)
    })
  }

  return {
    date: day,
    // The day the board is CURRENTLY on, which after a next-day cut-off is not
    // always today — everything that asks "is this day still open" compares
    // against this rather than against the calendar.
    open_day: openDay,
    // Closed days this login has been let back into, and every request the
    // viewer is entitled to see.
    open_days: myOpenDays,
    day_requests: dayRequests,
    cutoff,
    // Which day the cut-off falls on, so the screen can judge a tick against
    // the right deadline rather than against a bare clock reading.
    cutoff_day: cutoffDay,
    // The whole stamp, not just the clock: with a next-day cut-off, "is it
    // past the deadline yet" cannot be answered by a time alone.
    now: clockOf(localStamp()),
    now_stamp: localStamp(),
    // Roster exposed to the client: the whole active login list for an admin
    // (Team progress and the Assign dialog both need it), just the asking
    // login's own row otherwise — enough for My work, and nothing about
    // anybody else's grants.
    users: (viewerIsAdmin ? users : users.filter((u) => n(u.id) === vid)).map((u) => ({
      id: n(u.id),
      name: s(u.full_name) || s(u.username),
      username: s(u.username),
      role: s(u.role),
      active: n(u.active) === 1,
      // The deadline THIS login is judged against, already resolved — the
      // screen should never have to know which of the two it came from to
      // print it, only to say whose it is.
      cutoff: resolveCutoff(u, cutoff, cutoffDay).cutoff,
      cutoff_day: resolveCutoff(u, cutoff, cutoffDay).day,
      cutoff_own: resolveCutoff(u, cutoff, cutoffDay).own,
      // What the checklist was built from, so the screen can say why somebody
      // has no tasks rather than showing an empty list with no explanation.
      grants: grantsOf(u) === 'ALL' ? 'ALL' : (grantsOf(u) as Grant[]).map((g) => (g.scope ? `${g.module}:${g.scope}` : g.module))
    })),
    tasks: tasks.map((t) => ({
      id: n(t.id),
      user_id: n(t.user_id),
      user_name: nameOf.get(n(t.user_id)) || `#${n(t.user_id)}`,
      module: s(t.module),
      process_id: n(t.process_id) || null,
      title: lineCase(s(t.title)),
      detail: s(t.detail),
      kind: s(t.kind) || 'auto',
      state: s(t.state) || 'pending',
      marked_at: clockOf(t.marked_at),
      marked_stamp: s(t.marked_at),
      reviewed_at: clockOf(t.reviewed_at),
      reviewed_by: n(t.reviewed_by) || null,
      assigned_by: n(t.assigned_by) || null,
      assigned_by_name: n(t.assigned_by) ? nameOf.get(n(t.assigned_by)) || '' : '',
      due_at: s(t.due_at),
      thread: byTask.get(n(t.id)) || []
    }))
  }
}

// ------------------------------------------------------------ the moves ----
async function loadTask(taskId: number): Promise<Row> {
  const r = await plain('SELECT * FROM work_tasks WHERE id = ?', [n(taskId)])
  if (!r[0]) throw new Error('That task is not on the board any more')
  return r[0]
}

async function loadUser(userId: number): Promise<Row> {
  const r = await plain('SELECT id, username, full_name, role, permissions FROM users WHERE id = ?', [n(userId)])
  if (!r[0]) throw new Error('Who is making this change?')
  return r[0]
}

// Defence in depth for the one default-ALLOW permission in the app: the
// client already hides the page and the sidebar entry once an admin flips
// this off (see modules.ts), so a normal user never reaches these calls with
// it set — this exists for whatever reaches the channel directly. Admin is
// never blockable, same as everywhere else this flag is read.
function assertWorkAccess(u: Row): void {
  if (s(u.role) === 'admin') return
  if (!hasWorkAccess(parsePerms(u.permissions))) {
    throw new Error('Work Assignments access has been switched off for this login — ask an admin to turn it back on.')
  }
}

async function say(taskId: number, user: Row, text: string, kind: string): Promise<void> {
  const t = s(text).trim()
  if (!t) return
  await getClient().execute({
    sql: `INSERT INTO work_notes (task_id, user_id, role, text, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [n(taskId), n(user.id), s(user.role), t.slice(0, 2000), kind, localStamp()] as never[]
  })
}

// Tell the person whose task it is, on the same bell as everything else.
//
// Raised straight into `notifications` with them named in `recipients`: the
// feed reads the named list first, so this reaches exactly one person without
// needing a rule of its own. The dedupe key carries the note's id, so a second
// message on the same task is a second notification rather than one that
// silently collapses into the first.
async function tell(
  toUserId: number,
  title: string,
  body: string,
  severity: 'normal' | 'high',
  tag: string
): Promise<void> {
  const cid = getActiveCompanyId()
  await getClient()
    .execute({
      sql: `INSERT INTO notifications
              (company_id, rule_key, severity, audience, recipients, title, body, page, dedupe_key, created_at)
            VALUES (?, 'work:assignment', ?, 'named', ?, ?, ?, 'workAssignments', ?, datetime('now'))
            ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO NOTHING`,
      args: [cid, severity, JSON.stringify([n(toUserId)]), title, body, `${cid}:work:${tag}`] as never[]
    })
    .catch((e) => {
      // The work board is the record; the bell is a courtesy. A notification
      // that cannot be raised must not roll back a send-back that has already
      // been decided.
      console.error('[work] notification failed:', (e as Error).message)
    })
}

// ------------------------------------------------------ a day reopened ----
// FILLING IN A DAY THAT HAS ALREADY CLOSED.
//
// The board is today's. A shift that ran late, a tanker weighed at midnight, a
// day somebody was off — the work still happened and the record should say so,
// but a checklist anyone can back-fill at will records nothing worth having.
//
// So the day stays shut and the person ASKS. An admin opens it for that one
// login and that one date; the tick that follows carries its own stamp, so a
// day filled in on Thursday still shows Thursday as the moment it was said.
// Nothing here backdates anything: it only reopens the door.
async function openDays(userId: number): Promise<string[]> {
  const rows = await plain(
    "SELECT work_date FROM work_day_requests WHERE user_id = ? AND state = 'approved' ORDER BY work_date DESC",
    [n(userId)]
  )
  return rows.map((r) => s(r.work_date))
}

/** May this login act on this day at all? */
async function assertDayOpen(user: Row, workDate: string): Promise<void> {
  if (s(user.role) === 'admin') return
  const day = s(workDate).slice(0, 10)
  if (!day || day === (await workingDayISO())) return
  const ok = await plain(
    "SELECT id FROM work_day_requests WHERE user_id = ? AND work_date = ? AND state = 'approved'",
    [n(user.id), day]
  )
  if (!ok.length) {
    throw new Error(
      "That day is closed. Ask an admin to open it — the button is on the board, beside the date."
    )
  }
}

/** Somebody asks for a closed day back. */
export async function requestWorkDay(
  workDate: string,
  userId: number,
  reason?: string
): Promise<{ id: number; work_date: string; state: string }> {
  const u = await loadUser(n(userId))
  assertWorkAccess(u)
  const day = namedDay(s(workDate))
  if (!day) throw new Error('Which day?')
  const open = await workingDayISO()
  if (day === open) throw new Error('That day is already open — it is the board in front of you')
  if (day > open) throw new Error('That day has not happened yet')
  const why = s(reason).trim().slice(0, 500) || null
  await getClient().execute({
    sql: `INSERT INTO work_day_requests (user_id, work_date, reason, state, created_at)
          VALUES (?, ?, ?, 'pending', ?)
          ON CONFLICT(user_id, work_date) DO UPDATE SET
            reason = excluded.reason,
            -- Asking again after a refusal is a fresh ask, not a second row.
            -- A day already open is left alone: re-asking must not shut it.
            state = CASE WHEN work_day_requests.state = 'approved' THEN 'approved' ELSE 'pending' END,
            created_at = excluded.created_at,
            decided_by = NULL, decided_at = NULL, decided_note = NULL`,
    args: [n(u.id), day, why, localStamp()] as never[]
  })
  const row = (await plain('SELECT id, state FROM work_day_requests WHERE user_id = ? AND work_date = ?', [
    n(u.id),
    day
  ]))[0]
  const admins = await plain("SELECT id FROM users WHERE role = 'admin' AND active = 1")
  for (const a of admins) {
    await tell(
      n(a.id),
      `${s(u.full_name) || s(u.username)} is asking to fill in a closed day`,
      `${day}${why ? ` — ${why}` : ''}`,
      'normal',
      `dayreq:${n(row?.id)}:${Date.now()}`
    )
  }
  return { id: n(row?.id), work_date: day, state: s(row?.state) || 'pending' }
}

/** The admin opens it, or says no. */
export async function decideWorkDay(
  requestId: number,
  approve: boolean,
  adminId: number,
  note?: string
): Promise<{ id: number; state: string }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can open a closed day')
  const req = (await plain('SELECT * FROM work_day_requests WHERE id = ?', [n(requestId)]))[0]
  if (!req) throw new Error('That request is no longer there')
  const state = approve ? 'approved' : 'refused'
  await getClient().execute({
    sql: `UPDATE work_day_requests SET state = ?, decided_by = ?, decided_at = ?, decided_note = ? WHERE id = ?`,
    args: [state, n(a.id), localStamp(), s(note).trim().slice(0, 500) || null, n(requestId)] as never[]
  })
  await tell(
    n(req.user_id),
    approve ? `${s(req.work_date)} is open for you` : `${s(req.work_date)} was not opened`,
    approve
      ? 'Pick the date on your board and tick off what you finished that day.'
      : `${s(a.full_name) || s(a.username)} did not open it${s(note).trim() ? ` — ${s(note).trim()}` : ''}.`,
    'normal',
    `dayreq:${n(requestId)}:${state}:${Date.now()}`
  )
  return { id: n(requestId), state }
}

/**
 * AN ADMIN OPENS A DAY NOBODY ASKED FOR.
 *
 * The asking route exists because a checklist anyone can back-fill records
 * nothing. That reason holds for the person doing the work; it does not hold
 * for the admin, who is the one the asking is addressed to. Someone off sick,
 * a laptop that would not start, a day the site itself lost — making that
 * person file a request first, so it can be approved by the same hand that
 * already decided, is a form to fill in and nothing more.
 *
 * So the same door, opened from the other side. It writes the SAME row the
 * asking route writes, already approved, which is why nothing downstream
 * needs to know the difference: `assertDayOpen` keeps reading one table, and
 * a day opened here is a day opened there.
 *
 * `opened_by_admin` is kept only so shutting it again can tell the two apart
 * — a day nobody asked for is simply withdrawn, while a day that WAS asked
 * for is refused, because an ask is owed an answer.
 */
export async function setWorkDayOpen(
  userIds: number[],
  workDate: string,
  open: boolean,
  adminId: number,
  note?: string
): Promise<{ opened: number; closed: number; work_date: string }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can open a closed day')
  const day = namedDay(s(workDate))
  if (!day) throw new Error('Which day?')
  const today = await workingDayISO()
  if (day === today) throw new Error('That day is already open — it is the board in front of you')
  if (day > today) throw new Error('That day has not happened yet')

  const ids = Array.from(new Set((userIds || []).map((x) => n(x)).filter((x) => x > 0)))
  if (!ids.length) throw new Error('Whose day?')
  const why = s(note).trim().slice(0, 500) || null
  const stamp = localStamp()
  let opened = 0
  let closed = 0

  for (const id of ids) {
    const u = await loadUser(id)
    // An admin's own board is never shut, so opening one is a no-op that would
    // only leave a confusing row behind.
    if (s(u.role) === 'admin') continue
    if (open) {
      await getClient().execute({
        sql: `INSERT INTO work_day_requests (user_id, work_date, reason, state, decided_by, decided_at, decided_note, created_at, opened_by_admin)
              VALUES (?, ?, NULL, 'approved', ?, ?, ?, ?, 1)
              ON CONFLICT(user_id, work_date) DO UPDATE SET
                state = 'approved',
                decided_by = excluded.decided_by,
                decided_at = excluded.decided_at,
                decided_note = excluded.decided_note`,
        args: [id, day, n(a.id), stamp, why, stamp] as never[]
      })
      opened += 1
      await tell(
        id,
        `${day} is open for you`,
        `${s(a.full_name) || s(a.username)} opened it without being asked${why ? ` — ${why}` : ''}. Pick the date on your board and tick off what you finished that day.`,
        'normal',
        `dayopen:${id}:${day}:${Date.now()}`
      )
    } else {
      const cur = (await plain(
        'SELECT id, opened_by_admin FROM work_day_requests WHERE user_id = ? AND work_date = ?',
        [id, day]
      ))[0]
      if (!cur) continue
      if (n(cur.opened_by_admin) === 1) {
        // Nobody asked for it, so there is nothing to answer: take the row away
        // and the day is closed again, exactly as it was.
        await getClient().execute({
          sql: 'DELETE FROM work_day_requests WHERE id = ?',
          args: [n(cur.id)] as never[]
        })
      } else {
        await getClient().execute({
          sql: `UPDATE work_day_requests SET state = 'refused', decided_by = ?, decided_at = ?, decided_note = ? WHERE id = ?`,
          args: [n(a.id), stamp, why, n(cur.id)] as never[]
        })
      }
      closed += 1
      await tell(
        id,
        `${day} is closed again`,
        `${s(a.full_name) || s(a.username)} shut it${why ? ` — ${why}` : ''}. Anything already ticked stays ticked.`,
        'normal',
        `dayshut:${id}:${day}:${Date.now()}`
      )
    }
  }
  return { opened, closed, work_date: day }
}

/** Every request an admin has to look at, or one login's own. */
async function dayRequestsFor(viewerIsAdmin: boolean, viewerId: number): Promise<Row[]> {
  const rows = await plain(
    `SELECT r.*, u.full_name, u.username
       FROM work_day_requests r
       LEFT JOIN users u ON u.id = r.user_id
      ${viewerIsAdmin ? '' : 'WHERE r.user_id = ?'}
      ORDER BY r.state = 'pending' DESC, r.work_date DESC, r.id DESC
      LIMIT 60`,
    viewerIsAdmin ? [] : [n(viewerId)]
  )
  return rows.map((r) => ({
    id: n(r.id),
    user_id: n(r.user_id),
    user_name: s(r.full_name) || s(r.username) || `#${n(r.user_id)}`,
    work_date: s(r.work_date),
    reason: s(r.reason),
    state: s(r.state) || 'pending',
    decided_at: s(r.decided_at),
    decided_note: s(r.decided_note),
    opened_by_admin: n(r.opened_by_admin) === 1 ? 1 : 0
  }))
}

/** The owner ticks a task: a claim that it is done, not that it is finished. */
export async function tickWorkTask(taskId: number, userId: number): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const u = await loadUser(userId)
  assertWorkAccess(u)
  if (n(t.user_id) !== n(u.id)) throw new Error('That task belongs to somebody else')
  await assertDayOpen(u, s(t.work_date))
  if (s(t.state) !== 'pending') throw new Error(`This task is already ${s(t.state)}`)
  await getClient().execute({
    sql: "UPDATE work_tasks SET state = 'done', marked_at = ?, updated_at = ? WHERE id = ?",
    args: [localStamp(), localStamp(), n(taskId)] as never[]
  })
  return { id: n(taskId), state: 'done' }
}

/**
 * The owner takes their own tick back — the same button that ticked it.
 *
 * Only ever UNDOES the owner's own claim, and only while nobody has acted on
 * it: `done` returns to `pending`, and `redone` returns to `fixes` (the state
 * the admin put it in), so a send-back is never erased by the person it was
 * sent to. Once a reviewer has approved or sent the task back, their decision
 * stands and this refuses — a tick is the owner's to take back, a review is
 * not.
 *
 * marked_at is cleared with it. Leaving the old stamp would show a task that
 * is not ticked as having been ticked at a time, and the board reads that
 * stamp to decide whether the work landed after cut-off.
 */
export async function untickWorkTask(taskId: number, userId: number): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const u = await loadUser(userId)
  assertWorkAccess(u)
  if (n(t.user_id) !== n(u.id)) throw new Error('That task belongs to somebody else')
  await assertDayOpen(u, s(t.work_date))
  const back: Record<string, string> = { done: 'pending', redone: 'fixes' }
  const to = back[s(t.state)]
  if (!to) {
    throw new Error(
      s(t.state) === 'pending'
        ? 'That task is not ticked'
        : s(t.state) === 'approved'
          ? 'That task has been approved — ask an admin to reopen it'
          : 'That task has been sent back for fixes — it is not ticked'
    )
  }
  await getClient().execute({
    sql: 'UPDATE work_tasks SET state = ?, marked_at = NULL, updated_at = ? WHERE id = ?',
    args: [to, localStamp(), n(taskId)] as never[]
  })
  return { id: n(taskId), state: to }
}

/** Sent back, fixed, ticked again. */
export async function redoWorkTask(taskId: number, userId: number): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const u = await loadUser(userId)
  assertWorkAccess(u)
  if (n(t.user_id) !== n(u.id)) throw new Error('That task belongs to somebody else')
  await assertDayOpen(u, s(t.work_date))
  if (s(t.state) !== 'fixes') throw new Error('Only a task sent back for fixes can be marked redone')
  await getClient().execute({
    sql: "UPDATE work_tasks SET state = 'redone', marked_at = ?, updated_at = ? WHERE id = ?",
    args: [localStamp(), localStamp(), n(taskId)] as never[]
  })
  const admins = await plain("SELECT id FROM users WHERE role = 'admin' AND active = 1")
  for (const a of admins) {
    await tell(
      n(a.id),
      `${s(u.full_name) || s(u.username)} has re-done a task`,
      `${s(t.title)} — ready to look at again.`,
      'normal',
      `redone:${n(taskId)}:${Date.now()}`
    )
  }
  return { id: n(taskId), state: 'redone' }
}

/** The admin clears a tick. Approved is the only state that finishes a task. */
export async function approveWorkTask(
  taskId: number,
  adminId: number,
  note?: string
): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const a = await loadUser(adminId)
  if (s(a.role) !== 'admin') throw new Error('Only an admin can approve work')
  if (!REVIEWABLE.has(s(t.state))) {
    throw new Error(
      s(t.state) === 'approved' ? 'That task is already approved' : 'Nothing to approve — it has not been ticked yet'
    )
  }
  await getClient().execute({
    sql: "UPDATE work_tasks SET state = 'approved', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?",
    args: [localStamp(), n(a.id), localStamp(), n(taskId)] as never[]
  })
  await say(n(taskId), a, s(note).trim() || 'Approved.', 'approve')
  await tell(
    n(t.user_id),
    'Work approved',
    `${s(t.title)} — approved${s(note).trim() ? `: ${s(note).trim()}` : '.'}`,
    'normal',
    `approved:${n(taskId)}:${Date.now()}`
  )
  return { id: n(taskId), state: 'approved' }
}

/**
 * The admin sends a tick back. The note is REQUIRED — "needs fixes" with no
 * reason is a task nobody can act on, and the person is being told to do the
 * work twice.
 */
export async function sendBackWorkTask(
  taskId: number,
  adminId: number,
  note: string
): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const a = await loadUser(adminId)
  if (s(a.role) !== 'admin') throw new Error('Only an admin can send work back')
  if (!REVIEWABLE.has(s(t.state))) {
    throw new Error('Only a task that has been ticked can be sent back')
  }
  const text = s(note).trim()
  if (!text) throw new Error('Say what needs fixing before sending it back')
  await getClient().execute({
    sql: "UPDATE work_tasks SET state = 'fixes', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?",
    args: [localStamp(), n(a.id), localStamp(), n(taskId)] as never[]
  })
  await say(n(taskId), a, text, 'sendback')
  await tell(
    n(t.user_id),
    'Work sent back for fixes',
    `${s(t.title)} — ${text}`,
    'high',
    `sentback:${n(taskId)}:${Date.now()}`
  )
  return { id: n(taskId), state: 'fixes' }
}

/**
 * A note on a task, from either side. The other side hears about it — that is
 * the whole point of the thread; a reply nobody is told about is a reply
 * nobody reads.
 */
export async function addWorkNote(taskId: number, userId: number, text: string): Promise<{ id: number }> {
  const t = await loadTask(taskId)
  const u = await loadUser(userId)
  const body = s(text).trim()
  if (!body) throw new Error('Nothing to say')
  const owner = n(t.user_id) === n(u.id)
  if (!owner && s(u.role) !== 'admin') throw new Error('That task belongs to somebody else')
  // Only the owner's own side of the check applies here — an admin replying
  // on somebody else's task is never blocked by that other person's flag.
  if (owner) assertWorkAccess(u)
  await say(n(taskId), u, body, 'note')
  const who = s(u.full_name) || s(u.username)
  if (owner) {
    const admins = await plain("SELECT id FROM users WHERE role = 'admin' AND active = 1")
    for (const a of admins) {
      await tell(n(a.id), `${who} added a note`, `${s(t.title)} — ${body}`, 'normal', `note:${n(taskId)}:${Date.now()}:${n(a.id)}`)
    }
  } else {
    await tell(n(t.user_id), `${who} added a note`, `${s(t.title)} — ${body}`, 'normal', `note:${n(taskId)}:${Date.now()}`)
  }
  return { id: n(taskId) }
}

/**
 * A one-off the access-derived list cannot know about — a stock recount, a
 * supplier follow-up. Lands on the person's board for the day like any other
 * task and goes through the same review.
 */
/**
 * ONE-OFFS, HANDED OUT.
 *
 * Several at a time, because that is how they are thought of: a person is
 * caught in the corridor and given three things, not one thing three times.
 * `lines` carries them; a single `title` is still accepted, so an older client
 * (and the phone) keeps working unchanged.
 *
 * The bell rings ONCE however many lines there are. Three separate
 * notifications for three tasks handed over in one breath is noise, and noise
 * is how a bell stops being read.
 */
export async function assignWorkTask(v: Row, adminId: number): Promise<{ id: number; ids: number[] }> {
  const a = await loadUser(adminId)
  if (s(a.role) !== 'admin') throw new Error('Only an admin can assign a task')
  const uid = n(v.user_id)
  if (!uid) throw new Error('Who is this for?')

  // Whatever shape it arrived in, reduced to a list. Blank lines are dropped
  // rather than refused: a half-typed row left behind in the form is not a
  // reason to lose the three that were finished.
  const raw: Row[] = Array.isArray(v.lines) && v.lines.length ? (v.lines as Row[]) : [{ title: v.title, detail: v.detail }]
  const lines = raw
    .map((l) => ({
      title: lineCase(s(l?.title).trim()).slice(0, 300),
      detail: s(l?.detail).trim().slice(0, 2000) || null
    }))
    .filter((l) => !!l.title)
  if (!lines.length) throw new Error('Say what needs doing')

  const target = await loadUser(uid)
  // A task assigned with no date lands on the day whose board is open, which
  // after midnight on a next-day cut-off is still yesterday's.
  const day = namedDay(s(v.work_date)) || (await workingDayISO())
  const cid = getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const mod = s(v.module).trim() || 'workAssignments'
  const due = s(v.due_at).trim() || null
  const stamp = localStamp()

  const ids: number[] = []
  for (const l of lines) {
    const res = await getClient().execute({
      sql: `INSERT INTO work_tasks
              (factory_id, company_id, work_date, user_id, module, process_id, title, detail,
               kind, state, assigned_by, due_at, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'assigned', 'pending', ?, ?, ?)`,
      args: [fid || null, cid, day, uid, mod, l.title, l.detail, n(a.id), due, stamp] as never[]
    })
    const id = Number(res.lastInsertRowid) || 0
    if (id) ids.push(id)
  }
  if (!ids.length) throw new Error('Nothing could be assigned')

  // One bell, naming who gave it and what it is. With several lines it names
  // them all, so the notification is the whole message and not a prompt to go
  // and look.
  const from = s(a.full_name) || s(a.username)
  const one = lines.length === 1
  await tell(
    uid,
    one ? 'A task has been assigned to you' : `${lines.length} tasks have been assigned to you`,
    one
      ? `${from}: ${lines[0].title}${lines[0].detail ? ` — ${lines[0].detail}` : ''}`
      : `${from}: ${lines.map((l) => l.title).join(' · ')}`,
    'normal',
    `assigned:${ids.join('-')}`
  )
  void target
  return { id: ids[0], ids }
}

/** An assigned one-off, withdrawn. Only ever the one that was assigned. */
export async function removeWorkTask(taskId: number, adminId: number): Promise<{ id: number }> {
  const t = await loadTask(taskId)
  const a = await loadUser(adminId)
  if (s(a.role) !== 'admin') throw new Error('Only an admin can withdraw a task')
  if (s(t.kind) !== 'assigned') {
    throw new Error('This task comes from the page access, not from an assignment — it cannot be withdrawn')
  }
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM work_notes WHERE task_id = ?', args: [n(taskId)] })
  await c.execute({ sql: 'DELETE FROM work_tasks WHERE id = ?', args: [n(taskId)] })
  return { id: n(taskId) }
}
