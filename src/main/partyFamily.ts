import { getClient } from './db'

/**
 * The main party a supplier belongs to — itself when it is a main party
 * (DIL EXIM), its main when it is a sub-ledger (DIL EXIM – RAJKOT → DIL EXIM).
 */
export async function mainSupplierId(id: number): Promise<number> {
  if (!id) return 0
  const r = await getClient().execute({ sql: 'SELECT COALESCE(linked_party_id, id) AS m FROM suppliers WHERE id = ?', args: [id] })
  return Number(r.rows[0]?.m) || id
}

/**
 * One supplier family? A bargain or tanker made with DIL EXIM may be billed by
 * any of its sub-ledgers, and the reverse, so the checks that tie them to an
 * invoice's supplier compare the family, not the row.
 */
export async function sameSupplierFamily(a: number, b: number): Promise<boolean> {
  if (Number(a) === Number(b)) return true
  return (await mainSupplierId(Number(a))) === (await mainSupplierId(Number(b)))
}
