import os from 'os'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getSetting } from './repos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// This machine's LAN IPv4 (each desktop install identifies as one device).
export function machineIp(): string {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return '127.0.0.1'
}

// New devices auto-register as active; admins can deactivate them later.
export async function isIpAllowed(ip: string): Promise<boolean> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT active FROM ip_access WHERE ip = ?', args: [ip] })
  if (!res.rows.length) {
    await c.execute({
      sql: "INSERT INTO ip_access (ip, active, first_seen, last_seen) VALUES (?, 1, datetime('now'), datetime('now'))",
      args: [ip]
    })
    return true
  }
  await c.execute({ sql: "UPDATE ip_access SET last_seen = datetime('now') WHERE ip = ?", args: [ip] })
  return !!res.rows[0].active
}

export async function recordSession(userId: number, username: string, ip: string): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO sessions (user_id, username, ip, last_seen) VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_id, ip) DO UPDATE SET username = excluded.username, last_seen = datetime('now')`,
    args: [userId, username, ip]
  })
}

// The heartbeat is the one call this device already makes on a timer, so it is
// also where the signed-in user's CURRENT rights come back from. Permissions
// used to be read once at login and cached in the renderer, which meant an
// admin's change did nothing until the employee logged out and back in.
//
// `revoked` says the account is gone or switched off — the renderer signs out on
// it, the same as a device block.
export async function heartbeat(
  userId: number,
  username: string
): Promise<{
  blocked: boolean
  revoked?: boolean
  role?: string
  full_name?: string
  permissions?: unknown
}> {
  const ip = machineIp()
  const allowed = await isIpAllowed(ip)
  if (!allowed) return { blocked: true }
  await recordSession(userId, username, ip)
  const res = await getClient().execute({
    sql: 'SELECT role, full_name, permissions, active FROM users WHERE id = ? LIMIT 1',
    args: [userId]
  })
  if (!res.rows.length) return { blocked: false, revoked: true }
  const r = res.rows[0] as Row
  if (Number(r.active) === 0) return { blocked: false, revoked: true }
  let permissions: unknown = {}
  try {
    permissions = r.permissions ? JSON.parse(String(r.permissions)) : {}
  } catch {
    permissions = {}
  }
  return {
    blocked: false,
    role: String(r.role || ''),
    full_name: String(r.full_name || ''),
    permissions
  }
}

// Sessions seen in the last 90 seconds are considered live.
export async function liveUsers(): Promise<Row[]> {
  const res = await getClient().execute(
    "SELECT * FROM sessions WHERE last_seen >= datetime('now', '-90 seconds') ORDER BY last_seen DESC"
  )
  return toPlain(res)
}

export async function listIps(): Promise<Row[]> {
  return toPlain(await getClient().execute('SELECT * FROM ip_access ORDER BY last_seen DESC'))
}

export async function setIpActive(id: number, active: boolean): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE ip_access SET active = ? WHERE id = ?',
    args: [active ? 1 : 0, id]
  })
  return { id }
}

export async function logEvent(
  userId: number | null,
  username: string,
  ip: string,
  action: string,
  detail?: string | null,
  companyId?: number | null,
  entity?: string | null,
  entityId?: number | null
): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO user_logs (user_id, username, ip, action, detail, company_id, entity, entity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [userId, username, ip, action, detail || null, companyId ?? null, entity || null, entityId ?? null]
  })
}

export interface LogFilter {
  username?: string | string[]
  entity?: string | string[]
  action?: string
  from?: string
  to?: string
  q?: string
  limit?: number
}

// Activity log with optional filters (newest first). Also returns the distinct
// users/sections present, so the UI can populate its filter dropdowns.
export async function listLogs(
  filter: LogFilter = {}
): Promise<{ rows: Row[]; users: string[]; entities: string[] }> {
  const where: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any[] = []
  if (filter.username) {
    const usernames = (Array.isArray(filter.username) ? filter.username : [filter.username]).filter(Boolean)
    if (usernames.length) { where.push(`username IN (${usernames.map(() => '?').join(',')})`); args.push(...usernames) }
  }
  if (filter.entity) {
    const entities = (Array.isArray(filter.entity) ? filter.entity : [filter.entity]).filter(Boolean)
    if (entities.length) { where.push(`entity IN (${entities.map(() => '?').join(',')})`); args.push(...entities) }
  }
  if (filter.action) { where.push('action = ?'); args.push(filter.action) }
  if (filter.from) { where.push('created_at >= ?'); args.push(filter.from) }
  if (filter.to) { where.push('created_at <= ?'); args.push(`${filter.to} 23:59:59`) }
  if (filter.q) {
    where.push('(detail LIKE ? OR entity LIKE ? OR action LIKE ? OR username LIKE ?)')
    const like = `%${filter.q}%`
    args.push(like, like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  args.push(Math.min(Math.max(Number(filter.limit) || 500, 1), 2000))
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT * FROM user_logs ${whereSql} ORDER BY id DESC LIMIT ?`,
      args
    })
  )
  const u = toPlain(await getClient().execute('SELECT DISTINCT username FROM user_logs WHERE username IS NOT NULL ORDER BY username'))
  const en = toPlain(await getClient().execute("SELECT DISTINCT entity FROM user_logs WHERE entity IS NOT NULL AND entity != '' ORDER BY entity"))
  return {
    rows,
    users: u.map((r) => String(r.username)),
    entities: en.map((r) => String(r.entity))
  }
}

// Delete logs older than the configured retention (default 30 days).
export async function cleanupLogs(): Promise<void> {
  const days = Number((await getSetting('log_retention_days')) ?? '30') || 30
  await getClient().execute({
    sql: `DELETE FROM user_logs WHERE created_at < datetime('now', '-' || ? || ' days')`,
    args: [days]
  })
}
