import { createContext, useContext, useEffect, useState } from 'react'

// A period picked once (Alt+F2) and broadcast to every page's own date-range
// filter. `version` bumps on every Apply (even to the same dates) so a page's
// effect fires reliably; pages ignore version 0 (nothing picked yet) and keep
// whatever default range they normally open with. `scope: 'page'` narrows
// this to one page only (named by `page`, e.g. 'stock') — every other page's
// effect checks scope and ignores it; `scope: 'all'` (the default, persisted
// across launches) is the original broadcast-to-everyone behaviour.
export interface GlobalRange {
  from: string
  to: string
  version: number
  scope: 'all' | 'page'
  page?: string
}

const RangeContext = createContext<GlobalRange>({ from: '', to: '', version: 0, scope: 'all' })
const SetterContext = createContext<(from: string, to: string, scope?: 'all' | 'page', page?: string) => void>(() => {})

export function GlobalDateRangeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [range, setRangeState] = useState<GlobalRange>({ from: '', to: '', version: 0, scope: 'all' })

  useEffect(() => {
    let active = true
    window.api.settings.all().then((all) => {
      if (!active) return
      const f = all.global_date_from || ''
      const t = all.global_date_to || ''
      if (f || t) setRangeState({ from: f, to: t, version: 1, scope: 'all' })
    })
    return () => {
      active = false
    }
  }, [])

  // A page-scoped apply is a one-off override for whichever screen is open
  // right now — it isn't remembered across launches the way the "everywhere"
  // period is, or it would quietly outlive the page it was meant for.
  function setRange(from: string, to: string, scope: 'all' | 'page' = 'all', page?: string): void {
    setRangeState((p) => ({ from, to, version: p.version + 1, scope, page }))
    if (scope === 'all') {
      void window.api.settings.set('global_date_from', from)
      void window.api.settings.set('global_date_to', to)
    }
  }

  return (
    <RangeContext.Provider value={range}>
      <SetterContext.Provider value={setRange}>{children}</SetterContext.Provider>
    </RangeContext.Provider>
  )
}

export function useGlobalDateRange(): GlobalRange {
  return useContext(RangeContext)
}

export function useSetGlobalDateRange(): (from: string, to: string, scope?: 'all' | 'page', page?: string) => void {
  return useContext(SetterContext)
}

// True when this broadcast should be adopted by a page named `pageKey` —
// either it's meant for everyone, or it's scoped to exactly this page.
export function globalRangeAppliesTo(range: GlobalRange, pageKey: string): boolean {
  return range.version > 0 && (range.scope !== 'page' || range.page === pageKey)
}
