import { useState } from 'react'
import {
  Tags,
  Landmark,
  BookOpenCheck,
  Anchor,
  Boxes,
  Briefcase,
  Building2,
  BookOpenText,
  ClipboardCheck,
  Contact,
  DoorOpen,
  Droplets,
  Factory,
  FileText,
  FlaskConical,
  FilePlus2,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PackageOpen,
  Repeat,
  ScrollText,
  Settings as SettingsIcon,
  ShoppingCart,
  Tag,
  Truck,
  Wallet,
  Warehouse,
  X,
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
  | 'consignment'
  | 'gateEntry'
  | 'trading'
  | 'accounts'
  | 'treasury'
  | 'bankRecon'
  | 'categories'
  | 'products'
  | 'formulation'
  | 'production'
  | 'stock'
  | 'salesBargains'
  | 'sales'
  | 'suppliers'
  | 'transporters'
  | 'customers'
  | 'ports'
  | 'banks'
  | 'brokers'
  | 'packaging'
  | 'approvals'

const ITEMS: Record<string, { label: string; icon: LucideIcon }> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard },
  bargains: { label: 'Pur Bargain', icon: FileText },
  orders: { label: 'Purchases', icon: ShoppingCart },
  consignment: { label: 'Consignment', icon: PackageOpen },
  gateEntry: { label: 'Gate Entry', icon: DoorOpen },
  accounts: { label: 'Accounting', icon: BookOpenCheck },
  treasury: { label: 'Treasury', icon: Landmark },
  bankRecon: { label: 'Bank Reconciliation', icon: Wallet },
  categories: { label: 'Categories', icon: Tags },
  products: { label: 'Products', icon: Boxes },
  formulation: { label: 'Formulation', icon: FlaskConical },
  production: { label: 'Production', icon: Factory },
  stock: { label: 'Stock', icon: Warehouse },
  salesBargains: { label: 'Sales Bargain', icon: ScrollText },
  sales: { label: 'Sales', icon: Tag },
  suppliers: { label: 'Suppliers', icon: Building2 },
  transporters: { label: 'Transporters', icon: Truck },
  customers: { label: 'Customers', icon: Contact },
  ports: { label: 'Ports', icon: Anchor },
  banks: { label: 'Manage Banks', icon: Landmark },
  brokers: { label: 'Brokers', icon: Briefcase },
  packaging: { label: 'Packed SKU', icon: Package },
  trading: { label: 'Trading', icon: Repeat },
  approvals: { label: 'Approvals', icon: ClipboardCheck },
  settings: { label: 'Settings', icon: SettingsIcon }
}

const GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Overview', ids: ['dashboard'] },
  { label: 'Purchase', ids: ['bargains', 'orders', 'consignment', 'gateEntry'] },
  { label: 'Production', ids: ['products', 'formulation', 'production', 'stock'] },
  { label: 'Sales', ids: ['salesBargains', 'sales'] },
  { label: 'Trading', ids: ['trading'] },
  { label: 'Accounts', ids: ['accounts', 'treasury', 'bankRecon'] },
  { label: 'Masters', ids: ['categories', 'suppliers', 'transporters', 'customers', 'ports', 'banks', 'brokers', 'packaging'] },
  { label: 'System', ids: ['approvals', 'settings'] }
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
  // Website at phone width: no room for even a collapsed rail, and there's no
  // hover to expand it on touch anyway. Renders one tap-to-open trigger
  // instead — see the mobile branch below.
  mobile?: boolean
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
  onCompanyChange,
  mobile = false
}: Props): React.JSX.Element {
  // On mobile this only ever means "the overlay is open" — there's no
  // collapsed-but-visible rail state there, unlike desktop.
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
    const showLabel = expanded || mobile
    // The forest rail only applies to the website's own desktop-width rail —
    // the mobile overlay stays on its plain white sheet, and so does the
    // desktop app (__WEB__ compiles out there).
    const forestRail = __WEB__ && !mobile
    const btn = (
      <button
        onClick={() => {
          onNavigate(id as Page)
          if (mobile) setExpanded(false)
        }}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors',
          showLabel ? 'px-3' : 'justify-center px-0',
          forestRail
            ? active
              ? 'bg-[#072B20] text-[#C7F03F]'
              : 'text-[#6E9484] hover:bg-white/10 hover:text-[#DCEFE4]'
            : active
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {showLabel && <span className="truncate">{it.label}</span>}
      </button>
    )
    if (showLabel) return <div key={id}>{btn}</div>
    return (
      <Tooltip key={id}>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right">{it.label}</TooltipContent>
      </Tooltip>
    )
  }

  if (mobile) {
    return (
      <>
        {/* The one thing on screen at rest — no reserved rail, nothing else
            competing for the width a phone doesn't have. */}
        <button
          onClick={() => setExpanded(true)}
          aria-label="Open menu"
          className="fixed left-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-lg border bg-card text-foreground shadow-md"
        >
          <Menu className="h-5 w-5" />
        </button>

        {expanded && (
          <>
            <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setExpanded(false)} />
            <aside className="fixed left-0 top-0 z-50 flex h-screen w-72 max-w-[85vw] flex-col bg-card shadow-xl">
              <div className="flex h-14 items-center gap-2.5 border-b px-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm">
                  <Droplets className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="text-sm font-semibold leading-tight">Database Management</div>
                  <div className="text-[11px] text-muted-foreground">Software</div>
                </div>
                <button
                  onClick={() => setExpanded(false)}
                  aria-label="Close menu"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="border-b p-2">
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
              </div>

              <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-2">
                {visibleGroups.map((g) => (
                  <div key={g.label} className="space-y-0.5">
                    <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {g.label}
                    </div>
                    {g.ids.map((id) => navItem(id))}
                  </div>
                ))}
              </nav>

              <div className="border-t p-2">
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
              </div>
            </aside>
          </>
        )}
      </>
    )
  }

  // Website only — the "Sales Desktop" design handoff's forest/lime rail.
  // Desktop app keeps its existing neutral bg-card theme untouched (__WEB__
  // compiles out entirely there).
  const railBorder = __WEB__ ? 'border-white/10' : 'border-b'
  const footerBorder = __WEB__ ? 'border-white/10' : 'border-t'

  return (
    <>
      {/* reserves the collapsed rail width so content doesn't sit under the bar */}
      <div className="w-16 shrink-0" />

      <aside
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        className={cn(
          'fixed left-0 top-0 z-30 flex h-screen flex-col shadow-sm transition-[width] duration-200 ease-out',
          __WEB__ ? 'bg-[#0B3D2E]' : 'border-r bg-card',
          expanded ? 'w-64' : 'w-16'
        )}
      >
        <div className={cn('flex h-14 items-center gap-2.5 border-b px-3', railBorder)}>
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-sm',
              __WEB__ ? 'bg-[#C7F03F] text-[#0B3D2E]' : 'bg-amber-500 text-white'
            )}
          >
            <Droplets className="h-5 w-5" />
          </div>
          {expanded && (
            <div className="leading-tight">
              <div className={cn('text-sm font-semibold leading-tight', __WEB__ && 'text-white')}>Database Management</div>
              <div className={cn('text-[11px]', __WEB__ ? 'text-[#8FBFA8]' : 'text-muted-foreground')}>Software</div>
            </div>
          )}
        </div>

        {/* Company switcher — the active company scopes every business screen.
            Clickable in BOTH states, so switching never requires expanding. */}
        <div className={cn('border-b p-2', railBorder)}>
          {expanded ? (
            <Select value={String(companyId || '')} onValueChange={onCompanyChange}>
              <SelectTrigger className={cn('h-8 text-xs', __WEB__ && 'border-white/15 bg-white/10 text-[#DCEFE4]')}>
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
                className={cn(
                  'h-8 w-full justify-center gap-0.5 px-1 text-xs font-bold [&>svg]:h-3 [&>svg]:w-3',
                  __WEB__ ? 'border-white/15 bg-white/10 text-[#DCEFE4]' : 'bg-muted text-muted-foreground'
                )}
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
                <div
                  className={cn(
                    'px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider',
                    __WEB__ ? 'text-[#6E9484]' : 'text-muted-foreground/70'
                  )}
                >
                  {g.label}
                </div>
              ) : (
                gi > 0 && <div className={cn('mx-2 my-1 border-t', __WEB__ ? 'border-white/10' : 'border-border')} />
              )}
              {g.ids.map((id) => navItem(id))}
            </div>
          ))}
        </nav>

        <div className={cn('border-t p-2', footerBorder)}>
          {expanded ? (
            <div className="flex items-center gap-2.5 px-1 py-1">
              <div
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white',
                  __WEB__ ? 'bg-[#C2700A]' : 'bg-amber-500'
                )}
              >
                {initials(user.full_name || user.username)}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className={cn('truncate text-sm font-medium', __WEB__ && 'text-white')}>{user.full_name || user.username}</div>
                <div className={cn('text-[11px] capitalize', __WEB__ ? 'text-[#8FBFA8]' : 'text-muted-foreground')}>{user.role}</div>
              </div>
              <button
                onClick={onLogout}
                title="Sign out"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                  __WEB__ ? 'text-[#6E9484] hover:bg-white/10 hover:text-[#C7F03F]' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white',
                      __WEB__ ? 'bg-[#C2700A]' : 'bg-amber-500'
                    )}
                  >
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
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                      __WEB__ ? 'text-[#6E9484] hover:bg-white/10 hover:text-[#C7F03F]' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
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
