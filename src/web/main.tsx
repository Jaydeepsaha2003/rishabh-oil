// The web entry point for the front end.
//
// Two lines of consequence: install window.api by importing the SAME preload
// the desktop app uses (its `electron` import is aliased to our fetch shim by
// vite.web.config.ts), then hand over to the renderer's own entry, untouched.
//
// Order matters. The preload must have assigned window.api before any component
// renders, because App.tsx calls it on mount.
import '../preload/index'
// Only the website's mobile Sales view uses Manrope / IBM Plex Mono — loaded
// here rather than in the shared renderer entry so the desktop bundle never
// pulls in a font weight it doesn't use.
import '@fontsource-variable/manrope'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-mono/700.css'
import '../renderer/src/main'
