import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// Local wall-clock HH:MM — a gate time is read off the barrier, not off UTC.
function nowHHMM(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export async function listGateEntries(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT g.*, p.code AS oil_code, p.name AS oil_name,
           b.bargain_no, COALESCE(ds.name, s.name, dc.name) AS supplier_name,
           dc.name AS gate_customer_name,
           COALESCE(sl.invoice_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_invoice,
           COALESCE(sl.customer,  (SELECT customer  FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS sale_customer,
           -- A vehicle can carry several invoices out; the register names them
           -- all rather than only the one written on the entry.
           (SELECT COUNT(*) FROM gate_entry_sales gs WHERE gs.gate_entry_id = g.id) AS sale_count,
           (SELECT GROUP_CONCAT(x.invoice_no, ', ') FROM gate_entry_sales gs
              JOIN sales x ON x.id = gs.sale_id WHERE gs.gate_entry_id = g.id) AS sale_invoices
    FROM gate_entries g
    LEFT JOIN products p ON p.id = g.oil_type_id
    LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
    LEFT JOIN bargains b ON b.id = pt.bargain_id
    LEFT JOIN suppliers s ON s.id = pt.supplier_id
    LEFT JOIN suppliers ds ON ds.id = g.supplier_id
    LEFT JOIN customers dc ON dc.id = g.customer_id
    LEFT JOIN sales sl ON sl.id = g.sale_id
    ORDER BY g.id DESC
  `)
  return toPlain(res)
}

// Continuous gate-entry number per direction: GE/0001 inbound, GO/0001
// outbound (used as a default; the gateman can overwrite it with the physical
// gate-register number).
export async function nextGateEntryNo(direction: 'in' | 'out' = 'in'): Promise<string> {
  const res = await getClient().execute({
    sql: "SELECT gate_entry_no FROM gate_entries WHERE COALESCE(direction, 'in') = ?",
    args: [direction]
  })
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.gate_entry_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `${direction === 'out' ? 'GO' : 'GE'}/${String(maxSeq + 1).padStart(4, '0')}`
}

// Dispatched sale INVOICES (grouped, any company — the gate is shared) for the
// gate-out picker, with how many gate-out entries each already has. A whole
// invoice leaves together, so items are rolled up per invoice_group.
export async function listDispatchableSales(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT s.invoice_group,
           MAX(s.sale_date) AS sale_date,
           MAX(s.invoice_no) AS invoice_no,
           MAX(s.customer) AS customer,
           SUM(s.qty) AS qty,
           MAX(s.uom) AS uom,
           COUNT(*) AS item_count,
           GROUP_CONCAT(pr.name, ', ') AS product_name,
           MAX(pr.material_type) AS product_category,
           (SELECT COUNT(*) FROM gate_entries g
              WHERE g.direction = 'out'
                AND (g.invoice_group = s.invoice_group
                     OR EXISTS (SELECT 1 FROM gate_entry_sales gs
                                WHERE gs.gate_entry_id = g.id AND gs.invoice_group = s.invoice_group))) AS gate_outs
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    -- A trading sale is a pass-through on paper: the goods never come to our
    -- yard, so no vehicle is ever weighed out against it.
    WHERE s.status = 'done' AND s.invoice_group IS NOT NULL
      AND COALESCE(s.is_trading, 0) = 0 AND s.rejected_at IS NULL
    GROUP BY s.invoice_group
    ORDER BY MAX(s.sale_date) DESC, MAX(s.id) DESC
    LIMIT 300
  `)
  return toPlain(res)
}

// Total received qty recorded at the gate for a tanker. Only COMPLETED entries
// count — an arrival still waiting for weighment is not a received quantity.
// Returns null when the tanker has no completed gate entry yet.
export async function tankerGateReceived(tankerId: number): Promise<number | null> {
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(received_qty), 0) AS qty, COUNT(*) AS cnt
          FROM gate_entries
          WHERE tanker_id = ? AND status = 'completed' AND COALESCE(no_weighment, 0) = 0`,
    args: [tankerId]
  })
  if (!res.rows.length || n(res.rows[0].cnt) === 0) return null
  return n(res.rows[0].qty)
}

// Which product categories each party actually trades in, so the gate can
// narrow a long party list to the ones that make sense for the goods at the
// barrier. Derived from real documents (purchases, bargains, sales) and from
// the supplier's declared type — never from a hand-kept list that can go stale.
export async function partyCategories(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')) AS cat, 'supplier' AS side, o.supplier_id AS id
      FROM orders o JOIN products p ON p.id = o.oil_type_id WHERE o.supplier_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'supplier', b.supplier_id
      FROM bargains b JOIN products p ON p.id = b.oil_type_id WHERE b.supplier_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(su.supplier_type, '')), 'supplier', su.id
      FROM suppliers su WHERE COALESCE(su.supplier_type, '') != ''
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'customer', s.customer_id
      FROM sales s JOIN products p ON p.id = s.product_id WHERE s.customer_id IS NOT NULL
    UNION
    SELECT DISTINCT UPPER(COALESCE(p.material_type, '')), 'customer', sb.customer_id
      FROM sales_bargains sb JOIN products p ON p.id = sb.product_id WHERE sb.customer_id IS NOT NULL
  `)
  return toPlain(res).filter((r) => String(r.cat || '').trim() !== '' && Number(r.id) > 0)
}

// The dispatch quantity as the challan gives it: a number, or NA when the
// challan carries none. NA is the only word accepted — anything else is a
// typo, not an answer, and is treated as nothing having been entered.
export function parseDispatch(v: unknown): { qty: number; na: boolean } | null {
  if (v == null || v === '') return null
  if (typeof v === 'string' && v.trim().toUpperCase() === 'NA') return { qty: 0, na: true }
  const x = Number(v)
  if (!Number.isFinite(x)) return null
  if (x < 0) throw new Error('Dispatch quantity cannot be negative')
  return { qty: x, na: false }
}

export async function createGateEntry(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const direction = v.direction === 'out' ? 'out' : 'in'
  // The simple register line: a vehicle, optionally who it is with, and what
  // it carries. Nothing else is asked of it and it never waits to be weighed.
  const kind = String(v.entry_kind || 'standard') === 'simple' ? 'simple' : 'standard'
  if (kind === 'simple') {
    if (!String(v.tanker_no || '').trim()) throw new Error('Enter the vehicle number')
    if (!String(v.note || '').trim()) throw new Error('Say what the vehicle is carrying')
  }
  // A sale invoice is the normal case but not compulsory — empty vehicles,
  // returns and weighment runs leave too. What such an exit must carry is the
  // reason, so the register never holds an unexplained departure.
  // A list is accepted here too, for a loaded vehicle weighed straight at the
  // gate rather than coming in empty first.
  const outGroups: string[] = Array.isArray(v.invoice_groups)
    ? (v.invoice_groups as unknown[]).map((g) => String(g || '').trim()).filter(Boolean)
    : []
  if (outGroups.length && !v.invoice_group) v.invoice_group = outGroups[0]
  if (kind === 'standard' && direction === 'out' && !v.invoice_group && !v.sale_id && !String(v.note || '').trim()) {
    throw new Error('Pick the sale invoice being dispatched, or write why the vehicle is leaving without one')
  }
  // Every gate entry names its vehicle — either a tanker from the movement
  // register or a typed vehicle number; an entry with neither is untraceable.
  if (!n(v.tanker_id) && !String(v.tanker_no || '').trim()) {
    throw new Error('Pick a tanker from the list or type the vehicle number')
  }
  // The system serial is always auto-assigned fresh (authoritative, no stale
  // preview / duplicates). The user's optional manual number lives in ref_no.
  const gateNo = await nextGateEntryNo(direction)
  // Two-step flow: an entry without a weighed quantity stays 'pending' until
  // the weighbridge figure is entered, which completes the transaction.
  // Without weighment: the entry is done the moment it is recorded — it never
  // joins the weighbridge queue and keeps whatever quantity was declared.
  const dIn = parseDispatch(v.dispatch_na ? 'NA' : v.dispatch_qty)
  const noWeighment = !!v.no_weighment || kind === 'simple'
  const status = noWeighment ? 'completed' : v.status || (n(v.received_qty) > 0 ? 'completed' : 'pending')
  const res = await c.execute({
    sql: `INSERT INTO gate_entries
      (gate_entry_no, ref_no, entry_date, entry_time, tanker_id, tanker_no, oil_type_id, dispatch_qty, dispatch_na, received_qty, uom, status, note, direction, sale_id, invoice_group, rec_type, gross_weight, tare_weight, supplier_id, is_direct_mnc, no_weighment, customer_id, person, entry_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      gateNo,
      v.ref_no ? String(v.ref_no).trim() : null,
      v.entry_date,
      // Whatever the barrier says, else the clock now — the gateman should not
      // have to type the time of an entry he is making as it happens.
      v.entry_time ? String(v.entry_time).slice(0, 5) : nowHHMM(),
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      dIn ? dIn.qty : 0,
      dIn?.na ? 1 : 0,
      n(v.received_qty),
      v.uom || 'MT',
      status,
      v.note || null,
      direction,
      v.sale_id ? n(v.sale_id) : null,
      v.invoice_group ? String(v.invoice_group) : null,
      String(v.rec_type || 'OIL'),
      v.gross_weight != null && v.gross_weight !== '' ? n(v.gross_weight) : null,
      v.tare_weight != null && v.tare_weight !== '' ? n(v.tare_weight) : null,
      v.supplier_id ? n(v.supplier_id) : null,
      v.is_direct_mnc ? 1 : 0,
      noWeighment ? 1 : 0,
      v.customer_id ? n(v.customer_id) : null,
      v.person ? String(v.person).trim() : null,
      kind
    ]
  })
  const newId = Number(res.lastInsertRowid)
  // Every invoice on the vehicle, the primary one included, so the registers
  // see them all. A single-invoice entry gets one row, which keeps this and the
  // Gate Out path identical from here on.
  const linkGroups = outGroups.length ? outGroups : v.invoice_group ? [String(v.invoice_group)] : []
  if (linkGroups.length) await setGateEntrySales(newId, linkGroups)
  return { id: newId }
}

// Step 2 for the gateman: enter gross & tare from the weighbridge; the net
// (received qty) is gross − tare. Completes the entry.
export async function completeGateEntry(
  id: number,
  gross: number,
  tare: number
): Promise<{ id: number }> {
  const g = Number(gross)
  const t = Number(tare) || 0
  if (!Number.isFinite(g) || g <= 0) throw new Error('Enter the gross weight')
  if (t < 0) throw new Error('Tare weight cannot be negative')
  const net = Math.round((g - t) * 1000) / 1000
  if (net <= 0) throw new Error('Net weight (gross − tare) must be greater than zero')
  await getClient().execute({
    sql: "UPDATE gate_entries SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = 'completed' WHERE id = ?",
    args: [g, t, net, id]
  })
  return { id }
}

// Save whatever the weighbridge has so far. Gross and tare rarely arrive
// together — the loaded weight is taken on the way in and the empty weight
// only after unloading — so each is stored on its own and the entry stays in
// the queue until BOTH are in, at which point it completes on net = gross − tare.
export async function saveGateWeights(
  id: number,
  gross: number | null,
  tare: number | null,
  awaitingGrossOut?: boolean | null,
  // The challan quantity is often only to hand at the weighbridge, not when
  // the guard first waved the vehicle in, so it can be set or corrected here.
  // 'NA' records that the challan gives none. Left alone entirely when the
  // caller doesn't pass anything.
  dispatchQty?: number | string | null,
  // A vehicle weighed Tare-only at Gate In and flagged for sale gets its sale
  // invoice named here, at Gate Out, when its Gross is taken — that is the
  // first point the invoice actually exists. More than one may be named: a
  // tanker can carry several bills out on the same trip.
  invoiceGroup?: string | string[] | null,
  // The day the vehicle actually left, for an entry that came in and is now
  // going back out. Defaults to today when the caller doesn't say.
  outDate?: string | null,
  // And the clock time it left, HH:MM. Defaults to now, so the ordinary Gate
  // Out never has to type it; supplied only when a slip is keyed in later.
  outTime?: string | null
): Promise<{ id: number; status: string; net: number | null; missing: string | null }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM gate_entries WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Gate entry not found')
  const row = cur.rows[0]

  const given = (v: number | null, existing: unknown): number | null => {
    if (v == null || !Number.isFinite(Number(v))) return existing == null ? null : n(existing)
    return Number(v)
  }
  const g = given(gross, row.gross_weight)
  const t = given(tare, row.tare_weight)
  if (g != null && g < 0) throw new Error('Gross weight cannot be negative')
  if (t != null && t < 0) throw new Error('Tare weight cannot be negative')
  if (g == null && t == null) throw new Error('Enter the gross or the tare weight')

  const both = g != null && t != null
  const net = both ? Math.round((g - t) * 1000) / 1000 : null
  if (both && (net as number) <= 0) {
    throw new Error('Net weight (gross − tare) must be greater than zero — check the two figures')
  }
  // Only touch the flag when the caller actually decided one way or the
  // other — leave it as whatever it already was otherwise (e.g. a later
  // gross-only save from the new Gate Out picker shouldn't reset it).
  const flag = typeof awaitingGrossOut === 'boolean' ? (awaitingGrossOut ? 1 : 0) : n(row.awaiting_gross_out)
  const d = parseDispatch(dispatchQty)
  const dispQty = d ? d.qty : n(row.dispatch_qty)
  const dispNa = d ? d.na : !!n(row.dispatch_na)
  // Naming the invoice also pulls across who it is for, so the entry reads as
  // a proper dispatch rather than an unexplained vehicle. Left as it was when
  // the caller names nothing.
  let group = row.invoice_group as string | null
  let saleId = row.sale_id as number | null
  let customerId = row.customer_id as number | null
  // Naming invoices REPLACES whatever was linked — the caller sends the whole
  // list, so unticking one removes it. Saying nothing leaves the links alone.
  const namedGroups = Array.isArray(invoiceGroup)
    ? invoiceGroup.map((g) => String(g || '').trim()).filter(Boolean)
    : invoiceGroup != null && String(invoiceGroup).trim() !== ''
      ? [String(invoiceGroup).trim()]
      : []
  if (namedGroups.length) {
    const primary = await setGateEntrySales(id, namedGroups)
    group = primary.group
    saleId = primary.saleId
    customerId = primary.customerId ?? customerId
  }
  // A vehicle taken in empty, flagged for sale and now weighed out against an
  // invoice has made a DISPATCH — file it as one. It arrived through Gate In,
  // but what the register is recording is the load leaving, so leaving it as
  // an inbound entry hides it from Gate Out and, worse, leaves its invoice
  // looking as though it never went out (which would let a second vehicle be
  // linked to the same invoice). The flag comes off at the same time: it has
  // stopped awaiting anything.
  const nowOut = both && n(row.awaiting_gross_out) === 1 && !!group
  const direction = nowOut ? 'out' : String(row.direction || 'in')
  // A vehicle has left when its weighment CLOSES — both figures in — not when
  // either one of them is entered. A purchase tanker is weighed Gross loaded on
  // arrival and Tare once it has tipped, so the tare is normally the closing
  // weight and the day it is taken is the day the vehicle goes out. Stamp it so
  // the register can show the visit from both ends (IN on arrival, OUT on the
  // closing weight) without turning the entry outbound: the goods genuinely
  // came in.
  //
  // Keyed off the pair closing rather than off the tare specifically, because a
  // vehicle can be weighed Tare FIRST — brought in empty, tare taken at the
  // barrier, gross still to come. That vehicle has not left; it is standing on
  // the premises awaiting its second weight, and stamping it OUT on the tare
  // alone put a departure time against a row the register itself still showed
  // as Pending Wt. It now gets its out stamp when the gross arrives and the
  // weighment is actually finished.
  //
  // Never over a date already set — correcting a weight afterwards must not
  // move the time the vehicle really left — and never for the Tare-first sale
  // flow above, which gets its out date at Gate Out instead. Covers a dispatch
  // created straight as OUT too (a loaded vehicle weighed at the gate, which
  // passes through neither case above and used to complete with a blank OUT).
  const pairClosed =
    !nowOut &&
    both &&
    n(row.awaiting_gross_out) !== 1 &&
    !row.out_date
  // entry_date stays as the day it arrived; the departure gets its own date so
  // the register can show the visit from both ends.
  const leftOn =
    nowOut || pairClosed
      ? String(outDate || '').slice(0, 10) || todayISO()
      : (row.out_date as string | null)
  // Stamped at the same moment the out DATE is, off the local wall clock, and
  // only when the departure is being recorded for the first time — correcting a
  // weight afterwards must not move the time the vehicle actually left. A
  // caller may pass its own, e.g. when a gate slip is keyed in later.
  const leftAt =
    (nowOut || pairClosed) && !row.out_time
      ? (outTime ? String(outTime).slice(0, 5) : nowHHMM())
      : (row.out_time as string | null)
  await c.execute({
    sql: `UPDATE gate_entries
          SET gross_weight = ?, tare_weight = ?, received_qty = ?, status = ?, awaiting_gross_out = ?,
              dispatch_qty = ?, dispatch_na = ?, invoice_group = ?, sale_id = ?, customer_id = ?,
              direction = ?, out_date = ?, out_time = ?
          WHERE id = ?`,
    args: [
      g, t, both ? net : 0, both ? 'completed' : 'pending', nowOut ? 0 : flag,
      dispQty, dispNa ? 1 : 0, group, saleId, customerId, direction, leftOn, leftAt, id
    ]
  })
  return {
    id,
    status: both ? 'completed' : 'pending',
    net,
    missing: both ? null : g == null ? 'gross' : 'tare'
  }
}

// Replace the invoices linked to one gate entry. The FIRST is the primary and
// is also written onto the entry itself, so every existing register keeps
// working unchanged; all of them, primary included, land in the link table.
async function setGateEntrySales(
  entryId: number,
  groups: string[]
): Promise<{ group: string | null; saleId: number | null; customerId: number | null }> {
  const c = getClient()
  const clean = Array.from(new Set(groups.map((g) => String(g || '').trim()).filter(Boolean)))
  await c.execute({ sql: 'DELETE FROM gate_entry_sales WHERE gate_entry_id = ?', args: [entryId] })
  let first: { group: string; saleId: number | null; customerId: number | null } | null = null
  for (const g of clean) {
    const sale = await c.execute({
      sql: 'SELECT id, customer_id FROM sales WHERE invoice_group = ? ORDER BY id LIMIT 1',
      args: [g]
    })
    if (!sale.rows.length) throw new Error(`Sale invoice ${g} no longer exists`)
    const saleId = Number(sale.rows[0].id)
    const customerId = sale.rows[0].customer_id == null ? null : Number(sale.rows[0].customer_id)
    await c.execute({
      sql: 'INSERT OR IGNORE INTO gate_entry_sales (gate_entry_id, invoice_group, sale_id) VALUES (?, ?, ?)',
      args: [entryId, g, saleId]
    })
    if (!first) first = { group: g, saleId, customerId }
  }
  return first
    ? { group: first.group, saleId: first.saleId, customerId: first.customerId }
    : { group: null, saleId: null, customerId: null }
}

// Every invoice on one gate entry, for the register and the slip.
export async function gateEntrySales(entryId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT gs.invoice_group, gs.sale_id, s.invoice_no, s.customer,
                 (SELECT ROUND(SUM(x.qty), 3) FROM sales x WHERE x.invoice_group = gs.invoice_group) AS qty,
                 (SELECT x.uom FROM sales x WHERE x.invoice_group = gs.invoice_group LIMIT 1) AS uom
          FROM gate_entry_sales gs
          LEFT JOIN sales s ON s.id = gs.sale_id
          WHERE gs.gate_entry_id = ?
          ORDER BY gs.id`,
    args: [entryId]
  })
  return toPlain(res)
}

// Finish an entry with no weighment at all. Oil is always weighed — the whole
// purchase and stock chain is built on that figure — so only other categories
// (packaging, miscellaneous, scrap and the like) may skip it.
export async function skipGateWeighment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT rec_type, dispatch_qty FROM gate_entries WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Gate entry not found')
  if (String(cur.rows[0].rec_type || 'OIL').toUpperCase() === 'OIL') {
    throw new Error('Oil is always weighed — enter the gross and tare weights for this vehicle')
  }
  await c.execute({
    sql: "UPDATE gate_entries SET status = 'completed', no_weighment = 1, received_qty = ? WHERE id = ?",
    args: [n(cur.rows[0].dispatch_qty), id]
  })
  return { id }
}

