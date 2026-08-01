import type { InValue } from '@libsql/client'
import { getClient } from './db'

// Whitelist of writable columns per table. Table names and column names only
// ever come from this map (never from the renderer), so the dynamic SQL below
// is safe — all *values* are passed as bound parameters.
const TABLES: Record<string, string[]> = {
  categories: ['name', 'applies_to', 'note', 'active'],
  oil_types: ['code', 'name', 'active'],
  products: ['code', 'name', 'category', 'material_type', 'active'],
  suppliers: [
    'name',
    'supplier_type',
    'company_type',
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
  packagings: ['name', 'box_label', 'pouch_label', 'pouches_per_box', 'unit_size', 'unit_uom', 'base_per_pouch', 'base_uom', 'product_id', 'active']
}

type Row = Record<string, unknown>

function assertTable(table: string): string[] {
  const cols = TABLES[table]
  if (!cols) throw new Error(`Unknown table: ${table}`)
  return cols
}

// Coerce JS values into something libsql accepts as a bound parameter.
function toArg(v: unknown): InValue {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === undefined) return null
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
  if (excludeId) {
    const cur = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [excludeId] })
    const before = String(cur.rows[0]?.name ?? '').trim().toLowerCase()
    if (before === name.toLowerCase()) return // not a rename — leave it alone
  }
  const hit = await c.execute({
    sql: `SELECT id, name FROM ${table} WHERE TRIM(LOWER(name)) = ?${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
    args: excludeId ? [name.toLowerCase(), excludeId] : [name.toLowerCase()]
  })
  if (hit.rows.length) {
    throw new Error(`"${String(hit.rows[0].name)}" already exists — give this one a different name`)
  }
}

export async function list(table: string): Promise<Row[]> {
  assertTable(table)
  // Every master table has a `name` and feeds dropdowns across the app —
  // always list A→Z.
  const res = await getClient().execute(
    `SELECT * FROM ${table} ORDER BY name COLLATE NOCASE ASC`
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
  await assertUniqueName(table, values)
  const keys = pickKeys(values, allowed)
  if (keys.length === 0) throw new Error('No valid columns to insert')
  const placeholders = keys.map(() => '?').join(', ')
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    args: keys.map((k) => toArg(values[k]))
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
    args: [...keys.map((k) => toArg(values[k])), id]
  })
  return { id }
}

export async function remove(table: string, id: number): Promise<{ id: number }> {
  assertTable(table)
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
