import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { assertNoRepeatsWithin, assertPurchaseInvoiceNoFree, assertSalesInvoiceNoFree } from './invoiceno'
import { getActiveCompanyId } from './company'
import { createOrder, updateOrder, deleteOrder } from './orders'
import { createSale, updateSale, deleteSale } from './sales'
import { visibleFromFor } from './access-gate'

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

// The sale side of a deal, grouped by who it was sold to. A deal sells to one
// buyer or to several; either way this is a list, so the caller never has to
// hold two shapes in mind. Buyers come out in the order their first invoice
// was entered, which is the order the form shows them in.
function groupSaleParties(sLines: Row[], receiptsByKey: Map<string, number>): Row[] {
  const order: number[] = []
  const byParty = new Map<number, Row[]>()
  for (const l of sLines) {
    const cid = n(l.customer_id)
    if (!byParty.has(cid)) {
      byParty.set(cid, [])
      order.push(cid)
    }
    ;(byParty.get(cid) as Row[]).push(l)
  }
  return order.map((cid) => {
    const ls = byParty.get(cid) as Row[]
    const first = ls[0] ?? {}
    const qty = ls.reduce((a, l) => a + n(l.qty), 0)
    const taxable = ls.reduce((a, l) => a + n(l.amount), 0)
    const gstAmount = ls.reduce((a, l) => a + n(l.gst_amount), 0)
    const roundOff = ls.reduce((a, l) => a + n(l.round_off), 0)
    const tdsAmount = ls.reduce((a, l) => a + n(l.tds_amount), 0)
    const total = round2(taxable + gstAmount + roundOff)
    // What this buyer owes and what has actually come back through the bank —
    // per buyer, so one party paying up does not read as the deal being settled.
    const keys = Array.from(new Set(ls.map((l) => saleRefKey(l)).filter(Boolean)))
    const netReceivable = round2(total - tdsAmount)
    const paid = round2(keys.reduce((a, k) => a + (receiptsByKey.get(k) || 0), 0))
    return {
      customer_id: cid || null,
      customer_name: first.customer_name ?? null,
      invoice_count: ls.length,
      qty,
      rate: qty > 0 ? ls.reduce((a, l) => a + n(l.qty) * n(l.rate), 0) / qty : 0,
      taxable: round2(taxable),
      gst_pct: n(first.gst_pct),
      gst_type: first.gst_type ?? 'CGST_SGST',
      gst_amount: round2(gstAmount),
      round_off: round2(roundOff),
      total,
      tds_pct: n(first.tds_pct),
      tds_amount: round2(tdsAmount),
      net_receivable: netReceivable,
      paid,
      fully_paid: netReceivable > 0.005 && paid >= netReceivable - 0.005,
      lines: ls.map((l) => ({
        sale_id: n(l.id),
        invoice_no: l.invoice_no ?? '',
        qty: n(l.qty),
        rate: n(l.rate)
      }))
    }
  })
}

