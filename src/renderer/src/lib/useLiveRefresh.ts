import { useEffect, useRef } from 'react'

// Polls the global DB revision; when another user (or this one) writes, the
// number changes and we re-run `reload`. `reload` should be a stable useCallback.
//
// The main process answers `revision()` from an in-memory cache (one shared
// background watcher hits the network), so these ticks are effectively free.
// Still: skip while the window is hidden, and never start a new reload while
// the previous one is running — a slow connection must not stack work up.
export function useLiveRefresh(reload: () => void | Promise<void>, intervalMs = 3000): void {
  const last = useRef<number | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    let stopped = false

    const tick = async (): Promise<void> => {
      if (document.hidden || busy.current) return
      try {
        const rev = await window.api.revision()
        if (stopped) return
        if (last.current === null) {
          last.current = rev
        } else if (rev !== last.current) {
          last.current = rev
          busy.current = true
          try {
            await reload()
          } finally {
            busy.current = false
          }
        }
      } catch {
        // ignore transient connection errors; next tick retries
        busy.current = false
      }
    }

    const id = setInterval(tick, intervalMs)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [reload, intervalMs])
}
