import type { InValue } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// Whitelist of writable columns per table. Table names and column names only
// ever come from this map (never from the renderer), so the dynamic SQL below
// is safe — all *values* are passed as bound parameters.
const TABLES: Record<string, string[]> = {
  banks: ['name', 'branch', 'account_no', 'ifsc', 'note', 'active', 'company_id'],
  categories: ['name', 'applies_to', 'note', 'active'],
  oil_types: ['code', 'name', 'active'],
  products: ['code', 'name', 'category', 'material_type', 'active'],
  suppliers: [
    'name',
    'supplier_type',
    'company_type',
    'business_type',
    'gstin',
    'state',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_pct_above',
    'tds_above_only',
    'credit_period_days',
    'adds_interest',
    'interest_pct',
    'interest_days',
    'opening_purchase_amount',
    'opening_purchase_date',
    'skip_tanker_stages',
    'active'
  ],
  transporters: [
    'name',
    'company_type',
    'contact',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_pct_above',
    'default_rate_per_ton',
    'reverse_charge',
    'active'
  ],
  customers: [
    'name',
    'category',
    'company_type',
    'business_type',
    'gstin',
    'state',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_above_only',
    'adds_interest',
    'interest_pct',
    'interest_days',
    'credit_period_days',
    'active'
  ],
  sources: ['name', 'transit_days', 'active'],
  uoms: ['name', 'active'],
  brokers: ['name', 'contact_person', 'phone', 'brokerage_pct', 'address', 'note', 'active'],
  companies: ['name', 'active'],
  packagings: ['name', 'box_label', 'pouch_label', 'pouches_per_box', 'unit_size', 'unit_uom', 'base_per_pouch', 'base_uom', 'product_id', 'product_label', 'active']
}

type Row = Record<string, unknown>

// Most masters (suppliers, products, categories...) are shared across every
// company's books. Banks are the odd one out — a bank ACCOUNT belongs to one
// company, not to the business in general — so this is the one table that
// gets scoped like the transactional tables (orders, bargains) do, instead of
// sitting in the generic shared-master pool with everything else here.
const COMPANY_SCOPED_TABLES = new Set(['banks'])

function assertTable(table: string): string[] {
  const cols = TABLES[table]
  if (!cols) throw new Error(`Unknown table: ${table}`)
  return cols
}

// Coerce JS values into something libsql accepts as a bound parameter.
// An id column left blank in a form arrives as '' — store it as NULL, since
// "no link" is checked with IS NULL everywhere and '' would match neither
// that nor a real id.
function toArg(v: unknown, key?: string): InValue {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === undefined) return null
  if (v === '' && key?.endsWith('_id')) return null
  return v as InValue
}

function pickKeys(values: Row, allowed: string[]): string[] {
  return Object.keys(values).filter((k) => allowed.includes(k))
}

// Two masters with the same name are indistinguishable in every dropdown and
// split a party's history in two, so a duplicate is refused at the write path
// — the UI warns, this makes it impossible.
//
// A row that is ALREADY a duplicate can still be edited (that is how it gets
// fixed); only creating a clash, or renaming into one, is blocked.
async function assertUniqueName(table: string, values: Row, excludeId?: number): Promise<void> {
  if (!('name' in values)) return
  const name = String(values.name ?? '').trim()
  if (!name) return
  const c = getClient()
  const scoped = COMPANY_SCOPED_TABLES.has(table)
  // Whichever company the row is actually going into — the form's own
  // picker, not necessarily the one currently active in the sidebar.
  const targetCompany = Number(values.company_id) || getActiveCompanyId()
  const scopeSql = scoped ? ' AND company_id = ?' : ''
  const scopeArg = scoped ? [targetCompany] : []
  if (excludeId) {
    const cur = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [excludeId] })
    const before = String(cur.rows[0]?.name ?? '').trim().toLowerCase()
    if (before === name.toLowerCase()) return // not a rename — leave it alone
  }
  const hit = await c.execute({
    sql: `SELECT id, name FROM ${table} WHERE TRIM(LOWER(name)) = ?${scopeSql}${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
    args: [name.toLowerCase(), ...scopeArg, ...(excludeId ? [excludeId] : [])]
  })
  if (hit.rows.length) {
    throw new Error(`"${String(hit.rows[0].name)}" already exists — give this one a different name`)
  }
}

export async function list(table: string): Promise<Row[]> {
  assertTable(table)
  const scoped = COMPANY_SCOPED_TABLES.has(table)
  // Every master table has a `name` and feeds dropdowns across the app —
  // always list A→Z. Company-scoped tables only ever show the active
  // company's own rows (a bank with no company set yet — there isn't a way
  // to create one, but one could exist from before this was added — simply
  // won't appear until it's given one).
  const res = await getClient().execute(
    scoped
      ? { sql: `SELECT * FROM ${table} WHERE company_id = ? ORDER BY name COLLATE NOCASE ASC`, args: [getActiveCompanyId()] }
      : `SELECT * FROM ${table} ORDER BY name COLLATE NOCASE ASC`
  )
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

export async function get(table: string, id: number): Promise<Row | null> {
  assertTable(table)
  const res = await getClient().execute({
    sql: `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
    args: [id]
  })
  if (res.rows.length === 0) return null
  const r = res.rows[0] as unknown as Row
  const o: Row = {}
  for (const col of res.columns) o[col] = r[col]
  return o
}

