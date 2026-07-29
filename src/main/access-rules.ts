// The access decision, in one place, so the main process and the UI can never
// disagree about what a user is allowed to do.
//
// NOTE: nothing calls this yet. It is the decision logic only — wiring it into
// the IPC wrapper (and the Users page) is the next step. Kept separate so it can
// be tested on its own before any write path starts refusing anything.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type Action = 'view' | 'create' | 'edit' | 'delete'

// What a user may do in one module. `editDays` is the read-only window: an entry
// may be edited or deleted only while its OWN date (invoice date, bargain date,
// deposit date — not when it was keyed in) is within that many days of today.
// 0 = the entry's own day only. null/undefined = no time limit.
export interface ModulePerm {
  view?: boolean
  create?: boolean
  edit?: boolean
  delete?: boolean
  editDays?: number | null
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
    return perm.create ? OK : { allowed: false, reason: `You cannot add new entries in ${label}` }
  }
  if (!perm[action]) {
    return {
      allowed: false,
      reason: action === 'edit' ? `You cannot edit entries in ${label}` : `You cannot delete entries in ${label}`
    }
  }
  // The module is allowed; only the read-only window can still refuse.
  const limit = perm.editDays
  if (limit == null) return OK
  const days = ageInDays(opts.entryDate, opts.today)
  if (days <= limit) return OK
  const window = limit === 0 ? 'the same day it is dated' : `${limit} day${limit === 1 ? '' : 's'}`
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
