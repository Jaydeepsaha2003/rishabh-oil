// A TRADING COMPANY'S TANKER IS SOLD ON THE DAY IT IS EMPTIED.
// ---------------------------------------------------------------------------
// KR FINMARK buys oil and does not make anything from it: every tanker it
// takes is sold straight on to one of our manufacturing companies, and the
// oil goes into that company's tanks the moment it is emptied. So emptying a
// trading company's tanker is not finished until it is sold: the buyer and
// the purchase invoice number the buyer books it under are asked there, and
// the sale is raised from the tanker itself — its received quantity, its
// product, on the empty date. The sale is an ordinary inter-company sale
// (sales.ts → intercompany.ts), so the buyer's purchase is raised with it
// under the number given.
//
// The tanker keeps the sale's invoice group, so taking the tanker back from
// Empty takes the sale — and the buyer's purchase — back with it.
import { getClient } from './db'
import { withCompany } from './company'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

let columnsReady = false
async function ensureColumns(): Promise<void> {
  if (columnsReady) return
  for (const col of ['onward_sale_group TEXT', 'onward_company_id INTEGER']) {
    await getClient()
      .execute(`ALTER TABLE purchase_tankers ADD COLUMN ${col}`)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }
  columnsReady = true
}

/**
 * Does this company sell its tankers on at Empty? A Trading company (Companies
 * → Type) with the switch "Sell tankers on at Empty" left on — the default.
 * Turned off, its tankers empty like anybody else's and the sale is raised by
 * hand from Sales, as before.
 */
export async function isTradingCompany(companyId: number): Promise<boolean> {
  if (!n(companyId)) return false
  const r = await getClient()
    .execute({ sql: 'SELECT company_type, onward_sale_at_empty FROM companies WHERE id = ?', args: [n(companyId)] })
    .catch(() => getClient().execute({ sql: 'SELECT company_type, 1 AS onward_sale_at_empty FROM companies WHERE id = ?', args: [n(companyId)] }))
  const row = r.rows[0] as unknown as Row | undefined
  return s(row?.company_type).toLowerCase() === 'trading' && n(row?.onward_sale_at_empty ?? 1) !== 0
}

/** What the Empty step must carry for a trading company's tanker — refused before anything is written. */
export async function assertOnwardSale(tanker: Row, v: Row): Promise<void> {
  if (!(await isTradingCompany(n(tanker.company_id)))) return
  const o = (v?.onward || {}) as Row
  const buyer = n(o.buyer_company_id)
  if (!buyer) throw new Error('This tanker is a trading company\'s — pick the company it is sold to before marking it Empty')
  if (buyer === n(tanker.company_id)) throw new Error('A company cannot sell the tanker to itself — pick the buying company')
  if (!s(o.purchase_invoice_no).trim()) throw new Error('Enter the purchase invoice number the buying company books this tanker under')
  if (!s(o.sale_invoice_no).trim()) throw new Error('Enter the sale invoice number for this tanker')
  if (!(n(o.rate) > 0)) throw new Error('Enter the sale rate per MT')
}

/** Raise the sale for a trading company's tanker just emptied. */
export async function raiseOnwardSale(tankerId: number, v: Row): Promise<void> {
  await ensureColumns()
  const c = getClient()
  const t = (await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [n(tankerId)] })).rows[0] as unknown as Row
  if (!t || !(await isTradingCompany(n(t.company_id)))) return
  if (s(t.onward_sale_group)) return
  const o = (v?.onward || {}) as Row
  const buyer = n(o.buyer_company_id)
  const { ensureCompanyParties } = await import('./intercompany')
  let cust = (await c.execute({ sql: 'SELECT id, name FROM customers WHERE company_link_id = ? LIMIT 1', args: [buyer] })).rows[0] as unknown as Row
  if (!cust) {
    await ensureCompanyParties()
    cust = (await c.execute({ sql: 'SELECT id, name FROM customers WHERE company_link_id = ? LIMIT 1', args: [buyer] })).rows[0] as unknown as Row
  }
  if (!cust) throw new Error('No customer record stands for the buying company')
  // The product: the purchase invoice's, else the bargain's.
  const prod = (
    await c.execute({
      sql: `SELECT COALESCE((SELECT oil_type_id FROM orders WHERE id = ?), (SELECT oil_type_id FROM bargains WHERE id = ?)) AS pid`,
      args: [n(t.order_id), n(t.bargain_id)]
    })
  ).rows[0] as unknown as Row
  const productId = n(prod?.pid)
  if (!productId) throw new Error('This tanker has no product to sell — bill it on a purchase invoice first')
  const qty = n(t.received_qty)
  const date = s(t.empty_date).slice(0, 10)
  const { createSaleInvoice } = await import('./sales')
  const res = await withCompany(n(t.company_id), () =>
    createSaleInvoice({
      sale_date: date,
      invoice_no: s(o.sale_invoice_no).trim(),
      customer: s(cust.name),
      customer_id: n(cust.id),
      // Ex: the goods are handed over at our own gate — nothing to deliver.
      freight_term: 'FREIGHT_ON_GOODS',
      purchase_invoice_no: s(o.purchase_invoice_no).trim(),
      // The oil was never in a finished-goods tank to be checked against; it
      // goes from the tanker into the buyer's.
      force_no_stock: true,
      note: `Tanker ${s(t.tanker_no)} emptied ${date} — sold on`,
      items: [
        {
          product_id: productId,
          sale_type: 'LOOSE',
          qty,
          rate: n(o.rate),
          gst_pct: n(o.gst_pct),
          gst_type: s(o.gst_type) === 'IGST' ? 'IGST' : 'CGST_SGST'
        }
      ]
    })
  )
  await c.execute({
    sql: 'UPDATE purchase_tankers SET onward_sale_group = ?, onward_company_id = ? WHERE id = ?',
    args: [res.group, buyer, n(tankerId)]
  })
  await tagTransfer(o.tags, n(t.company_id), res.group, res.ids, buyer)
}

