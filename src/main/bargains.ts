import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
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

// bargains/orders still carry a foreign key to the legacy oil_types table, but
// the app now picks oils from products. Mirror the product row into oil_types
// (same id) so the FK is satisfied for any product chosen.
export async function ensureOilType(productId: number): Promise<void> {
  if (!productId) return
  await getClient().execute({
    sql: `INSERT OR IGNORE INTO oil_types (id, code, name, active)
          SELECT id, COALESCE(code, name, 'GEN'), COALESCE(name, code, 'PRODUCT'), 1
          FROM products WHERE id = ?`,
    args: [productId]
  })
}

// "DD-MM" from an ISO date string. e.g. 2025-06-13 -> "13-06".
function dayMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (m) return `${m[3]}-${m[2]}`
  const d = new Date(dateStr)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function listBargains(from?: string, to?: string): Promise<Row[]> {
  // Bargains are GENERAL — shared across every company, not company-scoped.
  // loaded_qty = total dispatched (received in) across this bargain's tankers +
  // consignment orders; balance = qty − loaded. Period register fields (relative
  // to [from,to]) split that "loaded" by the tanker loaded_date / order_date.
  const f = from || '0000-01-01'
  const t = to || '9999-12-31'
  const res = await getClient().execute({
    sql: `
    SELECT b.*, s.name AS supplier_name, s.supplier_type AS supplier_type,
           br.name AS broker_name,
           o.code AS oil_code, o.name AS oil_name,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob WHERE ob.bargain_id = b.id), 0) AS loaded_qty,
           b.qty
             - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
             - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0)
             - COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob WHERE ob.bargain_id = b.id), 0) AS balance_qty,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND substr(loaded_date, 1, 10) < ?), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND substr(loaded_date, 1, 10) < ?), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id AND substr(o2.order_date, 1, 10) < ?), 0) AS disp_before,
           COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND substr(loaded_date, 1, 10) >= ? AND substr(loaded_date, 1, 10) <= ?), 0)
             + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND substr(loaded_date, 1, 10) >= ? AND substr(loaded_date, 1, 10) <= ?), 0)
             + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id AND substr(o2.order_date, 1, 10) >= ? AND substr(o2.order_date, 1, 10) <= ?), 0) AS disp_period,
           (SELECT MAX(d) FROM (
              SELECT MAX(substr(loaded_date, 1, 10)) AS d FROM purchase_tankers WHERE bargain_id = b.id
              UNION ALL SELECT MAX(substr(loaded_date, 1, 10)) FROM purchase_tankers WHERE extra_bargain_id = b.id
              UNION ALL SELECT MAX(substr(o2.order_date, 1, 10)) FROM order_bargains ob JOIN orders o2 ON o2.id = ob.order_id WHERE ob.bargain_id = b.id
           )) AS last_dispatch_date,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) < ?), 0) AS adj_before,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) >= ? AND substr(adj_date, 1, 10) <= ?), 0) AS adj_in,
           COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'purchase' AND bargain_id = b.id AND substr(adj_date, 1, 10) > ?), 0) AS adj_after
    FROM bargains b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN products o ON o.id = b.oil_type_id
    LEFT JOIN brokers br ON br.id = b.broker_id
    ORDER BY b.id DESC
  `,
    args: [f, f, f, f, t, f, t, f, t, f, f, t, t]
  })
  return toPlain(res)
}

// Format: OIL/DD-MM/PARTYNAME(no spaces, upper)/SERIAL.
// Serial is a continuous running number across all bargains.
async function oilCodeFor(oilTypeId: number): Promise<string> {
  const res = await getClient().execute({ sql: 'SELECT code, name FROM products WHERE id = ?', args: [oilTypeId] })
  return (res.rows.length ? String(res.rows[0].code || res.rows[0].name || 'OIL') : 'OIL')
    .replace(/\s+/g, '')
    .toUpperCase()
}

async function partyNameFor(supplierId: number): Promise<string> {
  const res = await getClient().execute({ sql: 'SELECT name FROM suppliers WHERE id = ?', args: [supplierId] })
  return (res.rows.length ? String(res.rows[0].name || 'PARTY') : 'PARTY')
    .replace(/\s+/g, '')
    .toUpperCase()
}

async function nextBargainNo(
  oilTypeId: number,
  supplierId: number,
  bargainDate: string
): Promise<string> {
  const oil = await oilCodeFor(oilTypeId)
  const party = await partyNameFor(supplierId)

  // Serial resets every calendar month, GLOBAL across all companies (bargains
  // are general): max trailing serial among the month's bargains + 1, 2-digit.
  const monthKey = String(bargainDate).slice(0, 7) // yyyy-mm
  const existing = await getClient().execute({
    sql: 'SELECT bargain_no FROM bargains WHERE substr(bargain_date, 1, 7) = ?',
    args: [monthKey]
  })
  let maxSeq = 0
  for (const r of existing.rows) {
    const parts = String(r.bargain_no).split('/')
    const n = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(n) && n > maxSeq) maxSeq = n
  }
  const serial = String(maxSeq + 1).padStart(2, '0')
  return `${oil}/${dayMonth(bargainDate)}/${party}/${serial}`
}

