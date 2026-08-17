import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { createOrder, updateOrder, deleteOrder } from './orders'
import { createSale, updateSale, deleteSale } from './sales'

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
const round2 = (v: number): number => Math.round(v * 100) / 100

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

// Which orders/sales make up each deal. A deal booked before multi-invoice
// existed has no link rows, so it falls back to its own order_id / sale_id —
// nothing about those older deals is rewritten to make them fit.
async function dealLineIds(
  dealIds: number[],
  deals: Row[]
): Promise<{ orders: Map<number, number[]>; sales: Map<number, number[]> }> {
  const orders = new Map<number, number[]>()
  const sales = new Map<number, number[]>()
  if (!dealIds.length) return { orders, sales }
  const c = getClient()
  const list = dealIds.join(',')
  const [oRes, sRes] = await Promise.all([
    c.execute(`SELECT deal_id, order_id FROM trading_deal_orders WHERE deal_id IN (${list}) ORDER BY line_no, id`),
    c.execute(`SELECT deal_id, sale_id FROM trading_deal_sales WHERE deal_id IN (${list}) ORDER BY line_no, id`)
  ])
  for (const r of toPlain(oRes)) {
    const k = n(r.deal_id)
    orders.set(k, [...(orders.get(k) ?? []), n(r.order_id)])
  }
  for (const r of toPlain(sRes)) {
    const k = n(r.deal_id)
    sales.set(k, [...(sales.get(k) ?? []), n(r.sale_id)])
  }
  for (const d of deals) {
    const id = n(d.id)
    if (!orders.has(id) && n(d.order_id)) orders.set(id, [n(d.order_id)])
    if (!sales.has(id) && n(d.sale_id)) sales.set(id, [n(d.sale_id)])
  }
  return { orders, sales }
}

async function fetchOrderLines(ids: number[]): Promise<Map<number, Row>> {
  const m = new Map<number, Row>()
  if (!ids.length) return m
  const res = await getClient().execute(
    `SELECT o.id, o.invoice_no, o.order_date, o.invoice_rate, o.ordered_qty, o.uom,
            o.taxable_value, o.gst_amount, o.gst_pct, o.gst_type, o.tds_pct, o.tds_amount,
            o.round_off, o.net_amount, o.supplier_id, s.name AS supplier_name
     FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
     WHERE o.id IN (${ids.join(',')})`
  )
  for (const r of toPlain(res)) m.set(n(r.id), r)
  return m
}

async function fetchSaleLines(ids: number[]): Promise<Map<number, Row>> {
  const m = new Map<number, Row>()
  if (!ids.length) return m
  const res = await getClient().execute(
    `SELECT sl.id, sl.invoice_no, sl.invoice_group, sl.sale_date, sl.rate, sl.qty, sl.uom, sl.amount,
            sl.gst_pct, sl.gst_type, sl.gst_amount, sl.round_off, sl.tds_pct, sl.tds_amount,
            sl.customer_id, cu.name AS customer_name
     FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id
     WHERE sl.id IN (${ids.join(',')})`
  )
  for (const r of toPlain(res)) m.set(n(r.id), r)
  return m
}

// What a Trading sale invoice is actually keyed by for a bank Receipt's
// "Agst Ref" allocation — same rule listPendingRefs() uses for every other
// sale: the invoice_group when the invoice spans several `sales` rows, its
// own invoice_no otherwise.
function saleRefKey(l: Row): string {
  return String(l.invoice_group || l.invoice_no || '').trim()
}

// Every rupee a Receipt voucher has actually allocated against a sale ref,
// summed once for the whole company rather than per-deal — a deal's sale
// side can then just look its own keys up in this map.
async function saleReceiptsByKey(companyId: number): Promise<Map<string, number>> {
  const res = await getClient().execute({
    sql: `SELECT COALESCE(ba.sale_invoice_group, ba.ref_name) AS key, SUM(ba.amount) AS amount
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.method = 'agst_ref' AND je.company_id = ? AND COALESCE(ba.sale_invoice_group, ba.ref_name) IS NOT NULL
          GROUP BY key`,
    args: [companyId]
  })
  const m = new Map<string, number>()
  for (const r of toPlain(res)) m.set(String(r.key), n(r.amount))
  return m
}

