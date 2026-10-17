// SELLING TO OURSELVES.
// ---------------------------------------------------------------------------
// Two companies on one site trade with each other: KR FOODS sells oil to KR
// FINMARK. That is one movement of goods and TWO documents — a sale in the
// seller's books and a purchase in the buyer's — and until now the second one
// was typed again by hand in the other company, from the first one's figures,
// with nothing tying them together. A quantity corrected on one side stayed
// wrong on the other, and a sale deleted left a purchase standing.
//
// So the sale raises the purchase, and keeps it. Everything else in the
// software is untouched: the purchase is an ordinary `orders` row booked into
// the other company, and the party at each end is an ordinary master row that
// happens to say which company it stands for (company_link_id). Every ledger,
// bill-wise reference, TDS slab and voucher already works on those.
import { getClient } from './db'
import { createOrder, updateOrder, deleteOrder } from './orders'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

/**
 * A customer row and a supplier row for every company, so a company can be
 * picked in a party dropdown without inventing a second kind of party.
 *
 * Idempotent, and matched on company_link_id rather than on the name — a
 * company that is renamed keeps the party rows it already has (and the ledger
 * history hanging off them) instead of growing a second set.
 */
export async function ensureCompanyParties(): Promise<void> {
  const c = getClient()
  const companies = await c.execute(
    `SELECT id, name, gstin, state, gst_pct, tds_pct, tds_threshold, tds_above_only, credit_period_days,
            opening_purchase_amount, opening_purchase_date
       FROM companies WHERE COALESCE(active, 1) = 1`
  )
  for (const co of companies.rows as unknown as Row[]) {
    const cid = n(co.id)
    const name = s(co.name).trim()
    if (!cid || !name) continue
    // THE TERMS GO WHERE THE SOFTWARE LOOKS FOR THEM.
    //
    // Every slab, ledger, voucher and bill-wise reference in this system reads
    // a party row — customers.tds_threshold, suppliers.gst_pct and so on. The
    // company form is where these are ASKED, because that is where a person
    // thinks of them; the party rows standing for the company are where they
    // are READ. Copying them across on every save is what lets the whole of
    // the rest of the software stay exactly as it is.
    const terms = {
      gstin: s(co.gstin) || null,
      state: s(co.state) || null,
      gst_pct: n(co.gst_pct),
      tds_pct: n(co.tds_pct),
      tds_threshold: n(co.tds_threshold),
      tds_above_only: n(co.tds_above_only) ? 1 : 0,
      credit_period_days: n(co.credit_period_days),
      // Only the supplier side carries this: the slab it feeds is counted on
      // what was BOUGHT from a party, and the company's supplier row is the
      // one a purchase is booked against.
      opening_purchase_amount: n(co.opening_purchase_amount),
      opening_purchase_date: s(co.opening_purchase_date) || null
    }
    for (const table of ['customers', 'suppliers']) {
      const existing = await c.execute({
        sql: `SELECT id, name FROM ${table} WHERE company_link_id = ?`,
        args: [cid]
      })
      if (existing.rows.length) {
        const partyId = n((existing.rows[0] as unknown as Row).id)
        await c.execute({
          sql:
            table === 'suppliers'
              ? `UPDATE suppliers
                    SET name = ?, gstin = ?, state = ?, gst_pct = ?, tds_pct = ?,
                        tds_threshold = ?, tds_above_only = ?, credit_period_days = ?,
                        opening_purchase_amount = ?, opening_purchase_date = ?
                  WHERE id = ?`
              : `UPDATE customers
                    SET name = ?, gstin = ?, state = ?, gst_pct = ?, tds_pct = ?,
                        tds_threshold = ?, tds_above_only = ?, credit_period_days = ?
                  WHERE id = ?`,
          args:
            table === 'suppliers'
              ? [
                  name,
                  terms.gstin,
                  terms.state,
                  terms.gst_pct,
                  terms.tds_pct,
                  terms.tds_threshold,
                  terms.tds_above_only,
                  terms.credit_period_days,
                  terms.opening_purchase_amount,
                  terms.opening_purchase_date,
                  partyId
                ]
              : [
                  name,
                  terms.gstin,
                  terms.state,
                  terms.gst_pct,
                  terms.tds_pct,
                  terms.tds_threshold,
                  terms.tds_above_only,
                  terms.credit_period_days,
                  partyId
                ]
        })
        continue
      }
      // A party of the same name may already exist from before this feature —
      // adopt it rather than creating a duplicate the desk would have to tell
      // apart.
      const byName = await c.execute({
        sql: `SELECT id FROM ${table} WHERE TRIM(UPPER(name)) = ? AND company_link_id IS NULL`,
        args: [name.toUpperCase()]
      })
      if (byName.rows.length) {
        await c.execute({
          sql: `UPDATE ${table} SET company_link_id = ? WHERE id = ?`,
          args: [cid, n((byName.rows[0] as unknown as Row).id)]
        })
        continue
      }
      // skip_tanker_stages on the supplier side: goods moving between our own
      // companies have no journey to record — they are already on site.
      await c.execute({
        sql:
          table === 'suppliers'
            ? `INSERT INTO suppliers (name, company_link_id, active, skip_tanker_stages,
                 gstin, state, gst_pct, tds_pct, tds_threshold, tds_above_only, credit_period_days,
                 opening_purchase_amount, opening_purchase_date)
               VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            : `INSERT INTO customers (name, company_link_id, active,
                 gstin, state, gst_pct, tds_pct, tds_threshold, tds_above_only, credit_period_days)
               VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        args:
          table === 'suppliers'
            ? [
                name,
                cid,
                terms.gstin,
                terms.state,
                terms.gst_pct,
                terms.tds_pct,
                terms.tds_threshold,
                terms.tds_above_only,
                terms.credit_period_days,
                terms.opening_purchase_amount,
                terms.opening_purchase_date
              ]
            : [
                name,
                cid,
                terms.gstin,
                terms.state,
                terms.gst_pct,
                terms.tds_pct,
                terms.tds_threshold,
                terms.tds_above_only,
                terms.credit_period_days
              ]
      })
    }
  }
}

