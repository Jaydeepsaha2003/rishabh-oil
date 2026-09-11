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
const dayOf = (date?: string): string => {
  const d = s(date).slice(0, 10)
  return DATE_RE.test(d) ? d : todayISO()
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

// The default cut-off. One time for the whole day: a per-person cut-off is a
// rota, and this is a checklist.
const CUTOFF_KEY = 'work.cutoff'
const CUTOFF_DEFAULT = '18:30'

export async function workCutoff(): Promise<string> {
  const r = await plain('SELECT value FROM app_settings WHERE key = ?', [CUTOFF_KEY])
  const v = s(r[0]?.value).trim()
  return /^\d{2}:\d{2}$/.test(v) ? v : CUTOFF_DEFAULT
}

export async function setWorkCutoff(hhmm: string, adminId?: number): Promise<{ cutoff: string }> {
  const a = await loadUser(n(adminId))
  if (s(a.role) !== 'admin') throw new Error('Only an admin can change the cut-off')
  const v = s(hhmm).trim()
  if (!/^\d{2}:\d{2}$/.test(v)) throw new Error('Give the cut-off as HH:MM')
  await getClient().execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [CUTOFF_KEY, v]
  })
  return { cutoff: v }
}

// ---------------------------------------------------------------- access ----
// The same three shapes `users.permissions` has been written in over the life
// of the app, read the way lib/userRights.ts reads them for the screen. A
// fourth reading of this would be a fourth chance to disagree with the sidebar
// about what somebody can reach, so the rules are stated once, here, for the
// server: an array of keys, a map of key -> 'read'|'write', or a map of
// key -> { view, create, edit, delete, scope }.
type Grant = { module: string; scope: string }

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
    return out
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
  return out
}

// ------------------------------------------------------------- catalogue ----
export async function listWorkProcesses(): Promise<Row[]> {
  return (
    await plain(
      `SELECT id, module, scope, title, detail, sort_order, active
         FROM work_processes ORDER BY module, sort_order, id`
    )
  ).map((r) => ({ ...r, id: n(r.id), active: n(r.active) === 1 }))
}

export async function saveWorkProcess(v: Row): Promise<{ id: number }> {
  const module = s(v.module).trim()
  const title = s(v.title).trim()
  if (!module) throw new Error('Which page is this process for?')
  if (!title) throw new Error('Name the process')
  const id = n(v.id)
  const args = [module, s(v.scope).trim(), title, s(v.detail).trim() || null, n(v.sort_order), v.active === false ? 0 : 1]
  if (id) {
    await getClient().execute({
      sql: `UPDATE work_processes SET module = ?, scope = ?, title = ?, detail = ?, sort_order = ?, active = ?
             WHERE id = ?`,
      args: [...args, id] as never[]
    })
    return { id }
  }
  const res = await getClient().execute({
    sql: `INSERT INTO work_processes (module, scope, title, detail, sort_order, active)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(module, scope, title) DO UPDATE SET
            detail = excluded.detail, sort_order = excluded.sort_order, active = excluded.active`,
    args: args as never[]
  })
  return { id: Number(res.lastInsertRowid) || 0 }
}

export async function removeWorkProcess(id: number): Promise<{ id: number; retired: boolean }> {
  const pid = n(id)
  if (!pid) throw new Error('Which process?')
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

// ------------------------------------------------------- the day's board ----
// Write the rows this day needs, if they are not there already.
//
// Insert-or-ignore against (work_date, user_id, process_id): opening the board
// twice does not double it, a task already ticked is never touched, and a
// process granted since this morning is added. Only TODAY is materialised, so
// opening a past day shows what that day actually held rather than what
// today's access would have asked of it.
async function ensureDay(date: string): Promise<void> {
  if (date !== todayISO()) return
  const c = getClient()
  const cid = getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const users = await plain(
    'SELECT id, username, full_name, role, permissions FROM users WHERE active = 1 ORDER BY id'
  )
  const procs = (await listWorkProcesses()).filter((p) => p.active)

  for (const u of users) {
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
        .catch(() => {
          // A day that cannot be materialised must still be readable — the
          // board falls back to whatever rows are already there.
        })
    }
  }
}

/** The whole board for one day: people, their tasks, and every note on them. */
export async function listWorkBoard(date?: string, viewerId?: number): Promise<Row> {
  const day = dayOf(date)
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

  const [users, tasks, notes, cutoff] = await Promise.all([
    // Fetched in full regardless of who is asking — needed to resolve names
    // on notes and tasks (an admin's send-back note on a non-admin's own task
    // still needs the admin's name), and trimmed to what is actually RETURNED
    // further down.
    plain('SELECT id, username, full_name, role, active, permissions FROM users ORDER BY id'),
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
    workCutoff()
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
    cutoff,
    now: clockOf(localStamp()),
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
      title: s(t.title),
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

/** The owner ticks a task: a claim that it is done, not that it is finished. */
export async function tickWorkTask(taskId: number, userId: number): Promise<{ id: number; state: string }> {
  const t = await loadTask(taskId)
  const u = await loadUser(userId)
  assertWorkAccess(u)
  if (n(t.user_id) !== n(u.id)) throw new Error('That task belongs to somebody else')
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
export async function assignWorkTask(v: Row, adminId: number): Promise<{ id: number }> {
  const a = await loadUser(adminId)
  if (s(a.role) !== 'admin') throw new Error('Only an admin can assign a task')
  const uid = n(v.user_id)
  if (!uid) throw new Error('Who is this for?')
  const title = s(v.title).trim()
  if (!title) throw new Error('Say what needs doing')
  const target = await loadUser(uid)
  const day = dayOf(s(v.work_date))
  const cid = getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const res = await getClient().execute({
    sql: `INSERT INTO work_tasks
            (factory_id, company_id, work_date, user_id, module, process_id, title, detail,
             kind, state, assigned_by, due_at, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'assigned', 'pending', ?, ?, ?)`,
    args: [
      fid || null,
      cid,
      day,
      uid,
      s(v.module).trim() || 'workAssignments',
      title.slice(0, 300),
      s(v.detail).trim().slice(0, 2000) || null,
      n(a.id),
      s(v.due_at).trim() || null,
      localStamp()
    ] as never[]
  })
  const id = Number(res.lastInsertRowid) || 0
  await tell(
    uid,
    'A task has been assigned to you',
    `${title}${s(v.detail).trim() ? ` — ${s(v.detail).trim()}` : ''}`,
    'normal',
    `assigned:${id}`
  )
  void target
  return { id }
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