export async function listTradingDeals(): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT td.*, p.code AS product_code, p.name AS product_name,
                 l.lc_no AS lc_no, l.stage AS lc_stage, l.preclosed_date AS lc_preclosed_date,
                 l.expiry_date AS lc_expiry_date, l.amount AS lc_amount
          FROM trading_deals td
          LEFT JOIN products p ON p.id = td.product_id
          LEFT JOIN letters_of_credit l ON l.id = td.lc_id
          WHERE td.company_id = ?
          ORDER BY td.deal_date DESC, td.id DESC`,
    args: [cid]
  })
  const deals = toPlain(res)
  const dealIds = deals.map((d) => n(d.id)).filter(Boolean)
  const { orders, sales } = await dealLineIds(dealIds, deals)
  const [orderRows, saleRows, receiptsByKey] = await Promise.all([
    fetchOrderLines(Array.from(new Set(Array.from(orders.values()).flat()))),
    fetchSaleLines(Array.from(new Set(Array.from(sales.values()).flat()))),
    saleReceiptsByKey(cid)
  ])

  return deals.map((d) => {
    const id = n(d.id)
    const pLines = (orders.get(id) ?? []).map((oid) => orderRows.get(oid)).filter(Boolean) as Row[]
    const sLines = (sales.get(id) ?? []).map((sid) => saleRows.get(sid)).filter(Boolean) as Row[]

    const purchaseQty = pLines.reduce((s, l) => s + n(l.ordered_qty), 0)
    const saleQty = sLines.reduce((s, l) => s + n(l.qty), 0)
    const purchaseTotal = pLines.reduce(
      (s, l) => s + n(l.taxable_value) + n(l.gst_amount) + n(l.round_off),
      0
    )
    const saleNet = sLines.reduce((s, l) => s + n(l.amount) + n(l.gst_amount) + n(l.round_off), 0)
    // Margin is the profit on the trade itself — struck on taxable value on
    // both sides, not the tax-inclusive totals. GST is a pass-through (input
    // credit vs. output liability) and round-off is a rupee-rounding artifact;
    // neither is part of what was actually earned buying and reselling the goods.
    const purchaseTaxable = pLines.reduce((s, l) => s + n(l.taxable_value), 0)
    const saleTaxable = sLines.reduce((s, l) => s + n(l.amount), 0)
    const marginOnTaxable = round2(saleTaxable - purchaseTaxable)
    const marginPct = purchaseTaxable > 0 ? round2((marginOnTaxable / purchaseTaxable) * 100) : 0
    const first = pLines[0] ?? {}
    const firstSale = sLines[0] ?? {}
    // Several invoices at different rates have no single rate, so the list
    // shows what the deal actually averaged.
    const avg = (total: number, qty: number): number => (qty > 0 ? total / qty : 0)
    // What the customer actually pays after withholding TDS, and how much of
    // that has actually come back through the bank — a Receipt voucher
    // allocated (Agst Ref) against this deal's own sale invoice(s).
    const saleNetReceivable = round2(saleNet - sLines.reduce((s, l) => s + n(l.tds_amount), 0))
    const saleKeys = Array.from(new Set(sLines.map((l) => saleRefKey(l)).filter(Boolean)))
    const salePaid = round2(saleKeys.reduce((s, k) => s + (receiptsByKey.get(k) || 0), 0))
    const saleFullyPaid = saleNetReceivable > 0.005 && salePaid >= saleNetReceivable - 0.005
    // The bank side of a Trading LC closes the same way any LC does — repaid
    // at maturity or preclosed early — both of which stamp preclosed_date.
    const lcBankRepaid = !!d.lc_preclosed_date

    return {
      ...d,
      purchase_lines: pLines.map((l) => ({
        order_id: n(l.id),
        invoice_no: l.invoice_no ?? '',
        qty: n(l.ordered_qty),
        rate: n(l.invoice_rate)
      })),
      sale_lines: sLines.map((l) => ({
        sale_id: n(l.id),
        invoice_no: l.invoice_no ?? '',
        qty: n(l.qty),
        rate: n(l.rate)
      })),
      purchase_count: pLines.length,
      sale_count: sLines.length,
      purchase_invoice_no: first.invoice_no ?? '',
      sale_invoice_no: firstSale.invoice_no ?? '',
      purchase_qty: purchaseQty,
      sale_qty: saleQty,
      purchase_uom: first.uom || 'MT',
      purchase_rate: avg(pLines.reduce((s, l) => s + n(l.ordered_qty) * n(l.invoice_rate), 0), purchaseQty),
      sale_rate: avg(sLines.reduce((s, l) => s + n(l.qty) * n(l.rate), 0), saleQty),
      supplier_id: first.supplier_id ?? null,
      supplier_name: first.supplier_name ?? null,
      customer_id: firstSale.customer_id ?? null,
      customer_name: firstSale.customer_name ?? null,
      purchase_gst_pct: n(first.gst_pct),
      purchase_gst_type: first.gst_type ?? 'CGST_SGST',
      purchase_tds_pct: n(first.tds_pct),
      purchase_round_off: pLines.reduce((s, l) => s + n(l.round_off), 0),
      sale_gst_pct: n(firstSale.gst_pct),
      sale_gst_type: firstSale.gst_type ?? 'CGST_SGST',
      sale_tds_pct: n(firstSale.tds_pct),
      sale_tds_amount: sLines.reduce((s, l) => s + n(l.tds_amount), 0),
      sale_net_receivable: saleNetReceivable,
      sale_paid: salePaid,
      sale_fully_paid: saleFullyPaid,
      lc_bank_repaid: lcBankRepaid,
      // Both sides of the round trip are done: the bank has been repaid on
      // the LC, and the customer's money for the resale has actually come in.
      trading_lc_closed: !!d.lc_id && lcBankRepaid && saleFullyPaid,
      sale_round_off: sLines.reduce((s, l) => s + n(l.round_off), 0),
      purchase_taxable: pLines.reduce((s, l) => s + n(l.taxable_value), 0),
      purchase_gst_amount: pLines.reduce((s, l) => s + n(l.gst_amount), 0),
      purchase_tds_amount: pLines.reduce((s, l) => s + n(l.tds_amount), 0),
      // What is actually paid to the supplier across every invoice on the deal.
      purchase_net: pLines.reduce((s, l) => s + n(l.net_amount), 0),
      sale_amount: sLines.reduce((s, l) => s + n(l.amount), 0),
      sale_gst_amount: sLines.reduce((s, l) => s + n(l.gst_amount), 0),
      purchase_total: purchaseTotal,
      sale_net: saleNet,
      margin: marginOnTaxable,
      margin_pct: marginPct,
      // Both sides should move the same quantity; the form warns rather than
      // refuses, so a deal can sit part-sold until the rest is invoiced.
      qty_matched: Math.abs(purchaseQty - saleQty) < 1e-6
    }
  })
}

// One typed invoice line on either side of a deal: just a number, a quantity
// and a rate — everything else (party, product, GST, TDS, round-off) is set
// once for the whole deal and applies to every line.
function toLines(raw: unknown, side: 'purchase' | 'sale'): { invoiceNo: string; qty: number; rate: number }[] {
  const arr = Array.isArray(raw) ? raw : []
  const lines = arr
    .map((l) => {
      const r = (l ?? {}) as Row
      return {
        invoiceNo: r.invoice_no ? String(r.invoice_no).trim() : '',
        qty: n(r.qty),
        rate: n(r.rate)
      }
    })
    // A blank trailing row is how the grid always looks mid-entry; drop it
    // rather than failing the save on it.
    .filter((l) => l.invoiceNo !== '' || l.qty !== 0 || l.rate !== 0)
  if (!lines.length) throw new Error(`Add at least one ${side} invoice`)
  lines.forEach((l, i) => {
    const at = `${side === 'purchase' ? 'Purchase' : 'Sale'} invoice ${i + 1}`
    if (l.qty <= 0) throw new Error(`${at}: enter the quantity`)
    if (l.rate <= 0) throw new Error(`${at}: enter the rate`)
  })
  return lines
}

// Shared shape for both create and update — updateOrder/updateSale fully
// recompute from whatever's passed (no merge with the existing row), so the
// complete field set has to be rebuilt every time, not just the changed bits.
function dealFields(v: Row): {
  productId: number
  uom: string
  dealDate: string
  orderPayloads: Row[]
  salePayloads: Row[]
} {
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select the raw product')
  if (!v.supplier_id) throw new Error('Pick the supplier')
  if (!v.customer_id) throw new Error('Pick the customer')
  const uom = String(v.uom || 'MT')
  const dealDate = v.deal_date ? String(v.deal_date).slice(0, 10) : todayISO()

  const purchaseLines = toLines(v.purchase_lines, 'purchase')
  const saleLines = toLines(v.sale_lines, 'sale')
  // The two sides not matching is allowed on purpose (a deal can sit
  // part-sold) — the form shows the difference, and nothing is refused here.

  const orderPayloads = purchaseLines.map((l) => ({
    is_trading: true,
    invoice_no: l.invoiceNo,
    order_date: dealDate,
    supplier_id: n(v.supplier_id),
    oil_type_id: productId,
    ordered_qty: l.qty,
    uom,
    invoice_rate: l.rate,
    bargain_rate: l.rate,
    gst_pct: n(v.purchase_gst_pct),
    gst_type: v.purchase_gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
    tds_pct: n(v.purchase_tds_pct),
    // Round-off is entered once for the deal and belongs to it as a whole, so
    // it rides on the first invoice rather than being repeated on each.
    round_off: 0,
    // A trading deal is a clean pass-through — no interest block here, even
    // if the supplier's master carries a default.
    charge_interest: false
  }))
  if (orderPayloads.length) orderPayloads[0].round_off = n(v.purchase_round_off)

  const salePayloads = saleLines.map((l) => ({
    is_trading: true,
    invoice_no: l.invoiceNo || null,
    sale_date: dealDate,
    customer_id: n(v.customer_id),
    product_id: productId,
    qty: l.qty,
    uom,
    rate: l.rate,
    gst_pct: n(v.sale_gst_pct),
    gst_type: v.sale_gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
    tds_pct: n(v.sale_tds_pct),
    round_off: 0,
    sale_type: 'LOOSE',
    freight_term: 'EX'
  }))
  if (salePayloads.length) salePayloads[0].round_off = n(v.sale_round_off)

  return { productId, uom, dealDate, orderPayloads, salePayloads }
}

export async function createTradingDeal(v: Row): Promise<{ id: number }> {
  const { productId, dealDate, orderPayloads, salePayloads } = dealFields(v)

  // Every invoice on both sides is posted before the deal row exists, so a
  // failure anywhere rolls the whole lot back rather than leaving half a deal
  // behind with no link row to find it by.
  const orderIds: number[] = []
  const saleIds: number[] = []
  const rollback = async (): Promise<void> => {
    for (const sid of saleIds) await deleteSale(sid).catch(() => {})
    for (const oid of orderIds) await deleteOrder(oid).catch(() => {})
  }
  try {
    // Within a side the invoices must post IN ORDER — each one moves the
    // party's year-to-date total, which decides where the next sits on the TDS
    // slab. The two sides are independent of each other though, so they run
    // side by side and the wall-clock is the longer chain, not the sum.
    await Promise.all([
      (async () => {
        for (const p of orderPayloads) orderIds.push((await createOrder(p)).id)
      })(),
      (async () => {
        for (const p of salePayloads) saleIds.push((await createSale(p)).id)
      })()
    ])
  } catch (e) {
    await rollback()
    throw e
  }

  const c = getClient()
  let dealId: number
  try {
    const ins = await c.execute({
      sql: `INSERT INTO trading_deals (company_id, deal_date, product_id, order_id, sale_id, note)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        getActiveCompanyId(),
        dealDate,
        productId,
        orderIds[0],
        saleIds[0],
        v.note ? String(v.note).trim() : null
      ]
    })
    dealId = Number(ins.lastInsertRowid)
    await linkDealLines(dealId, orderIds, saleIds)
  } catch (e) {
    await rollback()
    throw e
  }
  return { id: dealId }
}

