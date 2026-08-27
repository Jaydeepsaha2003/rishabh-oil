import { useEffect, useRef } from 'react'

// Polls the global DB revision; when another user (or this one) writes, the
// number changes and we re-run `reload`.
//
// The main process answers `revision()` from an in-memory cache (one shared
// background watcher hits the network), so these ticks are effectively free.
// Still: skip while the window is hidden, and never start a new reload while
// the previous one is running — a slow connection must not stack work up.
//
// A page reloads its whole dataset when this fires, which is the expensive part
// — so a run of writes must not turn into a run of reloads. Saving five things
// in half a minute changed the revision five times and reloaded five times, for
// five copies of the same data. Changes are held for a moment and merged: each
// new one restarts the wait, so a burst settles into a single reload once the
// writing stops. The page that did the writing refreshes itself directly after
// saving, so this delay is never what the user is waiting on.
const COALESCE_MS = 1500

export function useLiveRefresh(reload: () => void | Promise<void>, intervalMs = 3000): void {
  const last = useRef<number | null>(null)
  const busy = useRef(false)

  // The callback's IDENTITY must not control the timer.
  //
  // Pages are free to pass an inline arrow, which is a new function on every
  // render — and with `reload` in the effect's dependencies, every render tore
  // the effect down and rebuilt it. That cleanup cleared the pending coalescing
  // timer. Worse, the revision had already been written to `last`, so the
  // change it was waiting to reload was not merely delayed, it was lost: no
  // later tick would ever see a difference again, and the page silently stopped
  // refreshing itself for the rest of the session.
  //
  // Held in a ref instead, so the effect is built once and always calls the
  // newest closure.
  const cb = useRef(reload)
  cb.current = reload

  useEffect(() => {
    let stopped = false
    let pending: ReturnType<typeof setTimeout> | null = null
    // The revision the pending reload is FOR. It is committed to `last` only
    // once that reload has actually run, so a reload that gets skipped or
    // throws is retried on the next tick instead of being forgotten.
    let target: number | null = null

    const run = async (): Promise<void> => {
      pending = null
      if (stopped || busy.current) return
      busy.current = true
      try {
        await cb.current()
        last.current = target
      } catch {
        // leave `last` behind the target so the next tick tries again
      } finally {
        busy.current = false
      }
    }

    const tick = async (): Promise<void> => {
      // Mid-reload, this tick has nothing to add: `last` still trails the
      // revision, so the next one picks the change up.
      if (document.hidden || busy.current) return
      try {
        const rev = await window.api.revision()
        if (stopped) return
        if (last.current === null) {
          last.current = rev
        } else if (rev !== last.current) {
          target = rev
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
  }, [intervalMs])
}
