import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL || process.env.MAIN_VITE_TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.MAIN_VITE_TURSO_AUTH_TOKEN

const c = createClient({ url, authToken })
const t = await c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
console.log('tables:', t.rows.map((r) => r.name).join(', '))
const u = await c.execute(
  'SELECT id, username, full_name, role, active, length(password_hash) AS hashlen FROM users'
)
console.log('users count:', u.rows.length)
for (const r of u.rows) console.log(JSON.stringify(r))
