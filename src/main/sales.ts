import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { deleteJournalByRef, postSaleJournal } from './journal'
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

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// Maintain the receivable entry in the customer ledger for a sale.
// Convention (shared with supplier/transporter ledger): amount positive = credit
// (we owe the party), negative = debit. A sale debits the customer (they owe us).
async function postCustomerReceivable(
  saleId: number,
  customerId: number | null,
  amount: number,
  date: string
): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'sale'",
    args: [saleId]
  })
  if (customerId && amount > 0) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'sale', ?, 'Sale invoice', (SELECT company_id FROM sales WHERE id = ?))`,
      args: [customerId, saleId, date, -Math.abs(amount), saleId]
    })
  }
}

// Tally journal for a sale: Dr Customer (incl. GST), Cr {FG} SALE A/C (taxable),
// Cr GST OUTPUT A/C (output gst).
async function postSaleEntry(saleId: number, v: Row, taxable: number, gst: number): Promise<void> {
  const prod = await getClient().execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [n(v.product_id)]
  })
  const code = String(prod.rows[0]?.code || prod.rows[0]?.name || 'FG').toUpperCase()
  await postSaleJournal({
    saleId,
    date: String(v.sale_date),
    invoiceNo: v.invoice_no ? String(v.invoice_no) : null,
    productCode: code,
    customerName: String(v.customer || '').trim(),
    amount: taxable,
    gst
  }).catch((e) => console.error('[journal] sale post failed:', (e as Error).message))
}

export async function listCustomerLedger(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, c.name AS customer_name, s.invoice_no
    FROM customer_ledger l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN sales s ON s.id = l.sale_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res)
}

export async function listSales(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT s.*, pr.name AS product_name, pr.category AS product_category, sb.bargain_no AS sales_bargain_no,
           pk.name AS packaging_name, tr.name AS transporter_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN transporters tr ON tr.id = s.transporter_id
    WHERE s.company_id = ?
    ORDER BY s.sale_date DESC, s.id DESC
  `
  })
  return toPlain(res)
}

// --- sales bargains (rate contracts for finished goods) ---

// "DD-MM" from an ISO date string. e.g. 2025-06-13 -> "13-06".
function dayMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (m) return `${m[3]}-${m[2]}`
  const d = new Date(dateStr)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function listSalesBargains(): Promise<Row[]> {
  // Sales bargains are GENERAL — shared across every company, like purchase
  // bargains (no company filter; sold sums sales from all companies).
  const res = await getClient().execute(`
    SELECT b.*, pr.name AS product_name, pk.name AS packaging_name,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS sold_qty,
      b.qty - COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS balance_qty
    FROM sales_bargains b
    LEFT JOIN products pr ON pr.id = b.product_id
    LEFT JOIN packagings pk ON pk.id = b.packaging_id
    ORDER BY b.id DESC
  `)
  return toPlain(res)
}

// Format: FGCODE/DD-MM/PARTY/SERIAL (mirrors the purchase bargain number).
// FGCODE = finished-good product code; PARTY = customer; SERIAL = continuous.
async function nextSalesBargainNo(
  productId: number,
  customer: string,
  dateStr: string
): Promise<string> {
  const c = getClient()
  const prodRes = await c.execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [productId]
  })
  const fg = (
    prodRes.rows.length ? String(prodRes.rows[0].code || prodRes.rows[0].name || 'FG') : 'FG'
  )
    .replace(/\s+/g, '')
    .toUpperCase()
  const party = String(customer || 'PARTY').replace(/\s+/g, '').toUpperCase() || 'PARTY'

  // Serial resets every calendar month, GLOBAL across companies (bargains are
  // general), mirroring purchase bargains.
  const monthKey = String(dateStr).slice(0, 7) // yyyy-mm
  const res = await c.execute({
    sql: 'SELECT bargain_no FROM sales_bargains WHERE substr(bargain_date, 1, 7) = ?',
    args: [monthKey]
  })
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.bargain_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  const serial = String(maxSeq + 1).padStart(2, '0')
  return `${fg}/${dayMonth(dateStr)}/${party}/${serial}`
}

