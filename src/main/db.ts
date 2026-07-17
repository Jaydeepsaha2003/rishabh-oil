import { createClient, type Client } from '@libsql/client'
import { SCHEMA_SQL } from './schema'
import { getStoredConfig } from './config'

let client: Client | null = null

// Resolved without the token — used to pre-fill the setup screen.
export function getConfiguredUrl(): string {
  return (
    getStoredConfig().url ||
    import.meta.env.MAIN_VITE_TURSO_DATABASE_URL ||
    process.env.MAIN_VITE_TURSO_DATABASE_URL ||
    process.env.TURSO_DATABASE_URL ||
    ''
  )
}

// Drop the cached client so the next call reconnects (after the user saves new credentials).
export function resetClient(): void {
  client = null
}

function loadEnv(): void {
  // Node 22+ can read a local .env into process.env. In dev the cwd is the
  // project root, so the .env you create there is picked up. (Packaged builds
  // will get their config a different way — handled later.)
  try {
    const proc = process as unknown as { loadEnvFile?: (path?: string) => void }
    proc.loadEnvFile?.()
  } catch {
    // No .env yet — fine until the user pastes their token.
  }
}

export function getClient(): Client {
  if (client) return client
  loadEnv()
  // Resolution order: credentials the user saved on this machine (highest, so
  // a fix sticks), then MAIN_VITE_* baked into the build, then dev .env.
  const stored = getStoredConfig()
  const url =
    stored.url ||
    import.meta.env.MAIN_VITE_TURSO_DATABASE_URL ||
    process.env.MAIN_VITE_TURSO_DATABASE_URL ||
    process.env.TURSO_DATABASE_URL
  const authToken =
    stored.authToken ||
    import.meta.env.MAIN_VITE_TURSO_AUTH_TOKEN ||
    process.env.MAIN_VITE_TURSO_AUTH_TOKEN ||
    process.env.TURSO_AUTH_TOKEN
  if (!url) {
    throw new Error('Turso database URL is not set — enter it in the setup screen.')
  }
  client = createClient({ url, authToken })
  return client
}

// Idempotent column additions for databases created before these columns
// existed. SQLite has no "ADD COLUMN IF NOT EXISTS", so each runs in its own
// try/catch and the "duplicate column name" error is simply ignored.
const MIGRATIONS = [
  'ALTER TABLE bargains ADD COLUMN opening_qty REAL',
  'ALTER TABLE bargains ADD COLUMN base_rate REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bargains ADD COLUMN duty REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bargains ADD COLUMN allowed_shortage_pct REAL',
  'ALTER TABLE orders ADD COLUMN is_registered_transporter INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE orders ADD COLUMN tanker_no TEXT',
  'ALTER TABLE orders ADD COLUMN posting INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN final_taxable_value REAL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN final_gst_amount REAL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN final_tds_amount REAL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN final_net_amount REAL DEFAULT 0',
  'ALTER TABLE supplier_ledger ADD COLUMN payment_id INTEGER',
  'ALTER TABLE transporter_ledger ADD COLUMN payment_id INTEGER',
  'ALTER TABLE users ADD COLUMN permissions TEXT',
  'ALTER TABLE transporters ADD COLUMN company_type TEXT',
  'ALTER TABLE transporters ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE transporters ADD COLUMN tds_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE transporters ADD COLUMN tds_threshold REAL NOT NULL DEFAULT 0',
  'ALTER TABLE transporters ADD COLUMN tds_pct_above REAL NOT NULL DEFAULT 0',
  'ALTER TABLE suppliers ADD COLUMN tds_threshold REAL NOT NULL DEFAULT 0',
  'ALTER TABLE suppliers ADD COLUMN tds_pct_above REAL NOT NULL DEFAULT 0',
  'ALTER TABLE suppliers ADD COLUMN tds_above_only INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN port_entry_date TEXT',
  'ALTER TABLE orders ADD COLUMN payment_cleared_date TEXT',
  'ALTER TABLE orders ADD COLUMN financed_by_party INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN dispatch_date TEXT',
  'ALTER TABLE orders ADD COLUMN outside_factory_date TEXT',
  'ALTER TABLE orders ADD COLUMN inside_factory_date TEXT',
  'ALTER TABLE orders ADD COLUMN received_date TEXT',
  'ALTER TABLE orders ADD COLUMN credit_interest_days REAL NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN credit_interest_amount REAL NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN sales_bargain_id INTEGER',
  'ALTER TABLE sales ADD COLUMN customer_id INTEGER',
  'ALTER TABLE payment_allocations ADD COLUMN sale_id INTEGER',
  // bargains/orders keep a legacy oil_types FK; mirror products so it is satisfied.
  `INSERT OR IGNORE INTO oil_types (id, code, name, active)
     SELECT id, COALESCE(code, name, 'GEN'), COALESCE(name, code, 'PRODUCT'), 1 FROM products`,
  // default UOM switched from ton to MT
  "UPDATE app_settings SET value = 'MT' WHERE key = 'default_uom' AND value = 'ton'",
  'ALTER TABLE suppliers ADD COLUMN supplier_type TEXT',
  "ALTER TABLE orders ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  "ALTER TABLE gate_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
  'ALTER TABLE bargains ADD COLUMN broker_id INTEGER',
  'ALTER TABLE orders ADD COLUMN round_off REAL NOT NULL DEFAULT 0',
  'ALTER TABLE suppliers ADD COLUMN opening_purchase_amount REAL NOT NULL DEFAULT 0',
  'ALTER TABLE suppliers ADD COLUMN opening_purchase_date TEXT',
  // bargain condition renamed to EX/DLD
  "UPDATE bargains SET bargain_type = 'EX' WHERE bargain_type = 'Ex'",
  "UPDATE bargains SET bargain_type = 'DLD' WHERE bargain_type = 'Delivered'",
  "UPDATE orders SET bargain_type = 'EX' WHERE bargain_type = 'Ex'",
  "UPDATE orders SET bargain_type = 'DLD' WHERE bargain_type = 'Delivered'",
  'ALTER TABLE purchase_tankers ADD COLUMN krfl_weighment_doc_no TEXT',
  'ALTER TABLE purchase_tankers ADD COLUMN krfl_weighment_photo TEXT',
  'ALTER TABLE purchase_tankers ADD COLUMN outside_weighment_doc_no TEXT',
  'ALTER TABLE purchase_tankers ADD COLUMN outside_weighment_photo TEXT',
  `INSERT INTO purchase_tankers
    (order_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id, loaded_qty, uom,
     payment_mode, status, transit_date, source_id, expected_delivery_date, outside_factory_date,
     inside_factory_date, empty_date, received_qty, transporter_id, transport_rate_per_ton,
     transport_amount, shortage_charge_amount)
   SELECT o.id, COALESCE(NULLIF(o.tanker_no, ''), 'Legacy-' || o.id),
          COALESCE(o.port_entry_date, o.loaded_date, o.order_date), o.bargain_id, o.supplier_id,
          o.oil_type_id, o.ordered_qty, o.uom,
          CASE WHEN o.financed_by_party = 1 THEN 'supplier_finance' ELSE 'paid_by_us' END,
          CASE
            WHEN o.status IN ('received', 'delivered') THEN 'empty'
            WHEN o.status = 'inside_factory' THEN 'inside_factory'
            WHEN o.status = 'outside_factory' THEN 'outside_factory'
            WHEN o.status = 'in_transit' THEN 'transit'
            ELSE 'loaded'
          END,
          o.dispatch_date, o.source_id, o.expected_delivery_date, o.outside_factory_date,
          o.inside_factory_date, COALESCE(o.received_date, o.delivered_date), o.received_qty,
          o.transporter_id, o.transport_rate_per_ton, o.transport_amount, o.shortage_charge_amount
   FROM orders o
   WHERE NOT EXISTS (SELECT 1 FROM purchase_tankers pt WHERE pt.order_id = o.id)`,
  // Order status is now derived from its tankers (loaded → received). Remap
  // leftovers from the earlier order lifecycle; the OLD 'loaded'→'at_port'
  // remap is gone — it ran every boot and corrupted freshly created purchases.
  "UPDATE orders SET status = 'received' WHERE status = 'delivered'",
  "UPDATE orders SET status = 'loaded' WHERE status IN ('at_port', 'ordered', 'payment_cleared', 'in_transit', 'outside_factory', 'inside_factory')"
]

