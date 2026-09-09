// First, before anything under src/main is required — see tz.ts.
import { serverClock } from './tz'
import { join } from 'node:path'
import { getClient } from '../main/db'
import { runStartupTasks } from '../main/bootstrap'
import { registerIpc } from '../main/ipc'
import { startHttpServer } from './http'
import { applyFilePragmas, livePath } from './dbrestore'

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

  // In the log on purpose: a gate time that looks wrong is the first sign the
  // host has been moved, and this line answers it without a code read.
  console.log(`[web] clock ${serverClock()}`)
  console.log('[web] connecting to the database…')
  await runStartupTasks()
  console.log('[web] schema ready')

  // A local SQLite file needs settings a cloud database does not, and they are
  // per-CONNECTION rather than stored in the file — so they are applied here on
  // every start, and again by dbrestore.ts after it swaps the file. The list
  // itself lives there so the two can never disagree.
  //
  // Only for a file: URL. Against Turso these are meaningless, and issuing them
  // would be noise in the log of a perfectly healthy cloud connection.
  const live = livePath()
  if (live) {
    await applyFilePragmas(getClient())
    console.log(`[web] local SQLite at ${live}: WAL, busy_timeout 5s, foreign keys on`)
  }

  registerIpc()
  startHttpServer({ port, webRoot })
}

main().catch((e) => {
  console.error('[web] failed to start:', e)
  process.exit(1)
})
