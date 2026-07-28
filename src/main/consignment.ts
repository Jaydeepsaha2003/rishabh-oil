import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const k of res.columns) o[k] = (r as Row)[k]
    return o
  })
}

const n = (v: unknown): number => Number(v) || 0

// Total consignment qty already drawn into the books for a supplier+product in
// the active company — i.e. booked via consignment purchase invoices.
async function invoicedMap(companyId: number): Promise<Map<string, number>> {
  const res = await getClient().execute({
    sql: `SELECT supplier_id, oil_type_id AS product_id, COALESCE(SUM(ordered_qty), 0) AS q
          FROM orders WHERE company_id = ? AND is_consignment = 1
          GROUP BY supplier_id, oil_type_id`,
    args: [companyId]
  })
  const m = new Map<string, number>()
  for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
  return m
}

// Total qty this party has ever deposited with us for a product. Zero means
// they hold no stock at our place, so there is nothing to draw against.
export async function consignmentDeposited(supplierId: number, productId: number): Promise<number> {
  const res = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?',
    args: [getActiveCompanyId(), supplierId, productId]
  })
  return n(res.rows[0]?.q)
}

// Consigned qty still lying at our place (deposited − invoiced) for a
// supplier+product in the active company.
export async function consignmentAvailable(supplierId: number, productId: number): Promise<number> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const dep = await c.execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?',
    args: [cid, supplierId, productId]
  })
  const inv = await c.execute({
    sql: 'SELECT COALESCE(SUM(ordered_qty), 0) AS q FROM orders WHERE company_id = ? AND is_consignment = 1 AND supplier_id = ? AND oil_type_id = ?',
    args: [cid, supplierId, productId]
  })
  return n(dep.rows[0]?.q) - n(inv.rows[0]?.q)
}

// Individual deposit lots for the active company.
export async function listConsignment(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT cs.*, s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, o.invoice_no, o.order_date,
                 b.bargain_no, b.rate_per_uom AS bargain_rate,
                 xb.bargain_no AS extra_bargain_no, xb.rate_per_uom AS extra_bargain_rate
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          LEFT JOIN orders o ON o.id = cs.order_id
          LEFT JOIN bargains b ON b.id = cs.bargain_id
          LEFT JOIN bargains xb ON xb.id = cs.extra_bargain_id
          WHERE cs.company_id = ?
          ORDER BY cs.id DESC`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

// Logged lots still waiting to be booked into a purchase invoice — the tankers
// the purchase form offers first. Optionally narrowed to one supplier/product.
export async function listUnbookedLots(supplierId?: number, productId?: number): Promise<Row[]> {
  const where = ['cs.company_id = ?', 'cs.order_id IS NULL']
  const args: (number | string)[] = [getActiveCompanyId()]
  if (supplierId) { where.push('cs.supplier_id = ?'); args.push(supplierId) }
  if (productId) { where.push('cs.product_id = ?'); args.push(productId) }
  const res = await getClient().execute({
    sql: `SELECT cs.id, cs.supplier_id, cs.product_id, cs.qty, cs.uom, cs.deposit_date, cs.note,
                 cs.tanker_no, cs.gate_entry_id, cs.bargain_id, cs.extra_bargain_id, cs.extra_qty,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, ge.received_qty AS gate_qty
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          WHERE ${where.join(' AND ')}
          ORDER BY cs.deposit_date, cs.id`,
    args
  })
  return toPlain(res)
}

// One picked tanker and the bargain(s) it draws against. A tanker may be split
// across two bargains: extra_qty goes to extra_bargain_id, the remainder to
// bargain_id — the same shape purchase_tankers uses for loaded tankers.
export interface LotPick {
  id: number
  bargain_id?: number | null
  extra_bargain_id?: number | null
  extra_qty?: number | null
}

// Normalise whatever the renderer sent into LotPick[]. Plain ids are accepted so
// a caller that does not care about bargains (auto FIFO) still works.
export function toLotPicks(v: unknown): LotPick[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) =>
      typeof x === 'object' && x !== null
        ? {
            id: Number((x as LotPick).id),
            bargain_id: (x as LotPick).bargain_id ? Number((x as LotPick).bargain_id) : null,
            extra_bargain_id: (x as LotPick).extra_bargain_id ? Number((x as LotPick).extra_bargain_id) : null,
            extra_qty: n((x as LotPick).extra_qty)
          }
        : { id: Number(x), bargain_id: null, extra_bargain_id: null, extra_qty: 0 }
    )
    .filter((x) => x.id > 0)
}

export interface LotAllocation {
  total: number
  // Per-bargain quantity + rate, ready for computeMoney's `lines`.
  lines: { bargain_id: number; bargain_no: string; rate: number; qty: number }[]
  primaryBargainId: number
}

// Check the picked tankers and work out what each bargain is drawing, WITHOUT
// touching anything. Callers run this before writing the invoice, so a bad pick
// can never leave a half-booked order behind.
export async function validateConsignmentLots(
  picks: unknown,
  supplierId: number,
  productId: number,
  orderId = 0
): Promise<LotAllocation> {
  const list = toLotPicks(picks)
  if (!list.length) return { total: 0, lines: [], primaryBargainId: 0 }
  const ids = list.map((p) => p.id)
  const res = await getClient().execute({
    sql: `SELECT id, supplier_id, product_id, qty, order_id, tanker_no
          FROM consignment_stock WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    args: [getActiveCompanyId(), ...ids]
  })
  if (res.rows.length !== ids.length) throw new Error('One of the selected consignment tankers no longer exists')
  const byId = new Map(res.rows.map((r) => [Number(r.id), r]))

  // Every bargain named across the picks must belong to this supplier + product.
  const bargainIds = Array.from(
    new Set(list.flatMap((p) => [p.bargain_id, p.extra_bargain_id]).filter((x): x is number => !!x))
  )
  const bargains = new Map<number, Row>()
  if (bargainIds.length) {
    const bres = await getClient().execute({
      sql: `SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom
            FROM bargains WHERE id IN (${bargainIds.map(() => '?').join(',')})`,
      args: bargainIds
    })
    for (const b of toPlain(bres)) {
      if (n(b.supplier_id) !== supplierId || n(b.oil_type_id) !== productId) {
        throw new Error(`Bargain ${b.bargain_no} is not for this supplier and product`)
      }
      bargains.set(Number(b.id), b)
    }
    if (bargains.size !== bargainIds.length) throw new Error('One of the selected bargains no longer exists')
  }

  const alloc = new Map<number, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
  const add = (bid: number | null | undefined, qty: number): void => {
    if (!bid || qty <= 1e-9) return
    const b = bargains.get(bid) as Row
    const cur = alloc.get(bid) || {
      bargain_id: bid,
      bargain_no: String(b?.bargain_no || ''),
      rate: n(b?.rate_per_uom),
      qty: 0
    }
    cur.qty += qty
    alloc.set(bid, cur)
  }

  let total = 0
  for (const p of list) {
    const row = byId.get(p.id) as Row
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is already booked on another purchase`)
    }
    if (n(row.supplier_id) !== supplierId || n(row.product_id) !== productId) {
      throw new Error('The selected tankers must all belong to this supplier and product')
    }
    const qty = n(row.qty)
    const extra = p.extra_bargain_id ? n(p.extra_qty) : 0
    if (extra < 0) throw new Error(`Split quantity on tanker ${row.tanker_no || row.id} cannot be negative`)
    if (extra > qty + 1e-6) {
      throw new Error(
        `Split quantity on tanker ${row.tanker_no || row.id} (${extra}) is more than the tanker itself (${qty})`
      )
    }
    if (p.extra_bargain_id && p.extra_bargain_id === p.bargain_id) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is split across the same bargain twice`)
    }
    if (bargainIds.length && !p.bargain_id && extra < qty - 1e-6) {
      throw new Error(`Assign a bargain to tanker ${row.tanker_no || row.id}`)
    }
    add(p.bargain_id, qty - extra)
    add(p.extra_bargain_id, extra)
    total += qty
  }
  const primary = list.find((p) => p.bargain_id)?.bargain_id || list.find((p) => p.extra_bargain_id)?.extra_bargain_id
  return { total, lines: Array.from(alloc.values()), primaryBargainId: Number(primary) || 0 }
}

