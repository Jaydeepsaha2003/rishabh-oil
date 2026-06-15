import { randomBytes, scryptSync } from 'crypto'
import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL || process.env.MAIN_VITE_TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.MAIN_VITE_TURSO_AUTH_TOKEN

const c = createClient({ url, authToken })

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

const existing = await c.execute("SELECT id FROM users WHERE username = 'admin'")
if (existing.rows.length) {
  console.log('admin already exists — nothing to do')
  process.exit(0)
}
await c.execute({
  sql: "INSERT INTO users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, 'admin', 1)",
  args: ['admin', hashPassword('admin123'), 'Rishabh Aggarwal']
})
console.log('✓ admin created — username: admin  password: admin123')
