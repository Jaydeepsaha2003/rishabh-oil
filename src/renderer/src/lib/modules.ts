import type { AppUser } from './session'

export interface ModuleDef {
  key: string
  label: string
}

// Modules an admin can grant per user. (User management stays admin-only.)
export const MODULES: ModuleDef[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'bargains', label: 'Bargains' },
  { key: 'orders', label: 'Orders' },
  { key: 'payments', label: 'Payments' },
  { key: 'ledgers', label: 'Ledgers' },
  { key: 'products', label: 'Products' },
  { key: 'formulation', label: 'Formulation' },
  { key: 'production', label: 'Production' },
  { key: 'stock', label: 'Stock' },
  { key: 'sales', label: 'Sales' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'transporters', label: 'Transporters' },
  { key: 'customers', label: 'Customers' },
  { key: 'settings', label: 'Settings' }
]

type PermUser = Pick<AppUser, 'role' | 'permissions'> | null | undefined

// 'write' (full) > 'read' (view only) > 'none'. Admin is always 'write'.
export function permLevel(user: PermUser, key: string): 'none' | 'read' | 'write' {
  if (!user) return 'none'
  if (user.role === 'admin') return 'write'
  const p = user.permissions
  if (Array.isArray(p)) return p.includes(key) ? 'write' : 'none'
  if (p && typeof p === 'object') {
    const v = (p as Record<string, string>)[key]
    return v === 'write' ? 'write' : v === 'read' ? 'read' : 'none'
  }
  return 'none'
}

export function canAccess(user: PermUser, key: string): boolean {
  return permLevel(user, key) !== 'none'
}

export function canWrite(user: PermUser, key: string): boolean {
  return permLevel(user, key) === 'write'
}