/** The company a customer stands for, or 0 for an ordinary customer. */
export async function companyOfCustomer(customerId: number): Promise<number> {
  if (!n(customerId)) return 0
  const r = await getClient().execute({
    sql: 'SELECT company_link_id FROM customers WHERE id = ?',
    args: [n(customerId)]
  })
  return n((r.rows[0] as unknown as Row)?.company_link_id)
}

/** The supplier row standing for a company — the seller, in the buyer's books. */
async function supplierForCompany(companyId: number): Promise<number> {
  const r = await getClient().execute({
    sql: 'SELECT id FROM suppliers WHERE company_link_id = ? LIMIT 1',
    args: [n(companyId)]
  })
  const id = n((r.rows[0] as unknown as Row)?.id)
  if (id) return id
  await ensureCompanyParties()
  const again = await getClient().execute({
    sql: 'SELECT id FROM suppliers WHERE company_link_id = ? LIMIT 1',
    args: [n(companyId)]
  })
  return n((again.rows[0] as unknown as Row)?.id)
}

/** The terms an inter-company invoice is raised on — kept on the company. */
async function companyTerms(companyId: number): Promise<{ gst: number; tds: number; aboveOnly: boolean }> {
  const r = await getClient().execute({
    sql: 'SELECT gst_pct, tds_pct, tds_above_only FROM companies WHERE id = ?',
    args: [n(companyId)]
  })
  const row = r.rows[0] as unknown as Row | undefined
  return { gst: n(row?.gst_pct), tds: n(row?.tds_pct), aboveOnly: !!n(row?.tds_above_only) }
}

/** The purchase already raised by this sale, if there is one. */
export async function pairedPurchaseOf(saleId: number): Promise<number> {
  const r = await getClient().execute({
    sql: 'SELECT id FROM orders WHERE intercompany_sale_id = ? LIMIT 1',
    args: [n(saleId)]
  })
  return n((r.rows[0] as unknown as Row)?.id)
}

/**
 * THE OTHER HALF, READ FROM THIS SIDE.
 *
 * A transfer between two of our own companies is ONE event kept in two sets of
 * books: a sale over there, a purchase here, raised from it and tied to it by
 * orders.intercompany_sale_id. Standing on the purchase, everything that
 * explains it — what was actually sent, how much of each thing, at what rate —
 * lives on the invoice in the other company, and until now there was no way to
 * see it without leaving the page and knowing where to look.
 *
 * So it is read and shown here. Every line of the SOURCE INVOICE, not merely
 * the one line this purchase was raised from: an invoice that moved four
 * products raised four purchases, and the reader standing on one of them is
 * owed the shape of the whole transfer, with their own line marked.
 *
 * Read-only, and that is not a limitation to apologise for — it is the point.
 * These figures belong to the selling company's invoice. Edited here they
 * would either be overwritten the next time that invoice is touched (the two
 * are kept in step by syncPairedPurchase) or, worse, would not be — and the
 * same transfer would read as two different events in two sets of books.
 */
