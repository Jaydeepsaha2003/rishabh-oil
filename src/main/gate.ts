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

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export async function listGateEntries(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT g.*, p.code AS oil_code, p.name AS oil_name,
           b.bargain_no, s.name AS supplier_name
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    ORDER BY g.id DESC
  `)
  return toPlain(res)
}

// Continuous gate-entry number: GE/0001 (used as a default; the gateman can
// overwrite it with the physical gate-register number).
export async function nextGateEntryNo(): Promise<string> {
  const res = await getClient().execute('SELECT gate_entry_no FROM gate_entries')
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.gate_entry_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `GE/${String(maxSeq + 1).padStart(4, '0')}`
}

// Total received qty recorded at the gate for a tanker (0 if no gate entry).
export async function tankerGateReceived(tankerId: number): Promise<number | null> {
  const res = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(received_qty), 0) AS qty, COUNT(*) AS cnt FROM gate_entries WHERE tanker_id = ?',
    args: [tankerId]
  })
  if (!res.rows.length || n(res.rows[0].cnt) === 0) return null
  return n(res.rows[0].qty)
}

export async function createGateEntry(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const gateNo = String(v.gate_entry_no || '').trim() || (await nextGateEntryNo())
  const res = await c.execute({
    sql: `INSERT INTO gate_entries
      (gate_entry_no, entry_date, tanker_id, tanker_no, oil_type_id, dispatch_qty, received_qty, uom, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      gateNo,
      v.entry_date,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      n(v.dispatch_qty),
      n(v.received_qty),
      v.uom || 'ton',
      v.note || null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateGateEntry(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: `UPDATE gate_entries SET gate_entry_no = ?, entry_date = ?, tanker_id = ?, tanker_no = ?,
          oil_type_id = ?, dispatch_qty = ?, received_qty = ?, uom = ?, note = ? WHERE id = ?`,
    args: [
      String(v.gate_entry_no || '').trim(),
      v.entry_date,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      n(v.dispatch_qty),
      n(v.received_qty),
      v.uom || 'ton',
      v.note || null,
      id
    ]
  })
  return { id }
}

export async function deleteGateEntry(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM gate_entries WHERE id = ?', args: [id] })
  return { id }
}
