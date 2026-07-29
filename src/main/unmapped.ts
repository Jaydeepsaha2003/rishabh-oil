// Purchase invoices that are not linked to any bargain — usually because the
// bargain they pointed at was deleted, or because the invoice was entered before
// its bargain existed. They sit in their own list until someone maps them onto
// one or more bargains.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { adjustBargainQty } from './bargains'

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
const EPS = 0.001

export interface MapLine {
  bargain_id: number
  qty: number
  // Raise the bargain's contracted quantity by the shortfall when the
  // allocation is more than its balance (same as a loading overage).
  top_up?: boolean
}

// An invoice is unmapped when the bargain register cannot attribute its
// quantity to a live bargain. For an ordinary invoice that means its tankers:
// gone, or carrying no bargain, or not covering the invoiced quantity — which is
// exactly what is left behind when a bargain deletion takes the tankers with it,
// even though the invoice's own bargain_id still points somewhere valid. For a
// consignment invoice the quantity rides on its logged tankers, or failing that
// on its own bargain_id.
const COVERED = `
  COALESCE((SELECT SUM(pt.loaded_qty) FROM purchase_tankers pt
            JOIN bargains b2 ON b2.id = pt.bargain_id
            WHERE pt.order_id = o.id), 0)`
const UNMAPPED_WHERE = `
  CASE WHEN o.is_consignment = 1 THEN
    (o.bargain_id IS NULL OR NOT EXISTS (SELECT 1 FROM bargains b WHERE b.id = o.bargain_id))
    AND NOT EXISTS (SELECT 1 FROM consignment_stock cs JOIN bargains b3 ON b3.id = cs.bargain_id
                    WHERE cs.order_id = o.id)
  ELSE
    ${COVERED} < o.ordered_qty - 0.001
  END`

