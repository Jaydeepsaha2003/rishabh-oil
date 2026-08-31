import type { AppUser } from './session'

export interface ModuleDef {
  key: string
  label: string
  // A page reached through its sections rather than granted in its own right.
  // It still needs a key so the navigation and the router can name it, but it
  // takes no row of its own on the rights grid — a parent tick beside three
  // child ticks is two ways of saying the same thing, and the two can
  // disagree.
  derived?: boolean
}

// Sections that stand in for a derived page: holding any one of them opens the
// page, and the strongest of them is the access the page carries.
export const DERIVED_FROM: Record<string, string[]> = {
  treasury: ['treasuryLc', 'treasuryBd', 'treasuryTracker']
}

// Modules an admin can grant per user. (User management stays admin-only.)
export const MODULES: ModuleDef[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'bargains', label: 'Pur Bargain' },
  { key: 'orders', label: 'Purchases' },
  { key: 'consignment', label: 'Consignment' },
  { key: 'gateEntry', label: 'Gate Entry' },
  { key: 'trading', label: 'Trading' },
  { key: 'accounts', label: 'Accounting' },
  { key: 'treasury', label: 'Treasury', derived: true },
  // Treasury holds three quite separate jobs, and the people who do them are
  // rarely the same person: the LC desk deals with the bank, bill discounting
  // is a financing decision, and the payment tracker is collections. Granting
  // "Treasury" gave all three to whoever needed one of them.
  //
  // These sit UNDER Treasury — a user needs Treasury itself to reach the page
  // at all, and then one of these to see a section of it.
  { key: 'treasuryLc', label: 'Treasury · Letters of Credit' },
  { key: 'treasuryBd', label: 'Treasury · Bill Discounting' },
  { key: 'treasuryTracker', label: 'Treasury · Payment Tracker' },
  { key: 'bankRecon', label: 'Bank Reconciliation' },
  { key: 'categories', label: 'Categories' },
  { key: 'products', label: 'Products' },
  { key: 'formulation', label: 'Formulation' },
  { key: 'production', label: 'Production' },
  { key: 'stock', label: 'Stock' },
  { key: 'salesBargains', label: 'Sales Bargain' },
  { key: 'sales', label: 'Sales' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'transporters', label: 'Transporters' },
  { key: 'customers', label: 'Customers' },
  { key: 'ports', label: 'Ports' },
  { key: 'banks', label: 'Manage Banks' },
  { key: 'brokers', label: 'Brokers' },
  { key: 'packaging', label: 'Packed SKU' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'settings', label: 'Settings' }
]

type PermUser = Pick<AppUser, 'role' | 'permissions'> | null | undefined

// 'write' (full) > 'read' (view only) > 'none'. Admin is always 'write'.
//
// user.permissions[key] comes in three shapes, oldest to newest — all still
// have to work, since existing users were saved under the older ones:
//   1. a flat string[] of module keys ("has this module" = full access)
//   2. { [key]: 'read' | 'write' }
//   3. { [key]: { view, create, edit, delete, editDays } } — the per-module
//      grid on the Users page. 'write' here means any of create/edit/delete;
//      'read' means view-only (view but no write flags).
export function permLevel(user: PermUser, key: string): 'none' | 'read' | 'write' {
  if (!user) return 'none'
  // A derived page carries whatever its strongest section carries — you reach
  // Treasury because you hold the LC desk, not because someone remembered to
  // tick Treasury as well.
  //
  // An explicit grant on the page itself still counts, so users saved before
  // the sections existed keep working: their old `treasury` entry is inherited
  // by each section below (see modulePerm on the server, and inheritFrom here).
  const sections = DERIVED_FROM[key]
  if (sections && user.role !== 'admin') {
    const own = directLevel(user, key)
    let best: 'none' | 'read' | 'write' = own
    for (const sec of sections) {
      const lvl = directLevel(user, sec)
      if (lvl === 'write') return 'write'
      if (lvl === 'read' && best === 'none') best = 'read'
    }
    return best
  }
  return directLevel(user, key)
}

function directLevel(user: PermUser, key: string): 'none' | 'read' | 'write' {
  if (!user) return 'none'
  // Everyone can see Approvals: admins act on the queue, others track their
  // own submitted masters (and see rejection reasons).
  if (key === 'approvals') return 'write'
  if (user.role === 'admin') return 'write'
  const p = user.permissions
  if (Array.isArray(p)) return p.includes(key) ? 'write' : 'none'
  if (p && typeof p === 'object') {
    const v = (p as Record<string, unknown>)[key]
    if (v === 'write') return 'write'
    if (v === 'read') return 'read'
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.create || o.edit || o.delete) return 'write'
      if (o.view) return 'read'
      return 'none'
    }
  }
  return 'none'
}

// A narrowed job inside a module: the user reaches the page, but only the one
// task the grant names. Today the only one is 'unload' on Sales — the unloading
// desk, which sees FOR deliveries still out and records nothing but the
// received quantity. Admins are never scoped.
export function moduleScope(user: PermUser, key: string): string | null {
  if (!user || user.role === 'admin') return null
  const p = user.permissions
  if (!p || Array.isArray(p) || typeof p !== 'object') return null
  const v = (p as Record<string, unknown>)[key]
  if (!v || typeof v !== 'object') return null
  const scope = (v as Record<string, unknown>).scope
  return scope ? String(scope) : null
}

export function canAccess(user: PermUser, key: string): boolean {
  return permLevel(user, key) !== 'none'
}

export function canWrite(user: PermUser, key: string): boolean {
  return permLevel(user, key) === 'write'
}
