import type { InValue, ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getSetting } from './repos'
import { tankerGateReceived } from './gate'
import { ensureOilType } from './bargains'

const STAGES = [
  'ordered',
  'at_port',
  'payment_cleared',
  'in_transit',
  'outside_factory',
  'inside_factory',
  'received'
]

const TANKER_STAGES = ['supplier_factory', 'loaded', 'transit', 'outside_factory', 'inside_factory', 'empty']

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

// Bargain condition "DLD" (delivered) — supplier bears transport. Accept the
// legacy "Delivered" value too. Anything else (e.g. "EX") is buyer-borne.
function isDelivered(v: unknown): boolean {
  const s = String(v || '').toUpperCase()
  return s === 'DLD' || s === 'DELIVERED'
}

// --- the calculation engine (kept in sync with src/renderer/src/lib/orderCalc.ts) ---
export interface MoneyInput {
  orderedQty: number
  invoiceRate: number
  bargainRate: number
  gstPct: number
  tdsPct: number
  addsInterest: boolean
  interestPct: number
  interestDays: number
  // Slab TDS (cumulative per financial year): base % up to threshold, then above %.
  tdsThreshold?: number
  tdsPctAbove?: number
  tdsPrior?: number // taxable already billed to this party this FY (before this order)
}

// Tiered TDS: the part of `taxable` still under the threshold (given `prior`
// already billed) is taxed at basePct, the rest at abovePct.
function tierTds(
  taxable: number,
  prior: number,
  threshold: number,
  basePct: number,
  abovePct: number
): number {
  if (!threshold || threshold <= 0) return (taxable * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, taxable))
  const above = taxable - below
  return (below * basePct) / 100 + (above * abovePct) / 100
}

// Indian FY (Apr–Mar) date range for the given date.
function fyRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1
  return { start: `${startY}-04-01`, end: `${startY + 1}-03-31` }
}

export async function supplierFyTaxable(
  supplierId: number,
  dateStr: string,
  excludeId: number
): Promise<number> {
  const { start, end } = fyRange(dateStr)
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(taxable_value), 0) AS t FROM orders
          WHERE supplier_id = ? AND order_date BETWEEN ? AND ? AND id != ?`,
    args: [supplierId, start, end, excludeId || 0]
  })
  // Add the "purchase bill amount as on <date>" if that date is in this FY —
  // it seeds the cumulative taxable so the TDS slab picks up from the right point.
  const sup = await c.execute({
    sql: 'SELECT opening_purchase_amount, opening_purchase_date FROM suppliers WHERE id = ?',
    args: [supplierId]
  })
  let opening = 0
  if (sup.rows.length) {
    const od = String(sup.rows[0].opening_purchase_date || '')
    if (od && od >= start && od <= end) opening = Number(sup.rows[0].opening_purchase_amount) || 0
  }
  return (Number(res.rows[0].t) || 0) + opening
}

export interface MoneyResult {
  interest_pct: number
  interest_days: number
  interest_per_unit: number
  adjusted_rate: number
  // Provisional block — on the (interest-adjusted) invoice rate.
  taxable_value: number
  gst_amount: number
  tds_amount: number
  net_amount: number
  // Final block — on the booked bargain rate.
  final_taxable_value: number
  final_gst_amount: number
  final_tds_amount: number
  final_net_amount: number
}

export function computeMoney(i: MoneyInput): MoneyResult {
  const interestPct = i.addsInterest ? i.interestPct : 0
  const interestDays = i.addsInterest ? i.interestDays : 0
  // Interest is computed on the booked (bargain) rate, added to the invoice rate.
  const interestPerUnit = i.bargainRate * (interestPct / 100) * (interestDays / 365)
  const adjustedRate = i.invoiceRate + interestPerUnit

  // Provisional (invoice) block.
  const threshold = i.tdsThreshold || 0
  const abovePct = i.tdsPctAbove || 0
  const prior = i.tdsPrior || 0

  const taxableValue = adjustedRate * i.orderedQty
  const gstAmount = (taxableValue * i.gstPct) / 100
  const tdsAmount = tierTds(taxableValue, prior, threshold, i.tdsPct, abovePct)
  const netAmount = taxableValue + gstAmount - tdsAmount

  // Final (bargain rate) block.
  const finalTaxable = i.bargainRate * i.orderedQty
  const finalGst = (finalTaxable * i.gstPct) / 100
  const finalTds = tierTds(finalTaxable, prior, threshold, i.tdsPct, abovePct)
  const finalNet = finalTaxable + finalGst - finalTds

  return {
    interest_pct: interestPct,
    interest_days: interestDays,
    interest_per_unit: interestPerUnit,
    adjusted_rate: adjustedRate,
    taxable_value: taxableValue,
    gst_amount: gstAmount,
    tds_amount: tdsAmount,
    net_amount: netAmount,
    final_taxable_value: finalTaxable,
    final_gst_amount: finalGst,
    final_tds_amount: finalTds,
    final_net_amount: finalNet
  }
}

async function getSupplier(id: number): Promise<Row | null> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM suppliers WHERE id = ? LIMIT 1',
    args: [id]
  })
  return res.rows.length ? (toPlain(res)[0] as Row) : null
}

// Replace the supplier payable ledger entry for an order.
async function setSupplierPayable(
  orderId: number,
  supplierId: number,
  amount: number,
  date: string
): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'payable'",
    args: [orderId]
  })
  await c.execute({
    sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note)
          VALUES (?, ?, ?, 'payable', ?, 'Order net amount')`,
    args: [supplierId, orderId, date, amount]
  })
}