// Rewrites which orders/sales belong to a deal. Called after the rows exist.
async function linkDealLines(dealId: number, orderIds: number[], saleIds: number[]): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM trading_deal_orders WHERE deal_id = ?', args: [dealId] })
  await c.execute({ sql: 'DELETE FROM trading_deal_sales WHERE deal_id = ?', args: [dealId] })
  for (let i = 0; i < orderIds.length; i++) {
    await c.execute({
      sql: 'INSERT INTO trading_deal_orders (deal_id, order_id, line_no) VALUES (?, ?, ?)',
      args: [dealId, orderIds[i], i]
    })
  }
  for (let i = 0; i < saleIds.length; i++) {
    await c.execute({
      sql: 'INSERT INTO trading_deal_sales (deal_id, sale_id, line_no) VALUES (?, ?, ?)',
      args: [dealId, saleIds[i], i]
    })
  }
}

export async function updateTradingDeal(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({
    sql: 'SELECT id, order_id, sale_id FROM trading_deals WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Trading deal not found')
  const deal = toPlain(cur)[0]
  const { orders, sales } = await dealLineIds([id], [deal])
  const existingOrders = orders.get(id) ?? []
  const existingSales = sales.get(id) ?? []

  const { productId, dealDate, orderPayloads, salePayloads } = dealFields(v)

  // Existing invoices are reused position by position, so editing a rate or a
  // number keeps the same underlying order/sale (and everything already
  // pointing at it). Only the surplus is created or removed.
  const orderIds: number[] = []
  for (let i = 0; i < orderPayloads.length; i++) {
    if (i < existingOrders.length) {
      await updateOrder(existingOrders[i], orderPayloads[i])
      orderIds.push(existingOrders[i])
    } else {
      orderIds.push((await createOrder(orderPayloads[i])).id)
    }
  }
  const saleIds: number[] = []
  for (let i = 0; i < salePayloads.length; i++) {
    if (i < existingSales.length) {
      await updateSale(existingSales[i], salePayloads[i])
      saleIds.push(existingSales[i])
    } else {
      saleIds.push((await createSale(salePayloads[i])).id)
    }
  }

  await c.execute({
    sql: 'UPDATE trading_deals SET deal_date = ?, product_id = ?, order_id = ?, sale_id = ?, note = ? WHERE id = ?',
    args: [dealDate, productId, orderIds[0], saleIds[0], v.note ? String(v.note).trim() : null, id]
  })
  await linkDealLines(id, orderIds, saleIds)

  // Rows dropped from the grid are removed only after the deal no longer
  // references them, so the foreign key never trips.
  for (const sid of existingSales.slice(salePayloads.length)) await deleteSale(sid)
  for (const oid of existingOrders.slice(orderPayloads.length)) await deleteOrder(oid)
  return { id }
}

// Called from lc.ts on create/update with whichever deal ids own at least one
// invoice the user ticked on this LC. trading_deals.lc_id is now only a soft,
// last-LC-to-touch-an-invoice pointer for legacy display (e.g. Trading.tsx's
// "LC ..." badge) — it is NOT the exclusivity boundary any more, since a
// deal's several invoices can each go to a different LC. The real boundary is
// per-invoice, enforced in lc.ts's syncLinkedOrders against lc_linked_orders.
export async function linkTradingDealsToLc(lcId: number, dealIds: unknown): Promise<void> {
  const c = getClient()
  const ids = Array.isArray(dealIds) ? dealIds.map((x) => n(x)).filter((x) => x > 0) : []
  await c.execute({
    sql: `UPDATE trading_deals SET lc_id = NULL WHERE lc_id = ? AND id NOT IN (${ids.length ? ids.join(',') : '0'})`,
    args: [lcId]
  })
  for (const id of ids) {
    await c.execute({ sql: 'UPDATE trading_deals SET lc_id = ? WHERE id = ?', args: [lcId, id] })
  }
}

export async function deleteTradingDeal(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT id, order_id, sale_id FROM trading_deals WHERE id = ?',
    args: [id]
  })
  if (!res.rows.length) throw new Error('Trading deal not found')
  const deal = toPlain(res)[0]
  const { orders, sales } = await dealLineIds([id], [deal])
  // The link rows reference both — drop them first, or deleting the sale/order
  // they still point to trips the foreign key.
  await c.execute({ sql: 'DELETE FROM trading_deal_orders WHERE deal_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM trading_deal_sales WHERE deal_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM trading_deals WHERE id = ?', args: [id] })
  for (const sid of sales.get(id) ?? []) await deleteSale(sid)
  for (const oid of orders.get(id) ?? []) await deleteOrder(oid)
  return { id }
}
