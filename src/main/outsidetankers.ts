import { getClient } from './db'
import { getActiveCompanyId } from './company'

// The gate supervisor's diary of tankers standing OUTSIDE the factory.
//
// Gate Entry records what has come in. This records what has not — lorries
// waiting on the road, at the weighbridge queue, parked up overnight — counted
// three times a day at 8 AM, 4 PM and 8 PM. It is a headcount, not a document:
// nobody is claiming a tanker number or a quantity, only "eleven of DEEPCHAND's
// RPS are still outside at four o'clock". That is why it carries no gate
// number, no weight and no link to a purchase.
//
// Kept deliberately separate from gate_entries. A tanker outside the gate has
// not arrived, and writing it into the arrivals table — even flagged — would
// put a vehicle on the register that no weighbridge has seen and no stock
// movement can ever attach to.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => Number(v || 0)

export const OUTSIDE_SLOTS = ['08:00', '16:00', '20:00'] as const

// One count per slot per line, so the same reading is not logged twice when
// two people check the gate at four o'clock. Reads left to right the way the
// supervisor walks it: what kind of movement, which product, whose lorries.
export async function listOutsideTankers(date?: string): Promise<Row[]> {
  const c = getClient()
  const day = String(date || '').slice(0, 10)
  const args: unknown[] = [getActiveCompanyId()]
  let where = 'WHERE t.company_id = ?'
  if (day) {
    where += ' AND t.log_date = ?'
    args.push(day)
  }
  const res = await c.execute({
    sql: `SELECT t.*,
                 p.name AS product_name,
                 p.code AS product_code,
                 COALESCE(s.name, cu.name) AS party_name
            FROM outside_tankers t
            LEFT JOIN products p ON p.id = t.product_id
            LEFT JOIN suppliers s ON s.id = t.party_id AND t.kind = 'purchase'
            LEFT JOIN customers cu ON cu.id = t.party_id AND t.kind = 'sales'
            ${where}
           ORDER BY t.log_date DESC, t.slot, t.id`,
    args
  })
  // SL No is derived, never stored. A stored counter goes wrong the first time
  // a line is deleted — you either leave a hole or renumber rows that people
  // have already written down. Position in the day is always right.
  const rows = res.rows as unknown as Row[]
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const k = String(r.log_date)
    const sl = (seen.get(k) || 0) + 1
    seen.set(k, sl)
    return { ...r, sl_no: sl }
  })
}

export async function saveOutsideTanker(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const day = String(v.log_date || '').slice(0, 10)
  if (!day) throw new Error('Pick the date this count was taken')
  const slot = String(v.slot || '')
  if (!OUTSIDE_SLOTS.includes(slot as (typeof OUTSIDE_SLOTS)[number]))
    throw new Error('Pick which round this is — 8 AM, 4 PM or 8 PM')
  const kind = String(v.kind || '')
  if (kind !== 'purchase' && kind !== 'sales')
    throw new Error('Say whether these are purchase or sales tankers')
  const tankers = Math.round(n(v.tankers))
  // Zero is a real answer — "nothing of theirs is outside any more" — so it is
  // allowed. A negative count is not.
  if (tankers < 0) throw new Error('A tanker count cannot be negative')

  const args = [
    getActiveCompanyId(),
    day,
    slot,
    kind,
    n(v.product_id) || null,
    n(v.party_id) || null,
    tankers,
    String(v.note || '').trim() || null,
    String(v.created_by || '') || null
  ]
  if (n(v.id)) {
    await c.execute({
      sql: `UPDATE outside_tankers
               SET log_date = ?, slot = ?, kind = ?, product_id = ?, party_id = ?,
                   tankers = ?, note = ?
             WHERE id = ? AND company_id = ?`,
      args: [day, slot, kind, args[4], args[5], tankers, args[7], n(v.id), getActiveCompanyId()]
    })
    return { id: n(v.id) }
  }
  const res = await c.execute({
    sql: `INSERT INTO outside_tankers
            (company_id, log_date, slot, kind, product_id, party_id, tankers, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args
  })
  return { id: Number(res.lastInsertRowid || 0) }
}

export async function removeOutsideTanker(id: number): Promise<{ ok: true }> {
  await getClient().execute({
    sql: 'DELETE FROM outside_tankers WHERE id = ? AND company_id = ?',
    args: [n(id), getActiveCompanyId()]
  })
  return { ok: true }
}
