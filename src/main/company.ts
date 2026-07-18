import type { ResultSet } from '@libsql/client'
import { getClient } from './db'

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
let activeCompanyId = 1

export function getActiveCompanyId(): number {
  return activeCompanyId
}

export function setActiveCompany(id: number): { id: number } {
  const v = Number(id)
  activeCompanyId = Number.isFinite(v) && v > 0 ? v : 1
  return { id: activeCompanyId }
}

export async function listCompanies(): Promise<Row[]> {
  const res = await getClient().execute('SELECT * FROM companies ORDER BY name COLLATE NOCASE ASC')
  return toPlain(res)
}
