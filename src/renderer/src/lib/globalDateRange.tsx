import { createContext, useContext, useEffect, useState } from 'react'

// A period picked once (Alt+F2) and broadcast to every page's own date-range
// filter. `version` bumps on every Apply (even to the same dates) so a page's
// effect fires reliably; pages ignore version 0 (nothing picked yet) and keep
// whatever default range they normally open with.
export interface GlobalRange {
  from: string
  to: string
  version: number
}

const RangeContext = createContext<GlobalRange>({ from: '', to: '', version: 0 })
const SetterContext = createContext<(from: string, to: string) => void>(() => {})

export function GlobalDateRangeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [range, setRangeState] = useState<GlobalRange>({ from: '', to: '', version: 0 })

  useEffect(() => {
    let active = true
    window.api.settings.all().then((all) => {
      if (!active) return
      const f = all.global_date_from || ''
      const t = all.global_date_to || ''
      if (f || t) setRangeState({ from: f, to: t, version: 1 })
    })
    return () => {
      active = false
    }
  }, [])

  function setRange(from: string, to: string): void {
    setRangeState((p) => ({ from, to, version: p.version + 1 }))
    void window.api.settings.set('global_date_from', from)
    void window.api.settings.set('global_date_to', to)
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

export function useSetGlobalDateRange(): (from: string, to: string) => void {
  return useContext(SetterContext)
}
