// Use the pure-HTTP web client (fetch-based) rather than the default Node entry.
// The default entry pulls in the native `libsql` addon (@libsql/win32-x64-msvc/
// index.node), which fails to load on a fresh machine that lacks the matching
// runtime — "The specified module could not be found." on first launch. We only
// ever talk to a REMOTE Turso database (libsql://…), which the web client fully
// supports, so there is no need for the native embedded driver at all.
import { createClient, type Client } from '@libsql/client/web'
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
  // multi-company: every business document belongs to a company (masters and
  // gate entries stay shared). Existing data lands in company 1.
  'ALTER TABLE bargains ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE orders ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE purchase_tankers ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE sales ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE sales_bargains ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE production ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE payments ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE bill_discounts ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE letters_of_credit ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE journal_entries ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  // Free-text remarks on bargains and purchase invoices.
  'ALTER TABLE bargains ADD COLUMN remarks TEXT',
  'ALTER TABLE orders ADD COLUMN remarks TEXT',
  // Invoice rate above bargain rate = freight billed by the supplier: the
  // difference is kept as per-ton freight data but NO transporter ledger posts.
  'ALTER TABLE orders ADD COLUMN freight_paid_to_supplier INTEGER NOT NULL DEFAULT 0',
  // Consignment purchase: goods were already at our site (no tanker movement,
  // no transporter, booked straight to received) — drawn from consignment stock.
  'ALTER TABLE orders ADD COLUMN is_consignment INTEGER NOT NULL DEFAULT 0',
  // Packaging master: reusable pack definitions with Box -> Pouch -> base
  // nesting. base per box = pouches_per_box * base_per_pouch.
  `CREATE TABLE IF NOT EXISTS packagings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    box_label TEXT NOT NULL DEFAULT 'Box',
    pouch_label TEXT NOT NULL DEFAULT 'Pouch',
    pouches_per_box REAL NOT NULL DEFAULT 1,
    base_per_pouch REAL NOT NULL DEFAULT 1,
    base_uom TEXT NOT NULL DEFAULT 'L',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Sales bargains carry a default sale type (LOOSE/PACKED), packaging and
  // freight term (FREIGHT_ON_GOODS = customer arranges; DLD = we deliver).
  "ALTER TABLE sales_bargains ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'LOOSE'",
  'ALTER TABLE sales_bargains ADD COLUMN packaging_id INTEGER',
  "ALTER TABLE sales_bargains ADD COLUMN freight_term TEXT NOT NULL DEFAULT 'FREIGHT_ON_GOODS'",
  // Each sale can override the bargain's type/freight; PACKED stores boxes +
  // loose pouches, DLD stores the transporter and freight.
  "ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'LOOSE'",
  'ALTER TABLE sales ADD COLUMN packaging_id INTEGER',
  'ALTER TABLE sales ADD COLUMN boxes REAL NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN pouches REAL NOT NULL DEFAULT 0',
  "ALTER TABLE sales ADD COLUMN freight_term TEXT NOT NULL DEFAULT 'FREIGHT_ON_GOODS'",
  'ALTER TABLE sales ADD COLUMN transporter_id INTEGER',
  'ALTER TABLE sales ADD COLUMN transport_rate REAL NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN transport_amount REAL NOT NULL DEFAULT 0',
  // Sale-linked freight lives in the transporter ledger (DLD deliveries).
  'ALTER TABLE transporter_ledger ADD COLUMN sale_id INTEGER',
  // Packaging SKUs: capture the unit size in its natural unit (KG/GM/L/ML);
  // base_per_pouch/base_uom are derived from these for stock conversion.
  'ALTER TABLE packagings ADD COLUMN unit_size REAL NOT NULL DEFAULT 0',
  "ALTER TABLE packagings ADD COLUMN unit_uom TEXT NOT NULL DEFAULT 'KG'",
  // Output GST on sales (bargain carries the default rate; the sale stores the
  // rate applied and the computed amount).
  'ALTER TABLE sales_bargains ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0',
  "ALTER TABLE sales_bargains ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  // Link the sales bargain to the customer master by id, so renaming a customer
  // reflects everywhere (the stored name is kept only as a fallback label).
  'ALTER TABLE sales_bargains ADD COLUMN customer_id INTEGER',
  'ALTER TABLE sales ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN gst_amount REAL NOT NULL DEFAULT 0',
  "ALTER TABLE sales ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  // Three-stage dispatch tracking for sales (loaded → transit → unloaded),
  // mirroring purchase tankers. Any of the three means the goods have left the
  // factory (status 'done'); 'pending' = not yet dispatched. Existing fulfilled
  // sales are treated as already unloaded/delivered.
  'ALTER TABLE sales ADD COLUMN dispatch_stage TEXT',
  "UPDATE sales SET dispatch_stage = 'unloaded' WHERE status = 'done' AND dispatch_stage IS NULL",
  // Allow dispatching a sale without booking stock (off-stock / untracked) after
  // an explicit confirmation. Such a sale does not draw from or affect stock.
  'ALTER TABLE sales ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1',
  // Date stamped at each dispatch stage (loaded → in transit → unloaded).
  'ALTER TABLE sales ADD COLUMN loaded_date TEXT',
  'ALTER TABLE sales ADD COLUMN transit_date TEXT',
  'ALTER TABLE sales ADD COLUMN unloaded_date TEXT',
  // Existing delivered sales: assume unloaded on the sale date.
  "UPDATE sales SET unloaded_date = sale_date WHERE dispatch_stage = 'unloaded' AND unloaded_date IS NULL",
  // Reverse-charge (RCM) flag for individual transporters (GTA). Informational
  // for now — freight is billed without GST and GST is self-accounted by us.
  'ALTER TABLE transporters ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0',
  // Gate OUT entries: outgoing sale dispatches tracked at the gate, alongside
  // the existing inbound (purchase tanker) entries. direction 'in' | 'out';
  // out entries link the sale being dispatched.
  "ALTER TABLE gate_entries ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'",
  'ALTER TABLE gate_entries ADD COLUMN sale_id INTEGER',
  // Receipt classification + gross/tare weighment. Net (received_qty) = gross − tare.
  "ALTER TABLE gate_entries ADD COLUMN rec_type TEXT NOT NULL DEFAULT 'OIL'",
  'ALTER TABLE gate_entries ADD COLUMN gross_weight REAL',
  'ALTER TABLE gate_entries ADD COLUMN tare_weight REAL',
  // Optional manual gate no (the physical gate-register number) — the system
  // serial (gate_entry_no) is always auto-assigned; this can be typed or blank.
  'ALTER TABLE gate_entries ADD COLUMN ref_no TEXT',
  // Multi-item sales invoices: line items share an invoice_group. Existing
  // single sales each become their own group. gate-out links the group.
  'ALTER TABLE sales ADD COLUMN invoice_group TEXT',
  "UPDATE sales SET invoice_group = 'LEGACY-' || id WHERE invoice_group IS NULL",
  'ALTER TABLE gate_entries ADD COLUMN invoice_group TEXT',
  // Manual additional interest (₹ per unit) on a purchase invoice — folds into
  // the adjusted bargain rate.
  'ALTER TABLE orders ADD COLUMN additional_interest REAL NOT NULL DEFAULT 0',
  // Dated log of bargain balance top-ups / removals, so an addition made in a
  // month shows under "Addition" in the bargain register for that month.
  // kind = 'purchase' | 'sales'; delta > 0 add, < 0 remove.
  `CREATE TABLE IF NOT EXISTS bargain_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    bargain_id INTEGER NOT NULL,
    delta REAL NOT NULL,
    adj_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Approval queue: master-list creations by non-admins park here (on hold)
  // until an admin approves (inserts into the real table) or rejects (reason
  // shown back to the requester). Real master tables only ever hold approved
  // rows, so existing dropdowns/consumers need no filtering.
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'create',
    payload TEXT NOT NULL,
    label TEXT,
    requested_by INTEGER,
    requested_by_name TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by INTEGER,
    decided_by_name TEXT,
    decided_at TEXT,
    reason TEXT,
    created_id INTEGER
  )`,
  // Consignment stock: supplier goods lying at our place, off-books until
  // invoiced. Created here (not in SCHEMA_SQL) so it also lands on existing DBs.
  `CREATE TABLE IF NOT EXISTS consignment_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL,
    uom TEXT NOT NULL DEFAULT 'MT',
    deposit_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Audit trail: attribute each logged action to a company, section and record.
  'ALTER TABLE user_logs ADD COLUMN company_id INTEGER',
  'ALTER TABLE user_logs ADD COLUMN entity TEXT',
  'ALTER TABLE user_logs ADD COLUMN entity_id INTEGER',
  // Inter-company stock movement: qty leaves the source company's stock and
  // adds to the destination company's stock (physical move, not a sale).
  `CREATE TABLE IF NOT EXISTS stock_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_company_id INTEGER NOT NULL,
    to_company_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL,
    uom TEXT NOT NULL DEFAULT 'MT',
    transfer_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Party ledgers are company books too — doc-linked rows inherit the parent
  // document's company; manual rows take the company they were entered in.
  'ALTER TABLE supplier_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE transporter_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE customer_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1',
  // Excess loading: qty loaded beyond the chosen bargain's balance is booked
  // against an auto-created bargain line; the split is remembered per tanker.
  'ALTER TABLE purchase_tankers ADD COLUMN extra_bargain_id INTEGER',
  'ALTER TABLE purchase_tankers ADD COLUMN extra_qty REAL NOT NULL DEFAULT 0',
  // Self-healing: doc-linked party-ledger rows always belong to their parent
  // document's company (covers rows written before these columns existed).
  `UPDATE supplier_ledger SET company_id = COALESCE(
     (SELECT o.company_id FROM orders o WHERE o.id = supplier_ledger.order_id),
     (SELECT p.company_id FROM payments p WHERE p.id = supplier_ledger.payment_id),
     company_id)`,
  `UPDATE transporter_ledger SET company_id = COALESCE(
     (SELECT o.company_id FROM orders o WHERE o.id = transporter_ledger.order_id),
     (SELECT p.company_id FROM payments p WHERE p.id = transporter_ledger.payment_id),
     company_id)`,
  `UPDATE customer_ledger SET company_id = COALESCE(
     (SELECT s.company_id FROM sales s WHERE s.id = customer_ledger.sale_id),
     (SELECT p.company_id FROM payments p WHERE p.id = customer_ledger.payment_id),
     company_id)`,
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
  "UPDATE orders SET status = 'loaded' WHERE status IN ('at_port', 'ordered', 'payment_cleared', 'in_transit', 'outside_factory', 'inside_factory')",
  // Snapshot of the weighted-average valuation rate used for a day's physical
  // count, so a saved count keeps the value it was booked at.
  'ALTER TABLE stock_counts ADD COLUMN rate REAL',
  // Links an auto-generated production run to the sale whose dispatch triggered
  // it. When a finished good that has a formulation is dispatched, we record a
  // production (consumes the recipe's raw/intermediate inputs, outputs the
  // dispatched qty) so raw stock is drawn down at dispatch. NULL = manual run.
  'ALTER TABLE production ADD COLUMN sale_id INTEGER',
  // Packed finished stock per SKU (packaging): a lightweight, company-scoped
  // count. on-hand = SUM(delta) − packed units sold. delta > 0 packs in,
  // < 0 removes. Dated so the balance reflects when it changed.
  `CREATE TABLE IF NOT EXISTS sku_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    packaging_id INTEGER NOT NULL,
    delta REAL NOT NULL,
    adj_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Tally-style Debit / Credit notes. A debit note reduces a supplier payable
  // (purchase return / rate cut); a credit note reduces a customer receivable
  // (sales return / allowance). Each posts a double-entry journal voucher AND a
  // signed party-ledger row; those ids are kept so a delete reverses both.
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    note_type TEXT NOT NULL,
    note_no TEXT NOT NULL,
    note_date TEXT NOT NULL,
    party_type TEXT NOT NULL,
    party_id INTEGER NOT NULL,
    against_account TEXT NOT NULL,
    base_amount REAL NOT NULL DEFAULT 0,
    gst_pct REAL NOT NULL DEFAULT 0,
    gst_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    narration TEXT,
    journal_entry_id INTEGER,
    ledger_table TEXT,
    ledger_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Classification of a sales bargain (mirrors the purchase-bargain type tabs):
  // FINISHED_OIL | FATTY | SCRAP | SPENT_EARTH | MISC.
  "ALTER TABLE sales_bargains ADD COLUMN sale_category TEXT NOT NULL DEFAULT 'FINISHED_OIL'",
  // Invoice-level round off on sales (mirrors purchases). Stored on the FIRST
  // line of the invoice group (others 0) so summing lines never double-counts.
  'ALTER TABLE sales ADD COLUMN round_off REAL NOT NULL DEFAULT 0',
  // Products get a material Category (OIL / HUSK / PACKAGING / CHEMICAL / MISC)
  // above the existing raw/intermediate/finished classification, which becomes
  // the Sub-category. The DEFAULT backfills every existing product as OIL.
  "ALTER TABLE products ADD COLUMN material_type TEXT NOT NULL DEFAULT 'OIL'",
  // A packed SKU belongs to a finished product (DALDA 15 KG TIN → DALDA), so
  // packed pieces can be reconciled in tonnage against that product's stock.
  'ALTER TABLE packagings ADD COLUMN product_id INTEGER',
  // Consignment lots now start life as a GATE ENTRY: the gateman passes the
  // tanker, the accountant validates it into consignment stock. This records
  // which gate entry a lot came from so it can't be validated twice.
  'ALTER TABLE consignment_stock ADD COLUMN gate_entry_id INTEGER',
  'ALTER TABLE consignment_stock ADD COLUMN tanker_no TEXT',
  // Which purchase invoice drew this lot (NULL = still pending booking), so the
  // purchase form can list the exact tankers waiting to be invoiced.
  'ALTER TABLE consignment_stock ADD COLUMN order_id INTEGER',
  // Per-tanker bargain allocation, mirroring purchase_tankers: one tanker can be
  // split across two bargains (extra_qty goes to extra_bargain_id).
  'ALTER TABLE consignment_stock ADD COLUMN bargain_id INTEGER',
  'ALTER TABLE consignment_stock ADD COLUMN extra_bargain_id INTEGER',
  'ALTER TABLE consignment_stock ADD COLUMN extra_qty REAL',
  // Parties whose goods are already at our site (consignment / MNC suppliers):
  // purchases from them skip the tanker movement entirely — no send-to-supplier,
  // no transit/outside/inside/empty. Booked straight to received.
  'ALTER TABLE suppliers ADD COLUMN skip_tanker_stages INTEGER NOT NULL DEFAULT 0',
  // Optional item lines on a debit/credit note (product × qty × rate). When
  // present they compute the note's base amount; ledger-only (no stock move).
  `CREATE TABLE IF NOT EXISTS note_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    product_id INTEGER,
    description TEXT,
    qty REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0
  )`
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

