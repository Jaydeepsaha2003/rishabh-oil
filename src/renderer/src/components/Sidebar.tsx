import { useState } from 'react'
import {
  Anchor,
  Boxes,
  Briefcase,
  Building2,
  Contact,
  CreditCard,
  DoorOpen,
  Droplets,
  Factory,
  FileText,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Settings as SettingsIcon,
  ShoppingCart,
  Tag,
  Truck,
  Wallet,
  Warehouse,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppUser } from '@/lib/session'
import { canAccess } from '@/lib/modules'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type Page =
  | 'dashboard'
  | 'settings'
  | 'bargains'
  | 'orders'
  | 'gateEntry'
  | 'ledgers'
  | 'payments'
  | 'products'
  | 'formulation'
  | 'production'
  | 'stock'
  | 'sales'
  | 'suppliers'
  | 'transporters'
  | 'customers'
  | 'ports'
  | 'brokers'

const ITEMS: Record<string, { label: string; icon: LucideIcon }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  bargains: { label: 'Bargain', icon: FileText },
  orders: { label: 'Purchases', icon: ShoppingCart },
  gateEntry: { label: 'Gate Entry', icon: DoorOpen },
  payments: { label: 'Payments', icon: CreditCard },
  ledgers: { label: 'Ledgers', icon: Wallet },
  products: { label: 'Products', icon: Boxes },
  formulation: { label: 'Formulation', icon: FlaskConical },
  production: { label: 'Production', icon: Factory },
  stock: { label: 'Stock', icon: Warehouse },
  sales: { label: 'Sales', icon: Tag },
  suppliers: { label: 'Suppliers', icon: Building2 },
  transporters: { label: 'Transporters', icon: Truck },
  customers: { label: 'Customers', icon: Contact },
  ports: { label: 'Ports', icon: Anchor },
  brokers: { label: 'Brokers', icon: Briefcase },
  settings: { label: 'Settings', icon: SettingsIcon }
}

const GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Overview', ids: ['dashboard'] },
  { label: 'Purchase', ids: ['bargains', 'orders', 'gateEntry'] },
  { label: 'Production', ids: ['products', 'formulation', 'production', 'stock'] },
  { label: 'Sales', ids: ['sales'] },
  { label: 'Accounts', ids: ['payments', 'ledgers'] },
  { label: 'Masters', ids: ['suppliers', 'transporters', 'customers', 'ports', 'brokers'] },
  { label: 'System', ids: ['settings'] }
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompanyRow = Record<string, any>

interface Props {
  page: Page
  onNavigate: (page: Page) => void
  user: AppUser
  onLogout: () => void
  companies: CompanyRow[]
  companyId: number
  onCompanyChange: (id: string) => void
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

export function Sidebar({
  page,
  onNavigate,
  user,
  onLogout,
  companies,
  companyId,
  onCompanyChange
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const activeCompany = companies.find((c) => Number(c.id) === Number(companyId))

  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    ids: g.ids.filter((id) => canAccess(user, id))
  })).filter((g) => g.ids.length > 0)

  function navItem(id: string): React.JSX.Element {
    const it = ITEMS[id]
    const Icon = it.icon
    const active = page === id
    const btn = (
      <button
        onClick={() => onNavigate(id as Page)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors',
          expanded ? 'px-3' : 'justify-center px-0',
          active
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {expanded && <span className="truncate">{it.label}</span>}
      </button>
    )
    if (expanded) return <div key={id}>{btn}</div>
    return (
      <Tooltip key={id}>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right">{it.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <>
      {/* reserves the collapsed rail width so content doesn't sit under the bar */}
      <div className="w-16 shrink-0" />

      <aside
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        className={cn(
          'fixed left-0 top-0 z-30 flex h-screen flex-col border-r bg-card shadow-sm transition-[width] duration-200 ease-out',
          expanded ? 'w-64' : 'w-16'
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b px-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm">
            <Droplets className="h-5 w-5" />
          </div>
          {expanded && (
            <div className="leading-tight">
              <div className="text-sm font-semibold">Rishabh Oil</div>
              <div className="text-[11px] text-muted-foreground">Production system</div>
            </div>
          )}
        </div>

        {/* Company switcher — the active company scopes every business screen.
            Clickable in BOTH states, so switching never requires expanding. */}
        <div className="border-b p-2">
          {expanded ? (
            <Select value={String(companyId || '')} onValueChange={onCompanyChange}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select company" />
              </SelectTrigger>
              <SelectContent>
                {companies
                  .filter((c) => c.active)
                  .map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : (
            <Select value={String(companyId || '')} onValueChange={onCompanyChange}>
              <SelectTrigger
                title={activeCompany?.name || 'Switch company'}
                className="h-8 w-full justify-center gap-0.5 bg-muted px-1 text-xs font-bold text-muted-foreground [&>svg]:h-3 [&>svg]:w-3"
              >
                <span>{String(activeCompany?.name || 'C').charAt(0)}</span>
              </SelectTrigger>
              <SelectContent className="min-w-[14rem]">
                {companies
                  .filter((c) => c.active)
                  .map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <nav
          className={cn(
            'flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-2',
            !expanded && 'no-scrollbar'
          )}
        >
          {visibleGroups.map((g, gi) => (
            <div key={g.label} className="space-y-0.5">
              {expanded ? (
                <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {g.label}
                </div>
              ) : (
                gi > 0 && <div className="mx-2 my-1 border-t" />
              )}
              {g.ids.map((id) => navItem(id))}
            </div>
          ))}
        </nav>

        <div className="border-t p-2">
          {expanded ? (
            <div className="flex items-center gap-2.5 px-1 py-1">
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
          ) : (
            <div className="flex flex-col items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-500 text-xs font-medium text-white">
                    {initials(user.full_name || user.username)}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {user.full_name || user.username} · {user.role}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onLogout}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Sign out</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
