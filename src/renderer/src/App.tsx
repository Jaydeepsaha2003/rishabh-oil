import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { LogOut } from 'lucide-react'
import { Sidebar, type Page } from './components/Sidebar'
import { LoginScreen } from './components/LoginScreen'
import { LoadingSplash } from './components/LoadingSplash'
import { DbSetupScreen } from './components/DbSetupScreen'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'
import { Bargains } from './pages/Bargains'
import { Orders } from './pages/Orders'
import { Ledgers } from './pages/Ledgers'
import { Payments } from './pages/Payments'
import { clearUser, loadUser, saveUser, type AppUser } from './lib/session'
import { MODULES, canAccess } from './lib/modules'

function App(): React.JSX.Element {
  const [user, setUser] = useState<AppUser | null>(() => loadUser())
  const [booting, setBooting] = useState(false)
  const [page, setPage] = useState<Page>('dashboard')
  const [dbState, setDbState] = useState<'checking' | 'ok' | 'setup'>('checking')

  // On launch, test the (auto-configured) connection; show setup only if it fails.
  useEffect(() => {
    window.api.dbPing().then((r) => setDbState(r.ok ? 'ok' : 'setup'))
  }, [])

  const allowed = user ? MODULES.filter((m) => canAccess(user, m.key)).map((m) => m.key) : []

  // If the current page isn't permitted, fall back to the first one that is.
  useEffect(() => {
    if (user && allowed.length > 0 && !allowed.includes(page)) {
      setPage(allowed[0] as Page)
    }
  }, [user, allowed, page])

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

  const view = allowed.includes(page) ? page : (allowed[0] as Page)

  return (
    <div className="flex h-screen overflow-hidden bg-muted/30 text-foreground">
      <Sidebar page={view} onNavigate={setPage} user={user} onLogout={handleLogout} />
      <main className="relative flex-1 overflow-auto">
        {view === 'dashboard' && <Dashboard onNavigate={setPage} />}
        {view === 'bargains' && <Bargains />}
        {view === 'orders' && <Orders />}
        {view === 'payments' && <Payments />}
        {view === 'ledgers' && <Ledgers />}
        {view === 'settings' && <Settings user={user} />}
      </main>
      <Toaster richColors position="top-right" />
    </div>
  )
}

export default App
