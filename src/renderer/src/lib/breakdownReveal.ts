import { useEffect, useState } from 'react'

// LINE BREAKDOWNS ARE HIDDEN UNTIL ASKED FOR.
//
// The working written under a voucher line ("break this figure down") is for
// the person who keeps it, not for whoever is looking at the screen. It stays
// out of sight — the link under a line, the parts it was saved with, and the
// Cashflow register built from them — until Ctrl + Alt + B is pressed, and
// goes again on the same keys. It is held in memory only, so a reload or a
// new sign-in always starts hidden.
//
// This is out of sight, not secured: the breakdown is still saved with the
// voucher, and anyone who knows the keys can show it.
let shown = false
const subs = new Set<(v: boolean) => void>()
let installed = false

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener(
    'keydown',
    (e) => {
      // By the key's position, so a keyboard layout that turns Ctrl+Alt into
      // AltGr still answers.
      if (!(e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyB')) return
      e.preventDefault()
      // Nothing else on the page sees it — plain B opens Opening balances.
      e.stopImmediatePropagation()
      shown = !shown
      for (const f of subs) f(shown)
    },
    true
  )
}

/** Whether line breakdowns are on screen; flips on Ctrl + Alt + B. */
export function useBreakdownShown(): boolean {
  const [v, setV] = useState(shown)
  useEffect(() => {
    install()
    subs.add(setV)
    setV(shown)
    return () => {
      subs.delete(setV)
    }
  }, [])
  return v
}
