import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { visibleFromFor } from './access-gate'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const k of res.columns) o[k] = (r as Row)[k]
    return o
  })
}

const n = (v: unknown): number => Number(v) || 0

// A LOT OR TERMINAL NUMBER, AS IT IS WRITTEN DOWN.
//
// Trimmed and upper-cased on the way in, because it arrives off a printed
// sheet and "l-2451", "L-2451 " and "L-2451" are one lot — and a register that
// treats them as three cannot group anything. Blank becomes NULL: a lot
// nobody has given us is absent, not an empty string to match against.
const label = (v: unknown): string | null => String(v ?? '').trim().toUpperCase().slice(0, 40) || null

/**
 * AN OPENING IS PARCELS, NOT A NUMBER.
 *
 * What a party holds with us on day one is not 167.51 MT in the abstract — it
 * is L-2451 at KANDLA and L-2779 at MUNDRA, and a withdrawal draws on one of
 * them and not the other. Every deposit AFTER the opening has said which lot
 * and which terminal since lots were added; only the opening itself was a
 * single undifferentiated figure, so the day the books start is the one day
 * the parcels cannot be told apart — and a purchase booked against the opening
 * had nothing to name.
 *
 * So the opening is a LIST. One consignment_stock row per lot + terminal,
 * is_opening on each, which means every reader already written — the pending
 * list, the purchase picker, the available balance — sees them as the lots
 * they are without a line of change.
 *
 * A single { qty } with no lines is still accepted, and still writes exactly
 * one unlabelled row: that is what every opening already on file looks like,
 * and re-saving one must not invent a lot number nobody gave us.
 */
interface OpeningLine {
  lot_no: string | null
  terminal_no: string | null
  qty: number
}

function openingLines(v: Row): OpeningLine[] {
  const raw = Array.isArray(v.lines) ? (v.lines as Row[]) : null
  if (!raw) return [{ lot_no: label(v.lot_no), terminal_no: label(v.terminal_no), qty: n(v.qty) }]
  const out: OpeningLine[] = []
  for (const l of raw) {
    const qty = n(l?.qty)
    if (qty <= 0) continue
    out.push({ lot_no: label(l?.lot_no), terminal_no: label(l?.terminal_no), qty })
  }
  return out
}

// Two parcels of the same lot at the same terminal are one parcel.
const lotKey = (l: { lot_no: string | null; terminal_no: string | null }): string =>
  `${l.lot_no || ''}@@${l.terminal_no || ''}`

export async function saveOpeningStock(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const supplierId = n(v.supplier_id)
  const productId = n(v.product_id)
  const uom = String(v.uom || 'MT')
  const date = String(v.deposit_date || '').slice(0, 10)
  if (!supplierId) throw new Error('Choose the MNC / party')
  if (!productId) throw new Error('Choose the product')
  if (!date) throw new Error('Enter the opening date')
  if (date > todayISO()) throw new Error('The opening date cannot be in the future')

  // Merged before anything is checked, so the figure that is validated is the
  // figure that gets written.
  const merged = new Map<string, OpeningLine>()
  for (const l of openingLines(v)) {
    const k = lotKey(l)
    const cur = merged.get(k)
    if (cur) cur.qty = Math.round((cur.qty + l.qty) * 1000) / 1000
    else merged.set(k, { ...l })
  }
  const lines = Array.from(merged.values())
  const qty = Math.round(lines.reduce((t, l) => t + l.qty, 0) * 1000) / 1000
  if (qty <= 0) {
    throw new Error('Enter an opening quantity greater than zero — use the history to restore an older figure')
  }

  // EVERY opening row, drawn or not. The drawn ones are the reason a floor
  // exists at all, and deleting one because it is missing from the new list
  // would unbook a purchase.
  const existing = await c.execute({
    sql: `SELECT * FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND is_opening = 1
          ORDER BY id`,
    args: [cid, supplierId, productId]
  })
  const lots = toPlain(existing)
  const free = lots.filter((l) => l.order_id == null)
  const drawn = lots.filter((l) => l.order_id != null)
  const oldTotal = lots.reduce((s2, l) => s2 + n(l.qty), 0)
  const available = await consignmentAvailable(supplierId, productId)
  // drawn − deposits-other-than-opening = the floor the opening cannot cross.
  const minOpening = Math.max(0, Math.round((oldTotal - available) * 1000) / 1000)
  if (qty < minOpening - 1e-6) {
    throw new Error(
      `${minOpening.toFixed(3)} ${uom} of this opening is already drawn into purchases — the opening cannot go below that`
    )
  }
  // A parcel a purchase has already drawn cannot be restated away. Its own row
  // is left exactly as it stands and counts towards the total.
  const drawnTotal = drawn.reduce((t, l) => t + n(l.qty), 0)
  if (drawn.length && qty < drawnTotal - 1e-6) {
    throw new Error(
      `${drawnTotal.toFixed(3)} ${uom} of this opening is booked on purchases — the opening cannot go below that`
    )
  }

  await c.execute({
    sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [cid, supplierId, productId, lots.length ? 'restate' : 'create', lots.length ? oldTotal : null, qty, uom, date, v.note ? String(v.note) : null]
  })

  // MATCHED BY PARCEL, NOT BY POSITION.
  //
  // Restating an opening usually changes one lot's quantity and leaves the
  // rest alone. Rewriting every row would give each of them a new id, and an
  // id is what a purchase holds on to — so a parcel keeps its row as long as
  // it keeps its lot and terminal.
  const spare = [...free]
  const takeMatching = (l: OpeningLine): Row | undefined => {
    const i = spare.findIndex((x) => lotKey({ lot_no: label(x.lot_no), terminal_no: label(x.terminal_no) }) === lotKey(l))
    return i >= 0 ? spare.splice(i, 1)[0] : undefined
  }
  const base = {
    supplier_id: supplierId,
    product_id: productId,
    uom,
    deposit_date: date,
    note: v.note ? String(v.note).trim() : 'Opening stock',
    is_opening: true
  }
  let firstId = 0
  const keep: OpeningLine[] = []
  for (const l of lines) {
    // A parcel already drawn is on file and untouchable; its quantity counts
    // but its row is not rewritten.
    const isDrawn = drawn.some(
      (d) => lotKey({ lot_no: label(d.lot_no), terminal_no: label(d.terminal_no) }) === lotKey(l)
    )
    if (isDrawn) continue
    keep.push(l)
  }
  for (const l of keep) {
    const row = takeMatching(l)
    const payload = { ...base, qty: l.qty, lot_no: l.lot_no, terminal_no: l.terminal_no }
    if (row) {
      await updateConsignment(n(row.id), payload)
      if (!firstId) firstId = n(row.id)
    } else {
      const made = await createConsignment(payload)
      if (!firstId) firstId = made.id
    }
  }
  // Whatever is left over is a parcel that has been taken off the opening, and
  // nothing has drawn on it.
  for (const gone of spare) await deleteConsignment(n(gone.id))
  return { id: firstId || n(lots[0]?.id) || 0 }
}

// Every parcel making up the opening for a party + product, as it stands.
export async function listOpeningLots(supplierId: number, productId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT id, qty, uom, lot_no, terminal_no, deposit_date, note, order_id
          FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND is_opening = 1
          ORDER BY (order_id IS NOT NULL), lot_no, terminal_no, id`,
    args: [getActiveCompanyId(), supplierId, productId]
  })
  return toPlain(res)
}

// The restatement trail for one party + product, newest first.
export async function listOpeningLog(supplierId: number, productId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT * FROM consignment_opening_log
          WHERE company_id = ? AND supplier_id = ? AND product_id = ?
          ORDER BY id DESC LIMIT 20`,
    args: [getActiveCompanyId(), supplierId, productId]
  })
  return toPlain(res)
}

export async function consignmentDeposited(supplierId: number, productId: number, companyId?: number): Promise<number> {
  const res = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?',
    args: [companyId || getActiveCompanyId(), supplierId, productId]
  })
  return n(res.rows[0]?.q)
}

