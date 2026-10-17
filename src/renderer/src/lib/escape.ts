import { useEffect, type RefObject } from 'react'
import { toast } from 'sonner'

// An overlay on its way out still sits in the page, marked data-state="closed",
// until its closing animation ends — and where that animation never runs (a
// background tab, reduced motion) it can sit there indefinitely. It is not
// open, so it must not hold the keyboard.
export const OVERLAY_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]),[role="alertdialog"]:not([data-state="closed"]),[data-escape-layer]:not([data-state="closed"])'

export function hasOpenOverlay(): boolean {
  return !!document.querySelector(OVERLAY_SELECTOR)
}

// ESC CLOSES A DIALOG — deliberately, and one layer at a time.
//
// The shared DialogContent refuses Escape unless it is read-only, so a
// half-filled form is never lost to a stray key. The price was that Esc did
// nothing at all in a dialog — not in a "Discard this draft?" question, not in
// a five-letter "Create ledger" box — and the page underneath stood aside too,
// so the key simply died. Pass this as onEscapeKeyDown to give a dialog back
// its Esc:
//
//   - nothing typed: Esc closes it, as Cancel would;
//   - something typed: the first Esc says so and the SECOND discards, so a
//     slip costs nothing and a deliberate double-tap still works;
//   - a dropdown open inside the dialog closes first and the dialog stays.
//
// The Esc that closes the dialog is spent on it: it does not also reach the
// page, which would otherwise take it as "leave this screen".
let armedAt = 0
/** The double-Esc rule on its own: true when this Esc may close — at once if
 *  nothing is typed, else only on the second press within a couple of seconds. */
export function escMayDiscard(dirty: boolean): boolean {
  if (dirty && Date.now() - armedAt > 2500) {
    armedAt = Date.now()
    toast('Press Esc again to discard what you typed')
    return false
  }
  armedAt = 0
  return true
}
export function escToClose(dirty = false): (e: KeyboardEvent) => void {
  return (e) => {
    // A dialog that has already CLOSED, and is only still in the page while it
    // fades out, does not own the key: with no open window at all, Esc is the
    // page's — "go back", after Open LC / Open BD from a voucher.
    if (!document.querySelector(OVERLAY_SELECTOR)) return
    if (document.querySelector('[data-escape-layer="select"]:not([data-state="closed"])')) {
      e.preventDefault()
      return
    }
    if (!escMayDiscard(dirty)) {
      e.preventDefault()
      return
    }
    e.stopPropagation()
  }
}

/** A custom drawer only owns Escape when it is the top visible overlay.
 *  `close` may return false to say it stayed open (a first Esc on typed work),
 *  in which case focus stays inside the drawer too. */
export function useDrawerEscape(open: boolean, ref: RefObject<HTMLElement>, close: () => void | boolean): void {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const layers = Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))
        .filter((el) => el.getClientRects().length)
      const top = layers[layers.length - 1]
      if (!ref.current || top !== ref.current) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (close() === false) return
      requestAnimationFrame(() => { if (previous?.isConnected) previous.focus() })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, ref, close])
}
