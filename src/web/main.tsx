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
