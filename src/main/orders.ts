import type { InValue, ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getSetting } from './repos'
import { tankerGateReceived } from './gate'
import { createBargain, ensureOilType } from './bargains'
import { deleteJournalByRef, postPurchaseJournal } from './journal'
import { getActiveCompanyId } from './company'

const STAGES = [
  'ordered',
  'at_port',
  'payment_cleared',
  'in_transit',
  'outside_factory',
  'inside_factory',
  'received'
]

const TANKER_STAGES = ['supplier_factory', 'loaded', 'transit', 'outside_factory', 'inside_factory', 'empty']

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

// Bargain condition "DLD" (delivered) — supplier bears transport. Accept the
// legacy "Delivered" value too. Anything else (e.g. "EX") is buyer-borne.
function isDelivered(v: unknown): boolean {
  const s = String(v || '').toUpperCase()
  return s === 'DLD' || s === 'DELIVERED'
}

// --- the calculation engine (kept in sync with src/renderer/src/lib/orderCalc.ts) ---
export interface MoneyInput {
  orderedQty: number
  invoiceRate: number
  bargainRate: number
  gstPct: number
  tdsPct: number
  addsInterest: boolean
  interestPct: number
  interestDays: number
  // Slab TDS (cumulative per financial year): base % up to threshold, then above %.
  tdsThreshold?: number
  tdsPctAbove?: number
  tdsPrior?: number // taxable already billed to this party this FY (before this order)
}

// Tiered TDS: the part of `taxable` still under the threshold (given `prior`
// already billed) is taxed at basePct, the rest at abovePct.
function tierTds(
  taxable: number,
  prior: number,
  threshold: number,
  basePct: number,
  abovePct: number
): number {
  if (!threshold || threshold <= 0) return (taxable * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, taxable))
  const above = taxable - below
  return (below * basePct) / 100 + (above * abovePct) / 100
}

// Indian FY (Apr–Mar) date range for the given date.
function fyRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1
  return { start: `${startY}-04-01`, end: `${startY + 1}-03-31` }
}

export async function supplierFyTaxable(
  supplierId: number,
  dateStr: string,
  excludeId: number
): Promise<number> {
  const { start, end } = fyRange(dateStr)
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(taxable_value), 0) AS t FROM orders
          WHERE supplier_id = ? AND order_date BETWEEN ? AND ? AND id != ? AND company_id = ?`,
    args: [supplierId, start, end, excludeId || 0, getActiveCompanyId()]
  })
  // Add the "purchase bill amount as on <date>" if that date is in this FY —
  // it seeds the cumulative taxable so the TDS slab picks up from the right point.
  const sup = await c.execute({
    sql: 'SELECT opening_purchase_amount, opening_purchase_date FROM suppliers WHERE id = ?',
    args: [supplierId]
  })
  let opening = 0
  if (sup.rows.length) {
    const od = String(sup.rows[0].opening_purchase_date || '')
    if (od && od >= start && od <= end) opening = Number(sup.rows[0].opening_purchase_amount) || 0
  }
  return (Number(res.rows[0].t) || 0) + opening
}

export interface MoneyResult {
  interest_pct: number
  interest_days: number
  interest_per_unit: number
  adjusted_rate: number
  // Provisional block — on the (interest-adjusted) invoice rate.
  taxable_value: number
  gst_amount: number
  tds_amount: number
  net_amount: number
  // Final block — on the booked bargain rate.
  final_taxable_value: number
  final_gst_amount: number
  final_tds_amount: number
  final_net_amount: number
}

export function computeMoney(i: MoneyInput): MoneyResult {
  const interestPct = i.addsInterest ? i.interestPct : 0
  const interestDays = i.addsInterest ? i.interestDays : 0
  // Interest is simple interest on the GST-INCLUSIVE bargain rate:
  // I = BG rate × (1 + GST%) × Int% × days / 365; adjusted rate = rate + I.
  // e.g. 122800 @ 5% GST, 15% for 15d → 128940 × 15% × 15/365 = 794.8356.
  const interestPerUnit =
    i.bargainRate * (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (interestDays / 365)
  const adjustedRate = i.invoiceRate + interestPerUnit

  // Provisional (invoice) block.
  const threshold = i.tdsThreshold || 0
  const abovePct = i.tdsPctAbove || 0
  const prior = i.tdsPrior || 0

  const taxableValue = adjustedRate * i.orderedQty
  const gstAmount = (taxableValue * i.gstPct) / 100
  const tdsAmount = tierTds(taxableValue, prior, threshold, i.tdsPct, abovePct)
  const netAmount = taxableValue + gstAmount - tdsAmount

  // Final (bargain rate) block.
  const finalTaxable = i.bargainRate * i.orderedQty
  const finalGst = (finalTaxable * i.gstPct) / 100
  const finalTds = tierTds(finalTaxable, prior, threshold, i.tdsPct, abovePct)
  const finalNet = finalTaxable + finalGst - finalTds

  return {
    interest_pct: interestPct,
    interest_days: interestDays,
    interest_per_unit: interestPerUnit,
    adjusted_rate: adjustedRate,
    taxable_value: taxableValue,
    gst_amount: gstAmount,
    tds_amount: tdsAmount,
    net_amount: netAmount,
    final_taxable_value: finalTaxable,
    final_gst_amount: finalGst,
    final_tds_amount: finalTds,
    final_net_amount: finalNet
  }
}

// Tanker stage dates must be chronological — e.g. a receipt on 3rd July can't
// follow a loading on 16th July. Empty/missing dates are skipped.
const STAGE_DATE_FIELDS: Array<[string, string]> = [
  ['loaded_date', 'Loading date'],
  ['transit_date', 'Transit date'],
  ['outside_factory_date', 'Outside factory date'],
  ['inside_factory_date', 'Inside factory date'],
  ['empty_date', 'Receipt (empty) date']
]

function ddmmyyyy(iso: string): string {
  return iso.split('-').reverse().join('/')
}

function assertStageDateOrder(t: Row): void {
  let prevVal = ''
  let prevLabel = ''
  for (const [key, label] of STAGE_DATE_FIELDS) {
    const val = String(t[key] || '').slice(0, 10)
    if (!val) continue
    if (prevVal && val < prevVal) {
      throw new Error(
        `${label} (${ddmmyyyy(val)}) cannot be before the ${prevLabel.toLowerCase()} (${ddmmyyyy(prevVal)})`
      )
    }
    prevVal = val
    prevLabel = label
  }
}

async function getSupplier(id: number): Promise<Row | null> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM suppliers WHERE id = ? LIMIT 1',
    args: [id]
  })
  return res.rows.length ? (toPlain(res)[0] as Row) : null
}

// Replace the supplier payable ledger entry for an order.
async function setSupplierPayable(
  orderId: number,
  supplierId: number,
  amount: number,
  date: string
): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'payable'",
    args: [orderId]
  })
  await c.execute({
    sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'payable', ?, 'Order net amount', (SELECT company_id FROM orders WHERE id = ?))`,
    args: [supplierId, orderId, date, amount, orderId]
  })
}

