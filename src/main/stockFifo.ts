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
export async function stockFifoMap(v: { productId: number; companyIds?: number[]; asOf?: string; qty: number }): Promise<Row> {
  const c = getClient()
  const pid = n(v.productId)
  const want = r3(n(v.qty))
  const asOf = String(v.asOf || '').slice(0, 10)
  const ids = (v.companyIds || []).map(Number).filter((x) => x > 0)
  if (!ids.length) ids.push(...(await companiesOfFactory()))
  const ph = ids.map(() => '?').join(', ')
  const dateCut = asOf ? 'AND d <= ?' : ''

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
            ) WHERE 1 = 1 ${dateCut}`,
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
  const perTanker = purchases.flatMap((r) => {
    const all = byOrder.get(n(r.id)) || []
    // A delivered order's own tankers win over the consignment draws naming it.
    const ts = all.some((t) => t.src === 'pt') ? all.filter((t) => t.src === 'pt') : all
    if (!ts.length) return [r]
    const total = ts.reduce((s, t) => s + n(t.q), 0)
    let given = 0
    return ts.map((t, i) => {
      const share = i === ts.length - 1 ? r3(n(r.qty) - given) : r3((n(r.qty) * n(t.q)) / total)
      given = r3(given + share)
      return { ...r, qty: share, tanker_no: t.tanker_no, tanker_id: n(t.id), td: t.td }
    })
  })

  // Newest first; on the same day the later-entered one first, and within an
  // invoice the tanker emptied last first.
  const inflows = [...perTanker, ...made]
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
  for (const r of inflows) {
    if (left <= 0.0005) break
    const qty = r3(n(r.qty))
    const taken = r3(Math.min(qty, left))
    left = r3(left - taken)
    cum = r3(cum + taken)
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
      invoice_date: r.order_date ? String(r.order_date).slice(0, 10) : null,
      invoice_no: r.invoice_no ?? null,
      // Each tanker once — a consignment draw can name the same one twice.
      tanker_no: r.tanker_no ? [...new Set(String(r.tanker_no).split(',').map((x) => x.trim()).filter(Boolean))].join(', ') : null,
      consignment: n(r.consignment) === 1,
      bargain_no: r.bargain_no ?? null,
      party: r.party ?? null,
      company: r.company ?? null,
      rate,
      qty,
      taken,
      partly: taken < qty - 0.0005,
      cumulative: cum,
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
