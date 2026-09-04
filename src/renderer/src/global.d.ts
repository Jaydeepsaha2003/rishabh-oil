// True when this bundle was built by vite.web.config.ts (the website), false
// for electron.vite.config.ts (the desktop app). Set via each config's own
// `define` — see the comment beside each. A shared page reads this to fork
// its own rendering without forking the file (e.g. Sales.tsx's mobile view).
declare const __WEB__: boolean