export async function listOrders(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT o.*,
           s.name AS supplier_name,
           ot.code AS oil_code, ot.name AS oil_name,
           src.name AS source_name,
           t.name AS transporter_name,
           (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
           (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products ot ON ot.id = o.oil_type_id
    LEFT JOIN sources src ON src.id = o.source_id
    LEFT JOIN transporters t ON t.id = o.transporter_id
    WHERE o.company_id = ?
    ORDER BY o.id DESC
  `
  })
  return toPlain(res)
}

export async function createOrder(v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), 0)
  const roundOff = n(v.round_off)
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n(v.tds_pct),
    // per-invoice interest choice from the form wins; fall back to the supplier
    addsInterest: v.charge_interest !== undefined ? !!v.charge_interest : !!supplier?.adds_interest,
    interestPct:
      v.interest_pct !== undefined && v.interest_pct !== '' ? n(v.interest_pct) : n(supplier?.interest_pct),
    interestDays:
      v.interest_days !== undefined && v.interest_days !== '' ? n(v.interest_days) : n(supplier?.interest_days),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior
  })
  const res = await getClient().execute({
    sql: `INSERT INTO orders
      (company_id, invoice_no, order_date, bargain_id, supplier_id, oil_type_id, bargain_type, ordered_qty, uom,
       bargain_rate, invoice_rate, interest_pct, interest_days, adjusted_rate, taxable_value,
       gst_pct, gst_type, gst_amount, tds_pct, tds_amount, round_off, net_amount,
       final_taxable_value, final_gst_amount, final_tds_amount, final_net_amount,
       tanker_no, transporter_id, allowed_shortage_pct, is_registered_transporter, posting, financed_by_party,
       payment_cleared_date, remarks, freight_paid_to_supplier, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'loaded')`,
    args: [
      getActiveCompanyId(),
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'EX',
      n(v.ordered_qty),
      v.uom || 'MT',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      roundOff,
      m.net_amount + roundOff,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n(v.transporter_id) : null,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== '' ? Number(v.allowed_shortage_pct) : null,
      v.is_registered_transporter ? 1 : 0,
      1,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date,
      v.remarks ? String(v.remarks).trim() : null,
      v.freight_paid_to_supplier ? 1 : 0
    ]
  })
  const id = Number(res.lastInsertRowid)
  await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id))
  await applySupplierFreight(id, v)
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount + roundOff, String(v.order_date))
  await postOrderJournal(id, v, m, supplier, roundOff)
  return { id }
}

// When freight is billed by the supplier (invoice rate > bargain rate), keep
// the per-ton difference as freight DATA on the invoice's tankers — purely for
// maintenance; no transporter ledger is ever posted for such invoices.
async function applySupplierFreight(orderId: number, v: Row): Promise<void> {
  if (!v.freight_paid_to_supplier) return
  const diff = n(v.invoice_rate) - n(v.bargain_rate)
  if (diff <= 0) return
  await getClient().execute({
    sql: 'UPDATE purchase_tankers SET transport_rate_per_ton = ? WHERE order_id = ?',
    args: [diff, orderId]
  })
}

// True when the order's freight sits inside the supplier invoice — then the
// transporter ledger must stay untouched for its tankers.
async function freightPaidToSupplier(orderId: number): Promise<boolean> {
  const res = await getClient().execute({
    sql: 'SELECT freight_paid_to_supplier FROM orders WHERE id = ?',
    args: [orderId]
  })
  return n(res.rows[0]?.freight_paid_to_supplier) === 1
}

// Tally double entry for a purchase: Dr {OIL} PUR A/C + Dr GST INPUT (+ Round off),
// Cr TDS PAYABLE + Cr Supplier.
async function postOrderJournal(
  orderId: number,
  v: Row,
  m: MoneyResult,
  supplier: Row | null,
  roundOff = 0
): Promise<void> {
  const oil = await getClient().execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [n(v.oil_type_id)]
  })
  const oilCode = String(oil.rows[0]?.code || oil.rows[0]?.name || 'OIL').toUpperCase()
  await postPurchaseJournal({
    orderId,
    date: String(v.order_date),
    invoiceNo: String(v.invoice_no || ''),
    oilCode,
    supplierName: String(supplier?.name || 'SUPPLIER'),
    taxable: m.taxable_value,
    gst: m.gst_amount,
    tds: m.tds_amount,
    net: m.net_amount + roundOff,
    roundOff,
    interest: m.interest_per_unit * n(v.ordered_qty)
  }).catch((e) => console.error('[journal] purchase post failed:', (e as Error).message))
}

export async function updateOrder(id: number, v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), id)
  const roundOff = n(v.round_off)
  const m = computeMoney({
    orderedQty: n(v.ordered_qty),
    invoiceRate: n(v.invoice_rate),
    bargainRate: n(v.bargain_rate),
    gstPct: n(v.gst_pct),
    tdsPct: supplier?.tds_above_only ? 0 : n(v.tds_pct),
    // per-invoice interest choice from the form wins; fall back to the supplier
    addsInterest: v.charge_interest !== undefined ? !!v.charge_interest : !!supplier?.adds_interest,
    interestPct:
      v.interest_pct !== undefined && v.interest_pct !== '' ? n(v.interest_pct) : n(supplier?.interest_pct),
    interestDays:
      v.interest_days !== undefined && v.interest_days !== '' ? n(v.interest_days) : n(supplier?.interest_days),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior
  })
  await getClient().execute({
    sql: `UPDATE orders SET
      invoice_no = ?, order_date = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      ordered_qty = ?, uom = ?, bargain_rate = ?, invoice_rate = ?, interest_pct = ?, interest_days = ?,
      adjusted_rate = ?, taxable_value = ?, gst_pct = ?, gst_type = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?, net_amount = ?,
      final_taxable_value = ?, final_gst_amount = ?, final_tds_amount = ?, final_net_amount = ?,
      tanker_no = ?, transporter_id = ?, allowed_shortage_pct = ?, is_registered_transporter = ?, posting = 1, financed_by_party = ?,
      payment_cleared_date = ?, remarks = ?, freight_paid_to_supplier = ?
      WHERE id = ?`,
    args: [
      v.invoice_no,
      v.order_date,
      v.bargain_id ? n(v.bargain_id) : null,
      n(v.supplier_id),
      n(v.oil_type_id),
      v.bargain_type || 'EX',
      n(v.ordered_qty),
      v.uom || 'MT',
      n(v.bargain_rate),
      n(v.invoice_rate),
      m.interest_pct,
      m.interest_days,
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      roundOff,
      m.net_amount + roundOff,
      m.final_taxable_value,
      m.final_gst_amount,
      m.final_tds_amount,
      m.final_net_amount,
      v.tanker_no || null,
      v.transporter_id ? n(v.transporter_id) : null,
      v.allowed_shortage_pct != null && v.allowed_shortage_pct !== '' ? Number(v.allowed_shortage_pct) : null,
      v.is_registered_transporter ? 1 : 0,
      v.financed_by_party ? 1 : 0,
      v.payment_date || v.order_date,
      v.remarks ? String(v.remarks).trim() : null,
      v.freight_paid_to_supplier ? 1 : 0,
      id
    ]
  })
  await getClient().execute({ sql: 'UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?', args: [id] })
  await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id))
  await applySupplierFreight(id, v)
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount + roundOff, String(v.order_date))
  await postOrderJournal(id, v, m, supplier, roundOff)
  return { id }
}

export async function deleteOrder(id: number): Promise<{ id: number }> {
  const c = getClient()
  await deleteJournalByRef('order_id', id)
  await c.execute({ sql: 'DELETE FROM supplier_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] })
  return { id }
}

async function assignTankers(
  orderId: number,
  tankerIds: unknown,
  bargainId: number,
  transporterId: number
): Promise<void> {
  const ids = Array.isArray(tankerIds) ? tankerIds.map(Number).filter((x) => x > 0) : []
  if (!ids.length) throw new Error('Select at least one loaded tanker')
  const c = getClient()
  for (const tankerId of ids) {
    const res = await c.execute({
      sql: 'SELECT order_id, bargain_id FROM purchase_tankers WHERE id = ?',
      args: [tankerId]
    })
    if (!res.rows.length) throw new Error('A selected tanker no longer exists')
    const row = res.rows[0]
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error('A selected tanker is already attached to another purchase')
    }
    if (Number(row.bargain_id) !== bargainId) {
      throw new Error('All tankers on one purchase must belong to the selected bargain')
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET order_id = ?,
            transporter_id = CASE WHEN ? > 0 THEN ? ELSE transporter_id END WHERE id = ?`,
      args: [orderId, transporterId, transporterId, tankerId]
    })
  }
}

