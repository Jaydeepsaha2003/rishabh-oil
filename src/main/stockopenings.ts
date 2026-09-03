import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getBooksFrom } from './openings'
import { stockLevels } from './stock'
import { productValuationRates } from './stock'

// Stock brought forward on the day the books begin.
//
// Book stock is derived entirely from movements. A mill that has been trading
// for years but whose books start on a date therefore opens every product at
// nothing, and every gram consumed since reads as stock it never had — which
// is why thirteen products in KR FOODS close negative, IVF worst at -532.7 MT.
// Entering what was actually in the tanks that morning is what makes the
// register true, and it is the thing every later reconciliation stands on.

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
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const r2 = (v: number): number => Math.round(v * 100) / 100

// The day the opening is struck. The ledger already has a books-start per
// company and stock has no business disagreeing with it, so that is the
// default — but it is only a default, because a mill may count its tanks on a
// different morning from the one its accountant closed the books on.
export async function stockOpeningDate(companyId?: number): Promise<string> {
  const cid = n(companyId) || getActiveCompanyId()
  const existing = await getClient().execute({
    sql: 'SELECT as_of FROM stock_openings WHERE company_id = ? ORDER BY as_of LIMIT 1',
    args: [cid]
  })
  if (existing.rows.length) return String(existing.rows[0].as_of).slice(0, 10)
  const books = await getBooksFrom(cid)
  return books ? String(books).slice(0, 10) : ''
}