// Tie the picked tankers, with their bargain split, to the invoice that drew them.
export async function assignConsignmentLots(
  orderId: number,
  picks: unknown,
  supplierId: number,
  productId: number
): Promise<LotAllocation> {
  const list = toLotPicks(picks)
  if (!list.length) return { total: 0, lines: [], primaryBargainId: 0 }
  const alloc = await validateConsignmentLots(list, supplierId, productId, orderId)
  const c = getClient()
  for (const p of list) {
    await c.execute({
      sql: `UPDATE consignment_stock
            SET order_id = ?, bargain_id = ?, extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        orderId,
        p.bargain_id || null,
        p.extra_bargain_id || null,
        p.extra_bargain_id ? n(p.extra_qty) : null,
        p.id
      ]
    })
  }
  return alloc
}

// Booking that did not name its tankers (the Book purchase button on the
// Consignment page) still has to take them out of the pending list, or the same
// tankers could be picked again on the purchase form. Oldest first, whole lots
// only, never past the invoiced quantity.
export async function autoAssignConsignmentLots(
  orderId: number,
  supplierId: number,
  productId: number,
  qty: number,
  bargainId = 0
): Promise<number> {
  const free = await getClient().execute({
    sql: `SELECT id, qty FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND order_id IS NULL
          ORDER BY deposit_date, id`,
    args: [getActiveCompanyId(), supplierId, productId]
  })
  const take: number[] = []
  let used = 0
  for (const r of free.rows) {
    if (used + n(r.qty) > qty + 1e-6) continue
    take.push(Number(r.id))
    used += n(r.qty)
  }
  // Only claim tankers when they account for the invoice exactly. A partial
  // match would leave part of the quantity with no tanker behind it, and the
  // bargain register counts one or the other — never a mix.
  if (!take.length || Math.abs(used - qty) > 1e-6) return 0
  await getClient().execute({
    sql: `UPDATE consignment_stock SET order_id = ?, bargain_id = ?
          WHERE id IN (${take.map(() => '?').join(',')})`,
    args: [orderId, bargainId || null, ...take]
  })
  return used
}

// Free every lot an invoice held (on edit or delete) so they become pending again.
export async function releaseConsignmentLots(orderId: number): Promise<void> {
  await getClient().execute({
    sql: `UPDATE consignment_stock
          SET order_id = NULL, bargain_id = NULL, extra_bargain_id = NULL, extra_qty = NULL
          WHERE order_id = ?`,
    args: [orderId]
  })
}


// Consigned stock rolled up per supplier+product: deposited, invoiced, balance.
export async function consignmentSummary(): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const dep = await getClient().execute({
    sql: `SELECT cs.supplier_id, cs.product_id, cs.uom,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 SUM(cs.qty) AS deposited
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?
          GROUP BY cs.supplier_id, cs.product_id`,
    args: [cid]
  })
  const inv = await invoicedMap(cid)
  return toPlain(dep).map((d) => {
    const invoiced = inv.get(`${d.supplier_id}:${d.product_id}`) || 0
    return { ...d, invoiced, balance: n(d.deposited) - invoiced }
  })
}

// Gate-in entries that aren't tied to a purchase tanker and haven't been
// validated into consignment stock yet — the accountant's to-do list. The
// gateman only records the vehicle (and later the weighment); everything else
// is filled in at validation.
export async function listPendingGateArrivals(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ge.id, ge.gate_entry_no, ge.ref_no, ge.entry_date, ge.tanker_no, ge.rec_type,
                 ge.received_qty, ge.gross_weight, ge.tare_weight, ge.uom, ge.status, ge.note,
                 ge.oil_type_id, p.code AS product_code, p.name AS product_name
          FROM gate_entries ge
          LEFT JOIN products p ON p.id = ge.oil_type_id
          WHERE ge.direction = 'in'
            AND ge.tanker_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.gate_entry_id = ge.id)
          ORDER BY ge.entry_date DESC, ge.id DESC`,
    args: []
  })
  return toPlain(res)
}

export async function createConsignment(v: Row): Promise<{ id: number }> {
  if (!v.supplier_id || !v.product_id) throw new Error('Supplier and product are required')
  if (n(v.qty) <= 0) throw new Error('Quantity must be greater than zero')
  const c = getClient()
  const gateId = v.gate_entry_id ? n(v.gate_entry_id) : null
  let tankerNo = v.tanker_no ? String(v.tanker_no).trim() : null
  if (gateId) {
    // Validating a gate arrival: it must exist and not already be booked.
    const ge = await c.execute({
      sql: 'SELECT id, tanker_no, direction FROM gate_entries WHERE id = ?',
      args: [gateId]
    })
    if (!ge.rows.length) throw new Error('That gate entry no longer exists')
    const dup = await c.execute({
      sql: 'SELECT id FROM consignment_stock WHERE gate_entry_id = ?',
      args: [gateId]
    })
    if (dup.rows.length) throw new Error('This gate entry has already been validated into consignment stock')
    if (!tankerNo) tankerNo = ge.rows[0].tanker_no ? String(ge.rows[0].tanker_no) : null
  }
  const res = await c.execute({
    sql: `INSERT INTO consignment_stock (company_id, supplier_id, product_id, qty, uom, deposit_date, note, gate_entry_id, tanker_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      n(v.supplier_id),
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      v.deposit_date,
      v.note ? String(v.note).trim() : null,
      gateId,
      tankerNo
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Editing a lot can't drop the supplier+product's deposited total below what
// has already been invoiced from it.
export async function updateConsignment(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Consignment entry not found')
  const row = cur.rows[0]
  const newQty = n(v.qty)
  if (newQty <= 0) throw new Error('Quantity must be greater than zero')
  if (row.order_id != null) {
    throw new Error('This tanker is already booked on a purchase invoice — edit or delete that purchase first')
  }
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  // available already reflects the current qty; adding the delta must stay ≥ 0
  if (avail + (newQty - n(row.qty)) < -1e-6) {
    throw new Error('Cannot reduce below the quantity already invoiced from this stock')
  }
  await c.execute({
    sql: `UPDATE consignment_stock SET qty = ?, uom = ?, deposit_date = ?, note = ? WHERE id = ?`,
    args: [newQty, v.uom || 'MT', v.deposit_date, v.note ? String(v.note).trim() : null, id]
  })
  return { id }
}

export async function deleteConsignment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const row = cur.rows[0]
  if (row.order_id != null) {
    throw new Error('This tanker is already booked on a purchase invoice — delete that purchase first')
  }
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  // Removing this lot drops availability by its qty; it can't go negative.
  if (avail - n(row.qty) < -1e-6) {
    throw new Error('Cannot delete — part of this stock has already been invoiced')
  }
  await c.execute({ sql: 'DELETE FROM consignment_stock WHERE id = ?', args: [id] })
  return { id }
}