// allCompanies = true is used by the (shared) Gate Entry screen.
export async function listPurchaseTankers(allCompanies = false): Promise<Row[]> {
  const res = await getClient().execute({
    args: allCompanies ? [] : [getActiveCompanyId()],
    sql: `
    SELECT pt.*, o.invoice_no, o.allowed_shortage_pct AS order_allowed_shortage_pct,
           b.bargain_no, b.bargain_type, b.rate_per_uom AS bargain_rate,
           b.allowed_shortage_pct, s.name AS supplier_name,
           p.code AS oil_code, p.name AS oil_name, src.name AS source_name,
           tr.name AS transporter_name
    FROM purchase_tankers pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN products p ON p.id = pt.oil_type_id
    LEFT JOIN sources src ON src.id = pt.source_id
    LEFT JOIN transporters tr ON tr.id = pt.transporter_id
    ${allCompanies ? '' : 'WHERE pt.company_id = ?'}
    ORDER BY CASE pt.status
      WHEN 'supplier_factory' THEN 1 WHEN 'loaded' THEN 2 WHEN 'transit' THEN 3
      WHEN 'outside_factory' THEN 4 WHEN 'inside_factory' THEN 5 ELSE 6 END, pt.id DESC
  `
  })
  return toPlain(res)
}

export async function createPurchaseTanker(v: Row): Promise<{ id: number }> {
  if (!v.tanker_no || !v.bargain_id) throw new Error('Tanker number and bargain are required')
  // Transporter is optional at send time (for both EX and DLD); it can still be
  // set later — the Empty stage requires it for EX freight posting.
  const res = await getClient().execute({
    sql: `INSERT INTO purchase_tankers
      (company_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id, loaded_qty, uom, payment_mode,
       transporter_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, 'supplier_factory')`,
    args: [
      getActiveCompanyId(),
      String(v.tanker_no).trim(),
      v.factory_entry_date || v.loaded_date || null,
      n(v.bargain_id),
      n(v.supplier_id),
      n(v.oil_type_id),
      v.uom || 'MT',
      v.transporter_id ? n(v.transporter_id) : null
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Edit any stage data of a tanker in one go (the pencil on the movement list).
// Recomputes expected delivery, and — for emptied tankers — freight/shortage
// and the transporter-ledger freight entry; the linked purchase is re-synced.
export async function updateTankerDetails(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Tanker not found')
  const t = toPlain(res)[0]

  const pick = (key: string): unknown => (v[key] !== undefined ? v[key] : t[key])
  const pickNum = (key: string, fallback: number): number =>
    v[key] !== undefined && v[key] !== '' ? n(v[key]) : fallback

  const bargainId = v.bargain_id ? n(v.bargain_id) : n(t.bargain_id)
  const loadedQty = pickNum('loaded_qty', n(t.loaded_qty))
  const receivedQty = pickNum('received_qty', n(t.received_qty))

  // Stage dates must stay chronological after the edit.
  const mergedDates: Row = {}
  for (const [key] of STAGE_DATE_FIELDS) mergedDates[key] = pick(key)
  assertStageDateOrder(mergedDates)

  // Bargain data (also refresh supplier/oil if the bargain was switched).
  const bRes = await c.execute({
    sql: 'SELECT supplier_id, oil_type_id, bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?',
    args: [bargainId]
  })
  if (!bRes.rows.length) throw new Error('Bargain not found')
  const b = bRes.rows[0]

  // Loaded qty must stay within the bargain balance (excluding this tanker).
  // Any excess portion already booked to an auto-created bargain is netted out.
  const extraQty = n(t.extra_qty)
  if (loadedQty > 0) {
    if (extraQty > 0 && loadedQty < extraQty - 1e-6) {
      throw new Error(
        `Loaded qty cannot be below the excess qty (${extraQty.toFixed(3)}) already booked to its own bargain`
      )
    }
    const bal = await c.execute({
      sql: `SELECT b.qty
              - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
              - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
            AS balance FROM bargains b WHERE b.id = ?`,
      args: [id, id, bargainId]
    })
    if (loadedQty - extraQty > n(bal.rows[0]?.balance) + 1e-6) {
      throw new Error(`Loaded qty exceeds the bargain balance (${n(bal.rows[0]?.balance).toFixed(3)})`)
    }
  }

  // Changing the received qty of an emptied tanker must still match the gate.
  if (String(t.status) === 'empty' && Math.abs(receivedQty - n(t.received_qty)) > 1e-9) {
    const gateQty = await tankerGateReceived(id)
    if (gateQty == null) throw new Error('No completed gate entry for this tanker')
    if (Math.abs(gateQty - receivedQty) > 0.001) {
      throw new Error(`Received qty (${receivedQty}) does not match the gate received qty (${gateQty})`)
    }
  }

  // Expected delivery from transit date + port transit days.
  const sourceId = v.source_id !== undefined ? (v.source_id ? n(v.source_id) : null) : (t.source_id ?? null)
  const transitDate = (pick('transit_date') as string) || null
  let expected: string | null = null
  if (sourceId && transitDate) {
    const src = await c.execute({ sql: 'SELECT transit_days FROM sources WHERE id = ?', args: [sourceId] })
    const d = new Date(transitDate)
    d.setDate(d.getDate() + n(src.rows[0]?.transit_days))
    expected = d.toISOString().slice(0, 10)
  }

  // Freight / shortage recompute for emptied tankers.
  let transporterId =
    v.transporter_id !== undefined ? (v.transporter_id ? n(v.transporter_id) : null) : (t.transporter_id ?? null)
  let rate = pickNum('transport_rate_per_ton', n(t.transport_rate_per_ton))
  let transport = n(t.transport_amount)
  let penalty = n(t.shortage_charge_amount)
  if (String(t.status) === 'empty') {
    const isEx = !isDelivered(b.bargain_type)
    rate = isEx ? rate : 0
    transport = loadedQty * rate
    let pct = b.allowed_shortage_pct == null
      ? n((await getSetting('allowed_shortage_pct')) ?? '0')
      : n(b.allowed_shortage_pct)
    if (t.order_id) {
      const ord = await c.execute({
        sql: 'SELECT allowed_shortage_pct FROM orders WHERE id = ?',
        args: [n(t.order_id)]
      })
      if (ord.rows.length && ord.rows[0].allowed_shortage_pct != null) pct = n(ord.rows[0].allowed_shortage_pct)
    }
    const shortage = Math.max(0, loadedQty - receivedQty)
    const excess = Math.max(0, shortage - (loadedQty * pct) / 100)
    penalty = isEx ? excess * n(b.rate_per_uom) : 0
    transporterId = isEx ? transporterId : null

    // Refresh this tanker's freight entry in the transporter ledger — unless
    // the supplier billed the freight (then it stays data-only).
    if (t.order_id) {
      await c.execute({
        sql: "DELETE FROM transporter_ledger WHERE order_id = ? AND entry_type = 'freight' AND note LIKE ?",
        args: [n(t.order_id), `Tanker ${t.tanker_no}:%`]
      })
      if (transporterId && !(await freightPaidToSupplier(n(t.order_id)))) {
        await c.execute({
          sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
                VALUES (?, ?, ?, 'freight', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
          args: [
            transporterId,
            n(t.order_id),
            (pick('empty_date') as string) || null,
            transport - penalty,
            `Tanker ${String(pick('tanker_no') || t.tanker_no)}: freight less shortage`,
            n(t.order_id)
          ]
        })
      }
    }
  }

  await c.execute({
    sql: `UPDATE purchase_tankers SET
      tanker_no = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?,
      loaded_date = ?, loaded_qty = ?, payment_mode = ?,
      transit_date = ?, source_id = ?, expected_delivery_date = ?,
      outside_factory_date = ?, inside_factory_date = ?, empty_date = ?,
      received_qty = ?, transporter_id = ?, transport_rate_per_ton = ?,
      transport_amount = ?, shortage_charge_amount = ?,
      krfl_weighment_doc_no = ?, outside_weighment_doc_no = ?
      WHERE id = ?`,
    args: [
      String(pick('tanker_no') || t.tanker_no).trim(),
      bargainId,
      n(b.supplier_id),
      n(b.oil_type_id),
      (pick('loaded_date') as string) || null,
      loadedQty,
      (pick('payment_mode') as string) || 'pending',
      transitDate,
      sourceId,
      expected,
      (pick('outside_factory_date') as string) || null,
      (pick('inside_factory_date') as string) || null,
      (pick('empty_date') as string) || null,
      receivedQty,
      transporterId,
      rate,
      transport,
      penalty,
      (pick('krfl_weighment_doc_no') as string) || null,
      (pick('outside_weighment_doc_no') as string) || null,
      id
    ]
  })

  if (t.order_id) await syncPurchaseFromTankers(n(t.order_id))
  return { id }
}

export async function deletePurchaseTanker(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT order_id FROM purchase_tankers WHERE id = ?', args: [id] })
  if (res.rows[0]?.order_id != null) throw new Error('Remove this tanker from its purchase before deleting it')
  await c.execute({ sql: 'DELETE FROM purchase_tankers WHERE id = ?', args: [id] })
  return { id }
}

async function syncPurchaseFromTankers(orderId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS empty_count,
                 SUM(COALESCE(received_qty, 0)) AS received_qty,
                 SUM(COALESCE(transport_amount, 0)) AS transport_amount,
                 SUM(COALESCE(shortage_charge_amount, 0)) AS shortage_amount
          FROM purchase_tankers WHERE order_id = ?`,
    args: [orderId]
  })
  const x = res.rows[0]
  const status = n(x.total) > 0 && n(x.total) === n(x.empty_count) ? 'received' : 'loaded'
  await c.execute({
    sql: `UPDATE orders SET status = ?, received_qty = ?, transport_amount = ?,
          shortage_charge_amount = ?, received_date = CASE WHEN ? = 'received' THEN date('now') ELSE received_date END
          WHERE id = ?`,
    args: [status, n(x.received_qty), n(x.transport_amount), n(x.shortage_amount), status, orderId]
  })
}

// Startup backfill: recompute each purchase's status/received totals from its
// tankers (fixes rows whose status was corrupted by the old lifecycle remap).
export async function backfillOrderStatuses(): Promise<void> {
  const c = getClient()
  const res = await c.execute(
    'SELECT DISTINCT order_id FROM purchase_tankers WHERE order_id IS NOT NULL'
  )
  for (const r of res.rows) {
    await syncPurchaseFromTankers(n(r.order_id)).catch(() => {})
  }
}

export async function advancePurchaseTanker(id: number, toStatus: string, data: Row): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Tanker not found')
  const tanker = toPlain(res)[0]
  const current = TANKER_STAGES.indexOf(String(tanker.status))
  const target = TANKER_STAGES.indexOf(toStatus)
  if (target !== current + 1) throw new Error('That is not the next tanker stage')

  // The new stage's date can never fall before an earlier stage's date.
  assertStageDateOrder({
    loaded_date: data.loaded_date ?? tanker.loaded_date,
    transit_date: data.transit_date ?? tanker.transit_date,
    outside_factory_date: data.outside_factory_date ?? tanker.outside_factory_date,
    inside_factory_date: data.inside_factory_date ?? tanker.inside_factory_date,
    empty_date: data.empty_date ?? tanker.empty_date
  })

  if (toStatus === 'loaded') {
    const qty = n(data.loaded_qty)
    if (qty <= 0) throw new Error('Enter the actual loaded quantity')
    // The bargain may be switched at loading time (defaults to the one chosen
    // when the tanker was sent). Balance is validated against the final choice.
    const bargainId = data.bargain_id ? n(data.bargain_id) : n(tanker.bargain_id)
    const balance = await c.execute({
      sql: `SELECT b.qty
              - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
              - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
            AS balance
            FROM bargains b WHERE b.id = ?`,
      args: [id, id, bargainId]
    })
    if (!balance.rows.length) throw new Error('Bargain not found')
    const bal = n(balance.rows[0].balance)
    // Trucks sometimes take on more than the bargain has left. With the user's
    // confirmation the excess becomes its own bargain line (same supplier/oil,
    // rate as confirmed) and this tanker's consumption is split across the two.
    let extraBargainId: number | null = null
    let extraQty = 0
    if (qty > bal + 1e-6) {
      if (!data.allow_excess) {
        throw new Error(`Loaded qty exceeds the bargain balance (${bal.toFixed(3)})`)
      }
      extraQty = Math.round((qty - Math.max(bal, 0)) * 1000) / 1000
      const oRes = await c.execute({ sql: 'SELECT * FROM bargains WHERE id = ?', args: [bargainId] })
      if (!oRes.rows.length) throw new Error('Bargain not found')
      const orig = toPlain(oRes)[0]
      const duty = n(orig.duty)
      const hasRate = data.excess_rate !== undefined && data.excess_rate !== null && data.excess_rate !== ''
      const baseRate = hasRate ? n(data.excess_rate) - duty : n(orig.base_rate)
      const created = await createBargain({
        bargain_date: String(data.loaded_date || '').slice(0, 10) || String(orig.bargain_date),
        supplier_id: orig.supplier_id,
        broker_id: orig.broker_id,
        oil_type_id: orig.oil_type_id,
        bargain_type: orig.bargain_type,
        qty: extraQty,
        uom: orig.uom,
        base_rate: baseRate,
        duty,
        allowed_shortage_pct: orig.allowed_shortage_pct
      })
      extraBargainId = created.id
    }
    const sourceId = data.source_id ? n(data.source_id) : null
    const transitDate = String(data.loaded_date || '')
    let expected: string | null = null
    if (sourceId && transitDate) {
      const src = await c.execute({ sql: 'SELECT transit_days FROM sources WHERE id = ?', args: [sourceId] })
      const d = new Date(transitDate)
      d.setDate(d.getDate() + n(src.rows[0]?.transit_days))
      expected = d.toISOString().slice(0, 10)
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'transit', bargain_id = ?, loaded_date = ?, loaded_qty = ?,
            payment_mode = ?, transit_date = ?, source_id = ?, expected_delivery_date = ?,
            extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        bargainId,
        data.loaded_date || null,
        qty,
        data.payment_mode === 'supplier_finance' ? 'supplier_finance' : 'paid_by_us',
        transitDate || null,
        sourceId,
        expected,
        extraBargainId,
        extraQty,
        id
      ]
    })
  } else if (toStatus === 'transit') {
    const sourceId = data.source_id ? n(data.source_id) : null
    const transitDate = String(data.transit_date || '')
    let expected: string | null = null
    if (sourceId && transitDate) {
      const src = await c.execute({ sql: 'SELECT transit_days FROM sources WHERE id = ?', args: [sourceId] })
      const d = new Date(transitDate)
      d.setDate(d.getDate() + n(src.rows[0]?.transit_days))
      expected = d.toISOString().slice(0, 10)
    }
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'transit', transit_date = ?, source_id = ?,
            expected_delivery_date = ? WHERE id = ?`,
      args: [transitDate || null, sourceId, expected, id]
    })
  } else if (toStatus === 'outside_factory') {
    // Invoice gate: a loaded tanker must be billed on a purchase invoice
    // before it can move past transit.
    if (!tanker.order_id) {
      throw new Error(
        `Tanker ${tanker.tanker_no} is not billed yet. Create the purchase invoice first, then move it further.`
      )
    }
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'outside_factory', outside_factory_date = ? WHERE id = ?",
      args: [data.outside_factory_date || null, id]
    })
  } else if (toStatus === 'inside_factory') {
    await c.execute({
      sql: "UPDATE purchase_tankers SET status = 'inside_factory', inside_factory_date = ? WHERE id = ?",
      args: [data.inside_factory_date || null, id]
    })
  } else if (toStatus === 'empty') {
    const receivedQty = n(data.received_qty)
    if (receivedQty <= 0 || receivedQty > n(tanker.loaded_qty) + 1e-6) throw new Error('Enter a valid empty quantity')
    // Cross-check against the gate-recorded received quantity for this tanker.
    const gateQty = await tankerGateReceived(id)
    if (gateQty == null) {
      throw new Error('No gate entry found for this tanker. Record the gate receipt first.')
    }
    if (Math.abs(gateQty - receivedQty) > 0.001) {
      throw new Error(
        `Received qty (${receivedQty}) does not match the gate received qty (${gateQty}) for this tanker.`
      )
    }
    const bargain = await c.execute({
      sql: 'SELECT bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?',
      args: [n(tanker.bargain_id)]
    })
    const b = bargain.rows[0] || {}
    const isEx = !isDelivered(b.bargain_type)
    const rate = isEx ? n(data.transport_rate_per_ton) : 0
    const transport = n(tanker.loaded_qty) * rate
    // Shortage tolerance: the purchase's own % (set at purchase creation when a
    // transporter is attached) wins; else the bargain's; else the global default.
    let pct = b.allowed_shortage_pct == null
      ? n((await getSetting('allowed_shortage_pct')) ?? '0')
      : n(b.allowed_shortage_pct)
    if (tanker.order_id) {
      const ord = await c.execute({
        sql: 'SELECT allowed_shortage_pct FROM orders WHERE id = ?',
        args: [n(tanker.order_id)]
      })
      if (ord.rows.length && ord.rows[0].allowed_shortage_pct != null) {
        pct = n(ord.rows[0].allowed_shortage_pct)
      }
    }
    const shortage = Math.max(0, n(tanker.loaded_qty) - receivedQty)
    const excess = Math.max(0, shortage - (n(tanker.loaded_qty) * pct) / 100)
    const penalty = isEx ? excess * n(b.rate_per_uom) : 0
    const transporterId = isEx ? n(data.transporter_id) : null
    await c.execute({
      sql: `UPDATE purchase_tankers SET status = 'empty', empty_date = ?, received_qty = ?,
            transporter_id = ?, transport_rate_per_ton = ?, transport_amount = ?,
            shortage_charge_amount = ?, krfl_weighment_doc_no = ?, krfl_weighment_photo = ?,
            outside_weighment_doc_no = ?, outside_weighment_photo = ? WHERE id = ?`,
      args: [
        data.empty_date || null,
        receivedQty,
        transporterId,
        rate,
        transport,
        penalty,
        data.krfl_weighment_doc_no || null,
        data.krfl_weighment_photo || null,
        data.outside_weighment_doc_no || null,
        data.outside_weighment_photo || null,
        id
      ]
    })
    if (tanker.order_id && transporterId && !(await freightPaidToSupplier(n(tanker.order_id)))) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger
          (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'freight', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
        args: [transporterId, n(tanker.order_id), data.empty_date || null, transport - penalty,
          `Tanker ${tanker.tanker_no}: freight less shortage`, n(tanker.order_id)]
      })
    }
  }
  if (tanker.order_id) await syncPurchaseFromTankers(n(tanker.order_id))
  return { id }
}