export async function intercompanySource(orderId: number): Promise<Row | null> {
  const c = getClient()
  const own = (
    await c.execute({
      sql: 'SELECT id, intercompany_sale_id, company_id, invoice_no FROM orders WHERE id = ? LIMIT 1',
      args: [n(orderId)]
    })
  ).rows[0] as unknown as Row | undefined
  const saleId = n(own?.intercompany_sale_id)
  if (!saleId) return null

  const mine = (
    await c.execute({
      sql: 'SELECT id, invoice_no, invoice_group, company_id, sale_date FROM sales WHERE id = ? LIMIT 1',
      args: [saleId]
    })
  ).rows[0] as unknown as Row | undefined
  if (!mine) return null

  // The whole invoice where there is a group, and the single line where there
  // is not — a trading sale is raised line by line with no group at all.
  const grp = s(mine.invoice_group)
  const rows = (
    await c.execute(
      grp
        ? {
            sql: `SELECT s.id, s.product_id, s.qty, s.uom, s.rate, s.amount, s.sale_type, s.is_rate_adj,
                         p.name AS product_name, pk.name AS packaging_name
                    FROM sales s
                    LEFT JOIN products p ON p.id = s.product_id
                    LEFT JOIN packagings pk ON pk.id = s.packaging_id
                   WHERE s.invoice_group = ? ORDER BY s.id`,
            args: [grp]
          }
        : {
            sql: `SELECT s.id, s.product_id, s.qty, s.uom, s.rate, s.amount, s.sale_type, s.is_rate_adj,
                         p.name AS product_name, pk.name AS packaging_name
                    FROM sales s
                    LEFT JOIN products p ON p.id = s.product_id
                    LEFT JOIN packagings pk ON pk.id = s.packaging_id
                   WHERE s.id = ?`,
            args: [saleId]
          }
    )
  ).rows as unknown as Row[]

  // Which purchase each line raised on this side, so a line that never made it
  // across can say so rather than simply be missing.
  const lines: Row[] = []
  for (const r of rows) {
    const paired = (
      await c.execute({
        sql: 'SELECT id, invoice_no, company_id FROM orders WHERE intercompany_sale_id = ? LIMIT 1',
        args: [n(r.id)]
      })
    ).rows[0] as unknown as Row | undefined
    lines.push({
      sale_id: n(r.id),
      product_id: n(r.product_id),
      product_name: s(r.product_name) || `#${n(r.product_id)}`,
      packaging_name: s(r.packaging_name),
      sale_type: s(r.sale_type) || 'LOOSE',
      is_rate_adj: n(r.is_rate_adj) === 1,
      qty: n(r.qty),
      uom: s(r.uom) || 'MT',
      rate: n(r.rate),
      amount: n(r.amount),
      // The line this very purchase was raised from.
      is_this_one: n(r.id) === saleId,
      paired_order_id: n(paired?.id) || null,
      paired_invoice_no: s(paired?.invoice_no)
    })
  }

  const nameOf = async (cid: number): Promise<string> => {
    if (!cid) return ''
    const r = await c.execute({ sql: 'SELECT name FROM companies WHERE id = ? LIMIT 1', args: [cid] })
    return s((r.rows[0] as unknown as Row)?.name)
  }

  return {
    sale_id: saleId,
    sale_invoice_no: s(mine.invoice_no),
    sale_date: s(mine.sale_date).slice(0, 10),
    seller_company_id: n(mine.company_id),
    seller_company: await nameOf(n(mine.company_id)),
    buyer_company: await nameOf(n(own?.company_id)),
    lines
  }
}

/**
 * ONE RATE, BECAUSE IT IS ONE TRANSFER.
 *
 * The purchase used to be booked at a rate typed separately on the sale form,
 * on the theory that a transfer might be priced differently at each end. It is
 * not, here: the two companies move oil between themselves at one price, and
 * asking twice for the same figure only created a way for them to disagree —
 * a sale of ₹21,00,000 standing against a purchase of something else, with
 * nothing in either set of books saying which was meant.
 *
 * So the sale's own rate IS the purchase's rate, and the field is gone.
 *
 * Loose takes the rate straight across. A PACKED line is billed on cases x
 * rate-per-case while the purchase is booked on the tonnage, so its per-MT
 * rate is worked back from the money — which makes the two VALUES equal, which
 * is the thing that actually has to match.
 */
export function pairedRate(sale: Row): number {
  const qty = n(sale.qty)
  const amount = n(sale.amount)
  if (s(sale.sale_type) === 'PACKED' && qty > 0 && amount > 0) {
    return Math.round((amount / qty) * 1e6) / 1e6
  }
  return n(sale.rate)
}

// The payload the other company's purchase is booked on.
//
// is_consignment: the goods are already at our site — they only changed books —
// so the purchase books straight to 'received' with no transporter and no
// tanker journey, which is the same path a consignment draw takes.
function purchasePayload(
  sale: Row,
  v: Row,
  buyer: number,
  supplierId: number,
  terms: { gst: number; tds: number; aboveOnly: boolean }
): Row {
  return {
    company_id: buyer,
    supplier_id: supplierId,
    oil_type_id: n(sale.product_id),
    ordered_qty: n(sale.qty),
    uom: s(sale.uom || 'MT'),
    invoice_no: s(v.purchase_invoice_no).trim(),
    invoice_rate: pairedRate(sale),
    order_date: s(sale.sale_date).slice(0, 10),
    gst_pct: terms.gst,
    tds_pct: terms.tds,
    is_consignment: true,
    intercompany_sale_id: n(sale.id),
    // The sales invoice these all belong to. One transfer of three products is
    // three purchase rows under ONE number, and this is what tells the
    // Purchases form they are one bill rather than three clashing ones.
    bill_group: s(sale.invoice_group) || null
  }
}