export async function listUnmappedOrders(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT o.id, o.invoice_no, o.order_date, o.supplier_id, o.oil_type_id, o.ordered_qty, o.uom,
                 o.bargain_rate, o.invoice_rate, o.adjusted_rate, o.taxable_value, o.net_amount,
                 o.gst_pct, o.is_consignment, o.status, o.bargain_id, o.remarks,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
                 (SELECT COALESCE(SUM(pt.loaded_qty), 0) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_qty,
                 (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos,
                 (SELECT COUNT(*) FROM consignment_stock cs WHERE cs.order_id = o.id) AS lot_count,
                 CASE WHEN o.bargain_id IS NOT NULL THEN 1 ELSE 0 END AS was_linked,
                 COALESCE((SELECT SUM(pt.loaded_qty) FROM purchase_tankers pt
                           JOIN bargains b2 ON b2.id = pt.bargain_id
                           WHERE pt.order_id = o.id), 0) AS covered_qty
          FROM orders o
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ? AND ${UNMAPPED_WHERE}
          ORDER BY o.order_date DESC, o.id DESC`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

export async function unmappedCount(): Promise<number> {
  const res = await getClient().execute({
    sql: `SELECT COUNT(*) AS q FROM orders o WHERE o.company_id = ? AND ${UNMAPPED_WHERE}`,
    args: [getActiveCompanyId()]
  })
  return n(res.rows[0]?.q)
}

// Quantity already committed against a bargain, from every source the register
// counts. Kept local so this module can report a balance without importing the
// full bargain list.
async function bargainBalance(id: number): Promise<{ qty: number; used: number; balance: number }> {
  const r = await getClient().execute({
    sql: `SELECT b.qty,
            COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id), 0)
            + COALESCE((SELECT SUM(o2.ordered_qty) FROM orders o2 WHERE o2.bargain_id = b.id AND o2.is_consignment = 1
                AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.order_id = o2.id)), 0)
            + COALESCE((SELECT SUM(qty - COALESCE(extra_qty, 0)) FROM consignment_stock WHERE bargain_id = b.id AND order_id IS NOT NULL), 0)
            + COALESCE((SELECT SUM(extra_qty) FROM consignment_stock WHERE extra_bargain_id = b.id AND order_id IS NOT NULL), 0)
          AS used
          FROM bargains b WHERE b.id = ? LIMIT 1`,
    args: [id]
  })
  if (!r.rows.length) throw new Error('That bargain no longer exists')
  const qty = n(r.rows[0].qty)
  const used = n(r.rows[0].used)
  return { qty, used, balance: qty - used }
}

// Spread the allocation lines across the carriers (tankers, or consignment
// tankers) in order. A carrier may straddle two lines — the tail goes to its
// extra bargain, exactly as a loaded tanker splits. Three lines on one carrier
// has nowhere to live, so it is refused.
interface Carrier { id: number; qty: number; label: string }
interface CarrierAlloc { id: number; bargain_id: number; extra_bargain_id: number | null; extra_qty: number | null }

function spread(carriers: Carrier[], lines: MapLine[]): CarrierAlloc[] {
  const out: CarrierAlloc[] = []
  let li = 0
  let left = lines.length ? n(lines[0].qty) : 0
  for (const car of carriers) {
    let need = n(car.qty)
    const parts: { bargain_id: number; qty: number }[] = []
    while (need > EPS) {
      while (left <= EPS && li < lines.length - 1) {
        li++
        left = n(lines[li].qty)
      }
      if (left <= EPS) throw new Error('The bargain quantities do not cover every tanker on this invoice')
      const take = Math.min(need, left)
      parts.push({ bargain_id: n(lines[li].bargain_id), qty: take })
      need -= take
      left -= take
    }
    if (parts.length > 2) {
      throw new Error(
        `${car.label} would be split across ${parts.length} bargains — a tanker can hold at most two, so split the invoice differently`
      )
    }
    out.push({
      id: car.id,
      bargain_id: parts[0]?.bargain_id || 0,
      extra_bargain_id: parts[1]?.bargain_id ?? null,
      extra_qty: parts[1] ? parts[1].qty : null
    })
  }
  return out
}

export interface MapResult {
  id: number
  bargain_id: number
  valueDiff: number
  toppedUp: { bargain_no: string; qty: number }[]
}

// Link an unmapped invoice to one or more bargains.
// `force` is required when the bargains' own value does not match the invoice —
// the renderer asks the user first and passes it through.
export async function mapOrderToBargains(
  orderId: number,
  rawLines: unknown,
  force = false
): Promise<MapResult> {
  const c = getClient()
  const ord = await c.execute({ sql: 'SELECT * FROM orders WHERE id = ? LIMIT 1', args: [orderId] })
  if (!ord.rows.length) throw new Error('That purchase invoice no longer exists')
  const order = toPlain(ord)[0]

  // Merge repeated bargains into one line so "add more qty to the same bargain"
  // behaves as a single allocation.
  const merged = new Map<number, MapLine>()
  for (const l of Array.isArray(rawLines) ? rawLines : []) {
    const bid = n((l as MapLine).bargain_id)
    const qty = n((l as MapLine).qty)
    if (!bid || qty <= 0) continue
    const cur = merged.get(bid) || { bargain_id: bid, qty: 0, top_up: false }
    cur.qty += qty
    cur.top_up = cur.top_up || !!(l as MapLine).top_up
    merged.set(bid, cur)
  }
  const lines = Array.from(merged.values())
  if (!lines.length) throw new Error('Add at least one bargain with a quantity')

  const orderedQty = n(order.ordered_qty)
  const allocated = lines.reduce((s, l) => s + l.qty, 0)
  if (Math.abs(allocated - orderedQty) > EPS) {
    throw new Error(
      `The bargain quantities add up to ${allocated.toFixed(3)} but the invoice is for ${orderedQty.toFixed(3)} ${order.uom || 'MT'}`
    )
  }

  // Every bargain must be this supplier's, for this product, and have room.
  const toppedUp: { bargain_no: string; qty: number }[] = []
  let bargainValue = 0
  for (const l of lines) {
    const b = await c.execute({
      sql: 'SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom FROM bargains WHERE id = ? LIMIT 1',
      args: [l.bargain_id]
    })
    if (!b.rows.length) throw new Error('One of the chosen bargains no longer exists')
    const bg = toPlain(b)[0]
    if (n(bg.supplier_id) !== n(order.supplier_id)) {
      throw new Error(`Bargain ${bg.bargain_no} belongs to a different supplier`)
    }
    if (n(bg.oil_type_id) !== n(order.oil_type_id)) {
      throw new Error(`Bargain ${bg.bargain_no} is for a different product`)
    }
    const { balance } = await bargainBalance(l.bargain_id)
    if (l.qty > balance + EPS) {
      const short = l.qty - balance
      if (!l.top_up) {
        throw new Error(
          `Bargain ${bg.bargain_no} has only ${balance.toFixed(3)} ${order.uom || 'MT'} left — ${short.toFixed(3)} short. Tick "add the shortfall to the bargain" to raise it.`
        )
      }
      await adjustBargainQty(
        l.bargain_id,
        short,
        `Raised while mapping invoice ${order.invoice_no}`,
        String(order.order_date)
      )
      toppedUp.push({ bargain_no: String(bg.bargain_no), qty: short })
    }
    bargainValue += n(bg.rate_per_uom) * l.qty
  }

  // What the bargains say this invoice is worth, against what it was booked at.
  const valueDiff = n(order.taxable_value) - bargainValue
  if (Math.abs(valueDiff) > 1 && !force) {
    throw new Error(
      `VALUE_MISMATCH:${valueDiff.toFixed(2)}:${bargainValue.toFixed(2)}:${n(order.taxable_value).toFixed(2)}`
    )
  }

  // Where the allocation lives: the invoice's consignment tankers if it has
  // them, otherwise its purchase tankers, otherwise fresh tanker rows so the
  // bargain register has something to count.
  const isConsignment = n(order.is_consignment) === 1
  if (isConsignment) {
    const lots = await c.execute({
      sql: 'SELECT id, qty, tanker_no FROM consignment_stock WHERE order_id = ? ORDER BY deposit_date, id',
      args: [orderId]
    })
    if (lots.rows.length) {
      const alloc = spread(
        toPlain(lots).map((r) => ({ id: n(r.id), qty: n(r.qty), label: `Tanker ${r.tanker_no || r.id}` })),
        lines
      )
      for (const a of alloc) {
        await c.execute({
          sql: 'UPDATE consignment_stock SET bargain_id = ?, extra_bargain_id = ?, extra_qty = ? WHERE id = ?',
          args: [a.bargain_id, a.extra_bargain_id, a.extra_qty, a.id]
        })
      }
    } else if (lines.length > 1) {
      throw new Error(
        'This consignment invoice has no tankers logged against it, so it can only be mapped to a single bargain'
      )
    }
  } else {
    const tk = await c.execute({
      sql: 'SELECT id, loaded_qty, tanker_no FROM purchase_tankers WHERE order_id = ? ORDER BY loaded_date, id',
      args: [orderId]
    })
    const carriers = toPlain(tk).map((r) => ({
      id: n(r.id),
      qty: n(r.loaded_qty),
      label: `Tanker ${r.tanker_no || r.id}`
    }))
    const covered = carriers.reduce((s, x) => s + x.qty, 0)
    // Nothing (or not enough) to carry the quantity: add a row per remaining
    // line so each bargain's share is recorded against this invoice.
    if (covered < orderedQty - EPS) {
      let short = orderedQty - covered
      // Skip the part the existing tankers already cover.
      let skip = covered
      for (const l of lines) {
        if (short <= EPS) break
        let share = l.qty
        if (skip > EPS) {
          const used = Math.min(skip, share)
          skip -= used
          share -= used
        }
        if (share <= EPS) continue
        const take = Math.min(share, short)
        const res = await c.execute({
          sql: `INSERT INTO purchase_tankers
                  (company_id, order_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id,
                   loaded_qty, received_qty, uom, payment_mode, status, empty_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'we_pay', 'empty', ?)`,
          args: [
            n(order.company_id) || getActiveCompanyId(),
            orderId,
            order.tanker_no ? String(order.tanker_no) : `MAP/${order.invoice_no}`,
            order.order_date,
            l.bargain_id,
            n(order.supplier_id),
            n(order.oil_type_id),
            take,
            take,
            order.uom || 'MT',
            order.order_date
          ]
        })
        carriers.push({ id: Number(res.lastInsertRowid), qty: take, label: `Tanker MAP/${order.invoice_no}` })
        short -= take
      }
    }
    // Re-spread everything so existing tankers also get their bargain.
    const alloc = spread(carriers, lines)
    for (const a of alloc) {
      await c.execute({
        sql: 'UPDATE purchase_tankers SET bargain_id = ?, extra_bargain_id = ?, extra_qty = ? WHERE id = ?',
        // purchase_tankers.extra_qty is NOT NULL, so an unsplit tanker gets 0.
        args: [a.bargain_id, a.extra_bargain_id, a.extra_qty ?? 0, a.id]
      })
    }
  }

  await c.execute({
    sql: 'UPDATE orders SET bargain_id = ? WHERE id = ?',
    args: [lines[0].bargain_id, orderId]
  })
  return { id: orderId, bargain_id: lines[0].bargain_id, valueDiff, toppedUp }
}
