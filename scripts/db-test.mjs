// Quick connection test. Run after pasting your token into .env:
//   npm run db:test
import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url) {
  console.error('✗ Missing TURSO_DATABASE_URL in .env')
  process.exit(1)
}
if (!authToken) {
  console.error('✗ Missing TURSO_AUTH_TOKEN in .env')
  process.exit(1)
}

try {
  const client = createClient({ url, authToken })
  const res = await client.execute('SELECT 1 AS ok')
  console.log('✓ Connected to Turso. Test query result:', res.rows)
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )
  console.log(
    '  Tables:',
    tables.rows.map((r) => r.name).join(', ') || '(none yet)'
  )
} catch (err) {
  console.error('✗ Connection failed:', err.message)
  process.exit(1)
}
