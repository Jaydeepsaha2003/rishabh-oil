import { getClient } from './db'
import { voucherSeriesOf } from './voucherNumbers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// THE DESK'S OWN VOUCHER TYPES, under the basic ones: PURCHASE OTHERS and
// PURCHASE OIL under Purchase, SALARY under Payment, and as many more as the
// desk wants. A voucher keeps its basic type — so it keeps that type's number
// series (PUR/***), its cash and bank rules and every register that reads it —
// and carries its own type as a label (journal_entries.vch_subtype). Any
// voucher can be given one, including those the Purchases and Sales pages post.
// ---------------------------------------------------------------------------

export const BASE_TYPES = ['CONTRA', 'PAYMENT', 'RECEIPT', 'JOURNAL', 'SALE', 'PURCHASE', 'DEBIT NOTE', 'CREDIT NOTE'] as const

let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS voucher_subtypes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_type TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(base_type, name)
  )`)
  ready = true
}

const clean = (s: unknown): string => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase()

/** Every type, with how many vouchers carry it. */
export async function listVoucherSubtypes(): Promise<Row[]> {
  await ensure()
  const r = await getClient().execute(`SELECT s.id, s.base_type, s.name,
      (SELECT COUNT(*) FROM journal_entries je WHERE je.vch_subtype = s.name) AS used
    FROM voucher_subtypes s ORDER BY s.base_type, s.name`)
  return (r.rows as unknown as Row[]).map((x) => ({ id: Number(x.id), base_type: String(x.base_type), name: String(x.name), used: Number(x.used || 0) }))
}

export async function createVoucherSubtype(v: { base_type: string; name: string }): Promise<{ id: number }> {
  await ensure()
  const base = clean(v.base_type)
  const name = clean(v.name)
  if (!(BASE_TYPES as readonly string[]).includes(base)) throw new Error('Pick the basic type it comes under')
  if (!name) throw new Error('Give the voucher type a name')
  if ((BASE_TYPES as readonly string[]).includes(name)) throw new Error(`${name} is a basic type already`)
  const taken = await getClient().execute({ sql: 'SELECT base_type FROM voucher_subtypes WHERE name = ?', args: [name] })
  if (taken.rows.length) throw new Error(`${name} already exists (under ${String(taken.rows[0].base_type)})`)
  const r = await getClient().execute({ sql: 'INSERT INTO voucher_subtypes (base_type, name) VALUES (?, ?)', args: [base, name] })
  return { id: Number(r.lastInsertRowid) }
}

/** Rename a type — the vouchers carrying it follow. */
export async function renameVoucherSubtype(v: { id: number; name: string }): Promise<{ id: number }> {
  await ensure()
  const c = getClient()
  const cur = (await c.execute({ sql: 'SELECT name FROM voucher_subtypes WHERE id = ?', args: [Number(v.id)] })).rows[0]
  if (!cur) throw new Error('That voucher type no longer exists')
  const name = clean(v.name)
  if (!name) throw new Error('Give the voucher type a name')
  if (name === String(cur.name)) return { id: Number(v.id) }
  const taken = await c.execute({ sql: 'SELECT id FROM voucher_subtypes WHERE name = ? AND id <> ?', args: [name, Number(v.id)] })
  if (taken.rows.length) throw new Error(`${name} already exists`)
  await c.execute({ sql: 'UPDATE voucher_subtypes SET name = ? WHERE id = ?', args: [name, Number(v.id)] })
  await c.execute({ sql: 'UPDATE journal_entries SET vch_subtype = ? WHERE vch_subtype = ?', args: [name, String(cur.name)] })
  return { id: Number(v.id) }
}

/** Remove a type nothing carries any more. */
export async function deleteVoucherSubtype(id: number): Promise<{ id: number }> {
  await ensure()
  const c = getClient()
  const cur = (await c.execute({ sql: 'SELECT name FROM voucher_subtypes WHERE id = ?', args: [Number(id)] })).rows[0]
  if (!cur) return { id: Number(id) }
  const used = Number((await c.execute({ sql: 'SELECT COUNT(*) AS k FROM journal_entries WHERE vch_subtype = ?', args: [String(cur.name)] })).rows[0]?.k || 0)
  if (used) throw new Error(`${used} voucher${used === 1 ? '' : 's'} carry ${String(cur.name)} — move them to another type first`)
  await c.execute({ sql: 'DELETE FROM voucher_subtypes WHERE id = ?', args: [Number(id)] })
  return { id: Number(id) }
}

/** The type name to store for a voucher of `vchType`, checked to be in its series; null clears it. */
export async function checkedSubtype(vchType: string, subtype: unknown): Promise<string | null> {
  const name = clean(subtype)
  if (!name) return null
  await ensure()
  const r = (await getClient().execute({ sql: 'SELECT base_type FROM voucher_subtypes WHERE name = ?', args: [name] })).rows[0]
  if (!r) throw new Error(`There is no voucher type called ${name}`)
  if (voucherSeriesOf(String(r.base_type)) !== voucherSeriesOf(vchType)) {
    throw new Error(`${name} is a ${String(r.base_type).toLowerCase()} type — it cannot be given to a ${String(vchType).toLowerCase()} voucher`)
  }
  return name
}

/** Give a posted voucher its type (or clear it). Only the label changes — never the number or the lines. */
export async function setVoucherSubtype(v: { entry_id: number; subtype: string | null }): Promise<{ id: number; subtype: string | null }> {
  const c = getClient()
  const e = (await c.execute({ sql: 'SELECT vch_type FROM journal_entries WHERE id = ?', args: [Number(v.entry_id)] })).rows[0]
  if (!e) throw new Error('That voucher no longer exists')
  const name = await checkedSubtype(String(e.vch_type), v.subtype)
  await c.execute({ sql: 'UPDATE journal_entries SET vch_subtype = ? WHERE id = ?', args: [name, Number(v.entry_id)] })
  return { id: Number(v.entry_id), subtype: name }
}