// Quantity already sold against a sales bargain.
async function salesBargainSold(id: number): Promise<number> {
  const r = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ?',
    args: [id]
  })
  return n(r.rows[0]?.q)
}

// Shared field checks (mirrors the purchase bargain validation).
function validateSalesBargainInput(v: Row): void {
  if (!v.customer || !String(v.customer).trim()) throw new Error('Customer is required')
  if (!v.product_id) throw new Error('Product is required')
  if (n(v.qty) <= 0) throw new Error('Quantity must be greater than zero')
  if (n(v.rate) <= 0) throw new Error('Rate must be greater than zero')
}

export async function createSalesBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  validateSalesBargainInput(v)
  const bargain_no = await nextSalesBargainNo(
    n(v.product_id),
    String(v.customer || ''),
    String(v.bargain_date)
  )
  const res = await getClient().execute({
    sql: `INSERT INTO sales_bargains (company_id, bargain_no, bargain_date, customer, product_id, qty, uom, rate, rate_expiry_date, status, note, sale_type, packaging_id, freight_term, gst_pct, gst_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.bargain_date,
      v.customer || null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      n(v.gst_pct),
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST'
    ]
  })
  return { id: Number(res.lastInsertRowid), bargain_no }
}

export async function updateSalesBargain(id: number, v: Row): Promise<{ id: number }> {
  validateSalesBargainInput(v)
  // Once anything is sold against it, the customer and product are locked and
  // the quantity can't drop below what's already been sold.
  const cur = await getClient().execute({
    sql: 'SELECT customer, product_id FROM sales_bargains WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Sales bargain not found')
  const sold = await salesBargainSold(id)
  if (sold > 1e-6) {
    if (String(v.customer || '').trim() !== String(cur.rows[0].customer || '').trim()) {
      throw new Error('Cannot change the customer — this bargain already has sales')
    }
    if (n(v.product_id) !== n(cur.rows[0].product_id)) {
      throw new Error('Cannot change the product — this bargain already has sales')
    }
    if (n(v.qty) < sold - 1e-6) {
      throw new Error(`Quantity cannot be below the ${sold.toFixed(3)} already sold on this bargain`)
    }
  }
  await getClient().execute({
    sql: `UPDATE sales_bargains SET bargain_date = ?, customer = ?, product_id = ?, qty = ?, uom = ?,
          rate = ?, rate_expiry_date = ?, note = ?, sale_type = ?, packaging_id = ?, freight_term = ?, gst_pct = ?, gst_type = ? WHERE id = ?`,
    args: [
      v.bargain_date,
      v.customer || null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      n(v.gst_pct),
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      id
    ]
  })
  return { id }
}

export async function deleteSalesBargain(id: number): Promise<{ id: number }> {
  if ((await salesBargainSold(id)) > 1e-6) {
    throw new Error('This sales bargain has sales linked to it. Delete those sales first.')
  }
  await getClient().execute({ sql: 'DELETE FROM sales_bargains WHERE id = ?', args: [id] })
  return { id }
}

// Add to (delta > 0) or remove from (delta < 0) a sales bargain's quantity,
// moving its open balance by the same amount. Can't drop below what's sold.
export async function adjustSalesBargainQty(
  id: number,
  delta: number,
  note?: string
): Promise<{ id: number; qty: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM sales_bargains WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Sales bargain not found')
  const b = toPlain(res)[0]
  const d = Number(delta) || 0
  if (d === 0) throw new Error('Enter a quantity to add or remove')
  const sold = await salesBargainSold(id)
  const newQty = Math.round((n(b.qty) + d) * 1000) / 1000
  if (newQty <= 0) throw new Error('The resulting quantity must be greater than zero')
  if (newQty < sold - 1e-6) {
    throw new Error(`Cannot remove below the ${sold.toFixed(3)} already sold on this bargain`)
  }
  const newNote = note ? `${b.note ? String(b.note) + '\n' : ''}${String(note).trim()}` : b.note
  await c.execute({
    sql: 'UPDATE sales_bargains SET qty = ?, note = ? WHERE id = ?',
    args: [newQty, newNote || null, id]
  })
  return { id, qty: newQty }
}

// Balance available on a sales bargain for a (possibly editing) sale.
async function salesBargainBalanceFor(bargainId: number, excludeSaleId: number): Promise<number> {
  const c = getClient()
  const b = await c.execute({ sql: 'SELECT qty FROM sales_bargains WHERE id = ?', args: [bargainId] })
  if (!b.rows.length) return Infinity
  const sold = await c.execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ? AND id != ?',
    args: [bargainId, excludeSaleId || 0]
  })
  return n(b.rows[0].qty) - n(sold.rows[0]?.q)
}

// Base quantity a sale actually draws from stock. For PACKED sales it comes
// from the packaging nesting: boxes × pouches_per_box × base_per_pouch, plus
// any loose pouches × base_per_pouch. LOOSE sales use the entered qty.
async function resolveSaleQty(v: Row): Promise<{ qty: number; uom: string }> {
  if (String(v.sale_type) === 'PACKED' && v.packaging_id) {
    const p = await getClient().execute({
      sql: 'SELECT pouches_per_box, base_per_pouch, base_uom FROM packagings WHERE id = ?',
      args: [n(v.packaging_id)]
    })
    if (p.rows.length) {
      const ppb = n(p.rows[0].pouches_per_box)
      const bpp = n(p.rows[0].base_per_pouch)
      const qty = n(v.boxes) * ppb * bpp + n(v.pouches) * bpp
      return { qty, uom: String(p.rows[0].base_uom || v.uom || 'L') }
    }
  }
  return { qty: n(v.qty), uom: String(v.uom || 'MT') }
}

// DLD deliveries: we manage the transporter, so post the freight to the
// transporter ledger (we owe them) and recover it from the customer (they owe
// us). Freight-on-goods deliveries post nothing. Replaces any prior entries.
async function postSaleFreight(saleId: number, v: Row, qty: number): Promise<number> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE sale_id = ?', args: [saleId] })
  await c.execute({ sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'freight'", args: [saleId] })
  if (String(v.freight_term) !== 'DLD') return 0
  const transporterId = v.transporter_id ? n(v.transporter_id) : null
  const amount = n(v.transport_amount) > 0 ? n(v.transport_amount) : qty * n(v.transport_rate)
  if (!transporterId || amount <= 0) return amount > 0 ? amount : 0
  const companyId = getActiveCompanyId()
  await c.execute({
    sql: `INSERT INTO transporter_ledger (transporter_id, sale_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'freight', ?, 'Delivery freight', ?)`,
    args: [transporterId, saleId, v.sale_date, amount, companyId]
  })
  const customerId = v.customer_id ? n(v.customer_id) : null
  if (customerId) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'freight', ?, 'Delivery freight recovered', ?)`,
      args: [customerId, saleId, v.sale_date, -Math.abs(amount), companyId]
    })
  }
  return amount
}

