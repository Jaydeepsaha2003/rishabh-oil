// One user's grant, and the arithmetic on it.
// -----------------------------------------------------------------------------
// Lifted out of the Users panel so the new User access page and the old
// Settings tab cannot drift apart on the one thing they must agree about: how
// a stored permission is READ. The shape has changed three times and all three
// are still on the books —
//
//   1. a flat array of module keys        ["orders","sales"]        = full
//   2. { [key]: 'read' | 'write' }
//   3. { [key]: { view, create, edit, delete, viewDays, editDays, scope } }
//
// — so a second copy of the parser is a second chance to forget one of them
// and silently reset somebody's access on the next save.
//
// Every function here is PURE: it takes the permissions object and hands back a
// new one. No component state, nothing to mock, and the rules can be checked on
// their own.

import { SECTION_PARENT } from './accessSections'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>

export type Perms = Record<string, unknown>
export type Flag = 'view' | 'create' | 'edit' | 'delete'
export const FLAGS: Flag[] = ['view', 'create', 'edit', 'delete']

// editDays = the ENTRY window: how far back they may date, edit or delete.
// viewDays = the VISIBLE window: how far back rows are listed at all.
// Two numbers because reading a week of history is context and keying a week
// late is a habit — the mill wants to grant the first without the second.
export type Rights = {
  view: boolean
  create: boolean
  edit: boolean
  delete: boolean
  editDays: string
  viewDays: string
  scope: string
}

const NONE: Rights = { view: false, create: false, edit: false, delete: false, editDays: '', viewDays: '', scope: '' }
const num = (v: unknown): string => (v == null || v === '' ? '' : String(v))

export function parsePerms(value: unknown): Perms {
  if (!value) return {}
  if (Array.isArray(value)) {
    const out: Perms = {}
    for (const k of value) out[String(k)] = 'write'
    return out
  }
  if (typeof value === 'object') return { ...(value as Perms) }
  try {
    const p = JSON.parse(String(value))
    if (Array.isArray(p)) {
      const out: Perms = {}
      for (const k of p) out[String(k)] = 'write'
      return out
    }
    return p && typeof p === 'object' ? (p as Perms) : {}
  } catch {
    return {}
  }
}

// Where a row's rights come from. A SECTION (Accounting · Day Book, Treasury ·
// LC…) with no setting of its own FOLLOWS its page; 'off' is a section switched
// off on its own row while the page is granted.
export type RightsSource = 'own' | 'follows' | 'off' | 'none'
export function rightsSource(perms: Perms, key: string): RightsSource {
  const raw = (perms || {})[key]
  if (raw === false) return 'off'
  if (raw !== undefined) return 'own'
  const parent = SECTION_PARENT[key]
  if (parent && rightsOf(perms, parent).view) return 'follows'
  return 'none'
}

export function rightsOf(perms: Perms, key: string): Rights {
  const raw = (perms || {})[key]
  // A section switched off on its own row.
  if (raw === false) return { ...NONE }
  // No setting of its own: a section reads as its page does (the server's
  // write gate applies the same rule).
  if (raw === undefined && SECTION_PARENT[key]) return rightsOf(perms, SECTION_PARENT[key])
  if (raw === 'write') return { ...NONE, view: true, create: true, edit: true, delete: true }
  if (raw === 'read') return { ...NONE, view: true }
  if (raw && typeof raw === 'object') {
    const o = raw as Any
    return {
      // A row with a write tick but no view tick is not a real state — it
      // could only have come from an older save — so view is inferred rather
      // than trusted.
      view: !!o.view || !!o.create || !!o.edit || !!o.delete,
      create: !!o.create,
      edit: !!o.edit,
      delete: !!o.delete,
      editDays: num(o.editDays),
      viewDays: num(o.viewDays),
      scope: o.scope ? String(o.scope) : ''
    }
  }
  return { ...NONE }
}

// A module with nothing ticked is DELETED rather than stored as a row of
// falses: "no grant" and "a grant of nothing" would read the same to a human
// and differently to permLevel.
export function writeRights(perms: Perms, key: string, next: Rights): Perms {
  const out = { ...(perms || {}) }
  const any = next.view || next.create || next.edit || next.delete
  const parent = SECTION_PARENT[key]
  if (parent) {
    // A SECTION: set back to exactly what its page grants, it goes back to
    // following the page, so a later change to the page reaches it too…
    const up = rightsOf(out, parent)
    const same =
      up.view === next.view && up.create === next.create && up.edit === next.edit && up.delete === next.delete &&
      up.editDays === next.editDays && up.viewDays === next.viewDays && up.scope === next.scope
    if (same) {
      delete out[key]
      return out
    }
    // …and switched off while the page is on, it is stored as OFF — deleting
    // it would quietly hand the page's access straight back.
    if (!any) {
      if (up.view) out[key] = false
      else delete out[key]
      return out
    }
  }
  if (!any) {
    delete out[key]
    return out
  }
  const entry: Any = { view: true, create: next.create, edit: next.edit, delete: next.delete }
  if (next.editDays !== '' && Number.isFinite(Number(next.editDays))) {
    entry.editDays = Math.max(0, Number(next.editDays))
  }
  if (next.viewDays !== '' && Number.isFinite(Number(next.viewDays))) {
    entry.viewDays = Math.max(0, Number(next.viewDays))
  }
  // Carried, not rebuilt — ticking any box on a scoped module would otherwise
  // silently drop the restriction it was granted under.
  if (next.scope) entry.scope = next.scope
  out[key] = entry
  return out
}