// Consigned qty still lying at our place (deposited − invoiced) for a
// supplier+product, in the given company (defaults to the active one).
export async function consignmentAvailable(supplierId: number, productId: number, companyId?: number): Promise<number> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const dep = await c.execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM consignment_stock WHERE company_id = ? AND supplier_id = ? AND product_id = ?',
    args: [cid, supplierId, productId]
  })
  const inv = await c.execute({
    sql: 'SELECT COALESCE(SUM(ordered_qty), 0) AS q FROM orders WHERE company_id = ? AND is_consignment = 1 AND supplier_id = ? AND oil_type_id = ?',
    args: [cid, supplierId, productId]
  })
  return n(dep.rows[0]?.q) - n(inv.rows[0]?.q)
}

// Individual deposit lots for the active company.
export async function listConsignment(forModule?: string): Promise<Row[]> {
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const from = await visibleFromFor('consignment', forModule)
  const res = await getClient().execute({
    sql: `SELECT cs.*, s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, o.invoice_no, o.order_date,
                 b.bargain_no, b.rate_per_uom AS bargain_rate,
                 xb.bargain_no AS extra_bargain_no, xb.rate_per_uom AS extra_bargain_rate
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          LEFT JOIN orders o ON o.id = cs.order_id
          LEFT JOIN bargains b ON b.id = cs.bargain_id
          LEFT JOIN bargains xb ON xb.id = cs.extra_bargain_id
          WHERE cs.company_id = ?${from ? ' AND cs.deposit_date >= ?' : ''}
          ORDER BY cs.id DESC`,
    args: from ? [getActiveCompanyId(), from] : [getActiveCompanyId()]
  })
  return toPlain(res)
}

// Logged lots still waiting to be booked into a purchase invoice — the tankers
// the purchase form offers first. Optionally narrowed to one supplier/product.
export async function listUnbookedLots(supplierId?: number, productId?: number): Promise<Row[]> {
  const where = ['cs.company_id = ?', 'cs.order_id IS NULL']
  const args: (number | string)[] = [getActiveCompanyId()]
  if (supplierId) { where.push('cs.supplier_id = ?'); args.push(supplierId) }
  if (productId) { where.push('cs.product_id = ?'); args.push(productId) }
  const res = await getClient().execute({
    sql: `SELECT cs.id, cs.supplier_id, cs.product_id, cs.qty, cs.uom, cs.deposit_date, cs.note,
                 cs.tanker_no, cs.gate_entry_id, cs.bargain_id, cs.extra_bargain_id, cs.extra_qty, cs.is_opening,
                 -- The parcel this row is, which is what a withdrawal is picked
                 -- by: a lot at a terminal, not a row id.
                 cs.lot_no, cs.terminal_no,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name,
                 ge.gate_entry_no, ge.entry_date AS gate_date, ge.received_qty AS gate_qty
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
          WHERE ${where.join(' AND ')}
          ORDER BY cs.deposit_date, cs.id`,
    args
  })
  return toPlain(res)
}

// One picked tanker and the bargain(s) it draws against. A tanker may be split
// across two bargains: extra_qty goes to extra_bargain_id, the remainder to
// bargain_id — the same shape purchase_tankers uses for loaded tankers.
export interface LotPick {
  id: number
  bargain_id?: number | null
  extra_bargain_id?: number | null
  extra_qty?: number | null
}

// Normalise whatever the renderer sent into LotPick[]. Plain ids are accepted so
// a caller that does not care about bargains (auto FIFO) still works.
export function toLotPicks(v: unknown): LotPick[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) =>
      typeof x === 'object' && x !== null
        ? {
            id: Number((x as LotPick).id),
            bargain_id: (x as LotPick).bargain_id ? Number((x as LotPick).bargain_id) : null,
            extra_bargain_id: (x as LotPick).extra_bargain_id ? Number((x as LotPick).extra_bargain_id) : null,
            extra_qty: n((x as LotPick).extra_qty)
          }
        : { id: Number(x), bargain_id: null, extra_bargain_id: null, extra_qty: 0 }
    )
    .filter((x) => x.id > 0)
}

export interface LotAllocation {
  total: number
  // Per-bargain quantity + rate, ready for computeMoney's `lines`.
  lines: { bargain_id: number; bargain_no: string; rate: number; qty: number }[]
  primaryBargainId: number
}

// Check the picked tankers and work out what each bargain is drawing, WITHOUT
// touching anything. Callers run this before writing the invoice, so a bad pick
// can never leave a half-booked order behind.
export async function validateConsignmentLots(
  picks: unknown,
  supplierId: number,
  productId: number,
  orderId = 0,
  companyId?: number
): Promise<LotAllocation> {
  const list = toLotPicks(picks)
  if (!list.length) return { total: 0, lines: [], primaryBargainId: 0 }
  const ids = list.map((p) => p.id)
  const res = await getClient().execute({
    sql: `SELECT id, supplier_id, product_id, qty, order_id, tanker_no
          FROM consignment_stock WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    args: [companyId || getActiveCompanyId(), ...ids]
  })
  if (res.rows.length !== ids.length) throw new Error('One of the selected consignment tankers no longer exists')
  const byId = new Map(res.rows.map((r) => [Number(r.id), r]))

  // Every bargain named across the picks must belong to this supplier + product.
  const bargainIds = Array.from(
    new Set(list.flatMap((p) => [p.bargain_id, p.extra_bargain_id]).filter((x): x is number => !!x))
  )
  const bargains = new Map<number, Row>()
  if (bargainIds.length) {
    const bres = await getClient().execute({
      sql: `SELECT id, bargain_no, supplier_id, oil_type_id, rate_per_uom
            FROM bargains WHERE id IN (${bargainIds.map(() => '?').join(',')})`,
      args: bargainIds
    })
    for (const b of toPlain(bres)) {
      if (n(b.supplier_id) !== supplierId || n(b.oil_type_id) !== productId) {
        throw new Error(`Bargain ${b.bargain_no} is not for this supplier and product`)
      }
      bargains.set(Number(b.id), b)
    }
    if (bargains.size !== bargainIds.length) throw new Error('One of the selected bargains no longer exists')
  }

  const alloc = new Map<number, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
  const add = (bid: number | null | undefined, qty: number): void => {
    if (!bid || qty <= 1e-9) return
    const b = bargains.get(bid) as Row
    const cur = alloc.get(bid) || {
      bargain_id: bid,
      bargain_no: String(b?.bargain_no || ''),
      rate: n(b?.rate_per_uom),
      qty: 0
    }
    cur.qty += qty
    alloc.set(bid, cur)
  }

  let total = 0
  for (const p of list) {
    const row = byId.get(p.id) as Row
    if (row.order_id != null && Number(row.order_id) !== orderId) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is already booked on another purchase`)
    }
    if (n(row.supplier_id) !== supplierId || n(row.product_id) !== productId) {
      throw new Error('The selected tankers must all belong to this supplier and product')
    }
    const qty = n(row.qty)
    const extra = p.extra_bargain_id ? n(p.extra_qty) : 0
    if (extra < 0) throw new Error(`Split quantity on tanker ${row.tanker_no || row.id} cannot be negative`)
    if (extra > qty + 1e-6) {
      throw new Error(
        `Split quantity on tanker ${row.tanker_no || row.id} (${extra}) is more than the tanker itself (${qty})`
      )
    }
    if (p.extra_bargain_id && p.extra_bargain_id === p.bargain_id) {
      throw new Error(`Tanker ${row.tanker_no || row.id} is split across the same bargain twice`)
    }
    if (bargainIds.length && !p.bargain_id && extra < qty - 1e-6) {
      throw new Error(`Assign a bargain to tanker ${row.tanker_no || row.id}`)
    }
    add(p.bargain_id, qty - extra)
    add(p.extra_bargain_id, extra)
    total += qty
  }
  const primary = list.find((p) => p.bargain_id)?.bargain_id || list.find((p) => p.extra_bargain_id)?.extra_bargain_id
  return { total, lines: Array.from(alloc.values()), primaryBargainId: Number(primary) || 0 }
}


