import { useEffect, useState } from 'react'

// The earliest date a page's forms may offer the signed-in user, per module.
//
// This is a COURTESY, not the control. The main process refuses an out-of-window
// save whatever the form sends, so a page that forgets to pass this still cannot
// be used to backdate — the user just meets the refusal a moment later instead
// of seeing the day greyed out in the calendar.
//
// Shared and LIVE. Shared because the window is a per-user setting, so asking
// once and handing the answer to every form is right. Live because an admin
// changing it must reach the person it applies to without them logging out:
// the presence heartbeat already brings fresh permissions back every few
// seconds, and calling clearEntryWindows() from there makes every mounted date
// picker re-ask. Cached-once-per-session meant a window widened at 10am did
// nothing until the clerk restarted the app.
let cached: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

// Mounted hooks, so a change reaches the forms already on screen rather than
// only the next one opened.
const listeners = new Set<(w: Record<string, string>) => void>()

// Called when the permissions behind these windows have changed. Re-asks at
// once and pushes the answer to every form currently showing a date picker.
export function clearEntryWindows(): void {
  cached = null
  inflight = null
  if (!listeners.size) return
  void fetchWindows().then((w) => {
    for (const fn of listeners) fn(w)
  })
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
    const onChange = (w: Record<string, string>): void => {
      if (alive) setWindows(w)
    }
    listeners.add(onChange)
    void fetchWindows().then(onChange)
    return () => {
      alive = false
      listeners.delete(onChange)
    }
  }, [])
  return windows[moduleKey] || undefined
}