export async function create(table: string, values: Row): Promise<{ id: number }> {
  const allowed = assertTable(table)
  // The form carries its own company picker — respect whichever company was
  // actually chosen there, only falling back to the active one if somehow
  // nothing was picked at all.
  if (COMPANY_SCOPED_TABLES.has(table) && !values.company_id) {
    values = { ...values, company_id: getActiveCompanyId() }
  }
  await assertUniqueName(table, values)
  const keys = pickKeys(values, allowed)
  if (keys.length === 0) throw new Error('No valid columns to insert')
  const placeholders = keys.map(() => '?').join(', ')
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    args: keys.map((k) => toArg(values[k], k))
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function update(table: string, id: number, values: Row): Promise<{ id: number }> {
  const allowed = assertTable(table)
  await assertUniqueName(table, values, id)
  const keys = pickKeys(values, allowed)
  if (keys.length === 0) return { id }
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  await getClient().execute({
    sql: `UPDATE ${table} SET ${setClause} WHERE id = ?`,
    args: [...keys.map((k) => toArg(values[k], k)), id]
  })
  return { id }
}

// What points at each master. Deleting a row the books still reference throws
// a bare "FOREIGN KEY constraint failed" from SQLite, which tells the person at
// the screen nothing — so the references are counted first and named.
const DEPENDENTS: Record<string, { table: string; column: string; label: string }[]> = {
  banks: [
    { table: 'letters_of_credit', column: 'our_bank_id', label: 'LC' },
    { table: 'bank_lc_limits', column: 'bank_id', label: 'sanctioned limit' }
  ],
  suppliers: [
    { table: 'bargains', column: 'supplier_id', label: 'purchase bargain' },
    { table: 'orders', column: 'supplier_id', label: 'purchase' },
    { table: 'purchase_tankers', column: 'supplier_id', label: 'tanker' },
    { table: 'consignment_stock', column: 'supplier_id', label: 'consignment lot' },
    { table: 'supplier_ledger', column: 'supplier_id', label: 'ledger entry' },
    { table: 'gate_entries', column: 'supplier_id', label: 'gate entry' }
  ],
  customers: [
    { table: 'sales', column: 'customer_id', label: 'sale' },
    { table: 'sales_bargains', column: 'customer_id', label: 'sales bargain' },
    { table: 'customer_ledger', column: 'customer_id', label: 'ledger entry' },
    { table: 'gate_entries', column: 'customer_id', label: 'gate entry' },
    { table: 'packaging_parties', column: 'customer_id', label: 'packed-SKU link' }
  ],
  products: [
    { table: 'sales', column: 'product_id', label: 'sale' },
    { table: 'sales_bargains', column: 'product_id', label: 'sales bargain' },
    { table: 'orders', column: 'oil_type_id', label: 'purchase' },
    { table: 'production', column: 'product_id', label: 'production run' },
    { table: 'production_items', column: 'product_id', label: 'production input' },
    { table: 'formulation_items', column: 'product_id', label: 'formulation line' },
    { table: 'consignment_stock', column: 'product_id', label: 'consignment lot' },
    { table: 'stock_counts', column: 'product_id', label: 'day-close count' },
    { table: 'stock_transfers', column: 'product_id', label: 'stock transfer' },
    { table: 'packagings', column: 'product_id', label: 'packed SKU' }
  ],
  transporters: [
    { table: 'purchase_tankers', column: 'transporter_id', label: 'tanker' },
    { table: 'orders', column: 'transporter_id', label: 'purchase' },
    { table: 'sales', column: 'transporter_id', label: 'sale' },
    { table: 'transporter_ledger', column: 'transporter_id', label: 'ledger entry' }
  ],
  sources: [{ table: 'bargains', column: 'source_id', label: 'purchase bargain' }],
  brokers: [{ table: 'bargains', column: 'broker_id', label: 'purchase bargain' }],
  packagings: [
    { table: 'sales', column: 'packaging_id', label: 'sale' },
    { table: 'sales_bargains', column: 'packaging_id', label: 'sales bargain' },
    { table: 'sales_bargain_sku_rates', column: 'packaging_id', label: 'rate-card line' },
    { table: 'packaging_parties', column: 'packaging_id', label: 'party link' }
  ],
  oil_types: [
    { table: 'bargains', column: 'oil_type_id', label: 'purchase bargain' },
    { table: 'purchase_tankers', column: 'oil_type_id', label: 'tanker' }
  ]
}

async function assertNotInUse(table: string, id: number): Promise<void> {
  const deps = DEPENDENTS[table]
  if (!deps) return
  const c = getClient()
  const held: string[] = []
  for (const d of deps) {
    const r = await c
      .execute({ sql: `SELECT COUNT(*) AS n FROM ${d.table} WHERE ${d.column} = ?`, args: [id] })
      .catch(() => null) // a table this build does not have is simply skipped
    const n = r ? Number(r.rows[0].n) : 0
    if (n > 0) held.push(`${n} ${d.label}${n === 1 ? '' : 's'}`)
  }
  if (!held.length) return
  const who = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [id] })
  const name = String(who.rows[0]?.name ?? 'This record')
  throw new Error(
    `"${name}" is still used by ${held.join(', ')} — deleting it would orphan them. ` +
      'Switch it off with the Active toggle instead, so it stops being offered but its history stays.'
  )
}

export async function remove(table: string, id: number): Promise<{ id: number }> {
  assertTable(table)
  await assertNotInUse(table, id)
  await getClient().execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] })
  return { id }
}

// --- app_settings (simple key/value) ---

export async function getSetting(key: string): Promise<string | null> {
  const res = await getClient().execute({
    sql: 'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
    args: [key]
  })
  return res.rows.length ? (res.rows[0].value as string) : null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getClient().execute({
    sql: 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value]
  })
}

export async function allSettings(): Promise<Record<string, string>> {
  const res = await getClient().execute('SELECT key, value FROM app_settings')
  const out: Record<string, string> = {}
  for (const r of res.rows) out[r.key as string] = r.value as string
  return out
}