/**
 * HOW MUCH COMES OUT OF WHICH PARCEL.
 *
 * A withdrawal used to be the parcels it named and nothing else: tick three
 * tankers, and the invoice was their total to the gram. That is right when the
 * quantity is the answer to "what did I tick". It is wrong when the quantity is
 * the question — which it usually is. The bill says 47 MT. The user types 47,
 * ticks the lot it came off, and the form replaced the 47 with the lot's own
 * 40.444, quietly, because whole lots were the only thing the model could
 * express.
 *
 * So the typed quantity leads and the ticked parcels say where it starts. The
 * ticked ones are drawn first, in the order they were ticked; if they do not
 * cover it, the rest comes off the oldest parcels that are still free — the
 * same oldest-first draw an untouched invoice has always used. A parcel can be
 * taken part-way: the drawn part becomes a row of its own against the invoice
 * and the remainder stays where it was, under the same lot and terminal, ready
 * for the next withdrawal.
 *
 * Nothing here decides whether the stock EXISTS — consignmentAvailable does
 * that, against deposits minus invoices, and it is checked before this runs.
 * This decides which rows carry it, which is what the bill has to be able to
 * say afterwards.
 */
export interface DrawStep {
  id: number
  take: number
  /** The whole row, as against a slice of it. */
  whole: boolean
  bargain_id: number | null
  extra_bargain_id: number | null
  extra_qty: number
}

export interface DrawPlan extends LotAllocation {
  steps: DrawStep[]
  /** What the ticked parcels held, so the form can say what it reached past. */
  ticked: number
  /** Taken off parcels nobody ticked, oldest first. */
  fromPool: number
}

export async function planConsignmentDraw(
  picks: unknown,
  supplierId: number,
  productId: number,
  wantQty: number,
  orderId = 0,
  companyId?: number,
  /**
   * The invoice's own bargain, for stock this draw reaches past the ticked
   * parcels to find. A parcel nobody ticked names no bargain, and without one
   * its share would fall out of the invoice's bargain split entirely: the
   * parcels would add up to the invoice and the bargains would not.
   */
  fallbackBargainId = 0
): Promise<DrawPlan> {
  const list = toLotPicks(picks)
  const cid = companyId || getActiveCompanyId()
  // Every check the named-parcels route has always made still applies: the
  // parcels exist, are this party's and this product's, are not already on
  // somebody else's invoice, and their bargains are this party's.
  const picked = await validateConsignmentLots(list, supplierId, productId, orderId, cid)
  const ticked = round3(picked.total)
  // No typed quantity is the old behaviour exactly: the parcels ARE the amount.
  const want = round3(wantQty > 1e-6 ? wantQty : ticked)
  if (want <= 1e-6) throw new Error('Enter the quantity to invoice')

  const byId = new Map<number, Row>()
  if (list.length) {
    const res = await getClient().execute({
      sql: `SELECT id, qty FROM consignment_stock WHERE id IN (${list.map(() => '?').join(',')})`,
      args: list.map((x) => x.id)
    })
    for (const r of toPlain(res)) byId.set(n(r.id), r)
  }

  const steps: DrawStep[] = []
  let left = want
  const eat = (id: number, have: number, pick?: LotPick): void => {
    if (left <= 1e-6 || have <= 1e-6) return
    const take = round3(Math.min(left, have))
    // An extra-bargain split is a share of the row; taking part of the row
    // takes no more of that share than it took of the row.
    const extra = pick?.extra_bargain_id ? Math.min(n(pick.extra_qty), take) : 0
    steps.push({
      id,
      take,
      whole: take >= have - 1e-6,
      bargain_id: pick?.bargain_id || fallbackBargainId || null,
      extra_bargain_id: extra > 1e-9 ? pick?.extra_bargain_id || null : null,
      extra_qty: extra
    })
    left = round3(left - take)
  }

  for (const pick of list) eat(pick.id, n(byId.get(pick.id)?.qty), pick)

  if (left > 1e-6) {
    // Past what was ticked. The oldest free parcels make up the difference,
    // which is the draw an invoice that ticked nothing has always taken.
    const mine = new Set(list.map((x) => x.id))
    const free = await getClient().execute({
      sql: `SELECT id, qty FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND (order_id IS NULL${orderId ? ' OR order_id = ?' : ''})
            ORDER BY deposit_date, id`,
      args: orderId ? [cid, supplierId, productId, orderId] : [cid, supplierId, productId]
    })
    for (const r of toPlain(free)) {
      if (left <= 1e-6) break
      if (mine.has(n(r.id))) continue
      eat(n(r.id), n(r.qty))
    }
  }
  if (left > 1e-6) {
    throw new Error(
      `Only ${round3(want - left).toFixed(3)} of consigned stock is available for this supplier and product`
    )
  }

  // What each bargain ends up drawing, from the amounts actually taken rather
  // than from the parcels' own sizes.
  const bargainIds = Array.from(
    new Set(steps.flatMap((x) => [x.bargain_id, x.extra_bargain_id]).filter((x): x is number => !!x))
  )
  const named = new Map<number, Row>()
  if (bargainIds.length) {
    const bres = await getClient().execute({
      sql: `SELECT id, bargain_no, rate_per_uom FROM bargains WHERE id IN (${bargainIds.map(() => '?').join(',')})`,
      args: bargainIds
    })
    for (const b of toPlain(bres)) named.set(n(b.id), b)
  }
  const lines = new Map<number, { bargain_id: number; bargain_no: string; rate: number; qty: number }>()
  const add = (bid: number | null, qty: number): void => {
    if (!bid || qty <= 1e-9) return
    const b = named.get(bid)
    const cur = lines.get(bid) || {
      bargain_id: bid,
      bargain_no: String(b?.bargain_no || ''),
      rate: n(b?.rate_per_uom),
      qty: 0
    }
    cur.qty = round3(cur.qty + qty)
    lines.set(bid, cur)
  }
  for (const x of steps) {
    add(x.bargain_id, round3(x.take - x.extra_qty))
    add(x.extra_bargain_id, x.extra_qty)
  }
  const drawnFromPicks = steps
    .filter((x) => list.some((pk) => pk.id === x.id))
    .reduce((t, x) => t + x.take, 0)
  return {
    total: want,
    steps,
    lines: Array.from(lines.values()),
    primaryBargainId: picked.primaryBargainId,
    ticked,
    fromPool: round3(want - drawnFromPicks)
  }
}

/**
 * Write the plan onto the parcels.
 *
 * A whole parcel is stamped with the invoice, as it always was. A part of one
 * becomes a row of its own carrying that part and pointing at its parent
 * through split_from, and the parent keeps the rest — same lot, same terminal,
 * same party, so the picker shows the pair as the one combination it is, and
 * releasing the invoice can put them back together exactly.
 */
