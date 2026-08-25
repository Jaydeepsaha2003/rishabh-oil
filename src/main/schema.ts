// Database schema for the procurement (purchase) module.
// Statements are idempotent (IF NOT EXISTS) so this can run safely on every startup.
// NOTE: keep statements free of embedded semicolons — initDb splits on ';'.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oil_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS uoms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  supplier_type TEXT,
  company_type TEXT,
  business_type TEXT NOT NULL DEFAULT 'Manufacturing',
  linked_party_id INTEGER REFERENCES suppliers(id),
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
  opening_purchase_amount REAL NOT NULL DEFAULT 0,
  opening_purchase_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_type TEXT,
  business_type TEXT NOT NULL DEFAULT 'Manufacturing',
  linked_party_id INTEGER REFERENCES customers(id),
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

CREATE TABLE IF NOT EXISTS brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  brokerage_pct REAL NOT NULL DEFAULT 0,
  address TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bargains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bargain_no TEXT NOT NULL UNIQUE,
  bargain_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  broker_id INTEGER REFERENCES brokers(id),
  oil_type_id INTEGER NOT NULL REFERENCES oil_types(id),
  bargain_type TEXT NOT NULL DEFAULT 'EX',
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
  bargain_type TEXT NOT NULL DEFAULT 'EX',
  ordered_qty REAL NOT NULL,
  uom TEXT NOT NULL DEFAULT 'ton',
  bargain_rate REAL NOT NULL DEFAULT 0,
  invoice_rate REAL NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days INTEGER NOT NULL DEFAULT 0,
  adjusted_rate REAL NOT NULL DEFAULT 0,
  taxable_value REAL NOT NULL DEFAULT 0,
  gst_pct REAL NOT NULL DEFAULT 0,
  gst_type TEXT NOT NULL DEFAULT 'CGST_SGST',
  gst_amount REAL NOT NULL DEFAULT 0,
  tds_pct REAL NOT NULL DEFAULT 0,
  tds_amount REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS purchase_tankers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  tanker_no TEXT NOT NULL,
  loaded_date TEXT NOT NULL,
  bargain_id INTEGER REFERENCES bargains(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  oil_type_id INTEGER NOT NULL REFERENCES products(id),
  loaded_qty REAL NOT NULL DEFAULT 0,
  uom TEXT NOT NULL DEFAULT 'ton',
  payment_mode TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'supplier_factory',
  transit_date TEXT,
  source_id INTEGER REFERENCES sources(id),
  expected_delivery_date TEXT,
  outside_factory_date TEXT,
  inside_factory_date TEXT,
  empty_date TEXT,
  received_qty REAL,
  transporter_id INTEGER REFERENCES transporters(id),
  transport_rate_per_ton REAL DEFAULT 0,
  transport_amount REAL DEFAULT 0,
  shortage_charge_amount REAL DEFAULT 0,
  krfl_weighment_doc_no TEXT,
  krfl_weighment_photo TEXT,
  outside_weighment_doc_no TEXT,
  outside_weighment_photo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gate_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_entry_no TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  tanker_id INTEGER REFERENCES purchase_tankers(id),
  tanker_no TEXT,
  oil_type_id INTEGER REFERENCES products(id),
  dispatch_qty REAL NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0,
  uom TEXT NOT NULL DEFAULT 'MT',
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS letters_of_credit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lc_no TEXT NOT NULL,
  facility_type TEXT NOT NULL DEFAULT 'lc',
  bank TEXT NOT NULL,
  party_type TEXT,
  party_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  open_date TEXT,
  expiry_date TEXT,
  interest_pct REAL DEFAULT 0,
  charges REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The lender master for Bill Discounting — company-scoped the same way the
-- banks master is, so it can be managed through the generic EntityManager
-- rather than needing its own IPC.
CREATE TABLE IF NOT EXISTS nbfcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  finance_type TEXT NOT NULL DEFAULT 'BOTH',
  tds_pct REAL NOT NULL DEFAULT 0,
  interest_pct REAL NOT NULL DEFAULT 0,
  interest_days REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bill Discounting (PID/SID): unlike an LC, a bill is opened directly with
-- its own Payment Received and Maturity dates already known — there's no
-- application/open/payment-received stage machine, and no invoice to link.
CREATE TABLE IF NOT EXISTS bill_discountings (
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
  status TEXT NOT NULL DEFAULT 'open',
  repaid_date TEXT,
  repaid_amount REAL,
  journal_entry_id INTEGER,
  repay_journal_entry_id INTEGER,
  margin_release_journal_entry_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bd_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
  repay_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  settle_via TEXT NOT NULL DEFAULT 'bank',
  ref TEXT,
  journal_entry_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lc_issuances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lc_id INTEGER NOT NULL REFERENCES letters_of_credit(id),
  issue_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  order_id INTEGER REFERENCES orders(id),
  bill_no TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  acc_group TEXT NOT NULL DEFAULT 'General',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  vch_type TEXT NOT NULL,
  vch_no TEXT,
  narration TEXT,
  order_id INTEGER,
  sale_id INTEGER,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  dr REAL NOT NULL DEFAULT 0,
  cr REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);

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

CREATE TABLE IF NOT EXISTS customer_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id),
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
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  book_qty REAL NOT NULL DEFAULT 0,
  actual_qty REAL NOT NULL DEFAULT 0,
  actual_value REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(count_date, product_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_supplier ON orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_tankers_order ON purchase_tankers(order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_tankers_status ON purchase_tankers(status);

INSERT OR IGNORE INTO companies (id, name) VALUES (1, 'RISHABH OIL');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('allowed_shortage_pct', '0.2');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_uom', 'MT');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('log_retention_days', '30');
INSERT OR IGNORE INTO uoms (name) VALUES ('MT'), ('TON'), ('KG'), ('LTR'), ('QUINTAL');
`
