import type { AppUser } from './session'
import { ACCOUNTS_SECTIONS, SECTION_PARENT } from './accessSections'

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
  treasury: ['treasuryLc', 'treasuryBd', 'treasuryTracker'],
  // Accounting keeps a row of its own (it is the default every section below
  // follows), but holding any one section is also enough to open the page.
  accounts: ACCOUNTS_SECTIONS.map((s) => s.key)
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
  // Each voucher type and screen of the Accounting page, grantable on its own.
  // See accessSections.ts — the list lives there so the server shares it.
  ...ACCOUNTS_SECTIONS.map((s) => ({ key: s.key, label: s.label })),
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
  { key: 'companies', label: 'Companies' },
  { key: 'factories', label: 'Factories' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'settings', label: 'Settings' }
]

// WHICH FAMILY A PAGE BELONGS TO.
//
// Thirty-odd pages is a list nobody reads; five families is one they can. Kept
// here rather than on the rights screen because the work-assignment catalogue
// asks the same question of the same pages, and two copies of this map would
// answer it differently within a month.
export const MODULE_GROUP: Record<string, string> = {
  dashboard: 'Daily work',
  bargains: 'Daily work',
  orders: 'Daily work',
  consignment: 'Daily work',
  gateEntry: 'Daily work',
  trading: 'Daily work',
  salesBargains: 'Daily work',
  sales: 'Daily work',
  accounts: 'Money',
  ...Object.fromEntries(ACCOUNTS_SECTIONS.map((s) => [s.key, 'Money'])),
  treasury: 'Money',
  treasuryLc: 'Money',
  treasuryBd: 'Money',
  treasuryTracker: 'Money',
  bankRecon: 'Money',
  formulation: 'Plant',
  production: 'Plant',
  stock: 'Plant',
  categories: 'Masters',
  products: 'Masters',
  suppliers: 'Masters',
  transporters: 'Masters',
  customers: 'Masters',
  ports: 'Masters',
  banks: 'Masters',
  brokers: 'Masters',
  packaging: 'Masters',
  companies: 'Masters',
  factories: 'Masters',
  approvals: 'System',
  notifications: 'System',
  settings: 'System'
}
export const MODULE_GROUPS = ['Daily work', 'Money', 'Plant', 'Masters', 'System', 'Other']

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
  // Everyone can OPEN Notifications — it is where you see what is on your own
  // bell and silence a rule for yourself. Only an admin can change what the
  // desk as a whole is told, and the page enforces that itself rather than
  // being hidden: a notification you receive but cannot find the setting for
  // is worse than a read-only page.
  if (key === 'notifications') return user.role === 'admin' ? 'write' : 'read'
  // Work Assignments is the one page every login reaches by default — the
  // checklist is built from access, not gated by it, so it cannot wait for
  // somebody to grant it. An admin can still take it away from one person: a
  // stored `permissions.workAssignments === false` is the only thing that
  // removes it, set from the toggle on User Access (never from a grid row —
  // this is not a page with create/edit/delete to parcel out).
  if (key === 'workAssignments') {
    if (user.role === 'admin') return 'write'
    const p = user.permissions
    const blocked = !!p && typeof p === 'object' && !Array.isArray(p) && (p as Record<string, unknown>).workAssignments === false
    return blocked ? 'none' : 'write'
  }
  if (user.role === 'admin') return 'write'
  const p = user.permissions
  const parent = SECTION_PARENT[key]
  if (Array.isArray(p)) return p.includes(key) || (!!parent && p.includes(parent)) ? 'write' : 'none'
  if (p && typeof p === 'object') {
    const v = (p as Record<string, unknown>)[key]
    // A section switched off on its own row, although its page is granted.
    if (v === false) return 'none'
    if (v === 'write') return 'write'
    if (v === 'read') return 'read'
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.create || o.edit || o.delete) return 'write'
      if (o.view) return 'read'
      return 'none'
    }
    // No setting of its own: a section follows the page it belongs to, the
    // same rule the server's write gate applies (modulePerm in access-rules).
    if (v === undefined && parent) return directLevel(user, parent)
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
