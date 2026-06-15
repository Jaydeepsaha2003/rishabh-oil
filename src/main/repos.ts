import type { InValue } from '@libsql/client'
import { getClient } from './db'

// Whitelist of writable columns per table. Table names and column names only
// ever come from this map (never from the renderer), so the dynamic SQL below
// is safe — all *values* are passed as bound parameters.
const TABLES: Record<string, string[]> = {
  oil_types: ['code', 'name', 'active'],
  suppliers: [
    'name',
    'company_type',
    'gstin',
    'state',
    'gst_pct',
    'tds_pct',
    'credit_period_days',
    'adds_interest',
    'interest_pct',
    'interest_days',
    'active'
  ],
  transporters: ['name', 'contact', 'default_rate_per_ton', 'active'],
  sources: ['name', 'transit_days', 'active']
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

export async function list(table: string): Promise<Row[]> {
  assertTable(table)
  const res = await getClient().execute(`SELECT * FROM ${table} ORDER BY id DESC`)
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
