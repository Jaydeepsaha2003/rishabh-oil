import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { deleteJournalByRef, postSaleJournal } from './journal'
import { getActiveCompanyId } from './company'
import { productStockAvailable, stockMap } from './stock'
import {
  productHasFormulation,
  formulationConsumption,
  createSaleProduction,
  deleteSaleProductions
} from './production'

// Guard: a dispatched (done) sale physically draws finished-goods stock, so the
// available stock (excluding this sale's own effect) must cover the quantity.
// Pending sales are commitments and don't deduct, so they aren't blocked here.
async function assertFinishedStock(
  productId: number,
  qty: number,
  productName: string,
  excludeSaleId?: number
): Promise<void> {
  const avail = await productStockAvailable(productId, { excludeSaleId })
  if (qty > avail + 1e-6) {
    throw new Error(
      `Not enough ${productName || 'finished'} stock to dispatch: need ${qty.toFixed(3)}, only ${Math.max(avail, 0).toFixed(3)} available. Produce more first, or keep the sale as pending.`
    )
  }
}

async function productLabel(productId: number): Promise<string> {
  const r = await getClient().execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [productId] })
  return r.rows.length ? String(r.rows[0].name || '') : ''
}

// Guard for dispatching a made-to-order finished good: the formulation's inputs
// must be in stock to make the dispatched qty. When editing an already-linked
// sale, that sale's existing auto-production consumption is added back first so
// the check reflects availability as if this dispatch weren't already booked.
async function assertRawForFinished(
  productId: number,
  qty: number,
  existingSaleId?: number
): Promise<void> {
  const consumption = await formulationConsumption(productId, qty)
  if (!consumption.length) return
  const levels = await stockMap()
  if (existingSaleId) {
    const ex = await getClient().execute({
      sql: `SELECT i.product_id AS pid, i.qty AS q FROM production_items i
            JOIN production p ON p.id = i.production_id WHERE p.sale_id = ?`,
      args: [existingSaleId]
    })
    for (const r of ex.rows) {
      const pid = Number(r.pid)
      levels[pid] = (Number(levels[pid]) || 0) + (Number(r.q) || 0)
    }
  }
  const names = await getClient().execute('SELECT id, name FROM products')
  const nameOf = new Map<number, string>()
  for (const r of names.rows) nameOf.set(Number(r.id), String(r.name || ''))
  const short = consumption.filter((cn) => cn.qty > (Number(levels[cn.product_id]) || 0) + 1e-6)
  if (short.length) {
    const detail = short
      .map((s) => `${nameOf.get(s.product_id) || 'component'} (need ${s.qty.toFixed(3)}, have ${Math.max(Number(levels[s.product_id]) || 0, 0).toFixed(3)})`)
      .join('; ')
    throw new Error(`Not enough input stock to make this dispatch: ${detail}. Purchase/produce those first, or dispatch off-stock.`)
  }
}

export type DispatchStage = 'pending' | 'loaded' | 'transit' | 'unloaded'

// A dispatch moves through loaded → transit → unloaded; any of those three
// means the goods have left the factory (accounting/stock status 'done').
// 'pending' = committed but not yet dispatched (no stock drawn).
function stageOf(v: Row): DispatchStage {
  const s = String(v.dispatch_stage || '').toLowerCase()
  if (s === 'loaded' || s === 'transit' || s === 'unloaded' || s === 'pending') return s
  // Legacy fallback: a sale carrying only status 'done' is treated as delivered.
  return String(v.status) === 'done' ? 'unloaded' : 'pending'
}
const isDispatched = (stage: DispatchStage): boolean => stage !== 'pending'
const statusForStage = (stage: DispatchStage): 'pending' | 'done' => (isDispatched(stage) ? 'done' : 'pending')

const STAGE_ORDER: DispatchStage[] = ['pending', 'loaded', 'transit', 'unloaded']

// Resolve the three stage dates for a target stage: keep/carry any dates for
// stages up to the target (stamping `today` where missing), clear dates for
// stages beyond it. `src` supplies any explicitly-provided dates (edit form).
function resolveStageDates(
  stage: DispatchStage,
  src: Record<string, unknown>,
  today: string
): { loaded_date: string | null; transit_date: string | null; unloaded_date: string | null } {
  const t = STAGE_ORDER.indexOf(stage)
  const val = (x: unknown): string | null => (x ? String(x) : null)
  let loaded = t >= 1 ? val(src.loaded_date) : null
  let transit = t >= 2 ? val(src.transit_date) : null
  let unloaded = t >= 3 ? val(src.unloaded_date) : null
  if (t >= 1 && !loaded) loaded = today
  if (t >= 2 && !transit) transit = today
  if (t >= 3 && !unloaded) unloaded = today
  return { loaded_date: loaded, transit_date: transit, unloaded_date: unloaded }
}