export async function listOrders(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT o.*,
           s.name AS supplier_name,
           ot.code AS oil_code, ot.name AS oil_name,
           src.name AS source_name,
           t.name AS transporter_name,
           (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
           (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products ot ON ot.id = o.oil_type_id
    LEFT JOIN sources src ON src.id = o.source_id
    LEFT JOIN transporters t ON t.id = o.transporter_id
    ORDER BY o.id DESC
  `)
  return toPlain(res)
}

export async function createOrder(v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), 0)
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n(v.tds_pct),
    addsInterest: !!supplier?.adds_interest,
    interestPct: n(supplier?.interest_pct),
    interestDays: n(supplier?.interest_days),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior
  })
  const res = await getClient().execute({
    sql: `INSERT INTO orders
      (invoice_no, order_date, bargain_id, supplier_id, oil_type_id, bargain_type, ordered_qty, uom,
       bargain_rate, invoice_rate, interest_pct, interest_days, adjusted_rate, taxable_value,
       gst_pct, gst_type, gst_amount, tds_pct, tds_amount, net_amount,
       final_taxable_value, final_gst_amount, final_tds_amount, final_net_amount,
       tanker_no, transporter_id, is_registered_transporter, posting, financed_by_party,
       payment_cleared_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'loaded')`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'EX',
      n(v.ordered_qty),
      v.uom || 'ton',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n(v.transporter_id) : null,
      v.is_registered_transporter ? 1 : 0,
      1,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date
    ]
  })
  const id = Number(res.lastInsertRowid)
  await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id))
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
  return { id }
}

export async function updateOrder(id: number, v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), id)
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n(v.tds_pct),
    addsInterest: !!supplier?.adds_interest,
    interestPct: n(supplier?.interest_pct),
    interestDays: n(supplier?.interest_days),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior
  })
  await getClient().execute({
    sql: `UPDATE orders SET
      invoice_no = ?, order_date = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      ordered_qty = ?, uom = ?, bargain_rate = ?, invoice_rate = ?, interest_pct = ?, interest_days = ?,
      adjusted_rate = ?, taxable_value = ?, gst_pct = ?, gst_type = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, net_amount = ?,
      final_taxable_value = ?, final_gst_amount = ?, final_tds_amount = ?, final_net_amount = ?,
      tanker_no = ?, transporter_id = ?, is_registered_transporter = ?, posting = 1, financed_by_party = ?,
      payment_cleared_date = ?
      WHERE id = ?`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'EX',
      n(v.ordered_qty),
      v.uom || 'ton',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n(v.transporter_id) : null,
      v.is_registered_transporter ? 1 : 0,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date,
      id
    ]
  })
  await getClient().execute({ sql: 'UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?', args: [id] })
  await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id))
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
  return { id }
}

export async function deleteOrder(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM supplier_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] })
  return { id }
}

async function assignTankers(
  orderId: number,
  tankerIds: unknown,
  bargainId: number,
  transporterId: number
): Promise<void> {
  const ids = Array.isArray(tankerIds) ? tankerIds.map(Number).filter((x) => x > 0) : []
  if (!ids.length) throw new Error('Select at least one loaded tanker')
  const c = getClient()
  for (const tankerId of ids) {
    const res = await c.execute({
      sql: 'SELECT order_id, bargain_id FROM purchase_tankers WHERE id = ?',
      args: [tankerId]
    })
    if (!res.rows.length) throw new Error('A selected tanker no longer exists')
    const row = res.rows[0]
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error('A selected tanker is already attached to another purchase')
    }
    if (Number(row.bargain_id) !== bargainId) {
      throw new Error('All tankers on one purchase must belong to the selected bargain')
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET order_id = ?,
            transporter_id = CASE WHEN ? > 0 THEN ? ELSE transporter_id END WHERE id = ?`,
      args: [orderId, transporterId, transporterId, tankerId]
    })
  }
}

