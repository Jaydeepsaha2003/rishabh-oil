import { useEffect, useRef } from 'react'

// Polls the global DB revision; when another user (or this one) writes, the
// number changes and we re-run `reload`. `reload` should be a stable useCallback.
//
// The main process answers `revision()` from an in-memory cache (one shared
// background watcher hits the network), so these ticks are effectively free.
// Still: skip while the window is hidden, and never start a new reload while
// the previous one is running — a slow connection must not stack work up.
// A page reloads its whole dataset when this fires, which is the expensive part
// — so a run of writes must not turn into a run of reloads. Saving five things
// in half a minute changed the revision five times and reloaded five times, for
// five copies of the same data. Changes are now held for a moment and merged:
// each new one restarts the wait, so a burst settles into a single reload once
// the writing stops. The page that did the writing refreshes itself directly
// after saving, so this delay is never what the user is waiting on.
const COALESCE_MS = 1500

export function useLiveRefresh(reload: () => void | Promise<void>, intervalMs = 3000): void {
  const last = useRef<number | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    let stopped = false
    let pending: ReturnType<typeof setTimeout> | null = null

    const run = async (): Promise<void> => {
      pending = null
      if (stopped || busy.current) return
      busy.current = true
      try {
        await reload()
      } finally {
        busy.current = false
      }
    }

    const tick = async (): Promise<void> => {
      if (document.hidden || busy.current) return
      try {
        const rev = await window.api.revision()
        if (stopped) return
        if (last.current === null) {
          last.current = rev
        } else if (rev !== last.current) {
          last.current = rev
          // Restart the wait, so a burst of writes collapses into one reload
          // rather than one per write.
          if (pending) clearTimeout(pending)
          pending = setTimeout(() => void run(), COALESCE_MS)
        }
      } catch {
        // ignore transient connection errors; next tick retries
        busy.current = false
      }
    }

    const id = setInterval(tick, intervalMs)
    return () => {
      stopped = true
      if (pending) clearTimeout(pending)
      clearInterval(id)
    }
  }, [reload, intervalMs])
}
