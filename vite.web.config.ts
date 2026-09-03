import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The web build of the SAME renderer.
// ---------------------------------------------------------------------------
// electron.vite.config.ts is not touched: the desktop build keeps its own
// config, its own output and its own behaviour. This one is a plain Vite build
// of the identical sources, with `electron` aliased so the preload's
// ipcRenderer.invoke becomes an HTTP call. No renderer file is modified.
export default defineConfig({
  // Rooted at src/web so index.html lands at out/web/index.html rather than
  // out/web/src/web/index.html — the server serves the root of out/web, and a
  // nested entry would 404 on every request.
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  resolve: {
    alias: {
      // The renderer's own alias, unchanged.
      '@': resolve(__dirname, 'src/renderer/src'),
      // The whole trick, in one line.
      electron: resolve(__dirname, 'src/web/electron-shim.ts')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  },
  // The renderer and the preload live above the root, which Vite blocks in dev
  // until it is told they are wanted.
  server: {
    port: 5174,
    // The renderer and the preload live above the root, which Vite blocks in
    // dev until it is told they are wanted.
    fs: { allow: [resolve(__dirname)] },
    // In dev the front end runs on Vite and the API on the Node server, so the
    // one endpoint is proxied and the session cookie stays same-origin.
    proxy: { '/api': `http://localhost:${process.env.PORT || 3000}` }
  },
})
