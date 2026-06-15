import type { InValue, ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getSetting } from './repos'

const STAGES = [
  'ordered',
  'at_port',
  'payment_cleared',
  'in_transit',
  'outside_factory',
  'inside_factory',
  'received'
]

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
  const taxableValue = adjustedRate * i.orderedQty
  const gstAmount = (taxableValue * i.gstPct) / 100
  const tdsAmount = (taxableValue * i.tdsPct) / 100
  const netAmount = taxableValue + gstAmount - tdsAmount

  // Final (bargain rate) block.
  const finalTaxable = i.bargainRate * i.orderedQty
  const finalGst = (finalTaxable * i.gstPct) / 100
  const finalTds = (finalTaxable * i.tdsPct) / 100
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
           t.name AS transporter_name
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN oil_types ot ON ot.id = o.oil_type_id
    LEFT JOIN sources src ON src.id = o.source_id
    LEFT JOIN transporters t ON t.id = o.transporter_id
    ORDER BY o.id DESC
  `)
  return toPlain(res)
}

export async function createOrder(v: Row): Promise<{ id: number }> {
  const supplier = await getSupplier(n(v.supplier_id))
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: n(v.tds_pct),
    addsInterest: !!supplier?.adds_interest,
    interestPct: n(supplier?.interest_pct),
    interestDays: n(supplier?.interest_days)
  })
  const res = await getClient().execute({
    sql: `INSERT INTO orders
      (invoice_no, order_date, bargain_id, supplier_id, oil_type_id, bargain_type, ordered_qty, uom,
       bargain_rate, invoice_rate, interest_pct, interest_days, adjusted_rate, taxable_value,
       gst_pct, gst_amount, tds_pct, tds_amount, net_amount,
       final_taxable_value, final_gst_amount, final_tds_amount, final_net_amount,
       tanker_no, is_registered_transporter, posting, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered')`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'Ex',
      n(v.ordered_qty),
      v.uom || 'ton',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.is_registered_transporter ? 1 : 0,
      v.posting ? 1 : 0
    ]
  })
  const id = Number(res.lastInsertRowid)
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
  return { id }
}

export async function updateOrder(id: number, v: Row): Promise<{ id: number }> {
  const supplier = await getSupplier(n(v.supplier_id))
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: n(v.tds_pct),
    addsInterest: !!supplier?.adds_interest,
    interestPct: n(supplier?.interest_pct),
    interestDays: n(supplier?.interest_days)
  })
  await getClient().execute({
    sql: `UPDATE orders SET
      invoice_no = ?, order_date = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      ordered_qty = ?, uom = ?, bargain_rate = ?, invoice_rate = ?, interest_pct = ?, interest_days = ?,
      adjusted_rate = ?, taxable_value = ?, gst_pct = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, net_amount = ?,
      final_taxable_value = ?, final_gst_amount = ?, final_tds_amount = ?, final_net_amount = ?,
      tanker_no = ?, is_registered_transporter = ?, posting = ?
      WHERE id = ?`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'Ex',
      n(v.ordered_qty),
      v.uom || 'ton',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      m.net_amount,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.is_registered_transporter ? 1 : 0,
      v.posting ? 1 : 0,
      id
    ]
  })
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
  return { id }
}

export async function deleteOrder(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM supplier_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] })
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
    sets.push('payment_cleared_date = ?', 'financed_by_party = ?')
    args.push(data.payment_cleared_date || null, data.financed_by_party ? 1 : 0)
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
    const isEx = (order.bargain_type || 'Ex') !== 'Delivered'
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
