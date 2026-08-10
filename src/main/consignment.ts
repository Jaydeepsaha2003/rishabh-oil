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

// Total qty this party has ever deposited with us for a product. Zero means
// they hold no stock at our place, so there is nothing to draw against.
// Restate the opening balance for a party + product in one validated step:
// the previous figure is logged first, duplicates merge into a single lot, and
// the new value may never fall below what has already been drawn out.
export async function saveOpeningStock(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const supplierId = n(v.supplier_id)
  const productId = n(v.product_id)
  const qty = n(v.qty)
  const uom = String(v.uom || 'MT')
  const date = String(v.deposit_date || '').slice(0, 10)
  if (!supplierId) throw new Error('Choose the MNC / party')
  if (!productId) throw new Error('Choose the product')
  if (qty <= 0) throw new Error('Enter an opening quantity greater than zero — use the history to restore an older figure')
  if (!date) throw new Error('Enter the opening date')
  if (date > new Date().toISOString().slice(0, 10)) throw new Error('The opening date cannot be in the future')

  const existing = await c.execute({
    sql: `SELECT * FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND is_opening = 1 AND order_id IS NULL
          ORDER BY id DESC`,
    args: [cid, supplierId, productId]
  })
  const lots = toPlain(existing)
  const oldTotal = lots.reduce((s2, l) => s2 + n(l.qty), 0)
  const available = await consignmentAvailable(supplierId, productId)
  // drawn − deposits-other-than-opening = the floor the opening cannot cross.
  const minOpening = Math.max(0, Math.round((oldTotal - available) * 1000) / 1000)
  if (qty < minOpening - 1e-6) {
    throw new Error(
      `${minOpening.toFixed(3)} ${uom} of this opening is already drawn into purchases — the opening cannot go below that`
    )
  }

  await c.execute({
    sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [cid, supplierId, productId, lots.length ? 'restate' : 'create', lots.length ? oldTotal : null, qty, uom, date, v.note ? String(v.note) : null]
  })

  const payload = {
    supplier_id: supplierId,
    product_id: productId,
    qty,
    uom,
    deposit_date: date,
    note: v.note ? String(v.note).trim() : 'Opening stock',
    is_opening: true
  }
  if (lots.length) {
    await updateConsignment(n(lots[0].id), payload)
    for (const extra of lots.slice(1)) await deleteConsignment(n(extra.id))
    return { id: n(lots[0].id) }
  }
  return createConsignment(payload)
}