// The two rules that make the row coherent, in one place:
//   nothing can be done to a page you cannot see, so clearing View clears the
//   rest of the row; and ticking any of the other three turns View on.
function applyFlag(cur: Rights, flag: Flag, on: boolean): Rights {
  const next: Rights = { ...cur, [flag]: on }
  if (flag === 'view' && !on) {
    next.create = false
    next.edit = false
    next.delete = false
  }
  if (on && flag !== 'view') next.view = true
  return next
}

export function toggleFlag(perms: Perms, key: string, flag: Flag): Perms {
  const cur = rightsOf(perms, key)
  return writeRights(perms, key, applyFlag(cur, flag, !cur[flag]))
}

export function setColumn(perms: Perms, keys: string[], flag: Flag, on: boolean): Perms {
  let out = { ...(perms || {}) }
  for (const key of keys) out = writeRights(out, key, applyFlag(rightsOf(out, key), flag, on))
  return out
}

export function setAllPerms(keys: string[], level: 'none' | 'read' | 'write'): Perms {
  if (level === 'none') return {}
  const out: Perms = {}
  for (const key of keys) {
    // A section whose page is being set in the same breath simply follows it.
    const parent = SECTION_PARENT[key]
    if (parent && keys.includes(parent)) continue
    out[key] =
      level === 'read'
        ? { view: true, create: false, edit: false, delete: false }
        : { view: true, create: true, edit: true, delete: true }
  }
  return out
}

// Fill one window down the whole grid. Typing 7 into Visible and 2 into Entry
// is the common setup — a week of history to read, two days to key — and doing
// it a row at a time across two dozen modules invites a missed box.
//
// The two fields have different reach on purpose: a visible window restricts
// READING, so it applies to any module the user can open; an entry window
// restricts WRITING, so it would mean nothing on a view-only module.
export function setAllDays(perms: Perms, keys: string[], field: 'editDays' | 'viewDays', days: string): Perms {
  let out = { ...(perms || {}) }
  for (const key of keys) {
    const cur = rightsOf(out, key)
    const writes = cur.create || cur.edit || cur.delete
    if (field === 'editDays' ? !writes : !cur.view) continue
    // The OTHER window is carried through untouched — filling one column must
    // not wipe the column beside it.
    out = writeRights(out, key, { ...cur, [field]: days })
  }
  return out
}

// Special access: a grant of its own rather than a combination of tick boxes,
// because what it restricts is not an ACTION but which rows and columns exist.
// The rights are fixed — there is exactly one thing to record — so the toggle
// writes them rather than offering them.
export function setDesk(
  perms: Perms,
  moduleKey: string,
  scope: string,
  on: boolean,
  // A desk that covers two pages does not always give the same on each: the
  // inter-company desk BILLS on Sales and only READS on Purchases, because a
  // transfer purchase is written by its sale. Omitted, every page gets what
  // every desk got before this existed.
  grant?: { view?: boolean; create?: boolean; edit?: boolean; delete?: boolean }
): Perms {
  const out = { ...(perms || {}) }
  if (!on) {
    const cur = out[moduleKey]
    if (cur && typeof cur === 'object') {
      const o = { ...(cur as Any) }
      // The page grant survives; only the narrowing is lifted. Deleting the
      // whole entry would take the user off Sales altogether, which is not
      // what turning a desk off means.
      delete o.scope
      out[moduleKey] = o
    }
  } else {
    out[moduleKey] = { view: true, create: false, edit: true, delete: false, ...(grant || {}), scope }
  }
  return out
}

// ------------------------------------------------------------- for the list --

export function scopeOf(perms: Perms): string {
  if (rightsOf(perms, 'sales').scope === 'unload') return 'Unloading desk'
  if (rightsOf(perms, 'orders').scope === 'readings') return 'Readings desk'
  if (rightsOf(perms, 'salesBargains').scope === 'topup') return 'Bargain increase desk'
  if (rightsOf(perms, 'sales').scope === 'intercompany') return 'Inter-company desk'
  if (rightsOf(perms, 'sales').scope === 'tds') return 'TDS desk'
  return ''
}

// "7d · 2d", "all · no limit", or "mixed" where the rows disagree — a column
// that has to say something true about two dozen modules at once.
export function windowsOf(perms: Perms, keys: string[]): string {
  const live = keys.map((k) => rightsOf(perms, k)).filter((r) => r.view)
  const uniq = (xs: string[]): string[] => [...new Set(xs.filter((x) => x !== ''))]
  const vd = uniq(live.map((r) => r.viewDays))
  const ed = uniq(live.map((r) => r.editDays))
  const one = (arr: string[], none: string): string =>
    arr.length === 0 ? none : arr.length === 1 ? `${arr[0]}d` : 'mixed'
  return `${one(vd, 'all')} · ${one(ed, 'no limit')}`
}

// Work Assignments access. Deliberately the ONE default-ALLOW permission in
// this file — everyone gets today's checklist without an admin having to grant
// it page by page — so it cannot share rightsOf/writeRights, whose whole
// contract is default-DENY (no entry = no access). An explicit `false` is the
// only thing that removes it; absence, `true`, or any other stored shape all
// read as allowed, which is what keeps every login that predates this feature
// unaffected.
export function hasWorkAccess(perms: Perms): boolean {
  return (perms || {}).workAssignments !== false
}

export function setWorkAccess(perms: Perms, on: boolean): Perms {
  const out = { ...(perms || {}) }
  // Turning it back on DELETES the flag rather than storing `true` — "on" and
  // "never touched" are the same state for a default-allow permission, and
  // leaving a stray key behind is one more thing a future reader has to know
  // is safe to ignore.
  if (on) delete out.workAssignments
  else out.workAssignments = false
  return out
}