export async function listTradingDeals(forModule?: string): Promise<Row[]> {
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const from = await visibleFromFor('trading', forModule)
  const cid = getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT td.*, p.code AS product_code, p.name AS product_name,
                 l.lc_no AS lc_no, l.stage AS lc_stage, l.preclosed_date AS lc_preclosed_date,
                 l.expiry_date AS lc_expiry_date, l.amount AS lc_amount
          FROM trading_deals td
          LEFT JOIN products p ON p.id = td.product_id
          LEFT JOIN letters_of_credit l ON l.id = td.lc_id
          WHERE td.company_id = ?${from ? ' AND td.deal_date >= ?' : ''}
          ORDER BY td.deal_date DESC, td.id DESC`,
    args: from ? [cid, from] : [cid]
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
    // Who the goods went to. One entry when the deal has a single buyer, one
    // per buyer when it was split — every figure below that reads "the
    // customer" is the whole sale side, whether that is one party or five.
    const saleParties = groupSaleParties(sLines, receiptsByKey)
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
        rate: n(l.rate),
        // Which buyer this invoice went to, so a flat list of the deal's sale
        // invoices can still say who each one was raised on.
        customer_id: l.customer_id ?? null,
        customer_name: l.customer_name ?? null
      })),
      sale_parties: saleParties,
      customer_count: saleParties.length,
      // Every buyer's name, for a list column and for search. The singular
      // `customer_name` below stays the FIRST buyer, because that is what the
      // LC and Bill Discounting pickers already read off a deal.
      customer_names: saleParties.map((sp) => sp.customer_name).filter(Boolean),
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

type DealLine = { invoiceNo: string; qty: number; rate: number }

// One typed invoice line: just a number, a quantity and a rate. Product and
// UOM are set once for the whole deal; the party and its GST/TDS are set once
// per SIDE on the purchase side, and once per BUYER on the sale side.
//
// Repeats are NOT checked here. The sale side is several grids now — one per
// buyer — all drawing on the same sale-invoice numbering, so a number used by
// two different buyers is still one number on two documents. The caller checks
// each side as a whole.
function toLines(raw: unknown, at: (i: number) => string, emptyMsg: string): DealLine[] {
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
  if (!lines.length) throw new Error(emptyMsg)
  lines.forEach((l, i) => {
    if (l.qty <= 0) throw new Error(`${at(i)}: enter the quantity`)
    if (l.rate <= 0) throw new Error(`${at(i)}: enter the rate`)
  })
  return lines
}

// One buyer on the sale side: the party, the tax treatment that party's own
// invoices carry, and that party's invoices.
//
// GST and TDS sit HERE and not on the deal because they are properties of the
// party, not of the trade: an out-of-state buyer is IGST while an in-state one
// is CGST+SGST, and each buyer withholds TDS on its own slab. One deal-wide
// rate would tax somebody wrongly the moment a second buyer is added.
type SaleParty = {
  customerId: number
  gstPct: number
  gstType: 'IGST' | 'CGST_SGST'
  tdsPct: number
  roundOff: number
  lines: DealLine[]
}

// The sale side, whichever shape it arrives in.
//
// `sale_parties` is the current shape. A caller that still sends the old
// single-customer shape (`customer_id` + `sale_lines` + `sale_gst_pct`…) is
// read as one buyer holding every line, so nothing that used to save stops
// saving — and a deal booked before this reads back through exactly that path.
function toSaleParties(v: Row): SaleParty[] {
  const raw = Array.isArray(v.sale_parties) ? (v.sale_parties as Row[]) : []
  const groups: Row[] = raw.length
    ? raw
    : [
        {
          customer_id: v.customer_id,
          gst_pct: v.sale_gst_pct,
          gst_type: v.sale_gst_type,
          tds_pct: v.sale_tds_pct,
          round_off: v.sale_round_off,
          lines: v.sale_lines
        }
      ]
  // A buyer card with nothing typed into it at all is the blank one the form
  // leaves waiting; drop it rather than refusing the save on it.
  const live = groups.filter((g) => {
    const ls = Array.isArray(g?.lines) ? (g.lines as Row[]) : []
    const anyLine = ls.some(
      (l) => String(l?.invoice_no ?? '').trim() !== '' || n(l?.qty) !== 0 || n(l?.rate) !== 0
    )
    return n(g?.customer_id) > 0 || anyLine
  })
  if (!live.length) throw new Error('Pick the customer')

  const multi = live.length > 1
  const parties = live.map((g, gi) => {
    const label = multi ? `Buyer ${gi + 1}` : 'Sale'
    if (!n(g?.customer_id)) {
      throw new Error(multi ? `${label}: pick the customer` : 'Pick the customer')
    }
    return {
      customerId: n(g.customer_id),
      gstPct: n(g.gst_pct),
      gstType: g.gst_type === 'IGST' ? ('IGST' as const) : ('CGST_SGST' as const),
      tdsPct: n(g.tds_pct),
      roundOff: n(g.round_off),
      lines: toLines(g.lines, (i) => `${label} invoice ${i + 1}`, `${label}: add at least one sale invoice`)
    }
  })

  // The same buyer entered twice is two half-lists of one party's invoices —
  // its TDS slab and its running total would be split across them. Refused
  // with the fix named, rather than quietly merged behind the user's back.
  const seen = new Set<number>()
  for (const p of parties) {
    if (seen.has(p.customerId)) {
      throw new Error("The same customer is listed twice — put all of that buyer's invoices under one entry")
    }
    seen.add(p.customerId)
  }
  return parties
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
  const uom = String(v.uom || 'MT')
  const dealDate = v.deal_date ? String(v.deal_date).slice(0, 10) : todayISO()

  const purchaseLines = toLines(
    v.purchase_lines,
    (i) => `Purchase invoice ${i + 1}`,
    'Add at least one purchase invoice'
  )
  const saleParties = toSaleParties(v)
  // The two sides not matching is allowed on purpose (a deal can sit
  // part-sold, or be sold on to buyers found one at a time) — the form shows
  // the difference, and nothing is refused here.

  // Each line becomes an invoice of its own, so no two lines on a side can
  // share a number. Checked per side rather than per grid, because the sale
  // side is now one grid per buyer and all of them draw on the same sale
  // numbering. The per-row guards inside createOrder/createSale deliberately
  // overlook the deal's own rows (see invoice_dup_exclude_ids), which leaves
  // this the one repeat they cannot see.
  assertNoRepeatsWithin(purchaseLines.map((l) => l.invoiceNo), 'Purchase invoice')
  assertNoRepeatsWithin(saleParties.flatMap((sp) => sp.lines.map((l) => l.invoiceNo)), 'Invoice')

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

  // Flattened in buyer order, and that order is load-bearing: an update
  // reuses the existing sale rows position by position, so the same flattening
  // on the way back in keeps each invoice on the row it was already on.
  const salePayloads = saleParties.flatMap((sp) =>
    sp.lines.map((l, i) => ({
      is_trading: true,
      invoice_no: l.invoiceNo || null,
      sale_date: dealDate,
      customer_id: sp.customerId,
      product_id: productId,
      qty: l.qty,
      uom,
      rate: l.rate,
      gst_pct: sp.gstPct,
      gst_type: sp.gstType,
      tds_pct: sp.tdsPct,
      // Round off belongs to a buyer's own invoice total, so it rides that
      // buyer's first invoice — not the deal's, which would round one party's
      // bill by another party's paisa.
      round_off: i === 0 ? sp.roundOff : 0,
      sale_type: 'LOOSE',
      freight_term: 'EX'
    }))
  )

  return { productId, uom, dealDate, orderPayloads, salePayloads }
}

// Every invoice number on the deal, checked BEFORE a single row is written.
//
// The per-row guards inside createOrder/createSale are the authority, but they
// fire mid-flight: by the time the third line is refused the first two are
// already posted, and unwinding them is a rollback that has to be perfect. It
// is cheaper and steadier to refuse the deal before it starts.
async function assertDealNumbersFree(
  orderPayloads: Row[],
  salePayloads: Row[],
  ownOrders: number[] = [],
  ownSales: number[] = []
): Promise<void> {
  const cid = getActiveCompanyId()
  for (const p of orderPayloads) {
    await assertPurchaseInvoiceNoFree({ ...p, invoice_dup_exclude_ids: ownOrders }, cid)
  }
  for (const p of salePayloads) {
    await assertSalesInvoiceNoFree({ ...p, invoice_dup_exclude_ids: ownSales }, cid)
  }
}

export async function createTradingDeal(v: Row): Promise<{ id: number }> {
  const { productId, dealDate, orderPayloads, salePayloads } = dealFields(v)
  await assertDealNumbersFree(orderPayloads, salePayloads)

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
    // allSettled, not all. Promise.all rejects the INSTANT one side throws,
    // while the other side is still posting — so the rollback ran against a
    // half-filled id list and the invoices created after it survived. A
    // refused deal left real orders and sales in the books, which is how
    // ZZTEST-T-1 came to exist twice.
    //
    // Both sides are allowed to finish; then, if either failed, everything
    // both of them made is unwound.
    const settled = await Promise.allSettled([
      (async () => {
        for (const p of orderPayloads) orderIds.push((await createOrder(p)).id)
      })(),
      (async () => {
        for (const p of salePayloads) saleIds.push((await createSale(p)).id)
      })()
    ])
    const failed = settled.find((r) => r.status === 'rejected')
    if (failed) throw (failed as PromiseRejectedResult).reason
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
  // The deal's own rows are left out of the duplicate search, because these
  // updates run one line at a time: swapping two lines' invoice numbers would
  // otherwise have the first update collide with the second row's number as it
  // stood a moment earlier — a refusal for a rearrangement that ends up
  // perfectly valid. The lines are checked against each other in toLines
  // instead, so a genuine repeat inside the deal is still refused.
  const ownOrders = [...existingOrders]
  const ownSales = [...existingSales]
  await assertDealNumbersFree(orderPayloads, salePayloads, ownOrders, ownSales)
  const orderIds: number[] = []
  for (let i = 0; i < orderPayloads.length; i++) {
    const p = { ...orderPayloads[i], invoice_dup_exclude_ids: ownOrders }
    if (i < existingOrders.length) {
      await updateOrder(existingOrders[i], p)
      orderIds.push(existingOrders[i])
    } else {
      orderIds.push((await createOrder(p)).id)
    }
  }
  const saleIds: number[] = []
  for (let i = 0; i < salePayloads.length; i++) {
    const p = { ...salePayloads[i], invoice_dup_exclude_ids: ownSales }
    if (i < existingSales.length) {
      await updateSale(existingSales[i], p)
      saleIds.push(existingSales[i])
    } else {
      saleIds.push((await createSale(p)).id)
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
