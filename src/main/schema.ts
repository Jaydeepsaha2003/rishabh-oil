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

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'raw',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS formulations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT,
  uom TEXT DEFAULT 'ton',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS formulation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  formulation_id INTEGER NOT NULL REFERENCES formulations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS production (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prod_date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0,
  uom TEXT DEFAULT 'ton',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_id INTEGER NOT NULL REFERENCES production(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_bargains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bargain_no TEXT,
  bargain_date TEXT NOT NULL,
  customer TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 0,
  uom TEXT DEFAULT 'ton',
  rate REAL DEFAULT 0,
  rate_expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_date TEXT NOT NULL,
  invoice_no TEXT,
  customer TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  sales_bargain_id INTEGER REFERENCES sales_bargains(id),
  qty REAL NOT NULL DEFAULT 0,
  uom TEXT DEFAULT 'ton',
  rate REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_type TEXT,
  gstin TEXT,
  state TEXT,
  gst_pct REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  tds_threshold REAL NOT NULL DEFAULT 0,
  tds_pct_above REAL NOT NULL DEFAULT 0,
  tds_above_only INTEGER NOT NULL DEFAULT 0,
  credit_period_days INTEGER NOT NULL DEFAULT 0,
  adds_interest INTEGER NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_type TEXT,
  gstin TEXT,
  state TEXT,
  gst_pct REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  tds_threshold REAL NOT NULL DEFAULT 0,
  tds_above_only INTEGER NOT NULL DEFAULT 0,
  adds_interest INTEGER NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days INTEGER NOT NULL DEFAULT 0,
  credit_period_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_type TEXT,
  contact TEXT,
  gst_pct REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  tds_threshold REAL NOT NULL DEFAULT 0,
  tds_pct_above REAL NOT NULL DEFAULT 0,
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
  credit_interest_days REAL NOT NULL DEFAULT 0,
  credit_interest_amount REAL NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  ip TEXT,
  last_seen TEXT,
  UNIQUE(user_id, ip)
);

CREATE TABLE IF NOT EXISTS ip_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE,
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS user_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  ip TEXT,
  action TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bargains_supplier ON bargains(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('allowed_shortage_pct', '0.2');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_uom', 'ton');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('log_retention_days', '30');
`
