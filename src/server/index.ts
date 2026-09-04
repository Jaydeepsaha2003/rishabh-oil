import { join } from 'node:path'
import { getClient } from '../main/db'
import { runStartupTasks } from '../main/bootstrap'
import { registerIpc } from '../main/ipc'
import { startHttpServer } from './http'

// The web entry point.
//
// It does three things and no more: connect to the database, let ipc.ts
// register its channels (into the shim's Map rather than Electron's), and open
// an HTTP port. Every rule, every query and every permission check is reached
// through those channels, which is why none of it is repeated here.
//
// runStartupTasks() (src/main/bootstrap.ts) is the exact same call the desktop
// makes from app.whenReady() — same schema, same runOnce migrations, same
// backfills. Sharing it rather than skipping it here is what lets a database
// this server opens for the first time build itself from nothing (a freshly
// uploaded, empty SQLite file), and one it has opened before pick up whatever
// changed since, with no separate "web" migration path to fall out of step.
async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 3000
  // Hostinger runs the built app from the project root, so the compiled front
  // end sits beside the compiled server.
  const webRoot = process.env.WEB_ROOT || join(process.cwd(), 'out', 'web')

  console.log('[web] connecting to the database…')
  await runStartupTasks()
  console.log('[web] schema ready')

  // A local SQLite file needs two things a cloud database does not, and both are
  // per-CONNECTION rather than stored in the file, so they are set here on every
  // start rather than once by the seeding script.
  //
  // Only for a file: URL. Against Turso these are meaningless, and issuing them
  // would be noise in the log of a perfectly healthy cloud connection.
  const url = String(
    process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || ''
  )
  if (url.startsWith('file:')) {
    const c = getClient()
    // SQLite serialises writers. Without a timeout a second writer fails
    // instantly with SQLITE_BUSY; with one it waits its turn, which for writes
    // measured in milliseconds is indistinguishable from not colliding at all.
    await c.execute('PRAGMA busy_timeout = 5000').catch(() => {})
    // WAL is already stored in the file by the seeding script; asserted here so
    // a hand-made database is not silently left in rollback-journal mode, where
    // a reader blocks every writer.
    await c.execute('PRAGMA journal_mode = WAL').catch(() => {})
    // Durable enough for WAL: the OS still flushes, we just do not fsync on
    // every commit. The failure mode is losing the last transaction on a power
    // cut, not a corrupt file.
    await c.execute('PRAGMA synchronous = NORMAL').catch(() => {})
    // Foreign keys are declared throughout the schema but SQLite ignores them
    // unless asked, per connection.
    await c.execute('PRAGMA foreign_keys = ON').catch(() => {})
    console.log('[web] local SQLite: WAL, busy_timeout 5s, foreign keys on')
  }

  registerIpc()
  startHttpServer({ port, webRoot })
}

main().catch((e) => {
  console.error('[web] failed to start:', e)
  process.exit(1)
})
