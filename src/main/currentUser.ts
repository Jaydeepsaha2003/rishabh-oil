// The user acting on THIS device, set by the renderer right after login and at
// boot. The audit trail in ipc.ts attributes every write to this user.
let current: { id: number | null; username: string } = { id: null, username: 'system' }

export function setCurrentUser(id: number | null, username: string): { ok: true } {
  current = { id: id ?? null, username: username || 'system' }
  return { ok: true }
}

export function getCurrentUser(): { id: number | null; username: string } {
  return current
}
