import { getClient } from './db'
import { getSetting } from './repos'
import { ALLOC } from './tankerAlloc'

// A TANKER'S OIL SHORTAGE IS CHARGED AT ITS INVOICE'S ADJUSTED RATE — what
// we actually pay per MT for that oil (bargain rate plus supplier interest
// and the rate adjustment), not the bare bargain rate. GT/4378: ₹1,23,897,
// not ₹1,23,100. Before the invoice exists the bargain's rate stands in, and
// saving the invoice re-prices the open line (repriceOpenShortage).

const n = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

/** The rate a tanker shortage is charged at: the invoice's adjusted rate, else its invoice rate, else the bargain's. */
export async function shortageOilRate(orderId: unknown, bargainRate: number): Promise<number> {
  if (!n(orderId)) return bargainRate
  const r = await getClient().execute({ sql: 'SELECT adjusted_rate, invoice_rate FROM orders WHERE id = ?', args: [n(orderId)] })
  const o = r.rows[0]
  return n(o?.adjusted_rate) || n(o?.invoice_rate) || bargainRate
}

export type ShortageRepriceFinding = {
  line_id: number
  tanker_id: number
  order_id: number
  company_id: number
  invoice_no: string
  tanker_no: string
  transporter: string
  excess: number
  pct: number
  rate: number
  amount: number
  new_amount: number
  note: string
  new_note: string
}

/**
 * Open tanker shortage lines (no bill, no note, not waived) whose amount is not
 * the excess shortage at the invoice's adjusted rate, or whose note still gives
 * the whole shortage rather than the part beyond tolerance. Read only.
 */
export async function scanShortageReprice(orderId?: number): Promise<ShortageRepriceFinding[]> {
  const c = getClient()
  const defPct = n((await getSetting('allowed_shortage_pct')) ?? '0')
  const r = await c.execute({
    sql: `SELECT l.id AS line_id, l.amount, l.note, o.id AS order_id, o.company_id, o.invoice_no,
                 COALESCE(NULLIF(o.adjusted_rate, 0), NULLIF(o.invoice_rate, 0), b.rate_per_uom) AS rate,
                 o.allowed_shortage_pct AS order_pct, b.allowed_shortage_pct AS bargain_pct,
                 t.name AS transporter, pt.id AS tanker_id, pt.tanker_no, pt.loaded_qty, pt.received_qty
            FROM transporter_ledger l
            JOIN orders o ON o.id = l.order_id
            LEFT JOIN transporters t ON t.id = l.transporter_id
            JOIN purchase_tankers pt ON pt.status = 'empty'
             AND UPPER(REPLACE(pt.tanker_no, ' ', '')) = UPPER(REPLACE(TRIM(SUBSTR(l.note, 8, INSTR(l.note, ':') - 8)), ' ', ''))
             AND (pt.order_id = o.id OR pt.id IN (SELECT a.tanker_id FROM ${ALLOC} a WHERE a.order_id = o.id))
            LEFT JOIN bargains b ON b.id = pt.bargain_id
           WHERE l.entry_type = 'shortage_penalty' AND l.note LIKE 'Tanker %:%'
             AND l.bill_id IS NULL AND l.note_id IS NULL AND l.waived_at IS NULL
             ${orderId ? 'AND o.id = ?' : ''}
           ORDER BY o.company_id, l.id`,
    args: orderId ? [n(orderId)] : []
  })
  const out: ShortageRepriceFinding[] = []
  for (const x of r.rows) {
    const loaded = n(x.loaded_qty)
    const pct = x.order_pct != null ? n(x.order_pct) : x.bargain_pct != null ? n(x.bargain_pct) : defPct
    const excess = Math.max(0, loaded - n(x.received_qty) - (loaded * pct) / 100)
    const rate = n(x.rate)
    if (rate <= 0 || excess <= 0) continue
    const amount = n(x.amount)
    const newAmount = -round2(excess * rate)
    const note = String(x.note || '')
    const newNote = `Tanker ${String(x.tanker_no)}: oil shortage ${excess.toFixed(3)} MT beyond ${pct}% tolerance`
    if (Math.abs(amount - newAmount) < 0.005 && note === newNote) continue
    out.push({
      line_id: n(x.line_id),
      tanker_id: n(x.tanker_id),
      order_id: n(x.order_id),
      company_id: n(x.company_id),
      invoice_no: String(x.invoice_no || ''),
      tanker_no: String(x.tanker_no || ''),
      transporter: String(x.transporter || ''),
      excess: Math.round(excess * 1e6) / 1e6,
      pct,
      rate,
      amount,
      new_amount: newAmount,
      note,
      new_note: newNote
    })
  }
  return out
}

/** Write the re-priced figures (ledger line + the tanker's own shortage charge). */
export async function applyShortageReprice(findings: ShortageRepriceFinding[]): Promise<number> {
  const c = getClient()
  for (const f of findings) {
    await c.execute({ sql: 'UPDATE transporter_ledger SET amount = ?, note = ? WHERE id = ?', args: [f.new_amount, f.new_note, f.line_id] })
    await c.execute({ sql: 'UPDATE purchase_tankers SET shortage_charge_amount = ? WHERE id = ?', args: [-f.new_amount, f.tanker_id] })
  }
  return findings.length
}

/** Saving an invoice keeps its tankers' still-open shortage lines at its adjusted rate. */
export async function repriceOpenShortage(orderId: number): Promise<void> {
  await applyShortageReprice(await scanShortageReprice(orderId))
}
