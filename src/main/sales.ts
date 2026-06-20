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

function financialYear(dateStr: string): string {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1
  return `${String(startY).slice(2)}-${String(startY + 1).slice(2)}`
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

async function nextSalesBargainNo(dateStr: string): Promise<string> {
  const c = getClient()
  const prefix = `SB/${financialYear(dateStr)}/`
  const res = await c.execute({
    sql: 'SELECT bargain_no FROM sales_bargains WHERE bargain_no LIKE ?',
    args: [`${prefix}%`]
  })
  let maxSeq = 0
  for (const r of res.rows) {
    const seq = parseInt(String(r.bargain_no).split('/')[2] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`
}

export async function createSalesBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  const bargain_no = await nextSalesBargainNo(String(v.bargain_date))
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
  const res = await getClient().execute({
    sql: `INSERT INTO sales (sale_date, invoice_no, customer, product_id, sales_bargain_id, qty, uom, rate, amount, status, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      v.uom || 'ton',
      rate,
      qty * rate,
      v.status || 'pending',
      v.note || null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateSale(id: number, v: Row): Promise<{ id: number }> {
  const qty = n(v.qty)
  const rate = n(v.rate)
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, status = ?, note = ? WHERE id = ?`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      v.uom || 'ton',
      rate,
      qty * rate,
      v.status || 'pending',
      v.note || null,
      id
    ]
  })
  return { id }
}

export async function setSaleStatus(id: number, status: string): Promise<{ id: number }> {
  await getClient().execute({ sql: 'UPDATE sales SET status = ? WHERE id = ?', args: [status, id] })
  return { id }
}

export async function deleteSale(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [id] })
  return { id }
}
