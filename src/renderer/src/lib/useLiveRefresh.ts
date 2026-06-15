import { useEffect, useRef } from 'react'

// Polls the global DB revision; when another user (or this one) writes, the
// number changes and we re-run `reload`. `reload` should be a stable useCallback.
export function useLiveRefresh(reload: () => void, intervalMs = 3000): void {
  const last = useRef<number | null>(null)

  useEffect(() => {
    let stopped = false

    const tick = async (): Promise<void> => {
      try {
        const rev = await window.api.revision()
        if (stopped) return
        if (last.current === null) {
          last.current = rev
        } else if (rev !== last.current) {
          last.current = rev
          reload()
        }
      } catch {
        // ignore transient connection errors; next tick retries
      }
    }

    const id = setInterval(tick, intervalMs)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [reload, intervalMs])
}
