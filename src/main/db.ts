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

// Today's date, in the LOCAL calendar day — never `new Date().toISOString()`,
// which renders in UTC. For any timezone ahead of UTC (IST is UTC+5:30), the
// stretch between local midnight and UTC midnight reads back as YESTERDAY —
// exactly what stamped a gate entry's OUT date a day before its own IN date
// when the weighment was saved just after midnight. Every "today" a date
// field defaults to, or a save-time stamp falls back to, must use this.
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  // Direct MNC arrival: the goods belong to a direct-purchase party and never
  // travelled on one of our purchase tankers, so there is no tanker to pick —
  // the gateman types the vehicle number and names the party right here, and the
  // accountant's validation step is then only about which oil it is.
  'ALTER TABLE gate_entries ADD COLUMN supplier_id INTEGER',
  'ALTER TABLE gate_entries ADD COLUMN is_direct_mnc INTEGER NOT NULL DEFAULT 0',
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
   WHERE NOT EXISTS (SELECT 1 FROM purchase_tankers pt WHERE pt.order_id = o.id)
     -- Consignment / direct purchases are tanker-less BY DESIGN: the goods are
     -- already at our site. Giving them a stand-in tanker would put them back
     -- into tanker movement and, worse, make the bargain register count their
     -- quantity twice (once via the tanker, once via the lots / the invoice).
     AND o.is_consignment = 0`,
  // Remove stand-in tankers this backfill created for consignment purchases
  // before the guard above existed. Only rows it generated itself are touched.
  `DELETE FROM purchase_tankers
   WHERE tanker_no = 'Legacy-' || order_id
     AND order_id IN (SELECT id FROM orders WHERE is_consignment = 1)`,
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
  // Opening balance rather than an arrival: the stock the MNC already held with
  // us when the books started, entered by hand with no gate entry behind it.
  'ALTER TABLE consignment_stock ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0',
  // The gate weighment and the allowed shortage that produced the net qty, so
  // the register can show how the figure was arrived at.
  'ALTER TABLE consignment_stock ADD COLUMN weighed_qty REAL',
  'ALTER TABLE consignment_stock ADD COLUMN shortage_pct REAL',
  // Per-SKU selling rates agreed on a sales bargain. Filled from a downloaded
  // sheet, then offered when a sale line on that bargain picks the SKU.
  `CREATE TABLE IF NOT EXISTS sales_bargain_sku_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sales_bargain_id INTEGER NOT NULL REFERENCES sales_bargains(id),
    packaging_id INTEGER NOT NULL REFERENCES packagings(id),
    rate_per_case REAL,
    rate_per_mt REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (sales_bargain_id, packaging_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sbsr_bargain ON sales_bargain_sku_rates(sales_bargain_id)',
  // Tally-style bill-wise adjustments on payment/receipt voucher lines:
  // agst_ref settles a named bill, advance/new_ref create one, on_account
  // leaves the money unallocated.
  `CREATE TABLE IF NOT EXISTS journal_bill_allocs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id INTEGER NOT NULL REFERENCES journal_lines(id),
    account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
    method TEXT NOT NULL,
    ref_name TEXT,
    amount REAL NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_jba_line ON journal_bill_allocs(line_id)',
  'CREATE INDEX IF NOT EXISTS idx_jba_account ON journal_bill_allocs(account_id)',
  // Which customers buy which packed SKUs — narrows the sales-bargain rate
  // card to the SKUs that party actually trades in.
  // A gate entry can be recorded without any weighment — it completes on the
  // spot instead of waiting at the weighbridge, and carries no gate figure.
  'ALTER TABLE gate_entries ADD COLUMN no_weighment INTEGER NOT NULL DEFAULT 0',
  // A manually-entered vehicle can belong to either side of the trade.
  'ALTER TABLE gate_entries ADD COLUMN customer_id INTEGER',
  // The plain gate-register line: a vehicle, who it is with, and what it
  // carries. No weighment, no document behind it.
  // Product/material categories as a master, so OIL, HUSK, SCRAP and whatever
  // the mill adds later live in one place instead of being hard-coded in every
  // screen. Referenced BY NAME, so existing rows keep working untouched.
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Seed from whatever the books already use, so nothing vanishes on upgrade.
  `INSERT OR IGNORE INTO categories (name)
     SELECT DISTINCT UPPER(TRIM(material_type)) FROM products
      WHERE COALESCE(TRIM(material_type), '') != ''`,
  `INSERT OR IGNORE INTO categories (name)
     SELECT DISTINCT UPPER(TRIM(supplier_type)) FROM suppliers
      WHERE COALESCE(TRIM(supplier_type), '') != ''`,
  `INSERT OR IGNORE INTO categories (name) VALUES
     ('OIL'), ('HUSK'), ('FATTY'), ('SCRAP'), ('SPENT EARTH'), ('PACKAGING'), ('CHEMICAL'), ('MISCELLANEOUS')`,
  // Which side of the trade a category belongs to: bought, sold, or both.
  "ALTER TABLE categories ADD COLUMN applies_to TEXT NOT NULL DEFAULT 'both'",
  // A customer can be tagged with the category it trades in, the way a supplier
  // already is — that is what lets the gate narrow the party list honestly.
  'ALTER TABLE customers ADD COLUMN category TEXT',
  // PP = presentation stock counted alongside the physical count.
  'ALTER TABLE stock_counts ADD COLUMN pp_qty REAL',
  'ALTER TABLE gate_entries ADD COLUMN person TEXT',
  "ALTER TABLE gate_entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'standard'",
  "ALTER TABLE notes ADD COLUMN against_ref TEXT",
  // Treasury: usance/margin on LCs, due-dated LC bills, and the discounting
  // economics (rate, interest, net) with the journal entries they posted.
  'ALTER TABLE letters_of_credit ADD COLUMN usance_days INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE letters_of_credit ADD COLUMN margin_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE letters_of_credit ADD COLUMN journal_entry_id INTEGER',
  'ALTER TABLE lc_issuances ADD COLUMN due_date TEXT',
  "ALTER TABLE lc_issuances ADD COLUMN status TEXT NOT NULL DEFAULT 'outstanding'",
  'ALTER TABLE lc_issuances ADD COLUMN settled_date TEXT',
  'ALTER TABLE lc_issuances ADD COLUMN journal_entry_id INTEGER',
  'ALTER TABLE bill_discounts ADD COLUMN customer_id INTEGER',
  'ALTER TABLE bill_discounts ADD COLUMN invoice_group TEXT',
  'ALTER TABLE bill_discounts ADD COLUMN rate_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bill_discounts ADD COLUMN charges REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bill_discounts ADD COLUMN interest_amount REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bill_discounts ADD COLUMN net_received REAL NOT NULL DEFAULT 0',
  'ALTER TABLE bill_discounts ADD COLUMN journal_entry_id INTEGER',
  'ALTER TABLE bill_discounts ADD COLUMN realize_entry_id INTEGER',
  // Every restatement of an MNC opening balance keeps its old figure, so a
  // mistaken change (or deletion) can be seen and put back.
  `CREATE TABLE IF NOT EXISTS consignment_opening_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    supplier_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_qty REAL,
    new_qty REAL,
    uom TEXT,
    deposit_date TEXT,
    note TEXT,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS packaging_parties (
    packaging_id INTEGER NOT NULL REFERENCES packagings(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    PRIMARY KEY (packaging_id, customer_id)
  )`,
  // How a consignment / direct purchase invoice is spread across bargains. The
  // quantity is typed, not tanker-wise, so the allocation belongs to the invoice
  // rather than to a tanker — and it is the single source the bargain register
  // reads for these purchases.
  `CREATE TABLE IF NOT EXISTS order_bargains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    bargain_id INTEGER NOT NULL REFERENCES bargains(id),
    qty REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_order_bargains_bargain ON order_bargains(bargain_id)',
  'CREATE INDEX IF NOT EXISTS idx_order_bargains_order ON order_bargains(order_id)',
  // Consignment invoices booked before this table existed keep their single
  // bargain link; give each one the row the register now expects.
  `INSERT INTO order_bargains (order_id, bargain_id, qty)
   SELECT o.id, o.bargain_id, o.ordered_qty FROM orders o
   WHERE o.is_consignment = 1 AND o.bargain_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM bargains b WHERE b.id = o.bargain_id)
     AND NOT EXISTS (SELECT 1 FROM order_bargains ob WHERE ob.order_id = o.id)`,
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
  )`,
  // The sanctioned facility a bank grants, sitting ABOVE individual LCs: each
  // LC draws against it, so headroom is the sanction less everything already
  // committed. Without this an LC only knew its own amount and nothing stopped
  // the bank's overall limit being exceeded.
  `CREATE TABLE IF NOT EXISTS bank_facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    bank TEXT NOT NULL,
    facility_type TEXT NOT NULL DEFAULT 'lc',
    sanctioned_limit REAL NOT NULL DEFAULT 0,
    sanction_date TEXT,
    review_date TEXT,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Outstanding that consumes the sanction but is NOT one of our LCs — the
  // legacy accounts and the DIL EXIM balance the notes call out. Kept as named
  // lines so the available figure can always be broken back down into what
  // makes it up, rather than being a single unexplained number.
  `CREATE TABLE IF NOT EXISTS facility_exposures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL REFERENCES bank_facilities(id),
    label TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'outstanding',
    as_of TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'ALTER TABLE letters_of_credit ADD COLUMN facility_id INTEGER',
  // Why the LC was opened — the notes head the LC record with its purpose, so
  // a register can be read without opening every one to remember what it was for.
  'ALTER TABLE letters_of_credit ADD COLUMN purpose TEXT',
  // FDs held as security. The notes ask for the FD NUMBER to be the link, with
  // the bank, amount, maturity and lien visible from whatever it secures.
  `CREATE TABLE IF NOT EXISTS fixed_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    fd_no TEXT NOT NULL,
    bank TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    start_date TEXT,
    maturity_date TEXT,
    interest_pct REAL NOT NULL DEFAULT 0,
    lien_status TEXT NOT NULL DEFAULT 'free',
    facility_id INTEGER,
    lc_id INTEGER,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // A hand-written reference kept alongside the auto-generated bargain_no —
  // e.g. the number the party quotes on their own paperwork — never used for
  // anything but display.
  'ALTER TABLE sales_bargains ADD COLUMN manual_bargain_no TEXT',
  // Trading LCs: the purchase invoice the LC was opened against, the party the
  // sale proceeds (repayment) will come from, and a workflow status distinct
  // from the open/utilized/closed lifecycle — the notes ask for In Progress /
  // On Hold as something the user sets, separate from whether it's drawn.
  'ALTER TABLE letters_of_credit ADD COLUMN linked_order_id INTEGER',
  'ALTER TABLE letters_of_credit ADD COLUMN receivable_party_id INTEGER',
  "ALTER TABLE letters_of_credit ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'in_progress'",
  // A repayment against an LC's exposure — the money coming back from the
  // receivable party. `posted` gates whether it has hit the books yet: a
  // repayment can be logged (with its bank document) before being confirmed.
  `CREATE TABLE IF NOT EXISTS lc_repayments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lc_id INTEGER NOT NULL REFERENCES letters_of_credit(id),
    party_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    repay_date TEXT,
    posted INTEGER NOT NULL DEFAULT 0,
    document_path TEXT,
    journal_entry_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_lc_repayments_lc ON lc_repayments(lc_id)',
  // Trading purchases/sales: bought from one party and sold straight to
  // another, never actually landing in our stock — no bargain, no tanker,
  // and (the one thing nothing else already gave us) excluded from every
  // stock computation via affects_stock.
  'ALTER TABLE orders ADD COLUMN is_trading INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN affects_stock INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE sales ADD COLUMN is_trading INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN affects_stock INTEGER NOT NULL DEFAULT 1',
  // FOR (DLD) sales: by default freight is recovered from the customer on top
  // of the goods value. This flips it — freight is deducted from the invoice
  // total instead, the transporter is still paid in full by us.
  'ALTER TABLE sales ADD COLUMN deduct_freight INTEGER NOT NULL DEFAULT 0',
  // The LC's own lifecycle, as the client works it day to day — separate from
  // the internal open/utilized/closed status (still used for facility
  // headroom) and from the Trading compliance flag.
  "ALTER TABLE letters_of_credit ADD COLUMN stage TEXT NOT NULL DEFAULT 'application'",
  // The fixed deposit lodged as security for the LC — mandatory in the UI.
  'ALTER TABLE letters_of_credit ADD COLUMN fd_no TEXT',
  // Entered at the Payment received stage, alongside maturity date — usance
  // days (relabeled Interest days) is then calculated from the two rather
  // than typed by hand.
  'ALTER TABLE letters_of_credit ADD COLUMN payment_received_date TEXT',
  // open_date already carries the Application date (see the earlier
  // Open date -> Application date relabel); the LC's actual opening — a
  // later, separate step — gets its own column.
  'ALTER TABLE letters_of_credit ADD COLUMN opened_date TEXT',
  // Swapping a tanker mid-transit (accident, breakdown) keeps the same
  // purchase_tankers row — bargain/order/financials stay put — but its
  // number changes and whatever quantity was lost comes off loaded_qty, so
  // the bargain balance and the gate's later weighment both reconcile
  // against what the replacement can actually still deliver.
  'ALTER TABLE purchase_tankers ADD COLUMN loss_qty REAL NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS tanker_replacements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanker_id INTEGER NOT NULL REFERENCES purchase_tankers(id),
    old_tanker_no TEXT,
    new_tanker_no TEXT NOT NULL,
    loss_qty REAL NOT NULL DEFAULT 0,
    reason TEXT,
    replaced_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tanker_replacements_tanker ON tanker_replacements(tanker_id)',
  // Which of the party's open invoices this LC covers — one LC can now cover
  // several, so it's a table rather than the single linked_order_id column.
  `CREATE TABLE IF NOT EXISTS lc_linked_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lc_id INTEGER NOT NULL REFERENCES letters_of_credit(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(lc_id, order_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_lc_linked_orders_lc ON lc_linked_orders(lc_id)',
  // LC repayment is US repaying the BANK (an outflow), not the receivable
  // party paying us — the bank often deducts a variable maturity charge at
  // the same moment, debited from our account as one combined withdrawal
  // alongside the repayment itself.
  'ALTER TABLE lc_repayments ADD COLUMN maturity_charges REAL NOT NULL DEFAULT 0',
  // Bank statement reconciliation: an import batch (one per uploaded file) and
  // its lines. A line either LINKS to a payment/LC entry already posted
  // elsewhere (no new posting — just marks it reconciled) or falls to 'misc'
  // when nothing recognizes it. sub_entry_* is a manual party/purpose note,
  // independent of the reconciliation status itself.
  `CREATE TABLE IF NOT EXISTS bank_statement_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank TEXT NOT NULL,
    file_name TEXT,
    company_id INTEGER NOT NULL DEFAULT 1,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bank_statement_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES bank_statement_imports(id),
    bank TEXT NOT NULL,
    txn_date TEXT NOT NULL,
    narration TEXT,
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    balance REAL,
    category TEXT,
    link_type TEXT,
    link_ref_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    sub_entry_enabled INTEGER NOT NULL DEFAULT 0,
    sub_entry_note TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_import ON bank_statement_lines(import_id)',
  'CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_status ON bank_statement_lines(status)',
  // Bill Discounting: no stages like an LC — just submit an invoice and the
  // discounter pays out T/T+1 on its own advice, so there's nothing here to
  // gate on dates the way LCs are. Each party carries its own rate/limit
  // (PID/SID, security, interest terms); entries draw against that limit.
  `CREATE TABLE IF NOT EXISTS bd_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    party_name TEXT NOT NULL,
    discounter TEXT,
    rate_pct REAL NOT NULL DEFAULT 0,
    finance_type TEXT NOT NULL DEFAULT 'PID',
    purpose TEXT,
    security_given INTEGER NOT NULL DEFAULT 0,
    interest_bearing INTEGER NOT NULL DEFAULT 0,
    interest_payment_schedule TEXT,
    sanctioned_limit REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bd_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bd_party_id INTEGER NOT NULL REFERENCES bd_parties(id),
    invoice_no TEXT,
    amount REAL NOT NULL DEFAULT 0,
    submitted_date TEXT NOT NULL,
    payment_date TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    repaid_date TEXT,
    interest_amount REAL NOT NULL DEFAULT 0,
    interest_received_date TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_bd_entries_party ON bd_entries(bd_party_id)',
  // Purchase & Sales Trading: one dedicated screen for a raw-product
  // pass-through deal (buy from a supplier, sell the same quantity straight
  // to a customer) — no tanker movement, no stock entries. Reuses the
  // existing orders/sales is_trading path under the hood; this table just
  // links the resulting purchase + sale as one deal for its own listing.
  `CREATE TABLE IF NOT EXISTS trading_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    deal_date TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    order_id INTEGER REFERENCES orders(id),
    sale_id INTEGER REFERENCES sales(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Bill-wise settlement used to tie a payment/receipt only to a free-typed
  // ref_name string matched against a supplier/customer's invoice_no — two
  // orders sharing (or missing) an invoice number could collide or miss
  // entirely. order_id is an exact link for purchases (one order = one
  // bill); sales invoices can span several `sales` rows sharing one
  // invoice_group, so that system-generated group id is the exact link
  // there instead of a single row id.
  'ALTER TABLE journal_bill_allocs ADD COLUMN order_id INTEGER REFERENCES orders(id)',
  'ALTER TABLE journal_bill_allocs ADD COLUMN sale_invoice_group TEXT',
  // A Gate In vehicle weighed Tare-only (arriving empty, before its Gross
  // comes later at Gate Out) can be flagged so it surfaces in Gate Out's own
  // "Awaiting Gross" picker instead of only sitting in Gate In's queue.
  'ALTER TABLE gate_entries ADD COLUMN awaiting_gross_out INTEGER NOT NULL DEFAULT 0',
  // Whether a supplier/transporter's business is Trading or Manufacturing.
  // The DEFAULT backfills every existing row to Manufacturing (the historical
  // assumption); new rows can choose either from here on.
  "ALTER TABLE suppliers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'Manufacturing'",
  "ALTER TABLE customers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'Manufacturing'",
  // A packed SKU that does not pack one of the finished products (product_id)
  // can instead carry a short product name typed by hand. Exactly one of the
  // two is used — the linked product's name wins when both are set.
  'ALTER TABLE packagings ADD COLUMN product_label TEXT',
  // A trading deal buys across several purchase invoices and sells across
  // several sale invoices, so its orders/sales are listed here rather than in
  // the single trading_deals.order_id / sale_id pair. Those two columns stay
  // as they are and still point at the deal's first invoice on each side, so
  // deals booked before this — which have no rows here at all — keep reading
  // and deleting exactly as they did.
  `CREATE TABLE IF NOT EXISTS trading_deal_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES trading_deals(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    line_no INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS trading_deal_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES trading_deals(id),
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    line_no INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tdo_deal ON trading_deal_orders(deal_id)',
  'CREATE INDEX IF NOT EXISTS idx_tds_deal ON trading_deal_sales(deal_id)',
  // TDS the customer withholds on a sale invoice, mirroring the purchase side.
  // Defaults to 0, so every sale booked before this — and every sale that
  // never sets a rate — keeps exactly the receivable it already had.
  'ALTER TABLE sales ADD COLUMN tds_pct REAL NOT NULL DEFAULT 0',
  'ALTER TABLE sales ADD COLUMN tds_amount REAL NOT NULL DEFAULT 0',
  // A refining recipe is not only what goes in: by-product and loss
  // percentages are struck on the CPO going IN, not the RPO coming out — 5.7%
  // fatty acid + 1% dead loss means 6.7% of the input never becomes product,
  // so 100 MT of RPO actually takes 100/0.933 = 107.18 MT of CPO (see
  // recipeTor() in production.ts), not 106.7. Each line now says which kind it
  // is — 'input' is consumed, 'output' is a by-product that lands in stock,
  // 'loss' is written off. Everything already recorded is an input, which is
  // exactly what the default leaves it as.
  "ALTER TABLE formulation_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'input'",
  "ALTER TABLE production_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'input'",
  // A challan that gives no quantity is a real answer, and a different one
  // from "nobody has filled this in yet" — the gate records it as NA so the
  // shortage column knows there is nothing to compare the weighed net against.
  'ALTER TABLE gate_entries ADD COLUMN dispatch_na INTEGER NOT NULL DEFAULT 0',
  // A vehicle taken in empty and weighed out loaded made two movements on
  // one record. entry_date is when it arrived; this is the day it left, so
  // the register can show both rather than only the one it started as.
  'ALTER TABLE gate_entries ADD COLUMN out_date TEXT',
  // A repayment covering more than the LC's own open amount is covering bank
  // charges too — split so the two kinds of charge post to their own ledger
  // accounts instead of one generic bucket. maturity_charges (their sum)
  // stays in sync for bank-reconciliation matching, which already reads it.
  'ALTER TABLE lc_repayments ADD COLUMN comm_charges REAL NOT NULL DEFAULT 0',
  'ALTER TABLE lc_repayments ADD COLUMN bank_charges REAL NOT NULL DEFAULT 0',
  // Pre-closure: the LC is wound up before its bills/maturity would naturally
  // settle it. Interest is recalculated over the days actually elapsed
  // (open date -> preclose date) rather than the full planned usance, and
  // whatever's left of the open amount either comes back to us or covers a
  // remaining balance still owed to the party — the user picks which.
  "ALTER TABLE letters_of_credit ADD COLUMN preclosed_date TEXT",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_settlement_direction TEXT",
  'ALTER TABLE letters_of_credit ADD COLUMN preclose_settlement_amount REAL',
  'ALTER TABLE letters_of_credit ADD COLUMN preclose_journal_entry_id INTEGER',
  // Overall LC facility limit per company — Fixed (always on) plus an
  // optional Convertible top-up — separate from any one LC's own open
  // amount, so the book as a whole can be tracked against what the bank has
  // actually sanctioned across every LC together.
  `CREATE TABLE IF NOT EXISTS lc_limits (
    company_id INTEGER PRIMARY KEY,
    fixed_limit REAL NOT NULL DEFAULT 0,
    convertible_limit REAL NOT NULL DEFAULT 0,
    convertible_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Some parties (e.g. Bunge-style deals) pay LC interest upfront straight
  // from the bank account instead of it coming out of the open amount — the
  // Open Amount then equals what the supplier actually receives, and interest
  // is calculated for reference only, posted later when its own bank
  // statement line is reconciled (see bankRecon.ts's 'lc_interest' link).
  'ALTER TABLE letters_of_credit ADD COLUMN interest_upfront INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE letters_of_credit ADD COLUMN interest_journal_entry_id INTEGER',
  // Premature-closure interest: the days between preclose and the LC's
  // original maturity that never happen still carry an interest cost. Stored
  // for record regardless of route; only routed to the bank does it get its
  // own deferred posting (see bankRecon.ts's 'lc_preclose_interest' link) —
  // routed to the party, it's already netted into preclose_settlement_amount.
  'ALTER TABLE letters_of_credit ADD COLUMN preclose_premature_interest REAL',
  'ALTER TABLE letters_of_credit ADD COLUMN preclose_interest_route TEXT',
  'ALTER TABLE letters_of_credit ADD COLUMN preclose_interest_journal_entry_id INTEGER',
  // A Trading LC finances one round trip — buy from the supplier, resell to
  // the customer — so it's struck against the whole deal, not a bare purchase
  // invoice. NULL until an LC picks this deal; a deal can only back one LC at
  // a time.
  'ALTER TABLE trading_deals ADD COLUMN lc_id INTEGER REFERENCES letters_of_credit(id)',
  // A by-product line's own % of input can be auto-calculated instead of
  // typed by hand — e.g. Fatty Acid = Oil FFA% x (1 + loss multiplier%) +
  // moisture loss%. The three inputs are kept alongside the computed qty so
  // the recipe stays auditable (why it's 5.7%, not just that it is).
  'ALTER TABLE formulation_items ADD COLUMN auto_calc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE formulation_items ADD COLUMN ffa_pct REAL',
  'ALTER TABLE formulation_items ADD COLUMN loss_multiplier_pct REAL',
  'ALTER TABLE formulation_items ADD COLUMN moisture_pct REAL',
  // An INPUT line's own auto-calc goes one step further than a by-product's:
  // a blended recipe (several raw oils, each its own quality) needs its own
  // TOR multiplier per ingredient — 1/(1 - fatty acid% - dead loss%) — rather
  // than one loss shared across the whole blend. Dead loss is the recipe's
  // own shared 'loss' line total (always present, same for every input), not
  // a per-input value — this column shipped briefly but is unused now.
  'ALTER TABLE formulation_items ADD COLUMN dead_loss_pct REAL',
  // The fatty acid an auto-calculated input line throws off is a REAL
  // by-product, not just a yield reduction — it lands in stock under
  // whichever product this names, summed across every input that names the
  // same one. NULL means this input's own fatty acid isn't tracked as stock.
  'ALTER TABLE formulation_items ADD COLUMN byproduct_product_id INTEGER REFERENCES products(id)',
  // A gate entry that will never be completed — the tanker it was cut for
  // never took delivery (party refused, redirected elsewhere) — gets marked
  // Rejected with a reason, rather than deleted outright or left stuck
  // forever in "Pending weight". Keeps the paper trail; any stock/invoice
  // correction (a Credit Note, say) is handled separately, on purpose.
  'ALTER TABLE gate_entries ADD COLUMN rejected_at TEXT',
  'ALTER TABLE gate_entries ADD COLUMN rejected_reason TEXT',
  // The round trip's last leg: the customer's payment for the resale actually
  // lands, closing a Trading LC out — Application -> Open -> Payment received
  // -> Preclose/Repayment -> Payment IN. Distinct from payment_received_date
  // (that's the BANK paying the SUPPLIER; this is the CUSTOMER paying US). A
  // deal's sale side can be paid across more than one receipt (a part-payment,
  // or one per invoice on a multi-invoice deal), so — like lc_repayments —
  // this is its own table rather than a single scalar on the LC; "closed"
  // itself is computed live from what's still outstanding, not stored here.
  `CREATE TABLE IF NOT EXISTS lc_payment_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lc_id INTEGER NOT NULL REFERENCES letters_of_credit(id),
    pay_date TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    journal_entry_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_lc_payment_ins_lc ON lc_payment_ins(lc_id)',
  // A sale invoice the customer refused to accept before it ever left through
  // the gate (or was turned back before unloading) — marked Rejected with a
  // reason rather than deleted, same reasoning as gate_entries above: the
  // invoice stays on record for GST/audit, and a Credit Note against it is
  // the actual correction, done separately. Applies to every line row sharing
  // the invoice_group, since that's the unit every other invoice-level action
  // (setInvoiceStage, deleteSaleInvoice) already operates on.
  'ALTER TABLE sales ADD COLUMN rejected_at TEXT',
  'ALTER TABLE sales ADD COLUMN rejected_reason TEXT',
  // A product can have more than one formulation (e.g. RPO's CPO-based recipe
  // and its SHEA-based one) — recording which one a run actually used, so the
  // consumption behind a past production entry can always be traced back to
  // the exact recipe, even after a newer one is added for the same product.
  'ALTER TABLE production ADD COLUMN formulation_id INTEGER REFERENCES formulations(id)',
  // The bank's interest and charges come out of an LC's open amount BEFORE the
  // beneficiary is paid, so a bill issued for the gross overpays the party on
  // paper. When interest/charges are later revised the shortfall moves with
  // them, so it is corrected by its own re-postable voucher (Dr Bank / Cr the
  // party, allocated On Account) rather than by rewriting the original
  // settlement — the payment that actually happened stays on the record and
  // the correction sits beside it.
  'ALTER TABLE letters_of_credit ADD COLUMN fee_adjust_journal_entry_id INTEGER',
  // OUR OWN bank accounts — the ones money actually moves out of for LC
  // repayments and other transactions. Deliberately NOT the same thing as an
  // LC's discounting bank (letters_of_credit.bank), which is the institution
  // that FINANCES the LC and is somebody else's bank, not ours.
  `CREATE TABLE IF NOT EXISTS banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    branch TEXT,
    account_no TEXT,
    ifsc TEXT,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_banks_name ON banks(name)',
  // Superseded by our_bank_id below: this briefly held the DISCOUNTING bank,
  // which does not belong in our own-accounts master. Left in place unused
  // rather than dropped, since dropping a referenced column is not worth the
  // risk for a column nothing now reads.
  'ALTER TABLE letters_of_credit ADD COLUMN bank_id INTEGER REFERENCES banks(id)',
  // Which of OUR accounts this LC's money moves through — the one a repayment
  // goes out of. The financing side stays on `bank` (the discounting bank).
  'ALTER TABLE letters_of_credit ADD COLUMN our_bank_id INTEGER REFERENCES banks(id)',
  'CREATE INDEX IF NOT EXISTS idx_lc_our_bank ON letters_of_credit(our_bank_id)',
  // Each bank sanctions its own LC limit, per company — the single company-wide
  // figure lc_limits held can't express "how much of THIS bank's line is used"
  // once there is more than one bank. lc_limits is left in place untouched; the
  // rows it held are copied across by backfillBankMaster() below.
  `CREATE TABLE IF NOT EXISTS bank_lc_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    bank_id INTEGER NOT NULL REFERENCES banks(id),
    fixed_limit REAL NOT NULL DEFAULT 0,
    convertible_limit REAL NOT NULL DEFAULT 0,
    convertible_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_lc_limits ON bank_lc_limits(company_id, bank_id)',
  // A bank ACCOUNT belongs to one company's books, not to the business in
  // general — the SAME real-world bank used by two companies gets its own
  // separate row per company, same as any other company-scoped record. The
  // one bank that existed before this (shared, used by both companies) is
  // left as-is here; splitting its existing links is a data fix, not schema.
  'ALTER TABLE banks ADD COLUMN company_id INTEGER REFERENCES companies(id)',
  'DROP INDEX IF EXISTS idx_banks_name',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_banks_company_name ON banks(company_id, name)',
  // A per-bargain override on an invoice that spans more than one bargain —
  // each bargain's own additional interest (₹/unit) and its own interest
  // days, added straight into THAT bargain's line instead of one shared
  // figure applied to every line alike. Absent for a bargain means it just
  // inherits the invoice's shared additional interest / interest days.
  `CREATE TABLE IF NOT EXISTS order_bargain_interest (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    bargain_id INTEGER NOT NULL REFERENCES bargains(id),
    additional_interest REAL NOT NULL DEFAULT 0,
    interest_days INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_order_bargain_interest ON order_bargain_interest(order_id, bargain_id)',
  // A Trading party can be the same real-world PAN as an existing
  // Manufacturing party, entered as its own row so a trading deal never mixes
  // with the manufacturing relationship's bargains/tankers. Linking the two
  // means the TDS slab (which the law applies per PAN, not per row) sums
  // both rows' taxable value together instead of quietly restarting the
  // slab at zero for whichever row a given invoice happens to sit under.
  'ALTER TABLE suppliers ADD COLUMN linked_party_id INTEGER REFERENCES suppliers(id)',
  'ALTER TABLE customers ADD COLUMN linked_party_id INTEGER REFERENCES customers(id)',
  // Bill Discounting replaces the old party+entries tracker (bd_parties /
  // bd_entries — both confirmed empty) with one LC-style record per bill,
  // plus a proper NBFC master. Both old tables are dropped outright.
  // A tanker's EX/DLD condition, as chosen per tanker when it's sent to the
  // supplier. The picker for this already existed on that dialog but the value
  // was thrown away on save, so freight and the shortage penalty always fell
  // back to the bargain's own type — silently ignoring the choice. NULL means
  // "not overridden", which keeps every existing tanker reading from its
  // bargain exactly as before.
  'ALTER TABLE purchase_tankers ADD COLUMN condition TEXT',
  // Whether the round off on this invoice was typed by hand. Previously the
  // form inferred it from "the stored value isn't zero", which froze a figure
  // that was correct for the OLD totals the moment anything else was edited —
  // so the invoice total quietly stopped landing on a whole rupee. Recording
  // the intent explicitly means auto can keep itself right while a genuine
  // manual override is respected AND visible as one.
  'ALTER TABLE sales ADD COLUMN round_off_manual INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN round_off_manual INTEGER NOT NULL DEFAULT 0',
  'DROP TABLE IF EXISTS bd_entries',
  'DROP TABLE IF EXISTS bd_parties',
  `CREATE TABLE IF NOT EXISTS nbfcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    finance_type TEXT NOT NULL DEFAULT 'BOTH',
    tds_pct REAL NOT NULL DEFAULT 0,
    interest_pct REAL NOT NULL DEFAULT 0,
    interest_days REAL NOT NULL DEFAULT 0,
    days_year REAL NOT NULL DEFAULT 360,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bill_discountings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    bd_no TEXT,
    nbfc_id INTEGER REFERENCES nbfcs(id),
    finance_type TEXT NOT NULL DEFAULT 'PID',
    party_type TEXT NOT NULL DEFAULT 'supplier',
    party_id INTEGER,
    purpose TEXT NOT NULL DEFAULT 'manufacturing',
    amount REAL NOT NULL DEFAULT 0,
    payment_received_date TEXT,
    maturity_date TEXT,
    margin_pct REAL NOT NULL DEFAULT 0,
    interest_pct REAL NOT NULL DEFAULT 0,
    tds_pct REAL NOT NULL DEFAULT 0,
    interest_upfront INTEGER NOT NULL DEFAULT 0,
    days_year REAL NOT NULL DEFAULT 360,
    status TEXT NOT NULL DEFAULT 'open',
    repaid_date TEXT,
    repaid_amount REAL,
    journal_entry_id INTEGER,
    repay_journal_entry_id INTEGER,
    margin_release_journal_entry_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`
,
  // Bill discounting counts interest on a 360-day year, not 365 — the
  // convention the mill's own working sheet uses. Kept per record (with an
  // NBFC-level default) rather than hard-coded, since it is a term that is
  // negotiated like the rate is.
  'ALTER TABLE bill_discountings ADD COLUMN days_year REAL NOT NULL DEFAULT 360',
  'ALTER TABLE nbfcs ADD COLUMN days_year REAL NOT NULL DEFAULT 360'
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
