import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Quiet auto-update indicator: shows nothing until a new version is actually
// on its way, then a download ticker, then one button — "Restart to update" —
// which installs silently and relaunches (no installer wizard).
export function UpdateBadge({ className }: { className?: string }): React.JSX.Element | null {
  const [status, setStatus] = useState<Row | null>(null)

  useEffect(() => window.api.updates.onStatus(setStatus), [])

  if (!status) return null
  if (status.state === 'downloading') {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] font-medium text-sky-700', className)}>
        <Download className="h-3 w-3 animate-pulse" />
        Update {Number(status.percent) || 0}%
      </span>
    )
  }
  if (status.state === 'downloaded') {
    return (
      <button
        type="button"
        onClick={() => void window.api.updates.install()}
        title="Installs silently and reopens the app — no installer steps"
        className={cn(
          'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 transition-colors hover:bg-indigo-100',
          className
        )}
      >
        <RefreshCw className="h-3 w-3" />
        v{status.version} ready — Restart to update
      </button>
    )
  }
  return null
}