export async function listPurchaseTankers(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT pt.*, o.invoice_no, b.bargain_no, b.bargain_type, b.rate_per_uom AS bargain_rate,
           b.allowed_shortage_pct, s.name AS supplier_name,
           p.code AS oil_code, p.name AS oil_name, src.name AS source_name,
           tr.name AS transporter_name
    FROM purchase_tankers pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN products p ON p.id = pt.oil_type_id
    LEFT JOIN sources src ON src.id = pt.source_id
    LEFT JOIN transporters tr ON tr.id = pt.transporter_id
    ORDER BY CASE pt.status
      WHEN 'supplier_factory' THEN 1 WHEN 'loaded' THEN 2 WHEN 'transit' THEN 3
      WHEN 'outside_factory' THEN 4 WHEN 'inside_factory' THEN 5 ELSE 6 END, pt.id DESC
  `)
  return toPlain(res)
}

export async function createPurchaseTanker(v: Row): Promise<{ id: number }> {
  if (!v.tanker_no || !v.bargain_id) throw new Error('Tanker number and bargain are required')
  // Transporter required for EX (buyer arranges transport); optional for DLD.
  if (String(v.condition || 'EX') !== 'DLD' && !v.transporter_id) {
    throw new Error('Select the transporter for this tanker')
  }
  const res = await getClient().execute({
    sql: `INSERT INTO purchase_tankers
      (tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id, loaded_qty, uom, payment_mode,
       transporter_id, status)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?, 'supplier_factory')`,
    args: [
      String(v.tanker_no).trim(),
      v.factory_entry_date || v.loaded_date,
      n(v.bargain_id),
      n(v.supplier_id),
      n(v.oil_type_id),
      v.uom || 'MT',
      v.transporter_id ? n(v.transporter_id) : null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function deletePurchaseTanker(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT order_id FROM purchase_tankers WHERE id = ?', args: [id] })
  if (res.rows[0]?.order_id != null) throw new Error('Remove this tanker from its purchase before deleting it')
  await c.execute({ sql: 'DELETE FROM purchase_tankers WHERE id = ?', args: [id] })
  return { id }
}

async function syncPurchaseFromTankers(orderId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_count,
                 SUM(COALESCE(received_qty, 0)) AS received_qty,
                 SUM(COALESCE(transport_amount, 0)) AS transport_amount,
                 SUM(COALESCE(shortage_charge_amount, 0)) AS shortage_amount
          FROM purchase_tankers WHERE order_id = ?`,
    args: [orderId]
  })
  const x = res.rows[0]
  const status = n(x.total) > 0 && n(x.total) === n(x.empty_count) ? 'received' : 'loaded'
  await c.execute({
    sql: `UPDATE orders SET status = ?, received_qty = ?, transport_amount = ?,
          shortage_charge_amount = ?, received_date = CASE WHEN ? = 'received' THEN date('now') ELSE received_date END
          WHERE id = ?`,
    args: [status, n(x.received_qty), n(x.transport_amount), n(x.shortage_amount), status, orderId]
  })
}

