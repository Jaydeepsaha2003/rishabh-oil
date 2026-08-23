import type { InValue, ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getSetting } from './repos'
import { tankerGateReceived } from './gate'
import { createBargain, ensureOilType, adjustBargainQty } from './bargains'
import {
  consignmentAvailable,
  consignmentDeposited,
  assignConsignmentLots,
  autoAssignConsignmentLots,
  releaseConsignmentLots,
  validateConsignmentLots,
  toLotPicks,
  type LotAllocation
} from './consignment'
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

// The Empty-stage received qty must match the gate weighment, but weighbridge
// readings drift — allow this much difference (in MT) before blocking.
const GATE_MATCH_BUFFER = 1

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

// A blank/unknown condition means "not overridden" — normalising to null (not
// to 'EX') is what lets a tanker keep deferring to its bargain instead of
// silently pinning itself to one condition the moment anything is saved.
function normCondition(v: unknown): 'EX' | 'DLD' | null {
  const s = String(v ?? '').trim().toUpperCase()
  if (!s) return null
  return s === 'DLD' || s === 'DELIVERED' ? 'DLD' : 'EX'
}

// The condition that actually governs THIS tanker: its own choice when one was
// made when it was sent to the supplier, otherwise the bargain's. Freight and
// the shortage penalty both hang off this, so a per-tanker override has to be
// honoured here or the picker on the send-to-supplier dialog means nothing.
function tankerIsEx(tankerCondition: unknown, bargainType: unknown): boolean {
  const own = normCondition(tankerCondition)
  return own ? own === 'EX' : !isDelivered(bargainType)
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
  additionalInterest?: number // manual per-unit interest added to the adjusted rate
  // Slab TDS (cumulative per financial year): base % up to threshold, then above %.
  tdsThreshold?: number
  tdsPctAbove?: number
  tdsPrior?: number // taxable already billed to this party this FY (before this order)
  // Per-bargain shares when the invoice spans more than one bargain rate. Each
  // line is rated (and rounded) on its own, matching how suppliers bill.
  // additionalInterest/interestDays here override the invoice-level ones
  // above for just that one line — absent means it inherits the shared value.
  lines?: { rate: number; qty: number; bargainId?: number; additionalInterest?: number; interestDays?: number }[]
  // Applied to the total excluding TDS, which then becomes the TDS base.
  roundOff?: number
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

// A Trading supplier can be the same real-world party (PAN) as an existing
// Manufacturing supplier, kept as its own row so a trading deal never mixes
// with the manufacturing relationship's bargains. When one is linked to the
// other (suppliers.linked_party_id), the law's TDS slab is per-PAN, not per
// row — so every id sharing that link resolves together here.
async function relatedSupplierIds(supplierId: number): Promise<number[]> {
  const c = getClient()
  const row = await c.execute({ sql: 'SELECT linked_party_id FROM suppliers WHERE id = ?', args: [supplierId] })
  const root = n(row.rows[0]?.linked_party_id) || supplierId
  const linked = await c.execute({ sql: 'SELECT id FROM suppliers WHERE linked_party_id = ?', args: [root] })
  return Array.from(new Set([root, supplierId, ...linked.rows.map((r) => Number(r.id))]))
}

export async function supplierFyTaxable(
  supplierId: number,
  dateStr: string,
  excludeId: number
): Promise<number> {
  const { start, end } = fyRange(dateStr)
  const c = getClient()
  const ids = await relatedSupplierIds(supplierId)
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(taxable_value), 0) AS t FROM orders
          WHERE supplier_id IN (${ids.map(() => '?').join(',')}) AND order_date BETWEEN ? AND ? AND id != ? AND company_id = ?`,
    args: [...ids, start, dateStr, excludeId || 0, getActiveCompanyId()]
  })
  // Add the "purchase bill amount as on <date>" if that date is in this FY —
  // it seeds the cumulative taxable so the TDS slab picks up from the right
  // point. Any of the linked rows can carry its own opening figure.
  const sup = await c.execute({
    sql: `SELECT opening_purchase_amount, opening_purchase_date FROM suppliers WHERE id IN (${ids.map(() => '?').join(',')})`,
    args: ids
  })
  let opening = 0
  for (const r of sup.rows) {
    const od = String(r.opening_purchase_date || '')
    if (od && od >= start && od <= end) opening += Number(r.opening_purchase_amount) || 0
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
  // Manual additional interest (₹ per unit) folds into the adjusted rate too.
  const rawAdjustedRate = i.invoiceRate + interestPerUnit + (i.additionalInterest || 0)

  // Provisional (invoice) block.
  const threshold = i.tdsThreshold || 0
  const abovePct = i.tdsPctAbove || 0
  const prior = i.tdsPrior || 0

  // Suppliers bill each bargain line at a WHOLE-RUPEE rate (rounded up), so the
  // taxable value is the sum of those line values — not one blended rate times
  // the total quantity. With a single bargain this is just ceil(rate) × qty.
  // Each line's own additional interest / interest days (when set) apply only
  // to that line, added straight into its own rate rather than blended in.
  const round2 = (v: number): number => Math.round(v * 100) / 100
  const lines = (i.lines || []).filter((l) => n(l.qty) > 0)
  const lineQty = lines.reduce((s, l) => s + n(l.qty), 0)
  // Whatever the invoice rate carries ABOVE the blended bargain rate — freight
  // the supplier billed inside the rate, usually — belongs on every line, the
  // same way a single-bargain invoice folds it into its one rate. Without this
  // a multi-bargain invoice, priced purely off each bargain's own rate, would
  // silently drop it on every re-save. The paisa guard stops the blended
  // average's OWN rounding from reading as a premium and pushing each line's
  // ceil() up by a whole rupee.
  const blendedRate = lineQty > 0 ? round2(lines.reduce((s, l) => s + n(l.rate) * n(l.qty), 0) / lineQty) : 0
  const rawPremium = round2(i.invoiceRate - blendedRate)
  const ratePremium = Math.abs(rawPremium) < 0.01 ? 0 : rawPremium
  const taxableValue =
    lines.length > 1 && lineQty > 0
      ? lines.reduce((s, l) => {
          const days = l.interestDays != null ? n(l.interestDays) : interestDays
          const addl = l.additionalInterest != null ? n(l.additionalInterest) : i.additionalInterest || 0
          const kF = (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (days / 365)
          return s + Math.ceil(n(l.rate) + n(l.rate) * kF + addl + ratePremium) * n(l.qty)
        }, 0)
      : Math.ceil(rawAdjustedRate) * i.orderedQty
  // The rate actually charged (taxable ÷ qty) — what the invoice shows per unit.
  const adjustedRate = i.orderedQty > 0 ? taxableValue / i.orderedQty : Math.ceil(rawAdjustedRate)
  const gstAmount = (taxableValue * i.gstPct) / 100
  // The round off lands on the total excluding TDS, and that rounded figure is
  // the base TDS is deducted on — so the rounding flows into TDS and the net.
  const roundOff = Number(i.roundOff) || 0
  const roundedTotal = taxableValue + gstAmount + roundOff
  // TDS is rounded to paise ONCE and the net derived from that rounded
  // figure, so the summary and the ledger cannot disagree by a paisa.
  const tdsAmount = round2(tierTds(roundedTotal, prior, threshold, i.tdsPct, abovePct))
  const netAmount = round2(roundedTotal - tdsAmount)

  // Final (bargain rate) block.
  const finalTaxable = i.bargainRate * i.orderedQty
  const finalGst = (finalTaxable * i.gstPct) / 100
  const finalRounded = finalTaxable + finalGst + roundOff
  const finalTds = round2(tierTds(finalRounded, prior, threshold, i.tdsPct, abovePct))
  const finalNet = round2(finalRounded - finalTds)

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
           -- Read the product master first; oil_types is only a legacy mirror kept
           -- for the FK, and a product missing from it left the label blank.
           -- A product may carry its label in name with a blank code, so empty
           -- strings have to fall through as well as NULLs.
           COALESCE(NULLIF(pr.code, ''), NULLIF(pr.name, ''), NULLIF(ot.code, ''), ot.name) AS oil_code,
           COALESCE(NULLIF(pr.name, ''), NULLIF(pr.code, ''), ot.name) AS oil_name,
           -- "Category" is material_type on the Products master; pr.category is
           -- its Sub-category, exposed separately so both can be shown.
           pr.material_type AS product_category,
           pr.category AS product_sub_category,
           src.name AS source_name,
           t.name AS transporter_name,
           (SELECT COUNT(*) FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_count,
           (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id) AS tanker_nos,
           -- How this purchase is being funded, if through an LC. A purchase is
           -- tagged by issuing a bill under an LC against it, so the LC comes
           -- back through lc_issuances rather than sitting on the order itself.
           (SELECT GROUP_CONCAT(DISTINCT lc.lc_no) FROM lc_issuances li
              JOIN letters_of_credit lc ON lc.id = li.lc_id
             WHERE li.order_id = o.id) AS lc_nos,
           (SELECT li.lc_id FROM lc_issuances li WHERE li.order_id = o.id LIMIT 1) AS lc_id,
           (SELECT COALESCE(SUM(li.amount), 0) FROM lc_issuances li WHERE li.order_id = o.id) AS lc_amount,
           -- Outstanding until every bill drawn for it has been settled.
           (SELECT COUNT(*) FROM lc_issuances li
             WHERE li.order_id = o.id AND COALESCE(li.status, 'outstanding') != 'settled') AS lc_bills_open,
           (SELECT MIN(li.due_date) FROM lc_issuances li
             WHERE li.order_id = o.id AND COALESCE(li.status, 'outstanding') != 'settled') AS lc_next_due,
           -- Settled via the Payment/Receipt voucher's bill-wise allocation
           -- (Accounting), linked to this exact order — not the old
           -- payments-page mechanism, which is being removed.
           COALESCE((SELECT SUM(ba.amount) FROM journal_bill_allocs ba WHERE ba.order_id = o.id AND ba.method = 'agst_ref'), 0) AS paid_amount
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products pr ON pr.id = o.oil_type_id
    LEFT JOIN products ot ON ot.id = o.oil_type_id
    LEFT JOIN sources src ON src.id = o.source_id
    LEFT JOIN transporters t ON t.id = o.transporter_id
    WHERE o.company_id = ?
    ORDER BY o.id DESC
  `
  })
  return toPlain(res)
}

