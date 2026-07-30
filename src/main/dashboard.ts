import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { stockLevels } from './stock'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Everything the dashboard shows, in one round trip. All figures are for the
// ACTIVE company. Months are ISO prefixes (YYYY-MM); the series cover the six
// months ending today.
export async function dashboardStats(): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()

  const q = async (sql: string, args: (string | number)[] = []): Promise<Row[]> =>
    toPlain(await c.execute({ sql, args: [cid, ...args] }))

  const [
    purchaseMonths,
    saleMonths,
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains,
    saleBargains,
    tankers,
    consignment,
    levels
  ] = await Promise.all([
    q(`SELECT substr(order_date, 1, 7) AS m, SUM(taxable_value + gst_amount + round_off) AS v, SUM(ordered_qty) AS qty, COUNT(*) AS cnt
       FROM orders WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT substr(sale_date, 1, 7) AS m, SUM(amount + gst_amount + round_off) AS v, SUM(qty) AS qty, COUNT(DISTINCT COALESCE(invoice_group, 'L' || id)) AS cnt
       FROM sales WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT order_date AS d, SUM(taxable_value + gst_amount + round_off) AS v
       FROM orders WHERE company_id = ? AND order_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT sale_date AS d, SUM(amount + gst_amount + round_off) AS v
       FROM sales WHERE company_id = ? AND sale_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT s.name, SUM(o.taxable_value + o.gst_amount + o.round_off) AS v, SUM(o.ordered_qty) AS qty
       FROM orders o JOIN suppliers s ON s.id = o.supplier_id
       WHERE o.company_id = ? GROUP BY o.supplier_id ORDER BY v DESC LIMIT 5`),
    q(`SELECT COALESCE(NULLIF(TRIM(s.customer), ''), 'CASH') AS name, SUM(s.amount + s.gst_amount + s.round_off) AS v, SUM(s.qty) AS qty
       FROM sales s WHERE s.company_id = ? GROUP BY name ORDER BY v DESC LIMIT 5`),
    q(`SELECT a.name, SUM(jl.cr) - SUM(jl.dr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group = 'Sundry Creditors'
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    q(`SELECT a.name, SUM(jl.dr) - SUM(jl.cr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group = 'Sundry Debtors'
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    q(`SELECT a.name, SUM(jl.dr) - SUM(jl.cr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.name IN ('TDS PAYABLE A/C', 'GST INPUT A/C', 'GST OUTPUT A/C')
       GROUP BY a.id`),
    q(`SELECT COUNT(*) AS cnt, COALESCE(SUM(qty), 0) AS qty FROM bargains WHERE company_id = ? AND status != 'settled'`).catch(
      () => [] as Row[]
    ),
    q(`SELECT COUNT(*) AS cnt, SUM(qty) AS qty FROM sales_bargains WHERE company_id = ? AND status != 'settled'`).catch(
      () => [] as Row[]
    ),
    q(`SELECT pt.status, COUNT(*) AS cnt FROM purchase_tankers pt
       WHERE pt.company_id = ? AND pt.status NOT IN ('received', 'empty') GROUP BY pt.status`).catch(() => [] as Row[]),
    q(`SELECT COALESCE(SUM(qty), 0) AS bal FROM consignment_stock WHERE company_id = ?`).catch(() => [] as Row[]),
    stockLevels()
  ])

  // Stock: per-category totals and the products sitting negative.
  const stockCats: Record<string, { qty: number; products: number }> = {}
  const negatives: Row[] = []
  for (const r of levels) {
    const cat = String(r.category || 'other')
    if (!stockCats[cat]) stockCats[cat] = { qty: 0, products: 0 }
    if (Math.abs(n(r.stock)) > 1e-9) {
      stockCats[cat].qty += n(r.stock)
      stockCats[cat].products++
    }
    if (n(r.stock) < -1e-9) negatives.push({ name: r.name, category: r.category, stock: n(r.stock) })
  }

  return {
    purchaseMonths: purchaseMonths.reverse(),
    saleMonths: saleMonths.reverse(),
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains: purBargains[0] || { cnt: 0, qty: 0 },
    saleBargains: saleBargains[0] || { cnt: 0, qty: 0 },
    tankers,
    consignmentBalance: n(consignment[0]?.bal),
    stockCats,
    negatives: negatives.sort((a, b) => a.stock - b.stock)
  }
}