// Bargain (landed) rate = base rate (ex duty) + customs duty.
function landedRate(v: Row): number {
  return (Number(v.base_rate) || 0) + (Number(v.duty) || 0)
}

// Total quantity already committed against a bargain: loaded on its own
// tankers + excess allocated to it + consignment purchases booked against it.
async function bargainConsumed(id: number): Promise<number> {
  const r = await getClient().execute({
    sql: `SELECT
            COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = ?), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = ?), 0)
            + COALESCE((SELECT SUM(ob.qty) FROM order_bargains ob WHERE ob.bargain_id = ?), 0)
          AS consumed`,
    args: [id, id, id]
  })
  return Number(r.rows[0]?.consumed) || 0
}

// Shared field checks for creating/editing a bargain.
function validateBargainInput(v: Row): { qty: number; rate: number } {
  if (!v.supplier_id) throw new Error('Supplier is required')
  if (!v.oil_type_id) throw new Error('Oil type is required')
  const qty = Number(v.qty) || 0
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const rate = landedRate(v)
  if (rate <= 0) throw new Error('Bargain rate (base + duty) must be greater than zero')
  return { qty, rate }
}

export async function createBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  const { qty, rate } = validateBargainInput(v)
  const total = qty * rate
  const bargain_no = await nextBargainNo(
    Number(v.oil_type_id),
    Number(v.supplier_id),
    String(v.bargain_date)
  )
  // The legacy oil_types FK is still enforced; mirror the chosen product into it.
  await ensureOilType(Number(v.oil_type_id))
  const res = await getClient().execute({
    sql: `INSERT INTO bargains
      (company_id, bargain_no, bargain_date, supplier_id, broker_id, oil_type_id, bargain_type, qty, opening_qty, uom,
       base_rate, duty, rate_per_uom, allowed_shortage_pct, rate_expiry_date, total_amount, remarks, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || 'EX',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'MT',
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== ''
        ? Number(v.allowed_shortage_pct)
        : null,
      v.rate_expiry_date || null,
      total,
      v.remarks ? String(v.remarks).trim() : null
    ]
  })
  return { id: Number(res.lastInsertRowid), bargain_no }
}

export async function updateBargain(id: number, v: Row): Promise<{ id: number; bargain_no: string }> {
  const { qty, rate } = validateBargainInput(v)
  const total = qty * rate
  // Once anything has been loaded/consumed against the bargain, its supplier
  // and oil are locked (linked tankers/purchases depend on them) and the
  // quantity can't drop below what's already committed.
  const cur = await getClient().execute({ sql: 'SELECT bargain_no, supplier_id, oil_type_id FROM bargains WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Bargain not found')
  const consumed = await bargainConsumed(id)
  const supplierChanged = Number(v.supplier_id) !== Number(cur.rows[0].supplier_id)
  const oilChanged = Number(v.oil_type_id) !== Number(cur.rows[0].oil_type_id)
  if (consumed > 1e-6) {
    if (supplierChanged) {
      throw new Error('Cannot change the supplier — this bargain already has loaded tankers or purchases')
    }
    if (oilChanged) {
      throw new Error('Cannot change the oil — this bargain already has loaded tankers or purchases')
    }
    if (qty < consumed - 1e-6) {
      throw new Error(`Quantity cannot be below the ${consumed.toFixed(3)} already loaded/consumed on this bargain`)
    }
  }
  // The bargain number names the party and oil in it (OIL/DD-MM/PARTY/SERIAL)
  // — while nothing has moved yet, changing either would otherwise leave the
  // number silently lying about what the bargain actually is. The date and
  // serial are kept exactly as struck; only the two changed segments update.
  let bargain_no = String(cur.rows[0].bargain_no)
  if (consumed <= 1e-6 && (supplierChanged || oilChanged)) {
    const parts = bargain_no.split('/')
    if (parts.length === 4) {
      const [oldOil, dateSeg, , serialSeg] = parts
      const newOil = oilChanged ? await oilCodeFor(Number(v.oil_type_id)) : oldOil
      const newParty = supplierChanged ? await partyNameFor(Number(v.supplier_id)) : parts[2]
      bargain_no = `${newOil}/${dateSeg}/${newParty}/${serialSeg}`
    }
  }
  await ensureOilType(Number(v.oil_type_id))
  await getClient().execute({
    sql: `UPDATE bargains SET
      bargain_no = ?, bargain_date = ?, supplier_id = ?, broker_id = ?, oil_type_id = ?, bargain_type = ?,
      qty = ?, opening_qty = ?, uom = ?, base_rate = ?, duty = ?, rate_per_uom = ?,
      allowed_shortage_pct = ?, rate_expiry_date = ?, total_amount = ?, remarks = ?
      WHERE id = ?`,
    args: [
      bargain_no,
      v.bargain_date,
      Number(v.supplier_id),
      v.broker_id ? Number(v.broker_id) : null,
      Number(v.oil_type_id),
      v.bargain_type || 'EX',
      qty,
      v.opening_qty != null && v.opening_qty !== '' ? Number(v.opening_qty) : null,
      v.uom || 'MT',
      Number(v.base_rate) || 0,
      Number(v.duty) || 0,
      rate,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== ''
        ? Number(v.allowed_shortage_pct)
        : null,
      v.rate_expiry_date || null,
      total,
      v.remarks ? String(v.remarks).trim() : null,
      id
    ]
  })
  return { id, bargain_no }
}

// Add to (delta > 0) or remove from (delta < 0) a bargain's quantity, which
// moves its open balance by the same amount. Can't drop below what has already
// been loaded / consumed. Keeps total_amount in step with the new quantity.
export async function adjustBargainQty(
  id: number,
  delta: number,
  note?: string,
  date?: string
): Promise<{ id: number; qty: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bargains WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Bargain not found')
  const b = toPlain(res)[0]
  const d = Number(delta) || 0
  if (d === 0) throw new Error('Enter a quantity to add or remove')

  // Rounded to the same 3 decimals qty is stored at — consumed is a SUM()
  // over many tanker/order rows and can carry residue past that, which a
  // 1e-6 tolerance is too tight to absorb.
  const consumed = Math.round((await bargainConsumed(id)) * 1000) / 1000
  const newQty = Math.round((Number(b.qty) + d) * 1000) / 1000
  // Zeroing out a bargain that never loaded anything is a cancellation, not
  // an error — the register already shows 0-balance bargains (toggle "show
  // settled"). Only a genuinely negative result is refused.
  if (newQty < -1e-9) throw new Error('The resulting quantity cannot go below zero')
  if (newQty < consumed - 1e-6) {
    throw new Error(`Cannot remove below the ${consumed.toFixed(3)} already loaded/consumed on this bargain`)
  }
  const rate = Number(b.rate_per_uom) || 0
  const remarks = note ? `${b.remarks ? String(b.remarks) + '\n' : ''}${String(note).trim()}` : b.remarks
  await c.execute({
    sql: 'UPDATE bargains SET qty = ?, total_amount = ?, remarks = ? WHERE id = ?',
    args: [newQty, newQty * rate, remarks || null, id]
  })
  // Dated log so the top-up shows under "Addition" for its month in the register.
  const adjDate = (date && String(date).slice(0, 10)) || todayISO()
  await c.execute({
    sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note) VALUES ('purchase', ?, ?, ?, ?)",
    args: [id, d, adjDate, note ? String(note).trim() : null]
  })
  return { id, qty: newQty }
}

export async function deleteBargain(id: number): Promise<{ id: number }> {
  const c = getClient()
  // Block deletion if any purchase invoice is linked (it carries financial data).
  const ord = await c.execute({
    sql: 'SELECT COUNT(*) AS n FROM orders WHERE bargain_id = ?',
    args: [id]
  })
  if (Number(ord.rows[0].n) > 0) {
    throw new Error('This bargain has purchases linked to it. Delete those purchases first.')
  }
  // A tanker on this bargain may be billed on an invoice booked against a
  // DIFFERENT bargain (e.g. a duplicate bargain, or an excess split). Deleting
  // the bargain must never wipe such a tanker — that would orphan the invoice.
  const billed = await c.execute({
    sql: `SELECT pt.tanker_no, o.invoice_no
          FROM purchase_tankers pt JOIN orders o ON o.id = pt.order_id
          WHERE (pt.bargain_id = ? OR pt.extra_bargain_id = ?) AND pt.order_id IS NOT NULL`,
    args: [id, id]
  })
  if (billed.rows.length) {
    const detail = billed.rows
      .map((r) => `${r.tanker_no || 'tanker'} → invoice ${r.invoice_no || '(no number)'}`)
      .join('; ')
    throw new Error(
      `This bargain has billed tankers linked to it (${detail}). Re-link or delete those purchases first — deleting now would leave the invoice without its tanker.`
    )
  }
  // Clean up loose (unbilled) tankers and their gate entries, then release any
  // excess allocation pointing here, before removing the bargain.
  await c.execute({
    sql: 'DELETE FROM gate_entries WHERE tanker_id IN (SELECT id FROM purchase_tankers WHERE bargain_id = ? AND order_id IS NULL)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM purchase_tankers WHERE bargain_id = ? AND order_id IS NULL', args: [id] })
  await c.execute({
    sql: 'UPDATE purchase_tankers SET extra_bargain_id = NULL, extra_qty = 0 WHERE extra_bargain_id = ?',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM bargain_adjustments WHERE kind = ? AND bargain_id = ?', args: ['purchase', id] })
  await c.execute({ sql: 'DELETE FROM bargains WHERE id = ?', args: [id] })
  return { id }
}
