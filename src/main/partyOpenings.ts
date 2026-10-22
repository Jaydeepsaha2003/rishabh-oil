import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// A PARTY'S BILLING BEFORE THESE BOOKS, PER COMPANY.
//
// A supplier's "Purchase bill amount (as on)" seeds the year's running total
// its TDS slab is read from. Suppliers are one list for every company, so the
// figure was one too — KR FINMARK's purchases from Deepchand or Ashok Shop
// were slabbed on what KR FOODS had bought from them. Each company now keeps
// its own figure: the masters' form reads and writes the one for the company
// open, and the slab reads the purchase's own company's.
//
// The old column on suppliers is left as it was. Its figure was copied, once,
// to every company, so nothing anyone has saved moves until a company's own
// figure is corrected. Customers get the same, for the TDS a customer deducts.
export type PartyKind = 'supplier' | 'customer'

let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS party_openings (
    kind TEXT NOT NULL,
    party_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    as_on TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, party_id, company_id)
  )`)
  const flag = await c.execute("SELECT value FROM app_settings WHERE key = 'party_openings_v1'")
  if (!flag.rows.length) {
    await c.execute(`INSERT OR IGNORE INTO party_openings (kind, party_id, company_id, amount, as_on)
      SELECT 'supplier', s.id, co.id, s.opening_purchase_amount, s.opening_purchase_date
        FROM suppliers s CROSS JOIN companies co
       WHERE COALESCE(s.opening_purchase_amount, 0) <> 0 OR COALESCE(s.opening_purchase_date, '') <> ''`)
    await c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('party_openings_v1', '1')")
  }
  ready = true
}

/** One company's figures for these parties: party_id → { amount, as_on }. */
export async function partyOpenings(kind: PartyKind, companyId: number, partyIds?: number[]): Promise<Map<number, { amount: number; as_on: string }>> {
  await ensure()
  const ids = (partyIds || []).map(n).filter(Boolean)
  const res = await getClient().execute({
    sql: `SELECT party_id, amount, as_on FROM party_openings WHERE kind = ? AND company_id = ?${
      ids.length ? ` AND party_id IN (${ids.map(() => '?').join(',')})` : ''
    }`,
    args: [kind, n(companyId), ...ids]
  })
  const out = new Map<number, { amount: number; as_on: string }>()
  for (const r of res.rows as unknown as Row[]) out.set(n(r.party_id), { amount: n(r.amount), as_on: String(r.as_on || '') })
  return out
}

/** What these parties had been billed before the books, in this company, if the figure falls in the year start..end. */
export async function partyOpeningInYear(kind: PartyKind, companyId: number, partyIds: number[], start: string, end: string): Promise<number> {
  const m = await partyOpenings(kind, companyId, partyIds)
  let t = 0
  for (const v of m.values()) if (v.as_on && v.as_on >= start && v.as_on <= end) t += v.amount
  return t
}

export async function setPartyOpening(kind: PartyKind, partyId: number, companyId: number, amount: unknown, asOn: unknown): Promise<void> {
  await ensure()
  await getClient().execute({
    sql: `INSERT INTO party_openings (kind, party_id, company_id, amount, as_on, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(kind, party_id, company_id) DO UPDATE SET amount = excluded.amount, as_on = excluded.as_on, updated_at = excluded.updated_at`,
    args: [kind, n(partyId), n(companyId), n(amount), asOn ? String(asOn).slice(0, 10) : null]
  })
}

// The masters' form shows one pair of fields; these are the names it uses.
export const OPENING_FIELDS: Record<'suppliers' | 'customers', { kind: PartyKind; amount: string; date: string }> = {
  suppliers: { kind: 'supplier', amount: 'opening_purchase_amount', date: 'opening_purchase_date' },
  customers: { kind: 'customer', amount: 'opening_sale_amount', date: 'opening_sale_date' }
}

/** The masters list, with the open company's own figure in the form's fields. */
export async function overlayOpenings(table: string, rows: Row[]): Promise<Row[]> {
  const f = OPENING_FIELDS[table as 'suppliers' | 'customers']
  if (!f) return rows
  const m = await partyOpenings(f.kind, getActiveCompanyId())
  return rows.map((r) => {
    const v = m.get(n(r.id))
    return { ...r, [f.amount]: v ? v.amount : 0, [f.date]: v ? v.as_on || null : null }
  })
}
