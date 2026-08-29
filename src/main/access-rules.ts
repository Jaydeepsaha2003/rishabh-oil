// The access decision, in one place, so the main process and the UI can never
// disagree about what a user is allowed to do.
//
// NOTE: nothing calls this yet. It is the decision logic only — wiring it into
// the IPC wrapper (and the Users page) is the next step. Kept separate so it can
// be tested on its own before any write path starts refusing anything.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type Action = 'view' | 'create' | 'edit' | 'delete'

// What a user may do in one module, and for how long.
//
// Two windows, both counted from the entry's OWN date (invoice date, bargain
// date, deposit date — never when it was keyed in), and both counted
// inclusively, so 2 on the 29th means the 28th and the 29th:
//
//   editDays — the ENTRY window. How far back a new entry may be dated, and
//              how far back an existing one may be edited or deleted. Tight,
//              because it is a duty control: an operator who cannot reach
//              last Friday has to key Friday's work on Friday.
//   viewDays — the VISIBLE window. How far back rows are listed at all. Wider,
//              because seeing the week's register is context, not licence.
//
// null/undefined on either = no limit. Where both are set the entry window is
// clamped to the visible one, since editing a row you cannot see is nonsense.
export interface ModulePerm {
  view?: boolean
  create?: boolean
  edit?: boolean
  delete?: boolean
  editDays?: number | null
  // How many days back this user may SEE, counted the same inclusive way.
  // Separate from editDays on purpose: reading a week of history is context,
  // and keying a week late is a habit. The client wants to grant the first
  // without granting the second — see viewDays vs editDays below.
  // null/undefined = no limit on reading.
  viewDays?: number | null
  // A narrowed job inside the module, for a user who needs one task and must
  // not see the rest of the page. Currently only 'unload' on the sales module:
  // the unloading desk, which sees FOR invoices still out for delivery and may
  // record nothing but the received quantity. Absent = the whole module.
  scope?: string | null
}

export interface AccessUser {
  role?: string | null
  // Either the new per-module object, or one of the two legacy shapes:
  // a string[] of module keys, or Record<key, 'read' | 'write'>.
  permissions?: unknown
}

export interface Verdict {
  allowed: boolean
  // Why not — shown to the user verbatim, so it has to read like a sentence.
  reason?: string
  // True when the module itself is permitted and only the time window blocked
  // it. The UI uses this to show a row as locked rather than forbidden.
  lockedByAge?: boolean
}

const OK: Verdict = { allowed: true }

// Everyone can reach Approvals: admins act on the queue, everyone else tracks
// their own submissions and sees why something was rejected.
const ALWAYS_OPEN = new Set(['approvals'])

// Read whichever permission shape this user was saved with.
export function modulePerm(user: AccessUser | null | undefined, moduleKey: string): ModulePerm {
  if (!user) return {}
  if (user.role === 'admin') {
    return { view: true, create: true, edit: true, delete: true, editDays: null }
  }
  if (ALWAYS_OPEN.has(moduleKey)) {
    return { view: true, create: true, edit: true, delete: true, editDays: null }
  }
  const p = user.permissions
  // Legacy: a flat list of module keys meant full access to each.
  if (Array.isArray(p)) {
    return p.includes(moduleKey)
      ? { view: true, create: true, edit: true, delete: true, editDays: null }
      : {}
  }
  if (p && typeof p === 'object') {
    const entry = (p as Record<string, unknown>)[moduleKey]
    // Legacy: 'write' | 'read' per module.
    if (entry === 'write') return { view: true, create: true, edit: true, delete: true, editDays: null }
    if (entry === 'read') return { view: true }
    if (entry && typeof entry === 'object') {
      const e = entry as ModulePerm
      // view is implied by any other right — you cannot edit what you cannot see.
      const view = e.view ?? !!(e.create || e.edit || e.delete)
      return { ...e, view }
    }
  }
  return {}
}

// The narrowed job this user holds in a module, if any. Admins never have one.
export function moduleScope(user: AccessUser | null | undefined, moduleKey: string): string | null {
  if (!user || user.role === 'admin') return null
  const scope = modulePerm(user, moduleKey).scope
  return scope ? String(scope) : null
}