// Per-bargain rate/qty shares for the tankers on an invoice. A split tanker
// contributes to BOTH its primary and its excess bargain, so an invoice spanning
// two bargains is priced line-wise (each at its own rate) like the supplier does.
async function bargainLinesForTankers(
  tankerIds: unknown
): Promise<{ rate: number; qty: number; bargainId: number }[]> {
  const ids = (Array.isArray(tankerIds) ? tankerIds : []).map((x) => n(x)).filter((x) => x > 0)
  if (ids.length === 0) return []
  const res = await getClient().execute({
    sql: `SELECT pt.loaded_qty, pt.extra_qty, pt.bargain_id, pt.extra_bargain_id,
                 b.rate_per_uom AS rate, xb.rate_per_uom AS extra_rate
          FROM purchase_tankers pt
          LEFT JOIN bargains b ON b.id = pt.bargain_id
          LEFT JOIN bargains xb ON xb.id = pt.extra_bargain_id
          WHERE pt.id IN (${ids.map(() => '?').join(',')})`,
    args: ids
  })
  const m = new Map<string, { rate: number; qty: number; bargainId: number }>()
  const add = (id: unknown, rate: number, qty: number): void => {
    if (!id || qty <= 0) return
    const k = String(id)
    const cur = m.get(k) || { rate, qty: 0, bargainId: n(id) }
    cur.qty += qty
    m.set(k, cur)
  }
  for (const r of toPlain(res)) {
    const loaded = n(r.loaded_qty)
    const extra = r.extra_bargain_id ? n(r.extra_qty) : 0
    add(r.bargain_id, n(r.rate), loaded - extra)
    if (extra > 0) add(r.extra_bargain_id, n(r.extra_rate), extra)
  }
  return Array.from(m.values())
}

// Per-bargain additional-interest / interest-days overrides typed on the
// form, merged onto the priced lines by bargain id before computeMoney runs.
interface BargainInterestOverride {
  bargain_id: number
  additional_interest?: number | string | null
  interest_days?: number | string | null
}
function applyBargainInterestOverrides<T extends { rate: number; qty: number; bargainId?: number }>(
  lines: T[],
  overrides: unknown
): (T & { additionalInterest?: number; interestDays?: number })[] {
  const list = Array.isArray(overrides) ? (overrides as BargainInterestOverride[]) : []
  const byBargain = new Map(list.map((o) => [n(o.bargain_id), o]))
  return lines.map((l) => {
    const o = l.bargainId ? byBargain.get(l.bargainId) : undefined
    const additionalInterest =
      o && o.additional_interest != null && o.additional_interest !== '' ? n(o.additional_interest) : undefined
    const interestDays =
      o && o.interest_days != null && o.interest_days !== '' ? n(o.interest_days) : undefined
    return { ...l, additionalInterest, interestDays }
  })
}

