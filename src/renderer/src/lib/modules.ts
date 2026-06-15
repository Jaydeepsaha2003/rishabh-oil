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
  { key: 'settings', label: 'Settings' }
]

export function canAccess(user: Pick<AppUser, 'role' | 'permissions'>, key: string): boolean {
  if (user.role === 'admin') return true
  return Array.isArray(user.permissions) && user.permissions.includes(key)
}
