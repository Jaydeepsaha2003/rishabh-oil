import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Live database connection indicator. It pings on mount and then every 20s, and
// also whenever Windows reports the network coming back, so a dropped Turso
// connection is visible rather than only surfacing as a failed save.
export function DbStatus({
  className,
  // Just the coloured dot, with the label moved to a hover tooltip — for
  // tight header clusters where the full pill (icon + text) doesn't fit or
  // isn't worth the width. The pill stays the default everywhere else.
  dotOnly = false
}: {
  className?: string
  dotOnly?: boolean
}): React.JSX.Element {
  const [state, setState] = useState<'checking' | 'ok' | 'offline' | 'error'>('checking')
  const [detail, setDetail] = useState('')

  useEffect(() => {
    let alive = true
    async function ping(): Promise<void> {
      try {
        const r = await window.api.dbPing()
        if (!alive) return
        setState(r.ok ? 'ok' : r.offline ? 'offline' : 'error')
        setDetail(r.message || '')
      } catch (e) {
        if (!alive) return
        setState('error')
        setDetail((e as Error).message)
      }
    }
    ping()
    const t = setInterval(ping, 20000)
    window.addEventListener('online', ping)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('online', ping)
    }
  }, [])

  const look = {
    checking: { dot: 'bg-slate-400', text: 'text-muted-foreground', label: 'Checking…' },
    ok: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Database connected' },
    offline: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'No internet' },
    error: { dot: 'bg-red-500', text: 'text-red-700', label: 'Database unreachable' }
  }[state]

  if (dotOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-card', className)}>
            <span className={cn('h-2 w-2 rounded-full', look.dot, state === 'ok' && 'animate-pulse')} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{detail || look.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <span
      title={detail || look.label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] font-medium',
        look.text,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', look.dot, state === 'ok' && 'animate-pulse')} />
      {look.label}
    </span>
  )
}
