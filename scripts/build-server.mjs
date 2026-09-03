// Bundles the web server: src/server/index.ts plus everything it pulls in from
// src/main, with `electron` aliased to the shim.
//
// A script rather than a shell one-liner because the esbuild binary path is
// platform-specific, and this has to build the same on a Windows desktop as on
// Hostinger's Linux box.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [resolve(root, 'src/server/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: resolve(root, 'out/server/index.cjs'),
  alias: {
    // The one substitution the whole migration rests on. See the shim's note.
    electron: resolve(root, 'src/server/electron-shim.ts'),
    // Turso on the desktop, a local SQLite file on the website.
    //
    // db.ts imports '@libsql/client/web' deliberately: that is the HTTP-only
    // build, and importing the default one made fresh machines crash on a
    // native .node addon they did not have. A server has no such problem, and
    // the default build is the one that speaks `file:` URLs.
    //
    // Same client API either way — same execute, same batch, same row and
    // column shapes — so not one query, table or column changes. Which URL is
    // used is then purely a matter of the environment: a libsql:// URL for
    // Turso, file:./data/rishabh.db for SQLite.
    '@libsql/client/web': '@libsql/client'
  },
  // electron-vite injects import.meta.env at build time; plain Node has no such
  // thing, and esbuild would substitute an empty object — so `import.meta.env
  // .MAIN_VITE_TURSO_DATABASE_URL` would throw rather than fall through. Every
  // read in db.ts already has a process.env fallback with the same name, so
  // pointing the whole expression there resolves it correctly and changes
  // nothing about the desktop build, which never runs this script.
  define: { 'import.meta.env': 'process.env' },
  // Left external so the installed package is used at runtime rather than
  // inlined — it resolves its own platform bits.
  external: ['@libsql/client', 'exceljs'],
  logLevel: 'warning'
})

console.log('[build] out/server/index.cjs')
