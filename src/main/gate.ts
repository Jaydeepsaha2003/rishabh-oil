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
           b.bargain_no, s.name AS supplier_name,
           sl.invoice_no AS sale_invoice, sl.customer AS sale_customer,
           sl.dispatch_stage AS sale_stage, spr.name AS sale_product
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN sales sl ON sl.id = g.sale_id
    LEFT JOIN products spr ON spr.id = sl.product_id
    ORDER BY g.id DESC
  `)
  return toPlain(res)
}

// Continuous gate-entry number per direction: GE/0001 inbound, GO/0001
// outbound (used as a default; the gateman can overwrite it with the physical
// gate-register number).
export async function nextGateEntryNo(direction: 'in' | 'out' = 'in'): Promise<string> {
  const res = await getClient().execute({
    sql: "SELECT gate_entry_no FROM gate_entries WHERE COALESCE(direction, 'in') = ?",
    args: [direction]
  })
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.gate_entry_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `${direction === 'out' ? 'GO' : 'GE'}/${String(maxSeq + 1).padStart(4, '0')}`
}

// Dispatched sales (any company — the gate is shared) for the gate-out picker,
// with how many gate-out entries each already has. Recent first.
export async function listDispatchableSales(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT s.id, s.sale_date, s.invoice_no, s.customer, s.qty, s.uom, s.dispatch_stage,
           pr.name AS product_name, co.name AS company_name,
           (SELECT COUNT(*) FROM gate_entries g WHERE g.sale_id = s.id AND g.direction = 'out') AS gate_outs
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN companies co ON co.id = s.company_id
    WHERE s.status = 'done'
    ORDER BY s.sale_date DESC, s.id DESC
    LIMIT 300
  `)
  return toPlain(res)
}

// Total received qty recorded at the gate for a tanker. Only COMPLETED entries
// count — an arrival still waiting for weighment is not a received quantity.
// Returns null when the tanker has no completed gate entry yet.
export async function tankerGateReceived(tankerId: number): Promise<number | null> {
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(received_qty), 0) AS qty, COUNT(*) AS cnt
          FROM gate_entries WHERE tanker_id = ? AND status = 'completed'`,
    args: [tankerId]
  })
  if (!res.rows.length || n(res.rows[0].cnt) === 0) return null
  return n(res.rows[0].qty)
}

export async function createGateEntry(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const direction = v.direction === 'out' ? 'out' : 'in'
  if (direction === 'out' && !v.sale_id) throw new Error('Select the sale being dispatched')
  const gateNo = String(v.gate_entry_no || '').trim() || (await nextGateEntryNo(direction))
  // Two-step flow: an entry without a weighed quantity stays 'pending' until
  // the weighbridge figure is entered, which completes the transaction.
  const status = v.status || (n(v.received_qty) > 0 ? 'completed' : 'pending')
  const res = await c.execute({
    sql: `INSERT INTO gate_entries
      (gate_entry_no, entry_date, tanker_id, tanker_no, oil_type_id, dispatch_qty, received_qty, uom, status, note, direction, sale_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      gateNo,
      v.entry_date,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      n(v.dispatch_qty),
      n(v.received_qty),
      v.uom || 'MT',
      status,
      v.note || null,
      direction,
      v.sale_id ? n(v.sale_id) : null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Step 2 for the gateman: enter the weighed quantity and finish the entry.
export async function completeGateEntry(id: number, receivedQty: number): Promise<{ id: number }> {
  if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
    throw new Error('Enter the weighed quantity')
  }
  await getClient().execute({
    sql: "UPDATE gate_entries SET received_qty = ?, status = 'completed' WHERE id = ?",
    args: [receivedQty, id]
  })
  return { id }
}

export async function updateGateEntry(id: number, v: Row): Promise<{ id: number }> {
  const status = n(v.received_qty) > 0 ? 'completed' : 'pending'
  await getClient().execute({
    sql: `UPDATE gate_entries SET gate_entry_no = ?, entry_date = ?, tanker_id = ?, tanker_no = ?,
          oil_type_id = ?, dispatch_qty = ?, received_qty = ?, uom = ?, status = ?, note = ?, sale_id = ? WHERE id = ?`,
    args: [
      String(v.gate_entry_no || '').trim(),
      v.entry_date,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      n(v.dispatch_qty),
      n(v.received_qty),
      v.uom || 'MT',
      status,
      v.note || null,
      v.sale_id ? n(v.sale_id) : null,
      id
    ]
  })
  return { id }
}

export async function deleteGateEntry(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM gate_entries WHERE id = ?', args: [id] })
  return { id }
}
