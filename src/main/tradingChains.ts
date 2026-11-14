// CHAIN TRADING — one parcel passed along several hands, some of them ours.
// ---------------------------------------------------------------------------
// KRFL sells 50 MT to BM, KRFIN buys the same 50 from BM, and KRFIN sells it
// back to KRFL (scenario 1); or the chain opens with a real purchase — BUNGE
// to KRFL — and runs on from there (scenario 2). Each step is a document in
// the books of whichever of our companies stands on it:
//
//   company → party     a sale in the seller's books
//   party   → company   a purchase in the buyer's books
//   company → company   an inter-company sale; the buyer's purchase is raised
//                       with it (intercompany.ts), under the same number
//
// A step either CREATES its invoice here or LINKS one already booked (the
// Bunge purchase with its tanker). What the chain creates is paper only — a
// trading sale/purchase, no stock either way — so only a linked real purchase
// carries goods. Deleting a chain removes what it created; linked invoices
// stay exactly as they were.
import { getClient } from './db'
import { withCompany } from './company'
import { withDbTransaction } from './dbTransaction'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }))

let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS trading_chains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_date TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    uom TEXT NOT NULL DEFAULT 'MT',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS trading_chain_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER NOT NULL,
    step INTEGER NOT NULL,
    seller_kind TEXT NOT NULL,
    seller_id INTEGER NOT NULL,
    buyer_kind TEXT NOT NULL,
    buyer_id INTEGER NOT NULL,
    leg_date TEXT,
    qty REAL NOT NULL DEFAULT 0,
    rate REAL NOT NULL DEFAULT 0,
    gst_pct REAL NOT NULL DEFAULT 0,
    invoice_no TEXT,
    sale_group TEXT,
    sale_company_id INTEGER,
    order_id INTEGER,
    order_company_id INTEGER,
    linked INTEGER NOT NULL DEFAULT 0
  )`)
  await c.execute('CREATE INDEX IF NOT EXISTS idx_tcl_chain ON trading_chain_legs(chain_id)')
  ready = true
}

type Leg = {
  seller_kind: 'company' | 'party'
  seller_id: number
  buyer_kind: 'company' | 'party'
  buyer_id: number
  leg_date: string
  qty: number
  rate: number
  gst_pct: number
  invoice_no: string
  // Link an invoice already booked instead of creating one.
  existing_sale_group?: string
  existing_order_id?: number
}

async function companyName(id: number): Promise<string> {
  const r = await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [id] })
  return s((r.rows[0] as unknown as Row)?.name)
}

// Same state → CGST+SGST, else IGST. Unknown state on either side → IGST.
const gstTypeOf = (a: unknown, b: unknown): 'IGST' | 'CGST_SGST' =>
  s(a).trim() && s(a).trim().toUpperCase() === s(b).trim().toUpperCase() ? 'CGST_SGST' : 'IGST'

function readLegs(v: Row): Leg[] {
  const raw: Row[] = Array.isArray(v.legs) ? v.legs : []
  const legs = raw.map((l, i): Leg => {
    const k = `Step ${i + 1}`
    const sk = l.seller_kind === 'party' ? 'party' : 'company'
    const bk = l.buyer_kind === 'party' ? 'party' : 'company'
    const leg: Leg = {
      seller_kind: sk,
      seller_id: n(l.seller_id),
      buyer_kind: bk,
      buyer_id: n(l.buyer_id),
      leg_date: s(l.leg_date || v.chain_date).slice(0, 10),
      qty: r3(n(l.qty)),
      rate: n(l.rate),
      gst_pct: n(l.gst_pct),
      invoice_no: s(l.invoice_no).trim(),
      existing_sale_group: s(l.existing_sale_group).trim() || undefined,
      existing_order_id: n(l.existing_order_id) || undefined
    }
    if (!leg.seller_id) throw new Error(`${k}: pick who sells`)
    if (!leg.buyer_id) throw new Error(`${k}: pick who buys`)
    if (sk === 'party' && bk === 'party') throw new Error(`${k}: one side must be one of our companies`)
    if (sk === 'company' && bk === 'company' && leg.seller_id === leg.buyer_id) throw new Error(`${k}: a company cannot sell to itself`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leg.leg_date)) throw new Error(`${k}: pick the date`)
    const linking = leg.existing_sale_group || leg.existing_order_id
    if (!linking) {
      if (!(leg.qty > 0)) throw new Error(`${k}: enter the quantity`)
      if (!(leg.rate > 0)) throw new Error(`${k}: enter the rate`)
      if (!leg.invoice_no) throw new Error(`${k}: enter the invoice number`)
    }
    return leg
  })
  if (!legs.length) throw new Error('Add at least one step to the chain')
  return legs
}

/** Customer standing for one of our companies (inter-company sale). */
async function linkCustomer(companyId: number): Promise<Row> {
  const c = getClient()
  const q = async (): Promise<Row | undefined> =>
    (await c.execute({ sql: 'SELECT id, name FROM customers WHERE company_link_id = ? LIMIT 1', args: [companyId] })).rows[0] as unknown as Row | undefined
  let cu = await q()
  if (!cu) {
    const { ensureCompanyParties } = await import('./intercompany')
    await ensureCompanyParties()
    cu = await q()
  }
  if (!cu) throw new Error(`No customer record stands for ${await companyName(companyId)}`)
  return cu
}

// Raise one step's documents. Returns what to store on the leg.
async function raiseLeg(leg: Leg, productId: number, uom: string, step: number): Promise<Row> {
  const c = getClient()
  const k = `Step ${step}`
  if (leg.seller_kind === 'company') {
    const seller = leg.seller_id
    let customer: Row
    let buyerState = ''
    if (leg.buyer_kind === 'company') {
      customer = await linkCustomer(leg.buyer_id)
      buyerState = s(((await c.execute({ sql: 'SELECT state FROM companies WHERE id = ?', args: [leg.buyer_id] })).rows[0] as unknown as Row)?.state)
    } else {
      const cu = (await c.execute({ sql: 'SELECT id, name, state FROM customers WHERE id = ?', args: [leg.buyer_id] })).rows[0] as unknown as Row | undefined
      if (!cu) throw new Error(`${k}: that customer no longer exists`)
      customer = cu
      buyerState = s(cu.state)
    }
    const sellerState = s(((await c.execute({ sql: 'SELECT state FROM companies WHERE id = ?', args: [seller] })).rows[0] as unknown as Row)?.state)
    const { createSaleInvoice } = await import('./sales')
    const res = await withCompany(seller, () =>
      createSaleInvoice({
        sale_date: leg.leg_date,
        invoice_no: leg.invoice_no,
        customer: s(customer.name),
        customer_id: n(customer.id),
        freight_term: 'EX',
        // Paper only: no stock leaves the seller, and the buyer's paired
        // purchase (inter-company) lands in no tank either.
        is_trading: true,
        purchase_invoice_no: leg.invoice_no,
        note: `Chain trading — step ${step}`,
        items: [
          {
            product_id: productId,
            sale_type: 'LOOSE',
            qty: leg.qty,
            uom,
            rate: leg.rate,
            gst_pct: leg.gst_pct,
            gst_type: gstTypeOf(sellerState, buyerState),
            paired_is_trading: true
          }
        ]
      })
    )
    let orderId: number | null = null
    let orderCompany: number | null = null
    if (leg.buyer_kind === 'company') {
      const o = (await c.execute({
        sql: `SELECT id FROM orders WHERE intercompany_sale_id IN (${res.ids.map(() => '?').join(',')}) LIMIT 1`,
        args: res.ids
      })).rows[0] as unknown as Row | undefined
      orderId = n(o?.id) || null
      orderCompany = leg.buyer_id
    }
    return { sale_group: res.group, sale_company_id: seller, order_id: orderId, order_company_id: orderCompany }
  }
  // party → company: a purchase in the buyer's books.
  const sup = (await c.execute({ sql: 'SELECT id, name, state, tds_pct FROM suppliers WHERE id = ?', args: [leg.seller_id] })).rows[0] as unknown as Row | undefined
  if (!sup) throw new Error(`${k}: that supplier no longer exists`)
  const buyerState = s(((await c.execute({ sql: 'SELECT state FROM companies WHERE id = ?', args: [leg.buyer_id] })).rows[0] as unknown as Row)?.state)
  const { createOrder } = await import('./orders')
  const res = await withCompany(leg.buyer_id, () =>
    createOrder({
      is_trading: true,
      company_id: leg.buyer_id,
      invoice_no: leg.invoice_no,
      order_date: leg.leg_date,
      supplier_id: n(sup.id),
      oil_type_id: productId,
      ordered_qty: leg.qty,
      uom,
      invoice_rate: leg.rate,
      bargain_rate: leg.rate,
      gst_pct: leg.gst_pct,
      gst_type: gstTypeOf(sup.state, buyerState),
      tds_pct: n(sup.tds_pct),
      round_off: 0,
      charge_interest: false
    })
  )
  return { sale_group: null, sale_company_id: null, order_id: n(res.id), order_company_id: leg.buyer_id }
}

// A linked step: check the invoice is what the step says, and read its figures.
async function linkLeg(leg: Leg, step: number): Promise<Row> {
  const c = getClient()
  const k = `Step ${step}`
  if (leg.existing_sale_group) {
    if (leg.seller_kind !== 'company') throw new Error(`${k}: only one of our companies' sales can be linked`)
    const rows = plain(
      (await c.execute({ sql: 'SELECT id, company_id, invoice_no, sale_date, qty, rate FROM sales WHERE invoice_group = ?', args: [leg.existing_sale_group] })).rows
    )
    if (!rows.length) throw new Error(`${k}: that sale invoice no longer exists`)
    if (n(rows[0].company_id) !== leg.seller_id) throw new Error(`${k}: that sale is in another company's books`)
    const qty = rows.reduce((t, r) => t + n(r.qty), 0)
    let orderId: number | null = null
    if (leg.buyer_kind === 'company') {
      const o = (await c.execute({ sql: `SELECT id FROM orders WHERE intercompany_sale_id IN (${rows.map((r) => n(r.id)).join(',')}) LIMIT 1`, args: [] })).rows[0] as unknown as Row | undefined
      orderId = n(o?.id) || null
    }
    return {
      sale_group: leg.existing_sale_group,
      sale_company_id: leg.seller_id,
      order_id: orderId,
      order_company_id: leg.buyer_kind === 'company' ? leg.buyer_id : null,
      invoice_no: s(rows[0].invoice_no),
      leg_date: s(rows[0].sale_date).slice(0, 10),
      qty: r3(qty),
      rate: n(rows[0].rate)
    }
  }
  const o = (await c.execute({ sql: 'SELECT id, company_id, invoice_no, order_date, ordered_qty, invoice_rate FROM orders WHERE id = ?', args: [n(leg.existing_order_id)] }))
    .rows[0] as unknown as Row | undefined
  if (!o) throw new Error(`${k}: that purchase invoice no longer exists`)
  if (leg.buyer_kind !== 'company' || n(o.company_id) !== leg.buyer_id) throw new Error(`${k}: that purchase is in another company's books`)
  return {
    sale_group: null,
    sale_company_id: null,
    order_id: n(o.id),
    order_company_id: leg.buyer_id,
    invoice_no: s(o.invoice_no),
    leg_date: s(o.order_date).slice(0, 10),
    qty: r3(n(o.ordered_qty)),
    rate: n(o.invoice_rate)
  }
}