// Advance an order one stage along the tanker lifecycle. Only the immediate
// next stage is allowed (no skipping). The 'received' stage does the weighing,
// shortage and transporter-ledger work.
export async function advanceOrder(
  id: number,
  toStatus: string,
  data: Row
): Promise<{ id: number }> {
  const c = getClient()
  const ordRes = await c.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] })
  if (!ordRes.rows.length) throw new Error('Order not found')
  const order = toPlain(ordRes)[0] as Row

  const ci = STAGES.indexOf(String(order.status))
  const ti = STAGES.indexOf(toStatus)
  if (ti < 0 || ti !== ci + 1) throw new Error('That step is not the next stage for this order')

  const sets: string[] = ['status = ?']
  const args: InValue[] = [toStatus]

  if (toStatus === 'at_port') {
    sets.push('port_entry_date = ?')
    args.push(data.port_entry_date || null)
    if (data.tanker_no !== undefined) {
      sets.push('tanker_no = ?')
      args.push(data.tanker_no || null)
    }
  } else if (toStatus === 'payment_cleared') {
    const financed = !!data.financed_by_party
    const pcDate = (data.payment_cleared_date as string) || null
    // Credit-period interest: charged only on days beyond the credit period, and
    // only for suppliers who DON'T already bill interest in the invoice
    // (adds_interest). Skipped entirely when the party financed it.
    const supplier = await getSupplier(n(order.supplier_id))
    let interestDays = 0
    let interestAmt = 0
    if (
      !financed &&
      supplier &&
      !supplier.adds_interest &&
      n(supplier.interest_pct) > 0 &&
      pcDate &&
      order.order_date
    ) {
      const days = Math.round(
        (new Date(pcDate).getTime() - new Date(String(order.order_date)).getTime()) / 86400000
      )
      interestDays = Math.max(0, days - n(supplier.credit_period_days))
      interestAmt = (n(order.net_amount) * n(supplier.interest_pct) * interestDays) / (100 * 365)
    }
    await c.execute({
      sql: `UPDATE orders SET status = 'payment_cleared', payment_cleared_date = ?, financed_by_party = ?,
            credit_interest_days = ?, credit_interest_amount = ? WHERE id = ?`,
      args: [pcDate, financed ? 1 : 0, interestDays, interestAmt, id]
    })
    await c.execute({
      sql: "DELETE FROM supplier_ledger WHERE order_id = ? AND entry_type = 'interest'",
      args: [id]
    })
    if (interestAmt > 0) {
      await c.execute({
        sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note, company_id)
              VALUES (?, ?, ?, 'interest', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
        args: [
          n(order.supplier_id),
          id,
          pcDate,
          interestAmt,
          `Interest for ${interestDays} days beyond credit period`,
          id
        ]
      })
    }
    return { id }
  } else if (toStatus === 'in_transit') {
    const sourceId = data.source_id ? Number(data.source_id) : null
    const dispatch = (data.dispatch_date as string) || null
    let expected: string | null = null
    if (sourceId && dispatch) {
      const s = await c.execute({
        sql: 'SELECT transit_days FROM sources WHERE id = ?',
        args: [sourceId]
      })
      const days = s.rows.length ? n(s.rows[0].transit_days) : 0
      const d = new Date(dispatch)
      d.setDate(d.getDate() + days)
      expected = d.toISOString().slice(0, 10)
    }
    sets.push('dispatch_date = ?', 'source_id = ?', 'expected_delivery_date = ?')
    args.push(dispatch, sourceId, expected)
  } else if (toStatus === 'outside_factory') {
    sets.push('outside_factory_date = ?')
    args.push(data.outside_factory_date || null)
  } else if (toStatus === 'inside_factory') {
    sets.push('inside_factory_date = ?')
    args.push(data.inside_factory_date || null)
  } else if (toStatus === 'received') {
    const isEx = !isDelivered(order.bargain_type)
    const orderedQty = n(order.ordered_qty)
    const receivedQty = n(data.received_qty)
    const bargainRate = n(order.bargain_rate)
    const transportRate = isEx ? n(data.transport_rate_per_ton) : 0
    const transportAmount = isEx ? orderedQty * transportRate : 0

    let pct = n((await getSetting('allowed_shortage_pct')) ?? '0')
    if (order.bargain_id) {
      const b = await c.execute({
        sql: 'SELECT allowed_shortage_pct FROM bargains WHERE id = ?',
        args: [Number(order.bargain_id)]
      })
      const bp = b.rows.length ? b.rows[0].allowed_shortage_pct : null
      if (bp != null) pct = Number(bp)
    }
    // the purchase's own tolerance (captured at creation) wins over both
    if (order.allowed_shortage_pct != null) pct = Number(order.allowed_shortage_pct)
    const allowedQty = (orderedQty * pct) / 100
    const actualShortage = Math.max(0, orderedQty - receivedQty)
    const excessShortage = Math.max(0, actualShortage - allowedQty)
    const shortageCharge = isEx ? excessShortage * bargainRate : 0
    const transporterId = isEx ? n(data.transporter_id) : null

    sets.push(
      'received_date = ?',
      'received_qty = ?',
      'transporter_id = ?',
      'transport_rate_per_ton = ?',
      'transport_amount = ?',
      'allowed_shortage_pct = ?',
      'allowed_shortage_qty = ?',
      'actual_shortage_qty = ?',
      'excess_shortage_qty = ?',
      'shortage_charge_amount = ?'
    )
    args.push(
      data.received_date || null,
      receivedQty,
      transporterId,
      transportRate,
      transportAmount,
      pct,
      allowedQty,
      actualShortage,
      excessShortage,
      shortageCharge
    )
    args.push(id)
    await c.execute({ sql: `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, args })

    await c.execute({
      sql: "DELETE FROM transporter_ledger WHERE order_id = ? AND entry_type IN ('freight','shortage_penalty')",
      args: [id]
    })
    if (isEx && transporterId && !n(order.freight_paid_to_supplier)) {
      await c.execute({
        sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
              VALUES (?, ?, ?, 'freight', ?, 'Freight earned', (SELECT company_id FROM orders WHERE id = ?))`,
        args: [transporterId, id, data.received_date || null, transportAmount, id]
      })
      if (shortageCharge > 0) {
        await c.execute({
          sql: `INSERT INTO transporter_ledger (transporter_id, order_id, entry_date, entry_type, amount, note, company_id)
                VALUES (?, ?, ?, 'shortage_penalty', ?, ?, (SELECT company_id FROM orders WHERE id = ?))`,
          args: [
            transporterId,
            id,
            data.received_date || null,
            -shortageCharge,
            `Shortage ${excessShortage.toFixed(3)} ${order.uom} beyond ${pct}% tolerance`,
            id
          ]
        })
      }
    }
    return { id }
  }

  args.push(id)
  await c.execute({ sql: `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, args })
  return { id }
}

// --- ledgers ---

export async function listSupplierLedger(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, s.name AS supplier_name, o.invoice_no
    FROM supplier_ledger l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN orders o ON o.id = l.order_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res)
}

export async function listTransporterLedger(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, t.name AS transporter_name, o.invoice_no
    FROM transporter_ledger l
    LEFT JOIN transporters t ON t.id = l.transporter_id
    LEFT JOIN orders o ON o.id = l.order_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res)
}

// Manual ledger entry (opening balance, advance, adjustment) — Tally style.
// Stored signed: credit (we owe the party) positive, debit negative.
export async function addLedgerEntry(d: Row): Promise<{ id: number }> {
  const partyType =
    d.party_type === 'transporter'
      ? 'transporter'
      : d.party_type === 'customer'
        ? 'customer'
        : 'supplier'
  const table =
    partyType === 'supplier'
      ? 'supplier_ledger'
      : partyType === 'transporter'
        ? 'transporter_ledger'
        : 'customer_ledger'
  const col =
    partyType === 'supplier'
      ? 'supplier_id'
      : partyType === 'transporter'
        ? 'transporter_id'
        : 'customer_id'
  const amount = n(d.cr) - n(d.dr)
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${col}, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    args: [n(d.party_id), d.entry_date, d.entry_type || 'manual', amount, d.note || null, getActiveCompanyId()]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Only manual entries can be deleted (auto entries are owned by orders/payments).
export async function deleteLedgerEntry(partyType: string, id: number): Promise<{ id: number }> {
  const table =
    partyType === 'transporter'
      ? 'transporter_ledger'
      : partyType === 'customer'
        ? 'customer_ledger'
        : 'supplier_ledger'
  await getClient().execute({
    sql: `DELETE FROM ${table} WHERE id = ? AND entry_type IN ('opening','advance','adjustment','manual','general','dr_note','cr_note')`,
    args: [id]
  })
  return { id }
}

export async function recordSupplierPayment(data: Row): Promise<{ id: number }> {
  const res = await getClient().execute({
    sql: `INSERT INTO supplier_ledger (supplier_id, order_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'payment', ?, ?, ?)`,
    args: [
      n(data.supplier_id),
      data.order_id ? n(data.order_id) : null,
      data.entry_date,
      -Math.abs(n(data.amount)),
      data.note || 'Payment',
      getActiveCompanyId()
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}