export async function updateGateEntry(id: number, v: Row): Promise<{ id: number }> {
  const gross = v.gross_weight != null && v.gross_weight !== '' ? n(v.gross_weight) : null
  const tare = v.tare_weight != null && v.tare_weight !== '' ? n(v.tare_weight) : null
  const both = gross != null && tare != null
  const net = both ? Math.round(((gross as number) - (tare as number)) * 1000) / 1000 : null
  if (both && (net as number) <= 0) {
    throw new Error('Net weight (gross − tare) must be greater than zero — check the two figures')
  }
  // A weighed entry's net IS gross − tare and is never typed: the weighbridge
  // decides it, not the operator. An entry with NEITHER weight is one
  // finished without weighment and carries its own typed received qty; one
  // with only ONE of the two is genuinely still incomplete — treating a
  // blank tare as zero (the previous bug here) let editing an unrelated
  // field on a half-weighed entry silently mark it Completed with the full
  // gross carried over as the net.
  const received = gross == null && tare == null ? n(v.received_qty) : both ? (net as number) : 0
  const status = received > 0 ? 'completed' : 'pending'
  const dUp = parseDispatch(v.dispatch_na ? 'NA' : v.dispatch_qty)
  await getClient().execute({
    sql: `UPDATE gate_entries SET gate_entry_no = ?, ref_no = ?, entry_date = ?, entry_time = COALESCE(?, entry_time), tanker_id = ?, tanker_no = ?,
          oil_type_id = ?, dispatch_qty = ?, dispatch_na = ?, received_qty = ?, uom = ?, status = ?, note = ?, sale_id = ?,
          rec_type = ?, gross_weight = ?, tare_weight = ?, supplier_id = ?, customer_id = ?, is_direct_mnc = ? WHERE id = ?`,
    args: [
      String(v.gate_entry_no || '').trim(),
      v.ref_no ? String(v.ref_no).trim() : null,
      v.entry_date,
      v.entry_time ? String(v.entry_time).slice(0, 5) : null,
      v.tanker_id ? n(v.tanker_id) : null,
      v.tanker_no || null,
      v.oil_type_id ? n(v.oil_type_id) : null,
      dUp ? dUp.qty : 0,
      dUp?.na ? 1 : 0,
      received,
      v.uom || 'MT',
      status,
      v.note || null,
      v.sale_id ? n(v.sale_id) : null,
      String(v.rec_type || 'OIL'),
      gross,
      tare,
      v.supplier_id ? n(v.supplier_id) : null,
      v.customer_id ? n(v.customer_id) : null,
      v.is_direct_mnc ? 1 : 0,
      id
    ]
  })
  return { id }
}

export async function deleteGateEntry(id: number): Promise<{ id: number }> {
  // The invoice links go with the entry — they are meaningless without it.
  await getClient().execute({ sql: 'DELETE FROM gate_entry_sales WHERE gate_entry_id = ?', args: [id] })
  await getClient().execute({ sql: 'DELETE FROM gate_entries WHERE id = ?', args: [id] })
  return { id }
}

// A tanker that will never be completed — the party refused it and it went
// elsewhere instead — gets marked Rejected rather than deleted, so the gate
// register still explains what happened to it. Deliberately doesn't touch
// the linked sale/stock at all; a Credit Note (or whatever the actual
// correction is) is a separate, manual step.
export async function rejectGateEntry(id: number, reason: string): Promise<{ id: number }> {
  const trimmed = String(reason || '').trim()
  if (!trimmed) throw new Error('Enter a reason for rejecting this entry')
  await getClient().execute({
    sql: "UPDATE gate_entries SET rejected_at = datetime('now'), rejected_reason = ? WHERE id = ?",
    args: [trimmed, id]
  })
  return { id }
}

export async function unrejectGateEntry(id: number): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE gate_entries SET rejected_at = NULL, rejected_reason = NULL WHERE id = ?',
    args: [id]
  })
  return { id }
}
