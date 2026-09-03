import { AsyncLocalStorage } from 'node:async_hooks'

// Who is asking, and on whose books.
//
// On the desktop there is one user and one active company per process, so
// currentUser.ts and company.ts hold them in a module variable and that is
// correct: the process IS the session.
//
// A web server is the opposite. Dozens of people share one process, and a
// module variable would mean one person's company switch changed what everyone
// else was looking at — and, worse, whose name the audit trail recorded. So
// each HTTP request runs inside a context carrying its own user and company,
// and the two modules above read from here when a context exists.
//
// Deliberately a Node builtin and nothing else. It lives under src/main so the
// business modules can read it without importing anything from src/server, and
// AsyncLocalStorage is present in Electron's main process too — so the desktop
// build carries this file and simply never opens a context, falling through to
// the module variable exactly as before.
export interface RequestContext {
  userId: number | null
  username: string
  companyId: number
  ip?: string
}

const store = new AsyncLocalStorage<RequestContext>()

export function runInRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn)
}

export function currentRequestContext(): RequestContext | undefined {
  return store.getStore()
}
