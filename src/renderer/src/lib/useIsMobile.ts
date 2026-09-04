import { useEffect, useState } from 'react'

// Phone-width breakpoint for the web build's mobile layouts. Only meaningful
// on the website: the desktop app's window is always maximized well above
// this width, so gating a mobile view on __WEB__ as well (not done here —
// callers do it) is what actually keeps it off the desktop app, not this
// number. 767px matches Tailwind's own `sm` breakpoint (max-width: 767.98px)
// so it agrees with any `sm:` classes already used nearby.
const MOBILE_BREAKPOINT = 768

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
  )

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = (): void => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
