// Startup file for Hostinger (or any Node host).
//
// Hostinger's Node.js setup asks for one entry file and runs it with plain
// `node`, with no room for flags — so this is that file. It carries no logic of
// its own: it checks the app has been built and hands over to the bundle.
//
// There is no --env-file flag because none is needed. src/main/db.ts calls
// process.loadEnvFile() itself, so a .env in the working directory is picked up,
// and variables already set in hPanel take precedence over it.
// FEWER THREADS PER COPY. The host counts every thread as a process (limit
// 120), and LiteSpeed runs several copies of this app under load. libuv's pool
// defaults to 4 threads; this app does little file or DNS work, so 2 is plenty.
// Must be set before anything touches the pool, i.e. here, first.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '2'

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const bundle = join(__dirname, 'out', 'server', 'index.cjs')

if (!existsSync(bundle)) {
  // out/ is build output and deliberately not in the repository, so a fresh
  // clone reaches this. Said plainly, because "Cannot find module" on a hosting
  // panel with no stack trace is a bad half-hour.
  console.error(
    [
      '',
      'The app has not been built yet.',
      '',
      '  npm install',
      '  npm run web:build',
      '',
      `Expected: ${bundle}`,
      ''
    ].join('\n')
  )
  process.exit(1)
}

require(bundle)