async function saveOrderBargainInterest(orderId: number, overrides: unknown): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM order_bargain_interest WHERE order_id = ?', args: [orderId] })
  const list = Array.isArray(overrides) ? (overrides as BargainInterestOverride[]) : []
  for (const o of list) {
    const bargainId = n(o.bargain_id)
    const additionalInterest = o.additional_interest != null && o.additional_interest !== '' ? n(o.additional_interest) : 0
    const interestDays = o.interest_days != null && o.interest_days !== '' ? n(o.interest_days) : 0
    if (!bargainId || (!additionalInterest && !interestDays)) continue
    await c.execute({
      sql: 'INSERT INTO order_bargain_interest (order_id, bargain_id, additional_interest, interest_days) VALUES (?, ?, ?, ?)',
      args: [orderId, bargainId, additionalInterest, interestDays]
    })
  }
}

export async function listOrderBargainInterest(orderId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: 'SELECT bargain_id, additional_interest, interest_days FROM order_bargain_interest WHERE order_id = ?',
    args: [orderId]
  })
  return toPlain(res)
}

// How a consignment / direct purchase is spread across bargains. The quantity is
// typed rather than taken tanker by tanker, so the split lives on the invoice.
export interface OrderBargainLine {
  bargain_id: number
  qty: number
}

// Merge repeated bargains, drop empties. Adding the same bargain twice simply
// means "put more quantity on it".
function toBargainLines(v: unknown): OrderBargainLine[] {
  const m = new Map<number, OrderBargainLine>()
  for (const l of Array.isArray(v) ? v : []) {
    const id = n((l as OrderBargainLine)?.bargain_id)
    const qty = n((l as OrderBargainLine)?.qty)
    if (!id || qty <= 0) continue
    const cur = m.get(id) || { bargain_id: id, qty: 0 }
    cur.qty += qty
    m.set(id, cur)
  }
  return Array.from(m.values())
}

// Check the lines against the invoice and each bargain, and return them priced.
async function priceBargainLines(
  lines: OrderBargainLine[],
  supplierId: number,
  productId: number,
  orderedQty: number,
  uom: string
): Promise<{ lines: { rate: number; qty: number; bargainId: number }[]; primaryBargainId: number }> {
  if (!lines.length) return { lines: [], primaryBargainId: 0 }
  const total = lines.reduce((sum, l) => sum + l.qty, 0)
  if (Math.abs(total - orderedQty) > 0.001) {
    throw new Error(
      `The bargain quantities add up to ${total.toFixed(3)} but the invoice is for ${orderedQty.toFixed(3)} ${uom}`
    )
  }
  const out: { rate: number; qty: number; bargainId: number }[] = []
  for (const l of lines) {
    const r = await getClient().execute({
      sql: 'SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom FROM bargains WHERE id = ? LIMIT 1',
      args: [l.bargain_id]
    })
    if (!r.rows.length) throw new Error('One of the chosen bargains no longer exists')
    const b = toPlain(r)[0]
    if (n(b.supplier_id) !== supplierId) throw new Error(`Bargain ${b.bargain_no} belongs to a different supplier`)
    if (n(b.oil_type_id) !== productId) throw new Error(`Bargain ${b.bargain_no} is for a different product`)
    out.push({ rate: n(b.rate_per_uom), qty: l.qty, bargainId: l.bargain_id })
  }
  return { lines: out, primaryBargainId: lines[0].bargain_id }
}

async function saveOrderBargains(orderId: number, lines: OrderBargainLine[]): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM order_bargains WHERE order_id = ?', args: [orderId] })
  for (const l of lines) {
    await c.execute({
      sql: 'INSERT INTO order_bargains (order_id, bargain_id, qty) VALUES (?, ?, ?)',
      args: [orderId, l.bargain_id, l.qty]
    })
  }
}

export async function listOrderBargains(orderId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ob.id, ob.bargain_id, ob.qty, b.bargain_no, b.rate_per_uom, b.bargain_date
          FROM order_bargains ob LEFT JOIN bargains b ON b.id = ob.bargain_id
          WHERE ob.order_id = ? ORDER BY ob.id`,
    args: [orderId]
  })
  return toPlain(res)
}

// Consignment / direct draws across every bargain — the rows a bargain needs to
// show alongside its tankers, since these purchases carry no tanker of their own.
export async function listConsignmentDraws(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ob.bargain_id, ob.qty, o.id AS order_id, o.invoice_no, o.order_date, o.uom,
                 o.invoice_rate, o.adjusted_rate, o.taxable_value, o.ordered_qty,
                 s.name AS supplier_name, p.code AS oil_code, p.name AS oil_name,
                 (SELECT GROUP_CONCAT(cs.tanker_no, ', ') FROM consignment_stock cs
                   WHERE cs.order_id = o.id AND cs.tanker_no IS NOT NULL) AS tanker_nos
          FROM order_bargains ob
          JOIN orders o ON o.id = ob.order_id
          LEFT JOIN suppliers s ON s.id = o.supplier_id
          LEFT JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ?
          ORDER BY o.order_date, o.id`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res)
}

