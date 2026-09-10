// Who may open the phone's menu.
// -----------------------------------------------------------------------------
// The mobile sidebar used to own its own trigger: a button fixed at left-3
// top-3, floating over whatever the page had drawn. Every mobile page since
// then puts a forest header at the very top of the screen, so the button sat on
// top of the page title — which is why the title had to be nudged and why there
// was nowhere to put anything else up there.
//
// So the open/closed state moves out here, and the trigger moves INTO the page's
// own top bar (see components/MobileBar). The sidebar renders the overlay; the
// page renders the button. Nothing floats over anything.
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

type Ctx = {
  open: boolean
  setOpen: (v: boolean) => void
  // Whether the page on screen is drawing its own MobileBar. The sidebar falls
  // back to a floating trigger when nothing else offers one — every page
  // without a mobile fork still renders its desktop layout at phone width, and
  // taking the button away from those would leave no way to the menu at all.
  hasBar: boolean
  registerBar: () => () => void
}

// Defaults to a no-op rather than throwing. A page rendered outside the
// provider — a test, a storybook — should draw its bar and do nothing when the
// button is pressed, not blow up.
const MobileMenuCtx = createContext<Ctx>({
  open: false,
  setOpen: () => {},
  hasBar: false,
  registerBar: () => () => {}
})

export function MobileMenuProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // A count rather than a flag: React mounts the next page before unmounting
  // the last on some transitions, and a flag would be left false by the
  // outgoing bar's cleanup running after the incoming one's effect.
  const [bars, setBars] = useState(0)
  const registerBar = useCallback((): (() => void) => {
    setBars((n) => n + 1)
    return () => setBars((n) => Math.max(0, n - 1))
  }, [])
  const value = useMemo(() => ({ open, setOpen, hasBar: bars > 0, registerBar }), [open, bars, registerBar])
  return <MobileMenuCtx.Provider value={value}>{children}</MobileMenuCtx.Provider>
}

export function useMobileMenu(): Ctx {
  return useContext(MobileMenuCtx)
}
