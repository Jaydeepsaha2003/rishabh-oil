import type { ResultSet } from '@libsql/client'
import { getClient } from './db'

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
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note)
            VALUES (?, ?, ?, 'sale', ?, 'Sale invoice')`,
      args: [customerId, saleId, date, -Math.abs(amount)]
    })
  }
}

export async function listCustomerLedger(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT l.*, c.name AS customer_name, s.invoice_no
    FROM customer_ledger l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN sales s ON s.id = l.sale_id
    ORDER BY l.id DESC
  `)
  return toPlain(res)
}

export async function listSales(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT s.*, pr.name AS product_name, pr.category AS product_category, sb.bargain_no AS sales_bargain_no
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    ORDER BY s.sale_date DESC, s.id DESC
  `)
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
  const res = await getClient().execute(`
    SELECT b.*, pr.name AS product_name,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS sold_qty,
      b.qty - COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS balance_qty
    FROM sales_bargains b
    LEFT JOIN products pr ON pr.id = b.product_id
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

  // continuous serial = max trailing segment across all sales bargains + 1
  const res = await c.execute('SELECT bargain_no FROM sales_bargains')
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.bargain_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  const serial = String(maxSeq + 1).padStart(4, '0')
  return `${fg}/${dayMonth(dateStr)}/${party}/${serial}`
}

export async function createSalesBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  const bargain_no = await nextSalesBargainNo(
    n(v.product_id),
    String(v.customer || ''),
    String(v.bargain_date)
  )
  const res = await getClient().execute({
    sql: `INSERT INTO sales_bargains (bargain_no, bargain_date, customer, product_id, qty, uom, rate, rate_expiry_date, status, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    args: [
      bargain_no,
      v.bargain_date,
      v.customer || null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'ton',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null
    ]
  })
  return { id: Number(res.lastInsertRowid), bargain_no }
}

export async function updateSalesBargain(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: `UPDATE sales_bargains SET bargain_date = ?, customer = ?, product_id = ?, qty = ?, uom = ?,
          rate = ?, rate_expiry_date = ?, note = ? WHERE id = ?`,
    args: [
      v.bargain_date,
      v.customer || null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'ton',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      id
    ]
  })
  return { id }
}

export async function deleteSalesBargain(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM sales_bargains WHERE id = ?', args: [id] })
  return { id }
}

export async function createSale(v: Row): Promise<{ id: number }> {
  const qty = n(v.qty)
  const rate = n(v.rate)
  const amount = qty * rate
  const customerId = v.customer_id ? n(v.customer_id) : null
  const res = await getClient().execute({
    sql: `INSERT INTO sales (sale_date, invoice_no, customer, customer_id, product_id, sales_bargain_id, qty, uom, rate, amount, status, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      v.uom || 'ton',
      rate,
      amount,
      v.status || 'pending',
      v.note || null
    ]
  })
  const id = Number(res.lastInsertRowid)
  await postCustomerReceivable(id, customerId, amount, String(v.sale_date))
  return { id }
}

export async function updateSale(id: number, v: Row): Promise<{ id: number }> {
  const qty = n(v.qty)
  const rate = n(v.rate)
  const amount = qty * rate
  const customerId = v.customer_id ? n(v.customer_id) : null
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, customer_id = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, status = ?, note = ? WHERE id = ?`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      v.uom || 'ton',
      rate,
      amount,
      v.status || 'pending',
      v.note || null,
      id
    ]
  })
  await postCustomerReceivable(id, customerId, amount, String(v.sale_date))
  return { id }
}

export async function setSaleStatus(id: number, status: string): Promise<{ id: number }> {
  await getClient().execute({ sql: 'UPDATE sales SET status = ? WHERE id = ?', args: [status, id] })
  return { id }
}

export async function deleteSale(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM payment_allocations WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM customer_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [id] })
  return { id }
}