// stock_counts was UNIQUE(count_date, product_id); multi-company needs the
// company in the key. Rebuild once (detected by the missing company_id column).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rebuildStockCountsForCompanies(c: any): Promise<void> {
  const info = await c.execute('PRAGMA table_info(stock_counts)')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasCompany = info.rows.some((r: any) => String(r.name) === 'company_id')
  if (hasCompany) return
  await c.execute(`CREATE TABLE stock_counts_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    count_date TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    book_qty REAL NOT NULL DEFAULT 0,
    actual_qty REAL NOT NULL DEFAULT 0,
    actual_value REAL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(company_id, count_date, product_id)
  )`)
  await c.execute(`INSERT INTO stock_counts_new
      (id, company_id, count_date, product_id, book_qty, actual_qty, actual_value, note, created_at)
    SELECT id, 1, count_date, product_id, book_qty, actual_qty, actual_value, note, created_at
    FROM stock_counts`)
  await c.execute('DROP TABLE stock_counts')
  await c.execute('ALTER TABLE stock_counts_new RENAME TO stock_counts')
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
    await rebuildStockCountsForCompanies(c).catch((e) =>
      console.error('[db] stock_counts rebuild failed:', (e as Error).message)
    )
    console.log('[db] schema ready')
  } catch (err) {
    console.error('[db] init skipped/failed:', (err as Error).message)
  }
}

