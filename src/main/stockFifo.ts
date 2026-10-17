import { getClient } from './db'
import { companiesOfFactory } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const r2 = (v: number): number => Math.round(v * 100) / 100

// STOCK MAPPING — where a balance came from, first in first out.
//
// Under FIFO the oil still in the tanks is the oil that came in LAST: what
// went out first was what came in first. So a balance of 110.372 MT of CPO is
// read back from the newest receipt down — the latest tanker's whole quantity,
// then the one before, and so on — until the balance is covered; the last
// entry reached is only partly in it. Each line says what that entry was (its
// tanker, invoice, supplier, rate), what of it is still in stock, and the
// running total, so the balance can be valued at the rates it was bought at.
//
// The inflows are the ones the stock register counts in (stock.ts SOURCES):
// purchases received into stock, dated the day the tanker was emptied (the
// invoice date for a consignment / direct purchase), and production — the
// main product of a batch and any by-product it gave off. Whatever the
// receipts cannot cover is older than every entry here: the opening count.
//
// Read only.
// all: every receipt up to the date, not only the ones FIFO reaches — the
// desk picks by hand which tankers the balance stands for, the way it picks
// loads for a batch's FFA. FIFO's own answer still rides on each line
// (fifo / taken), so it can be ticked in one go.
export async function stockFifoMap(v: { productId: number; companyIds?: number[]; asOf?: string; qty: number; all?: boolean }): Promise<Row> {
  const c = getClient()
  const pid = n(v.productId)
  const want = r3(n(v.qty))
  const asOf = String(v.asOf || '').slice(0, 10)
  const ids = (v.companyIds || []).map(Number).filter((x) => x > 0)
  if (!ids.length) ids.push(...(await companiesOfFactory()))
  const ph = ids.map(() => '?').join(', ')
  const dateCut = asOf ? 'AND d <= ?' : ''
  // A consignment invoice is let through whatever its date: its tankers are
  // dated by the day each was deposited in our tank, and cut on that below.
  const purchaseCut = asOf ? 'AND (consignment = 1 OR d <= ?)' : ''

  const purchases = (
    await c.execute({
      sql: `SELECT * FROM (
              SELECT o.id, 'purchase' AS kind, o.invoice_no,
                     COALESCE(NULLIF(TRIM(o.tanker_no), ''), (SELECT GROUP_CONCAT(pt.tanker_no, ', ') FROM purchase_tankers pt WHERE pt.order_id = o.id),
                              (SELECT GROUP_CONCAT(cs.tanker_no, ', ') FROM consignment_stock cs WHERE cs.order_id = o.id AND cs.tanker_no IS NOT NULL)) AS tanker_no,
                     COALESCE(o.is_consignment, 0) AS consignment,
                     o.received_qty AS qty,
                     CASE WHEN COALESCE(o.invoice_rate, 0) > 0 THEN o.invoice_rate ELSE o.bargain_rate END AS rate,
                     o.order_date, o.company_id, s.name AS party, co.name AS company,
                     b.bargain_no,
                     CASE WHEN COALESCE(o.is_consignment, 0) = 1 THEN o.order_date
                          ELSE COALESCE(o.received_date, o.order_date) END AS d
                FROM orders o
                LEFT JOIN suppliers s ON s.id = o.supplier_id
                LEFT JOIN companies co ON co.id = o.company_id
                LEFT JOIN bargains b ON b.id = o.bargain_id
               WHERE o.status = 'received' AND COALESCE(o.affects_stock, 1) = 1
                 AND o.oil_type_id = ? AND o.company_id IN (${ph})
                 AND COALESCE(o.received_qty, 0) > 0
            ) WHERE 1 = 1 ${purchaseCut}`,
      args: [pid, ...ids, ...(asOf ? [asOf] : [])]
    })
  ).rows as unknown as Row[]

  const made = (
    await c
      .execute({
        sql: `SELECT * FROM (
                SELECT p.id, 'production' AS kind, p.qty AS qty, p.prod_date AS d, p.company_id, co.name AS company
                  FROM production p LEFT JOIN companies co ON co.id = p.company_id
                 WHERE p.product_id = ? AND p.company_id IN (${ph})
                   AND COALESCE(p.kind, 'batch') <> 'recirculation' AND COALESCE(p.qty, 0) > 0
                UNION ALL
                SELECT p.id, 'by-product' AS kind, i.qty AS qty, p.prod_date AS d, p.company_id, co.name AS company
                  FROM production_items i JOIN production p ON p.id = i.production_id
                  LEFT JOIN companies co ON co.id = p.company_id
                 WHERE i.kind = 'output' AND i.product_id = ? AND p.company_id IN (${ph})
                   AND COALESCE(p.kind, 'batch') <> 'recirculation' AND COALESCE(i.qty, 0) > 0
              ) WHERE 1 = 1 ${dateCut}`,
        args: [pid, ...ids, pid, ...ids, ...(asOf ? [asOf] : [])]
      })
      .catch(() => ({ rows: [] }))
  ).rows as unknown as Row[]

  // One line per TANKER, not per invoice. An invoice's received quantity is
  // shared out over its tankers in proportion to what each brought (received,
  // else loaded), so the invoice still adds up to exactly what the register
  // counted; an invoice with no tanker rows stays a single line.
  const oids = purchases.map((r) => n(r.id))
  const oph = oids.map(() => '?').join(', ')
  const tankerRows = oids.length
    ? ((
        await c
          .execute({
            sql: `SELECT order_id, id, tanker_no, COALESCE(NULLIF(received_qty, 0), loaded_qty) AS q, COALESCE(empty_date, '') AS td, 'pt' AS src
                    FROM purchase_tankers WHERE order_id IN (${oph})
                  UNION ALL
                  SELECT order_id, id, tanker_no, qty AS q, COALESCE(deposit_date, '') AS td, 'cs' AS src
                    FROM consignment_stock WHERE order_id IN (${oph})`,
            args: [...oids, ...oids]
          })
          .catch(() => ({ rows: [] }))
      ).rows as unknown as Row[])
    : []
  const byOrder = new Map<number, Row[]>()
  for (const t of tankerRows) {
    if (n(t.q) <= 0 || !String(t.tanker_no || '').trim()) continue
    byOrder.set(n(t.order_id), [...(byOrder.get(n(t.order_id)) || []), t])
  }
  const perTanker = purchases
    .flatMap((r): Row[] => {
      const all = byOrder.get(n(r.id)) || []
      // A delivered order's own tankers win over the consignment draws naming it.
      const ts = all.some((t) => t.src === 'pt') ? all.filter((t) => t.src === 'pt') : all
      if (!ts.length) return [{ ...r, inv_d: r.d }]
      const total = ts.reduce((s, t) => s + n(t.q), 0)
      let given = 0
      return ts.map((t, i) => {
        const share = i === ts.length - 1 ? r3(n(r.qty) - given) : r3((n(r.qty) * n(t.q)) / total)
        given = r3(given + share)
        // A consignment tanker (Bunge's) stands in the list on the day it was
        // deposited in our tank, not on the invoice that later drew it.
        const d = n(r.consignment) === 1 && t.src === 'cs' && String(t.td || '').trim() ? String(t.td) : r.d
        return { ...r, d, inv_d: r.d, qty: share, r_qty: r3(n(t.q)), tanker_no: t.tanker_no, tanker_id: n(t.id), td: t.td }
      })
    })
    .filter((r) => !asOf || String(r.d).slice(0, 10) <= asOf)

  // CONSIGNMENT TANKERS NOT YET INVOICED — standing in our tank, deposited,
  // not drawn into our books by any invoice yet. Listed so the desk sees every
  // tanker in the tank, but never part of FIFO's answer: the stock count only
  // takes a consignment in on its invoice.
  const undrawn = (
    await c
      .execute({
        sql: `SELECT cs.id, cs.qty, cs.tanker_no, cs.deposit_date AS d, cs.company_id, s.name AS party, co.name AS company, b.bargain_no
                FROM consignment_stock cs
                LEFT JOIN suppliers s ON s.id = cs.supplier_id
                LEFT JOIN companies co ON co.id = cs.company_id
                LEFT JOIN bargains b ON b.id = cs.bargain_id
               WHERE cs.order_id IS NULL AND cs.product_id = ? AND cs.company_id IN (${ph})
                 AND COALESCE(cs.qty, 0) > 0 ${asOf ? 'AND cs.deposit_date <= ?' : ''}`,
        args: [pid, ...ids, ...(asOf ? [asOf] : [])]
      })
      .catch(() => ({ rows: [] }))
  ).rows as unknown as Row[]
  const undrawnLines = undrawn.map((u): Row => ({
    id: 0,
    kind: 'purchase',
    invoice_no: null,
    tanker_no: u.tanker_no,
    consignment: 1,
    uninvoiced: true,
    qty: r3(n(u.qty)),
    r_qty: r3(n(u.qty)),
    rate: null,
    order_date: null,
    company_id: u.company_id,
    party: u.party,
    company: u.company,
    bargain_no: u.bargain_no,
    d: u.d,
    td: u.d,
    tanker_id: n(u.id)
  }))

  // Newest first; on the same day the later-entered one first, and within an
  // invoice the tanker emptied last first.
  const inflows: Row[] = [...perTanker, ...undrawnLines, ...made]
    .map((r) => ({ ...r }))
    .sort(
      (a, b) =>
        String(b.d).localeCompare(String(a.d)) ||
        n(b.id) - n(a.id) ||
        String(a.kind).localeCompare(String(b.kind)) ||
        String(b.td || '').localeCompare(String(a.td || '')) ||
        n(b.tanker_id) - n(a.tanker_id)
    )

  const lines: Row[] = []
  let left = want
  let cum = 0
  let value = 0
  let valuedQty = 0
  let running = 0
  // Every receipt when asked for all — capped, so a product bought for years
  // does not send thousands of rows to a picker nobody scrolls that far down.
  const cap = v.all ? 400 : Infinity
  for (const r of inflows) {
    if (left <= 0.0005 && !v.all) break
    if (lines.length >= cap) break
    const qty = r3(n(r.qty))
    // Not in our stock at the opening: a tanker with no invoice yet, or one
    // whose invoice is dated after it. Listed, never taken by FIFO.
    const invoicedLater = !!asOf && !r.uninvoiced && String(r.inv_d || r.d).slice(0, 10) > asOf
    const outside = !!r.uninvoiced || invoicedLater
    const taken = outside ? 0 : r3(Math.max(0, Math.min(qty, left)))
    left = r3(Math.max(0, left - taken))
    cum = r3(cum + taken)
    running = r3(running + qty)
    const rate = r.kind === 'purchase' ? r2(n(r.rate)) : null
    if (rate != null && rate > 0) {
      value += taken * rate
      valuedQty += taken
    }
    lines.push({
      kind: r.kind,
      id: n(r.id),
      tanker_id: r.tanker_id ?? null,
      date: String(r.d || '').slice(0, 10),
      // The tanker's own receipt: the day it was emptied (or deposited, for a
      // consignment) and what it brought — R.Date and R.Qty on the screen.
      r_date: String(r.td || r.d || '').slice(0, 10),
      r_qty: r.r_qty != null ? n(r.r_qty) : qty,
      invoice_date: r.order_date ? String(r.order_date).slice(0, 10) : null,
      invoice_no: r.invoice_no ?? null,
      // Each tanker once — a consignment draw can name the same one twice.
      tanker_no: r.tanker_no ? [...new Set(String(r.tanker_no).split(',').map((x) => x.trim()).filter(Boolean))].join(', ') : null,
      consignment: n(r.consignment) === 1,
      uninvoiced: !!r.uninvoiced,
      invoiced_later: invoicedLater,
      bargain_no: r.bargain_no ?? null,
      party: r.party ?? null,
      company: r.company ?? null,
      rate,
      qty,
      taken,
      partly: taken > 0.0005 && taken < qty - 0.0005,
      fifo: taken > 0.0005,
      cumulative: cum,
      // Every receipt's quantity added up from the newest down.
      running,
      value: rate != null ? r2(taken * rate) : null
    })
  }
  return {
    product_id: pid,
    as_of: asOf || null,
    qty: want,
    lines,
    covered: cum,
    // Older than every receipt on the books — the opening count.
    from_opening: Math.max(0, r3(left)),
    value: r2(value),
    valued_qty: r3(valuedQty),
    avg_rate: valuedQty > 0 ? r2(value / valuedQty) : null
  }
}