/**
 * Mark a purchase as one company's half of a transfer.
 *
 * Both columns are written AFTER the insert rather than through createOrder,
 * which names its columns explicitly and is shared by every purchase there is
 * — a place where a field only two callers use does not belong.
 *
 * The group matters as much as the sale id. Three products transferred are
 * three purchase rows under one invoice number, and this stamp is the only
 * thing that tells the duplicate-number rule they are one bill: unstamped,
 * the second product of every transfer is refused as a clash with the first.
 * Failing quietly is not an option for the same reason, so it is not caught.
 */
async function stampPair(orderId: number, saleId: number, group: string): Promise<void> {
  await getClient().execute({
    sql: 'UPDATE orders SET intercompany_sale_id = ?, bill_group = ? WHERE id = ?',
    args: [saleId, group || null, orderId]
  })
}

/**
 * Raise the other half of an inter-company sale.
 *
 * Returns 0 when the sale is not one — an ordinary customer, or the buying
 * company is the seller itself, which is a mis-pick rather than a transfer.
 */
export async function raisePairedPurchase(sale: Row, v: Row): Promise<number> {
  const buyer = await companyOfCustomer(n(sale.customer_id))
  if (!buyer || buyer === n(sale.company_id)) return 0
  const invoiceNo = s(v.purchase_invoice_no).trim()
  if (!invoiceNo) throw new Error('Enter the purchase invoice number the other company books this under')
  // No rate to ask for any more — but a sale of nothing still cannot raise a
  // purchase of nothing, and saying so here beats a silent zero in two ledgers.
  if (pairedRate(sale) <= 0) {
    throw new Error('This sale has no rate yet — the transfer is booked at the same rate on both sides')
  }
  const supplierId = await supplierForCompany(n(sale.company_id))
  if (!supplierId) throw new Error('No supplier record stands for the selling company')
  const terms = await companyTerms(buyer)
  const res = await createOrder(purchasePayload(sale, v, buyer, supplierId, terms))
  const orderId = n(res?.id)
  if (orderId) await stampPair(orderId, n(sale.id), s(sale.invoice_group))
  return orderId
}

/**
 * Keep the purchase in step with its sale.
 *
 * Four cases, and all four happen: the sale was inter-company and still is
 * (update), was not and now is (raise), was and now is not (remove), and never
 * was (nothing). Anything less leaves one side of a pair standing alone.
 */
export async function syncPairedPurchase(sale: Row, v: Row): Promise<void> {
  const existing = await pairedPurchaseOf(n(sale.id))
  const buyer = await companyOfCustomer(n(sale.customer_id))
  const stillPaired = !!buyer && buyer !== n(sale.company_id)
  if (!existing && !stillPaired) return
  if (!existing && stillPaired) {
    await raisePairedPurchase(sale, v)
    return
  }
  if (existing && !stillPaired) {
    await deleteOrder(existing)
    return
  }
  const supplierId = await supplierForCompany(n(sale.company_id))
  const terms = await companyTerms(buyer)
  const payload = purchasePayload(sale, v, buyer, supplierId, terms)
  // A purchase invoice number left blank on an edit means "leave what the
  // other company already has" rather than "clear it" — the sale form does not
  // always carry it once the pair exists. The rate is no longer one of these:
  // it is derived from the sale every time, so it only falls back when the
  // sale itself has none, which is a case raisePairedPurchase already refuses.
  const current = await getClient().execute({
    sql: 'SELECT invoice_no, invoice_rate FROM orders WHERE id = ?',
    args: [existing]
  })
  const cur = current.rows[0] as unknown as Row | undefined
  if (!s(payload.invoice_no)) payload.invoice_no = s(cur?.invoice_no)
  if (!n(payload.invoice_rate)) payload.invoice_rate = n(cur?.invoice_rate)
  await updateOrder(existing, payload)
  // Re-stamped on every sync, because updateOrder does not carry these two
  // columns — and a pair raised before the group existed has none at all, so
  // an edit is the moment it gets one.
  await stampPair(existing, n(sale.id), s(sale.invoice_group))
}

/** A sale that is deleted takes its purchase with it. */
export async function removePairedPurchase(saleId: number): Promise<void> {
  const id = await pairedPurchaseOf(n(saleId))
  if (id) await deleteOrder(id)
}
