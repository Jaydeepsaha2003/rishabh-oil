import { currentRequestContext } from './requestContext'

// The user acting on THIS device, set by the renderer right after login and at
// boot. The audit trail in ipc.ts attributes every write to this user.
//
// One process, one user — true on the desktop, and the module variable below is
// the right shape for it. Under the web server it is not: many people share the
// process, so each request carries its own user and the context wins whenever
// there is one. With no context (every desktop call) this behaves exactly as it
// always did.
let current: { id: number | null; username: string } = { id: null, username: 'system' }

export function setCurrentUser(id: number | null, username: string): { ok: true } {
  const ctx = currentRequestContext()
  if (ctx) {
    ctx.userId = id ?? null
    ctx.username = username || 'system'
    return { ok: true }
  }
  current = { id: id ?? null, username: username || 'system' }
  return { ok: true }
}

export function getCurrentUser(): { id: number | null; username: string } {
  const ctx = currentRequestContext()
  if (ctx) return { id: ctx.userId, username: ctx.username }
  return current
}