export async function applyConsignmentDraw(
  orderId: number,
  plan: DrawPlan,
  companyId?: number
): Promise<void> {
  const c = getClient()
  for (const step of plan.steps) {
    if (step.whole) {
      await c.execute({
        sql: `UPDATE consignment_stock
              SET order_id = ?, bargain_id = ?, extra_bargain_id = ?, extra_qty = ?
              WHERE id = ?`,
        args: [
          orderId,
          step.bargain_id || null,
          step.extra_bargain_id || null,
          step.extra_bargain_id ? step.extra_qty : null,
          step.id
        ]
      })
      continue
    }
    const res = await c.execute({
      sql: 'SELECT * FROM consignment_stock WHERE id = ? LIMIT 1',
      args: [step.id]
    })
    const parent = (toPlain(res)[0] || null) as Row | null
    if (!parent) continue
    await c.execute({
      sql: `INSERT INTO consignment_stock
              (company_id, supplier_id, product_id, qty, uom, deposit_date, note, gate_entry_id,
               tanker_no, order_id, bargain_id, extra_bargain_id, extra_qty, is_opening,
               lot_no, terminal_no, split_from)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        companyId || n(parent.company_id),
        n(parent.supplier_id),
        n(parent.product_id),
        step.take,
        String(parent.uom || 'MT'),
        String(parent.deposit_date || ''),
        parent.note ? String(parent.note) : null,
        parent.gate_entry_id ? n(parent.gate_entry_id) : null,
        parent.tanker_no ? String(parent.tanker_no) : null,
        orderId,
        step.bargain_id || null,
        step.extra_bargain_id || null,
        step.extra_bargain_id ? step.extra_qty : null,
        n(parent.is_opening) === 1 ? 1 : 0,
        parent.lot_no ? String(parent.lot_no) : null,
        parent.terminal_no ? String(parent.terminal_no) : null,
        step.id
      ]
    })
    // The parent keeps what was not taken. weighed_qty and shortage_pct stay on
    // it untouched: they describe how the parcel was measured when it arrived,
    // which a later withdrawal does not change.
    await c.execute({
      sql: 'UPDATE consignment_stock SET qty = ? WHERE id = ?',
      args: [round3(n(parent.qty) - step.take), step.id]
    })
  }
}

function round3(x: number): number {
  return Math.round((Number(x) || 0) * 1000) / 1000
}

// Tie the picked tankers, with their bargain split, to the invoice that drew them.
export async function assignConsignmentLots(
  orderId: number,
  picks: unknown,
  supplierId: number,
  productId: number,
  companyId?: number
): Promise<LotAllocation> {
  const list = toLotPicks(picks)
  if (!list.length) return { total: 0, lines: [], primaryBargainId: 0 }
  const alloc = await validateConsignmentLots(list, supplierId, productId, orderId, companyId)
  const c = getClient()
  for (const p of list) {
    await c.execute({
      sql: `UPDATE consignment_stock
            SET order_id = ?, bargain_id = ?, extra_bargain_id = ?, extra_qty = ?
            WHERE id = ?`,
      args: [
        orderId,
        p.bargain_id || null,
        p.extra_bargain_id || null,
        p.extra_bargain_id ? n(p.extra_qty) : null,
        p.id
      ]
    })
  }
  return alloc
}

// Booking that did not name its tankers (the Book purchase button on the
// Consignment page) still has to take them out of the pending list, or the same
// tankers could be picked again on the purchase form. Oldest first, whole lots
// only, never past the invoiced quantity.
export async function autoAssignConsignmentLots(
  orderId: number,
  supplierId: number,
  productId: number,
  qty: number,
  bargainId = 0,
  companyId?: number
): Promise<number> {
  const free = await getClient().execute({
    sql: `SELECT id, qty FROM consignment_stock
          WHERE company_id = ? AND supplier_id = ? AND product_id = ? AND order_id IS NULL
          ORDER BY deposit_date, id`,
    args: [companyId || getActiveCompanyId(), supplierId, productId]
  })
  const take: number[] = []
  let used = 0
  for (const r of free.rows) {
    if (used + n(r.qty) > qty + 1e-6) continue
    take.push(Number(r.id))
    used += n(r.qty)
  }
  // Only claim tankers when they account for the invoice exactly. A partial
  // match would leave part of the quantity with no tanker behind it, and the
  // bargain register counts one or the other — never a mix.
  if (!take.length || Math.abs(used - qty) > 1e-6) return 0
  await getClient().execute({
    sql: `UPDATE consignment_stock SET order_id = ?, bargain_id = ?
          WHERE id IN (${take.map(() => '?').join(',')})`,
    args: [orderId, bargainId || null, ...take]
  })
  return used
}

// Free every lot an invoice held (on edit or delete) so they become pending again.
export async function releaseConsignmentLots(orderId: number): Promise<void> {
  const c = getClient()
  // A slice this invoice took out of a parcel goes back INTO that parcel, not
  // back into the pending list as a parcel of its own — otherwise editing one
  // invoice twice would leave a lot standing as five fragments of itself.
  const slices = toPlain(
    await c.execute({
      sql: 'SELECT id, qty, split_from FROM consignment_stock WHERE order_id = ? AND split_from IS NOT NULL',
      args: [orderId]
    })
  )
  for (const sl of slices) {
    const parent = await c.execute({
      sql: 'SELECT id, qty FROM consignment_stock WHERE id = ? LIMIT 1',
      args: [n(sl.split_from)]
    })
    if (!parent.rows.length) continue
    await c.execute({
      sql: 'UPDATE consignment_stock SET qty = ? WHERE id = ?',
      args: [round3(n(toPlain(parent)[0].qty) + n(sl.qty)), n(sl.split_from)]
    })
    await c.execute({ sql: 'DELETE FROM consignment_stock WHERE id = ?', args: [n(sl.id)] })
  }
  // A slice whose parent is gone cannot be merged; it is freed like any other
  // parcel below, which keeps its quantity in the register either way.
  await c.execute({
    sql: `UPDATE consignment_stock
          SET order_id = NULL, bargain_id = NULL, extra_bargain_id = NULL, extra_qty = NULL
          WHERE order_id = ?`,
    args: [orderId]
  })
}


/**
 * TAKE AN INVOICE BACK OFF THE PARCELS IT DREW.
 *
 * A withdrawal is written onto the parcels themselves: the invoice stamps the
 * rows it took, and a parcel it took only part of is carved into a slice of
 * its own. That is right while the attribution is right """ + D + """ and a trap when it
 * is not, because the register has no way to say "these were not the parcels".
 * An opening carved into five drawn slices cannot be restated (see
 * saveOpeningStock: a drawn parcel is untouchable), so a wrong guess about
 * which cargo fed which bill freezes the opening it guessed at.
 *
 * So the draw comes undone the same way editing the invoice already undid it:
 * slices merge back into the parcel they were cut from, and every row goes
 * back to unbooked. Nothing about the INVOICE changes """ + D + """ its quantity, its
 * value and its voucher are untouched, and the party balance is deposits less
 * invoices either way. What comes back is only the freedom to say where the
 * stock came from.
 */
export async function unlinkConsignmentDraw(orderId: number): Promise<{ id: number; freed: number }> {
  const id = n(orderId)
  if (!id) throw new Error('Which invoice?')
  const before = await getClient().execute({
    sql: 'SELECT COUNT(*) AS c FROM consignment_stock WHERE order_id = ?',
    args: [id]
  })
  const freed = n(toPlain(before)[0]?.c)
  if (!freed) throw new Error('This invoice is not holding any parcel')
  await releaseConsignmentLots(id)
  return { id, freed }
}

/**
 * The same, for every invoice standing on one party's product.
 *
 * Which is what undoing a bulk assignment actually means: the parcels were
 * matched to the invoices in one sweep, and a sweep is undone by a sweep, not
 * by opening eleven invoices in turn.
 */
export async function unlinkConsignmentDrawsFor(
  supplierId: number,
  productId: number
): Promise<{ invoices: number; freed: number }> {
  const c = getClient()
  const orders = toPlain(
    await c.execute({
      sql: `SELECT DISTINCT cs.order_id AS id
              FROM consignment_stock cs
             WHERE cs.company_id = ? AND cs.supplier_id = ? AND cs.product_id = ?
               AND cs.order_id IS NOT NULL`,
      args: [getActiveCompanyId(), n(supplierId), n(productId)]
    })
  )
  let freed = 0
  for (const o of orders) {
    const one = await unlinkConsignmentDraw(n(o.id)).catch(() => null)
    if (one) freed += one.freed
  }
  return { invoices: orders.length, freed }
}

/**
 * RENAME A COMBINATION, EVERYWHERE IT IS WRITTEN.
 *
 * A lot at a terminal is one cargo however many vehicles carried it, so a
 * correction to its number is a correction to all of them. Row by row it is
 * six edits that can disagree with each other; the register groups by the
 * pair, and a pair half-renamed splits into two groups that are really one.
 *
 * Drawn rows are renamed too. This writes a LABEL and nothing else """ + D + """ no
 * quantity, no invoice, no voucher """ + D + """ so there is no reason a parcel already
 * on a bill should have to keep a number that turned out to be wrong.
 */
export async function renameConsignmentLot(v: {
  supplier_id: number
  product_id: number
  from_lot?: string | null
  from_terminal?: string | null
  to_lot?: string | null
  to_terminal?: string | null
}): Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const fromLot = label(v.from_lot)
  const fromTerm = label(v.from_terminal)
  const toLot = label(v.to_lot)
  const toTerm = label(v.to_terminal)
  if (!toLot && !toTerm) throw new Error('Give the combination a lot number, a terminal number, or both')
  // Matched on what the rows actually hold, NULL included """ + D + """ "no lot yet" is a
  // combination like any other, and naming it is the commonest rename there is.
  const res = await c.execute({
    sql: `UPDATE consignment_stock SET lot_no = ?, terminal_no = ?
           WHERE company_id = ? AND supplier_id = ? AND product_id = ?
             AND COALESCE(lot_no, '') = COALESCE(?, '')
             AND COALESCE(terminal_no, '') = COALESCE(?, '')`,
    args: [toLot, toTerm, cid, n(v.supplier_id), n(v.product_id), fromLot, fromTerm]
  })
  return { updated: Number(res.rowsAffected || 0), lot_no: toLot, terminal_no: toTerm }
}

// Consigned stock rolled up per supplier+product: deposited, invoiced, balance.
// With a date range, the same split Book Stock uses: whatever moved before
// `from` collapses into `opening`, and `deposited`/`invoiced` become the
// movement strictly inside [from, to] — `balance` is then the closing figure
// as of `to`. Without a range (both blank) `opening` is 0 and `deposited`/
// `invoiced`/`balance` are the lifetime totals, exactly as before this split
// existed.
export async function consignmentSummary(range?: { from?: string; to?: string }): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const c = getClient()
  const from = String(range?.from || '')
  const to = String(range?.to || '')

  const base = await c.execute({
    sql: `SELECT DISTINCT cs.supplier_id, cs.product_id, cs.uom,
                 s.name AS supplier_name, p.code AS product_code, p.name AS product_name
          FROM consignment_stock cs
          LEFT JOIN suppliers s ON s.id = cs.supplier_id
          LEFT JOIN products p ON p.id = cs.product_id
          WHERE cs.company_id = ?`,
    args: [cid]
  })

  const depositSlice = async (kind: 'opening' | 'period'): Promise<Map<string, number>> => {
    if (kind === 'opening' && !from) return new Map()
    let sql = 'SELECT supplier_id, product_id, SUM(qty) AS q FROM consignment_stock WHERE company_id = ?'
    const args: (string | number)[] = [cid]
    if (kind === 'opening') {
      sql += ' AND deposit_date < ?'
      args.push(from)
    } else {
      if (from) { sql += ' AND deposit_date >= ?'; args.push(from) }
      if (to) { sql += ' AND deposit_date <= ?'; args.push(to) }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, product_id`, args })
    const m = new Map<string, number>()
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
    return m
  }

  // Stock becomes "invoiced" the moment the consignment purchase is booked —
  // orders.ordered_qty where is_consignment=1, sliced by order date instead
  // of taken over all time.
  const invoicedSlice = async (kind: 'opening' | 'period'): Promise<Map<string, number>> => {
    if (kind === 'opening' && !from) return new Map()
    let sql = `SELECT supplier_id, oil_type_id AS product_id, SUM(ordered_qty) AS q
               FROM orders WHERE company_id = ? AND is_consignment = 1`
    const args: (string | number)[] = [cid]
    if (kind === 'opening') {
      sql += ' AND order_date < ?'
      args.push(from)
    } else {
      if (from) { sql += ' AND order_date >= ?'; args.push(from) }
      if (to) { sql += ' AND order_date <= ?'; args.push(to) }
    }
    const res = await c.execute({ sql: `${sql} GROUP BY supplier_id, oil_type_id`, args })
    const m = new Map<string, number>()
    for (const r of res.rows) m.set(`${r.supplier_id}:${r.product_id}`, n(r.q))
    return m
  }

  const [depOpening, depPeriod, invOpening, invPeriod] = await Promise.all([
    depositSlice('opening'),
    depositSlice('period'),
    invoicedSlice('opening'),
    invoicedSlice('period')
  ])

  return toPlain(base).map((r) => {
    const key = `${r.supplier_id}:${r.product_id}`
    const opening = (depOpening.get(key) || 0) - (invOpening.get(key) || 0)
    const deposited = depPeriod.get(key) || 0
    const invoiced = invPeriod.get(key) || 0
    return { ...r, opening, deposited, invoiced, balance: opening + deposited - invoiced }
  })
}

