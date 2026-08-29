import { useEffect, useState } from 'react'

// The earliest date a page's forms may offer the signed-in user, per module.
//
// This is a COURTESY, not the control. The main process refuses an out-of-window
// save whatever the form sends, so a page that forgets to pass this still cannot
// be used to backdate — the user just meets the refusal a moment later instead
// of seeing the day greyed out in the calendar. Wire it wherever a user picks
// the business date of a new entry.
//
// Fetched once per session and shared: the window is a per-user setting that
// only moves at midnight, so re-asking on every mount would be one request per
// page load for an answer that does not change.
let cached: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

// The Users page saves a change -> the next reader asks again.
export function clearEntryWindows(): void {
  cached = null
  inflight = null
}

function fetchWindows(): Promise<Record<string, string>> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = window.api.access
      .entryWindows()
      .then((w) => {
        cached = w || {}
        return cached
      })
      .catch(() => {
        // Never let this break a form. No answer means no restriction shown;
        // the server still holds the line.
        inflight = null
        return {}
      })
  }
  return inflight
}

// The minimum date for one module, or undefined for no limit. Pass straight to
// <DatePicker min={...}>.
export function useEntryWindow(moduleKey: string): string | undefined {
  const [windows, setWindows] = useState<Record<string, string>>(cached || {})
  useEffect(() => {
    let alive = true
    void fetchWindows().then((w) => {
      if (alive) setWindows(w)
    })
    return () => {
      alive = false
    }
  }, [])
  return windows[moduleKey] || undefined
}
