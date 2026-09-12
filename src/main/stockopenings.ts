import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId, companiesOfFactory, factoryOfCompanies } from './company'
import { getBooksFrom } from './openings'
import { stockLevels } from './stock'
import { getCurrentUser } from './currentUser'
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
// The day this SITE's books opened. Opening stock is the oil standing in the
// tank that morning, and the tank is not divided between the companies that
// trade through it — one buys, another manufactures, one set of tanks.
export async function stockOpeningDate(companyId?: number): Promise<string> {
  const cid = n(companyId) || getActiveCompanyId()
  const fid0 = await factoryOfCompanies([cid])
  if (fid0) {
    const fr = await getClient().execute({
      sql: 'SELECT as_of FROM stock_openings WHERE factory_id = ? ORDER BY as_of LIMIT 1',
      args: [fid0]
    })
    const d0 = fr.rows[0] ? (fr.rows[0] as unknown as Row).as_of : null
    if (d0) return String(d0).slice(0, 10)
  }
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
  // One sheet per factory. Read by site, and the book-stock column beside it
  // is read the same way, or the sheet would compare the site's opening with
  // one company's movements.
  const fid = await factoryOfCompanies([cid])
  const scope = fid ? await companiesOfFactory(fid) : [cid]
  const ppKey = fid ? `f${fid}` : `c${cid}`
  const [saved, levels, rates, dupes, ppStages, ppLines] = await Promise.all([
    c.execute(
      fid
        ? {
            sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                         COALESCE(adj_qty, 0) AS adj_qty, rate, as_of, note
                  FROM stock_openings WHERE factory_id = ?`,
            args: [fid]
          }
        : {
            sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                         COALESCE(adj_qty, 0) AS adj_qty, rate, as_of, note
                  FROM stock_openings WHERE company_id = ?`,
            args: [cid]
          }
    ),
    stockLevels(asOf ? { from: asOf } : undefined, scope),
    productValuationRates().catch(() => new Map<number, number>()),
    duplicateProductNames(),
    // The site's stage list and every stored breakdown line. Both tolerate a
    // database that has not run the migration yet — an empty list simply means
    // the sheet shows PP as the single figure it has always been.
    listPpStages(cid).catch(() => [] as Row[]),
    ppLinesByProduct(ppKey).catch(() => new Map<number, Row[]>())
  ])

  const savedBy = new Map<number, Row>()
  for (const r of toPlain(saved)) savedBy.set(n(r.product_id), r)

  const rows = (levels as Row[]).map((p) => {
    const id = n(p.id)
    const s = savedBy.get(id)
    const entered = s ? n(s.qty) : null
    // WHAT WAS COUNTED THAT MORNING, not what is standing in the vessels now.
    //
    // This used to prefer the live vessel sum, which was right while the
    // vessels were only a breakdown of the counted figure and nothing drew on
    // them. Production now does: finishing 35 out of a vessel leaves 18, and
    // the sheet then showed the opening as 18 — an opening that shrank weeks
    // after the morning it records, taking the register down with it.
    //
    // The stored figure wins wherever an opening has been struck. The vessel
    // sum remains the fallback for a product whose opening never was, which is
    // what lets a breakdown typed against it show a total and be saved.
    const lines = ppLines.get(id) || []
    const ppSum = lines.length ? r3(lines.reduce((t, l) => t + n(l.qty), 0)) : null
    const stored = s && s.pp_qty != null ? n(s.pp_qty) : null
    const pp = stored != null ? stored : ppSum
    // Signed: a correction that takes stock OFF the count is the ordinary case.
    const adj = s ? n(s.adj_qty) : null
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
    const closing = r3(fromMovement + n(entered) + n(pp) + n(adj))
    return {
      id,
      code: p.code,
      name: p.name,
      category: p.category,
      material_type: p.material_type,
      active: p.active,
      // What is saved against this product today (null = never entered).
      // Counted in three parts, the way the plant counts it: what is in the
      // tank, what is already in process, and the correction between the dip
      // and the card. The register opens at the total of all three.
      qty: entered,
      pp_qty: pp,
      adj_qty: adj,
      // What that PP is made of, where somebody has said. An empty list means
      // PP is a single figure typed straight in, which is what every opening
      // struck before this feature existed is.
      pp_lines: lines,
      total:
        entered == null && pp == null && adj == null ? null : r3(n(entered) + n(pp) + n(adj)),
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

  // Valued on the whole opening — tank, in-process and the correction.
  const totalValue = rows.reduce(
    (t, r) => t + (n(r.qty) + n(r.pp_qty) + n(r.adj_qty)) * n(r.rate),
    0
  )
  // The site this sheet belongs to, read off the payload by the screen so the
  // name shown is the one the save will actually write against.
  const facName = fid
    ? String(
        (
          await c
            .execute({ sql: 'SELECT name FROM factories WHERE id = ?', args: [fid] })
            .catch(() => null)
        )?.rows?.[0]?.name || ''
      )
    : ''
  return {
    company_id: cid,
    factory_id: fid || null,
    factory_name: facName || null,
    as_of: asOf,
    books_from: (await getBooksFrom(cid)) || null,
    rows,
    entered_count: rows.filter((r) => r.qty != null || r.pp_qty != null || r.adj_qty != null).length,
    total_raw: r3(rows.reduce((t, r) => t + n(r.qty), 0)),
    total_pp: r3(rows.reduce((t, r) => t + n(r.pp_qty), 0)),
    total_adj: r3(rows.reduce((t, r) => t + n(r.adj_qty), 0)),
    total_qty: r3(rows.reduce((t, r) => t + n(r.qty) + n(r.pp_qty) + n(r.adj_qty), 0)),
    negative_count: rows.filter((r) => n(r.movement_closing) < -0.0005).length,
    still_negative: rows.filter((r) => n(r.closing) < -0.0005).length,
    total_value: r2(totalValue),
    // Two products may legitimately share a name — RPO exists as both a raw
    // oil and a finished one — so this is a warning to label them, never a
    // prompt to merge them. Merging would collapse the two into one line and
    // lose the distinction between what is bought and what is made.
    name_clashes: dupes,
    // What this page loaded, handed back on save so a stale sheet cannot
    // overwrite figures it never saw. See openingsVersion.
    version: await openingsVersion(cid),
    // The vessels this site breaks its in-process oil down into — one list for
    // the whole sheet, because one refinery has one set of them.
    pp_stages: ppStages
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
/**
 * A fingerprint of the openings this sheet is editing.
 *
 * The sheet posts what is ON THE PAGE and replaces what it finds — every
 * quantity, and every vessel line, wholesale. That is fine while one person is
 * on it; it is a quiet data loss the moment the page is stale, because the
 * save takes an old screen at its word and deletes anything the screen no
 * longer knows about. A vessel holding 35 MT has been lost to this twice.
 *
 * So the page carries a fingerprint of what it loaded and hands it back. If
 * the stored figures have moved since, the save is refused and the reader is
 * told to reload rather than silently winning.
 *
 * Deliberately cheap: the row counts and the latest stamp on each side. Two
 * saves inside the same second by different people would slip through — a
 * risk worth the simplicity here, where the realistic case is a page left open
 * for an hour.
 */
export async function openingsVersion(companyId?: number): Promise<string> {
  const cid = n(companyId) || getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  const scope = fid ? `f${fid}` : `c${cid}`
  const c = getClient()
  const [o, pp] = await Promise.all([
    c.execute({
      sql: fid
        ? 'SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM stock_openings WHERE factory_id = ?'
        : 'SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM stock_openings WHERE company_id = ?',
      args: [fid || cid]
    }),
    c.execute({
      sql: 'SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM stock_opening_pp WHERE scope = ?',
      args: [scope]
    })
  ])
  const a = toPlain(o)[0] || {}
  const b = toPlain(pp)[0] || {}
  return `${n(a.n)}:${String(a.t || '')}|${n(b.n)}:${String(b.t || '')}`
}

/** Refuse a save built on a page that has since been overtaken. */
async function assertOpeningsUnchanged(seen: unknown, companyId?: number): Promise<void> {
  const token = String(seen || '').trim()
  // No token at all means an older client, or a caller with nothing to
  // compare. Those keep working exactly as before rather than being locked
  // out by a guard they never sent for.
  if (!token) return
  const now = await openingsVersion(companyId)
  if (token === now) return
  throw new Error(
    'This opening sheet was changed somewhere else while you had it open. Reload the page before saving — saving now would overwrite those changes.'
  )
}

export async function saveStockOpenings(
  rows: Row[],
  asOf: string,
  companyId?: number,
  seenVersion?: string
): Promise<{ saved: number; cleared: number }> {
  const cid = n(companyId) || getActiveCompanyId()
  await assertOpeningsUnchanged(seenVersion, cid)
  const date = String(asOf || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the date this opening is struck on')
  const c = getClient()
  // The sheet belongs to the SITE, so a product has one opening row per
  // factory however many companies trade through it. company_id is still
  // stamped, as a record of who struck it.
  const fid = await factoryOfCompanies([cid])
  // Matched by hand rather than with ON CONFLICT: the table's unique key is
  // still (company_id, product_id) from before factories existed, and adding a
  // second one would mean merging any rows that collide — a delete, on opening
  // stock, to satisfy a constraint. Not worth it. An UPDATE that affects
  // nothing tells us to INSERT just as well.
  const keyed = (extra: string): { sql: string; args: (string | number | null)[] } =>
    fid
      ? { sql: `factory_id = ?${extra}`, args: [fid] }
      : { sql: `company_id = ?${extra}`, args: [cid] }

  // Where a product's PP has been broken down by stage, the breakdown is the
  // figure — not whatever this payload happens to carry. Without this a save
  // from the phone, whose draft never saw the stage detail, would flatten a
  // seven-vessel count back to the total it was last shown, and a stale tab
  // would flatten it to an older one.
  const ppFromLines = await ppTotalsByProduct(cid).catch(() => new Map<number, number>())

  let saved = 0
  let cleared = 0
  for (const raw of Array.isArray(rows) ? rows : []) {
    const pid = n(raw?.product_id ?? raw?.id)
    if (!pid) continue
    // Blank means EVERY part blank. A tank counted at nothing with work in
    // process, or an adjustment on its own, is still a real answer — so one
    // figure alone keeps the row.
    const rawBlank = raw?.qty === '' || raw?.qty == null
    const broken = ppFromLines.get(pid)
    // A breakdown IS an answer about PP, so a row carrying one is never blank
    // — otherwise clearing the tank figure would delete the opening and take
    // the stage detail's total with it.
    const ppBlank = broken == null && (raw?.pp_qty === '' || raw?.pp_qty == null)
    const adjBlank = raw?.adj_qty === '' || raw?.adj_qty == null
    const blank = rawBlank && ppBlank && adjBlank
    if (blank) {
      const k = keyed(' AND product_id = ?')
      const res = await c.execute({
        sql: `DELETE FROM stock_openings WHERE ${k.sql}`,
        args: [...k.args, pid]
      })
      if (Number(res.rowsAffected) > 0) cleared++
      continue
    }
    const qty = n(raw.qty)
    const pp = broken == null ? n(raw.pp_qty) : broken
    const adj = n(raw.adj_qty)
    const rate = raw?.rate === '' || raw?.rate == null ? null : n(raw.rate)
    const note = raw?.note ? String(raw.note).trim() : null
    // Update the site's row for this product if there is one, otherwise write
    // it. Two statements rather than an upsert, because the only unique key on
    // this table is the pre-factory one.
    const k = keyed(' AND product_id = ?')
    const upd = await c.execute({
      sql: `UPDATE stock_openings
               SET factory_id = COALESCE(factory_id, (SELECT factory_id FROM companies WHERE id = ?)),
                   as_of = ?, qty = ?, pp_qty = ?, adj_qty = ?, rate = ?, note = ?,
                   updated_at = datetime('now')
             WHERE ${k.sql}`,
      args: [cid, date, qty, pp, adj, rate, note, ...k.args, pid]
    })
    if (!Number(upd.rowsAffected)) {
      await c.execute({
        sql: `INSERT INTO stock_openings (company_id, factory_id, product_id, as_of, qty, pp_qty, adj_qty, rate, note, updated_at)
              VALUES (?, (SELECT factory_id FROM companies WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [cid, cid, pid, date, qty, pp, adj, rate, note]
      })
    }
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
  // Read by SITE — the opening it mirrors belongs to the factory now, and a
  // company that did not happen to strike the row would otherwise mirror
  // nothing and leave day one reading as a variance.
  const fid = await factoryOfCompanies([companyId])
  const rows = toPlain(
    await c.execute(
      fid
        ? {
            sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                         COALESCE(adj_qty, 0) AS adj_qty, rate
                  FROM stock_openings WHERE factory_id = ? AND as_of = ?`,
            args: [fid, date]
          }
        : {
            sql: `SELECT product_id, qty, COALESCE(pp_qty, 0) AS pp_qty,
                         COALESCE(adj_qty, 0) AS adj_qty, rate
                  FROM stock_openings WHERE company_id = ? AND as_of = ?`,
            args: [companyId, date]
          }
    )
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
        // The correction rides on the tank figure here rather than getting a
        // column of its own: what this sheet has to say is what was PHYSICALLY
        // there, and the corrected tank figure is that. Splitting it out again
        // would only invite a second reconciliation of a number already
        // reconciled.
        args: [
          companyId,
          date,
          n(r.product_id),
          r3(n(r.qty) + n(r.adj_qty)),
          n(r.pp_qty),
          r.rate == null ? null : n(r.rate)
        ]
      })
      // A database whose stock_counts lacks the unique key this relies on would
      // otherwise fail the whole save; the opening itself is already stored.
      .catch((e) => console.error('[stock] opening-day count seed failed:', (e as Error).message))
  }
}

// ---------------------------------------------------------------------------
// What the PP figure is made of.
// ---------------------------------------------------------------------------
// PP on the opening sheet is one number, and on the plant's own count sheet it
// never is: it is six or seven vessels added up — 6 in the bleacher, 2.5 in the
// deo feed tanks, 32 in the deo scrubber, and so on to a total of 53. Storing
// only the total threw away the only part of the count anybody could check
// later, which is why the breakdown lives here.
//
// THE STAGE LIST BELONGS TO THE SITE, NOT THE ROW. A refinery has one set of
// vessels, so a stage typed while counting one oil is offered against every
// other oil on the sheet. That is the whole point of keeping the stages in a
// table of their own rather than as free text per row.

// Which list this company reads. By site where the site is known, because the
// opening sheet itself is read that way — one set of tanks, however many
// companies trade through it — and by company only where it is not.
export async function ppScope(companyId?: number): Promise<string> {
  const cid = n(companyId) || getActiveCompanyId()
  const fid = await factoryOfCompanies([cid])
  return fid ? `f${fid}` : `c${cid}`
}

// The stages this site offers. Retired ones (crossed off while some row still
// had a quantity against them) are deliberately included, flagged, because a
// row that carries one has to be able to show its name.
export async function listPpStages(companyId?: number): Promise<Row[]> {
  const scope = await ppScope(companyId)
  const res = await getClient().execute({
    sql: `SELECT id, name, sort_order, active FROM stock_pp_stages
           WHERE scope = ? ORDER BY sort_order, id`,
    args: [scope]
  })
  return toPlain(res).map((r) => ({
    id: n(r.id),
    name: String(r.name),
    sort_order: n(r.sort_order),
    active: n(r.active) === 1
  }))
}

// Every stored line for the site, keyed by product. Read in one go rather than
// per row: the sheet is forty products long and forty round trips to fill in a
// column most of them leave blank is not a trade worth making.
async function ppLinesByProduct(scope: string): Promise<Map<number, Row[]>> {
  const res = await getClient().execute({
    sql: `SELECT l.product_id, l.stage_id, l.qty, l.ffa, s.name, s.sort_order, s.active
            FROM stock_opening_pp l
            JOIN stock_pp_stages s ON s.id = l.stage_id
           WHERE l.scope = ?
           ORDER BY s.sort_order, s.id`,
    args: [scope]
  })
  const by = new Map<number, Row[]>()
  for (const r of toPlain(res)) {
    const pid = n(r.product_id)
    if (!by.has(pid)) by.set(pid, [])
    by.get(pid)!.push({
      stage_id: n(r.stage_id),
      name: String(r.name),
      qty: r3(n(r.qty)),
      // Never coerced to a side. A line counted but not yet classified is a
      // third answer and the screen says so.
      ffa: r.ffa === 'with' || r.ffa === 'without' ? String(r.ffa) : null,
      active: n(r.active) === 1
    })
  }
  return by
}

// Add a stage to the site's list, or bring one back that was crossed off.
//
// Matched case-insensitively on the name: "Post Bleacher" typed again as "POST
// BLEACHER" is the same vessel, and two spellings of it in the list would be
// two columns of the same thing on every future count.
export async function addPpStage(name: string, companyId?: number): Promise<Row> {
  const label = String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!label) throw new Error('Name the stage')
  if (label.length > 60) throw new Error('Keep the stage name under 60 characters')
  const scope = await ppScope(companyId)
  const c = getClient()
  const found = await c.execute({
    sql: 'SELECT id, name, active FROM stock_pp_stages WHERE scope = ? AND UPPER(name) = UPPER(?)',
    args: [scope, label]
  })
  if (found.rows.length) {
    const row = toPlain(found)[0]
    // Reviving a retired stage rather than refusing: the rows that kept a
    // quantity against it already show it, and asking for it again plainly
    // means wanting it offered to the rest.
    if (n(row.active) !== 1) {
      await c.execute({ sql: 'UPDATE stock_pp_stages SET active = 1 WHERE id = ?', args: [n(row.id)] })
    }
    return { id: n(row.id), name: String(row.name), active: true, revived: n(row.active) !== 1 }
  }
  const next = await c.execute({
    sql: 'SELECT COALESCE(MAX(sort_order), 0) + 10 AS o FROM stock_pp_stages WHERE scope = ?',
    args: [scope]
  })
  const order = n((next.rows[0] as unknown as Row)?.o) || 10
  const ins = await c.execute({
    sql: 'INSERT INTO stock_pp_stages (scope, name, sort_order) VALUES (?, ?, ?)',
    args: [scope, label, order]
  })
  return { id: Number(ins.lastInsertRowid), name: label, active: true, revived: false }
}

// Cross a stage off — without losing a count.
//
// The rule asked for, and the only safe one: a stage is deleted outright ONLY
// where nothing has a quantity against it. Where something does, those lines
// are kept and the stage is retired instead — it stops being offered to the
// rows that left it blank, and stays on the rows that used it. So pressing the
// cross can never silently take 32 MT off an opening.
export async function removePpStage(
  stageId: number,
  companyId?: number
): Promise<{ removed: number; kept: number; retired: boolean; name: string }> {
  const id = n(stageId)
  if (!id) throw new Error('Which stage?')
  const scope = await ppScope(companyId)
  const c = getClient()
  const st = await c.execute({
    sql: 'SELECT name FROM stock_pp_stages WHERE id = ? AND scope = ?',
    args: [id, scope]
  })
  if (!st.rows.length) throw new Error('That stage is not on this site’s list')
  const name = String((st.rows[0] as unknown as Row).name || '')

  // Blank lines first. A stored line of nil is not a count, it is a leftover,
  // and clearing them is what lets a stage used nowhere go away completely.
  const del = await c.execute({
    sql: 'DELETE FROM stock_opening_pp WHERE scope = ? AND stage_id = ? AND ABS(COALESCE(qty, 0)) < 0.0005',
    args: [scope, id]
  })
  const kept = await c.execute({
    sql: 'SELECT COUNT(*) AS k FROM stock_opening_pp WHERE scope = ? AND stage_id = ?',
    args: [scope, id]
  })
  const keptCount = n((kept.rows[0] as unknown as Row)?.k)
  if (keptCount > 0) {
    await c.execute({ sql: 'UPDATE stock_pp_stages SET active = 0 WHERE id = ?', args: [id] })
    return { removed: Number(del.rowsAffected) || 0, kept: keptCount, retired: true, name }
  }
  await c.execute({ sql: 'DELETE FROM stock_pp_stages WHERE id = ? AND scope = ?', args: [id, scope] })
  return { removed: Number(del.rowsAffected) || 0, kept: 0, retired: false, name }
}

// One product's breakdown, replaced whole.
//
// Saved on its own rather than riding on the sheet's Save, for two reasons: the
// stage list it edits is shared and changes immediately, and the cross's rule
// has to be able to ask what actually has a quantity — a draft nobody has
// saved cannot answer that.
//
// stock_openings.pp_qty is rewritten from the lines here, so the register can
// never read a PP the breakdown does not add up to.
export async function savePpLines(
  productId: number,
  lines: Row[],
  companyId?: number,
  seenVersion?: string
): Promise<{ total: number; lines: number }> {
  const pid = n(productId)
  if (!pid) throw new Error('Which product?')
  await assertOpeningsUnchanged(seenVersion, companyId)
  const cid = n(companyId) || getActiveCompanyId()
  const scope = await ppScope(cid)
  const c = getClient()

  // A line arrives with a stage id, a stage NAME, or both. The screen now adds
  // vessels by typing, so the name is the common case: it is resolved against
  // the site's list and added to it when it is new, which is what keeps the
  // same tank from being spelled three ways across thirty products.
  const raw = (Array.isArray(lines) ? lines : []).map((l) => ({
    stage_id: n(l?.stage_id),
    stage: String(l?.stage ?? l?.name ?? '').trim(),
    qty: l?.qty === '' || l?.qty == null ? 0 : n(l.qty),
    ffa: l?.ffa === 'with' || l?.ffa === 'without' ? String(l.ffa) : null
  }))
  for (const l of raw) {
    if (l.stage_id > 0 || !l.stage) continue
    // addPpStage matches case-insensitively and revives a retired name, so
    // this neither duplicates nor resurrects a typo as a second vessel.
    l.stage_id = n((await addPpStage(l.stage, cid)).id)
  }

  // A line with no quantity is not stored. Blank and nil are the same
  // statement about a vessel — nothing in it — so a row somebody added and
  // left empty is not a count and does not become one.
  const keep = raw.filter((l) => l.stage_id > 0 && Math.abs(l.qty) > 0.0005)

  await c.execute({
    sql: 'DELETE FROM stock_opening_pp WHERE scope = ? AND product_id = ?',
    args: [scope, pid]
  })
  for (const l of keep) {
    await c.execute({
      sql: `INSERT INTO stock_opening_pp (scope, product_id, stage_id, qty, ffa, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      args: [scope, pid, l.stage_id, r3(l.qty), l.ffa]
    })
  }
  const total = r3(keep.reduce((t, l) => t + l.qty, 0))
  await writePpTotal(cid, scope, pid, keep.length ? total : null)
  return { total, lines: keep.length }
}

// Push a breakdown's total onto the opening row, if there is one.
//
// Deliberately does NOT create an opening row that does not exist yet: a
// breakdown typed against a product whose opening has never been struck is
// picked up by the sheet's own Save, which knows the date and the rate. All
// this has to do is keep an existing row honest.
async function writePpTotal(
  companyId: number,
  scope: string,
  productId: number,
  total: number | null
): Promise<void> {
  const c = getClient()
  const fid = scope.startsWith('f') ? Number(scope.slice(1)) : 0
  const where = fid ? 'factory_id = ?' : 'company_id = ?'
  const arg = fid || companyId
  await c
    .execute({
      sql: `UPDATE stock_openings SET pp_qty = ?, updated_at = datetime('now')
             WHERE ${where} AND product_id = ?`,
      args: [total == null ? 0 : total, arg, productId]
    })
    .catch((e) => console.error('[stock] PP total write failed:', (e as Error).message))
}

// The PP totals the breakdowns add up to, by product. Used by the sheet's save
// so a submitted PP can never overwrite a breakdown — including a save that
// came from the phone, whose own draft never saw the stage detail.
export async function ppTotalsByProduct(companyId?: number): Promise<Map<number, number>> {
  const scope = await ppScope(companyId)
  const res = await getClient().execute({
    sql: `SELECT product_id, SUM(qty) AS t FROM stock_opening_pp
           WHERE scope = ? GROUP BY product_id`,
    args: [scope]
  })
  const m = new Map<number, number>()
  for (const r of toPlain(res)) m.set(n(r.product_id), r3(n(r.t)))
  return m
}

// -------------------------------------------------------- PP × production --
// A batch drawing on PP takes it off specific vessels, oldest first — the
// vessel that has sat longest empties before a fresher one is touched. Stage
// age is the stage's own `created_at` (when that vessel was first added to
// the site's list), not when it was last counted, because two vessels last
// re-counted the same morning still have a real order between them.

async function ppProductTotal(scope: string, productId: number): Promise<number> {
  const res = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS t FROM stock_opening_pp WHERE scope = ? AND product_id = ?',
    args: [scope, n(productId)]
  })
  return r3(n(toPlain(res)[0]?.t))
}

// Vessels holding a given FFA class for one product, oldest first, zero
// balances left out — exactly the order and the set production draws from.
async function ppVessels(
  scope: string,
  productId: number,
  ffa: 'with' | 'without'
): Promise<{ stage_id: number; qty: number }[]> {
  // WHAT IS LEFT, worked out rather than stored.
  //
  // stock_opening_pp is the COUNTED opening — what each vessel held that
  // morning — and production must not edit it. It used to: a draw decremented
  // the row, so consuming 35 turned a counted 53 into a stored 18, and the
  // opening shrank weeks after the morning it records. The counted figure
  // stays put and what is available is it, less what has been drawn against
  // it. Reversing a run deletes its draw rows and the balance comes back on
  // its own.
  const res = await getClient().execute({
    sql: `SELECT sop.stage_id,
                 sop.qty - COALESCE((SELECT SUM(d.qty) FROM pp_draws d
                                      WHERE d.scope = sop.scope
                                        AND d.product_id = sop.product_id
                                        AND d.stage_id = sop.stage_id), 0) AS qty
            FROM stock_opening_pp sop
            JOIN stock_pp_stages st ON st.id = sop.stage_id
           WHERE sop.scope = ? AND sop.product_id = ? AND sop.ffa = ?
           ORDER BY st.created_at, st.id`,
    args: [scope, n(productId), ffa]
  })
  return toPlain(res)
    .map((r) => ({ stage_id: n(r.stage_id), qty: r3(n(r.qty)) }))
    .filter((v) => v.qty > 0.0005)
}

// Total Without-FFA PP standing for one product — what a batch may draw
// one-for-one before anything starts paying the recipe's FFA loss.
export async function ppFreeTotal(productId: number, companyId?: number): Promise<number> {
  const scope = await ppScope(companyId)
  const vessels = await ppVessels(scope, productId, 'without')
  return r3(vessels.reduce((t, v) => t + v.qty, 0))
}

// Every auto-calculated input's Without-FFA PP total, in the shape
// expandRecipeWithPp wants — one lookup for a whole batch instead of one per
// input.
export async function ppFreeByProduct(
  productIds: number[],
  companyId?: number
): Promise<Record<number, number>> {
  const scope = await ppScope(companyId)
  const out: Record<number, number> = {}
  for (const pid of new Set(productIds.filter((x) => n(x) > 0))) {
    const vessels = await ppVessels(scope, pid, 'without')
    out[pid] = r3(vessels.reduce((t, v) => t + v.qty, 0))
  }
  return out
}

// Both PP buckets, per product — what the Production entry sheet's preview
// needs to show a batch's draw split before it is saved, same figures
// createProduction/updateProduction would actually draw against.
export async function ppTotalsBothByProduct(
  productIds: number[],
  companyId?: number
): Promise<Record<number, { without: number; with: number }>> {
  const scope = await ppScope(companyId)
  const out: Record<number, { without: number; with: number }> = {}
  for (const pid of new Set(productIds.filter((x) => n(x) > 0))) {
    const [without, withFfa] = await Promise.all([ppVessels(scope, pid, 'without'), ppVessels(scope, pid, 'with')])
    out[pid] = {
      without: r3(without.reduce((t, v) => t + v.qty, 0)),
      with: r3(withFfa.reduce((t, v) => t + v.qty, 0))
    }
  }
  return out
}

// One production run's own PP draws — what the entry sheet needs to give
// back to the pool it is previewing against when that run is being edited,
// the same way it already gives back the run's own Raw consumption.
/**
 * Every vessel standing for one product, with what is in it — the list the
 * write-off screen offers. Empty vessels are left out: there is nothing to
 * write off in them.
 */
export async function ppVesselBalances(productId: number, companyId?: number): Promise<Row[]> {
  const scope = await ppScope(companyId)
  // WHAT IS LEFT, not what was counted. A vessel that has already fed a batch
  // holds less than the morning's figure, and this list is what a write-off or
  // a move is capped by — offering the count would let either act on oil that
  // has already gone through the plant. `counted` comes along for the screen,
  // which still wants to say what the morning found.
  const res = await getClient().execute({
    sql: `SELECT sop.stage_id, st.name AS vessel, sop.ffa,
                 sop.qty AS counted,
                 sop.qty - COALESCE((SELECT SUM(d.qty) FROM pp_draws d
                                      WHERE d.scope = sop.scope AND d.product_id = sop.product_id
                                        AND d.stage_id = sop.stage_id), 0) AS qty
            FROM stock_opening_pp sop
            JOIN stock_pp_stages st ON st.id = sop.stage_id
           WHERE sop.scope = ? AND sop.product_id = ?
           ORDER BY st.created_at, st.id`,
    args: [scope, n(productId)]
  })
  return toPlain(res)
    .map((r) => ({ ...r, qty: r3(n(r.qty)), counted: r3(n(r.counted)) }))
    .filter((r) => n(r.qty) > 0.0005)
}

/**
 * Every vessel at this site that could RECEIVE a heel, for one oil.
 *
 * Unlike the list above this keeps the empty ones — an empty vessel is the
 * commonest destination — and says what each already holds so a mismatched
 * FFA class can be seen before it is picked rather than refused after.
 */
export async function ppVesselsForReceiving(productId: number, companyId?: number): Promise<Row[]> {
  const scope = await ppScope(companyId)
  const res = await getClient().execute({
    sql: `SELECT st.id AS stage_id, st.name AS vessel,
                 COALESCE(sop.qty, 0) AS qty, sop.ffa
            FROM stock_pp_stages st
            LEFT JOIN stock_opening_pp sop
                   ON sop.stage_id = st.id AND sop.scope = ? AND sop.product_id = ?
           WHERE st.scope = ? AND st.active = 1
           ORDER BY st.created_at, st.id`,
    args: [scope, n(productId), scope]
  })
  return toPlain(res).map((r) => ({ ...r, qty: r3(n(r.qty)) }))
}

/**
 * Take a heel out of a vessel for good.
 *
 * TWO balances move, because PP is counted twice over by design: the vessel
 * row says WHERE the oil is, and the opening's pp_qty says it is part of the
 * product's stock. A write-off has to come off both, or the vessel empties
 * while the register still carries the oil — which is the same double-count
 * the production pair exists to avoid, in the other direction.
 *
 * DEAD LOSS is not stocked: the recipe's own dead loss is a 'loss' line and
 * the register deliberately counts neither consumption nor production for it
 * (see stock.ts). So this reduces PP and keeps the reason; it does not invent
 * a pile of dead loss somewhere else.
 */
export async function writeOffPp(
  productId: number,
  stageId: number,
  qty: number,
  note: string,
  companyId?: number
): Promise<{ product_id: number; stage_id: number; qty: number }> {
  const want = r3(qty)
  if (!(want > 0.0005)) throw new Error('Enter a quantity to write off')
  const reason = String(note || '').trim()
  if (!reason) throw new Error('Say why this oil is being written off')
  const cid = n(companyId) || getActiveCompanyId()
  const scope = await ppScope(cid)
  const c = getClient()
  const cur = await c.execute({
    sql: 'SELECT qty, ffa FROM stock_opening_pp WHERE scope = ? AND product_id = ? AND stage_id = ?',
    args: [scope, n(productId), n(stageId)]
  })
  const have = r3(n(cur.rows[0]?.qty))
  if (!cur.rows.length || have <= 0.0005) throw new Error('That vessel is already empty')
  if (want > have + 0.0005) {
    throw new Error(`Only ${have} is standing in that vessel — cannot write off ${want}`)
  }
  await c.execute({
    sql: `UPDATE stock_opening_pp SET qty = qty - ?, updated_at = datetime('now')
           WHERE scope = ? AND product_id = ? AND stage_id = ?`,
    args: [want, scope, n(productId), n(stageId)]
  })
  // The other half: the product's own opening carries this oil as pp_qty, so
  // it leaves there too and the register falls by exactly what was written off.
  await c.execute({
    sql: `UPDATE stock_openings SET pp_qty = MAX(0, COALESCE(pp_qty, 0) - ?), updated_at = datetime('now')
           WHERE product_id = ? AND company_id IN (SELECT id FROM companies WHERE id = ?)`,
    args: [want, n(productId), cid]
  })
  const u = getCurrentUser()
  await c.execute({
    sql: `INSERT INTO pp_writeoffs (scope, product_id, stage_id, qty, ffa, note, written_by, written_by_name, company_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [scope, n(productId), n(stageId), want, String(cur.rows[0]?.ffa || ''), reason, u.id, u.username, cid]
  })
  return { product_id: n(productId), stage_id: n(stageId), qty: want }
}

/**
 * Move a heel out of one oil's vessel and into another oil's.
 *
 * Not everything left in a tank is dead. A shea heel that will never finish as
 * RPO is often perfectly good feedstock for something else, and the only way to
 * say so was to write it off here and re-count it there — two corrections, on
 * two different days, with nothing joining them.
 *
 * It is a transfer, so it is exactly symmetric: the oil leaves one product's PP
 * and arrives in another's, both vessel rows and both openings move by the same
 * figure, and the site's total PP is unchanged. Nothing is produced, no recipe
 * runs, and the oil keeps whatever FFA state it had — moving a tank does not
 * refine what is in it.
 *
 * The destination vessel must be empty or already hold the same FFA class. A
 * vessel row carries ONE ffa flag (see the UNIQUE key), so tipping with-FFA oil
 * into a without-FFA vessel would silently relabel what was already standing
 * there — the one outcome this must not have.
 */
export async function movePp(
  productId: number,
  stageId: number,
  qty: number,
  toProductId: number,
  toStageId: number,
  note: string,
  companyId?: number
): Promise<{ product_id: number; to_product_id: number; qty: number }> {
  const want = r3(qty)
  const from = n(productId)
  const to = n(toProductId)
  const fromStage = n(stageId)
  const toStage = n(toStageId)
  if (!(want > 0.0005)) throw new Error('Enter a quantity to move')
  if (!from || !fromStage) throw new Error('Pick the vessel the oil is coming out of')
  if (!to || !toStage) throw new Error('Pick the oil and the vessel it is going into')
  if (from === to && fromStage === toStage) throw new Error('That is the same vessel — nothing to move')

  const cid = n(companyId) || getActiveCompanyId()
  const scope = await ppScope(cid)
  const c = getClient()

  // WHAT IS ACTUALLY THERE, not what was counted. A vessel that has already
  // fed a batch holds less than the morning's figure, and moving against the
  // count would move oil that has been used.
  const src = await c.execute({
    sql: `SELECT sop.ffa,
                 sop.qty AS counted,
                 sop.qty - COALESCE((SELECT SUM(d.qty) FROM pp_draws d
                                      WHERE d.scope = sop.scope AND d.product_id = sop.product_id
                                        AND d.stage_id = sop.stage_id), 0) AS avail
            FROM stock_opening_pp sop
           WHERE sop.scope = ? AND sop.product_id = ? AND sop.stage_id = ?`,
    args: [scope, from, fromStage]
  })
  if (!src.rows.length) throw new Error('There is nothing standing in that vessel')
  const ffa = String(toPlain(src)[0].ffa || '')
  const avail = r3(n(toPlain(src)[0].avail))
  if (avail <= 0.0005) throw new Error('That vessel is already empty')
  if (want > avail + 0.0005) {
    throw new Error(`Only ${avail} is left in that vessel — cannot move ${want}`)
  }

  const dst = await c.execute({
    sql: 'SELECT qty, ffa FROM stock_opening_pp WHERE scope = ? AND product_id = ? AND stage_id = ?',
    args: [scope, to, toStage]
  })
  if (dst.rows.length) {
    const dq = r3(n(dst.rows[0].qty))
    const dffa = String(dst.rows[0].ffa || '')
    if (dq > 0.0005 && dffa !== ffa) {
      throw new Error(
        `That vessel already holds oil counted ${dffa === 'with' ? 'WITH' : dffa === 'without' ? 'W/O' : 'un-classified for'} FFA, and this heel is ${ffa === 'with' ? 'WITH' : ffa === 'without' ? 'W/O' : 'un-classified for'} FFA. Pick an empty vessel, or one holding the same kind.`
      )
    }
  }

  // Out of one vessel...
  await c.execute({
    sql: `UPDATE stock_opening_pp SET qty = qty - ?, updated_at = datetime('now')
           WHERE scope = ? AND product_id = ? AND stage_id = ?`,
    args: [want, scope, from, fromStage]
  })
  // ...and into the other, creating the row when that vessel has never held
  // this oil before. The arriving oil sets the FFA class only on a row that
  // was empty; one already holding the same class keeps it.
  if (dst.rows.length) {
    await c.execute({
      sql: `UPDATE stock_opening_pp SET qty = qty + ?, ffa = ?, updated_at = datetime('now')
             WHERE scope = ? AND product_id = ? AND stage_id = ?`,
      args: [want, ffa || null, scope, to, toStage]
    })
  } else {
    await c.execute({
      sql: `INSERT INTO stock_opening_pp (scope, product_id, stage_id, qty, ffa, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      args: [scope, to, toStage, want, ffa || null]
    })
  }

  // The other half, on both sides: PP is part of each product's own stock, so
  // the openings move by the same figure or the register carries the oil under
  // the wrong oil's name. Same shape as writeOffPp's, in both directions.
  await c.execute({
    sql: `UPDATE stock_openings SET pp_qty = MAX(0, COALESCE(pp_qty, 0) - ?), updated_at = datetime('now')
           WHERE product_id = ? AND company_id IN (SELECT id FROM companies WHERE id = ?)`,
    args: [want, from, cid]
  })
  await c.execute({
    sql: `UPDATE stock_openings SET pp_qty = COALESCE(pp_qty, 0) + ?, updated_at = datetime('now')
           WHERE product_id = ? AND company_id IN (SELECT id FROM companies WHERE id = ?)`,
    args: [want, to, cid]
  })

  // Logged in the same place a write-off is, because it is the same question
  // answered differently — "where did that heel go?". A row carrying a
  // destination is a move; one without is oil that left for good.
  const u = getCurrentUser()
  await c.execute({
    sql: `INSERT INTO pp_writeoffs (scope, product_id, stage_id, qty, ffa, note,
                                    to_product_id, to_stage_id,
                                    written_by, written_by_name, company_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [scope, from, fromStage, want, ffa, String(note || '').trim(), to, toStage, u.id, u.username, cid]
  })
  return { product_id: from, to_product_id: to, qty: want }
}

/** What has been written off a product's vessels, newest first. */
export async function listPpWriteoffs(productId: number, companyId?: number): Promise<Row[]> {
  const scope = await ppScope(n(companyId) || getActiveCompanyId())
  const res = await getClient().execute({
    sql: `SELECT w.id, w.qty, w.ffa, w.note, w.written_by_name, w.created_at, st.name AS vessel,
                 w.to_product_id, p.name AS to_product, ts.name AS to_vessel
            FROM pp_writeoffs w
            LEFT JOIN stock_pp_stages st ON st.id = w.stage_id
            LEFT JOIN products p ON p.id = w.to_product_id
            LEFT JOIN stock_pp_stages ts ON ts.id = w.to_stage_id
           WHERE w.scope = ? AND w.product_id = ?
           ORDER BY w.id DESC
           LIMIT 100`,
    args: [scope, n(productId)]
  })
  return toPlain(res)
}

export async function ppDrawsForProduction(
  productionId: number
): Promise<{ product_id: number; ffa: string; qty: number }[]> {
  const res = await getClient().execute({
    sql: 'SELECT product_id, ffa, qty FROM pp_draws WHERE production_id = ?',
    args: [n(productionId)]
  })
  return toPlain(res).map((r) => ({ product_id: n(r.product_id), ffa: String(r.ffa || ''), qty: r3(n(r.qty)) }))
}

// Draw `qty` off one product's PP, oldest vessel of the given FFA class
// first, logging exactly what was taken from where in pp_draws so a later
// edit or delete can put it back. Returns what was actually drawn — capped by
// what the vessels held, same as the math that decided how much to ask for.
export async function drawPp(
  productionId: number,
  productId: number,
  ffa: 'with' | 'without',
  qty: number,
  companyId?: number
): Promise<number> {
  let need = r3(qty)
  if (need <= 0.0005 || !n(productId) || !n(productionId)) return 0
  const cid = n(companyId) || getActiveCompanyId()
  const scope = await ppScope(cid)
  const c = getClient()
  const vessels = await ppVessels(scope, productId, ffa)
  let drawn = 0
  for (const v of vessels) {
    if (need <= 0.0005) break
    const take = r3(Math.min(v.qty, need))
    if (take <= 0.0005) continue
    // Only the draw is written. The counted opening line is left exactly as it
    // was struck — see ppVessels for why what is AVAILABLE is derived from it
    // rather than stored.
    await c.execute({
      sql: `INSERT INTO pp_draws (production_id, scope, product_id, stage_id, qty, ffa)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [n(productionId), scope, productId, v.stage_id, take, ffa]
    })
    need -= take
    drawn += take
  }
  // Nothing else is written. A vessel drawn to nothing keeps its counted line
  // — that line is the record of what it held that morning, not a statement
  // about today — and the opening total it feeds stays where it was struck.
  // Deleting the line here is what used to make the PP column fall to 18 the
  // moment 35 was consumed.
  return drawn
}

// Put back everything one production run took off PP, before that run's
// lines are rebuilt (an edit) or removed (a delete) — otherwise a vessel this
// run drew from stays permanently short of what it actually holds, and a
// second edit on the same run would draw again on top of the first.
export async function reversePpDraws(productionId: number): Promise<void> {
  // Deleting the draw rows IS the reversal.
  //
  // It used to add the quantity back onto the vessel row and recreate rows the
  // draw had emptied — necessary while the row held the live balance, and the
  // source of a bug where a recreated row came back unclassified and vanished
  // from both FFA totals. The row now holds the COUNTED opening and was never
  // touched, so removing the draw restores the balance by arithmetic alone.
  await getClient().execute({ sql: 'DELETE FROM pp_draws WHERE production_id = ?', args: [n(productionId)] })
}
