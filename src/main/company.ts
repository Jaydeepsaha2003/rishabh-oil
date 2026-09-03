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
