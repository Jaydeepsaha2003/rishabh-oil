import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import App from './App'
import './assets/main.css'
import { TooltipProvider } from './components/ui/tooltip'
import { dropReloadStamp } from './lib/freshReload'

// A "Reload onto the new build" arrives with a cache-busting stamp on the
// address; take it off before anything reads the address (see freshReload).
if (__WEB__) dropReloadStamp()

// A number field must not change because something brushed past it.
//
// Every quantity on this app posts something real — stock out of a tank, a
// rupee figure on an invoice — and a <input type="number"> will happily
// increment on Arrow Up/Down or on the scroll wheel. Both are silent: the
// figure moves, nothing says so, and the next save writes it. main.css
// already hides the spinner buttons; these are the two ways left in.
//
// Registered once here rather than on each of the hundreds of number inputs
// in the app, in the CAPTURE phase so it lands before React's own handler on
// the field.
if (__WEB__) {
  const isNumberField = (t: EventTarget | null): t is HTMLInputElement =>
    t instanceof HTMLInputElement && t.type === 'number'

  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && isNumberField(e.target)) e.preventDefault()
    },
    true
  )

  // Only while the field holds focus — that is the only time a browser
  // changes the value on wheel, and it keeps the page scrolling normally when
  // the pointer merely passes over an idle input.
  //
  // ON THE FIELD, NOT ON THE DOCUMENT. This used to be one non-passive wheel
  // listener on the whole document, and a non-passive listener there makes
  // the browser wait for script before it may start ANY wheel scroll, on any
  // page — so a long register like Treasury stuttered under the wheel every
  // time the page had work in hand (a live refresh, a list re-drawing). Hung
  // on the focused field instead, only a wheel over that one box waits; the
  // rest of the page scrolls on the compositor as it should.
  const stopWheel = (e: WheelEvent): void => e.preventDefault()
  document.addEventListener('focusin', (e) => {
    if (isNumberField(e.target)) e.target.addEventListener('wheel', stopWheel, { passive: false })
  })
  document.addEventListener('focusout', (e) => {
    if (isNumberField(e.target)) e.target.removeEventListener('wheel', stopWheel)
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={200}>
      <App />
    </TooltipProvider>
  </React.StrictMode>
)