// One-time cleanup: trailing bargain serials were 4-digit (…/0017); reformat to
// the 2-digit scheme (…/17), keeping the same number. Idempotent — already
// 2-digit values are left untouched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function backfillBargainSerials(c: any): Promise<void> {
  const res = await c.execute('SELECT id, bargain_no FROM bargains')
  for (const r of res.rows) {
    const no = String(r.bargain_no || '')
    const parts = no.split('/')
    const last = parts[parts.length - 1] ?? ''
    const num = parseInt(last, 10)
    if (!/^\d+$/.test(last) || Number.isNaN(num)) continue
    const fixed = String(num).padStart(2, '0')
    if (fixed === last) continue
    parts[parts.length - 1] = fixed
    await c.execute({
      sql: 'UPDATE bargains SET bargain_no = ? WHERE id = ?',
      args: [parts.join('/'), r.id]
    })
  }
}

export async function initDb(): Promise<void> {
  // Never crash the app if the token is missing — the UI surfaces the status.
  try {
    const c = getClient()
    const statements = SCHEMA_SQL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of statements) {
      await c.execute(stmt)
    }
    for (const sql of MIGRATIONS) {
      try {
        await c.execute(sql)
      } catch {
        // column already exists — expected on databases already migrated
      }
    }
    await backfillBargainSerials(c).catch(() => {})
    console.log('[db] schema ready')
  } catch (err) {
    console.error('[db] init skipped/failed:', (err as Error).message)
  }
}

// Global change counter for live multi-user refresh. Every write bumps it;
// clients poll getRevision() and refetch only when the number changes.
export async function bumpRevision(): Promise<void> {
  await getClient().execute(
    `INSERT INTO app_settings (key, value) VALUES ('db_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  )
}

export async function getRevision(): Promise<number> {
  try {
    const res = await getClient().execute("SELECT value FROM app_settings WHERE key = 'db_revision'")
    return res.rows.length ? Number(res.rows[0].value) : 0
  } catch {
    return 0
  }
}

export async function ping(): Promise<{ ok: boolean; message: string }> {
  try {
    const c = getClient()
    await c.execute('SELECT 1')
    return { ok: true, message: 'Connected to Turso' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
