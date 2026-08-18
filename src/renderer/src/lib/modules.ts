import type { AppUser } from './session'

export interface ModuleDef {
  key: string
  label: string
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
  { key: 'treasury', label: 'Treasury' },
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

export function canAccess(user: PermUser, key: string): boolean {
  return permLevel(user, key) !== 'none'
}

export function canWrite(user: PermUser, key: string): boolean {
  return permLevel(user, key) === 'write'
}