/**
 * THE BOOK TRANSFER'S TAGS, ON BOTH SIDES OF IT.
 *
 * Asked for in the Empty dialog, beside the buyer and the invoice numbers —
 * the transfer does not exist until Empty, so they are applied here, in the
 * same transaction that raises it. Tags are kept per book, so each name is
 * found (or made) in the seller's book for the sale and in the buyer's book
 * for its paired purchase: one label, read the same on both.
 */
async function tagTransfer(names: unknown, sellerId: number, group: string, saleIds: number[], buyerId: number): Promise<void> {
  const list = Array.from(
    new Set((Array.isArray(names) ? names : []).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
  ).slice(0, 20)
  if (!list.length) return
  const { createTag, ensureTagTables } = await import('./tags')
  await ensureTagTables()
  const c = getClient()
  const link = async (tagId: number, entity: string, ref: string): Promise<void> => {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO tag_links (tag_id, entity, ref, created_by) VALUES (?, ?, ?, ?)',
      args: [tagId, entity, ref, getCurrentUser().username || null]
    })
  }
  const ids = saleIds.map(n).filter((x) => x > 0)
  const orders = ids.length
    ? (
        await c.execute({
          sql: `SELECT id FROM orders WHERE intercompany_sale_id IN (${ids.map(() => '?').join(',')})`,
          args: ids
        })
      ).rows.map((r) => n((r as unknown as Row).id))
    : []
  for (const name of list) {
    const sellerTag = await createTag({ name, companyId: sellerId })
    await link(n(sellerTag.id), 'sale', group)
    if (buyerId && orders.length) {
      const buyerTag = await createTag({ name, companyId: buyerId })
      for (const oid of orders) await link(n(buyerTag.id), 'order', String(oid))
    }
  }
}

/** Taking a tanker back from Empty takes its onward sale (and the buyer's purchase) back too. */
export async function removeOnwardSale(tankerId: number): Promise<void> {
  await ensureColumns()
  const c = getClient()
  const t = (await c.execute({ sql: 'SELECT company_id, onward_sale_group FROM purchase_tankers WHERE id = ?', args: [n(tankerId)] }))
    .rows[0] as unknown as Row
  const group = s(t?.onward_sale_group)
  if (!group) return
  // Its tags go with it — on the sale, and on the buyer's paired purchase —
  // so none is left pointing at a bill that no longer exists.
  const paired = (
    await c.execute({
      sql: 'SELECT o.id FROM orders o JOIN sales sl ON sl.id = o.intercompany_sale_id WHERE sl.invoice_group = ?',
      args: [group]
    })
  ).rows.map((r) => String(n((r as unknown as Row).id)))
  await c.execute({ sql: "DELETE FROM tag_links WHERE entity = 'sale' AND ref = ?", args: [group] }).catch(() => {})
  for (const oid of paired) await c.execute({ sql: "DELETE FROM tag_links WHERE entity = 'order' AND ref = ?", args: [oid] }).catch(() => {})
  const { deleteSaleInvoice } = await import('./sales')
  await withCompany(n(t.company_id), () => deleteSaleInvoice(group))
  await c.execute({ sql: 'UPDATE purchase_tankers SET onward_sale_group = NULL, onward_company_id = NULL WHERE id = ?', args: [n(tankerId)] })
}
