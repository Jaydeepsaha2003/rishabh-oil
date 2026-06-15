import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { InValue, ResultSet } from '@libsql/client'
import { getClient } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// scrypt via Node's built-in crypto — no native module, packages cleanly on all platforms.
function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = (stored || '').split(':')
  if (!salt || !hash) return false
  const computed = scryptSync(pw, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return expected.length === computed.length && timingSafeEqual(computed, expected)
}

// First run: create the admin (Rishabh Aggarwal). Default login admin / admin123.
export async function seedDefaultAdmin(): Promise<void> {
  const c = getClient()
  const res = await c.execute('SELECT COUNT(*) AS n FROM users')
  if (Number(res.rows[0].n) > 0) return
  await c.execute({
    sql: "INSERT INTO users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, 'admin', 1)",
    args: ['admin', hashPassword('admin123'), 'Rishabh Aggarwal']
  })
  console.log('[auth] seeded default admin (admin / admin123)')
}

export async function login(username: string, password: string): Promise<Row> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM users WHERE username = ? AND active = 1 LIMIT 1',
    args: [username]
  })
  if (!res.rows.length) throw new Error('Invalid username or password')
  const u = toPlain(res)[0]
  if (!verifyPassword(password, String(u.password_hash))) {
    throw new Error('Invalid username or password')
  }
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    permissions: parsePermissions(u.permissions)
  }
}

function parsePermissions(value: unknown): string[] {
  if (!value) return []
  try {
    const arr = JSON.parse(String(value))
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

export async function listUsers(): Promise<Row[]> {
  const res = await getClient().execute(
    'SELECT id, username, full_name, role, active, permissions, created_at FROM users ORDER BY id ASC'
  )
  return toPlain(res)
}

export async function createUser(v: Row): Promise<{ id: number }> {
  if (!v.username) throw new Error('Username is required')
  if (!v.password) throw new Error('Password is required')
  const args: InValue[] = [
    v.username,
    hashPassword(String(v.password)),
    v.full_name || null,
    v.role || 'viewer',
    v.active ? 1 : 0,
    JSON.stringify(Array.isArray(v.permissions) ? v.permissions : [])
  ]
  try {
    const res = await getClient().execute({
      sql: 'INSERT INTO users (username, password_hash, full_name, role, active, permissions) VALUES (?, ?, ?, ?, ?, ?)',
      args
    })
    return { id: Number(res.lastInsertRowid) }
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) throw new Error('Username already exists')
    throw e
  }
}

export async function updateUser(id: number, v: Row): Promise<{ id: number }> {
  const sets = ['full_name = ?', 'role = ?', 'active = ?', 'permissions = ?']
  const args: InValue[] = [
    v.full_name || null,
    v.role || 'viewer',
    v.active ? 1 : 0,
    JSON.stringify(Array.isArray(v.permissions) ? v.permissions : [])
  ]
  if (v.password) {
    sets.push('password_hash = ?')
    args.push(hashPassword(String(v.password)))
  }
  args.push(id)
  await getClient().execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args })
  return { id }
}

export async function deleteUser(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] })
  return { id }
}