// Today in local time (YYYY-MM-DD). Fine in the main process (not a workflow).
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
async function postSaleEntry(saleId: number, v: Row, taxable: number, gst: number, roundOff = 0): Promise<void> {
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
    gst,
    roundOff
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
           pk.name AS packaging_name, tr.name AS transporter_name, cu.name AS customer_master
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN transporters tr ON tr.id = s.transporter_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    WHERE s.company_id = ?
    ORDER BY s.sale_date DESC, s.id DESC
  `
  })
  // Show the customer master's current name when the sale is linked to it.
  return toPlain(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }))
}

// --- sales bargains (rate contracts for finished goods) ---

// "DD-MM" from an ISO date string. e.g. 2025-06-13 -> "13-06".
function dayMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (m) return `${m[3]}-${m[2]}`
  const d = new Date(dateStr)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function listSalesBargains(from?: string, to?: string): Promise<Row[]> {
  // Sales bargains are GENERAL — shared across every company, like purchase
  // bargains (no company filter; sold sums sales from all companies).
  // Period register fields (relative to [from,to]): disp_before = dispatched
  // before the period, disp_period = dispatched within it, last_dispatch_date =
  // the date the last dispatch happened (used for the "finished this period" rule).
  const f = from || '0000-01-01'
  const t = to || '9999-12-31'
  const res = await getClient().execute({
    sql: `
    SELECT b.*, pr.name AS product_name, pk.name AS packaging_name, cu.name AS customer_master,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS sold_qty,
      b.qty - COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id), 0) AS balance_qty,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) < ?), 0) AS disp_before,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) >= ? AND substr(sale_date, 1, 10) <= ?), 0) AS disp_period,
      (SELECT MAX(substr(sale_date, 1, 10)) FROM sales WHERE sales_bargain_id = b.id) AS last_dispatch_date,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) < ?), 0) AS adj_before,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) >= ? AND substr(adj_date, 1, 10) <= ?), 0) AS adj_in,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) > ?), 0) AS adj_after
    FROM sales_bargains b
    LEFT JOIN products pr ON pr.id = b.product_id
    LEFT JOIN packagings pk ON pk.id = b.packaging_id
    LEFT JOIN customers cu ON cu.id = b.customer_id
    ORDER BY b.id DESC
  `,
    args: [f, f, t, f, f, t, t]
  })
  // When linked to the master, always show the master's current name (renames
  // propagate); otherwise fall back to the free-text name stored on the bargain.
  return toPlain(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }))
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

// Sale-bargain classification (mirrors the purchase-bargain type tabs).
const SALE_CATEGORIES = ['FINISHED_OIL', 'FATTY', 'SCRAP', 'SPENT_EARTH', 'MISC']
function saleCategory(v: unknown): string {
  const s = String(v || '').toUpperCase()
  return SALE_CATEGORIES.includes(s) ? s : 'FINISHED_OIL'
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
    sql: `INSERT INTO sales_bargains (company_id, bargain_no, bargain_date, customer, customer_id, product_id, qty, uom, rate, rate_expiry_date, status, note, sale_type, sale_category, packaging_id, freight_term, gst_pct, gst_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n(v.customer_id) : null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      saleCategory(v.sale_category),
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
    sql: 'SELECT customer, customer_id, product_id FROM sales_bargains WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Sales bargain not found')
  const sold = await salesBargainSold(id)
  if (sold > 1e-6) {
    // Compare by master id when linked (so a rename isn't seen as a change);
    // fall back to the free-text name for un-linked legacy bargains.
    const curId = n(cur.rows[0].customer_id)
    const newId = n(v.customer_id)
    const changed =
      curId > 0 || newId > 0
        ? curId !== newId
        : String(v.customer || '').trim() !== String(cur.rows[0].customer || '').trim()
    if (changed) {
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
    sql: `UPDATE sales_bargains SET bargain_date = ?, customer = ?, customer_id = ?, product_id = ?, qty = ?, uom = ?,
          rate = ?, rate_expiry_date = ?, note = ?, sale_type = ?, sale_category = ?, packaging_id = ?, freight_term = ?, gst_pct = ?, gst_type = ? WHERE id = ?`,
    args: [
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n(v.customer_id) : null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      saleCategory(v.sale_category),
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
  note?: string,
  date?: string
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
  // Dated log so the top-up shows under "Addition" for its month in the register.
  const adjDate = (date && String(date).slice(0, 10)) || new Date().toISOString().slice(0, 10)
  await c.execute({
    sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note) VALUES ('sales', ?, ?, ?, ?)",
    args: [id, d, adjDate, note ? String(note).trim() : null]
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

// Convert a quantity between units of the SAME dimension (mass or volume).
// Mismatched dimensions (e.g. L → MT, which needs density) are left as-is.
const UNIT_FACTOR: Record<string, { dim: 'mass' | 'vol'; f: number }> = {
  KG: { dim: 'mass', f: 1 },
  QUINTAL: { dim: 'mass', f: 100 },
  MT: { dim: 'mass', f: 1000 },
  TON: { dim: 'mass', f: 1000 },
  ML: { dim: 'vol', f: 0.001 },
  L: { dim: 'vol', f: 1 },
  KL: { dim: 'vol', f: 1000 }
}
export function convertQty(qty: number, from: string, to: string): number {
  const a = UNIT_FACTOR[String(from || '').toUpperCase()]
  const b = UNIT_FACTOR[String(to || '').toUpperCase()]
  if (!a || !b || a.dim !== b.dim) return qty
  return (qty * a.f) / b.f
}

// Base quantity a sale actually draws from stock, IN THE SALE/BARGAIN UNIT. For
// PACKED sales the packaging nesting (boxes × pouches_per_box × base_per_pouch
// + loose pouches × base_per_pouch) is computed in the packaging's base unit,
// then converted to the sale unit (e.g. 1000 cases × 15 KG = 15,000 KG = 15 MT).
async function resolveSaleQty(v: Row): Promise<{ qty: number; uom: string }> {
  // The sale's unit follows its bargain (falls back to the entered uom, then MT).
  let target = String(v.uom || '').trim()
  if (v.sales_bargain_id) {
    const b = await getClient().execute({
      sql: 'SELECT uom FROM sales_bargains WHERE id = ?',
      args: [n(v.sales_bargain_id)]
    })
    if (b.rows.length && b.rows[0].uom) target = String(b.rows[0].uom)
  }
  if (!target) target = 'MT'

  if (String(v.sale_type) === 'PACKED' && v.packaging_id) {
    const p = await getClient().execute({
      sql: 'SELECT pouches_per_box, base_per_pouch, base_uom FROM packagings WHERE id = ?',
      args: [n(v.packaging_id)]
    })
    if (p.rows.length) {
      const ppb = n(p.rows[0].pouches_per_box)
      const bpp = n(p.rows[0].base_per_pouch)
      const baseUom = String(p.rows[0].base_uom || 'KG')
      const baseQty = n(v.boxes) * ppb * bpp + n(v.pouches) * bpp
      const qty = Math.round(convertQty(baseQty, baseUom, target) * 1e6) / 1e6
      return { qty, uom: target }
    }
  }
  return { qty: n(v.qty), uom: target }
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
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select a product')
  const { qty, uom } = await resolveSaleQty(v)
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const rate = n(v.rate)
  if (rate < 0) throw new Error('Rate cannot be negative')
  const amount = qty * rate
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  // Invoice-level round off (carried on the first line of the group only).
  const roundOff = Math.round((n(v.round_off) || 0) * 100) / 100
  const net = amount + gstAmount + roundOff
  const customerId = v.customer_id ? n(v.customer_id) : null
  // Can't dispatch more than the chosen sales bargain still has open.
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), 0)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  const stage = stageOf(v)
  const status = statusForStage(stage)
  const dates = resolveStageDates(stage, v, todayLocal())
  // A finished good WITH a formulation is made-to-order: dispatching it consumes
  // the recipe's raw/intermediate inputs (via a linked auto-production), not
  // finished stock. Without a formulation it draws finished stock as before.
  const hasFormula = await productHasFormulation(productId)
  // Off-stock: dispatch is allowed without booking stock only when explicitly
  // forced (confirmed in the UI). Such a sale is not stock-tracked.
  const trackStock = isDispatched(stage) && v.force_no_stock ? 0 : 1
  if (isDispatched(stage)) {
    if (hasFormula) {
      if (!v.force_no_stock) await assertRawForFinished(productId, qty)
    } else if (trackStock === 1) {
      await assertFinishedStock(productId, qty, await productLabel(productId))
    }
  }
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_amount) > 0 ? n(v.transport_amount) : qty * n(v.transport_rate))
    : 0
  const res = await getClient().execute({
    sql: `INSERT INTO sales (company_id, sale_date, invoice_no, invoice_group, customer, customer_id, product_id, sales_bargain_id,
            qty, uom, rate, amount, gst_pct, gst_amount, gst_type, round_off, status, dispatch_stage, track_stock, loaded_date, transit_date, unloaded_date, note, sale_type, packaging_id, boxes, pouches, freight_term,
            transporter_id, transport_rate, transport_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      v.sale_date,
      v.invoice_no || null,
      v.invoice_group || null,
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
      roundOff,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
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
  // Made-to-order dispatch → draw the raw inputs via a linked auto-production.
  if (isDispatched(stage) && hasFormula) {
    const prodDate = dates.loaded_date || dates.transit_date || dates.unloaded_date || String(v.sale_date) || todayLocal()
    await createSaleProduction(id, productId, qty, prodDate, uom)
  }
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount, roundOff)
  await postSaleFreight(id, v, qty)
  return { id }
}

export async function updateSale(id: number, v: Row): Promise<{ id: number }> {
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select a product')
  const { qty, uom } = await resolveSaleQty(v)
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const rate = n(v.rate)
  if (rate < 0) throw new Error('Rate cannot be negative')
  const amount = qty * rate
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  // Invoice-level round off (carried on the first line of the group only).
  const roundOff = Math.round((n(v.round_off) || 0) * 100) / 100
  const net = amount + gstAmount + roundOff
  const customerId = v.customer_id ? n(v.customer_id) : null
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), id)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  const stage = stageOf(v)
  const status = statusForStage(stage)
  const dates = resolveStageDates(stage, v, todayLocal())
  const hasFormula = await productHasFormulation(productId)
  // Keeping/putting this sale in a dispatched stage must be backed by stock:
  // formulation goods by their raw inputs, plain goods by finished stock —
  // unless explicitly forced off-stock.
  const trackStock = isDispatched(stage) && v.force_no_stock ? 0 : 1
  if (isDispatched(stage)) {
    if (hasFormula) {
      if (!v.force_no_stock) await assertRawForFinished(productId, qty, id)
    } else if (trackStock === 1) {
      await assertFinishedStock(productId, qty, await productLabel(productId), id)
    }
  }
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_amount) > 0 ? n(v.transport_amount) : qty * n(v.transport_rate))
    : 0
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, customer_id = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, gst_pct = ?, gst_amount = ?, gst_type = ?, round_off = ?, status = ?, dispatch_stage = ?, track_stock = ?, loaded_date = ?, transit_date = ?, unloaded_date = ?, note = ?, sale_type = ?, packaging_id = ?, boxes = ?,
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
      roundOff,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
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
  // Sync the linked auto-production to the edited state: (re)create it while
  // dispatched with a formulation, otherwise drop it (reverses the raw draw).
  if (isDispatched(stage) && hasFormula) {
    const prodDate = dates.loaded_date || dates.transit_date || dates.unloaded_date || String(v.sale_date) || todayLocal()
    await createSaleProduction(id, productId, qty, prodDate, uom)
  } else {
    await deleteSaleProductions(id)
  }
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount, roundOff)
  await postSaleFreight(id, v, qty)
  return { id }
}

// Move a dispatch through its stages (pending → loaded → transit → unloaded).
// Advancing from pending into any dispatched stage draws finished stock (guarded);
// dropping back to pending releases it. Moving between dispatched stages is free.
export async function setSaleStage(id: number, stageIn: string, force = false, dateIn?: string): Promise<{ id: number }> {
  const stage = stageOf({ dispatch_stage: stageIn })
  const status = statusForStage(stage)
  const r = await getClient().execute({
    sql: 'SELECT product_id, qty, uom, status, track_stock, loaded_date, transit_date, unloaded_date FROM sales WHERE id = ?',
    args: [id]
  })
  if (!r.rows.length) throw new Error('Sale not found')
  const row = r.rows[0]
  const pid = n(row.product_id)
  const saleQty = n(row.qty)
  const hasFormula = await productHasFormulation(pid)
  const wasDispatched = String(row.status) === 'done'
  let trackStock = n(row.track_stock)
  if (!isDispatched(stage)) {
    // Back to pending → release stock and re-enable tracking for next time.
    trackStock = 1
  } else if (!wasDispatched) {
    // Dispatching now: force → off-stock; otherwise require stock — raw inputs
    // for a formulation good, finished stock for a plain one.
    trackStock = force ? 0 : 1
    if (hasFormula) {
      if (!force) await assertRawForFinished(pid, saleQty, id)
    } else if (trackStock === 1) {
      await assertFinishedStock(pid, saleQty, await productLabel(pid), id)
    }
  }
  // Stamp the reached stage's date (carrying earlier ones, clearing later ones).
  const dates = resolveStageDates(stage, row as unknown as Record<string, unknown>, dateIn || todayLocal())
  await getClient().execute({
    sql: 'UPDATE sales SET status = ?, dispatch_stage = ?, track_stock = ?, loaded_date = ?, transit_date = ?, unloaded_date = ? WHERE id = ?',
    args: [status, stage, trackStock, dates.loaded_date, dates.transit_date, dates.unloaded_date, id]
  })
  // Keep the linked auto-production in step with the sale's dispatch state.
  if (isDispatched(stage) && hasFormula) {
    const prodDate = dates.loaded_date || dates.transit_date || dates.unloaded_date || dateIn || todayLocal()
    await createSaleProduction(id, pid, saleQty, prodDate, String(row.uom || 'MT'))
  } else if (!isDispatched(stage)) {
    await deleteSaleProductions(id)
  }
  return { id }
}

// Backwards-compatible status toggle (pending/done) — maps done → unloaded.
export async function setSaleStatus(id: number, status: string): Promise<{ id: number }> {
  return setSaleStage(id, status === 'done' ? 'unloaded' : 'pending')
}

export async function deleteSale(id: number): Promise<{ id: number }> {
  const c = getClient()
  // Reverse the linked auto-production first (releases the raw it consumed).
  await deleteSaleProductions(id)
  await deleteJournalByRef('sale_id', id)
  await c.execute({ sql: 'DELETE FROM payment_allocations WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM customer_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [id] })
  return { id }
}

// --- multi-item sale invoices ---
// An invoice is one or more line items (each a sales row) sharing an
// invoice_group plus a common header (date, invoice no, customer, freight,
// dispatch stage). Each item is created through createSale so all the per-line
// guards (stock, bargain balance, packaging conversion, GST, journal, ledger)
// still apply.

let invoiceSeq = 0
function newInvoiceGroup(): string {
  invoiceSeq += 1
  return `INV-${Date.now().toString(36)}-${invoiceSeq}`
}

// Merge the shared invoice header onto each line item.
function mergeInvoiceItem(header: Row, item: Row, group: string): Row {
  return {
    ...item,
    invoice_group: group,
    sale_date: header.sale_date,
    invoice_no: header.invoice_no,
    customer: header.customer,
    customer_id: header.customer_id,
    freight_term: header.freight_term,
    transporter_id: header.transporter_id,
    transport_rate: header.transport_rate,
    dispatch_stage: header.dispatch_stage,
    loaded_date: header.loaded_date,
    transit_date: header.transit_date,
    unloaded_date: header.unloaded_date,
    force_no_stock: header.force_no_stock
  }
}

export async function createSaleInvoice(v: Row): Promise<{ group: string; ids: number[] }> {
  const items: Row[] = Array.isArray(v.items) ? v.items : []
  if (!items.length) throw new Error('Add at least one item to the invoice')
  const group = newInvoiceGroup()
  const ids: number[] = []
  for (let i = 0; i < items.length; i++) {
    // Invoice-level round off rides on the FIRST line only (others 0).
    const res = await createSale({ ...mergeInvoiceItem(v, items[i], group), round_off: i === 0 ? v.round_off : 0 })
    ids.push(res.id)
  }
  return { group, ids }
}

// Edit an invoice: reverse its existing lines and recreate from the new set
// (keeps the same group). Simpler and always consistent versus diffing.
export async function updateSaleInvoice(group: string, v: Row): Promise<{ group: string; ids: number[] }> {
  const items: Row[] = Array.isArray(v.items) ? v.items : []
  if (!items.length) throw new Error('Add at least one item to the invoice')
  const existing = await getClient().execute({
    sql: 'SELECT id FROM sales WHERE invoice_group = ?',
    args: [group]
  })
  for (const r of existing.rows) await deleteSale(Number(r.id))
  const ids: number[] = []
  for (let i = 0; i < items.length; i++) {
    const res = await createSale({ ...mergeInvoiceItem(v, items[i], group), round_off: i === 0 ? v.round_off : 0 })
    ids.push(res.id)
  }
  return { group, ids }
}

// Move a whole invoice through a dispatch stage (all its line items together).
export async function setInvoiceStage(
  group: string,
  stage: string,
  force = false,
  date?: string
): Promise<{ group: string }> {
  const rows = await getClient().execute({
    sql: 'SELECT id FROM sales WHERE invoice_group = ? ORDER BY id',
    args: [group]
  })
  for (const r of rows.rows) await setSaleStage(Number(r.id), stage, force, date)
  return { group }
}

export async function deleteSaleInvoice(group: string): Promise<{ group: string }> {
  const rows = await getClient().execute({
    sql: 'SELECT id FROM sales WHERE invoice_group = ?',
    args: [group]
  })
  for (const r of rows.rows) await deleteSale(Number(r.id))
  return { group }
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

// One-time backfill: auto round-off on existing sale invoices (created before
// the round_off column). For every invoice group whose lines all have 0 round
// off and whose total isn't already a whole rupee, the "Auto" rounding is
// applied: ro = round(total) − total, stored on the group's FIRST line, with
// that line's journal voucher and customer receivable re-posted at the rounded
// net. Guarded by a settings flag so it runs once.
export async function backfillSalesRoundOff(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_round_off_backfilled'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.invoice_group, s.sale_date, s.invoice_no, s.customer, s.customer_id,
           s.amount, s.gst_amount, s.round_off, pr.code AS product_code, pr.name AS product_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    ORDER BY s.id ASC
  `)
  // Group into invoices the same way the UI does (legacy rows stand alone).
  const groups = new Map<string, Row[]>()
  for (const r of toPlain(sales)) {
    const g = String(r.invoice_group || `LEGACY-${r.id}`)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(r)
  }
  let applied = 0
  for (const lines of groups.values()) {
    // Don't touch invoices that already carry a round off.
    if (lines.some((l) => Math.abs(n(l.round_off)) > 0.004)) continue
    const raw = lines.reduce((s, l) => s + n(l.amount) + n(l.gst_amount), 0)
    const ro = Math.round((Math.round(raw) - raw) * 100) / 100
    if (Math.abs(ro) < 0.005) continue
    const first = lines[0]
    await c.execute({ sql: 'UPDATE sales SET round_off = ? WHERE id = ?', args: [ro, n(first.id)] })
    const code = String(first.product_code || first.product_name || 'FG').toUpperCase()
    await postSaleJournal({
      saleId: n(first.id),
      date: String(first.sale_date),
      invoiceNo: first.invoice_no ? String(first.invoice_no) : null,
      productCode: code,
      customerName: String(first.customer || '').trim(),
      amount: n(first.amount),
      gst: n(first.gst_amount),
      roundOff: ro,
      companyId: n(first.company_id) || 1
    }).catch(() => {})
    if (first.customer_id) {
      await postCustomerReceivable(
        n(first.id),
        n(first.customer_id),
        n(first.amount) + n(first.gst_amount) + ro,
        String(first.sale_date)
      ).catch(() => {})
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_round_off_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[sales] backfilled round off on ${applied} invoices`)
}

// One-time backfill: link existing sales bargains to the customer master by
// name (trimmed, case-insensitive), so a customer rename thereafter propagates
// everywhere. Bargains whose name has no exact master match (typos, or
// customers not in the master) are left unlinked and keep their stored name —
// re-picking the customer on the bargain links them. Runs once (per new links).
export async function backfillSalesBargainCustomers(): Promise<void> {
  const c = getClient()
  const rows = await c.execute(
    'SELECT id, customer FROM sales_bargains WHERE customer_id IS NULL AND customer IS NOT NULL'
  )
  if (!rows.rows.length) return
  const custs = await c.execute('SELECT id, name FROM customers')
  const byName = new Map<string, number>()
  for (const cu of custs.rows) {
    byName.set(String(cu.name || '').trim().toLowerCase(), Number(cu.id))
  }
  let linked = 0
  for (const r of rows.rows) {
    const id = byName.get(String(r.customer || '').trim().toLowerCase())
    if (!id) continue
    await c.execute({ sql: 'UPDATE sales_bargains SET customer_id = ? WHERE id = ?', args: [id, Number(r.id)] })
    linked++
  }
  if (linked > 0) console.log(`[sales] linked ${linked} sales bargains to the customer master`)
}