export async function createOrder(v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  // No tanker movement: the goods are already at our site, so the invoice is
  // booked in one step (no transporter, straight to 'received'). Either an
  // explicit consignment draw or a supplier the master flags as direct.
  // Trading: bought and sold straight through, no bargain and no tanker — it
  // takes the same no-movement booking path as a consignment/direct purchase,
  // it just also never lands in stock (affects_stock, set below).
  const isTrading = !!v.is_trading
  const isConsignment = !!v.is_consignment || !!supplier?.skip_tanker_stages || isTrading
  // The company this purchase belongs to. It is chosen on the form, so a tanker
  // recorded under the wrong company can be billed into the right one — the
  // tankers move with the invoice (see assignTankers). A consignment lot pick
  // below must resolve against this SAME company, since a deposit and the
  // purchase drawing on it always belong to one company together.
  const bookInCompany = v.company_id ? n(v.company_id) : getActiveCompanyId()
  // Tankers picked from Log Consignment Stock, each with the bargain(s) it draws
  // against. The invoiced quantity is their sum, exactly as a tanker-based
  // invoice adds up its loaded qty. Validated up front so a bad pick never
  // leaves a half-written invoice behind.
  const picks = toLotPicks(v.consignment_lot_ids)
  let lotAlloc: LotAllocation = { total: 0, lines: [], primaryBargainId: 0 }
  if (picks.length) {
    lotAlloc = await validateConsignmentLots(picks, n(v.supplier_id), n(v.oil_type_id), 0, bookInCompany)
    v.ordered_qty = lotAlloc.total
    // The invoice's own bargain_id is the first tanker's — the split lives on
    // the tankers, as it does for loaded ones.
    if (lotAlloc.primaryBargainId) v.bargain_id = lotAlloc.primaryBargainId
  }
  // Typed-quantity route: the user enters how much is being invoiced and splits
  // it across bargains by hand.
  const obLines = picks.length ? [] : toBargainLines(v.bargain_lines)
  let obPriced: { lines: { rate: number; qty: number }[]; primaryBargainId: number } = { lines: [], primaryBargainId: 0 }
  if (obLines.length) {
    obPriced = await priceBargainLines(
      obLines,
      n(v.supplier_id),
      n(v.oil_type_id),
      n(v.ordered_qty),
      String(v.uom || 'MT')
    )
    if (obPriced.primaryBargainId) v.bargain_id = obPriced.primaryBargainId
  }
  if (isConsignment) {
    if (n(v.ordered_qty) <= 0) throw new Error('Enter the quantity to invoice')
    // Whenever the party actually holds stock with us, the invoice can never
    // draw more than its balance — whether the tankers were named or the
    // quantity typed. A plain direct-purchase supplier holds nothing, so it is
    // unrestricted. A Trading purchase never draws on consigned stock at all —
    // it is a separate pass-through deal, not a draw against what that
    // supplier has deposited with us. The balance is checked in the SAME
    // company the invoice is being booked into — a consignment deposit and its
    // purchase always belong to one company together.
    const deposited = isTrading ? 0 : await consignmentDeposited(n(v.supplier_id), n(v.oil_type_id), bookInCompany)
    if (deposited > 0) {
      const avail = await consignmentAvailable(n(v.supplier_id), n(v.oil_type_id), bookInCompany)
      if (n(v.ordered_qty) > avail + 1e-6) {
        throw new Error(`Only ${avail.toFixed(3)} of consigned stock is available for this supplier and product`)
      }
    }
  }
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), 0)
  const roundOff = n(v.round_off)
  // Consignment tankers bring their own per-bargain split; otherwise the split
  // comes from the loaded tankers on the invoice.
  const bargainLines = obPriced.lines.length
    ? obPriced.lines
    : lotAlloc.lines.length
      ? lotAlloc.lines.map((l) => ({ rate: l.rate, qty: l.qty, bargainId: l.bargain_id }))
      : await bargainLinesForTankers(v.tanker_ids)
  const pricedLines = applyBargainInterestOverrides(bargainLines, v.bargain_interest)
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
    additionalInterest: n(v.additional_interest),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior,
    roundOff,
    lines: pricedLines
  })
  const res = await getClient().execute({
    sql: `INSERT INTO orders
      (company_id, invoice_no, order_date, bargain_id, supplier_id, oil_type_id, bargain_type, ordered_qty, uom,
       bargain_rate, invoice_rate, interest_pct, interest_days, additional_interest, adjusted_rate, taxable_value,
       gst_pct, gst_type, gst_amount, tds_pct, tds_amount, round_off, round_off_manual, net_amount,
       final_taxable_value, final_gst_amount, final_tds_amount, final_net_amount,
       tanker_no, transporter_id, allowed_shortage_pct, is_registered_transporter, posting, financed_by_party,
       payment_cleared_date, remarks, freight_paid_to_supplier, is_consignment, received_qty, received_date, status,
       is_trading, affects_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      bookInCompany,
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
      n(v.additional_interest),
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      roundOff,
      v.round_off_manual ? 1 : 0,
      m.net_amount,
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
      v.freight_paid_to_supplier ? 1 : 0,
      isConsignment ? 1 : 0,
      // consignment goods are already at site → received on booking
      isConsignment ? n(v.ordered_qty) : null,
      isConsignment ? v.order_date : null,
      isConsignment ? 'received' : 'loaded',
      isTrading ? 1 : 0,
      isTrading ? 0 : 1
    ]
  })
  const id = Number(res.lastInsertRowid)
  if (isConsignment) {
    if (picks.length) {
      const alloc = await assignConsignmentLots(id, picks, n(v.supplier_id), n(v.oil_type_id), bookInCompany)
      // Mirror the tanker split onto the invoice, which is what the register reads.
      await saveOrderBargains(id, alloc.lines.map((l) => ({ bargain_id: l.bargain_id, qty: l.qty })))
    } else {
      await saveOrderBargains(
        id,
        obLines.length ? obLines : v.bargain_id ? [{ bargain_id: n(v.bargain_id), qty: n(v.ordered_qty) }] : []
      )
      await autoAssignConsignmentLots(id, n(v.supplier_id), n(v.oil_type_id), n(v.ordered_qty), n(v.bargain_id), bookInCompany)
    }
  } else {
    await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id), bookInCompany)
    await applySupplierFreight(id, v)
  }
  await saveOrderBargainInterest(id, v.bargain_interest)
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
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
    net: m.net_amount,
    roundOff,
    interest: m.interest_per_unit * n(v.ordered_qty)
  }).catch((e) => console.error('[journal] purchase post failed:', (e as Error).message))
}

export async function updateOrder(id: number, v: Row): Promise<{ id: number }> {
  await ensureOilType(n(v.oil_type_id))
  const supplier = await getSupplier(n(v.supplier_id))
  const cur = await getClient().execute({
    sql: 'SELECT is_consignment FROM orders WHERE id = ? LIMIT 1',
    args: [id]
  })
  const wasConsignment = !!cur.rows[0]?.is_consignment
  const picks = toLotPicks(v.consignment_lot_ids)
  // Re-picked tankers redefine the invoiced quantity — checked before any write.
  let lotAlloc: LotAllocation = { total: 0, lines: [], primaryBargainId: 0 }
  if (wasConsignment && picks.length) {
    lotAlloc = await validateConsignmentLots(picks, n(v.supplier_id), n(v.oil_type_id), id)
    v.ordered_qty = lotAlloc.total
    if (lotAlloc.primaryBargainId) v.bargain_id = lotAlloc.primaryBargainId
  }
  const obLines = wasConsignment && !picks.length ? toBargainLines(v.bargain_lines) : []
  let obPriced: { lines: { rate: number; qty: number; bargainId: number }[]; primaryBargainId: number } = {
    lines: [],
    primaryBargainId: 0
  }
  if (obLines.length) {
    obPriced = await priceBargainLines(
      obLines,
      n(v.supplier_id),
      n(v.oil_type_id),
      n(v.ordered_qty),
      String(v.uom || 'MT')
    )
    if (obPriced.primaryBargainId) v.bargain_id = obPriced.primaryBargainId
  }
  const prior = await supplierFyTaxable(n(v.supplier_id), String(v.order_date), id)
  const roundOff = n(v.round_off)
  const bargainLines = obPriced.lines.length
    ? obPriced.lines
    : lotAlloc.lines.length
      ? lotAlloc.lines.map((l) => ({ rate: l.rate, qty: l.qty, bargainId: l.bargain_id }))
      : await bargainLinesForTankers(v.tanker_ids)
  const pricedLines = applyBargainInterestOverrides(bargainLines, v.bargain_interest)
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
    additionalInterest: n(v.additional_interest),
    tdsThreshold: n(supplier?.tds_threshold),
    tdsPctAbove: n(v.tds_pct),
    tdsPrior: prior,
    roundOff,
    lines: pricedLines
  })
  await saveOrderBargainInterest(id, v.bargain_interest)
  await getClient().execute({
    sql: `UPDATE orders SET
      invoice_no = ?, order_date = ?, bargain_id = ?, supplier_id = ?, oil_type_id = ?, bargain_type = ?,
      ordered_qty = ?, uom = ?, bargain_rate = ?, invoice_rate = ?, interest_pct = ?, interest_days = ?, additional_interest = ?,
      adjusted_rate = ?, taxable_value = ?, gst_pct = ?, gst_type = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?, round_off_manual = ?, net_amount = ?,
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
      n(v.additional_interest),
      m.adjusted_rate,
      m.taxable_value,
      n(v.gst_pct),
      v.gst_type || 'CGST_SGST',
      m.gst_amount,
      n(v.tds_pct),
      m.tds_amount,
      roundOff,
      v.round_off_manual ? 1 : 0,
      m.net_amount,
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
  // A direct/consignment invoice has no tankers of its own; keep the received
  // qty locked to the invoiced qty instead of walking the movement stages, and
  // re-assert status='received' — createOrder sets this at booking time, but
  // an edit never touched it, so a row that somehow drifted to 'loaded'
  // (or was created before this invariant existed) would stay stuck there,
  // silently excluded from stock, forever.
  if (wasConsignment) {
    await getClient().execute({
      sql: "UPDATE orders SET received_qty = ?, status = 'received' WHERE id = ?",
      args: [n(v.ordered_qty), id]
    })
    // Re-pick the consignment tankers this invoice draws, and re-state how the
    // quantity is spread across bargains.
    await releaseConsignmentLots(id)
    if (picks.length) {
      const alloc = await assignConsignmentLots(id, picks, n(v.supplier_id), n(v.oil_type_id))
      await saveOrderBargains(id, alloc.lines.map((l) => ({ bargain_id: l.bargain_id, qty: l.qty })))
    } else {
      await saveOrderBargains(
        id,
        obLines.length ? obLines : v.bargain_id ? [{ bargain_id: n(v.bargain_id), qty: n(v.ordered_qty) }] : []
      )
      await autoAssignConsignmentLots(id, n(v.supplier_id), n(v.oil_type_id), n(v.ordered_qty), n(v.bargain_id))
    }
  } else {
    await getClient().execute({ sql: 'UPDATE purchase_tankers SET order_id = NULL WHERE order_id = ?', args: [id] })
    const moveTo = v.company_id ? n(v.company_id) : 0
    if (moveTo) {
      await getClient().execute({ sql: 'UPDATE orders SET company_id = ? WHERE id = ?', args: [moveTo, id] })
    }
    await assignTankers(id, v.tanker_ids, n(v.bargain_id), n(v.transporter_id), moveTo)
    await applySupplierFreight(id, v)
  }
  await setSupplierPayable(id, n(v.supplier_id), m.net_amount, String(v.order_date))
  await postOrderJournal(id, v, m, supplier, roundOff)
  return { id }
}

// A few things point at a purchase that deleteOrder itself doesn't own —
// unlike the ledger rows/tankers/consignment lots below (which the delete is
// allowed to unwind), these represent a decision made elsewhere (an LC
// naming this invoice, a bill already issued against it, a trading deal
// built from it) that would otherwise surface as a raw FOREIGN KEY error
// instead of telling the user what to undo first.
async function assertOrderNotInUse(id: number): Promise<void> {
  const c = getClient()
  const lc = await c.execute({
    sql: `SELECT l.lc_no FROM lc_linked_orders lo JOIN letters_of_credit l ON l.id = lo.lc_id WHERE lo.order_id = ? LIMIT 1`,
    args: [id]
  })
  if (lc.rows.length) {
    throw new Error(
      `This purchase is linked to LC ${lc.rows[0].lc_no} — edit that LC and untick this invoice before deleting it.`
    )
  }
  const issuance = await c.execute({
    sql: `SELECT l.lc_no FROM lc_issuances i JOIN letters_of_credit l ON l.id = i.lc_id WHERE i.order_id = ? LIMIT 1`,
    args: [id]
  })
  if (issuance.rows.length) {
    throw new Error(
      `A bill has already been issued against this purchase under LC ${issuance.rows[0].lc_no} — that bill has to be removed first.`
    )
  }
  const deal = await c.execute({
    sql: `SELECT DISTINCT d.id, d.deal_date FROM trading_deals d
          LEFT JOIN trading_deal_orders x ON x.deal_id = d.id
          WHERE d.order_id = ? OR x.order_id = ? LIMIT 1`,
    args: [id, id]
  })
  if (deal.rows.length) {
    throw new Error(
      `This purchase is part of a Trading deal dated ${String(deal.rows[0].deal_date).slice(0, 10)} — remove it from that deal on the Trading page first.`
    )
  }
}

export async function deleteOrder(id: number): Promise<{ id: number }> {
  const c = getClient()
  await assertOrderNotInUse(id)
  await deleteJournalByRef('order_id', id)
  await c.execute({ sql: 'DELETE FROM supplier_ledger WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE order_id = ?', args: [id] })
  // Honour what the delete promises: the tankers return to the loaded queue, so
  // the stages walked after loading are cleared along with the invoice link.
  await c.execute({
    sql: `UPDATE purchase_tankers
          SET order_id = NULL, status = 'loaded', transit_date = NULL, outside_factory_date = NULL,
              inside_factory_date = NULL, empty_date = NULL, received_qty = NULL
          WHERE order_id = ?`,
    args: [id]
  })
  // Consignment tankers this invoice drew go back to pending, and its bargain
  // allocation goes with it.
  await releaseConsignmentLots(id)
  await c.execute({ sql: 'DELETE FROM order_bargains WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM order_bargain_interest WHERE order_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] })
  return { id }
}

async function assignTankers(
  orderId: number,
  tankerIds: unknown,
  bargainId: number,
  transporterId: number,
  companyId = 0
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
      // A tanker belongs to whichever company its invoice was booked in, so a
      // clerical mix-up is corrected by re-billing rather than by editing rows.
      sql: `UPDATE purchase_tankers SET order_id = ?,
            company_id = CASE WHEN ? > 0 THEN ? ELSE company_id END,
            transporter_id = CASE WHEN ? > 0 THEN ? ELSE transporter_id END WHERE id = ?`,
      args: [orderId, companyId, companyId, transporterId, transporterId, tankerId]
    })
  }
}

