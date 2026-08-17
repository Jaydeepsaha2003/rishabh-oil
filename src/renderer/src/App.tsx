import { useCallback, useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { Download, LogOut, RefreshCw, WifiOff } from 'lucide-react'
import { Sidebar, type Page } from './components/Sidebar'
import { LoginScreen } from './components/LoginScreen'
import { LoadingSplash } from './components/LoadingSplash'
import { DbSetupScreen } from './components/DbSetupScreen'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'
import { Bargains } from './pages/Bargains'
import { Orders } from './pages/Orders'
import { Consignment } from './pages/Consignment'
import { GateEntry } from './pages/GateEntry'
import { Trading } from './pages/Trading'
import { Accounts } from './pages/Accounts'
import { Treasury } from './pages/Treasury'
import { BankReconciliation } from './pages/BankReconciliation'
import { Products } from './pages/Products'
import { Categories } from './pages/Categories'
import { Formulation } from './pages/Formulation'
import { Production } from './pages/Production'
import { Stock } from './pages/Stock'
import { Sales, SalesBargains } from './pages/Sales'
import { Suppliers } from './pages/Suppliers'
import { Transporters } from './pages/Transporters'
import { Customers } from './pages/Customers'
import { Ports } from './pages/Ports'
import { Brokers } from './pages/Brokers'
import { Packaging } from './pages/Packaging'
import { Approvals } from './pages/Approvals'
import { NotificationBell } from './components/NotificationBell'
import { GlobalDateRangeDialog } from './components/GlobalDateRangeDialog'
import { GlobalDateRangeProvider } from './lib/globalDateRange'
import { clearUser, loadUser, saveUser, type AppUser } from './lib/session'
import { MODULES, canAccess } from './lib/modules'

// Full-width bar pinned above the sidebar+page area — visible on every page,
// not just once the download finishes, so no one is caught mid-task on a
// stale build. Shows as soon as `update-available` fires and stays up
// through download; turns into a one-click restart once ready.
function UpdateTopBar(): React.JSX.Element | null {
  const [status, setStatus] = useState<{ state: string; version?: string; percent?: number } | null>(null)
  useEffect(
    () =>
      window.api.updates.onStatus((s) => {
        const state = String(s.state || '')
        if (state === 'available' || state === 'downloading' || state === 'downloaded') {
          setStatus({ state, version: s.version, percent: s.percent })
        } else if (state === 'none' || state === 'error') {
          setStatus(null)
        }
      }),
    []
  )
  if (!status) return null
  const ready = status.state === 'downloaded'
  return (
    <div
      className={`flex items-center justify-center gap-3 px-4 py-1.5 text-sm font-medium text-white ${ready ? 'bg-emerald-600' : 'bg-amber-600'}`}
    >
      <Download className="h-4 w-4" />
      {ready ? (
        <>
          <span>Version {status.version} is ready to install.</span>
          <button
            onClick={() => window.api.updates.install()}
            className="rounded-full bg-white/20 px-3 py-0.5 font-semibold hover:bg-white/30"
          >
            Restart & update
          </button>
        </>
      ) : (
        <span>
          {status.state === 'downloading'
            ? `Downloading version ${status.version || ''}${status.percent != null ? ` — ${status.percent}%` : ''}…`
            : `A new version${status.version ? ` (${status.version})` : ''} is available and downloading in the background…`}
        </span>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompanyRow = Record<string, any>

function App(): React.JSX.Element {
  const [user, setUser] = useState<AppUser | null>(() => loadUser())
  const [booting, setBooting] = useState(false)
  const [page, setPage] = useState<Page>('dashboard')
  const [dbState, setDbState] = useState<'checking' | 'ok' | 'setup' | 'offline'>('checking')
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [companyId, setCompanyId] = useState<number>(0)
  const [companyReady, setCompanyReady] = useState(false)
  // Deep-link from the Ledgers page to a specific source document.
  const [focus, setFocus] = useState<{ page: Page; id: number } | null>(null)
  // Where "Back" returns to after a drill-through (e.g. Ledgers → the source
  // document → Back → Ledgers, with the ledger it opened from still showing).
  const [returnTo, setReturnTo] = useState<Page | null>(null)

  function openRecord(target: 'orders' | 'sales', id: number): void {
    setReturnTo(page)
    setFocus({ page: target, id })
    setPage(target)
  }

  // Manual navigation (sidebar) always clears any pending drill-through context.
  function navigate(p: Page): void {
    setReturnTo(null)
    setFocus(null)
    setPage(p)
  }

  function goBack(): void {
    const t = returnTo || 'accounts'
    setReturnTo(null)
    setFocus(null)
    setPage(t)
  }

  // Human label of the page a drill-through came from (for the Back button).
  const backLabel = returnTo ? MODULES.find((m) => m.key === returnTo)?.label || 'previous page' : ''

  // Alt+F2 (Tally's period-change key) — works from anywhere in the app, not
  // just one page, since every date-range filter listens for the same broadcast.
  const [periodOpen, setPeriodOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.altKey && e.key === 'F2') {
        e.preventDefault()
        setPeriodOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // On launch, test the (auto-configured) connection. No internet → a friendly
  // "check your connection" screen (NOT the credentials screen); any other
  // failure → setup. While offline, keep retrying so it recovers by itself.
  const checkDb = useCallback(async () => {
    if (!navigator.onLine) {
      setDbState('offline')
      return
    }
    const r = await window.api.dbPing().catch(() => ({ ok: false, offline: true, message: '' }))
    setDbState(r.ok ? 'ok' : (r as { offline?: boolean }).offline ? 'offline' : 'setup')
  }, [])
  useEffect(() => {
    checkDb()
  }, [checkDb])
  useEffect(() => {
    if (dbState !== 'offline') return
    const timer = setInterval(checkDb, 5000)
    window.addEventListener('online', checkDb)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', checkDb)
    }
  }, [dbState, checkDb])

  // Pick the active company (remembered per machine) BEFORE any page loads data
  // — every scoped query in the main process filters by it.
  useEffect(() => {
    if (!user || dbState !== 'ok') return
    let cancelled = false
    ;(async () => {
      const list = await window.api.company.list().catch(() => [] as CompanyRow[])
      // Default new devices to the OLDEST active company (the original one),
      // not the alphabetically first — a remembered choice always wins.
      const active = [...list.filter((c) => c.active)].sort((a, b) => Number(a.id) - Number(b.id))
      const stored = Number(localStorage.getItem('companyId') || 0)
      const pick = active.find((c) => Number(c.id) === stored) || active[0] || list[0]
      const id = Number(pick?.id || 1)
      await window.api.company.setActive(id).catch(() => {})
      if (cancelled) return
      setCompanies(list)
      setCompanyId(id)
      localStorage.setItem('companyId', String(id))
      setCompanyReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [user, dbState])

  // Instant switch: set the active company in the main process and remount the
  // pages (via key) so every screen refetches — no full app reload needed.
  async function switchCompany(id: string): Promise<void> {
    localStorage.setItem('companyId', id)
    try {
      await window.api.company.setActive(Number(id))
    } catch {
      // main process falls back to company 1; the UI below still updates
    }
    setCompanyId(Number(id))
    const name = companies.find((c) => String(c.id) === id)?.name
    if (name) toast.success(`Working in ${name}`)
  }

  const allowed = user ? MODULES.filter((m) => canAccess(user, m.key)).map((m) => m.key) : []

  // If the current page isn't permitted, fall back to the first one that is.
  useEffect(() => {
    if (user && allowed.length > 0 && !allowed.includes(page)) {
      setPage(allowed[0] as Page)
    }
  }, [user, allowed, page])

  // Tell the main process who is acting on this device, so the audit trail can
  // attribute every write. Runs on login and whenever the user is restored.
  useEffect(() => {
    if (!user) return
    window.api.session.setUser(Number(user.id), String(user.username)).catch(() => {})
  }, [user])

  // Presence heartbeat — marks this user live and enforces device (IP) blocks.
  useEffect(() => {
    if (!user) return
    let stop = false
    const beat = async (): Promise<void> => {
      try {
        const r = await window.api.access.heartbeat(user.id, user.username)
        if (!stop && r.blocked) {
          clearUser()
          setUser(null)
        }
      } catch {
        // ignore transient errors
      }
    }
    beat()
    const id = setInterval(beat, 30000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [user])

  function handleLogin(u: AppUser): void {
    saveUser(u)
    setUser(u)
    setBooting(true)
    setTimeout(() => setBooting(false), 1400)
  }

  function handleLogout(): void {
    clearUser()
    setUser(null)
    setPage('dashboard')
  }

  if (dbState === 'checking') return <LoadingSplash />
  if (dbState === 'offline') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600">
          <WifiOff className="h-8 w-8" />
        </div>
        <h2 className="text-xl font-semibold">No internet connection</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          This app needs the internet to reach your data. Please turn on Wi-Fi or check your network — it will reconnect automatically.
        </p>
        <button
          onClick={() => { setDbState('checking'); checkDb() }}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium shadow-sm hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      </div>
    )
  }
  if (dbState === 'setup') return <DbSetupScreen onReady={() => setDbState('ok')} />

  if (!user) return <LoginScreen onLogin={handleLogin} />
  if (booting) return <LoadingSplash name={user.full_name} />

  if (allowed.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold">No modules assigned</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask an administrator to grant you access.
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    )
  }

  if (!companyReady) return <LoadingSplash />

  const view = allowed.includes(page) ? page : (allowed[0] as Page)

  return (
    <GlobalDateRangeProvider>
    <div className="flex h-screen flex-col overflow-hidden bg-muted/30 text-foreground">
      <UpdateTopBar />
      <div className="flex flex-1 overflow-hidden">
      <Sidebar
        page={view}
        onNavigate={navigate}
        user={user}
        onLogout={handleLogout}
        companies={companies}
        companyId={companyId}
        onCompanyChange={switchCompany}
      />
      <main key={companyId} className="relative flex-1 overflow-auto">
        {view === 'dashboard' && <Dashboard onNavigate={setPage} />}
        {view === 'bargains' && <Bargains onOpenOrder={(id) => openRecord('orders', id)} />}
        {view === 'orders' && (
          <Orders
            focusId={focus?.page === 'orders' ? focus.id : null}
            onFocusHandled={() => setFocus(null)}
            onBack={view === 'orders' && returnTo ? goBack : undefined}
            backLabel={backLabel}
          />
        )}
        {view === 'consignment' && <Consignment />}
        {view === 'gateEntry' && <GateEntry />}
        {view === 'trading' && <Trading />}
        {view === 'accounts' && <Accounts onExit={() => setPage('dashboard')} />}
        {view === 'treasury' && <Treasury onCompanyChange={switchCompany} />}
        {view === 'bankRecon' && <BankReconciliation />}
        {view === 'products' && <Products />}
        {view === 'categories' && <Categories />}
        {view === 'formulation' && <Formulation />}
        {view === 'production' && <Production />}
        {view === 'stock' && <Stock />}
        {view === 'salesBargains' && <SalesBargains onOpenSale={(id) => openRecord('sales', id)} />}
        {view === 'sales' && (
          <Sales
            focusId={focus?.page === 'sales' ? focus.id : null}
            onFocusHandled={() => setFocus(null)}
            onBack={view === 'sales' && returnTo ? goBack : undefined}
            backLabel={backLabel}
          />
        )}
        {view === 'suppliers' && <Suppliers />}
        {view === 'transporters' && <Transporters />}
        {view === 'customers' && <Customers />}
        {view === 'ports' && <Ports />}
        {view === 'brokers' && <Brokers />}
        {view === 'packaging' && <Packaging />}
        {view === 'approvals' && <Approvals />}
        {view === 'settings' && <Settings user={user} />}
      </main>
      <NotificationBell user={user} onNavigate={(p) => navigate(p as Page)} />
      </div>
      <GlobalDateRangeDialog open={periodOpen} onOpenChange={setPeriodOpen} currentPage={page} />
      <Toaster richColors position="bottom-right" />
    </div>
    </GlobalDateRangeProvider>
  )
}

export default App
