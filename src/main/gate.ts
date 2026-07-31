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
           b.bargain_no, COALESCE(ds.name, s.name, dc.name) AS supplier_name,
           dc.name AS gate_customer_name,
           COALESCE(sl.invoice_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_invoice,
           COALESCE(sl.customer,  (SELECT customer  FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_customer
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN suppliers ds ON ds.id = g.supplier_id
    LEFT JOIN customers dc ON dc.id = g.customer_id
    LEFT JOIN sales sl ON sl.id = g.sale_id
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

// Dispatched sale INVOICES (grouped, any company — the gate is shared) for the
// gate-out picker, with how many gate-out entries each already has. A whole
// invoice leaves together, so items are rolled up per invoice_group.
export async function listDispatchableSales(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT s.invoice_group,
           MAX(s.sale_date) AS sale_date,
           MAX(s.invoice_no) AS invoice_no,
           MAX(s.customer) AS customer,
           SUM(s.qty) AS qty,
           MAX(s.uom) AS uom,
           COUNT(*) AS item_count,
           GROUP_CONCAT(pr.name, ', ') AS product_name,
           MAX(pr.material_type) AS product_category,
           (SELECT COUNT(*) FROM gate_entries g WHERE g.invoice_group = s.invoice_group AND g.direction = 'out') AS gate_outs
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    WHERE s.status = 'done' AND s.invoice_group IS NOT NULL
    GROUP BY s.invoice_group
    ORDER BY MAX(s.sale_date) DESC, MAX(s.id) DESC
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
          FROM gate_entries
          WHERE tanker_id = ? AND status = 'completed' AND COALESCE(no_weighment, 0) = 0`,
    args: [tankerId]
  })
  if (!res.rows.length || n(res.rows[0].cnt) === 0) return null
  return n(res.rows[0].qty)
}

export async function createGateEntry(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const direction = v.direction === 'out' ? 'out' : 'in'
  // The simple register line: a vehicle, optionally who it is with, and what
  // it carries. Nothing else is asked of it and it never waits to be weighed.
  const kind = String(v.entry_kind || 'standard') === 'simple' ? 'simple' : 'standard'
  if (kind === 'simple') {
    if (!String(v.tanker_no || '').trim()) throw new Error('Enter the vehicle number')
    if (!String(v.note || '').trim()) throw new Error('Say what the vehicle is carrying')
  }
  // A sale invoice is the normal case but not compulsory — empty vehicles,
  // returns and weighment runs leave too. What such an exit must carry is the
  // reason, so the register never holds an unexplained departure.
  if (kind === 'standard' && direction === 'out' && !v.invoice_group && !v.sale_id && !String(v.note || '').trim()) {
    throw new Error('Pick the sale invoice being dispatched, or write why the vehicle is leaving without one')
  }
  // Every gate entry names its vehicle — either a tanker from the movement
  // register or a typed vehicle number; an entry with neither is untraceable.
  if (!n(v.tanker_id) && !String(v.tanker_no || '').trim()) {
    throw new Error('Pick a tanker from the list or type the vehicle number')
  }
  // The system serial is always auto-assigned fresh (authoritative, no stale
  // preview / duplicates). The user's optional manual number lives in ref_no.
  const gateNo = await nextGateEntryNo(direction)
  // Two-step flow: an entry without a weighed quantity stays 'pending' until
  // the weighbridge figure is entered, which completes the transaction.
  // Without weighment: the entry is done the moment it is recorded — it never
  // joins the weighbridge queue and keeps whatever quantity was declared.
  const noWeighment = !!v.no_weighment || kind === 'simple'
  const status = noWeighment ? 'completed' : v.status || (n(v.received_qty) > 0 ? 'completed' : 'pending')
  const res = await c.execute({
    sql: `INSERT INTO gate_entries
      (gate_entry_no, ref_no, entry_date, tanker_id, tanker_no, oil_type_id, dispatch_qty, received_qty, uom, status, note, direction, sale_id, invoice_group, rec_type, gross_weight, tare_weight, supplier_id, is_direct_mnc, no_weighment, customer_id, person, entry_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      gateNo,
      v.ref_no ? String(v.ref_no).trim() : null,
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
      v.sale_id ? n(v.sale_id) : null,
      v.invoice_group ? String(v.invoice_group) : null,
      String(v.rec_type || 'OIL'),
      v.gross_weight != null && v.gross_weight !== '' ? n(v.gross_weight) : null,
      v.tare_weight != null && v.tare_weight !== '' ? n(v.tare_weight) : null,
      v.supplier_id ? n(v.supplier_id) : null,
      v.is_direct_mnc ? 1 : 0,
      noWeighment ? 1 : 0,
      v.customer_id ? n(v.customer_id) : null,
      v.person ? String(v.person).trim() : null,
      kind
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Step 2 for the gateman: enter gross & tare from the weighbridge; the net
// (received qty) is gross − tare. Completes the entry.
export async function completeGateEntry(
  id: number,
  gross: number,
  tare: number
): Promise<{ id: number }> {
  const g = Number(gross)
  const t = Number(tare) || 0
  if (!Number.isFinite(g) || g <= 0) throw new Error('Enter the gross weight')
  if (t < 0) throw new Error('Tare weight cannot be negative')
  const net = Math.round((g - t) * 1000) / 1000
  if (net <= 0) throw new Error('Net weight (gross − tare) must be greater than zero')
  await getClient().execute({
    sql: "UPDATE gate_entries SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = 'completed' WHERE id = ?",
    args: [g, t, net, id]
  })
  return { id }
}

// Save whatever the weighbridge has so far. Gross and tare rarely arrive
// together — the loaded weight is taken on the way in and the empty weight
// only after unloading — so each is stored on its own and the entry stays in
// the queue until BOTH are in, at which point it completes on net = gross − tare.
export async function saveGateWeights(
  id: number,
  gross: number | null,
  tare: number | null
): Promise<{ id: number; status: string; net: number | null; missing: string | null }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM gate_entries WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Gate entry not found')
  const row = cur.rows[0]

  const given = (v: number | null, existing: unknown): number | null => {
    if (v == null || !Number.isFinite(Number(v))) return existing == null ? null : n(existing)
    return Number(v)
  }
  const g = given(gross, row.gross_weight)
  const t = given(tare, row.tare_weight)
  if (g != null && g < 0) throw new Error('Gross weight cannot be negative')
  if (t != null && t < 0) throw new Error('Tare weight cannot be negative')
  if (g == null && t == null) throw new Error('Enter the gross or the tare weight')

  const both = g != null && t != null
  const net = both ? Math.round((g - t) * 1000) / 1000 : null
  if (both && (net as number) <= 0) {
    throw new Error('Net weight (gross − tare) must be greater than zero — check the two figures')
  }
  await c.execute({
    sql: `UPDATE gate_entries
          SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = ?
          WHERE id = ?`,
    args: [g, t, both ? net : 0, both ? 'completed' : 'pending', id]
  })
  return {
    id,
    status: both ? 'completed' : 'pending',
    net,
    missing: both ? null : g == null ? 'gross' : 'tare'
  }
}

// Finish an entry with no weighment at all. Oil is always weighed — the whole
// purchase and stock chain is built on that figure — so only other categories
// (packaging, miscellaneous, scrap and the like) may skip it.
export async function skipGateWeighment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT rec_type, dispatch_qty FROM gate_entries WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Gate entry not found')
  if (String(cur.rows[0].rec_type || 'OIL').toUpperCase() === 'OIL') {
    throw new Error('Oil is always weighed — enter the gross and tare weights for this vehicle')
  }
  await c.execute({
    sql: "UPDATE gate_entries SET status = 'completed', no_weighment = 1, received_qty = ? WHERE id = ?",
    args: [n(cur.rows[0].dispatch_qty), id]
  })
  return { id }
}

export async function updateGateEntry(id: number, v: Row): Promise<{ id: number }> {
  // If gross is provided, derive net from gross − tare; else use received_qty.
  const gross = v.gross_weight != null && v.gross_weight !== '' ? n(v.gross_weight) : null
  const tare = v.tare_weight != null && v.tare_weight !== '' ? n(v.tare_weight) : null
  const received = gross != null ? Math.round((gross - (tare || 0)) * 1000) / 1000 : n(v.received_qty)
  const status = received > 0 ? 'completed' : 'pending'
  await getClient().execute({
    sql: `UPDATE gate_entries SET gate_entry_no = ?, ref_no = ?, entry_date = ?, tanker_id = ?, tanker_no = ?,
          oil_type_id = ?, dispatch_qty = ?, received_qty = ?, uom = ?, status = ?, note = ?, sale_id = ?,
          rec_type = ?, gross_weight = ?, tare_weight = ?, supplier_id = ?, is_direct_mnc = ? WHERE id = ?`,
    args: [
      String(v.gate_entry_no || '').trim(),
      v.ref_no ? String(v.ref_no).trim() : null,
      v.entry_date,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      n(v.dispatch_qty),
      received,
      v.uom || 'MT',
      status,
      v.note || null,
      v.sale_id ? n(v.sale_id) : null,
      String(v.rec_type || 'OIL'),
      gross,
      tare,
      v.supplier_id ? n(v.supplier_id) : null,
      v.is_direct_mnc ? 1 : 0,
      id
    ]
  })
  return { id }
}

export async function deleteGateEntry(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM gate_entries WHERE id = ?', args: [id] })
  return { id }
}
