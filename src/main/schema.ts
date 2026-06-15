// Database schema for the procurement (purchase) module.
// Statements are idempotent (IF NOT EXISTS) so this can run safely on every startup.
// NOTE: keep statements free of embedded semicolons — initDb splits on ';'.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS oil_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_type TEXT,
  gstin TEXT,
  state TEXT,
  gst_pct REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  credit_period_days INTEGER NOT NULL DEFAULT 0,
  adds_interest INTEGER NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  default_rate_per_ton REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  transit_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bargains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bargain_no TEXT NOT NULL UNIQUE,
  bargain_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  oil_type_id INTEGER NOT NULL REFERENCES oil_types(id),
  bargain_type TEXT NOT NULL DEFAULT 'Ex',
  qty REAL NOT NULL,
  opening_qty REAL,
  uom TEXT NOT NULL DEFAULT 'ton',
  base_rate REAL NOT NULL DEFAULT 0,
  duty REAL NOT NULL DEFAULT 0,
  rate_per_uom REAL NOT NULL,
  allowed_shortage_pct REAL,
  rate_expiry_date TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL,
  order_date TEXT NOT NULL,
  bargain_id INTEGER REFERENCES bargains(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  oil_type_id INTEGER NOT NULL REFERENCES oil_types(id),
  bargain_type TEXT NOT NULL DEFAULT 'Ex',
  ordered_qty REAL NOT NULL,
  uom TEXT NOT NULL DEFAULT 'ton',
  bargain_rate REAL NOT NULL DEFAULT 0,
  invoice_rate REAL NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days INTEGER NOT NULL DEFAULT 0,
  adjusted_rate REAL NOT NULL DEFAULT 0,
  taxable_value REAL NOT NULL DEFAULT 0,
  gst_pct REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  tds_amount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ordered',
  loaded_date TEXT,
  source_id INTEGER REFERENCES sources(id),
  expected_delivery_date TEXT,
  delivered_date TEXT,
  received_qty REAL,
  transporter_id INTEGER REFERENCES transporters(id),
  transport_rate_per_ton REAL DEFAULT 0,
  transport_amount REAL DEFAULT 0,
  allowed_shortage_pct REAL DEFAULT 0,
  allowed_shortage_qty REAL DEFAULT 0,
  actual_shortage_qty REAL DEFAULT 0,
  excess_shortage_qty REAL DEFAULT 0,
  shortage_charge_amount REAL DEFAULT 0,
  is_registered_transporter INTEGER NOT NULL DEFAULT 1,
  tanker_no TEXT,
  posting INTEGER NOT NULL DEFAULT 0,
  final_taxable_value REAL DEFAULT 0,
  final_gst_amount REAL DEFAULT 0,
  final_tds_amount REAL DEFAULT 0,
  final_net_amount REAL DEFAULT 0,
  port_entry_date TEXT,
  payment_cleared_date TEXT,
  financed_by_party INTEGER NOT NULL DEFAULT 0,
  dispatch_date TEXT,
  outside_factory_date TEXT,
  inside_factory_date TEXT,
  received_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  order_id INTEGER REFERENCES orders(id),
  payment_id INTEGER,
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS transporter_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transporter_id INTEGER NOT NULL REFERENCES transporters(id),
  order_id INTEGER REFERENCES orders(id),
  payment_id INTEGER,
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_type TEXT NOT NULL,
  party_id INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT,
  method TEXT NOT NULL DEFAULT 'on_account',
  is_advance INTEGER NOT NULL DEFAULT 0,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS bill_discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id),
  party_name TEXT,
  medium TEXT,
  lc_open_amount REAL DEFAULT 0,
  open_date TEXT,
  maturity_date TEXT,
  payment_received_date TEXT,
  disc_bank TEXT,
  bill_nos TEXT,
  amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  active INTEGER NOT NULL DEFAULT 1,
  permissions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bargains_supplier ON bargains(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('allowed_shortage_pct', '0.2');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_uom', 'ton');
`