// Global change counter for live multi-user refresh. Every write bumps it;
// clients poll getRevision() and refetch only when the number changes.
//
// The revision is CACHED in the main process and refreshed by ONE background
// watcher. Previously every mounted page polled it straight through to Turso
// every 3s — on a slow connection those round-trips piled up and the whole UI
// stalled until they timed out. Now renderer polls are answered instantly from
// memory and only the single watcher touches the network (never overlapping).
let cachedRevision = 0
let revisionInFlight = false
let revisionTimer: ReturnType<typeof setInterval> | null = null

async function fetchRevision(): Promise<void> {
  if (revisionInFlight) return // a slow request never stacks another behind it
  revisionInFlight = true
  try {
    const res = await getClient().execute("SELECT value FROM app_settings WHERE key = 'db_revision'")
    cachedRevision = res.rows.length ? Number(res.rows[0].value) : 0
  } catch {
    // keep the last known value; next tick retries
  } finally {
    revisionInFlight = false
  }
}

export function startRevisionWatcher(): void {
  if (revisionTimer) return
  fetchRevision()
  revisionTimer = setInterval(fetchRevision, 4000)
}

export async function bumpRevision(): Promise<void> {
  await getClient().execute(
    `INSERT INTO app_settings (key, value) VALUES ('db_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  )
  // Reflect our own write immediately so this device's pages refresh at once.
  cachedRevision += 1
}

export function getRevision(): number {
  return cachedRevision
}

// Distinguish "no internet" from a real config/auth problem so the UI can ask
// the user to check their connection instead of showing the credentials screen.
function isNetworkError(err: unknown): boolean {
  const msg = `${(err as Error)?.message || ''} ${((err as { cause?: Error })?.cause?.message) || ''}`
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|UND_ERR|network|getaddrinfo/i.test(msg)
}

export async function ping(): Promise<{ ok: boolean; message: string; offline?: boolean }> {
  try {
    const c = getClient()
    await c.execute('SELECT 1')
    return { ok: true, message: 'Connected to Turso' }
  } catch (err) {
    if (isNetworkError(err)) {
      // The connection may recover; don't cache a client built mid-outage.
      resetClient()
      return { ok: false, offline: true, message: 'No internet connection' }
    }
    return { ok: false, message: (err as Error).message }
  }
}
