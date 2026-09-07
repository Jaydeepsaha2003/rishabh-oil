import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

// "A newer version of this site is live — reload."
//
// Website only. The desktop app has electron-updater and UpdateBadge for the
// same job; a browser tab has nothing, so it can sit for days on a bundle that
// was replaced hours ago, and the bug report that follows is always about
// behaviour that was already fixed.
//
// How it knows, without a version endpoint to keep in step: the built client is
// one hashed file, `/assets/index-<hash>.js`, and its hash changes on every
// deploy that changes the front end. So the tab compares the script IT is
// running against the one index.html is currently handing out. No build
// constant to remember to bump, and nothing to get out of sync — the thing
// being compared is the artefact itself.
//
// Nothing to dismiss: reloading replaces the bundle, the two names agree again,
// and the chip is gone on its own.

const ASSET = /\/assets\/index-[A-Za-z0-9_.-]+\.js/

// The entry script of the running page, as index.html named it. Absent under
// `vite dev` (modules are served unhashed from /src), which is exactly when
// this check should do nothing.
function ownScript(): string | null {
  const tags = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
  for (const t of tags) {
    const m = ASSET.exec(t.getAttribute('src') || '')
    if (m) return m[0]
  }
  return null
}

// index.html as the server would serve it now. `no-store` plus a cache-buster
// because the whole point is to bypass whatever the browser is holding.
async function liveScript(): Promise<string | null> {
  const res = await fetch(`/?_v=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' })
  if (!res.ok) return null
  const m = ASSET.exec(await res.text())
  return m ? m[0] : null
}

const HOTKEY = /mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd+Shift+R' : 'Ctrl+Shift+R'

export function LiveVersionBadge({ className }: { className?: string }): React.JSX.Element | null {
  const [stale, setStale] = useState(false)

  const check = useCallback(async (): Promise<void> => {
    const own = ownScript()
    if (!own) return
    const live = await liveScript().catch(() => null)
    // A failed or unrecognisable response says nothing about the version. Only
    // a name we can read AND that differs is evidence.
    if (live && live !== own) setStale(true)
  }, [])

  useEffect(() => {
    if (!__WEB__ || stale) return
    // Not on mount: the tab has just loaded the current bundle, so the first
    // useful moment to ask is a couple of minutes in.
    const t = window.setInterval(() => void check(), 120_000)
    // And whenever the tab is looked at again — someone coming back to a
    // window left open overnight is the case this exists for.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check, stale])

  if (!__WEB__ || !stale) return null
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      title={`A newer version of this site is live. Press ${HOTKEY} for a hard reload, or click here.`}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-[4px] border border-[#E2A84A] bg-[#FFFBF2] px-3 text-[12.5px] font-extrabold text-[#8A5300] transition-colors motion-safe:animate-pulse hover:!bg-[#FFF4E0]',
        className
      )}
    >
      {/* The dot blinks on its own beat — the chip fades, the dot cuts in and
          out, so it reads as an alert rather than a decoration. Both are
          motion-safe: someone who has asked their system for less movement
          gets the amber chip and no animation, which still says everything. */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[#C2700A] opacity-75 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#C2700A]" />
      </span>
      <RefreshCw className="h-3.5 w-3.5 shrink-0" />
      New version live — press {HOTKEY}
    </button>
  )
}