export async function createSale(v: Row): Promise<{ id: number }> {
  const { qty, uom } = await resolveSaleQty(v)
  const rate = n(v.rate)
  const amount = qty * rate
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  const net = amount + gstAmount
  const customerId = v.customer_id ? n(v.customer_id) : null
  // Can't dispatch more than the chosen sales bargain still has open.
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), 0)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_amount) > 0 ? n(v.transport_amount) : qty * n(v.transport_rate))
    : 0
  const res = await getClient().execute({
    sql: `INSERT INTO sales (company_id, sale_date, invoice_no, customer, customer_id, product_id, sales_bargain_id,
            qty, uom, rate, amount, gst_pct, gst_amount, gst_type, status, note, sale_type, packaging_id, boxes, pouches, freight_term,
            transporter_id, transport_rate, transport_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      v.status || 'pending',
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      n(v.boxes),
      n(v.pouches),
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      v.transporter_id ? n(v.transporter_id) : null,
      n(v.transport_rate),
      transportAmount
    ]
  })
  const id = Number(res.lastInsertRowid)
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount)
  await postSaleFreight(id, v, qty)
  return { id }
}

export async function updateSale(id: number, v: Row): Promise<{ id: number }> {
  const { qty, uom } = await resolveSaleQty(v)
  const rate = n(v.rate)
  const amount = qty * rate
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  const net = amount + gstAmount
  const customerId = v.customer_id ? n(v.customer_id) : null
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), id)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_amount) > 0 ? n(v.transport_amount) : qty * n(v.transport_rate))
    : 0
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, customer_id = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, gst_pct = ?, gst_amount = ?, gst_type = ?, status = ?, note = ?, sale_type = ?, packaging_id = ?, boxes = ?,
          pouches = ?, freight_term = ?, transporter_id = ?, transport_rate = ?, transport_amount = ? WHERE id = ?`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      v.status || 'pending',
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      n(v.boxes),
      n(v.pouches),
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      v.transporter_id ? n(v.transporter_id) : null,
      n(v.transport_rate),
      transportAmount,
      id
    ]
  })
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount)
  await postSaleFreight(id, v, qty)
  return { id }
}