// The invoices behind the "Invoiced" column — the same consignment purchases
// consignmentSummary sums, listed one row each so a product can be expanded to
// show what drew its stock down, not just the deposits that built it up.
export async function listConsignmentInvoices(range?: {
  from?: string
  to?: string
}): Promise<Row[]> {
  const from = String(range?.from || '')
  const to = String(range?.to || '')
  let sql = `SELECT o.id, o.invoice_no, o.order_date, o.supplier_id, o.oil_type_id AS product_id,
                    o.ordered_qty, o.uom, o.invoice_rate, o.taxable_value, o.net_amount,
                    b.bargain_no
             FROM orders o
             LEFT JOIN bargains b ON b.id = o.bargain_id
             WHERE o.company_id = ? AND o.is_consignment = 1`
  const args: (string | number)[] = [getActiveCompanyId()]
  if (from) { sql += ' AND o.order_date >= ?'; args.push(from) }
  if (to) { sql += ' AND o.order_date <= ?'; args.push(to) }
  const res = await getClient().execute({ sql: `${sql} ORDER BY o.order_date, o.id`, args })
  return toPlain(res)
}

// Gate-in entries booked as Direct MNC stock that haven't been validated into
// consignment stock yet — the accountant's to-do list. Only entries the
// gateman actually flagged Direct MNC belong here: a hand-typed vehicle for
// Packaging or Miscellaneous is a different thing entirely and is never
// meant to become a consignment lot, whatever date it was entered on.
export async function listPendingGateArrivals(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ge.id, ge.gate_entry_no, ge.ref_no, ge.entry_date, ge.tanker_no, ge.rec_type,
                 ge.received_qty, ge.gross_weight, ge.tare_weight, ge.uom, ge.status, ge.note,
                 ge.oil_type_id, ge.supplier_id, ge.is_direct_mnc,
                 p.code AS product_code, p.name AS product_name, s.name AS supplier_name
          FROM gate_entries ge
          LEFT JOIN products p ON p.id = ge.oil_type_id
          LEFT JOIN suppliers s ON s.id = ge.supplier_id
          WHERE ge.direction = 'in'
            AND ge.is_direct_mnc = 1
            AND ge.tanker_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.gate_entry_id = ge.id)
          ORDER BY ge.entry_date DESC, ge.id DESC`,
    args: []
  })
  return toPlain(res)
}

// Every check a consignment lot has to pass, whether it is being logged for the
// first time or edited afterwards. Kept in one place so both routes refuse the
// same mistakes with the same wording.
//
// `existing` is the row being edited (absent when logging a new one). The gate
// entry a lot came from is authoritative about the party and the weighed
// quantity, so an edit cannot quietly contradict it.
const CONSIGNMENT_UOMS = ['MT', 'KG', 'L']
// Same tolerance the purchase side allows between a gate weighment and the books.
const GATE_BUFFER = 1

async function validateLot(v: Row, existing: Row | null, companyId?: number): Promise<{
  supplierId: number
  productId: number
  qty: number
  uom: string
  depositDate: string
}> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const supplierId = v.supplier_id ? n(v.supplier_id) : n(existing?.supplier_id)
  const productId = v.product_id ? n(v.product_id) : n(existing?.product_id)
  const qty = v.qty != null && v.qty !== '' ? n(v.qty) : n(existing?.qty)
  const uom = String(v.uom || existing?.uom || 'MT').toUpperCase()
  const depositDate = String(v.deposit_date || existing?.deposit_date || '').slice(0, 10)

  if (!supplierId) throw new Error('Choose the supplier this stock belongs to')
  if (!productId) throw new Error('Choose the product')
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  if (!Number.isFinite(qty)) throw new Error('Quantity must be a number')
  if (!CONSIGNMENT_UOMS.includes(uom)) {
    throw new Error(`Unit must be one of ${CONSIGNMENT_UOMS.join(', ')}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depositDate)) throw new Error('Enter the date this stock came in')
  const today = todayISO()
  if (depositDate > today) throw new Error('The date cannot be in the future')

  // The party must be a real, live supplier.
  const sup = await c.execute({
    sql: 'SELECT id, name, active FROM suppliers WHERE id = ? LIMIT 1',
    args: [supplierId]
  })
  if (!sup.rows.length) throw new Error('That supplier no longer exists')
  if (!n(sup.rows[0].active)) throw new Error(`${sup.rows[0].name} is marked inactive — reactivate it first`)

  // So must the product.
  const prod = await c.execute({
    sql: 'SELECT id, code, name, active FROM products WHERE id = ? LIMIT 1',
    args: [productId]
  })
  if (!prod.rows.length) throw new Error('That product no longer exists')
  if (!n(prod.rows[0].active)) {
    throw new Error(`${prod.rows[0].code || prod.rows[0].name} is marked inactive — reactivate it first`)
  }

  // Anything the gate recorded wins: the party was named there and the vehicle
  // was weighed there, so an edit cannot drift away from it.
  const gateId = existing?.gate_entry_id ?? (v.gate_entry_id ? n(v.gate_entry_id) : null)
  if (gateId) {
    const ge = await c.execute({
      sql: 'SELECT id, gate_entry_no, supplier_id, is_direct_mnc, received_qty, status FROM gate_entries WHERE id = ? LIMIT 1',
      args: [n(gateId)]
    })
    if (!ge.rows.length) throw new Error('That gate entry no longer exists')
    const g = toPlain(ge)[0]
    if (n(g.is_direct_mnc) === 1 && n(g.supplier_id) && n(g.supplier_id) !== supplierId) {
      const named = await c.execute({ sql: 'SELECT name FROM suppliers WHERE id = ?', args: [n(g.supplier_id)] })
      throw new Error(
        `Gate entry ${g.gate_entry_no} was booked in for ${named.rows[0]?.name || 'another party'} — change it at the gate if that is wrong`
      )
    }
    const weighed = n(g.received_qty)
    if (weighed > 0 && Math.abs(qty - weighed) > GATE_BUFFER + 1e-6) {
      throw new Error(
        `Gate entry ${g.gate_entry_no} weighed ${weighed.toFixed(3)} ${uom} — ${qty.toFixed(3)} is more than ${GATE_BUFFER} ${uom} away from it`
      )
    }
  }

  // Opening stock is a balance, not a running total — but a balance made of
  // PARCELS: L-2451 at KANDLA and L-2779 at MUNDRA are two rows of one
  // opening, and saveOpeningStock writes them as such. What is still refused
  // is a second row for the SAME parcel, which is the duplicate this has
  // always been about; an unlabelled opening is its own parcel, so a party
  // that keeps its stock in one pool behaves exactly as before.
  if (!existing && v.is_opening) {
    const lot = label(v.lot_no)
    const term = label(v.terminal_no)
    const dup = await c.execute({
      sql: `SELECT id, qty, uom FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND is_opening = 1 AND order_id IS NULL
              AND COALESCE(lot_no, '') = ? AND COALESCE(terminal_no, '') = ? LIMIT 1`,
      args: [cid, supplierId, productId, lot || '', term || '']
    })
    if (dup.rows.length) {
      const d = dup.rows[0]
      throw new Error(
        `${lot || term ? `Parcel ${[lot, term].filter(Boolean).join(' at ')} of the opening` : 'Opening stock'} for ` +
          `${sup.rows[0].name} · ${prod.rows[0].code || prod.rows[0].name} is already recorded ` +
          `(${n(d.qty).toFixed(3)} ${d.uom || 'MT'}) — update that entry instead of adding another`
      )
    }
  }

  // Two lots of the same party, product, date and vehicle is almost always the
  // same delivery entered twice.
  const tankerNo = (v.tanker_no ?? existing?.tanker_no) ? String(v.tanker_no ?? existing?.tanker_no).trim() : null
  if (tankerNo) {
    const dup = await c.execute({
      sql: `SELECT id FROM consignment_stock
            WHERE company_id = ? AND supplier_id = ? AND product_id = ?
              AND substr(deposit_date, 1, 10) = ? AND UPPER(TRIM(tanker_no)) = ?
              AND id <> ? LIMIT 1`,
      args: [cid, supplierId, productId, depositDate, tankerNo.toUpperCase(), n(existing?.id) || 0]
    })
    if (dup.rows.length) {
      throw new Error(`Tanker ${tankerNo} is already logged for this party and product on ${depositDate}`)
    }
  }

  return { supplierId, productId, qty, uom, depositDate }
}