export async function advancePurchaseTanker(id: number, toStatus: string, data: Row): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Tanker not found')
  const tanker = toPlain(res)[0]
  const current = TANKER_STAGES.indexOf(String(tanker.status))
  const target = TANKER_STAGES.indexOf(toStatus)
  if (target !== current + 1) throw new Error('That is not the next tanker stage')

  if (toStatus === 'loaded') {
    const qty = n(data.loaded_qty)
    if (qty <= 0) throw new Error('Enter the actual loaded quantity')
    const balance = await c.execute({
      sql: `SELECT b.qty - COALESCE(
              (SELECT SUM(loaded_qty) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0
            ) AS balance
            FROM bargains b WHERE b.id = ?`,
      args: [id, n(tanker.bargain_id)]
    })
    if (!balance.rows.length || qty > n(balance.rows[0].balance) + 1e-6) {
      throw new Error(`Loaded qty exceeds the bargain balance (${n(balance.rows[0]?.balance).toFixed(3)})`)
    }
    const sourceId = data.source_id ? n(data.source_id) : null
    const transitDate = String(data.loaded_date || '')
    let expected: string | null = null
    if (sourceId && transitDate) {
      const src = await c.execute({ sql: 'SELECT transit_days FROM sources WHERE id = ?', args: [sourceId] })
      const d = new Date(transitDate)
      d.setDate(d.getDate() + n(src.rows[0]?.transit_days))
      expected = d.toISOString().slice(0, 10)
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'transit', loaded_date = ?, loaded_qty = ?,
            payment_mode = ?, transit_date = ?, source_id = ?, expected_delivery_date = ?
            WHERE id = ?`,
      args: [
        data.loaded_date || null,
        qty,
        data.payment_mode === 'supplier_finance' ? 'supplier_finance' : 'paid_by_us',
        transitDate || null,
        sourceId,
        expected,
        id
      ]
    })
  } else if (toStatus === 'transit') {
    const sourceId = data.source_id ? n(data.source_id) : null
    const transitDate = String(data.transit_date || '')
    let expected: string | null = null
    if (sourceId && transitDate) {
      const src = await c.execute({ sql: 'SELECT transit_days FROM sources WHERE id = ?', args: [sourceId] })
      const d = new Date(transitDate)
      d.setDate(d.getDate() + n(src.rows[0]?.transit_days))
      expected = d.toISOString().slice(0, 10)
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'transit', transit_date = ?, source_id = ?,
            expected_delivery_date = ? WHERE id = ?`,
      args: [transitDate || null, sourceId, expected, id]
    })
  } else if (toStatus === 'outside_factory') {
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'outside_factory', outside_factory_date = ? WHERE id = ?",
      args: [data.outside_factory_date || null, id]
    })
  } else if (toStatus === 'inside_factory') {
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'inside_factory', inside_factory_date = ? WHERE id = ?",
      args: [data.inside_factory_date || null, id]
    })
  } else if (toStatus === 'empty') {
    const receivedQty = n(data.received_qty)
    if (receivedQty <= 0 || receivedQty > n(tanker.loaded_qty) + 1e-6) throw new Error('Enter a valid empty quantity')
    // Cross-check against the gate-recorded received quantity for this tanker.
    const gateQty = await tankerGateReceived(id)
    if (gateQty == null) {
      throw new Error('No gate entry found for this tanker. Record the gate receipt first.')
    }
    if (Math.abs(gateQty - receivedQty) > 0.001) {
      throw new Error(
        `Received qty (${receivedQty}) does not match the gate received qty (${gateQty}) for this tanker.`
      )
    }
    const bargain = await c.execute({
      sql: 'SELECT bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?',
      args: [n(tanker.bargain_id)]
    })
    const b = bargain.rows[0] || {}
    const isEx = !isDelivered(b.bargain_type)
    const rate = isEx ? n(data.transport_rate_per_ton) : 0
    const transport = n(tanker.loaded_qty) * rate
    let pct = b.allowed_shortage_pct == null
      ? n((await getSetting('allowed_shortage_pct')) ?? '0')
      : n(b.allowed_shortage_pct)
    const shortage = Math.max(0, n(tanker.loaded_qty) - receivedQty)
    const excess = Math.max(0, shortage - (n(tanker.loaded_qty) * pct) / 100)
    const penalty = isEx ? excess * n(b.rate_per_uom) : 0
    const transporterId = isEx ? n(data.transporter_id) : null
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'empty', empty_date = ?, received_qty = ?,
            transporter_id = ?, transport_rate_per_ton = ?, transport_amount = ?,
            shortage_charge_amount = ?, krfl_weighment_doc_no = ?, krfl_weighment_photo = ?,
            outside_weighment_doc_no = ?, outside_weighment_photo = ? WHERE id = ?`,
      args: [
        data.empty_date || null,
        receivedQty,
        transporterId,
        rate,
        transport,
        penalty,
        data.krfl_weighment_doc_no || null,
        data.krfl_weighment_photo || null,
        data.outside_weighment_doc_no || null,
        data.outside_weighment_photo || null,
        id
      ]
    })
    if (tanker.order_id && transporterId) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger
          (transporter_id, order_id, entry_date, entry_type, amount, note)
          VALUES (?, ?, ?, 'freight', ?, ?)`,
        args: [transporterId, n(tanker.order_id), data.empty_date || null, transport - penalty,
          `Tanker ${tanker.tanker_no}: freight less shortage`]
      })
    }
  }
  if (tanker.order_id) await syncPurchaseFromTankers(n(tanker.order_id))
  return { id }
}

