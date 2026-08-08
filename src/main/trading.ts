import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { createOrder, deleteOrder } from './orders'
import { createSale, deleteSale } from './sales'

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

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Purchase & Sales Trading: a raw-product pass-through — buy from a supplier,
// sell the same quantity straight to a customer, no tanker movement, no stock
// entries. One deal here creates BOTH an `orders` row and a `sales` row (both
// flagged is_trading, which already skips bargains/tankers/stock in that
// existing logic), linked by a `trading_deals` row for a single combined list.
// ---------------------------------------------------------------------------

export async function listTradingDeals(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT td.*, p.code AS product_code, p.name AS product_name,
            o.invoice_no AS purchase_invoice_no, o.invoice_rate AS purchase_rate, o.ordered_qty AS purchase_qty,
            o.uom AS purchase_uom, o.net_amount AS purchase_net, o.supplier_id, s.name AS supplier_name,
            sl.invoice_no AS sale_invoice_no, sl.rate AS sale_rate, sl.qty AS sale_qty,
            sl.amount AS sale_amount, sl.gst_amount AS sale_gst_amount, sl.round_off AS sale_round_off,
            sl.customer_id, cu.name AS customer_name
          FROM trading_deals td
          LEFT JOIN products p ON p.id = td.product_id
          LEFT JOIN orders o ON o.id = td.order_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN sales sl ON sl.id = td.sale_id
          LEFT JOIN customers cu ON cu.id = sl.customer_id
          WHERE td.company_id = ?
          ORDER BY td.deal_date DESC, td.id DESC`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res).map((d) => {
    const saleNet = n(d.sale_amount) + n(d.sale_gst_amount) + n(d.sale_round_off)
    return { ...d, sale_net: saleNet, margin: saleNet - n(d.purchase_net) }
  })
}

export async function createTradingDeal(v: Row): Promise<{ id: number }> {
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select the raw product')
  const qty = n(v.qty)
  if (qty <= 0) throw new Error('Enter the quantity')
  if (!v.supplier_id) throw new Error('Pick the supplier')
  if (!v.customer_id) throw new Error('Pick the customer')
  const purchaseRate = n(v.purchase_rate)
  if (purchaseRate <= 0) throw new Error('Enter the purchase rate')
  const saleRate = n(v.sale_rate)
  if (saleRate <= 0) throw new Error('Enter the sale rate')
  const uom = String(v.uom || 'MT')
  const dealDate = v.deal_date ? String(v.deal_date).slice(0, 10) : todayISO()
  const gstPct = n(v.gst_pct)

  const { id: orderId } = await createOrder({
    is_trading: true,
    invoice_no: v.purchase_invoice_no ? String(v.purchase_invoice_no).trim() : '',
    order_date: dealDate,
    supplier_id: n(v.supplier_id),
    oil_type_id: productId,
    ordered_qty: qty,
    uom,
    invoice_rate: purchaseRate,
    bargain_rate: purchaseRate,
    gst_pct: gstPct,
    tds_pct: 0,
    // The trading form has no interest control — don't let a supplier's
    // default interest terms silently inflate a deal meant to be a clean
    // pass-through.
    charge_interest: false
  })

  let saleId: number
  try {
    const res = await createSale({
      is_trading: true,
      invoice_no: v.sale_invoice_no ? String(v.sale_invoice_no).trim() : null,
      sale_date: dealDate,
      customer_id: n(v.customer_id),
      product_id: productId,
      qty,
      uom,
      rate: saleRate,
      gst_pct: gstPct,
      sale_type: 'LOOSE',
      freight_term: 'EX'
    })
    saleId = res.id
  } catch (e) {
    // The purchase side already posted — don't leave it dangling if the sale
    // side fails validation (e.g. a bad customer/rate).
    await deleteOrder(orderId).catch(() => {})
    throw e
  }

  const c = getClient()
  const ins = await c.execute({
    sql: `INSERT INTO trading_deals (company_id, deal_date, product_id, order_id, sale_id, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [getActiveCompanyId(), dealDate, productId, orderId, saleId, v.note ? String(v.note).trim() : null]
  })
  return { id: Number(ins.lastInsertRowid) }
}

export async function deleteTradingDeal(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT order_id, sale_id FROM trading_deals WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Trading deal not found')
  const row = res.rows[0]
  // The link row references both — drop it first, or deleting the sale/order
  // it still points to trips the foreign key.
  await c.execute({ sql: 'DELETE FROM trading_deals WHERE id = ?', args: [id] })
  if (row.sale_id) await deleteSale(Number(row.sale_id))
  if (row.order_id) await deleteOrder(Number(row.order_id))
  return { id }
}
