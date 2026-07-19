import { useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { Download, LogOut } from 'lucide-react'
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
import { Ledgers } from './pages/Ledgers'
import { Payments } from './pages/Payments'
import { Products } from './pages/Products'
import { Formulation } from './pages/Formulation'
import { Production } from './pages/Production'
import { Stock } from './pages/Stock'
import { Sales } from './pages/Sales'
import { Suppliers } from './pages/Suppliers'
import { Transporters } from './pages/Transporters'
import { Customers } from './pages/Customers'
import { Ports } from './pages/Ports'
import { Brokers } from './pages/Brokers'
import { clearUser, loadUser, saveUser, type AppUser } from './lib/session'
import { MODULES, canAccess } from './lib/modules'

// Floating "Update" pill — appears automatically once a new version has been
// downloaded in the background; one click restarts into the new version.
function UpdateBanner(): React.JSX.Element | null {
  const [ready, setReady] = useState<string | null>(null)
  useEffect(
    () =>
      window.api.updates.onStatus((s) => {
        if (s.state === 'downloaded') setReady(String(s.version || ''))
      }),
    []
  )
  if (ready == null) return null
  return (
    <button
      onClick={() => window.api.updates.install()}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-emerald-700"
      title={`Version ${ready} downloaded — click to restart and update`}
    >
      <Download className="h-4 w-4" />
      Update{ready ? ` to v${ready}` : ''}
    </button>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompanyRow = Record<string, any>

function App(): React.JSX.Element {
  const [user, setUser] = useState<AppUser | null>(() => loadUser())
  const [booting, setBooting] = useState(false)
  const [page, setPage] = useState<Page>('dashboard')
  const [dbState, setDbState] = useState<'checking' | 'ok' | 'setup'>('checking')
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [companyId, setCompanyId] = useState<number>(0)
  const [companyReady, setCompanyReady] = useState(false)
  // Deep-link from the Ledgers page to a specific source document.
  const [focus, setFocus] = useState<{ page: Page; id: number } | null>(null)

  function openRecord(page: 'orders' | 'sales' | 'payments', id: number): void {
    setFocus({ page, id })
    setPage(page)
  }

  // On launch, test the (auto-configured) connection; show setup only if it fails.
  useEffect(() => {
    window.api.dbPing().then((r) => setDbState(r.ok ? 'ok' : 'setup'))
  }, [])

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
    <div className="flex h-screen overflow-hidden bg-muted/30 text-foreground">
      <Sidebar
        page={view}
        onNavigate={setPage}
        user={user}
        onLogout={handleLogout}
        companies={companies}
        companyId={companyId}
        onCompanyChange={switchCompany}
      />
      <main key={companyId} className="relative flex-1 overflow-auto">
        {view === 'dashboard' && <Dashboard onNavigate={setPage} />}
        {view === 'bargains' && <Bargains />}
        {view === 'orders' && (
          <Orders
            focusId={focus?.page === 'orders' ? focus.id : null}
            onFocusHandled={() => setFocus(null)}
          />
        )}
        {view === 'consignment' && <Consignment />}
        {view === 'gateEntry' && <GateEntry />}
        {view === 'payments' && (
          <Payments
            focusId={focus?.page === 'payments' ? focus.id : null}
            onFocusHandled={() => setFocus(null)}
          />
        )}
        {view === 'ledgers' && <Ledgers onOpenRecord={openRecord} />}
        {view === 'products' && <Products />}
        {view === 'formulation' && <Formulation />}
        {view === 'production' && <Production />}
        {view === 'stock' && <Stock />}
        {view === 'sales' && (
          <Sales
            focusId={focus?.page === 'sales' ? focus.id : null}
            onFocusHandled={() => setFocus(null)}
          />
        )}
        {view === 'suppliers' && <Suppliers />}
        {view === 'transporters' && <Transporters />}
        {view === 'customers' && <Customers />}
        {view === 'ports' && <Ports />}
        {view === 'brokers' && <Brokers />}
        {view === 'settings' && <Settings user={user} />}
      </main>
      <UpdateBanner />
      <Toaster richColors position="top-right" />
    </div>
  )
}

export default App