// Advance an order one stage along the tanker lifecycle. Only the immediate
// next stage is allowed (no skipping). The 'received' stage does the weighing,
// shortage and transporter-ledger work.
export async function advanceOrder(
  id: number,
  toStatus: string,
  data: Row
): Promise<{ id: number }> {
  const c = getClient()
  const ordRes = await c.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] })
  if (!ordRes.rows.length) throw new Error('Order not found')
  const order = toPlain(ordRes)[0] as Row

  const ci = STAGES.indexOf(String(order.status))
  const ti = STAGES.indexOf(toStatus)
  if (ti < 0 || ti !== ci + 1) throw new Error('That step is not the next stage for this order')

  const sets: string[] = ['status = ?']
  const args: InValue[] = [toStatus]

  if (toStatus === 'at_port') {
    sets.push('port_entry_date = ?')
    args.push(data.port_entry_date || null)
    if (data.tanker_no !== undefined) {
      sets.push('tanker_no = ?')
      args.push(data.tanker_no || null)
    }
  } else if (toStatus === 'payment_cleared') {
    const financed = !!data.financed_by_party
    const pcDate = (data.payment_cleared_date as string) || null
    // Credit-period interest: charged only on days beyond the credit period, and
    // only for suppliers who DON'T already bill interest in the invoice
    // (adds_interest). Skipped entirely when the party financed it.
    const supplier = await getSupplier(n(order.supplier_id))
    let interestDays = 0
    let interestAmt = 0
    if (
      !financed &&
      supplier &&
      !supplier.adds_interest &&
      n(supplier.interest_pct) > 0 &&
      pcDate &&
      order.order_date
    ) {
      const days = Math.round(
        (new Date(pcDate).getTime() - new Date(String(order.order_date)).getTime()) / 86400000
      )
      interestDays = Math.max(0, days - n(supplier.credit_period_days))
      interestAmt = (n(order.net_amount) * n(supplier.interest_pct) * interestDays) / (100 * 365)
    }
    await c.execute({
      sql: `UPDATE orders SET status = 'payment_cleared', payment_cleared_date = ?, financed_by_party = ?,
            credit_interest_days = ?, credit_interest_amount = ? WHERE id = ?`,
      args: [pcDate, financed ? 1 : 0, interestDays, interestAmt, id]
    })
    await c.execute({
      sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'interest'",
      args: [id]
    })
    if (interestAmt > 0) {
      await c.execute({
        sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note)
              VALUES (?, ?, ?, 'interest', ?, ?)`,
        args: [
          n(order.supplier_id),
          id,
          pcDate,
          interestAmt,
          `Interest for ${interestDays} days beyond credit period`
        ]
      })
    }
    return { id }
  } else if (toStatus === 'in_transit') {
    const sourceId = data.source_id ? Number(data.source_id) : null
    const dispatch = (data.dispatch_date as string) || null
    let expected: string | null = null
    if (sourceId && dispatch) {
      const s = await c.execute({
        sql: 'SELECT transit_days FROM sources WHERE id = ?',
        args: [sourceId]
      })
      const days = s.rows.length ? n(s.rows[0].transit_days) : 0
      const d = new Date(dispatch)
      d.setDate(d.getDate() + days)
      expected = d.toISOString().slice(0, 10)
    }
    sets.push('dispatch_date = ?', 'source_id = ?', 'expected_delivery_date = ?')
    args.push(dispatch, sourceId, expected)
  } else if (toStatus === 'outside_factory') {
    sets.push('outside_factory_date = ?')
    args.push(data.outside_factory_date || null)
  } else if (toStatus === 'inside_factory') {
    sets.push('inside_factory_date = ?')
    args.push(data.inside_factory_date || null)
  } else if (toStatus === 'received') {
    const isEx = !isDelivered(order.bargain_type)
    const orderedQty = n(order.ordered_qty)
    const receivedQty = n(data.received_qty)
    const bargainRate = n(order.bargain_rate)
    const transportRate = isEx ? n(data.transport_rate_per_ton) : 0
    const transportAmount = isEx ? orderedQty * transportRate : 0

    let pct = n((await getSetting('allowed_shortage_pct')) ?? '0')
    if (order.bargain_id) {
      const b = await c.execute({
        sql: 'SELECT allowed_shortage_pct FROM bargains WHERE id = ?',
        args: [Number(order.bargain_id)]
      })
      const bp = b.rows.length ? b.rows[0].allowed_shortage_pct : null
      if (bp != null) pct = Number(bp)
    }
    const allowedQty = (orderedQty * pct) / 100
    const actualShortage = Math.max(0, orderedQty - receivedQty)
    const excessShortage = Math.max(0, actualShortage - allowedQty)
    const shortageCharge = isEx ? excessShortage * bargainRate : 0
    const transporterId = isEx ? n(data.transporter_id) : null

    sets.push(
      'received_date = ?',
      'received_qty = ?',
      'transporter_id = ?',
      'transport_rate_per_ton = ?',
      'transport_amount = ?',
      'allowed_shortage_pct = ?',
      'allowed_shortage_qty = ?',
      'actual_shortage_qty = ?',
      'excess_shortage_qty = ?',
      'shortage_charge_amount = ?'
    )
    args.push(
      data.received_date || null,
      receivedQty,
      transporterId,
      transportRate,
      transportAmount,
      pct,
      allowedQty,
      actualShortage,
      excessShortage,
      shortageCharge
    )
    args.push(id)
    await c.execute({ sql: `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, args })

    await c.execute({
      sql: "DELETE FROM transporter_ledger WHERE order_id = ? AND entry_type IN ('freight','shortage_penalty')",
      args: [id]
    })
    if (isEx && transporterId) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note)
              VALUES (?, ?, ?, 'freight', ?, 'Freight earned')`,
        args: [transporterId, id, data.received_date || null, transportAmount]
      })
      if (shortageCharge > 0) {
        await c.execute({
          sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note)
                VALUES (?, ?, ?, 'shortage_penalty', ?, ?)`,
          args: [
            transporterId,
            id,
            data.received_date || null,
            -shortageCharge,
            `Shortage ${excessShortage.toFixed(3)} ${order.uom} beyond ${pct}% tolerance`
          ]
        })
      }
    }
    return { id }
  }

  args.push(id)
  await c.execute({ sql: `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, args })
  return { id }
}

// --- ledgers ---

export async function listSupplierLedger(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT l.*, s.name AS supplier_name, o.invoice_no
    FROM supplier_ledger l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN orders o ON o.id = l.order_id
    ORDER BY l.id DESC
  `)
  return toPlain(res)
}

