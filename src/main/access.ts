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

export async function heartbeat(userId: number, username: string): Promise<{ blocked: boolean }> {
  const ip = machineIp()
  const allowed = await isIpAllowed(ip)
  if (!allowed) return { blocked: true }
  await recordSession(userId, username, ip)
  return { blocked: false }
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
  detail?: string
): Promise<void> {
  await getClient().execute({
    sql: 'INSERT INTO user_logs (user_id, username, ip, action, detail) VALUES (?, ?, ?, ?, ?)',
    args: [userId, username, ip, action, detail || null]
  })
}

export async function listLogs(limit = 300): Promise<Row[]> {
  return toPlain(
    await getClient().execute({
      sql: 'SELECT * FROM user_logs ORDER BY id DESC LIMIT ?',
      args: [limit]
    })
  )
}

// Delete logs older than the configured retention (default 30 days).
export async function cleanupLogs(): Promise<void> {
  const days = Number((await getSetting('log_retention_days')) ?? '30') || 30
  await getClient().execute({
    sql: `DELETE FROM user_logs WHERE created_at < datetime('now', '-' || ? || ' days')`,
    args: [days]
  })
}