export async function createTradingChain(v: Row): Promise<{ id: number }> {
  await ensure()
  const productId = n(v.product_id)
  if (!productId) throw new Error('Pick the product')
  const chainDate = s(v.chain_date).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chainDate)) throw new Error('Pick the chain date')
  const uom = s(v.uom || 'MT')
  const legs = readLegs(v)
  return withDbTransaction(async () => {
    const c = getClient()
    const ins = await c.execute({
      sql: 'INSERT INTO trading_chains (chain_date, product_id, qty, uom, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [chainDate, productId, r3(n(v.qty)), uom, s(v.note).trim() || null, getCurrentUser().username || null]
    })
    const chainId = Number(ins.lastInsertRowid)
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]
      const linked = !!(leg.existing_sale_group || leg.existing_order_id)
      const got = linked ? await linkLeg(leg, i + 1) : await raiseLeg(leg, productId, uom, i + 1)
      await c.execute({
        sql: `INSERT INTO trading_chain_legs (chain_id, step, seller_kind, seller_id, buyer_kind, buyer_id, leg_date, qty, rate, gst_pct, invoice_no,
                sale_group, sale_company_id, order_id, order_company_id, linked)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          chainId,
          i + 1,
          leg.seller_kind,
          leg.seller_id,
          leg.buyer_kind,
          leg.buyer_id,
          s(got.leg_date ?? leg.leg_date),
          n(got.qty ?? leg.qty),
          n(got.rate ?? leg.rate),
          leg.gst_pct,
          s(got.invoice_no ?? leg.invoice_no) || null,
          got.sale_group ?? null,
          got.sale_company_id ?? null,
          got.order_id ?? null,
          got.order_company_id ?? null,
          linked ? 1 : 0
        ]
      })
    }
    return { id: chainId }
  })
}

export async function deleteTradingChain(id: number): Promise<{ id: number }> {
  await ensure()
  return withDbTransaction(async () => {
    const c = getClient()
    const legs = plain((await c.execute({ sql: 'SELECT * FROM trading_chain_legs WHERE chain_id = ? ORDER BY step DESC', args: [n(id)] })).rows)
    const { deleteSaleInvoice } = await import('./sales')
    const { deleteOrder } = await import('./orders')
    for (const l of legs) {
      if (n(l.linked)) continue
      // An inter-company sale takes its paired purchase with it.
      if (s(l.sale_group)) await withCompany(n(l.sale_company_id), () => deleteSaleInvoice(s(l.sale_group)))
      else if (n(l.order_id)) await withCompany(n(l.order_company_id), () => deleteOrder(n(l.order_id)).then(() => undefined))
    }
    await c.execute({ sql: 'DELETE FROM trading_chain_legs WHERE chain_id = ?', args: [n(id)] })
    await c.execute({ sql: 'DELETE FROM trading_chains WHERE id = ?', args: [n(id)] })
    return { id: n(id) }
  })
}

export async function listTradingChains(): Promise<Row[]> {
  await ensure()
  const c = getClient()
  const chains = plain(
    (await c.execute(`SELECT tc.*, p.name AS product_name, p.code AS product_code FROM trading_chains tc LEFT JOIN products p ON p.id = tc.product_id ORDER BY tc.chain_date DESC, tc.id DESC`)).rows
  )
  if (!chains.length) return []
  const legs = plain((await c.execute(`SELECT * FROM trading_chain_legs WHERE chain_id IN (${chains.map((x) => n(x.id)).join(',')}) ORDER BY chain_id, step`)).rows)
  const companies = new Map(plain((await c.execute('SELECT id, name FROM companies')).rows).map((r) => [n(r.id), s(r.name)]))
  const sup = new Map(plain((await c.execute('SELECT id, name FROM suppliers')).rows).map((r) => [n(r.id), s(r.name)]))
  const cus = new Map(plain((await c.execute('SELECT id, name FROM customers')).rows).map((r) => [n(r.id), s(r.name)]))
  const nameOf = (kind: string, id: number, side: 'seller' | 'buyer'): string =>
    kind === 'company' ? companies.get(id) || `Company ${id}` : (side === 'seller' ? sup.get(id) : cus.get(id)) || `#${id}`
  // A created document can be deleted from its own page; say so rather than
  // show a step that is no longer in the books.
  const saleGroups = new Set(
    plain((await c.execute(`SELECT DISTINCT invoice_group AS g FROM sales WHERE invoice_group IN (SELECT sale_group FROM trading_chain_legs WHERE sale_group IS NOT NULL)`)).rows).map((r) => s(r.g))
  )
  const orderIds = new Set(
    plain((await c.execute(`SELECT id FROM orders WHERE id IN (SELECT order_id FROM trading_chain_legs WHERE order_id IS NOT NULL)`)).rows).map((r) => n(r.id))
  )
  return chains.map((ch) => {
    const mine = legs
      .filter((l) => n(l.chain_id) === n(ch.id))
      .map((l): Row => ({
        ...l,
        seller_name: nameOf(s(l.seller_kind), n(l.seller_id), 'seller'),
        buyer_name: nameOf(s(l.buyer_kind), n(l.buyer_id), 'buyer'),
        missing: (s(l.sale_group) && !saleGroups.has(s(l.sale_group))) || (!s(l.sale_group) && n(l.order_id) && !orderIds.has(n(l.order_id)))
      }))
    // Where each of our companies ends up: + bought, − sold.
    const net = new Map<number, number>()
    for (const l of mine) {
      if (l.seller_kind === 'company') net.set(n(l.seller_id), r3((net.get(n(l.seller_id)) || 0) - n(l.qty)))
      if (l.buyer_kind === 'company') net.set(n(l.buyer_id), r3((net.get(n(l.buyer_id)) || 0) + n(l.qty)))
    }
    return {
      ...ch,
      legs: mine,
      net: [...net.entries()].map(([cid, q]) => ({ company_id: cid, company: companies.get(cid) || `Company ${cid}`, qty: q }))
    }
  })
}

/**
 * Invoices a step can link instead of creating one: the seller company's sales
 * to that buyer, or the buyer company's purchases from that supplier — of the
 * chain's product, not already on another chain.
 */
export async function chainLinkable(v: Row): Promise<Row[]> {
  await ensure()
  const c = getClient()
  const productId = n(v.product_id)
  const sk = v.seller_kind === 'party' ? 'party' : 'company'
  const bk = v.buyer_kind === 'party' ? 'party' : 'company'
  const sid = n(v.seller_id)
  const bid = n(v.buyer_id)
  if (!sid || !bid) return []
  if (sk === 'company') {
    const custId = bk === 'company' ? n((await linkCustomer(bid)).id) : bid
    return plain(
      (await c.execute({
        sql: `SELECT invoice_group AS sale_group, MIN(invoice_no) AS invoice_no, MIN(sale_date) AS date, SUM(qty) AS qty, MIN(rate) AS rate,
                     SUM(amount + gst_amount + round_off) AS amount
                FROM sales
               WHERE company_id = ? AND customer_id = ? AND (? = 0 OR product_id = ?) AND invoice_group IS NOT NULL
                 AND invoice_group NOT IN (SELECT sale_group FROM trading_chain_legs WHERE sale_group IS NOT NULL)
               GROUP BY invoice_group ORDER BY date DESC LIMIT 60`,
        args: [sid, custId, productId, productId]
      })).rows
    )
  }
  return plain(
    (await c.execute({
      sql: `SELECT id AS order_id, invoice_no, order_date AS date, ordered_qty AS qty, invoice_rate AS rate, net_amount AS amount
              FROM orders
             WHERE company_id = ? AND supplier_id = ? AND (? = 0 OR oil_type_id = ?) AND COALESCE(invoice_no, '') != ''
               AND id NOT IN (SELECT order_id FROM trading_chain_legs WHERE order_id IS NOT NULL)
             ORDER BY order_date DESC LIMIT 60`,
      args: [bid, sid, productId, productId]
    })).rows
  )
}