export async function listTransporterLedger(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT l.*, t.name AS transporter_name, o.invoice_no
    FROM transporter_ledger l
    LEFT JOIN transporters t ON t.id = l.transporter_id
    LEFT JOIN orders o ON o.id = l.order_id
    ORDER BY l.id DESC
  `)
  return toPlain(res)
}

// Manual ledger entry (opening balance, advance, adjustment) — Tally style.
// Stored signed: credit (we owe the party) positive, debit negative.
export async function addLedgerEntry(d: Row): Promise<{ id: number }> {
  const partyType =
    d.party_type === 'transporter'
      ? 'transporter'
      : d.party_type === 'customer'
        ? 'customer'
        : 'supplier'
  const table =
    partyType === 'supplier'
      ? 'supplier_ledger'
      : partyType === 'transporter'
        ? 'transporter_ledger'
        : 'customer_ledger'
  const col =
    partyType === 'supplier'
      ? 'supplier_id'
      : partyType === 'transporter'
        ? 'transporter_id'
        : 'customer_id'
  const amount = n(d.cr) - n(d.dr)
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${col}, order_id, entry_date, entry_type, amount, note)
          VALUES (?, NULL, ?, ?, ?, ?)`,
    args: [n(d.party_id), d.entry_date, d.entry_type || 'manual', amount, d.note || null]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Only manual entries can be deleted (auto entries are owned by orders/payments).
export async function deleteLedgerEntry(partyType: string, id: number): Promise<{ id: number }> {
  const table =
    partyType === 'transporter'
      ? 'transporter_ledger'
      : partyType === 'customer'
        ? 'customer_ledger'
        : 'supplier_ledger'
  await getClient().execute({
    sql: `DELETE FROM ${table} WHERE id = ? AND entry_type IN ('opening','advance','adjustment','manual','general','dr_note','cr_note')`,
    args: [id]
  })
  return { id }
}

export async function recordSupplierPayment(data: Row): Promise<{ id: number }> {
  const res = await getClient().execute({
    sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note)
          VALUES (?, ?, ?, 'payment', ?, ?)`,
    args: [
      n(data.supplier_id),
      data.order_id ? n(data.order_id) : null,
      data.entry_date,
      -Math.abs(n(data.amount)),
      data.note || 'Payment'
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}
