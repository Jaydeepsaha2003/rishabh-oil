import { useEffect, useState } from 'react'
import { Database, Loader2 } from 'lucide-react'

const BACKDROP = 'linear-gradient(120deg, #0f172a, #b45309, #0f172a, #1e293b)'

export function DbSetupScreen({ onReady }: { onReady: () => void }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.config.get().then((c) => setUrl(c.url || ''))
  }, [])

  async function save(): Promise<void> {
    if (!url.trim() || !token.trim()) {
      setError('Enter both the database URL and the auth token.')
      return
    }
    setSaving(true)
    setError(null)
    const res = await window.api.config.save(url.trim(), token.trim())
    setSaving(false)
    if (res.ok) onReady()
    else setError(res.message || 'Could not connect — check the URL and token.')
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div
        className="absolute inset-0 animate-gradient-shift bg-[length:200%_200%]"
        style={{ backgroundImage: BACKDROP }}
      />
      <div className="relative w-full max-w-md animate-fade-up rounded-2xl border border-white/10 bg-white/95 p-8 shadow-2xl backdrop-blur">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg">
            <Database className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Connect the database</h1>
          <p className="mt-1 text-sm text-slate-500">
            We couldn&apos;t reach the database. Paste your Turso URL and token to connect this
            computer.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Database URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="libsql://your-db.turso.io"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Auth token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your Turso auth token"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={save}
            disabled={saving}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-amber-500 text-sm font-medium text-white shadow-sm transition hover:bg-amber-600 disabled:opacity-70"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting…
              </>
            ) : (
              'Save & connect'
            )}
          </button>
          <p className="text-center text-xs text-slate-400">
            Saved securely on this computer. Your administrator can provide these details.
          </p>
        </div>
      </div>
    </div>
  )
}
