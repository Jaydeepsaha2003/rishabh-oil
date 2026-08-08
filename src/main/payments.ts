import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// --- bill discounting (read-only here — managed from Treasury) ---

export async function listBillDiscounts(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT b.*, s.name AS supplier_name
    FROM bill_discounts b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.company_id = ?
    ORDER BY b.id DESC
  `
  })
  return toPlain(res)
}