export async function setSaleStatus(id: number, status: string): Promise<{ id: number }> {
  await getClient().execute({ sql: 'UPDATE sales SET status = ? WHERE id = ?', args: [status, id] })
  return { id }
}

export async function deleteSale(id: number): Promise<{ id: number }> {
  const c = getClient()
  await deleteJournalByRef('sale_id', id)
  await c.execute({ sql: 'DELETE FROM payment_allocations WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM customer_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [id] })
  return { id }
}

// One-time backfill: apply output GST to sales booked before GST existed. The
// rate is taken from the sale's bargain, else the customer master; sales with
// no derivable rate are left untouched. Each affected sale is re-posted
// (journal GST OUTPUT leg + customer receivable at net incl. GST). Guarded by
// a settings flag so it runs only once.
export async function backfillSalesGst(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_gst_backfilled'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.sale_date, s.invoice_no, s.customer, s.customer_id, s.amount,
           pr.code AS product_code, pr.name AS product_name,
           sb.gst_pct AS bargain_gst, cu.gst_pct AS customer_gst
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    WHERE COALESCE(s.gst_pct, 0) = 0 AND COALESCE(s.gst_amount, 0) = 0
  `)
  let applied = 0
  for (const r of toPlain(sales)) {
    const gstPct = n(r.bargain_gst) > 0 ? n(r.bargain_gst) : n(r.customer_gst)
    if (gstPct <= 0) continue
    const amount = n(r.amount)
    const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
    if (gstAmount <= 0) continue
    await c.execute({
      sql: 'UPDATE sales SET gst_pct = ?, gst_amount = ? WHERE id = ?',
      args: [gstPct, gstAmount, n(r.id)]
    })
    const code = String(r.product_code || r.product_name || 'FG').toUpperCase()
    await postSaleJournal({
      saleId: n(r.id),
      date: String(r.sale_date),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      productCode: code,
      customerName: String(r.customer || '').trim(),
      amount,
      gst: gstAmount,
      companyId: n(r.company_id) || 1
    }).catch(() => {})
    if (r.customer_id) {
      await postCustomerReceivable(n(r.id), n(r.customer_id), amount + gstAmount, String(r.sale_date)).catch(() => {})
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_gst_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[sales] backfilled output GST on ${applied} sales`)
}