// The restatement trail for one party + product, newest first.
export async function listOpeningLog(supplierId: number, productId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT * FROM consignment_opening_log
          WHERE company_id = ? AND supplier_id = ? AND product_id = ?
          ORDER BY id DESC LIMIT 20`,
    args: [getActiveCompanyId(), supplierId, productId]
  })
  return toPlain(res)
}

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
                 cs.tanker_no, cs.gate_entry_id, cs.bargain_id, cs.extra_bargain_id, cs.extra_qty, cs.is_opening,
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
// With a date range, the same split Book Stock uses: whatever moved before
// `from` collapses into `opening`, and `deposited`/`invoiced` become the
// movement strictly inside [from, to] — `balance` is then the closing figure
// as of `to`. Without a range (both blank) `opening` is 0 and `deposited`/
// `invoiced`/`balance` are the lifetime totals, exactly as before this split
// existed.
export async function consignmentSummary(range?: { from?: string; to?: string }): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const c = getClient()
  const from = String(range?.from || '')
  const to = String(range?.to || '')

  const base = await c.execute({
    sql: `SELECT DISTINCT cs.supplier_id, cs.product_id, cs.uom,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?`,
    args: [cid]
  })

  const depositSlice = async (kind: 'opening' | 'period'): Promise<Map<string, number>> => {
    if (kind === 'opening' && !from) return new Map()
    let sql = 'SELECT supplier_id, product_id, SUM(qty) AS q FROM consignment_stock WHERE company_id = ?'
    const args: (string | number)[] = [cid]
    if (kind === 'opening') {
      sql += ' AND deposit_date < ?'
      args.push(from)
    } else {
      if (from) { sql += ' AND deposit_date >= ?'; args.push(from) }
      if (to) { sql += ' AND deposit_date <= ?'; args.push(to) }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, product_id`, args })
    const m = new Map<string, number>()
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
    return m
  }

  // Stock becomes "invoiced" the moment the consignment purchase is booked —
  // orders.ordered_qty where is_consignment=1, sliced by order date instead
  // of taken over all time.
  const invoicedSlice = async (kind: 'opening' | 'period'): Promise<Map<string, number>> => {
    if (kind === 'opening' && !from) return new Map()
    let sql = `SELECT supplier_id, oil_type_id AS product_id, SUM(ordered_qty) AS q
               FROM orders WHERE company_id = ? AND is_consignment = 1`
    const args: (string | number)[] = [cid]
    if (kind === 'opening') {
      sql += ' AND order_date < ?'
      args.push(from)
    } else {
      if (from) { sql += ' AND order_date >= ?'; args.push(from) }
      if (to) { sql += ' AND order_date <= ?'; args.push(to) }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, oil_type_id`, args })
    const m = new Map<string, number>()
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
    return m
  }

  const [depOpening, depPeriod, invOpening, invPeriod] = await Promise.all([
    depositSlice('opening'),
    depositSlice('period'),
    invoicedSlice('opening'),
    invoicedSlice('period')
  ])

  return toPlain(base).map((r) => {
    const key = `${r.supplier_id}:${r.product_id}`
    const opening = (depOpening.get(key) || 0) - (invOpening.get(key) || 0)
    const deposited = depPeriod.get(key) || 0
    const invoiced = invPeriod.get(key) || 0
    return { ...r, opening, deposited, invoiced, balance: opening + deposited - invoiced }
  })
}

// The invoices behind the "Invoiced" column — the same consignment purchases
// consignmentSummary sums, listed one row each so a product can be expanded to
// show what drew its stock down, not just the deposits that built it up.
export async function listConsignmentInvoices(range?: {
  from?: string
  to?: string
}): Promise<Row[]> {
  const from = String(range?.from || '')
  const to = String(range?.to || '')
  let sql = `SELECT o.id, o.invoice_no, o.order_date, o.supplier_id, o.oil_type_id AS product_id,
                    o.ordered_qty, o.uom, o.invoice_rate, o.taxable_value, o.net_amount,
                    b.bargain_no
             FROM orders o
             LEFT JOIN bargains b ON b.id = o.bargain_id
             WHERE o.company_id = ? AND o.is_consignment = 1`
  const args: (string | number)[] = [getActiveCompanyId()]
  if (from) { sql += ' AND o.order_date >= ?'; args.push(from) }
  if (to) { sql += ' AND o.order_date <= ?'; args.push(to) }
  const res = await getClient().execute({ sql: `${sql} ORDER BY o.order_date, o.id`, args })
  return toPlain(res)
}

// Gate-in entries booked as Direct MNC stock that haven't been validated into
// consignment stock yet — the accountant's to-do list. Only entries the
// gateman actually flagged Direct MNC belong here: a hand-typed vehicle for
// Packaging or Miscellaneous is a different thing entirely and is never
// meant to become a consignment lot, whatever date it was entered on.
export async function listPendingGateArrivals(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ge.id, ge.gate_entry_no, ge.ref_no, ge.entry_date, ge.tanker_no, ge.rec_type,
                 ge.received_qty, ge.gross_weight, ge.tare_weight, ge.uom, ge.status, ge.note,
                 ge.oil_type_id, ge.supplier_id, ge.is_direct_mnc,
                 p.code AS product_code, p.name AS product_name, s.name AS supplier_name
          FROM gate_entries ge
          LEFT JOIN products p ON p.id = ge.oil_type_id
          LEFT JOIN suppliers s ON s.id = ge.supplier_id
          WHERE ge.direction = 'in'
            AND ge.is_direct_mnc = 1
            AND ge.tanker_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.gate_entry_id = ge.id)
          ORDER BY ge.entry_date DESC, ge.id DESC`,
    args: []
  })
  return toPlain(res)
}

// Every check a consignment lot has to pass, whether it is being logged for the
// first time or edited afterwards. Kept in one place so both routes refuse the
// same mistakes with the same wording.
//
// `existing` is the row being edited (absent when logging a new one). The gate
// entry a lot came from is authoritative about the party and the weighed
// quantity, so an edit cannot quietly contradict it.
const CONSIGNMENT_UOMS = ['MT', 'KG', 'L']
// Same tolerance the purchase side allows between a gate weighment and the books.
const GATE_BUFFER = 1

