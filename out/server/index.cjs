var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key3 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key3) && key3 !== except)
        __defProp(to, key3, { get: () => from[key3], enumerable: !(desc = __getOwnPropDesc(from, key3)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/server/index.ts
var import_node_path5 = require("node:path");

// src/main/db.ts
var import_web = require("@libsql/client");

// src/main/schema.ts
var SCHEMA_SQL = `
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

-- The lender master for Bill Discounting \u2014 company-scoped the same way the
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
-- its own Payment Received and Maturity dates already known \u2014 there's no
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
  invoice_amount REAL,
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
`;

// src/server/electron-shim.ts
var import_node_path = require("node:path");
var import_node_fs = require("node:fs");
var handlers = /* @__PURE__ */ new Map();
var ipcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn);
  },
  removeHandler(channel) {
    handlers.delete(channel);
  },
  on() {
  }
};
var dataDir = process.env.DATA_DIR || (0, import_node_path.join)(process.cwd(), ".server-data");
var app = {
  getPath(name) {
    const dir = name === "userData" ? dataDir : (0, import_node_path.join)(dataDir, name);
    try {
      (0, import_node_fs.mkdirSync)(dir, { recursive: true });
    } catch {
    }
    return dir;
  },
  getVersion() {
    return process.env.APP_VERSION || "0.0.0-web";
  },
  getName() {
    return "rishabh-oil-web";
  },
  whenReady() {
    return Promise.resolve();
  },
  on() {
  },
  quit() {
  },
  isPackaged: true
};
var notOnTheWeb = (what) => () => {
  throw new Error(`${what} is only available in the desktop app`);
};
var shell = {
  openExternal: notOnTheWeb("Opening a link from the server"),
  openPath: notOnTheWeb("Opening a file on the server"),
  showItemInFolder: notOnTheWeb("Showing a file on the server")
};
var dialog = {
  showOpenDialog: notOnTheWeb("Choosing a file from the server"),
  showSaveDialog: notOnTheWeb("Saving a file from the server"),
  showMessageBox: notOnTheWeb("A message box")
};

// src/main/config.ts
var import_fs = require("fs");
var import_path = require("path");
function configPath() {
  return (0, import_path.join)(app.getPath("userData"), "rishabh-oil-config.json");
}
function getStoredConfig() {
  try {
    const p = configPath();
    if (!(0, import_fs.existsSync)(p)) return {};
    return JSON.parse((0, import_fs.readFileSync)(p, "utf-8"));
  } catch {
    return {};
  }
}
function saveStoredConfig(url, authToken) {
  const p = configPath();
  (0, import_fs.mkdirSync)((0, import_path.dirname)(p), { recursive: true });
  (0, import_fs.writeFileSync)(p, JSON.stringify({ url, authToken }, null, 2), "utf-8");
}

// src/main/db.ts
var client = null;
function getConfiguredUrl() {
  return getStoredConfig().url || process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || "";
}
function resetClient() {
  client = null;
}
function todayISO() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadEnv() {
  try {
    const proc = process;
    proc.loadEnvFile?.();
  } catch {
  }
}
function isStaleStream(e) {
  const err = e;
  if (!err || err.code !== "SERVER_ERROR") return false;
  const status = Number(err.cause?.status);
  return status === 400 || status === 404;
}
function withStreamRecovery(raw) {
  const methods = ["execute", "batch", "executeMultiple", "migrate"];
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !methods.includes(prop)) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } catch (e) {
          if (!isStaleStream(e)) throw e;
          console.warn(`[db] stale stream on ${String(prop)} \u2014 reopening and retrying once`);
          client = null;
          const fresh = getClient();
          const fn = Reflect.get(fresh, prop);
          return await fn.apply(fresh, args);
        }
      };
    }
  });
}
function getClient() {
  if (client) return client;
  loadEnv();
  const stored = getStoredConfig();
  const url = stored.url || process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL;
  const authToken = stored.authToken || process.env.MAIN_VITE_TURSO_AUTH_TOKEN || process.env.MAIN_VITE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error("Turso database URL is not set \u2014 enter it in the setup screen.");
  }
  client = withStreamRecovery((0, import_web.createClient)({ url, authToken }));
  return client;
}
var MIGRATIONS = [
  "ALTER TABLE bargains ADD COLUMN opening_qty REAL",
  "ALTER TABLE bargains ADD COLUMN base_rate REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bargains ADD COLUMN duty REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bargains ADD COLUMN allowed_shortage_pct REAL",
  "ALTER TABLE orders ADD COLUMN is_registered_transporter INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE orders ADD COLUMN tanker_no TEXT",
  "ALTER TABLE orders ADD COLUMN posting INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN final_taxable_value REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN final_gst_amount REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN final_tds_amount REAL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN final_net_amount REAL DEFAULT 0",
  "ALTER TABLE supplier_ledger ADD COLUMN payment_id INTEGER",
  "ALTER TABLE transporter_ledger ADD COLUMN payment_id INTEGER",
  "ALTER TABLE users ADD COLUMN permissions TEXT",
  "ALTER TABLE transporters ADD COLUMN company_type TEXT",
  "ALTER TABLE transporters ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE transporters ADD COLUMN tds_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE transporters ADD COLUMN tds_threshold REAL NOT NULL DEFAULT 0",
  "ALTER TABLE transporters ADD COLUMN tds_pct_above REAL NOT NULL DEFAULT 0",
  "ALTER TABLE suppliers ADD COLUMN tds_threshold REAL NOT NULL DEFAULT 0",
  "ALTER TABLE suppliers ADD COLUMN tds_pct_above REAL NOT NULL DEFAULT 0",
  "ALTER TABLE suppliers ADD COLUMN tds_above_only INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN port_entry_date TEXT",
  "ALTER TABLE orders ADD COLUMN payment_cleared_date TEXT",
  "ALTER TABLE orders ADD COLUMN financed_by_party INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN dispatch_date TEXT",
  "ALTER TABLE orders ADD COLUMN outside_factory_date TEXT",
  "ALTER TABLE orders ADD COLUMN inside_factory_date TEXT",
  "ALTER TABLE orders ADD COLUMN received_date TEXT",
  "ALTER TABLE orders ADD COLUMN credit_interest_days REAL NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN credit_interest_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN sales_bargain_id INTEGER",
  "ALTER TABLE sales ADD COLUMN customer_id INTEGER",
  "ALTER TABLE payment_allocations ADD COLUMN sale_id INTEGER",
  // bargains/orders keep a legacy oil_types FK; mirror products so it is satisfied.
  `INSERT OR IGNORE INTO oil_types (id, code, name, active)
     SELECT id, COALESCE(code, name, 'GEN'), COALESCE(name, code, 'PRODUCT'), 1 FROM products`,
  // default UOM switched from ton to MT
  "UPDATE app_settings SET value = 'MT' WHERE key = 'default_uom' AND value = 'ton'",
  "ALTER TABLE suppliers ADD COLUMN supplier_type TEXT",
  "ALTER TABLE orders ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  "ALTER TABLE gate_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
  "ALTER TABLE bargains ADD COLUMN broker_id INTEGER",
  "ALTER TABLE orders ADD COLUMN round_off REAL NOT NULL DEFAULT 0",
  // multi-company: every business document belongs to a company (masters and
  // gate entries stay shared). Existing data lands in company 1.
  "ALTER TABLE bargains ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE orders ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE purchase_tankers ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE sales ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE sales_bargains ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE production ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE payments ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE bill_discounts ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE letters_of_credit ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE journal_entries ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  // Free-text remarks on bargains and purchase invoices.
  "ALTER TABLE bargains ADD COLUMN remarks TEXT",
  "ALTER TABLE orders ADD COLUMN remarks TEXT",
  // Invoice rate above bargain rate = freight billed by the supplier: the
  // difference is kept as per-ton freight data but NO transporter ledger posts.
  "ALTER TABLE orders ADD COLUMN freight_paid_to_supplier INTEGER NOT NULL DEFAULT 0",
  // Consignment purchase: goods were already at our site (no tanker movement,
  // no transporter, booked straight to received) — drawn from consignment stock.
  "ALTER TABLE orders ADD COLUMN is_consignment INTEGER NOT NULL DEFAULT 0",
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
  "ALTER TABLE sales_bargains ADD COLUMN packaging_id INTEGER",
  "ALTER TABLE sales_bargains ADD COLUMN freight_term TEXT NOT NULL DEFAULT 'FREIGHT_ON_GOODS'",
  // Each sale can override the bargain's type/freight; PACKED stores boxes +
  // loose pouches, DLD stores the transporter and freight.
  "ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'LOOSE'",
  "ALTER TABLE sales ADD COLUMN packaging_id INTEGER",
  "ALTER TABLE sales ADD COLUMN boxes REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN pouches REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN freight_term TEXT NOT NULL DEFAULT 'FREIGHT_ON_GOODS'",
  "ALTER TABLE sales ADD COLUMN transporter_id INTEGER",
  "ALTER TABLE sales ADD COLUMN transport_rate REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN transport_amount REAL NOT NULL DEFAULT 0",
  // Sale-linked freight lives in the transporter ledger (DLD deliveries).
  "ALTER TABLE transporter_ledger ADD COLUMN sale_id INTEGER",
  // Packaging SKUs: capture the unit size in its natural unit (KG/GM/L/ML);
  // base_per_pouch/base_uom are derived from these for stock conversion.
  "ALTER TABLE packagings ADD COLUMN unit_size REAL NOT NULL DEFAULT 0",
  "ALTER TABLE packagings ADD COLUMN unit_uom TEXT NOT NULL DEFAULT 'KG'",
  // Output GST on sales (bargain carries the default rate; the sale stores the
  // rate applied and the computed amount).
  "ALTER TABLE sales_bargains ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales_bargains ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  // Link the sales bargain to the customer master by id, so renaming a customer
  // reflects everywhere (the stored name is kept only as a fallback label).
  "ALTER TABLE sales_bargains ADD COLUMN customer_id INTEGER",
  "ALTER TABLE sales ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN gst_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN gst_type TEXT NOT NULL DEFAULT 'CGST_SGST'",
  // Three-stage dispatch tracking for sales (loaded → transit → unloaded),
  // mirroring purchase tankers. Any of the three means the goods have left the
  // factory (status 'done'); 'pending' = not yet dispatched. Existing fulfilled
  // sales are treated as already unloaded/delivered.
  "ALTER TABLE sales ADD COLUMN dispatch_stage TEXT",
  "UPDATE sales SET dispatch_stage = 'unloaded' WHERE status = 'done' AND dispatch_stage IS NULL",
  // Allow dispatching a sale without booking stock (off-stock / untracked) after
  // an explicit confirmation. Such a sale does not draw from or affect stock.
  "ALTER TABLE sales ADD COLUMN track_stock INTEGER NOT NULL DEFAULT 1",
  // Date stamped at each dispatch stage (loaded → in transit → unloaded).
  "ALTER TABLE sales ADD COLUMN loaded_date TEXT",
  "ALTER TABLE sales ADD COLUMN transit_date TEXT",
  "ALTER TABLE sales ADD COLUMN unloaded_date TEXT",
  // Existing delivered sales: assume unloaded on the sale date.
  "UPDATE sales SET unloaded_date = sale_date WHERE dispatch_stage = 'unloaded' AND unloaded_date IS NULL",
  // Reverse-charge (RCM) flag for individual transporters (GTA). Informational
  // for now — freight is billed without GST and GST is self-accounted by us.
  "ALTER TABLE transporters ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0",
  // Gate OUT entries: outgoing sale dispatches tracked at the gate, alongside
  // the existing inbound (purchase tanker) entries. direction 'in' | 'out';
  // out entries link the sale being dispatched.
  "ALTER TABLE gate_entries ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'",
  "ALTER TABLE gate_entries ADD COLUMN sale_id INTEGER",
  // Receipt classification + gross/tare weighment. Net (received_qty) = gross − tare.
  "ALTER TABLE gate_entries ADD COLUMN rec_type TEXT NOT NULL DEFAULT 'OIL'",
  "ALTER TABLE gate_entries ADD COLUMN gross_weight REAL",
  "ALTER TABLE gate_entries ADD COLUMN tare_weight REAL",
  // Optional manual gate no (the physical gate-register number) — the system
  // serial (gate_entry_no) is always auto-assigned; this can be typed or blank.
  "ALTER TABLE gate_entries ADD COLUMN ref_no TEXT",
  // Multi-item sales invoices: line items share an invoice_group. Existing
  // single sales each become their own group. gate-out links the group.
  "ALTER TABLE sales ADD COLUMN invoice_group TEXT",
  "UPDATE sales SET invoice_group = 'LEGACY-' || id WHERE invoice_group IS NULL",
  "ALTER TABLE gate_entries ADD COLUMN invoice_group TEXT",
  // Direct MNC arrival: the goods belong to a direct-purchase party and never
  // travelled on one of our purchase tankers, so there is no tanker to pick —
  // the gateman types the vehicle number and names the party right here, and the
  // accountant's validation step is then only about which oil it is.
  "ALTER TABLE gate_entries ADD COLUMN supplier_id INTEGER",
  "ALTER TABLE gate_entries ADD COLUMN is_direct_mnc INTEGER NOT NULL DEFAULT 0",
  // Manual additional interest (₹ per unit) on a purchase invoice — folds into
  // the adjusted bargain rate.
  "ALTER TABLE orders ADD COLUMN additional_interest REAL NOT NULL DEFAULT 0",
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
  "ALTER TABLE user_logs ADD COLUMN company_id INTEGER",
  "ALTER TABLE user_logs ADD COLUMN entity TEXT",
  "ALTER TABLE user_logs ADD COLUMN entity_id INTEGER",
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
  "ALTER TABLE supplier_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE transporter_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE customer_ledger ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1",
  // Excess loading: qty loaded beyond the chosen bargain's balance is booked
  // against an auto-created bargain line; the split is remembered per tanker.
  "ALTER TABLE purchase_tankers ADD COLUMN extra_bargain_id INTEGER",
  "ALTER TABLE purchase_tankers ADD COLUMN extra_qty REAL NOT NULL DEFAULT 0",
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
  "ALTER TABLE suppliers ADD COLUMN opening_purchase_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE suppliers ADD COLUMN opening_purchase_date TEXT",
  // bargain condition renamed to EX/DLD
  "UPDATE bargains SET bargain_type = 'EX' WHERE bargain_type = 'Ex'",
  "UPDATE bargains SET bargain_type = 'DLD' WHERE bargain_type = 'Delivered'",
  "UPDATE orders SET bargain_type = 'EX' WHERE bargain_type = 'Ex'",
  "UPDATE orders SET bargain_type = 'DLD' WHERE bargain_type = 'Delivered'",
  "ALTER TABLE purchase_tankers ADD COLUMN krfl_weighment_doc_no TEXT",
  "ALTER TABLE purchase_tankers ADD COLUMN krfl_weighment_photo TEXT",
  "ALTER TABLE purchase_tankers ADD COLUMN outside_weighment_doc_no TEXT",
  "ALTER TABLE purchase_tankers ADD COLUMN outside_weighment_photo TEXT",
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
  "ALTER TABLE stock_counts ADD COLUMN rate REAL",
  // Links an auto-generated production run to the sale whose dispatch triggered
  // it. When a finished good that has a formulation is dispatched, we record a
  // production (consumes the recipe's raw/intermediate inputs, outputs the
  // dispatched qty) so raw stock is drawn down at dispatch. NULL = manual run.
  "ALTER TABLE production ADD COLUMN sale_id INTEGER",
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
  "ALTER TABLE sales ADD COLUMN round_off REAL NOT NULL DEFAULT 0",
  // Products get a material Category (OIL / HUSK / PACKAGING / CHEMICAL / MISC)
  // above the existing raw/intermediate/finished classification, which becomes
  // the Sub-category. The DEFAULT backfills every existing product as OIL.
  "ALTER TABLE products ADD COLUMN material_type TEXT NOT NULL DEFAULT 'OIL'",
  // A packed SKU belongs to a finished product (DALDA 15 KG TIN → DALDA), so
  // packed pieces can be reconciled in tonnage against that product's stock.
  "ALTER TABLE packagings ADD COLUMN product_id INTEGER",
  // Consignment lots now start life as a GATE ENTRY: the gateman passes the
  // tanker, the accountant validates it into consignment stock. This records
  // which gate entry a lot came from so it can't be validated twice.
  "ALTER TABLE consignment_stock ADD COLUMN gate_entry_id INTEGER",
  "ALTER TABLE consignment_stock ADD COLUMN tanker_no TEXT",
  // Which purchase invoice drew this lot (NULL = still pending booking), so the
  // purchase form can list the exact tankers waiting to be invoiced.
  "ALTER TABLE consignment_stock ADD COLUMN order_id INTEGER",
  // Per-tanker bargain allocation, mirroring purchase_tankers: one tanker can be
  // split across two bargains (extra_qty goes to extra_bargain_id).
  "ALTER TABLE consignment_stock ADD COLUMN bargain_id INTEGER",
  "ALTER TABLE consignment_stock ADD COLUMN extra_bargain_id INTEGER",
  "ALTER TABLE consignment_stock ADD COLUMN extra_qty REAL",
  // Opening balance rather than an arrival: the stock the MNC already held with
  // us when the books started, entered by hand with no gate entry behind it.
  "ALTER TABLE consignment_stock ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0",
  // The gate weighment and the allowed shortage that produced the net qty, so
  // the register can show how the figure was arrived at.
  "ALTER TABLE consignment_stock ADD COLUMN weighed_qty REAL",
  "ALTER TABLE consignment_stock ADD COLUMN shortage_pct REAL",
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
  "CREATE INDEX IF NOT EXISTS idx_sbsr_bargain ON sales_bargain_sku_rates(sales_bargain_id)",
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
  "CREATE INDEX IF NOT EXISTS idx_jba_line ON journal_bill_allocs(line_id)",
  "CREATE INDEX IF NOT EXISTS idx_jba_account ON journal_bill_allocs(account_id)",
  // Which customers buy which packed SKUs — narrows the sales-bargain rate
  // card to the SKUs that party actually trades in.
  // A gate entry can be recorded without any weighment — it completes on the
  // spot instead of waiting at the weighbridge, and carries no gate figure.
  "ALTER TABLE gate_entries ADD COLUMN no_weighment INTEGER NOT NULL DEFAULT 0",
  // A manually-entered vehicle can belong to either side of the trade.
  "ALTER TABLE gate_entries ADD COLUMN customer_id INTEGER",
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
  "ALTER TABLE customers ADD COLUMN category TEXT",
  // PP = presentation stock counted alongside the physical count.
  "ALTER TABLE stock_counts ADD COLUMN pp_qty REAL",
  "ALTER TABLE gate_entries ADD COLUMN person TEXT",
  "ALTER TABLE gate_entries ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'standard'",
  "ALTER TABLE notes ADD COLUMN against_ref TEXT",
  // Treasury: usance/margin on LCs, due-dated LC bills, and the discounting
  // economics (rate, interest, net) with the journal entries they posted.
  "ALTER TABLE letters_of_credit ADD COLUMN usance_days INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE letters_of_credit ADD COLUMN margin_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE letters_of_credit ADD COLUMN journal_entry_id INTEGER",
  "ALTER TABLE lc_issuances ADD COLUMN due_date TEXT",
  "ALTER TABLE lc_issuances ADD COLUMN status TEXT NOT NULL DEFAULT 'outstanding'",
  "ALTER TABLE lc_issuances ADD COLUMN settled_date TEXT",
  "ALTER TABLE lc_issuances ADD COLUMN journal_entry_id INTEGER",
  "ALTER TABLE bill_discounts ADD COLUMN customer_id INTEGER",
  "ALTER TABLE bill_discounts ADD COLUMN invoice_group TEXT",
  "ALTER TABLE bill_discounts ADD COLUMN rate_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bill_discounts ADD COLUMN charges REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bill_discounts ADD COLUMN interest_amount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bill_discounts ADD COLUMN net_received REAL NOT NULL DEFAULT 0",
  "ALTER TABLE bill_discounts ADD COLUMN journal_entry_id INTEGER",
  "ALTER TABLE bill_discounts ADD COLUMN realize_entry_id INTEGER",
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
  "CREATE INDEX IF NOT EXISTS idx_order_bargains_bargain ON order_bargains(bargain_id)",
  "CREATE INDEX IF NOT EXISTS idx_order_bargains_order ON order_bargains(order_id)",
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
  "ALTER TABLE suppliers ADD COLUMN skip_tanker_stages INTEGER NOT NULL DEFAULT 0",
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
  "ALTER TABLE letters_of_credit ADD COLUMN facility_id INTEGER",
  // Why the LC was opened — the notes head the LC record with its purpose, so
  // a register can be read without opening every one to remember what it was for.
  "ALTER TABLE letters_of_credit ADD COLUMN purpose TEXT",
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
  "ALTER TABLE sales_bargains ADD COLUMN manual_bargain_no TEXT",
  // Trading LCs: the purchase invoice the LC was opened against, the party the
  // sale proceeds (repayment) will come from, and a workflow status distinct
  // from the open/utilized/closed lifecycle — the notes ask for In Progress /
  // On Hold as something the user sets, separate from whether it's drawn.
  "ALTER TABLE letters_of_credit ADD COLUMN linked_order_id INTEGER",
  "ALTER TABLE letters_of_credit ADD COLUMN receivable_party_id INTEGER",
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
  "CREATE INDEX IF NOT EXISTS idx_lc_repayments_lc ON lc_repayments(lc_id)",
  // Trading purchases/sales: bought from one party and sold straight to
  // another, never actually landing in our stock — no bargain, no tanker,
  // and (the one thing nothing else already gave us) excluded from every
  // stock computation via affects_stock.
  "ALTER TABLE orders ADD COLUMN is_trading INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN affects_stock INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE sales ADD COLUMN is_trading INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN affects_stock INTEGER NOT NULL DEFAULT 1",
  // FOR (DLD) sales: by default freight is recovered from the customer on top
  // of the goods value. This flips it — freight is deducted from the invoice
  // total instead, the transporter is still paid in full by us.
  "ALTER TABLE sales ADD COLUMN deduct_freight INTEGER NOT NULL DEFAULT 0",
  // The LC's own lifecycle, as the client works it day to day — separate from
  // the internal open/utilized/closed status (still used for facility
  // headroom) and from the Trading compliance flag.
  "ALTER TABLE letters_of_credit ADD COLUMN stage TEXT NOT NULL DEFAULT 'application'",
  // The fixed deposit lodged as security for the LC — mandatory in the UI.
  "ALTER TABLE letters_of_credit ADD COLUMN fd_no TEXT",
  // Entered at the Payment received stage, alongside maturity date — usance
  // days (relabeled Interest days) is then calculated from the two rather
  // than typed by hand.
  "ALTER TABLE letters_of_credit ADD COLUMN payment_received_date TEXT",
  // open_date already carries the Application date (see the earlier
  // Open date -> Application date relabel); the LC's actual opening — a
  // later, separate step — gets its own column.
  "ALTER TABLE letters_of_credit ADD COLUMN opened_date TEXT",
  // Swapping a tanker mid-transit (accident, breakdown) keeps the same
  // purchase_tankers row — bargain/order/financials stay put — but its
  // number changes and whatever quantity was lost comes off loaded_qty, so
  // the bargain balance and the gate's later weighment both reconcile
  // against what the replacement can actually still deliver.
  "ALTER TABLE purchase_tankers ADD COLUMN loss_qty REAL NOT NULL DEFAULT 0",
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
  "CREATE INDEX IF NOT EXISTS idx_tanker_replacements_tanker ON tanker_replacements(tanker_id)",
  // Which of the party's open invoices this LC covers — one LC can now cover
  // several, so it's a table rather than the single linked_order_id column.
  `CREATE TABLE IF NOT EXISTS lc_linked_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lc_id INTEGER NOT NULL REFERENCES letters_of_credit(id),
    order_id INTEGER NOT NULL REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(lc_id, order_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_lc_linked_orders_lc ON lc_linked_orders(lc_id)",
  // LC repayment is US repaying the BANK (an outflow), not the receivable
  // party paying us — the bank often deducts a variable maturity charge at
  // the same moment, debited from our account as one combined withdrawal
  // alongside the repayment itself.
  "ALTER TABLE lc_repayments ADD COLUMN maturity_charges REAL NOT NULL DEFAULT 0",
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
  "CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_import ON bank_statement_lines(import_id)",
  "CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_status ON bank_statement_lines(status)",
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
  "CREATE INDEX IF NOT EXISTS idx_bd_entries_party ON bd_entries(bd_party_id)",
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
  "ALTER TABLE journal_bill_allocs ADD COLUMN order_id INTEGER REFERENCES orders(id)",
  "ALTER TABLE journal_bill_allocs ADD COLUMN sale_invoice_group TEXT",
  // A Gate In vehicle weighed Tare-only (arriving empty, before its Gross
  // comes later at Gate Out) can be flagged so it surfaces in Gate Out's own
  // "Awaiting Gross" picker instead of only sitting in Gate In's queue.
  "ALTER TABLE gate_entries ADD COLUMN awaiting_gross_out INTEGER NOT NULL DEFAULT 0",
  // Whether a supplier/transporter's business is Trading or Manufacturing.
  // The DEFAULT backfills every existing row to Manufacturing (the historical
  // assumption); new rows can choose either from here on.
  "ALTER TABLE suppliers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'Manufacturing'",
  "ALTER TABLE customers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'Manufacturing'",
  // A packed SKU that does not pack one of the finished products (product_id)
  // can instead carry a short product name typed by hand. Exactly one of the
  // two is used — the linked product's name wins when both are set.
  "ALTER TABLE packagings ADD COLUMN product_label TEXT",
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
  "CREATE INDEX IF NOT EXISTS idx_tdo_deal ON trading_deal_orders(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_tds_deal ON trading_deal_sales(deal_id)",
  // TDS the customer withholds on a sale invoice, mirroring the purchase side.
  // Defaults to 0, so every sale booked before this — and every sale that
  // never sets a rate — keeps exactly the receivable it already had.
  "ALTER TABLE sales ADD COLUMN tds_pct REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sales ADD COLUMN tds_amount REAL NOT NULL DEFAULT 0",
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
  "ALTER TABLE gate_entries ADD COLUMN dispatch_na INTEGER NOT NULL DEFAULT 0",
  // A vehicle taken in empty and weighed out loaded made two movements on
  // one record. entry_date is when it arrived; this is the day it left, so
  // the register can show both rather than only the one it started as.
  "ALTER TABLE gate_entries ADD COLUMN out_date TEXT",
  // A repayment covering more than the LC's own open amount is covering bank
  // charges too — split so the two kinds of charge post to their own ledger
  // accounts instead of one generic bucket. maturity_charges (their sum)
  // stays in sync for bank-reconciliation matching, which already reads it.
  "ALTER TABLE lc_repayments ADD COLUMN comm_charges REAL NOT NULL DEFAULT 0",
  "ALTER TABLE lc_repayments ADD COLUMN bank_charges REAL NOT NULL DEFAULT 0",
  // Pre-closure: the LC is wound up before its bills/maturity would naturally
  // settle it. Interest is recalculated over the days actually elapsed
  // (open date -> preclose date) rather than the full planned usance, and
  // whatever's left of the open amount either comes back to us or covers a
  // remaining balance still owed to the party — the user picks which.
  "ALTER TABLE letters_of_credit ADD COLUMN preclosed_date TEXT",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_settlement_direction TEXT",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_settlement_amount REAL",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_journal_entry_id INTEGER",
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
  "ALTER TABLE letters_of_credit ADD COLUMN interest_upfront INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE letters_of_credit ADD COLUMN interest_journal_entry_id INTEGER",
  // Premature-closure interest: the days between preclose and the LC's
  // original maturity that never happen still carry an interest cost. Stored
  // for record regardless of route; only routed to the bank does it get its
  // own deferred posting (see bankRecon.ts's 'lc_preclose_interest' link) —
  // routed to the party, it's already netted into preclose_settlement_amount.
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_premature_interest REAL",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_interest_route TEXT",
  "ALTER TABLE letters_of_credit ADD COLUMN preclose_interest_journal_entry_id INTEGER",
  // A Trading LC finances one round trip — buy from the supplier, resell to
  // the customer — so it's struck against the whole deal, not a bare purchase
  // invoice. NULL until an LC picks this deal; a deal can only back one LC at
  // a time.
  "ALTER TABLE trading_deals ADD COLUMN lc_id INTEGER REFERENCES letters_of_credit(id)",
  // A by-product line's own % of input can be auto-calculated instead of
  // typed by hand — e.g. Fatty Acid = Oil FFA% x (1 + loss multiplier%) +
  // moisture loss%. The three inputs are kept alongside the computed qty so
  // the recipe stays auditable (why it's 5.7%, not just that it is).
  "ALTER TABLE formulation_items ADD COLUMN auto_calc INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE formulation_items ADD COLUMN ffa_pct REAL",
  "ALTER TABLE formulation_items ADD COLUMN loss_multiplier_pct REAL",
  "ALTER TABLE formulation_items ADD COLUMN moisture_pct REAL",
  // An INPUT line's own auto-calc goes one step further than a by-product's:
  // a blended recipe (several raw oils, each its own quality) needs its own
  // TOR multiplier per ingredient — 1/(1 - fatty acid% - dead loss%) — rather
  // than one loss shared across the whole blend. Dead loss is the recipe's
  // own shared 'loss' line total (always present, same for every input), not
  // a per-input value — this column shipped briefly but is unused now.
  "ALTER TABLE formulation_items ADD COLUMN dead_loss_pct REAL",
  // The fatty acid an auto-calculated input line throws off is a REAL
  // by-product, not just a yield reduction — it lands in stock under
  // whichever product this names, summed across every input that names the
  // same one. NULL means this input's own fatty acid isn't tracked as stock.
  "ALTER TABLE formulation_items ADD COLUMN byproduct_product_id INTEGER REFERENCES products(id)",
  // A gate entry that will never be completed — the tanker it was cut for
  // never took delivery (party refused, redirected elsewhere) — gets marked
  // Rejected with a reason, rather than deleted outright or left stuck
  // forever in "Pending weight". Keeps the paper trail; any stock/invoice
  // correction (a Credit Note, say) is handled separately, on purpose.
  "ALTER TABLE gate_entries ADD COLUMN rejected_at TEXT",
  "ALTER TABLE gate_entries ADD COLUMN rejected_reason TEXT",
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
  "CREATE INDEX IF NOT EXISTS idx_lc_payment_ins_lc ON lc_payment_ins(lc_id)",
  // A sale invoice the customer refused to accept before it ever left through
  // the gate (or was turned back before unloading) — marked Rejected with a
  // reason rather than deleted, same reasoning as gate_entries above: the
  // invoice stays on record for GST/audit, and a Credit Note against it is
  // the actual correction, done separately. Applies to every line row sharing
  // the invoice_group, since that's the unit every other invoice-level action
  // (setInvoiceStage, deleteSaleInvoice) already operates on.
  "ALTER TABLE sales ADD COLUMN rejected_at TEXT",
  "ALTER TABLE sales ADD COLUMN rejected_reason TEXT",
  // A product can have more than one formulation (e.g. RPO's CPO-based recipe
  // and its SHEA-based one) — recording which one a run actually used, so the
  // consumption behind a past production entry can always be traced back to
  // the exact recipe, even after a newer one is added for the same product.
  "ALTER TABLE production ADD COLUMN formulation_id INTEGER REFERENCES formulations(id)",
  // The bank's interest and charges come out of an LC's open amount BEFORE the
  // beneficiary is paid, so a bill issued for the gross overpays the party on
  // paper. When interest/charges are later revised the shortfall moves with
  // them, so it is corrected by its own re-postable voucher (Dr Bank / Cr the
  // party, allocated On Account) rather than by rewriting the original
  // settlement — the payment that actually happened stays on the record and
  // the correction sits beside it.
  "ALTER TABLE letters_of_credit ADD COLUMN fee_adjust_journal_entry_id INTEGER",
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_banks_name ON banks(name)",
  // Superseded by our_bank_id below: this briefly held the DISCOUNTING bank,
  // which does not belong in our own-accounts master. Left in place unused
  // rather than dropped, since dropping a referenced column is not worth the
  // risk for a column nothing now reads.
  "ALTER TABLE letters_of_credit ADD COLUMN bank_id INTEGER REFERENCES banks(id)",
  // Which of OUR accounts this LC's money moves through — the one a repayment
  // goes out of. The financing side stays on `bank` (the discounting bank).
  "ALTER TABLE letters_of_credit ADD COLUMN our_bank_id INTEGER REFERENCES banks(id)",
  "CREATE INDEX IF NOT EXISTS idx_lc_our_bank ON letters_of_credit(our_bank_id)",
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_lc_limits ON bank_lc_limits(company_id, bank_id)",
  // A bank ACCOUNT belongs to one company's books, not to the business in
  // general — the SAME real-world bank used by two companies gets its own
  // separate row per company, same as any other company-scoped record. The
  // one bank that existed before this (shared, used by both companies) is
  // left as-is here; splitting its existing links is a data fix, not schema.
  "ALTER TABLE banks ADD COLUMN company_id INTEGER REFERENCES companies(id)",
  "DROP INDEX IF EXISTS idx_banks_name",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_banks_company_name ON banks(company_id, name)",
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
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_order_bargain_interest ON order_bargain_interest(order_id, bargain_id)",
  // A Trading party can be the same real-world PAN as an existing
  // Manufacturing party, entered as its own row so a trading deal never mixes
  // with the manufacturing relationship's bargains/tankers. Linking the two
  // means the TDS slab (which the law applies per PAN, not per row) sums
  // both rows' taxable value together instead of quietly restarting the
  // slab at zero for whichever row a given invoice happens to sit under.
  "ALTER TABLE suppliers ADD COLUMN linked_party_id INTEGER REFERENCES suppliers(id)",
  "ALTER TABLE customers ADD COLUMN linked_party_id INTEGER REFERENCES customers(id)",
  // Bill Discounting replaces the old party+entries tracker (bd_parties /
  // bd_entries — both confirmed empty) with one LC-style record per bill,
  // plus a proper NBFC master. Both old tables are dropped outright.
  // A tanker's EX/DLD condition, as chosen per tanker when it's sent to the
  // supplier. The picker for this already existed on that dialog but the value
  // was thrown away on save, so freight and the shortage penalty always fell
  // back to the bargain's own type — silently ignoring the choice. NULL means
  // "not overridden", which keeps every existing tanker reading from its
  // bargain exactly as before.
  "ALTER TABLE purchase_tankers ADD COLUMN condition TEXT",
  // Whether the round off on this invoice was typed by hand. Previously the
  // form inferred it from "the stored value isn't zero", which froze a figure
  // that was correct for the OLD totals the moment anything else was edited —
  // so the invoice total quietly stopped landing on a whole rupee. Recording
  // the intent explicitly means auto can keep itself right while a genuine
  // manual override is respected AND visible as one.
  "ALTER TABLE sales ADD COLUMN round_off_manual INTEGER NOT NULL DEFAULT 0",
  // What the transporter actually delivered, captured when the invoice is
  // marked Unloaded. Null until then — a zero would read as "nothing arrived"
  // rather than "not weighed yet".
  "ALTER TABLE sales ADD COLUMN received_qty REAL",
  // --- Transporter billing -------------------------------------------------
  // A transporter runs several tankers over a month and raises ONE bill for the
  // lot, so their freight must not land on their ledger tanker by tanker. Each
  // freight line now accrues to a control account and only reaches the
  // transporter's own ledger when their bill is entered against it.
  //   accrued          1 once the accrual voucher exists for this line
  //   accrual_entry_id the voucher that accrued it (so an edit can reverse it)
  //   bill_id          the transporter bill that has since settled it
  "ALTER TABLE transporter_ledger ADD COLUMN accrued INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE transporter_ledger ADD COLUMN accrual_entry_id INTEGER",
  "ALTER TABLE transporter_ledger ADD COLUMN bill_id INTEGER",
  `CREATE TABLE IF NOT EXISTS transporter_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    transporter_id INTEGER NOT NULL REFERENCES transporters(id),
    -- 'purchase' = freight on inward tankers, 'sales' = on outward deliveries.
    side TEXT NOT NULL DEFAULT 'purchase',
    bill_no TEXT,
    bill_date TEXT NOT NULL,
    taxable REAL NOT NULL DEFAULT 0,
    gst_pct REAL NOT NULL DEFAULT 0,
    gst_amount REAL NOT NULL DEFAULT 0,
    tds_pct REAL NOT NULL DEFAULT 0,
    tds_amount REAL NOT NULL DEFAULT 0,
    round_off REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    journal_entry_id INTEGER,
    ledger_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  "ALTER TABLE orders ADD COLUMN round_off_manual INTEGER NOT NULL DEFAULT 0",
  // These two used to retire the old party+entries tracker. They are NO-OPS
  // now, and must stay no-ops, because the NAME bd_parties was later reused
  // for a completely different table — the party links on a discounted bill,
  // created by runOnce('bd_parties_v1'). Migrations replay from whatever index
  // a database has reached, so leaving the DROP here meant one replay wiped
  // the live table while the runOnce marker said "already created" and never
  // brought it back. That is exactly how Bill Discounting (and, through a
  // shared Promise.all, the whole LC screen) went blank.
  //
  // Kept as statements rather than deleted so every later migration keeps its
  // index — the list is applied BY COUNT, so removing entries would silently
  // skip real work on databases already past this point.
  "SELECT 1 /* was: DROP TABLE IF EXISTS bd_entries */",
  "SELECT 1 /* was: DROP TABLE IF EXISTS bd_parties */",
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
  )`,
  // Bill discounting counts interest on a 360-day year, not 365 — the
  // convention the mill's own working sheet uses. Kept per record (with an
  // NBFC-level default) rather than hard-coded, since it is a term that is
  // negotiated like the rate is.
  "ALTER TABLE bill_discountings ADD COLUMN days_year REAL NOT NULL DEFAULT 360",
  "ALTER TABLE nbfcs ADD COLUMN days_year REAL NOT NULL DEFAULT 360",
  // A transporter's bill rarely lands exactly on what the tanker lines add up
  // to — a rate agreed later, detention, a negotiated reduction. The difference
  // is recorded rather than the freight lines being edited, so the register
  // still shows what each tanker earned and the bill still shows what was
  // actually agreed. Positive adds, negative reduces.
  "ALTER TABLE transporter_bills ADD COLUMN adjustment REAL NOT NULL DEFAULT 0",
  "ALTER TABLE transporter_bills ADD COLUMN adjustment_note TEXT",
  // The clock time a vehicle was booked in or out. entry_date alone answers
  // "which day" — a gate register also has to answer "when", both to sequence
  // two vehicles on the same day and to settle a dispute about detention.
  "ALTER TABLE gate_entries ADD COLUMN entry_time TEXT",
  // A customer credit note is a sales return: the goods come back, so the
  // quantity has to go back onto the bargain it was drawn from. The note
  // remembers which bargain it credited, and the adjustment log row remembers
  // which note put it there, so altering or deleting the note reverses it.
  "ALTER TABLE notes ADD COLUMN bargain_id INTEGER",
  "ALTER TABLE bargain_adjustments ADD COLUMN note_id INTEGER",
  // The clock time the vehicle LEFT, the counterpart to entry_time. out_date
  // alone answers which day it went out; a gate register has to answer when,
  // both to sequence two departures on one day and to settle detention.
  "ALTER TABLE gate_entries ADD COLUMN out_time TEXT",
  // A packed sale is negotiated and billed PER CASE, so the per-case rate is
  // what the line's value has to be struck on. It used to be converted to a
  // per-MT rate and the amount taken as qty x that — and the conversion cannot
  // be exact for a case weight like 13.395 KG, which silently understated the
  // line. The per-MT rate is still stored for reporting; this is the figure the
  // money now comes from.
  "ALTER TABLE sales ADD COLUMN rate_per_case REAL",
  // ---------------------------------------------------------------------
  // Indexes on the columns the registers' CORRELATED SUBQUERIES filter on.
  // Without them every such subquery is a full table scan, and the registers
  // run one per row: the sales-bargain register alone does ~6 subqueries over
  // `sales` for each of its bargains, so 27 bargains x 6 x 169 rows is ~27,000
  // rows read for one refresh — and every open page refetches on every write.
  // Rows read is what the hosting plan is metered on, so this is the single
  // biggest lever on the bill. Pure lookup speed: no behaviour changes.
  // ---------------------------------------------------------------------
  "CREATE INDEX IF NOT EXISTS idx_sales_bargain ON sales(sales_bargain_id)",
  "CREATE INDEX IF NOT EXISTS idx_sales_group ON sales(invoice_group)",
  "CREATE INDEX IF NOT EXISTS idx_sales_company_date ON sales(company_id, sale_date)",
  "CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)",
  "CREATE INDEX IF NOT EXISTS idx_sales_invoice_no ON sales(invoice_no)",
  "CREATE INDEX IF NOT EXISTS idx_pt_bargain ON purchase_tankers(bargain_id)",
  "CREATE INDEX IF NOT EXISTS idx_pt_extra_bargain ON purchase_tankers(extra_bargain_id)",
  "CREATE INDEX IF NOT EXISTS idx_pt_company ON purchase_tankers(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_orders_company_date ON orders(company_id, order_date)",
  "CREATE INDEX IF NOT EXISTS idx_orders_invoice_no ON orders(invoice_no)",
  "CREATE INDEX IF NOT EXISTS idx_je_sale ON journal_entries(sale_id)",
  "CREATE INDEX IF NOT EXISTS idx_je_order ON journal_entries(order_id)",
  "CREATE INDEX IF NOT EXISTS idx_je_payment ON journal_entries(payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_je_company_date ON journal_entries(company_id, entry_date)",
  "CREATE INDEX IF NOT EXISTS idx_jba_account ON journal_bill_allocs(account_id)",
  "CREATE INDEX IF NOT EXISTS idx_cl_sale ON customer_ledger(sale_id)",
  "CREATE INDEX IF NOT EXISTS idx_cl_customer ON customer_ledger(customer_id)",
  "CREATE INDEX IF NOT EXISTS idx_sl_order ON supplier_ledger(order_id)",
  "CREATE INDEX IF NOT EXISTS idx_sl_supplier ON supplier_ledger(supplier_id)",
  "CREATE INDEX IF NOT EXISTS idx_tl_sale ON transporter_ledger(sale_id)",
  "CREATE INDEX IF NOT EXISTS idx_tl_order ON transporter_ledger(order_id)",
  "CREATE INDEX IF NOT EXISTS idx_tl_bill ON transporter_ledger(bill_id)",
  "CREATE INDEX IF NOT EXISTS idx_tl_transporter ON transporter_ledger(transporter_id)",
  "CREATE INDEX IF NOT EXISTS idx_gate_group ON gate_entries(invoice_group)",
  "CREATE INDEX IF NOT EXISTS idx_gate_tanker ON gate_entries(tanker_id)",
  "CREATE INDEX IF NOT EXISTS idx_gate_sale ON gate_entries(sale_id)",
  "CREATE INDEX IF NOT EXISTS idx_gate_company_date ON gate_entries(company_id, entry_date)",
  "CREATE INDEX IF NOT EXISTS idx_notes_je ON notes(journal_entry_id)",
  "CREATE INDEX IF NOT EXISTS idx_notes_company ON notes(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_note_items_note ON note_items(note_id)",
  "CREATE INDEX IF NOT EXISTS idx_badj_bargain ON bargain_adjustments(kind, bargain_id)",
  "CREATE INDEX IF NOT EXISTS idx_badj_note ON bargain_adjustments(note_id)",
  "CREATE INDEX IF NOT EXISTS idx_production_sale ON production(sale_id)",
  "CREATE INDEX IF NOT EXISTS idx_bd_company ON bill_discountings(company_id)",
  "CREATE INDEX IF NOT EXISTS idx_lc_issuances_lc ON lc_issuances(lc_id)",
  // A discounted bill is not always cleared in one go: an NBFC will take it
  // back in instalments, and until now the only way to record that was to wait
  // and post the whole thing at the end, which left the facility reading as
  // fully outstanding money that had already gone back. Each part now gets its
  // own dated row and its own voucher, and the bill closes when the parts add
  // up to it. Bills repaid in full before this keep their single figure on the
  // parent row and are read from there, so nothing already posted moves.
  `CREATE TABLE IF NOT EXISTS bd_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
  repay_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  settle_via TEXT NOT NULL DEFAULT 'bank',
  ref TEXT,
  journal_entry_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`,
  "CREATE INDEX IF NOT EXISTS idx_bd_repay_bd ON bd_repayments(bd_id)",
  // What a bill is discounted for is not always the whole invoice behind it, so
  // the invoice's own value is worth recording next to the amount opened
  // against it — it is what tells you how much of the invoice was financed.
  // Informational: nothing is priced off it.
  "ALTER TABLE bill_discountings ADD COLUMN invoice_amount REAL",
  // ---------------------------------------------------------------------
  // Second pass on rows read, aimed at what the measurements actually show:
  // this database is small (~7,300 rows), so the bill is driven by how OFTEN
  // a query runs and how much of a table it has to walk each time -- not by
  // table size. These cover the tables that were still being walked whole.
  //
  // user_logs is the biggest table in the database and had no index at all.
  // The activity log runs two DISTINCT sweeps over the entire table on every
  // open, purely to fill its two filter dropdowns -- so opening it read every
  // row twice over. It also filters by username, entity, action and date, and
  // the nightly cleanup deletes by date.
  // ---------------------------------------------------------------------
  "CREATE INDEX IF NOT EXISTS idx_ulogs_username ON user_logs(username)",
  "CREATE INDEX IF NOT EXISTS idx_ulogs_entity ON user_logs(entity)",
  "CREATE INDEX IF NOT EXISTS idx_ulogs_created ON user_logs(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ulogs_action ON user_logs(action)",
  // production_items is joined to its parent on every stock figure and read
  // per product by the stock registers' correlated subqueries.
  "CREATE INDEX IF NOT EXISTS idx_pitems_production ON production_items(production_id)",
  "CREATE INDEX IF NOT EXISTS idx_pitems_kind_product ON production_items(kind, product_id)",
  // The SKU stock register runs SIX correlated subqueries per SKU -- three over
  // the adjustments and three over sales -- and each was scanning its whole
  // table. Both sides filter on the packaging (the SKU) within a company.
  "CREATE INDEX IF NOT EXISTS idx_skuadj_pkg ON sku_adjustments(company_id, packaging_id)",
  "CREATE INDEX IF NOT EXISTS idx_sales_pkg_type ON sales(packaging_id, sale_type)",
  // A stock count is looked up by its date within a company.
  "CREATE INDEX IF NOT EXISTS idx_scounts_company_date ON stock_counts(company_id, count_date)",
  "CREATE INDEX IF NOT EXISTS idx_scounts_product ON stock_counts(product_id)",
  // Bill Discounting: the register filters by NBFC and by finance type, and
  // every mutation re-reads the bill by id (already the primary key).
  "CREATE INDEX IF NOT EXISTS idx_bd_nbfc ON bill_discountings(nbfc_id)",
  "CREATE INDEX IF NOT EXISTS idx_bd_company_status ON bill_discountings(company_id, status)"
  // ---------------------------------------------------------------------
  // NOTE FOR LATER, learned the hard way: this list is applied BY COUNT.
  // Startup stores how many entries it has run and executes only the ones
  // past that mark, so
  //   - a statement inserted into the middle sits below the mark and never
  //     runs at all, silently, on every existing install; and
  //   - swapping entries around does not help either, because the count is
  //     unchanged and the mark still covers them.
  // Only APPENDING works. Anything that must run on installs already past
  // the mark belongs in a runOnce() instead, keyed by name -- see
  // 'ulogs_entity_index_v1' in index.ts.
  // ---------------------------------------------------------------------
];
async function backfillBargainSerials(c) {
  const res = await c.execute("SELECT id, bargain_no FROM bargains");
  for (const r of res.rows) {
    const no = String(r.bargain_no || "");
    const parts = no.split("/");
    const last = parts[parts.length - 1] ?? "";
    const num2 = parseInt(last, 10);
    if (!/^\d+$/.test(last) || Number.isNaN(num2)) continue;
    const fixed = String(num2).padStart(2, "0");
    if (fixed === last) continue;
    parts[parts.length - 1] = fixed;
    await c.execute({
      sql: "UPDATE bargains SET bargain_no = ? WHERE id = ?",
      args: [parts.join("/"), r.id]
    });
  }
}
async function rebuildStockCountsForCompanies(c) {
  const info = await c.execute("PRAGMA table_info(stock_counts)");
  const hasCompany = info.rows.some((r) => String(r.name) === "company_id");
  if (hasCompany) return;
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
  )`);
  await c.execute(`INSERT INTO stock_counts_new
      (id, company_id, count_date, product_id, book_qty, actual_qty, actual_value, note, created_at)
    SELECT id, 1, count_date, product_id, book_qty, actual_qty, actual_value, note, created_at
    FROM stock_counts`);
  await c.execute("DROP TABLE stock_counts");
  await c.execute("ALTER TABLE stock_counts_new RENAME TO stock_counts");
}
var APPLIED_KEY = "schema_applied_count";
async function initDb() {
  try {
    const c = getClient();
    let applied = 0;
    try {
      const r = await c.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [APPLIED_KEY] });
      applied = r.rows.length ? Number(r.rows[0].value) || 0 : 0;
    } catch {
      applied = 0;
    }
    if (applied > 0) {
      try {
        const t = await c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales' LIMIT 1");
        if (!t.rows.length) applied = 0;
      } catch {
        applied = 0;
      }
    }
    if (applied === 0) {
      await c.executeMultiple(SCHEMA_SQL);
    }
    if (applied < MIGRATIONS.length) {
      for (let i = applied; i < MIGRATIONS.length; i++) {
        try {
          await c.execute(MIGRATIONS[i]);
        } catch {
        }
      }
      await c.execute({
        sql: `INSERT INTO app_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [APPLIED_KEY, String(MIGRATIONS.length)]
      });
    }
    await backfillBargainSerials(c).catch(() => {
    });
    await rebuildStockCountsForCompanies(c).catch(
      (e) => console.error("[db] stock_counts rebuild failed:", e.message)
    );
    console.log("[db] schema ready");
  } catch (err) {
    console.error("[db] init skipped/failed:", err.message);
  }
}
var cachedRevision = 0;
var revisionInFlight = false;
var revisionTimer = null;
var POLL_MIN_MS = 15e3;
var POLL_MAX_MS = 12e4;
var QUIET_BEFORE_BACKOFF = 8;
var pollMs = POLL_MIN_MS;
var quietPolls = 0;
function resetPollInterval() {
  pollMs = POLL_MIN_MS;
  quietPolls = 0;
}
async function fetchRevision() {
  if (revisionInFlight) return;
  revisionInFlight = true;
  try {
    const res = await getClient().execute("SELECT value FROM app_settings WHERE key = 'db_revision'");
    const next = res.rows.length ? Number(res.rows[0].value) : 0;
    if (next !== cachedRevision) {
      notifyDataChanged();
      resetPollInterval();
    } else if (++quietPolls > QUIET_BEFORE_BACKOFF) {
      pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    }
    cachedRevision = next;
  } catch {
  } finally {
    revisionInFlight = false;
  }
}
function startRevisionWatcher() {
  if (revisionTimer) return;
  fetchRevision();
  const tick = async () => {
    await fetchRevision();
    revisionTimer = setTimeout(tick, pollMs);
  };
  revisionTimer = setTimeout(tick, pollMs);
}
async function runOnce(key3, fn) {
  const c = getClient();
  const flag = `once_${key3}`;
  const done = await c.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [flag] });
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  await fn();
  await c.execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    args: [flag]
  });
}
async function runDaily(key3, fn) {
  const c = getClient();
  const flag = `daily_${key3}`;
  const today = todayISO();
  const done = await c.execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [flag] });
  if (done.rows.length && String(done.rows[0].value) === today) return;
  await fn();
  await c.execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [flag, today]
  });
}
var invalidators = [];
function onDataChanged(fn) {
  invalidators.push(fn);
}
function notifyDataChanged() {
  for (const fn of invalidators) fn();
}
async function bumpRevision() {
  await getClient().execute(
    `INSERT INTO app_settings (key, value) VALUES ('db_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  );
  cachedRevision += 1;
  notifyDataChanged();
  resetPollInterval();
}
function getRevision() {
  return cachedRevision;
}
function isNetworkError(err) {
  const msg = `${err?.message || ""} ${err?.cause?.message || ""}`;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|UND_ERR|network|getaddrinfo/i.test(msg);
}
async function ping() {
  try {
    const c = getClient();
    await c.execute("SELECT 1");
    return { ok: true, message: "Connected to Turso" };
  } catch (err) {
    if (isNetworkError(err)) {
      resetClient();
      return { ok: false, offline: true, message: "No internet connection" };
    }
    return { ok: false, message: err.message };
  }
}

// src/main/requestContext.ts
var import_node_async_hooks = require("node:async_hooks");
var store = new import_node_async_hooks.AsyncLocalStorage();
function runInRequestContext(ctx, fn) {
  return store.run(ctx, fn);
}
function currentRequestContext() {
  return store.getStore();
}

// src/main/company.ts
function toPlain(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var activeCompanyId = 1;
function getActiveCompanyId() {
  const ctx = currentRequestContext();
  if (ctx) return ctx.companyId;
  return activeCompanyId;
}
function setActiveCompany(id) {
  const v = Number(id);
  const next = Number.isFinite(v) && v > 0 ? v : 1;
  const ctx = currentRequestContext();
  if (ctx) {
    ctx.companyId = next;
    return { id: next };
  }
  activeCompanyId = next;
  return { id: activeCompanyId };
}
async function listCompanies() {
  const res = await getClient().execute("SELECT * FROM companies ORDER BY name COLLATE NOCASE ASC");
  return toPlain(res);
}

// src/main/repos.ts
var TABLES = {
  banks: ["name", "branch", "account_no", "ifsc", "note", "active", "company_id"],
  // days_year belongs here: the Manage NBFCs form offers it, but a column
  // missing from this list is silently DROPPED by pickKeys — so changing the
  // year basis from 360 to 365 saved without complaint and changed nothing.
  nbfcs: ["name", "finance_type", "tds_pct", "interest_pct", "interest_days", "days_year", "days_incl_start", "sanctioned_limit", "note", "active", "company_id"],
  categories: ["name", "applies_to", "note", "active"],
  oil_types: ["code", "name", "active"],
  products: ["code", "name", "category", "material_type", "uom", "active"],
  suppliers: [
    "name",
    "supplier_type",
    "company_type",
    "business_type",
    "linked_party_id",
    "gstin",
    "state",
    "gst_pct",
    "tds_pct",
    "tds_threshold",
    "tds_pct_above",
    "tds_above_only",
    "credit_period_days",
    "adds_interest",
    "interest_pct",
    "interest_days",
    "opening_purchase_amount",
    "opening_purchase_date",
    "skip_tanker_stages",
    "active"
  ],
  transporters: [
    "name",
    "company_type",
    "contact",
    "gst_pct",
    "tds_pct",
    "tds_threshold",
    "tds_pct_above",
    "default_rate_per_ton",
    "reverse_charge",
    "active"
  ],
  customers: [
    "name",
    "category",
    "company_type",
    "business_type",
    "linked_party_id",
    "gstin",
    "state",
    "gst_pct",
    "tds_pct",
    "tds_threshold",
    "tds_above_only",
    "adds_interest",
    "interest_pct",
    "interest_days",
    "credit_period_days",
    "active"
  ],
  sources: ["name", "transit_days", "active"],
  uoms: ["name", "active"],
  brokers: ["name", "contact_person", "phone", "brokerage_pct", "address", "note", "active"],
  companies: ["name", "active"],
  packagings: ["name", "box_label", "pouch_label", "pouches_per_box", "unit_size", "unit_uom", "base_per_pouch", "base_uom", "product_id", "product_label", "active"]
};
var COMPANY_SCOPED_TABLES = /* @__PURE__ */ new Set(["banks", "nbfcs"]);
function assertTable(table) {
  const cols = TABLES[table];
  if (!cols) throw new Error(`Unknown table: ${table}`);
  return cols;
}
function toArg(v, key3) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === void 0) return null;
  if (v === "" && key3?.endsWith("_id")) return null;
  return v;
}
function pickKeys(values, allowed) {
  return Object.keys(values).filter((k) => allowed.includes(k));
}
async function assertUniqueName(table, values, excludeId) {
  if (!("name" in values)) return;
  const name = String(values.name ?? "").trim();
  if (!name) return;
  const c = getClient();
  const scoped = COMPANY_SCOPED_TABLES.has(table);
  const targetCompany = Number(values.company_id) || getActiveCompanyId();
  const scopeSql = scoped ? " AND company_id = ?" : "";
  const scopeArg = scoped ? [targetCompany] : [];
  if (excludeId) {
    const cur = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [excludeId] });
    const before = String(cur.rows[0]?.name ?? "").trim().toLowerCase();
    if (before === name.toLowerCase()) return;
  }
  const hit = await c.execute({
    sql: `SELECT id, name FROM ${table} WHERE TRIM(LOWER(name)) = ?${scopeSql}${excludeId ? " AND id != ?" : ""} LIMIT 1`,
    args: [name.toLowerCase(), ...scopeArg, ...excludeId ? [excludeId] : []]
  });
  if (hit.rows.length) {
    throw new Error(`"${String(hit.rows[0].name)}" already exists \u2014 give this one a different name`);
  }
}
var masterCache = /* @__PURE__ */ new Map();
onDataChanged(() => masterCache.clear());
async function list(table) {
  assertTable(table);
  const scoped = COMPANY_SCOPED_TABLES.has(table);
  const key3 = `${table}|${scoped ? getActiveCompanyId() : 0}`;
  const hit = masterCache.get(key3);
  if (hit) return hit.map((r) => ({ ...r }));
  const res = await getClient().execute(
    scoped ? { sql: `SELECT * FROM ${table} WHERE company_id = ? ORDER BY name COLLATE NOCASE ASC`, args: [getActiveCompanyId()] } : `SELECT * FROM ${table} ORDER BY name COLLATE NOCASE ASC`
  );
  const rows = res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
  masterCache.set(key3, rows);
  return rows.map((r) => ({ ...r }));
}
async function get(table, id) {
  assertTable(table);
  const res = await getClient().execute({
    sql: `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
    args: [id]
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  const o = {};
  for (const col of res.columns) o[col] = r[col];
  return o;
}
async function create(table, values) {
  const allowed = assertTable(table);
  if (COMPANY_SCOPED_TABLES.has(table) && !values.company_id) {
    values = { ...values, company_id: getActiveCompanyId() };
  }
  await assertUniqueName(table, values);
  const keys = pickKeys(values, allowed);
  if (keys.length === 0) throw new Error("No valid columns to insert");
  const placeholders = keys.map(() => "?").join(", ");
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
    args: keys.map((k) => toArg(values[k], k))
  });
  return { id: Number(res.lastInsertRowid) };
}
var LEDGER_MASTERS = /* @__PURE__ */ new Set(["customers", "suppliers", "transporters", "brokers"]);
async function renameLedgerAccount(oldName, newName) {
  const c = getClient();
  const from = String(oldName || "").trim().toUpperCase();
  const to = String(newName || "").trim().toUpperCase();
  if (!from || !to || from === to) return;
  const src = await c.execute({ sql: "SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?", args: [from] });
  if (!src.rows.length) return;
  const srcId = Number(src.rows[0].id);
  const dst = await c.execute({ sql: "SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?", args: [to] });
  if (!dst.rows.length) {
    await c.execute({ sql: "UPDATE ledger_accounts SET name = ? WHERE id = ?", args: [to, srcId] });
    return;
  }
  const dstId = Number(dst.rows[0].id);
  if (dstId === srcId) return;
  await c.execute({ sql: "UPDATE journal_lines SET account_id = ? WHERE account_id = ?", args: [dstId, srcId] });
  await c.execute({ sql: "UPDATE journal_bill_allocs SET account_id = ? WHERE account_id = ?", args: [dstId, srcId] });
  await c.execute({ sql: "DELETE FROM ledger_accounts WHERE id = ?", args: [srcId] });
}
async function update(table, id, values) {
  const allowed = assertTable(table);
  await assertUniqueName(table, values, id);
  const keys = pickKeys(values, allowed);
  if (keys.length === 0) return { id };
  let priorName = "";
  if (LEDGER_MASTERS.has(table) && keys.includes("name")) {
    const prev = await getClient().execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [id] });
    priorName = prev.rows.length ? String(prev.rows[0].name || "") : "";
  }
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  await getClient().execute({
    sql: `UPDATE ${table} SET ${setClause} WHERE id = ?`,
    args: [...keys.map((k) => toArg(values[k], k)), id]
  });
  if (priorName) await renameLedgerAccount(priorName, String(values.name || ""));
  return { id };
}
var DEPENDENTS = {
  banks: [
    { table: "letters_of_credit", column: "our_bank_id", label: "LC" },
    { table: "bank_lc_limits", column: "bank_id", label: "sanctioned limit" }
  ],
  nbfcs: [{ table: "bill_discountings", column: "nbfc_id", label: "discounted bill" }],
  suppliers: [
    { table: "bargains", column: "supplier_id", label: "purchase bargain" },
    { table: "orders", column: "supplier_id", label: "purchase" },
    { table: "purchase_tankers", column: "supplier_id", label: "tanker" },
    { table: "consignment_stock", column: "supplier_id", label: "consignment lot" },
    { table: "supplier_ledger", column: "supplier_id", label: "ledger entry" },
    { table: "gate_entries", column: "supplier_id", label: "gate entry" }
  ],
  customers: [
    { table: "sales", column: "customer_id", label: "sale" },
    { table: "sales_bargains", column: "customer_id", label: "sales bargain" },
    { table: "customer_ledger", column: "customer_id", label: "ledger entry" },
    { table: "gate_entries", column: "customer_id", label: "gate entry" },
    { table: "packaging_parties", column: "customer_id", label: "packed-SKU link" }
  ],
  products: [
    { table: "sales", column: "product_id", label: "sale" },
    { table: "sales_bargains", column: "product_id", label: "sales bargain" },
    { table: "orders", column: "oil_type_id", label: "purchase" },
    { table: "production", column: "product_id", label: "production run" },
    { table: "production_items", column: "product_id", label: "production input" },
    { table: "formulation_items", column: "product_id", label: "formulation line" },
    { table: "consignment_stock", column: "product_id", label: "consignment lot" },
    { table: "stock_counts", column: "product_id", label: "day-close count" },
    { table: "stock_transfers", column: "product_id", label: "stock transfer" },
    { table: "packagings", column: "product_id", label: "packed SKU" }
  ],
  transporters: [
    { table: "purchase_tankers", column: "transporter_id", label: "tanker" },
    { table: "orders", column: "transporter_id", label: "purchase" },
    { table: "sales", column: "transporter_id", label: "sale" },
    { table: "transporter_ledger", column: "transporter_id", label: "ledger entry" }
  ],
  sources: [{ table: "bargains", column: "source_id", label: "purchase bargain" }],
  brokers: [{ table: "bargains", column: "broker_id", label: "purchase bargain" }],
  packagings: [
    { table: "sales", column: "packaging_id", label: "sale" },
    { table: "sales_bargains", column: "packaging_id", label: "sales bargain" },
    { table: "sales_bargain_sku_rates", column: "packaging_id", label: "rate-card line" },
    { table: "packaging_parties", column: "packaging_id", label: "party link" }
  ],
  oil_types: [
    { table: "bargains", column: "oil_type_id", label: "purchase bargain" },
    { table: "purchase_tankers", column: "oil_type_id", label: "tanker" }
  ]
};
async function assertNotInUse(table, id) {
  const deps = DEPENDENTS[table];
  if (!deps) return;
  const c = getClient();
  const held = [];
  for (const d of deps) {
    const r = await c.execute({ sql: `SELECT COUNT(*) AS n FROM ${d.table} WHERE ${d.column} = ?`, args: [id] }).catch(() => null);
    const n25 = r ? Number(r.rows[0].n) : 0;
    if (n25 > 0) held.push(`${n25} ${d.label}${n25 === 1 ? "" : "s"}`);
  }
  if (!held.length) return;
  const who = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [id] });
  const name = String(who.rows[0]?.name ?? "This record");
  throw new Error(
    `"${name}" is still used by ${held.join(", ")} \u2014 deleting it would orphan them. Switch it off with the Active toggle instead, so it stops being offered but its history stays.`
  );
}
async function remove(table, id) {
  assertTable(table);
  await assertNotInUse(table, id);
  await getClient().execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] });
  return { id };
}
async function getSetting(key3) {
  const res = await getClient().execute({
    sql: "SELECT value FROM app_settings WHERE key = ? LIMIT 1",
    args: [key3]
  });
  return res.rows.length ? res.rows[0].value : null;
}
async function setSetting(key3, value) {
  await getClient().execute({
    sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [key3, value]
  });
}
async function allSettings() {
  const res = await getClient().execute("SELECT key, value FROM app_settings");
  const out = {};
  for (const r of res.rows) out[r.key] = r.value;
  return out;
}

// src/main/openings.ts
var n = (v) => Number(v ?? 0) || 0;
var round2 = (v) => Math.round(v * 100) / 100;
function key(companyId) {
  return `books_from:${companyId}`;
}
async function getBooksFrom(companyId) {
  const cid = companyId || getActiveCompanyId();
  const v = await getSetting(key(cid));
  const d = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
async function setBooksFrom(date, companyId) {
  const cid = companyId || getActiveCompanyId();
  const d = String(date || "").slice(0, 10);
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Give the date as YYYY-MM-DD");
  await setSetting(key(cid), d);
  return { ok: true };
}
async function listOpenings(companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const from = await getBooksFrom(cid);
  const res = await c.execute({
    sql: `SELECT a.id, a.name, a.acc_group,
                 COALESCE(o.dr, 0) AS dr, COALESCE(o.cr, 0) AS cr,
                 COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                             FROM journal_lines jl
                             JOIN journal_entries je ON je.id = jl.entry_id
                            WHERE jl.account_id = a.id AND je.company_id = ?
                              ${from ? "AND je.entry_date >= ?" : ""}), 0) AS movement,
                 COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                             FROM journal_lines jl
                             JOIN journal_entries je ON je.id = jl.entry_id
                            WHERE jl.account_id = a.id AND je.company_id = ?
                              ${from ? "AND je.entry_date < ?" : "AND 0"}), 0) AS before_cutoff
            FROM ledger_accounts a
            LEFT JOIN ledger_openings o ON o.account_id = a.id AND o.company_id = ?
           ORDER BY a.acc_group, a.name`,
    args: from ? [cid, from, cid, from, cid] : [cid, cid, cid]
  });
  const rows = res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
  const dr = round2(rows.reduce((s, r) => s + n(r.dr), 0));
  const cr = round2(rows.reduce((s, r) => s + n(r.cr), 0));
  return {
    books_from: from,
    rows,
    total_dr: dr,
    total_cr: cr,
    // Tally calls this "Difference in opening balances". A non-zero figure is
    // not an error to be hidden — it is the part of the opening position you
    // have not accounted for yet, and it belongs on screen until it is nil.
    difference: round2(dr - cr)
  };
}
async function saveOpenings(rows, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  let saved = 0;
  for (const r of rows || []) {
    const id = n(r.account_id);
    if (!id) continue;
    const dr = round2(Math.max(0, n(r.dr)));
    const cr = round2(Math.max(0, n(r.cr)));
    if (dr > 4e-3 && cr > 4e-3) {
      throw new Error("An opening balance is either a debit or a credit, not both");
    }
    if (dr < 5e-3 && cr < 5e-3) {
      await c.execute({
        sql: "DELETE FROM ledger_openings WHERE company_id = ? AND account_id = ?",
        args: [cid, id]
      });
      continue;
    }
    await c.execute({
      sql: `INSERT INTO ledger_openings (company_id, account_id, dr, cr, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company_id, account_id)
            DO UPDATE SET dr = excluded.dr, cr = excluded.cr, updated_at = excluded.updated_at`,
      args: [cid, id, dr, cr, todayISO()]
    });
    saved += 1;
  }
  return { saved };
}
async function ledgerOpening(accountId, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const res = await c.execute({
    sql: "SELECT dr, cr FROM ledger_openings WHERE company_id = ? AND account_id = ?",
    args: [cid, n(accountId)]
  });
  const r = res.rows[0] || {};
  return {
    books_from: await getBooksFrom(cid),
    // Signed the way the ledger runs its balance: positive is a debit.
    opening: round2(n(r.dr) - n(r.cr))
  };
}
async function openingMap(companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const res = await c.execute({
    sql: "SELECT account_id, dr, cr FROM ledger_openings WHERE company_id = ?",
    args: [cid]
  });
  const m = /* @__PURE__ */ new Map();
  for (const r of res.rows) {
    m.set(Number(r.account_id), round2(n(r.dr) - n(r.cr)));
  }
  return m;
}

// src/main/journal.ts
function toPlain2(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n2(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
async function getOrCreateAccount(name, group = "General") {
  const c = getClient();
  const clean = String(name || "").trim().toUpperCase();
  if (!clean) throw new Error("Account name is required");
  await c.execute({
    sql: "INSERT OR IGNORE INTO ledger_accounts (name, acc_group) VALUES (?, ?)",
    args: [clean, group]
  });
  const res = await c.execute({
    sql: "SELECT id FROM ledger_accounts WHERE name = ?",
    args: [clean]
  });
  return Number(res.rows[0].id);
}
async function listAccounts(companyId) {
  const res = await getClient().execute({
    args: [companyId || getActiveCompanyId()],
    sql: `
    SELECT a.*,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance,
      -- Postings across EVERY company, not just the one in view.
      (SELECT COUNT(*) FROM journal_lines jl2 WHERE jl2.account_id = a.id) AS line_count,
      (SELECT COUNT(*) FROM journal_bill_allocs ba WHERE ba.account_id = a.id) AS alloc_count,
      -- Whether a master still claims this name. A party or a standing account
      -- with no postings YET is perfectly normal \u2014 CASH A/C, FREIGHT INWARD
      -- A/C, a transporter not yet billed \u2014 and must never be offered for
      -- deletion. Only a name nothing claims is a genuine leftover, which is
      -- what a rename used to strand.
      (SELECT COUNT(*) FROM customers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM suppliers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM transporters m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM brokers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) AS claimed_by_master
    FROM ledger_accounts a ORDER BY a.name
  `
  });
  return toPlain2(res);
}
async function createAccount(name, group = "General") {
  return { id: await getOrCreateAccount(name, group) };
}
async function postJournal(a) {
  const c = getClient();
  const lines = a.lines.filter((l) => n2(l.dr) > 4e-3 || n2(l.cr) > 4e-3);
  if (!lines.length) throw new Error("Journal entry has no amounts");
  const dr = lines.reduce((s, l) => s + n2(l.dr), 0);
  const cr = lines.reduce((s, l) => s + n2(l.cr), 0);
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error(`Journal not balanced (Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)})`);
  }
  const ins = await c.execute({
    sql: `INSERT INTO journal_entries (company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      a.companyId ?? getActiveCompanyId(),
      a.date,
      a.vchType,
      a.vchNo || null,
      a.narration || null,
      a.orderId ?? null,
      a.saleId ?? null,
      a.paymentId ?? null
    ]
  });
  const entryId = Number(ins.lastInsertRowid);
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group);
    await c.execute({
      sql: "INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)",
      args: [entryId, accountId, n2(l.dr), n2(l.cr)]
    });
  }
  return { id: entryId };
}
async function repostJournal(entryId, a) {
  const c = getClient();
  const id = n2(entryId);
  if (!id) throw new Error("No entry to re-post");
  const exists = await c.execute({ sql: "SELECT id FROM journal_entries WHERE id = ?", args: [id] });
  if (!exists.rows.length) throw new Error("That journal entry no longer exists");
  const lines = a.lines.filter((l) => n2(l.dr) > 4e-3 || n2(l.cr) > 4e-3);
  if (!lines.length) throw new Error("Journal entry has no amounts");
  const dr = lines.reduce((s, l) => s + n2(l.dr), 0);
  const cr = lines.reduce((s, l) => s + n2(l.cr), 0);
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error(`Journal not balanced (Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)})`);
  }
  await c.execute({
    sql: `UPDATE journal_entries
             SET entry_date = ?, vch_type = ?, vch_no = ?, narration = ?,
                 order_id = ?, sale_id = ?, payment_id = ?
           WHERE id = ?`,
    args: [
      a.date,
      a.vchType,
      a.vchNo || null,
      a.narration || null,
      a.orderId ?? null,
      a.saleId ?? null,
      a.paymentId ?? null,
      id
    ]
  });
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [id]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [id] });
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group);
    await c.execute({
      sql: "INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)",
      args: [id, accountId, n2(l.dr), n2(l.cr)]
    });
  }
  return { id };
}
async function deleteJournalByRef(refCol, refId) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT id FROM journal_entries WHERE ${refCol} = ?`,
    args: [refId]
  });
  for (const r of res.rows) {
    await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [r.id] });
    await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [r.id] });
  }
}
async function deleteManualEntry(id) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT order_id, sale_id, payment_id FROM journal_entries WHERE id = ?",
    args: [id]
  });
  if (!res.rows.length) return { id };
  const r = res.rows[0];
  if (r.order_id != null || r.sale_id != null || r.payment_id != null) {
    throw new Error("This entry was posted automatically \u2014 adjust its source document instead");
  }
  const noteRef = await c.execute({
    sql: "SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1",
    args: [id]
  });
  if (noteRef.rows.length) {
    throw new Error("This voucher belongs to a Debit/Credit note \u2014 delete the note itself");
  }
  const billRef = await c.execute({
    sql: "SELECT id, bill_no FROM transporter_bills WHERE journal_entry_id = ? LIMIT 1",
    args: [id]
  });
  if (billRef.rows.length) {
    throw new Error(
      `This voucher is transporter bill ${String(billRef.rows[0].bill_no || billRef.rows[0].id)} \u2014 delete it from the Freight Working register so its freight lines go back to unbilled`
    );
  }
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [id]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [id] });
  return { id };
}
function vchPrefix(t) {
  const u = String(t || "").toUpperCase();
  if (u.includes("PURCHASE")) return "PUR";
  if (u.includes("SALE")) return "SAL";
  if (u.includes("DEBIT")) return "DN";
  if (u.includes("CREDIT")) return "CN";
  if (u.includes("RECEIPT")) return "RCP";
  if (u.includes("PAYMENT")) return "PAY";
  if (u.includes("CONTRA")) return "CON";
  if (u.includes("OPENING")) return "OB";
  if (u.includes("JOURNAL")) return "JV";
  const letters = u.replace(/[^A-Z]/g, "");
  return letters.slice(0, 3) || "VCH";
}
async function voucherCodeMap(companyId) {
  const res = await getClient().execute({
    sql: "SELECT id, vch_type FROM journal_entries WHERE company_id = ? ORDER BY id ASC",
    args: [companyId]
  });
  const counters = /* @__PURE__ */ new Map();
  const map = /* @__PURE__ */ new Map();
  for (const r of res.rows) {
    const pre = vchPrefix(String(r.vch_type));
    const seq = (counters.get(pre) || 0) + 1;
    counters.set(pre, seq);
    map.set(Number(r.id), `${pre}/${seq}`);
  }
  return map;
}
async function accountStatement(accountId, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const booksFrom = await getBooksFrom(cid);
  const res = await c.execute({
    sql: `SELECT jl.id, je.id AS entry_id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 jl.dr, jl.cr, je.order_id, je.sale_id, je.payment_id
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_id = ? AND je.company_id = ?
            ${booksFrom ? "AND je.entry_date >= ?" : ""}
          ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC`,
    args: booksFrom ? [accountId, cid, booksFrom] : [accountId, cid]
  });
  const lines = toPlain2(res);
  if (!lines.length) return lines;
  const others = await c.execute({
    sql: `SELECT jl.entry_id, jl.dr, jl.cr, a.name
          FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.account_id != ?
            AND jl.entry_id IN (SELECT entry_id FROM journal_lines WHERE account_id = ?)`,
    args: [accountId, accountId]
  });
  const byEntry = /* @__PURE__ */ new Map();
  for (const r of toPlain2(others)) {
    const k = Number(r.entry_id);
    if (!byEntry.has(k)) byEntry.set(k, []);
    byEntry.get(k).push(r);
  }
  const codes = await voucherCodeMap(cid);
  const allocRes = await c.execute({
    sql: `SELECT line_id, method, ref_name, order_id, sale_invoice_group, amount
          FROM journal_bill_allocs WHERE line_id IN (${lines.map(() => "?").join(",")})`,
    args: lines.map((l) => Number(l.id))
  });
  const allocsByLine = /* @__PURE__ */ new Map();
  for (const a of toPlain2(allocRes)) {
    const k = Number(a.line_id);
    if (!allocsByLine.has(k)) allocsByLine.set(k, []);
    allocsByLine.get(k).push(a);
  }
  for (const l of lines) {
    const rest = byEntry.get(Number(l.entry_id)) || [];
    const opposite = Number(l.dr) > 0 ? rest.filter((r) => n2(r.cr) > 0).sort((a, b) => n2(b.cr) - n2(a.cr)) : rest.filter((r) => n2(r.dr) > 0).sort((a, b) => n2(b.dr) - n2(a.dr));
    l.particulars = String((opposite[0] || rest[0])?.name || "");
    l.voucher_code = codes.get(Number(l.entry_id)) || "";
    l.legs = rest.map((r) => ({ name: String(r.name), dr: n2(r.dr), cr: n2(r.cr) }));
    l.allocs = allocsByLine.get(Number(l.id)) || [];
  }
  return lines;
}
async function postPurchaseJournal(v) {
  await deleteJournalByRef("order_id", v.orderId);
  const ro = n2(v.roundOff);
  const interest = Math.min(Math.max(0, n2(v.interest)), n2(v.taxable));
  await postJournal({
    date: v.date,
    vchType: "PURCHASE OIL",
    vchNo: v.invoiceNo,
    narration: `Purchase ${v.invoiceNo}`,
    orderId: v.orderId,
    companyId: v.companyId,
    lines: [
      { account: `${v.oilCode} PUR A/C`, group: "Purchase Accounts", dr: v.taxable - interest },
      { account: "INTEREST A/C", group: "Indirect Expenses", dr: interest },
      { account: "GST INPUT A/C", group: "Duties & Taxes", dr: v.gst },
      { account: "ROUND OFF A/C", group: "Indirect Expenses", dr: ro > 0 ? ro : 0, cr: ro < 0 ? -ro : 0 },
      { account: "TDS PAYABLE A/C", group: "Duties & Taxes", cr: v.tds },
      { account: v.supplierName, group: "Sundry Creditors", cr: v.net }
    ]
  });
}
async function postPaymentJournal(v) {
  await deleteJournalByRef("payment_id", v.paymentId);
  const sourceAccount = `${String(v.source || "BANK").toUpperCase()} A/C`;
  await postJournal({
    date: v.date,
    vchType: v.isReceipt ? "RECEIPT" : "PAYMENT",
    vchNo: v.reference || null,
    paymentId: v.paymentId,
    companyId: v.companyId,
    lines: v.isReceipt ? [
      { account: sourceAccount, group: "Bank Accounts", dr: v.amount },
      { account: v.partyName, group: v.partyGroup, cr: v.amount }
    ] : [
      { account: v.partyName, group: v.partyGroup, dr: v.amount },
      { account: sourceAccount, group: "Bank Accounts", cr: v.amount }
    ]
  });
}
function round22(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
async function postSaleJournal(v) {
  const prior = await getClient().execute({
    sql: "SELECT id FROM journal_entries WHERE sale_id = ? ORDER BY id",
    args: [v.saleId]
  });
  const priorIds = prior.rows.map((r) => n2(r.id)).filter(Boolean);
  const taxable = n2(v.amount);
  const gst = n2(v.gst);
  const ro = n2(v.roundOff);
  const freight = n2(v.freightAmount);
  const transporterName = String(v.transporterName || "").trim();
  if (taxable <= 0 && gst <= 0) {
    await deleteJournalByRef("sale_id", v.saleId);
    return;
  }
  const hasFreight = freight > 0 && !!transporterName;
  const deducted = !!v.deductFreight && hasFreight;
  const tds = round22(n2(v.tds));
  const customerDr = round22(taxable + gst + ro - (deducted ? freight : 0) - tds);
  const lines = [
    { account: v.customerName || "CASH CUSTOMER A/C", group: "Sundry Debtors", dr: customerDr },
    { account: `${v.productCode} SALE A/C`, group: "Sales Accounts", cr: taxable },
    { account: "GST OUTPUT A/C", group: "Duties & Taxes", cr: gst },
    { account: "ROUND OFF A/C", group: "Indirect Expenses", cr: ro > 0 ? ro : 0, dr: ro < 0 ? -ro : 0 }
  ];
  if (tds > 4e-3) {
    lines.push({ account: "TDS RECEIVABLE A/C", group: "Deposits (Asset)", dr: tds });
  }
  if (hasFreight) {
    lines.push({ account: "FREIGHT OUTWARD A/C", group: "Direct Expenses", dr: freight });
    if (!deducted) {
      lines.push({ account: "FREIGHT PAYABLE A/C", group: "Current Liabilities", cr: freight });
    }
  }
  const args = {
    date: v.date,
    vchType: "SALE",
    vchNo: v.invoiceNo,
    saleId: v.saleId,
    companyId: v.companyId,
    lines
  };
  if (priorIds.length) {
    for (const extra of priorIds.slice(1)) {
      await getClient().execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [extra] });
      await getClient().execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [extra] });
    }
    await repostJournal(priorIds[0], args);
    return;
  }
  await postJournal(args);
}
async function backfillJournal() {
  const c = getClient();
  await getOrCreateAccount("ROUND OFF A/C", "Indirect Expenses").catch(() => {
  });
  await getOrCreateAccount("INTEREST A/C", "Indirect Expenses").catch(() => {
  });
  await getOrCreateAccount("GST INPUT A/C", "Duties & Taxes").catch(() => {
  });
  await getOrCreateAccount("GST OUTPUT A/C", "Duties & Taxes").catch(() => {
  });
  await getOrCreateAccount("TDS PAYABLE A/C", "Duties & Taxes").catch(() => {
  });
  await getOrCreateAccount("BANK A/C", "Bank Accounts").catch(() => {
  });
  const orders = await c.execute(`
    SELECT o.id, o.invoice_no, o.order_date, o.taxable_value, o.gst_amount, o.tds_amount, o.round_off, o.net_amount,
           o.interest_pct, o.interest_days, o.bargain_rate, o.ordered_qty, o.company_id,
           s.name AS supplier_name, p.code AS oil_code, p.name AS oil_name
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products p ON p.id = o.oil_type_id
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.order_id = o.id)
  `);
  for (const r of orders.rows) {
    const interest = n2(r.bargain_rate) * (n2(r.interest_pct) / 100) * (n2(r.interest_days) / 365) * n2(r.ordered_qty);
    await postPurchaseJournal({
      orderId: Number(r.id),
      date: String(r.order_date),
      invoiceNo: String(r.invoice_no || ""),
      oilCode: String(r.oil_code || r.oil_name || "OIL").toUpperCase(),
      supplierName: String(r.supplier_name || "SUPPLIER"),
      taxable: n2(r.taxable_value),
      gst: n2(r.gst_amount),
      tds: n2(r.tds_amount),
      net: n2(r.net_amount),
      roundOff: n2(r.round_off),
      interest,
      companyId: n2(r.company_id) || 1
    }).catch(() => {
    });
  }
  const pays = await c.execute(`
    SELECT p.id, p.party_type, p.payment_date, p.amount, p.source, p.reference, p.company_id,
           CASE p.party_type WHEN 'supplier' THEN s.name WHEN 'transporter' THEN t.name ELSE cu.name END AS party_name
    FROM payments p
    LEFT JOIN suppliers s ON p.party_type = 'supplier' AND s.id = p.party_id
    LEFT JOIN transporters t ON p.party_type = 'transporter' AND t.id = p.party_id
    LEFT JOIN customers cu ON p.party_type = 'customer' AND cu.id = p.party_id
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.payment_id = p.id)
  `);
  for (const r of pays.rows) {
    await postPaymentJournal({
      paymentId: Number(r.id),
      date: String(r.payment_date),
      partyName: String(r.party_name || "PARTY"),
      partyGroup: String(r.party_type) === "customer" ? "Sundry Debtors" : "Sundry Creditors",
      source: String(r.source || "BANK"),
      amount: n2(r.amount),
      isReceipt: String(r.party_type) === "customer",
      reference: r.reference ? String(r.reference) : null,
      companyId: n2(r.company_id) || 1
    }).catch(() => {
    });
  }
  const sales = await c.execute(`
    SELECT MIN(s.id) AS id, MIN(s.sale_date) AS sale_date, MIN(s.invoice_no) AS invoice_no,
           MIN(s.customer) AS customer, SUM(s.amount) AS amount, MIN(s.company_id) AS company_id,
           MIN(p.code) AS code, MIN(p.name) AS name
    FROM sales s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries je
      JOIN sales s2 ON s2.id = je.sale_id
      WHERE COALESCE(s2.invoice_group, 'L' || s2.id) = COALESCE(s.invoice_group, 'L' || s.id)
    )
    GROUP BY COALESCE(s.invoice_group, 'L' || s.id)
  `);
  for (const r of sales.rows) {
    await postSaleJournal({
      saleId: Number(r.id),
      date: String(r.sale_date),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      productCode: String(r.code || r.name || "FG").toUpperCase(),
      customerName: String(r.customer || "").trim(),
      amount: n2(r.amount),
      companyId: n2(r.company_id) || 1
    }).catch(() => {
    });
  }
  const total = orders.rows.length + pays.rows.length + sales.rows.length;
  if (total > 0) {
    console.log(
      `[journal] backfilled ${orders.rows.length} purchases, ${pays.rows.length} payments, ${sales.rows.length} sales`
    );
  }
}
async function addManualJournal(d) {
  const amount = n2(d.amount);
  if (amount <= 0) throw new Error("Enter an amount");
  if (!d.dr_account || !d.cr_account) throw new Error("Pick the Dr and Cr accounts");
  return postJournal({
    date: String(d.entry_date),
    vchType: String(d.vch_type || "JOURNAL"),
    vchNo: d.vch_no || null,
    narration: d.narration || null,
    lines: [
      { account: String(d.dr_account), dr: amount },
      { account: String(d.cr_account), cr: amount }
    ]
  });
}

// src/main/backup.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/main/dbsnapshot.ts
var import_node_zlib = require("node:zlib");
function lit(v) {
  if (v === null || v === void 0) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const buf = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    return `X'${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}
function idempotent(sql) {
  return sql.replace(
    /^\s*CREATE\s+(UNIQUE\s+|TEMP\s+|TEMPORARY\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?!IF\s+NOT\s+EXISTS)/i,
    (_m, mod, kind) => `CREATE ${mod || ""}${kind} IF NOT EXISTS `
  );
}
function internal(name) {
  return name.startsWith("sqlite_") || name.startsWith("libsql_") || name === "_litestream_seq";
}
var ROWS_PER_INSERT = 200;
var READ_PAGE = 2e3;
var RID = "__snapshot_rowid";
async function* readTable(c, table) {
  let after = 0;
  for (; ; ) {
    let res;
    try {
      res = await c.execute({
        sql: `SELECT rowid AS ${RID}, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${READ_PAGE}`,
        args: [after]
      });
    } catch {
      const all = await c.execute(`SELECT * FROM "${table}"`);
      if (all.rows.length) {
        yield { columns: all.columns, rows: all.rows };
      }
      return;
    }
    if (!res.rows.length) return;
    const columns = res.columns.filter((x) => x !== RID);
    const rows = res.rows;
    after = rows[rows.length - 1][RID];
    yield { columns, rows };
    if (res.rows.length < READ_PAGE) return;
  }
}
async function dumpSql(from) {
  const c = from ?? getClient();
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const out = [
    `-- Rishabh Oil database snapshot, taken ${at}`,
    "-- Restore it from Settings -> Database on the website, or by hand:",
    "--   sqlite3 restored.db < this-file.sql",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;"
  ];
  const master = await c.execute(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`
  );
  const tables = [];
  for (const r of master.rows) {
    const name = String(r.name);
    if (internal(name)) continue;
    out.push(`${idempotent(String(r.sql))};`);
    if (String(r.type) === "table") tables.push(name);
  }
  let rows = 0;
  for (const table of tables) {
    let wrote = 0;
    const at2 = out.length;
    out.push("");
    for await (const page of readTable(c, table)) {
      wrote += page.rows.length;
      const cols = page.columns.map((x) => `"${x}"`).join(", ");
      for (let i = 0; i < page.rows.length; i += ROWS_PER_INSERT) {
        const slice = page.rows.slice(i, i + ROWS_PER_INSERT);
        const tuples = slice.map((row) => `(${page.columns.map((col) => lit(row[col])).join(", ")})`).join(",\n  ");
        out.push(`INSERT INTO "${table}" (${cols}) VALUES
  ${tuples};`);
      }
    }
    if (wrote) out[at2] = `-- ${table}: ${wrote} rows`;
    else out.splice(at2, 1);
    rows += wrote;
  }
  try {
    const seq = await c.execute("SELECT name, seq FROM sqlite_sequence");
    if (seq.rows.length) {
      out.push("-- AUTOINCREMENT high-water marks");
      for (const r of seq.rows) {
        out.push(
          `DELETE FROM sqlite_sequence WHERE name = ${lit(r.name)}; INSERT INTO sqlite_sequence (name, seq) VALUES (${lit(r.name)}, ${lit(r.seq)});`
        );
      }
    }
  } catch {
  }
  out.push("COMMIT;");
  const sql = out.join("\n");
  return { sql, at, tables: tables.length, rows, bytes: Buffer.byteLength(sql, "utf8") };
}
function stamp() {
  const d = /* @__PURE__ */ new Date();
  const p = (n25) => String(n25).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function snapshotGz() {
  const snap = await dumpSql();
  const buf = (0, import_node_zlib.gzipSync)(Buffer.from(snap.sql, "utf8"), { level: 9 });
  return {
    at: snap.at,
    tables: snap.tables,
    rows: snap.rows,
    bytes: snap.bytes,
    gz: buf.toString("base64"),
    gzBytes: buf.length,
    fileName: `rishabh-snapshot-${stamp()}.sql.gz`
  };
}

// src/main/backup.ts
function todayISO2() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function dailyBackup(dirOverride) {
  const dir = dirOverride || (0, import_node_path2.join)(app.getPath("userData"), "backup");
  if (!(0, import_node_fs2.existsSync)(dir)) (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
  const file = (0, import_node_path2.join)(dir, `rishabh-oil-backup-${todayISO2()}.sql`);
  if ((0, import_node_fs2.existsSync)(file)) return { file, skipped: true };
  const snap = await dumpSql();
  (0, import_node_fs2.writeFileSync)(file, snap.sql, "utf-8");
  const keep = 7;
  const olds = (0, import_node_fs2.readdirSync)(dir).filter((f) => /^rishabh-oil-backup-\d{4}-\d{2}-\d{2}\.sql$/.test(f)).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
    try {
      (0, import_node_fs2.unlinkSync)((0, import_node_path2.join)(dir, f));
    } catch {
    }
  }
  console.log(`[backup] daily backup written: ${file} (${snap.rows} rows)`);
  return { file, skipped: false };
}

// src/main/currentUser.ts
var current = { id: null, username: "system" };
function setCurrentUser(id, username) {
  const ctx = currentRequestContext();
  if (ctx) {
    ctx.userId = id ?? null;
    ctx.username = username || "system";
    return { ok: true };
  }
  current = { id: id ?? null, username: username || "system" };
  return { ok: true };
}
function getCurrentUser() {
  const ctx = currentRequestContext();
  if (ctx) return { id: ctx.userId, username: ctx.username };
  return current;
}

// src/main/access-rules.ts
var OK = { allowed: true };
var ALWAYS_OPEN = /* @__PURE__ */ new Set(["approvals"]);
var SECTION_PARENT = {
  treasuryLc: "treasury",
  treasuryBd: "treasury",
  treasuryTracker: "treasury"
};
function modulePerm(user, moduleKey) {
  if (!user) return {};
  if (user.role === "admin") {
    return { view: true, create: true, edit: true, delete: true, editDays: null };
  }
  if (ALWAYS_OPEN.has(moduleKey)) {
    return { view: true, create: true, edit: true, delete: true, editDays: null };
  }
  const p = user.permissions;
  if (Array.isArray(p)) {
    return p.includes(moduleKey) ? { view: true, create: true, edit: true, delete: true, editDays: null } : {};
  }
  if (p && typeof p === "object") {
    const entry = p[moduleKey];
    if (entry === "write") return { view: true, create: true, edit: true, delete: true, editDays: null };
    if (entry === "read") return { view: true };
    if (entry && typeof entry === "object") {
      const e = entry;
      const view = e.view ?? !!(e.create || e.edit || e.delete);
      return { ...e, view };
    }
    const parent = SECTION_PARENT[moduleKey];
    if (parent) {
      const up = p[parent];
      if (up === "write") return { view: true, create: true, edit: true, delete: true, editDays: null };
      if (up === "read") return { view: true };
      if (up && typeof up === "object") {
        const e = up;
        const view = e.view ?? !!(e.create || e.edit || e.delete);
        return { ...e, view };
      }
    }
  }
  return {};
}
function moduleScope(user, moduleKey) {
  if (!user || user.role === "admin") return null;
  const scope = modulePerm(user, moduleKey).scope;
  return scope ? String(scope) : null;
}
function windowStart(days, today) {
  const t = String(today).slice(0, 10);
  const d = /* @__PURE__ */ new Date(`${t}T00:00:00`);
  d.setDate(d.getDate() - Math.max(0, (Number(days) || 0) - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function withinWindow(date, days, today) {
  const d = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= windowStart(days, today);
}
function ageInDays(entryDate, today) {
  const d = String(entryDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const a = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  const t = String(today).slice(0, 10);
  const b = Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));
  return Math.max(0, Math.round((b - a) / 864e5));
}
function viewDays(user, moduleKey) {
  if (!user || String(user.role || "").toLowerCase() === "admin") return null;
  const v = modulePerm(user, moduleKey).viewDays;
  return v == null ? null : Math.max(0, Number(v) || 0);
}
function entryDays(user, moduleKey) {
  if (!user || String(user.role || "").toLowerCase() === "admin") return null;
  const e = modulePerm(user, moduleKey).editDays;
  if (e == null) return viewDays(user, moduleKey);
  return Math.max(0, Number(e) || 0);
}
function alterDays(user, moduleKey) {
  const e = entryDays(user, moduleKey);
  const v = viewDays(user, moduleKey);
  if (e == null) return v;
  return v == null ? e : Math.min(e, v);
}
function can(user, moduleKey, action, opts = { today: "" }) {
  const label = opts.moduleLabel || moduleKey;
  const perm = modulePerm(user, moduleKey);
  if (!perm.view && !perm.create && !perm.edit && !perm.delete) {
    return { allowed: false, reason: `You do not have access to ${label}` };
  }
  if (action === "view") {
    return perm.view ? OK : { allowed: false, reason: `You cannot view ${label}` };
  }
  if (action === "create") {
    if (!perm.create) return { allowed: false, reason: `You cannot add new entries in ${label}` };
    const limit2 = entryDays(user, moduleKey);
    if (limit2 == null || opts.entryDate == null) return OK;
    if (withinWindow(opts.entryDate, limit2, opts.today)) return OK;
    return {
      allowed: false,
      lockedByAge: true,
      reason: `You can only date a new ${label} entry ${limit2 <= 1 ? "today" : `from ${windowStart(limit2, opts.today)} onwards`}`
    };
  }
  if (!perm[action]) {
    return {
      allowed: false,
      reason: action === "edit" ? `You cannot edit entries in ${label}` : `You cannot delete entries in ${label}`
    };
  }
  const limit = alterDays(user, moduleKey);
  if (limit == null) return OK;
  if (withinWindow(opts.entryDate, limit, opts.today)) return OK;
  const days = ageInDays(opts.entryDate, opts.today);
  const window = limit <= 1 ? "the day it is dated" : `a ${limit}-day window (from ${windowStart(limit, opts.today)})`;
  return {
    allowed: false,
    lockedByAge: true,
    reason: `This entry is dated ${days} days ago and can only be ${action === "edit" ? "edited" : "deleted"} within ${window}`
  };
}

// src/main/access-gate.ts
var CHANNEL_RULES = {
  // module keys MUST match MODULES in src/renderer/src/lib/modules.ts — a key
  // that is not grantable there would read as "no access" and refuse every
  // write. Namespaces with no grantable module are left out on purpose so they
  // keep working exactly as before.
  orders: { module: "orders", label: "Purchases", table: "orders", dateCol: "order_date" },
  tankers: { module: "orders", label: "Purchases", table: "purchase_tankers", dateCol: "loaded_date" },
  bargains: { module: "bargains", label: "Purchase bargains", table: "bargains", dateCol: "bargain_date" },
  sales: { module: "sales", label: "Sales", table: "sales", dateCol: "sale_date" },
  salesBargains: {
    module: "salesBargains",
    label: "Sales bargains",
    table: "sales_bargains",
    dateCol: "bargain_date"
  },
  consignment: {
    module: "consignment",
    label: "Consignment stock",
    table: "consignment_stock",
    dateCol: "deposit_date"
  },
  gate: { module: "gateEntry", label: "Gate entries", table: "gate_entries", dateCol: "entry_date" },
  // Treasury's three sections are granted separately, so each channel names
  // the section it belongs to rather than the page they share.
  //
  // `payments` used to name a module key that is not grantable anywhere, which
  // read as "no access" and refused every payment a non-admin tried to make.
  payments: { module: "treasuryTracker", label: "Payment Tracker", table: "payments", dateCol: "payment_date" },
  tbill: { module: "treasuryTracker", label: "Payment Tracker" },
  lc: { module: "treasuryLc", label: "Letters of Credit" },
  bd: { module: "treasuryBd", label: "Bill Discounting" },
  billDiscounts: { module: "treasuryBd", label: "Bill discounts" },
  production: { module: "production", label: "Production", table: "production", dateCol: "prod_date" },
  // One table behind two menus; the Debit note grant governs both.
  notes: { module: "debitNotes", label: "Debit/Credit notes", table: "notes", dateCol: "note_date" },
  trading: { module: "trading", label: "Trading", table: "trading_deals", dateCol: "deal_date" },
  stockCount: { module: "stock", label: "Stock" },
  skuStock: { module: "stock", label: "Stock" },
  // The packed shelf's opening count, open to everyone for the same reason
  // stockOpening is: it is counted by the people on the floor, and until it
  // is in, every SKU that has shipped reads negative. See assertAllowed.
  skuOpening: { module: "stock", label: "Stock" },
  formulations: { module: "formulation", label: "Formulations" },
  // The recipe sub-category master. Governed by the Formulation grant, since
  // renaming or retiring one reclassifies every recipe pointing at it.
  formulationSubcategory: { module: "formulation", label: "Recipe sub-categories" },
  // Stock brought forward. Every balance in the register stands on these, so it
  // belongs behind the Stock grant rather than being reachable by anyone who can
  // open the page.
  stockOpening: { module: "stock", label: "Opening stock" }
};
var READ_OPS = /* @__PURE__ */ new Set([
  "list",
  "get",
  "items",
  "issuances",
  "sheet",
  "outstanding",
  "all",
  "summary",
  "transfers",
  "fyTaxable",
  "needs",
  "breakdown",
  "nextNo",
  "liveUsers",
  "ips",
  "logs",
  "dispatchableSales",
  "mine",
  "pendingCount",
  "pending",
  "lots",
  "unmapped",
  "unmappedCount",
  "bargainLines",
  "consignmentDraws",
  "accounts",
  "statement",
  "suppliers",
  "transporters",
  "customers",
  "returns",
  "unattributedReturns"
]);
function actionFor(op) {
  if (op === "create" || op === "record" || op === "issue" || op === "transfer" || op === "createInvoice") return "create";
  if (op === "delete" || op === "remove" || op === "removeInvoice" || op === "deleteEntry" || op === "deleteTransfer" || // Removing a packed-stock entry is a deletion, not an edit. Without this
  // it fell through to 'edit' and anyone who could enter packing could also
  // delete somebody else's.
  op === "deleteAdjustment" || op === "deleteIssuance" || op === "removeIssuance") return "delete";
  return "edit";
}
var GATE_FINISH_OPS = /* @__PURE__ */ new Set(["complete", "weights", "skipWeighment"]);
async function gateEntryUnfinished(id) {
  if (!id) return false;
  try {
    const res = await getClient().execute({
      sql: `SELECT COALESCE(status, '') AS s FROM gate_entries WHERE id = ? LIMIT 1`,
      args: [id]
    });
    if (!res.rows.length) return false;
    return String(res.rows[0].s) !== "completed";
  } catch {
    return false;
  }
}
var cache = null;
function clearAccessCache() {
  cache = null;
}
async function currentAccessUser() {
  const { id } = getCurrentUser();
  if (!id) return null;
  if (cache && cache.id === id) return cache.user;
  const res = await getClient().execute({
    sql: "SELECT role, permissions, active FROM users WHERE id = ? LIMIT 1",
    args: [id]
  });
  if (!res.rows.length) return null;
  const r = res.rows[0];
  let permissions = {};
  try {
    permissions = r.permissions ? JSON.parse(String(r.permissions)) : {};
  } catch {
    permissions = {};
  }
  const user = { role: String(r.role || ""), permissions };
  cache = { id, user };
  return user;
}
async function visibleFrom(moduleKey) {
  const user = await currentAccessUser();
  if (!user) return null;
  const days = viewDays(user, moduleKey);
  if (days == null) return null;
  return windowStart(days, todayISO());
}
async function entryWindows() {
  const out = {};
  const user = await currentAccessUser();
  if (!user) return out;
  if (String(user.role || "").toLowerCase() === "admin") return out;
  const perms = user.permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return out;
  const today = todayISO();
  for (const key3 of Object.keys(perms)) {
    const days = entryDays(user, key3);
    if (days != null) out[key3] = windowStart(days, today);
  }
  return out;
}
async function visibleFromFor(ownModule, callerModule) {
  if (!callerModule || callerModule === ownModule) return visibleFrom(ownModule);
  const user = await currentAccessUser();
  if (!user) return null;
  if (!modulePerm(user, callerModule).view) return visibleFrom(ownModule);
  return visibleFrom(callerModule);
}
async function currentScope(moduleKey) {
  const user = await currentAccessUser();
  if (!user) return null;
  return moduleScope(user, moduleKey);
}
async function assertOnOrAfterBooksStart(rule, op, args) {
  if (!rule.dateCol) return;
  if (actionFor(op) !== "create") return;
  const a = args;
  const raw = a?.values?.[rule.dateCol] ?? a?.[rule.dateCol];
  const d = String(raw ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  const from = await getBooksFrom();
  if (!from || d >= from) return;
  throw new Error(
    `These books begin on ${from}. An entry dated ${d} falls before that, where the opening balances already account for it \u2014 it would be counted twice.`
  );
}
function assertScopedSales(op, args) {
  const stage = String(args?.stage || "");
  const isUnload = (op === "setInvoiceStage" || op === "setStage") && stage === "unloaded";
  if (!isUnload) {
    throw new Error(
      "Your access to Sales covers recording received quantities on deliveries only \u2014 nothing else on this page can be changed."
    );
  }
}
async function assertAllowed(channel, args) {
  const [ns, op] = String(channel).split(":");
  const rule = CHANNEL_RULES[ns];
  if (!rule || !op) return;
  if (READ_OPS.has(op)) return;
  if (ns === "stockOpening" || ns === "skuOpening") return;
  await assertOnOrAfterBooksStart(rule, op, args);
  const user = await currentAccessUser();
  if (!user) return;
  if (user.role === "admin") return;
  if (moduleScope(user, rule.module) === "unload" && rule.module === "sales") {
    assertScopedSales(op, args);
    return;
  }
  let action = actionFor(op);
  if (ns === "gate" && action === "edit" && GATE_FINISH_OPS.has(op) && await gateEntryUnfinished(Number(args?.id) || 0)) {
    action = "create";
  }
  let entryDate;
  const id = Number(args?.id) || 0;
  if (action === "create" && rule.dateCol) {
    const a = args;
    entryDate = a?.values?.[rule.dateCol] ?? a?.[rule.dateCol];
  }
  if ((action === "edit" || action === "delete") && rule.table && rule.dateCol && id) {
    try {
      const res = await getClient().execute({
        sql: `SELECT ${rule.dateCol} AS d FROM ${rule.table} WHERE id = ? LIMIT 1`,
        args: [id]
      });
      entryDate = res.rows[0]?.d;
    } catch {
      entryDate = void 0;
    }
  }
  const verdict = can(user, rule.module, action, {
    entryDate,
    today: todayISO(),
    moduleLabel: rule.label
  });
  if (!verdict.allowed) throw new Error(verdict.reason || "You are not allowed to do that");
}

// src/main/gate.ts
function toPlain3(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function nowHHMM() {
  const d = /* @__PURE__ */ new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function n3(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
async function listGateEntries() {
  const from = await visibleFrom("gateEntry");
  const res = await getClient().execute({
    args: from ? [from] : [],
    sql: `
    SELECT g.*, p.code AS oil_code, p.name AS oil_name,
           b.bargain_no, COALESCE(ds.name, s.name, dc.name) AS supplier_name,
           dc.name AS gate_customer_name,
           COALESCE(sl.invoice_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_invoice,
           COALESCE(sl.customer,  (SELECT customer  FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_customer,
           -- A vehicle can carry several invoices out; the register names them
           -- all rather than only the one written on the entry.
           (SELECT COUNT(*) FROM gate_entry_sales gs WHERE gs.gate_entry_id = g.id) AS sale_count,
           (SELECT GROUP_CONCAT(x.invoice_no, ', ') FROM gate_entry_sales gs
              JOIN sales x ON x.id = gs.sale_id WHERE gs.gate_entry_id = g.id) AS sale_invoices
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN suppliers ds ON ds.id = g.supplier_id
    LEFT JOIN customers dc ON dc.id = g.customer_id
    LEFT JOIN sales sl ON sl.id = g.sale_id
    ${/* Compared directly, not through substr(): a function around the column
        makes the whole thing unindexable, and a plain string compare is
        correct anyway since the dates sort lexicographically. */
    ""}
    ${from ? "WHERE (g.entry_date >= ? OR COALESCE(g.status, '') <> 'completed')" : ""}
    ORDER BY g.id DESC
  `
  });
  return toPlain3(res);
}
async function gateEntriesFor(args) {
  const orderId = n3(args?.orderId);
  const saleIds = (args?.saleIds || []).map(n3).filter((x) => x > 0);
  const group = String(args?.invoiceGroup || "").trim();
  const where = [];
  const bind = [];
  if (orderId) {
    where.push("g.tanker_id IN (SELECT id FROM purchase_tankers WHERE order_id = ?)");
    bind.push(orderId);
  }
  if (saleIds.length) {
    const ph = saleIds.map(() => "?").join(", ");
    where.push(`g.sale_id IN (${ph})`);
    bind.push(...saleIds);
    where.push(
      `EXISTS (SELECT 1 FROM gate_entry_sales gs WHERE gs.gate_entry_id = g.id AND gs.sale_id IN (${ph}))`
    );
    bind.push(...saleIds);
  }
  if (group) {
    where.push("g.invoice_group = ? AND COALESCE(g.invoice_group, '') <> ''");
    bind.push(group);
  }
  if (!where.length) return { rows: [], hidden: 0, window_from: "" };
  const res = await getClient().execute({
    args: bind,
    sql: `
    SELECT g.*, p.code AS oil_code, p.name AS oil_name,
           b.bargain_no,
           COALESCE(ds.name, s.name, dc.name) AS party_name,
           dc.name AS gate_customer_name,
           pt.tanker_no AS purchase_tanker_no,
           pt.loaded_qty AS tanker_loaded_qty,
           pt.order_id AS purchase_order_id,
           o.invoice_no AS purchase_invoice_no,
           t.name AS transporter_name,
           src.name AS source_name,
           (SELECT COUNT(*) FROM gate_entry_sales gs WHERE gs.gate_entry_id = g.id) AS sale_count,
           (SELECT GROUP_CONCAT(x.invoice_no, ', ') FROM gate_entry_sales gs
              JOIN sales x ON x.id = gs.sale_id WHERE gs.gate_entry_id = g.id) AS sale_invoices,
           COALESCE(sl.invoice_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_invoice,
           COALESCE(sl.customer,  (SELECT customer  FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_customer
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN transporters t ON t.id = pt.transporter_id
    LEFT JOIN sources src ON src.id = pt.source_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN suppliers ds ON ds.id = g.supplier_id
    LEFT JOIN customers dc ON dc.id = g.customer_id
    LEFT JOIN sales sl ON sl.id = g.sale_id
    WHERE ${where.join(" OR ")}
    ORDER BY g.entry_date DESC, g.id DESC
  `
  });
  const all = toPlain3(res);
  const from = await visibleFrom("gateEntry");
  if (!from) return { rows: all, hidden: 0, window_from: "" };
  const rows = all.filter(
    (r) => String(r.entry_date || "") >= from || String(r.status || "") !== "completed"
  );
  return { rows, hidden: all.length - rows.length, window_from: from };
}
async function nextGateEntryNo(direction = "in") {
  const res = await getClient().execute({
    sql: "SELECT gate_entry_no FROM gate_entries WHERE COALESCE(direction, 'in') = ?",
    args: [direction]
  });
  let maxSeq = 0;
  for (const r of res.rows) {
    const parts = String(r.gate_entry_no).split("/");
    const seq = parseInt(parts[parts.length - 1] ?? "0", 10);
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${direction === "out" ? "GO" : "GE"}/${String(maxSeq + 1).padStart(4, "0")}`;
}
async function listDispatchableSales() {
  const res = await getClient().execute(`
    SELECT s.invoice_group,
           MAX(s.sale_date) AS sale_date,
           MAX(s.invoice_no) AS invoice_no,
           MAX(s.customer) AS customer,
           SUM(s.qty) AS qty,
           MAX(s.uom) AS uom,
           COUNT(*) AS item_count,
           GROUP_CONCAT(pr.name, ', ') AS product_name,
           MAX(pr.material_type) AS product_category,
           (SELECT COUNT(*) FROM gate_entries g
              WHERE g.direction = 'out'
                AND (g.invoice_group = s.invoice_group
                     OR EXISTS (SELECT 1 FROM gate_entry_sales gs
                                WHERE gs.gate_entry_id = g.id AND gs.invoice_group = s.invoice_group))) AS gate_outs
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    -- A trading sale is a pass-through on paper: the goods never come to our
    -- yard, so no vehicle is ever weighed out against it.
    WHERE s.status = 'done' AND s.invoice_group IS NOT NULL
      AND COALESCE(s.is_trading, 0) = 0 AND s.rejected_at IS NULL
    GROUP BY s.invoice_group
    ORDER BY MAX(s.sale_date) DESC, MAX(s.id) DESC
    LIMIT 300
  `);
  return toPlain3(res);
}
async function tankerGateReceived(tankerId) {
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(received_qty), 0) AS qty, COUNT(*) AS cnt
          FROM gate_entries
          WHERE tanker_id = ? AND status = 'completed' AND COALESCE(no_weighment, 0) = 0`,
    args: [tankerId]
  });
  if (!res.rows.length || n3(res.rows[0].cnt) === 0) return null;
  return n3(res.rows[0].qty);
}
async function partyCategories() {
  const res = await getClient().execute(`
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')) AS cat, 'supplier' AS side, o.supplier_id AS id
      FROM orders o JOIN products p ON p.id = o.oil_type_id WHERE o.supplier_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'supplier', b.supplier_id
      FROM bargains b JOIN products p ON p.id = b.oil_type_id WHERE b.supplier_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(su.supplier_type, '')), 'supplier', su.id
      FROM suppliers su WHERE COALESCE(su.supplier_type, '') != ''
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'customer', s.customer_id
      FROM sales s JOIN products p ON p.id = s.product_id WHERE s.customer_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'customer', sb.customer_id
      FROM sales_bargains sb JOIN products p ON p.id = sb.product_id WHERE sb.customer_id IS NOT NULL
  `);
  return toPlain3(res).filter((r) => String(r.cat || "").trim() !== "" && Number(r.id) > 0);
}
function parseDispatch(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string" && v.trim().toUpperCase() === "NA") return { qty: 0, na: true };
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  if (x < 0) throw new Error("Dispatch quantity cannot be negative");
  return { qty: x, na: false };
}
async function createGateEntry(v) {
  const c = getClient();
  const direction = v.direction === "out" ? "out" : "in";
  const kind = String(v.entry_kind || "standard") === "simple" ? "simple" : "standard";
  if (kind === "simple") {
    if (!String(v.tanker_no || "").trim()) throw new Error("Enter the vehicle number");
    if (!String(v.note || "").trim()) throw new Error("Say what the vehicle is carrying");
  }
  const outGroups = Array.isArray(v.invoice_groups) ? v.invoice_groups.map((g) => String(g || "").trim()).filter(Boolean) : [];
  if (outGroups.length && !v.invoice_group) v.invoice_group = outGroups[0];
  if (kind === "standard" && direction === "out" && !v.invoice_group && !v.sale_id && !String(v.note || "").trim()) {
    throw new Error("Pick the sale invoice being dispatched, or write why the vehicle is leaving without one");
  }
  if (!n3(v.tanker_id) && !String(v.tanker_no || "").trim()) {
    throw new Error("Pick a tanker from the list or type the vehicle number");
  }
  const gateNo = await nextGateEntryNo(direction);
  const dIn = parseDispatch(v.dispatch_na ? "NA" : v.dispatch_qty);
  const noWeighment = !!v.no_weighment || kind === "simple";
  const status = noWeighment ? "completed" : v.status || (n3(v.received_qty) > 0 ? "completed" : "pending");
  const res = await c.execute({
    sql: `INSERT INTO gate_entries
      (gate_entry_no, ref_no, entry_date, entry_time, tanker_id, tanker_no, oil_type_id, dispatch_qty, dispatch_na, received_qty, uom, status, note, direction, sale_id, invoice_group, rec_type, gross_weight, tare_weight, supplier_id, is_direct_mnc, no_weighment, customer_id, person, entry_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      gateNo,
      v.ref_no ? String(v.ref_no).trim() : null,
      v.entry_date,
      // Whatever the barrier says, else the clock now — the gateman should not
      // have to type the time of an entry he is making as it happens.
      v.entry_time ? String(v.entry_time).slice(0, 5) : nowHHMM(),
      v.tanker_id ? n3(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n3(v.oil_type_id) : null,
      dIn ? dIn.qty : 0,
      dIn?.na ? 1 : 0,
      n3(v.received_qty),
      v.uom || "MT",
      status,
      v.note || null,
      direction,
      v.sale_id ? n3(v.sale_id) : null,
      v.invoice_group ? String(v.invoice_group) : null,
      String(v.rec_type || "OIL"),
      v.gross_weight != null && v.gross_weight !== "" ? n3(v.gross_weight) : null,
      v.tare_weight != null && v.tare_weight !== "" ? n3(v.tare_weight) : null,
      v.supplier_id ? n3(v.supplier_id) : null,
      v.is_direct_mnc ? 1 : 0,
      noWeighment ? 1 : 0,
      v.customer_id ? n3(v.customer_id) : null,
      v.person ? String(v.person).trim() : null,
      kind
    ]
  });
  const newId = Number(res.lastInsertRowid);
  const linkGroups = outGroups.length ? outGroups : v.invoice_group ? [String(v.invoice_group)] : [];
  if (linkGroups.length) await setGateEntrySales(newId, linkGroups);
  return { id: newId };
}
async function completeGateEntry(id, gross, tare) {
  const g = Number(gross);
  const t = Number(tare) || 0;
  if (!Number.isFinite(g) || g <= 0) throw new Error("Enter the gross weight");
  if (t < 0) throw new Error("Tare weight cannot be negative");
  const net = Math.round((g - t) * 1e3) / 1e3;
  if (net <= 0) throw new Error("Net weight (gross \u2212 tare) must be greater than zero");
  await getClient().execute({
    sql: "UPDATE gate_entries SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = 'completed' WHERE id = ?",
    args: [g, t, net, id]
  });
  return { id };
}
async function saveGateWeights(id, gross, tare, awaitingGrossOut, dispatchQty, invoiceGroup, outDate, outTime) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT * FROM gate_entries WHERE id = ?", args: [id] });
  if (!cur.rows.length) throw new Error("Gate entry not found");
  const row = cur.rows[0];
  const given = (v, existing) => {
    if (v == null || !Number.isFinite(Number(v))) return existing == null ? null : n3(existing);
    return Number(v);
  };
  const g = given(gross, row.gross_weight);
  const t = given(tare, row.tare_weight);
  if (g != null && g < 0) throw new Error("Gross weight cannot be negative");
  if (t != null && t < 0) throw new Error("Tare weight cannot be negative");
  if (g == null && t == null) throw new Error("Enter the gross or the tare weight");
  const both = g != null && t != null;
  const net = both ? Math.round((g - t) * 1e3) / 1e3 : null;
  if (both && net <= 0) {
    throw new Error("Net weight (gross \u2212 tare) must be greater than zero \u2014 check the two figures");
  }
  const flag = typeof awaitingGrossOut === "boolean" ? awaitingGrossOut ? 1 : 0 : n3(row.awaiting_gross_out);
  const d = parseDispatch(dispatchQty);
  const dispQty = d ? d.qty : n3(row.dispatch_qty);
  const dispNa = d ? d.na : !!n3(row.dispatch_na);
  let group = row.invoice_group;
  let saleId = row.sale_id;
  let customerId = row.customer_id;
  const namedGroups = Array.isArray(invoiceGroup) ? invoiceGroup.map((g2) => String(g2 || "").trim()).filter(Boolean) : invoiceGroup != null && String(invoiceGroup).trim() !== "" ? [String(invoiceGroup).trim()] : [];
  if (namedGroups.length) {
    const primary = await setGateEntrySales(id, namedGroups);
    group = primary.group;
    saleId = primary.saleId;
    customerId = primary.customerId ?? customerId;
  }
  const nowOut = both && n3(row.awaiting_gross_out) === 1 && !!group;
  const direction = nowOut ? "out" : String(row.direction || "in");
  const pairClosed = !nowOut && both && n3(row.awaiting_gross_out) !== 1 && !row.out_date;
  const leftOn = nowOut || pairClosed ? String(outDate || "").slice(0, 10) || todayISO() : row.out_date;
  const leftAt = (nowOut || pairClosed) && !row.out_time ? outTime ? String(outTime).slice(0, 5) : nowHHMM() : row.out_time;
  await c.execute({
    sql: `UPDATE gate_entries
          SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = ?, awaiting_gross_out = ?,
              dispatch_qty = ?, dispatch_na = ?, invoice_group = ?, sale_id = ?, customer_id = ?,
              direction = ?, out_date = ?, out_time = ?
          WHERE id = ?`,
    args: [
      g,
      t,
      both ? net : 0,
      both ? "completed" : "pending",
      nowOut ? 0 : flag,
      dispQty,
      dispNa ? 1 : 0,
      group,
      saleId,
      customerId,
      direction,
      leftOn,
      leftAt,
      id
    ]
  });
  return {
    id,
    status: both ? "completed" : "pending",
    net,
    missing: both ? null : g == null ? "gross" : "tare"
  };
}
async function setGateEntrySales(entryId, groups) {
  const c = getClient();
  const clean = Array.from(new Set(groups.map((g) => String(g || "").trim()).filter(Boolean)));
  await c.execute({ sql: "DELETE FROM gate_entry_sales WHERE gate_entry_id = ?", args: [entryId] });
  let first = null;
  for (const g of clean) {
    const sale = await c.execute({
      sql: "SELECT id, customer_id FROM sales WHERE invoice_group = ? ORDER BY id LIMIT 1",
      args: [g]
    });
    if (!sale.rows.length) throw new Error(`Sale invoice ${g} no longer exists`);
    const saleId = Number(sale.rows[0].id);
    const customerId = sale.rows[0].customer_id == null ? null : Number(sale.rows[0].customer_id);
    await c.execute({
      sql: "INSERT OR IGNORE INTO gate_entry_sales (gate_entry_id, invoice_group, sale_id) VALUES (?, ?, ?)",
      args: [entryId, g, saleId]
    });
    if (!first) first = { group: g, saleId, customerId };
  }
  return first ? { group: first.group, saleId: first.saleId, customerId: first.customerId } : { group: null, saleId: null, customerId: null };
}
async function skipGateWeighment(id) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT rec_type, dispatch_qty FROM gate_entries WHERE id = ?", args: [id] });
  if (!cur.rows.length) throw new Error("Gate entry not found");
  if (String(cur.rows[0].rec_type || "OIL").toUpperCase() === "OIL") {
    throw new Error("Oil is always weighed \u2014 enter the gross and tare weights for this vehicle");
  }
  await c.execute({
    sql: "UPDATE gate_entries SET status = 'completed', no_weighment = 1, received_qty = ? WHERE id = ?",
    args: [n3(cur.rows[0].dispatch_qty), id]
  });
  return { id };
}
async function updateGateEntry(id, v) {
  const gross = v.gross_weight != null && v.gross_weight !== "" ? n3(v.gross_weight) : null;
  const tare = v.tare_weight != null && v.tare_weight !== "" ? n3(v.tare_weight) : null;
  const both = gross != null && tare != null;
  const net = both ? Math.round((gross - tare) * 1e3) / 1e3 : null;
  if (both && net <= 0) {
    throw new Error("Net weight (gross \u2212 tare) must be greater than zero \u2014 check the two figures");
  }
  const received = gross == null && tare == null ? n3(v.received_qty) : both ? net : 0;
  const status = received > 0 ? "completed" : "pending";
  const dUp = parseDispatch(v.dispatch_na ? "NA" : v.dispatch_qty);
  await getClient().execute({
    sql: `UPDATE gate_entries SET gate_entry_no = ?, ref_no = ?, entry_date = ?, entry_time = COALESCE(?, entry_time), tanker_id = ?, tanker_no = ?,
          oil_type_id = ?, dispatch_qty = ?, dispatch_na = ?, received_qty = ?, uom = ?, status = ?, note = ?, sale_id = ?,
          rec_type = ?, gross_weight = ?, tare_weight = ?, supplier_id = ?, customer_id = ?, is_direct_mnc = ? WHERE id = ?`,
    args: [
      String(v.gate_entry_no || "").trim(),
      v.ref_no ? String(v.ref_no).trim() : null,
      v.entry_date,
      v.entry_time ? String(v.entry_time).slice(0, 5) : null,
      v.tanker_id ? n3(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n3(v.oil_type_id) : null,
      dUp ? dUp.qty : 0,
      dUp?.na ? 1 : 0,
      received,
      v.uom || "MT",
      status,
      v.note || null,
      v.sale_id ? n3(v.sale_id) : null,
      String(v.rec_type || "OIL"),
      gross,
      tare,
      v.supplier_id ? n3(v.supplier_id) : null,
      v.customer_id ? n3(v.customer_id) : null,
      v.is_direct_mnc ? 1 : 0,
      id
    ]
  });
  return { id };
}
async function deleteGateEntry(id) {
  await getClient().execute({ sql: "DELETE FROM gate_entry_sales WHERE gate_entry_id = ?", args: [id] });
  await getClient().execute({ sql: "DELETE FROM gate_entries WHERE id = ?", args: [id] });
  return { id };
}
async function rejectGateEntry(id, reason) {
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new Error("Enter a reason for rejecting this entry");
  await getClient().execute({
    sql: "UPDATE gate_entries SET rejected_at = datetime('now'), rejected_reason = ? WHERE id = ?",
    args: [trimmed, id]
  });
  return { id };
}
async function unrejectGateEntry(id) {
  await getClient().execute({
    sql: "UPDATE gate_entries SET rejected_at = NULL, rejected_reason = NULL WHERE id = ?",
    args: [id]
  });
  return { id };
}

// src/main/bargains.ts
function toPlain4(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
async function ensureOilType(productId) {
  if (!productId) return;
  await getClient().execute({
    sql: `INSERT OR IGNORE INTO oil_types (id, code, name, active)
          SELECT id, COALESCE(code, name, 'GEN'), COALESCE(name, code, 'PRODUCT'), 1
          FROM products WHERE id = ?`,
    args: [productId]
  });
}
function dayMonth(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
  if (m) return `${m[3]}-${m[2]}`;
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
async function listBargains(from, to, companyIds, forModule) {
  const f = from || "0000-01-01";
  const t = to || "9999-12-31";
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const ptCo = cos.length ? ` AND company_id IN (${cos.join(",")})` : "";
  const obCo = cos.length ? ` AND o2.company_id IN (${cos.join(",")})` : "";
  const vis = await visibleFromFor("bargains", forModule);
  const res = await getClient().execute({
    sql: `
    SELECT b.*, s.name AS supplier_name, s.supplier_type AS supplier_type,
           br.name AS broker_name,
           o.code AS oil_code, o.name AS oil_name,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id${ptCo}), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id${ptCo}), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id${obCo}), 0) AS loaded_qty,
           b.qty
             - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id${ptCo}), 0)
             - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id${ptCo}), 0)
             - COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id${obCo}), 0) AS balance_qty,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND substr(loaded_date, 1, 10) < ?${ptCo}), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND substr(loaded_date, 1, 10) < ?${ptCo}), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id AND substr(o2.order_date, 1, 10) < ?${obCo}), 0) AS disp_before,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND substr(loaded_date, 1, 10) >= ? AND substr(loaded_date, 1, 10) <= ?${ptCo}), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND substr(loaded_date, 1, 10) >= ? AND substr(loaded_date, 1, 10) <= ?${ptCo}), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id AND substr(o2.order_date, 1, 10) >= ? AND substr(o2.order_date, 1, 10) <= ?${obCo}), 0) AS disp_period,
           (SELECT MAX(d) FROM (
              SELECT MAX(substr(loaded_date, 1, 10)) AS d FROM purchase_tankers WHERE bargain_id = b.id${ptCo}
              UNION ALL SELECT MAX(substr(loaded_date, 1, 10)) FROM purchase_tankers WHERE extra_bargain_id = b.id${ptCo}
              UNION ALL SELECT MAX(substr(o2.order_date, 1, 10)) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id${obCo}
           )) AS last_dispatch_date,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) < ?), 0) AS adj_before,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) >= ? AND substr(adj_date, 1, 10) <= ?), 0) AS adj_in,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) > ?), 0) AS adj_after,
      -- A purchase bargain has no company of its own \u2014 it is general, and what
      -- draws on it is what lands in a book. So the company is WHOSE TANKERS
      -- AND CONSIGNMENT PURCHASES drew on it: one name for most, both when a
      -- bargain was split across the two books, empty while nothing has been
      -- drawn yet.
      (SELECT GROUP_CONCAT(DISTINCT co.name) FROM (
          SELECT company_id FROM purchase_tankers WHERE bargain_id = b.id${ptCo}
          UNION SELECT company_id FROM purchase_tankers WHERE extra_bargain_id = b.id AND COALESCE(extra_qty, 0) > 0${ptCo}
          UNION SELECT o2.company_id FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id${obCo}
       ) x LEFT JOIN companies co ON co.id = x.company_id) AS drawn_companies
    FROM bargains b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN products o ON o.id = b.oil_type_id
    LEFT JOIN brokers br ON br.id = b.broker_id
    ${vis ? "WHERE b.bargain_date >= ?" : ""}
    ORDER BY b.id DESC
  `,
    args: vis ? [f, f, f, f, t, f, t, f, t, f, f, t, t, vis] : [f, f, f, f, t, f, t, f, t, f, f, t, t]
  });
  return toPlain4(res);
}
async function oilCodeFor(oilTypeId) {
  const res = await getClient().execute({ sql: "SELECT code, name FROM products WHERE id = ?", args: [oilTypeId] });
  return (res.rows.length ? String(res.rows[0].code || res.rows[0].name || "OIL") : "OIL").replace(/\s+/g, "").toUpperCase();
}
async function partyNameFor(supplierId) {
  const res = await getClient().execute({ sql: "SELECT name FROM suppliers WHERE id = ?", args: [supplierId] });
  return (res.rows.length ? String(res.rows[0].name || "PARTY") : "PARTY").replace(/\s+/g, "").toUpperCase();
}
async function nextBargainNo(oilTypeId, supplierId, bargainDate) {
  const oil = await oilCodeFor(oilTypeId);
  const party = await partyNameFor(supplierId);
  const monthKey = String(bargainDate).slice(0, 7);
  const existing = await getClient().execute({
    sql: "SELECT bargain_no FROM bargains WHERE substr(bargain_date, 1, 7) = ?",
    args: [monthKey]
  });
  let maxSeq = 0;
  for (const r of existing.rows) {
    const parts = String(r.bargain_no).split("/");
    const n25 = parseInt(parts[parts.length - 1] ?? "0", 10);
    if (!Number.isNaN(n25) && n25 > maxSeq) maxSeq = n25;
  }
  const serial = String(maxSeq + 1).padStart(2, "0");
  return `${oil}/${dayMonth(bargainDate)}/${party}/${serial}`;
}
function landedRate(v) {
  return (Number(v.base_rate) || 0) + (Number(v.duty) || 0);
}
async function bargainConsumed(id) {
  const r = await getClient().execute({
    sql: `SELECT
            COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = ?), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = ?), 0)
            + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob WHERE ob.bargain_id = ?), 0)
          AS consumed`,
    args: [id, id, id]
  });
  return Number(r.rows[0]?.consumed) || 0;
}
function validateBargainInput(v) {
  if (!v.supplier_id) throw new Error("Supplier is required");
  if (!v.oil_type_id) throw new Error("Oil type is required");
  const qty = Number(v.qty) || 0;
  if (qty <= 0) throw new Error("Quantity must be greater than zero");
  const rate = landedRate(v);
  if (rate <= 0) throw new Error("Bargain rate (base + duty) must be greater than zero");
  const struck = String(v.bargain_date || "").slice(0, 10);
  const expires = String(v.rate_expiry_date || "").slice(0, 10);
  if (struck && expires && expires <= struck) {
    throw new Error(
      expires === struck ? "Contract expiry cannot be the same day as the bargain \u2014 it has to be after it" : "Contract expiry cannot be before the bargain date"
    );
  }
  return { qty, rate };
}
async function createBargain(v) {
  const { qty, rate } = validateBargainInput(v);
  const total = qty * rate;
  const bargain_no = await nextBargainNo(
    Number(v.oil_type_id),
    Number(v.supplier_id),
    String(v.bargain_date)
  );
  await ensureOilType(Number(v.oil_type_id));
  const res = await getClient().execute({
    sql: `INSERT INTO bargains
      (company_id, bargain_no, bargain_date, supplier_id, broker_id, oil_type_id, bargain_type, qty, opening_qty, uom,
       base_rate, duty, rate_per_uom, allowed_shortage_pct, rate_expiry_date, total_amount, remarks, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || "EX",
      qty,
      v.opening_qty != null && v.opening_qty !== "" ? Number(v.opening_qty) : null,
      v.uom || "MT",
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== "" ? Number(v.allowed_shortage_pct) : null,
      v.rate_expiry_date || null,
      total,
      v.remarks ? String(v.remarks).trim() : null
    ]
  });
  return { id: Number(res.lastInsertRowid), bargain_no };
}
async function updateBargain(id, v) {
  const { qty, rate } = validateBargainInput(v);
  const total = qty * rate;
  const cur = await getClient().execute({ sql: "SELECT bargain_no, supplier_id, oil_type_id FROM bargains WHERE id = ?", args: [id] });
  if (!cur.rows.length) throw new Error("Bargain not found");
  const consumed = await bargainConsumed(id);
  const supplierChanged = Number(v.supplier_id) !== Number(cur.rows[0].supplier_id);
  const oilChanged = Number(v.oil_type_id) !== Number(cur.rows[0].oil_type_id);
  if (consumed > 1e-6) {
    if (supplierChanged) {
      throw new Error("Cannot change the supplier \u2014 this bargain already has loaded tankers or purchases");
    }
    if (oilChanged) {
      throw new Error("Cannot change the oil \u2014 this bargain already has loaded tankers or purchases");
    }
    if (qty < consumed - 1e-6) {
      throw new Error(`Quantity cannot be below the ${consumed.toFixed(3)} already loaded/consumed on this bargain`);
    }
  }
  let bargain_no = String(cur.rows[0].bargain_no);
  if (consumed <= 1e-6 && (supplierChanged || oilChanged)) {
    const parts = bargain_no.split("/");
    if (parts.length === 4) {
      const [oldOil, dateSeg, , serialSeg] = parts;
      const newOil = oilChanged ? await oilCodeFor(Number(v.oil_type_id)) : oldOil;
      const newParty = supplierChanged ? await partyNameFor(Number(v.supplier_id)) : parts[2];
      bargain_no = `${newOil}/${dateSeg}/${newParty}/${serialSeg}`;
    }
  }
  await ensureOilType(Number(v.oil_type_id));
  await getClient().execute({
    sql: `UPDATE bargains SET
      bargain_no = ?, bargain_date = ?, supplier_id = ?, broker_id = ?, oil_type_id = ?, bargain_type = ?,
      qty = ?, opening_qty = ?, uom = ?, base_rate = ?, duty = ?, rate_per_uom = ?,
      allowed_shortage_pct = ?, rate_expiry_date = ?, total_amount = ?, remarks = ?
      WHERE id = ?`,
    args: [
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || "EX",
      qty,
      v.opening_qty != null && v.opening_qty !== "" ? Number(v.opening_qty) : null,
      v.uom || "MT",
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== "" ? Number(v.allowed_shortage_pct) : null,
      v.rate_expiry_date || null,
      total,
      v.remarks ? String(v.remarks).trim() : null,
      id
    ]
  });
  return { id, bargain_no };
}
async function adjustBargainQty(id, delta, note, date) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM bargains WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Bargain not found");
  const b = toPlain4(res)[0];
  const d = Number(delta) || 0;
  if (d === 0) throw new Error("Enter a quantity to add or remove");
  const consumed = Math.round(await bargainConsumed(id) * 1e3) / 1e3;
  const newQty = Math.round((Number(b.qty) + d) * 1e3) / 1e3;
  if (newQty < -1e-9) throw new Error("The resulting quantity cannot go below zero");
  if (newQty < consumed - 1e-6) {
    throw new Error(`Cannot remove below the ${consumed.toFixed(3)} already loaded/consumed on this bargain`);
  }
  const rate = Number(b.rate_per_uom) || 0;
  const remarks = note ? `${b.remarks ? String(b.remarks) + "\n" : ""}${String(note).trim()}` : b.remarks;
  await c.execute({
    sql: "UPDATE bargains SET qty = ?, total_amount = ?, remarks = ? WHERE id = ?",
    args: [newQty, newQty * rate, remarks || null, id]
  });
  const adjDate = date && String(date).slice(0, 10) || todayISO();
  await c.execute({
    sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note) VALUES ('purchase', ?, ?, ?, ?)",
    args: [id, d, adjDate, note ? String(note).trim() : null]
  });
  return { id, qty: newQty };
}
async function deleteBargain(id) {
  const c = getClient();
  const ord = await c.execute({
    sql: "SELECT COUNT(*) AS n FROM orders WHERE bargain_id = ?",
    args: [id]
  });
  if (Number(ord.rows[0].n) > 0) {
    throw new Error("This bargain has purchases linked to it. Delete those purchases first.");
  }
  const billed = await c.execute({
    sql: `SELECT pt.tanker_no, o.invoice_no
          FROM purchase_tankers pt JOIN orders o ON o.id = pt.order_id
          WHERE (pt.bargain_id = ? OR pt.extra_bargain_id = ?) AND pt.order_id IS NOT NULL`,
    args: [id, id]
  });
  if (billed.rows.length) {
    const detail = billed.rows.map((r) => `${r.tanker_no || "tanker"} \u2192 invoice ${r.invoice_no || "(no number)"}`).join("; ");
    throw new Error(
      `This bargain has billed tankers linked to it (${detail}). Re-link or delete those purchases first \u2014 deleting now would leave the invoice without its tanker.`
    );
  }
  await c.execute({
    sql: "DELETE FROM gate_entries WHERE tanker_id IN (SELECT id FROM purchase_tankers WHERE bargain_id = ? AND order_id IS NULL)",
    args: [id]
  });
  await c.execute({ sql: "DELETE FROM purchase_tankers WHERE bargain_id = ? AND order_id IS NULL", args: [id] });
  await c.execute({
    sql: "UPDATE purchase_tankers SET extra_bargain_id = NULL, extra_qty = 0 WHERE extra_bargain_id = ?",
    args: [id]
  });
  await c.execute({ sql: "DELETE FROM bargain_adjustments WHERE kind = ? AND bargain_id = ?", args: ["purchase", id] });
  await c.execute({ sql: "DELETE FROM bargains WHERE id = ?", args: [id] });
  return { id };
}

// src/main/consignment.ts
function toPlain5(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const k of res.columns) o[k] = r[k];
    return o;
  });
}
var n4 = (v) => Number(v) || 0;
async function saveOpeningStock(v) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const supplierId = n4(v.supplier_id);
  const productId = n4(v.product_id);
  const qty = n4(v.qty);
  const uom = String(v.uom || "MT");
  const date = String(v.deposit_date || "").slice(0, 10);
  if (!supplierId) throw new Error("Choose the MNC / party");
  if (!productId) throw new Error("Choose the product");
  if (qty <= 0) throw new Error("Enter an opening quantity greater than zero \u2014 use the history to restore an older figure");
  if (!date) throw new Error("Enter the opening date");
  if (date > todayISO()) throw new Error("The opening date cannot be in the future");
  const existing = await c.execute({
    sql: `SELECT * FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND is_opening = 1 AND order_id IS NULL
          ORDER BY id DESC`,
    args: [cid, supplierId, productId]
  });
  const lots = toPlain5(existing);
  const oldTotal = lots.reduce((s2, l) => s2 + n4(l.qty), 0);
  const available = await consignmentAvailable(supplierId, productId);
  const minOpening = Math.max(0, Math.round((oldTotal - available) * 1e3) / 1e3);
  if (qty < minOpening - 1e-6) {
    throw new Error(
      `${minOpening.toFixed(3)} ${uom} of this opening is already drawn into purchases \u2014 the opening cannot go below that`
    );
  }
  await c.execute({
    sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [cid, supplierId, productId, lots.length ? "restate" : "create", lots.length ? oldTotal : null, qty, uom, date, v.note ? String(v.note) : null]
  });
  const payload = {
    supplier_id: supplierId,
    product_id: productId,
    qty,
    uom,
    deposit_date: date,
    note: v.note ? String(v.note).trim() : "Opening stock",
    is_opening: true
  };
  if (lots.length) {
    await updateConsignment(n4(lots[0].id), payload);
    for (const extra of lots.slice(1)) await deleteConsignment(n4(extra.id));
    return { id: n4(lots[0].id) };
  }
  return createConsignment(payload);
}
async function listOpeningLog(supplierId, productId) {
  const res = await getClient().execute({
    sql: `SELECT * FROM consignment_opening_log
          WHERE company_id = ? AND supplier_id = ? AND product_id = ?
          ORDER BY id DESC LIMIT 20`,
    args: [getActiveCompanyId(), supplierId, productId]
  });
  return toPlain5(res);
}
async function consignmentDeposited(supplierId, productId, companyId) {
  const res = await getClient().execute({
    sql: "SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?",
    args: [companyId || getActiveCompanyId(), supplierId, productId]
  });
  return n4(res.rows[0]?.q);
}
async function consignmentAvailable(supplierId, productId, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const dep = await c.execute({
    sql: "SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?",
    args: [cid, supplierId, productId]
  });
  const inv = await c.execute({
    sql: "SELECT COALESCE(SUM(ordered_qty), 0) AS q FROM orders WHERE company_id = ? AND is_consignment = 1 AND supplier_id = ? AND oil_type_id = ?",
    args: [cid, supplierId, productId]
  });
  return n4(dep.rows[0]?.q) - n4(inv.rows[0]?.q);
}
async function listConsignment(forModule) {
  const from = await visibleFromFor("consignment", forModule);
  const res = await getClient().execute({
    sql: `SELECT cs.*, s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, o.invoice_no, o.order_date,
                 b.bargain_no, b.rate_per_uom AS bargain_rate,
                 xb.bargain_no AS extra_bargain_no, xb.rate_per_uom AS extra_bargain_rate
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          LEFT JOIN orders o ON o.id = cs.order_id
          LEFT JOIN bargains b ON b.id = cs.bargain_id
          LEFT JOIN bargains xb ON xb.id = cs.extra_bargain_id
          WHERE cs.company_id = ?${from ? " AND cs.deposit_date >= ?" : ""}
          ORDER BY cs.id DESC`,
    args: from ? [getActiveCompanyId(), from] : [getActiveCompanyId()]
  });
  return toPlain5(res);
}
async function listUnbookedLots(supplierId, productId) {
  const where = ["cs.company_id = ?", "cs.order_id IS NULL"];
  const args = [getActiveCompanyId()];
  if (supplierId) {
    where.push("cs.supplier_id = ?");
    args.push(supplierId);
  }
  if (productId) {
    where.push("cs.product_id = ?");
    args.push(productId);
  }
  const res = await getClient().execute({
    sql: `SELECT cs.id, cs.supplier_id, cs.product_id, cs.qty, cs.uom, cs.deposit_date, cs.note,
                 cs.tanker_no, cs.gate_entry_id, cs.bargain_id, cs.extra_bargain_id, cs.extra_qty, cs.is_opening,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, ge.received_qty AS gate_qty
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          WHERE ${where.join(" AND ")}
          ORDER BY cs.deposit_date, cs.id`,
    args
  });
  return toPlain5(res);
}
function toLotPicks(v) {
  if (!Array.isArray(v)) return [];
  return v.map(
    (x) => typeof x === "object" && x !== null ? {
      id: Number(x.id),
      bargain_id: x.bargain_id ? Number(x.bargain_id) : null,
      extra_bargain_id: x.extra_bargain_id ? Number(x.extra_bargain_id) : null,
      extra_qty: n4(x.extra_qty)
    } : { id: Number(x), bargain_id: null, extra_bargain_id: null, extra_qty: 0 }
  ).filter((x) => x.id > 0);
}
async function validateConsignmentLots(picks, supplierId, productId, orderId = 0, companyId) {
  const list2 = toLotPicks(picks);
  if (!list2.length) return { total: 0, lines: [], primaryBargainId: 0 };
  const ids = list2.map((p) => p.id);
  const res = await getClient().execute({
    sql: `SELECT id, supplier_id, product_id, qty, order_id, tanker_no
          FROM consignment_stock WHERE company_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    args: [companyId || getActiveCompanyId(), ...ids]
  });
  if (res.rows.length !== ids.length) throw new Error("One of the selected consignment tankers no longer exists");
  const byId = new Map(res.rows.map((r) => [Number(r.id), r]));
  const bargainIds = Array.from(
    new Set(list2.flatMap((p) => [p.bargain_id, p.extra_bargain_id]).filter((x) => !!x))
  );
  const bargains = /* @__PURE__ */ new Map();
  if (bargainIds.length) {
    const bres = await getClient().execute({
      sql: `SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom
            FROM bargains WHERE id IN (${bargainIds.map(() => "?").join(",")})`,
      args: bargainIds
    });
    for (const b of toPlain5(bres)) {
      if (n4(b.supplier_id) !== supplierId || n4(b.oil_type_id) !== productId) {
        throw new Error(`Bargain ${b.bargain_no} is not for this supplier and product`);
      }
      bargains.set(Number(b.id), b);
    }
    if (bargains.size !== bargainIds.length) throw new Error("One of the selected bargains no longer exists");
  }
  const alloc = /* @__PURE__ */ new Map();
  const add = (bid, qty) => {
    if (!bid || qty <= 1e-9) return;
    const b = bargains.get(bid);
    const cur = alloc.get(bid) || {
      bargain_id: bid,
      bargain_no: String(b?.bargain_no || ""),
      rate: n4(b?.rate_per_uom),
      qty: 0
    };
    cur.qty += qty;
    alloc.set(bid, cur);
  };
  let total = 0;
  for (const p of list2) {
    const row = byId.get(p.id);
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is already booked on another purchase`);
    }
    if (n4(row.supplier_id) !== supplierId || n4(row.product_id) !== productId) {
      throw new Error("The selected tankers must all belong to this supplier and product");
    }
    const qty = n4(row.qty);
    const extra = p.extra_bargain_id ? n4(p.extra_qty) : 0;
    if (extra < 0) throw new Error(`Split quantity on tanker ${row.tanker_no || row.id} cannot be negative`);
    if (extra > qty + 1e-6) {
      throw new Error(
        `Split quantity on tanker ${row.tanker_no || row.id} (${extra}) is more than the tanker itself (${qty})`
      );
    }
    if (p.extra_bargain_id && p.extra_bargain_id === p.bargain_id) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is split across the same bargain twice`);
    }
    if (bargainIds.length && !p.bargain_id && extra < qty - 1e-6) {
      throw new Error(`Assign a bargain to tanker ${row.tanker_no || row.id}`);
    }
    add(p.bargain_id, qty - extra);
    add(p.extra_bargain_id, extra);
    total += qty;
  }
  const primary = list2.find((p) => p.bargain_id)?.bargain_id || list2.find((p) => p.extra_bargain_id)?.extra_bargain_id;
  return { total, lines: Array.from(alloc.values()), primaryBargainId: Number(primary) || 0 };
}
async function assignConsignmentLots(orderId, picks, supplierId, productId, companyId) {
  const list2 = toLotPicks(picks);
  if (!list2.length) return { total: 0, lines: [], primaryBargainId: 0 };
  const alloc = await validateConsignmentLots(list2, supplierId, productId, orderId, companyId);
  const c = getClient();
  for (const p of list2) {
    await c.execute({
      sql: `UPDATE consignment_stock
            SET order_id = ?, bargain_id = ?, extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        orderId,
        p.bargain_id || null,
        p.extra_bargain_id || null,
        p.extra_bargain_id ? n4(p.extra_qty) : null,
        p.id
      ]
    });
  }
  return alloc;
}
async function autoAssignConsignmentLots(orderId, supplierId, productId, qty, bargainId = 0, companyId) {
  const free = await getClient().execute({
    sql: `SELECT id, qty FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND order_id IS NULL
          ORDER BY deposit_date, id`,
    args: [companyId || getActiveCompanyId(), supplierId, productId]
  });
  const take = [];
  let used = 0;
  for (const r of free.rows) {
    if (used + n4(r.qty) > qty + 1e-6) continue;
    take.push(Number(r.id));
    used += n4(r.qty);
  }
  if (!take.length || Math.abs(used - qty) > 1e-6) return 0;
  await getClient().execute({
    sql: `UPDATE consignment_stock SET order_id = ?, bargain_id = ?
          WHERE id IN (${take.map(() => "?").join(",")})`,
    args: [orderId, bargainId || null, ...take]
  });
  return used;
}
async function releaseConsignmentLots(orderId) {
  await getClient().execute({
    sql: `UPDATE consignment_stock
          SET order_id = NULL, bargain_id = NULL, extra_bargain_id = NULL, extra_qty = NULL
          WHERE order_id = ?`,
    args: [orderId]
  });
}
async function consignmentSummary(range) {
  const cid = getActiveCompanyId();
  const c = getClient();
  const from = String(range?.from || "");
  const to = String(range?.to || "");
  const base = await c.execute({
    sql: `SELECT DISTINCT cs.supplier_id, cs.product_id, cs.uom,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?`,
    args: [cid]
  });
  const depositSlice = async (kind) => {
    if (kind === "opening" && !from) return /* @__PURE__ */ new Map();
    let sql = "SELECT supplier_id, product_id, SUM(qty) AS q FROM consignment_stock WHERE company_id = ?";
    const args = [cid];
    if (kind === "opening") {
      sql += " AND deposit_date < ?";
      args.push(from);
    } else {
      if (from) {
        sql += " AND deposit_date >= ?";
        args.push(from);
      }
      if (to) {
        sql += " AND deposit_date <= ?";
        args.push(to);
      }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, product_id`, args });
    const m = /* @__PURE__ */ new Map();
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n4(r.q));
    return m;
  };
  const invoicedSlice = async (kind) => {
    if (kind === "opening" && !from) return /* @__PURE__ */ new Map();
    let sql = `SELECT supplier_id, oil_type_id AS product_id, SUM(ordered_qty) AS q
               FROM orders WHERE company_id = ? AND is_consignment = 1`;
    const args = [cid];
    if (kind === "opening") {
      sql += " AND order_date < ?";
      args.push(from);
    } else {
      if (from) {
        sql += " AND order_date >= ?";
        args.push(from);
      }
      if (to) {
        sql += " AND order_date <= ?";
        args.push(to);
      }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, oil_type_id`, args });
    const m = /* @__PURE__ */ new Map();
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n4(r.q));
    return m;
  };
  const [depOpening, depPeriod, invOpening, invPeriod] = await Promise.all([
    depositSlice("opening"),
    depositSlice("period"),
    invoicedSlice("opening"),
    invoicedSlice("period")
  ]);
  return toPlain5(base).map((r) => {
    const key3 = `${r.supplier_id}:${r.product_id}`;
    const opening = (depOpening.get(key3) || 0) - (invOpening.get(key3) || 0);
    const deposited = depPeriod.get(key3) || 0;
    const invoiced = invPeriod.get(key3) || 0;
    return { ...r, opening, deposited, invoiced, balance: opening + deposited - invoiced };
  });
}
async function listConsignmentInvoices(range) {
  const from = String(range?.from || "");
  const to = String(range?.to || "");
  let sql = `SELECT o.id, o.invoice_no, o.order_date, o.supplier_id, o.oil_type_id AS product_id,
                    o.ordered_qty, o.uom, o.invoice_rate, o.taxable_value, o.net_amount,
                    b.bargain_no
             FROM orders o
             LEFT JOIN bargains b ON b.id = o.bargain_id
             WHERE o.company_id = ? AND o.is_consignment = 1`;
  const args = [getActiveCompanyId()];
  if (from) {
    sql += " AND o.order_date >= ?";
    args.push(from);
  }
  if (to) {
    sql += " AND o.order_date <= ?";
    args.push(to);
  }
  const res = await getClient().execute({ sql: `${sql} ORDER BY o.order_date, o.id`, args });
  return toPlain5(res);
}
async function listPendingGateArrivals() {
  const res = await getClient().execute({
    sql: `SELECT ge.id, ge.gate_entry_no, ge.ref_no, ge.entry_date, ge.tanker_no, ge.rec_type,
                 ge.received_qty, ge.gross_weight, ge.tare_weight, ge.uom, ge.status, ge.note,
                 ge.oil_type_id, ge.supplier_id, ge.is_direct_mnc,
                 p.code AS product_code, p.name AS product_name, s.name AS supplier_name
          FROM gate_entries ge
          LEFT JOIN products p ON p.id = ge.oil_type_id
          LEFT JOIN suppliers s ON s.id = ge.supplier_id
          WHERE ge.direction = 'in'
            AND ge.is_direct_mnc = 1
            AND ge.tanker_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.gate_entry_id = ge.id)
          ORDER BY ge.entry_date DESC, ge.id DESC`,
    args: []
  });
  return toPlain5(res);
}
var CONSIGNMENT_UOMS = ["MT", "KG", "L"];
var GATE_BUFFER = 1;
async function validateLot(v, existing, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const supplierId = v.supplier_id ? n4(v.supplier_id) : n4(existing?.supplier_id);
  const productId = v.product_id ? n4(v.product_id) : n4(existing?.product_id);
  const qty = v.qty != null && v.qty !== "" ? n4(v.qty) : n4(existing?.qty);
  const uom = String(v.uom || existing?.uom || "MT").toUpperCase();
  const depositDate = String(v.deposit_date || existing?.deposit_date || "").slice(0, 10);
  if (!supplierId) throw new Error("Choose the supplier this stock belongs to");
  if (!productId) throw new Error("Choose the product");
  if (qty <= 0) throw new Error("Quantity must be greater than zero");
  if (!Number.isFinite(qty)) throw new Error("Quantity must be a number");
  if (!CONSIGNMENT_UOMS.includes(uom)) {
    throw new Error(`Unit must be one of ${CONSIGNMENT_UOMS.join(", ")}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depositDate)) throw new Error("Enter the date this stock came in");
  const today = todayISO();
  if (depositDate > today) throw new Error("The date cannot be in the future");
  const sup = await c.execute({
    sql: "SELECT id, name, active FROM suppliers WHERE id = ? LIMIT 1",
    args: [supplierId]
  });
  if (!sup.rows.length) throw new Error("That supplier no longer exists");
  if (!n4(sup.rows[0].active)) throw new Error(`${sup.rows[0].name} is marked inactive \u2014 reactivate it first`);
  const prod = await c.execute({
    sql: "SELECT id, code, name, active FROM products WHERE id = ? LIMIT 1",
    args: [productId]
  });
  if (!prod.rows.length) throw new Error("That product no longer exists");
  if (!n4(prod.rows[0].active)) {
    throw new Error(`${prod.rows[0].code || prod.rows[0].name} is marked inactive \u2014 reactivate it first`);
  }
  const gateId = existing?.gate_entry_id ?? (v.gate_entry_id ? n4(v.gate_entry_id) : null);
  if (gateId) {
    const ge = await c.execute({
      sql: "SELECT id, gate_entry_no, supplier_id, is_direct_mnc, received_qty, status FROM gate_entries WHERE id = ? LIMIT 1",
      args: [n4(gateId)]
    });
    if (!ge.rows.length) throw new Error("That gate entry no longer exists");
    const g = toPlain5(ge)[0];
    if (n4(g.is_direct_mnc) === 1 && n4(g.supplier_id) && n4(g.supplier_id) !== supplierId) {
      const named = await c.execute({ sql: "SELECT name FROM suppliers WHERE id = ?", args: [n4(g.supplier_id)] });
      throw new Error(
        `Gate entry ${g.gate_entry_no} was booked in for ${named.rows[0]?.name || "another party"} \u2014 change it at the gate if that is wrong`
      );
    }
    const weighed = n4(g.received_qty);
    if (weighed > 0 && Math.abs(qty - weighed) > GATE_BUFFER + 1e-6) {
      throw new Error(
        `Gate entry ${g.gate_entry_no} weighed ${weighed.toFixed(3)} ${uom} \u2014 ${qty.toFixed(3)} is more than ${GATE_BUFFER} ${uom} away from it`
      );
    }
  }
  if (!existing && v.is_opening) {
    const dup = await c.execute({
      sql: `SELECT id, qty, uom FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND is_opening = 1 AND order_id IS NULL LIMIT 1`,
      args: [cid, supplierId, productId]
    });
    if (dup.rows.length) {
      const d = dup.rows[0];
      throw new Error(
        `Opening stock for ${sup.rows[0].name} \xB7 ${prod.rows[0].code || prod.rows[0].name} is already recorded (${n4(d.qty).toFixed(3)} ${d.uom || "MT"}) \u2014 update that entry instead of adding another`
      );
    }
  }
  const tankerNo = v.tanker_no ?? existing?.tanker_no ? String(v.tanker_no ?? existing?.tanker_no).trim() : null;
  if (tankerNo) {
    const dup = await c.execute({
      sql: `SELECT id FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND substr(deposit_date, 1, 10) = ? AND UPPER(TRIM(tanker_no)) = ?
              AND id <> ? LIMIT 1`,
      args: [cid, supplierId, productId, depositDate, tankerNo.toUpperCase(), n4(existing?.id) || 0]
    });
    if (dup.rows.length) {
      throw new Error(`Tanker ${tankerNo} is already logged for this party and product on ${depositDate}`);
    }
  }
  return { supplierId, productId, qty, uom, depositDate };
}
async function createConsignment(v) {
  const c = getClient();
  const gateId = v.gate_entry_id ? n4(v.gate_entry_id) : null;
  let tankerNo = v.tanker_no ? String(v.tanker_no).trim() : null;
  if (gateId) {
    const ge = await c.execute({
      sql: "SELECT id, tanker_no, direction FROM gate_entries WHERE id = ?",
      args: [gateId]
    });
    if (!ge.rows.length) throw new Error("That gate entry no longer exists");
    const dup = await c.execute({
      sql: "SELECT id FROM consignment_stock WHERE gate_entry_id = ?",
      args: [gateId]
    });
    if (dup.rows.length) throw new Error("This gate entry has already been validated into consignment stock");
    if (!tankerNo) tankerNo = ge.rows[0].tanker_no ? String(ge.rows[0].tanker_no) : null;
  }
  const bookCompany = v.company_id ? n4(v.company_id) : getActiveCompanyId();
  const ok = await validateLot({ ...v, tanker_no: tankerNo }, null, bookCompany);
  const res = await c.execute({
    sql: `INSERT INTO consignment_stock (company_id, supplier_id, product_id, qty, uom, deposit_date, note,
            gate_entry_id, tanker_no, is_opening, weighed_qty, shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      bookCompany,
      ok.supplierId,
      ok.productId,
      ok.qty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      gateId,
      tankerNo,
      v.is_opening ? 1 : 0,
      v.weighed_qty != null && v.weighed_qty !== "" ? n4(v.weighed_qty) : null,
      v.shortage_pct != null && v.shortage_pct !== "" ? n4(v.shortage_pct) : null
    ]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function updateConsignment(id, v) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT * FROM consignment_stock WHERE id = ?", args: [id] });
  if (!cur.rows.length) throw new Error("Consignment entry not found");
  const row = toPlain5(cur)[0];
  if (row.order_id != null) {
    const inv = await c.execute({
      sql: "SELECT invoice_no FROM orders WHERE id = ? LIMIT 1",
      args: [n4(row.order_id)]
    });
    const no = inv.rows[0]?.invoice_no;
    throw new Error(
      `This tanker is already booked on purchase invoice ${no || "(unknown)"} \u2014 edit or delete that purchase first`
    );
  }
  const newCompany = v.company_id ? n4(v.company_id) : n4(row.company_id);
  const ok = await validateLot(v, row, newCompany);
  const newQty = ok.qty;
  const newSupplier = ok.supplierId;
  const newProduct = ok.productId;
  const moved = newSupplier !== n4(row.supplier_id) || newProduct !== n4(row.product_id) || newCompany !== n4(row.company_id);
  const avail = await consignmentAvailable(n4(row.supplier_id), n4(row.product_id), n4(row.company_id));
  if (moved) {
    if (avail - n4(row.qty) < -1e-6) {
      throw new Error("Cannot move this stock \u2014 part of this supplier and product has already been invoiced");
    }
  } else if (avail + (newQty - n4(row.qty)) < -1e-6) {
    throw new Error("Cannot reduce below the quantity already invoiced from this stock");
  }
  await c.execute({
    sql: `UPDATE consignment_stock
          SET company_id = ?, supplier_id = ?, product_id = ?, qty = ?, uom = ?, deposit_date = ?, note = ?,
              weighed_qty = ?, shortage_pct = ?
          WHERE id = ?`,
    args: [
      newCompany,
      newSupplier,
      newProduct,
      newQty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      v.weighed_qty != null && v.weighed_qty !== "" ? n4(v.weighed_qty) : row.weighed_qty,
      v.shortage_pct != null && v.shortage_pct !== "" ? n4(v.shortage_pct) : row.shortage_pct,
      id
    ]
  });
  return { id };
}
async function deleteConsignment(id) {
  {
    const cur2 = await getClient().execute({ sql: "SELECT * FROM consignment_stock WHERE id = ?", args: [id] });
    if (cur2.rows.length && n4(cur2.rows[0].is_opening) === 1 && cur2.rows[0].order_id == null) {
      const l = cur2.rows[0];
      const avail2 = await consignmentAvailable(n4(l.supplier_id), n4(l.product_id));
      if (n4(l.qty) > avail2 + 1e-6) {
        throw new Error(
          `${(n4(l.qty) - avail2).toFixed(3)} ${l.uom || "MT"} of this opening is already drawn into purchases \u2014 reduce it from the opening dialog instead of deleting`
        );
      }
      await getClient().execute({
        sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
              VALUES (?, ?, ?, 'delete', ?, NULL, ?, ?, ?)`,
        args: [n4(l.company_id) || getActiveCompanyId(), n4(l.supplier_id), n4(l.product_id), n4(l.qty), String(l.uom || "MT"), String(l.deposit_date || ""), l.note ? String(l.note) : null]
      }).catch(() => {
      });
    }
  }
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT * FROM consignment_stock WHERE id = ?", args: [id] });
  if (!cur.rows.length) return { id };
  const row = cur.rows[0];
  if (row.order_id != null) {
    throw new Error("This tanker is already booked on a purchase invoice \u2014 delete that purchase first");
  }
  const avail = await consignmentAvailable(n4(row.supplier_id), n4(row.product_id));
  if (avail - n4(row.qty) < -1e-6) {
    throw new Error("Cannot delete \u2014 part of this stock has already been invoiced");
  }
  await c.execute({ sql: "DELETE FROM consignment_stock WHERE id = ?", args: [id] });
  return { id };
}

// src/main/invoiceno.ts
var key2 = (v) => String(v ?? "").trim().toUpperCase();
function excluded(v, id) {
  const extra = Array.isArray(v?.invoice_dup_exclude_ids) ? v.invoice_dup_exclude_ids.map((x) => Number(x)).filter((x) => x > 0) : [];
  return id ? [...extra, id] : extra;
}
function notIn(col, ids) {
  return ids.length ? ` AND ${col} NOT IN (${ids.map(() => "?").join(",")})` : "";
}
async function assertPurchaseInvoiceNoFree(v, companyId, id) {
  const want = key2(v?.invoice_no);
  if (!want) return;
  const c = getClient();
  if (id) {
    const own = await c.execute({ sql: "SELECT invoice_no FROM orders WHERE id = ?", args: [id] });
    if (own.rows.length && key2(own.rows[0].invoice_no) === want) return;
  }
  const skip = excluded(v, id);
  const res = await c.execute({
    sql: `SELECT o.id, o.invoice_no, o.order_date, s.name AS party
            FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
           WHERE o.company_id = ? AND UPPER(TRIM(COALESCE(o.invoice_no,''))) = ?
                 ${notIn("o.id", skip)}
           ORDER BY o.id LIMIT 1`,
    args: [companyId, want, ...skip]
  });
  if (!res.rows.length) return;
  const hit = res.rows[0];
  throw new Error(
    `Purchase invoice ${String(v.invoice_no).trim()} is already booked in this company${hit.party ? ` \u2014 ${hit.party}` : ""}${hit.order_date ? `, ${String(hit.order_date).slice(0, 10)}` : ""}. Two purchases cannot share one invoice number.`
  );
}
async function assertSalesInvoiceNoFree(v, companyId, id, allowExistingNumber) {
  const want = key2(v?.invoice_no);
  if (!want || allowExistingNumber) return;
  const c = getClient();
  if (id) {
    const own = await c.execute({ sql: "SELECT invoice_no FROM sales WHERE id = ?", args: [id] });
    if (own.rows.length && key2(own.rows[0].invoice_no) === want) return;
  }
  const group = String(v?.invoice_group || "").trim();
  const mine = group ? group : id ? `row:${id}` : "row:0";
  const skip = excluded(v, id);
  const res = await c.execute({
    sql: `SELECT s.id, s.invoice_no, s.sale_date, cu.name AS party
            FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
           WHERE s.company_id = ? AND UPPER(TRIM(COALESCE(s.invoice_no,''))) = ?
             AND COALESCE(s.invoice_group, 'row:' || s.id) <> ?
                 ${notIn("s.id", skip)}
           ORDER BY s.id LIMIT 1`,
    args: [companyId, want, mine, ...skip]
  });
  if (!res.rows.length) return;
  const hit = res.rows[0];
  throw new Error(
    `Invoice ${String(v.invoice_no).trim()} is already used in this company${hit.party ? ` \u2014 ${hit.party}` : ""}${hit.sale_date ? `, ${String(hit.sale_date).slice(0, 10)}` : ""}. Give this one a number of its own.`
  );
}
function assertNoRepeatsWithin(numbers, what) {
  const seen = /* @__PURE__ */ new Map();
  for (let i = 0; i < numbers.length; i++) {
    const k = key2(numbers[i]);
    if (!k) continue;
    const first = seen.get(k);
    if (first !== void 0) {
      throw new Error(
        `${what} ${String(numbers[i]).trim()} is on two lines of this deal (lines ${first + 1} and ${i + 1}). Each line is its own invoice, so each needs its own number.`
      );
    }
    seen.set(k, i);
  }
}

// src/main/orders.ts
var STAGES = [
  "ordered",
  "at_port",
  "payment_cleared",
  "in_transit",
  "outside_factory",
  "inside_factory",
  "received"
];
var TANKER_STAGES = ["supplier_factory", "loaded", "transit", "outside_factory", "inside_factory", "empty"];
var GATE_MATCH_BUFFER = 1;
function toPlain6(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n5(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function isDelivered(v) {
  const s = String(v || "").toUpperCase();
  return s === "DLD" || s === "DELIVERED";
}
function normCondition(v) {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return null;
  return s === "DLD" || s === "DELIVERED" ? "DLD" : "EX";
}
function tankerIsEx(tankerCondition, bargainType) {
  const own = normCondition(tankerCondition);
  return own ? own === "EX" : !isDelivered(bargainType);
}
function tierTds(taxable, prior, threshold, basePct, abovePct) {
  if (!threshold || threshold <= 0) return taxable * basePct / 100;
  const below = Math.max(0, Math.min(threshold - prior, taxable));
  const above = taxable - below;
  return below * basePct / 100 + above * abovePct / 100;
}
function fyRange(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1;
  return { start: `${startY}-04-01`, end: `${startY + 1}-03-31` };
}
async function relatedSupplierIds(supplierId) {
  const c = getClient();
  const row = await c.execute({ sql: "SELECT linked_party_id FROM suppliers WHERE id = ?", args: [supplierId] });
  const root = n5(row.rows[0]?.linked_party_id) || supplierId;
  const linked = await c.execute({ sql: "SELECT id FROM suppliers WHERE linked_party_id = ?", args: [root] });
  return Array.from(/* @__PURE__ */ new Set([root, supplierId, ...linked.rows.map((r) => Number(r.id))]));
}
async function supplierFyTaxable(supplierId, dateStr, excludeId) {
  const { start, end } = fyRange(dateStr);
  const c = getClient();
  const ids = await relatedSupplierIds(supplierId);
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(taxable_value), 0) AS t FROM orders
          WHERE supplier_id IN (${ids.map(() => "?").join(",")}) AND order_date BETWEEN ? AND ? AND id != ? AND company_id = ?`,
    args: [...ids, start, dateStr, excludeId || 0, getActiveCompanyId()]
  });
  const sup = await c.execute({
    sql: `SELECT opening_purchase_amount, opening_purchase_date FROM suppliers WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids
  });
  let opening = 0;
  for (const r of sup.rows) {
    const od = String(r.opening_purchase_date || "");
    if (od && od >= start && od <= end) opening += Number(r.opening_purchase_amount) || 0;
  }
  return (Number(res.rows[0].t) || 0) + opening;
}
function rateRoundOff(v) {
  return v.rate_round_off != null && v.rate_round_off !== "" ? Number(v.rate_round_off) : null;
}
function computeMoney(i) {
  const interestPct = i.addsInterest ? i.interestPct : 0;
  const interestDays = i.addsInterest ? i.interestDays : 0;
  const interestPerUnit = i.bargainRate * (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (interestDays / 365);
  const rawAdjustedRate = i.invoiceRate + interestPerUnit + (i.additionalInterest || 0);
  const threshold = i.tdsThreshold || 0;
  const abovePct = i.tdsPctAbove || 0;
  const prior = i.tdsPrior || 0;
  const round213 = (v) => Math.round(v * 100) / 100;
  const lines = (i.lines || []).filter((l) => n5(l.qty) > 0);
  const lineQty = lines.reduce((s, l) => s + n5(l.qty), 0);
  const blendedRate = lineQty > 0 ? round213(lines.reduce((s, l) => s + n5(l.rate) * n5(l.qty), 0) / lineQty) : 0;
  const rawPremium = round213(i.invoiceRate - blendedRate);
  const ratePremium = Math.abs(rawPremium) < 0.01 ? 0 : rawPremium;
  const billedRate = (raw) => i.rateRoundOff == null ? Math.ceil(raw) : round213(raw + n5(i.rateRoundOff));
  const taxableValue = lines.length > 1 && lineQty > 0 ? lines.reduce((s, l) => {
    const days = l.interestDays != null ? n5(l.interestDays) : interestDays;
    const addl = l.additionalInterest != null ? n5(l.additionalInterest) : i.additionalInterest || 0;
    const kF = (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (days / 365);
    return s + billedRate(n5(l.rate) + n5(l.rate) * kF + addl + ratePremium) * n5(l.qty);
  }, 0) : billedRate(rawAdjustedRate) * i.orderedQty;
  const adjustedRate = i.orderedQty > 0 ? taxableValue / i.orderedQty : billedRate(rawAdjustedRate);
  const gstAmount = taxableValue * i.gstPct / 100;
  const roundOff = Number(i.roundOff) || 0;
  const roundedTotal = taxableValue + gstAmount + roundOff;
  const tdsAmount = round213(tierTds(roundedTotal, prior, threshold, i.tdsPct, abovePct));
  const netAmount = round213(roundedTotal - tdsAmount);
  const finalTaxable = i.bargainRate * i.orderedQty;
  const finalGst = finalTaxable * i.gstPct / 100;
  const finalRounded = finalTaxable + finalGst + roundOff;
  const finalTds = round213(tierTds(finalRounded, prior, threshold, i.tdsPct, abovePct));
  const finalNet = round213(finalRounded - finalTds);
  return {
    interest_pct: interestPct,
    interest_days: interestDays,
    interest_per_unit: interestPerUnit,
    adjusted_rate: adjustedRate,
    taxable_value: taxableValue,
    gst_amount: gstAmount,
    tds_amount: tdsAmount,
    net_amount: netAmount,
    final_taxable_value: finalTaxable,
    final_gst_amount: finalGst,
    final_tds_amount: finalTds,
    final_net_amount: finalNet
  };
}
var STAGE_DATE_FIELDS = [
  ["loaded_date", "Loading date"],
  ["transit_date", "Transit date"],
  ["outside_factory_date", "Outside factory date"],
  ["inside_factory_date", "Inside factory date"],
  ["empty_date", "Receipt (empty) date"]
];
function ddmmyyyy(iso) {
  return iso.split("-").reverse().join("/");
}
function assertStageDateOrder(t) {
  let prevVal = "";
  let prevLabel = "";
  for (const [key3, label] of STAGE_DATE_FIELDS) {
    const val = String(t[key3] || "").slice(0, 10);
    if (!val) continue;
    if (prevVal && val < prevVal) {
      throw new Error(
        `${label} (${ddmmyyyy(val)}) cannot be before the ${prevLabel.toLowerCase()} (${ddmmyyyy(prevVal)})`
      );
    }
    prevVal = val;
    prevLabel = label;
  }
}
async function getSupplier(id) {
  const res = await getClient().execute({
    sql: "SELECT * FROM suppliers WHERE id = ? LIMIT 1",
    args: [id]
  });
  return res.rows.length ? toPlain6(res)[0] : null;
}
async function setSupplierPayable(orderId, supplierId, amount, date) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'payable'",
    args: [orderId]
  });
  await c.execute({
    sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'payable', ?, 'Order net amount', (SELECT company_id FROM orders WHERE id = ?))`,
    args: [supplierId, orderId, date, amount, orderId]
  });
}
async function listOrders(forModule) {
  const from = await visibleFromFor("orders", forModule);
  const res = await getClient().execute({
    args: from ? [getActiveCompanyId(), from] : [getActiveCompanyId()],
    sql: `
    SELECT o.*,
           s.name AS supplier_name,
           -- Read the product master first; oil_types is only a legacy mirror kept
           -- for the FK, and a product missing from it left the label blank.
           -- A product may carry its label in name with a blank code, so empty
           -- strings have to fall through as well as NULLs.
           COALESCE(NULLIF(pr.code, ''), NULLIF(pr.name, ''), NULLIF(ot.code, ''), ot.name) AS oil_code,
           COALESCE(NULLIF(pr.name, ''), NULLIF(pr.code, ''), ot.name) AS oil_name,
           -- "Category" is material_type on the Products master; pr.category is
           -- its Sub-category, exposed separately so both can be shown.
           pr.material_type AS product_category,
           pr.category AS product_sub_category,
           src.name AS source_name,
           t.name AS transporter_name,
           (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
           (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos,
           -- Shortage rolled up from the tankers. The order's own
           -- actual_shortage_qty columns are only written on the tanker-less
           -- receipt path, so a tanker purchase showed nothing at all.
           (SELECT COALESCE(SUM(MAX(0, pt.loaded_qty - pt.received_qty)), 0)
              FROM purchase_tankers pt
             WHERE pt.order_id = o.id AND pt.status = 'empty' AND pt.received_qty IS NOT NULL) AS tanker_shortage_qty,
           -- Already recovered by docking the transporter's freight, so the part
           -- still open is what a debit note would be raised for.
           (SELECT COALESCE(SUM(pt.shortage_charge_amount), 0)
              FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_shortage_charged,
           -- Freight earned on this invoice, before the shortage deduction.
           (SELECT COALESCE(SUM(pt.transport_amount), 0)
              FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_freight_total,
           (SELECT COUNT(*) FROM purchase_tankers pt
             WHERE pt.order_id = o.id AND pt.status = 'empty' AND pt.received_qty IS NOT NULL) AS tanker_weighed_count,
           -- How this purchase is being funded, if through an LC. A purchase is
           -- tagged by issuing a bill under an LC against it, so the LC comes
           -- back through lc_issuances rather than sitting on the order itself.
           (SELECT GROUP_CONCAT(DISTINCT lc.lc_no) FROM lc_issuances li
              JOIN letters_of_credit lc ON lc.id = li.lc_id
             WHERE li.order_id = o.id) AS lc_nos,
           (SELECT li.lc_id FROM lc_issuances li WHERE li.order_id = o.id LIMIT 1) AS lc_id,
           (SELECT COALESCE(SUM(li.amount), 0) FROM lc_issuances li WHERE li.order_id = o.id) AS lc_amount,
           -- Outstanding until every bill drawn for it has been settled.
           (SELECT COUNT(*) FROM lc_issuances li
             WHERE li.order_id = o.id AND COALESCE(li.status, 'outstanding') != 'settled') AS lc_bills_open,
           (SELECT MIN(li.due_date) FROM lc_issuances li
             WHERE li.order_id = o.id AND COALESCE(li.status, 'outstanding') != 'settled') AS lc_next_due,
           -- Settled via the Payment/Receipt voucher's bill-wise allocation
           -- (Accounting), linked to this exact order \u2014 not the old
           -- payments-page mechanism, which is being removed.
           COALESCE((SELECT SUM(ba.amount) FROM journal_bill_allocs ba WHERE ba.order_id = o.id AND ba.method = 'agst_ref'), 0) AS paid_amount
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products pr ON pr.id = o.oil_type_id
    LEFT JOIN products ot ON ot.id = o.oil_type_id
    LEFT JOIN sources src ON src.id = o.source_id
    LEFT JOIN transporters t ON t.id = o.transporter_id
    WHERE o.company_id = ?${from ? " AND (o.order_date >= ? OR COALESCE(o.status, '') <> 'received')" : ""}
    ORDER BY o.id DESC
  `
  });
  return toPlain6(res);
}
async function purchaseBargainNotes(orderId) {
  const c = getClient();
  const bg = await c.execute({
    sql: `SELECT DISTINCT b.id, b.bargain_no, b.bargain_date, b.qty, b.uom, b.rate_per_uom,
                 b.rate_expiry_date, b.remarks, s.name AS supplier_name
          FROM purchase_tankers pt
          JOIN bargains b ON b.id = pt.bargain_id OR b.id = pt.extra_bargain_id
          LEFT JOIN suppliers s ON s.id = b.supplier_id
          WHERE pt.order_id = ?
          ORDER BY b.bargain_date, b.id`,
    args: [orderId]
  });
  const bargains = toPlain6(bg);
  if (!bargains.length) return [];
  const ids = bargains.map((b) => n5(b.id));
  const adj = await c.execute({
    sql: `SELECT bargain_id, delta, adj_date, note
          FROM bargain_adjustments
          WHERE kind = 'purchase' AND bargain_id IN (${ids.map(() => "?").join(",")})
          ORDER BY adj_date, id`,
    args: ids
  });
  const byBargain = /* @__PURE__ */ new Map();
  for (const a of toPlain6(adj)) {
    const k = n5(a.bargain_id);
    const list2 = byBargain.get(k) || [];
    list2.push(a);
    byBargain.set(k, list2);
  }
  return bargains.map((b) => ({ ...b, adjustments: byBargain.get(n5(b.id)) || [] }));
}
async function bargainLinesForTankers(tankerIds) {
  const ids = (Array.isArray(tankerIds) ? tankerIds : []).map((x) => n5(x)).filter((x) => x > 0);
  if (ids.length === 0) return [];
  const res = await getClient().execute({
    sql: `SELECT pt.loaded_qty, pt.extra_qty, pt.bargain_id, pt.extra_bargain_id,
                 b.rate_per_uom AS rate, xb.rate_per_uom AS extra_rate
          FROM purchase_tankers pt
          LEFT JOIN bargains b ON b.id = pt.bargain_id
          LEFT JOIN bargains xb ON xb.id = pt.extra_bargain_id
          WHERE pt.id IN (${ids.map(() => "?").join(",")})`,
    args: ids
  });
  const m = /* @__PURE__ */ new Map();
  const add = (id, rate, qty) => {
    if (!id || qty <= 0) return;
    const k = String(id);
    const cur = m.get(k) || { rate, qty: 0, bargainId: n5(id) };
    cur.qty += qty;
    m.set(k, cur);
  };
  for (const r of toPlain6(res)) {
    const loaded = n5(r.loaded_qty);
    const extra = r.extra_bargain_id ? n5(r.extra_qty) : 0;
    add(r.bargain_id, n5(r.rate), loaded - extra);
    if (extra > 0) add(r.extra_bargain_id, n5(r.extra_rate), extra);
  }
  return Array.from(m.values());
}
function applyBargainInterestOverrides(lines, overrides) {
  const list2 = Array.isArray(overrides) ? overrides : [];
  const byBargain = new Map(list2.map((o) => [n5(o.bargain_id), o]));
  return lines.map((l) => {
    const o = l.bargainId ? byBargain.get(l.bargainId) : void 0;
    const additionalInterest = o && o.additional_interest != null && o.additional_interest !== "" ? n5(o.additional_interest) : void 0;
    const interestDays = o && o.interest_days != null && o.interest_days !== "" ? n5(o.interest_days) : void 0;
    return { ...l, additionalInterest, interestDays };
  });
}
async function saveOrderBargainInterest(orderId, overrides) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM order_bargain_interest WHERE order_id = ?", args: [orderId] });
  const list2 = Array.isArray(overrides) ? overrides : [];
  for (const o of list2) {
    const bargainId = n5(o.bargain_id);
    const additionalInterest = o.additional_interest != null && o.additional_interest !== "" ? n5(o.additional_interest) : 0;
    const interestDays = o.interest_days != null && o.interest_days !== "" ? n5(o.interest_days) : 0;
    if (!bargainId || !additionalInterest && !interestDays) continue;
    await c.execute({
      sql: "INSERT INTO order_bargain_interest (order_id, bargain_id, additional_interest, interest_days) VALUES (?, ?, ?, ?)",
      args: [orderId, bargainId, additionalInterest, interestDays]
    });
  }
}
async function listOrderBargainInterest(orderId) {
  const res = await getClient().execute({
    sql: "SELECT bargain_id, additional_interest, interest_days FROM order_bargain_interest WHERE order_id = ?",
    args: [orderId]
  });
  return toPlain6(res);
}
function toBargainLines(v) {
  const m = /* @__PURE__ */ new Map();
  for (const l of Array.isArray(v) ? v : []) {
    const id = n5(l?.bargain_id);
    const qty = n5(l?.qty);
    if (!id || qty <= 0) continue;
    const cur = m.get(id) || { bargain_id: id, qty: 0 };
    cur.qty += qty;
    m.set(id, cur);
  }
  return Array.from(m.values());
}
async function priceBargainLines(lines, supplierId, productId, orderedQty, uom) {
  if (!lines.length) return { lines: [], primaryBargainId: 0 };
  const total = lines.reduce((sum, l) => sum + l.qty, 0);
  if (Math.abs(total - orderedQty) > 1e-3) {
    throw new Error(
      `The bargain quantities add up to ${total.toFixed(3)} but the invoice is for ${orderedQty.toFixed(3)} ${uom}`
    );
  }
  const out = [];
  for (const l of lines) {
    const r = await getClient().execute({
      sql: "SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom FROM bargains WHERE id = ? LIMIT 1",
      args: [l.bargain_id]
    });
    if (!r.rows.length) throw new Error("One of the chosen bargains no longer exists");
    const b = toPlain6(r)[0];
    if (n5(b.supplier_id) !== supplierId) throw new Error(`Bargain ${b.bargain_no} belongs to a different supplier`);
    if (n5(b.oil_type_id) !== productId) throw new Error(`Bargain ${b.bargain_no} is for a different product`);
    out.push({ rate: n5(b.rate_per_uom), qty: l.qty, bargainId: l.bargain_id });
  }
  return { lines: out, primaryBargainId: lines[0].bargain_id };
}
async function saveOrderBargains(orderId, lines) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM order_bargains WHERE order_id = ?", args: [orderId] });
  for (const l of lines) {
    await c.execute({
      sql: "INSERT INTO order_bargains (order_id, bargain_id, qty) VALUES (?, ?, ?)",
      args: [orderId, l.bargain_id, l.qty]
    });
  }
}
async function listOrderBargains(orderId) {
  const res = await getClient().execute({
    sql: `SELECT ob.id, ob.bargain_id, ob.qty, b.bargain_no, b.rate_per_uom, b.bargain_date
          FROM order_bargains ob LEFT JOIN bargains b ON b.id = ob.bargain_id
          WHERE ob.order_id = ? ORDER BY ob.id`,
    args: [orderId]
  });
  return toPlain6(res);
}
async function listConsignmentDraws(companyIds) {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const res = await getClient().execute({
    sql: `SELECT ob.bargain_id, ob.qty, o.id AS order_id, o.invoice_no, o.order_date, o.uom,
                 o.invoice_rate, o.adjusted_rate, o.taxable_value, o.ordered_qty,
                 o.company_id, co.name AS company_name,
                 s.name AS supplier_name, p.code AS oil_code, p.name AS oil_name,
                 (SELECT GROUP_CONCAT(cs.tanker_no, ', ') FROM consignment_stock cs
                   WHERE cs.order_id = o.id AND cs.tanker_no IS NOT NULL) AS tanker_nos
          FROM order_bargains ob
          JOIN orders o ON o.id = ob.order_id
          LEFT JOIN companies co ON co.id = o.company_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          ${cos.length ? `WHERE o.company_id IN (${cos.join(",")})` : ""}
          ORDER BY o.order_date, o.id`,
    args: []
  });
  return toPlain6(res);
}
async function createOrder(v) {
  await ensureOilType(n5(v.oil_type_id));
  const supplier = await getSupplier(n5(v.supplier_id));
  const isTrading = !!v.is_trading;
  const isConsignment = !!v.is_consignment || !!supplier?.skip_tanker_stages || isTrading;
  const bookInCompany = v.company_id ? n5(v.company_id) : getActiveCompanyId();
  await assertPurchaseInvoiceNoFree(v, bookInCompany);
  const picks = toLotPicks(v.consignment_lot_ids);
  let lotAlloc = { total: 0, lines: [], primaryBargainId: 0 };
  if (picks.length) {
    lotAlloc = await validateConsignmentLots(picks, n5(v.supplier_id), n5(v.oil_type_id), 0, bookInCompany);
    v.ordered_qty = lotAlloc.total;
    if (lotAlloc.primaryBargainId) v.bargain_id = lotAlloc.primaryBargainId;
  }
  const obLines = picks.length ? [] : toBargainLines(v.bargain_lines);
  let obPriced = { lines: [], primaryBargainId: 0 };
  if (obLines.length) {
    obPriced = await priceBargainLines(
      obLines,
      n5(v.supplier_id),
      n5(v.oil_type_id),
      n5(v.ordered_qty),
      String(v.uom || "MT")
    );
    if (obPriced.primaryBargainId) v.bargain_id = obPriced.primaryBargainId;
  }
  if (isConsignment) {
    if (n5(v.ordered_qty) <= 0) throw new Error("Enter the quantity to invoice");
    const deposited = isTrading ? 0 : await consignmentDeposited(n5(v.supplier_id), n5(v.oil_type_id), bookInCompany);
    if (deposited > 0) {
      const avail = await consignmentAvailable(n5(v.supplier_id), n5(v.oil_type_id), bookInCompany);
      if (n5(v.ordered_qty) > avail + 1e-6) {
        throw new Error(`Only ${avail.toFixed(3)} of consigned stock is available for this supplier and product`);
      }
    }
  }
  const prior = await supplierFyTaxable(n5(v.supplier_id), String(v.order_date), 0);
  const roundOff = n5(v.round_off);
  const bargainLines = obPriced.lines.length ? obPriced.lines : lotAlloc.lines.length ? lotAlloc.lines.map((l) => ({ rate: l.rate, qty: l.qty, bargainId: l.bargain_id })) : await bargainLinesForTankers(v.tanker_ids);
  const pricedLines = applyBargainInterestOverrides(bargainLines, v.bargain_interest);
  const m = computeMoney({
    orderedQty: n5(v.ordered_qty),
    invoiceRate: n5(v.invoice_rate),
    bargainRate: n5(v.bargain_rate),
    gstPct: n5(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n5(v.tds_pct),
    // per-invoice interest choice from the form wins; fall back to the supplier
    addsInterest: v.charge_interest !== void 0 ? !!v.charge_interest : !!supplier?.adds_interest,
    interestPct: v.interest_pct !== void 0 && v.interest_pct !== "" ? n5(v.interest_pct) : n5(supplier?.interest_pct),
    interestDays: v.interest_days !== void 0 && v.interest_days !== "" ? n5(v.interest_days) : n5(supplier?.interest_days),
    additionalInterest: n5(v.additional_interest),
    rateRoundOff: rateRoundOff(v),
    tdsThreshold: n5(supplier?.tds_threshold),
    tdsPctAbove: n5(v.tds_pct),
    tdsPrior: prior,
    roundOff,
    lines: pricedLines
  });
  const res = await getClient().execute({
    sql: `INSERT INTO orders
      (company_id, invoice_no, order_date, bargain_id, supplier_id, oil_type_id, bargain_type, ordered_qty, uom,
       bargain_rate, invoice_rate, interest_pct, interest_days, additional_interest, adjusted_rate, taxable_value,
       gst_pct, gst_type, gst_amount, tds_pct, tds_amount, round_off, round_off_manual, net_amount,
       final_taxable_value, final_gst_amount, final_tds_amount, final_net_amount,
       tanker_no, transporter_id, allowed_shortage_pct, is_registered_transporter, posting, financed_by_party,
       payment_cleared_date, remarks, freight_paid_to_supplier, is_consignment, received_qty, received_date, status,
       is_trading, affects_stock, rate_round_off)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      bookInCompany,
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n5(v.bargain_id) : null,
      n5(v.supplier_id),
      n5(v.oil_type_id),
      v.bargain_type || "EX",
      n5(v.ordered_qty),
      v.uom || "MT",
      n5(v.bargain_rate),
      n5(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      n5(v.additional_interest),
      m.adjusted_rate,
      m.taxable_value,
      n5(v.gst_pct),
      v.gst_type || "CGST_SGST",
      m.gst_amount,
      n5(v.tds_pct),
      m.tds_amount,
      roundOff,
      v.round_off_manual ? 1 : 0,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n5(v.transporter_id) : null,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== "" ? Number(v.allowed_shortage_pct) : null,
      v.is_registered_transporter ? 1 : 0,
      1,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date,
      v.remarks ? String(v.remarks).trim() : null,
      v.freight_paid_to_supplier ? 1 : 0,
      isConsignment ? 1 : 0,
      // consignment goods are already at site → received on booking
      isConsignment ? n5(v.ordered_qty) : null,
      isConsignment ? v.order_date : null,
      isConsignment ? "received" : "loaded",
      isTrading ? 1 : 0,
      isTrading ? 0 : 1,
      rateRoundOff(v)
    ]
  });
  const id = Number(res.lastInsertRowid);
  if (isConsignment) {
    if (picks.length) {
      const alloc = await assignConsignmentLots(id, picks, n5(v.supplier_id), n5(v.oil_type_id), bookInCompany);
      await saveOrderBargains(id, alloc.lines.map((l) => ({ bargain_id: l.bargain_id, qty: l.qty })));
    } else {
      await saveOrderBargains(
        id,
        obLines.length ? obLines : v.bargain_id ? [{ bargain_id: n5(v.bargain_id), qty: n5(v.ordered_qty) }] : []
      );
      await autoAssignConsignmentLots(id, n5(v.supplier_id), n5(v.oil_type_id), n5(v.ordered_qty), n5(v.bargain_id), bookInCompany);
    }
  } else {
    await assignTankers(id, v.tanker_ids, n5(v.bargain_id), n5(v.transporter_id), bookInCompany);
    await applySupplierFreight(id, v);
  }
  await saveOrderBargainInterest(id, v.bargain_interest);
  await setSupplierPayable(id, n5(v.supplier_id), m.net_amount, String(v.order_date));
  await postOrderJournal(id, v, m, supplier, roundOff);
  return { id };
}
async function applySupplierFreight(orderId, v) {
  if (!v.freight_paid_to_supplier) return;
  const diff = n5(v.invoice_rate) - n5(v.bargain_rate);
  if (diff <= 0) return;
  await getClient().execute({
    sql: "UPDATE purchase_tankers SET transport_rate_per_ton = ? WHERE order_id = ?",
    args: [diff, orderId]
  });
}
async function freightPaidToSupplier(orderId) {
  const res = await getClient().execute({
    sql: "SELECT freight_paid_to_supplier FROM orders WHERE id = ?",
    args: [orderId]
  });
  return n5(res.rows[0]?.freight_paid_to_supplier) === 1;
}
async function postOrderJournal(orderId, v, m, supplier, roundOff = 0) {
  const oil = await getClient().execute({
    sql: "SELECT code, name FROM products WHERE id = ?",
    args: [n5(v.oil_type_id)]
  });
  const oilCode = String(oil.rows[0]?.code || oil.rows[0]?.name || "OIL").toUpperCase();
  await postPurchaseJournal({
    orderId,
    date: String(v.order_date),
    invoiceNo: String(v.invoice_no || ""),
    oilCode,
    supplierName: String(supplier?.name || "SUPPLIER"),
    taxable: m.taxable_value,
    gst: m.gst_amount,
    tds: m.tds_amount,
    net: m.net_amount,
    roundOff,
    interest: m.interest_per_unit * n5(v.ordered_qty)
  }).catch((e) => console.error("[journal] purchase post failed:", e.message));
}
async function updateOrder(id, v) {
  await ensureOilType(n5(v.oil_type_id));
  const supplier = await getSupplier(n5(v.supplier_id));
  const cur = await getClient().execute({
    sql: "SELECT is_consignment, company_id FROM orders WHERE id = ? LIMIT 1",
    args: [id]
  });
  const wasConsignment = !!cur.rows[0]?.is_consignment;
  await assertPurchaseInvoiceNoFree(v, n5(cur.rows[0]?.company_id) || getActiveCompanyId(), id);
  const picks = toLotPicks(v.consignment_lot_ids);
  let lotAlloc = { total: 0, lines: [], primaryBargainId: 0 };
  if (wasConsignment && picks.length) {
    lotAlloc = await validateConsignmentLots(picks, n5(v.supplier_id), n5(v.oil_type_id), id);
    v.ordered_qty = lotAlloc.total;
    if (lotAlloc.primaryBargainId) v.bargain_id = lotAlloc.primaryBargainId;
  }
  const obLines = wasConsignment && !picks.length ? toBargainLines(v.bargain_lines) : [];
  let obPriced = {
    lines: [],
    primaryBargainId: 0
  };
  if (obLines.length) {
    obPriced = await priceBargainLines(
      obLines,
      n5(v.supplier_id),
      n5(v.oil_type_id),
      n5(v.ordered_qty),
      String(v.uom || "MT")
    );
    if (obPriced.primaryBargainId) v.bargain_id = obPriced.primaryBargainId;
  }
  const prior = await supplierFyTaxable(n5(v.supplier_id), String(v.order_date), id);
  const roundOff = n5(v.round_off);
  const bargainLines = obPriced.lines.length ? obPriced.lines : lotAlloc.lines.length ? lotAlloc.lines.map((l) => ({ rate: l.rate, qty: l.qty, bargainId: l.bargain_id })) : await bargainLinesForTankers(v.tanker_ids);
  const pricedLines = applyBargainInterestOverrides(bargainLines, v.bargain_interest);
  const m = computeMoney({
    orderedQty: n5(v.ordered_qty),
    invoiceRate: n5(v.invoice_rate),
    bargainRate: n5(v.bargain_rate),
    gstPct: n5(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n5(v.tds_pct),
    // per-invoice interest choice from the form wins; fall back to the supplier
    addsInterest: v.charge_interest !== void 0 ? !!v.charge_interest : !!supplier?.adds_interest,
    interestPct: v.interest_pct !== void 0 && v.interest_pct !== "" ? n5(v.interest_pct) : n5(supplier?.interest_pct),
    interestDays: v.interest_days !== void 0 && v.interest_days !== "" ? n5(v.interest_days) : n5(supplier?.interest_days),
    additionalInterest: n5(v.additional_interest),
    rateRoundOff: rateRoundOff(v),
    tdsThreshold: n5(supplier?.tds_threshold),
    tdsPctAbove: n5(v.tds_pct),
    tdsPrior: prior,
    roundOff,
    lines: pricedLines
  });
  await saveOrderBargainInterest(id, v.bargain_interest);
  await getClient().execute({
    sql: `UPDATE orders SET
      invoice_no = ?, order_date = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      ordered_qty = ?, uom = ?, bargain_rate = ?, invoice_rate = ?, interest_pct = ?, interest_days = ?, additional_interest = ?,
      adjusted_rate = ?, taxable_value = ?, gst_pct = ?, gst_type = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?, round_off_manual = ?, net_amount = ?,
      final_taxable_value = ?, final_gst_amount = ?, final_tds_amount = ?, final_net_amount = ?,
      tanker_no = ?, transporter_id = ?, allowed_shortage_pct = ?, is_registered_transporter = ?, posting = 1, financed_by_party = ?,
      payment_cleared_date = ?, remarks = ?, freight_paid_to_supplier = ?, rate_round_off = ?
      WHERE id = ?`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n5(v.bargain_id) : null,
      n5(v.supplier_id),
      n5(v.oil_type_id),
      v.bargain_type || "EX",
      n5(v.ordered_qty),
      v.uom || "MT",
      n5(v.bargain_rate),
      n5(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      n5(v.additional_interest),
      m.adjusted_rate,
      m.taxable_value,
      n5(v.gst_pct),
      v.gst_type || "CGST_SGST",
      m.gst_amount,
      n5(v.tds_pct),
      m.tds_amount,
      roundOff,
      v.round_off_manual ? 1 : 0,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n5(v.transporter_id) : null,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== "" ? Number(v.allowed_shortage_pct) : null,
      v.is_registered_transporter ? 1 : 0,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date,
      v.remarks ? String(v.remarks).trim() : null,
      v.freight_paid_to_supplier ? 1 : 0,
      rateRoundOff(v),
      id
    ]
  });
  if (wasConsignment) {
    await getClient().execute({
      sql: "UPDATE orders SET received_qty = ?, status = 'received' WHERE id = ?",
      args: [n5(v.ordered_qty), id]
    });
    await releaseConsignmentLots(id);
    if (picks.length) {
      const alloc = await assignConsignmentLots(id, picks, n5(v.supplier_id), n5(v.oil_type_id));
      await saveOrderBargains(id, alloc.lines.map((l) => ({ bargain_id: l.bargain_id, qty: l.qty })));
    } else {
      await saveOrderBargains(
        id,
        obLines.length ? obLines : v.bargain_id ? [{ bargain_id: n5(v.bargain_id), qty: n5(v.ordered_qty) }] : []
      );
      await autoAssignConsignmentLots(id, n5(v.supplier_id), n5(v.oil_type_id), n5(v.ordered_qty), n5(v.bargain_id));
    }
  } else {
    await getClient().execute({ sql: "UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?", args: [id] });
    const moveTo = v.company_id ? n5(v.company_id) : 0;
    if (moveTo) {
      await getClient().execute({ sql: "UPDATE orders SET company_id = ? WHERE id = ?", args: [moveTo, id] });
    }
    await assignTankers(id, v.tanker_ids, n5(v.bargain_id), n5(v.transporter_id), moveTo);
    await applySupplierFreight(id, v);
  }
  await setSupplierPayable(id, n5(v.supplier_id), m.net_amount, String(v.order_date));
  await postOrderJournal(id, v, m, supplier, roundOff);
  return { id };
}
async function assertOrderNotInUse(id) {
  const c = getClient();
  const lc = await c.execute({
    sql: `SELECT l.lc_no FROM lc_linked_orders lo JOIN letters_of_credit l ON l.id = lo.lc_id WHERE lo.order_id = ? LIMIT 1`,
    args: [id]
  });
  if (lc.rows.length) {
    throw new Error(
      `This purchase is linked to LC ${lc.rows[0].lc_no} \u2014 edit that LC and untick this invoice before deleting it.`
    );
  }
  const issuance = await c.execute({
    sql: `SELECT l.lc_no FROM lc_issuances i JOIN letters_of_credit l ON l.id = i.lc_id WHERE i.order_id = ? LIMIT 1`,
    args: [id]
  });
  if (issuance.rows.length) {
    throw new Error(
      `A bill has already been issued against this purchase under LC ${issuance.rows[0].lc_no} \u2014 that bill has to be removed first.`
    );
  }
  const deal = await c.execute({
    sql: `SELECT DISTINCT d.id, d.deal_date FROM trading_deals d
          LEFT JOIN trading_deal_orders x ON x.deal_id = d.id
          WHERE d.order_id = ? OR x.order_id = ? LIMIT 1`,
    args: [id, id]
  });
  if (deal.rows.length) {
    throw new Error(
      `This purchase is part of a Trading deal dated ${String(deal.rows[0].deal_date).slice(0, 10)} \u2014 remove it from that deal on the Trading page first.`
    );
  }
}
async function deleteOrder(id) {
  const c = getClient();
  await assertOrderNotInUse(id);
  await deleteJournalByRef("order_id", id);
  await c.execute({ sql: "DELETE FROM supplier_ledger WHERE order_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM transporter_ledger WHERE order_id = ?", args: [id] });
  await c.execute({
    sql: `UPDATE purchase_tankers
          SET order_id = NULL, status = 'loaded', transit_date = NULL, outside_factory_date = NULL,
              inside_factory_date = NULL, empty_date = NULL, received_qty = NULL
          WHERE order_id = ?`,
    args: [id]
  });
  await releaseConsignmentLots(id);
  await c.execute({ sql: "DELETE FROM order_bargains WHERE order_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM order_bargain_interest WHERE order_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM orders WHERE id = ?", args: [id] });
  return { id };
}
async function assignTankers(orderId, tankerIds, bargainId, transporterId, companyId = 0) {
  const ids = Array.isArray(tankerIds) ? tankerIds.map(Number).filter((x) => x > 0) : [];
  if (!ids.length) throw new Error("Select at least one loaded tanker");
  const c = getClient();
  for (const tankerId of ids) {
    const res = await c.execute({
      sql: "SELECT order_id, bargain_id FROM purchase_tankers WHERE id = ?",
      args: [tankerId]
    });
    if (!res.rows.length) throw new Error("A selected tanker no longer exists");
    const row = res.rows[0];
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error("A selected tanker is already attached to another purchase");
    }
    if (Number(row.bargain_id) !== bargainId) {
      throw new Error("All tankers on one purchase must belong to the selected bargain");
    }
    await c.execute({
      // A tanker belongs to whichever company its invoice was booked in, so a
      // clerical mix-up is corrected by re-billing rather than by editing rows.
      sql: `UPDATE purchase_tankers SET order_id = ?,
            company_id = CASE WHEN ? > 0 THEN ? ELSE company_id END,
            transporter_id = CASE WHEN ? > 0 THEN ? ELSE transporter_id END WHERE id = ?`,
      args: [orderId, companyId, companyId, transporterId, transporterId, tankerId]
    });
  }
}
async function listPurchaseTankers(allCompanies = false, forModule) {
  const from = await visibleFromFor("orders", forModule);
  const base = allCompanies ? [] : [getActiveCompanyId()];
  const res = await getClient().execute({
    args: from ? [...base, from] : base,
    sql: `
    SELECT pt.*, o.invoice_no, o.order_date AS invoice_date, o.company_id AS invoice_company_id,
           o.allowed_shortage_pct AS order_allowed_shortage_pct,
           b.bargain_no, b.bargain_type, b.rate_per_uom AS bargain_rate,
           b.allowed_shortage_pct, s.name AS supplier_name,
           p.code AS oil_code, p.name AS oil_name, src.name AS source_name,
           p.material_type AS product_category,
           tr.name AS transporter_name, xb.bargain_no AS extra_bargain_no,
           xb.rate_per_uom AS extra_bargain_rate,
           -- what the gate recorded for this tanker: its own entry number and
           -- the vehicle number written down there, which is the number the
           -- yard actually saw.
           ge.gate_entry_no, ge.tanker_no AS gate_tanker_no, ge.entry_date AS gate_date,
           ge.received_qty AS gate_qty,
           (SELECT old_tanker_no || ' -> ' || new_tanker_no || ' (' || loss_qty || ' lost)'
              FROM tanker_replacements WHERE tanker_id = pt.id ORDER BY id DESC LIMIT 1) AS last_replacement
    FROM purchase_tankers pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN bargains xb ON xb.id = pt.extra_bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN products p ON p.id = pt.oil_type_id
    LEFT JOIN sources src ON src.id = pt.source_id
    LEFT JOIN transporters tr ON tr.id = pt.transporter_id
    LEFT JOIN gate_entries ge ON ge.tanker_id = pt.id AND ge.direction = 'in'
    ${allCompanies ? "" : "WHERE pt.company_id = ?"}
    ${from ? `${allCompanies ? "WHERE" : "AND"} (pt.status != 'empty' OR pt.loaded_date IS NULL OR pt.loaded_date >= ?)` : ""}
    ORDER BY CASE pt.status
      WHEN 'supplier_factory' THEN 1 WHEN 'loaded' THEN 2 WHEN 'transit' THEN 3
      WHEN 'outside_factory' THEN 4 WHEN 'inside_factory' THEN 5 ELSE 6 END, pt.id DESC
  `
  });
  return toPlain6(res);
}
async function createPurchaseTanker(v) {
  if (!v.bargain_id) throw new Error("Bargain is required");
  const res = await getClient().execute({
    sql: `INSERT INTO purchase_tankers
      (company_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id, loaded_qty, uom, payment_mode,
       transporter_id, status, condition)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, 'supplier_factory', ?)`,
    args: [
      getActiveCompanyId(),
      String(v.tanker_no || "").trim(),
      v.factory_entry_date || v.loaded_date || null,
      n5(v.bargain_id),
      n5(v.supplier_id),
      n5(v.oil_type_id),
      v.uom || "MT",
      v.transporter_id ? n5(v.transporter_id) : null,
      normCondition(v.condition)
    ]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function updateTankerDetails(id, v) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM purchase_tankers WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Tanker not found");
  const t = toPlain6(res)[0];
  const pick = (key3) => v[key3] !== void 0 ? v[key3] : t[key3];
  const pickNum = (key3, fallback) => v[key3] !== void 0 && v[key3] !== "" ? n5(v[key3]) : fallback;
  const bargainId = v.bargain_id ? n5(v.bargain_id) : n5(t.bargain_id);
  const loadedQty = pickNum("loaded_qty", n5(t.loaded_qty));
  const receivedQty = pickNum("received_qty", n5(t.received_qty));
  const mergedDates = {};
  for (const [key3] of STAGE_DATE_FIELDS) mergedDates[key3] = pick(key3);
  assertStageDateOrder(mergedDates);
  const bRes = await c.execute({
    sql: "SELECT supplier_id, oil_type_id, bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?",
    args: [bargainId]
  });
  if (!bRes.rows.length) throw new Error("Bargain not found");
  const b = bRes.rows[0];
  const extraQty = n5(t.extra_qty);
  if (loadedQty > 0) {
    if (extraQty > 0 && loadedQty < extraQty - 1e-6) {
      throw new Error(
        `Loaded qty cannot be below the excess qty (${extraQty.toFixed(3)}) already booked to its own bargain`
      );
    }
    const bal = await c.execute({
      sql: `SELECT b.qty
              - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
              - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
            AS balance FROM bargains b WHERE b.id = ?`,
      args: [id, id, bargainId]
    });
    if (loadedQty - extraQty > n5(bal.rows[0]?.balance) + 1e-6) {
      throw new Error(`Loaded qty exceeds the bargain balance (${n5(bal.rows[0]?.balance).toFixed(3)})`);
    }
  }
  if (String(t.status) === "empty" && Math.abs(receivedQty - n5(t.received_qty)) > 1e-9) {
    const gateQty = await tankerGateReceived(id);
    if (gateQty == null) throw new Error("No completed gate entry for this tanker");
    if (Math.abs(gateQty - receivedQty) > GATE_MATCH_BUFFER) {
      throw new Error(`Received qty (${receivedQty}) is more than ${GATE_MATCH_BUFFER} MT away from the gate received qty (${gateQty})`);
    }
  }
  const sourceId = v.source_id !== void 0 ? v.source_id ? n5(v.source_id) : null : t.source_id ?? null;
  const transitDate = pick("transit_date") || null;
  let expected = null;
  if (sourceId && transitDate) {
    const src = await c.execute({ sql: "SELECT transit_days FROM sources WHERE id = ?", args: [sourceId] });
    const d = new Date(transitDate);
    d.setDate(d.getDate() + n5(src.rows[0]?.transit_days));
    expected = d.toISOString().slice(0, 10);
  }
  let transporterId = v.transporter_id !== void 0 ? v.transporter_id ? n5(v.transporter_id) : null : t.transporter_id ?? null;
  let rate = pickNum("transport_rate_per_ton", n5(t.transport_rate_per_ton));
  let transport = n5(t.transport_amount);
  let penalty = n5(t.shortage_charge_amount);
  if (String(t.status) === "empty") {
    const isEx = tankerIsEx(v.condition !== void 0 ? v.condition : t.condition, b.bargain_type);
    rate = isEx ? rate : 0;
    transport = receivedQty * rate;
    let pct = b.allowed_shortage_pct == null ? n5(await getSetting("allowed_shortage_pct") ?? "0") : n5(b.allowed_shortage_pct);
    if (t.order_id) {
      const ord = await c.execute({
        sql: "SELECT allowed_shortage_pct FROM orders WHERE id = ?",
        args: [n5(t.order_id)]
      });
      if (ord.rows.length && ord.rows[0].allowed_shortage_pct != null) pct = n5(ord.rows[0].allowed_shortage_pct);
    }
    const shortage = Math.max(0, loadedQty - receivedQty);
    const excess = Math.max(0, shortage - loadedQty * pct / 100);
    penalty = isEx ? excess * n5(b.rate_per_uom) : 0;
    transporterId = isEx ? transporterId : null;
    if (t.order_id) {
      const tankerNo = String(pick("tanker_no") || t.tanker_no);
      await c.execute({
        sql: `DELETE FROM transporter_ledger
               WHERE order_id = ? AND entry_type IN ('freight','shortage_penalty') AND note LIKE ?`,
        args: [n5(t.order_id), `Tanker ${t.tanker_no}:%`]
      });
      if (transporterId && !await freightPaidToSupplier(n5(t.order_id))) {
        const emptyOn = pick("empty_date") || null;
        if (transport > 4e-3) {
          await c.execute({
            sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
                  VALUES (?, ?, ?, 'freight', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
            args: [transporterId, n5(t.order_id), emptyOn, Math.round(transport * 100) / 100, `Tanker ${tankerNo}: freight`, n5(t.order_id)]
          });
        }
        if (penalty > 4e-3) {
          await c.execute({
            sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
                  VALUES (?, ?, ?, 'shortage_penalty', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
            args: [
              transporterId,
              n5(t.order_id),
              emptyOn,
              -(Math.round(penalty * 100) / 100),
              `Tanker ${tankerNo}: oil shortage ${excess.toFixed(3)} ${String(t.uom || "MT")} beyond ${pct}% tolerance`,
              n5(t.order_id)
            ]
          });
        }
      }
    }
  }
  await c.execute({
    sql: `UPDATE purchase_tankers SET
      tanker_no = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?,
      loaded_date = ?, loaded_qty = ?, payment_mode = ?,
      transit_date = ?, source_id = ?, expected_delivery_date = ?,
      outside_factory_date = ?, inside_factory_date = ?, empty_date = ?,
      received_qty = ?, transporter_id = ?, transport_rate_per_ton = ?,
      transport_amount = ?, shortage_charge_amount = ?,
      krfl_weighment_doc_no = ?, outside_weighment_doc_no = ?, condition = ?
      WHERE id = ?`,
    args: [
      String(pick("tanker_no") || t.tanker_no).trim(),
      bargainId,
      n5(b.supplier_id),
      n5(b.oil_type_id),
      pick("loaded_date") || null,
      loadedQty,
      pick("payment_mode") || "pending",
      transitDate,
      sourceId,
      expected,
      pick("outside_factory_date") || null,
      pick("inside_factory_date") || null,
      pick("empty_date") || null,
      receivedQty,
      transporterId,
      rate,
      transport,
      penalty,
      pick("krfl_weighment_doc_no") || null,
      pick("outside_weighment_doc_no") || null,
      normCondition(pick("condition")),
      id
    ]
  });
  if (t.order_id) await syncPurchaseFromTankers(n5(t.order_id));
  return { id };
}
async function deletePurchaseTanker(id) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT order_id FROM purchase_tankers WHERE id = ?", args: [id] });
  if (res.rows[0]?.order_id != null) throw new Error("Remove this tanker from its purchase before deleting it");
  await c.execute({ sql: "DELETE FROM purchase_tankers WHERE id = ?", args: [id] });
  return { id };
}
async function syncPurchaseFromTankers(orderId) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_count,
                 SUM(COALESCE(received_qty, 0)) AS received_qty,
                 SUM(COALESCE(transport_amount, 0)) AS transport_amount,
                 SUM(COALESCE(shortage_charge_amount, 0)) AS shortage_amount
          FROM purchase_tankers WHERE order_id = ?`,
    args: [orderId]
  });
  const x = res.rows[0];
  const status = n5(x.total) > 0 && n5(x.total) === n5(x.empty_count) ? "received" : "loaded";
  await c.execute({
    sql: `UPDATE orders SET status = ?, received_qty = ?, transport_amount = ?,
          shortage_charge_amount = ?,
          received_date = CASE WHEN ? = 'received' THEN COALESCE(
            (SELECT MAX(COALESCE(pt.empty_date, pt.inside_factory_date, pt.outside_factory_date, pt.transit_date, pt.loaded_date))
             FROM purchase_tankers pt WHERE pt.order_id = orders.id),
            orders.received_date, orders.order_date, date('now'))
          ELSE received_date END
          WHERE id = ?`,
    args: [status, n5(x.received_qty), n5(x.transport_amount), n5(x.shortage_amount), status, orderId]
  });
}
async function backfillPurchaseRoundOff() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'purchase_round_off_backfilled_3'");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  const sup = await c.execute(
    "SELECT id, name, tds_threshold, tds_above_only, opening_purchase_amount, opening_purchase_date FROM suppliers"
  );
  const suppliers = /* @__PURE__ */ new Map();
  for (const r of toPlain6(sup)) suppliers.set(n5(r.id), r);
  const res = await c.execute(`
    SELECT o.id, o.company_id, o.supplier_id, o.invoice_no, o.order_date, o.ordered_qty, o.bargain_rate,
           o.gst_pct, o.interest_pct, o.interest_days, o.taxable_value, o.gst_amount, o.tds_pct, o.tds_amount,
           o.round_off, o.round_off_manual, o.net_amount, o.final_taxable_value, o.final_gst_amount,
           pr.code AS oil_code, pr.name AS oil_name
    FROM orders o LEFT JOIN products pr ON pr.id = o.oil_type_id
    ORDER BY o.order_date ASC, o.id ASC`);
  const round213 = (v) => Math.round(v * 100) / 100;
  const same = (a, b) => Math.abs(a - b) < 5e-3;
  const prior = /* @__PURE__ */ new Map();
  let applied = 0;
  for (const r of toPlain6(res)) {
    const s = suppliers.get(n5(r.supplier_id));
    const { start, end } = fyRange(String(r.order_date));
    const key3 = `${n5(r.company_id)}|${n5(r.supplier_id)}|${start}`;
    if (!prior.has(key3)) {
      const od = String(s?.opening_purchase_date || "");
      prior.set(key3, od && od >= start && od <= end ? n5(s?.opening_purchase_amount) : 0);
    }
    const before = prior.get(key3);
    prior.set(key3, before + n5(r.taxable_value));
    if (n5(r.round_off_manual) === 1) continue;
    const T = round213(n5(r.taxable_value) + n5(r.gst_amount));
    const ro = round213(Math.round(T) - T);
    const pct = s?.tds_above_only ? 0 : n5(r.tds_pct);
    const threshold = n5(s?.tds_threshold);
    const tds = round213(tierTds(T + ro, before, threshold, pct, n5(r.tds_pct)));
    const net = round213(T + ro - tds);
    const fT = round213(n5(r.final_taxable_value) + n5(r.final_gst_amount));
    const fTds = round213(tierTds(fT + ro, before, threshold, pct, n5(r.tds_pct)));
    const fNet = round213(fT + ro - fTds);
    if (same(ro, n5(r.round_off)) && same(tds, n5(r.tds_amount)) && same(net, n5(r.net_amount))) continue;
    console.log(
      `[orders] round-off repair #${r.id} ${r.invoice_no} ${r.order_date}: ro ${n5(r.round_off).toFixed(2)} -> ${ro.toFixed(2)} | tds ${n5(r.tds_amount).toFixed(2)} -> ${tds.toFixed(2)} | net ${n5(r.net_amount).toFixed(2)} -> ${net.toFixed(2)}`
    );
    await c.execute({
      sql: "UPDATE orders SET round_off = ?, tds_amount = ?, net_amount = ?, final_tds_amount = ?, final_net_amount = ? WHERE id = ?",
      args: [ro, tds, net, fTds, fNet, n5(r.id)]
    });
    const interestPerUnit = n5(r.bargain_rate) * (1 + n5(r.gst_pct) / 100) * (n5(r.interest_pct) / 100) * (n5(r.interest_days) / 365);
    await postPurchaseJournal({
      orderId: n5(r.id),
      date: String(r.order_date),
      invoiceNo: String(r.invoice_no || ""),
      oilCode: String(r.oil_code || r.oil_name || "OIL").toUpperCase(),
      supplierName: String(s?.name || "SUPPLIER"),
      taxable: n5(r.taxable_value),
      gst: n5(r.gst_amount),
      tds,
      net,
      roundOff: ro,
      interest: interestPerUnit * n5(r.ordered_qty),
      companyId: n5(r.company_id) || 1
    }).catch((e) => console.error("[orders] journal re-post failed:", e.message));
    if (n5(r.supplier_id)) {
      await setSupplierPayable(n5(r.id), n5(r.supplier_id), net, String(r.order_date)).catch(
        (e) => console.error("[orders] payable re-post failed:", e.message)
      );
    }
    applied++;
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('purchase_round_off_backfilled_3', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  );
  if (applied > 0) console.log(`[orders] round-off repair corrected ${applied} purchases`);
}
async function backfillOrderStatuses() {
  const c = getClient();
  const res = await c.execute(
    "SELECT DISTINCT order_id FROM purchase_tankers WHERE order_id IS NOT NULL"
  );
  for (const r of res.rows) {
    await syncPurchaseFromTankers(n5(r.order_id)).catch(() => {
    });
  }
}
async function replaceTanker(id, v) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM purchase_tankers WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Tanker not found");
  const tanker = toPlain6(res)[0];
  if (String(tanker.status) !== "transit") {
    throw new Error("A tanker can only be replaced while In Transit \u2014 it is already billed once past that stage");
  }
  const newTankerNo = String(v.new_tanker_no || "").trim();
  if (!newTankerNo) throw new Error("Enter the replacement tanker number");
  const lossQty = n5(v.loss_qty);
  if (lossQty < 0) throw new Error("Loss quantity cannot be negative");
  if (lossQty >= n5(tanker.loaded_qty)) {
    throw new Error(`Loss cannot be at or above the ${n5(tanker.loaded_qty)} ${tanker.uom || "MT"} loaded \u2014 nothing would remain to replace`);
  }
  const newLoadedQty = Math.round((n5(tanker.loaded_qty) - lossQty) * 1e3) / 1e3;
  const replacedDate = v.date ? String(v.date).slice(0, 10) : todayISO();
  await c.execute({
    sql: "UPDATE purchase_tankers SET tanker_no = ?, loaded_qty = ?, loss_qty = loss_qty + ? WHERE id = ?",
    args: [newTankerNo, newLoadedQty, lossQty, id]
  });
  await c.execute({
    sql: `INSERT INTO tanker_replacements (tanker_id, old_tanker_no, new_tanker_no, loss_qty, reason, replaced_date)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, tanker.tanker_no || null, newTankerNo, lossQty, v.reason ? String(v.reason).trim() : null, replacedDate]
  });
  return { id };
}
async function revertPurchaseTanker(id) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM purchase_tankers WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Tanker not found");
  const tanker = toPlain6(res)[0];
  const current2 = TANKER_STAGES.indexOf(String(tanker.status));
  if (current2 <= 0) throw new Error("Already at the supplier factory \u2014 nothing to undo");
  const prev = TANKER_STAGES[current2 - 1];
  const dateCol = {
    transit: "transit_date",
    outside_factory: "outside_factory_date",
    inside_factory: "inside_factory_date",
    empty: "empty_date"
  };
  const clearQty = String(tanker.status) === "loaded" ? ", loaded_qty = 0" : "";
  const clear = dateCol[String(tanker.status)];
  await c.execute({
    sql: `UPDATE purchase_tankers SET status = ?${clear ? `, ${clear} = NULL` : ""}${String(tanker.status) === "empty" ? ", received_qty = NULL" : ""}${clearQty} WHERE id = ?`,
    args: [prev, id]
  });
  if (tanker.order_id) await syncPurchaseFromTankers(n5(tanker.order_id)).catch(() => {
  });
  return { id, status: prev };
}
async function advancePurchaseTanker(id, toStatus, data) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM purchase_tankers WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Tanker not found");
  const tanker = toPlain6(res)[0];
  const current2 = TANKER_STAGES.indexOf(String(tanker.status));
  const target = TANKER_STAGES.indexOf(toStatus);
  if (target !== current2 + 1) throw new Error("That is not the next tanker stage");
  assertStageDateOrder({
    loaded_date: data.loaded_date ?? tanker.loaded_date,
    transit_date: data.transit_date ?? tanker.transit_date,
    outside_factory_date: data.outside_factory_date ?? tanker.outside_factory_date,
    inside_factory_date: data.inside_factory_date ?? tanker.inside_factory_date,
    empty_date: data.empty_date ?? tanker.empty_date
  });
  if (toStatus === "loaded") {
    const qty = n5(data.loaded_qty);
    if (qty <= 0) throw new Error("Enter the actual loaded quantity");
    const tankerNo = String(data.tanker_no ?? tanker.tanker_no ?? "").trim();
    if (!tankerNo) throw new Error("Tanker number is required at loading");
    const bargainId = data.bargain_id ? n5(data.bargain_id) : n5(tanker.bargain_id);
    const balance = await c.execute({
      sql: `SELECT b.qty
              - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
              - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
            AS balance
            FROM bargains b WHERE b.id = ?`,
      args: [id, id, bargainId]
    });
    if (!balance.rows.length) throw new Error("Bargain not found");
    const bal = n5(balance.rows[0].balance);
    let extraBargainId = null;
    let extraQty = 0;
    if (qty > bal + 1e-6) {
      if (!data.allow_excess) {
        throw new Error(`Loaded qty exceeds the bargain balance (${bal.toFixed(3)})`);
      }
      extraQty = Math.round((qty - Math.max(bal, 0)) * 1e3) / 1e3;
      const oRes = await c.execute({ sql: "SELECT * FROM bargains WHERE id = ?", args: [bargainId] });
      if (!oRes.rows.length) throw new Error("Bargain not found");
      const orig = toPlain6(oRes)[0];
      if (data.expand_bargain) {
        await adjustBargainQty(
          bargainId,
          extraQty,
          `Extra ${extraQty.toFixed(3)} ${orig.uom} on tanker ${tanker.tanker_no || id} at loading`,
          String(data.loaded_date || "").slice(0, 10) || void 0
        );
        extraBargainId = null;
        extraQty = 0;
      } else if (data.extra_bargain_id) {
        const chosenId = n5(data.extra_bargain_id);
        if (chosenId === bargainId) throw new Error("The excess bargain must be different from the loading bargain");
        const chRes = await c.execute({
          sql: `SELECT b.id, b.supplier_id, b.oil_type_id,
                  b.qty
                    - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
                    - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
                    - COALESCE((SELECT SUM(ordered_qty) FROM orders WHERE bargain_id = b.id AND is_consignment = 1), 0)
                  AS balance
                FROM bargains b WHERE b.id = ?`,
          args: [id, id, chosenId]
        });
        if (!chRes.rows.length) throw new Error("Selected bargain not found");
        const ch = chRes.rows[0];
        if (n5(ch.supplier_id) !== n5(orig.supplier_id) || n5(ch.oil_type_id) !== n5(orig.oil_type_id)) {
          throw new Error("The excess bargain must be for the same supplier and oil");
        }
        if (extraQty > n5(ch.balance) + 1e-6) {
          throw new Error(`The selected bargain has only ${n5(ch.balance).toFixed(3)} balance for the ${extraQty.toFixed(3)} excess`);
        }
        extraBargainId = chosenId;
      } else {
        const duty = n5(orig.duty);
        const hasRate = data.excess_rate !== void 0 && data.excess_rate !== null && data.excess_rate !== "";
        const baseRate = hasRate ? n5(data.excess_rate) - duty : n5(orig.base_rate);
        const created = await createBargain({
          bargain_date: String(data.loaded_date || "").slice(0, 10) || String(orig.bargain_date),
          supplier_id: orig.supplier_id,
          broker_id: orig.broker_id,
          oil_type_id: orig.oil_type_id,
          bargain_type: orig.bargain_type,
          qty: extraQty,
          uom: orig.uom,
          base_rate: baseRate,
          duty,
          allowed_shortage_pct: orig.allowed_shortage_pct
        });
        extraBargainId = created.id;
      }
    }
    const loadSourceId = data.source_id ? n5(data.source_id) : tanker.source_id ?? null;
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'loaded', tanker_no = ?, bargain_id = ?, loaded_date = ?, loaded_qty = ?,
            payment_mode = ?, source_id = ?, extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        tankerNo,
        bargainId,
        data.loaded_date || null,
        qty,
        data.payment_mode === "supplier_finance" ? "supplier_finance" : "paid_by_us",
        loadSourceId,
        extraBargainId,
        extraQty,
        id
      ]
    });
  } else if (toStatus === "transit") {
    const sourceId = data.source_id ? n5(data.source_id) : tanker.source_id ?? null;
    const transitDate = String(data.transit_date || "");
    let expected = null;
    if (sourceId && transitDate) {
      const src = await c.execute({ sql: "SELECT transit_days FROM sources WHERE id = ?", args: [sourceId] });
      const d = new Date(transitDate);
      d.setDate(d.getDate() + n5(src.rows[0]?.transit_days));
      expected = d.toISOString().slice(0, 10);
    }
    const bt = tanker.bargain_id ? (await c.execute({ sql: "SELECT bargain_type FROM bargains WHERE id = ?", args: [n5(tanker.bargain_id)] })).rows[0]?.bargain_type : null;
    const isEx = tankerIsEx(data.condition !== void 0 ? data.condition : tanker.condition, bt);
    const rate = n5(data.transport_rate_per_ton);
    const transporterId = data.transporter_id ? n5(data.transporter_id) : tanker.transporter_id ?? null;
    if (isEx && rate <= 0) {
      throw new Error(
        `Tanker ${tanker.tanker_no} is on EX terms, so the transporter rate per ${String(tanker.uom || "MT")} is required before it moves to In transit.`
      );
    }
    const sets = ["status = 'transit'", "transit_date = ?", "source_id = ?", "expected_delivery_date = ?"];
    const args = [transitDate || null, sourceId, expected];
    if (isEx) {
      sets.push("transport_rate_per_ton = ?", "transporter_id = ?");
      args.push(rate, transporterId);
    }
    args.push(id);
    await c.execute({
      sql: `UPDATE purchase_tankers SET ${sets.join(", ")} WHERE id = ?`,
      args
    });
  } else if (toStatus === "outside_factory") {
    if (!tanker.order_id) {
      throw new Error(
        `Tanker ${tanker.tanker_no} is not billed yet. Create the purchase invoice first, then move it further.`
      );
    }
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'outside_factory', outside_factory_date = ? WHERE id = ?",
      args: [data.outside_factory_date || null, id]
    });
  } else if (toStatus === "inside_factory") {
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'inside_factory', inside_factory_date = ? WHERE id = ?",
      args: [data.inside_factory_date || null, id]
    });
  } else if (toStatus === "empty") {
    const receivedQty = n5(data.received_qty);
    if (receivedQty <= 0 || receivedQty > n5(tanker.loaded_qty) + 1e-6) throw new Error("Enter a valid empty quantity");
    const gateQty = await tankerGateReceived(id);
    if (gateQty == null) {
      throw new Error("No gate entry found for this tanker. Record the gate receipt first.");
    }
    if (Math.abs(gateQty - receivedQty) > GATE_MATCH_BUFFER) {
      throw new Error(
        `Received qty (${receivedQty}) is more than ${GATE_MATCH_BUFFER} MT away from the gate received qty (${gateQty}) for this tanker.`
      );
    }
    const bargain = await c.execute({
      sql: "SELECT bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?",
      args: [n5(tanker.bargain_id)]
    });
    const b = bargain.rows[0] || {};
    const isEx = tankerIsEx(tanker.condition, b.bargain_type);
    const rate = isEx ? n5(data.transport_rate_per_ton) : 0;
    const transport = receivedQty * rate;
    let pct = b.allowed_shortage_pct == null ? n5(await getSetting("allowed_shortage_pct") ?? "0") : n5(b.allowed_shortage_pct);
    if (tanker.order_id) {
      const ord = await c.execute({
        sql: "SELECT allowed_shortage_pct FROM orders WHERE id = ?",
        args: [n5(tanker.order_id)]
      });
      if (ord.rows.length && ord.rows[0].allowed_shortage_pct != null) {
        pct = n5(ord.rows[0].allowed_shortage_pct);
      }
    }
    const shortage = Math.max(0, n5(tanker.loaded_qty) - receivedQty);
    const excess = Math.max(0, shortage - n5(tanker.loaded_qty) * pct / 100);
    const penalty = isEx ? excess * n5(b.rate_per_uom) : 0;
    const transporterId = isEx ? n5(data.transporter_id) : null;
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'empty', empty_date = ?, received_qty = ?,
            transporter_id = ?, transport_rate_per_ton = ?, transport_amount = ?,
            shortage_charge_amount = ?, krfl_weighment_doc_no = ?, krfl_weighment_photo = ?,
            outside_weighment_doc_no = ?, outside_weighment_photo = ? WHERE id = ?`,
      args: [
        data.empty_date || null,
        receivedQty,
        transporterId,
        rate,
        transport,
        penalty,
        data.krfl_weighment_doc_no || null,
        data.krfl_weighment_photo || null,
        data.outside_weighment_doc_no || null,
        data.outside_weighment_photo || null,
        id
      ]
    });
    if (tanker.order_id && transporterId && !await freightPaidToSupplier(n5(tanker.order_id))) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger
          (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'freight', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
        args: [
          transporterId,
          n5(tanker.order_id),
          data.empty_date || null,
          transport - penalty,
          `Tanker ${tanker.tanker_no}: freight less shortage`,
          n5(tanker.order_id)
        ]
      });
    }
  }
  if (tanker.order_id) await syncPurchaseFromTankers(n5(tanker.order_id));
  return { id };
}
async function advanceOrder(id, toStatus, data) {
  const c = getClient();
  const ordRes = await c.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [id] });
  if (!ordRes.rows.length) throw new Error("Order not found");
  const order = toPlain6(ordRes)[0];
  const ci = STAGES.indexOf(String(order.status));
  const ti = STAGES.indexOf(toStatus);
  if (ti < 0 || ti !== ci + 1) throw new Error("That step is not the next stage for this order");
  const sets = ["status = ?"];
  const args = [toStatus];
  if (toStatus === "at_port") {
    sets.push("port_entry_date = ?");
    args.push(data.port_entry_date || null);
    if (data.tanker_no !== void 0) {
      sets.push("tanker_no = ?");
      args.push(data.tanker_no || null);
    }
  } else if (toStatus === "payment_cleared") {
    const financed = !!data.financed_by_party;
    const pcDate = data.payment_cleared_date || null;
    const supplier = await getSupplier(n5(order.supplier_id));
    let interestDays = 0;
    let interestAmt = 0;
    if (!financed && supplier && !supplier.adds_interest && n5(supplier.interest_pct) > 0 && pcDate && order.order_date) {
      const days = Math.round(
        (new Date(pcDate).getTime() - new Date(String(order.order_date)).getTime()) / 864e5
      );
      interestDays = Math.max(0, days - n5(supplier.credit_period_days));
      interestAmt = n5(order.net_amount) * n5(supplier.interest_pct) * interestDays / (100 * 365);
    }
    await c.execute({
      sql: `UPDATE orders SET status = 'payment_cleared', payment_cleared_date = ?, financed_by_party = ?,
            credit_interest_days = ?, credit_interest_amount = ? WHERE id = ?`,
      args: [pcDate, financed ? 1 : 0, interestDays, interestAmt, id]
    });
    await c.execute({
      sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'interest'",
      args: [id]
    });
    if (interestAmt > 0) {
      await c.execute({
        sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note, company_id)
              VALUES (?, ?, ?, 'interest', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
        args: [
          n5(order.supplier_id),
          id,
          pcDate,
          interestAmt,
          `Interest for ${interestDays} days beyond credit period`,
          id
        ]
      });
    }
    return { id };
  } else if (toStatus === "in_transit") {
    const sourceId = data.source_id ? Number(data.source_id) : null;
    const dispatch = data.dispatch_date || null;
    let expected = null;
    if (sourceId && dispatch) {
      const s = await c.execute({
        sql: "SELECT transit_days FROM sources WHERE id = ?",
        args: [sourceId]
      });
      const days = s.rows.length ? n5(s.rows[0].transit_days) : 0;
      const d = new Date(dispatch);
      d.setDate(d.getDate() + days);
      expected = d.toISOString().slice(0, 10);
    }
    sets.push("dispatch_date = ?", "source_id = ?", "expected_delivery_date = ?");
    args.push(dispatch, sourceId, expected);
  } else if (toStatus === "outside_factory") {
    sets.push("outside_factory_date = ?");
    args.push(data.outside_factory_date || null);
  } else if (toStatus === "inside_factory") {
    sets.push("inside_factory_date = ?");
    args.push(data.inside_factory_date || null);
  } else if (toStatus === "received") {
    const isEx = !isDelivered(order.bargain_type);
    const orderedQty = n5(order.ordered_qty);
    const receivedQty = n5(data.received_qty);
    const bargainRate = n5(order.bargain_rate);
    const transportRate = isEx ? n5(data.transport_rate_per_ton) : 0;
    const transportAmount = isEx ? receivedQty * transportRate : 0;
    let pct = n5(await getSetting("allowed_shortage_pct") ?? "0");
    if (order.bargain_id) {
      const b = await c.execute({
        sql: "SELECT allowed_shortage_pct FROM bargains WHERE id = ?",
        args: [Number(order.bargain_id)]
      });
      const bp = b.rows.length ? b.rows[0].allowed_shortage_pct : null;
      if (bp != null) pct = Number(bp);
    }
    if (order.allowed_shortage_pct != null) pct = Number(order.allowed_shortage_pct);
    const allowedQty = orderedQty * pct / 100;
    const actualShortage = Math.max(0, orderedQty - receivedQty);
    const excessShortage = Math.max(0, actualShortage - allowedQty);
    const shortageCharge = isEx ? excessShortage * bargainRate : 0;
    const transporterId = isEx ? n5(data.transporter_id) : null;
    sets.push(
      "received_date = ?",
      "received_qty = ?",
      "transporter_id = ?",
      "transport_rate_per_ton = ?",
      "transport_amount = ?",
      "allowed_shortage_pct = ?",
      "allowed_shortage_qty = ?",
      "actual_shortage_qty = ?",
      "excess_shortage_qty = ?",
      "shortage_charge_amount = ?"
    );
    args.push(
      data.received_date || null,
      receivedQty,
      transporterId,
      transportRate,
      transportAmount,
      pct,
      allowedQty,
      actualShortage,
      excessShortage,
      shortageCharge
    );
    args.push(id);
    await c.execute({ sql: `UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, args });
    await c.execute({
      sql: "DELETE FROM transporter_ledger WHERE order_id = ? AND entry_type IN ('freight','shortage_penalty')",
      args: [id]
    });
    if (isEx && transporterId && !n5(order.freight_paid_to_supplier)) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
              VALUES (?, ?, ?, 'freight', ?, 'Freight earned', (SELECT company_id FROM orders WHERE id = ?))`,
        args: [transporterId, id, data.received_date || null, transportAmount, id]
      });
      if (shortageCharge > 0) {
        await c.execute({
          sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
                VALUES (?, ?, ?, 'shortage_penalty', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
          args: [
            transporterId,
            id,
            data.received_date || null,
            -shortageCharge,
            `Shortage ${excessShortage.toFixed(3)} ${order.uom} beyond ${pct}% tolerance`,
            id
          ]
        });
      }
    }
    return { id };
  }
  args.push(id);
  await c.execute({ sql: `UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, args });
  return { id };
}
async function listSupplierLedger() {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, s.name AS supplier_name, o.invoice_no
    FROM supplier_ledger l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN orders o ON o.id = l.order_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  });
  return toPlain6(res);
}
async function listTransporterLedger() {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, t.name AS transporter_name, o.invoice_no
    FROM transporter_ledger l
    LEFT JOIN transporters t ON t.id = l.transporter_id
    LEFT JOIN orders o ON o.id = l.order_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  });
  return toPlain6(res);
}
async function addLedgerEntry(d) {
  const partyType = d.party_type === "transporter" ? "transporter" : d.party_type === "customer" ? "customer" : "supplier";
  const table = partyType === "supplier" ? "supplier_ledger" : partyType === "transporter" ? "transporter_ledger" : "customer_ledger";
  const col = partyType === "supplier" ? "supplier_id" : partyType === "transporter" ? "transporter_id" : "customer_id";
  const amount = n5(d.cr) - n5(d.dr);
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${col}, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    args: [n5(d.party_id), d.entry_date, d.entry_type || "manual", amount, d.note || null, getActiveCompanyId()]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function deleteLedgerEntry(partyType, id) {
  const table = partyType === "transporter" ? "transporter_ledger" : partyType === "customer" ? "customer_ledger" : "supplier_ledger";
  await getClient().execute({
    sql: `DELETE FROM ${table} WHERE id = ? AND entry_type IN ('opening','advance','adjustment','manual','general','dr_note','cr_note')`,
    args: [id]
  });
  return { id };
}

// src/main/stock.ts
async function stockLevels(range, companyIds) {
  const c = getClient();
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0);
  if (!cidList.length) cidList.push(getActiveCompanyId());
  const ph = cidList.map(() => "?").join(", ");
  const from = String(range?.from || "");
  const to = String(range?.to || "");
  const SOURCES = {
    received: {
      base: `SELECT oil_type_id AS pid, SUM(received_qty) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id IN (${ph})`,
      // Dated when the oil actually landed — the day the tanker was emptied,
      // which is what received_date records. Stock is a physical register, so
      // a tanker invoiced at the end of one month and emptied in the next is
      // that next month's receipt. (Falls back to the invoice date for an
      // older row that never got an emptied date written to it.)
      //
      // A consignment or direct purchase has no tanker journey at all — the
      // goods are already standing at our site and the invoice is what draws
      // them into our books, so that is the day they land. Its received_date
      // is only ever a stamp of when the invoice happened to be booked, which
      // would otherwise drag a July draw into August.
      date: `CASE WHEN COALESCE(is_consignment, 0) = 1
                  THEN order_date
                  ELSE COALESCE(received_date, order_date) END`,
      group: "GROUP BY oil_type_id"
    },
    produced: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM production WHERE company_id IN (${ph})`,
      date: "prod_date",
      group: "GROUP BY product_id"
    },
    // A by-product line ('output', e.g. fatty acid off a refining batch) is
    // made by the batch just as the main product is, so it adds to stock.
    // Dead loss ('loss') is neither consumed nor produced — it just goes.
    byProduct: {
      base: `SELECT i.product_id AS pid, SUM(i.qty) AS q FROM production_items i
             JOIN production p ON p.id = i.production_id
             WHERE i.kind = 'output' AND p.company_id IN (${ph})`,
      date: "p.prod_date",
      group: "GROUP BY i.product_id"
    },
    consumed: {
      base: `SELECT i.product_id AS pid, SUM(i.qty) AS q FROM production_items i
             JOIN production p ON p.id = i.production_id
             WHERE i.kind = 'input' AND p.company_id IN (${ph})`,
      date: "p.prod_date",
      group: "GROUP BY i.product_id"
    },
    // Stock leaves on the INVOICE date, and the quantity is the dispatched one.
    //
    // The mill invoices as the lorry goes, so the invoice date IS the dispatch:
    // 158 of 163 lines have the two the same. It used to date by the unloaded
    // date, which kept goods on our books for as long as the lorry was on the
    // road — twelve days on one August invoice. Then by the loaded date, which
    // was nearly right but is re-stamped whenever an invoice is edited, so a
    // July dispatch could silently reappear as an August one.
    //
    // The invoice date is the one figure on a sale that never moves by itself,
    // and it is what the Sales register counts by — so the two pages can no
    // longer disagree about which month a dispatch belongs to.
    // LOOSE sales only — see packedOut below for why a packed sale is excluded.
    //
    // Loose oil goes straight out of the plant tank, so it is drawn here exactly
    // as it always was. A packed sale draws its SKU's piece count instead, the
    // oil having already left the tank when it was packed.
    sold: {
      base: `SELECT s.product_id AS pid, SUM(s.qty) AS q FROM sales s
             LEFT JOIN packagings pk ON pk.id = s.packaging_id
             WHERE s.status = 'done' AND COALESCE(s.affects_stock, 1) = 1
               AND s.company_id IN (${ph})
               AND NOT (COALESCE(s.sale_type, 'LOOSE') = 'PACKED' AND pk.product_id IS NOT NULL)`,
      date: "s.sale_date",
      group: "GROUP BY s.product_id"
    },
    // Oil drawn out of the plant tank to be packed into SKUs.
    packedOut: {
      base: `SELECT pk.product_id AS pid,
                    SUM(a.delta * (
                      CASE
                        WHEN COALESCE(pk.unit_size, 0) > 0 THEN
                          CASE UPPER(COALESCE(pk.unit_uom, 'KG'))
                            WHEN 'GM' THEN pk.unit_size / 1000.0
                            WHEN 'G' THEN pk.unit_size / 1000.0
                            WHEN 'ML' THEN pk.unit_size / 1000.0
                            WHEN 'QUINTAL' THEN pk.unit_size * 100.0
                            WHEN 'MT' THEN pk.unit_size * 1000.0
                            WHEN 'TON' THEN pk.unit_size * 1000.0
                            WHEN 'KL' THEN pk.unit_size * 1000.0
                            ELSE pk.unit_size
                          END
                        ELSE
                          CASE UPPER(COALESCE(pk.base_uom, 'KG'))
                            WHEN 'GM' THEN pk.base_per_pouch / 1000.0
                            WHEN 'G' THEN pk.base_per_pouch / 1000.0
                            WHEN 'ML' THEN pk.base_per_pouch / 1000.0
                            WHEN 'QUINTAL' THEN pk.base_per_pouch * 100.0
                            WHEN 'MT' THEN pk.base_per_pouch * 1000.0
                            WHEN 'TON' THEN pk.base_per_pouch * 1000.0
                            WHEN 'KL' THEN pk.base_per_pouch * 1000.0
                            ELSE pk.base_per_pouch
                          END
                      END
                    ) / 1000.0) AS q
             FROM sku_adjustments a
             JOIN packagings pk ON pk.id = a.packaging_id
             WHERE pk.product_id IS NOT NULL
               AND COALESCE(a.kind, CASE WHEN a.delta < 0 THEN 'correction' ELSE 'packing' END) = 'packing'
               AND a.company_id IN (${ph})`,
      date: "a.adj_date",
      group: "GROUP BY pk.product_id"
    },
    transferredIn: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE to_company_id IN (${ph})`,
      date: "transfer_date",
      group: "GROUP BY product_id"
    },
    transferredOut: {
      base: `SELECT product_id AS pid, SUM(qty) AS q FROM stock_transfers WHERE from_company_id IN (${ph})`,
      date: "transfer_date",
      group: "GROUP BY product_id"
    },
    // A return REVERSES the movement that first booked the goods, so each one
    // is netted off the column it came from rather than inflating the other
    // side: a sales return reduces Dispatch, a purchase return reduces Receipt.
    // Only real returns move goods — a credit note to a supplier or a debit
    // note to a customer is a rate/claim adjustment, money only — and a note
    // with no item lines moves nothing at all.
    returnedIn: {
      base: `SELECT ni.product_id AS pid, SUM(ni.qty) AS q
             FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
             WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
               AND ni.product_id IS NOT NULL AND nt.company_id IN (${ph})`,
      date: "nt.note_date",
      group: "GROUP BY ni.product_id"
    },
    returnedOut: {
      base: `SELECT ni.product_id AS pid, SUM(ni.qty) AS q
             FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
             WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier'
               AND ni.product_id IS NOT NULL AND nt.company_id IN (${ph})`,
      date: "nt.note_date",
      group: "GROUP BY ni.product_id"
    }
  };
  const floor = await openingFloor(cidList);
  const slice = async (src, kind) => {
    if (kind === "opening" && !from) return /* @__PURE__ */ new Map();
    let sql = src.base;
    const args = [...cidList];
    if (kind === "opening") {
      if (floor && from <= floor) return /* @__PURE__ */ new Map();
      sql += ` AND ${src.date} < ?`;
      args.push(from);
      if (floor) {
        sql += ` AND ${src.date} >= ?`;
        args.push(floor);
      }
    } else {
      const lo = floor && (!from || from < floor) ? floor : from;
      if (lo) {
        sql += ` AND ${src.date} >= ?`;
        args.push(lo);
      }
      if (to) {
        sql += ` AND ${src.date} <= ?`;
        args.push(to);
      }
    }
    const res = await c.execute({ sql: `${sql} ${src.group}`, args });
    const m = /* @__PURE__ */ new Map();
    for (const r of res.rows) m.set(Number(r.pid), Number(r.q) || 0);
    return m;
  };
  const openingBalance = async () => {
    const args = [...cidList];
    let sql = `SELECT product_id AS pid,
                      SUM(qty + COALESCE(pp_qty, 0) + COALESCE(adj_qty, 0)) AS q
               FROM stock_openings WHERE company_id IN (${ph})`;
    if (to) {
      sql += " AND as_of <= ?";
      args.push(to);
    }
    const res = await c.execute({ sql: `${sql} GROUP BY product_id`, args });
    const m = /* @__PURE__ */ new Map();
    for (const r of res.rows) m.set(Number(r.pid), Number(r.q) || 0);
    return m;
  };
  const keys = Object.keys(SOURCES);
  const [products, brought, ...maps] = await Promise.all([
    c.execute("SELECT id, code, name, category, material_type, active FROM products ORDER BY category, name"),
    openingBalance(),
    ...keys.map((k) => slice(SOURCES[k], "period")),
    ...keys.map((k) => slice(SOURCES[k], "opening"))
  ]);
  const period = Object.fromEntries(keys.map((k, i) => [k, maps[i]]));
  const opening = Object.fromEntries(keys.map((k, i) => [k, maps[keys.length + i]]));
  return products.rows.map((p) => {
    const id = Number(p.id);
    const g = (m, k) => m[k].get(id) || 0;
    const open = (brought.get(id) || 0) + g(opening, "received") + g(opening, "produced") + g(opening, "byProduct") + g(opening, "transferredIn") - g(opening, "consumed") - g(opening, "sold") - g(opening, "transferredOut") - g(opening, "packedOut") + g(opening, "returnedIn") - g(opening, "returnedOut");
    const rec = g(period, "received") - g(period, "returnedOut");
    const prod = g(period, "produced") + g(period, "byProduct");
    const cons = g(period, "consumed");
    const sld = g(period, "sold") - g(period, "returnedIn");
    const tIn = g(period, "transferredIn");
    const tOut = g(period, "transferredOut");
    const packed = g(period, "packedOut");
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      material_type: p.material_type,
      active: p.active,
      opening: open,
      // The part of the opening that was entered as stock brought forward,
      // rather than derived from movements before the range.
      opening_brought: brought.get(id) || 0,
      received: rec,
      produced: prod,
      consumed: cons,
      sold: sld,
      transferred_in: tIn,
      transferred_out: tOut,
      packed_out: packed,
      stock: open + rec + prod + tIn - cons - sld - tOut - packed
    };
  });
}
async function productValuationRates() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const cost = /* @__PURE__ */ new Map();
  const raw = await c.execute({
    sql: `SELECT oil_type_id AS pid, SUM(adjusted_rate * received_qty) AS v, SUM(received_qty) AS q
          FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ?
          GROUP BY oil_type_id`,
    args: [cid]
  });
  for (const r of raw.rows) {
    const q = Number(r.q) || 0;
    if (q > 0) cost.set(Number(r.pid), (Number(r.v) || 0) / q);
  }
  const batches = await c.execute({
    sql: "SELECT id, product_id, qty FROM production WHERE company_id = ?",
    args: [cid]
  });
  const items = await c.execute({
    sql: `SELECT i.production_id AS bid, i.product_id AS pid, i.qty AS qty
          FROM production_items i JOIN production p ON p.id = i.production_id
          WHERE i.kind = 'input' AND p.company_id = ?`,
    args: [cid]
  });
  const itemsByBatch = /* @__PURE__ */ new Map();
  for (const it of items.rows) {
    const bid = Number(it.bid);
    if (!itemsByBatch.has(bid)) itemsByBatch.set(bid, []);
    itemsByBatch.get(bid).push({ pid: Number(it.pid), qty: Number(it.qty) || 0 });
  }
  const byOutput = /* @__PURE__ */ new Map();
  for (const b of batches.rows) {
    const pid = Number(b.product_id);
    if (!byOutput.has(pid)) byOutput.set(pid, []);
    byOutput.get(pid).push({ qty: Number(b.qty) || 0, items: itemsByBatch.get(Number(b.id)) || [] });
  }
  for (let pass = 0; pass < 5; pass++) {
    for (const [outPid, bs] of byOutput) {
      let inCost = 0;
      let outQty = 0;
      for (const b of bs) {
        for (const it of b.items) inCost += it.qty * (cost.get(it.pid) || 0);
        outQty += b.qty;
      }
      if (outQty > 0) cost.set(outPid, inCost / outQty);
    }
  }
  return cost;
}
async function productStockForCompany(companyId, productId) {
  const c = getClient();
  const one = async (sql) => {
    const r = await c.execute({ sql, args: [companyId, productId] });
    return Number(r.rows[0]?.q) || 0;
  };
  const rec = await one("SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND oil_type_id = ?");
  const prod = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?");
  const byProd = await one("SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'output' AND p.company_id = ? AND i.product_id = ?");
  const cons = await one("SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'input' AND p.company_id = ? AND i.product_id = ?");
  const sld = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND product_id = ?");
  const tIn = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?");
  const tOut = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?");
  const retIn = await one(`SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
                           WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND nt.company_id = ? AND ni.product_id = ?`);
  const retOut = await one(`SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
                            WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier' AND nt.company_id = ? AND ni.product_id = ?`);
  return rec + prod + byProd + tIn - cons - sld - tOut + retIn - retOut;
}
async function openingFloor(cidList) {
  if (!cidList.length) return "";
  const ph = cidList.map(() => "?").join(", ");
  const res = await getClient().execute({
    sql: `SELECT COUNT(DISTINCT company_id) AS cos, MIN(as_of) AS first
          FROM stock_openings WHERE company_id IN (${ph})`,
    args: [...cidList]
  });
  const r = res.rows[0];
  if (!r || Number(r.cos) !== cidList.length || !r.first) return "";
  return String(r.first).slice(0, 10);
}
async function stockPartyBreakdown(companyIds, range) {
  const c = getClient();
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0);
  if (!cidList.length) cidList.push(getActiveCompanyId());
  const ph = cidList.map(() => "?").join(", ");
  const multi = cidList.length > 1;
  const asked = String(range?.from || "");
  const to = String(range?.to || "");
  const floor = await openingFloor(cidList);
  const from = floor && (!asked || asked < floor) ? floor : asked;
  const bounds = (dateExpr) => {
    const parts = [];
    const args = [];
    if (from) {
      parts.push(`AND ${dateExpr} >= ?`);
      args.push(from);
    }
    if (to) {
      parts.push(`AND ${dateExpr} <= ?`);
      args.push(to);
    }
    return { sql: parts.join(" "), args };
  };
  const recDateExpr = `CASE WHEN COALESCE(o.is_consignment, 0) = 1
                             THEN o.order_date
                             ELSE COALESCE(o.received_date, o.order_date) END`;
  const recB = bounds(recDateExpr);
  const dispB = bounds("s.sale_date");
  const out = {};
  const ensure = (pid) => out[pid] ??= { receipt: [], dispatch: [], packed: [] };
  const rec = await c.execute({
    sql: `SELECT o.oil_type_id AS pid, COALESCE(s.name, 'Unknown') AS party, co.name AS company, SUM(o.received_qty) AS qty
          FROM orders o
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1 AND o.company_id IN (${ph}) ${recB.sql}
          GROUP BY o.oil_type_id, s.name, o.company_id
          HAVING SUM(o.received_qty) > 0
          ORDER BY qty DESC`,
    args: [...cidList, ...recB.args]
  });
  for (const r of rec.rows)
    ensure(Number(r.pid)).receipt.push({
      party: multi ? `${r.party} \xB7 ${r.company || ""}` : String(r.party),
      qty: Number(r.qty) || 0
    });
  const disp = await c.execute({
    sql: `SELECT s.product_id AS pid, COALESCE(cu.name, s.customer, 'Unknown') AS party, co.name AS company, SUM(s.qty) AS qty
          FROM sales s
          LEFT JOIN customers cu ON cu.id = s.customer_id
          LEFT JOIN companies co ON co.id = s.company_id
          LEFT JOIN packagings pk ON pk.id = s.packaging_id
          WHERE s.status = 'done' AND COALESCE(s.affects_stock, 1) = 1 AND s.company_id IN (${ph})
            AND NOT (COALESCE(s.sale_type, 'LOOSE') = 'PACKED' AND pk.product_id IS NOT NULL)
            ${dispB.sql}
          GROUP BY s.product_id, COALESCE(cu.name, s.customer), s.company_id
          HAVING SUM(s.qty) > 0
          ORDER BY qty DESC`,
    args: [...cidList, ...dispB.args]
  });
  for (const r of disp.rows)
    ensure(Number(r.pid)).dispatch.push({
      party: multi ? `${r.party} \xB7 ${r.company || ""}` : String(r.party),
      qty: Number(r.qty) || 0
    });
  const noteB = bounds("nt.note_date");
  const noteSide = async (noteType, partyType, master) => {
    const res = await c.execute({
      sql: `SELECT ni.product_id AS pid, COALESCE(m.name, 'Unknown') AS party, co.name AS company,
                   nt.note_no AS note_no, SUM(ni.qty) AS qty
            FROM note_items ni
            JOIN notes nt ON nt.id = ni.note_id
            LEFT JOIN ${master} m ON m.id = nt.party_id
            LEFT JOIN companies co ON co.id = nt.company_id
            WHERE nt.note_type = ? AND nt.party_type = ? AND ni.product_id IS NOT NULL
              AND nt.company_id IN (${ph}) ${noteB.sql}
            GROUP BY ni.product_id, m.name, nt.company_id, nt.note_no
            HAVING SUM(ni.qty) > 0
            ORDER BY qty DESC`,
      args: [noteType, partyType, ...cidList, ...noteB.args]
    });
    return res.rows;
  };
  for (const r of await noteSide("credit", "customer", "customers"))
    ensure(Number(r.pid)).dispatch.push({
      party: `${multi ? `${r.party} \xB7 ${r.company || ""}` : String(r.party)} \u2014 return ${r.note_no}`,
      qty: -(Number(r.qty) || 0),
      isReturn: true
    });
  for (const r of await noteSide("debit", "supplier", "suppliers"))
    ensure(Number(r.pid)).receipt.push({
      party: `${multi ? `${r.party} \xB7 ${r.company || ""}` : String(r.party)} \u2014 return ${r.note_no}`,
      qty: -(Number(r.qty) || 0),
      isReturn: true
    });
  const packB = bounds("a.adj_date");
  const packMT = `
    CASE
      WHEN COALESCE(pk.unit_size, 0) > 0 THEN
        CASE UPPER(COALESCE(pk.unit_uom, 'KG'))
          WHEN 'GM' THEN pk.unit_size / 1000.0
          WHEN 'G' THEN pk.unit_size / 1000.0
          WHEN 'ML' THEN pk.unit_size / 1000.0
          WHEN 'QUINTAL' THEN pk.unit_size * 100.0
          WHEN 'MT' THEN pk.unit_size * 1000.0
          WHEN 'TON' THEN pk.unit_size * 1000.0
          WHEN 'KL' THEN pk.unit_size * 1000.0
          ELSE pk.unit_size
        END
      ELSE
        CASE UPPER(COALESCE(pk.base_uom, 'KG'))
          WHEN 'GM' THEN pk.base_per_pouch / 1000.0
          WHEN 'G' THEN pk.base_per_pouch / 1000.0
          WHEN 'ML' THEN pk.base_per_pouch / 1000.0
          WHEN 'QUINTAL' THEN pk.base_per_pouch * 100.0
          WHEN 'MT' THEN pk.base_per_pouch * 1000.0
          WHEN 'TON' THEN pk.base_per_pouch * 1000.0
          WHEN 'KL' THEN pk.base_per_pouch * 1000.0
          ELSE pk.base_per_pouch
        END
    END / 1000.0`;
  const packed = await c.execute({
    sql: `SELECT pk.product_id AS pid, pk.name AS sku, co.name AS company,
                 SUM(a.delta) AS pieces, SUM(a.delta * (${packMT})) AS qty
          FROM sku_adjustments a
          JOIN packagings pk ON pk.id = a.packaging_id
          LEFT JOIN companies co ON co.id = a.company_id
          WHERE pk.product_id IS NOT NULL
            AND COALESCE(a.kind, CASE WHEN a.delta < 0 THEN 'correction' ELSE 'packing' END) = 'packing'
            AND a.company_id IN (${ph}) ${packB.sql}
          GROUP BY pk.product_id, pk.id, a.company_id
          HAVING SUM(a.delta) <> 0
          ORDER BY qty DESC`,
    args: [...cidList, ...packB.args]
  });
  for (const r of packed.rows)
    ensure(Number(r.pid)).packed.push({
      party: multi ? `${r.sku} \xB7 ${r.company || ""}` : String(r.sku),
      pieces: Number(r.pieces) || 0,
      qty: Number(r.qty) || 0
    });
  return out;
}
async function productStockAvailable(productId, opts = {}) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const one = async (sql, args) => {
    const r = await c.execute({ sql, args });
    return Number(r.rows[0]?.q) || 0;
  };
  const exP = opts.excludeProductionId;
  const exS = opts.excludeSaleId;
  const rec = await one(
    "SELECT COALESCE(SUM(received_qty), 0) AS q FROM orders WHERE status = 'received' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND oil_type_id = ?",
    [cid, productId]
  );
  const prod = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM production WHERE company_id = ? AND product_id = ?${exP ? " AND id <> ?" : ""}`,
    exP ? [cid, productId, exP] : [cid, productId]
  );
  const byProd = await one(
    `SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'output' AND p.company_id = ? AND i.product_id = ?${exP ? " AND p.id <> ?" : ""}`,
    exP ? [cid, productId, exP] : [cid, productId]
  );
  const cons = await one(
    `SELECT COALESCE(SUM(i.qty), 0) AS q FROM production_items i JOIN production p ON p.id = i.production_id WHERE i.kind = 'input' AND p.company_id = ? AND i.product_id = ?${exP ? " AND p.id <> ?" : ""}`,
    exP ? [cid, productId, exP] : [cid, productId]
  );
  const sld = await one(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE status = 'done' AND COALESCE(affects_stock, 1) = 1 AND company_id = ? AND product_id = ?${exS ? " AND id <> ?" : ""}`,
    exS ? [cid, productId, exS] : [cid, productId]
  );
  const tIn = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE to_company_id = ? AND product_id = ?", [cid, productId]);
  const tOut = await one("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_transfers WHERE from_company_id = ? AND product_id = ?", [cid, productId]);
  const retIn = await one(
    `SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND nt.company_id = ? AND ni.product_id = ?`,
    [cid, productId]
  );
  const retOut = await one(
    `SELECT COALESCE(SUM(ni.qty), 0) AS q FROM note_items ni JOIN notes nt ON nt.id = ni.note_id
     WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier' AND nt.company_id = ? AND ni.product_id = ?`,
    [cid, productId]
  );
  return rec + prod + byProd + tIn - cons - sld - tOut + retIn - retOut;
}
async function listStockTransfers() {
  const cid = getActiveCompanyId();
  const res = await getClient().execute({
    sql: `SELECT t.*, p.code AS product_code, p.name AS product_name,
                 fc.name AS from_company_name, tc.name AS to_company_name
          FROM stock_transfers t
          LEFT JOIN products p ON p.id = t.product_id
          LEFT JOIN companies fc ON fc.id = t.from_company_id
          LEFT JOIN companies tc ON tc.id = t.to_company_id
          WHERE t.from_company_id = ? OR t.to_company_id = ?
          ORDER BY t.id DESC`,
    args: [cid, cid]
  });
  return res.rows.map((r) => {
    const o = {};
    for (const k of res.columns) o[k] = r[k];
    o.direction = Number(o.from_company_id) === cid ? "out" : "in";
    return o;
  });
}
async function createStockTransfer(v) {
  const from = getActiveCompanyId();
  const to = Number(v.to_company_id) || 0;
  const productId = Number(v.product_id) || 0;
  const qty = Number(v.qty) || 0;
  if (!to || to === from) throw new Error("Choose a different destination company");
  if (!productId) throw new Error("Select a product");
  if (qty <= 0) throw new Error("Quantity must be greater than zero");
  const avail = await productStockForCompany(from, productId);
  if (qty > avail + 1e-6) throw new Error(`Only ${avail.toFixed(3)} in stock to transfer`);
  const res = await getClient().execute({
    sql: `INSERT INTO stock_transfers (from_company_id, to_company_id, product_id, qty, uom, transfer_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [from, to, productId, qty, v.uom || "MT", v.transfer_date, v.note ? String(v.note).trim() : null]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function deleteStockTransfer(id) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT * FROM stock_transfers WHERE id = ?", args: [id] });
  if (!cur.rows.length) return { id };
  const t = cur.rows[0];
  const destStock = await productStockForCompany(Number(t.to_company_id), Number(t.product_id));
  if (destStock - Number(t.qty) < -1e-6) {
    throw new Error("Cannot reverse \u2014 the destination company has already used this stock");
  }
  await c.execute({ sql: "DELETE FROM stock_transfers WHERE id = ?", args: [id] });
  return { id };
}
async function stockMap() {
  const levels = await stockLevels();
  const out = {};
  for (const l of levels) out[l.id] = l.stock;
  return out;
}
async function productionNeeds() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const levels = await stockLevels();
  const stockOf = {};
  for (const l of levels) stockOf[l.id] = l.stock;
  const num2 = async (sql, key3) => {
    const r = await c.execute({ sql, args: [cid] });
    const m = /* @__PURE__ */ new Map();
    for (const row of r.rows) m.set(Number(row[key3]), Number(row.q) || 0);
    return m;
  };
  const pending = await num2(
    "SELECT product_id AS pid, SUM(qty) AS q FROM sales WHERE status != 'done' AND COALESCE(affects_stock, 1) = 1 AND rejected_at IS NULL AND company_id = ? GROUP BY product_id",
    "pid"
  );
  const bargains = await c.execute({
    sql: "SELECT id, product_id, qty FROM sales_bargains WHERE company_id = ?",
    args: [cid]
  });
  const soldByB = await num2(
    "SELECT sales_bargain_id AS bid, SUM(qty) AS q FROM sales WHERE sales_bargain_id IS NOT NULL AND company_id = ? GROUP BY sales_bargain_id",
    "bid"
  );
  const contractRemaining = /* @__PURE__ */ new Map();
  for (const b of bargains.rows) {
    const pid = Number(b.product_id);
    const rem = Math.max(0, (Number(b.qty) || 0) - (soldByB.get(Number(b.id)) || 0));
    contractRemaining.set(pid, (contractRemaining.get(pid) || 0) + rem);
  }
  const forms = await c.execute("SELECT id, product_id FROM formulations");
  const formByProduct = /* @__PURE__ */ new Map();
  for (const f of forms.rows) formByProduct.set(Number(f.product_id), Number(f.id));
  const itemsRes = await c.execute("SELECT formulation_id, product_id, qty FROM formulation_items");
  const itemsByForm = /* @__PURE__ */ new Map();
  for (const it of itemsRes.rows) {
    const fid = Number(it.formulation_id);
    const arr = itemsByForm.get(fid) || [];
    arr.push({ product_id: Number(it.product_id), qty: Number(it.qty) || 0 });
    itemsByForm.set(fid, arr);
  }
  const out = [];
  for (const l of levels) {
    if (l.category !== "finished") continue;
    const id = l.id;
    const demand = (pending.get(id) || 0) + (contractRemaining.get(id) || 0);
    const shortfall = demand - l.stock;
    if (shortfall <= 1e-9) continue;
    let rawShort = false;
    const fid = formByProduct.get(id);
    if (fid) {
      for (const it of itemsByForm.get(fid) || []) {
        const need = shortfall * it.qty / 100;
        if ((stockOf[it.product_id] || 0) < need - 1e-9) rawShort = true;
      }
    }
    out.push({
      id,
      name: l.name,
      stock: l.stock,
      demand,
      shortfall,
      raw_short: rawShort
    });
  }
  return out;
}
function toPlain7(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
async function stockRegisters(companyIds, range) {
  const c = getClient();
  const cidList = (companyIds || []).map(Number).filter((x) => x > 0);
  if (!cidList.length) cidList.push(getActiveCompanyId());
  const ph = cidList.map(() => "?").join(", ");
  const from = String(range?.from || "");
  const to = String(range?.to || "");
  const bounds = (dateExpr) => {
    const parts = [];
    const args = [];
    if (from) {
      parts.push(`AND ${dateExpr} >= ?`);
      args.push(from);
    }
    if (to) {
      parts.push(`AND ${dateExpr} <= ?`);
      args.push(to);
    }
    return { sql: parts.join(" "), args };
  };
  const recDateExpr = `CASE WHEN COALESCE(o.is_consignment, 0) = 1
                             THEN o.order_date
                             ELSE COALESCE(o.received_date, o.order_date) END`;
  const recB = bounds(recDateExpr);
  const recTankers = await c.execute({
    sql: `SELECT ${recDateExpr} AS received_date,
                 pt.loaded_date AS loaded_date,
                 COALESCE(sp.name, s2.name, 'Unknown') AS party,
                 tr.name AS transporter,
                 o.invoice_no AS bill_no,
                 pt.tanker_no AS vehicle_no,
                 p.name AS oil_type,
                 pt.loaded_qty AS dispatch_qty,
                 CASE WHEN pt.status = 'empty' THEN pt.received_qty ELSE NULL END AS received_qty,
                 pt.condition AS tanker_condition,
                 b.bargain_type AS bargain_type,
                 o.allowed_shortage_pct AS order_pct,
                 b.allowed_shortage_pct AS bargain_pct,
                 co.name AS company
          FROM purchase_tankers pt
          JOIN orders o ON o.id = pt.order_id
          LEFT JOIN bargains b ON b.id = pt.bargain_id
          LEFT JOIN suppliers sp ON sp.id = pt.supplier_id
          LEFT JOIN suppliers s2 ON s2.id = o.supplier_id
          LEFT JOIN transporters tr ON tr.id = COALESCE(pt.transporter_id, o.transporter_id)
          LEFT JOIN products p ON p.id = COALESCE(pt.oil_type_id, o.oil_type_id)
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1
            AND o.company_id IN (${ph}) ${recB.sql}`,
    args: [...cidList, ...recB.args]
  });
  const recDirect = await c.execute({
    sql: `SELECT ${recDateExpr} AS received_date,
                 o.loaded_date AS loaded_date,
                 COALESCE(s.name, 'Unknown') AS party,
                 tr.name AS transporter,
                 o.invoice_no AS bill_no,
                 o.tanker_no AS vehicle_no,
                 p.name AS oil_type,
                 o.ordered_qty AS dispatch_qty,
                 o.received_qty AS received_qty,
                 NULL AS tanker_condition,
                 COALESCE(b.bargain_type, o.bargain_type) AS bargain_type,
                 o.allowed_shortage_pct AS order_pct,
                 b.allowed_shortage_pct AS bargain_pct,
                 co.name AS company
          FROM orders o
          LEFT JOIN bargains b ON b.id = o.bargain_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN transporters tr ON tr.id = o.transporter_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          LEFT JOIN companies co ON co.id = o.company_id
          WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1
            AND o.company_id IN (${ph}) ${recB.sql}
            AND NOT EXISTS (SELECT 1 FROM purchase_tankers pt WHERE pt.order_id = o.id)`,
    args: [...cidList, ...recB.args]
  });
  const dispB = bounds("s.sale_date");
  const disp = await c.execute({
    sql: `SELECT s.loaded_date AS loaded_date,
                 COALESCE(s.unloaded_date, s.sale_date) AS received_date,
                 COALESCE(cu.name, s.customer, 'Unknown') AS party,
                 tr.name AS transporter,
                 s.invoice_no AS bill_no,
                 -- The vehicle that carried it out. Gate Out links to a sale by
                 -- INVOICE GROUP, not sale_id \u2014 joining on gate_entries.sale_id
                 -- matched nothing at all (it is null on every gate row), which
                 -- is why this column came out empty in the register.
                 (SELECT ge.tanker_no FROM gate_entries ge
                   WHERE ge.direction = 'out' AND (ge.invoice_group = s.invoice_group
                    OR EXISTS (SELECT 1 FROM gate_entry_sales gs
                               WHERE gs.gate_entry_id = ge.id AND gs.invoice_group = s.invoice_group))
                     AND s.invoice_group IS NOT NULL
                   ORDER BY ge.id DESC LIMIT 1) AS vehicle_no,
                 p.name AS oil_type,
                 s.qty AS dispatch_qty,
                 -- What the transporter delivered, captured when the invoice was
                 -- marked Unloaded; the gate register is the fallback for a
                 -- vehicle weighed at the yard instead.
                 COALESCE(
                   s.received_qty,
                   (SELECT ge.received_qty FROM gate_entries ge
                     WHERE ge.direction = 'out' AND (ge.invoice_group = s.invoice_group
                    OR EXISTS (SELECT 1 FROM gate_entry_sales gs
                               WHERE gs.gate_entry_id = ge.id AND gs.invoice_group = s.invoice_group))
                       AND s.invoice_group IS NOT NULL AND ge.received_qty > 0
                     ORDER BY ge.id DESC LIMIT 1)
                 ) AS received_qty,
                 co.name AS company
          FROM sales s
          LEFT JOIN customers cu ON cu.id = s.customer_id
          LEFT JOIN transporters tr ON tr.id = s.transporter_id
          LEFT JOIN products p ON p.id = s.product_id
          LEFT JOIN companies co ON co.id = s.company_id
          WHERE s.status = 'done' AND COALESCE(s.affects_stock, 1) = 1
            AND s.company_id IN (${ph}) ${dispB.sql}`,
    args: [...cidList, ...dispB.args]
  });
  const defaultPct = Number(await getSetting("allowed_shortage_pct") ?? 0) || 0;
  const isEx = (tankerCondition, bargainType) => {
    const own = String(tankerCondition ?? "").trim().toUpperCase();
    if (own) return own !== "DLD" && own !== "DELIVERED";
    return !["DLD", "DELIVERED"].includes(String(bargainType ?? "").trim().toUpperCase());
  };
  const withDeductible = (r) => {
    const loaded = Number(r.dispatch_qty) || 0;
    const rec = r.received_qty == null ? null : Number(r.received_qty);
    if (rec == null || loaded <= 0 || !isEx(r.tanker_condition, r.bargain_type)) return { ...r, deductible: null };
    const pct = Number(r.order_pct ?? r.bargain_pct ?? defaultPct) || 0;
    const allowed = loaded * pct / 100;
    const shortage = Math.max(0, loaded - rec);
    return { ...r, deductible: shortage > allowed ? Math.round((shortage - allowed) * 1e3) / 1e3 : null };
  };
  const noteB = bounds("nt.note_date");
  const noteLines = async (noteType, partyType, master) => {
    const res = await c.execute({
      sql: `SELECT nt.note_date AS received_date, NULL AS loaded_date,
                   COALESCE(m.name, 'Unknown') AS party, NULL AS transporter,
                   nt.note_no AS bill_no, NULL AS vehicle_no,
                   p.name AS oil_type,
                   -ni.qty AS dispatch_qty, NULL AS received_qty,
                   co.name AS company, nt.against_ref AS against_ref,
                   1 AS is_return
            FROM note_items ni
            JOIN notes nt ON nt.id = ni.note_id
            LEFT JOIN ${master} m ON m.id = nt.party_id
            LEFT JOIN products p ON p.id = ni.product_id
            LEFT JOIN companies co ON co.id = nt.company_id
            WHERE nt.note_type = ? AND nt.party_type = ? AND ni.product_id IS NOT NULL
              AND ni.qty > 0 AND nt.company_id IN (${ph}) ${noteB.sql}`,
      args: [noteType, partyType, ...cidList, ...noteB.args]
    });
    return toPlain7(res);
  };
  const bySeq = (a, b) => String(b.received_date || b.loaded_date || "").localeCompare(String(a.received_date || a.loaded_date || ""));
  const receipts = [
    ...toPlain7(recTankers).map(withDeductible),
    ...toPlain7(recDirect).map(withDeductible),
    // A purchase return carries no deductible — nothing was short-delivered.
    ...(await noteLines("debit", "supplier", "suppliers")).map((r) => ({ ...r, deductible: null }))
  ].sort(bySeq);
  const dispatches = [...toPlain7(disp), ...await noteLines("credit", "customer", "customers")].sort(bySeq);
  return { receipts, dispatches };
}

// src/renderer/src/lib/recipeMath.ts
var num = (v) => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};
var kindOf = (it) => String(it.kind || "input");
var sumOf = (items, kind) => items.filter((it) => kindOf(it) === kind).reduce((s, it) => s + num(it.qty), 0);
function uniformRecipeTor(items) {
  const lossPct = sumOf(items, "output") + sumOf(items, "loss");
  if (lossPct <= 0 || lossPct >= 100) return 100;
  return 100 * 100 / (100 - lossPct);
}
function inputFattyAcidPct(it) {
  return num(it.ffa_pct) * (1 + num(it.loss_multiplier_pct) / 100);
}
function inputTorMultiplier(it, sharedDeadLossPct) {
  const yieldPct = 100 - inputFattyAcidPct(it) - sharedDeadLossPct;
  if (yieldPct <= 0) return 1;
  return 100 / yieldPct;
}
function recipeTor(items) {
  const inputs = items.filter((it) => kindOf(it) === "input");
  const blend = inputs.reduce((s, it) => s + num(it.qty), 0);
  const uniformTor = uniformRecipeTor(items);
  if (blend <= 0) return uniformTor;
  const deadLoss = sumOf(items, "loss");
  return inputs.reduce((s, it) => {
    const mult = it.auto_calc ? inputTorMultiplier(it, deadLoss) : uniformTor / 100;
    return s + num(it.qty) * mult;
  }, 0);
}
function expandRecipe(items, outputQty) {
  const blend = sumOf(items, "input");
  const uniformTor = uniformRecipeTor(items);
  const tor = recipeTor(items);
  const deadLoss = sumOf(items, "loss");
  const lines = items.map((it) => {
    const kind = kindOf(it);
    let pct;
    if (kind === "input") {
      const mult = it.auto_calc ? inputTorMultiplier(it, deadLoss) : uniformTor / 100;
      pct = blend > 0 ? num(it.qty) * mult : 0;
    } else {
      pct = tor * num(it.qty) / 100;
    }
    return { product_id: Number(it.product_id), qty: outputQty * pct / 100, kind };
  });
  const byproductAdds = /* @__PURE__ */ new Map();
  for (const it of items) {
    if (kindOf(it) !== "input" || !it.auto_calc || !num(it.byproduct_product_id)) continue;
    const mult = inputTorMultiplier(it, deadLoss);
    const pct = blend > 0 ? num(it.qty) * mult : 0;
    const inputQty = outputQty * pct / 100;
    const pid = num(it.byproduct_product_id);
    byproductAdds.set(pid, (byproductAdds.get(pid) || 0) + inputQty * inputFattyAcidPct(it) / 100);
  }
  for (const [pid, qty] of byproductAdds) {
    const existing = lines.find((l) => l.kind === "output" && l.product_id === pid);
    if (existing) existing.qty += qty;
    else lines.push({ product_id: pid, qty, kind: "output" });
  }
  return lines;
}

// src/main/production.ts
function toPlain8(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n6(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
async function listProduction(forModule) {
  const from = await visibleFromFor("production", forModule);
  const res = await getClient().execute({
    args: from ? [getActiveCompanyId(), from] : [getActiveCompanyId()],
    sql: `
    SELECT p.*, pr.name AS product_name, pr.category AS product_category, f.name AS formulation_name,
           sc.name AS subcategory_name, f.subcategory_id
    FROM production p
    LEFT JOIN products pr ON pr.id = p.product_id
    LEFT JOIN formulations f ON f.id = p.formulation_id
    LEFT JOIN formulation_subcategories sc ON sc.id = f.subcategory_id
    WHERE p.company_id = ?${from ? " AND p.prod_date >= ?" : ""}
    ORDER BY p.prod_date DESC, p.id DESC
  `
  });
  return toPlain8(res);
}
async function getProductionItems(productionId) {
  const res = await getClient().execute({
    sql: `SELECT i.*, pr.name AS product_name, pr.category AS product_category
          FROM production_items i
          LEFT JOIN products pr ON pr.id = i.product_id
          WHERE i.production_id = ?
          ORDER BY i.id`,
    args: [productionId]
  });
  return toPlain8(res);
}
async function createProduction(v) {
  const c = getClient();
  const productId = n6(v.product_id);
  const qty = n6(v.qty);
  if (!productId) throw new Error("Select a product to produce");
  if (qty <= 0) throw new Error("Production quantity must be greater than zero");
  const prodDay = String(v.prod_date || "").slice(0, 10);
  if (prodDay && prodDay > (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)) {
    throw new Error("Production cannot be dated in the future");
  }
  let fid = n6(v.formulation_id);
  if (fid) {
    const owner = await c.execute({ sql: "SELECT product_id FROM formulations WHERE id = ?", args: [fid] });
    if (!owner.rows.length || Number(owner.rows[0].product_id) !== productId) {
      throw new Error("That recipe doesn't belong to the selected product");
    }
  } else {
    const fRes = await c.execute({
      sql: "SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      args: [productId]
    });
    fid = fRes.rows.length ? Number(fRes.rows[0].id) : 0;
  }
  const lines = [];
  if (fid) {
    const items = await c.execute({
      sql: "SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?",
      args: [fid]
    });
    lines.push(...expandRecipe(toPlain8(items), qty));
  }
  const consumption = lines.filter((l) => l.kind === "input");
  if (consumption.length) {
    const [levels, names] = await Promise.all([
      stockMap(),
      c.execute("SELECT id, name FROM products")
    ]);
    const nameOf = /* @__PURE__ */ new Map();
    for (const r of names.rows) nameOf.set(Number(r.id), String(r.name || ""));
    const short = consumption.map((cn) => ({ ...cn, avail: levels[cn.product_id] || 0 })).filter((cn) => cn.qty > cn.avail + 1e-6);
    if (short.length) {
      const detail = short.map((s) => `${nameOf.get(s.product_id) || "component"} (need ${s.qty.toFixed(3)}, have ${Math.max(s.avail, 0).toFixed(3)})`).join("; ");
      console.warn(`[production] batch recorded with short inputs: ${detail}`);
    }
  }
  const ins = await c.execute({
    sql: "INSERT INTO production (company_id, prod_date, product_id, qty, uom, note, formulation_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [getActiveCompanyId(), v.prod_date, productId, qty, v.uom || "MT", v.note || null, fid || null]
  });
  const id = Number(ins.lastInsertRowid);
  for (const l of lines) {
    await c.execute({
      sql: "INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)",
      args: [id, l.product_id, l.qty, l.kind]
    });
  }
  return { id };
}
async function updateProduction(id, v) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT id FROM production WHERE id = ?", args: [n6(id)] });
  if (!cur.rows.length) throw new Error("Production run not found");
  const productId = n6(v.product_id);
  const qty = n6(v.qty);
  if (!productId) throw new Error("Select a product to produce");
  if (qty <= 0) throw new Error("Production quantity must be greater than zero");
  const prodDay = String(v.prod_date || "").slice(0, 10);
  if (prodDay && prodDay > (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)) {
    throw new Error("Production cannot be dated in the future");
  }
  let fid = n6(v.formulation_id);
  if (fid) {
    const owner = await c.execute({ sql: "SELECT product_id FROM formulations WHERE id = ?", args: [fid] });
    if (!owner.rows.length || Number(owner.rows[0].product_id) !== productId) {
      throw new Error("That recipe doesn't belong to the selected product");
    }
  } else {
    const fRes = await c.execute({
      sql: "SELECT id FROM formulations WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      args: [productId]
    });
    fid = fRes.rows.length ? Number(fRes.rows[0].id) : 0;
  }
  const lines = [];
  if (fid) {
    const items = await c.execute({
      sql: "SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id FROM formulation_items WHERE formulation_id = ?",
      args: [fid]
    });
    lines.push(...expandRecipe(toPlain8(items), qty));
  }
  await c.execute({
    sql: `UPDATE production SET prod_date = ?, product_id = ?, qty = ?, uom = ?, note = ?, formulation_id = ?
           WHERE id = ?`,
    args: [v.prod_date, productId, qty, v.uom || "MT", v.note || null, fid || null, n6(id)]
  });
  await c.execute({ sql: "DELETE FROM production_items WHERE production_id = ?", args: [n6(id)] });
  for (const l of lines) {
    await c.execute({
      sql: "INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)",
      args: [n6(id), l.product_id, l.qty, l.kind]
    });
  }
  const left = await productStockAvailable(productId);
  if (left < -1e-6) {
    const nameRow = await c.execute({ sql: "SELECT name FROM products WHERE id = ?", args: [productId] });
    console.warn(
      `[production] run ${id} altered \u2014 ${String(nameRow.rows[0]?.name || "product")} is now short by ${(Math.round(-left * 1e3) / 1e3).toFixed(3)}.`
    );
  }
  return { id: n6(id) };
}
async function deleteSaleProductions(saleId) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM production_items WHERE production_id IN (SELECT id FROM production WHERE sale_id = ?)",
    args: [saleId]
  });
  await c.execute({ sql: "DELETE FROM production WHERE sale_id = ?", args: [saleId] });
}
async function deleteProduction(id) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT product_id FROM production WHERE id = ?", args: [id] });
  if (!cur.rows.length) return { id };
  const productId = Number(cur.rows[0].product_id);
  const without = await productStockAvailable(productId, { excludeProductionId: id });
  if (without < -1e-6) {
    const nameRow = await c.execute({ sql: "SELECT name FROM products WHERE id = ?", args: [productId] });
    const label = String(nameRow.rows[0]?.name || "product");
    console.warn(
      `[production] run ${id} deleted \u2014 ${label} is now short by ${(Math.round(-without * 1e3) / 1e3).toFixed(3)}. Enter the missing production or the opening stock to clear it.`
    );
  }
  await c.execute({ sql: "DELETE FROM production_items WHERE production_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM production WHERE id = ?", args: [id] });
  return { id };
}

// src/main/sales.ts
async function assertFinishedStock(productId, qty, productName, excludeSaleId) {
  const avail = await productStockAvailable(productId, { excludeSaleId });
  if (qty > avail + 1e-6) {
    throw new Error(
      `Not enough ${productName || "finished"} stock to dispatch: need ${qty.toFixed(3)}, only ${Math.max(avail, 0).toFixed(3)} available. Produce more first, or keep the sale as pending.`
    );
  }
}
async function productLabel(productId) {
  const r = await getClient().execute({ sql: "SELECT name FROM products WHERE id = ?", args: [productId] });
  return r.rows.length ? String(r.rows[0].name || "") : "";
}
function stageOf(v) {
  const s = String(v.dispatch_stage || "").toLowerCase();
  if (s === "loaded" || s === "transit" || s === "unloaded" || s === "pending") return s;
  return String(v.status) === "done" ? "unloaded" : "pending";
}
var isDispatched = (stage) => stage !== "pending";
var statusForStage = (stage) => isDispatched(stage) ? "done" : "pending";
var STAGE_ORDER = ["pending", "loaded", "transit", "unloaded"];
function resolveStageDates(stage, src, today) {
  const t = STAGE_ORDER.indexOf(stage);
  const val = (x) => x ? String(x) : null;
  let loaded = t >= 1 ? val(src.loaded_date) : null;
  let transit = t >= 2 ? val(src.transit_date) : null;
  let unloaded = t >= 3 ? val(src.unloaded_date) : null;
  if (t >= 1 && !loaded) loaded = today;
  if (t >= 2 && !transit) transit = today;
  if (t >= 3 && !unloaded) unloaded = today;
  return { loaded_date: loaded, transit_date: transit, unloaded_date: unloaded };
}
function todayLocal() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toPlain9(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n7(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round23 = (v) => Math.round(v * 100) / 100;
function tierTds2(taxable, prior, threshold, basePct, abovePct) {
  if (!threshold || threshold <= 0) return taxable * basePct / 100;
  const below = Math.max(0, Math.min(threshold - prior, taxable));
  const above = taxable - below;
  return below * basePct / 100 + above * abovePct / 100;
}
function fyRange2(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1;
  return { start: `${startY}-04-01`, end: `${startY + 1}-03-31` };
}
async function relatedCustomerIds(customerId) {
  const c = getClient();
  const row = await c.execute({ sql: "SELECT linked_party_id FROM customers WHERE id = ?", args: [customerId] });
  const root = Number(row.rows[0]?.linked_party_id) || customerId;
  const linked = await c.execute({ sql: "SELECT id FROM customers WHERE linked_party_id = ?", args: [root] });
  return Array.from(/* @__PURE__ */ new Set([root, customerId, ...linked.rows.map((r) => Number(r.id))]));
}
async function customerFyTaxable(customerId, dateStr, excludeId) {
  const { start } = fyRange2(dateStr);
  const ids = await relatedCustomerIds(customerId);
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS t FROM sales
          WHERE customer_id IN (${ids.map(() => "?").join(",")}) AND sale_date BETWEEN ? AND ? AND id != ? AND company_id = ?`,
    args: [...ids, start, String(dateStr).slice(0, 10), excludeId || 0, getActiveCompanyId()]
  });
  return Number(res.rows[0].t) || 0;
}
async function resolveTdsPct(v, customerId) {
  const stated = v.tds_pct;
  if (stated !== void 0 && stated !== null && String(stated).trim() !== "") return n7(stated);
  if (!customerId) return 0;
  const cu = await getClient().execute({
    sql: "SELECT tds_pct FROM customers WHERE id = ?",
    args: [customerId]
  });
  return cu.rows.length ? n7(cu.rows[0].tds_pct) : 0;
}
async function saleTds(customerId, tdsPct, taxable, dateStr, excludeId) {
  if (!customerId || tdsPct <= 0 || taxable <= 0) return 0;
  const cu = await getClient().execute({
    sql: "SELECT tds_threshold, tds_above_only FROM customers WHERE id = ?",
    args: [customerId]
  });
  const master = cu.rows[0];
  const threshold = Number(master?.tds_threshold) || 0;
  const basePct = master?.tds_above_only ? 0 : tdsPct;
  const prior = threshold > 0 ? await customerFyTaxable(customerId, dateStr, excludeId) : 0;
  return Math.round(tierTds2(taxable, prior, threshold, basePct, tdsPct) * 100) / 100;
}
async function postCustomerReceivable(saleId, customerId, amount, date) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'sale'",
    args: [saleId]
  });
  if (customerId && amount > 0) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'sale', ?, 'Sale invoice', (SELECT company_id FROM sales WHERE id = ?))`,
      args: [customerId, saleId, date, -Math.abs(amount), saleId]
    });
  }
}
async function postSaleInvoiceJournal(saleId, reuseEntryId) {
  const c = getClient();
  const seed = await c.execute({
    sql: "SELECT id, invoice_group, company_id FROM sales WHERE id = ?",
    args: [n7(saleId)]
  });
  if (!seed.rows.length) return;
  const seedRow = seed.rows[0];
  const group = seedRow.invoice_group ? String(seedRow.invoice_group) : null;
  const rowsRes = group ? await c.execute({
    sql: `SELECT s.*, p.code AS product_code, p.name AS product_name, cu.name AS customer_master
              FROM sales s LEFT JOIN products p ON p.id = s.product_id
              LEFT JOIN customers cu ON cu.id = s.customer_id
              WHERE s.invoice_group = ? ORDER BY s.id`,
    args: [group]
  }) : await c.execute({
    sql: `SELECT s.*, p.code AS product_code, p.name AS product_name, cu.name AS customer_master
              FROM sales s LEFT JOIN products p ON p.id = s.product_id
              LEFT JOIN customers cu ON cu.id = s.customer_id
              WHERE s.id = ?`,
    args: [n7(saleId)]
  });
  const rows = toPlain9(rowsRes);
  if (!rows.length) return;
  const first = rows[0];
  const ids = rows.map((r) => n7(r.id));
  const priorRes = await c.execute(
    `SELECT id FROM journal_entries WHERE sale_id IN (${ids.join(",")}) ORDER BY id`
  );
  const priorIds = priorRes.rows.map((r) => n7(r.id)).filter(Boolean);
  const target = n7(reuseEntryId) || priorIds[0] || 0;
  const taxable = round23(rows.reduce((t, r) => t + n7(r.amount), 0));
  const gst = round23(rows.reduce((t, r) => t + n7(r.gst_amount), 0));
  const ro = round23(rows.reduce((t, r) => t + n7(r.round_off), 0));
  const tds = round23(rows.reduce((t, r) => t + n7(r.tds_amount), 0));
  const freight = round23(rows.reduce((t, r) => t + n7(r.transport_amount), 0));
  if (taxable <= 0 && gst <= 0) {
    for (const id of priorIds) await deleteJournalEntryById(id);
    return;
  }
  let customerName = String(first.customer_master || first.customer || "").trim();
  if (!customerName) customerName = "CASH CUSTOMER A/C";
  let transporterName = "";
  if (freight > 0 && first.transporter_id) {
    const t = await c.execute({ sql: "SELECT name FROM transporters WHERE id = ?", args: [n7(first.transporter_id)] });
    transporterName = t.rows.length ? String(t.rows[0].name).trim() : "";
  }
  const hasFreight = freight > 0 && !!transporterName;
  const deducted = !!first.deduct_freight && hasFreight;
  const bySaleAcc = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const code = String(r.product_code || r.product_name || "FG").toUpperCase();
    const acc = `${code} SALE A/C`;
    bySaleAcc.set(acc, round23((bySaleAcc.get(acc) || 0) + n7(r.amount)));
  }
  const saleLines = Array.from(bySaleAcc, ([account, cr]) => ({ account, group: "Sales Accounts", cr }));
  const saleAccounts = round23(saleLines.reduce((t, l) => t + l.cr, 0));
  const freightOutward = hasFreight ? freight : 0;
  const freightPayable = hasFreight && !deducted ? freight : 0;
  const roCr = ro > 0 ? ro : 0;
  const roDr = ro < 0 ? -ro : 0;
  const custDr = round23(
    saleAccounts + gst + roCr + freightPayable - tds - roDr - freightOutward
  );
  const lines = [
    { account: customerName, group: "Sundry Debtors", dr: custDr },
    ...saleLines,
    { account: "GST OUTPUT A/C", group: "Duties & Taxes", cr: gst },
    { account: "ROUND OFF A/C", group: "Indirect Expenses", cr: roCr, dr: roDr }
  ];
  if (tds > 4e-3) lines.push({ account: "TDS RECEIVABLE A/C", group: "Deposits (Asset)", dr: tds });
  if (hasFreight) {
    lines.push({ account: "FREIGHT OUTWARD A/C", group: "Direct Expenses", dr: freightOutward });
    if (!deducted) lines.push({ account: "FREIGHT PAYABLE A/C", group: "Current Liabilities", cr: freightPayable });
  }
  const args = {
    date: String(first.sale_date),
    vchType: "SALE",
    vchNo: first.invoice_no ? String(first.invoice_no) : null,
    // The voucher is filed under the invoice's FIRST line, so deleting that
    // line has to hand the voucher on rather than take it down — see deleteSale.
    saleId: n7(first.id),
    companyId: n7(first.company_id) || void 0,
    lines
  };
  if (target) {
    await repostJournal(target, args);
    for (const id of priorIds) if (id !== target) await deleteJournalEntryById(id);
    return;
  }
  await postJournal(args);
}
async function deleteJournalEntryById(entryId) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [n7(entryId)]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [n7(entryId)] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [n7(entryId)] });
}
async function postSaleEntry(saleId, v, taxable, gst, roundOff = 0, freightAmount = 0, tds = 0) {
  const prod = await getClient().execute({
    sql: "SELECT code, name FROM products WHERE id = ?",
    args: [n7(v.product_id)]
  });
  const code = String(prod.rows[0]?.code || prod.rows[0]?.name || "FG").toUpperCase();
  let customerName = String(v.customer || "").trim();
  if (v.customer_id) {
    const cu = await getClient().execute({ sql: "SELECT name FROM customers WHERE id = ?", args: [n7(v.customer_id)] });
    if (cu.rows.length) customerName = String(cu.rows[0].name || "").trim() || customerName;
  }
  let transporterName = null;
  if (freightAmount > 0 && v.transporter_id) {
    const t = await getClient().execute({ sql: "SELECT name FROM transporters WHERE id = ?", args: [n7(v.transporter_id)] });
    transporterName = t.rows.length ? String(t.rows[0].name) : null;
  }
  await postSaleInvoiceJournal(saleId).catch(
    (e) => console.error("[journal] sale post failed:", e.message)
  );
}
async function listCustomerLedger() {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, c.name AS customer_name, s.invoice_no
    FROM customer_ledger l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN sales s ON s.id = l.sale_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  });
  return toPlain9(res);
}
async function listSalesForUnloadDesk(companyIds) {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const res = await getClient().execute({
    args: cos.length ? [] : [getActiveCompanyId()],
    sql: `
    WITH gate_out AS (
      -- Which gate entry carried each invoice group out. A gate entry names its
      -- group directly, or reaches it through gate_entry_sales when one vehicle
      -- carried several invoices; both are the same question, so they are one
      -- UNION rather than an OR nobody can index.
      SELECT grp, MAX(id) AS ge_id FROM (
        SELECT ge.invoice_group AS grp, ge.id AS id
          FROM gate_entries ge
         WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
        UNION ALL
        SELECT gs.invoice_group AS grp, ge.id AS id
          FROM gate_entry_sales gs
          JOIN gate_entries ge ON ge.id = gs.gate_entry_id AND ge.direction = 'out'
      ) GROUP BY grp
    )
    SELECT s.id, s.invoice_no, s.invoice_group, s.sale_date, s.customer, s.customer_id,
           s.product_id, s.packaging_id, s.qty, s.uom, s.received_qty,
           s.dispatch_stage, s.status, s.freight_term, s.track_stock, s.is_trading,
           s.allowed_shortage_pct, sb.allowed_shortage_pct AS bargain_allowed_shortage_pct,
           s.loaded_date, s.transit_date, s.unloaded_date, s.rejected_at, s.company_id,
           pr.name AS product_name, pr.material_type AS product_category,
           pr.category AS product_sub_category, pk.name AS packaging_name,
           cu.name AS customer_master, co.name AS company_name,
           gv.tanker_no AS gate_vehicle_no
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    LEFT JOIN companies co ON co.id = s.company_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN gate_out go2 ON go2.grp = s.invoice_group
    LEFT JOIN gate_entries gv ON gv.id = go2.ge_id
    WHERE ${cos.length ? `s.company_id IN (${cos.join(",")})` : "s.company_id = ?"}
      AND COALESCE(s.freight_term, 'FREIGHT_ON_GOODS') = 'DLD'
      AND COALESCE(s.dispatch_stage, CASE WHEN s.status = 'done' THEN 'unloaded' ELSE 'pending' END) <> 'unloaded'
      AND s.rejected_at IS NULL
      AND COALESCE(s.is_trading, 0) = 0
    ORDER BY s.sale_date DESC, s.id DESC
  `
  });
  return toPlain9(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }));
}
async function listSales(companyIds, forModule) {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const vis = await visibleFromFor("sales", forModule);
  const res = await getClient().execute({
    args: vis ? cos.length ? [vis] : [getActiveCompanyId(), vis] : cos.length ? [] : [getActiveCompanyId()],
    sql: `
    WITH gate_out AS (
      -- Which gate entry carried each invoice group out. A gate entry names its
      -- group directly, or reaches it through gate_entry_sales when one vehicle
      -- carried several invoices; both are the same question, so they are one
      -- UNION rather than an OR nobody can index.
      SELECT grp, MAX(id) AS ge_id FROM (
        SELECT ge.invoice_group AS grp, ge.id AS id
          FROM gate_entries ge
         WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
        UNION ALL
        SELECT gs.invoice_group AS grp, ge.id AS id
          FROM gate_entry_sales gs
          JOIN gate_entries ge ON ge.id = gs.gate_entry_id AND ge.direction = 'out'
      ) GROUP BY grp
    )
    SELECT s.*, pr.name AS product_name, pr.material_type AS product_category,
           pr.category AS product_sub_category, sb.bargain_no AS sales_bargain_no,
           -- The allowance falls back invoice -> bargain -> mill default, so
           -- the bargain's figure has to travel with the line.
           sb.allowed_shortage_pct AS bargain_allowed_shortage_pct,
           pk.name AS packaging_name, tr.name AS transporter_name, cu.name AS customer_master,
           co.name AS company_name,
           COALESCE((SELECT SUM(cl.amount) FROM customer_ledger cl
                      WHERE cl.sale_id = s.id AND cl.entry_type = 'payment'), 0) AS received_amount,
           -- The vehicle that actually carried this invoice out, from the
           -- gate register \u2014 Gate Out already links to a sale by invoice
           -- group; this is that link read back onto the invoice itself.
           gv.tanker_no AS gate_vehicle_no,
           gv.gate_entry_no AS gate_entry_no,
           gv.status AS gate_status
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN transporters tr ON tr.id = s.transporter_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    LEFT JOIN companies co ON co.id = s.company_id
    LEFT JOIN gate_out go2 ON go2.grp = s.invoice_group
    LEFT JOIN gate_entries gv ON gv.id = go2.ge_id
    WHERE ${cos.length ? `s.company_id IN (${cos.join(",")})` : "s.company_id = ?"}${vis ? " AND s.sale_date >= ?" : ""}
    ORDER BY s.sale_date DESC, s.id DESC
  `
  });
  return toPlain9(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }));
}
function dayMonth2(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
  if (m) return `${m[3]}-${m[2]}`;
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
var RETURN_MATCH = `(
  nt.bargain_id = b.id
  OR (nt.bargain_id IS NULL
      AND COALESCE(nt.against_ref, '') <> ''
      AND EXISTS (SELECT 1 FROM sales s2
                   WHERE s2.sales_bargain_id = b.id
                     AND s2.product_id = ni.product_id
                     AND TRIM(UPPER(s2.invoice_no)) = TRIM(UPPER(nt.against_ref))))
)`;
function returnSum(dateWhere, coWhere) {
  return `COALESCE((SELECT SUM(ni.qty)
      FROM notes nt JOIN note_items ni ON ni.note_id = nt.id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       AND ${RETURN_MATCH}${coWhere}${dateWhere}), 0)`;
}
async function salesInvoiceSeries(companyId) {
  const cid = companyId || getActiveCompanyId();
  const res = await getClient().execute({
    sql: `SELECT invoice_no FROM sales
           WHERE company_id = ? AND invoice_no IS NOT NULL AND TRIM(invoice_no) <> ''`,
    args: [cid]
  });
  const count = /* @__PURE__ */ new Map();
  const highest = /* @__PURE__ */ new Map();
  for (const r of toPlain9(res)) {
    const m = String(r.invoice_no || "").trim().match(/^(.*?)[/\-]?(\d+)$/);
    if (!m || !m[1]) continue;
    const prefix2 = m[1].replace(/[/\-]+$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    count.set(prefix2, (count.get(prefix2) || 0) + 1);
    const num2 = Number(m[2]);
    if (num2 > (highest.get(prefix2) || 0)) highest.set(prefix2, num2);
  }
  let prefix = "";
  let best = 0;
  for (const [p, c] of count) {
    if (c > best) {
      best = c;
      prefix = p;
    }
  }
  return {
    company_id: cid,
    prefix,
    highest: prefix ? highest.get(prefix) || 0 : 0,
    // The obvious next one. A suggestion only — a gap being filled in is a
    // perfectly good reason to type something else.
    next: prefix ? (highest.get(prefix) || 0) + 1 : 1,
    invoices: best
  };
}
async function salesInvoiceGaps(companyId, range) {
  const cid = companyId || getActiveCompanyId();
  const conds = ["s.company_id = ?", "s.invoice_no IS NOT NULL", "TRIM(s.invoice_no) <> ''"];
  const args = [cid];
  if (range?.from) {
    conds.push("s.sale_date >= ?");
    args.push(range.from);
  }
  if (range?.to) {
    conds.push("s.sale_date <= ?");
    args.push(range.to);
  }
  const res = await getClient().execute({
    sql: `SELECT DISTINCT s.invoice_no, MIN(s.sale_date) AS first_date
            FROM sales s WHERE ${conds.join(" AND ")}
           GROUP BY s.invoice_no ORDER BY s.invoice_no`,
    args
  });
  const voidRes = await getClient().execute({
    sql: `SELECT prefix, number, reason, cancelled_on FROM cancelled_invoice_nos
           WHERE company_id = ? ORDER BY prefix, number`,
    args: [cid]
  });
  const voided = /* @__PURE__ */ new Map();
  for (const r of toPlain9(voidRes)) {
    const pfx = String(r.prefix || "");
    if (!voided.has(pfx)) voided.set(pfx, /* @__PURE__ */ new Map());
    voided.get(pfx).set(n7(r.number), r);
  }
  const series = /* @__PURE__ */ new Map();
  const unparsed = [];
  for (const r of toPlain9(res)) {
    const inv = String(r.invoice_no || "").trim();
    const m = inv.match(/^(.*?)[/\\-]?(\d+)$/);
    if (!m || !m[1]) {
      unparsed.push(inv);
      continue;
    }
    const prefix = m[1].replace(/[/\\-]+$/, "");
    if (!series.has(prefix)) series.set(prefix, /* @__PURE__ */ new Map());
    series.get(prefix).set(Number(m[2]), String(r.first_date || "").slice(0, 10));
  }
  const bare = (v) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const rows = [];
  for (const [prefix, nums] of series) {
    const keys = [...nums.keys()].sort((a, b) => a - b);
    if (!keys.length) continue;
    const lo = keys[0];
    const hi = keys[keys.length - 1];
    const held = /* @__PURE__ */ new Set();
    const strays = [];
    for (const [other, otherNums] of series) {
      if (bare(other) !== bare(prefix)) continue;
      for (const k of otherNums.keys()) held.add(k);
      if (other !== prefix) {
        for (const k of otherNums.keys()) strays.push({ number: k, as: `${other}/${k}` });
      }
    }
    const voidHere = /* @__PURE__ */ new Map();
    for (const [vp, vnums] of voided) {
      if (bare(vp) !== bare(prefix)) continue;
      for (const [num2, row] of vnums) voidHere.set(num2, row);
    }
    const missing = [];
    const cancelled = [];
    for (let i = lo; i <= hi; i++) {
      if (held.has(i)) continue;
      const v = voidHere.get(i);
      if (v) {
        cancelled.push({ number: i, reason: v.reason ?? null, cancelled_on: v.cancelled_on ?? null });
        continue;
      }
      missing.push(i);
    }
    rows.push({
      prefix,
      used: keys.length,
      cancelled,
      cancelled_count: cancelled.length,
      from: lo,
      to: hi,
      expected: hi - lo + 1,
      missing,
      missing_count: missing.length,
      // Numbers that exist, but keyed under a misspelt prefix — a typo to fix,
      // not a bill to hunt for.
      strays
    });
  }
  rows.sort((a, b) => n7(b.used) - n7(a.used));
  return {
    company_id: cid,
    series: rows.filter((r) => n7(r.used) > 1 || !rows.some((o) => o !== r && bare(String(o.prefix)) === bare(String(r.prefix)))),
    // Invoice numbers with no number in them at all — a party name typed into
    // the invoice field, most often.
    unparsed
  };
}
async function listSalesBargains(from, to, companyIds, forModule) {
  const f = from || "0000-01-01";
  const t = to || "9999-12-31";
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const sCo = cos.length ? ` AND company_id IN (${cos.join(",")})` : "";
  const nCo = cos.length ? ` AND nt.company_id IN (${cos.join(",")})` : "";
  const vis = await visibleFromFor("salesBargains", forModule);
  const res = await getClient().execute({
    sql: `
    SELECT b.*, pr.name AS product_name, pk.name AS packaging_name, cu.name AS customer_master,
      co.name AS company_name,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id${sCo}), 0) AS sold_qty,
      b.qty - COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id${sCo}), 0)
            + ${returnSum("", nCo)} AS balance_qty,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) < ?${sCo}), 0) AS disp_before,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) >= ? AND substr(sale_date, 1, 10) <= ?${sCo}), 0) AS disp_period,
      (SELECT MAX(substr(sale_date, 1, 10)) FROM sales WHERE sales_bargain_id = b.id${sCo}) AS last_dispatch_date,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) < ?), 0) AS adj_before,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) >= ? AND substr(adj_date, 1, 10) <= ?), 0) AS adj_in,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) > ?), 0) AS adj_after,
      ${returnSum("", nCo)} AS returned_qty,
      ${returnSum(" AND substr(nt.note_date, 1, 10) < ?", nCo)} AS ret_before,
      ${returnSum(" AND substr(nt.note_date, 1, 10) >= ? AND substr(nt.note_date, 1, 10) <= ?", nCo)} AS ret_in,
      ${returnSum(" AND substr(nt.note_date, 1, 10) > ?", nCo)} AS ret_after
    FROM sales_bargains b
    LEFT JOIN products pr ON pr.id = b.product_id
    LEFT JOIN packagings pk ON pk.id = b.packaging_id
    LEFT JOIN customers cu ON cu.id = b.customer_id
    LEFT JOIN companies co ON co.id = b.company_id
    ${vis ? "WHERE b.bargain_date >= ?" : ""}
    ORDER BY b.id DESC
  `,
    args: vis ? [f, f, t, f, f, t, t, f, f, t, t, vis] : [f, f, t, f, f, t, t, f, f, t, t]
  });
  return toPlain9(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }));
}
async function listSalesBargainReturns(companyIds) {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const res = await getClient().execute(`
    SELECT b.id AS bargain_id, nt.id AS note_id, nt.note_no, nt.note_date, nt.against_ref,
           nt.company_id, co.name AS company_name, ni.qty, ni.rate, ni.amount,
           nt.gst_pct,
           -- The registers show a dispatch INCLUDING GST (amount + gst_amount),
           -- so a return has to be stated on the same basis or netting the two
           -- silently drops the tax. note_items.amount is taxable only.
           ROUND(ni.amount * (1 + COALESCE(nt.gst_pct, 0) / 100.0), 2) AS amount_incl,
           p.name AS product_name, nt.bargain_id AS explicit_bargain_id
      FROM notes nt
      JOIN note_items ni ON ni.note_id = nt.id
      JOIN sales_bargains b ON ${RETURN_MATCH}
      LEFT JOIN products p ON p.id = ni.product_id
      LEFT JOIN companies co ON co.id = nt.company_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       ${cos.length ? `AND nt.company_id IN (${cos.join(",")})` : ""}
     ORDER BY nt.note_date, nt.id`);
  return toPlain9(res);
}
async function listUnattributedReturns(companyIds) {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const res = await getClient().execute(`
    SELECT nt.id AS note_id, nt.note_no, nt.note_date, nt.against_ref, nt.company_id,
           cu.name AS customer, ni.qty, p.name AS product_name
      FROM notes nt
      JOIN note_items ni ON ni.note_id = nt.id
      LEFT JOIN customers cu ON cu.id = nt.party_id
      LEFT JOIN products p ON p.id = ni.product_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       ${cos.length ? `AND nt.company_id IN (${cos.join(",")})` : ""}
       AND NOT EXISTS (SELECT 1 FROM sales_bargains b WHERE ${RETURN_MATCH})
     ORDER BY nt.note_date, nt.id`);
  return toPlain9(res);
}
async function nextSalesBargainNo(productId, customer, dateStr) {
  const c = getClient();
  const prodRes = await c.execute({
    sql: "SELECT code, name FROM products WHERE id = ?",
    args: [productId]
  });
  const fg = (prodRes.rows.length ? String(prodRes.rows[0].code || prodRes.rows[0].name || "FG") : "FG").replace(/\s+/g, "").toUpperCase();
  const party = String(customer || "PARTY").replace(/\s+/g, "").toUpperCase() || "PARTY";
  const monthKey = String(dateStr).slice(0, 7);
  const res = await c.execute({
    sql: "SELECT bargain_no FROM sales_bargains WHERE substr(bargain_date, 1, 7) = ?",
    args: [monthKey]
  });
  let maxSeq = 0;
  for (const r of res.rows) {
    const parts = String(r.bargain_no).split("/");
    const seq = parseInt(parts[parts.length - 1] ?? "0", 10);
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  const serial = String(maxSeq + 1).padStart(2, "0");
  return `${fg}/${dayMonth2(dateStr)}/${party}/${serial}`;
}
async function salesBargainSold(id) {
  const r = await getClient().execute({
    sql: "SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ?",
    args: [id]
  });
  return n7(r.rows[0]?.q);
}
var SALE_CATEGORIES = ["FINISHED_OIL", "FATTY", "SCRAP", "SPENT_EARTH", "MISC"];
function saleCategory(v) {
  const s = String(v || "").toUpperCase();
  return SALE_CATEGORIES.includes(s) ? s : "FINISHED_OIL";
}
function validateSalesBargainInput(v) {
  if (!v.customer || !String(v.customer).trim()) throw new Error("Customer is required");
  if (!v.product_id) throw new Error("Product is required");
  if (n7(v.qty) <= 0) throw new Error("Quantity must be greater than zero");
  if (n7(v.rate) <= 0) throw new Error("Rate must be greater than zero");
  const struck = String(v.bargain_date || "").slice(0, 10);
  const expires = String(v.rate_expiry_date || "").slice(0, 10);
  if (struck && expires && expires <= struck) {
    throw new Error(
      expires === struck ? "Rate expiry cannot be the same day as the bargain \u2014 it has to be after it" : "Rate expiry cannot be before the bargain date"
    );
  }
}
async function createSalesBargain(v) {
  validateSalesBargainInput(v);
  const bargain_no = await nextSalesBargainNo(
    n7(v.product_id),
    String(v.customer || ""),
    String(v.bargain_date)
  );
  const res = await getClient().execute({
    sql: `INSERT INTO sales_bargains (company_id, bargain_no, manual_bargain_no, bargain_date, customer, customer_id, product_id, qty, uom, rate, rate_expiry_date, status, note, sale_type, sale_category, packaging_id, freight_term, gst_pct, gst_type, allowed_shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.manual_bargain_no ? String(v.manual_bargain_no).trim() : null,
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n7(v.customer_id) : null,
      n7(v.product_id),
      n7(v.qty),
      v.uom || "MT",
      n7(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === "PACKED" ? "PACKED" : "LOOSE",
      saleCategory(v.sale_category),
      v.packaging_id ? n7(v.packaging_id) : null,
      v.freight_term === "DLD" ? "DLD" : "FREIGHT_ON_GOODS",
      n7(v.gst_pct),
      v.gst_type === "IGST" ? "IGST" : "CGST_SGST",
      shortagePct(v)
    ]
  });
  return { id: Number(res.lastInsertRowid), bargain_no };
}
async function updateSalesBargain(id, v) {
  validateSalesBargainInput(v);
  const cur = await getClient().execute({
    sql: "SELECT customer, customer_id, product_id FROM sales_bargains WHERE id = ?",
    args: [id]
  });
  if (!cur.rows.length) throw new Error("Sales bargain not found");
  const sold = await salesBargainSold(id);
  if (sold > 1e-6) {
    const curId = n7(cur.rows[0].customer_id);
    const newId = n7(v.customer_id);
    const changed = curId > 0 || newId > 0 ? curId !== newId : String(v.customer || "").trim() !== String(cur.rows[0].customer || "").trim();
    if (changed) {
      throw new Error("Cannot change the customer \u2014 this bargain already has sales");
    }
    if (n7(v.product_id) !== n7(cur.rows[0].product_id)) {
      throw new Error("Cannot change the product \u2014 this bargain already has sales");
    }
    if (n7(v.qty) < sold - 1e-6) {
      throw new Error(`Quantity cannot be below the ${sold.toFixed(3)} already sold on this bargain`);
    }
  }
  await getClient().execute({
    sql: `UPDATE sales_bargains SET bargain_date = ?, customer = ?, customer_id = ?, product_id = ?, qty = ?, uom = ?,
          rate = ?, rate_expiry_date = ?, note = ?, sale_type = ?, sale_category = ?, packaging_id = ?, freight_term = ?, gst_pct = ?, gst_type = ?, manual_bargain_no = ?, allowed_shortage_pct = ? WHERE id = ?`,
    args: [
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n7(v.customer_id) : null,
      n7(v.product_id),
      n7(v.qty),
      v.uom || "MT",
      n7(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === "PACKED" ? "PACKED" : "LOOSE",
      saleCategory(v.sale_category),
      v.packaging_id ? n7(v.packaging_id) : null,
      v.freight_term === "DLD" ? "DLD" : "FREIGHT_ON_GOODS",
      n7(v.gst_pct),
      v.gst_type === "IGST" ? "IGST" : "CGST_SGST",
      v.manual_bargain_no ? String(v.manual_bargain_no).trim() : null,
      shortagePct(v),
      id
    ]
  });
  return { id };
}
async function deleteSalesBargain(id) {
  if (await salesBargainSold(id) > 1e-6) {
    throw new Error("This sales bargain has sales linked to it. Delete those sales first.");
  }
  await getClient().execute({ sql: "DELETE FROM sales_bargains WHERE id = ?", args: [id] });
  return { id };
}
async function adjustSalesBargainQty(id, delta, note, date) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM sales_bargains WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Sales bargain not found");
  const b = toPlain9(res)[0];
  const d = Number(delta) || 0;
  if (d === 0) throw new Error("Enter a quantity to add or remove");
  const sold = Math.round(await salesBargainSold(id) * 1e3) / 1e3;
  const newQty = Math.round((n7(b.qty) + d) * 1e3) / 1e3;
  if (newQty < -1e-9) throw new Error("The resulting quantity cannot go below zero");
  if (newQty < sold - 1e-6) {
    throw new Error(`Cannot remove below the ${sold.toFixed(3)} already sold on this bargain`);
  }
  const newNote = note ? `${b.note ? String(b.note) + "\n" : ""}${String(note).trim()}` : b.note;
  await c.execute({
    sql: "UPDATE sales_bargains SET qty = ?, note = ? WHERE id = ?",
    args: [newQty, newNote || null, id]
  });
  const adjDate = date && String(date).slice(0, 10) || todayISO();
  await c.execute({
    sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note) VALUES ('sales', ?, ?, ?, ?)",
    args: [id, d, adjDate, note ? String(note).trim() : null]
  });
  return { id, qty: newQty };
}
async function salesBargainBalanceFor(bargainId, excludeSaleId) {
  const c = getClient();
  const b = await c.execute({ sql: "SELECT qty FROM sales_bargains WHERE id = ?", args: [bargainId] });
  if (!b.rows.length) return Infinity;
  const sold = await c.execute({
    sql: "SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ? AND id != ?",
    args: [bargainId, excludeSaleId || 0]
  });
  const ret = await c.execute({
    sql: `SELECT COALESCE(SUM(ni.qty), 0) AS q
            FROM notes nt JOIN note_items ni ON ni.note_id = nt.id
            JOIN sales_bargains b ON b.id = ?
           WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND ${RETURN_MATCH}`,
    args: [bargainId]
  });
  return n7(b.rows[0].qty) - n7(sold.rows[0]?.q) + n7(ret.rows[0]?.q);
}
var UNIT_FACTOR = {
  KG: { dim: "mass", f: 1 },
  QUINTAL: { dim: "mass", f: 100 },
  MT: { dim: "mass", f: 1e3 },
  TON: { dim: "mass", f: 1e3 },
  ML: { dim: "vol", f: 1e-3 },
  L: { dim: "vol", f: 1 },
  KL: { dim: "vol", f: 1e3 }
};
function convertQty(qty, from, to) {
  const a = UNIT_FACTOR[String(from || "").toUpperCase()];
  const b = UNIT_FACTOR[String(to || "").toUpperCase()];
  if (!a || !b || a.dim !== b.dim) return qty;
  return qty * a.f / b.f;
}
async function resolveSaleAmount(v, qty, rate) {
  const perCase = n7(v.rate_per_case);
  if (String(v.sale_type) !== "PACKED" || !v.packaging_id || perCase <= 0) return qty * rate;
  const p = await getClient().execute({
    sql: "SELECT pouches_per_box, base_per_pouch FROM packagings WHERE id = ?",
    args: [n7(v.packaging_id)]
  });
  if (!p.rows.length) return qty * rate;
  const ppb = n7(p.rows[0].pouches_per_box);
  const bpp = n7(p.rows[0].base_per_pouch);
  if (ppb <= 0 || bpp <= 0) return qty * rate;
  const cases = n7(v.boxes) + n7(v.pouches) / ppb;
  return round23(cases * perCase);
}
async function resolveSaleQty(v) {
  let target = String(v.uom || "").trim();
  if (v.sales_bargain_id) {
    const b = await getClient().execute({
      sql: "SELECT uom FROM sales_bargains WHERE id = ?",
      args: [n7(v.sales_bargain_id)]
    });
    if (b.rows.length && b.rows[0].uom) target = String(b.rows[0].uom);
  }
  if (!target) target = "MT";
  if (String(v.sale_type) === "PACKED" && v.packaging_id) {
    const p = await getClient().execute({
      sql: "SELECT pouches_per_box, base_per_pouch, base_uom FROM packagings WHERE id = ?",
      args: [n7(v.packaging_id)]
    });
    if (p.rows.length) {
      const ppb = n7(p.rows[0].pouches_per_box);
      const bpp = n7(p.rows[0].base_per_pouch);
      const baseUom = String(p.rows[0].base_uom || "KG");
      const baseQty = n7(v.boxes) * ppb * bpp + n7(v.pouches) * bpp;
      const qty = Math.round(convertQty(baseQty, baseUom, target) * 1e6) / 1e6;
      return { qty, uom: target };
    }
  }
  return { qty: n7(v.qty), uom: target };
}
async function resolveFreightQty(v, qty) {
  if (String(v.sale_type) === "PACKED" && v.packaging_id) {
    const p = await getClient().execute({
      sql: "SELECT pouches_per_box FROM packagings WHERE id = ?",
      args: [n7(v.packaging_id)]
    });
    const ppb = p.rows.length ? n7(p.rows[0].pouches_per_box) : 0;
    const boxes = n7(v.boxes);
    const pouches = n7(v.pouches);
    return ppb > 0 ? boxes + pouches / ppb : boxes;
  }
  return v.received_qty != null && n7(v.received_qty) > 0 ? n7(v.received_qty) : qty;
}
function shortagePct(v) {
  return v.allowed_shortage_pct != null && v.allowed_shortage_pct !== "" ? Number(v.allowed_shortage_pct) : null;
}
async function postSaleShortageDebit(saleId) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM transporter_ledger WHERE sale_id = ? AND entry_type = 'shortage_penalty'",
    args: [saleId]
  });
  const r = await c.execute({
    sql: `SELECT s.*, sb.allowed_shortage_pct AS bargain_allowed_shortage_pct
            FROM sales s LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
           WHERE s.id = ?`,
    args: [saleId]
  });
  if (!r.rows.length) return 0;
  const row = r.rows[0];
  if (String(row.freight_term) !== "DLD") return 0;
  if (row.received_qty == null) return 0;
  if (n7(row.is_trading) === 1) return 0;
  const transporterId = row.transporter_id ? n7(row.transporter_id) : null;
  if (!transporterId) return 0;
  if (n7(row.deduct_freight) === 1) return 0;
  const dispatched = n7(row.qty);
  if (dispatched <= 0) return 0;
  const pct = await allowedShortagePct(row);
  const shortage = Math.max(0, dispatched - n7(row.received_qty));
  const excess = Math.max(0, shortage - dispatched * pct / 100);
  const charge = round23(excess * n7(row.rate));
  if (charge <= 4e-3) return 0;
  await c.execute({
    sql: `INSERT INTO transporter_ledger (transporter_id, sale_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'shortage_penalty', ?, ?, ?)`,
    args: [
      transporterId,
      saleId,
      row.unloaded_date || row.sale_date || null,
      -charge,
      `Oil shortage ${excess.toFixed(3)} ${String(row.uom || "")} beyond ${pct}% tolerance`,
      n7(row.company_id) || getActiveCompanyId()
    ]
  });
  return charge;
}
async function allowedShortagePct(row) {
  if (row.allowed_shortage_pct != null && row.allowed_shortage_pct !== "") return n7(row.allowed_shortage_pct);
  if (row.bargain_allowed_shortage_pct != null && row.bargain_allowed_shortage_pct !== "") {
    return n7(row.bargain_allowed_shortage_pct);
  }
  return n7(await getSetting("allowed_shortage_pct") ?? "0");
}
async function postSaleFreight(saleId, v, qty) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM transporter_ledger WHERE sale_id = ?", args: [saleId] });
  await c.execute({ sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'freight'", args: [saleId] });
  if (String(v.freight_term) !== "DLD") return 0;
  const transporterId = v.transporter_id ? n7(v.transporter_id) : null;
  const amount = n7(v.transport_rate) > 0 ? round23(qty * n7(v.transport_rate)) : n7(v.transport_amount);
  if (!transporterId || amount <= 0) return amount > 0 ? amount : 0;
  const companyId = getActiveCompanyId();
  if (v.deduct_freight) return amount;
  await c.execute({
    // accrued = 1: the sale voucher already carried Dr FREIGHT OUTWARD /
    // Cr FREIGHT PAYABLE for this, so the transporter's bill must debit the
    // payable rather than book the expense a second time.
    sql: `INSERT INTO transporter_ledger (transporter_id, sale_id, entry_date, entry_type, amount, note, company_id, accrued)
          VALUES (?, ?, ?, 'freight', ?, 'Delivery freight', ?, 1)`,
    args: [transporterId, saleId, v.sale_date, amount, companyId]
  });
  const customerId = v.customer_id ? n7(v.customer_id) : null;
  if (customerId) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'freight', ?, 'Delivery freight recovered', ?)`,
      args: [customerId, saleId, v.sale_date, -Math.abs(amount), companyId]
    });
  }
  return amount;
}
async function createSale(v) {
  const productId = n7(v.product_id);
  if (!productId) throw new Error("Select a product");
  await assertSalesInvoiceNoFree(v, getActiveCompanyId(), void 0, !!v.invoice_no_grandfathered);
  const { qty, uom } = await resolveSaleQty(v);
  if (qty <= 0) throw new Error("Quantity must be greater than zero");
  const rate = n7(v.rate);
  if (rate < 0) throw new Error("Rate cannot be negative");
  const amount = await resolveSaleAmount(v, qty, rate);
  const gstPct = n7(v.gst_pct);
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100;
  const roundOff = Math.round((n7(v.round_off) || 0) * 100) / 100;
  const customerId = v.customer_id ? n7(v.customer_id) : null;
  const tdsPct = await resolveTdsPct(v, customerId);
  const tdsAmount = await saleTds(customerId, tdsPct, amount, String(v.sale_date), 0);
  const net = amount + gstAmount + roundOff - tdsAmount;
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n7(v.sales_bargain_id), 0);
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`);
    }
  }
  const exTerm = v.freight_term !== "DLD";
  const stage = exTerm ? "unloaded" : stageOf(v);
  const status = statusForStage(stage);
  const dates = resolveStageDates(stage, v, exTerm && String(v.sale_date || "") || todayLocal());
  const isTrading = !!v.is_trading;
  const trackStock = isTrading || isDispatched(stage) && v.force_no_stock ? 0 : 1;
  if (isDispatched(stage) && !isTrading && trackStock === 1) {
    await assertFinishedStock(productId, qty, await productLabel(productId));
  }
  const freightQty = await resolveFreightQty(v, qty);
  const transportAmount = String(v.freight_term) === "DLD" ? n7(v.transport_rate) > 0 ? round23(freightQty * n7(v.transport_rate)) : n7(v.transport_amount) : 0;
  const res = await getClient().execute({
    sql: `INSERT INTO sales (company_id, sale_date, invoice_no, invoice_group, customer, customer_id, product_id, sales_bargain_id,
            qty, uom, rate, amount, gst_pct, gst_amount, gst_type, round_off, round_off_manual, tds_pct, tds_amount, status, dispatch_stage, track_stock, loaded_date, transit_date, unloaded_date, note, sale_type, packaging_id, boxes, pouches, freight_term,
            transporter_id, transport_rate, transport_amount, is_trading, affects_stock, deduct_freight, rate_per_case,
            allowed_shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      v.sale_date,
      v.invoice_no || null,
      v.invoice_group || null,
      v.customer || null,
      customerId,
      n7(v.product_id),
      v.sales_bargain_id ? n7(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === "IGST" ? "IGST" : "CGST_SGST",
      roundOff,
      v.round_off_manual ? 1 : 0,
      tdsPct,
      tdsAmount,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
      v.note || null,
      v.sale_type === "PACKED" ? "PACKED" : "LOOSE",
      v.packaging_id ? n7(v.packaging_id) : null,
      n7(v.boxes),
      n7(v.pouches),
      v.freight_term === "DLD" ? "DLD" : "FREIGHT_ON_GOODS",
      v.transporter_id ? n7(v.transporter_id) : null,
      n7(v.transport_rate),
      transportAmount,
      isTrading ? 1 : 0,
      isTrading ? 0 : 1,
      v.deduct_freight ? 1 : 0,
      n7(v.rate_per_case) > 0 ? round23(n7(v.rate_per_case)) : null,
      shortagePct(v)
    ]
  });
  const id = Number(res.lastInsertRowid);
  await postCustomerReceivable(id, customerId, net, String(v.sale_date));
  await postSaleEntry(id, v, amount, gstAmount, roundOff, transportAmount, tdsAmount);
  await postSaleFreight(id, v, freightQty);
  await postSaleShortageDebit(id);
  return { id };
}
async function updateSale(id, v) {
  const productId = n7(v.product_id);
  if (!productId) throw new Error("Select a product");
  {
    const own = await getClient().execute({
      sql: "SELECT company_id, invoice_group FROM sales WHERE id = ? LIMIT 1",
      args: [id]
    });
    const cid = n7(own.rows[0]?.company_id) || getActiveCompanyId();
    const grp = v.invoice_group || own.rows[0]?.invoice_group || null;
    await assertSalesInvoiceNoFree({ ...v, invoice_group: grp }, cid, id, !!v.invoice_no_grandfathered);
  }
  const { qty, uom } = await resolveSaleQty(v);
  if (qty <= 0) throw new Error("Quantity must be greater than zero");
  const rate = n7(v.rate);
  if (rate < 0) throw new Error("Rate cannot be negative");
  const amount = await resolveSaleAmount(v, qty, rate);
  const gstPct = n7(v.gst_pct);
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100;
  const roundOff = Math.round((n7(v.round_off) || 0) * 100) / 100;
  const customerId = v.customer_id ? n7(v.customer_id) : null;
  const tdsPct = n7(v.tds_pct);
  const tdsAmount = await saleTds(customerId, tdsPct, amount, String(v.sale_date), id);
  const net = amount + gstAmount + roundOff - tdsAmount;
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n7(v.sales_bargain_id), id);
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`);
    }
  }
  const exTerm = v.freight_term !== "DLD";
  const stage = exTerm ? "unloaded" : stageOf(v);
  const status = statusForStage(stage);
  const dates = resolveStageDates(stage, v, exTerm && String(v.sale_date || "") || todayLocal());
  const isTrading = !!v.is_trading;
  const trackStock = isTrading || isDispatched(stage) && v.force_no_stock ? 0 : 1;
  if (isDispatched(stage) && !isTrading && trackStock === 1) {
    await assertFinishedStock(productId, qty, await productLabel(productId), id);
  }
  const freightQty = await resolveFreightQty(v, qty);
  const transportAmount = String(v.freight_term) === "DLD" ? n7(v.transport_rate) > 0 ? round23(freightQty * n7(v.transport_rate)) : n7(v.transport_amount) : 0;
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, customer_id = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, gst_pct = ?, gst_amount = ?, gst_type = ?, round_off = ?, round_off_manual = ?, tds_pct = ?, tds_amount = ?, status = ?, dispatch_stage = ?, track_stock = ?, loaded_date = ?, transit_date = ?, unloaded_date = ?, note = ?, sale_type = ?, packaging_id = ?, boxes = ?,
          pouches = ?, freight_term = ?, transporter_id = ?, transport_rate = ?, transport_amount = ?, deduct_freight = ?,
          rate_per_case = ?, allowed_shortage_pct = ? WHERE id = ?`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n7(v.product_id),
      v.sales_bargain_id ? n7(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === "IGST" ? "IGST" : "CGST_SGST",
      roundOff,
      v.round_off_manual ? 1 : 0,
      tdsPct,
      tdsAmount,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
      v.note || null,
      v.sale_type === "PACKED" ? "PACKED" : "LOOSE",
      v.packaging_id ? n7(v.packaging_id) : null,
      n7(v.boxes),
      n7(v.pouches),
      v.freight_term === "DLD" ? "DLD" : "FREIGHT_ON_GOODS",
      v.transporter_id ? n7(v.transporter_id) : null,
      n7(v.transport_rate),
      transportAmount,
      v.deduct_freight ? 1 : 0,
      n7(v.rate_per_case) > 0 ? round23(n7(v.rate_per_case)) : null,
      shortagePct(v),
      id
    ]
  });
  await deleteSaleProductions(id);
  await postCustomerReceivable(id, customerId, net, String(v.sale_date));
  await postSaleEntry(id, v, amount, gstAmount, roundOff, transportAmount, tdsAmount);
  await postSaleFreight(id, v, freightQty);
  await postSaleShortageDebit(id);
  return { id };
}
async function recomputeSaleFreight(id) {
  const c = getClient();
  const r = await c.execute({ sql: "SELECT * FROM sales WHERE id = ?", args: [id] });
  if (!r.rows.length) return;
  const row = r.rows[0];
  await postSaleShortageDebit(id);
  if (String(row.freight_term) !== "DLD" || n7(row.transport_rate) <= 0) return;
  const qty = await resolveFreightQty(row, n7(row.qty));
  const amount = round23(qty * n7(row.transport_rate));
  if (Math.abs(amount - n7(row.transport_amount)) < 5e-3) return;
  await c.execute({ sql: "UPDATE sales SET transport_amount = ? WHERE id = ?", args: [amount, id] });
  await postSaleFreight(id, { ...row, transport_amount: amount }, qty);
  await postSaleEntry(
    id,
    { ...row, transport_amount: amount },
    n7(row.amount),
    n7(row.gst_amount),
    n7(row.round_off),
    amount,
    // Carried through, or re-striking the freight would silently drop the
    // TDS leg and put the whole invoice back on the customer.
    n7(row.tds_amount)
  );
}
async function setSaleStage(id, stageIn, force = false, dateIn, receivedQty) {
  const stage = stageOf({ dispatch_stage: stageIn });
  const status = statusForStage(stage);
  const r = await getClient().execute({
    sql: "SELECT product_id, qty, uom, status, track_stock, loaded_date, transit_date, unloaded_date, received_qty FROM sales WHERE id = ?",
    args: [id]
  });
  if (!r.rows.length) throw new Error("Sale not found");
  const row = r.rows[0];
  const pid = n7(row.product_id);
  const saleQty = n7(row.qty);
  const wasDispatched = String(row.status) === "done";
  let trackStock = n7(row.track_stock);
  if (!isDispatched(stage)) {
    trackStock = 1;
  } else if (!wasDispatched) {
    trackStock = force ? 0 : 1;
    if (trackStock === 1) {
      await assertFinishedStock(pid, saleQty, await productLabel(pid), id);
    }
  }
  const dates = resolveStageDates(stage, row, dateIn || todayLocal());
  const recQty = stage !== "unloaded" ? null : receivedQty === void 0 ? row.received_qty == null ? null : n7(row.received_qty) : receivedQty;
  await getClient().execute({
    sql: `UPDATE sales SET status = ?, dispatch_stage = ?, track_stock = ?,
            loaded_date = ?, transit_date = ?, unloaded_date = ?, received_qty = ? WHERE id = ?`,
    args: [status, stage, trackStock, dates.loaded_date, dates.transit_date, dates.unloaded_date, recQty, id]
  });
  await recomputeSaleFreight(id);
  await deleteSaleProductions(id);
  return { id };
}
async function setSaleStatus(id, status) {
  return setSaleStage(id, status === "done" ? "unloaded" : "pending");
}
async function deleteSale(id) {
  const c = getClient();
  await deleteSaleProductions(id);
  const own = await c.execute({ sql: "SELECT invoice_group FROM sales WHERE id = ?", args: [id] });
  const grp = own.rows[0] ? own.rows[0].invoice_group : null;
  let survivor = 0;
  if (grp) {
    const rest = await c.execute({
      sql: "SELECT id FROM sales WHERE invoice_group = ? AND id != ? ORDER BY id LIMIT 1",
      args: [String(grp), id]
    });
    survivor = rest.rows.length ? n7(rest.rows[0].id) : 0;
  }
  if (survivor) {
    await c.execute({ sql: "UPDATE journal_entries SET sale_id = ? WHERE sale_id = ?", args: [survivor, id] });
  } else {
    await deleteJournalByRef("sale_id", id);
  }
  await c.execute({ sql: "DELETE FROM payment_allocations WHERE sale_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM customer_ledger WHERE sale_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM transporter_ledger WHERE sale_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM sales WHERE id = ?", args: [id] });
  if (survivor) {
    await postSaleInvoiceJournal(survivor).catch(
      (e) => console.error("[journal] invoice re-post after line delete failed:", e.message)
    );
  }
  return { id };
}
var invoiceSeq = 0;
function newInvoiceGroup() {
  invoiceSeq += 1;
  return `INV-${Date.now().toString(36)}-${invoiceSeq}`;
}
function mergeInvoiceItem(header, item, group) {
  return {
    ...item,
    invoice_group: group,
    sale_date: header.sale_date,
    invoice_no: header.invoice_no,
    customer: header.customer,
    customer_id: header.customer_id,
    freight_term: header.freight_term,
    transporter_id: header.transporter_id,
    transport_rate: header.transport_rate,
    dispatch_stage: header.dispatch_stage,
    loaded_date: header.loaded_date,
    transit_date: header.transit_date,
    unloaded_date: header.unloaded_date,
    force_no_stock: header.force_no_stock,
    is_trading: header.is_trading,
    deduct_freight: header.deduct_freight,
    // Agreed for the whole delivery, not per line — one tanker, one tolerance.
    allowed_shortage_pct: header.allowed_shortage_pct
  };
}
async function createSaleInvoice(v) {
  const items = Array.isArray(v.items) ? v.items : [];
  if (!items.length) throw new Error("Add at least one item to the invoice");
  const group = newInvoiceGroup();
  const ids = [];
  for (let i = 0; i < items.length; i++) {
    const res = await createSale({ ...mergeInvoiceItem(v, items[i], group), round_off: i === 0 ? v.round_off : 0, round_off_manual: i === 0 ? v.round_off_manual : 0 });
    ids.push(res.id);
  }
  return { group, ids };
}
async function updateSaleInvoice(group, v) {
  const items = Array.isArray(v.items) ? v.items : [];
  if (!items.length) throw new Error("Add at least one item to the invoice");
  const existing = await getClient().execute({
    sql: "SELECT id, product_id, packaging_id, received_qty, invoice_no FROM sales WHERE invoice_group = ? ORDER BY id",
    args: [group]
  });
  const heldBefore = String(existing.rows[0]?.invoice_no || "").trim().toUpperCase();
  const keepsItsNumber = !!heldBefore && heldBefore === String(v.invoice_no || "").trim().toUpperCase();
  const weighed = toPlain9(existing).filter((r) => r.received_qty != null).map((r) => ({ product_id: n7(r.product_id), packaging_id: n7(r.packaging_id), qty: n7(r.received_qty), used: false }));
  for (const r of existing.rows) await deleteSale(Number(r.id));
  const ids = [];
  for (let i = 0; i < items.length; i++) {
    const res = await createSale({
      ...mergeInvoiceItem(v, items[i], group),
      round_off: i === 0 ? v.round_off : 0,
      round_off_manual: i === 0 ? v.round_off_manual : 0,
      invoice_no_grandfathered: keepsItsNumber
    });
    ids.push(res.id);
    const match = weighed.find(
      (w) => !w.used && w.product_id === n7(items[i].product_id) && w.packaging_id === n7(items[i].packaging_id)
    );
    if (match) {
      match.used = true;
      await getClient().execute({
        sql: "UPDATE sales SET received_qty = ? WHERE id = ?",
        args: [match.qty, res.id]
      });
      await recomputeSaleFreight(res.id);
    }
  }
  return { group, ids };
}
async function setInvoiceStage(group, stage, force = false, date, received) {
  const rows = await getClient().execute({
    sql: "SELECT id FROM sales WHERE invoice_group = ? ORDER BY id",
    args: [group]
  });
  for (const r of rows.rows) {
    const id = Number(r.id);
    const q = received ? received[String(id)] : void 0;
    await setSaleStage(id, stage, force, date, q === void 0 ? void 0 : q);
  }
  return { group };
}
async function deleteSaleInvoice(group) {
  const rows = await getClient().execute({
    sql: "SELECT id FROM sales WHERE invoice_group = ?",
    args: [group]
  });
  for (const r of rows.rows) await deleteSale(Number(r.id));
  return { group };
}
async function rejectSaleInvoice(group, reason) {
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new Error("Enter a reason for rejecting this invoice");
  await getClient().execute({
    sql: "UPDATE sales SET rejected_at = datetime('now'), rejected_reason = ? WHERE invoice_group = ?",
    args: [trimmed, group]
  });
  return { group };
}
async function cancelSaleDelivery(group, reason, freightQty) {
  const c = getClient();
  const trimmed = String(reason || "").trim();
  if (!trimmed) throw new Error("Enter why the delivery was cancelled");
  const rows = await c.execute({
    sql: "SELECT id, qty, received_qty FROM sales WHERE invoice_group = ?",
    args: [group]
  });
  if (!rows.rows.length) throw new Error("That invoice no longer exists");
  for (const r of rows.rows) {
    const id = n7(r.id);
    const supplied = freightQty ? freightQty[String(id)] : void 0;
    const assumed = supplied == null ? n7(r.qty) : n7(supplied);
    if (assumed < 0) throw new Error("The freight quantity cannot be negative");
    await c.execute({ sql: "UPDATE sales SET received_qty = ? WHERE id = ?", args: [round23(assumed), id] });
    await recomputeSaleFreight(id);
  }
  await c.execute({
    sql: "UPDATE sales SET rejected_at = datetime('now'), rejected_reason = ? WHERE invoice_group = ?",
    args: [trimmed, group]
  });
  return { group, lines: rows.rows.length };
}
async function unrejectSaleInvoice(group) {
  await getClient().execute({
    sql: "UPDATE sales SET rejected_at = NULL, rejected_reason = NULL WHERE invoice_group = ?",
    args: [group]
  });
  return { group };
}
async function backfillSalesGst() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_gst_backfilled'");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.sale_date, s.invoice_no, s.customer, s.customer_id, s.amount,
           pr.code AS product_code, pr.name AS product_name,
           sb.gst_pct AS bargain_gst, cu.gst_pct AS customer_gst
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    WHERE COALESCE(s.gst_pct, 0) = 0 AND COALESCE(s.gst_amount, 0) = 0
  `);
  let applied = 0;
  for (const r of toPlain9(sales)) {
    const gstPct = n7(r.bargain_gst) > 0 ? n7(r.bargain_gst) : n7(r.customer_gst);
    if (gstPct <= 0) continue;
    const amount = n7(r.amount);
    const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100;
    if (gstAmount <= 0) continue;
    await c.execute({
      sql: "UPDATE sales SET gst_pct = ?, gst_amount = ? WHERE id = ?",
      args: [gstPct, gstAmount, n7(r.id)]
    });
    const code = String(r.product_code || r.product_name || "FG").toUpperCase();
    await postSaleJournal({
      saleId: n7(r.id),
      date: String(r.sale_date),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      productCode: code,
      customerName: String(r.customer || "").trim(),
      amount,
      gst: gstAmount,
      companyId: n7(r.company_id) || 1
    }).catch(() => {
    });
    if (r.customer_id) {
      await postCustomerReceivable(n7(r.id), n7(r.customer_id), amount + gstAmount, String(r.sale_date)).catch(() => {
      });
    }
    applied++;
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_gst_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  );
  if (applied > 0) console.log(`[sales] backfilled output GST on ${applied} sales`);
}
async function backfillExSalesDone() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'ex_sales_done_backfilled'");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  const rows = await c.execute(
    "SELECT id, invoice_no, sale_date FROM sales WHERE COALESCE(freight_term, 'FREIGHT_ON_GOODS') != 'DLD' AND status != 'done' ORDER BY id"
  );
  for (const r of rows.rows) {
    await setSaleStage(n7(r.id), "unloaded", false, String(r.sale_date)).catch(() => setSaleStage(n7(r.id), "unloaded", true, String(r.sale_date))).catch((e) => console.error(`[sales] ex-done sweep failed for #${r.id}:`, e.message));
    console.log(`[sales] ex sale #${r.id} ${r.invoice_no || ""} marked done as of ${r.sale_date}`);
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('ex_sales_done_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  );
  if (rows.rows.length) console.log(`[sales] ex-done sweep completed ${rows.rows.length} sales`);
}
async function backfillSalesRoundOff() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_round_off_backfilled_2'");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.invoice_group, s.sale_date, s.invoice_no, s.customer, s.customer_id,
           s.amount, s.gst_amount, s.round_off, pr.code AS product_code, pr.name AS product_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    ORDER BY s.id ASC
  `);
  const groups = /* @__PURE__ */ new Map();
  for (const r of toPlain9(sales)) {
    const g = String(r.invoice_group || `LEGACY-${r.id}`);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  let applied = 0;
  for (const lines of groups.values()) {
    if (lines.some((l) => Math.abs(n7(l.round_off)) > 4e-3)) continue;
    const raw = Math.round(lines.reduce((s, l) => s + n7(l.amount) + n7(l.gst_amount), 0) * 100) / 100;
    const ro = Math.round((Math.round(raw) - raw) * 100) / 100;
    if (Math.abs(ro) < 5e-3) continue;
    const first = lines[0];
    await c.execute({ sql: "UPDATE sales SET round_off = ? WHERE id = ?", args: [ro, n7(first.id)] });
    const code = String(first.product_code || first.product_name || "FG").toUpperCase();
    await postSaleJournal({
      saleId: n7(first.id),
      date: String(first.sale_date),
      invoiceNo: first.invoice_no ? String(first.invoice_no) : null,
      productCode: code,
      customerName: String(first.customer || "").trim(),
      amount: n7(first.amount),
      gst: n7(first.gst_amount),
      roundOff: ro,
      companyId: n7(first.company_id) || 1
    }).catch(() => {
    });
    if (first.customer_id) {
      await postCustomerReceivable(
        n7(first.id),
        n7(first.customer_id),
        n7(first.amount) + n7(first.gst_amount) + ro,
        String(first.sale_date)
      ).catch(() => {
      });
    }
    applied++;
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_round_off_backfilled_2', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  );
  if (applied > 0) console.log(`[sales] backfilled round off on ${applied} invoices`);
}
async function restateStaleSalesRoundOff() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_round_off_restated_3'");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.invoice_group, s.sale_date, s.invoice_no, s.customer, s.customer_id,
           s.amount, s.gst_amount, s.round_off, s.round_off_manual, pr.code AS product_code, pr.name AS product_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    ORDER BY s.id ASC
  `);
  const groups = /* @__PURE__ */ new Map();
  for (const r of toPlain9(sales)) {
    const g = String(r.invoice_group || `LEGACY-${r.id}`);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  let applied = 0;
  for (const lines of groups.values()) {
    if (lines.some((l) => n7(l.round_off_manual) === 1)) continue;
    const raw = Math.round(lines.reduce((s, l) => s + n7(l.amount) + n7(l.gst_amount), 0) * 100) / 100;
    if (raw <= 0) continue;
    const should = Math.round((Math.round(raw) - raw) * 100) / 100;
    const stored = Math.round(lines.reduce((s, l) => s + n7(l.round_off), 0) * 100) / 100;
    if (Math.abs(stored - should) < 5e-3) continue;
    const first = lines[0];
    await c.execute({ sql: "UPDATE sales SET round_off = ? WHERE id = ?", args: [should, n7(first.id)] });
    for (const l of lines.slice(1)) {
      if (Math.abs(n7(l.round_off)) > 4e-3) {
        await c.execute({ sql: "UPDATE sales SET round_off = 0 WHERE id = ?", args: [n7(l.id)] });
      }
    }
    const code = String(first.product_code || first.product_name || "FG").toUpperCase();
    await postSaleJournal({
      saleId: n7(first.id),
      date: String(first.sale_date),
      invoiceNo: first.invoice_no ? String(first.invoice_no) : null,
      productCode: code,
      customerName: String(first.customer || "").trim(),
      amount: n7(first.amount),
      gst: n7(first.gst_amount),
      roundOff: should,
      companyId: n7(first.company_id) || 1
    }).catch(() => {
    });
    if (first.customer_id) {
      await postCustomerReceivable(
        n7(first.id),
        n7(first.customer_id),
        n7(first.amount) + n7(first.gst_amount) + should,
        String(first.sale_date)
      ).catch(() => {
      });
    }
    applied++;
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_round_off_restated_3', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  );
  if (applied > 0) console.log(`[sales] restated stale round off on ${applied} invoices`);
}
async function backfillSalesBargainCustomers() {
  const c = getClient();
  const rows = await c.execute(
    "SELECT id, customer FROM sales_bargains WHERE customer_id IS NULL AND customer IS NOT NULL"
  );
  if (!rows.rows.length) return;
  const custs = await c.execute("SELECT id, name FROM customers");
  const byName = /* @__PURE__ */ new Map();
  for (const cu of custs.rows) {
    byName.set(String(cu.name || "").trim().toLowerCase(), Number(cu.id));
  }
  let linked = 0;
  for (const r of rows.rows) {
    const id = byName.get(String(r.customer || "").trim().toLowerCase());
    if (!id) continue;
    await c.execute({ sql: "UPDATE sales_bargains SET customer_id = ? WHERE id = ?", args: [id, Number(r.id)] });
    linked++;
  }
  if (linked > 0) console.log(`[sales] linked ${linked} sales bargains to the customer master`);
}
async function cancelInvoiceNo(v) {
  const cid = n7(v?.company_id) || getActiveCompanyId();
  const prefix = String(v?.prefix || "").trim();
  const num2 = n7(v?.number);
  const reason = String(v?.reason || "").trim();
  if (!prefix || !num2) throw new Error("Pick the invoice number to cancel");
  if (!reason) {
    throw new Error("Say why it was cancelled \u2014 a voided number with no reason cannot be checked later");
  }
  const c = getClient();
  const inUse = await c.execute({
    sql: `SELECT invoice_no FROM sales
           WHERE company_id = ?
             AND UPPER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(invoice_no,'')), '/', ''), '-', ''), ' ', ''))
                 = UPPER(REPLACE(REPLACE(REPLACE(? , '/', ''), '-', ''), ' ', ''))
           LIMIT 1`,
    args: [cid, `${prefix}${num2}`]
  });
  if (inUse.rows.length) {
    throw new Error(
      `${String(inUse.rows[0].invoice_no)} is a real invoice \u2014 cancel it from the register instead, so its stock and ledger are reversed too.`
    );
  }
  await c.execute({
    sql: `INSERT INTO cancelled_invoice_nos (company_id, prefix, number, reason, cancelled_on, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, prefix, number) DO UPDATE SET
            reason = excluded.reason, cancelled_on = excluded.cancelled_on, created_by = excluded.created_by`,
    args: [cid, prefix, num2, reason, todayISO(), getCurrentUser().username || null]
  });
  return { prefix, number: num2 };
}
async function uncancelInvoiceNo(v) {
  const cid = n7(v?.company_id) || getActiveCompanyId();
  const prefix = String(v?.prefix || "").trim();
  const num2 = n7(v?.number);
  if (!prefix || !num2) throw new Error("Pick the invoice number");
  await getClient().execute({
    sql: "DELETE FROM cancelled_invoice_nos WHERE company_id = ? AND prefix = ? AND number = ?",
    args: [cid, prefix, num2]
  });
  return { prefix, number: num2 };
}

// src/main/auth.ts
var import_crypto = require("crypto");

// src/main/access.ts
var import_os = __toESM(require("os"));
function toPlain10(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function machineIp() {
  const ifaces = import_os.default.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}
async function isIpAllowed(ip) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT active FROM ip_access WHERE ip = ?", args: [ip] });
  if (!res.rows.length) {
    await c.execute({
      sql: "INSERT INTO ip_access (ip, active, first_seen, last_seen) VALUES (?, 1, datetime('now'), datetime('now'))",
      args: [ip]
    });
    return true;
  }
  await c.execute({ sql: "UPDATE ip_access SET last_seen = datetime('now') WHERE ip = ?", args: [ip] });
  return !!res.rows[0].active;
}
async function recordSession(userId, username, ip) {
  await getClient().execute({
    sql: `INSERT INTO sessions (user_id, username, ip, last_seen) VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(user_id, ip) DO UPDATE SET username = excluded.username, last_seen = datetime('now')`,
    args: [userId, username, ip]
  });
}
async function heartbeat(userId, username) {
  const ip = machineIp();
  const allowed = await isIpAllowed(ip);
  if (!allowed) return { blocked: true };
  await recordSession(userId, username, ip);
  clearAccessCache();
  const res = await getClient().execute({
    sql: "SELECT role, full_name, permissions, active FROM users WHERE id = ? LIMIT 1",
    args: [userId]
  });
  if (!res.rows.length) return { blocked: false, revoked: true };
  const r = res.rows[0];
  if (Number(r.active) === 0) return { blocked: false, revoked: true };
  let permissions = {};
  try {
    permissions = r.permissions ? JSON.parse(String(r.permissions)) : {};
  } catch {
    permissions = {};
  }
  return {
    blocked: false,
    role: String(r.role || ""),
    full_name: String(r.full_name || ""),
    permissions
  };
}
async function liveUsers() {
  const res = await getClient().execute(
    "SELECT * FROM sessions WHERE last_seen >= datetime('now', '-90 seconds') ORDER BY last_seen DESC"
  );
  return toPlain10(res);
}
async function listIps() {
  return toPlain10(await getClient().execute("SELECT * FROM ip_access ORDER BY last_seen DESC"));
}
async function setIpActive(id, active) {
  await getClient().execute({
    sql: "UPDATE ip_access SET active = ? WHERE id = ?",
    args: [active ? 1 : 0, id]
  });
  return { id };
}
async function logEvent(userId, username, ip, action, detail, companyId, entity, entityId, entityKey) {
  await getClient().execute({
    sql: `INSERT INTO user_logs (user_id, username, ip, action, detail, company_id, entity, entity_id, entity_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      userId,
      username,
      ip,
      action,
      detail || null,
      companyId ?? null,
      entity || null,
      entityId ?? null,
      entityKey || null
    ]
  });
}
async function entityHistory(entity, opts = {}) {
  const names = (Array.isArray(entity) ? entity : [entity]).filter(Boolean);
  const id = Number(opts.id) || null;
  const key3 = opts.key ? String(opts.key) : null;
  const detail = opts.detail ? String(opts.detail) : null;
  if (!names.length || !id && !key3 && !detail) return [];
  const match = [];
  const args = [...names];
  if (id) {
    match.push("entity_id = ?");
    args.push(id);
  }
  if (key3) {
    match.push("entity_key = ?");
    args.push(key3);
  }
  if (detail) {
    match.push("(entity_id IS NULL AND entity_key IS NULL AND detail = ?)");
    args.push(detail);
  }
  args.push(Math.min(Math.max(Number(opts.limit) || 200, 1), 500));
  const res = await getClient().execute({
    sql: `SELECT id, created_at, username, ip, action, detail
          FROM user_logs
          WHERE entity IN (${names.map(() => "?").join(",")})
            AND (${match.join(" OR ")})
          ORDER BY id ASC
          LIMIT ?`,
    args
  });
  return toPlain10(res);
}
async function listLogs(filter = {}) {
  const where = [];
  const args = [];
  if (filter.username) {
    const usernames = (Array.isArray(filter.username) ? filter.username : [filter.username]).filter(Boolean);
    if (usernames.length) {
      where.push(`username IN (${usernames.map(() => "?").join(",")})`);
      args.push(...usernames);
    }
  }
  if (filter.entity) {
    const entities = (Array.isArray(filter.entity) ? filter.entity : [filter.entity]).filter(Boolean);
    if (entities.length) {
      where.push(`entity IN (${entities.map(() => "?").join(",")})`);
      args.push(...entities);
    }
  }
  if (filter.action) {
    where.push("action = ?");
    args.push(filter.action);
  }
  if (filter.from) {
    where.push("created_at >= ?");
    args.push(filter.from);
  }
  if (filter.to) {
    where.push("created_at <= ?");
    args.push(`${filter.to} 23:59:59`);
  }
  if (filter.q) {
    where.push("(detail LIKE ? OR entity LIKE ? OR action LIKE ? OR username LIKE ?)");
    const like = `%${filter.q}%`;
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(Math.min(Math.max(Number(filter.limit) || 500, 1), 2e3));
  const rows = toPlain10(
    await getClient().execute({
      sql: `SELECT * FROM user_logs ${whereSql} ORDER BY id DESC LIMIT ?`,
      args
    })
  );
  const u = toPlain10(await getClient().execute("SELECT DISTINCT username FROM user_logs WHERE username IS NOT NULL ORDER BY username"));
  const en = toPlain10(await getClient().execute("SELECT DISTINCT entity FROM user_logs WHERE entity IS NOT NULL AND entity != '' ORDER BY entity"));
  return {
    rows,
    users: u.map((r) => String(r.username)),
    entities: en.map((r) => String(r.entity))
  };
}
async function cleanupLogs() {
  const days = Number(await getSetting("log_retention_days") ?? "30") || 30;
  await getClient().execute({
    sql: `DELETE FROM user_logs WHERE created_at < datetime('now', '-' || ? || ' days')`,
    args: [days]
  });
}

// src/main/auth.ts
function toPlain11(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function hashPassword(pw) {
  const salt = (0, import_crypto.randomBytes)(16).toString("hex");
  const hash = (0, import_crypto.scryptSync)(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const computed = (0, import_crypto.scryptSync)(pw, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === computed.length && (0, import_crypto.timingSafeEqual)(computed, expected);
}
async function seedDefaultAdmin() {
  const c = getClient();
  const res = await c.execute("SELECT COUNT(*) AS n FROM users");
  if (Number(res.rows[0].n) > 0) return;
  await c.execute({
    sql: "INSERT INTO users (username, password_hash, full_name, role, active) VALUES (?, ?, ?, 'admin', 1)",
    args: ["admin", hashPassword("admin123"), "Rishabh Aggarwal"]
  });
  console.log("[auth] seeded default admin (admin / admin123)");
}
async function login(username, password) {
  const ip = machineIp();
  if (!await isIpAllowed(ip)) {
    throw new Error("This device has been blocked by the administrator");
  }
  const res = await getClient().execute({
    sql: "SELECT * FROM users WHERE lower(username) = lower(?) AND active = 1 LIMIT 1",
    args: [username]
  });
  if (!res.rows.length) throw new Error("Invalid username or password");
  const u = toPlain11(res)[0];
  if (!verifyPassword(password, String(u.password_hash))) {
    throw new Error("Invalid username or password");
  }
  await recordSession(Number(u.id), String(u.username), ip);
  setCurrentUser(Number(u.id), String(u.username));
  await logEvent(Number(u.id), String(u.username), ip, "login", null, null, "Session", null);
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    permissions: parsePermissions(u.permissions)
  };
}
function parsePermissions(value) {
  if (!value) return {};
  try {
    const p = JSON.parse(String(value));
    if (Array.isArray(p)) {
      const out = {};
      for (const k of p) out[String(k)] = "write";
      return out;
    }
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
async function listUsers() {
  const res = await getClient().execute(
    "SELECT id, username, full_name, role, active, permissions, created_at FROM users ORDER BY id ASC"
  );
  return toPlain11(res);
}
async function createUser(v) {
  if (!v.username) throw new Error("Username is required");
  if (!v.password) throw new Error("Password is required");
  const args = [
    v.username,
    hashPassword(String(v.password)),
    v.full_name || null,
    v.role || "viewer",
    v.active ? 1 : 0,
    JSON.stringify(v.permissions && typeof v.permissions === "object" ? v.permissions : {})
  ];
  try {
    const res = await getClient().execute({
      sql: "INSERT INTO users (username, password_hash, full_name, role, active, permissions) VALUES (?, ?, ?, ?, ?, ?)",
      args
    });
    return { id: Number(res.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new Error("Username already exists");
    throw e;
  }
}
async function updateUser(id, v) {
  const sets = ["full_name = ?", "role = ?", "active = ?", "permissions = ?"];
  const args = [
    v.full_name || null,
    v.role || "viewer",
    v.active ? 1 : 0,
    JSON.stringify(v.permissions && typeof v.permissions === "object" ? v.permissions : {})
  ];
  if (v.password) {
    sets.push("password_hash = ?");
    args.push(hashPassword(String(v.password)));
  }
  args.push(id);
  await getClient().execute({ sql: `UPDATE users SET ${sets.join(", ")} WHERE id = ?`, args });
  return { id };
}
async function deleteUser(id) {
  await getClient().execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] });
  return { id };
}

// src/main/seed.ts
var PRODUCTS = [
  {
    category: "raw",
    items: [
      "CPO",
      "RPO",
      "RPS",
      "SHEA",
      "MAHUWA",
      "RPL",
      "RPKO",
      "CORN OIL",
      "MUSTARD OIL",
      "SUNFLOWER OIL",
      "SOYABEAN OIL",
      "FATTY ACID",
      "OTHERS"
    ]
  },
  { category: "intermediate", items: ["IVF", "HO-DALDA", "HO-PANGHAT", "FATTY OIL", "RECOVERED OIL"] },
  { category: "finished", items: ["DALDA", "GAGAN", "PANGHAT", "SWAD", "ROYAL", "LOOSE", "OTHERS"] }
];
async function seedProducts() {
  const c = getClient();
  const res = await c.execute("SELECT COUNT(*) AS n FROM products");
  if (Number(res.rows[0].n) > 0) return;
  for (const group of PRODUCTS) {
    for (const name of group.items) {
      await c.execute({
        sql: "INSERT INTO products (code, name, category, active) VALUES (?, ?, ?, 1)",
        args: [name, name, group.category]
      });
    }
  }
  console.log("[seed] products seeded");
}
var RECIPES = [
  { out: "DALDA", items: [["RPS", 23], ["HO-DALDA", 2], ["IVF", 75]] },
  { out: "GAGAN", items: [["RPS", 23], ["HO-DALDA", 2], ["IVF", 75]] },
  { out: "PANGHAT", items: [["RPO", 85], ["HO-PANGHAT", 15]] },
  { out: "SWAD", items: [["RPO", 15], ["HO-PANGHAT", 85]] },
  { out: "ROYAL", items: [["RPS", 23], ["HO-DALDA", 2], ["IVF", 75]] },
  { out: "LOOSE", items: [["RPS", 25], ["SHEA", 70], ["RECOVERED OIL", 5]] },
  { out: "IVF", items: [["RPO", 50], ["RPS", 50]] },
  { out: "HO-DALDA", items: [["RPS", 100]] },
  { out: "HO-PANGHAT", items: [["RPS", 100]] },
  { out: "FATTY OIL", items: [["FATTY ACID", 100]] }
];
var PACKAGINGS = [
  { name: "DALDA JAR 4.2 KG \xD7 4", pouch_label: "Jar", unit_size: 4.2, unit_uom: "KG", pouches_per_box: 4 },
  { name: "DALDA JAR 15 KG \xD7 1", pouch_label: "Jar", unit_size: 15, unit_uom: "KG", pouches_per_box: 1 },
  { name: "DALDA PCH 1 KG \xD7 15", pouch_label: "Pch", unit_size: 1, unit_uom: "KG", pouches_per_box: 15 },
  { name: "GAGAN ND 420 G POUCH \xD7 40", pouch_label: "Pouch", unit_size: 420, unit_uom: "GM", pouches_per_box: 40 },
  { name: "BANSARI NEW PCH 750 G \xD7 20", pouch_label: "Pch", unit_size: 750, unit_uom: "GM", pouches_per_box: 20 },
  { name: "BANSARI PCH 200 ML \xD7 90", pouch_label: "Pch", unit_size: 200, unit_uom: "ML", pouches_per_box: 90 },
  { name: "PANGHAT TIN 15 L \xD7 1", pouch_label: "Tin", unit_size: 15, unit_uom: "L", pouches_per_box: 1 },
  { name: "SWAD BOTTLE 1 L \xD7 12", pouch_label: "Bottle", unit_size: 1, unit_uom: "L", pouches_per_box: 12 }
];
async function seedPackagings() {
  const c = getClient();
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sample_packagings_seeded' LIMIT 1");
  if (done.rows.length && String(done.rows[0].value) === "1") return;
  let added = 0;
  for (const p of PACKAGINGS) {
    const exists = await c.execute({
      sql: "SELECT 1 FROM packagings WHERE upper(name) = upper(?) LIMIT 1",
      args: [p.name]
    });
    if (exists.rows.length) continue;
    const u = p.unit_uom;
    const baseUom = u === "ML" || u === "L" ? "L" : "KG";
    const perPouch = u === "GM" || u === "ML" ? p.unit_size / 1e3 : p.unit_size;
    const basePerPouch = Math.round(perPouch * 1e6) / 1e6;
    await c.execute({
      sql: `INSERT INTO packagings (name, box_label, pouch_label, pouches_per_box, unit_size, unit_uom, base_per_pouch, base_uom, active)
            VALUES (?, 'Case', ?, ?, ?, ?, ?, ?, 1)`,
      args: [p.name, p.pouch_label, p.pouches_per_box, p.unit_size, p.unit_uom, basePerPouch, baseUom]
    });
    added++;
  }
  await c.execute("INSERT INTO app_settings (key, value) VALUES ('sample_packagings_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  console.log(`[seed] sample packagings seeded (${added} added)`);
}
async function findProductId(name) {
  const res = await getClient().execute({
    sql: "SELECT id FROM products WHERE upper(name) = upper(?) LIMIT 1",
    args: [name]
  });
  return res.rows.length ? Number(res.rows[0].id) : null;
}
async function ensureProductId(name, category) {
  const existing = await findProductId(name);
  if (existing) return existing;
  const res = await getClient().execute({
    sql: "INSERT INTO products (code, name, category, active) VALUES (?, ?, ?, 1)",
    args: [name, name, category]
  });
  return Number(res.lastInsertRowid);
}
async function seedFormulations() {
  const c = getClient();
  const res = await c.execute("SELECT COUNT(*) AS n FROM formulations");
  if (Number(res.rows[0].n) > 0) return;
  await ensureProductId("RECOVERED OIL", "intermediate");
  for (const r of RECIPES) {
    const outId = await findProductId(r.out);
    if (!outId) continue;
    const ins = await c.execute({
      sql: "INSERT INTO formulations (product_id, name, uom, active) VALUES (?, NULL, 'ton', 1)",
      args: [outId]
    });
    const fid = Number(ins.lastInsertRowid);
    for (const [name, pct] of r.items) {
      const pid = await ensureProductId(name, "raw");
      await c.execute({
        sql: "INSERT INTO formulation_items (formulation_id, product_id, qty) VALUES (?, ?, ?)",
        args: [fid, pid, pct]
      });
    }
  }
  console.log("[seed] formulations seeded");
}

// src/main/bootstrap.ts
async function runStartupTasks() {
  await initDb();
  await runOnce("journal_backfill_v1", () => backfillJournal()).catch(
    (e) => console.error("[journal] backfill failed:", e)
  );
  await backfillSalesGst().catch((e) => console.error("[sales] GST backfill failed:", e));
  await backfillSalesRoundOff().catch((e) => console.error("[sales] round-off backfill failed:", e));
  await restateStaleSalesRoundOff().catch((e) => console.error("[sales] round-off restatement failed:", e));
  await backfillExSalesDone().catch((e) => console.error("[sales] ex-done sweep failed:", e));
  dailyBackup().catch((e) => console.error("[backup] daily backup failed:", e));
  await backfillSalesBargainCustomers().catch((e) => console.error("[sales] bargain-customer link failed:", e));
  await runOnce("order_status_sync_v1", () => backfillOrderStatuses()).catch(
    (e) => console.error("[orders] status backfill failed:", e)
  );
  await backfillPurchaseRoundOff().catch((e) => console.error("[orders] round-off repair failed:", e));
  await seedDefaultAdmin().catch((e) => console.error("[auth] seed failed:", e));
  await seedProducts().catch((e) => console.error("[seed] products failed:", e));
  await seedFormulations().catch((e) => console.error("[seed] formulations failed:", e));
  await seedPackagings().catch((e) => console.error("[seed] packagings failed:", e));
  await runDaily("cleanup_logs", () => cleanupLogs()).catch(() => {
  });
  await runOnce("stock_openings_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      product_id INTEGER NOT NULL REFERENCES products(id),
      as_of TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      rate REAL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, product_id)
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_stock_openings_co ON stock_openings(company_id)");
  }).catch((e) => console.error("[stock] opening-stock table failed:", e));
  await runOnce("stock_openings_pp_v1", async () => {
    await getClient().execute("ALTER TABLE stock_openings ADD COLUMN pp_qty REAL NOT NULL DEFAULT 0").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[stock] opening pp column failed:", e));
  await runOnce("stock_openings_adj_v1", async () => {
    await getClient().execute("ALTER TABLE stock_openings ADD COLUMN adj_qty REAL NOT NULL DEFAULT 0").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[stock] opening adjustment column failed:", e));
  await runOnce("products_uom_v1", async () => {
    const c = getClient();
    await c.execute("ALTER TABLE products ADD COLUMN uom TEXT NOT NULL DEFAULT 'MT'").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
    await c.execute({
      sql: "UPDATE products SET uom = 'PCS' WHERE TRIM(name) = ? AND uom <> 'PCS'",
      args: ["CARTON,POUCH,500MLX32,DALDA"]
    });
  }).catch((e) => console.error("[products] measuring-unit column failed:", e));
  await runOnce("sku_openings_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS sku_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      packaging_id INTEGER NOT NULL REFERENCES packagings(id),
      as_of TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, packaging_id)
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_sku_openings_co ON sku_openings(company_id)").catch(() => {
    });
  }).catch((e) => console.error("[stock] packed-SKU opening table failed:", e));
  await runOnce("formulation_subcategory_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS formulation_subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await c.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_fsubcat_name ON formulation_subcategories(UPPER(TRIM(name)))"
    );
    try {
      await c.execute("ALTER TABLE formulations ADD COLUMN subcategory_id INTEGER REFERENCES formulation_subcategories(id)");
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
    for (const [i, name] of ["recovered-oil", "fatty-oil-based", "rps"].entries()) {
      await c.execute({
        sql: `INSERT INTO formulation_subcategories (name, sort_order)
              SELECT ?, ? WHERE NOT EXISTS (
                SELECT 1 FROM formulation_subcategories WHERE UPPER(TRIM(name)) = UPPER(TRIM(?))
              )`,
        args: [name, i, name]
      });
    }
  }).catch((e) => console.error("[formulations] subcategory setup failed:", e));
  await runOnce("cancelled_invoice_nos_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS cancelled_invoice_nos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      prefix TEXT NOT NULL,
      number INTEGER NOT NULL,
      reason TEXT,
      cancelled_on TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, prefix, number)
    )`);
    await c.execute(
      "CREATE INDEX IF NOT EXISTS idx_cancinv_co ON cancelled_invoice_nos(company_id, prefix)"
    );
  }).catch((e) => console.error("[sales] cancelled-invoice table failed:", e));
  await runOnce("lc_interest_excl_charges_v1", async () => {
    const c = getClient();
    const info = await c.execute({ sql: "PRAGMA table_info('letters_of_credit')", args: [] });
    const cols = new Set(info.rows.map((r) => String(r.name)));
    if (cols.has("interest_excl_charges")) return;
    if (cols.has("interest_on_charges")) {
      await c.execute(
        "ALTER TABLE letters_of_credit RENAME COLUMN interest_on_charges TO interest_excl_charges"
      );
      return;
    }
    await c.execute(
      "ALTER TABLE letters_of_credit ADD COLUMN interest_excl_charges INTEGER NOT NULL DEFAULT 0"
    );
  }).catch((e) => console.error("[lc] interest-base column failed:", e));
  await runOnce("lc_interest_adj_v1", async () => {
    const c = getClient();
    const info = await c.execute({ sql: "PRAGMA table_info('letters_of_credit')", args: [] });
    const cols = new Set(info.rows.map((r) => String(r.name)));
    if (cols.has("interest_adj")) return;
    await c.execute("ALTER TABLE letters_of_credit ADD COLUMN interest_adj REAL NOT NULL DEFAULT 0");
  }).catch((e) => console.error("[lc] interest-adjustment column failed:", e));
  await runOnce("bd_days_incl_start_v1", async () => {
    const c = getClient();
    for (const table of ["nbfcs", "bill_discountings"]) {
      const info = await c.execute({ sql: `PRAGMA table_info('${table}')`, args: [] });
      const cols = new Set(info.rows.map((r) => String(r.name)));
      if (cols.has("days_incl_start")) continue;
      await c.execute(`ALTER TABLE ${table} ADD COLUMN days_incl_start INTEGER NOT NULL DEFAULT 0`);
    }
  }).catch((e) => console.error("[bd] receipt-date basis column failed:", e));
  await runOnce("ulogs_entity_index_v1", async () => {
    const c = getClient();
    await c.execute("CREATE INDEX IF NOT EXISTS idx_ulogs_entity_id ON user_logs(entity, entity_id)");
    await c.execute("DROP INDEX IF EXISTS idx_ulogs_entity");
    await c.execute("CREATE INDEX IF NOT EXISTS idx_stransfers_to ON stock_transfers(to_company_id, product_id)");
    await c.execute("CREATE INDEX IF NOT EXISTS idx_stransfers_from ON stock_transfers(from_company_id, product_id)");
  }).catch((e) => console.error("[logs] history index failed:", e));
  await runOnce("ulogs_entity_key_v1", async () => {
    const c = getClient();
    await c.execute("ALTER TABLE user_logs ADD COLUMN entity_key TEXT");
    await c.execute("CREATE INDEX IF NOT EXISTS idx_ulogs_entity_key ON user_logs(entity, entity_key)");
  }).catch((e) => console.error("[logs] entity key failed:", e));
  await runOnce("gate_entry_sales_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS gate_entry_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_entry_id INTEGER NOT NULL REFERENCES gate_entries(id),
      invoice_group TEXT NOT NULL,
      sale_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(gate_entry_id, invoice_group)
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_ges_entry ON gate_entry_sales(gate_entry_id)");
    await c.execute("CREATE INDEX IF NOT EXISTS idx_ges_group ON gate_entry_sales(invoice_group)");
    await c.execute(`INSERT OR IGNORE INTO gate_entry_sales (gate_entry_id, invoice_group, sale_id)
      SELECT g.id, g.invoice_group, g.sale_id FROM gate_entries g
      WHERE g.invoice_group IS NOT NULL AND g.invoice_group <> ''`);
  }).catch((e) => console.error("[gate] invoice links failed:", e));
  await runOnce("bd_payment_in_v1", async () => {
    const c = getClient();
    await c.execute("ALTER TABLE bill_discountings ADD COLUMN receivable_party_id INTEGER");
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_linked_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, order_id)
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_bd_linked_orders_bd ON bd_linked_orders(bd_id)");
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_payment_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      pay_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_bd_payment_ins_bd ON bd_payment_ins(bd_id)");
  }).catch((e) => console.error("[bd] payment-in schema failed:", e));
  await runOnce("bd_limits_v1", async () => {
    const c = getClient();
    await c.execute("ALTER TABLE nbfcs ADD COLUMN sanctioned_limit REAL NOT NULL DEFAULT 0");
    await c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_nbfcs_company_name ON nbfcs(company_id, TRIM(LOWER(name)))");
  }).catch((e) => console.error("[bd] limits schema failed:", e));
  await runOnce("bd_parties_reshape_v1", async () => {
    const c = getClient();
    const info = await c.execute({ sql: "PRAGMA table_info('bd_parties')", args: [] });
    const cols = new Set(info.rows.map((r) => String(r.name)));
    if (cols.size === 0 || cols.has("bd_id")) return;
    const count = await c.execute("SELECT COUNT(*) AS n FROM bd_parties");
    const n25 = Number(count.rows[0].n);
    if (n25 > 0) {
      console.error(`[bd] bd_parties has the retired party+entries shape AND ${n25} row(s) \u2014 leaving it for a human`);
      return;
    }
    await c.execute("DROP TABLE IF EXISTS bd_entries");
    await c.execute("DROP TABLE bd_parties");
  }).catch((e) => console.error("[bd] party-table reshape failed:", e));
  await runOnce("bd_tables_repair_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS bill_discountings (
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
      receivable_party_id INTEGER,
      invoice_amount REAL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    for (const sql of [
      "ALTER TABLE bill_discountings ADD COLUMN days_year REAL NOT NULL DEFAULT 360",
      "ALTER TABLE bill_discountings ADD COLUMN invoice_amount REAL",
      "ALTER TABLE bill_discountings ADD COLUMN receivable_party_id INTEGER"
    ]) {
      await c.execute(sql).catch(() => {
      });
    }
    for (const sql of [
      "CREATE INDEX IF NOT EXISTS idx_bd_company ON bill_discountings(company_id)",
      "CREATE INDEX IF NOT EXISTS idx_bd_nbfc ON bill_discountings(nbfc_id)",
      "CREATE INDEX IF NOT EXISTS idx_bd_company_status ON bill_discountings(company_id, status)"
    ]) {
      await c.execute(sql).catch(() => {
      });
    }
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_repayments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      repay_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      journal_entry_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_bd_repay_bd ON bd_repayments(bd_id)").catch(() => {
    });
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      amount REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, party_id)
    )`);
    await c.execute("ALTER TABLE bd_parties ADD COLUMN amount REAL").catch(() => {
    });
    await c.execute("CREATE INDEX IF NOT EXISTS idx_bd_parties_bd ON bd_parties(bd_id)").catch(() => {
    });
    await c.execute(`INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id)
      SELECT id, party_type, party_id FROM bill_discountings WHERE party_id IS NOT NULL`).catch(() => {
    });
    console.log("[bd] tables checked/restored");
  }).catch((e) => console.error("[bd] table repair failed:", e));
  await runOnce("bd_parties_v1", async () => {
    const c = getClient();
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, party_id)
    )`);
    await c.execute("CREATE INDEX IF NOT EXISTS idx_bd_parties_bd ON bd_parties(bd_id)");
    await c.execute(`INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id)
      SELECT id, party_type, party_id FROM bill_discountings WHERE party_id IS NOT NULL`);
  }).catch((e) => console.error("[bd] parties schema failed:", e));
  await runOnce("bd_party_amount_v1", async () => {
    const c = getClient();
    await c.execute("ALTER TABLE bd_parties ADD COLUMN amount REAL NOT NULL DEFAULT 0").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[bd] party split failed:", e));
  await runOnce("sales_shortage_v1", async () => {
    const c = getClient();
    for (const t of ["sales", "sales_bargains"]) {
      await c.execute(`ALTER TABLE ${t} ADD COLUMN allowed_shortage_pct REAL`).catch((e) => {
        if (!/duplicate column/i.test(String(e.message))) throw e;
      });
    }
  }).catch((e) => console.error("[sales] shortage allowance failed:", e));
  await runOnce("sku_adj_kind_v1", async () => {
    const c = getClient();
    for (const col of ["kind TEXT", "created_by TEXT"]) {
      await c.execute(`ALTER TABLE sku_adjustments ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e.message))) throw e;
      });
    }
  }).catch((e) => console.error("[sku] adjustment kind failed:", e));
  await runOnce("order_rate_round_v1", async () => {
    await getClient().execute("ALTER TABLE orders ADD COLUMN rate_round_off REAL").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[orders] rate rounding failed:", e));
  await runOnce("tledger_note_v1", async () => {
    await getClient().execute("ALTER TABLE transporter_ledger ADD COLUMN note_id INTEGER").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[freight] penalty note link failed:", e));
  await runOnce("tledger_company_idx_v1", async () => {
    await getClient().execute(
      "CREATE INDEX IF NOT EXISTS idx_tl_company_type ON transporter_ledger(company_id, entry_type)"
    );
  }).catch((e) => console.error("[freight] ledger index failed:", e));
  await runOnce("tledger_waived_v1", async () => {
    const c = getClient();
    for (const col of ["waived_at TEXT", "waived_by TEXT", "waived_reason TEXT", "waived_entry_id INTEGER"]) {
      await c.execute(`ALTER TABLE transporter_ledger ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e.message))) throw e;
      });
    }
  }).catch((e) => console.error("[freight] waiver columns failed:", e));
  await runOnce("gate_date_idx_v1", async () => {
    await getClient().execute("CREATE INDEX IF NOT EXISTS idx_gate_date ON gate_entries(entry_date)");
  }).catch((e) => console.error("[gate] date index failed:", e));
  await runOnce("lc_charges_je_v1", async () => {
    await getClient().execute("ALTER TABLE letters_of_credit ADD COLUMN charges_journal_entry_id INTEGER").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[lc] charges journal column failed:", e));
  await runOnce("lc_preclose_payout_je_v1", async () => {
    await getClient().execute("ALTER TABLE letters_of_credit ADD COLUMN preclose_payout_journal_entry_id INTEGER").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[lc] preclose payout column failed:", e));
  await runOnce("lc_fee_je_v1", async () => {
    await getClient().execute("ALTER TABLE lc_repayments ADD COLUMN fee_journal_entry_id INTEGER").catch((e) => {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    });
  }).catch((e) => console.error("[lc] fee journal column failed:", e));
  await runOnce("ledger_openings_v1", async () => {
    await getClient().execute(`CREATE TABLE IF NOT EXISTS ledger_openings (
      company_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      dr REAL NOT NULL DEFAULT 0,
      cr REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (company_id, account_id)
    )`);
  }).catch((e) => console.error("[openings] table failed:", e));
  startRevisionWatcher();
}

// src/main/unmapped.ts
function toPlain12(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const k of res.columns) o[k] = r[k];
    return o;
  });
}
var n8 = (v) => Number(v) || 0;
var EPS = 1e-3;
var COVERED = `
  COALESCE((SELECT SUM(pt.loaded_qty) FROM purchase_tankers pt
            JOIN bargains b2 ON b2.id = pt.bargain_id
            WHERE pt.order_id = o.id), 0)`;
var UNMAPPED_WHERE = `
  COALESCE(o.is_trading, 0) = 0 AND
  CASE WHEN o.is_consignment = 1 THEN
    (o.bargain_id IS NULL OR NOT EXISTS (SELECT 1 FROM bargains b WHERE b.id = o.bargain_id))
    AND NOT EXISTS (SELECT 1 FROM consignment_stock cs JOIN bargains b3 ON b3.id = cs.bargain_id
                    WHERE cs.order_id = o.id)
  ELSE
    ${COVERED} < o.ordered_qty - 0.001
  END`;
async function listUnmappedOrders() {
  const res = await getClient().execute({
    sql: `SELECT o.id, o.invoice_no, o.order_date, o.supplier_id, o.oil_type_id, o.ordered_qty, o.uom,
                 o.bargain_rate, o.invoice_rate, o.adjusted_rate, o.taxable_value, o.net_amount,
                 o.gst_pct, o.is_consignment, o.status, o.bargain_id, o.remarks,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
                 (SELECT COALESCE(SUM(pt.loaded_qty), 0) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_qty,
                 (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos,
                 (SELECT COUNT(*) FROM consignment_stock cs WHERE cs.order_id = o.id) AS lot_count,
                 CASE WHEN o.bargain_id IS NOT NULL THEN 1 ELSE 0 END AS was_linked,
                 COALESCE((SELECT SUM(pt.loaded_qty) FROM purchase_tankers pt
                           JOIN bargains b2 ON b2.id = pt.bargain_id
                           WHERE pt.order_id = o.id), 0) AS covered_qty
          FROM orders o
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ? AND ${UNMAPPED_WHERE}
          ORDER BY o.order_date DESC, o.id DESC`,
    args: [getActiveCompanyId()]
  });
  return toPlain12(res);
}
async function unmappedCount() {
  const res = await getClient().execute({
    sql: `SELECT COUNT(*) AS q FROM orders o WHERE o.company_id = ? AND ${UNMAPPED_WHERE}`,
    args: [getActiveCompanyId()]
  });
  return n8(res.rows[0]?.q);
}
async function bargainBalance(id) {
  const r = await getClient().execute({
    sql: `SELECT b.qty,
            COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0)
            + COALESCE((SELECT SUM(o2.ordered_qty) FROM orders o2 WHERE o2.bargain_id = b.id AND o2.is_consignment = 1
                AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.order_id = o2.id)), 0)
            + COALESCE((SELECT SUM(qty - COALESCE(extra_qty, 0)) FROM consignment_stock WHERE bargain_id = b.id AND order_id IS NOT NULL), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM consignment_stock WHERE extra_bargain_id = b.id AND order_id IS NOT NULL), 0)
          AS used
          FROM bargains b WHERE b.id = ? LIMIT 1`,
    args: [id]
  });
  if (!r.rows.length) throw new Error("That bargain no longer exists");
  const qty = n8(r.rows[0].qty);
  const used = n8(r.rows[0].used);
  return { qty, used, balance: qty - used };
}
function spread(carriers, lines) {
  const out = [];
  let li = 0;
  let left = lines.length ? n8(lines[0].qty) : 0;
  for (const car of carriers) {
    let need = n8(car.qty);
    const parts = [];
    while (need > EPS) {
      while (left <= EPS && li < lines.length - 1) {
        li++;
        left = n8(lines[li].qty);
      }
      if (left <= EPS) throw new Error("The bargain quantities do not cover every tanker on this invoice");
      const take = Math.min(need, left);
      parts.push({ bargain_id: n8(lines[li].bargain_id), qty: take });
      need -= take;
      left -= take;
    }
    if (parts.length > 2) {
      throw new Error(
        `${car.label} would be split across ${parts.length} bargains \u2014 a tanker can hold at most two, so split the invoice differently`
      );
    }
    out.push({
      id: car.id,
      bargain_id: parts[0]?.bargain_id || 0,
      extra_bargain_id: parts[1]?.bargain_id ?? null,
      extra_qty: parts[1] ? parts[1].qty : null
    });
  }
  return out;
}
async function mapOrderToBargains(orderId, rawLines, force = false) {
  const c = getClient();
  const ord = await c.execute({ sql: "SELECT * FROM orders WHERE id = ? LIMIT 1", args: [orderId] });
  if (!ord.rows.length) throw new Error("That purchase invoice no longer exists");
  const order = toPlain12(ord)[0];
  const merged = /* @__PURE__ */ new Map();
  for (const l of Array.isArray(rawLines) ? rawLines : []) {
    const bid = n8(l.bargain_id);
    const qty = n8(l.qty);
    if (!bid || qty <= 0) continue;
    const cur = merged.get(bid) || { bargain_id: bid, qty: 0, top_up: false };
    cur.qty += qty;
    cur.top_up = cur.top_up || !!l.top_up;
    merged.set(bid, cur);
  }
  const lines = Array.from(merged.values());
  if (!lines.length) throw new Error("Add at least one bargain with a quantity");
  const orderedQty = n8(order.ordered_qty);
  const allocated = lines.reduce((s, l) => s + l.qty, 0);
  if (Math.abs(allocated - orderedQty) > EPS) {
    throw new Error(
      `The bargain quantities add up to ${allocated.toFixed(3)} but the invoice is for ${orderedQty.toFixed(3)} ${order.uom || "MT"}`
    );
  }
  const toppedUp = [];
  let bargainValue = 0;
  for (const l of lines) {
    const b = await c.execute({
      sql: "SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom FROM bargains WHERE id = ? LIMIT 1",
      args: [l.bargain_id]
    });
    if (!b.rows.length) throw new Error("One of the chosen bargains no longer exists");
    const bg = toPlain12(b)[0];
    if (n8(bg.supplier_id) !== n8(order.supplier_id)) {
      throw new Error(`Bargain ${bg.bargain_no} belongs to a different supplier`);
    }
    if (n8(bg.oil_type_id) !== n8(order.oil_type_id)) {
      throw new Error(`Bargain ${bg.bargain_no} is for a different product`);
    }
    const { balance } = await bargainBalance(l.bargain_id);
    if (l.qty > balance + EPS) {
      const short = l.qty - balance;
      if (!l.top_up) {
        throw new Error(
          `Bargain ${bg.bargain_no} has only ${balance.toFixed(3)} ${order.uom || "MT"} left \u2014 ${short.toFixed(3)} short. Tick "add the shortfall to the bargain" to raise it.`
        );
      }
      await adjustBargainQty(
        l.bargain_id,
        short,
        `Raised while mapping invoice ${order.invoice_no}`,
        String(order.order_date)
      );
      toppedUp.push({ bargain_no: String(bg.bargain_no), qty: short });
    }
    bargainValue += n8(bg.rate_per_uom) * l.qty;
  }
  const valueDiff = n8(order.taxable_value) - bargainValue;
  if (Math.abs(valueDiff) > 1 && !force) {
    throw new Error(
      `VALUE_MISMATCH:${valueDiff.toFixed(2)}:${bargainValue.toFixed(2)}:${n8(order.taxable_value).toFixed(2)}`
    );
  }
  const isConsignment = n8(order.is_consignment) === 1;
  if (isConsignment) {
    const lots = await c.execute({
      sql: "SELECT id, qty, tanker_no FROM consignment_stock WHERE order_id = ? ORDER BY deposit_date, id",
      args: [orderId]
    });
    if (lots.rows.length) {
      const alloc = spread(
        toPlain12(lots).map((r) => ({ id: n8(r.id), qty: n8(r.qty), label: `Tanker ${r.tanker_no || r.id}` })),
        lines
      );
      for (const a of alloc) {
        await c.execute({
          sql: "UPDATE consignment_stock SET bargain_id = ?, extra_bargain_id = ?, extra_qty = ? WHERE id = ?",
          args: [a.bargain_id, a.extra_bargain_id, a.extra_qty, a.id]
        });
      }
    } else if (lines.length > 1) {
      throw new Error(
        "This consignment invoice has no tankers logged against it, so it can only be mapped to a single bargain"
      );
    }
  } else {
    const tk = await c.execute({
      sql: "SELECT id, loaded_qty, tanker_no FROM purchase_tankers WHERE order_id = ? ORDER BY loaded_date, id",
      args: [orderId]
    });
    const carriers = toPlain12(tk).map((r) => ({
      id: n8(r.id),
      qty: n8(r.loaded_qty),
      label: `Tanker ${r.tanker_no || r.id}`
    }));
    const covered = carriers.reduce((s, x) => s + x.qty, 0);
    if (covered < orderedQty - EPS) {
      let short = orderedQty - covered;
      let skip = covered;
      for (const l of lines) {
        if (short <= EPS) break;
        let share = l.qty;
        if (skip > EPS) {
          const used = Math.min(skip, share);
          skip -= used;
          share -= used;
        }
        if (share <= EPS) continue;
        const take = Math.min(share, short);
        const res = await c.execute({
          sql: `INSERT INTO purchase_tankers
                  (company_id, order_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id,
                   loaded_qty, received_qty, uom, payment_mode, status, empty_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'we_pay', 'empty', ?)`,
          args: [
            n8(order.company_id) || getActiveCompanyId(),
            orderId,
            order.tanker_no ? String(order.tanker_no) : `MAP/${order.invoice_no}`,
            order.order_date,
            l.bargain_id,
            n8(order.supplier_id),
            n8(order.oil_type_id),
            take,
            take,
            order.uom || "MT",
            order.order_date
          ]
        });
        carriers.push({ id: Number(res.lastInsertRowid), qty: take, label: `Tanker MAP/${order.invoice_no}` });
        short -= take;
      }
    }
    const alloc = spread(carriers, lines);
    for (const a of alloc) {
      await c.execute({
        sql: "UPDATE purchase_tankers SET bargain_id = ?, extra_bargain_id = ?, extra_qty = ? WHERE id = ?",
        // purchase_tankers.extra_qty is NOT NULL, so an unsplit tanker gets 0.
        args: [a.bargain_id, a.extra_bargain_id, a.extra_qty ?? 0, a.id]
      });
    }
  }
  await c.execute({
    sql: "UPDATE orders SET bargain_id = ? WHERE id = ?",
    args: [lines[0].bargain_id, orderId]
  });
  return { id: orderId, bargain_id: lines[0].bargain_id, valueDiff, toppedUp };
}

// src/main/trading.ts
function toPlain13(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n9(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round24 = (v) => Math.round(v * 100) / 100;
function todayISO3() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function dealLineIds(dealIds, deals) {
  const orders = /* @__PURE__ */ new Map();
  const sales = /* @__PURE__ */ new Map();
  if (!dealIds.length) return { orders, sales };
  const c = getClient();
  const list2 = dealIds.join(",");
  const [oRes, sRes] = await Promise.all([
    c.execute(`SELECT deal_id, order_id FROM trading_deal_orders WHERE deal_id IN (${list2}) ORDER BY line_no, id`),
    c.execute(`SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${list2}) ORDER BY line_no, id`)
  ]);
  for (const r of toPlain13(oRes)) {
    const k = n9(r.deal_id);
    orders.set(k, [...orders.get(k) ?? [], n9(r.order_id)]);
  }
  for (const r of toPlain13(sRes)) {
    const k = n9(r.deal_id);
    sales.set(k, [...sales.get(k) ?? [], n9(r.sale_id)]);
  }
  for (const d of deals) {
    const id = n9(d.id);
    if (!orders.has(id) && n9(d.order_id)) orders.set(id, [n9(d.order_id)]);
    if (!sales.has(id) && n9(d.sale_id)) sales.set(id, [n9(d.sale_id)]);
  }
  return { orders, sales };
}
async function fetchOrderLines(ids) {
  const m = /* @__PURE__ */ new Map();
  if (!ids.length) return m;
  const res = await getClient().execute(
    `SELECT o.id, o.invoice_no, o.order_date, o.invoice_rate, o.ordered_qty, o.uom,
            o.taxable_value, o.gst_amount, o.gst_pct, o.gst_type, o.tds_pct, o.tds_amount,
            o.round_off, o.net_amount, o.supplier_id, s.name AS supplier_name
     FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.id IN (${ids.join(",")})`
  );
  for (const r of toPlain13(res)) m.set(n9(r.id), r);
  return m;
}
async function fetchSaleLines(ids) {
  const m = /* @__PURE__ */ new Map();
  if (!ids.length) return m;
  const res = await getClient().execute(
    `SELECT sl.id, sl.invoice_no, sl.invoice_group, sl.sale_date, sl.rate, sl.qty, sl.uom, sl.amount,
            sl.gst_pct, sl.gst_type, sl.gst_amount, sl.round_off, sl.tds_pct, sl.tds_amount,
            sl.customer_id, cu.name AS customer_name
     FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
     WHERE sl.id IN (${ids.join(",")})`
  );
  for (const r of toPlain13(res)) m.set(n9(r.id), r);
  return m;
}
function saleRefKey(l) {
  return String(l.invoice_group || l.invoice_no || "").trim();
}
async function saleReceiptsByKey(companyId) {
  const res = await getClient().execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amount
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ? AND COALESCE(ba.sale_invoice_group, ba.ref_name) IS NOT NULL
          GROUP BY key`,
    args: [companyId]
  });
  const m = /* @__PURE__ */ new Map();
  for (const r of toPlain13(res)) m.set(String(r.key), n9(r.amount));
  return m;
}
function groupSaleParties(sLines, receiptsByKey) {
  const order = [];
  const byParty = /* @__PURE__ */ new Map();
  for (const l of sLines) {
    const cid = n9(l.customer_id);
    if (!byParty.has(cid)) {
      byParty.set(cid, []);
      order.push(cid);
    }
    ;
    byParty.get(cid).push(l);
  }
  return order.map((cid) => {
    const ls = byParty.get(cid);
    const first = ls[0] ?? {};
    const qty = ls.reduce((a, l) => a + n9(l.qty), 0);
    const taxable = ls.reduce((a, l) => a + n9(l.amount), 0);
    const gstAmount = ls.reduce((a, l) => a + n9(l.gst_amount), 0);
    const roundOff = ls.reduce((a, l) => a + n9(l.round_off), 0);
    const tdsAmount = ls.reduce((a, l) => a + n9(l.tds_amount), 0);
    const total = round24(taxable + gstAmount + roundOff);
    const keys = Array.from(new Set(ls.map((l) => saleRefKey(l)).filter(Boolean)));
    const netReceivable = round24(total - tdsAmount);
    const paid = round24(keys.reduce((a, k) => a + (receiptsByKey.get(k) || 0), 0));
    return {
      customer_id: cid || null,
      customer_name: first.customer_name ?? null,
      invoice_count: ls.length,
      qty,
      rate: qty > 0 ? ls.reduce((a, l) => a + n9(l.qty) * n9(l.rate), 0) / qty : 0,
      taxable: round24(taxable),
      gst_pct: n9(first.gst_pct),
      gst_type: first.gst_type ?? "CGST_SGST",
      gst_amount: round24(gstAmount),
      round_off: round24(roundOff),
      total,
      tds_pct: n9(first.tds_pct),
      tds_amount: round24(tdsAmount),
      net_receivable: netReceivable,
      paid,
      fully_paid: netReceivable > 5e-3 && paid >= netReceivable - 5e-3,
      lines: ls.map((l) => ({
        sale_id: n9(l.id),
        invoice_no: l.invoice_no ?? "",
        qty: n9(l.qty),
        rate: n9(l.rate)
      }))
    };
  });
}
async function listTradingDeals(forModule) {
  const from = await visibleFromFor("trading", forModule);
  const cid = getActiveCompanyId();
  const res = await getClient().execute({
    sql: `SELECT td.*, p.code AS product_code, p.name AS product_name,
                 l.lc_no AS lc_no, l.stage AS lc_stage, l.preclosed_date AS lc_preclosed_date,
                 l.expiry_date AS lc_expiry_date, l.amount AS lc_amount
          FROM trading_deals td
          LEFT JOIN products p ON p.id = td.product_id
          LEFT JOIN letters_of_credit l ON l.id = td.lc_id
          WHERE td.company_id = ?${from ? " AND td.deal_date >= ?" : ""}
          ORDER BY td.deal_date DESC, td.id DESC`,
    args: from ? [cid, from] : [cid]
  });
  const deals = toPlain13(res);
  const dealIds = deals.map((d) => n9(d.id)).filter(Boolean);
  const { orders, sales } = await dealLineIds(dealIds, deals);
  const [orderRows, saleRows, receiptsByKey] = await Promise.all([
    fetchOrderLines(Array.from(new Set(Array.from(orders.values()).flat()))),
    fetchSaleLines(Array.from(new Set(Array.from(sales.values()).flat()))),
    saleReceiptsByKey(cid)
  ]);
  return deals.map((d) => {
    const id = n9(d.id);
    const pLines = (orders.get(id) ?? []).map((oid) => orderRows.get(oid)).filter(Boolean);
    const sLines = (sales.get(id) ?? []).map((sid) => saleRows.get(sid)).filter(Boolean);
    const purchaseQty = pLines.reduce((s, l) => s + n9(l.ordered_qty), 0);
    const saleQty = sLines.reduce((s, l) => s + n9(l.qty), 0);
    const purchaseTotal = pLines.reduce(
      (s, l) => s + n9(l.taxable_value) + n9(l.gst_amount) + n9(l.round_off),
      0
    );
    const saleNet = sLines.reduce((s, l) => s + n9(l.amount) + n9(l.gst_amount) + n9(l.round_off), 0);
    const purchaseTaxable = pLines.reduce((s, l) => s + n9(l.taxable_value), 0);
    const saleTaxable = sLines.reduce((s, l) => s + n9(l.amount), 0);
    const marginOnTaxable = round24(saleTaxable - purchaseTaxable);
    const marginPct = purchaseTaxable > 0 ? round24(marginOnTaxable / purchaseTaxable * 100) : 0;
    const first = pLines[0] ?? {};
    const firstSale = sLines[0] ?? {};
    const avg = (total, qty) => qty > 0 ? total / qty : 0;
    const saleNetReceivable = round24(saleNet - sLines.reduce((s, l) => s + n9(l.tds_amount), 0));
    const saleKeys = Array.from(new Set(sLines.map((l) => saleRefKey(l)).filter(Boolean)));
    const salePaid = round24(saleKeys.reduce((s, k) => s + (receiptsByKey.get(k) || 0), 0));
    const saleFullyPaid = saleNetReceivable > 5e-3 && salePaid >= saleNetReceivable - 5e-3;
    const saleParties = groupSaleParties(sLines, receiptsByKey);
    const lcBankRepaid = !!d.lc_preclosed_date;
    return {
      ...d,
      purchase_lines: pLines.map((l) => ({
        order_id: n9(l.id),
        invoice_no: l.invoice_no ?? "",
        qty: n9(l.ordered_qty),
        rate: n9(l.invoice_rate)
      })),
      sale_lines: sLines.map((l) => ({
        sale_id: n9(l.id),
        invoice_no: l.invoice_no ?? "",
        qty: n9(l.qty),
        rate: n9(l.rate),
        // Which buyer this invoice went to, so a flat list of the deal's sale
        // invoices can still say who each one was raised on.
        customer_id: l.customer_id ?? null,
        customer_name: l.customer_name ?? null
      })),
      sale_parties: saleParties,
      customer_count: saleParties.length,
      // Every buyer's name, for a list column and for search. The singular
      // `customer_name` below stays the FIRST buyer, because that is what the
      // LC and Bill Discounting pickers already read off a deal.
      customer_names: saleParties.map((sp) => sp.customer_name).filter(Boolean),
      purchase_count: pLines.length,
      sale_count: sLines.length,
      purchase_invoice_no: first.invoice_no ?? "",
      sale_invoice_no: firstSale.invoice_no ?? "",
      purchase_qty: purchaseQty,
      sale_qty: saleQty,
      purchase_uom: first.uom || "MT",
      purchase_rate: avg(pLines.reduce((s, l) => s + n9(l.ordered_qty) * n9(l.invoice_rate), 0), purchaseQty),
      sale_rate: avg(sLines.reduce((s, l) => s + n9(l.qty) * n9(l.rate), 0), saleQty),
      supplier_id: first.supplier_id ?? null,
      supplier_name: first.supplier_name ?? null,
      customer_id: firstSale.customer_id ?? null,
      customer_name: firstSale.customer_name ?? null,
      purchase_gst_pct: n9(first.gst_pct),
      purchase_gst_type: first.gst_type ?? "CGST_SGST",
      purchase_tds_pct: n9(first.tds_pct),
      purchase_round_off: pLines.reduce((s, l) => s + n9(l.round_off), 0),
      sale_gst_pct: n9(firstSale.gst_pct),
      sale_gst_type: firstSale.gst_type ?? "CGST_SGST",
      sale_tds_pct: n9(firstSale.tds_pct),
      sale_tds_amount: sLines.reduce((s, l) => s + n9(l.tds_amount), 0),
      sale_net_receivable: saleNetReceivable,
      sale_paid: salePaid,
      sale_fully_paid: saleFullyPaid,
      lc_bank_repaid: lcBankRepaid,
      // Both sides of the round trip are done: the bank has been repaid on
      // the LC, and the customer's money for the resale has actually come in.
      trading_lc_closed: !!d.lc_id && lcBankRepaid && saleFullyPaid,
      sale_round_off: sLines.reduce((s, l) => s + n9(l.round_off), 0),
      purchase_taxable: pLines.reduce((s, l) => s + n9(l.taxable_value), 0),
      purchase_gst_amount: pLines.reduce((s, l) => s + n9(l.gst_amount), 0),
      purchase_tds_amount: pLines.reduce((s, l) => s + n9(l.tds_amount), 0),
      // What is actually paid to the supplier across every invoice on the deal.
      purchase_net: pLines.reduce((s, l) => s + n9(l.net_amount), 0),
      sale_amount: sLines.reduce((s, l) => s + n9(l.amount), 0),
      sale_gst_amount: sLines.reduce((s, l) => s + n9(l.gst_amount), 0),
      purchase_total: purchaseTotal,
      sale_net: saleNet,
      margin: marginOnTaxable,
      margin_pct: marginPct,
      // Both sides should move the same quantity; the form warns rather than
      // refuses, so a deal can sit part-sold until the rest is invoiced.
      qty_matched: Math.abs(purchaseQty - saleQty) < 1e-6
    };
  });
}
function toLines(raw, at, emptyMsg) {
  const arr = Array.isArray(raw) ? raw : [];
  const lines = arr.map((l) => {
    const r = l ?? {};
    return {
      invoiceNo: r.invoice_no ? String(r.invoice_no).trim() : "",
      qty: n9(r.qty),
      rate: n9(r.rate)
    };
  }).filter((l) => l.invoiceNo !== "" || l.qty !== 0 || l.rate !== 0);
  if (!lines.length) throw new Error(emptyMsg);
  lines.forEach((l, i) => {
    if (l.qty <= 0) throw new Error(`${at(i)}: enter the quantity`);
    if (l.rate <= 0) throw new Error(`${at(i)}: enter the rate`);
  });
  return lines;
}
function toSaleParties(v) {
  const raw = Array.isArray(v.sale_parties) ? v.sale_parties : [];
  const groups = raw.length ? raw : [
    {
      customer_id: v.customer_id,
      gst_pct: v.sale_gst_pct,
      gst_type: v.sale_gst_type,
      tds_pct: v.sale_tds_pct,
      round_off: v.sale_round_off,
      lines: v.sale_lines
    }
  ];
  const live = groups.filter((g) => {
    const ls = Array.isArray(g?.lines) ? g.lines : [];
    const anyLine = ls.some(
      (l) => String(l?.invoice_no ?? "").trim() !== "" || n9(l?.qty) !== 0 || n9(l?.rate) !== 0
    );
    return n9(g?.customer_id) > 0 || anyLine;
  });
  if (!live.length) throw new Error("Pick the customer");
  const multi = live.length > 1;
  const parties = live.map((g, gi) => {
    const label = multi ? `Buyer ${gi + 1}` : "Sale";
    if (!n9(g?.customer_id)) {
      throw new Error(multi ? `${label}: pick the customer` : "Pick the customer");
    }
    return {
      customerId: n9(g.customer_id),
      gstPct: n9(g.gst_pct),
      gstType: g.gst_type === "IGST" ? "IGST" : "CGST_SGST",
      tdsPct: n9(g.tds_pct),
      roundOff: n9(g.round_off),
      lines: toLines(g.lines, (i) => `${label} invoice ${i + 1}`, `${label}: add at least one sale invoice`)
    };
  });
  const seen = /* @__PURE__ */ new Set();
  for (const p of parties) {
    if (seen.has(p.customerId)) {
      throw new Error("The same customer is listed twice \u2014 put all of that buyer's invoices under one entry");
    }
    seen.add(p.customerId);
  }
  return parties;
}
function dealFields(v) {
  const productId = n9(v.product_id);
  if (!productId) throw new Error("Select the raw product");
  if (!v.supplier_id) throw new Error("Pick the supplier");
  const uom = String(v.uom || "MT");
  const dealDate = v.deal_date ? String(v.deal_date).slice(0, 10) : todayISO3();
  const purchaseLines = toLines(
    v.purchase_lines,
    (i) => `Purchase invoice ${i + 1}`,
    "Add at least one purchase invoice"
  );
  const saleParties = toSaleParties(v);
  assertNoRepeatsWithin(purchaseLines.map((l) => l.invoiceNo), "Purchase invoice");
  assertNoRepeatsWithin(saleParties.flatMap((sp) => sp.lines.map((l) => l.invoiceNo)), "Invoice");
  const orderPayloads = purchaseLines.map((l) => ({
    is_trading: true,
    invoice_no: l.invoiceNo,
    order_date: dealDate,
    supplier_id: n9(v.supplier_id),
    oil_type_id: productId,
    ordered_qty: l.qty,
    uom,
    invoice_rate: l.rate,
    bargain_rate: l.rate,
    gst_pct: n9(v.purchase_gst_pct),
    gst_type: v.purchase_gst_type === "IGST" ? "IGST" : "CGST_SGST",
    tds_pct: n9(v.purchase_tds_pct),
    // Round-off is entered once for the deal and belongs to it as a whole, so
    // it rides on the first invoice rather than being repeated on each.
    round_off: 0,
    // A trading deal is a clean pass-through — no interest block here, even
    // if the supplier's master carries a default.
    charge_interest: false
  }));
  if (orderPayloads.length) orderPayloads[0].round_off = n9(v.purchase_round_off);
  const salePayloads = saleParties.flatMap(
    (sp) => sp.lines.map((l, i) => ({
      is_trading: true,
      invoice_no: l.invoiceNo || null,
      sale_date: dealDate,
      customer_id: sp.customerId,
      product_id: productId,
      qty: l.qty,
      uom,
      rate: l.rate,
      gst_pct: sp.gstPct,
      gst_type: sp.gstType,
      tds_pct: sp.tdsPct,
      // Round off belongs to a buyer's own invoice total, so it rides that
      // buyer's first invoice — not the deal's, which would round one party's
      // bill by another party's paisa.
      round_off: i === 0 ? sp.roundOff : 0,
      sale_type: "LOOSE",
      freight_term: "EX"
    }))
  );
  return { productId, uom, dealDate, orderPayloads, salePayloads };
}
async function assertDealNumbersFree(orderPayloads, salePayloads, ownOrders = [], ownSales = []) {
  const cid = getActiveCompanyId();
  for (const p of orderPayloads) {
    await assertPurchaseInvoiceNoFree({ ...p, invoice_dup_exclude_ids: ownOrders }, cid);
  }
  for (const p of salePayloads) {
    await assertSalesInvoiceNoFree({ ...p, invoice_dup_exclude_ids: ownSales }, cid);
  }
}
async function createTradingDeal(v) {
  const { productId, dealDate, orderPayloads, salePayloads } = dealFields(v);
  await assertDealNumbersFree(orderPayloads, salePayloads);
  const orderIds = [];
  const saleIds = [];
  const rollback = async () => {
    for (const sid of saleIds) await deleteSale(sid).catch(() => {
    });
    for (const oid of orderIds) await deleteOrder(oid).catch(() => {
    });
  };
  try {
    const settled = await Promise.allSettled([
      (async () => {
        for (const p of orderPayloads) orderIds.push((await createOrder(p)).id);
      })(),
      (async () => {
        for (const p of salePayloads) saleIds.push((await createSale(p)).id);
      })()
    ]);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  } catch (e) {
    await rollback();
    throw e;
  }
  const c = getClient();
  let dealId;
  try {
    const ins = await c.execute({
      sql: `INSERT INTO trading_deals (company_id, deal_date, product_id, order_id, sale_id, note)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        getActiveCompanyId(),
        dealDate,
        productId,
        orderIds[0],
        saleIds[0],
        v.note ? String(v.note).trim() : null
      ]
    });
    dealId = Number(ins.lastInsertRowid);
    await linkDealLines(dealId, orderIds, saleIds);
  } catch (e) {
    await rollback();
    throw e;
  }
  return { id: dealId };
}
async function linkDealLines(dealId, orderIds, saleIds) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM trading_deal_orders WHERE deal_id = ?", args: [dealId] });
  await c.execute({ sql: "DELETE FROM trading_deal_sales WHERE deal_id = ?", args: [dealId] });
  for (let i = 0; i < orderIds.length; i++) {
    await c.execute({
      sql: "INSERT INTO trading_deal_orders (deal_id, order_id, line_no) VALUES (?, ?, ?)",
      args: [dealId, orderIds[i], i]
    });
  }
  for (let i = 0; i < saleIds.length; i++) {
    await c.execute({
      sql: "INSERT INTO trading_deal_sales (deal_id, sale_id, line_no) VALUES (?, ?, ?)",
      args: [dealId, saleIds[i], i]
    });
  }
}
async function updateTradingDeal(id, v) {
  const c = getClient();
  const cur = await c.execute({
    sql: "SELECT id, order_id, sale_id FROM trading_deals WHERE id = ?",
    args: [id]
  });
  if (!cur.rows.length) throw new Error("Trading deal not found");
  const deal = toPlain13(cur)[0];
  const { orders, sales } = await dealLineIds([id], [deal]);
  const existingOrders = orders.get(id) ?? [];
  const existingSales = sales.get(id) ?? [];
  const { productId, dealDate, orderPayloads, salePayloads } = dealFields(v);
  const ownOrders = [...existingOrders];
  const ownSales = [...existingSales];
  await assertDealNumbersFree(orderPayloads, salePayloads, ownOrders, ownSales);
  const orderIds = [];
  for (let i = 0; i < orderPayloads.length; i++) {
    const p = { ...orderPayloads[i], invoice_dup_exclude_ids: ownOrders };
    if (i < existingOrders.length) {
      await updateOrder(existingOrders[i], p);
      orderIds.push(existingOrders[i]);
    } else {
      orderIds.push((await createOrder(p)).id);
    }
  }
  const saleIds = [];
  for (let i = 0; i < salePayloads.length; i++) {
    const p = { ...salePayloads[i], invoice_dup_exclude_ids: ownSales };
    if (i < existingSales.length) {
      await updateSale(existingSales[i], p);
      saleIds.push(existingSales[i]);
    } else {
      saleIds.push((await createSale(p)).id);
    }
  }
  await c.execute({
    sql: "UPDATE trading_deals SET deal_date = ?, product_id = ?, order_id = ?, sale_id = ?, note = ? WHERE id = ?",
    args: [dealDate, productId, orderIds[0], saleIds[0], v.note ? String(v.note).trim() : null, id]
  });
  await linkDealLines(id, orderIds, saleIds);
  for (const sid of existingSales.slice(salePayloads.length)) await deleteSale(sid);
  for (const oid of existingOrders.slice(orderPayloads.length)) await deleteOrder(oid);
  return { id };
}
async function linkTradingDealsToLc(lcId, dealIds) {
  const c = getClient();
  const ids = Array.isArray(dealIds) ? dealIds.map((x) => n9(x)).filter((x) => x > 0) : [];
  await c.execute({
    sql: `UPDATE trading_deals SET lc_id = NULL WHERE lc_id = ? AND id NOT IN (${ids.length ? ids.join(",") : "0"})`,
    args: [lcId]
  });
  for (const id of ids) {
    await c.execute({ sql: "UPDATE trading_deals SET lc_id = ? WHERE id = ?", args: [lcId, id] });
  }
}
async function deleteTradingDeal(id) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT id, order_id, sale_id FROM trading_deals WHERE id = ?",
    args: [id]
  });
  if (!res.rows.length) throw new Error("Trading deal not found");
  const deal = toPlain13(res)[0];
  const { orders, sales } = await dealLineIds([id], [deal]);
  await c.execute({ sql: "DELETE FROM trading_deal_orders WHERE deal_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM trading_deal_sales WHERE deal_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM trading_deals WHERE id = ?", args: [id] });
  for (const sid of sales.get(id) ?? []) await deleteSale(sid);
  for (const oid of orders.get(id) ?? []) await deleteOrder(oid);
  return { id };
}

// src/main/skurates.ts
function toPlain14(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const k of res.columns) o[k] = r[k];
    return o;
  });
}
var n10 = (v) => Number(v) || 0;
async function listSkuRates(salesBargainId) {
  const c = getClient();
  const bg = await c.execute({
    sql: "SELECT id, bargain_no, product_id, rate, uom, customer_id FROM sales_bargains WHERE id = ? LIMIT 1",
    args: [salesBargainId]
  });
  if (!bg.rows.length) throw new Error("That sales bargain no longer exists");
  const productId = n10(bg.rows[0].product_id);
  const customerId = n10(bg.rows[0].customer_id);
  const res = await c.execute({
    sql: `SELECT pk.id AS packaging_id, pk.name, pk.unit_size, pk.unit_uom,
                 pk.base_per_pouch, pk.base_uom, pk.pouches_per_box, pk.product_id,
                 r.rate_per_case, r.rate_per_mt, r.updated_at
          FROM packagings pk
          LEFT JOIN sales_bargain_sku_rates r
            ON r.packaging_id = pk.id AND r.sales_bargain_id = ?
          WHERE pk.active = 1 AND (? = 0 OR pk.product_id IS NULL OR pk.product_id = ?)
          ORDER BY pk.name`,
    args: [salesBargainId, productId, productId]
  });
  let rows = toPlain14(res);
  const keepsRate = (r) => r.rate_per_case != null || r.rate_per_mt != null;
  const claimedRes = await c.execute("SELECT packaging_id, customer_id FROM packaging_parties");
  const claimedBy = /* @__PURE__ */ new Map();
  for (const r of claimedRes.rows) {
    const pid = Number(r.packaging_id);
    const set = claimedBy.get(pid) || /* @__PURE__ */ new Set();
    set.add(Number(r.customer_id));
    claimedBy.set(pid, set);
  }
  const linked = /* @__PURE__ */ new Set();
  if (customerId) {
    for (const [pid, set] of claimedBy) if (set.has(customerId)) linked.add(pid);
  }
  rows = rows.map((r) => {
    const pid = Number(r.packaging_id);
    const owners = claimedBy.get(pid);
    return {
      ...r,
      party_linked: linked.has(pid) ? 1 : 0,
      // Nobody's exclusive — offered to anyone.
      free: owners && owners.size ? 0 : 1,
      claimed_by: owners ? owners.size : 0
    };
  });
  if (customerId) {
    if (linked.size) {
      const own = rows.filter((r) => n10(r.party_linked) === 1 || keepsRate(r));
      if (own.length) rows = own;
    } else {
      const free = rows.filter((r) => n10(r.free) === 1 || keepsRate(r));
      if (free.length) rows = free;
    }
  }
  return rows;
}
async function packagingPartyCounts() {
  const res = await getClient().execute(
    `SELECT pp.packaging_id, COUNT(*) AS parties,
            GROUP_CONCAT(cu.name, ', ') AS names
     FROM packaging_parties pp
     LEFT JOIN customers cu ON cu.id = pp.customer_id
     GROUP BY pp.packaging_id`
  );
  return res.rows.map((r) => ({
    packaging_id: Number(r.packaging_id),
    parties: Number(r.parties),
    names: String(r.names || "")
  }));
}
async function listPackagingParties(packagingId) {
  const res = await getClient().execute({
    sql: "SELECT customer_id FROM packaging_parties WHERE packaging_id = ?",
    args: [packagingId]
  });
  return res.rows.map((r) => Number(r.customer_id));
}
async function setPackagingParties(packagingId, customerIds) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM packaging_parties WHERE packaging_id = ?", args: [packagingId] });
  const ids = Array.from(new Set((customerIds || []).map(Number).filter((x) => x > 0)));
  for (const cid of ids) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO packaging_parties (packaging_id, customer_id) VALUES (?, ?)",
      args: [packagingId, cid]
    });
  }
  return { count: ids.length };
}
async function saveSkuRates(salesBargainId, rows) {
  const c = getClient();
  const bg = await c.execute({
    sql: "SELECT id FROM sales_bargains WHERE id = ? LIMIT 1",
    args: [salesBargainId]
  });
  if (!bg.rows.length) throw new Error("That sales bargain no longer exists");
  let saved = 0;
  let cleared = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = raw;
    const pid = n10(r.packaging_id);
    if (!pid) continue;
    const perCase = r.rate_per_case === "" || r.rate_per_case == null ? null : n10(r.rate_per_case);
    const perMt = r.rate_per_mt === "" || r.rate_per_mt == null ? null : n10(r.rate_per_mt);
    if ((perCase == null || perCase <= 0) && (perMt == null || perMt <= 0)) {
      const del = await c.execute({
        sql: "DELETE FROM sales_bargain_sku_rates WHERE sales_bargain_id = ? AND packaging_id = ?",
        args: [salesBargainId, pid]
      });
      cleared += del.rowsAffected || 0;
      continue;
    }
    await c.execute({
      sql: `INSERT INTO sales_bargain_sku_rates (sales_bargain_id, packaging_id, rate_per_case, rate_per_mt, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT (sales_bargain_id, packaging_id)
            DO UPDATE SET rate_per_case = excluded.rate_per_case,
                          rate_per_mt = excluded.rate_per_mt,
                          updated_at = datetime('now')`,
      args: [salesBargainId, pid, perCase, perMt]
    });
    saved++;
  }
  return { saved, cleared };
}

// src/main/formulations.ts
function toPlain15(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n11(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
async function listFormulations() {
  const res = await getClient().execute(`
    SELECT f.*, p.name AS product_name, p.category AS product_category,
      sc.name AS subcategory_name,
      (SELECT COUNT(*) FROM formulation_items WHERE formulation_id = f.id) AS item_count,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'input') AS blend_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'output') AS byproduct_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id AND kind = 'loss') AS loss_pct,
      (SELECT COALESCE(SUM(qty), 0) FROM formulation_items WHERE formulation_id = f.id) AS total_qty
    FROM formulations f
    LEFT JOIN products p ON p.id = f.product_id
    LEFT JOIN formulation_subcategories sc ON sc.id = f.subcategory_id
    ORDER BY f.id DESC
  `);
  const rows = toPlain15(res);
  if (!rows.length) return rows;
  const itemsRes = await getClient().execute(
    `SELECT formulation_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id
     FROM formulation_items WHERE formulation_id IN (${rows.map((r) => n11(r.id)).join(",")})`
  );
  const itemsByFormulation = /* @__PURE__ */ new Map();
  for (const it of toPlain15(itemsRes)) {
    const fid = n11(it.formulation_id);
    if (!itemsByFormulation.has(fid)) itemsByFormulation.set(fid, []);
    itemsByFormulation.get(fid).push(it);
  }
  return rows.map((r) => ({ ...r, tor: recipeTor(itemsByFormulation.get(n11(r.id)) || []) }));
}
async function getFormulationItems(formulationId) {
  const res = await getClient().execute({
    sql: `SELECT i.*, p.name AS product_name, p.category AS product_category
          FROM formulation_items i
          LEFT JOIN products p ON p.id = i.product_id
          WHERE i.formulation_id = ?
          ORDER BY i.id`,
    args: [formulationId]
  });
  return toPlain15(res);
}
async function writeItems(formulationId, items) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM formulation_items WHERE formulation_id = ?", args: [formulationId] });
  for (const it of items || []) {
    const pid = n11(it.product_id);
    if (!pid) continue;
    const kind = it.kind === "output" || it.kind === "loss" ? String(it.kind) : "input";
    const autoCalc = it.auto_calc ? 1 : 0;
    await c.execute({
      sql: `INSERT INTO formulation_items (formulation_id, product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        formulationId,
        pid,
        n11(it.qty),
        kind,
        autoCalc,
        autoCalc && it.ffa_pct != null && it.ffa_pct !== "" ? n11(it.ffa_pct) : null,
        autoCalc && it.loss_multiplier_pct != null && it.loss_multiplier_pct !== "" ? n11(it.loss_multiplier_pct) : null,
        autoCalc && it.moisture_pct != null && it.moisture_pct !== "" ? n11(it.moisture_pct) : null,
        autoCalc && kind === "input" && n11(it.byproduct_product_id) ? n11(it.byproduct_product_id) : null
      ]
    });
  }
}
async function createFormulation(v) {
  const res = await getClient().execute({
    sql: "INSERT INTO formulations (product_id, name, uom, subcategory_id, active) VALUES (?, ?, ?, ?, 1)",
    args: [n11(v.product_id), v.name || null, v.uom || "MT", n11(v.subcategory_id) || null]
  });
  const id = Number(res.lastInsertRowid);
  await writeItems(id, v.items);
  return { id };
}
async function updateFormulation(id, v) {
  await getClient().execute({
    sql: "UPDATE formulations SET product_id = ?, name = ?, uom = ?, subcategory_id = ? WHERE id = ?",
    args: [n11(v.product_id), v.name || null, v.uom || "MT", n11(v.subcategory_id) || null, id]
  });
  await writeItems(id, v.items);
  return { id };
}
async function deleteFormulation(id) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM formulation_items WHERE formulation_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM formulations WHERE id = ?", args: [id] });
  return { id };
}
async function listFormulationSubcategories() {
  const res = await getClient().execute(`
    SELECT sc.*,
      (SELECT COUNT(*) FROM formulations f WHERE f.subcategory_id = sc.id) AS in_use
    FROM formulation_subcategories sc
    ORDER BY sc.active DESC, sc.sort_order, UPPER(TRIM(sc.name))
  `);
  return toPlain15(res);
}
async function saveFormulationSubcategory(v) {
  const name = String(v?.name || "").trim();
  if (!name) throw new Error("Give the sub-category a name");
  const c = getClient();
  const id = n11(v?.id);
  const clash = await c.execute({
    sql: `SELECT id, name FROM formulation_subcategories
           WHERE UPPER(TRIM(name)) = UPPER(TRIM(?)) AND id <> ?`,
    args: [name, id]
  });
  if (clash.rows.length) {
    throw new Error(`"${String(clash.rows[0].name)}" already exists \u2014 one name per sub-category.`);
  }
  if (id) {
    await c.execute({
      sql: "UPDATE formulation_subcategories SET name = ?, note = ?, active = ? WHERE id = ?",
      args: [name, v?.note ? String(v.note).trim() : null, v?.active === false ? 0 : 1, id]
    });
    return { id };
  }
  const res = await c.execute({
    sql: `INSERT INTO formulation_subcategories (name, note, sort_order, active)
          VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM formulation_subcategories), 1)`,
    args: [name, v?.note ? String(v.note).trim() : null]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function deleteFormulationSubcategory(id) {
  const c = getClient();
  const used = await c.execute({
    sql: "SELECT COUNT(*) AS c FROM formulations WHERE subcategory_id = ?",
    args: [n11(id)]
  });
  const count = n11(used.rows[0].c);
  if (count > 0) {
    throw new Error(
      `${count} ${count === 1 ? "recipe uses" : "recipes use"} this sub-category. Retire it instead, or move those recipes first \u2014 deleting it would leave them classified as nothing.`
    );
  }
  await c.execute({ sql: "DELETE FROM formulation_subcategories WHERE id = ?", args: [n11(id)] });
  return { id: n11(id) };
}

// src/main/stockopenings.ts
function toPlain16(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var n12 = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
var r3 = (v) => Math.round(v * 1e3) / 1e3;
var r2 = (v) => Math.round(v * 100) / 100;
async function stockOpeningDate(companyId) {
  const cid = n12(companyId) || getActiveCompanyId();
  const existing = await getClient().execute({
    sql: "SELECT as_of FROM stock_openings WHERE company_id = ? ORDER BY as_of LIMIT 1",
    args: [cid]
  });
  if (existing.rows.length) return String(existing.rows[0].as_of).slice(0, 10);
  const books = await getBooksFrom(cid);
  return books ? String(books).slice(0, 10) : "";
}
async function listStockOpenings(companyId) {
  const cid = n12(companyId) || getActiveCompanyId();
  const c = getClient();
  const asOf = await stockOpeningDate(cid);
  const [saved, levels, rates, dupes] = await Promise.all([
    c.execute({
      sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                   COALESCE(adj_qty, 0) AS adj_qty, rate, as_of, note
            FROM stock_openings WHERE company_id = ?`,
      args: [cid]
    }),
    stockLevels(asOf ? { from: asOf } : void 0, [cid]),
    productValuationRates().catch(() => /* @__PURE__ */ new Map()),
    duplicateProductNames()
  ]);
  const savedBy = /* @__PURE__ */ new Map();
  for (const r of toPlain16(saved)) savedBy.set(n12(r.product_id), r);
  const rows = levels.map((p) => {
    const id = n12(p.id);
    const s = savedBy.get(id);
    const entered = s ? n12(s.qty) : null;
    const pp = s ? n12(s.pp_qty) : null;
    const adj = s ? n12(s.adj_qty) : null;
    const fromMovement = r3(n12(p.stock) - n12(p.opening));
    const closing = r3(fromMovement + n12(entered) + n12(pp) + n12(adj));
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      material_type: p.material_type,
      active: p.active,
      // What is saved against this product today (null = never entered).
      // Counted in three parts, the way the plant counts it: what is in the
      // tank, what is already in process, and the correction between the dip
      // and the card. The register opens at the total of all three.
      qty: entered,
      pp_qty: pp,
      adj_qty: adj,
      total: entered == null && pp == null && adj == null ? null : r3(n12(entered) + n12(pp) + n12(adj)),
      rate: s && s.rate != null ? n12(s.rate) : null,
      note: s?.note ?? null,
      // Movement-only closing: what the register would say with no opening at
      // all. Negative here is precisely the hole an opening has to fill.
      movement_closing: fromMovement,
      shortfall: fromMovement < 0 ? r3(-fromMovement) : 0,
      closing,
      suggested_rate: r2(rates.get(id) || 0)
    };
  });
  const totalValue = rows.reduce(
    (t, r) => t + (n12(r.qty) + n12(r.pp_qty) + n12(r.adj_qty)) * n12(r.rate),
    0
  );
  return {
    company_id: cid,
    as_of: asOf,
    books_from: await getBooksFrom(cid) || null,
    rows,
    entered_count: rows.filter((r) => r.qty != null || r.pp_qty != null || r.adj_qty != null).length,
    total_raw: r3(rows.reduce((t, r) => t + n12(r.qty), 0)),
    total_pp: r3(rows.reduce((t, r) => t + n12(r.pp_qty), 0)),
    total_adj: r3(rows.reduce((t, r) => t + n12(r.adj_qty), 0)),
    total_qty: r3(rows.reduce((t, r) => t + n12(r.qty) + n12(r.pp_qty) + n12(r.adj_qty), 0)),
    negative_count: rows.filter((r) => n12(r.movement_closing) < -5e-4).length,
    still_negative: rows.filter((r) => n12(r.closing) < -5e-4).length,
    total_value: r2(totalValue),
    // Two products may legitimately share a name — RPO exists as both a raw
    // oil and a finished one — so this is a warning to label them, never a
    // prompt to merge them. Merging would collapse the two into one line and
    // lose the distinction between what is bought and what is made.
    name_clashes: dupes
  };
}
async function duplicateProductNames() {
  const res = await getClient().execute({
    sql: `SELECT UPPER(TRIM(REPLACE(REPLACE(name, '.', ''), '  ', ' '))) AS k,
                 COUNT(*) AS c,
                 GROUP_CONCAT(id) AS ids,
                 GROUP_CONCAT(name, ' | ') AS names,
                 GROUP_CONCAT(COALESCE(category, ''), ' | ') AS categories,
                 GROUP_CONCAT(COALESCE(code, '-'), ' | ') AS codes
            FROM products
           GROUP BY k HAVING COUNT(*) > 1
           ORDER BY k`,
    args: []
  });
  return toPlain16(res).map((r) => {
    const cats = String(r.categories || "").split(" | ");
    return {
      key: r.k,
      count: n12(r.c),
      ids: String(r.ids || "").split(",").map(Number),
      names: String(r.names || "").split(" | "),
      codes: String(r.codes || "").split(" | "),
      categories: cats,
      // Same name AND same category is the one that may really be a duplicate.
      // Different categories means two different goods that need distinct
      // names, which is a labelling job, not a merge.
      same_category: new Set(cats).size === 1
    };
  });
}
async function saveStockOpenings(rows, asOf, companyId) {
  const cid = n12(companyId) || getActiveCompanyId();
  const date = String(asOf || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pick the date this opening is struck on");
  const c = getClient();
  let saved = 0;
  let cleared = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const pid = n12(raw?.product_id ?? raw?.id);
    if (!pid) continue;
    const rawBlank = raw?.qty === "" || raw?.qty == null;
    const ppBlank = raw?.pp_qty === "" || raw?.pp_qty == null;
    const adjBlank = raw?.adj_qty === "" || raw?.adj_qty == null;
    const blank = rawBlank && ppBlank && adjBlank;
    if (blank) {
      const res = await c.execute({
        sql: "DELETE FROM stock_openings WHERE company_id = ? AND product_id = ?",
        args: [cid, pid]
      });
      if (Number(res.rowsAffected) > 0) cleared++;
      continue;
    }
    const qty = n12(raw.qty);
    const pp = n12(raw.pp_qty);
    const adj = n12(raw.adj_qty);
    const rate = raw?.rate === "" || raw?.rate == null ? null : n12(raw.rate);
    await c.execute({
      sql: `INSERT INTO stock_openings (company_id, product_id, as_of, qty, pp_qty, adj_qty, rate, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(company_id, product_id) DO UPDATE SET
              as_of = excluded.as_of,
              qty = excluded.qty,
              pp_qty = excluded.pp_qty,
              adj_qty = excluded.adj_qty,
              rate = excluded.rate,
              note = excluded.note,
              updated_at = datetime('now')`,
      args: [cid, pid, date, qty, pp, adj, rate, raw?.note ? String(raw.note).trim() : null]
    });
    saved++;
  }
  await seedOpeningDayCount(cid, date);
  return { saved, cleared };
}
async function seedOpeningDayCount(companyId, date) {
  const c = getClient();
  const rows = toPlain16(
    await c.execute({
      sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                   COALESCE(adj_qty, 0) AS adj_qty, rate
            FROM stock_openings WHERE company_id = ? AND as_of = ?`,
      args: [companyId, date]
    })
  );
  for (const r of rows) {
    await c.execute({
      sql: `INSERT INTO stock_counts (company_id, count_date, product_id, actual_qty, pp_qty, rate, note)
              VALUES (?, ?, ?, ?, ?, ?, 'Opening stock')
              ON CONFLICT(company_id, count_date, product_id) DO UPDATE SET
                actual_qty = excluded.actual_qty,
                pp_qty = excluded.pp_qty,
                rate = COALESCE(excluded.rate, stock_counts.rate),
                note = 'Opening stock'`,
      // The correction rides on the tank figure here rather than getting a
      // column of its own: what this sheet has to say is what was PHYSICALLY
      // there, and the corrected tank figure is that. Splitting it out again
      // would only invite a second reconciliation of a number already
      // reconciled.
      args: [
        companyId,
        date,
        n12(r.product_id),
        r3(n12(r.qty) + n12(r.adj_qty)),
        n12(r.pp_qty),
        r.rate == null ? null : n12(r.rate)
      ]
    }).catch((e) => console.error("[stock] opening-day count seed failed:", e.message));
  }
}

// src/main/stockcount.ts
function n13(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
async function stockCountSheet(date) {
  const levels = await stockLevels();
  const rates = await productValuationRates();
  const saved = await getClient().execute({
    sql: "SELECT * FROM stock_counts WHERE count_date = ? AND company_id = ?",
    args: [date, getActiveCompanyId()]
  });
  const byProduct = /* @__PURE__ */ new Map();
  for (const r of saved.rows) byProduct.set(Number(r.product_id), r);
  return levels.map((l) => {
    const s = byProduct.get(Number(l.id));
    const rate = s && s.rate != null && Number(s.rate) > 0 ? Number(s.rate) : rates.get(Number(l.id)) || 0;
    const actualQty = s && s.actual_qty != null ? Number(s.actual_qty) : null;
    return {
      product_id: l.id,
      code: l.code,
      name: l.name,
      category: l.category,
      book_qty: l.stock,
      rate,
      book_value: (Number(l.stock) || 0) * rate,
      actual_qty: actualQty,
      actual_value: actualQty != null ? actualQty * rate : null,
      // PP — presentation stock, counted next to the physical figure.
      pp_qty: s && s.pp_qty != null ? Number(s.pp_qty) : null,
      note: s ? s.note : null
    };
  });
}
async function previousStockCount(date) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const prev = await c.execute({
    sql: `SELECT MAX(count_date) AS d FROM stock_counts
          WHERE company_id = ? AND count_date < ?`,
    args: [cid, String(date).slice(0, 10)]
  });
  const src = prev.rows[0]?.d ? String(prev.rows[0].d) : null;
  if (!src) return { source_date: null, items: [] };
  const res = await c.execute({
    sql: `SELECT product_id, actual_qty, pp_qty, note FROM stock_counts
          WHERE company_id = ? AND count_date = ?`,
    args: [cid, src]
  });
  return {
    source_date: src,
    items: res.rows.map((r) => ({
      product_id: Number(r.product_id),
      actual_qty: r.actual_qty == null ? null : Number(r.actual_qty),
      pp_qty: r.pp_qty == null ? null : Number(r.pp_qty),
      note: r.note ?? null
    }))
  };
}
async function listStockCounts(date) {
  const res = await getClient().execute({
    sql: `SELECT sc.*, p.code, p.name, p.category
          FROM stock_counts sc LEFT JOIN products p ON p.id = sc.product_id
          WHERE sc.count_date = ? AND sc.company_id = ? ORDER BY p.category, p.name`,
    args: [date, getActiveCompanyId()]
  });
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
async function stockCountHistory(from, to) {
  const res = await getClient().execute({
    // Company-scoped, like every other read on this page. Without it the
    // history mixed both companies' closings into one row per date AND could
    // not use the (company_id, count_date) index, so it scanned the table.
    sql: `SELECT substr(sc.count_date, 1, 10) AS count_date,
                 COUNT(*) AS products,
                 SUM(CASE WHEN ABS(COALESCE(sc.book_qty,0) - (COALESCE(sc.actual_qty,0) + COALESCE(sc.pp_qty,0))) > 0.0005
                          THEN 1 ELSE 0 END) AS mismatches,
                 ROUND(SUM(COALESCE(sc.book_qty,0) - (COALESCE(sc.actual_qty,0) + COALESCE(sc.pp_qty,0))), 3) AS net_diff,
                 ROUND(SUM(COALESCE(sc.actual_value, 0)), 2) AS actual_value,
                 MAX(sc.created_at) AS last_saved
            FROM stock_counts sc
           WHERE sc.company_id = ? AND sc.count_date >= ? AND sc.count_date <= ?
           GROUP BY substr(sc.count_date, 1, 10)
           ORDER BY count_date DESC`,
    args: [getActiveCompanyId(), String(from).slice(0, 10), String(to).slice(0, 10)]
  });
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
async function saveStockCounts(date, items) {
  const c = getClient();
  const rates = await productValuationRates();
  let count = 0;
  for (const it of items || []) {
    const hasActual = it.actual_qty !== "" && it.actual_qty != null;
    const hasPp = it.pp_qty !== "" && it.pp_qty != null;
    if (!hasActual && !hasPp) continue;
    const pid = n13(it.product_id);
    const actualQty = n13(it.actual_qty);
    const rate = rates.get(pid) || 0;
    await c.execute({
      sql: `INSERT INTO stock_counts (company_id, count_date, product_id, book_qty, actual_qty, rate, actual_value, pp_qty, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(company_id, count_date, product_id) DO UPDATE SET
              book_qty = excluded.book_qty,
              actual_qty = excluded.actual_qty,
              rate = excluded.rate,
              actual_value = excluded.actual_value,
              pp_qty = excluded.pp_qty,
              note = excluded.note`,
      args: [
        getActiveCompanyId(),
        date,
        pid,
        n13(it.book_qty),
        actualQty,
        rate,
        actualQty * rate,
        hasPp ? n13(it.pp_qty) : null,
        it.note || null
      ]
    });
    count++;
  }
  return { count };
}

// src/main/skustock.ts
function toPlain17(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n14(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function span(when) {
  if (!when) return { from: null, to: null, ranged: false };
  if (typeof when === "string") {
    const d = String(when).slice(0, 10);
    return d ? { from: d, to: d, ranged: true } : { from: null, to: null, ranged: false };
  }
  const from = when.from ? String(when.from).slice(0, 10) : "";
  const to = when.to ? String(when.to).slice(0, 10) : "";
  return { from: from || null, to: to || null, ranged: !!(from || to) };
}
async function skuOpeningDate(companyId) {
  const cid = n14(companyId) || getActiveCompanyId();
  const res = await getClient().execute({
    sql: "SELECT MIN(as_of) AS d FROM sku_openings WHERE company_id = ?",
    args: [cid]
  }).catch(() => null);
  const d = res?.rows?.[0] ? res.rows[0].d : null;
  return d ? String(d).slice(0, 10) : "";
}
async function skuOpeningMap(cid) {
  const m = /* @__PURE__ */ new Map();
  const res = await getClient().execute({ sql: "SELECT packaging_id, qty FROM sku_openings WHERE company_id = ?", args: [cid] }).catch(() => null);
  for (const r of res ? toPlain17(res) : []) m.set(n14(r.packaging_id), n14(r.qty));
  return m;
}
async function listSkuStock(when) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const { from, to, ranged } = span(when);
  const round = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
  const floor = await skuOpeningDate(cid);
  const openings = floor ? await skuOpeningMap(cid) : /* @__PURE__ */ new Map();
  const args = [];
  const sinceFloor = (col) => {
    if (!floor) return "";
    args.push(floor);
    return `AND substr(${col}, 1, 10) >= ?`;
  };
  const before = (col) => {
    if (!ranged) return "";
    if (!from) return "AND 1 = 0";
    const parts = [];
    if (floor) {
      args.push(floor);
      parts.push(`AND substr(${col}, 1, 10) >= ?`);
    }
    args.push(from);
    parts.push(`AND substr(${col}, 1, 10) < ?`);
    return parts.join(" ");
  };
  const within = (col) => {
    if (!ranged) return "AND 1 = 0";
    const parts = [];
    const lo = floor && (!from || from < floor) ? floor : from;
    if (lo) {
      args.push(lo);
      parts.push(`AND substr(${col}, 1, 10) >= ?`);
    }
    if (to) {
      args.push(to);
      parts.push(`AND substr(${col}, 1, 10) <= ?`);
    }
    return parts.join(" ");
  };
  args.push(cid);
  const sinceAdj = sinceFloor("adj_date");
  args.push(cid);
  const sinceSale = sinceFloor("s.sale_date");
  args.push(cid);
  const beforeAdj = before("adj_date");
  args.push(cid);
  const beforeSale = before("s.sale_date");
  args.push(cid);
  const withinAdj = within("adj_date");
  args.push(cid);
  const withinSale = within("s.sale_date");
  const res = await c.execute({
    sql: `
    SELECT pk.id, pk.name, pk.box_label, pk.pouch_label, pk.pouches_per_box,
           pk.base_per_pouch, pk.base_uom, pk.unit_size, pk.unit_uom,
           -- What this SKU packs: the linked finished product, else the short
           -- name typed on the SKU. Used to filter the packed-stock list.
           COALESCE(pr.name, pk.product_label) AS product_name,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       ${sinceAdj}), 0) AS added,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       ${sinceSale}), 0) AS sold,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       ${beforeAdj}), 0) AS added_before,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       ${beforeSale}), 0) AS sold_before,
           COALESCE((SELECT SUM(delta) FROM sku_adjustments
                     WHERE packaging_id = pk.id AND company_id = ?
                       ${withinAdj}), 0) AS added_on,
           COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                     WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                       AND s.status = 'done' AND s.company_id = ?
                       ${withinSale}), 0) AS sold_on
    FROM packagings pk
    LEFT JOIN products pr ON pr.id = pk.product_id
    WHERE pk.active = 1
    ORDER BY pk.name COLLATE NOCASE ASC`,
    args
  });
  const runs = await negativeRuns(cid, to);
  return toPlain17(res).map((r) => {
    const brought = openings.get(n14(r.id)) || 0;
    const opening = round(brought + n14(r.added_before) - n14(r.sold_before));
    const addedOn = round(n14(r.added_on));
    const soldOn = round(n14(r.sold_on));
    const onHand = ranged ? round(opening + addedOn - soldOn) : round(brought + n14(r.added) - n14(r.sold));
    const run = onHand < -1e-6 ? runs.get(n14(r.id)) : void 0;
    return {
      ...r,
      opening,
      added_on: addedOn,
      sold_on: soldOn,
      // Day view: closing for that date. Otherwise the running balance.
      on_hand: onHand,
      // The part of the opening that was COUNTED rather than derived from
      // movements, so the sheet can show what it is answering against.
      opening_brought: round(brought),
      negative_since: run?.negative_since ?? null,
      negative_trigger: run?.negative_trigger ?? null
    };
  });
}
async function negativeRuns(cid, upto) {
  const c = getClient();
  const res = await c.execute({
    sql: `
    SELECT sku, d, SUM(adj) AS adj, SUM(sale) AS sale FROM (
      SELECT packaging_id AS sku, substr(adj_date, 1, 10) AS d, SUM(delta) AS adj, 0 AS sale
        FROM sku_adjustments
       WHERE company_id = ? AND (? IS NULL OR substr(adj_date, 1, 10) <= ?)
       GROUP BY packaging_id, d
      UNION ALL
      SELECT s.packaging_id, substr(s.sale_date, 1, 10), 0,
             SUM(s.boxes * pk.pouches_per_box + s.pouches)
        FROM sales s JOIN packagings pk ON pk.id = s.packaging_id
       WHERE s.sale_type = 'PACKED' AND s.status = 'done' AND s.company_id = ?
         AND (? IS NULL OR substr(s.sale_date, 1, 10) <= ?)
       GROUP BY s.packaging_id, substr(s.sale_date, 1, 10)
    )
    GROUP BY sku, d
    ORDER BY sku, d`,
    args: [cid, upto, upto, cid, upto, upto]
  });
  const byS = /* @__PURE__ */ new Map();
  for (const r of toPlain17(res)) {
    const k = n14(r.sku);
    byS.set(k, [...byS.get(k) || [], r]);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [sku, days] of byS) {
    let bal = 0;
    let since = null;
    let trigger = null;
    for (const day of days) {
      const before = bal;
      bal = Math.round((bal + n14(day.adj) - n14(day.sale)) * 1e6) / 1e6;
      if (bal < -1e-6) {
        if (since === null) {
          since = String(day.d);
          trigger = { ...day, before };
        }
      } else {
        since = null;
        trigger = null;
      }
    }
    if (since) out.set(sku, { negative_since: since, negative_trigger: trigger });
  }
  return out;
}
async function skuMovementBreakdown(when) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const { from: asked, to } = span(when);
  const floor = await skuOpeningDate(cid);
  const from = floor && (!asked || asked < floor) ? floor : asked;
  const bounds = (col) => {
    const parts = [];
    const args = [];
    if (from) {
      parts.push(`AND substr(${col}, 1, 10) >= ?`);
      args.push(from);
    }
    if (to) {
      parts.push(`AND substr(${col}, 1, 10) <= ?`);
      args.push(to);
    }
    return { sql: parts.join(" "), args };
  };
  const dispB = bounds("s.sale_date");
  const adjB = bounds("adj_date");
  const disp = await c.execute({
    sql: `SELECT s.packaging_id AS sku, s.invoice_no, s.sale_date, s.customer,
                 SUM(s.boxes * pk.pouches_per_box + s.pouches) AS pieces, SUM(s.boxes) AS boxes
          FROM sales s JOIN packagings pk ON pk.id = s.packaging_id
          WHERE s.sale_type = 'PACKED' AND s.status = 'done' AND s.company_id = ?
            ${dispB.sql}
          GROUP BY s.packaging_id, s.invoice_group, s.customer
          ORDER BY s.sale_date, s.invoice_no`,
    args: [cid, ...dispB.args]
  });
  const packed = await c.execute({
    sql: `SELECT packaging_id AS sku, adj_date, delta, note, created_by, created_at,
                 COALESCE(kind, CASE WHEN delta < 0 THEN 'correction' ELSE 'packing' END) AS kind,
                 kind AS kind_stated
          FROM sku_adjustments
          WHERE company_id = ? ${adjB.sql}
          ORDER BY adj_date, id`,
    args: [cid, ...adjB.args]
  });
  const bySku = /* @__PURE__ */ new Map();
  const slot = (id) => {
    const cur = bySku.get(id) || { sku: id, dispatch: [], packed_in: [] };
    bySku.set(id, cur);
    return cur;
  };
  for (const r of toPlain17(disp)) slot(n14(r.sku)).dispatch.push(r);
  for (const r of toPlain17(packed)) slot(n14(r.sku)).packed_in.push(r);
  return Array.from(bySku.values());
}
async function listSkuOpenings(companyId, asOfIn) {
  const cid = n14(companyId) || getActiveCompanyId();
  const c = getClient();
  const asOf = String(asOfIn || "").slice(0, 10) || await skuOpeningDate(cid);
  const saved = await skuOpeningMap(cid);
  const notes = /* @__PURE__ */ new Map();
  const savedRows = await c.execute({ sql: "SELECT packaging_id, note FROM sku_openings WHERE company_id = ?", args: [cid] }).catch(() => null);
  for (const r of savedRows ? toPlain17(savedRows) : []) {
    if (r.note) notes.set(n14(r.packaging_id), String(r.note));
  }
  const moved = await c.execute({
    sql: `SELECT pk.id,
                 COALESCE((SELECT SUM(a.delta) FROM sku_adjustments a
                           WHERE a.packaging_id = pk.id AND a.company_id = ?
                             AND (? = '' OR substr(a.adj_date, 1, 10) >= ?)), 0) AS packed_in,
                 COALESCE((SELECT SUM(s.boxes * pk.pouches_per_box + s.pouches) FROM sales s
                           WHERE s.packaging_id = pk.id AND s.sale_type = 'PACKED'
                             AND s.status = 'done' AND s.company_id = ?
                             AND (? = '' OR substr(s.sale_date, 1, 10) >= ?)), 0) AS dispatched
          FROM packagings pk WHERE pk.active = 1`,
    args: [cid, asOf, asOf, cid, asOf, asOf]
  });
  const movedBy = /* @__PURE__ */ new Map();
  for (const r of toPlain17(moved)) movedBy.set(n14(r.id), r);
  const skus = await c.execute({
    sql: `SELECT pk.id, pk.name, pk.pouches_per_box, pk.base_per_pouch, pk.base_uom,
                 pk.unit_size, pk.unit_uom, pk.box_label, pk.pouch_label,
                 COALESCE(pr.name, pk.product_label) AS product_name
          FROM packagings pk LEFT JOIN products pr ON pr.id = pk.product_id
          WHERE pk.active = 1 ORDER BY pk.name COLLATE NOCASE ASC`,
    args: []
  });
  const round = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
  const rows = toPlain17(skus).map((p) => {
    const id = n14(p.id);
    const mv = movedBy.get(id);
    const fromMovement = round(n14(mv?.packed_in) - n14(mv?.dispatched));
    const entered = saved.has(id) ? n14(saved.get(id)) : null;
    return {
      ...p,
      qty: entered,
      note: notes.get(id) ?? null,
      // What the shelf reads with no opening at all. Negative here is exactly
      // the hole an opening figure is there to fill.
      movement_closing: fromMovement,
      shortfall: fromMovement < 0 ? round(-fromMovement) : 0,
      closing: round(fromMovement + n14(entered))
    };
  });
  return {
    company_id: cid,
    as_of: asOf,
    rows,
    entered_count: rows.filter((r) => r.qty != null).length,
    total_qty: round(rows.reduce((t, r) => t + n14(r.qty), 0)),
    negative_count: rows.filter((r) => n14(r.movement_closing) < -5e-4).length,
    still_negative: rows.filter((r) => n14(r.closing) < -5e-4).length
  };
}
async function saveSkuOpenings(rows, asOf, companyId) {
  const cid = n14(companyId) || getActiveCompanyId();
  const date = String(asOf || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pick the date this opening is counted on");
  const c = getClient();
  let saved = 0;
  let cleared = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const pid = n14(raw?.packaging_id ?? raw?.id);
    if (!pid) continue;
    const blank = raw?.qty === "" || raw?.qty == null;
    if (blank) {
      const res = await c.execute({
        sql: "DELETE FROM sku_openings WHERE company_id = ? AND packaging_id = ?",
        args: [cid, pid]
      });
      if (Number(res.rowsAffected) > 0) cleared++;
      continue;
    }
    await c.execute({
      sql: `INSERT INTO sku_openings (company_id, packaging_id, as_of, qty, note, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(company_id, packaging_id) DO UPDATE SET
              as_of = excluded.as_of,
              qty = excluded.qty,
              note = excluded.note,
              updated_at = datetime('now')`,
      args: [cid, pid, date, n14(raw.qty), raw?.note ? String(raw.note).trim() : null]
    });
    saved++;
  }
  return { saved, cleared };
}
async function listSkuAdjustments(packagingId) {
  const pid = n14(packagingId);
  if (!pid) return [];
  const MT = `
    CASE
      WHEN COALESCE(pk.unit_size, 0) > 0 THEN
        CASE UPPER(COALESCE(pk.unit_uom, 'KG'))
          WHEN 'GM' THEN pk.unit_size / 1000.0
          WHEN 'G' THEN pk.unit_size / 1000.0
          WHEN 'ML' THEN pk.unit_size / 1000.0
          WHEN 'QUINTAL' THEN pk.unit_size * 100.0
          WHEN 'MT' THEN pk.unit_size * 1000.0
          WHEN 'TON' THEN pk.unit_size * 1000.0
          WHEN 'KL' THEN pk.unit_size * 1000.0
          ELSE pk.unit_size
        END
      ELSE
        CASE UPPER(COALESCE(pk.base_uom, 'KG'))
          WHEN 'GM' THEN pk.base_per_pouch / 1000.0
          WHEN 'G' THEN pk.base_per_pouch / 1000.0
          WHEN 'ML' THEN pk.base_per_pouch / 1000.0
          WHEN 'QUINTAL' THEN pk.base_per_pouch * 100.0
          WHEN 'MT' THEN pk.base_per_pouch * 1000.0
          WHEN 'TON' THEN pk.base_per_pouch * 1000.0
          WHEN 'KL' THEN pk.base_per_pouch * 1000.0
          ELSE pk.base_per_pouch
        END
    END / 1000.0`;
  const res = await getClient().execute({
    sql: `SELECT a.id, a.delta, a.adj_date, a.note, a.created_by, a.created_at,
                 COALESCE(a.kind, CASE WHEN a.delta < 0 THEN 'correction' ELSE 'packing' END) AS kind,
                 a.delta * (${MT}) AS mt,
                 pr.name AS product_name
          FROM sku_adjustments a
          JOIN packagings pk ON pk.id = a.packaging_id
          LEFT JOIN products pr ON pr.id = pk.product_id
          WHERE a.packaging_id = ? AND a.company_id = ?
          ORDER BY a.adj_date DESC, a.id DESC`,
    args: [pid, getActiveCompanyId()]
  });
  return toPlain17(res).map((r) => ({
    ...r,
    mt: Math.round(n14(r.mt) * 1e3) / 1e3,
    // Only a packing entry moves oil between the tank and the shelf; see the
    // packedOut source in stock.ts, which filters on exactly this.
    moves_bulk: String(r.kind) === "packing"
  }));
}
async function deleteSkuAdjustment(id) {
  const c = getClient();
  const rid = n14(id);
  if (!rid) throw new Error("Nothing to remove");
  const res = await c.execute({
    sql: "SELECT id, packaging_id FROM sku_adjustments WHERE id = ? AND company_id = ?",
    args: [rid, getActiveCompanyId()]
  });
  if (!res.rows.length) throw new Error("That entry is not on this company's books");
  const pkg = n14(res.rows[0].packaging_id);
  await c.execute({ sql: "DELETE FROM sku_adjustments WHERE id = ?", args: [rid] });
  return { id: rid, packaging_id: pkg };
}
async function adjustSkuStock(packagingId, delta, note, date, kind) {
  const c = getClient();
  const pid = n14(packagingId);
  const d = n14(delta);
  if (!pid) throw new Error("Select an SKU");
  if (d === 0) throw new Error("Enter a quantity to add or remove");
  const pkg = await c.execute({ sql: "SELECT id FROM packagings WHERE id = ?", args: [pid] });
  if (!pkg.rows.length) throw new Error("SKU not found");
  const adjDate = date && String(date).slice(0, 10) || todayISO();
  const k = String(kind) === "correction" ? "correction" : "packing";
  if (k === "correction" && !String(note || "").trim()) {
    throw new Error("Say what is being corrected \u2014 a correction without a reason cannot be checked later");
  }
  await c.execute({
    sql: `INSERT INTO sku_adjustments (company_id, packaging_id, delta, adj_date, note, kind, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      pid,
      d,
      adjDate,
      note ? String(note).trim() : null,
      k,
      getCurrentUser().username || null
    ]
  });
  const rows = await listSkuStock();
  const cur = rows.find((r) => Number(r.id) === pid);
  return { id: pid, on_hand: cur ? Number(cur.on_hand) : 0 };
}

// src/main/accounting.ts
function toPlain18(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n15(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round25 = (v) => Math.round(v * 100) / 100;
var todayISO4 = () => {
  const d = /* @__PURE__ */ new Date();
  const p2 = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
var TALLY_GROUPS = [
  { name: "Capital Account", nature: "liability" },
  { name: "Reserves & Surplus", nature: "liability" },
  { name: "Loans (Liability)", nature: "liability" },
  { name: "Secured Loans", nature: "liability" },
  { name: "Unsecured Loans", nature: "liability" },
  { name: "Bank OD A/c", nature: "liability" },
  { name: "Current Liabilities", nature: "liability" },
  { name: "Duties & Taxes", nature: "liability" },
  { name: "Provisions", nature: "liability" },
  { name: "Sundry Creditors", nature: "liability" },
  { name: "Fixed Assets", nature: "asset" },
  { name: "Investments", nature: "asset" },
  { name: "Current Assets", nature: "asset" },
  { name: "Bank Accounts", nature: "asset" },
  { name: "Cash-in-Hand", nature: "asset" },
  { name: "Deposits (Asset)", nature: "asset" },
  { name: "Loans & Advances (Asset)", nature: "asset" },
  { name: "Stock-in-Hand", nature: "asset" },
  { name: "Sundry Debtors", nature: "asset" },
  { name: "Sales Accounts", nature: "income" },
  { name: "Direct Incomes", nature: "income" },
  { name: "Indirect Incomes", nature: "income" },
  { name: "Purchase Accounts", nature: "expense" },
  { name: "Direct Expenses", nature: "expense" },
  { name: "Indirect Expenses", nature: "expense" },
  { name: "General", nature: "asset" }
];
function groupNature(group) {
  return TALLY_GROUPS.find((g) => g.name === String(group || ""))?.nature || "asset";
}
var CASH_BANK_GROUPS = ["Bank Accounts", "Cash-in-Hand", "Bank OD A/c"];
async function listGroups(companyId) {
  const res = await getClient().execute({
    args: [companyId || getActiveCompanyId()],
    sql: `
    SELECT a.id, a.name, a.acc_group,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance
    FROM ledger_accounts a ORDER BY a.acc_group, a.name`
  });
  return toPlain18(res);
}
async function accountGroupOf(name) {
  const res = await getClient().execute({
    sql: "SELECT acc_group FROM ledger_accounts WHERE name = ?",
    args: [String(name || "").trim().toUpperCase()]
  });
  return String(res.rows[0]?.acc_group || "");
}
async function validateVoucher(v) {
  const lines = (v.lines || []).map((l) => ({
    account: String(l.account || "").trim(),
    group: l.group,
    dr: n15(l.dr),
    cr: n15(l.cr),
    allocs: (l.allocs || []).map((a) => ({
      method: a.method,
      ref_name: a.ref_name ? String(a.ref_name).trim() : null,
      order_id: a.order_id ? Number(a.order_id) : null,
      sale_invoice_group: a.sale_invoice_group ? String(a.sale_invoice_group).trim() : null,
      amount: n15(a.amount)
    })).filter((a) => a.amount > 4e-3)
  })).filter((l) => l.account && (l.dr > 4e-3 || l.cr > 4e-3));
  if (lines.length < 2) throw new Error("A voucher needs at least one Dr and one Cr line");
  if (lines.some((l) => l.dr > 4e-3 && l.cr > 4e-3)) {
    throw new Error("A line is either Dr or Cr, not both");
  }
  const dr = lines.reduce((s, l) => s + l.dr, 0);
  const cr = lines.reduce((s, l) => s + l.cr, 0);
  if (Math.abs(dr - cr) > 5e-3) {
    throw new Error(`Voucher does not balance \u2014 Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)}`);
  }
  if (!v.date) throw new Error("Voucher date is required");
  const isCashBank = async (l) => {
    const g = await accountGroupOf(l.account) || String(l.group || "");
    return CASH_BANK_GROUPS.includes(g);
  };
  if (v.vchType === "CONTRA") {
    for (const l of lines) {
      if (!await isCashBank(l)) {
        throw new Error(`Contra moves money between cash and bank only \u2014 "${l.account}" is neither`);
      }
    }
  } else if (v.vchType === "PAYMENT") {
    const credits = lines.filter((l) => l.cr > 4e-3);
    for (const l of credits) {
      if (!await isCashBank(l)) {
        throw new Error(`In a Payment the credit side is the cash or bank paying out \u2014 "${l.account}" is neither`);
      }
    }
  } else if (v.vchType === "RECEIPT") {
    const debits = lines.filter((l) => l.dr > 4e-3);
    for (const l of debits) {
      if (!await isCashBank(l)) {
        throw new Error(`In a Receipt the debit side is the cash or bank receiving \u2014 "${l.account}" is neither`);
      }
    }
  }
  for (const l of lines) {
    if (!l.allocs.length) continue;
    const total = l.allocs.reduce((s, a) => s + a.amount, 0);
    const lineAmt = l.dr > 4e-3 ? l.dr : l.cr;
    if (Math.abs(total - lineAmt) > 5e-3) {
      throw new Error(
        `Bill-wise details for "${l.account}" total ${total.toFixed(2)} but the line is ${lineAmt.toFixed(2)}`
      );
    }
    for (const a of l.allocs) {
      if (!["agst_ref", "advance", "on_account", "new_ref"].includes(a.method)) {
        throw new Error(`Unknown adjustment method "${a.method}"`);
      }
      if (a.method !== "on_account" && !a.ref_name) {
        throw new Error(
          `"${l.account}": ${a.method === "agst_ref" ? "Agst Ref" : a.method === "advance" ? "Advance" : "New Ref"} needs a reference name`
        );
      }
    }
  }
  return lines;
}
async function resolveRefIds(refName, companyId, side) {
  const ref = String(refName || "").trim();
  if (!ref) return { order_id: null, sale_invoice_group: null };
  const c = getClient();
  if (side === "supplier") {
    const r4 = await c.execute({
      sql: "SELECT id FROM orders WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1",
      args: [companyId, ref.toUpperCase()]
    });
    return { order_id: r4.rows.length ? Number(r4.rows[0].id) : null, sale_invoice_group: null };
  }
  const r = await c.execute({
    sql: `SELECT COALESCE(invoice_group, invoice_no) AS grp FROM sales
           WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1`,
    args: [companyId, ref.toUpperCase()]
  });
  return { order_id: null, sale_invoice_group: r.rows.length ? String(r.rows[0].grp) : null };
}
async function writeAllocs(entryId, lines) {
  const c = getClient();
  const saved = await c.execute({
    sql: "SELECT id, account_id FROM journal_lines WHERE entry_id = ? ORDER BY id ASC",
    args: [entryId]
  });
  const cid = getActiveCompanyId();
  for (let i = 0; i < lines.length && i < saved.rows.length; i++) {
    for (const a of lines[i].allocs) {
      let orderId = a.order_id || null;
      let saleGroup = a.sale_invoice_group || null;
      if (a.method === "agst_ref" && a.ref_name && !orderId && !saleGroup) {
        const grp = String(lines[i].group || "");
        const side = grp === "Sundry Debtors" ? "customer" : grp === "Sundry Creditors" ? "supplier" : null;
        if (side) {
          const ids = await resolveRefIds(String(a.ref_name), cid, side);
          orderId = ids.order_id;
          saleGroup = ids.sale_invoice_group;
        }
      }
      await c.execute({
        sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          Number(saved.rows[i].id),
          Number(saved.rows[i].account_id),
          a.method,
          a.ref_name || null,
          a.amount,
          orderId,
          saleGroup
        ]
      });
    }
  }
}
async function createVoucher(v) {
  const lines = await validateVoucher(v);
  const res = await postJournal({
    date: v.date,
    vchType: v.vchType,
    vchNo: v.vchNo || null,
    narration: v.narration || null,
    companyId: v.companyId ? n15(v.companyId) : void 0,
    lines
  });
  await writeAllocs(res.id, lines);
  return res;
}
async function updateVoucher(id, v) {
  const c = getClient();
  const cur = await c.execute({
    sql: "SELECT order_id, sale_id, payment_id FROM journal_entries WHERE id = ?",
    args: [id]
  });
  if (!cur.rows.length) throw new Error("Voucher not found");
  const r = cur.rows[0];
  if (r.order_id != null || r.sale_id != null || r.payment_id != null) {
    throw new Error("This voucher was posted automatically \u2014 alter its source document instead");
  }
  const isNote = await c.execute({ sql: "SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1", args: [id] });
  if (isNote.rows.length) {
    throw new Error("This voucher belongs to a Debit/Credit note \u2014 delete the note and enter it afresh");
  }
  const lines = await validateVoucher(v);
  await c.execute({
    sql: "UPDATE journal_entries SET entry_date = ?, vch_type = ?, vch_no = ?, narration = ? WHERE id = ?",
    args: [v.date, v.vchType, v.vchNo || null, v.narration || null, id]
  });
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [id]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [id] });
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group);
    await c.execute({
      sql: "INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)",
      args: [id, accountId, n15(l.dr), n15(l.cr)]
    });
  }
  await writeAllocs(id, lines);
  return { id };
}
async function getVoucher(id) {
  const c = getClient();
  const e = await c.execute({
    sql: "SELECT * FROM journal_entries WHERE id = ?",
    args: [id]
  });
  if (!e.rows.length) return null;
  const lines = await c.execute({
    sql: `SELECT jl.id, jl.dr, jl.cr, a.name AS account, a.acc_group
          FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? ORDER BY jl.id`,
    args: [id]
  });
  const entry = toPlain18(e)[0];
  const noteRef = await c.execute({
    sql: "SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1",
    args: [id]
  });
  entry.note_id = noteRef.rows.length ? Number(noteRef.rows[0].id) : null;
  entry.lines = toPlain18(lines);
  for (const l of entry.lines) {
    const al = await c.execute({
      sql: "SELECT method, ref_name, order_id, sale_invoice_group, amount FROM journal_bill_allocs WHERE line_id = ? ORDER BY id",
      args: [Number(l.id)]
    });
    l.allocs = toPlain18(al);
  }
  entry.manual = entry.order_id == null && entry.sale_id == null && entry.payment_id == null && entry.note_id == null;
  return entry;
}
async function listVouchers(from, to, vchType, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const conds = ["je.company_id = ?"];
  const args = [cid];
  if (from) {
    conds.push("je.entry_date >= ?");
    args.push(from);
  }
  if (to) {
    conds.push("je.entry_date <= ?");
    args.push(to);
  }
  if (vchType) {
    const types = (Array.isArray(vchType) ? vchType : [vchType]).filter(Boolean);
    if (types.length) {
      conds.push(`je.vch_type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }
  }
  const res = await c.execute({
    sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 je.order_id, je.sale_id, je.payment_id,
                 (SELECT nt.id FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS note_id,
                 (SELECT SUM(dr) FROM journal_lines WHERE entry_id = je.id) AS amount,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC LIMIT 1) AS dr_account,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC LIMIT 1) AS cr_account
          FROM journal_entries je
          WHERE ${conds.join(" AND ")}
          ORDER BY je.entry_date DESC, je.id DESC`,
    args
  });
  const rows = toPlain18(res);
  for (const r of rows) r.manual = r.order_id == null && r.sale_id == null && r.payment_id == null && r.note_id == null;
  return rows;
}
async function trialBalance(from, to, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const booksFrom = await getBooksFrom(cid);
  const entered = await openingMap(cid);
  const period = async (lo, hi) => {
    const conds = ["je.company_id = ?"];
    const args = [cid];
    if (booksFrom) {
      conds.push("je.entry_date >= ?");
      args.push(booksFrom);
    }
    if (lo) {
      conds.push("je.entry_date >= ?");
      args.push(lo);
    }
    if (hi) {
      conds.push("je.entry_date <= ?");
      args.push(hi);
    }
    const res = await c.execute({
      sql: `SELECT jl.account_id AS aid, SUM(jl.dr) AS dr, SUM(jl.cr) AS cr
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE ${conds.join(" AND ")} GROUP BY jl.account_id`,
      args
    });
    const m = /* @__PURE__ */ new Map();
    for (const r of res.rows) m.set(Number(r.aid), { dr: n15(r.dr), cr: n15(r.cr) });
    return m;
  };
  const accounts = toPlain18(await c.execute("SELECT id, name, acc_group FROM ledger_accounts ORDER BY acc_group, name"));
  const [inPeriod, before] = await Promise.all([
    period(from, to),
    from ? period(void 0, dayBefore(from)) : Promise.resolve(/* @__PURE__ */ new Map())
  ]);
  const rows = [];
  for (const a of accounts) {
    const p = inPeriod.get(Number(a.id)) || { dr: 0, cr: 0 };
    const o = before.get(Number(a.id)) || { dr: 0, cr: 0 };
    const opening = (entered.get(Number(a.id)) || 0) + o.dr - o.cr;
    const closing = opening + p.dr - p.cr;
    if (Math.abs(opening) < 5e-3 && Math.abs(p.dr) < 5e-3 && Math.abs(p.cr) < 5e-3) continue;
    rows.push({
      id: a.id,
      name: a.name,
      acc_group: a.acc_group,
      nature: groupNature(String(a.acc_group)),
      opening,
      period_dr: p.dr,
      period_cr: p.cr,
      closing,
      closing_dr: closing > 0 ? closing : 0,
      closing_cr: closing < 0 ? -closing : 0
    });
  }
  const totals = {
    opening_dr: rows.reduce((s, r) => s + (r.opening > 0 ? r.opening : 0), 0),
    opening_cr: rows.reduce((s, r) => s + (r.opening < 0 ? -r.opening : 0), 0),
    period_dr: rows.reduce((s, r) => s + r.period_dr, 0),
    period_cr: rows.reduce((s, r) => s + r.period_cr, 0),
    closing_dr: rows.reduce((s, r) => s + r.closing_dr, 0),
    closing_cr: rows.reduce((s, r) => s + r.closing_cr, 0)
  };
  return { rows, totals };
}
function dayBefore(iso) {
  const d = /* @__PURE__ */ new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function listPendingRefs(accountName, companyId, side) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const name = String(accountName || "").trim().toUpperCase();
  if (!name) return [];
  const acc = await c.execute({ sql: "SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?", args: [name] });
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0;
  if (!accountId && !side) return [];
  const group = side === "customer" ? "Sundry Debtors" : side === "supplier" ? "Sundry Creditors" : String(acc.rows[0]?.acc_group || "");
  const bills = [];
  if (group === "Sundry Creditors") {
    const r = await c.execute({
      sql: `SELECT o.id AS order_id, o.invoice_no AS ref, o.order_date AS bill_date, o.net_amount AS amount
            FROM orders o JOIN suppliers s ON s.id = o.supplier_id
            WHERE o.company_id = ? AND TRIM(UPPER(s.name)) = ? AND o.invoice_no IS NOT NULL AND o.invoice_no != ''`,
      args: [cid, name]
    });
    for (const b of toPlain18(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ""), amount: n15(b.amount), order_id: n15(b.order_id), sale_invoice_group: null });
    }
  } else if (group === "Sundry Debtors") {
    const r = await c.execute({
      // Match the CUSTOMER MASTER's name first, falling back to the sale's own
      // free-text customer field. Matching the free text alone made every
      // invoice booked against a customer record with that text blank or
      // spelled differently invisible here — whole customers offered no
      // invoices at all to a credit note.
      sql: `SELECT COALESCE(s.invoice_group, s.invoice_no) AS grp, MIN(s.invoice_no) AS ref, MIN(s.sale_date) AS bill_date,
                   SUM(s.amount + s.gst_amount + s.round_off) AS amount
            FROM sales s
            LEFT JOIN customers cu ON cu.id = s.customer_id
            WHERE s.company_id = ? AND TRIM(UPPER(COALESCE(cu.name, s.customer, ''))) = ?
              AND s.invoice_no IS NOT NULL AND s.invoice_no != ''
            GROUP BY grp`,
      args: [cid, name]
    });
    for (const b of toPlain18(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ""), amount: n15(b.amount), order_id: null, sale_invoice_group: String(b.grp) });
    }
  }
  const realRefs = new Set(bills.map((b) => b.ref));
  const made = await c.execute({
    sql: `SELECT ba.ref_name AS ref, MIN(je.entry_date) AS bill_date, SUM(ba.amount) AS amount
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method IN ('advance', 'new_ref') AND ba.ref_name IS NOT NULL
          GROUP BY ba.ref_name`,
    args: [accountId, cid]
  });
  const madeRows = [];
  for (const m of toPlain18(made)) {
    if (realRefs.has(String(m.ref))) {
      madeRows.push({ ref: `${m.ref} (duplicate ref \u2014 check this)`, bill_date: String(m.bill_date || ""), amount: n15(m.amount), order_id: null, sale_invoice_group: null });
      continue;
    }
    madeRows.push({ ref: String(m.ref), bill_date: String(m.bill_date || ""), amount: n15(m.amount), order_id: null, sale_invoice_group: null });
  }
  const settled = await c.execute({
    sql: `SELECT ba.ref_name AS ref, ba.order_id AS order_id, ba.sale_invoice_group AS sale_invoice_group,
                 ba.amount AS amount, je.entry_date, je.vch_type, je.vch_no, je.narration
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method = 'agst_ref'
          ORDER BY je.entry_date, je.id`,
    args: [accountId, cid]
  });
  const settledRows = toPlain18(settled);
  const sameRef = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();
  const matches = (s2, b) => {
    const hasIds = !!s2.order_id || !!s2.sale_invoice_group;
    if (hasIds) {
      if (b.order_id != null && n15(s2.order_id) === b.order_id) return true;
      if (b.sale_invoice_group != null && String(s2.sale_invoice_group || "") === b.sale_invoice_group) return true;
      return false;
    }
    return sameRef(s2.ref, b.ref);
  };
  const settlementsFor = (b) => {
    const out = [];
    for (const s of settledRows) {
      if (matches(s, b)) {
        out.push({
          entry_date: s.entry_date,
          vch_type: s.vch_type,
          vch_no: s.vch_no,
          narration: s.narration,
          amount: round25(n15(s.amount))
        });
      }
    }
    return out;
  };
  return [...bills, ...madeRows].map((b) => {
    const settlements = settlementsFor(b);
    const paid = round25(settlements.reduce((t, x) => t + n15(x.amount), 0));
    return {
      ref: b.ref,
      bill_date: b.bill_date,
      amount: n15(b.amount),
      order_id: b.order_id,
      sale_invoice_group: b.sale_invoice_group,
      paid,
      settlements,
      pending: round25(n15(b.amount) - paid)
    };
  }).filter((b) => b.pending > 5e-3).sort((a, b) => a.bill_date.localeCompare(b.bill_date));
}
async function billsOutstanding(accountName, companyId, opts = {}) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const name = String(accountName || "").trim().toUpperCase();
  if (!name) return { rows: [], on_account: 0, total_opening: 0, total_pending: 0, as_of: opts.asOf || todayISO4() };
  const asOf = String(opts.asOf || todayISO4()).slice(0, 10);
  const acc = await c.execute({
    sql: "SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?",
    args: [name]
  });
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0;
  const group = String(acc.rows[0]?.acc_group || "");
  const debtor = opts.side === "customer" || group === "Sundry Debtors";
  const master = debtor ? "customers" : "suppliers";
  const cp = await c.execute({
    sql: `SELECT credit_period_days FROM ${master} WHERE TRIM(UPPER(name)) = ? LIMIT 1`,
    args: [name]
  });
  const creditDays = cp.rows.length ? n15(cp.rows[0].credit_period_days) : 0;
  const bills = await listPendingRefs(accountName, cid, opts.side);
  const dayMs = 864e5;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const rows = bills.filter((b) => String(b.bill_date || "").slice(0, 10) <= asOf).map((b) => {
    const billDate = String(b.bill_date || "").slice(0, 10);
    let dueOn = billDate;
    if (billDate && creditDays > 0) {
      const d = /* @__PURE__ */ new Date(`${billDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + creditDays);
      dueOn = d.toISOString().slice(0, 10);
    }
    const dueMs = dueOn ? Date.parse(`${dueOn}T00:00:00Z`) : NaN;
    const overdue = Number.isFinite(dueMs) && asOfMs > dueMs ? Math.floor((asOfMs - dueMs) / dayMs) : 0;
    return {
      bill_date: billDate,
      ref: b.ref,
      opening: round25(n15(b.amount)),
      paid: round25(n15(b.paid)),
      pending: round25(n15(b.pending)),
      settlements: Array.isArray(b.settlements) ? b.settlements : [],
      due_on: dueOn,
      overdue_days: overdue,
      order_id: b.order_id,
      sale_invoice_group: b.sale_invoice_group
    };
  });
  const balRes = accountId ? await c.execute({
    sql: `SELECT ROUND(COALESCE(SUM(jl.dr), 0) - COALESCE(SUM(jl.cr), 0), 2) AS bal
              FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.account_id = ? AND je.company_id = ? AND je.entry_date <= ?`,
    args: [accountId, cid, asOf]
  }) : null;
  const balance = balRes ? n15(balRes.rows[0]?.bal) : 0;
  const totalPending = round25(rows.reduce((t, r) => t + n15(r.pending), 0));
  const billsSigned = debtor ? totalPending : -totalPending;
  const onAccount = round25(balance - billsSigned);
  return {
    as_of: asOf,
    debtor,
    credit_days: creditDays,
    rows,
    total_opening: round25(rows.reduce((t, r) => t + n15(r.opening), 0)),
    total_paid: round25(rows.reduce((t, r) => t + n15(r.paid), 0)),
    total_pending: totalPending,
    balance: round25(balance),
    on_account: onAccount
  };
}
async function tradingAccount(from, to, companyId) {
  const c = getClient();
  const cid = companyId || getActiveCompanyId();
  const f = from || "0000-01-01";
  const t = to || "9999-12-31";
  const purchases = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(COALESCE(o.received_qty, o.ordered_qty)) AS qty, SUM(o.taxable_value) AS value
          FROM orders o JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ? AND o.order_date BETWEEN ? AND ?
          GROUP BY code`,
    args: [cid, f, t]
  });
  const sales = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(s.qty) AS qty, SUM(s.amount) AS value
          FROM sales s JOIN products p ON p.id = s.product_id
          WHERE s.company_id = ? AND s.sale_date BETWEEN ? AND ? AND s.status = 'done'
          GROUP BY code`,
    args: [cid, f, t]
  });
  const m = /* @__PURE__ */ new Map();
  for (const r of toPlain18(purchases)) {
    m.set(String(r.code), {
      code: r.code,
      name: r.name,
      purchase_qty: n15(r.qty),
      purchase_value: n15(r.value),
      sale_qty: 0,
      sale_value: 0
    });
  }
  for (const r of toPlain18(sales)) {
    const key3 = String(r.code);
    const g = m.get(key3) || { code: key3, name: r.name, purchase_qty: 0, purchase_value: 0, sale_qty: 0, sale_value: 0 };
    g.sale_qty = n15(r.qty);
    g.sale_value = n15(r.value);
    m.set(key3, g);
  }
  const list2 = Array.from(m.values()).map((g) => ({
    ...g,
    gross: Math.round((n15(g.sale_value) - n15(g.purchase_value)) * 100) / 100
  }));
  return list2.sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

// src/main/notes.ts
function toPlain19(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n16(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function round26(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}
async function nextNoteNo(type, companyId) {
  const prefix = type === "debit" ? "DN" : "CN";
  const res = await getClient().execute({
    sql: "SELECT note_no FROM notes WHERE note_type = ? AND company_id = ?",
    args: [type, companyId || getActiveCompanyId()]
  });
  let max = 0;
  for (const r of res.rows) {
    const m = /(\d+)\s*$/.exec(String(r.note_no || ""));
    const v = m ? Number(m[1]) : 0;
    if (v > max) max = v;
  }
  return `${prefix}/${max + 1}`;
}
async function listNotes(companyId) {
  const res = await getClient().execute({
    args: [companyId ? n16(companyId) : getActiveCompanyId()],
    sql: `SELECT nt.*,
            CASE nt.party_type WHEN 'supplier' THEN s.name WHEN 'customer' THEN c.name WHEN 'transporter' THEN tr.name END AS party_name,
            (SELECT COUNT(*) FROM note_items ni WHERE ni.note_id = nt.id) AS item_count,
            sb.bargain_no AS bargain_no
          FROM notes nt
          LEFT JOIN sales_bargains sb ON sb.id = nt.bargain_id
          LEFT JOIN suppliers s ON nt.party_type = 'supplier' AND s.id = nt.party_id
          LEFT JOIN customers c ON nt.party_type = 'customer' AND c.id = nt.party_id
          LEFT JOIN transporters tr ON nt.party_type = 'transporter' AND tr.id = nt.party_id
          WHERE nt.company_id = ?
          ORDER BY nt.id DESC`
  });
  return toPlain19(res);
}
async function listNoteItems(noteId) {
  const res = await getClient().execute({
    sql: `SELECT ni.*, p.code AS product_code, p.name AS product_name
          FROM note_items ni LEFT JOIN products p ON p.id = ni.product_id
          WHERE ni.note_id = ? ORDER BY ni.id`,
    args: [noteId]
  });
  return toPlain19(res);
}
var PARTY_KINDS = {
  supplier: { master: "suppliers", ledger: "supplier_ledger", idCol: "supplier_id", refCol: "order_id", group: "Sundry Creditors", gst: "GST INPUT A/C" },
  customer: { master: "customers", ledger: "customer_ledger", idCol: "customer_id", refCol: "sale_id", group: "Sundry Debtors", gst: "GST OUTPUT A/C" },
  transporter: { master: "transporters", ledger: "transporter_ledger", idCol: "transporter_id", refCol: "order_id", group: "Sundry Creditors", gst: "GST INPUT A/C" }
};
async function createNote(v, existingId) {
  const c = getClient();
  const cid = v.company_id ? n16(v.company_id) : getActiveCompanyId();
  const type = v.note_type === "credit" ? "credit" : "debit";
  const requested = String(v.party_type || "").trim().toLowerCase();
  const partyType = requested in PARTY_KINDS ? requested : type === "debit" ? "supplier" : "customer";
  const kind = PARTY_KINDS[partyType];
  const partyId = n16(v.party_id);
  if (!partyId) throw new Error(`Select the ${partyType}`);
  const rawItems = Array.isArray(v.items) ? v.items : [];
  const items = rawItems.map((it) => ({
    product_id: it.product_id ? n16(it.product_id) : null,
    description: it.description ? String(it.description).trim() : null,
    qty: n16(it.qty),
    rate: n16(it.rate),
    amount: round26(n16(it.qty) * n16(it.rate))
  })).filter((it) => it.amount > 0 || it.qty > 0);
  const base = items.length ? round26(items.reduce((s, it) => s + it.amount, 0)) : round26(n16(v.base_amount));
  const gstPct = n16(v.gst_pct);
  if (base <= 0) throw new Error("Enter a base amount (or item lines) greater than zero");
  const gst = round26(base * (gstPct / 100));
  const rawTotal = round26(base + gst);
  const total = Math.round(rawTotal);
  const roundOff = round26(total - rawTotal);
  const againstRef = v.against_invoice ? String(v.against_invoice).trim() : null;
  const wantsBargain = type === "credit" && partyType === "customer";
  const bargainId = wantsBargain && v.bargain_id ? n16(v.bargain_id) : 0;
  const partyRes = await c.execute({
    sql: `SELECT name FROM ${kind.master} WHERE id = ?`,
    args: [partyId]
  });
  if (!partyRes.rows.length) throw new Error("Party not found");
  const partyName2 = String(partyRes.rows[0].name || "").trim();
  const purchaseSide = partyType !== "customer";
  const defaultAgainst = purchaseSide ? "PURCHASE RETURN A/C" : "SALES RETURN A/C";
  const againstGroup = purchaseSide ? "Purchase Accounts" : "Sales Accounts";
  const against = (String(v.against_account || "").trim() || defaultAgainst).toUpperCase();
  const prior = existingId ? (await c.execute({ sql: "SELECT * FROM notes WHERE id = ? AND company_id = ?", args: [existingId, cid] })).rows[0] : void 0;
  if (existingId && !prior) throw new Error("That note no longer exists");
  const noteNo = prior ? String(prior.note_no) : await nextNoteNo(type, cid);
  if (prior) {
    if (prior.journal_entry_id != null) {
      await c.execute({
        sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
        args: [n16(prior.journal_entry_id)]
      });
      await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [n16(prior.journal_entry_id)] });
      await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [n16(prior.journal_entry_id)] });
    }
    const priorLedger = String(prior.ledger_table || "");
    if (["customer_ledger", "transporter_ledger", "supplier_ledger"].includes(priorLedger) && prior.ledger_id != null) {
      await c.execute({ sql: `DELETE FROM ${priorLedger} WHERE id = ?`, args: [n16(prior.ledger_id)] });
    }
    await c.execute({ sql: "DELETE FROM note_items WHERE note_id = ?", args: [n16(existingId)] });
  }
  const date = String(v.note_date || todayISO()).slice(0, 10);
  const narration = v.narration ? String(v.narration).trim() : null;
  const je = await postJournal({
    date,
    vchType: type === "debit" ? "DEBIT NOTE" : "CREDIT NOTE",
    vchNo: noteNo,
    narration: narration || `${type === "debit" ? "Debit" : "Credit"} note ${noteNo}`,
    companyId: cid,
    lines: type === "debit" ? [
      { account: partyName2, group: kind.group, dr: total },
      { account: against, group: againstGroup, cr: base },
      { account: kind.gst, group: "Duties & Taxes", cr: gst },
      { account: "ROUND OFF A/C", group: "Indirect Expenses", cr: roundOff > 0 ? roundOff : 0, dr: roundOff < 0 ? -roundOff : 0 }
    ] : [
      { account: against, group: againstGroup, dr: base },
      { account: kind.gst, group: "Duties & Taxes", dr: gst },
      { account: "ROUND OFF A/C", group: "Indirect Expenses", dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
      { account: partyName2 || "CASH CUSTOMER A/C", group: kind.group, cr: total }
    ]
  });
  const partyLine = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [je.id, partyName2.toUpperCase()]
  });
  if (partyLine.rows.length) {
    const ids = againstRef ? await resolveRefIds(againstRef, cid, partyType === "customer" ? "customer" : "supplier") : { order_id: null, sale_invoice_group: null };
    await c.execute({
      sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Number(partyLine.rows[0].id),
        Number(partyLine.rows[0].account_id),
        againstRef ? "agst_ref" : "on_account",
        againstRef,
        total,
        ids.order_id,
        ids.sale_invoice_group
      ]
    });
  }
  const table = kind.ledger;
  const partyCol = kind.idCol;
  const refCol = kind.refCol;
  const signedAmount = type === "debit" ? -total : total;
  const led = await c.execute({
    sql: `INSERT INTO ${table} (${partyCol}, ${refCol}, entry_date, entry_type, amount, note, company_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    args: [partyId, date, type === "debit" ? "dr_note" : "cr_note", signedAmount, `${noteNo} \u2014 ${against}`, cid]
  });
  let noteId;
  if (prior) {
    await c.execute({
      sql: `UPDATE notes SET
        note_type = ?, note_date = ?, party_type = ?, party_id = ?, against_account = ?,
        base_amount = ?, gst_pct = ?, gst_amount = ?, total_amount = ?, narration = ?,
        journal_entry_id = ?, ledger_table = ?, ledger_id = ?, against_ref = ?, bargain_id = ?
        WHERE id = ? AND company_id = ?`,
      args: [
        type,
        date,
        partyType,
        partyId,
        against,
        base,
        gstPct,
        gst,
        total,
        narration,
        je.id,
        table,
        Number(led.lastInsertRowid),
        againstRef,
        bargainId || null,
        existingId,
        cid
      ]
    });
    noteId = existingId;
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO notes
        (company_id, note_type, note_no, note_date, party_type, party_id, against_account,
         base_amount, gst_pct, gst_amount, total_amount, narration, journal_entry_id, ledger_table, ledger_id, against_ref, bargain_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cid,
        type,
        noteNo,
        date,
        partyType,
        partyId,
        against,
        base,
        gstPct,
        gst,
        total,
        narration,
        je.id,
        table,
        Number(led.lastInsertRowid),
        againstRef,
        bargainId || null
      ]
    });
    noteId = Number(ins.lastInsertRowid);
  }
  for (const it of items) {
    await c.execute({
      sql: "INSERT INTO note_items (note_id, product_id, description, qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?)",
      args: [noteId, it.product_id, it.description, it.qty, it.rate, it.amount]
    });
  }
  return { id: noteId, note_no: noteNo };
}
async function updateNote(id, v) {
  return createNote(v, n16(id));
}
async function deleteNote(id, companyId) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT * FROM notes WHERE id = ? AND company_id = ?",
    args: [id, companyId ? n16(companyId) : getActiveCompanyId()]
  });
  if (!res.rows.length) return { id };
  const note = res.rows[0];
  if (note.journal_entry_id != null) {
    await c.execute({
      sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
      args: [Number(note.journal_entry_id)]
    });
    await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [Number(note.journal_entry_id)] });
    await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [Number(note.journal_entry_id)] });
  }
  if (note.ledger_table && note.ledger_id != null) {
    const stored = String(note.ledger_table);
    const table = ["customer_ledger", "transporter_ledger", "supplier_ledger"].includes(stored) ? stored : "supplier_ledger";
    await c.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [Number(note.ledger_id)] });
  }
  await c.execute({ sql: "DELETE FROM note_items WHERE note_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM notes WHERE id = ?", args: [id] });
  return { id };
}

// src/main/daybook.ts
function toPlain20(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
async function daybook(from, to) {
  const c = getClient();
  const cid = getActiveCompanyId();
  const vres = await c.execute({
    sql: `
      SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration,
             je.order_id, je.sale_id, je.payment_id,
             COALESCE((SELECT SUM(dr) FROM journal_lines WHERE entry_id = je.id), 0) AS amount,
             (SELECT GROUP_CONCAT(a.name, ' + ') FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id AND jl.dr > 0) AS dr_accounts,
             (SELECT GROUP_CONCAT(a.name, ' + ') FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id AND jl.cr > 0) AS cr_accounts
      FROM journal_entries je
      WHERE je.company_id = ? AND substr(je.entry_date, 1, 10) >= ? AND substr(je.entry_date, 1, 10) <= ?
      ORDER BY je.entry_date ASC, je.id ASC`,
    args: [cid, from, to]
  });
  const mres = await c.execute({
    sql: `
      SELECT g.id, g.entry_date, g.direction, g.rec_type, g.gate_entry_no, g.ref_no, g.tanker_no, g.uom,
             CASE WHEN g.direction = 'out' THEN g.dispatch_qty ELSE g.received_qty END AS qty,
             g.status,
             COALESCE(sup.name, (SELECT customer FROM sales WHERE invoice_group = g.invoice_group LIMIT 1), sl.customer) AS party,
             COALESCE(b.bargain_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS ref_doc
      FROM gate_entries g
      LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
      LEFT JOIN bargains b ON b.id = pt.bargain_id
      LEFT JOIN suppliers sup ON sup.id = pt.supplier_id
      LEFT JOIN sales sl ON sl.id = g.sale_id
      WHERE substr(g.entry_date, 1, 10) >= ? AND substr(g.entry_date, 1, 10) <= ?
      ORDER BY g.entry_date ASC, g.id ASC`,
    args: [from, to]
  });
  return { vouchers: toPlain20(vres), material: toPlain20(mres) };
}

// src/main/dashboard.ts
function toPlain21(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var n17 = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
async function dashboardStats() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const q = async (sql, args = []) => toPlain21(await c.execute({ sql, args: [cid, ...args] }));
  const [
    purchaseMonths,
    saleMonths,
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains,
    saleBargains,
    tankers,
    consignment,
    levels
  ] = await Promise.all([
    q(`SELECT substr(order_date, 1, 7) AS m, SUM(taxable_value + gst_amount + round_off) AS v, SUM(ordered_qty) AS qty, COUNT(*) AS cnt
       FROM orders WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT substr(sale_date, 1, 7) AS m, SUM(amount + gst_amount + round_off) AS v, SUM(qty) AS qty, COUNT(DISTINCT COALESCE(invoice_group, 'L' || id)) AS cnt
       FROM sales WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT order_date AS d, SUM(taxable_value + gst_amount + round_off) AS v
       FROM orders WHERE company_id = ? AND order_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT sale_date AS d, SUM(amount + gst_amount + round_off) AS v
       FROM sales WHERE company_id = ? AND sale_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT s.name, SUM(o.taxable_value + o.gst_amount + o.round_off) AS v, SUM(o.ordered_qty) AS qty
       FROM orders o JOIN suppliers s ON s.id = o.supplier_id
       WHERE o.company_id = ? GROUP BY o.supplier_id ORDER BY v DESC LIMIT 5`),
    // The MASTER's name first, then the free text, and only then CASH.
    //
    // This read the free-text column alone. A sale booked from the Trading page
    // sets customer_id and leaves that text NULL, so every trading invoice fell
    // into one "CASH" bucket -- which then led the chart at Rs 26.54 Cr, a
    // customer that does not exist, while the real ones were understated. The
    // supplier query beside it has always joined its master; this now matches.
    q(`SELECT COALESCE(NULLIF(TRIM(cu.name), ''), NULLIF(TRIM(s.customer), ''), 'CASH') AS name,
              SUM(s.amount + s.gst_amount + s.round_off) AS v, SUM(s.qty) AS qty
       FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
       WHERE s.company_id = ? GROUP BY name ORDER BY v DESC LIMIT 5`),
    q(`SELECT a.name, SUM(jl.cr) - SUM(jl.dr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group = 'Sundry Creditors'
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    q(`SELECT a.name, SUM(jl.dr) - SUM(jl.cr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group = 'Sundry Debtors'
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    q(`SELECT a.name, SUM(jl.dr) - SUM(jl.cr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.name IN ('TDS PAYABLE A/C', 'GST INPUT A/C', 'GST OUTPUT A/C')
       GROUP BY a.id`),
    q(`SELECT COUNT(*) AS cnt, COALESCE(SUM(qty), 0) AS qty FROM bargains WHERE company_id = ? AND status != 'settled'`).catch(
      () => []
    ),
    q(`SELECT COUNT(*) AS cnt, SUM(qty) AS qty FROM sales_bargains WHERE company_id = ? AND status != 'settled'`).catch(
      () => []
    ),
    q(`SELECT pt.status, COUNT(*) AS cnt FROM purchase_tankers pt
       WHERE pt.company_id = ? AND pt.status NOT IN ('received', 'empty') GROUP BY pt.status`).catch(() => []),
    q(`SELECT COALESCE(SUM(qty), 0) AS bal FROM consignment_stock WHERE company_id = ?`).catch(() => []),
    stockLevels()
  ]);
  const stockCats = {};
  const negatives = [];
  for (const r of levels) {
    const cat = String(r.category || "other");
    if (!stockCats[cat]) stockCats[cat] = { qty: 0, products: 0 };
    if (Math.abs(n17(r.stock)) > 1e-9) {
      stockCats[cat].qty += n17(r.stock);
      stockCats[cat].products++;
    }
    if (n17(r.stock) < -1e-9) negatives.push({ name: r.name, category: r.category, stock: n17(r.stock) });
  }
  return {
    purchaseMonths: purchaseMonths.reverse(),
    saleMonths: saleMonths.reverse(),
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains: purBargains[0] || { cnt: 0, qty: 0 },
    saleBargains: saleBargains[0] || { cnt: 0, qty: 0 },
    tankers,
    consignmentBalance: n17(consignment[0]?.bal),
    stockCats,
    negatives: negatives.sort((a, b) => a.stock - b.stock)
  };
}

// src/main/lcInterest.ts
var n18 = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
var round27 = (v) => Math.round(v * 100) / 100;
function lcInterestBase(lc) {
  const amount = n18(lc?.amount);
  const adj = n18(lc?.interest_adj);
  if (!lc?.interest_excl_charges && !adj) return amount;
  const gross = lc?.interest_excl_charges ? round27(amount - n18(lc?.charges)) : amount;
  const adjusted = round27(gross + adj);
  return Math.max(0, adjusted);
}
function lcInterest(lc) {
  return round27(lcInterestBase(lc) * n18(lc?.interest_pct) * n18(lc?.usance_days) / (100 * 365));
}
function lcInterestBasis(lc) {
  const base = lc?.interest_excl_charges ? "open amount less bank charges" : "open amount";
  const adj = round27(n18(lc?.interest_adj));
  if (Math.abs(adj) < 5e-3) return base;
  return `${base} ${adj < 0 ? "less" : "plus"} an adjustment of ${Math.abs(adj).toFixed(2)}`;
}
function lcInterestBaseIsCustom(lc) {
  return !!lc?.interest_excl_charges || Math.abs(n18(lc?.interest_adj)) >= 5e-3;
}

// src/main/treasury.ts
function toPlain22(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n19(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round28 = (v) => Math.round(v * 100) / 100;
function todayISO5() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween(a, b) {
  return Math.round(((/* @__PURE__ */ new Date(`${b}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${a}T00:00:00`)).getTime()) / 864e5);
}
function duePeriodOf(daysLeft) {
  if (daysLeft == null) return "none";
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= 1) return "t1";
  if (daysLeft <= 7) return "week";
  if (daysLeft <= 14) return "fortnight";
  if (daysLeft <= 30) return "month";
  if (daysLeft <= 90) return "quarter";
  return "later";
}
async function dropEntry(entryId) {
  if (!entryId) return;
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [entryId]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [entryId] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [entryId] });
}
async function allocAgainst(entryId, partyName2, ref, amount) {
  const c = getClient();
  const line = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [entryId, partyName2.toUpperCase()]
  });
  if (!line.rows.length) return;
  await c.execute({
    sql: "INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount) VALUES (?, ?, ?, ?, ?)",
    args: [Number(line.rows[0].id), Number(line.rows[0].account_id), ref ? "agst_ref" : "on_account", ref, amount]
  });
}
function planReceipt(outstanding, value, fallbackParty) {
  const takes = [];
  let remaining = value;
  for (const o of [...outstanding].sort((a, b) => b.due - a.due)) {
    if (remaining <= 5e-3) break;
    const amount = round28(Math.min(remaining, o.due));
    takes.push({ party: (o.customer_name || fallbackParty).trim() || fallbackParty, key: o.key, amount });
    remaining -= amount;
  }
  const totals = /* @__PURE__ */ new Map();
  for (const t of takes) totals.set(t.party, round28((totals.get(t.party) || 0) + t.amount));
  const byParty = Array.from(totals, ([party, amount]) => ({ party, amount }));
  const drift = round28(value - byParty.reduce((a, b) => a + b.amount, 0));
  if (Math.abs(drift) > 5e-4 && byParty.length) {
    const biggest = byParty.reduce((a, b) => b.amount > a.amount ? b : a);
    biggest.amount = round28(biggest.amount + drift);
  }
  return { takes, byParty };
}
function assertNotFuture(date, what) {
  const d = String(date || "").slice(0, 10);
  if (d && d > todayISO5()) throw new Error(`${what} cannot be a future date`);
}
async function bankAccountFor(lc) {
  const id = n19(lc.our_bank_id);
  if (!id) return "BANK A/C";
  const r = await getClient().execute({ sql: "SELECT name FROM banks WHERE id = ?", args: [id] });
  const name = String(r.rows[0]?.name || "").trim();
  return name ? `${name.toUpperCase()} A/C` : "BANK A/C";
}
var LC_PAYABLE_GROUP = "Current Liabilities";
async function lcPayable(lc) {
  const id = n19(lc.our_bank_id);
  if (id) {
    const r = await getClient().execute({ sql: "SELECT name FROM banks WHERE id = ?", args: [id] });
    const own = String(r.rows[0]?.name || "").trim().toUpperCase();
    if (own) return `LC PAYABLE - ${own}`;
  }
  const bank = String(lc.bank || "").trim().toUpperCase();
  return bank ? `LC PAYABLE - ${bank}` : "LC PAYABLE";
}
async function postLcOpening(lcId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!res.rows.length) return;
  const lc = toPlain22(res)[0];
  await dropEntry(n19(lc.journal_entry_id) || null);
  const margin = round28(n19(lc.amount) * n19(lc.margin_pct) / 100);
  if (margin < 5e-3) {
    await c.execute({ sql: "UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?", args: [lcId] });
    return;
  }
  const je = await postJournal({
    date: String(lc.open_date || todayISO5()),
    vchType: "CONTRA",
    vchNo: String(lc.lc_no || ""),
    narration: `LC ${lc.lc_no} \u2014 margin ${margin.toFixed(2)} lodged with ${lc.bank}`,
    companyId: n19(lc.company_id) || void 0,
    lines: [
      { account: "LC MARGIN A/C", group: "Deposits (Asset)", dr: margin },
      { account: await bankAccountFor(lc), group: "Bank Accounts", cr: margin }
    ]
  });
  await c.execute({ sql: "UPDATE letters_of_credit SET journal_entry_id = ? WHERE id = ?", args: [je.id, lcId] });
}
async function postLcFees(lcId) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT charges_journal_entry_id FROM letters_of_credit WHERE id = ?",
    args: [lcId]
  });
  if (!res.rows.length) return;
  await dropEntry(n19(res.rows[0].charges_journal_entry_id) || null);
  await c.execute({ sql: "UPDATE letters_of_credit SET charges_journal_entry_id = NULL WHERE id = ?", args: [lcId] });
}
async function postLcUpfrontInterest(lcId, dateIn) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain22(res)[0];
  const bankAcc = await bankAccountFor(lc);
  await dropEntry(n19(lc.interest_journal_entry_id) || null);
  const interest = lcInterest(lc);
  const charges = round28(n19(lc.charges));
  const total = round28(interest + charges);
  if (total < 5e-3) {
    await c.execute({ sql: "UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?", args: [lcId] });
    return null;
  }
  const je = await postJournal({
    date: String(dateIn || todayISO5()).slice(0, 10),
    vchType: "JOURNAL",
    vchNo: String(lc.lc_no || ""),
    narration: `LC ${lc.lc_no} \u2014 interest ${interest.toFixed(2)} and charges ${charges.toFixed(2)} paid upfront from the bank, per its statement` + (lcInterestBaseIsCustom(lc) ? ` (interest on ${lcInterestBasis(lc)})` : ""),
    companyId: n19(lc.company_id) || void 0,
    lines: [
      { account: "INTEREST A/C", group: "Indirect Expenses", dr: interest },
      { account: "BANK CHARGES A/C", group: "Indirect Expenses", dr: charges },
      { account: bankAcc, group: "Bank Accounts", cr: total }
    ]
  });
  await c.execute({ sql: "UPDATE letters_of_credit SET interest_journal_entry_id = ? WHERE id = ?", args: [je.id, lcId] });
  await resyncLcSettlement(lcId);
  return { id: je.id };
}
function lcFeeDelta() {
  return 0;
}
async function syncLcFeeAdjustment(lcId) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT l.*, s.name AS supplier_name
          FROM letters_of_credit l
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.id = ?`,
    args: [lcId]
  });
  if (!res.rows.length) return 0;
  const lc = toPlain22(res)[0];
  const bankAcc = await bankAccountFor(lc);
  const iss = await c.execute({
    sql: `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) AS settled,
                 COUNT(CASE WHEN order_id IS NOT NULL THEN 1 END) AS linked
          FROM lc_issuances WHERE lc_id = ?`,
    args: [lcId]
  });
  const delta = lcFeeDelta();
  await dropEntry(n19(lc.fee_adjust_journal_entry_id) || null);
  const party = String(lc.supplier_name || "").trim();
  if (delta === 0 || !party) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET fee_adjust_journal_entry_id = NULL WHERE id = ?",
      args: [lcId]
    });
    return 0;
  }
  const size = round28(Math.abs(delta));
  const retained = delta < 0;
  const je = await postJournal({
    date: String(lc.payment_received_date || lc.open_date || todayISO5()).slice(0, 10),
    vchType: "JOURNAL",
    vchNo: String(lc.lc_no || ""),
    narration: retained ? `LC ${lc.lc_no} \u2014 ${size.toFixed(2)} of the bill was retained by ${lc.bank} as interest and charges, so it never reached ${party}; their account is credited back by that much` : `LC ${lc.lc_no} \u2014 ${lc.bank} released ${size.toFixed(2)} to ${party} beyond the bill as drawn, so their account is debited by that much`,
    companyId: n19(lc.company_id) || void 0,
    lines: retained ? [
      { account: bankAcc, group: "Bank Accounts", dr: size },
      { account: party, group: "Sundry Creditors", cr: size }
    ] : [
      { account: party, group: "Sundry Creditors", dr: size },
      { account: bankAcc, group: "Bank Accounts", cr: size }
    ]
  });
  await allocAgainst(je.id, party, null, size);
  await c.execute({
    sql: "UPDATE letters_of_credit SET fee_adjust_journal_entry_id = ? WHERE id = ?",
    args: [je.id, lcId]
  });
  return delta;
}
async function refreshLcUpfrontInterest(lcId) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT interest_journal_entry_id FROM letters_of_credit WHERE id = ?",
    args: [lcId]
  });
  const jeId = n19(res.rows[0]?.interest_journal_entry_id);
  if (!jeId) return;
  const je = await c.execute({ sql: "SELECT entry_date FROM journal_entries WHERE id = ?", args: [jeId] });
  const date = String(je.rows[0]?.entry_date || "").slice(0, 10);
  await postLcUpfrontInterest(lcId, date || void 0);
}
async function dropLcUpfrontInterest(lcId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT interest_journal_entry_id FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (res.rows.length && res.rows[0].interest_journal_entry_id) {
    await dropEntry(n19(res.rows[0].interest_journal_entry_id));
    await c.execute({ sql: "UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?", args: [lcId] });
    await resyncLcSettlement(lcId);
  }
}
async function postLcMarginRelease(lcId, amount, dateIn) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain22(res)[0];
  const bankAcc = await bankAccountFor(lc);
  const value = round28(amount);
  if (value < 5e-3) return null;
  const je = await postJournal({
    date: String(dateIn || todayISO5()).slice(0, 10),
    vchType: "RECEIPT",
    vchNo: String(lc.lc_no || ""),
    narration: `LC ${lc.lc_no} preclosed \u2014 margin of ${value.toFixed(2)} refunded by ${lc.bank}`,
    companyId: n19(lc.company_id) || void 0,
    lines: [
      { account: bankAcc, group: "Bank Accounts", dr: value },
      { account: "LC MARGIN A/C", group: "Deposits (Asset)", cr: value }
    ]
  });
  return { id: je.id };
}
async function postLcPrematureInterestRebate(lcId, direction, amount, dateIn) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT l.*, s.name AS supplier_name FROM letters_of_credit l
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.id = ?`,
    args: [lcId]
  });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain22(res)[0];
  const bankAcc = await bankAccountFor(lc);
  const payable = await lcPayable(lc);
  const value = round28(amount);
  if (value < 5e-3) return null;
  const date = String(dateIn || todayISO5()).slice(0, 10);
  const je = await postJournal({
    date,
    vchType: "JOURNAL",
    vchNo: String(lc.lc_no || ""),
    narration: `LC ${lc.lc_no} preclosed \u2014 interest of ${value.toFixed(2)} reversed for the days that will not happen${direction === "pay_to_party" ? ", and passed on to the supplier" : ""}`,
    companyId: n19(lc.company_id) || void 0,
    lines: [
      { account: payable, group: LC_PAYABLE_GROUP, dr: value },
      { account: "INTEREST A/C", group: "Indirect Expenses", cr: value }
    ]
  });
  let payoutId;
  if (direction === "pay_to_party") {
    const party = String(lc.supplier_name || "").trim();
    if (!party) throw new Error("The LC has no supplier party \u2014 set it on the LC first");
    const pay = await postJournal({
      date,
      vchType: "PAYMENT",
      vchNo: String(lc.lc_no || ""),
      narration: `LC ${lc.lc_no} \u2014 preclosure interest rebate of ${value.toFixed(2)} paid on to ${party}`,
      companyId: n19(lc.company_id) || void 0,
      lines: [
        { account: party, group: "Sundry Creditors", dr: value },
        { account: bankAcc, group: "Bank Accounts", cr: value }
      ]
    });
    payoutId = pay.id;
  }
  return { id: je.id, payoutId };
}
async function outstandingSaleRefsForLc(lcId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain22(res)[0];
  if (String(lc.purpose || "") !== "trading") throw new Error("Payment IN only applies to a Trading LC");
  if (!lc.receivable_party_id) throw new Error("Set the party payment will be received from on this LC first");
  const custRes = await c.execute({ sql: "SELECT name FROM customers WHERE id = ?", args: [Number(lc.receivable_party_id)] });
  const customerName = String(custRes.rows[0]?.name || "").trim();
  if (!customerName) throw new Error("The receivable party could not be found");
  const dealsRes = await c.execute({
    sql: `SELECT DISTINCT td.id, td.sale_id
          FROM trading_deals td
          WHERE EXISTS (
            SELECT 1 FROM lc_linked_orders lo
            WHERE lo.lc_id = ?
              AND lo.order_id IN (
                SELECT order_id FROM trading_deal_orders WHERE deal_id = td.id
                UNION SELECT td.order_id
              )
          )`,
    args: [lcId]
  });
  const dealRows = toPlain22(dealsRes);
  if (!dealRows.length) throw new Error("This LC has no linked Trading deal to receive payment against");
  const dealIds = dealRows.map((d) => n19(d.id));
  const linksRes = await c.execute({
    sql: `SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${dealIds.join(",")})`,
    args: []
  });
  const saleIdsByDeal = /* @__PURE__ */ new Map();
  for (const r of toPlain22(linksRes)) {
    const k = n19(r.deal_id);
    saleIdsByDeal.set(k, [...saleIdsByDeal.get(k) ?? [], n19(r.sale_id)]);
  }
  const saleIds = Array.from(
    new Set(dealRows.flatMap((d) => saleIdsByDeal.get(n19(d.id)) ?? (n19(d.sale_id) ? [n19(d.sale_id)] : [])))
  );
  if (!saleIds.length) throw new Error("This LC's linked Trading deal has no sale invoice yet");
  const salesRes = await c.execute({
    sql: `SELECT COALESCE(sl.invoice_group, sl.invoice_no) AS key, MIN(sl.invoice_no) AS invoice_no,
                 MIN(sl.sale_date) AS sale_date, MIN(cu.name) AS customer_name,
                 SUM(sl.amount + sl.gst_amount + sl.round_off - sl.tds_amount) AS due
          FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
          WHERE sl.id IN (${saleIds.join(",")}) GROUP BY key`,
    args: []
  });
  const bills = toPlain22(salesRes).map((s) => ({
    key: String(s.key || "").trim(),
    invoice_no: String(s.invoice_no || ""),
    sale_date: String(s.sale_date || ""),
    customer_name: String(s.customer_name || "").trim(),
    due: round28(n19(s.due))
  })).filter((s) => s.key);
  if (!bills.length) throw new Error("This LC's linked Trading deal has no sale invoice yet");
  const keys = bills.map((b) => b.key);
  const settledRes = await c.execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amt
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ? AND COALESCE(ba.sale_invoice_group, ba.ref_name) IN (${keys.map(() => "?").join(",")})
          GROUP BY key`,
    args: [n19(lc.company_id) || getActiveCompanyId(), ...keys]
  });
  const settledMap = /* @__PURE__ */ new Map();
  for (const r of toPlain22(settledRes)) settledMap.set(String(r.key), n19(r.amt));
  const refs = bills.map((b) => ({ ...b, due: round28(b.due - (settledMap.get(b.key) || 0)) })).filter((b) => b.due > 5e-3);
  return { lc, customerName, refs };
}
async function listLcOpenTradingInvoices(lcId) {
  const { refs } = await outstandingSaleRefsForLc(lcId).catch(() => ({ refs: [] }));
  return refs;
}
async function postLcPaymentIn(lcId, amount, dateIn, selectedKeys) {
  const { lc, customerName, refs } = await outstandingSaleRefsForLc(lcId);
  const bankAcc = await bankAccountFor(lc);
  const wanted = Array.isArray(selectedKeys) && selectedKeys.length ? new Set(selectedKeys.map(String)) : null;
  const outstanding = wanted ? refs.filter((r) => wanted.has(r.key)) : refs;
  if (!outstanding.length) throw new Error("Every sale invoice on this deal is already fully paid");
  const totalDue = round28(outstanding.reduce((s, o) => s + o.due, 0));
  const value = round28(n19(amount));
  if (value < 5e-3) throw new Error("Enter the amount received");
  if (value > totalDue + 5e-3) {
    throw new Error(`Only ${totalDue.toFixed(2)} is still receivable on the ${wanted ? "selected invoice(s)" : "LC's deal(s)"}`);
  }
  const c = getClient();
  const date = String(dateIn || todayISO5()).slice(0, 10);
  assertNotFuture(date, "The date the payment was received");
  const { takes, byParty } = planReceipt(outstanding, value, customerName);
  const je = await postJournal({
    date,
    vchType: "RECEIPT",
    vchNo: String(lc.lc_no || ""),
    narration: `LC ${lc.lc_no} \u2014 payment IN of ${value.toFixed(2)} received from ` + (byParty.length > 1 ? byParty.map((b) => `${b.party} ${b.amount.toFixed(2)}`).join(", ") : byParty[0]?.party || customerName),
    companyId: n19(lc.company_id) || void 0,
    lines: [
      { account: bankAcc, group: "Bank Accounts", dr: value },
      ...byParty.map((b) => ({ account: b.party, group: "Sundry Debtors", cr: b.amount }))
    ]
  });
  for (const t of takes) await allocAgainst(je.id, t.party, t.key, t.amount);
  await c.execute({
    sql: "INSERT INTO lc_payment_ins (lc_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, ?)",
    args: [lcId, date, value, je.id]
  });
  return { id: je.id, date };
}
async function outstandingSaleRefsForBd(bdId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM bill_discountings WHERE id = ?", args: [bdId] });
  if (!res.rows.length) throw new Error("Discounted bill not found");
  const bd = toPlain22(res)[0];
  if (String(bd.purpose || "") !== "trading") throw new Error("Payment IN only applies to a Trading bill");
  if (!bd.receivable_party_id) throw new Error("Set the party payment will be received from on this bill first");
  const custRes = await c.execute({ sql: "SELECT name FROM customers WHERE id = ?", args: [Number(bd.receivable_party_id)] });
  const customerName = String(custRes.rows[0]?.name || "").trim();
  if (!customerName) throw new Error("The receivable party could not be found");
  const dealsRes = await c.execute({
    sql: `SELECT DISTINCT td.id, td.sale_id
          FROM trading_deals td
          WHERE EXISTS (
            SELECT 1 FROM bd_linked_orders bo
            WHERE bo.bd_id = ?
              AND bo.order_id IN (
                SELECT order_id FROM trading_deal_orders WHERE deal_id = td.id
                UNION SELECT td.order_id
              )
          )`,
    args: [bdId]
  });
  const dealRows = toPlain22(dealsRes);
  if (!dealRows.length) throw new Error("This bill has no linked Trading deal to receive payment against");
  const dealIds = dealRows.map((d) => n19(d.id));
  const linksRes = await c.execute({
    sql: `SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${dealIds.join(",")})`,
    args: []
  });
  const saleIdsByDeal = /* @__PURE__ */ new Map();
  for (const r of toPlain22(linksRes)) {
    const k = n19(r.deal_id);
    saleIdsByDeal.set(k, [...saleIdsByDeal.get(k) ?? [], n19(r.sale_id)]);
  }
  const saleIds = Array.from(
    new Set(dealRows.flatMap((d) => saleIdsByDeal.get(n19(d.id)) ?? (n19(d.sale_id) ? [n19(d.sale_id)] : [])))
  );
  if (!saleIds.length) throw new Error("This bill's linked Trading deal has no sale invoice yet");
  const salesRes = await c.execute({
    sql: `SELECT COALESCE(sl.invoice_group, sl.invoice_no) AS key, MIN(sl.invoice_no) AS invoice_no,
                 MIN(sl.sale_date) AS sale_date, MIN(cu.name) AS customer_name,
                 SUM(sl.amount + sl.gst_amount + sl.round_off - sl.tds_amount) AS due
          FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
          WHERE sl.id IN (${saleIds.join(",")}) GROUP BY key`,
    args: []
  });
  const bills = toPlain22(salesRes).map((x) => ({
    key: String(x.key || "").trim(),
    invoice_no: String(x.invoice_no || ""),
    sale_date: String(x.sale_date || ""),
    customer_name: String(x.customer_name || "").trim(),
    due: round28(n19(x.due))
  })).filter((x) => x.key);
  if (!bills.length) throw new Error("This bill's linked Trading deal has no sale invoice yet");
  const keys = bills.map((b) => b.key);
  const settledRes = await c.execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amt
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ?
            AND COALESCE(ba.sale_invoice_group, ba.ref_name) IN (${keys.map(() => "?").join(",")})
          GROUP BY key`,
    args: [n19(bd.company_id) || getActiveCompanyId(), ...keys]
  });
  const settled = /* @__PURE__ */ new Map();
  for (const r of toPlain22(settledRes)) settled.set(String(r.key), n19(r.amt));
  const refs = bills.map((b) => ({ ...b, due: round28(b.due - (settled.get(b.key) || 0)) })).filter((b) => b.due > 5e-3);
  return { bd, customerName, refs };
}
async function listBdOpenTradingInvoices(bdId) {
  try {
    const { refs } = await outstandingSaleRefsForBd(bdId);
    return refs;
  } catch {
    return [];
  }
}
async function postBdPaymentIn(bdId, amount, dateIn, selectedKeys) {
  const { bd, customerName, refs } = await outstandingSaleRefsForBd(bdId);
  const wanted = Array.isArray(selectedKeys) && selectedKeys.length ? new Set(selectedKeys.map(String)) : null;
  const outstanding = wanted ? refs.filter((r) => wanted.has(r.key)) : refs;
  if (!outstanding.length) throw new Error("Every sale invoice on this deal is already fully paid");
  const totalDue = round28(outstanding.reduce((t, o) => t + o.due, 0));
  const value = round28(n19(amount));
  if (value < 5e-3) throw new Error("Enter the amount received");
  if (value > totalDue + 5e-3) {
    throw new Error(
      `Only ${totalDue.toFixed(2)} is still receivable on the ${wanted ? "selected invoice(s)" : "bill's deal(s)"}`
    );
  }
  const c = getClient();
  const date = String(dateIn || todayISO5()).slice(0, 10);
  assertNotFuture(date, "The date the payment was received");
  const { takes, byParty } = planReceipt(outstanding, value, customerName);
  const je = await postJournal({
    date,
    vchType: "RECEIPT",
    vchNo: String(bd.bd_no || ""),
    narration: `Bill Discounting ${bd.bd_no} \u2014 payment IN of ${value.toFixed(2)} received from ` + (byParty.length > 1 ? byParty.map((b) => `${b.party} ${b.amount.toFixed(2)}`).join(", ") : byParty[0]?.party || customerName),
    companyId: n19(bd.company_id) || void 0,
    lines: [
      { account: "BANK A/C", group: "Bank Accounts", dr: value },
      ...byParty.map((b) => ({ account: b.party, group: "Sundry Debtors", cr: b.amount }))
    ]
  });
  for (const t of takes) await allocAgainst(je.id, t.party, t.key, t.amount);
  await c.execute({
    sql: "INSERT INTO bd_payment_ins (bd_id, pay_date, amount, journal_entry_id) VALUES (?, ?, ?, ?)",
    args: [bdId, date, value, je.id]
  });
  return { id: je.id, date };
}
async function listBdPaymentIns(bdId) {
  const res = await getClient().execute({
    sql: "SELECT * FROM bd_payment_ins WHERE bd_id = ? ORDER BY id DESC",
    args: [bdId]
  });
  return toPlain22(res);
}
async function deleteBdPaymentIn(paymentInId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT journal_entry_id FROM bd_payment_ins WHERE id = ?", args: [paymentInId] });
  if (!res.rows.length) throw new Error("That receipt no longer exists");
  const je = n19(res.rows[0].journal_entry_id);
  if (je) {
    await c.execute({
      sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
      args: [je]
    });
    await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [je] });
    await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [je] });
  }
  await c.execute({ sql: "DELETE FROM bd_payment_ins WHERE id = ?", args: [paymentInId] });
  return { id: paymentInId };
}
async function listAllLcRepayments() {
  const res = await getClient().execute({
    sql: `SELECT r.*, l.lc_no, l.bank, s.name AS supplier_name
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          WHERE l.company_id = ?
          ORDER BY l.lc_no, r.repay_date, r.id`,
    args: [getActiveCompanyId()]
  });
  return toPlain22(res);
}
async function listLcPaymentIns(lcId) {
  const res = await getClient().execute({
    sql: "SELECT * FROM lc_payment_ins WHERE lc_id = ? ORDER BY id DESC",
    args: [lcId]
  });
  return toPlain22(res);
}
async function deleteLcPaymentIn(id) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT journal_entry_id FROM lc_payment_ins WHERE id = ?", args: [id] });
  if (res.rows.length && res.rows[0].journal_entry_id) await dropEntry(n19(res.rows[0].journal_entry_id));
  await c.execute({ sql: "DELETE FROM lc_payment_ins WHERE id = ?", args: [id] });
  return { id };
}
async function settleLcBill(issuanceId, dateIn) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT status FROM lc_issuances WHERE id = ?", args: [issuanceId] });
  if (!res.rows.length) throw new Error("LC bill not found");
  if (String(res.rows[0].status) === "settled") throw new Error("This bill is already settled");
  const je = await settleLcBillsCombined([issuanceId], dateIn);
  if (!je) throw new Error("That bill could not be settled");
  return je;
}
async function settleLcBillsCombined(issuanceIds, dateIn, reuseEntryId) {
  if (!issuanceIds.length) return null;
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT i.*, l.lc_no, l.bank, l.our_bank_id, l.party_type, l.party_id, l.company_id,
                 l.amount AS lc_amount, l.charges AS lc_charges, l.interest_pct, l.usance_days,
                 l.interest_upfront, l.interest_excl_charges, l.interest_adj,
                 l.interest_journal_entry_id,
                 s.name AS supplier_name, o.invoice_no
          FROM lc_issuances i
          JOIN letters_of_credit l ON l.id = i.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.id IN (${issuanceIds.map(() => "?").join(",")})`,
    args: issuanceIds
  });
  const bills = toPlain22(res).filter((b) => String(b.status) !== "settled");
  if (!bills.length) return null;
  const first = bills[0];
  const party = String(first.supplier_name || "").trim();
  if (!party) throw new Error("The LC has no supplier party \u2014 set it on the LC first");
  const date = String(dateIn || todayISO5()).slice(0, 10);
  const total = round28(bills.reduce((s2, b) => s2 + n19(b.amount), 0));
  const payable = await lcPayable(first);
  const feeLines = [];
  let fees = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const b of bills) {
    const lcId = n19(b.lc_id);
    if (seen.has(lcId)) continue;
    seen.add(lcId);
    if (n19(b.interest_journal_entry_id)) continue;
    const interest = lcInterest({
      amount: b.lc_amount,
      charges: b.lc_charges,
      interest_pct: b.interest_pct,
      usance_days: b.usance_days,
      interest_excl_charges: b.interest_excl_charges,
      interest_adj: b.interest_adj
    });
    const charges = round28(n19(b.lc_charges));
    if (interest > 5e-3) feeLines.push({ account: "INTEREST A/C", group: "Indirect Expenses", dr: interest });
    if (charges > 5e-3) feeLines.push({ account: "BANK CHARGES A/C", group: "Indirect Expenses", dr: charges });
    fees = round28(fees + interest + charges);
  }
  const post = reuseEntryId ? (args) => repostJournal(reuseEntryId, args) : postJournal;
  const je = await post({
    date,
    // A JOURNAL, not a PAYMENT. Nothing of yours moves here — the bank honours
    // the credit out of its own funds. One liability is exchanged for another:
    // the supplier is discharged, and the bank takes their place.
    vchType: "JOURNAL",
    vchNo: String(first.lc_no || ""),
    // A bill auto-issued against the whole LC is NAMED after it, so repeating
    // the name tells the reader nothing. It is mentioned only when it carries a
    // name of its own, such as a reference the bank gave you.
    narration: (() => {
      const bill = String(first.bill_no || "").trim();
      const named = bills.length === 1 && bill && bill !== String(first.lc_no || "").trim() ? ` (bill ${bill})` : "";
      const many = bills.length > 1 ? ` \u2014 ${bills.length} bills` : "";
      const kept = fees > 5e-3 ? `, keeping ${fees.toFixed(2)} interest and commission` : "";
      const basis = fees > 5e-3 && lcInterestBaseIsCustom(first) ? ` (interest on ${lcInterestBasis(first)})` : "";
      return `LC ${first.lc_no}${named}${many} matured \u2014 ${first.bank} paid ${party} ${total.toFixed(2)}${kept}${basis}`;
    })(),
    companyId: n19(first.company_id) || void 0,
    lines: [
      { account: party, group: "Sundry Creditors", dr: total },
      ...feeLines,
      { account: payable, group: LC_PAYABLE_GROUP, cr: round28(total + fees) }
    ]
  });
  for (const b of bills) {
    const ref = b.invoice_no ? String(b.invoice_no) : b.bill_no ? String(b.bill_no) : null;
    await allocAgainst(je.id, party, ref, round28(n19(b.amount)));
  }
  await c.execute({
    sql: `UPDATE lc_issuances SET status = 'settled', settled_date = ?, journal_entry_id = ?
          WHERE id IN (${bills.map(() => "?").join(",")})`,
    args: [date, je.id, ...bills.map((b) => Number(b.id))]
  });
  return { id: je.id };
}
async function resyncLcSettlement(lcId) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT id, journal_entry_id, settled_date FROM lc_issuances
           WHERE lc_id = ? AND journal_entry_id IS NOT NULL ORDER BY journal_entry_id, id`,
    args: [n19(lcId)]
  });
  if (!res.rows.length) return;
  const groups = /* @__PURE__ */ new Map();
  for (const r of toPlain22(res)) {
    const je = n19(r.journal_entry_id);
    if (!groups.has(je)) groups.set(je, { ids: [], date: String(r.settled_date || "").slice(0, 10) });
    groups.get(je).ids.push(n19(r.id));
  }
  const live = [];
  for (const [entryId, g] of groups) {
    await c.execute({
      sql: `UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL
             WHERE id IN (${g.ids.map(() => "?").join(",")})`,
      args: g.ids
    });
    const je = await settleLcBillsCombined(g.ids, g.date || void 0, entryId);
    if (je) live.push(je.id);
  }
  const dropped = await dropOrphanLcSettlements(lcId, live);
  if (dropped) console.log(`[lc] removed ${dropped} orphaned settlement voucher(s) on LC ${lcId}`);
}
async function dropOrphanLcSettlements(lcId, keep = []) {
  const c = getClient();
  const lc = await c.execute({
    sql: "SELECT lc_no, company_id FROM letters_of_credit WHERE id = ?",
    args: [n19(lcId)]
  });
  if (!lc.rows.length) return 0;
  const lcNo = String(lc.rows[0].lc_no || "").trim();
  if (!lcNo) return 0;
  const skip = keep.filter((x) => n19(x) > 0);
  const res = await c.execute({
    sql: `SELECT je.id FROM journal_entries je
           WHERE je.company_id = ?
             AND TRIM(COALESCE(je.vch_no, '')) = ?
             AND je.vch_type = 'JOURNAL'
             AND je.narration LIKE '%matured%'
             AND NOT EXISTS (SELECT 1 FROM lc_issuances i WHERE i.journal_entry_id = je.id)
             ${skip.length ? `AND je.id NOT IN (${skip.map(() => "?").join(",")})` : ""}`,
    args: [n19(lc.rows[0].company_id), lcNo, ...skip]
  });
  for (const r of res.rows) await dropEntry(n19(r.id));
  return res.rows.length;
}
async function reopenLcBill(issuanceId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT journal_entry_id FROM lc_issuances WHERE id = ?", args: [issuanceId] });
  if (!res.rows.length) throw new Error("LC bill not found");
  const entryId = n19(res.rows[0].journal_entry_id) || null;
  await dropEntry(entryId);
  const sql = entryId ? "UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL WHERE journal_entry_id = ?" : "UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL WHERE id = ?";
  await c.execute({ sql, args: [entryId || issuanceId] });
  return { id: issuanceId };
}
async function listLcRepayments(lcId) {
  const res = await getClient().execute({
    sql: `SELECT r.*, cu.name AS party_name FROM lc_repayments r
          LEFT JOIN customers cu ON cu.id = r.party_id
          WHERE r.lc_id = ? ORDER BY r.id DESC`,
    args: [lcId]
  });
  return toPlain22(res);
}
async function postLcRepaymentEntry(repaymentId) {
  const c = getClient();
  const res = await c.execute({
    sql: `SELECT r.*, l.lc_no, l.company_id, l.bank, l.our_bank_id, l.amount AS lc_open_amount,
                 l.interest_upfront, l.interest_journal_entry_id AS lc_interest_journal_entry_id,
                 l.interest_pct AS lc_interest_pct, l.usance_days AS lc_usance_days,
                 l.charges AS lc_charges, l.interest_excl_charges AS lc_interest_excl_charges,
                 l.interest_adj AS lc_interest_adj
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          WHERE r.id = ?`,
    args: [repaymentId]
  });
  if (!res.rows.length) throw new Error("Repayment not found");
  const rep = toPlain22(res)[0];
  const bankAcc = await bankAccountFor(rep);
  const payable = await lcPayable(rep);
  await dropEntry(n19(rep.journal_entry_id) || null);
  await dropEntry(n19(rep.fee_journal_entry_id) || null);
  const ownFeeJe = n19(rep.fee_journal_entry_id) || null;
  const upfrontStillDue = !!rep.interest_upfront && (!n19(rep.lc_interest_journal_entry_id) || n19(rep.lc_interest_journal_entry_id) === ownFeeJe);
  const upfrontInterest = upfrontStillDue ? lcInterest({
    amount: n19(rep.lc_open_amount),
    interest_pct: n19(rep.lc_interest_pct),
    usance_days: n19(rep.lc_usance_days),
    interest_excl_charges: rep.lc_interest_excl_charges,
    interest_adj: n19(rep.lc_interest_adj)
  }) : 0;
  const upfrontCharges = upfrontStillDue ? round28(n19(rep.lc_charges)) : 0;
  const total = round28(n19(rep.amount));
  const comm = round28(n19(rep.comm_charges));
  const extra = round28(n19(rep.bank_charges) + upfrontCharges);
  const onTheDay = round28(comm + extra + upfrontInterest);
  const date = String(rep.repay_date || todayISO5()).slice(0, 10);
  let feeJe = null;
  if (onTheDay > 4e-3) {
    const lines = [];
    if (upfrontInterest > 5e-3) lines.push({ account: "INTEREST A/C", group: "Indirect Expenses", dr: upfrontInterest });
    if (comm > 5e-3) lines.push({ account: "COMM. CHARGES A/C", group: "Indirect Expenses", dr: comm });
    if (extra > 5e-3) lines.push({ account: "BANK CHARGES A/C", group: "Indirect Expenses", dr: extra });
    lines.push({ account: payable, group: LC_PAYABLE_GROUP, cr: onTheDay });
    const je2 = await postJournal({
      date,
      vchType: "JOURNAL",
      vchNo: rep.lc_no ? String(rep.lc_no) : null,
      narration: upfrontStillDue ? `LC ${rep.lc_no} \u2014 ${rep.bank || "the bank"} charged ${onTheDay.toFixed(2)} on settlement (interest never reconciled upfront, caught at repayment)` : `LC ${rep.lc_no} \u2014 ${rep.bank || "the bank"} charged ${onTheDay.toFixed(2)} on settlement`,
      companyId: n19(rep.company_id) || void 0,
      lines
    });
    feeJe = je2.id;
    if (upfrontStillDue) {
      await c.execute({
        sql: "UPDATE letters_of_credit SET interest_journal_entry_id = ? WHERE id = ?",
        args: [je2.id, n19(rep.lc_id)]
      });
    }
  } else if (n19(rep.lc_interest_journal_entry_id) === ownFeeJe && ownFeeJe) {
    await c.execute({ sql: "UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ?", args: [n19(rep.lc_id)] });
  }
  const je = await postJournal({
    date,
    vchType: "PAYMENT",
    vchNo: rep.lc_no ? String(rep.lc_no) : null,
    narration: `LC ${rep.lc_no} repaid to ${rep.bank || "the bank"}`,
    companyId: n19(rep.company_id) || void 0,
    lines: [
      { account: payable, group: LC_PAYABLE_GROUP, dr: total },
      { account: bankAcc, group: "Bank Accounts", cr: total }
    ]
  });
  await c.execute({
    sql: "UPDATE lc_repayments SET journal_entry_id = ?, fee_journal_entry_id = ? WHERE id = ?",
    args: [je.id, feeJe, repaymentId]
  });
}
async function saveLcRepayment(v) {
  const c = getClient();
  const lcId = n19(v.lc_id);
  if (!lcId) throw new Error("Pick the LC this repayment is against");
  const amount = n19(v.amount);
  if (amount <= 0) throw new Error("Enter the repayment amount");
  const lcRes = await c.execute({ sql: "SELECT amount FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!lcRes.rows.length) throw new Error("LC not found");
  const openAmount = n19(lcRes.rows[0].amount);
  if (amount < openAmount - 5e-3) {
    throw new Error(`The repayment (${amount.toFixed(2)}) cannot be less than the LC's open amount (${openAmount.toFixed(2)})`);
  }
  const commCharges = round28(n19(v.comm_charges));
  const bankCharges = round28(n19(v.bank_charges));
  const excess = round28(amount - openAmount);
  if (excess > 5e-3) {
    if (Math.abs(commCharges + bankCharges - excess) > 5e-3) {
      throw new Error(
        `Comm. charges + Bank charges must add up to the ${excess.toFixed(2)} over the open amount (currently ${(commCharges + bankCharges).toFixed(2)})`
      );
    }
  } else if (commCharges > 5e-3 || bankCharges > 5e-3) {
    throw new Error("Comm. charges and Bank charges only apply when the repayment exceeds the open amount");
  }
  const maturityCharges = round28(commCharges + bankCharges);
  const posted = v.posted ? 1 : 0;
  assertNotFuture(v.repay_date ? String(v.repay_date).slice(0, 10) : "", "The repayment date");
  const args = [
    lcId,
    v.party_id ? n19(v.party_id) : null,
    amount,
    maturityCharges,
    commCharges,
    bankCharges,
    v.repay_date ? String(v.repay_date).slice(0, 10) : todayISO5(),
    posted,
    v.document_path ? String(v.document_path) : null,
    v.note ? String(v.note).trim() : null
  ];
  let id;
  if (v.id) {
    id = n19(v.id);
    const prev = await c.execute({
      sql: "SELECT posted, journal_entry_id, fee_journal_entry_id FROM lc_repayments WHERE id = ?",
      args: [id]
    });
    if (!prev.rows.length) throw new Error("Repayment not found");
    await c.execute({
      sql: `UPDATE lc_repayments SET lc_id = ?, party_id = ?, amount = ?, maturity_charges = ?, comm_charges = ?, bank_charges = ?,
            repay_date = ?, posted = ?, document_path = ?, note = ? WHERE id = ?`,
      args: [...args, id]
    });
    if (n19(prev.rows[0].posted) && !posted) {
      const oldFeeJe = n19(prev.rows[0].fee_journal_entry_id) || null;
      await dropEntry(n19(prev.rows[0].journal_entry_id) || null);
      await dropEntry(oldFeeJe);
      await c.execute({
        sql: "UPDATE lc_repayments SET journal_entry_id = NULL, fee_journal_entry_id = NULL WHERE id = ?",
        args: [id]
      });
      if (oldFeeJe) {
        await c.execute({
          sql: "UPDATE letters_of_credit SET interest_journal_entry_id = NULL WHERE id = ? AND interest_journal_entry_id = ?",
          args: [lcId, oldFeeJe]
        });
      }
    }
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO lc_repayments (lc_id, party_id, amount, maturity_charges, comm_charges, bank_charges, repay_date, posted, document_path, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args
    });
    id = Number(ins.lastInsertRowid);
  }
  if (posted) {
    try {
      await postLcRepaymentEntry(id);
    } catch (e) {
      await c.execute({ sql: "UPDATE lc_repayments SET posted = 0 WHERE id = ?", args: [id] });
      throw e;
    }
  }
  return { id };
}
async function deleteLcRepayment(id) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT journal_entry_id, fee_journal_entry_id FROM lc_repayments WHERE id = ?",
    args: [id]
  });
  if (res.rows.length) {
    await dropEntry(n19(res.rows[0].journal_entry_id) || null);
    await dropEntry(n19(res.rows[0].fee_journal_entry_id) || null);
  }
  await c.execute({ sql: "DELETE FROM lc_repayments WHERE id = ?", args: [id] });
  return { id };
}
async function treasuryAlerts() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const today = todayISO5();
  const lcs = toPlain22(
    await c.execute({
      sql: `SELECT l.*, s.name AS supplier_name,
                   COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized
            FROM letters_of_credit l
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            WHERE l.company_id = ? AND l.status != 'closed'`,
      args: [cid]
    })
  );
  const lcExpiring = lcs.filter((l) => !l.preclosed_date).map((l) => ({ ...l, days_left: l.expiry_date ? daysBetween(today, String(l.expiry_date)) : null })).filter((l) => l.days_left != null && l.days_left <= 15).sort((a, b) => a.days_left - b.days_left);
  const lcBills = toPlain22(
    await c.execute({
      sql: `SELECT i.*, l.lc_no, l.bank, s.name AS supplier_name, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ? AND COALESCE(i.status, 'outstanding') = 'outstanding' AND i.due_date IS NOT NULL`,
      args: [cid]
    })
  );
  const lcBillsDue = lcBills.map((b) => ({ ...b, days_left: daysBetween(today, String(b.due_date)) })).filter((b) => b.days_left <= 7).sort((a, b) => a.days_left - b.days_left);
  const bd = toPlain22(
    await c.execute({
      sql: `SELECT bd.*, nb.name AS nbfc_name,
                   COALESCE(s.name, cu.name) AS party_name
            FROM bill_discountings bd
            LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
            LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
            LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
            WHERE bd.company_id = ? AND bd.status = 'open' AND bd.maturity_date IS NOT NULL`,
      args: [cid]
    })
  );
  const billsDue = bd.map((b) => ({ ...b, days_left: daysBetween(today, String(b.maturity_date)) })).filter((b) => b.days_left <= 7).sort((a, b) => a.days_left - b.days_left);
  return {
    lcExpiring,
    lcBillsDue,
    billsDue,
    overdue: lcBillsDue.filter((b) => b.days_left < 0).length + billsDue.filter((b) => b.days_left < 0).length + lcExpiring.filter((l) => l.days_left < 0).length
  };
}
async function listPaymentTracker() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const today = todayISO5();
  const lcBills = toPlain22(
    await c.execute({
      sql: `SELECT i.id, i.amount, i.due_date, i.status, i.issue_date,
                   l.lc_no AS ref, l.bank, s.name AS party, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: "lc_bill",
    kind_label: "LC bill",
    ref: String(r.ref || ""),
    detail: `${r.bank || ""}${r.invoice_no ? ` \xB7 inv ${r.invoice_no}` : ""}`,
    party: String(r.party || ""),
    amount: n19(r.amount),
    due_date: r.due_date ? String(r.due_date) : null,
    status: String(r.status || "outstanding"),
    settled: String(r.status || "outstanding") === "settled"
  }));
  const bd = toPlain22(
    await c.execute({
      sql: `SELECT bd.id, bd.bd_no, bd.amount, bd.maturity_date, bd.status, bd.finance_type,
                   nb.name AS nbfc_name, COALESCE(s.name, cu.name) AS party_name
            FROM bill_discountings bd
            LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
            LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
            LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
            WHERE bd.company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: "bill_discount",
    kind_label: "Bill discounting",
    ref: String(r.bd_no || ""),
    detail: `${r.nbfc_name || ""}${r.finance_type ? ` \xB7 ${r.finance_type}` : ""}`,
    party: String(r.party_name || ""),
    amount: n19(r.amount),
    due_date: r.maturity_date ? String(r.maturity_date) : null,
    status: String(r.status || "open"),
    settled: String(r.status || "") === "repaid"
  }));
  const all = [...lcBills, ...bd].map((r) => {
    const daysLeft = r.due_date ? daysBetween(today, r.due_date) : null;
    return {
      ...r,
      days_left: daysLeft,
      due_period: duePeriodOf(daysLeft),
      overdue: !r.settled && daysLeft != null && daysLeft < 0
    };
  });
  all.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1;
    const ad = a.days_left ?? Infinity;
    const bd2 = b.days_left ?? Infinity;
    return ad - bd2;
  });
  return all;
}

// src/main/approvals.ts
function toPlain23(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var APPROVAL_TABLES = /* @__PURE__ */ new Set([
  "oil_types",
  "products",
  "suppliers",
  "transporters",
  "customers",
  "sources",
  "uoms",
  "brokers",
  "packagings"
]);
async function actingIsAdmin() {
  const u = getCurrentUser();
  if (!u.id) return true;
  const r = await getClient().execute({ sql: "SELECT role FROM users WHERE id = ?", args: [u.id] });
  return r.rows.length ? String(r.rows[0].role) === "admin" : false;
}
async function needsApproval(table) {
  if (!APPROVAL_TABLES.has(table)) return false;
  return !await actingIsAdmin();
}
async function submitApprovalRequest(table, values) {
  const u = getCurrentUser();
  const label = String(values.name ?? values.code ?? "").trim();
  const res = await getClient().execute({
    sql: `INSERT INTO approval_requests (table_name, action, payload, label, requested_by, requested_by_name, status)
          VALUES (?, 'create', ?, ?, ?, ?, 'pending')`,
    args: [table, JSON.stringify(values), label || null, u.id ?? null, u.username || null]
  });
  return { pending: true, requestId: Number(res.lastInsertRowid) };
}
async function listApprovalRequests() {
  const res = await getClient().execute(
    "SELECT * FROM approval_requests ORDER BY (status = 'pending') DESC, id DESC"
  );
  return toPlain23(res);
}
async function myApprovalRequests() {
  const u = getCurrentUser();
  if (!u.id) return [];
  const res = await getClient().execute({
    sql: "SELECT * FROM approval_requests WHERE requested_by = ? ORDER BY id DESC",
    args: [u.id]
  });
  return toPlain23(res);
}
async function pendingApprovalCount() {
  const res = await getClient().execute("SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'");
  return Number(res.rows[0]?.n) || 0;
}
async function assertAdmin() {
  if (!await actingIsAdmin()) throw new Error("Only an admin can decide approvals");
}
async function loadPending(id) {
  const res = await getClient().execute({ sql: "SELECT * FROM approval_requests WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("Approval request not found");
  const row = toPlain23(res)[0];
  if (String(row.status) !== "pending") throw new Error("This request has already been decided");
  return row;
}
async function approveRequest(id) {
  await assertAdmin();
  const req = await loadPending(id);
  const values = JSON.parse(String(req.payload));
  const created = await create(String(req.table_name), values);
  const u = getCurrentUser();
  await getClient().execute({
    sql: `UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_by_name = ?,
          decided_at = datetime('now'), created_id = ? WHERE id = ?`,
    args: [u.id ?? null, u.username || null, created.id, id]
  });
  return { id, createdId: created.id };
}
async function rejectRequest(id, reason) {
  await assertAdmin();
  const clean = String(reason || "").trim();
  if (!clean) throw new Error("A reason is required to reject");
  await loadPending(id);
  const u = getCurrentUser();
  await getClient().execute({
    sql: `UPDATE approval_requests SET status = 'rejected', decided_by = ?, decided_by_name = ?,
          decided_at = datetime('now'), reason = ? WHERE id = ?`,
    args: [u.id ?? null, u.username || null, clean, id]
  });
  return { id };
}

// src/main/facilities.ts
function toPlain24(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var n20 = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
async function listFacilities() {
  const res = await getClient().execute({
    sql: `SELECT f.*,
            COALESCE((SELECT SUM(l.amount - COALESCE((SELECT SUM(r.amount) FROM lc_repayments r
                       WHERE r.lc_id = l.id AND r.posted = 1), 0)) FROM letters_of_credit l
                       WHERE l.facility_id = f.id AND l.status != 'closed'), 0) AS lc_committed,
            COALESCE((SELECT SUM(i.amount) FROM lc_issuances i
                       JOIN letters_of_credit l2 ON l2.id = i.lc_id
                      WHERE l2.facility_id = f.id), 0) AS lc_utilized,
            COALESCE((SELECT SUM(e.amount) FROM facility_exposures e
                       WHERE e.facility_id = f.id AND e.kind = 'outstanding'), 0) AS other_outstanding,
            COALESCE((SELECT SUM(e.amount) FROM facility_exposures e
                       WHERE e.facility_id = f.id AND e.kind = 'planned'), 0) AS planned
          FROM bank_facilities f
          WHERE f.company_id = ?
          ORDER BY f.active DESC, f.name`,
    args: [getActiveCompanyId()]
  });
  return toPlain24(res).map((f) => {
    const committed = n20(f.lc_committed) + n20(f.other_outstanding);
    return {
      ...f,
      total_outstanding: committed,
      available: n20(f.sanctioned_limit) - committed,
      // What would be left if everything currently planned were also drawn.
      available_after_planned: n20(f.sanctioned_limit) - committed - n20(f.planned)
    };
  });
}
async function listFacilityExposures(facilityId) {
  const res = await getClient().execute({
    sql: "SELECT * FROM facility_exposures WHERE facility_id = ? ORDER BY kind, id",
    args: [facilityId]
  });
  return toPlain24(res);
}
var FACILITY_COLS = ["name", "bank", "facility_type", "sanctioned_limit", "sanction_date", "review_date", "note", "active"];
var FACILITY_FALLBACK = {
  facility_type: "lc",
  sanctioned_limit: 0,
  active: 1
};
function facilityArgs(v) {
  return FACILITY_COLS.map((k) => {
    const val = v[k];
    if (val === "" || val === void 0 || val === null) return FACILITY_FALLBACK[k] ?? null;
    if (k === "sanctioned_limit") return n20(val);
    if (k === "active") return val ? 1 : 0;
    return String(val);
  });
}
async function createFacility(v) {
  if (!String(v.name || "").trim()) throw new Error("Give the facility a name");
  if (!String(v.bank || "").trim()) throw new Error("Name the bank");
  const res = await getClient().execute({
    sql: `INSERT INTO bank_facilities (company_id, ${FACILITY_COLS.join(", ")})
          VALUES (?, ${FACILITY_COLS.map(() => "?").join(", ")})`,
    args: [getActiveCompanyId(), ...facilityArgs(v)]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function updateFacility(id, v) {
  await getClient().execute({
    sql: `UPDATE bank_facilities SET ${FACILITY_COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    args: [...facilityArgs(v), id]
  });
  return { id };
}
async function deleteFacility(id) {
  const c = getClient();
  const lc = await c.execute({ sql: "SELECT COUNT(*) AS n FROM letters_of_credit WHERE facility_id = ?", args: [id] });
  if (n20(lc.rows[0].n) > 0) {
    throw new Error(
      `${n20(lc.rows[0].n)} LC(s) draw against this facility \u2014 unlink them first, or switch the facility off instead so its history stays.`
    );
  }
  await c.execute({ sql: "DELETE FROM facility_exposures WHERE facility_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM bank_facilities WHERE id = ?", args: [id] });
  return { id };
}
async function saveExposure(v) {
  const c = getClient();
  const facilityId = n20(v.facility_id);
  if (!facilityId) throw new Error("Pick the facility this balance sits under");
  if (!String(v.label || "").trim()) throw new Error("Name this balance (e.g. the account it belongs to)");
  const args = [
    String(v.label).trim(),
    n20(v.amount),
    String(v.kind || "outstanding"),
    v.as_of ? String(v.as_of).slice(0, 10) : null,
    v.note ? String(v.note).trim() : null
  ];
  if (v.id) {
    await c.execute({
      sql: "UPDATE facility_exposures SET label = ?, amount = ?, kind = ?, as_of = ?, note = ? WHERE id = ?",
      args: [...args, n20(v.id)]
    });
    return { id: n20(v.id) };
  }
  const res = await c.execute({
    sql: `INSERT INTO facility_exposures (facility_id, label, amount, kind, as_of, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [facilityId, ...args]
  });
  return { id: Number(res.lastInsertRowid) };
}
async function deleteExposure(id) {
  await getClient().execute({ sql: "DELETE FROM facility_exposures WHERE id = ?", args: [id] });
  return { id };
}
async function facilityHeadroom(facilityId, excludeLcId = 0) {
  const c = getClient();
  const f = await c.execute({ sql: "SELECT * FROM bank_facilities WHERE id = ?", args: [facilityId] });
  if (!f.rows.length) throw new Error("That facility no longer exists");
  const lc = await c.execute({
    sql: `SELECT COALESCE(SUM(l.amount - COALESCE((SELECT SUM(r.amount) FROM lc_repayments r
                 WHERE r.lc_id = l.id AND r.posted = 1), 0)), 0) AS a
          FROM letters_of_credit l WHERE l.facility_id = ? AND l.status != 'closed' AND l.id != ?`,
    args: [facilityId, excludeLcId]
  });
  const other = await c.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS a FROM facility_exposures WHERE facility_id = ? AND kind = 'outstanding'",
    args: [facilityId]
  });
  const sanctioned = n20(f.rows[0].sanctioned_limit);
  const lcCommitted = n20(lc.rows[0].a);
  const otherOutstanding = n20(other.rows[0].a);
  return {
    facility_id: facilityId,
    name: f.rows[0].name,
    sanctioned,
    lc_committed: lcCommitted,
    other_outstanding: otherOutstanding,
    total_outstanding: lcCommitted + otherOutstanding,
    available: sanctioned - lcCommitted - otherOutstanding
  };
}

// src/main/lc.ts
function toPlain25(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n21(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function round29(v) {
  return Math.round(v * 100) / 100;
}
function netAvailable(lc, issued) {
  const interest = lc.interest_upfront ? 0 : lcInterest(lc);
  const charges = lc.interest_upfront ? 0 : round29(n21(lc.charges));
  return round29(n21(lc.amount) - interest - charges - issued);
}
async function listLCs() {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*,
      s.name AS supplier_name,
      l.bank AS bank_name,
      ob.name AS our_bank_name,
      f.name AS facility_name,
      rp.name AS receivable_party_name,
      (SELECT GROUP_CONCAT(lo.order_id) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_order_ids_csv,
      (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_nos,
      (SELECT COALESCE(SUM(o.net_amount), 0) FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_amount_total,
      (SELECT COUNT(*) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_invoice_count,
      (SELECT GROUP_CONCAT(td.id) FROM trading_deals td WHERE td.lc_id = l.id) AS linked_deal_ids_csv,
      COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized,
      COALESCE((SELECT SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END) FROM lc_issuances WHERE lc_id = l.id), 0) AS settled_total,
      COALESCE((SELECT COUNT(CASE WHEN order_id IS NOT NULL THEN 1 END) FROM lc_issuances WHERE lc_id = l.id), 0) AS linked_bill_count,
      l.amount - COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS available,
      COALESCE((SELECT SUM(amount) FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid,
      (SELECT MIN(due_date) FROM lc_issuances WHERE lc_id = l.id AND COALESCE(status, 'outstanding') != 'settled') AS next_due_date
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
    LEFT JOIN banks ob ON ob.id = l.our_bank_id
    LEFT JOIN bank_facilities f ON f.id = l.facility_id
    LEFT JOIN customers rp ON rp.id = l.receivable_party_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  });
  return toPlain25(res).map((l) => {
    const linkedCount = n21(l.linked_invoice_count);
    const margin = Math.round(n21(l.amount) * n21(l.margin_pct) / 100 * 100) / 100;
    const interest = lcInterest(l);
    const rawCharges = Math.round(n21(l.charges) * 100) / 100;
    const chargedInterest = l.interest_upfront ? 0 : interest;
    const charges = l.interest_upfront ? 0 : rawCharges;
    const compliant = String(l.purpose || "") !== "trading" || linkedCount > 0 && !!l.receivable_party_id;
    return {
      ...l,
      linked_order_ids: String(l.linked_order_ids_csv || "").split(",").map((x) => Number(x)).filter((x) => x > 0),
      linked_deal_ids: String(l.linked_deal_ids_csv || "").split(",").map((x) => Number(x)).filter((x) => x > 0),
      // Back-calculated: the open amount is the limit struck with the bank —
      // interest and charges come OUT of it, not added on top (unless both
      // are paid upfront from the bank instead — see interest_upfront).
      lc_net_available: Math.round((n21(l.amount) - chargedInterest - charges) * 100) / 100,
      // What the beneficiary was ACTUALLY paid: the bills the bank honoured.
      //
      // lc_net_available above is a back-calculation — open amount less what
      // the fees ought to be — and the two disagreed. LC-15's bill was raised
      // for 1,60,57,801.64 while the back-calculation said 1,60,54,441.64,
      // because the bill deducted the interest and not the ₹3,360 charges. The
      // ledger carried one figure and the register showed the other.
      //
      // A recorded amount beats a formula, every time. Until a bill exists
      // there is nothing recorded, so the expectation stands in — and says so.
      paid_to_party: n21(l.utilized) > 4e-3 ? round29(n21(l.utilized)) : null,
      paid_expected: Math.round((n21(l.amount) - chargedInterest - charges) * 100) / 100,
      // What's actually left to issue bills against — interest and charges
      // come out of the open amount before issued bills reduce it further.
      // The shortfall an over-drawn LC used to show as a negative balance is
      // now credited back to the party instead (syncLcFeeAdjustment), so the
      // LC itself is square — reporting it as still negative would double-count
      // a correction that has already been posted.
      interest_basis: lcInterestBasis(l),
      interest_base_amount: lcInterestBase(l),
      fee_adjustment: lcFeeDelta(),
      available: round29(netAvailable(l, n21(l.utilized)) - lcFeeDelta()),
      // What's still owed against the LC's full sanctioned limit, net of
      // repayments — explicitly requested this way even for an LC that's
      // barely drawn down, so it reads as the limit's outstanding exposure.
      outstanding: Math.round((n21(l.amount) - n21(l.repaid)) * 100) / 100,
      compliant,
      display_status: !compliant ? "non_compliant" : String(l.workflow_status || "in_progress")
    };
  });
}
async function getLcLimit(bankId, from, to) {
  const c = getClient();
  const cid = getActiveCompanyId();
  let bank = n21(bankId);
  if (bank) {
    const owner = await c.execute({ sql: "SELECT company_id FROM banks WHERE id = ?", args: [bank] });
    if (n21(owner.rows[0]?.company_id) !== cid) bank = 0;
  }
  const limitRes = bank ? await c.execute({
    sql: "SELECT fixed_limit, convertible_limit, convertible_enabled FROM bank_lc_limits WHERE company_id = ? AND bank_id = ?",
    args: [cid, bank]
  }) : await c.execute({
    sql: `SELECT COALESCE(SUM(fixed_limit), 0) AS fixed_limit,
                     COALESCE(SUM(convertible_limit), 0) AS convertible_limit,
                     MAX(convertible_enabled) AS convertible_enabled
              FROM bank_lc_limits WHERE company_id = ?`,
    args: [cid]
  });
  let limit = limitRes.rows.length ? toPlain25(limitRes)[0] : { fixed_limit: 0, convertible_limit: 0, convertible_enabled: 0 };
  if (!bank && n21(limit.fixed_limit) === 0 && n21(limit.convertible_limit) === 0) {
    const legacy = await c.execute({
      sql: "SELECT fixed_limit, convertible_limit, convertible_enabled FROM lc_limits WHERE company_id = ?",
      args: [cid]
    });
    if (legacy.rows.length) limit = toPlain25(legacy)[0];
  }
  const f = from ? String(from).slice(0, 10) : "";
  const t = to ? String(to).slice(0, 10) : "";
  const sumsRes = await c.execute({
    sql: `SELECT stage, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
            ${bank ? "AND our_bank_id = ?" : ""}
            ${f ? "AND open_date >= ?" : ""}
            ${t ? "AND open_date <= ?" : ""}
          GROUP BY stage`,
    args: [cid, ...bank ? [bank] : [], ...f ? [f] : [], ...t ? [t] : []]
  });
  const byStage = { application: 0, open: 0, payment_received: 0 };
  let periodCount = 0;
  for (const r of toPlain25(sumsRes)) {
    const stage = String(r.stage || "application");
    if (stage in byStage) byStage[stage] = n21(r.total);
    periodCount += n21(r.cnt);
  }
  const totalCountRes = await c.execute({
    sql: `SELECT COUNT(*) AS cnt FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
            ${bank ? "AND our_bank_id = ?" : ""}`,
    args: bank ? [cid, bank] : [cid]
  });
  const totalCount = n21(totalCountRes.rows[0]?.cnt);
  const totalLimit = round29(n21(limit.fixed_limit) + (limit.convertible_enabled ? n21(limit.convertible_limit) : 0));
  const utilized = round29(byStage.application + byStage.open + byStage.payment_received);
  return {
    bank_id: bank || null,
    fixed_limit: n21(limit.fixed_limit),
    convertible_limit: n21(limit.convertible_limit),
    convertible_enabled: !!n21(limit.convertible_enabled),
    total_limit: totalLimit,
    lc_count: totalCount,
    period_lc_count: periodCount,
    application: round29(byStage.application),
    open: round29(byStage.open),
    payment_received: round29(byStage.payment_received),
    utilized,
    available: round29(totalLimit - utilized),
    period_from: f || null,
    period_to: t || null
  };
}
async function listBankLcLimits() {
  const cid = getActiveCompanyId();
  const res = await getClient().execute({
    sql: `SELECT b.id AS bank_id, b.name AS bank, b.active,
                 COALESCE(l.fixed_limit, 0) AS fixed_limit,
                 COALESCE(l.convertible_limit, 0) AS convertible_limit,
                 COALESCE(l.convertible_enabled, 0) AS convertible_enabled,
                 (SELECT COUNT(*) FROM letters_of_credit x WHERE x.company_id = ? AND x.our_bank_id = b.id) AS lc_count,
                 COALESCE((SELECT SUM(x.amount) FROM letters_of_credit x
                           WHERE x.company_id = ? AND x.our_bank_id = b.id
                             AND COALESCE(x.facility_type, 'lc') = 'lc' AND x.preclosed_date IS NULL), 0) AS utilized
          FROM banks b
          LEFT JOIN bank_lc_limits l ON l.bank_id = b.id AND l.company_id = ?
          WHERE b.company_id = ?
          ORDER BY b.name`,
    args: [cid, cid, cid, cid]
  });
  return toPlain25(res).map((r) => {
    const total = round29(n21(r.fixed_limit) + (n21(r.convertible_enabled) ? n21(r.convertible_limit) : 0));
    return { ...r, convertible_enabled: !!n21(r.convertible_enabled), total_limit: total, available: round29(total - n21(r.utilized)) };
  });
}
async function saveLcLimit(v) {
  const cid = getActiveCompanyId();
  const bankId = n21(v.bank_id);
  if (!bankId) throw new Error("Pick which bank this limit is sanctioned by");
  const owner = await getClient().execute({ sql: "SELECT company_id FROM banks WHERE id = ?", args: [bankId] });
  if (n21(owner.rows[0]?.company_id) !== cid) throw new Error("That bank belongs to a different company");
  await getClient().execute({
    sql: `INSERT INTO bank_lc_limits (company_id, bank_id, fixed_limit, convertible_limit, convertible_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(company_id, bank_id) DO UPDATE SET
            fixed_limit = excluded.fixed_limit,
            convertible_limit = excluded.convertible_limit,
            convertible_enabled = excluded.convertible_enabled,
            updated_at = excluded.updated_at`,
    args: [cid, bankId, n21(v.fixed_limit), n21(v.convertible_limit), v.convertible_enabled ? 1 : 0]
  });
  return { id: bankId };
}
async function syncLinkedOrders(lcId, orderIds) {
  const c = getClient();
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n21(x)).filter((x) => x > 0) : [];
  if (ids.length) {
    const taken = await c.execute({
      sql: `SELECT lo.order_id, o.invoice_no, l.lc_no
            FROM lc_linked_orders lo
            JOIN orders o ON o.id = lo.order_id
            LEFT JOIN letters_of_credit l ON l.id = lo.lc_id
            WHERE lo.order_id IN (${ids.join(",")}) AND lo.lc_id != ?`,
      args: [lcId]
    });
    if (taken.rows.length) {
      const t = taken.rows[0];
      throw new Error(`Invoice ${t.invoice_no || `#${t.order_id}`} is already linked to ${t.lc_no ? `LC ${t.lc_no}` : "another LC"}`);
    }
  }
  await c.execute({ sql: "DELETE FROM lc_linked_orders WHERE lc_id = ?", args: [lcId] });
  for (const oid of ids) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO lc_linked_orders (lc_id, order_id) VALUES (?, ?)",
      args: [lcId, oid]
    });
  }
}
async function syncPaymentReceivedIssuance(lcId, v) {
  const paymentDate = String(v.payment_received_date || "").slice(0, 10);
  if (!paymentDate) return;
  const c = getClient();
  const existing = await c.execute({ sql: "SELECT COUNT(*) AS n FROM lc_issuances WHERE lc_id = ?", args: [lcId] });
  if (n21(existing.rows[0]?.n) === 0) {
    const issueDate = String(v.open_date || paymentDate).slice(0, 10);
    const dueDate = String(v.expiry_date || paymentDate).slice(0, 10);
    const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x) => n21(x)).filter((x) => x > 0) : [];
    if (ids.length) {
      let remaining = netAvailable(v, 0);
      for (const oid of ids) {
        const o = await c.execute({ sql: "SELECT invoice_no, net_amount FROM orders WHERE id = ?", args: [oid] });
        if (!o.rows.length) continue;
        const issueAmount = Math.min(remaining, n21(o.rows[0].net_amount));
        if (issueAmount <= 5e-3) continue;
        await c.execute({
          sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, due_date, status)
                VALUES (?, ?, ?, ?, ?, ?, 'outstanding')`,
          args: [lcId, issueDate, Math.round(issueAmount * 100) / 100, oid, String(o.rows[0].invoice_no || ""), dueDate]
        });
        remaining -= issueAmount;
      }
    } else if (netAvailable(v, 0) > 0) {
      await c.execute({
        sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, bill_no, due_date, status)
              VALUES (?, ?, ?, ?, ?, 'outstanding')`,
        args: [lcId, issueDate, netAvailable(v, 0), null, dueDate]
      });
    }
  }
  const outstanding = await c.execute({
    sql: "SELECT id FROM lc_issuances WHERE lc_id = ? AND COALESCE(status, 'outstanding') != 'settled'",
    args: [lcId]
  });
  await settleLcBillsCombined(outstanding.rows.map((r) => Number(r.id)), paymentDate).catch(
    (e) => console.error("[lc] auto-settle on payment received failed:", e.message)
  );
}
async function listLCIssuances(lcId) {
  const res = await getClient().execute({
    sql: `SELECT i.*, o.invoice_no
          FROM lc_issuances i
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.lc_id = ? ORDER BY i.id DESC`,
    args: [lcId]
  });
  return toPlain25(res);
}
var LC_COLS = [
  "our_bank_id",
  "usance_days",
  "margin_pct",
  "lc_no",
  "facility_type",
  "bank",
  "party_type",
  "party_id",
  "amount",
  "open_date",
  "expiry_date",
  "interest_pct",
  "charges",
  "status",
  "note",
  "facility_id",
  "purpose",
  "receivable_party_id",
  "workflow_status",
  "stage",
  "fd_no",
  "payment_received_date",
  "opened_date",
  "interest_upfront",
  "interest_excl_charges",
  "interest_adj"
];
function lcArgs(v) {
  return LC_COLS.map((k) => {
    const val = v[k];
    if (val === "" || val === void 0 || val === null) {
      if (k === "workflow_status") return "in_progress";
      if (k === "stage") return "application";
      if (k === "amount" || k === "usance_days" || k === "margin_pct" || k === "interest_upfront" || k === "interest_excl_charges" || k === "interest_adj") {
        return 0;
      }
      if (k === "lc_no") return "";
      return null;
    }
    if (k === "our_bank_id" || k === "party_id" || k === "amount" || k === "interest_pct" || k === "charges" || k === "usance_days" || k === "margin_pct" || k === "facility_id" || k === "receivable_party_id" || k === "interest_upfront" || // Signed: a negative adjustment is the ordinary case, so this must not
    // be floored or read as a string.
    k === "interest_adj") {
      return n21(val);
    }
    return val;
  });
}
async function assertWithinFacility(v, excludeLcId = 0) {
  const facilityId = n21(v.facility_id);
  if (!facilityId || v.force_over_limit) return;
  const h = await facilityHeadroom(facilityId, excludeLcId);
  const amount = n21(v.amount);
  if (amount > n21(h.available) + 5e-3) {
    throw new Error(
      `${h.name} has ${Number(h.available).toFixed(2)} left of its ${Number(h.sanctioned).toFixed(2)} sanction (${Number(h.lc_committed).toFixed(2)} on other LCs, ${Number(h.other_outstanding).toFixed(2)} other outstanding). This LC of ${amount.toFixed(2)} would exceed it.`
    );
  }
}
async function assertWithinInvoiceCover(v) {
  const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x) => n21(x)).filter((x) => x > 0) : [];
  if (!ids.length) return;
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(net_amount), 0) AS total FROM orders WHERE id IN (${ids.map(() => "?").join(", ")})`,
    args: ids
  });
  const total = n21(res.rows[0]?.total);
  const amount = n21(v.amount);
  if (amount > total + 5e-3) {
    throw new Error(
      `The open amount (${amount.toFixed(2)}) cannot exceed the ${total.toFixed(2)} total of the selected invoices.`
    );
  }
}
function assertLcNoIfPastApplication(v) {
  if (String(v.stage || "application") !== "application" && !String(v.lc_no || "").trim()) {
    throw new Error("LC number is required once the LC is Open");
  }
}
async function assertLcNoNotTaken(v, id) {
  const lcNo = String(v.lc_no || "").trim();
  if (!lcNo) return;
  const c = getClient();
  const cid = n21(v.company_id) || getActiveCompanyId();
  if (id) {
    const own = await c.execute({ sql: "SELECT lc_no FROM letters_of_credit WHERE id = ?", args: [id] });
    const was = String(own.rows[0]?.lc_no || "").trim();
    if (was.toUpperCase() === lcNo.toUpperCase()) return;
  }
  const res = await c.execute({
    sql: `SELECT id, lc_no, bank, amount, open_date FROM letters_of_credit
           WHERE company_id = ? AND UPPER(TRIM(COALESCE(lc_no,''))) = ? AND id <> ?
           ORDER BY id LIMIT 1`,
    args: [cid, lcNo.toUpperCase(), n21(id)]
  });
  if (!res.rows.length) return;
  const clash = toPlain25(res)[0];
  const when = String(clash.open_date || "").slice(0, 10);
  throw new Error(
    `LC ${lcNo} already exists in this company \u2014 ${clash.bank || "unknown bank"}${when ? `, opened ${when}` : ""}. Give this one a number of its own.`
  );
}
async function assertHasLinkedInvoice(v) {
  if (String(v.stage || "application") === "application") return;
  const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x) => n21(x)).filter((x) => x > 0) : [];
  if (ids.length) return;
  if (await getSetting("lc_require_linked_invoice") === "0") return;
  const res = await getClient().execute({
    sql: `SELECT COUNT(*) AS n FROM orders
          WHERE supplier_id = ? AND company_id = ? AND COALESCE(is_trading, 0) = ? AND order_date <= ?`,
    args: [
      n21(v.party_id),
      n21(v.company_id) || getActiveCompanyId(),
      String(v.purpose || "") === "trading" ? 1 : 0,
      String(v.open_date || "").slice(0, 10)
    ]
  });
  if (n21(res.rows[0]?.n) === 0) return;
  throw new Error(
    "Link at least one purchase invoice before the LC leaves Application \u2014 an LC that is Open or has received payment must name the invoice(s) it covers."
  );
}
function assertPaymentReceivedNotBeforeOpen(v) {
  if (String(v.stage || "application") === "payment_received" && v.opened_date && v.payment_received_date && String(v.payment_received_date) < String(v.opened_date)) {
    throw new Error("Payment received date cannot be before the date the LC was opened");
  }
}
async function resizeAutoLcBill(lcId) {
  const c = getClient();
  const lcRes = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [n21(lcId)] });
  if (!lcRes.rows.length) return;
  const lc = toPlain25(lcRes)[0];
  const res = await c.execute({
    sql: "SELECT id, amount, order_id, bill_no FROM lc_issuances WHERE lc_id = ?",
    args: [n21(lcId)]
  });
  if (res.rows.length !== 1) return;
  const bill = toPlain25(res)[0];
  if (n21(bill.order_id)) return;
  if (String(bill.bill_no || "").trim()) return;
  const want = netAvailable(lc, 0);
  if (want <= 5e-3) return;
  if (Math.abs(want - n21(bill.amount)) < 5e-3) return;
  await c.execute({
    sql: "UPDATE lc_issuances SET amount = ? WHERE id = ?",
    args: [round29(want), n21(bill.id)]
  });
}
async function syncLcVouchers(id) {
  const problems = [];
  try {
    await postLcOpening(id);
  } catch (e) {
    problems.push(`the margin voucher (${e.message})`);
  }
  try {
    await postLcFees(id);
  } catch (e) {
    problems.push(`the stray fee voucher (${e.message})`);
  }
  try {
    await resizeAutoLcBill(id);
  } catch (e) {
    problems.push(`the bill amount (${e.message})`);
  }
  try {
    await refreshLcUpfrontInterest(id);
  } catch (e) {
    problems.push(`the upfront interest voucher (${e.message})`);
  }
  try {
    await resyncLcSettlement(id);
  } catch (e) {
    problems.push(`the settlement journal (${e.message})`);
  }
  try {
    await syncLcFeeAdjustment(id);
  } catch (e) {
    problems.push(`the party's fee adjustment (${e.message})`);
  }
  if (!problems.length) return void 0;
  return `The LC saved, but ${problems.join(" and ")} could not be re-posted \u2014 the books are out of step until that is fixed.`;
}
async function assertOwnBankBelongsToCompany(v) {
  const bankId = n21(v.our_bank_id);
  if (!bankId) return;
  const cid = n21(v.company_id) || getActiveCompanyId();
  const owner = await getClient().execute({ sql: "SELECT company_id FROM banks WHERE id = ?", args: [bankId] });
  if (n21(owner.rows[0]?.company_id) !== cid) {
    throw new Error("That bank belongs to a different company \u2014 pick one of this company's own banks");
  }
}
async function createLC(v) {
  if (!v.bank) throw new Error("Bank is required");
  if (!String(v.open_date || "").trim()) throw new Error("Application date is required");
  assertLcNoIfPastApplication(v);
  await assertLcNoNotTaken(v);
  await assertHasLinkedInvoice(v);
  await assertOwnBankBelongsToCompany(v);
  assertPaymentReceivedNotBeforeOpen(v);
  if (!String(v.fd_no || "").trim()) throw new Error("FD No is required");
  await assertWithinFacility(v);
  await assertWithinInvoiceCover(v);
  const res = await getClient().execute({
    sql: `INSERT INTO letters_of_credit (company_id, ${LC_COLS.join(", ")})
          VALUES (?, ${LC_COLS.map(() => "?").join(", ")})`,
    args: [getActiveCompanyId(), ...lcArgs(v)]
  });
  const id = Number(res.lastInsertRowid);
  await syncLinkedOrders(id, v.linked_order_ids);
  await linkTradingDealsToLc(id, v.linked_deal_ids);
  await syncPaymentReceivedIssuance(id, v);
  const warning = await syncLcVouchers(id);
  return { id, warning };
}
async function updateLC(id, v) {
  if (!v.bank) throw new Error("Bank is required");
  if (!String(v.open_date || "").trim()) throw new Error("Application date is required");
  assertLcNoIfPastApplication(v);
  await assertLcNoNotTaken(v, id);
  await assertHasLinkedInvoice(v);
  await assertOwnBankBelongsToCompany(v);
  assertPaymentReceivedNotBeforeOpen(v);
  if (!String(v.fd_no || "").trim()) throw new Error("FD No is required");
  await assertWithinFacility(v, id);
  await assertWithinInvoiceCover(v);
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET ${LC_COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    args: [...lcArgs(v), id]
  });
  await syncLinkedOrders(id, v.linked_order_ids);
  await linkTradingDealsToLc(id, v.linked_deal_ids);
  await syncPaymentReceivedIssuance(id, v);
  const warning = await syncLcVouchers(id);
  return { id, warning };
}
function daysBetween2(a, b) {
  return Math.round(((/* @__PURE__ */ new Date(`${b}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${a}T00:00:00`)).getTime()) / 864e5);
}
async function precloseLC(id, v) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain25(res)[0];
  if (lc.preclosed_date) throw new Error("This LC is already preclosed");
  if (String(lc.stage || "application") !== "payment_received") {
    throw new Error(
      String(lc.stage || "application") === "application" ? "This LC is still an application \u2014 the bank has not opened it, so there is nothing to wind up. Mark it Open first." : "The bank has not paid the beneficiary under this LC yet, so there is nothing to repay. Mark Payment received first."
    );
  }
  const precloseDate = String(v.preclose_date || "").slice(0, 10);
  if (!precloseDate) throw new Error("Pick the preclosure date");
  const interestStart = lc.payment_received_date || lc.opened_date || lc.open_date;
  if (!interestStart) throw new Error("The LC has no date yet to count interest days from");
  const actualDays = Math.max(0, daysBetween2(String(interestStart), precloseDate));
  const prematureInterest = round29(n21(v.premature_interest));
  const rebateDirection = v.premature_interest_direction === "pay_to_party" ? "pay_to_party" : "credit_to_us";
  await c.execute({
    sql: `UPDATE letters_of_credit SET usance_days = ?, preclosed_date = ?, preclose_premature_interest = ?,
          preclose_interest_route = ? WHERE id = ?`,
    args: [actualDays, precloseDate, prematureInterest, rebateDirection, id]
  });
  await postLcOpening(id);
  const rebate = await postLcPrematureInterestRebate(id, rebateDirection, prematureInterest, precloseDate);
  if (rebate) {
    await c.execute({
      sql: `UPDATE letters_of_credit
               SET preclose_interest_journal_entry_id = ?, preclose_payout_journal_entry_id = ?
             WHERE id = ?`,
      args: [rebate.id, rebate.payoutId ?? null, id]
    });
  }
  await saveLcRepayment({
    lc_id: id,
    amount: n21(v.amount),
    comm_charges: n21(v.comm_charges),
    bank_charges: n21(v.bank_charges),
    repay_date: precloseDate,
    posted: true,
    note: "Preclosure repayment"
  });
  if (v.release_margin) {
    const margin = round29(n21(lc.amount) * n21(lc.margin_pct) / 100);
    const settlement = await postLcMarginRelease(id, margin, precloseDate);
    if (settlement) {
      await c.execute({
        sql: `UPDATE letters_of_credit SET preclose_settlement_direction = 'margin_released',
              preclose_settlement_amount = ?, preclose_journal_entry_id = ? WHERE id = ?`,
        args: [margin, settlement.id, id]
      });
    }
  }
  await c.execute({ sql: "UPDATE letters_of_credit SET workflow_status = 'preclosed' WHERE id = ?", args: [id] });
  return { id };
}
async function unPrecloseLC(id) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [id] });
  if (!res.rows.length) throw new Error("LC not found");
  const lc = toPlain25(res)[0];
  if (!lc.preclosed_date) throw new Error("This LC is not preclosed, so there is nothing to undo");
  const removed = [];
  if (lc.preclose_payout_journal_entry_id) {
    await dropTreasuryEntry(n21(lc.preclose_payout_journal_entry_id));
  }
  if (lc.preclose_interest_journal_entry_id) {
    await dropTreasuryEntry(n21(lc.preclose_interest_journal_entry_id));
    removed.push("premature-interest rebate voucher");
  }
  if (lc.preclose_journal_entry_id) {
    await dropTreasuryEntry(n21(lc.preclose_journal_entry_id));
    removed.push("margin-release voucher");
  }
  const reps = await c.execute({
    sql: `SELECT id, journal_entry_id FROM lc_repayments
           WHERE lc_id = ? AND substr(repay_date, 1, 10) = ? AND COALESCE(note, '') = 'Preclosure repayment'`,
    args: [id, String(lc.preclosed_date).slice(0, 10)]
  });
  for (const r of reps.rows) {
    if (r.journal_entry_id) await dropTreasuryEntry(n21(r.journal_entry_id));
    await c.execute({ sql: "DELETE FROM lc_repayments WHERE id = ?", args: [n21(r.id)] });
  }
  if (reps.rows.length) removed.push(`${reps.rows.length} preclosure repayment row(s)`);
  const interestStart = lc.payment_received_date || lc.opened_date || lc.open_date;
  const plannedDays = interestStart && lc.expiry_date ? Math.max(0, daysBetween2(String(interestStart), String(lc.expiry_date))) : n21(lc.usance_days);
  await c.execute({
    sql: `UPDATE letters_of_credit
             SET usance_days = ?, preclosed_date = NULL, preclose_premature_interest = NULL,
                 preclose_interest_route = NULL, preclose_interest_journal_entry_id = NULL,
                 preclose_payout_journal_entry_id = NULL,
                 preclose_settlement_direction = NULL, preclose_settlement_amount = NULL,
                 preclose_journal_entry_id = NULL, workflow_status = 'in_progress'
           WHERE id = ?`,
    args: [plannedDays, id]
  });
  await postLcOpening(id);
  removed.push(`interest days back to ${plannedDays}`);
  return { id, removed };
}
async function deleteLC(id) {
  const c = getClient();
  const bills = await c.execute({ sql: "SELECT journal_entry_id FROM lc_issuances WHERE lc_id = ?", args: [id] });
  for (const b of bills.rows) if (b.journal_entry_id) await dropTreasuryEntry(Number(b.journal_entry_id));
  const repayments = await c.execute({ sql: "SELECT journal_entry_id FROM lc_repayments WHERE lc_id = ?", args: [id] });
  for (const r of repayments.rows) if (r.journal_entry_id) await dropTreasuryEntry(Number(r.journal_entry_id));
  const paymentIns = await c.execute({ sql: "SELECT journal_entry_id FROM lc_payment_ins WHERE lc_id = ?", args: [id] });
  for (const p of paymentIns.rows) if (p.journal_entry_id) await dropTreasuryEntry(Number(p.journal_entry_id));
  const lc = await c.execute({
    sql: `SELECT journal_entry_id, preclose_journal_entry_id, interest_journal_entry_id, preclose_interest_journal_entry_id,
                 preclose_payout_journal_entry_id, charges_journal_entry_id
          FROM letters_of_credit WHERE id = ?`,
    args: [id]
  });
  if (lc.rows.length && lc.rows[0].journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].journal_entry_id));
  if (lc.rows.length && lc.rows[0].preclose_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_journal_entry_id));
  if (lc.rows.length && lc.rows[0].interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].interest_journal_entry_id));
  if (lc.rows.length && lc.rows[0].preclose_interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_interest_journal_entry_id));
  if (lc.rows.length && lc.rows[0].preclose_payout_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_payout_journal_entry_id));
  if (lc.rows.length && lc.rows[0].charges_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].charges_journal_entry_id));
  await c.execute({ sql: "DELETE FROM lc_issuances WHERE lc_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM lc_repayments WHERE lc_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM lc_payment_ins WHERE lc_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM lc_linked_orders WHERE lc_id = ?", args: [id] });
  await linkTradingDealsToLc(id, []);
  await c.execute({ sql: "DELETE FROM letters_of_credit WHERE id = ?", args: [id] });
  return { id };
}
async function dropTreasuryEntry(entryId) {
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [entryId]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [entryId] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [entryId] });
}
async function issueLC(v) {
  const c = getClient();
  const lcId = n21(v.lc_id);
  const amount = n21(v.amount);
  if (amount <= 0) throw new Error("Enter the issuance amount");
  const lcRes = await c.execute({ sql: "SELECT * FROM letters_of_credit WHERE id = ?", args: [lcId] });
  if (!lcRes.rows.length) throw new Error("LC not found");
  const used = await c.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS u FROM lc_issuances WHERE lc_id = ?",
    args: [lcId]
  });
  const available = netAvailable(lcRes.rows[0], n21(used.rows[0].u));
  if (amount > available + 5e-3) {
    throw new Error(`Issuance exceeds available LC balance (${available.toFixed(2)})`);
  }
  const lc = lcRes.rows[0];
  const issueDate = String(v.issue_date || "").slice(0, 10);
  if (lc.expiry_date && issueDate > String(lc.expiry_date)) {
    throw new Error(`The LC expired on ${lc.expiry_date} \u2014 a bill cannot be issued after that`);
  }
  let dueDate = String(v.due_date || "").slice(0, 10);
  if (!dueDate) {
    const d = /* @__PURE__ */ new Date(`${issueDate}T00:00:00`);
    d.setDate(d.getDate() + (n21(lc.usance_days) || 0));
    dueDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const ins = await c.execute({
    sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, note, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding')`,
    args: [
      lcId,
      issueDate,
      amount,
      v.order_id ? n21(v.order_id) : null,
      v.bill_no || null,
      v.note || null,
      dueDate
    ]
  });
  if (amount >= available - 5e-3) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'utilized' WHERE id = ?",
      args: [lcId]
    });
  }
  return { id: Number(ins.lastInsertRowid) };
}
async function deleteLCIssuance(id) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT lc_id, journal_entry_id FROM lc_issuances WHERE id = ?", args: [id] });
  if (res.rows.length && res.rows[0].journal_entry_id) await dropTreasuryEntry(Number(res.rows[0].journal_entry_id));
  await c.execute({ sql: "DELETE FROM lc_issuances WHERE id = ?", args: [id] });
  if (res.rows.length) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'open' WHERE id = ? AND status = 'utilized'",
      args: [n21(res.rows[0].lc_id)]
    });
  }
  return { id };
}

// src/main/bankRecon.ts
var import_exceljs = __toESM(require("exceljs"));
var import_fs2 = require("fs");
function toPlain26(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n22(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round210 = (v) => Math.round(v * 100) / 100;
function normHeader(h) {
  return String(h ?? "").trim().toLowerCase();
}
function findCol(headerRow, keys) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = normHeader(headerRow[i]);
    if (keys.some((k) => h.includes(k))) return i;
  }
  return -1;
}
function parseAmount(s) {
  const cleaned = String(s ?? "").replace(/[,₹\s]/g, "");
  const x = Number(cleaned);
  return Number.isFinite(x) ? x : 0;
}
function parseDate(s) {
  const raw = String(s ?? "").trim();
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const d = m[1];
    const mo = m[2];
    let y = m[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const dt = new Date(raw);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}
function rowsToLines(rows) {
  if (!rows.length) return [];
  const headerIdx = rows.findIndex(
    (r) => findCol(r, ["date"]) >= 0 && (findCol(r, ["debit", "withdrawal"]) >= 0 || findCol(r, ["credit", "deposit"]) >= 0)
  );
  const headerRow = headerIdx >= 0 ? rows[headerIdx] : rows[0];
  const dateCol = findCol(headerRow, ["date"]);
  const narrCol = findCol(headerRow, ["narration", "description", "particular", "remark", "details"]);
  const debitCol = findCol(headerRow, ["debit", "withdrawal"]);
  const creditCol = findCol(headerRow, ["credit", "deposit"]);
  const balCol = findCol(headerRow, ["balance"]);
  const dataRows = rows.slice((headerIdx >= 0 ? headerIdx : 0) + 1);
  const out = [];
  for (const r of dataRows) {
    const date = dateCol >= 0 ? parseDate(r[dateCol]) : null;
    if (!date) continue;
    const debit = debitCol >= 0 ? parseAmount(r[debitCol]) : 0;
    const credit = creditCol >= 0 ? parseAmount(r[creditCol]) : 0;
    if (!debit && !credit) continue;
    out.push({
      txn_date: date,
      narration: narrCol >= 0 ? String(r[narrCol] ?? "").trim() : "",
      debit,
      credit,
      balance: balCol >= 0 ? parseAmount(r[balCol]) : null
    });
  }
  return out;
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}
async function parseXlsxFile(filePath) {
  const wb = new import_exceljs.default.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cell.text ?? "");
    });
    rows.push(cells);
  });
  return rows;
}
async function importBankStatement(v) {
  const filePath = String(v.file_path || "").trim();
  if (!filePath) throw new Error("Pick a bank statement file");
  const bank = String(v.bank || "").trim();
  if (!bank) throw new Error("Bank is required");
  const rows = /\.xlsx?$/i.test(filePath) ? await parseXlsxFile(filePath) : parseCsv((0, import_fs2.readFileSync)(filePath, "utf8"));
  const lines = rowsToLines(rows);
  if (!lines.length) {
    throw new Error("No usable transaction rows found \u2014 the file needs Date and Debit/Credit columns");
  }
  const c = getClient();
  const companyId = getActiveCompanyId() || 1;
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const ins = await c.execute({
    sql: "INSERT INTO bank_statement_imports (bank, file_name, company_id) VALUES (?, ?, ?)",
    args: [bank, fileName, companyId]
  });
  const importId = Number(ins.lastInsertRowid);
  for (const l of lines) {
    await c.execute({
      sql: `INSERT INTO bank_statement_lines (import_id, bank, txn_date, narration, debit, credit, balance)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [importId, bank, l.txn_date, l.narration, l.debit, l.credit, l.balance]
    });
  }
  return { id: importId, count: lines.length };
}
async function listBankStatementImports() {
  const res = await getClient().execute(
    `SELECT i.*,
       (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = i.id) AS line_count,
       (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = i.id AND status = 'pending') AS pending_count
     FROM bank_statement_imports i ORDER BY i.id DESC`
  );
  return toPlain26(res);
}
async function deleteBankStatementImport(id) {
  const c = getClient();
  await c.execute({ sql: "DELETE FROM bank_statement_lines WHERE import_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM bank_statement_imports WHERE id = ?", args: [id] });
  return { id };
}
async function listBankStatementLines(filter) {
  const where = [];
  const args = [];
  if (filter?.import_id) {
    where.push("import_id = ?");
    args.push(n22(filter.import_id));
  }
  if (filter?.status) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(String).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
  }
  const sql = `SELECT * FROM bank_statement_lines ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY txn_date DESC, id DESC`;
  const res = await getClient().execute({ sql, args });
  return toPlain26(res);
}
var DATE_WINDOW_DAYS = 5;
var AMOUNT_TOLERANCE = 0.5;
function withinDateWindow(a, b, days) {
  const diff = Math.abs((/* @__PURE__ */ new Date(`${a}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${b}T00:00:00`)).getTime());
  return diff <= days * 864e5;
}
async function suggestBankLineMatch(lineId) {
  const c = getClient();
  const lineRes = await c.execute({ sql: "SELECT * FROM bank_statement_lines WHERE id = ?", args: [lineId] });
  if (!lineRes.rows.length) throw new Error("Statement line not found");
  const line = toPlain26(lineRes)[0];
  const amount = n22(line.debit) > 0 ? n22(line.debit) : n22(line.credit);
  const narration = String(line.narration || "").toUpperCase();
  const lcRes = await c.execute(
    `SELECT id, lc_no, charges, opened_date, open_date, amount, interest_pct, usance_days,
            interest_upfront, interest_excl_charges, interest_adj
     FROM letters_of_credit WHERE lc_no IS NOT NULL AND lc_no != ''`
  );
  for (const lc of toPlain26(lcRes)) {
    const lcNo = String(lc.lc_no || "").toUpperCase();
    if (!lcNo || !narration.includes(lcNo)) continue;
    if (!n22(lc.interest_upfront) && n22(lc.charges) > 0 && Math.abs(n22(lc.charges) - amount) <= AMOUNT_TOLERANCE) {
      return {
        category: "lc",
        link_type: "lc_opening",
        link_ref_id: n22(lc.id),
        label: `LC ${lc.lc_no} \u2014 opening commission/charges ${n22(lc.charges).toFixed(2)}`
      };
    }
    if (n22(lc.interest_upfront)) {
      const interest = lcInterest(lc);
      const charges = round210(n22(lc.charges));
      const total = round210(interest + charges);
      if (total > 0 && Math.abs(total - amount) <= AMOUNT_TOLERANCE) {
        return {
          category: "lc",
          link_type: "lc_interest",
          link_ref_id: n22(lc.id),
          label: `LC ${lc.lc_no} \u2014 interest ${interest.toFixed(2)} + charges ${charges.toFixed(2)} paid upfront (${total.toFixed(2)})`
        };
      }
    }
    const repRes = await c.execute({
      sql: "SELECT id, amount, maturity_charges, repay_date FROM lc_repayments WHERE lc_id = ?",
      args: [lc.id]
    });
    for (const rep of toPlain26(repRes)) {
      const total = round210(n22(rep.amount) + n22(rep.maturity_charges));
      if (Math.abs(total - amount) <= AMOUNT_TOLERANCE && withinDateWindow(String(rep.repay_date), String(line.txn_date), DATE_WINDOW_DAYS)) {
        return {
          category: "lc",
          link_type: "lc_repayment",
          link_ref_id: n22(rep.id),
          label: `LC ${lc.lc_no} \u2014 repayment ${total.toFixed(2)} on ${rep.repay_date}`
        };
      }
    }
  }
  const payRes = await c.execute({
    sql: `SELECT p.*,
       CASE p.party_type WHEN 'supplier' THEN s.name WHEN 'transporter' THEN t.name WHEN 'customer' THEN c.name END AS party_name
     FROM payments p
     LEFT JOIN suppliers s ON p.party_type = 'supplier' AND s.id = p.party_id
     LEFT JOIN transporters t ON p.party_type = 'transporter' AND t.id = p.party_id
     LEFT JOIN customers c ON p.party_type = 'customer' AND c.id = p.party_id
     WHERE ABS(p.amount - ?) <= ?`,
    args: [amount, AMOUNT_TOLERANCE]
  });
  let best = null;
  for (const pay of toPlain26(payRes)) {
    if (!withinDateWindow(String(pay.payment_date), String(line.txn_date), DATE_WINDOW_DAYS)) continue;
    const nameMatches = pay.party_name && narration.includes(String(pay.party_name).toUpperCase());
    if (nameMatches || !best) {
      best = {
        category: "oil",
        link_type: "payment",
        link_ref_id: n22(pay.id),
        label: `Payment to ${pay.party_name || pay.party_type} \u2014 ${n22(pay.amount).toFixed(2)} on ${pay.payment_date}`
      };
      if (nameMatches) break;
    }
  }
  return best;
}
async function reverseLcInterestLink(lineId) {
  const c = getClient();
  const cur = await c.execute({ sql: "SELECT link_type, link_ref_id FROM bank_statement_lines WHERE id = ?", args: [lineId] });
  const row = cur.rows[0];
  if (!row || !row.link_ref_id) return;
  if (String(row.link_type) === "lc_interest") await dropLcUpfrontInterest(n22(row.link_ref_id));
}
async function reconcileBankLine(lineId, v) {
  const category = String(v.category || "").trim();
  if (!category) throw new Error("Pick what this line is");
  const c = getClient();
  const linkType = v.link_type ? String(v.link_type) : null;
  const linkRefId = v.link_ref_id ? n22(v.link_ref_id) : null;
  if (linkType === "lc_interest" && linkRefId) {
    const line = await c.execute({ sql: "SELECT txn_date FROM bank_statement_lines WHERE id = ?", args: [lineId] });
    await postLcUpfrontInterest(linkRefId, String(line.rows[0]?.txn_date || ""));
  }
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = ?, link_type = ?, link_ref_id = ?, status = 'reconciled', reviewed_at = datetime('now')
          WHERE id = ?`,
    args: [category, linkType, linkRefId, lineId]
  });
  return { id: lineId };
}
async function markBankLineMisc(lineId) {
  const c = getClient();
  await reverseLcInterestLink(lineId);
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = 'misc', link_type = NULL, link_ref_id = NULL, status = 'misc', reviewed_at = datetime('now')
          WHERE id = ?`,
    args: [lineId]
  });
  return { id: lineId };
}
async function unreconcileBankLine(lineId) {
  const c = getClient();
  await reverseLcInterestLink(lineId);
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = NULL, link_type = NULL, link_ref_id = NULL, status = 'pending', reviewed_at = NULL
          WHERE id = ?`,
    args: [lineId]
  });
  return { id: lineId };
}
async function setBankLineSubEntry(lineId, v) {
  const c = getClient();
  await c.execute({
    sql: "UPDATE bank_statement_lines SET sub_entry_enabled = ?, sub_entry_note = ? WHERE id = ?",
    args: [v.enabled ? 1 : 0, v.note ? String(v.note).trim() : null, lineId]
  });
  return { id: lineId };
}

// src/main/billDiscounting.ts
function toPlain27(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
function n23(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
var round211 = (v) => Math.round(v * 100) / 100;
function todayISO6() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween3(a, b) {
  return Math.round(((/* @__PURE__ */ new Date(`${b}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${a}T00:00:00`)).getTime()) / 864e5);
}
function bdCalc(bd) {
  const amount = n23(bd.amount);
  const invoice = n23(bd.invoice_amount);
  const from = String(bd.payment_received_date || "").slice(0, 10);
  const to = String(bd.maturity_date || "").slice(0, 10);
  const inclStart = bd.days_incl_start ? 1 : 0;
  const intDays = from && to ? Math.max(0, daysBetween3(from, to) + inclStart) : 0;
  const marginBase = invoice > 0 ? invoice : amount;
  const marginAmount = round211(marginBase * n23(bd.margin_pct) / 100);
  const sanctionedAmount = round211(marginBase - marginAmount);
  const drawn = invoice > 0 ? amount : sanctionedAmount;
  const undrawnAmount = round211(sanctionedAmount - drawn);
  const daysYear = n23(bd.days_year) || 360;
  const openAmount = drawn;
  const interestAmount = round211(openAmount * n23(bd.interest_pct) * intDays / (100 * daysYear));
  const tdsAmount = round211(interestAmount * n23(bd.tds_pct) / 100);
  const netInterest = round211(interestAmount - tdsAmount);
  const receiptAmount = bd.interest_upfront ? openAmount : round211(openAmount - interestAmount);
  return {
    intDays,
    marginAmount,
    sanctionedAmount,
    undrawnAmount,
    openAmount,
    interestAmount,
    tdsAmount,
    netInterest,
    receiptAmount
  };
}
async function dropEntry2(entryId) {
  if (!entryId) return;
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [entryId]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [entryId] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [entryId] });
}
async function allocAgainst2(entryId, partyName2, ref, amount) {
  const c = getClient();
  const line = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [entryId, partyName2.toUpperCase()]
  });
  if (!line.rows.length) return;
  await c.execute({
    sql: "INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount) VALUES (?, ?, ?, ?, ?)",
    args: [Number(line.rows[0].id), Number(line.rows[0].account_id), ref ? "agst_ref" : "on_account", ref, amount]
  });
}
async function loadBd(id) {
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name,
                 s.name AS supplier_name, cu.name AS customer_name
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE bd.id = ?`,
    args: [id]
  });
  if (!res.rows.length) throw new Error("Bill Discounting entry not found");
  return toPlain27(res)[0];
}
async function repaidSoFar(bd) {
  const r = await getClient().execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS paid, COUNT(*) AS parts FROM bd_repayments WHERE bd_id = ?",
    args: [Number(bd.id)]
  });
  if (n23(r.rows[0].parts) > 0) return round211(n23(r.rows[0].paid));
  return String(bd.status) === "repaid" ? round211(n23(bd.repaid_amount)) : 0;
}
async function dropRepayEntries(bd) {
  const c = getClient();
  const parts = await c.execute({ sql: "SELECT journal_entry_id FROM bd_repayments WHERE bd_id = ?", args: [Number(bd.id)] });
  for (const r of parts.rows) await dropEntry2(n23(r.journal_entry_id) || null);
  await c.execute({ sql: "DELETE FROM bd_repayments WHERE bd_id = ?", args: [Number(bd.id)] });
  await dropEntry2(n23(bd.repay_journal_entry_id) || null);
}
function partyName(bd) {
  return String(bd.party_type === "supplier" ? bd.supplier_name : bd.customer_name || "").trim();
}
async function postBdOpening(bdId) {
  const c = getClient();
  const bd = await loadBd(bdId);
  await dropEntry2(n23(bd.journal_entry_id) || null);
  if (!bd.payment_received_date) {
    await c.execute({ sql: "UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?", args: [bdId] });
    return;
  }
  const calc = bdCalc(bd);
  const upfront = !!bd.interest_upfront;
  const interest = upfront ? 0 : calc.interestAmount;
  const amount = n23(bd.amount);
  if (calc.marginAmount < 5e-3 && interest < 5e-3 && amount < 5e-3) {
    await c.execute({ sql: "UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?", args: [bdId] });
    return;
  }
  const marginWithheld = n23(bd.invoice_amount) > 0 ? 0 : calc.marginAmount;
  const lines = [{ account: "BANK A/C", group: "Bank Accounts", dr: calc.receiptAmount }];
  if (marginWithheld > 5e-3) lines.push({ account: "BD MARGIN A/C", group: "Deposits (Asset)", dr: marginWithheld });
  if (interest > 5e-3) lines.push({ account: "INTEREST ON BILL DISCOUNTING A/C", group: "Indirect Expenses", dr: interest });
  lines.push({ account: "BILLS DISCOUNTED A/C", group: "Loans (Liability)", cr: amount });
  const je = await postJournal({
    date: String(bd.payment_received_date || todayISO6()).slice(0, 10),
    vchType: "RECEIPT",
    vchNo: String(bd.bd_no || ""),
    narration: `Bill Discounting ${bd.bd_no || ""} (${bd.finance_type}) opened with ${bd.nbfc_name || "the NBFC"} \u2014 margin ${calc.marginAmount.toFixed(2)}, interest ${interest.toFixed(2)}` + (upfront ? " (interest settled separately on reconciliation)" : ""),
    companyId: n23(bd.company_id) || void 0,
    lines
  });
  await c.execute({ sql: "UPDATE bill_discountings SET journal_entry_id = ? WHERE id = ?", args: [je.id, bdId] });
}
async function postBdUpfrontInterest(bdId, dateIn) {
  const bd = await loadBd(bdId);
  if (!bd.interest_upfront) throw new Error("This Bill Discounting entry was not opened with interest upfront");
  const calc = bdCalc(bd);
  if (calc.interestAmount < 5e-3) return null;
  const je = await postJournal({
    date: String(dateIn || todayISO6()).slice(0, 10),
    vchType: "JOURNAL",
    vchNo: String(bd.bd_no || ""),
    narration: `Bill Discounting ${bd.bd_no} \u2014 interest ${calc.interestAmount.toFixed(2)} (TDS ${calc.tdsAmount.toFixed(2)}) settled upfront, per the bank statement`,
    companyId: n23(bd.company_id) || void 0,
    lines: [
      { account: "INTEREST ON BILL DISCOUNTING A/C", group: "Indirect Expenses", dr: calc.interestAmount },
      { account: "TDS ON INTEREST PAYABLE A/C", group: "Duties & Taxes", cr: calc.tdsAmount },
      { account: "BANK A/C", group: "Bank Accounts", cr: calc.netInterest }
    ]
  });
  return { id: je.id };
}
async function postBdMarginRelease(bd) {
  const calc = bdCalc(bd);
  if (n23(bd.invoice_amount) > 0) return null;
  if (calc.marginAmount < 5e-3) return null;
  const je = await postJournal({
    date: String(bd.repaid_date || todayISO6()).slice(0, 10),
    vchType: "RECEIPT",
    vchNo: String(bd.bd_no || ""),
    narration: `Bill Discounting ${bd.bd_no} repaid \u2014 margin of ${calc.marginAmount.toFixed(2)} refunded by ${bd.nbfc_name || "the NBFC"}`,
    companyId: n23(bd.company_id) || void 0,
    lines: [
      { account: "BANK A/C", group: "Bank Accounts", dr: calc.marginAmount },
      { account: "BD MARGIN A/C", group: "Deposits (Asset)", cr: calc.marginAmount }
    ]
  });
  await getClient().execute({
    sql: "UPDATE bill_discountings SET margin_release_journal_entry_id = ? WHERE id = ?",
    args: [je.id, n23(bd.id)]
  });
  return { id: je.id };
}
var BD_COLS = [
  "bd_no",
  "nbfc_id",
  "finance_type",
  "party_type",
  "party_id",
  "purpose",
  // Who pays US back on a trading bill — the other half of the round trip.
  "receivable_party_id",
  "amount",
  "invoice_amount",
  "payment_received_date",
  "maturity_date",
  "margin_pct",
  "days_year",
  "days_incl_start",
  "interest_pct",
  "tds_pct",
  "interest_upfront",
  "note"
];
function bdArgs(v) {
  return BD_COLS.map((k) => {
    if (k === "interest_upfront" || k === "days_incl_start") return v[k] ? 1 : 0;
    if (k === "days_year") return n23(v[k]) || 360;
    if (["amount", "margin_pct", "interest_pct", "tds_pct"].includes(k)) return n23(v[k]);
    if (k === "invoice_amount") {
      const val2 = v[k];
      return val2 === "" || val2 === void 0 || val2 === null ? null : n23(val2);
    }
    if (k === "nbfc_id" || k === "receivable_party_id") return v[k] ? n23(v[k]) : null;
    const val = v[k];
    return val === "" || val === void 0 || val === null ? null : String(val);
  });
}
function withPrimaryParty(v) {
  if (!Array.isArray(v.party_ids)) return v;
  const ids = v.party_ids.map((x) => n23(x)).filter((x) => x > 0);
  return ids.length ? { ...v, party_id: ids[0] } : v;
}
async function syncBdParties(bdId, partyType, partyIds, split) {
  const c = getClient();
  const ids = Array.isArray(partyIds) ? Array.from(new Set(partyIds.map((x) => n23(x)).filter((x) => x > 0))) : [];
  await c.execute({ sql: "DELETE FROM bd_parties WHERE bd_id = ?", args: [bdId] });
  for (const pid of ids) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id, amount) VALUES (?, ?, ?, ?)",
      args: [bdId, partyType, pid, split ? n23(split[String(pid)]) : 0]
    });
  }
  return ids.length ? ids[0] : null;
}
async function listBdParties(bdId) {
  const res = await getClient().execute({
    sql: `SELECT bp.party_id, bp.party_type, COALESCE(bp.amount, 0) AS amount,
                 COALESCE(s.name, cu.name) AS name
          FROM bd_parties bp
          LEFT JOIN suppliers s ON bp.party_type = 'supplier' AND s.id = bp.party_id
          LEFT JOIN customers cu ON bp.party_type = 'customer' AND cu.id = bp.party_id
          WHERE bp.bd_id = ? ORDER BY bp.id`,
    args: [bdId]
  });
  return toPlain27(res);
}
async function syncBdLinkedOrders(bdId, orderIds) {
  const c = getClient();
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n23(x)).filter((x) => x > 0) : [];
  if (ids.length) {
    const taken = await c.execute({
      sql: `SELECT bo.order_id, o.invoice_no, b.bd_no
            FROM bd_linked_orders bo
            JOIN orders o ON o.id = bo.order_id
            LEFT JOIN bill_discountings b ON b.id = bo.bd_id
            WHERE bo.order_id IN (${ids.join(",")}) AND bo.bd_id != ?`,
      args: [bdId]
    });
    if (taken.rows.length) {
      const t = taken.rows[0];
      throw new Error(
        `Invoice ${t.invoice_no || `#${t.order_id}`} is already linked to ${t.bd_no ? `bill ${t.bd_no}` : "another discounted bill"}`
      );
    }
  }
  await c.execute({ sql: "DELETE FROM bd_linked_orders WHERE bd_id = ?", args: [bdId] });
  for (const oid of ids) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO bd_linked_orders (bd_id, order_id) VALUES (?, ?)",
      args: [bdId, oid]
    });
  }
}
async function listBdLinkedOrders(bdId) {
  const res = await getClient().execute({
    sql: `SELECT bo.order_id, o.invoice_no, o.order_date, o.net_amount, s.name AS supplier_name
          FROM bd_linked_orders bo
          JOIN orders o ON o.id = bo.order_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          WHERE bo.bd_id = ? ORDER BY o.order_date, o.id`,
    args: [bdId]
  });
  return toPlain27(res);
}
async function validateBd(v) {
  if (!String(v.bd_no ?? "").trim()) throw new Error("Enter the BD no");
  if (!["PID", "SID"].includes(String(v.finance_type))) throw new Error("Choose PID or SID");
  const partyType = String(v.finance_type) === "PID" ? "supplier" : "customer";
  if (String(v.party_type) !== partyType) throw new Error("Party type must follow the finance type");
  const partyIds = Array.isArray(v.party_ids) ? Array.from(new Set(v.party_ids.map((x) => n23(x)).filter((x) => x > 0))) : n23(v.party_id) ? [n23(v.party_id)] : [];
  if (!partyIds.length) throw new Error(partyType === "supplier" ? "Choose the supplier" : "Choose the customer");
  if (n23(v.amount) <= 0) throw new Error("Enter the open amount");
  if (!v.maturity_date) throw new Error("Enter the maturity date");
  if (v.payment_received_date && String(v.maturity_date).slice(0, 10) < String(v.payment_received_date).slice(0, 10)) {
    throw new Error("Maturity date cannot be before the payment received date");
  }
  const table = partyType === "supplier" ? "suppliers" : "customers";
  const found = await getClient().execute({
    sql: `SELECT id, name, active FROM ${table} WHERE id IN (${partyIds.map(() => "?").join(",")})`,
    args: partyIds
  });
  if (found.rows.length !== partyIds.length) throw new Error("One of the parties no longer exists");
  const inactive = found.rows.find((r) => !n23(r.active));
  if (inactive) throw new Error(`${String(inactive.name)} is marked inactive`);
  if (partyIds.length > 1) {
    const split = v.party_amounts || {};
    const given = partyIds.map((pid) => round211(n23(split[String(pid)])));
    if (given.some((x) => x <= 0)) {
      throw new Error("Give each party its sanctioned amount");
    }
    const sum = round211(given.reduce((t, x) => t + x, 0));
    const total = round211(bdCalc(v).sanctionedAmount);
    if (Math.abs(sum - total) > 0.05) {
      throw new Error(
        `The parties' sanctioned amounts come to ${inr(sum)}, but the bill's sanctioned amount is ${inr(total)} \u2014 they have to match`
      );
    }
  }
}
async function listBd(filter) {
  const where = ["bd.company_id = ?"];
  const args = [getActiveCompanyId()];
  if (filter?.status) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(String).filter(Boolean);
    if (statuses.length) {
      where.push(`bd.status IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
  }
  if (filter?.finance_type) {
    where.push("bd.finance_type = ?");
    args.push(String(filter.finance_type));
  }
  if (filter?.nbfc_id) {
    where.push("bd.nbfc_id = ?");
    args.push(n23(filter.nbfc_id));
  }
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name, nb.finance_type AS nbfc_finance_type,
                 s.name AS supplier_name, cu.name AS customer_name,
                 COALESCE(rp.paid, 0) AS parts_paid, COALESCE(rp.parts, 0) AS repay_parts,
                 rc.name AS receivable_party_name,
                 -- A bill can be raised against several parties; the register
                 -- names them all rather than only the one on the row.
                 (SELECT COUNT(*) FROM bd_parties bp WHERE bp.bd_id = bd.id) AS party_count,
                 (SELECT GROUP_CONCAT(COALESCE(s2.name, cu2.name), ', ') FROM bd_parties bp
                    LEFT JOIN suppliers s2 ON bp.party_type = 'supplier' AND s2.id = bp.party_id
                    LEFT JOIN customers cu2 ON bp.party_type = 'customer' AND cu2.id = bp.party_id
                    WHERE bp.bd_id = bd.id) AS party_names,
                 (SELECT GROUP_CONCAT(bp.party_id) FROM bd_parties bp WHERE bp.bd_id = bd.id) AS party_ids_csv,
                 (SELECT GROUP_CONCAT(bp.party_id || ':' || COALESCE(bp.amount, 0)) FROM bd_parties bp
                    WHERE bp.bd_id = bd.id) AS party_split_csv,
                 -- The purchase invoices this bill funded: the route to the
                 -- trading deal, and through it to the resale invoices.
                 (SELECT COUNT(*) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_invoice_count,
                 (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM bd_linked_orders bo
                    JOIN orders o ON o.id = bo.order_id WHERE bo.bd_id = bd.id) AS linked_invoice_nos,
                 (SELECT GROUP_CONCAT(bo.order_id) FROM bd_linked_orders bo WHERE bo.bd_id = bd.id) AS linked_order_ids_csv,
                 -- What the customer has already paid back on the resale.
                 COALESCE((SELECT SUM(pi.amount) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id), 0) AS payment_in_total,
                 (SELECT COUNT(*) FROM bd_payment_ins pi WHERE pi.bd_id = bd.id) AS payment_in_count
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          LEFT JOIN customers rc ON rc.id = bd.receivable_party_id
          LEFT JOIN (SELECT bd_id, SUM(amount) AS paid, COUNT(*) AS parts
                     FROM bd_repayments GROUP BY bd_id) rp ON rp.bd_id = bd.id
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(bd.payment_received_date, bd.created_at) DESC, bd.id DESC`,
    args
  });
  return toPlain27(res).map((bd) => {
    const parts = n23(bd.repay_parts);
    const repaidTotal = round211(
      parts > 0 ? n23(bd.parts_paid) : String(bd.status) === "repaid" ? n23(bd.repaid_amount) : 0
    );
    return {
      ...bd,
      party_name: partyName(bd),
      ...bdCalc(bd),
      repaid_total: repaidTotal,
      outstanding_amount: round211(Math.max(0, n23(bd.amount) - repaidTotal)),
      repay_parts: parts,
      // Three stages, in the order a bill goes through them: opened and waiting
      // on the NBFC's money, live once it has landed, wound up once repaid.
      // Derived rather than stored, so the payment date stays the single fact
      // that decides it and no row can disagree with its own dates.
      stage: String(bd.status) === "repaid" ? "repaid" : bd.payment_received_date ? "live" : "awaiting"
    };
  });
}
async function createBd(v) {
  await validateBd(v);
  v = withPrimaryParty(v);
  const res = await getClient().execute({
    sql: `INSERT INTO bill_discountings (company_id, ${BD_COLS.join(", ")}, status)
          VALUES (?, ${BD_COLS.map(() => "?").join(", ")}, 'open')`,
    args: [getActiveCompanyId(), ...bdArgs(v)]
  });
  const id = Number(res.lastInsertRowid);
  const partyIds = Array.isArray(v.party_ids) ? v.party_ids : n23(v.party_id) ? [n23(v.party_id)] : [];
  await syncBdParties(id, String(v.party_type), partyIds, v.party_amounts);
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids);
  await postBdOpening(id);
  return { id };
}
async function updateBd(id, v) {
  const cur = await loadBd(id);
  if (String(cur.status) === "repaid") throw new Error("This bill is already repaid \u2014 reopen it first if it needs correcting");
  await validateBd(v);
  v = withPrimaryParty(v);
  const paid = await repaidSoFar(cur);
  if (paid > 0 && n23(v.amount) - paid < -4e-3) {
    throw new Error(`${inr(paid)} has already been repaid on this bill \u2014 the amount cannot be set below that`);
  }
  await getClient().execute({
    sql: `UPDATE bill_discountings SET ${BD_COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    args: [...bdArgs(v), id]
  });
  if (Array.isArray(v.party_ids) || n23(v.party_id)) {
    await syncBdParties(
      id,
      String(v.party_type),
      Array.isArray(v.party_ids) ? v.party_ids : [n23(v.party_id)],
      v.party_amounts
    );
  }
  if (Array.isArray(v.linked_order_ids)) await syncBdLinkedOrders(id, v.linked_order_ids);
  await postBdOpening(id);
  return { id };
}
async function deleteBd(id) {
  const c = getClient();
  const bd = await loadBd(id);
  await dropEntry2(n23(bd.journal_entry_id) || null);
  await dropRepayEntries(bd);
  await dropEntry2(n23(bd.margin_release_journal_entry_id) || null);
  const ins = await c.execute({ sql: "SELECT journal_entry_id FROM bd_payment_ins WHERE bd_id = ?", args: [id] });
  for (const r of ins.rows) await dropEntry2(n23(r.journal_entry_id) || null);
  await c.execute({ sql: "DELETE FROM bd_payment_ins WHERE bd_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM bd_linked_orders WHERE bd_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM bd_parties WHERE bd_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM bill_discountings WHERE id = ?", args: [id] });
  return { id };
}
function assertNotFuture2(date, what) {
  const d = String(date || "").slice(0, 10);
  if (d && d > todayISO6()) throw new Error(`${what} cannot be a future date`);
}
function inr(v) {
  return `Rs ${round211(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
async function repayBd(id, v) {
  const c = getClient();
  const bd = await loadBd(id);
  if (String(bd.status) === "repaid") throw new Error("This bill is already repaid");
  if (!bd.payment_received_date) {
    throw new Error("Mark the payment received first \u2014 there is nothing to repay until the NBFC has funded this bill");
  }
  const face = n23(bd.amount);
  const already = await repaidSoFar(bd);
  const due = round211(face - already);
  if (due <= 4e-3) throw new Error("There is nothing left to repay on this bill");
  const asked = v.amount === void 0 || v.amount === null || String(v.amount).trim() === "" ? due : round211(n23(v.amount));
  if (asked <= 0) throw new Error("Enter the amount being repaid");
  if (asked - due > 4e-3) {
    throw new Error(
      already > 0 ? `Only ${inr(due)} is still outstanding on this bill \u2014 ${inr(already)} has already been repaid` : `That is more than the ${inr(due)} this bill is for`
    );
  }
  const date = String(v.repay_date || todayISO6()).slice(0, 10);
  assertNotFuture2(date, "The repayment date");
  if (v.settle_via === "party" && String(bd.finance_type) === "SID") {
    throw new Error(
      "A SID bill is repaid to the financier, not settled against the customer \u2014 the customer\u2019s ledger is not involved"
    );
  }
  const settleVia = v.settle_via === "party" ? "party" : "bank";
  let party = partyName(bd);
  if (settleVia === "party" && n23(v.party_id) && n23(v.party_id) !== n23(bd.party_id)) {
    const chosen = (await listBdParties(id)).find((p) => n23(p.party_id) === n23(v.party_id));
    if (!chosen) throw new Error("That party is not on this bill");
    party = String(chosen.name || "").trim();
  }
  if (settleVia === "party" && !party) throw new Error("This bill has no linked party to settle against");
  const left = round211(due - asked);
  const closed = left <= 4e-3;
  const lines = [{ account: "BILLS DISCOUNTED A/C", group: "Loans (Liability)", dr: asked }];
  if (settleVia === "party") {
    lines.push({
      account: party,
      group: bd.party_type === "supplier" ? "Sundry Creditors" : "Sundry Debtors",
      cr: asked
    });
  } else {
    lines.push({ account: "BANK A/C", group: "Bank Accounts", cr: asked });
  }
  const je = await postJournal({
    date,
    vchType: "PAYMENT",
    vchNo: String(bd.bd_no || ""),
    narration: `Bill Discounting ${bd.bd_no} ${closed && already <= 4e-3 ? "repaid" : closed ? "closed \u2014 final part repayment" : "part repayment"} to ${bd.nbfc_name || "the NBFC"}` + (closed ? "" : ` \u2014 ${inr(left)} still outstanding`) + (settleVia === "party" ? ` \u2014 settled against ${party}` : ""),
    companyId: n23(bd.company_id) || void 0,
    lines
  });
  if (settleVia === "party") await allocAgainst2(je.id, party, v.ref || null, asked);
  await c.execute({
    sql: `INSERT INTO bd_repayments (bd_id, repay_date, amount, settle_via, ref, journal_entry_id, note)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, date, asked, settleVia, v.ref ? String(v.ref) : null, je.id, v.note ? String(v.note) : null]
  });
  const paid = round211(already + asked);
  await c.execute({
    sql: `UPDATE bill_discountings
          SET status = ?, repaid_date = ?, repaid_amount = ?, repay_journal_entry_id = NULL
          WHERE id = ?`,
    args: [closed ? "repaid" : "open", closed ? date : null, paid, id]
  });
  if (v.release_margin && closed) {
    const fresh = await loadBd(id);
    await postBdMarginRelease(fresh);
  }
  return { id, amount: asked, outstanding: left, closed };
}
async function listBdRepayments(bdId) {
  const bd = await loadBd(bdId);
  const res = await getClient().execute({
    sql: `SELECT r.*, je.vch_no, je.entry_date AS voucher_date
          FROM bd_repayments r
          LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
          WHERE r.bd_id = ? ORDER BY r.repay_date, r.id`,
    args: [bdId]
  });
  let left = n23(bd.amount);
  return toPlain27(res).map((r) => {
    left = round211(left - n23(r.amount));
    return { ...r, balance_after: left };
  });
}
async function listAllBdRepayments() {
  const res = await getClient().execute({
    sql: `SELECT r.*, bd.bd_no, bd.finance_type, bd.amount AS bill_amount,
                 nb.name AS nbfc_name, s.name AS supplier_name, cu.name AS customer_name,
                 bd.party_type
          FROM bd_repayments r
          JOIN bill_discountings bd ON bd.id = r.bd_id
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE bd.company_id = ?
          ORDER BY bd.bd_no, r.repay_date, r.id`,
    args: [getActiveCompanyId()]
  });
  return toPlain27(res).map((r) => ({ ...r, party_name: partyName(r) }));
}
async function listAllBdParties() {
  const res = await getClient().execute({
    sql: `SELECT bd.bd_no, bp.party_id, bp.party_type, COALESCE(bp.amount, 0) AS amount,
                 COALESCE(s.name, cu.name) AS name
          FROM bd_parties bp
          JOIN bill_discountings bd ON bd.id = bp.bd_id
          LEFT JOIN suppliers s ON bp.party_type = 'supplier' AND s.id = bp.party_id
          LEFT JOIN customers cu ON bp.party_type = 'customer' AND cu.id = bp.party_id
          WHERE bd.company_id = ?
          ORDER BY bd.bd_no, bp.id`,
    args: [getActiveCompanyId()]
  });
  return toPlain27(res);
}
async function deleteBdRepayment(repaymentId) {
  const c = getClient();
  const res = await c.execute({ sql: "SELECT * FROM bd_repayments WHERE id = ?", args: [repaymentId] });
  if (!res.rows.length) throw new Error("That repayment no longer exists");
  const part = toPlain27(res)[0];
  const bdId = Number(part.bd_id);
  await dropEntry2(n23(part.journal_entry_id) || null);
  await c.execute({ sql: "DELETE FROM bd_repayments WHERE id = ?", args: [repaymentId] });
  const bd = await loadBd(bdId);
  const paid = await repaidSoFar({ ...bd, status: "open" });
  const closed = n23(bd.amount) - paid <= 4e-3;
  if (!closed && n23(bd.margin_release_journal_entry_id)) {
    await dropEntry2(n23(bd.margin_release_journal_entry_id));
  }
  await c.execute({
    sql: `UPDATE bill_discountings
          SET status = ?, repaid_date = ?, repaid_amount = ?, margin_release_journal_entry_id = ?
          WHERE id = ?`,
    args: [
      closed ? "repaid" : "open",
      closed ? String(bd.repaid_date || "").slice(0, 10) || null : null,
      paid > 0 ? paid : null,
      closed ? n23(bd.margin_release_journal_entry_id) || null : null,
      bdId
    ]
  });
  return { id: repaymentId, bd_id: bdId };
}
async function markBdPaymentReceived(id, dateIn) {
  const c = getClient();
  const bd = await loadBd(id);
  if (String(bd.status) === "repaid") throw new Error("This bill is already repaid \u2014 reopen it first if the receipt date needs correcting");
  const date = String(dateIn || todayISO6()).slice(0, 10);
  assertNotFuture2(date, "The payment received date");
  const maturity = String(bd.maturity_date || "").slice(0, 10);
  if (maturity && date > maturity) {
    throw new Error("The payment cannot be received after the maturity date \u2014 check the date");
  }
  await c.execute({ sql: "UPDATE bill_discountings SET payment_received_date = ? WHERE id = ?", args: [date, id] });
  await postBdOpening(id);
  return { id, date };
}
async function unmarkBdPaymentReceived(id) {
  const c = getClient();
  const bd = await loadBd(id);
  if (String(bd.status) === "repaid") throw new Error("This bill is repaid \u2014 reopen it first");
  const paid = await repaidSoFar(bd);
  if (paid > 4e-3) {
    throw new Error(`${inr(paid)} has already been repaid on this bill \u2014 remove the repayments before undoing the receipt`);
  }
  await dropEntry2(n23(bd.journal_entry_id) || null);
  await c.execute({
    sql: "UPDATE bill_discountings SET payment_received_date = NULL, journal_entry_id = NULL WHERE id = ?",
    args: [id]
  });
  return { id };
}
async function reopenBd(id) {
  const c = getClient();
  const bd = await loadBd(id);
  await dropRepayEntries(bd);
  await dropEntry2(n23(bd.margin_release_journal_entry_id) || null);
  await c.execute({
    sql: "UPDATE bill_discountings SET status = 'open', repaid_date = NULL, repaid_amount = NULL, repay_journal_entry_id = NULL, margin_release_journal_entry_id = NULL WHERE id = ?",
    args: [id]
  });
  return { id };
}
async function bdLimits() {
  const c = getClient();
  const cid = getActiveCompanyId();
  const res = await c.execute({
    sql: `SELECT nb.id, nb.name, nb.finance_type, nb.active,
                 COALESCE(nb.sanctioned_limit, 0) AS sanctioned,
                 COALESCE((SELECT SUM(bd.amount - COALESCE((SELECT SUM(r.amount) FROM bd_repayments r
                            WHERE r.bd_id = bd.id), 0))
                           FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid' AND bd.payment_received_date IS NOT NULL), 0) AS utilised,
                 COALESCE((SELECT SUM(bd.amount) FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ?
                             AND bd.status <> 'repaid' AND bd.payment_received_date IS NULL), 0) AS committed,
                 COALESCE((SELECT COUNT(*) FROM bill_discountings bd
                           WHERE bd.nbfc_id = nb.id AND bd.company_id = ? AND bd.status <> 'repaid'), 0) AS open_bills
          FROM nbfcs nb
          WHERE nb.company_id = ?
          ORDER BY nb.active DESC, nb.name COLLATE NOCASE`,
    args: [cid, cid, cid, cid]
  });
  const perNbfc = toPlain27(res).map((r) => {
    const sanctioned = round211(n23(r.sanctioned));
    const utilised = round211(n23(r.utilised));
    return {
      ...r,
      sanctioned,
      utilised,
      committed: round211(n23(r.committed)),
      // No sanctioned figure means nothing to be available OUT of — reported as
      // null so the screen can say "not set" rather than showing a negative.
      available: sanctioned > 0 ? round211(sanctioned - utilised) : null,
      used_pct: sanctioned > 0 ? Math.round(utilised / sanctioned * 1e3) / 10 : null
    };
  });
  const combinedRaw = await getSetting(`bd_combined_limit_${cid}`);
  const combined = combinedRaw == null || String(combinedRaw).trim() === "" ? null : round211(n23(combinedRaw));
  const utilisedTotal = round211(perNbfc.reduce((t, r) => t + n23(r.utilised), 0));
  const sanctionedTotal = round211(perNbfc.reduce((t, r) => t + n23(r.sanctioned), 0));
  return {
    per_nbfc: perNbfc,
    // The sum of what each NBFC has sanctioned. Not the same thing as the
    // combined ceiling: a group limit can sit below the sum of its lines.
    sanctioned_sum: sanctionedTotal,
    utilised_total: utilisedTotal,
    committed_total: round211(perNbfc.reduce((t, r) => t + n23(r.committed), 0)),
    combined_limit: combined,
    combined_available: combined == null ? null : round211(combined - utilisedTotal),
    combined_used_pct: combined && combined > 0 ? Math.round(utilisedTotal / combined * 1e3) / 10 : null,
    // What can actually be drawn, from whichever limits have been recorded:
    //
    //   lines only    -> the sum of them
    //   combined only -> the combined ceiling
    //   both          -> the LOWER of the two. A group ceiling caps the lines,
    //                    and the lines cap the group in the other direction —
    //                    you cannot draw more than either allows.
    //   neither       -> nothing to report
    //
    // The basis is named alongside it, so the figure is never a number without
    // provenance. Reporting only the combined ceiling was wrong: per-NBFC limits
    // on their own are a real limit, and the screen said "not set" over them.
    ...(() => {
      const lines = sanctionedTotal > 0 ? sanctionedTotal : null;
      if (combined == null && lines == null) {
        return { effective_limit: null, effective_basis: null, effective_available: null, effective_used_pct: null };
      }
      const limit = combined != null && lines != null ? Math.min(combined, lines) : combined != null ? combined : lines;
      const basis = combined != null && lines != null ? combined <= lines ? "combined" : "lines" : combined != null ? "combined" : "lines";
      return {
        effective_limit: round211(limit),
        effective_basis: basis,
        effective_available: round211(limit - utilisedTotal),
        effective_used_pct: limit > 0 ? Math.round(utilisedTotal / limit * 1e3) / 10 : null
      };
    })(),
    // Worth saying out loud: a group ceiling under the sum of the lines means
    // the lines cannot all be drawn at once.
    lines_exceed_combined: combined != null && sanctionedTotal > combined
  };
}
async function setBdCombinedLimit(value) {
  const cid = getActiveCompanyId();
  const raw = value == null || String(value).trim() === "" ? "" : String(round211(n23(value)));
  await setSetting(`bd_combined_limit_${cid}`, raw);
  return { value: raw === "" ? null : Number(raw) };
}
async function bdKpis() {
  const all = await listBd({ status: ["open"] });
  const rows = all.filter((r) => String(r.stage) === "live");
  const awaiting = all.filter((r) => String(r.stage) === "awaiting");
  return {
    count: rows.length,
    outstanding_total: round211(rows.reduce((s, r) => s + n23(r.outstanding_amount), 0)),
    margin_total: round211(rows.reduce((s, r) => s + n23(r.marginAmount), 0)),
    interest_total: round211(rows.reduce((s, r) => s + n23(r.interestAmount), 0)),
    tds_total: round211(rows.reduce((s, r) => s + n23(r.tdsAmount), 0)),
    receipt_total: round211(rows.reduce((s, r) => s + n23(r.receiptAmount), 0)),
    awaiting_count: awaiting.length,
    awaiting_total: round211(awaiting.reduce((s, r) => s + n23(r.amount), 0))
  };
}

// src/main/transporterBilling.ts
function toPlain28(res) {
  return res.rows.map((r) => {
    const o = {};
    for (const col of res.columns) o[col] = r[col];
    return o;
  });
}
var n24 = (v) => Number(v) || 0;
var round212 = (v) => Math.round(v * 100) / 100;
var todayISO7 = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
async function listTransporterFreight(side, opts = {}) {
  const c = getClient();
  const cid = opts.companyId ? n24(opts.companyId) : getActiveCompanyId();
  const args = [cid];
  const where = ["l.company_id = ?", "l.entry_type IN ('freight', 'shortage_penalty')"];
  where.push(side === "purchase" ? "l.order_id IS NOT NULL" : "l.sale_id IS NOT NULL");
  if (side === "sales") {
    where.push("COALESCE((SELECT sa2.deduct_freight FROM sales sa2 WHERE sa2.id = l.sale_id), 0) <> 1");
  }
  if (opts.from) {
    where.push("COALESCE(l.entry_date, ?) >= ?");
    args.push(opts.from, opts.from);
  }
  if (opts.to) {
    where.push("COALESCE(l.entry_date, '9999-12-31') <= ?");
    args.push(opts.to);
  }
  if (opts.transporterId) {
    where.push("l.transporter_id = ?");
    args.push(n24(opts.transporterId));
  }
  if (opts.state === "unbilled") where.push("l.bill_id IS NULL");
  if (opts.state === "billed") where.push("l.bill_id IS NOT NULL");
  const doc = side === "purchase" ? `o.invoice_no AS doc_no, o.order_date AS doc_date, s.name AS party_name,
         p.name AS product_name,
         -- Purchase freight is booked per TANKER (one ledger row each) under a
         -- single oil invoice, and the tanker number lives in the note the
         -- ledger writer stamps: "Tanker XX/1234: freight less shortage".
         COALESCE(
           NULLIF(TRIM(SUBSTR(l.note, 8, INSTR(l.note, ':') - 8)), ''),
           o.tanker_no
         ) AS vehicle_no,
         o.ordered_qty AS dispatch_qty, o.received_qty AS received_qty,
         o.status AS dispatch_stage,
         CASE WHEN o.status != 'received' THEN 1 ELSE 0 END AS provisional` : `sa.invoice_no AS doc_no, sa.sale_date AS doc_date, COALESCE(cu.name, sa.customer) AS party_name,
         p.name AS product_name,
         -- A sale has no tanker record of its own; the vehicle that carried it
         -- is whatever the gate wrote against the invoice group on the way out.
         -- Resolved through the join below rather than a subquery per row.
         gv.tanker_no AS vehicle_no,
         sa.qty AS dispatch_qty, sa.received_qty AS received_qty, sa.dispatch_stage AS dispatch_stage,
         -- Until the invoice is unloaded there is no weighed-in quantity, so the
         -- freight is still an estimate off the dispatched qty. Flagged so the
         -- register can say "valuation" rather than presenting a provisional
         -- figure as something the transporter can be billed on.
         CASE WHEN sa.dispatch_stage = 'unloaded' OR (sa.dispatch_stage IS NULL AND sa.status = 'done')
              THEN 0 ELSE 1 END AS provisional`;
  const joins = side === "purchase" ? `LEFT JOIN orders o ON o.id = l.order_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.oil_type_id` : `LEFT JOIN sales sa ON sa.id = l.sale_id
         LEFT JOIN customers cu ON cu.id = sa.customer_id
         LEFT JOIN products p ON p.id = sa.product_id
         LEFT JOIN (SELECT ge.invoice_group AS grp, MAX(ge.id) AS ge_id
                      FROM gate_entries ge
                     WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
                     GROUP BY ge.invoice_group) go2 ON go2.grp = sa.invoice_group
         LEFT JOIN gate_entries gv ON gv.id = go2.ge_id`;
  const res = await c.execute({
    sql: `SELECT l.id, l.transporter_id, l.entry_date, l.entry_type, l.amount, l.note,
                 l.accrued, l.bill_id, l.note_id, l.waived_at, l.waived_by, l.waived_reason,
                 nt.note_no, nt.note_date,
                 t.name AS transporter_name,
                 b.bill_no, b.bill_date, ${doc}
          FROM transporter_ledger l
          LEFT JOIN transporters t ON t.id = l.transporter_id
          LEFT JOIN transporter_bills b ON b.id = l.bill_id
          LEFT JOIN notes nt ON nt.id = l.note_id
          ${joins}
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(l.entry_date, '') DESC, l.id DESC`,
    args
  });
  return toPlain28(res);
}
async function transporterFreightKpis(side, opts = {}) {
  const rows = await listTransporterFreight(side, { ...opts, state: "all" });
  const total = round212(rows.reduce((t, r) => t + n24(r.amount), 0));
  const unbilled = round212(rows.filter((r) => r.bill_id == null).reduce((t, r) => t + n24(r.amount), 0));
  const parties = new Set(rows.filter((r) => r.bill_id == null).map((r) => String(r.transporter_id)));
  const provisional = round212(
    rows.filter((r) => r.bill_id == null && n24(r.provisional) === 1).reduce((t, r) => t + n24(r.amount), 0)
  );
  return {
    lines: rows.length,
    unbilled_lines: rows.filter((r) => r.bill_id == null).length,
    total,
    billed: round212(total - unbilled),
    unbilled,
    provisional,
    firm: round212(unbilled - provisional),
    transporters_pending: parties.size
  };
}
async function listTransporterBills(companyId) {
  const res = await getClient().execute({
    sql: `SELECT b.*, t.name AS transporter_name,
                 (SELECT COUNT(*) FROM transporter_ledger l WHERE l.bill_id = b.id) AS line_count
          FROM transporter_bills b
          LEFT JOIN transporters t ON t.id = b.transporter_id
          WHERE b.company_id = ?
          ORDER BY b.id DESC`,
    args: [companyId ? n24(companyId) : getActiveCompanyId()]
  });
  return toPlain28(res);
}
async function dropEntry3(entryId) {
  if (!entryId) return;
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)",
    args: [entryId]
  });
  await c.execute({ sql: "DELETE FROM journal_lines WHERE entry_id = ?", args: [entryId] });
  await c.execute({ sql: "DELETE FROM journal_entries WHERE id = ?", args: [entryId] });
}
async function createTransporterBill(v, existingId) {
  const c = getClient();
  const cid = v.company_id ? n24(v.company_id) : getActiveCompanyId();
  const transporterId = n24(v.transporter_id);
  if (!transporterId) throw new Error("Select the transporter");
  const side = v.side === "sales" ? "sales" : "purchase";
  const lineIds = (Array.isArray(v.line_ids) ? v.line_ids : []).map(n24).filter((x) => x > 0);
  if (!lineIds.length) throw new Error("Tick at least one freight line for this bill");
  const ph = lineIds.map(() => "?").join(", ");
  const linesRes = await c.execute({
    sql: `SELECT id, transporter_id, amount, accrued, bill_id FROM transporter_ledger
          WHERE id IN (${ph}) AND company_id = ?`,
    args: [...lineIds, cid]
  });
  const picked = toPlain28(linesRes);
  if (picked.length !== lineIds.length) throw new Error("Some of those freight lines no longer exist");
  for (const l of picked) {
    if (n24(l.transporter_id) !== transporterId) throw new Error("Every line on one bill must belong to the same transporter");
    if (l.bill_id != null && n24(l.bill_id) !== n24(existingId)) throw new Error("One of those lines is already on another bill");
    if (l.note_id != null) {
      throw new Error("That shortage is already on a debit note \u2014 leave it off the bill, which books the freight in full");
    }
    if (l.waived_at != null) {
      throw new Error("That shortage was written off \u2014 leave it off the bill, which books the freight in full");
    }
  }
  const accrued = round212(picked.filter((l) => n24(l.accrued) === 1).reduce((t, l) => t + n24(l.amount), 0));
  const unaccrued = round212(picked.filter((l) => n24(l.accrued) !== 1).reduce((t, l) => t + n24(l.amount), 0));
  const lineTotal = round212(accrued + unaccrued);
  const adjustment = round212(n24(v.adjustment));
  const taxable = round212(lineTotal + adjustment);
  if (taxable <= 0) throw new Error("The bill nets to zero or less \u2014 check the adjustment");
  const gstPct = n24(v.gst_pct);
  const gst = round212(taxable * gstPct / 100);
  const tdsPct = n24(v.tds_pct);
  const tds = round212(taxable * tdsPct / 100);
  const raw = round212(taxable + gst - tds);
  const total = Math.round(raw);
  const roundOff = round212(total - raw);
  const billDate = String(v.bill_date || todayISO7()).slice(0, 10);
  const billNo = v.bill_no ? String(v.bill_no).trim() : null;
  const note = v.note ? String(v.note).trim() : null;
  const partyRes = await c.execute({ sql: "SELECT name FROM transporters WHERE id = ?", args: [transporterId] });
  if (!partyRes.rows.length) throw new Error("Transporter not found");
  const partyName2 = String(partyRes.rows[0].name || "").trim();
  const prior = existingId ? (await c.execute({ sql: "SELECT * FROM transporter_bills WHERE id = ? AND company_id = ?", args: [existingId, cid] })).rows[0] : void 0;
  if (existingId && !prior) throw new Error("That bill no longer exists");
  if (prior) {
    await dropEntry3(n24(prior.journal_entry_id) || null);
    await c.execute({ sql: "UPDATE transporter_ledger SET bill_id = NULL WHERE bill_id = ?", args: [existingId] });
  }
  const je = await postJournal({
    date: billDate,
    // A freight bill IS a purchase of a service, so it belongs in the purchase
    // series and reads as PUR in the ledger — not as an unexplained JV.
    vchType: side === "purchase" ? "PURCHASE FREIGHT INWARD" : "PURCHASE FREIGHT OUTWARD",
    vchNo: billNo,
    narration: `Transporter bill ${billNo || ""} \u2014 ${partyName2} (${side === "purchase" ? "inward" : "outward"} freight, ${picked.length} line${picked.length === 1 ? "" : "s"}` + (adjustment ? `, adjusted by ${adjustment > 0 ? "+" : ""}${adjustment.toFixed(2)}` : "") + ")" + (v.adjustment_note ? ` \u2014 ${String(v.adjustment_note).trim()}` : ""),
    companyId: cid,
    lines: [
      { account: "FREIGHT PAYABLE A/C", group: "Current Liabilities", dr: accrued },
      {
        account: side === "purchase" ? "FREIGHT INWARD A/C" : "FREIGHT OUTWARD A/C",
        group: "Direct Expenses",
        // The adjustment is freight too, so it lands on the same expense —
        // positive as more cost, negative as less.
        dr: round212(unaccrued + adjustment) > 0 ? round212(unaccrued + adjustment) : 0,
        cr: round212(unaccrued + adjustment) < 0 ? -round212(unaccrued + adjustment) : 0
      },
      { account: "GST INPUT A/C", group: "Duties & Taxes", dr: gst },
      { account: "ROUND OFF A/C", group: "Indirect Expenses", dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
      { account: "TDS PAYABLE A/C", group: "Duties & Taxes", cr: tds },
      { account: partyName2, group: "Sundry Creditors", cr: total }
    ]
  });
  let billId;
  if (prior) {
    await c.execute({
      sql: `UPDATE transporter_bills SET transporter_id = ?, side = ?, bill_no = ?, bill_date = ?,
              taxable = ?, gst_pct = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?,
              total = ?, journal_entry_id = ?, note = ?, adjustment = ?, adjustment_note = ?
            WHERE id = ? AND company_id = ?`,
      args: [
        transporterId,
        side,
        billNo,
        billDate,
        taxable,
        gstPct,
        gst,
        tdsPct,
        tds,
        roundOff,
        total,
        je.id ?? null,
        note,
        adjustment,
        v.adjustment_note ? String(v.adjustment_note).trim() : null,
        existingId,
        cid
      ]
    });
    billId = existingId;
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO transporter_bills
              (company_id, transporter_id, side, bill_no, bill_date, taxable, gst_pct, gst_amount,
               tds_pct, tds_amount, round_off, total, journal_entry_id, note, adjustment, adjustment_note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cid,
        transporterId,
        side,
        billNo,
        billDate,
        taxable,
        gstPct,
        gst,
        tdsPct,
        tds,
        roundOff,
        total,
        je.id,
        note,
        adjustment,
        v.adjustment_note ? String(v.adjustment_note).trim() : null
      ]
    });
    billId = Number(ins.lastInsertRowid);
  }
  await c.execute({ sql: `UPDATE transporter_ledger SET bill_id = ? WHERE id IN (${ph})`, args: [billId, ...lineIds] });
  return { id: billId };
}
async function raiseFreightShortageNote(lineId, v = {}) {
  const c = getClient();
  const cid = v.companyId ? n24(v.companyId) : getActiveCompanyId();
  const r = await c.execute({
    sql: `SELECT l.*, s.invoice_no AS sale_invoice, o.invoice_no AS order_invoice
            FROM transporter_ledger l
            LEFT JOIN sales s ON s.id = l.sale_id
            LEFT JOIN orders o ON o.id = l.order_id
           WHERE l.id = ? AND l.company_id = ?`,
    args: [n24(lineId), cid]
  });
  if (!r.rows.length) throw new Error("That freight line no longer exists");
  const line = toPlain28(r)[0];
  if (String(line.entry_type) !== "shortage_penalty") {
    throw new Error("Only a shortage line can be raised as a debit note");
  }
  if (line.note_id != null) throw new Error("A debit note has already been raised on this shortage");
  if (line.waived_at != null) {
    throw new Error("This shortage was written off as not the transporter's \u2014 undo that first to claim it");
  }
  if (line.bill_id != null) {
    throw new Error("That shortage is already netted into a booked bill \u2014 delete the bill first if it should be claimed separately");
  }
  const amount = round212(Math.abs(n24(line.amount)));
  if (amount <= 0) throw new Error("Nothing to claim on this line");
  if (!line.transporter_id) throw new Error("This line has no transporter to raise a note against");
  const inv = String(line.sale_invoice || line.order_invoice || "");
  const inward = line.order_id != null;
  const note = await createNote({
    company_id: cid,
    note_type: "debit",
    party_type: "transporter",
    party_id: n24(line.transporter_id),
    note_date: String(v.date || line.entry_date || todayISO7()).slice(0, 10),
    against_account: inward ? "FREIGHT INWARD A/C" : "FREIGHT OUTWARD A/C",
    base_amount: amount,
    gst_pct: 0,
    against_invoice: inv || null,
    narration: `Oil shortage recovery${inv ? ` on ${inv}` : ""}${line.note ? ` \u2014 ${String(line.note)}` : ""}`
  });
  await c.execute({
    sql: "UPDATE transporter_ledger SET note_id = ? WHERE id = ?",
    args: [note.id, n24(lineId)]
  });
  await bumpRevision();
  return { note_id: note.id, note_no: note.note_no };
}
async function waiveFreightShortage(lineId, v) {
  const c = getClient();
  const cid = v.companyId ? n24(v.companyId) : getActiveCompanyId();
  const reason = String(v.reason || "").trim();
  if (!reason) throw new Error("Say why this shortage is not the transporter's \u2014 a waiver without a reason cannot be reviewed later");
  const r = await c.execute({
    sql: `SELECT l.*, o.invoice_no AS order_invoice, s.invoice_no AS sale_invoice,
                 pr.code AS oil_code, pr.name AS oil_name, sp.code AS sale_code, sp.name AS sale_name
            FROM transporter_ledger l
            LEFT JOIN orders o ON o.id = l.order_id
            LEFT JOIN products pr ON pr.id = o.oil_type_id
            LEFT JOIN sales s ON s.id = l.sale_id
            LEFT JOIN products sp ON sp.id = s.product_id
           WHERE l.id = ? AND l.company_id = ?`,
    args: [n24(lineId), cid]
  });
  if (!r.rows.length) throw new Error("That freight line no longer exists");
  const line = toPlain28(r)[0];
  if (String(line.entry_type) !== "shortage_penalty") throw new Error("Only a shortage line can be written off");
  if (line.note_id != null) throw new Error("A debit note has already been raised on this shortage \u2014 delete it first");
  if (line.waived_at != null) throw new Error("This shortage has already been written off");
  if (line.bill_id != null) throw new Error("That shortage is already netted into a booked bill \u2014 delete the bill first");
  const amount = round212(Math.abs(n24(line.amount)));
  if (amount <= 0) throw new Error("Nothing to write off on this line");
  const inward = line.order_id != null;
  const goods = inward ? `${String(line.oil_code || line.oil_name || "OIL").toUpperCase()} PUR A/C` : `${String(line.sale_code || line.sale_name || "FG").toUpperCase()} SALE A/C`;
  const inv = String(line.order_invoice || line.sale_invoice || "");
  const je = await postJournal({
    date: String(v.date || line.entry_date || todayISO7()).slice(0, 10),
    vchType: "JOURNAL",
    vchNo: null,
    narration: `Oil shortage written off${inv ? ` on ${inv}` : ""} \u2014 not the transporter's: ${reason}`,
    companyId: cid,
    lines: [
      { account: "OIL SHORTAGE LOSS A/C", group: "Indirect Expenses", dr: amount },
      { account: goods, group: inward ? "Purchase Accounts" : "Sales Accounts", cr: amount }
    ]
  });
  await c.execute({
    sql: `UPDATE transporter_ledger
             SET waived_at = ?, waived_by = ?, waived_reason = ?, waived_entry_id = ?
           WHERE id = ?`,
    args: [todayISO7(), getCurrentUser().username || null, reason, je.id ?? null, n24(lineId)]
  });
  await bumpRevision();
  return { id: n24(lineId), entry_id: je.id ?? null };
}
async function unwaiveFreightShortage(lineId, companyId) {
  const c = getClient();
  const cid = companyId ? n24(companyId) : getActiveCompanyId();
  const r = await c.execute({
    sql: "SELECT waived_entry_id FROM transporter_ledger WHERE id = ? AND company_id = ?",
    args: [n24(lineId), cid]
  });
  if (!r.rows.length) throw new Error("That freight line no longer exists");
  const entryId = r.rows[0].waived_entry_id;
  await c.execute({
    sql: `UPDATE transporter_ledger
             SET waived_at = NULL, waived_by = NULL, waived_reason = NULL, waived_entry_id = NULL
           WHERE id = ?`,
    args: [n24(lineId)]
  });
  if (entryId != null) await dropEntry3(n24(entryId));
  await bumpRevision();
  return { id: n24(lineId) };
}
async function unraiseFreightShortageNote(lineId, companyId) {
  const c = getClient();
  const cid = companyId ? n24(companyId) : getActiveCompanyId();
  const r = await c.execute({
    sql: "SELECT note_id FROM transporter_ledger WHERE id = ? AND company_id = ?",
    args: [n24(lineId), cid]
  });
  if (!r.rows.length) throw new Error("That freight line no longer exists");
  const noteId = r.rows[0].note_id;
  await c.execute({ sql: "UPDATE transporter_ledger SET note_id = NULL WHERE id = ?", args: [n24(lineId)] });
  if (noteId != null) await deleteNote(n24(noteId), cid);
  await bumpRevision();
  return { id: n24(lineId) };
}
async function updateTransporterBill(id, v) {
  return createTransporterBill(v, n24(id));
}
async function listOrphanedTransporterBills(companyId) {
  const res = await getClient().execute({
    sql: `SELECT tb.*, tr.name AS transporter_name,
                 (SELECT COUNT(*) FROM transporter_ledger l WHERE l.bill_id = tb.id) AS line_count,
                 (SELECT ROUND(SUM(l.amount), 2) FROM transporter_ledger l WHERE l.bill_id = tb.id) AS line_amount
            FROM transporter_bills tb
            LEFT JOIN transporters tr ON tr.id = tb.transporter_id
           WHERE tb.company_id = ?
             AND tb.journal_entry_id IS NOT NULL
             AND tb.journal_entry_id NOT IN (SELECT id FROM journal_entries)
           ORDER BY tb.id`,
    args: [companyId ? n24(companyId) : getActiveCompanyId()]
  });
  return toPlain28(res);
}
async function deleteTransporterBill(id, companyId) {
  const c = getClient();
  const res = await c.execute({
    sql: "SELECT * FROM transporter_bills WHERE id = ? AND company_id = ?",
    args: [id, companyId ? n24(companyId) : getActiveCompanyId()]
  });
  if (!res.rows.length) throw new Error("That transporter bill no longer exists in this company");
  const bill = res.rows[0];
  await dropEntry3(n24(bill.journal_entry_id) || null);
  await c.execute({ sql: "UPDATE transporter_ledger SET bill_id = NULL WHERE bill_id = ?", args: [id] });
  await c.execute({ sql: "DELETE FROM transporter_bills WHERE id = ?", args: [id] });
  return { id };
}

// src/main/ipc.ts
var NS_ENTITY = {
  bargains: "Bargain",
  orders: "Purchase",
  tankers: "Tanker",
  consignment: "Consignment",
  sales: "Sale",
  salesBargains: "Sales bargain",
  billDiscount: "Bill discount",
  bd: "Bill discount",
  lc: "Letter of credit",
  journal: "Journal",
  ledger: "Ledger",
  production: "Production",
  formulation: "Formulation",
  stock: "Stock",
  stockCount: "Stock count",
  skuStock: "Packed SKU stock",
  notes: "Debit/Credit note",
  gate: "Gate entry",
  users: "User",
  access: "Access",
  settings: "Settings",
  company: "Company"
};
var OP_VERB = {
  create: "Created",
  update: "Updated",
  // These were falling through and being stored as the raw channel word
  // ('preclose', 'unpreclose'), which read like code in the trail.
  preclose: "Preclosed",
  unpreclose: "Undid preclosure",
  markReceived: "Marked payment received",
  unmarkReceived: "Undid payment received",
  repay: "Repaid",
  deleteRepayment: "Removed a repayment",
  deleteAdjustment: "Removed a packed-stock entry",
  reopen: "Reopened",
  saveLimit: "Changed the facility limit",
  upfrontInterest: "Posted upfront interest",
  createInvoice: "Created",
  updateInvoice: "Updated",
  deleteInvoice: "Deleted",
  rejectInvoice: "Rejected",
  unrejectInvoice: "Un-rejected",
  setInvoiceStage: "Moved the dispatch stage",
  setStage: "Moved the dispatch stage",
  cancelDelivery: "Cancelled the delivery",
  delete: "Deleted",
  advance: "Advanced",
  record: "Recorded",
  save: "Saved",
  setStatus: "Changed status",
  issue: "Issued",
  addEntry: "Added entry",
  deleteEntry: "Deleted entry",
  createAccount: "Created account",
  deleteIssuance: "Deleted issuance",
  transfer: "Transferred",
  deleteTransfer: "Reversed transfer",
  setIp: "Changed device",
  set: "Changed setting"
};
function tableLabel(table) {
  const map = {
    suppliers: "Supplier",
    customers: "Customer",
    transporters: "Transporter",
    brokers: "Broker",
    products: "Product",
    sources: "Port",
    uoms: "UOM",
    companies: "Company"
  };
  return map[table] || (table ? table.charAt(0).toUpperCase() + table.slice(1) : "Record");
}
function summarizeArgs(args) {
  const v = args?.values || args?.data || args || {};
  const parts = [];
  const add = (label, val) => {
    if (val != null && val !== "") parts.push(label ? `${label} ${val}` : String(val));
  };
  add("", v.name);
  add("Inv", v.invoice_no);
  add("", v.bargain_no);
  add("Tanker", v.tanker_no);
  add("LC", v.lc_no);
  add("Qty", v.qty ?? v.ordered_qty);
  add("\u20B9", v.amount);
  if (args?.toStatus) parts.push(`\u2192 ${args.toStatus}`);
  if (args?.key) parts.push(`${args.key} = ${args.value}`);
  return parts.join(" \xB7 ").slice(0, 220);
}
async function recordAudit(channel, args, result) {
  const [ns, op] = channel.split(":");
  const entity = ns === "data" ? tableLabel(String(args?.table || "")) : NS_ENTITY[ns] || ns;
  const action = OP_VERB[op] || op;
  const entityId = Number(result?.id ?? args?.id) || null;
  const key3 = args?.group ?? args?.invoice_group ?? result?.group ?? result?.invoice_group ?? null;
  const entityKey = key3 == null || key3 === "" ? null : String(key3);
  const detail = summarizeArgs(args);
  const user = getCurrentUser();
  await logEvent(
    user.id,
    user.username,
    machineIp(),
    action,
    detail,
    getActiveCompanyId(),
    entity,
    entityId,
    entityKey
  );
}
function registerIpc() {
  const READONLY = /:list$|:get$|:items$|:issuances$|:sheet$|:outstanding$|:all$|:summary$|:transfers$|:fyTaxable$|:needs$|:breakdown$|:nextNo$|:liveUsers$|:ips$|:logs$|:dispatchableSales$|:mine$|:pendingCount$|:pending$|:lots$|:unmapped$|:unmappedCount$|:bargainLines$|:bargainNotes$|:bargainInterest$|:consignmentDraws$|^access:heartbeat$|^db:ping$|^db:snapshot$|^app:revision$|^auth:login$|^journal:booksFrom$|^journal:openings$|^journal:opening$|^journal:accounts$|^journal:statement$|^journal:trialBalance$|^journal:groups$|^journal:groupNames$|^journal:pendingRefs$|^journal:billsOutstanding$|^journal:tradingAccount$|^dashboard:stats$|^skuRates:parties$|^skuRates:partyCounts$|^consignment:openingLog$|^consignment:invoices$|^gate:partyCategories$|^gate:forRecord$|^treasury:alerts$|^treasury:paymentTracker$|^facility:exposures$|^facility:headroom$|^company:setActive$|^company:getActive$|^session:setUser$|^lc:repayments$|^lc:allRepayments$|^lc:getLimit$|^lc:bankLimits$|^lc:paymentIns$|^lc:openTradingInvoices$|^files:pickDocument$|^files:openDocument$|^bankRecon:imports$|^bankRecon:list$|^bankRecon:suggest$|^bd:kpis$|^bd:limits$|^skuStock:adjustments$|^skuOpening:list$|^skuOpening:date$|^stockCount:previous$|^stockOpening:list$|^stockOpening:date$|^formulationSubcategory:list$|^bd:allRepayments$|^bd:linkedOrders$|^bd:parties$|^bd:allParties$|^bd:openTradingInvoices$|^bd:paymentIns$|^access:entryWindows$|^access:entityHistory$|^trading:list$|^sales:series$|^sales:invoiceGaps$|^salesBargains:returns$|^salesBargains:unattributedReturns$|^tbill:orphans$/;
  const AUDIT_SKIP = /* @__PURE__ */ new Set(["config:get", "config:save", "session:setUser"]);
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (e, args) => {
      if (!READONLY.test(channel)) await assertAllowed(channel, args);
      const result = await fn(e, args);
      if (!READONLY.test(channel)) {
        notifyDataChanged();
        await bumpRevision().catch(() => {
        });
        if (!AUDIT_SKIP.has(channel)) await recordAudit(channel, args, result).catch(() => {
        });
      }
      return result;
    });
  };
  handle("app:revision", () => getRevision());
  handle("db:ping", () => ping());
  handle("db:snapshot", async () => {
    const user = getCurrentUser();
    const who = await getClient().execute({ sql: "SELECT role FROM users WHERE id = ? AND active = 1", args: [user.id] }).catch(() => null);
    if (String(who?.rows[0]?.role || "") !== "admin") {
      throw new Error("Only an administrator can download the database.");
    }
    const snap = await snapshotGz();
    await logEvent(
      user.id,
      user.username,
      machineIp(),
      "Downloaded a database snapshot",
      `${snap.rows.toLocaleString()} rows across ${snap.tables} tables \xB7 ${(snap.gzBytes / 1048576).toFixed(2)} MB`,
      getActiveCompanyId(),
      "Database",
      null,
      null
    ).catch(() => {
    });
    return snap;
  });
  handle("config:get", () => ({ url: getConfiguredUrl() }));
  handle("config:save", async (_e, { url, token }) => {
    saveStoredConfig(url, token);
    resetClient();
    await initDb();
    await seedDefaultAdmin().catch(() => {
    });
    await seedProducts().catch(() => {
    });
    await seedFormulations().catch(() => {
    });
    return ping();
  });
  handle("company:list", () => listCompanies());
  handle("company:setActive", (_e, { id }) => setActiveCompany(id));
  handle("company:getActive", () => ({ id: getActiveCompanyId() }));
  handle("data:list", (_e, { table }) => list(table));
  handle("data:get", (_e, { table, id }) => get(table, id));
  handle(
    "data:create",
    async (_e, { table, values }) => await needsApproval(table) ? submitApprovalRequest(table, values) : create(table, values)
  );
  handle(
    "data:update",
    (_e, { table, id, values }) => update(table, id, values)
  );
  handle(
    "data:delete",
    (_e, { table, id }) => remove(table, id)
  );
  handle("approvals:list", () => listApprovalRequests());
  handle("approvals:mine", () => myApprovalRequests());
  handle("approvals:pendingCount", () => pendingApprovalCount());
  handle("approvals:approve", (_e, { id }) => approveRequest(id));
  handle(
    "approvals:reject",
    (_e, { id, reason }) => rejectRequest(id, reason)
  );
  handle("settings:get", (_e, { key: key3 }) => getSetting(key3));
  handle(
    "settings:set",
    (_e, { key: key3, value }) => setSetting(key3, value)
  );
  handle("settings:all", () => allSettings());
  handle(
    "bargains:list",
    (_e, args) => listBargains(args?.from, args?.to, args?.companyIds, args?.forModule)
  );
  handle("bargains:create", (_e, { values }) => createBargain(values));
  handle(
    "bargains:update",
    (_e, { id, values }) => updateBargain(id, values)
  );
  handle("bargains:delete", (_e, { id }) => deleteBargain(id));
  handle(
    "bargains:adjust",
    (_e, { id, delta, note, date }) => adjustBargainQty(id, delta, note, date)
  );
  handle("orders:bargainNotes", (_e, { id }) => purchaseBargainNotes(id));
  handle("orders:list", (_e, args) => listOrders(args?.forModule));
  handle("skuRates:list", (_e, { id }) => listSkuRates(id));
  handle("skuRates:partyCounts", () => packagingPartyCounts());
  handle("skuRates:parties", (_e, { packagingId }) => listPackagingParties(packagingId));
  handle("skuRates:setParties", (_e, { packagingId, customerIds }) => setPackagingParties(packagingId, customerIds));
  handle("skuRates:save", (_e, { id, rows }) => saveSkuRates(id, rows));
  handle("orders:consignmentDraws", (_e, args) => listConsignmentDraws(args?.companyIds));
  handle("orders:bargainLines", (_e, { id }) => listOrderBargains(id));
  handle("orders:bargainInterest", (_e, { id }) => listOrderBargainInterest(id));
  handle(
    "tankers:list",
    (_e, args) => listPurchaseTankers(!!args?.all, args?.forModule)
  );
  handle("tankers:create", (_e, { values }) => createPurchaseTanker(values));
  handle(
    "tankers:update",
    (_e, { id, values }) => updateTankerDetails(id, values)
  );
  handle("tankers:delete", (_e, { id }) => deletePurchaseTanker(id));
  handle(
    "tankers:advance",
    (_e, { id, toStatus, data }) => advancePurchaseTanker(id, toStatus, data)
  );
  handle("tankers:revert", (_e, { id }) => revertPurchaseTanker(id));
  handle("tankers:replace", (_e, { id, values }) => replaceTanker(id, values));
  handle("orders:create", (_e, { values }) => createOrder(values));
  handle(
    "orders:update",
    (_e, { id, values }) => updateOrder(id, values)
  );
  handle("orders:delete", (_e, { id }) => deleteOrder(id));
  handle(
    "orders:fyTaxable",
    (_e, { supplierId, date, excludeId }) => supplierFyTaxable(supplierId, date, excludeId)
  );
  handle(
    "sales:fyTaxable",
    (_e, { customerId, date, excludeId }) => customerFyTaxable(customerId, date, excludeId)
  );
  handle(
    "orders:advance",
    (_e, { id, toStatus, data }) => advanceOrder(id, toStatus, data)
  );
  handle("orders:unmapped", () => listUnmappedOrders());
  handle("orders:unmappedCount", () => unmappedCount());
  handle(
    "orders:map",
    (_e, { id, lines, force }) => mapOrderToBargains(id, lines, !!force)
  );
  handle("consignment:list", (_e, args) => listConsignment(args?.forModule));
  handle("consignment:summary", (_e, args) => consignmentSummary(args?.range));
  handle("consignment:pending", () => listPendingGateArrivals());
  handle(
    "consignment:invoices",
    (_e, args) => listConsignmentInvoices(args?.range)
  );
  handle(
    "consignment:lots",
    (_e, { supplierId, productId }) => listUnbookedLots(supplierId, productId)
  );
  handle("consignment:create", (_e, { values }) => createConsignment(values));
  handle(
    "consignment:update",
    (_e, { id, values }) => updateConsignment(id, values)
  );
  handle("consignment:delete", (_e, { id }) => deleteConsignment(id));
  handle("consignment:saveOpening", (_e, { values }) => saveOpeningStock(values));
  handle(
    "consignment:openingLog",
    (_e, { supplierId, productId }) => listOpeningLog(supplierId, productId)
  );
  handle("journal:booksFrom", (_e, args) => getBooksFrom(args?.companyId));
  handle(
    "journal:setBooksFrom",
    (_e, { date, companyId }) => setBooksFrom(date, companyId)
  );
  handle("journal:openings", (_e, args) => listOpenings(args?.companyId));
  handle(
    "journal:saveOpenings",
    (_e, { rows, companyId }) => saveOpenings(rows, companyId)
  );
  handle(
    "journal:opening",
    (_e, { accountId, companyId }) => ledgerOpening(accountId, companyId)
  );
  handle("journal:accounts", (_e, args) => listAccounts(args?.companyId));
  handle("journal:createAccount", (_e, { name, group }) => createAccount(name, group));
  handle(
    "journal:statement",
    (_e, { accountId, companyId }) => accountStatement(accountId, companyId)
  );
  handle("journal:addEntry", (_e, { data }) => addManualJournal(data));
  handle(
    "journal:trialBalance",
    (_e, args) => trialBalance(args?.from, args?.to, args?.companyId)
  );
  handle("journal:groups", (_e, args) => listGroups(args?.companyId));
  handle("journal:groupNames", () => TALLY_GROUPS);
  handle(
    "journal:billsOutstanding",
    (_e, a) => billsOutstanding(a.account, a.companyId, { asOf: a.asOf, side: a.side })
  );
  handle(
    "journal:pendingRefs",
    (_e, { account, companyId, side }) => listPendingRefs(account, companyId, side)
  );
  handle(
    "journal:tradingAccount",
    (_e, { from, to, companyId }) => tradingAccount(from, to, companyId)
  );
  handle("dashboard:stats", () => dashboardStats());
  handle(
    "vouchers:list",
    (_e, args) => listVouchers(args?.from, args?.to, args?.vchType, args?.companyId)
  );
  handle("vouchers:get", (_e, { id }) => getVoucher(id));
  handle("vouchers:create", (_e, { values }) => createVoucher(values));
  handle(
    "vouchers:update",
    (_e, { id, values }) => updateVoucher(id, values)
  );
  handle("vouchers:delete", (_e, { id }) => deleteManualEntry(id));
  handle("journal:deleteEntry", (_e, { id }) => deleteManualEntry(id));
  handle("ledger:suppliers", () => listSupplierLedger());
  handle("ledger:transporters", () => listTransporterLedger());
  handle("ledger:customers", () => listCustomerLedger());
  handle("ledger:addEntry", (_e, { data }) => addLedgerEntry(data));
  handle(
    "ledger:deleteEntry",
    (_e, { partyType, id }) => deleteLedgerEntry(partyType, id)
  );
  handle(
    "auth:login",
    (_e, { username, password }) => login(username, password)
  );
  handle("users:list", () => listUsers());
  handle("users:create", (_e, { values }) => createUser(values));
  handle("users:update", (_e, { id, values }) => {
    clearAccessCache();
    return updateUser(id, values);
  });
  handle("users:delete", (_e, { id }) => deleteUser(id));
  handle(
    "access:heartbeat",
    (_e, { userId, username }) => heartbeat(userId, username)
  );
  handle("access:entryWindows", () => entryWindows());
  handle("access:liveUsers", () => liveUsers());
  handle("access:ips", () => listIps());
  handle(
    "access:setIp",
    (_e, { id, active }) => setIpActive(id, active)
  );
  handle("access:logs", (_e, args) => listLogs(args?.filter || {}));
  handle(
    "session:setUser",
    (_e, { id, username }) => setCurrentUser(id, username)
  );
  handle("formulations:list", () => listFormulations());
  handle("formulations:items", (_e, { id }) => getFormulationItems(id));
  handle("formulations:create", (_e, { values }) => createFormulation(values));
  handle(
    "formulations:update",
    (_e, { id, values }) => updateFormulation(id, values)
  );
  handle("formulations:delete", (_e, { id }) => deleteFormulation(id));
  handle("stock:list", (_e, args) => stockLevels(args?.range, args?.companyIds));
  handle("stock:needs", () => productionNeeds());
  handle(
    "stock:registers",
    (_e, args) => stockRegisters(args?.companyIds, args?.range)
  );
  handle(
    "stock:breakdown",
    (_e, args) => stockPartyBreakdown(args?.companyIds, args?.range)
  );
  handle("daybook:list", (_e, { from, to }) => daybook(from, to));
  handle("stock:transfers", () => listStockTransfers());
  handle("stock:transfer", (_e, { values }) => createStockTransfer(values));
  handle("stock:deleteTransfer", (_e, { id }) => deleteStockTransfer(id));
  handle("stockCount:previous", (_e, { date }) => previousStockCount(date));
  handle("stockCount:sheet", (_e, { date }) => stockCountSheet(date));
  handle("stockCount:list", (_e, { date }) => listStockCounts(date));
  handle(
    "stockCount:save",
    (_e, { date, items }) => saveStockCounts(date, items)
  );
  handle("formulationSubcategory:list", () => listFormulationSubcategories());
  handle(
    "formulationSubcategory:save",
    (_e, { values }) => saveFormulationSubcategory(values)
  );
  handle(
    "formulationSubcategory:delete",
    (_e, { id }) => deleteFormulationSubcategory(id)
  );
  handle("sales:cancelInvoiceNo", (_e, { values }) => cancelInvoiceNo(values));
  handle("sales:uncancelInvoiceNo", (_e, { values }) => uncancelInvoiceNo(values));
  handle(
    "stockOpening:list",
    (_e, { companyId } = {}) => listStockOpenings(companyId)
  );
  handle(
    "stockOpening:save",
    (_e, { rows, asOf, companyId }) => saveStockOpenings(rows, asOf, companyId)
  );
  handle(
    "stockOpening:date",
    (_e, { companyId } = {}) => stockOpeningDate(companyId)
  );
  handle("stockCount:history", (_e, { from, to }) => stockCountHistory(from, to));
  handle(
    "skuStock:breakdown",
    (_e, { date } = {}) => skuMovementBreakdown(date)
  );
  handle(
    "skuStock:list",
    (_e, args) => listSkuStock(args?.date)
  );
  handle("skuStock:adjustments", (_e, { id }) => listSkuAdjustments(id));
  handle("skuOpening:list", (_e, args) => listSkuOpenings(void 0, args?.asOf));
  handle("skuOpening:date", () => skuOpeningDate());
  handle("skuOpening:save", (_e, { rows, asOf }) => saveSkuOpenings(rows, asOf));
  handle("skuStock:deleteAdjustment", (_e, { id }) => deleteSkuAdjustment(id));
  handle(
    "skuStock:adjust",
    (_e, { id, delta, note, date, kind }) => adjustSkuStock(id, delta, note, date, kind)
  );
  handle(
    "tfreight:list",
    (_e, a) => listTransporterFreight(a.side, a)
  );
  handle(
    "tfreight:kpis",
    (_e, a) => transporterFreightKpis(a.side, a)
  );
  handle("tbill:list", (_e, a = {}) => listTransporterBills(a?.companyId));
  handle("tbill:create", (_e, { values }) => createTransporterBill(values));
  handle(
    "tfreight:raiseNote",
    (_e, { lineId, date, companyId }) => raiseFreightShortageNote(lineId, { date, companyId })
  );
  handle(
    "tfreight:unraiseNote",
    (_e, { lineId, companyId }) => unraiseFreightShortageNote(lineId, companyId)
  );
  handle(
    "tfreight:waive",
    (_e, { lineId, reason, date, companyId }) => waiveFreightShortage(lineId, { reason, date, companyId })
  );
  handle(
    "tfreight:unwaive",
    (_e, { lineId, companyId }) => unwaiveFreightShortage(lineId, companyId)
  );
  handle("tbill:update", (_e, { id, values }) => updateTransporterBill(id, values));
  handle(
    "tbill:delete",
    (_e, { id, companyId }) => deleteTransporterBill(id, companyId)
  );
  handle("tbill:orphans", (_e, a = {}) => listOrphanedTransporterBills(a?.companyId));
  handle("notes:list", (_e, a = {}) => listNotes(a?.companyId));
  handle("notes:items", (_e, { id }) => listNoteItems(id));
  handle("notes:create", (_e, { values }) => createNote(values));
  handle("notes:update", (_e, { id, values }) => updateNote(id, values));
  handle("notes:delete", (_e, { id, companyId }) => deleteNote(id, companyId));
  handle("production:list", (_e, args) => listProduction(args?.forModule));
  handle("production:items", (_e, { id }) => getProductionItems(id));
  handle("production:create", (_e, { values }) => createProduction(values));
  handle("production:update", (_e, { id, values }) => updateProduction(id, values));
  handle("production:delete", (_e, { id }) => deleteProduction(id));
  handle(
    "sales:list",
    async (_e, args) => await currentScope("sales") === "unload" ? listSalesForUnloadDesk(args?.companyIds) : listSales(args?.companyIds, args?.forModule)
  );
  handle("sales:series", (_e, args) => salesInvoiceSeries(args?.companyId));
  handle(
    "sales:invoiceGaps",
    (_e, args) => salesInvoiceGaps(args?.companyId, { from: args?.from, to: args?.to })
  );
  handle("sales:create", (_e, { values }) => createSale(values));
  handle("sales:update", (_e, { id, values }) => updateSale(id, values));
  handle("sales:createInvoice", (_e, { values }) => createSaleInvoice(values));
  handle("sales:updateInvoice", (_e, { group, values }) => updateSaleInvoice(group, values));
  handle(
    "sales:setInvoiceStage",
    (_e, { group, stage, force, date, received }) => setInvoiceStage(group, stage, force, date, received)
  );
  handle("sales:deleteInvoice", (_e, { group }) => deleteSaleInvoice(group));
  handle("sales:rejectInvoice", (_e, { group, reason }) => rejectSaleInvoice(group, reason));
  handle(
    "sales:cancelDelivery",
    (_e, { group, reason, freightQty }) => cancelSaleDelivery(group, reason, freightQty)
  );
  handle("sales:unrejectInvoice", (_e, { group }) => unrejectSaleInvoice(group));
  handle(
    "sales:setStatus",
    (_e, { id, status }) => setSaleStatus(id, status)
  );
  handle(
    "sales:setStage",
    (_e, { id, stage, force, date }) => setSaleStage(id, stage, force, date)
  );
  handle("sales:delete", (_e, { id }) => deleteSale(id));
  handle(
    "salesBargains:list",
    (_e, args) => listSalesBargains(args?.from, args?.to, args?.companyIds, args?.forModule)
  );
  handle("salesBargains:returns", (_e, args) => listSalesBargainReturns(args?.companyIds));
  handle(
    "salesBargains:unattributedReturns",
    (_e, args) => listUnattributedReturns(args?.companyIds)
  );
  handle("salesBargains:create", (_e, { values }) => createSalesBargain(values));
  handle(
    "salesBargains:update",
    (_e, { id, values }) => updateSalesBargain(id, values)
  );
  handle("salesBargains:delete", (_e, { id }) => deleteSalesBargain(id));
  handle(
    "salesBargains:adjust",
    (_e, { id, delta, note, date }) => adjustSalesBargainQty(id, delta, note, date)
  );
  handle("gate:list", () => listGateEntries());
  handle("gate:nextNo", (_e, args) => nextGateEntryNo(args?.direction));
  handle("gate:dispatchableSales", () => listDispatchableSales());
  handle("gate:partyCategories", () => partyCategories());
  handle(
    "gate:forRecord",
    (_e, args) => gateEntriesFor(args)
  );
  handle("gate:create", (_e, { values }) => createGateEntry(values));
  handle(
    "gate:update",
    (_e, { id, values }) => updateGateEntry(id, values)
  );
  handle(
    "gate:complete",
    (_e, { id, gross, tare }) => completeGateEntry(id, gross, tare)
  );
  handle(
    "gate:weights",
    (_e, {
      id,
      gross,
      tare,
      awaitingGrossOut,
      dispatchQty,
      invoiceGroup,
      outDate,
      outTime
    }) => saveGateWeights(id, gross, tare, awaitingGrossOut, dispatchQty, invoiceGroup, outDate, outTime)
  );
  handle("gate:skipWeighment", (_e, { id }) => skipGateWeighment(id));
  handle("gate:delete", (_e, { id }) => deleteGateEntry(id));
  handle("gate:reject", (_e, { id, reason }) => rejectGateEntry(id, reason));
  handle("gate:unreject", (_e, { id }) => unrejectGateEntry(id));
  handle("lc:list", () => listLCs());
  handle("treasury:alerts", () => treasuryAlerts());
  handle("treasury:paymentTracker", () => listPaymentTracker());
  handle("treasury:settleLcBill", (_e, { id, date }) => settleLcBill(id, date));
  handle("treasury:reopenLcBill", (_e, { id }) => reopenLcBill(id));
  handle("lc:issuances", (_e, { lcId }) => listLCIssuances(lcId));
  handle("lc:create", (_e, { values }) => createLC(values));
  handle("lc:update", (_e, { id, values }) => updateLC(id, values));
  handle("lc:delete", (_e, { id }) => deleteLC(id));
  handle("lc:issue", (_e, { values }) => issueLC(values));
  handle("lc:deleteIssuance", (_e, { id }) => deleteLCIssuance(id));
  handle("lc:unpreclose", (_e, { id }) => unPrecloseLC(id));
  handle(
    "lc:preclose",
    (_e, {
      id,
      values
    }) => precloseLC(id, values)
  );
  handle(
    "lc:paymentIn",
    (_e, { id, amount, date, selectedKeys }) => postLcPaymentIn(id, amount, date, selectedKeys)
  );
  handle("lc:allRepayments", () => listAllLcRepayments());
  handle("lc:paymentIns", (_e, { lcId }) => listLcPaymentIns(lcId));
  handle("lc:deletePaymentIn", (_e, { id }) => deleteLcPaymentIn(id));
  handle("lc:openTradingInvoices", (_e, { lcId }) => listLcOpenTradingInvoices(lcId));
  handle("lc:repayments", (_e, { lcId }) => listLcRepayments(lcId));
  handle("lc:saveRepayment", (_e, { values }) => saveLcRepayment(values));
  handle("lc:deleteRepayment", (_e, { id }) => deleteLcRepayment(id));
  handle(
    "lc:getLimit",
    (_e, args) => getLcLimit(args?.bankId, args?.from, args?.to)
  );
  handle("lc:bankLimits", () => listBankLcLimits());
  handle("lc:saveLimit", (_e, { values }) => saveLcLimit(values));
  handle("files:pickDocument", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openFile"] });
    return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
  });
  handle("files:openDocument", (_e, { path }) => {
    void shell.openPath(path);
    return { ok: true };
  });
  handle("bankRecon:import", (_e, { values }) => importBankStatement(values));
  handle("bankRecon:imports", () => listBankStatementImports());
  handle("bankRecon:deleteImport", (_e, { id }) => deleteBankStatementImport(id));
  handle("bankRecon:list", (_e, { filter }) => listBankStatementLines(filter));
  handle("bankRecon:suggest", (_e, { lineId }) => suggestBankLineMatch(lineId));
  handle("bankRecon:reconcile", (_e, { lineId, values }) => reconcileBankLine(lineId, values));
  handle("bankRecon:markMisc", (_e, { lineId }) => markBankLineMisc(lineId));
  handle("bankRecon:unreconcile", (_e, { lineId }) => unreconcileBankLine(lineId));
  handle("bankRecon:setSubEntry", (_e, { lineId, values }) => setBankLineSubEntry(lineId, values));
  handle("bd:list", (_e, { filter } = {}) => listBd(filter));
  handle("bd:create", (_e, { values }) => createBd(values));
  handle("bd:update", (_e, { id, values }) => updateBd(id, values));
  handle("bd:delete", (_e, { id }) => deleteBd(id));
  handle(
    "bd:repay",
    (_e, {
      id,
      values
    }) => repayBd(id, values)
  );
  handle("bd:repayments", (_e, { id }) => listBdRepayments(id));
  handle("bd:allRepayments", () => listAllBdRepayments());
  handle("bd:linkedOrders", (_e, { id }) => listBdLinkedOrders(id));
  handle("bd:parties", (_e, { id }) => listBdParties(id));
  handle("bd:allParties", () => listAllBdParties());
  handle("bd:openTradingInvoices", (_e, { id }) => listBdOpenTradingInvoices(id));
  handle("bd:paymentIns", (_e, { id }) => listBdPaymentIns(id));
  handle(
    "bd:paymentIn",
    (_e, { id, amount, date, keys }) => postBdPaymentIn(id, amount, date, keys)
  );
  handle("bd:deletePaymentIn", (_e, { id }) => deleteBdPaymentIn(id));
  handle("bd:deleteRepayment", (_e, { id }) => deleteBdRepayment(id));
  handle("bd:markReceived", (_e, { id, date }) => markBdPaymentReceived(id, date));
  handle("bd:unmarkReceived", (_e, { id }) => unmarkBdPaymentReceived(id));
  handle("bd:reopen", (_e, { id }) => reopenBd(id));
  handle("bd:upfrontInterest", (_e, { id, date }) => postBdUpfrontInterest(id, date));
  handle("bd:kpis", () => bdKpis());
  handle("bd:limits", () => bdLimits());
  handle("bd:setCombinedLimit", (_e, { value }) => setBdCombinedLimit(value));
  handle(
    "access:entityHistory",
    (_e, {
      entity,
      id,
      key: key3,
      detail,
      limit
    }) => entityHistory(entity, { id, key: key3, detail, limit })
  );
  handle("trading:list", (_e, args) => listTradingDeals(args?.forModule));
  handle("trading:create", (_e, { values }) => createTradingDeal(values));
  handle("trading:update", (_e, { id, values }) => updateTradingDeal(id, values));
  handle("trading:delete", (_e, { id }) => deleteTradingDeal(id));
  handle("facility:list", () => listFacilities());
  handle("facility:exposures", (_e, { facilityId }) => listFacilityExposures(facilityId));
  handle(
    "facility:headroom",
    (_e, { facilityId, excludeLcId }) => facilityHeadroom(facilityId, excludeLcId || 0)
  );
  handle("facility:create", (_e, { values }) => createFacility(values));
  handle("facility:update", (_e, { id, values }) => updateFacility(id, values));
  handle("facility:delete", (_e, { id }) => deleteFacility(id));
  handle("facility:saveExposure", (_e, { values }) => saveExposure(values));
  handle("facility:deleteExposure", (_e, { id }) => deleteExposure(id));
}

// src/server/http.ts
var import_node_http = require("node:http");
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var import_node_crypto = require("node:crypto");

// src/server/dbrestore.ts
var import_client = require("@libsql/client");
var import_node_zlib2 = require("node:zlib");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var REQUIRED_TABLES = ["users", "products", "orders", "sales", "app_settings"];
var KEEP_BACKUPS = 3;
function configuredUrl() {
  return String(process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || "");
}
function livePath() {
  const url = configuredUrl();
  if (!url.startsWith("file:")) return null;
  return url.slice("file:".length);
}
function sizeOf(path) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += (0, import_node_fs3.statSync)(path + suffix).size;
    } catch {
    }
  }
  return total;
}
function backupDir(live) {
  const dir = (0, import_node_path3.join)((0, import_node_path3.dirname)(live), "replaced");
  (0, import_node_fs3.mkdirSync)(dir, { recursive: true });
  return dir;
}
function sweepTemp(live) {
  try {
    const dir = (0, import_node_path3.dirname)(live);
    const stem = (0, import_node_path3.basename)(live);
    for (const f of (0, import_node_fs3.readdirSync)(dir)) {
      if (!f.startsWith(`${stem}.uploaded-`) && !f.startsWith(`${stem}.incoming-`)) continue;
      try {
        (0, import_node_fs3.rmSync)((0, import_node_path3.join)(dir, f), { force: true });
      } catch {
      }
    }
  } catch {
  }
}
function stamp2() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
async function countAll(c) {
  const names = await userTables(c);
  if (!names.length) return { tables: 0, rows: 0 };
  const union = names.map((n25) => `SELECT COUNT(*) AS k FROM "${n25}"`).join(" UNION ALL ");
  const res = await c.execute(union);
  let rows = 0;
  for (const r of res.rows) rows += Number(r.k) || 0;
  return { tables: names.length, rows };
}
async function userTables(c) {
  const res = await c.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'`
  );
  return res.rows.map((r) => String(r.name));
}
async function dbStatus() {
  const live = livePath();
  const counted = await countAll(getClient()).catch(() => ({ tables: 0, rows: 0 }));
  if (!live) {
    return { supported: false, path: null, bytes: 0, ...counted, restorePoints: [] };
  }
  const dir = (0, import_node_path3.join)((0, import_node_path3.dirname)(live), "replaced");
  const points = (0, import_node_fs3.existsSync)(dir) ? (0, import_node_fs3.readdirSync)(dir).filter((f) => f.startsWith((0, import_node_path3.basename)(live) + ".")).map((f) => {
    const st = (0, import_node_fs3.statSync)((0, import_node_path3.join)(dir, f));
    return { name: f, bytes: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => a.at < b.at ? 1 : -1) : [];
  return { supported: true, path: live, bytes: sizeOf(live), ...counted, restorePoints: points };
}
var SQLITE_MAGIC = "SQLite format 3\0";
function isSqliteFile(buf) {
  return buf.length > 16 && buf.subarray(0, 16).toString("latin1") === SQLITE_MAGIC;
}
async function sqlFromDbFile(buf, live) {
  const tmp = `${live}.uploaded-${stamp2()}`;
  (0, import_node_fs3.writeFileSync)(tmp, buf);
  let c = null;
  try {
    c = (0, import_client.createClient)({ url: `file:${tmp}` });
    const names = new Set(await userTables(c));
    const missing = REQUIRED_TABLES.filter((t) => !names.has(t));
    if (missing.length) {
      throw new Error(
        `That database has no ${missing.join(", ")} table${missing.length === 1 ? "" : "s"} \u2014 it is not this app's database.`
      );
    }
    const snap = await dumpSql(c);
    if (!snap.rows) throw new Error("That database file is empty \u2014 nothing would be restored.");
    return snap.sql;
  } catch (e) {
    const msg = e.message || "";
    throw new Error(
      /not this app|is empty/.test(msg) ? msg : `That database file could not be read (${msg}). The upload may have been cut short.`
    );
  } finally {
    try {
      c?.close();
    } catch {
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        (0, import_node_fs3.rmSync)(tmp + suffix, { force: true });
      } catch {
      }
    }
  }
}
function readSnapshot(buf) {
  const gz = buf.length > 2 && buf[0] === 31 && buf[1] === 139;
  let text;
  try {
    text = (gz ? (0, import_node_zlib2.gunzipSync)(buf) : buf).toString("utf8");
  } catch {
    throw new Error("That file is not readable \u2014 the download may have been cut short.");
  }
  if (!/CREATE\s+TABLE/i.test(text)) {
    throw new Error("That is not a snapshot. Upload the .sql.gz file the app gives you.");
  }
  if (!/COMMIT\s*;\s*$/i.test(text)) {
    throw new Error("The snapshot is incomplete \u2014 it ends mid-file. Download it again.");
  }
  const missing = REQUIRED_TABLES.filter(
    (t) => !new RegExp(`CREATE\\s+TABLE(\\s+IF\\s+NOT\\s+EXISTS)?\\s+"?${t}"?\\b`, "i").test(text)
  );
  if (missing.length) {
    throw new Error(`The snapshot has no ${missing.join(", ")} table${missing.length === 1 ? "" : "s"} \u2014 it is not this app's database.`);
  }
  if (!/INSERT\s+INTO/i.test(text)) {
    throw new Error("The snapshot holds a schema but no data \u2014 nothing would be restored.");
  }
  return text;
}
function body(sql) {
  const firstCreate = sql.search(/CREATE\s+TABLE/i);
  if (firstCreate < 0) return sql;
  const head = sql.slice(0, firstCreate).replace(/^\s*(PRAGMA\s+foreign_keys\s*=\s*OFF|BEGIN(\s+\w+)?\s+TRANSACTION)\s*;\s*$/gim, "");
  const rest = sql.slice(firstCreate).replace(/\s*COMMIT\s*;\s*$/i, "\n");
  return head + rest;
}
async function applyFilePragmas(c) {
  await c.execute("PRAGMA busy_timeout = 5000").catch(() => {
  });
  await c.execute("PRAGMA journal_mode = WAL").catch(() => {
  });
  await c.execute("PRAGMA synchronous = NORMAL").catch(() => {
  });
  await c.execute("PRAGMA foreign_keys = ON").catch(() => {
  });
}
async function restoreFromDump(buf) {
  const started = Date.now();
  const live = livePath();
  if (live) sweepTemp(live);
  if (!live) {
    throw new Error(
      "This site runs against a cloud database, not a local file, so there is nothing here to replace."
    );
  }
  const sql = isSqliteFile(buf) ? await sqlFromDbFile(buf, live) : readSnapshot(buf);
  const c = getClient();
  const before = await countAll(c).catch(() => ({ tables: 0, rows: 0 }));
  await c.execute("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {
  });
  const keptName = `${(0, import_node_path3.basename)(live)}.${stamp2()}`;
  (0, import_node_fs3.copyFileSync)(live, (0, import_node_path3.join)(backupDir(live), keptName));
  const existing = await c.execute(
    `SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'
      ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END`
  );
  const drops = existing.rows.map((r) => {
    const kind = String(r.type).toUpperCase();
    return kind === "TABLE" || kind === "VIEW" || kind === "INDEX" || kind === "TRIGGER" ? `DROP ${kind} IF EXISTS "${String(r.name)}";` : "";
  }).filter(Boolean).join("\n");
  await c.execute("PRAGMA foreign_keys = OFF").catch(() => {
  });
  try {
    await c.executeMultiple(`BEGIN TRANSACTION;
${drops}
${body(sql)}
COMMIT;`);
  } catch (e) {
    await c.execute("ROLLBACK").catch(() => {
    });
    await c.execute("PRAGMA foreign_keys = ON").catch(() => {
    });
    throw new Error(
      `The snapshot could not be loaded (${e.message}). Nothing was changed \u2014 the database is exactly as it was.`
    );
  }
  await c.execute("PRAGMA foreign_keys = ON").catch(() => {
  });
  await c.execute("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {
  });
  const after = await countAll(c);
  await runStartupTasks();
  try {
    const dir = backupDir(live);
    const olds = (0, import_node_fs3.readdirSync)(dir).filter((f) => f.startsWith((0, import_node_path3.basename)(live) + ".")).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) {
      (0, import_node_fs3.rmSync)((0, import_node_path3.join)(dir, f), { force: true });
    }
  } catch {
  }
  return {
    tables: after.tables,
    rows: after.rows,
    bytes: sizeOf(live),
    replacedBackup: keptName,
    tookMs: Date.now() - started,
    before
  };
}

// src/server/http.ts
var sessions = /* @__PURE__ */ new Map();
var SESSION_TTL_MS = 12 * 60 * 60 * 1e3;
function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) if (v.seen < cutoff) sessions.delete(k);
}
function readCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "";
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`That file is larger than the ${Math.round(limit / 1048576)} MB limit`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function json(res, status, body2, cookie) {
  const payload = JSON.stringify(body2);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    // The API is not cacheable and must never be stored by a proxy.
    "cache-control": "no-store"
  };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(status, headers);
  res.end(payload);
}
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8"
};
function serveStatic(res, root, urlPath) {
  const rel = (0, import_node_path4.normalize)(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  if (rel.split(/[/\\]/).includes("..")) return false;
  const full = (0, import_node_path4.join)(root, rel);
  if (!full.startsWith(root + import_node_path4.sep) && full !== root) return false;
  if (!(0, import_node_fs4.existsSync)(full) || !(0, import_node_fs4.statSync)(full).isFile()) return false;
  const ext = (0, import_node_path4.extname)(full).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    // Vite fingerprints its assets, so they are safe to cache hard; index.html
    // must not be, or a deploy never reaches anyone.
    "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
  });
  (0, import_node_fs4.createReadStream)(full).pipe(res);
  return true;
}
function applySessionEffect(channel, args, result, s) {
  if (channel === "auth:login") {
    const u = result || {};
    if (u && u.id) {
      s.userId = Number(u.id);
      s.username = String(u.username || "");
    }
    return;
  }
  if (channel === "session:setUser") {
    s.userId = args?.id == null ? null : Number(args.id);
    s.username = String(args?.username || "system");
    return;
  }
  if (channel === "company:setActive") {
    const id = Number(args?.id);
    if (Number.isFinite(id) && id > 0) s.companyId = id;
  }
}
function currentSession(req) {
  sweepSessions();
  const sid = readCookie(req, "sid");
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  s.seen = Date.now();
  return s;
}
async function isAdmin(s) {
  if (!s || !s.userId) return false;
  try {
    const r = await getClient().execute({
      sql: "SELECT role FROM users WHERE id = ? AND active = 1",
      args: [s.userId]
    });
    return String(r.rows[0]?.role || "") === "admin";
  } catch {
    return false;
  }
}
var RESTORE_LIMIT = 256 * 1024 * 1024;
function startHttpServer({ port, webRoot }) {
  const server = (0, import_node_http.createServer)(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    if (path === "/api/health") {
      return json(res, 200, { ok: true, at: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (path === "/brand-icon") {
      try {
        const fn = handlers.get("settings:get");
        const ctx = { userId: null, username: "", companyId: 0, ip: clientIp(req) };
        const raw = fn ? await runInRequestContext(ctx, () => Promise.resolve(fn({}, { key: "brand_logo" }))) : null;
        const url2 = String(raw || "");
        const m = /^data:([^;,]+);base64,(.+)$/i.exec(url2);
        if (m) {
          const body2 = Buffer.from(m[2], "base64");
          res.writeHead(200, {
            "content-type": m[1],
            "content-length": body2.length,
            // Short: a logo changes rarely, but when it does the installed
            // app should pick it up without waiting a day.
            "cache-control": "public, max-age=300"
          });
          return res.end(body2);
        }
      } catch {
      }
      if (serveStatic(res, webRoot, "brand-default.png")) return;
      return json(res, 404, { error: "No brand icon set" });
    }
    if (path === "/api/db/info") {
      const s = currentSession(req);
      if (!await isAdmin(s)) return json(res, 403, { error: "Administrators only" });
      try {
        return json(res, 200, { ok: true, result: await dbStatus() });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    if (path === "/api/db/snapshot") {
      const s = currentSession(req);
      if (!await isAdmin(s)) return json(res, 403, { error: "Administrators only" });
      try {
        const fn = handlers.get("db:snapshot");
        if (!fn) throw new Error("This build has no snapshot channel");
        const ctx = {
          userId: s.userId,
          username: s.username,
          companyId: s.companyId,
          ip: clientIp(req)
        };
        const snap = await runInRequestContext(
          ctx,
          () => Promise.resolve(fn({}, {}))
        );
        const body2 = Buffer.from(snap.gz, "base64");
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": body2.length,
          "content-disposition": `attachment; filename="${snap.fileName}"`,
          "cache-control": "no-store"
        });
        return res.end(body2);
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    if (path === "/api/db/restore") {
      if (req.method !== "POST") return json(res, 405, { error: "Use POST" });
      const s = currentSession(req);
      if (!await isAdmin(s)) return json(res, 403, { error: "Administrators only" });
      try {
        const buf = await readBinary(req, RESTORE_LIMIT);
        if (!buf.length) return json(res, 200, { ok: false, error: "No file was uploaded" });
        const report = await restoreFromDump(buf);
        await logEvent(
          s.userId,
          s.username,
          clientIp(req),
          "Restored the database",
          `${report.rows.toLocaleString()} rows across ${report.tables} tables \xB7 previous copy kept as ${report.replacedBackup}`,
          s.companyId,
          "Database",
          null,
          null
        ).catch(() => {
        });
        console.log(
          `[web] database restored by ${s.username}: ${report.rows} rows, ${report.tables} tables, ${report.tookMs} ms`
        );
        return json(res, 200, { ok: true, result: report });
      } catch (e) {
        console.error("[web] restore failed:", e);
        return json(res, 200, { ok: false, error: e.message || "Restore failed" });
      }
    }
    if (path === "/api/invoke") {
      if (req.method !== "POST") return json(res, 405, { error: "Use POST" });
      let payload;
      try {
        payload = JSON.parse(await readBody(req) || "{}");
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      const channel = String(payload?.channel || "");
      const args = payload?.args ?? {};
      const fn = handlers.get(channel);
      if (!fn) return json(res, 404, { error: `Unknown channel: ${channel}` });
      sweepSessions();
      let sid = readCookie(req, "sid");
      let cookie;
      if (!sid || !sessions.has(sid)) {
        sid = (0, import_node_crypto.randomBytes)(24).toString("hex");
        sessions.set(sid, { userId: null, username: "system", companyId: 1, seen: Date.now() });
        cookie = `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1e3}`;
      }
      const s = sessions.get(sid);
      s.seen = Date.now();
      const ctx = {
        userId: s.userId,
        username: s.username,
        companyId: s.companyId,
        ip: clientIp(req)
      };
      try {
        const result = await runInRequestContext(ctx, () => Promise.resolve(fn({}, args)));
        s.userId = ctx.userId;
        s.username = ctx.username;
        s.companyId = ctx.companyId;
        applySessionEffect(channel, args, result, s);
        return json(res, 200, { ok: true, result: result ?? null }, cookie);
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message || "Request failed" }, cookie);
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "Method not allowed" });
    }
    if (serveStatic(res, webRoot, path === "/" ? "index.html" : path)) return;
    if (serveStatic(res, webRoot, "index.html")) return;
    return json(res, 404, { error: "Not built yet \u2014 run npm run web:build" });
  });
  server.listen(port, () => {
    console.log(`[web] listening on http://localhost:${port}`);
    console.log(`[web] serving ${webRoot}`);
    console.log(`[web] ${handlers.size} channels registered`);
  });
}

// src/server/index.ts
async function main() {
  const port = Number(process.env.PORT) || 3e3;
  const webRoot = process.env.WEB_ROOT || (0, import_node_path5.join)(process.cwd(), "out", "web");
  console.log("[web] connecting to the database\u2026");
  await runStartupTasks();
  console.log("[web] schema ready");
  const live = livePath();
  if (live) {
    await applyFilePragmas(getClient());
    console.log(`[web] local SQLite at ${live}: WAL, busy_timeout 5s, foreign keys on`);
  }
  registerIpc();
  startHttpServer({ port, webRoot });
}
main().catch((e) => {
  console.error("[web] failed to start:", e);
  process.exit(1);
});