// The oldest date a window of N days reaches back to, counted INCLUSIVELY: N
// days means N days on the calendar with today among them, so on 29-08 a 2-day
// window is the 28th and the 29th. That is how the mill says it and how anyone
// reading "2 days" on the settings page expects it to behave.
//
// 0 and 1 both mean today alone; a window of no days at all would leave a user
// unable to key in anything, which is a permission to withhold, not a window.
export function windowStart(days: number, today: string): string {
  const t = String(today).slice(0, 10)
  const d = new Date(`${t}T00:00:00`)
  d.setDate(d.getDate() - Math.max(0, (Number(days) || 0) - 1))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Whether a date falls inside that window. Anything today or later is in: a
// window limits how far BACK a user may reach, never how far forward.
export function withinWindow(date: unknown, days: number, today: string): boolean {
  const d = String(date ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true // no usable date -> nothing to judge
  return d >= windowStart(days, today)
}

// Whole days between an entry's own date and today. Negative for a future date,
// which is treated as 0 so a post-dated entry is never born locked.
export function ageInDays(entryDate: unknown, today: string): number {
  const d = String(entryDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0 // no usable date → never age-locked
  const a = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
  const t = String(today).slice(0, 10)
  const b = Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)))
  return Math.max(0, Math.round((b - a) / 86400000))
}

// How far back this user may SEE in a module. null = no limit.
export function viewDays(user: AccessUser | null | undefined, moduleKey: string): number | null {
  if (!user || String(user.role || '').toLowerCase() === 'admin') return null
  const v = modulePerm(user, moduleKey).viewDays
  return v == null ? null : Math.max(0, Number(v) || 0)
}

// How far back this user may WRITE in a module — date a new entry, or edit or
// delete an old one. null = no limit.
//
// Clamped to the visible window: a narrower view than entry window would let
// someone rewrite a row the list never showed them, which is worse than either
// restriction on its own.
export function entryDays(user: AccessUser | null | undefined, moduleKey: string): number | null {
  if (!user || String(user.role || '').toLowerCase() === 'admin') return null
  const e = modulePerm(user, moduleKey).editDays
  const v = viewDays(user, moduleKey)
  if (e == null) return v
  const days = Math.max(0, Number(e) || 0)
  return v == null ? days : Math.min(days, v)
}

// The one question every write path should ask. `entryDate` is only needed for
// edit and delete; pass the row's own business date.
export function can(
  user: AccessUser | null | undefined,
  moduleKey: string,
  action: Action,
  opts: { entryDate?: unknown; today: string; moduleLabel?: string } = { today: '' }
): Verdict {
  const label = opts.moduleLabel || moduleKey
  const perm = modulePerm(user, moduleKey)
  if (!perm.view && !perm.create && !perm.edit && !perm.delete) {
    return { allowed: false, reason: `You do not have access to ${label}` }
  }
  if (action === 'view') {
    return perm.view ? OK : { allowed: false, reason: `You cannot view ${label}` }
  }
  if (action === 'create') {
    if (!perm.create) return { allowed: false, reason: `You cannot add new entries in ${label}` }
    // How far BACK a new entry may be dated. Without this the window would
    // govern what a user may change after the fact and nothing about what they
    // may write in the first place — someone held to two days could still book
    // last month simply by typing the date.
    const limit = entryDays(user, moduleKey)
    if (limit == null || opts.entryDate == null) return OK
    if (withinWindow(opts.entryDate, limit, opts.today)) return OK
    return {
      allowed: false,
      lockedByAge: true,
      reason: `You can only date a new ${label} entry ${
        limit <= 1 ? 'today' : `from ${windowStart(limit, opts.today)} onwards`
      }`
    }
  }
  if (!perm[action]) {
    return {
      allowed: false,
      reason: action === 'edit' ? `You cannot edit entries in ${label}` : `You cannot delete entries in ${label}`
    }
  }
  // The module is allowed; only the working window can still refuse. Same
  // arithmetic as the create rule above, so what a user may key in and what
  // they may go back and fix are one window and not two.
  const limit = entryDays(user, moduleKey)
  if (limit == null) return OK
  if (withinWindow(opts.entryDate, limit, opts.today)) return OK
  const days = ageInDays(opts.entryDate, opts.today)
  const window = limit <= 1 ? 'the day it is dated' : `a ${limit}-day window (from ${windowStart(limit, opts.today)})`
  return {
    allowed: false,
    lockedByAge: true,
    reason: `This entry is dated ${days} days ago and can only be ${
      action === 'edit' ? 'edited' : 'deleted'
    } within ${window}`
  }
}

// Convenience for lists and exports: a row stays visible (the client chose
// read-only over hiding, so totals still reconcile) but is marked locked.
export function lockRow(
  user: AccessUser | null | undefined,
  moduleKey: string,
  row: Row,
  dateField: string,
  today: string
): { canEdit: boolean; canDelete: boolean; lockedReason?: string } {
  const e = can(user, moduleKey, 'edit', { entryDate: row?.[dateField], today })
  const d = can(user, moduleKey, 'delete', { entryDate: row?.[dateField], today })
  return {
    canEdit: e.allowed,
    canDelete: d.allowed,
    lockedReason: e.allowed ? undefined : e.reason
  }
}