// allCompanies = true is used by the (shared) Gate Entry screen.
export async function listPurchaseTankers(allCompanies = false): Promise<Row[]> {
  const res = await getClient().execute({
    args: allCompanies ? [] : [getActiveCompanyId()],
    sql: `
    SELECT pt.*, o.invoice_no, o.order_date AS invoice_date, o.company_id AS invoice_company_id,
           o.allowed_shortage_pct AS order_allowed_shortage_pct,
           b.bargain_no, b.bargain_type, b.rate_per_uom AS bargain_rate,
           b.allowed_shortage_pct, s.name AS supplier_name,
           p.code AS oil_code, p.name AS oil_name, src.name AS source_name,
           p.material_type AS product_category,
           tr.name AS transporter_name, xb.bargain_no AS extra_bargain_no,
           xb.rate_per_uom AS extra_bargain_rate,
           -- what the gate recorded for this tanker: its own entry number and
           -- the vehicle number written down there, which is the number the
           -- yard actually saw.
           ge.gate_entry_no, ge.tanker_no AS gate_tanker_no, ge.entry_date AS gate_date,
           ge.received_qty AS gate_qty,
           (SELECT old_tanker_no || ' -> ' || new_tanker_no || ' (' || loss_qty || ' lost)'
              FROM tanker_replacements WHERE tanker_id = pt.id ORDER BY id DESC LIMIT 1) AS last_replacement
    FROM purchase_tankers pt
    LEFT JOIN orders o ON o.id = pt.order_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN bargains xb ON xb.id = pt.extra_bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN products p ON p.id = pt.oil_type_id
    LEFT JOIN sources src ON src.id = pt.source_id
    LEFT JOIN transporters tr ON tr.id = pt.transporter_id
    LEFT JOIN gate_entries ge ON ge.tanker_id = pt.id AND ge.direction = 'in'
    ${allCompanies ? '' : 'WHERE pt.company_id = ?'}
    ORDER BY CASE pt.status
      WHEN 'supplier_factory' THEN 1 WHEN 'loaded' THEN 2 WHEN 'transit' THEN 3
      WHEN 'outside_factory' THEN 4 WHEN 'inside_factory' THEN 5 ELSE 6 END, pt.id DESC
  `
  })
  return toPlain(res)
}

