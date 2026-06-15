import { useState } from 'react'
import { Droplets, Loader2, Lock, User } from 'lucide-react'
import type { AppUser } from '@/lib/session'

const BACKDROP = 'linear-gradient(120deg, #0f172a, #b45309, #0f172a, #1e293b)'

export function LoginScreen({ onLogin }: { onLogin: (u: AppUser) => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const u = await window.api.auth.login(username.trim(), password)
      onLogin(u as AppUser)
    } catch (err) {
      setError((err as Error).message)
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div
        className="absolute inset-0 animate-gradient-shift bg-[length:200%_200%]"
        style={{ backgroundImage: BACKDROP }}
      />
      <Droplets className="absolute left-[12%] top-[16%] h-24 w-24 animate-float text-amber-400/10" />
      <Droplets
        className="absolute bottom-[14%] right-[14%] h-32 w-32 animate-float text-amber-300/10"
        style={{ animationDelay: '1.2s' }}
      />

      <div className="relative w-full max-w-sm animate-fade-up rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg">
            <Droplets className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Welcome to Rishabh Oil</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to your production workspace</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="relative">
            <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-amber-500 text-sm font-medium text-white shadow-sm transition hover:bg-amber-600 disabled:opacity-70"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-400">
          First time? Default admin — <span className="font-medium text-slate-500">admin / admin123</span>
        </p>
      </div>
    </div>
  )
}
