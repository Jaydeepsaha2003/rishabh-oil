import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { currentRequestContext } from './requestContext'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// The active company for THIS app instance. The renderer sets it at startup
// (from localStorage) and on every switch; all scoped queries read it.
// Which company's books are being written. Per-process on the desktop, and
// per-REQUEST under the web server — see requestContext: a shared module
// variable there would let one person's company switch redirect everybody
// else's writes into the wrong books.
let activeCompanyId = 1

export function getActiveCompanyId(): number {
  const ctx = currentRequestContext()
  if (ctx) return ctx.companyId
  return activeCompanyId
}

export function setActiveCompany(id: number): { id: number } {
  const v = Number(id)
  const next = Number.isFinite(v) && v > 0 ? v : 1
  const ctx = currentRequestContext()
  if (ctx) {
    ctx.companyId = next
    return { id: next }
  }
  activeCompanyId = next
  return { id: activeCompanyId }
}

export async function listCompanies(): Promise<Row[]> {
  const res = await getClient().execute('SELECT * FROM companies ORDER BY name COLLATE NOCASE ASC')
  return toPlain(res)
}

// ------------------------------------------------------------------ factories
// A factory is a physical site. Stock and production belong to it; purchases,
// sales and every ledger stay with the company that booked them.
//
// The bridge between the two is this: a factory resolves to the companies
// attached to it, and every stock query already filters by company_id IN (...).
// So nothing downstream needs to learn a new concept — it is handed a longer
// list of companies than before.

export async function listFactories(): Promise<Row[]> {
  const res = await getClient().execute(
    `SELECT f.*,
            (SELECT COUNT(*) FROM companies c WHERE c.factory_id = f.id) AS company_count
       FROM factories f
      ORDER BY f.name COLLATE NOCASE ASC`
  )
  return toPlain(res)
}

export async function saveFactory(v: Row): Promise<{ id: number }> {
  const name = String(v?.name ?? '').trim()
  if (!name) throw new Error('Factory name is required')
  const location = String(v?.location ?? '').trim() || null
  const active = v?.active === undefined ? 1 : v.active ? 1 : 0
  const id = Number(v?.id || 0)
  if (id > 0) {
    await getClient().execute({
      sql: 'UPDATE factories SET name = ?, location = ?, active = ? WHERE id = ?',
      args: [name, location, active, id]
    })
    return { id }
  }
  const res = await getClient().execute({
    sql: 'INSERT INTO factories (name, location, active) VALUES (?, ?, ?)',
    args: [name, location, active]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Which companies' rows make up this factory's stock. Falls back to the active
// company's own factory when none is named, so a caller that knows nothing
// about factories still gets the right site rather than the whole group.
export async function companiesOfFactory(factoryId?: number): Promise<number[]> {
  const c = getClient()
  let fid = Number(factoryId || 0)
  if (!fid) {
    const own = await c.execute({
      sql: 'SELECT factory_id FROM companies WHERE id = ?',
      args: [getActiveCompanyId()]
    })
    fid = Number(own.rows[0]?.factory_id || 0)
  }
  // No factory assigned anywhere yet — behave exactly as before the factories
  // existed, so an un-migrated database is never shown somebody else's stock.
  if (!fid) return [getActiveCompanyId()]
  const res = await c.execute({
    sql: 'SELECT id FROM companies WHERE factory_id = ? ORDER BY id',
    args: [fid]
  })
  const ids = res.rows.map((r) => Number((r as unknown as Row).id)).filter((x) => x > 0)
  return ids.length ? ids : [getActiveCompanyId()]
}

// The factory the active company belongs to, for a header or a picker default.
export async function activeFactory(): Promise<Row | null> {
  const res = await getClient().execute({
    sql: `SELECT f.* FROM factories f
            JOIN companies c ON c.factory_id = f.id
           WHERE c.id = ?`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)[0] || null
}

// The factory a set of companies belongs to — for the tables that are keyed to
// the site rather than the books (opening stock, and anything that follows it).
// Returns 0 when nothing is assigned, which every caller reads as "behave the
// way this did before factories existed".
export async function factoryOfCompanies(companyIds: number[]): Promise<number> {
  const ids = (companyIds || []).map(Number).filter((x) => x > 0)
  if (!ids.length) ids.push(getActiveCompanyId())
  const res = await getClient().execute({
    sql: `SELECT DISTINCT factory_id FROM companies
           WHERE id IN (${ids.map(() => '?').join(', ')}) AND factory_id IS NOT NULL`,
    args: ids
  })
  // Companies spanning two sites have no single opening to bring forward, so
  // the caller falls back rather than picking one of them arbitrarily.
  if (res.rows.length !== 1) return 0
  return Number((res.rows[0] as unknown as Row).factory_id || 0)
}

// Whether a company selection covers every company at a factory. The opening
// stock is the site's, so it is only carried into a view that shows the site.
export async function coversWholeFactory(
  factoryId: number,
  companyIds: number[]
): Promise<boolean> {
  if (!factoryId) return false
  const all = await getClient().execute({
    sql: 'SELECT id FROM companies WHERE factory_id = ?',
    args: [factoryId]
  })
  const have = new Set((companyIds || []).map(Number))
  return all.rows.every((r) => have.has(Number((r as unknown as Row).id)))
}