async function validateLot(v: Row, existing: Row | null): Promise<{
  supplierId: number
  productId: number
  qty: number
  uom: string
  depositDate: string
}> {
  const c = getClient()
  const supplierId = v.supplier_id ? n(v.supplier_id) : n(existing?.supplier_id)
  const productId = v.product_id ? n(v.product_id) : n(existing?.product_id)
  const qty = v.qty != null && v.qty !== '' ? n(v.qty) : n(existing?.qty)
  const uom = String(v.uom || existing?.uom || 'MT').toUpperCase()
  const depositDate = String(v.deposit_date || existing?.deposit_date || '').slice(0, 10)

  if (!supplierId) throw new Error('Choose the supplier this stock belongs to')
  if (!productId) throw new Error('Choose the product')
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  if (!Number.isFinite(qty)) throw new Error('Quantity must be a number')
  if (!CONSIGNMENT_UOMS.includes(uom)) {
    throw new Error(`Unit must be one of ${CONSIGNMENT_UOMS.join(', ')}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depositDate)) throw new Error('Enter the date this stock came in')
  const today = new Date().toISOString().slice(0, 10)
  if (depositDate > today) throw new Error('The date cannot be in the future')

  // The party must be a real, live supplier.
  const sup = await c.execute({
    sql: 'SELECT id, name, active FROM suppliers WHERE id = ? LIMIT 1',
    args: [supplierId]
  })
  if (!sup.rows.length) throw new Error('That supplier no longer exists')
  if (!n(sup.rows[0].active)) throw new Error(`${sup.rows[0].name} is marked inactive — reactivate it first`)

  // So must the product.
  const prod = await c.execute({
    sql: 'SELECT id, code, name, active FROM products WHERE id = ? LIMIT 1',
    args: [productId]
  })
  if (!prod.rows.length) throw new Error('That product no longer exists')
  if (!n(prod.rows[0].active)) {
    throw new Error(`${prod.rows[0].code || prod.rows[0].name} is marked inactive — reactivate it first`)
  }

  // Anything the gate recorded wins: the party was named there and the vehicle
  // was weighed there, so an edit cannot drift away from it.
  const gateId = existing?.gate_entry_id ?? (v.gate_entry_id ? n(v.gate_entry_id) : null)
  if (gateId) {
    const ge = await c.execute({
      sql: 'SELECT id, gate_entry_no, supplier_id, is_direct_mnc, received_qty, status FROM gate_entries WHERE id = ? LIMIT 1',
      args: [n(gateId)]
    })
    if (!ge.rows.length) throw new Error('That gate entry no longer exists')
    const g = toPlain(ge)[0]
    if (n(g.is_direct_mnc) === 1 && n(g.supplier_id) && n(g.supplier_id) !== supplierId) {
      const named = await c.execute({ sql: 'SELECT name FROM suppliers WHERE id = ?', args: [n(g.supplier_id)] })
      throw new Error(
        `Gate entry ${g.gate_entry_no} was booked in for ${named.rows[0]?.name || 'another party'} — change it at the gate if that is wrong`
      )
    }
    const weighed = n(g.received_qty)
    if (weighed > 0 && Math.abs(qty - weighed) > GATE_BUFFER + 1e-6) {
      throw new Error(
        `Gate entry ${g.gate_entry_no} weighed ${weighed.toFixed(3)} ${uom} — ${qty.toFixed(3)} is more than ${GATE_BUFFER} ${uom} away from it`
      )
    }
  }

  // Opening stock is a balance, not a running total: one per party + product.
  // A second one has to be an edit of the first, never a new row.
  if (!existing && v.is_opening) {
    const dup = await c.execute({
      sql: `SELECT id, qty, uom FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND is_opening = 1 AND order_id IS NULL LIMIT 1`,
      args: [getActiveCompanyId(), supplierId, productId]
    })
    if (dup.rows.length) {
      const d = dup.rows[0]
      throw new Error(
        `Opening stock for ${sup.rows[0].name} · ${prod.rows[0].code || prod.rows[0].name} is already recorded ` +
          `(${n(d.qty).toFixed(3)} ${d.uom || 'MT'}) — update that entry instead of adding another`
      )
    }
  }

  // Two lots of the same party, product, date and vehicle is almost always the
  // same delivery entered twice.
  const tankerNo = (v.tanker_no ?? existing?.tanker_no) ? String(v.tanker_no ?? existing?.tanker_no).trim() : null
  if (tankerNo) {
    const dup = await c.execute({
      sql: `SELECT id FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND substr(deposit_date, 1, 10) = ? AND UPPER(TRIM(tanker_no)) = ?
              AND id <> ? LIMIT 1`,
      args: [getActiveCompanyId(), supplierId, productId, depositDate, tankerNo.toUpperCase(), n(existing?.id) || 0]
    })
    if (dup.rows.length) {
      throw new Error(`Tanker ${tankerNo} is already logged for this party and product on ${depositDate}`)
    }
  }

  return { supplierId, productId, qty, uom, depositDate }
}

export async function createConsignment(v: Row): Promise<{ id: number }> {
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
  const ok = await validateLot({ ...v, tanker_no: tankerNo }, null)
  const res = await c.execute({
    sql: `INSERT INTO consignment_stock (company_id, supplier_id, product_id, qty, uom, deposit_date, note,
            gate_entry_id, tanker_no, is_opening, weighed_qty, shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      ok.supplierId,
      ok.productId,
      ok.qty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      gateId,
      tankerNo,
      v.is_opening ? 1 : 0,
      v.weighed_qty != null && v.weighed_qty !== '' ? n(v.weighed_qty) : null,
      v.shortage_pct != null && v.shortage_pct !== '' ? n(v.shortage_pct) : null
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
  const row = toPlain(cur)[0]
  // Refuse first, before anything is written: a booked lot is frozen because its
  // quantity is already inside a purchase invoice.
  if (row.order_id != null) {
    const inv = await c.execute({
      sql: 'SELECT invoice_no FROM orders WHERE id = ? LIMIT 1',
      args: [n(row.order_id)]
    })
    const no = inv.rows[0]?.invoice_no
    throw new Error(
      `This tanker is already booked on purchase invoice ${no || '(unknown)'} — edit or delete that purchase first`
    )
  }
  const ok = await validateLot(v, row)
  const newQty = ok.qty
  // The party and the product are editable too, so a lot can be moved to the
  // pair it should have been logged against.
  const newSupplier = ok.supplierId
  const newProduct = ok.productId
  const moved = newSupplier !== n(row.supplier_id) || newProduct !== n(row.product_id)
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  if (moved) {
    // The whole lot leaves its old supplier+product, so that pair loses all of
    // it — it must still cover whatever has already been invoiced from it.
    if (avail - n(row.qty) < -1e-6) {
      throw new Error('Cannot move this stock — part of this supplier and product has already been invoiced')
    }
  } else if (avail + (newQty - n(row.qty)) < -1e-6) {
    // available already reflects the current qty; adding the delta must stay ≥ 0
    throw new Error('Cannot reduce below the quantity already invoiced from this stock')
  }
  await c.execute({
    sql: `UPDATE consignment_stock
          SET supplier_id = ?, product_id = ?, qty = ?, uom = ?, deposit_date = ?, note = ?,
              weighed_qty = ?, shortage_pct = ?
          WHERE id = ?`,
    args: [
      newSupplier,
      newProduct,
      newQty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      v.weighed_qty != null && v.weighed_qty !== '' ? n(v.weighed_qty) : row.weighed_qty,
      v.shortage_pct != null && v.shortage_pct !== '' ? n(v.shortage_pct) : row.shortage_pct,
      id
    ]
  })
  return { id }
}

export async function deleteConsignment(id: number): Promise<{ id: number }> {
  {
    // A deleted OPENING lot still leaves its figure in the restatement log, so
    // a mistaken removal can be restored from the dialog's history.
    const cur = await getClient().execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
    if (cur.rows.length && n(cur.rows[0].is_opening) === 1 && cur.rows[0].order_id == null) {
      const l = cur.rows[0]
      // Deleting the opening cannot orphan quantity already drawn into
      // purchases — the balance would go negative.
      const avail = await consignmentAvailable(n(l.supplier_id), n(l.product_id))
      if (n(l.qty) > avail + 1e-6) {
        throw new Error(
          `${(n(l.qty) - avail).toFixed(3)} ${l.uom || 'MT'} of this opening is already drawn into purchases — reduce it from the opening dialog instead of deleting`
        )
      }
      await getClient().execute({
        sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
              VALUES (?, ?, ?, 'delete', ?, NULL, ?, ?, ?)`,
        args: [n(l.company_id) || getActiveCompanyId(), n(l.supplier_id), n(l.product_id), n(l.qty), String(l.uom || 'MT'), String(l.deposit_date || ''), l.note ? String(l.note) : null]
      }).catch(() => {})
    }
  }
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
