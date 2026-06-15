import {
  CreditCard,
  Droplets,
  FileText,
  LayoutDashboard,
  LogOut,
  Settings as SettingsIcon,
  ShoppingCart,
  Wallet
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppUser } from '@/lib/session'
import { canAccess } from '@/lib/modules'

export type Page = 'dashboard' | 'settings' | 'bargains' | 'orders' | 'ledgers' | 'payments'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, enabled: true },
  { id: 'bargains', label: 'Bargains', icon: FileText, enabled: true },
  { id: 'orders', label: 'Orders', icon: ShoppingCart, enabled: true },
  { id: 'payments', label: 'Payments', icon: CreditCard, enabled: true },
  { id: 'ledgers', label: 'Ledgers', icon: Wallet, enabled: true },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, enabled: true }
] as const

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  user: AppUser
  onLogout: () => void
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function Sidebar({ page, onNavigate, user, onLogout }: Props): React.JSX.Element {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2.5 border-b px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm">
          <Droplets className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Rishabh Oil</div>
          <div className="text-[11px] text-muted-foreground">Production system</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 p-3">
        <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Menu
        </div>
        {NAV.filter((n) => canAccess(user, n.id)).map((n) => {
          const Icon = n.icon
          const active = page === n.id
          return (
            <button
              key={n.id}
              onClick={() => onNavigate(n.id as Page)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {n.label}
            </button>
          )
        })}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-medium text-white">
            {initials(user.full_name || user.username)}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{user.full_name || user.username}</div>
            <div className="text-[11px] capitalize text-muted-foreground">{user.role}</div>
          </div>
          <button
            onClick={onLogout}
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