export async function createConsignment(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const gateId = v.gate_entry_id ? n(v.gate_entry_id) : null
  let tankerNo = v.tanker_no ? String(v.tanker_no).trim() : null
  if (gateId) {
    // Validating a gate arrival: it must exist and not already be booked.
    const ge = await c.execute({
      sql: 'SELECT id, tanker_no, direction FROM gate_entries WHERE id = ?',
      args: [gateId]
    })
    if (!ge.rows.length) throw new Error('That gate entry no longer exists')
    const dup = await c.execute({
      sql: 'SELECT id FROM consignment_stock WHERE gate_entry_id = ?',
      args: [gateId]
    })
    if (dup.rows.length) throw new Error('This gate entry has already been validated into consignment stock')
    if (!tankerNo) tankerNo = ge.rows[0].tanker_no ? String(ge.rows[0].tanker_no) : null
  }
  const bookCompany = v.company_id ? n(v.company_id) : getActiveCompanyId()
  const ok = await validateLot({ ...v, tanker_no: tankerNo }, null, bookCompany)
  const res = await c.execute({
    sql: `INSERT INTO consignment_stock (company_id, supplier_id, product_id, qty, uom, deposit_date, note,
            gate_entry_id, tanker_no, is_opening, weighed_qty, shortage_pct, lot_no, terminal_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      bookCompany,
      ok.supplierId,
      ok.productId,
      ok.qty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      gateId,
      tankerNo,
      v.is_opening ? 1 : 0,
      v.weighed_qty != null && v.weighed_qty !== '' ? n(v.weighed_qty) : null,
      v.shortage_pct != null && v.shortage_pct !== '' ? n(v.shortage_pct) : null,
      label(v.lot_no),
      label(v.terminal_no)
    ]
  })
  return { id: Number(res.lastInsertRowid) }
}

// Editing a lot can't drop the supplier+product's deposited total below what
// has already been invoiced from it.
export async function updateConsignment(id: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) throw new Error('Consignment entry not found')
  const row = toPlain(cur)[0]
  // Refuse first, before anything is written: a booked lot is frozen because its
  // quantity is already inside a purchase invoice.
  if (row.order_id != null) {
    const inv = await c.execute({
      sql: 'SELECT invoice_no FROM orders WHERE id = ? LIMIT 1',
      args: [n(row.order_id)]
    })
    const no = inv.rows[0]?.invoice_no
    throw new Error(
      `This tanker is already booked on purchase invoice ${no || '(unknown)'} — edit or delete that purchase first`
    )
  }
  const newCompany = v.company_id ? n(v.company_id) : n(row.company_id)
  const ok = await validateLot(v, row, newCompany)
  const newQty = ok.qty
  // The party and the product are editable too, so a lot can be moved to the
  // pair it should have been logged against.
  const newSupplier = ok.supplierId
  const newProduct = ok.productId
  const moved = newSupplier !== n(row.supplier_id) || newProduct !== n(row.product_id) || newCompany !== n(row.company_id)
  // Checked against the OLD company — that is whose books this lot is
  // currently sitting in, and whose already-invoiced quantity it must keep
  // covering if it moves away.
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id), n(row.company_id))
  if (moved) {
    // The whole lot leaves its old supplier+product+company, so that pair
    // loses all of it — it must still cover whatever has already been
    // invoiced from it.
    if (avail - n(row.qty) < -1e-6) {
      throw new Error('Cannot move this stock — part of this supplier and product has already been invoiced')
    }
  } else if (avail + (newQty - n(row.qty)) < -1e-6) {
    // available already reflects the current qty; adding the delta must stay ≥ 0
    throw new Error('Cannot reduce below the quantity already invoiced from this stock')
  }
  await c.execute({
    sql: `UPDATE consignment_stock
          SET company_id = ?, supplier_id = ?, product_id = ?, qty = ?, uom = ?, deposit_date = ?, note = ?,
              weighed_qty = ?, shortage_pct = ?, tanker_no = ?, lot_no = ?, terminal_no = ?
          WHERE id = ?`,
    args: [
      newCompany,
      newSupplier,
      newProduct,
      newQty,
      ok.uom,
      ok.depositDate,
      v.note ? String(v.note).trim() : null,
      v.weighed_qty != null && v.weighed_qty !== '' ? n(v.weighed_qty) : row.weighed_qty,
      v.shortage_pct != null && v.shortage_pct !== '' ? n(v.shortage_pct) : row.shortage_pct,
      // Only a caller that actually named the key may change it — every other
      // path into this function (booking, allocation) leaves it alone rather
      // than blanking the vehicle the gate weighed.
      v.tanker_no !== undefined ? String(v.tanker_no ?? '').trim() || null : row.tanker_no,
      // Same rule as the tanker: only a caller that NAMED the field may change
      // it, so booking a lot into a purchase cannot quietly strip the labels
      // that say which cargo it came off.
      v.lot_no !== undefined ? label(v.lot_no) : row.lot_no,
      v.terminal_no !== undefined ? label(v.terminal_no) : row.terminal_no,
      id
    ]
  })
  // The parts an invoice split off this lot are still this lot: a lot or
  // terminal named on it reaches them too, or the one parcel would read as
  // two differently-labelled ones the moment it was relabelled.
  if (v.lot_no !== undefined || v.terminal_no !== undefined) {
    await c.execute({
      sql: 'UPDATE consignment_stock SET lot_no = ?, terminal_no = ? WHERE split_from = ?',
      args: [
        v.lot_no !== undefined ? label(v.lot_no) : row.lot_no ?? null,
        v.terminal_no !== undefined ? label(v.terminal_no) : row.terminal_no ?? null,
        id
      ]
    })
  }
  return { id }
}

export async function deleteConsignment(id: number): Promise<{ id: number }> {
  {
    // A deleted OPENING lot still leaves its figure in the restatement log, so
    // a mistaken removal can be restored from the dialog's history.
    const cur = await getClient().execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
    if (cur.rows.length && n(cur.rows[0].is_opening) === 1 && cur.rows[0].order_id == null) {
      const l = cur.rows[0]
      // Deleting the opening cannot orphan quantity already drawn into
      // purchases — the balance would go negative.
      const avail = await consignmentAvailable(n(l.supplier_id), n(l.product_id))
      if (n(l.qty) > avail + 1e-6) {
        throw new Error(
          `${(n(l.qty) - avail).toFixed(3)} ${l.uom || 'MT'} of this opening is already drawn into purchases — reduce it from the opening dialog instead of deleting`
        )
      }
      await getClient().execute({
        sql: `INSERT INTO consignment_opening_log (company_id, supplier_id, product_id, action, old_qty, new_qty, uom, deposit_date, note)
              VALUES (?, ?, ?, 'delete', ?, NULL, ?, ?, ?)`,
        args: [n(l.company_id) || getActiveCompanyId(), n(l.supplier_id), n(l.product_id), n(l.qty), String(l.uom || 'MT'), String(l.deposit_date || ''), l.note ? String(l.note) : null]
      }).catch(() => {})
    }
  }
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [id] })
  if (!cur.rows.length) return { id }
  const row = cur.rows[0]
  if (row.order_id != null) {
    throw new Error('This tanker is already booked on a purchase invoice — delete that purchase first')
  }
  const avail = await consignmentAvailable(n(row.supplier_id), n(row.product_id))
  // Removing this lot drops availability by its qty; it can't go negative.
  if (avail - n(row.qty) < -1e-6) {
    throw new Error('Cannot delete — part of this stock has already been invoiced')
  }
  await c.execute({ sql: 'DELETE FROM consignment_stock WHERE id = ?', args: [id] })
  return { id }
}

// ---------------------------------------------------------------------------
// WHICH CARGO A TANKER CAME OFF
// ---------------------------------------------------------------------------
//
// Five tankers arrive from BUNGE against one parcel: one lot at the port, one
// terminal it was discharged at. Each arrival is validated on its own — that
// is right, because each is weighed on its own — so the thing they have in
// common has to be put back afterwards, over several rows at once.

/**
 * Set the lot and/or terminal on a set of deposits.
 *
 * Only the field NAMED is written: passing a lot alone leaves each row's
 * terminal as it was, which is what lets the two be filled in on different
 * days by different desks. An empty string clears — that is a deliberate
 * "this had no lot after all", and is different from not mentioning it.
 *
 * A booked lot is not refused here. Its quantity is frozen inside a purchase
 * invoice, but which cargo it came off is a FACT ABOUT THE ARRIVAL, not about
 * the invoice, and it is usually learnt after the booking.
 */
export async function assignConsignmentGroup(
  ids: number[],
  v: { lot_no?: string; terminal_no?: string }
): Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }> {
  const list = (Array.isArray(ids) ? ids : []).map(n).filter(Boolean)
  if (!list.length) throw new Error('Pick at least one tanker to assign')
  const setLot = v.lot_no !== undefined
  const setTerm = v.terminal_no !== undefined
  if (!setLot && !setTerm) throw new Error('Give a lot number, a terminal number, or both')
  const lot = setLot ? label(v.lot_no) : null
  const term = setTerm ? label(v.terminal_no) : null

  const c = getClient()
  const sets: string[] = []
  const args: (string | number | null)[] = []
  if (setLot) {
    sets.push('lot_no = ?')
    args.push(lot)
  }
  if (setTerm) {
    sets.push('terminal_no = ?')
    args.push(term)
  }
  const res = await c.execute({
    sql: `UPDATE consignment_stock SET ${sets.join(', ')}
           WHERE company_id = ? AND id IN (${list.map(() => '?').join(',')})`,
    args: [...args, getActiveCompanyId(), ...list] as never[]
  })
  // …and the parts invoices split off those lots, which are the same parcels.
  await c.execute({
    sql: `UPDATE consignment_stock SET ${sets.join(', ')}
           WHERE company_id = ? AND split_from IN (${list.map(() => '?').join(',')})`,
    args: [...args, getActiveCompanyId(), ...list] as never[]
  })
  return { updated: Number(res.rowsAffected || 0), lot_no: lot, terminal_no: term }
}


/**
 * WHICH PARCELS THE INVOICES ALREADY BOOKED CAME OFF.
 *
 * A consignment purchase draws its parcels only when the form ticks some: an
 * invoice booked by typing a quantity and nothing else took the stock out of
 * the balance (deposits less invoices, which is what the register totals) but
 * left every parcel standing as unbooked. Two things went wrong because of it.
 * The withdrawal could not say which lot at which terminal it came off — the
 * question the register now groups itself to answer — and the next booking
 * was offered parcels that had in truth already gone, because the picker asks
 * order_id IS NULL and every one of them was still null.
 *
 * So the invoices are walked oldest first and given the parcels they would
 * have drawn had they been booked through the picker: the same oldest-first
 * FIFO an untouched invoice has always used, through the same plan/apply pair,
 * splitting the parcel it stops in the middle of. Nothing is invented and
 * nothing is moved:
 *
 *   - Only invoices that hold NO parcel at all are touched, so this can run
 *     again and find nothing to do, and a hand-picked invoice is never
 *     second-guessed.
 *   - Trading purchases are skipped. They ride the consignment booking path
 *     but are bought and sold straight through, off no deposit at all.
 *   - An invoice the deposits cannot cover is left exactly as it is. The plan
 *     refuses rather than reaching for stock that is not there, and the next
 *     invoice is still tried — one party short of a deposit does not stop the
 *     rest.
 *   - Quantities, rates, bargains and vouchers are not written. The only
 *     change is which parcel row carries which invoice, which is the fact
 *     that was missing.
 */
export async function backfillConsignmentDraws(): Promise<{
  linked: number
  skipped: number
  notes: string[]
}> {
  const c = getClient()
  const res = await c.execute(`SELECT o.id, o.company_id, o.supplier_id, o.oil_type_id, o.ordered_qty,
                 o.bargain_id, o.invoice_no, o.order_date
            FROM orders o
           WHERE o.is_consignment = 1
             AND COALESCE(o.is_trading, 0) = 0
             AND COALESCE(o.ordered_qty, 0) > 0
             AND NOT EXISTS (SELECT 1 FROM consignment_stock cs WHERE cs.order_id = o.id)
           ORDER BY o.order_date, o.id`)
  const orders = toPlain(res)
  let linked = 0
  let skipped = 0
  const notes: string[] = []
  for (const o of orders) {
    try {
      const plan = await planConsignmentDraw(
        [],
        n(o.supplier_id),
        n(o.oil_type_id),
        n(o.ordered_qty),
        n(o.id),
        n(o.company_id),
        n(o.bargain_id)
      )
      await applyConsignmentDraw(n(o.id), plan, n(o.company_id))
      linked += 1
    } catch (e) {
      skipped += 1
      notes.push(`${String(o.invoice_no || o.id)}: ${(e as Error).message}`)
    }
  }
  return { linked, skipped, notes }
}

// HOW ALIKE TWO TANKER NUMBERS ARE.
//
// A parcel is carried by vehicles booked together, and it shows in the
// numbers: the same lorry making a second trip (identical), or a row of them
// off one fleet (RJ09GB/4045, RJ09GB/4046). Split into the letters in front
// and the digits behind and the two cases fall out.
//
// Deliberately narrow. This is a SUGGESTION beside a human decision, so it had
// better be right when it speaks: a near-miss that groups two unrelated
// tankers costs more than saying nothing.
// The PLATE, out of whatever the gate typed into the box.
//
// The field is free text and the yard uses it as one: real rows read
// "GJ39T 4627-BUNGE INDIA-CPO-INV.NO-8630636491". Everything from the first
// dash that is followed by a word is documentation, not the vehicle — cut it,
// or the invoice number becomes the tanker's digits and nothing matches.
//
// Four letters, not one: MH-12-AB-1234 is a plate, and cutting at its first
// dash would leave "MH".
function plateOf(no: unknown): string {
  return String(no ?? '')
    .toUpperCase()
    .split(/-(?=[A-Z]{4})/)[0]
    .replace(/[^A-Z0-9]/g, '')
}

function tankerParts(no: unknown): { key: string; tail: number } | null {
  const raw = plateOf(no)
  if (!raw) return null
  const m = raw.match(/^(.*?)(\d+)$/)
  if (!m) return { key: raw, tail: NaN }
  return { key: m[1], tail: Number(m[2]) }
}

export function tankerKin(a: unknown, b: unknown): { kin: boolean; why: string } {
  const x = tankerParts(a)
  const y = tankerParts(b)
  if (!x || !y) return { kin: false, why: '' }
  const rawA = plateOf(a)
  const rawB = plateOf(b)
  if (rawA === rawB) return { kin: true, why: 'same vehicle, another trip' }
  if (!x.key || x.key !== y.key) return { kin: false, why: '' }
  if (!Number.isFinite(x.tail) || !Number.isFinite(y.tail)) return { kin: false, why: '' }
  const gap = Math.abs(x.tail - y.tail)
  if (gap > 0 && gap <= 10) return { kin: true, why: 'consecutive number, same fleet' }
  return { kin: false, why: '' }
}

/**
 * What else looks like it belongs with this arrival.
 *
 * Same party and same product always — a lot is a parcel of ONE oil from ONE
 * supplier, and nothing across that line is ever a suggestion. Then, in the
 * order they are worth reading:
 *
 *   1. a deposit whose tanker is kin to this one and already carries a lot —
 *      the strongest, because it tells us the NUMBER as well as the grouping;
 *   2. kin with no lot yet;
 *   3. anything else unlabelled that arrived within three days.
 *
 * Never returns a row already on a different lot: moving one is a decision,
 * not a suggestion, and the desk can still do it by hand.
 */
export async function consignmentKin(id: number): Promise<Row> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT * FROM consignment_stock WHERE id = ?', args: [n(id)] })
  if (!cur.rows.length) throw new Error('That tanker is no longer on the register')
  const row = toPlain(cur)[0]

  const near = await c.execute({
    sql: `SELECT cs.*, ge.gate_entry_no, o.invoice_no
            FROM consignment_stock cs
            LEFT JOIN gate_entries ge ON ge.id = cs.gate_entry_id
            LEFT JOIN orders o ON o.id = cs.order_id
           WHERE cs.company_id = ? AND cs.supplier_id = ? AND cs.product_id = ?
             AND cs.id <> ? AND COALESCE(cs.is_opening, 0) = 0
             AND ABS(JULIANDAY(cs.deposit_date) - JULIANDAY(?)) <= 7
           ORDER BY cs.deposit_date DESC, cs.id DESC
           LIMIT 40`,
    args: [n(row.company_id), n(row.supplier_id), n(row.product_id), n(row.id), String(row.deposit_date)]
  })

  const mine = String(row.lot_no || '')
  const out: Row[] = []
  for (const r of toPlain(near)) {
    const theirs = String(r.lot_no || '')
    // A row already on a DIFFERENT lot is left alone — moving one is a
    // decision, not a suggestion. But that only applies once this arrival has
    // a lot of its own: while it has none, the rows that already carry one are
    // the whole point, because they are what tells us the number.
    if (mine && theirs && theirs !== mine) continue
    const k = tankerKin(row.tanker_no, r.tanker_no)
    const days = Math.abs(
      (Date.parse(`${String(r.deposit_date).slice(0, 10)}T00:00:00Z`) -
        Date.parse(`${String(row.deposit_date).slice(0, 10)}T00:00:00Z`)) /
        86400000
    )
    const near = `arrived ${days === 0 ? 'the same day' : `within ${days} day${days === 1 ? '' : 's'}`}`
    if (k.kin) {
      // Kin AND already lotted is the best thing this can say: it gives the
      // grouping and the number in one row.
      out.push({ ...r, why: theirs ? `${k.why} — already on ${theirs}` : k.why, rank: theirs ? 1 : 2 })
    } else if (theirs && days <= 3) {
      // Not the same vehicle, but a cargo landed beside it has been named.
      out.push({ ...r, why: `${near} — already on ${theirs}`, rank: 3 })
    } else if (!theirs && days <= 3) {
      out.push({ ...r, why: near, rank: 4 })
    }
  }
  out.sort((a, b) => n(a.rank) - n(b.rank) || String(b.deposit_date).localeCompare(String(a.deposit_date)))

  // The number to propose: the one a kin tanker is already on. Nothing is
  // invented — an empty suggestion means nobody has named this cargo yet.
  // Rank 1 first — the same vehicle, already lotted — then a neighbour that
  // carries one. Nothing is invented: with neither, the suggestion is empty
  // and the desk names the cargo itself.
  const fromKin = out.find((r) => n(r.rank) === 1) || out.find((r) => n(r.rank) === 3)
  return {
    row,
    suggested_lot: mine || String(fromKin?.lot_no || ''),
    suggested_terminal: String(row.terminal_no || '') || String(fromKin?.terminal_no || ''),
    suggested_from: fromKin ? String(fromKin.tanker_no || '') : '',
    kin: out.slice(0, 12)
  }
}
