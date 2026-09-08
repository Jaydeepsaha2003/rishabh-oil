// The web entry point for the front end.
//
// Two lines of consequence: install window.api by importing the SAME preload
// the desktop app uses (its `electron` import is aliased to our fetch shim by
// vite.web.config.ts), then hand over to the renderer's own entry, untouched.
//
// Order matters. The preload must have assigned window.api before any component
// renders, because App.tsx calls it on mount.
import '../preload/index'
import '../renderer/src/main'
import { watchForNewVersion } from './version-watch'

// A tab left open across a deploy keeps running the bundle it started with;
// this offers it a reload rather than letting it quietly show an old build.
watchForNewVersion()

// Installable web app. The worker itself caches nothing (see public/sw.js) —
// it exists so the browser offers "Install", and registering after load keeps
// it off the critical path.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unsupported or blocked worker only costs the install prompt.
    })
  })
}