export async function createPurchaseTanker(v: Row): Promise<{ id: number }> {
  // Tanker number is often unknown when sending to the supplier — only the
  // bargain is required now; the number is filled in at the Loaded stage.
  if (!v.bargain_id) throw new Error('Bargain is required')
  // Transporter is optional at send time (for both EX and DLD); it can still be
  // set later — the Empty stage requires it for EX freight posting.
  const res = await getClient().execute({
    sql: `INSERT INTO purchase_tankers
      (company_id, tanker_no, loaded_date, bargain_id, supplier_id, oil_type_id, loaded_qty, uom, payment_mode,
       transporter_id, status, condition)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, 'supplier_factory', ?)`,
    args: [
      getActiveCompanyId(),
      String(v.tanker_no || '').trim(),
      v.factory_entry_date || v.loaded_date || null,
      n(v.bargain_id),
      n(v.supplier_id),
      n(v.oil_type_id),
      v.uom || 'MT',
      v.transporter_id ? n(v.transporter_id) : null,
      normCondition(v.condition)
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

  // Changing the received qty of an emptied tanker must still match the gate
  // weighment — within a 1 MT operational buffer.
  if (String(t.status) === 'empty' && Math.abs(receivedQty - n(t.received_qty)) > 1e-9) {
    const gateQty = await tankerGateReceived(id)
    if (gateQty == null) throw new Error('No completed gate entry for this tanker')
    if (Math.abs(gateQty - receivedQty) > GATE_MATCH_BUFFER) {
      throw new Error(`Received qty (${receivedQty}) is more than ${GATE_MATCH_BUFFER} MT away from the gate received qty (${gateQty})`)
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
    // This tanker's own EX/DLD choice wins over the bargain's when one was made.
    const isEx = tankerIsEx(v.condition !== undefined ? v.condition : t.condition, b.bargain_type)
    rate = isEx ? rate : 0
    // Freight is earned on what ARRIVED, not on what was loaded — the client's
    // rule, and the reason a shortage costs the transporter twice over (it
    // shrinks the freight base as well as attracting the penalty below).
    transport = receivedQty * rate
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
      krfl_weighment_doc_no = ?, outside_weighment_doc_no = ?, condition = ?
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
      normCondition(pick('condition')),
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
  // The receipt date is when the LAST tanker actually finished — never
  // date('now'), which restamped every order's history on each startup sweep.
  await c.execute({
    sql: `UPDATE orders SET status = ?, received_qty = ?, transport_amount = ?,
          shortage_charge_amount = ?,
          received_date = CASE WHEN ? = 'received' THEN COALESCE(
            (SELECT MAX(COALESCE(pt.empty_date, pt.inside_factory_date, pt.outside_factory_date, pt.transit_date, pt.loaded_date))
             FROM purchase_tankers pt WHERE pt.order_id = orders.id),
            orders.received_date, orders.order_date, date('now'))
          ELSE received_date END
          WHERE id = ?`,
    args: [status, n(x.received_qty), n(x.transport_amount), n(x.shortage_amount), status, orderId]
  })
}

// Startup backfill: recompute each purchase's status/received totals from its
// tankers (fixes rows whose status was corrupted by the old lifecycle remap).
// One-time repair agreed with the client: round off becomes round-to-the-rupee
// of the total excluding TDS, and TDS is charged on that rounded, GST-inclusive
// total (older rows had TDS on the taxable value alone). Stored round offs are
// re-derived rather than trusted, because the form's auto round-off oscillated
// before 0.3.56 and saved whichever value the loop was passing through. Journal
// vouchers are re-posted at the corrected figures. Runs once, behind a flag.
export async function backfillPurchaseRoundOff(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'purchase_round_off_backfilled_3'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sup = await c.execute(
    'SELECT id, name, tds_threshold, tds_above_only, opening_purchase_amount, opening_purchase_date FROM suppliers'
  )
  const suppliers = new Map<number, Row>()
  for (const r of toPlain(sup)) suppliers.set(n(r.id), r)

  const res = await c.execute(`
    SELECT o.id, o.company_id, o.supplier_id, o.invoice_no, o.order_date, o.ordered_qty, o.bargain_rate,
           o.gst_pct, o.interest_pct, o.interest_days, o.taxable_value, o.gst_amount, o.tds_pct, o.tds_amount,
           o.round_off, o.round_off_manual, o.net_amount, o.final_taxable_value, o.final_gst_amount,
           pr.code AS oil_code, pr.name AS oil_name
    FROM orders o LEFT JOIN products pr ON pr.id = o.oil_type_id
    ORDER BY o.order_date ASC, o.id ASC`)

  const round2 = (v: number): number => Math.round(v * 100) / 100
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.005
  // Cumulative FY taxable per (company, supplier), accumulated in date order so
  // each row's TDS slab sees only what was billed before it — what the form saw
  // when the invoice was originally saved.
  const prior = new Map<string, number>()
  let applied = 0
  for (const r of toPlain(res)) {
    const s = suppliers.get(n(r.supplier_id))
    const { start, end } = fyRange(String(r.order_date))
    const key = `${n(r.company_id)}|${n(r.supplier_id)}|${start}`
    if (!prior.has(key)) {
      const od = String(s?.opening_purchase_date || '')
      prior.set(key, od && od >= start && od <= end ? n(s?.opening_purchase_amount) : 0)
    }
    const before = prior.get(key)!
    prior.set(key, before + n(r.taxable_value))

    // A round off the user typed by hand is theirs — never restate it. The FY
    // running total above is still advanced, so later invoices' TDS slabs stay
    // correct.
    if (n(r.round_off_manual) === 1) continue

    // Base rounded to PAISA before the rupee rounding — GST can carry a
    // third decimal, and rounding off from the un-rounded figure left the
    // total a paisa short of whole.
    const T = round2(n(r.taxable_value) + n(r.gst_amount))
    const ro = round2(Math.round(T) - T)
    const pct = s?.tds_above_only ? 0 : n(r.tds_pct)
    const threshold = n(s?.tds_threshold)
    const tds = round2(tierTds(T + ro, before, threshold, pct, n(r.tds_pct)))
    const net = round2(T + ro - tds)
    const fT = round2(n(r.final_taxable_value) + n(r.final_gst_amount))
    const fTds = round2(tierTds(fT + ro, before, threshold, pct, n(r.tds_pct)))
    const fNet = round2(fT + ro - fTds)
    if (same(ro, n(r.round_off)) && same(tds, n(r.tds_amount)) && same(net, n(r.net_amount))) continue

    console.log(
      `[orders] round-off repair #${r.id} ${r.invoice_no} ${r.order_date}: ` +
        `ro ${n(r.round_off).toFixed(2)} -> ${ro.toFixed(2)} | tds ${n(r.tds_amount).toFixed(2)} -> ${tds.toFixed(2)} | ` +
        `net ${n(r.net_amount).toFixed(2)} -> ${net.toFixed(2)}`
    )
    await c.execute({
      sql: 'UPDATE orders SET round_off = ?, tds_amount = ?, net_amount = ?, final_tds_amount = ?, final_net_amount = ? WHERE id = ?',
      args: [ro, tds, net, fTds, fNet, n(r.id)]
    })
    const interestPerUnit =
      n(r.bargain_rate) * (1 + n(r.gst_pct) / 100) * (n(r.interest_pct) / 100) * (n(r.interest_days) / 365)
    await postPurchaseJournal({
      orderId: n(r.id),
      date: String(r.order_date),
      invoiceNo: String(r.invoice_no || ''),
      oilCode: String(r.oil_code || r.oil_name || 'OIL').toUpperCase(),
      supplierName: String(s?.name || 'SUPPLIER'),
      taxable: n(r.taxable_value),
      gst: n(r.gst_amount),
      tds,
      net,
      roundOff: ro,
      interest: interestPerUnit * n(r.ordered_qty),
      companyId: n(r.company_id) || 1
    }).catch((e) => console.error('[orders] journal re-post failed:', (e as Error).message))
    // The payable ledger entry mirrors net_amount, so it has to be restated
    // with it or the supplier's balance keeps the old figure.
    if (n(r.supplier_id)) {
      await setSupplierPayable(n(r.id), n(r.supplier_id), net, String(r.order_date)).catch((e) =>
        console.error('[orders] payable re-post failed:', (e as Error).message)
      )
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('purchase_round_off_backfilled_3', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[orders] round-off repair corrected ${applied} purchases`)
}

export async function backfillOrderStatuses(): Promise<void> {
  const c = getClient()
  const res = await c.execute(
    'SELECT DISTINCT order_id FROM purchase_tankers WHERE order_id IS NOT NULL'
  )
  for (const r of res.rows) {
    await syncPurchaseFromTankers(n(r.order_id)).catch(() => {})
  }
}

// Undo a mistaken stage move: step the tanker BACK one stage and clear the
// abandoned stage's date. Never below 'loaded' (loading fixed the quantity and
// drew the bargain). If the tanker belongs to an invoice, the order's status
// re-syncs, so a received purchase correctly drops back to loaded.
// Swap the physical vehicle mid-transit — accident, breakdown, whatever
// stops the original tanker completing the trip. The bargain/order/financials
// on this tanker row stay exactly as they were; only its number changes, and
// whatever quantity didn't make it onto the replacement comes off loaded_qty
// (so the bargain's balance and the gate's later weighment both reconcile
// against what actually still arrives). Restricted to Transit — before the
// tanker is billed (Outside Factory onward requires an invoice already tied
// to its original loaded_qty, which a retroactive cut would desync).
export async function replaceTanker(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Tanker not found')
  const tanker = toPlain(res)[0]
  if (String(tanker.status) !== 'transit') {
    throw new Error('A tanker can only be replaced while In Transit — it is already billed once past that stage')
  }
  const newTankerNo = String(v.new_tanker_no || '').trim()
  if (!newTankerNo) throw new Error('Enter the replacement tanker number')
  const lossQty = n(v.loss_qty)
  if (lossQty < 0) throw new Error('Loss quantity cannot be negative')
  if (lossQty >= n(tanker.loaded_qty)) {
    throw new Error(`Loss cannot be at or above the ${n(tanker.loaded_qty)} ${tanker.uom || 'MT'} loaded — nothing would remain to replace`)
  }
  const newLoadedQty = Math.round((n(tanker.loaded_qty) - lossQty) * 1000) / 1000
  const replacedDate = v.date ? String(v.date).slice(0, 10) : todayISO()
  await c.execute({
    sql: 'UPDATE purchase_tankers SET tanker_no = ?, loaded_qty = ?, loss_qty = loss_qty + ? WHERE id = ?',
    args: [newTankerNo, newLoadedQty, lossQty, id]
  })
  await c.execute({
    sql: `INSERT INTO tanker_replacements (tanker_id, old_tanker_no, new_tanker_no, loss_qty, reason, replaced_date)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, tanker.tanker_no || null, newTankerNo, lossQty, v.reason ? String(v.reason).trim() : null, replacedDate]
  })
  return { id }
}

export async function revertPurchaseTanker(id: number): Promise<{ id: number; status: string }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM purchase_tankers WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Tanker not found')
  const tanker = toPlain(res)[0]
  const current = TANKER_STAGES.indexOf(String(tanker.status))
  const min = TANKER_STAGES.indexOf('loaded')
  if (current <= min) throw new Error('Already at Loaded — a loaded tanker cannot go back further')
  const prev = TANKER_STAGES[current - 1]
  const dateCol: Record<string, string> = {
    transit: 'transit_date',
    outside_factory: 'outside_factory_date',
    inside_factory: 'inside_factory_date',
    empty: 'empty_date'
  }
  const clear = dateCol[String(tanker.status)]
  await c.execute({
    sql: `UPDATE purchase_tankers SET status = ?${clear ? `, ${clear} = NULL` : ''}${String(tanker.status) === 'empty' ? ', received_qty = NULL' : ''} WHERE id = ?`,
    args: [prev, id]
  })
  if (tanker.order_id) await syncPurchaseFromTankers(n(tanker.order_id)).catch(() => {})
  return { id, status: prev }
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
    // Tanker number is mandatory at loading (it may have been left blank when the
    // tanker was sent to the supplier). Take the value entered now, else keep any
    // existing one; blank is not allowed past this stage.
    const tankerNo = String(data.tanker_no ?? tanker.tanker_no ?? '').trim()
    if (!tankerNo) throw new Error('Tanker number is required at loading')
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
    // confirmation the excess is either (a) allocated to another EXISTING open
    // bargain (same supplier/oil), or (b) booked as its own new bargain line.
    // Either way this tanker's consumption is split across the two bargains.
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

      if (data.expand_bargain) {
        // (c) Grow THIS bargain by the excess so the whole load stays on one
        // bargain (logged as a dated Addition at the bargain's own rate). No
        // split — the full qty consumes from bargainId.
        await adjustBargainQty(
          bargainId,
          extraQty,
          `Extra ${extraQty.toFixed(3)} ${orig.uom} on tanker ${tanker.tanker_no || id} at loading`,
          String(data.loaded_date || '').slice(0, 10) || undefined
        )
        extraBargainId = null
        extraQty = 0
      } else if (data.extra_bargain_id) {
        // (a) Use the next available bargain — must be a different bargain with
        // enough balance for the excess quantity.
        const chosenId = n(data.extra_bargain_id)
        if (chosenId === bargainId) throw new Error('The excess bargain must be different from the loading bargain')
        const chRes = await c.execute({
          sql: `SELECT b.id, b.supplier_id, b.oil_type_id,
                  b.qty
                    - COALESCE((SELECT SUM(loaded_qty - COALESCE(extra_qty, 0)) FROM purchase_tankers WHERE bargain_id = b.id AND id != ?), 0)
                    - COALESCE((SELECT SUM(extra_qty) FROM purchase_tankers WHERE extra_bargain_id = b.id AND id != ?), 0)
                    - COALESCE((SELECT SUM(ordered_qty) FROM orders WHERE bargain_id = b.id AND is_consignment = 1), 0)
                  AS balance
                FROM bargains b WHERE b.id = ?`,
          args: [id, id, chosenId]
        })
        if (!chRes.rows.length) throw new Error('Selected bargain not found')
        const ch = chRes.rows[0]
        if (n(ch.supplier_id) !== n(orig.supplier_id) || n(ch.oil_type_id) !== n(orig.oil_type_id)) {
          throw new Error('The excess bargain must be for the same supplier and oil')
        }
        if (extraQty > n(ch.balance) + 1e-6) {
          throw new Error(`The selected bargain has only ${n(ch.balance).toFixed(3)} balance for the ${extraQty.toFixed(3)} excess`)
        }
        extraBargainId = chosenId
      } else {
        // (b) Book the excess as a brand-new bargain line (optional rate).
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
      sql: `UPDATE purchase_tankers SET status = 'transit', tanker_no = ?, bargain_id = ?, loaded_date = ?, loaded_qty = ?,
            payment_mode = ?, transit_date = ?, source_id = ?, expected_delivery_date = ?,
            extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        tankerNo,
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
    // Cross-check against the gate-recorded received quantity for this tanker,
    // allowing a 1 MT operational buffer between weighbridge and receipt.
    const gateQty = await tankerGateReceived(id)
    if (gateQty == null) {
      throw new Error('No gate entry found for this tanker. Record the gate receipt first.')
    }
    if (Math.abs(gateQty - receivedQty) > GATE_MATCH_BUFFER) {
      throw new Error(
        `Received qty (${receivedQty}) is more than ${GATE_MATCH_BUFFER} MT away from the gate received qty (${gateQty}) for this tanker.`
      )
    }
    const bargain = await c.execute({
      sql: 'SELECT bargain_type, rate_per_uom, allowed_shortage_pct FROM bargains WHERE id = ?',
      args: [n(tanker.bargain_id)]
    })
    const b = bargain.rows[0] || {}
    // The tanker's own EX/DLD choice wins over the bargain's when one was made.
    const isEx = tankerIsEx(tanker.condition, b.bargain_type)
    const rate = isEx ? n(data.transport_rate_per_ton) : 0
    // On received qty, not loaded — see the note on the edit path.
    const transport = receivedQty * rate
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