// Every product, with what it opens at today, what the book says it closes at,
// and what that closing would become once the opening is applied.
//
// The projected closing is the number that matters on this screen: it is the
// only way to see, while typing, whether the figure being entered actually
// clears the negative it is there to clear.
export async function listStockOpenings(companyId?: number): Promise<Row> {
  const cid = n(companyId) || getActiveCompanyId()
  const c = getClient()

  // The opening date decides what counts. Movements BEFORE it are deliberately
  // out of scope: that morning is the fresh start, and anything earlier belongs
  // to the period the mill is not reconciling. Reading all-time movement here
  // was what put a −1,586.8 against DALDA on a sheet whose whole purpose is to
  // state what the tank held on 1 September.
  //
  // Those earlier movements are not deleted and are still visible in the Book
  // Stock register to anyone who widens the period by hand — they are simply
  // not what this screen is about.
  const asOf = await stockOpeningDate(cid)
  const [saved, levels, rates, dupes] = await Promise.all([
    c.execute({
      sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty, rate, as_of, note
            FROM stock_openings WHERE company_id = ?`,
      args: [cid]
    }),
    stockLevels(asOf ? { from: asOf } : undefined, [cid]),
    productValuationRates().catch(() => new Map<number, number>()),
    duplicateProductNames()
  ])

  const savedBy = new Map<number, Row>()
  for (const r of toPlain(saved)) savedBy.set(n(r.product_id), r)

  const rows = (levels as Row[]).map((p) => {
    const id = n(p.id)
    const s = savedBy.get(id)
    const entered = s ? n(s.qty) : null
    const pp = s ? n(s.pp_qty) : null
    // Movements SINCE the opening date, and nothing else.
    //
    // `opening` from a ranged read is everything before the range — the saved
    // opening plus any earlier movement — so taking it off `stock` leaves the
    // period's own activity. That keeps this screen answering one question:
    // given what happened after that morning, what does the tank have to have
    // held on it? A second visit therefore shows the same shortfall it showed
    // first time, rather than one already half-answered by the saved figure.
    const fromMovement = r3(n(p.stock) - n(p.opening))
    // What the register will read once the opening is applied.
    const closing = r3(fromMovement + n(entered) + n(pp))
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      material_type: p.material_type,
      active: p.active,
      // What is saved against this product today (null = never entered).
      // Counted in two parts, the way the plant counts it: what is in the tank
      // and what is already in process. The register opens at the total.
      qty: entered,
      pp_qty: pp,
      total: entered == null && pp == null ? null : r3(n(entered) + n(pp)),
      rate: s && s.rate != null ? n(s.rate) : null,
      note: s?.note ?? null,
      // Movement-only closing: what the register would say with no opening at
      // all. Negative here is precisely the hole an opening has to fill.
      movement_closing: fromMovement,
      shortfall: fromMovement < 0 ? r3(-fromMovement) : 0,
      closing,
      suggested_rate: r2(rates.get(id) || 0)
    }
  })

  // Valued on the whole opening — tank plus in-process.
  const totalValue = rows.reduce((t, r) => t + (n(r.qty) + n(r.pp_qty)) * n(r.rate), 0)
  return {
    company_id: cid,
    as_of: asOf,
    books_from: (await getBooksFrom(cid)) || null,
    rows,
    entered_count: rows.filter((r) => r.qty != null || r.pp_qty != null).length,
    total_raw: r3(rows.reduce((t, r) => t + n(r.qty), 0)),
    total_pp: r3(rows.reduce((t, r) => t + n(r.pp_qty), 0)),
    total_qty: r3(rows.reduce((t, r) => t + n(r.qty) + n(r.pp_qty), 0)),
    negative_count: rows.filter((r) => n(r.movement_closing) < -0.0005).length,
    still_negative: rows.filter((r) => n(r.closing) < -0.0005).length,
    total_value: r2(totalValue),
    // Two products may legitimately share a name — RPO exists as both a raw
    // oil and a finished one — so this is a warning to label them, never a
    // prompt to merge them. Merging would collapse the two into one line and
    // lose the distinction between what is bought and what is made.
    name_clashes: dupes
  }
}

// Products whose names read the same once case, spacing and full stops are set
// aside. Reported with their category so the reader can see at once whether
// they are genuinely two things or one thing entered twice.
export async function duplicateProductNames(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT UPPER(TRIM(REPLACE(REPLACE(name, '.', ''), '  ', ' '))) AS k,
                 COUNT(*) AS c,
                 GROUP_CONCAT(id) AS ids,
                 GROUP_CONCAT(name, ' | ') AS names,
                 GROUP_CONCAT(COALESCE(category, ''), ' | ') AS categories,
                 GROUP_CONCAT(COALESCE(code, '-'), ' | ') AS codes
            FROM products
           GROUP BY k HAVING COUNT(*) > 1
           ORDER BY k`,
    args: []
  })
  return toPlain(res).map((r) => {
    const cats = String(r.categories || '').split(' | ')
    return {
      key: r.k,
      count: n(r.c),
      ids: String(r.ids || '').split(',').map(Number),
      names: String(r.names || '').split(' | '),
      codes: String(r.codes || '').split(' | '),
      categories: cats,
      // Same name AND same category is the one that may really be a duplicate.
      // Different categories means two different goods that need distinct
      // names, which is a labelling job, not a merge.
      same_category: new Set(cats).size === 1
    }
  })
}

// Save the whole sheet in one go. A row with a blank quantity is REMOVED
// rather than stored as zero: "nothing brought forward" and "not yet counted"
// are different statements, and only the first should show as an opening of
// nil on the register.
export async function saveStockOpenings(
  rows: Row[],
  asOf: string,
  companyId?: number
): Promise<{ saved: number; cleared: number }> {
  const cid = n(companyId) || getActiveCompanyId()
  const date = String(asOf || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the date this opening is struck on')
  const c = getClient()

  let saved = 0
  let cleared = 0
  for (const raw of Array.isArray(rows) ? rows : []) {
    const pid = n(raw?.product_id ?? raw?.id)
    if (!pid) continue
    // Blank means BOTH parts blank. A tank counted at nothing with work in
    // process is still a real answer, so one figure alone keeps the row.
    const rawBlank = raw?.qty === '' || raw?.qty == null
    const ppBlank = raw?.pp_qty === '' || raw?.pp_qty == null
    const blank = rawBlank && ppBlank
    if (blank) {
      const res = await c.execute({
        sql: 'DELETE FROM stock_openings WHERE company_id = ? AND product_id = ?',
        args: [cid, pid]
      })
      if (Number(res.rowsAffected) > 0) cleared++
      continue
    }
    const qty = n(raw.qty)
    const pp = n(raw.pp_qty)
    const rate = raw?.rate === '' || raw?.rate == null ? null : n(raw.rate)
    await c.execute({
      sql: `INSERT INTO stock_openings (company_id, product_id, as_of, qty, pp_qty, rate, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(company_id, product_id) DO UPDATE SET
              as_of = excluded.as_of,
              qty = excluded.qty,
              pp_qty = excluded.pp_qty,
              rate = excluded.rate,
              note = excluded.note,
              updated_at = datetime('now')`,
      args: [cid, pid, date, qty, pp, rate, raw?.note ? String(raw.note).trim() : null]
    })
    saved++
  }

  // The opening IS the actual stock on that morning, so the day-close sheet for
  // that date is written from it too. Without this the books would open at a
  // figure the physical count screen had never heard of, and the first
  // reconciliation would read as a variance on day one.
  //
  // Only the opening date is touched, and only the products on this sheet.
  await seedOpeningDayCount(cid, date)
  return { saved, cleared }
}

// Mirror the opening into stock_counts for the opening date: actual = book on
// the morning the books start. Rewritten each save so the two cannot drift.
async function seedOpeningDayCount(companyId: number, date: string): Promise<void> {
  const c = getClient()
  const rows = toPlain(
    await c.execute({
      sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty, rate
            FROM stock_openings WHERE company_id = ? AND as_of = ?`,
      args: [companyId, date]
    })
  )
  for (const r of rows) {
    await c
      .execute({
        sql: `INSERT INTO stock_counts (company_id, count_date, product_id, actual_qty, pp_qty, rate, note)
              VALUES (?, ?, ?, ?, ?, ?, 'Opening stock')
              ON CONFLICT(company_id, count_date, product_id) DO UPDATE SET
                actual_qty = excluded.actual_qty,
                pp_qty = excluded.pp_qty,
                rate = COALESCE(excluded.rate, stock_counts.rate),
                note = 'Opening stock'`,
        args: [companyId, date, n(r.product_id), n(r.qty), n(r.pp_qty), r.rate == null ? null : n(r.rate)]
      })
      // A database whose stock_counts lacks the unique key this relies on would
      // otherwise fail the whole save; the opening itself is already stored.
      .catch((e) => console.error('[stock] opening-day count seed failed:', (e as Error).message))
  }
}
