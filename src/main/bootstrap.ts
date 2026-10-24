import { ensurePpTraceSchema } from './ppTrace'
import { ensureTankerInvoices } from './tankerAlloc'
import { getClient, initDb, runDaily, runOnce, startRevisionWatcher, todayISO } from './db'
import { seedDefaultGroups } from './ledgerGroups'
import { splitGstLedgersByRate } from './gstBackfill'
import { backfillJournal } from './journal'
import { ensureBdPostingFields } from './accountingSchema'
import { ensureVoucherNumbers, realignVoucherSeries } from './voucherNumbers'
import { widenRenameRedirects } from './ledgerMap'
import { ensureCompanyParties } from './intercompany'
import { fileLcRepaymentsAsPayments, refreshLcUpfrontInterest, repairLcRepaymentAccount } from './treasury'
import { ensureFacilityLimitLog } from './facilityLimits'
import { dailyBackup } from './backup'
import { migrateBdPerNbfcLedgers, convertOpenAdjToCharge } from './billDiscounting'
import { backfillOrderStatuses, backfillPurchaseRoundOff, repairPurchaseTdsOnTaxable } from './orders'
import {
  backfillSalesGst,
  backfillSalesBargainCustomers,
  backfillSalesRoundOff,
  restateStaleSalesRoundOff,
  backfillExSalesDone, repairSaleUnitsFromProduct } from './sales'
import { seedDefaultAdmin } from './auth'
import { seedProducts, seedFormulations, seedPackagings } from './seed'
import { cleanupLogs } from './access'
import { expandRecipe, recipeTor } from '../renderer/src/lib/recipeMath'
import { applyGateTimeFix } from './gateTimeFix'
import { backfillConsignmentDraws } from './consignment'
import { startNotificationWatcher, pruneNotifications } from './notify'
import { startPushWatcher } from './webpush'
import { previewLcCharges, fixLcCharges, autoFixDuplicateSales } from './accountingRepairs'

// Everything a database needs before the app can serve a single request: the
// schema (initDb), every additive migration recorded by runOnce, and the
// backfills that repair rows written before a rule existed.
//
// Shared between the desktop's app.whenReady() and the web server's startup,
// so a database opened for the very first time — desktop or web — ends up in
// exactly the same shape, and a database opened again picks up only whatever
// changed since. Nothing here is destructive: initDb's schema is
// CREATE-TABLE-IF-NOT-EXISTS throughout, and runOnce records its own marker
// INSIDE the database rather than in any file on disk, so re-running this
// against an already-migrated database — including one seeded from a
// different source, like a Turso copy — costs one lookup per key and changes
// nothing. That is what lets a freshly uploaded SQLite file "recreate" itself
// on first boot and an existing one "migrate" forward on every boot after,
// with no separate code path for either case.
export async function runStartupTasks(): Promise<void> {
  await initDb()
  // One tanker billed on several invoices (tankerAlloc.ts). Idempotent, and on
  // every start so a database restored from an older snapshot has it too.
  await ensureTankerInvoices().catch((e) => console.error('[tankers] tanker_invoices table failed:', e))
  await ensureBdPostingFields()
  // Permanent voucher numbers: the first fill numbers every existing voucher
  // exactly as the ledgers already show it. Additive — a new table only.
  await ensureVoucherNumbers()
  // A ledger rename's redirect covers every company, because the ledger row is
  // shared — see widenRenameRedirects. Redirect rows only; no voucher moves.
  await runOnce('ledger_map_renames_sitewide_v1', async () => {
    const n = await widenRenameRedirects()
    if (n) console.log(`[ledger] ${n} rename redirect(s) now apply to every company`)
  }).catch((e) => console.error('[ledger] widening rename redirects failed:', e))
  // The duplicate sales vouchers (audit F01) are NOT removed here. Deleting
  // postings is a reviewed action, offered in Settings → Accounting checks.
  // ONCE, not on every launch.
  //
  // This posts vouchers for documents created before the journal engine
  // existed. It ran on every single startup, and because it asks "does this
  // document have a voucher?", every start was a fresh chance to re-post
  // anything that momentarily did not — which is how consolidating a
  // multi-line invoice onto one voucher kept being undone: the next start saw
  // the invoice's other lines as unposted and wrote a voucher for each,
  // double-counting the revenue and the debtor. It happened repeatedly,
  // because electron-vite restarts the main process on any file change under
  // src/main.
  //
  // A catch-up job for historical rows only needs to run once, and runOnce
  // records nothing if it throws, so a genuine failure still retries.
  // Before anything reads these tables: a column this build assumes is a
  // fact to check, not an event to record. See ensureRequiredColumns.
  await ensureRequiredColumns().catch((e) => console.error('[schema] column check failed:', e))

  // An LC repayment that debited the wrong account and so never cleared the
  // payable it settled. A fact to check rather than an event to record, for
  // the same reason the columns above are — see repairLcRepaymentAccount.
  await repairLcRepaymentAccount().catch((e) => console.error('[lc] repayment repair failed:', e))

  // Where a facility's limit has been, as against where it is now.
  await ensureFacilityLimitLog().catch((e) => console.error('[limits] log table failed:', e))

  await runOnce('journal_backfill_v1', () => backfillJournal()).catch((e) =>
    console.error('[journal] backfill failed:', e)
  )
  await backfillSalesGst().catch((e) => console.error('[sales] GST backfill failed:', e))
  await backfillSalesRoundOff().catch((e) => console.error('[sales] round-off backfill failed:', e))
  await restateStaleSalesRoundOff().catch((e) => console.error('[sales] round-off restatement failed:', e))
  await backfillExSalesDone().catch((e) => console.error('[sales] ex-done sweep failed:', e))
  // First launch of the day: a full portable dump of the cloud database.
  dailyBackup().catch((e) => console.error('[backup] daily backup failed:', e))
  await backfillSalesBargainCustomers().catch((e) => console.error('[sales] bargain-customer link failed:', e))
  // Re-syncs every order from its tankers. Unlike the other startup tasks it
  // is not self-limiting — it did that work on every single launch, which is
  // most of why starting up was slow. Tanker moves already re-sync their own
  // order, so this only ever needed to run once to catch up old rows.
  await runOnce('order_status_sync_v1', () => backfillOrderStatuses()).catch((e) =>
    console.error('[orders] status backfill failed:', e)
  )
  await backfillPurchaseRoundOff().catch((e) => console.error('[orders] round-off repair failed:', e))

  // Purchases posted while TDS ran on the GST-inclusive total, restated onto
  // the taxable value. Once, and after the round-off repair above so the
  // round off each invoice carries is settled before the TDS is struck on it.
  //
  // This is the only route to the live data there is: the website's database
  // is a file on the host, reachable from nothing but the server itself.
  await runOnce('purchase_tds_taxable_basis_v1', () => repairPurchaseTdsOnTaxable()).catch((e) =>
    console.error('[orders] TDS basis repair failed:', e)
  )

  // Sale lines stamped MT for a product counted in pieces. A label, not a
  // figure: no quantity, rate or ledger entry moves.
  await runOnce('sale_units_from_product_v1', () => repairSaleUnitsFromProduct()).catch((e) =>
    console.error('[sales] unit repair failed:', e)
  )
  await seedDefaultAdmin().catch((e) => console.error('[auth] seed failed:', e))
  await seedProducts().catch((e) => console.error('[seed] products failed:', e))
  await seedFormulations().catch((e) => console.error('[seed] formulations failed:', e))
  await seedPackagings().catch((e) => console.error('[seed] packagings failed:', e))
  await runDaily('cleanup_logs', () => cleanupLogs()).catch(() => {})
  // Notifications, checked on the way up and every quarter of an hour after.
  //
  // Safe to have several machines doing it at once: raising is an insert that
  // ignores a live duplicate, and resolving is idempotent, so two desktops and
  // the server all running this converge on the same answer rather than
  // fighting. Started after the migrations above so the tables exist.
  startNotificationWatcher()
  // And the other half of telling somebody: the banner on their phone. It
  // watches the same table the bell reads, so anything raised anywhere — a
  // rule, a send-back, an approval — reaches a subscribed device without the
  // code that raised it needing to know push exists.
  startPushWatcher()
  await runDaily('notify_retention', async () => { await pruneNotifications() }).catch(() => {})
  // Stock brought forward on the day the books begin.
  //
  // Created here rather than appended to MIGRATIONS because this database is
  // already past the migration-count mark — it records 347 applied, and an
  // appended statement below that mark is skipped in silence. Exactly the trap
  // the note at the end of that list warns about, and exactly what runOnce is
  // for.
  //
  // Book stock is derived entirely from movements, so a mill trading for years
  // whose books start on a date opens every product at nothing, and every gram
  // consumed since reads as stock it never had. Thirteen products in KR FOODS
  // close negative for that reason alone.
  await runOnce('stock_openings_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      product_id INTEGER NOT NULL REFERENCES products(id),
      as_of TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      rate REAL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, product_id)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_stock_openings_co ON stock_openings(company_id)')
  }).catch((e) => console.error('[stock] opening-stock table failed:', e))

  // A BILL LINE THAT CARRIES MONEY AND NO GOODS.
  //
  // A rate settled after the oil has gone, a discount agreed at the end of a
  // month, a short-weight allowance — each is a real figure on a real invoice
  // and none of them moves a kilogram. Billed as an ordinary line they would
  // have to carry a quantity, and any quantity at all is a lie to the stock
  // register: either goods that never left, or a rate divided into a tonnage
  // nobody agreed.
  //
  // So the line says so. It names the product or the SKU it concerns — which
  // is what makes it readable a year later — carries no quantity at all, and
  // is stamped affects_stock = 0, the same flag a trading pass-through uses
  // and which every stock query in the app already respects.
  // A LEDGER CAN BE HIDDEN. Masters → Hide takes a ledger out of the pickers
  // and the chart's list (Show hidden brings it back to unhide); every figure,
  // posting and report stays exactly as it was. A new column, default 0, so no
  // existing row changes.
  await runOnce('ledger_hidden_v1', async () => {
    await getClient()
      .execute('ALTER TABLE ledger_accounts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[ledgers] hidden flag failed:', e))

  await runOnce('sales_rate_adjustment_v1', async () => {
    await getClient()
      .execute('ALTER TABLE sales ADD COLUMN is_rate_adj INTEGER NOT NULL DEFAULT 0')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[sales] rate-adjustment flag failed:', e))

  // AN OPENING CAN BE STRUCK AGAIN, AND THE OLD ONE IS NOT LOST.
  //
  // stock_openings holds one row per product — the opening the register is
  // standing on right now — so re-counting the tanks used to overwrite the
  // last count with no trace that it had ever said anything else. That is
  // fine for a figure typed twice in a minute and wrong for a mill that
  // re-strikes its opening every quarter: the previous count is the evidence
  // behind months of closing balances, and it should still be readable after
  // it stops being the one in force.
  //
  // So the live table stays exactly as it is — every reader of the opening is
  // untouched — and each strike is ALSO written here, in full, as a set. One
  // set per date: saving the same morning again corrects that set rather than
  // piling up a set per keystroke.
  await runOnce('stock_opening_sets_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_opening_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factory_id INTEGER,
      company_id INTEGER NOT NULL,
      as_of TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      created_by INTEGER,
      created_by_name TEXT,
      updated_at TEXT,
      updated_by_name TEXT,
      -- How many times this morning's count has been corrected. A set that
      -- reads 1 was typed once and never touched again.
      revisions INTEGER NOT NULL DEFAULT 1,
      -- Exactly one set per site is in force; the rest are what it replaced.
      is_current INTEGER NOT NULL DEFAULT 0
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_opening_set_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      pp_qty REAL NOT NULL DEFAULT 0,
      adj_qty REAL NOT NULL DEFAULT 0,
      rate REAL,
      note TEXT,
      UNIQUE(set_id, product_id)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_opening_sets ON stock_opening_sets(factory_id, company_id, as_of)')

    // The count already in force becomes set one. Starting the history at the
    // NEXT strike would leave the opening every current figure rests on as the
    // only one with no record — the opposite of the point.
    const live = await c.execute(
      `SELECT factory_id, company_id, as_of, COUNT(*) AS n, MIN(updated_at) AS first_at, MAX(updated_at) AS last_at
         FROM stock_openings GROUP BY factory_id, company_id, as_of`
    )
    for (const g of live.rows) {
      const fid = (g as unknown as Record<string, unknown>).factory_id
      const cid = (g as unknown as Record<string, unknown>).company_id
      const asOf = String((g as unknown as Record<string, unknown>).as_of || '').slice(0, 10)
      if (!asOf) continue
      const first = String((g as unknown as Record<string, unknown>).first_at || '')
      const last = String((g as unknown as Record<string, unknown>).last_at || '')
      const res = await c.execute({
        sql: `INSERT INTO stock_opening_sets
                (factory_id, company_id, as_of, note, created_at, created_by_name, updated_at, revisions, is_current)
              VALUES (?, ?, ?, 'The count in force when history began', ?, NULL, ?, 1, 1)`,
        args: [(fid as number) ?? null, (cid as number) ?? 1, asOf, first || last, last || first]
      })
      const sid = Number(res.lastInsertRowid) || 0
      if (!sid) continue
      await c.execute({
        sql: `INSERT INTO stock_opening_set_lines (set_id, product_id, qty, pp_qty, adj_qty, rate, note)
              SELECT ?, product_id, qty, pp_qty, adj_qty, rate, note
                FROM stock_openings
               WHERE as_of = ? AND ${fid == null ? 'factory_id IS NULL AND company_id = ?' : 'factory_id = ?'}`,
        args: [sid, asOf, (fid == null ? ((cid as number) ?? 1) : (fid as number)) as number]
      })
    }
  }).catch((e) => console.error('[stock] opening-stock history failed:', e))

  // An opening is counted the way the plant counts: what is in the tank, plus
  // what is already in process (PP / WIP). They are two separate figures on the
  // count sheet and the total is what the register opens at — the same shape
  // the Day close screen already uses, so the two agree by construction.
  await runOnce('stock_openings_pp_v1', async () => {
    await getClient()
      .execute('ALTER TABLE stock_openings ADD COLUMN pp_qty REAL NOT NULL DEFAULT 0')
      .catch((e) => {
        // Already there on a database that has had this column added by hand.
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[stock] opening pp column failed:', e))

  // A third part to an opening count: the correction.
  //
  // A tank dip and a stock card disagree, oil is in a line rather than a
  // vessel, a drum was counted twice. Rather than editing the counted figure —
  // which loses what was actually measured — the difference is stated on its
  // own, signed, and the register opens at all three added up. Nil by default,
  // so every opening already entered keeps the total it was saved with.
  await runOnce('stock_openings_adj_v1', async () => {
    await getClient()
      .execute('ALTER TABLE stock_openings ADD COLUMN adj_qty REAL NOT NULL DEFAULT 0')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[stock] opening adjustment column failed:', e))

  // What the PP figure is actually MADE OF.
  //
  // "PP 53 MT" is the sum of what is standing in each vessel on the morning
  // the books open — 6 in the bleacher, 32 in the deo scrubber, 3 in the
  // filter press, and so on down the line. The plant writes that breakdown out
  // by hand every time it counts, and until now the sheet took only the total,
  // so the one figure nobody could check afterwards was the one made of seven
  // parts.
  //
  // Two tables. The STAGES are the site's own list, shared by every product on
  // the sheet: a stage added while counting one oil is offered against all of
  // them, because a refinery has one set of vessels. The LINES are what each
  // product had in each of them.
  //
  // `active` is what makes a cross safe to press. A stage crossed off is only
  // deleted outright if nothing anywhere has a quantity against it; if
  // something does, the stage is retired instead — it stops being offered to
  // rows that never used it, and stays on the rows that did.
  await runOnce('stock_pp_stages_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_pp_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'f<factory_id>' where the site is known, else 'c<company_id>'. The
      -- opening sheet itself is read by site with a company fallback, and the
      -- stage list has to be scoped the same way or one company's stages would
      -- be invisible to another trading through the same tanks.
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope, name)
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS stock_opening_pp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      stage_id INTEGER NOT NULL REFERENCES stock_pp_stages(id),
      qty REAL NOT NULL DEFAULT 0,
      -- 'with' | 'without' | NULL. Whether that vessel's contents were
      -- measured with the free fatty acid still in them. NULL is a real
      -- answer — "counted, not yet classified" — and is reported as such
      -- rather than quietly folded into one side.
      ffa TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope, product_id, stage_id)
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_stock_opening_pp_prod ON stock_opening_pp(scope, product_id)'
    )
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_stock_opening_pp_stage ON stock_opening_pp(stage_id)'
    )
  }).catch((e) => console.error('[stock] PP stage tables failed:', e))

  // A record of exactly what one production run took off PP, vessel by
  // vessel — not a balance (stock_opening_pp.qty already is one, live), but
  // the undo tape for it. Editing or deleting a run has to put back precisely
  // what that run drew before it draws again or disappears, and the only way
  // to do that without guessing is to have written it down at the time.
  // THE RATE AN INVOICE WAS BILLED AT, HELD BY THE INVOICE.
  //
  // A purchase invoice used to keep only ONE rate: a single-bargain invoice
  // kept the bargain's rate, a split one kept the quantity-weighted blend. The
  // per-bargain rates behind that blend were never stored, so a split invoice
  // had to re-read them from the bargains every time it was opened — and
  // therefore silently re-priced itself whenever a bargain rate was later
  // corrected, while a single-bargain invoice beside it did not.
  //
  // The rate now lives on the tanker, next to the bargain it was loaded
  // against, frozen when the invoice is saved. A bargain rate corrected
  // afterwards changes nothing that has already been billed; the invoice
  // screen SHOWS the difference and offers to adopt it, one bargain at a time.
  //
  // Backfilled from each bargain's rate as it stands today, which is what
  // those invoices are already priced on — the blend stored on every existing
  // split invoice reproduces exactly from these figures.
  // WHAT CHANGED, not just who was here.
  //
  // The activity log records that somebody saved an invoice. It cannot say the
  // rate went from 1,30,000 to 1,27,000, which is the thing actually asked
  // about a month later. One row per field that moved, with the pair.
  // OIL THAT IS NEVER COMING BACK.
  //
  // A vessel holds a heel that cannot be finished — settled sludge, a tank
  // bottom, oil gone off. Leaving it in PP means every future batch is offered
  // stock that does not exist and the same question gets asked forever. Writing
  // it off takes it out of PP for good, and the reason is kept with it: a
  // quantity that vanished with no explanation is the one thing an auditor
  // always asks about.
  // GIVE THE COUNTED OPENING ITS DRAWS BACK.
  //
  // Production used to take its PP straight off the vessel row, so consuming
  // 35 of a counted 53 rewrote the count to 18 and deleted any vessel it
  // emptied. The count is the record of what a tank held that morning; it is
  // not a statement about today, and it must not move because the oil was
  // later used. What is AVAILABLE is derived now — counted less drawn — but
  // every row the old code reduced is short by exactly what pp_draws says was
  // taken out of it.
  //
  // So: add each vessel's recorded draws back onto its line, rebuild the lines
  // that were deleted outright, and restate the opening total from the
  // repaired lines. Runs once. pp_draws is the evidence and is left alone.
  await runOnce('pp_counted_restore_v1', async () => {
    const c = getClient()
    // A vessel emptied to nothing lost its row — rebuild it from the draw.
    await c.execute(
      "INSERT INTO stock_opening_pp (scope, product_id, stage_id, qty, ffa, updated_at) " +
        "SELECT d.scope, d.product_id, d.stage_id, 0, MAX(d.ffa), datetime('now') " +
        "FROM pp_draws d " +
        "WHERE NOT EXISTS (SELECT 1 FROM stock_opening_pp p " +
        "WHERE p.scope = d.scope AND p.product_id = d.product_id AND p.stage_id = d.stage_id) " +
        "GROUP BY d.scope, d.product_id, d.stage_id"
    )
    await c.execute(
      "UPDATE stock_opening_pp SET " +
        "qty = qty + COALESCE((SELECT SUM(d.qty) FROM pp_draws d " +
        "WHERE d.scope = stock_opening_pp.scope AND d.product_id = stock_opening_pp.product_id " +
        "AND d.stage_id = stock_opening_pp.stage_id), 0), updated_at = datetime('now') " +
        "WHERE EXISTS (SELECT 1 FROM pp_draws d WHERE d.scope = stock_opening_pp.scope " +
        "AND d.product_id = stock_opening_pp.product_id AND d.stage_id = stock_opening_pp.stage_id)"
    )
    // The opening total follows its own lines, for every product that has any.
    await c.execute(
      "UPDATE stock_openings SET pp_qty = COALESCE((SELECT ROUND(SUM(p.qty), 3) FROM stock_opening_pp p " +
        "WHERE p.product_id = stock_openings.product_id AND p.scope = " +
        "CASE WHEN stock_openings.factory_id IS NOT NULL THEN 'f' || stock_openings.factory_id " +
        "ELSE 'c' || stock_openings.company_id END), pp_qty) " +
        "WHERE EXISTS (SELECT 1 FROM stock_opening_pp p WHERE p.product_id = stock_openings.product_id)"
    )
  }).catch((e) => console.error('[stock] pp counted restore failed:', e))

  await runOnce('pp_writeoffs_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS pp_writeoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      stage_id INTEGER NOT NULL REFERENCES stock_pp_stages(id),
      qty REAL NOT NULL,
      ffa TEXT,
      note TEXT,
      written_by INTEGER,
      written_by_name TEXT,
      company_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_pp_writeoffs_product ON pp_writeoffs(product_id, id)')
  }).catch((e) => console.error('[stock] pp write-offs failed:', e))

  await runOnce('change_log_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      -- What the record is CALLED, kept beside the id: an invoice number read
      -- back years later means something where a row id does not.
      entity_key TEXT,
      action TEXT NOT NULL DEFAULT 'updated',
      field TEXT,
      label TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_by INTEGER,
      changed_by_name TEXT,
      company_id INTEGER,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_change_log_rec ON change_log(entity, entity_id, id)')
  }).catch((e) => console.error('[history] change log failed:', e))

  await runOnce('tanker_frozen_bargain_rate_v1', async () => {
    const c = getClient()
    for (const col of ['bargain_rate', 'extra_bargain_rate']) {
      await c.execute(`ALTER TABLE purchase_tankers ADD COLUMN ${col} REAL`).catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await c.execute(`UPDATE purchase_tankers SET bargain_rate =
      (SELECT b.rate_per_uom FROM bargains b WHERE b.id = purchase_tankers.bargain_id)
      WHERE bargain_rate IS NULL AND bargain_id IS NOT NULL`)
    await c.execute(`UPDATE purchase_tankers SET extra_bargain_rate =
      (SELECT b.rate_per_uom FROM bargains b WHERE b.id = purchase_tankers.extra_bargain_id)
      WHERE extra_bargain_rate IS NULL AND extra_bargain_id IS NOT NULL`)
  }).catch((e) => console.error('[orders] tanker frozen bargain rate failed:', e))

  await runOnce('pp_draws_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS pp_draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id INTEGER NOT NULL REFERENCES production(id),
      scope TEXT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      stage_id INTEGER NOT NULL REFERENCES stock_pp_stages(id),
      qty REAL NOT NULL,
      ffa TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_pp_draws_production ON pp_draws(production_id)')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_pp_draws_stage ON pp_draws(stage_id)')
  }).catch((e) => console.error('[production] pp_draws table failed:', e))

  // The day's work, per person.
  //
  // Three tables. PROCESSES is the catalogue — which daily jobs each page is
  // responsible for, so the checklist can be built from what somebody can
  // actually reach instead of being maintained by hand and drifting from it.
  // TASKS is one row per person per process per day, written rather than
  // derived on read — today's list grows as access is granted, nothing already
  // raised is ever removed, and a past day is never touched. NOTES is the conversation on a task
  // — the admin saying what needs fixing, the answer, and the note that says
  // what changed.
  await runOnce('work_assignments_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS work_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- A MODULES key: gateEntry, stock, sales… Whoever holds that page gets
      -- the processes hanging off it.
      module TEXT NOT NULL,
      -- '' means any grant of the module sees it. A value means only a grant
      -- carrying that scope does — which is what stops the lab desk, whose
      -- Purchases grant is scoped to 'readings', being asked to confirm rates.
      scope TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      detail TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(module, scope, title)
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS work_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factory_id INTEGER,
      company_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      module TEXT NOT NULL,
      -- NULL for a one-off an admin assigned: it has no catalogue entry, and
      -- SQLite treats NULLs as distinct in a UNIQUE index, so several of them
      -- on one day do not collide.
      process_id INTEGER,
      title TEXT NOT NULL,
      detail TEXT,
      kind TEXT NOT NULL DEFAULT 'auto',
      state TEXT NOT NULL DEFAULT 'pending',
      -- Local wall-clock stamps, written by work.ts. Never datetime('now'):
      -- that is UTC, and a tick at 02:00 IST would stamp the previous evening
      -- and land on the wrong side of the cut-off.
      marked_at TEXT,
      reviewed_at TEXT,
      reviewed_by INTEGER,
      assigned_by INTEGER,
      due_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(work_date, user_id, process_id)
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS work_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      -- The role AS IT WAS when the note was written, so a note from somebody
      -- since promoted still reads as what it was at the time.
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      created_at TEXT
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(work_date, user_id)')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_work_tasks_site ON work_tasks(factory_id, work_date)')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_work_notes_task ON work_notes(task_id, id)')

    // The starting catalogue. Written once — an admin can add to it, retire an
    // entry or reword one, and this never runs again to undo that.
    const SEED: [string, string, string, string][] = [
      ['gateEntry', '', 'Weigh and record every tanker in', 'Gross and tare on each vehicle, both directions.'],
      ['gateEntry', '', "Close today's gate register", 'No entry left pending a weight at cut-off.'],
      ['stock', '', 'View the receiving stocks', 'What came in today against the book figure, with a note on any difference.'],
      ['sales', '', "Raise invoices for today's dispatches", 'Every loaded tanker invoiced before cut-off.'],
      ['sales', 'unload', 'Confirm unloading receipts', 'Received quantity against what was dispatched.'],
      ['orders', '', "Book today's purchases and confirm rates", 'Every purchase raised today has a rate against it.'],
      ['orders', 'readings', "Log lab readings against today's tankers", 'FFA and moisture on each tanker before it is emptied.'],
      ['bargains', '', 'Update open purchase bargains', 'Balance quantity against what was actually drawn.'],
      ['salesBargains', '', 'Update open sales bargains', 'Every dispatch drawn against the right bargain.'],
      ['accounts', '', "Post today's vouchers", 'Nothing left unposted at cut-off.'],
      // The LC desk and the discounting desk are granted separately and are
      // often not the same person, so they are asked separately.
      ['treasuryLc', '', 'Check LCs maturing this week', 'Anything inside seven days needs a plan today.'],
      ['treasuryBd', '', 'Check bills maturing this week', 'Anything inside seven days needs a plan today.'],
      ['bankRecon', '', "Reconcile yesterday's bank statement", 'Every credit and debit tied to a voucher.'],
      ['production', '', "Record today's batches", 'Every batch run, with its formulation and what it consumed.'],
      ['formulation', '', 'Check the recipes used today', 'Any ratio changed on the floor is recorded against the batch.'],
      ['consignment', '', 'Update consignment deliveries', 'Received quantity and date against each delivery.'],
      ['packaging', '', "Enter today's packing", 'Pieces packed against each SKU, and the oil it drew.']
    ]
    let order = 0
    for (const [module, scope, title, detail] of SEED) {
      order += 10
      await c.execute({
        sql: `INSERT INTO work_processes (module, scope, title, detail, sort_order)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(module, scope, title) DO NOTHING`,
        args: [module, scope, title, detail, order]
      })
    }
  }).catch((e) => console.error('[work] work-assignment tables failed:', e))

  // How a product is MEASURED.
  //
  // Everything the mill makes is weighed, so MT is the default and every
  // product already on the books is one. A packaging item is not: a carton is a
  // carton, and counting it in tonnes is how it ended up on the production tab
  // beside the oils. Stated on the product rather than guessed from its
  // category, because the category says what a thing IS and this says how it
  // is counted — a mill could perfectly well weigh a by-product and count a
  // tin.
  await runOnce('products_uom_v1', async () => {
    const c = getClient()
    await c
      .execute("ALTER TABLE products ADD COLUMN uom TEXT NOT NULL DEFAULT 'MT'")
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    // The DEFAULT backfills every existing row to MT. This is the one that is
    // counted rather than weighed; matched by its exact name so the statement
    // is simply a no-op on a database that has no such product.
    await c.execute({
      sql: "UPDATE products SET uom = 'PCS' WHERE TRIM(name) = ? AND uom <> 'PCS'",
      args: ['CARTON,POUCH,500MLX32,DALDA']
    })
  }).catch((e) => console.error('[products] measuring-unit column failed:', e))

  // Packs on the shelf the morning the books began.
  //
  // The bulk register got this first: a counted opening is a BALANCE, and
  // movements before it are superseded by the count rather than added to it.
  // The packed shelf had no such figure, so it carried its whole history
  // forward — which is right until somebody counts the shelf, and wrong the
  // moment they do.
  //
  // Kept apart from stock_openings on purpose: that table is keyed by PRODUCT
  // and holds tonnes in the tank, this one is keyed by PACKAGING and holds
  // pieces on the shelf. Oil already in jars on the opening morning was never
  // in the tank, so the two figures do not overlap and must not share a row.
  await runOnce('sku_openings_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS sku_openings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      packaging_id INTEGER NOT NULL REFERENCES packagings(id),
      as_of TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, packaging_id)
    )`)
    await c
      .execute('CREATE INDEX IF NOT EXISTS idx_sku_openings_co ON sku_openings(company_id)')
      .catch(() => {})
  }).catch((e) => console.error('[stock] packed-SKU opening table failed:', e))

  // How a recipe is CLASSIFIED, as distinct from what it makes.
  //
  // Two recipes can both output DALDA and be entirely different jobs: one built
  // on recovered oil, one on RPS. The output product cannot say which, so the
  // sub-category needs a name of its own before production or stock can be read by it.
  //
  // A managed list rather than a text column on purpose. There are already two
  // ledgers called LEGACY COMMODITIES (one with a full stop) and two products
  // called RPO; free text would become "recovered-oil", "Recovered Oil" and
  // "recovered oil " inside a month, and the grouping would quietly stop
  // working while still looking as though it worked.
  await runOnce('formulation_subcategory_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS formulation_subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    // Case-insensitive uniqueness, so the very thing this table exists to
    // prevent cannot be created inside it either.
    await c.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_fsubcat_name ON formulation_subcategories(UPPER(TRIM(name)))'
    )
    try {
      await c.execute('ALTER TABLE formulations ADD COLUMN subcategory_id INTEGER REFERENCES formulation_subcategories(id)')
    } catch (e) {
      // Already there. Swallowed deliberately: runOnce does not record its
      // marker if this throws, so it would retry on every launch for ever.
      if (!/duplicate column/i.test((e as Error).message)) throw e
    }
    // The three sub-categories the client named. Seeded so the field is usable at once;
    // all three can be renamed, retired or added to from the manage dialog.
    for (const [i, name] of ['recovered-oil', 'fatty-oil-based', 'rps'].entries()) {
      await c.execute({
        sql: `INSERT INTO formulation_subcategories (name, sort_order)
              SELECT ?, ? WHERE NOT EXISTS (
                SELECT 1 FROM formulation_subcategories WHERE UPPER(TRIM(name)) = UPPER(TRIM(?))
              )`,
        args: [name, i, name]
      })
    }
  }).catch((e) => console.error('[formulations] subcategory setup failed:', e))

  // A formulation built one-off from the PP vessel breakdown is not a master
  // recipe. It exists only to restate that with-FFA vessel into the oils it is
  // made of, so it is marked hidden and kept off the Formulations tab — it is
  // still there to be picked on the breakdown that made it, just not offered as
  // a reusable recipe alongside the ones the mill actually runs to.
  await runOnce('formulation_hidden_v1', async () => {
    const c = getClient()
    try {
      await c.execute('ALTER TABLE formulations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
    } catch (e) {
      // Already there. Swallowed deliberately: runOnce does not record its
      // marker if this throws, so it would retry on every launch for ever.
      if (!/duplicate column/i.test((e as Error).message)) throw e
    }
  }).catch((e) => console.error('[formulations] hidden column setup failed:', e))

  // Invoice numbers that were deliberately voided rather than lost.
  //
  // A gap in the series has two innocent explanations and one worrying one: the
  // form was spoiled, the bill was cancelled, or nobody knows. Recording the
  // first two turns the report from a list of unanswered questions into a list
  // of real ones — which is the only way the report stays useful as the series
  // grows.
  //
  // The number is stored as prefix + number rather than as text, so it matches
  // the series the gap report reconstructs however the invoice was punctuated.
  await runOnce('cancelled_invoice_nos_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS cancelled_invoice_nos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      prefix TEXT NOT NULL,
      number INTEGER NOT NULL,
      reason TEXT,
      cancelled_on TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, prefix, number)
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_cancinv_co ON cancelled_invoice_nos(company_id, prefix)'
    )
  }).catch((e) => console.error('[sales] cancelled-invoice table failed:', e))

  // What an LC's interest is charged ON.
  //
  // Off means the whole open amount, which is how every LC on the books today
  // was posted — so the default preserves them exactly and nothing recalculates
  // until somebody edits an LC and says otherwise. On means the commission is
  // deducted first and interest runs only on what the bank actually advanced.
  //
  // Handles all three states, because an earlier build of this shipped the
  // column under a name that described the opposite option: rename it if that
  // one is present, add it if neither is, do nothing if it is already right.
  await runOnce('lc_interest_excl_charges_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('letters_of_credit')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (cols.has('interest_excl_charges')) return
    if (cols.has('interest_on_charges')) {
      await c.execute(
        'ALTER TABLE letters_of_credit RENAME COLUMN interest_on_charges TO interest_excl_charges'
      )
      return
    }
    await c.execute(
      'ALTER TABLE letters_of_credit ADD COLUMN interest_excl_charges INTEGER NOT NULL DEFAULT 0'
    )
  }).catch((e) => console.error('[lc] interest-base column failed:', e))

  // The bank's interest is not always struck on the amount the credit was
  // opened at. This column carries that difference — signed, nil by default,
  // so nothing already posted moves until somebody enters one. See
  // lcInterestBase in lcInterest.ts.
  await runOnce('lc_interest_adj_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('letters_of_credit')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (cols.has('interest_adj')) return
    await c.execute('ALTER TABLE letters_of_credit ADD COLUMN interest_adj REAL NOT NULL DEFAULT 0')
  }).catch((e) => console.error('[lc] interest-adjustment column failed:', e))

  // An LC repayment's charges on ledgers the user picks — as many rows as the
  // bank's debit carried (saveLcRepayment / repayLcParts). JSON rows plus
  // their total, so every reader can take them off the principal in SQL.
  await runOnce('lc_repay_charges_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('lc_repayments')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (!cols.has('charges')) await c.execute('ALTER TABLE lc_repayments ADD COLUMN charges TEXT')
    if (!cols.has('charges_total')) await c.execute('ALTER TABLE lc_repayments ADD COLUMN charges_total REAL')
  }).catch((e) => console.error('[lc] repayment-charges columns failed:', e))

  // Interest paid in the same debit as a discounted bill's repayment — gross,
  // posted to the interest ledger on the repayment voucher (repayBd). Nil on
  // every repayment already entered, so nothing moves.
  // What the bank ACTUALLY debited for an LC's upfront interest and charges,
  // when its statement differs from the worked figure (PAY/18: worked
  // 2,76,523.51, bank and Tally 2,76,288). Nil on every LC, so nothing moves.
  await runOnce('lc_upfront_debited_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('letters_of_credit')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (cols.has('upfront_debited')) return
    await c.execute('ALTER TABLE letters_of_credit ADD COLUMN upfront_debited REAL')
  }).catch((e) => console.error('[lc] upfront-debited column failed:', e))

  await runOnce('bd_repay_interest_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('bd_repayments')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (cols.has('interest')) return
    await c.execute('ALTER TABLE bd_repayments ADD COLUMN interest REAL')
  }).catch((e) => console.error('[bd] repayment-interest column failed:', e))

  // Charges a repayment put on ledgers the user picked, as JSON [{account, amount}].
  await runOnce('bd_repay_charges_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('bd_repayments')", args: [] })
    if (info.rows.some((r) => String((r as unknown as Record<string, unknown>).name) === 'charges')) return
    await c.execute('ALTER TABLE bd_repayments ADD COLUMN charges TEXT')
  }).catch((e) => console.error('[bd] repayment-charges column failed:', e))

  // Whether a discounted bill's interest counts the payment received date
  // itself. Both ends of that question are real conventions and NBFCs differ,
  // so it is one of their negotiated terms — kept on the NBFC as the default
  // AND on each bill, the way days_year already is, so changing an NBFC's
  // terms never moves the interest on a bill already recorded.
  //
  // Nil by default, which is the behaviour every existing bill was posted
  // with: interest from the day after the receipt to maturity.
  await runOnce('bd_days_incl_start_v1', async () => {
    const c = getClient()
    for (const table of ['nbfcs', 'bill_discountings']) {
      const info = await c.execute({ sql: `PRAGMA table_info('${table}')`, args: [] })
      const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
      if (cols.has('days_incl_start')) continue
      await c.execute(`ALTER TABLE ${table} ADD COLUMN days_incl_start INTEGER NOT NULL DEFAULT 0`)
    }
  }).catch((e) => console.error('[bd] receipt-date basis column failed:', e))

  // Index work for installs that are already past the migration-count mark, so
  // it cannot be added to that list and be run. Keyed by name, so it happens
  // exactly once per database and costs nothing on every launch after.
  // The consignment invoices booked before a withdrawal drew its parcels.
  // See backfillConsignmentDraws: oldest invoice first, oldest parcel first,
  // and anything it cannot cover left alone.
  await runOnce('consignment_draw_fifo_v1', async () => {
    const out = await backfillConsignmentDraws()
    if (out.linked || out.skipped) {
      console.log(
        `[consignment] linked ${out.linked} invoice(s) to their parcels FIFO` +
          (out.skipped ? `, left ${out.skipped} alone: ${out.notes.join('; ')}` : '')
      )
    }
  }).catch((e) => console.warn('[consignment] FIFO draw backfill skipped:', (e as Error).message))

  // A second pass, asked for by name: relink the consignment withdrawals that
  // were still showing no lot·terminal — bookings made after the first pass, or
  // ones it could not cover then and can now. Safe to run on top of the first:
  // backfillConsignmentDraws only touches orders with NO parcel link yet, so an
  // already-linked withdrawal is never disturbed. A new key, so it fires once
  // more even though the first pass has already been marked done.
  await runOnce('consignment_draw_fifo_v2', async () => {
    const out = await backfillConsignmentDraws()
    if (out.linked || out.skipped) {
      console.log(
        `[consignment] FIFO relink: linked ${out.linked} invoice(s) to their parcels` +
          (out.skipped ? `, left ${out.skipped} alone: ${out.notes.join('; ')}` : '')
      )
    }
  }).catch((e) => console.warn('[consignment] FIFO draw relink skipped:', (e as Error).message))

  await runOnce('ulogs_entity_index_v1', async () => {
    const c = getClient()
    // One record's own history -- who did what to THIS letter of credit --
    // filters on the module and the record id together.
    await c.execute('CREATE INDEX IF NOT EXISTS idx_ulogs_entity_id ON user_logs(entity, entity_id)')
    // Which makes the plain entity index redundant: the composite covers
    // everything it did, entity being its leading column. Left in place it only
    // gave the planner a worse option that it kept choosing -- matching a
    // record's history on the module alone and then filtering, walking every
    // row belonging to that module instead of the few belonging to the record.
    await c.execute('DROP INDEX IF EXISTS idx_ulogs_entity')
    // stock_transfers is empty today, so scanning it costs nothing -- but the
    // stock registers sum it PER PRODUCT, twice each way, so the day it starts
    // filling those scans multiply by the product count. Indexed now, while it
    // is free to do.
    await c.execute('CREATE INDEX IF NOT EXISTS idx_stransfers_to ON stock_transfers(to_company_id, product_id)')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_stransfers_from ON stock_transfers(from_company_id, product_id)')
  }).catch((e) => console.error('[logs] history index failed:', e))
  // Not every record is identified by a number: a sales invoice is a GROUP of
  // line rows addressed by its group string, so every sales event landed with
  // no record key at all and the trail could not say which invoice it belonged
  // to -- 246 events, none of them attributable. This is that key.
  //
  // Here rather than in the migration list for the reason written at the foot
  // of that list: it is applied by COUNT, and an install already past the mark
  // silently skips anything added to it. A named runOnce cannot be skipped.
  await runOnce('ulogs_entity_key_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE user_logs ADD COLUMN entity_key TEXT')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_ulogs_entity_key ON user_logs(entity, entity_key)')
  }).catch((e) => console.error('[logs] entity key failed:', e))
  // One vehicle can carry more than one sale out of the gate. The entry keeps
  // its primary invoice -- every register that asks "has this invoice gone out"
  // still reads that column -- and this table holds every invoice on the
  // vehicle, the primary included, so a second bill on the same tanker is
  // recognised as dispatched instead of looking as though it never left.
  //
  // A named runOnce, not the migration list, for the reason written at the foot
  // of that list: it is applied by COUNT, and an install already at the mark
  // silently skips whatever is added to it.
  await runOnce('gate_entry_sales_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS gate_entry_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_entry_id INTEGER NOT NULL REFERENCES gate_entries(id),
      invoice_group TEXT NOT NULL,
      sale_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(gate_entry_id, invoice_group)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_ges_entry ON gate_entry_sales(gate_entry_id)')
    await c.execute('CREATE INDEX IF NOT EXISTS idx_ges_group ON gate_entry_sales(invoice_group)')
    // Every gate-out already on file gets its existing single invoice as a
    // link, so the two paths read the same from here on and no past dispatch
    // has to be re-keyed.
    await c.execute(`INSERT OR IGNORE INTO gate_entry_sales (gate_entry_id, invoice_group, sale_id)
      SELECT g.id, g.invoice_group, g.sale_id FROM gate_entries g
      WHERE g.invoice_group IS NOT NULL AND g.invoice_group <> ''`)
  }).catch((e) => console.error('[gate] invoice links failed:', e))
  // A TRADING discounted bill has a round trip like a Trading LC: we discount
  // the purchase, resell the goods, and the customer's money comes back. Only
  // the first half was tracked — the repayment to the NBFC — because nothing
  // said which resale invoices the money was expected through. These three
  // mirror the LC side exactly: who pays us back, which purchase invoices the
  // bill funded (the route to the trading deal, and so to the resale
  // invoices), and each receipt as it lands.
  await runOnce('bd_payment_in_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE bill_discountings ADD COLUMN receivable_party_id INTEGER')
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_linked_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, order_id)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_linked_orders_bd ON bd_linked_orders(bd_id)')
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_payment_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      pay_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_payment_ins_bd ON bd_payment_ins(bd_id)')
  }).catch((e) => console.error('[bd] payment-in schema failed:', e))
  // A discounted bill draws on a limit the NBFC has sanctioned, and there was
  // nowhere to record it -- the page could show utilisation with nothing to
  // measure it against. The limit belongs on the NBFC because that is who
  // sanctions it; the combined ceiling across all of them is a company setting.
  //
  // The unique index is the belt to assertUniqueName's braces: a name is
  // already refused per company in the application, and this makes it
  // impossible from any path at all. It is per COMPANY on purpose -- two
  // companies each keeping their own INFOTEL master is correct, not a
  // duplicate, and pooling them would merge two separate facilities.
  await runOnce('bd_limits_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE nbfcs ADD COLUMN sanctioned_limit REAL NOT NULL DEFAULT 0')
    await c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_nbfcs_company_name ON nbfcs(company_id, TRIM(LOWER(name)))')
  }).catch((e) => console.error('[bd] limits schema failed:', e))
  // One discounted bill can be raised against several suppliers (PID) or
  // customers (SID) -- a single facility drawn on a batch of invoices from more
  // than one party. The bill keeps its PRIMARY party in the column it always
  // had, so every register, voucher and ledger posting is untouched, and this
  // table holds all of them, the primary included.
  // A database built entirely from nothing replays db.ts's numbered MIGRATIONS
  // list from index 0 — which includes the ORIGINAL bd_parties (party_name,
  // discounter, rate_pct...), the tracker Bill Discounting replaced. Its DROP
  // was turned into a no-op there on purpose, because production had already
  // reused the name for the bd_id-keyed table below and a replay must not wipe
  // it. A fresh database has no such table yet at that point, so it inherits
  // the OLD one under the new name instead — and every "IF NOT EXISTS" from
  // here on then leaves it exactly as it is.
  //
  // Both retired tables were confirmed empty when they were dropped everywhere
  // else, and nothing in the current app writes to that shape, so a table
  // still in it is safe to rebuild — checked by an actual row count rather
  // than taken on faith, so a database that somehow has real rows in it is
  // reported instead of touched.
  await runOnce('bd_parties_reshape_v1', async () => {
    const c = getClient()
    const info = await c.execute({ sql: "PRAGMA table_info('bd_parties')", args: [] })
    const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)))
    if (cols.size === 0 || cols.has('bd_id')) return // doesn't exist yet, or already the right shape
    const count = await c.execute('SELECT COUNT(*) AS n FROM bd_parties')
    const n = Number((count.rows[0] as unknown as Record<string, unknown>).n)
    if (n > 0) {
      console.error(`[bd] bd_parties has the retired party+entries shape AND ${n} row(s) — leaving it for a human`)
      return
    }
    await c.execute('DROP TABLE IF EXISTS bd_entries')
    await c.execute('DROP TABLE bd_parties')
  }).catch((e) => console.error('[bd] party-table reshape failed:', e))
  // Bill Discounting's tables, restored for a database that never got them.
  //
  // bill_discountings sits in the MIDDLE of the migration list, and that list
  // is applied by COUNT — so an install whose count was already past that
  // point never ran it, and Bill Discounting has been querying a table that
  // was not there. bd_parties has the same problem from the other direction:
  // a migration replay dropped it (the name was reused, see db.ts) while its
  // own runOnce marker said it existed.
  //
  // Under its own key so it runs regardless of those older markers, and every
  // statement is idempotent, so it is harmless where the tables are fine.
  // Columns on `companies` that the count-based MIGRATIONS list could not be
  // trusted to add. That list runs entries by INDEX from a stored count, and
  // these two were added to it twice — once mid-list, where the mark already
  // covered them, and then appended, by which point the first attempt had
  // bumped the count past the new length. The result on a live database was
  // `colour` present and `company_type` missing, and no further restart could
  // fix it because the count said there was nothing to do.
  //
  // Unconditional and idempotent instead: a duplicate-column error is the job
  // already done, and anything else is worth seeing.
  await (async (): Promise<void> => {
    const c = getClient()
    for (const sql of [
      "ALTER TABLE companies ADD COLUMN company_type TEXT NOT NULL DEFAULT 'manufacturing'",
      'ALTER TABLE companies ADD COLUMN colour TEXT',
      // The order companies are offered in (Accounting's Select Company). Nullable
      // and never backfilled: a company with none sorts after the numbered ones.
      'ALTER TABLE companies ADD COLUMN priority INTEGER'
    ]) {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
  })().catch((e: unknown) => console.error('[companies] column repair failed:', e))

  // A transporter's GST registration, and a freight bill's free deduction.
  //   transporters.gst_registration  'registered' | 'unregistered'; NULL reads
  //     as registered, so every transporter entered before keeps working as it
  //     did until someone marks it otherwise.
  //   transporter_bills.others_amount / others_ledger  a deduction typed on the
  //     bill (damage, detention…), credited to the ledger named.
  for (const sql of [
    'ALTER TABLE transporters ADD COLUMN gst_registration TEXT',
    'ALTER TABLE transporter_bills ADD COLUMN others_amount REAL NOT NULL DEFAULT 0',
    'ALTER TABLE transporter_bills ADD COLUMN others_ledger TEXT',
    // RCM on an unregistered transporter's freight: the rate struck and the
    // tax it came to (0 on every bill booked before RCM was posted).
    'ALTER TABLE transporter_bills ADD COLUMN rcm_pct REAL NOT NULL DEFAULT 0',
    'ALTER TABLE transporter_bills ADD COLUMN rcm_amount REAL NOT NULL DEFAULT 0',
    // Several deductions on one bill (detention, damage, …): a JSON list of
    // { amount, ledger, note }. NULL on every bill booked before — those keep
    // their single others_amount / others_ledger.
    'ALTER TABLE transporter_bills ADD COLUMN deductions_json TEXT'
  ]) {
    await getClient()
      .execute(sql)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error('[transporters] column failed:', e)
      })
  }

  // BD PAYMENT TO THE SUPPLIER IN PARTS: the first part on the bill, the rest
  // in their own table. Nullable / new, so every bill before reads as paid in
  // one go. Idempotent.
  // An LC application the bank rejected: when, why, who recorded it. Nullable
  // — no LC before this was ever rejected. Idempotent.
  for (const sql of [
    'ALTER TABLE letters_of_credit ADD COLUMN rejected_date TEXT',
    'ALTER TABLE letters_of_credit ADD COLUMN rejected_reason TEXT',
    'ALTER TABLE letters_of_credit ADD COLUMN rejected_by TEXT'
  ]) {
    await getClient()
      .execute(sql)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error('[lc] rejected column failed:', e)
      })
  }
  // Raw opening stock, tank by tank (see stockopenings.parseRawTanks) — on the
  // live opening and on every history line. Nullable: every opening struck
  // before this is a single figure, exactly as it was. Idempotent.
  for (const sql of [
    'ALTER TABLE stock_openings ADD COLUMN raw_tanks TEXT',
    'ALTER TABLE stock_opening_set_lines ADD COLUMN raw_tanks TEXT'
  ]) {
    await getClient()
      .execute(sql)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error('[stock] raw_tanks column failed:', e)
      })
  }
  await getClient()
    .execute('ALTER TABLE bill_discountings ADD COLUMN first_party_part REAL')
    .catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) console.error('[bd] first_party_part column failed:', e)
    })
  await getClient()
    .execute(`CREATE TABLE IF NOT EXISTS bd_party_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL,
      part_no INTEGER NOT NULL,
      pay_date TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    .catch((e: unknown) => console.error('[bd] party payments table failed:', e))
  // SID RECEIVED IN PARTS. The NBFC can release a SID bill's money in several
  // legs on different dates; the first leg is the Payment received itself
  // (first_receipt_part), each later one a row here with its own voucher and
  // its own interest to maturity. Nullable and never backfilled: every bill
  // already on file reads as received in one go, exactly as before.
  await getClient()
    .execute('ALTER TABLE bill_discountings ADD COLUMN first_receipt_part REAL')
    .catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) console.error('[bd] first_receipt_part column failed:', e)
    })
  await getClient()
    .execute(`CREATE TABLE IF NOT EXISTS bd_receipt_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL,
      part_no INTEGER NOT NULL,
      receipt_date TEXT NOT NULL,
      amount REAL NOT NULL,
      interest REAL NOT NULL DEFAULT 0,
      account TEXT,
      ref TEXT,
      note TEXT,
      journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    .catch((e: unknown) => console.error('[bd] receipt parts table failed:', e))
  // EACH PART ITS OWN MATURITY, INTEREST % AND MARGIN %. NULL everywhere it
  // already exists, which reads as the bill's own maturity and rates — so no
  // leg already received moves. Part 1's live on the bill (it is the Payment
  // received itself); the later ones on their rows.
  for (const [table, col] of [
    ['bill_discountings', 'first_receipt_maturity TEXT'],
    ['bill_discountings', 'first_receipt_interest_pct REAL'],
    ['bill_discountings', 'first_receipt_margin_pct REAL'],
    ['bd_receipt_parts', 'maturity_date TEXT'],
    ['bd_receipt_parts', 'interest_pct REAL'],
    ['bd_receipt_parts', 'margin_pct REAL']
  ]) {
    await getClient()
      .execute(`ALTER TABLE ${table} ADD COLUMN ${col}`)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error(`[bd] ${table} ${col} failed:`, e)
      })
  }

  // LC PAYMENT TO THE PARTY IN INSTALLMENTS. The bank can pay the beneficiary
  // in parts on different dates; each part is a set of lc_issuances rows
  // sharing one installment_no, settled by its own voucher on its own date.
  // Nullable and never backfilled: every bill raised before reads as the one
  // payment it always was. Idempotent, like the block above.
  await getClient()
    .execute('ALTER TABLE lc_issuances ADD COLUMN installment_no INTEGER')
    .catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) console.error('[lc] installment column failed:', e)
    })

  // The amount the bank BLOCKS against the facility when it opens the credit,
  // as distinct from the amount actually opened. They part company whenever the
  // bill submitted comes in under what was requested: the open amount follows
  // the bill, while the bank still holds the requested figure against the
  // limit. Nullable and never backfilled — every existing LC reads its blocked
  // figure as COALESCE(blocked_amount, amount), so old rows keep behaving
  // exactly as they did and nothing has to be rewritten to make that true.
  await (async (): Promise<void> => {
    await getClient()
      .execute('ALTER TABLE letters_of_credit ADD COLUMN blocked_amount REAL')
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  })().catch((e: unknown) => console.error('[lc] blocked_amount column failed:', e))

  // NOT runOnce, deliberately — and this is the second time these tables have
  // gone missing for the same reason.
  //
  // Every statement in here is CREATE TABLE / CREATE INDEX IF NOT EXISTS or an
  // ALTER whose duplicate-column error is swallowed, so running it on a
  // healthy database costs a few no-op DDL statements and changes nothing.
  // Behind a runOnce it fixed the problem exactly once: db.ts's MIGRATIONS list
  // is applied BY COUNT and once reused the bd_parties name (see the note
  // there), so a later replay drops the table again — while this block's marker
  // still says it has been dealt with, and nothing recreates it.
  //
  // Which is the state a live database was found in: both markers recorded, and
  // no bd_parties table. bd:list and bd:kpis threw "no such table", and because
  // Treasury loads its LCs and its bills in one Promise.all, the whole page
  // came up empty rather than just Bill Discounting. Unconditional, it heals on
  // the next start however the table came to be missing.
  await (async (): Promise<void> => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS bill_discountings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      bd_no TEXT,
      nbfc_id INTEGER REFERENCES nbfcs(id),
      finance_type TEXT NOT NULL DEFAULT 'PID',
      party_type TEXT NOT NULL DEFAULT 'supplier',
      party_id INTEGER,
      purpose TEXT NOT NULL DEFAULT 'manufacturing',
      amount REAL NOT NULL DEFAULT 0,
      payment_received_date TEXT,
      maturity_date TEXT,
      margin_pct REAL NOT NULL DEFAULT 0,
      interest_pct REAL NOT NULL DEFAULT 0,
      tds_pct REAL NOT NULL DEFAULT 0,
      interest_upfront INTEGER NOT NULL DEFAULT 0,
      days_year REAL NOT NULL DEFAULT 360,
      status TEXT NOT NULL DEFAULT 'open',
      repaid_date TEXT,
      repaid_amount REAL,
      journal_entry_id INTEGER,
      repay_journal_entry_id INTEGER,
      margin_release_journal_entry_id INTEGER,
      receivable_party_id INTEGER,
      invoice_amount REAL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    // Columns the migration list adds after the table. Swallowed one by one:
    // "duplicate column" is the expected answer where the table is already
    // complete, and runOnce records nothing if the block throws.
    for (const sql of [
      'ALTER TABLE bill_discountings ADD COLUMN days_year REAL NOT NULL DEFAULT 360',
      'ALTER TABLE bill_discountings ADD COLUMN invoice_amount REAL',
      'ALTER TABLE bill_discountings ADD COLUMN receivable_party_id INTEGER'
    ]) {
      await c.execute(sql).catch(() => {})
    }
    for (const sql of [
      'CREATE INDEX IF NOT EXISTS idx_bd_company ON bill_discountings(company_id)',
      'CREATE INDEX IF NOT EXISTS idx_bd_nbfc ON bill_discountings(nbfc_id)',
      'CREATE INDEX IF NOT EXISTS idx_bd_company_status ON bill_discountings(company_id, status)'
    ]) {
      await c.execute(sql).catch(() => {})
    }
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_repayments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      repay_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      journal_entry_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_repay_bd ON bd_repayments(bd_id)').catch(() => {})

    // The party links, whose name a migration had been dropping.
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      amount REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, party_id)
    )`)
    await c.execute('ALTER TABLE bd_parties ADD COLUMN amount REAL').catch(() => {})
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_parties_bd ON bd_parties(bd_id)').catch(() => {})
    // Any bill already on file gets its own party as a link, so both read paths
    // agree. IGNORE, so a bill that already has links is left alone.
    await c.execute(`INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id)
      SELECT id, party_type, party_id FROM bill_discountings WHERE party_id IS NOT NULL`).catch(() => {})

    /**
     * PRINCIPAL REPAYMENTS — WHAT THE LIMIT ITSELF COMES DOWN BY.
     *
     * Not a repayment of a bill. A bill's repayment gives its money back and
     * frees the limit it was using, so the line can be drawn again; this is the
     * NBFC cutting the line. Repay 4 lakh of principal against a 35 lakh
     * facility and the facility is 31 lakh from then on, whatever any bill is
     * doing — the room does not come back.
     *
     * Kept as rows rather than as a running figure on the NBFC so the drop is
     * dated, attributable and reversible: a limit that simply reads 31 cannot
     * say when or why it stopped being 35.
     */
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_limit_reductions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      nbfc_id INTEGER NOT NULL REFERENCES nbfcs(id),
      bd_id INTEGER REFERENCES bill_discountings(id),
      amount REAL NOT NULL DEFAULT 0,
      reduce_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c
      .execute('CREATE INDEX IF NOT EXISTS idx_bd_limit_red_nbfc ON bd_limit_reductions(company_id, nbfc_id)')
      .catch(() => {})

    console.log('[bd] tables checked/restored')
  })().catch((e: unknown) => console.error('[bd] table repair failed:', e))
  await runOnce('bd_parties_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(bd_id, party_id)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_parties_bd ON bd_parties(bd_id)')
    // Every bill already on file gets its existing single party as a link, so
    // both paths read alike from here and nothing has to be re-keyed.
    await c.execute(`INSERT OR IGNORE INTO bd_parties (bd_id, party_type, party_id)
      SELECT id, party_type, party_id FROM bill_discountings WHERE party_id IS NOT NULL`)
  }).catch((e) => console.error('[bd] parties schema failed:', e))
  // How the open amount is divided between the parties on one bill. A facility
  // drawn on invoices from three suppliers is not three equal shares, so the
  // split is recorded rather than assumed.
  await runOnce('bd_party_amount_v1', async () => {
    const c = getClient()
    // Already added, not-null, by bd_tables_repair_v1 above on a database that
    // never had this column — which every one built from nothing now is.
    await c.execute('ALTER TABLE bd_parties ADD COLUMN amount REAL NOT NULL DEFAULT 0').catch((e) => {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e
    })
  }).catch((e) => console.error('[bd] party split failed:', e))
  // A FOR delivery is weighed again at the customer's end, and a little is
  // always lost in transit — so a tolerance is agreed and only the shortage
  // BEYOND it is anybody's fault. The purchase side has carried this since the
  // beginning; the sales side had the weighbridge figure and no allowance to
  // judge it against. Nullable on both, so every existing invoice and bargain
  // keeps falling back to the mill-wide default exactly as it does today.
  await runOnce('sales_shortage_v1', async () => {
    const c = getClient()
    for (const t of ['sales', 'sales_bargains']) {
      // A column already there is the job already done, not a failure. Left to
      // throw, runOnce never records the marker and the whole block is retried
      // -- and logged -- on every launch for the life of the install.
      await c
        .execute(`ALTER TABLE ${t} ADD COLUMN allowed_shortage_pct REAL`)
        .catch((e) => {
          if (!/duplicate column/i.test(String((e as Error).message))) throw e
        })
    }
  }).catch((e) => console.error('[sales] shortage allowance failed:', e))
  // A hand-typed fix to a packed count and a real day's packing are two
  // different events, and the register could not tell them apart -- it guessed
  // from the sign, so a correction that ADDED stock passed for production.
  // Recorded explicitly from here on, with who made it. Nullable, so every
  // existing row keeps being read by the old guess and nothing restates itself.
  await runOnce('sku_adj_kind_v1', async () => {
    const c = getClient()
    for (const col of ['kind TEXT', 'created_by TEXT']) {
      await c.execute(`ALTER TABLE sku_adjustments ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
  }).catch((e) => console.error('[sku] adjustment kind failed:', e))
  // The purchase rate used to be rounded UP to the whole rupee, always and
  // invisibly, because that is how the supplier bills. It is not how every
  // supplier bills, so it is a figure now rather than a rule: a per-unit
  // adjustment the user sets, nil by default.
  //
  // NULL is left meaning "the old ceiling", so not one existing purchase moves
  // by a paisa and none of them need writing to. New entries always state it.
  await runOnce('order_rate_round_v1', async () => {
    await getClient()
      .execute('ALTER TABLE orders ADD COLUMN rate_round_off REAL')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[orders] rate rounding failed:', e))
  // A shortage can be settled two ways and must never be settled both: netted
  // off the transporter's freight bill, or claimed on its own debit note. This
  // records which note claimed it, and NULL means it is still just a deduction
  // waiting on the bill.
  await runOnce('tledger_note_v1', async () => {
    await getClient()
      .execute('ALTER TABLE transporter_ledger ADD COLUMN note_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[freight] penalty note link failed:', e))
  // The freight registers filter transporter_ledger by company and entry type
  // on every refresh, and neither led an index — so both sides scanned the
  // whole ledger to find their handful of rows.
  await runOnce('tledger_company_idx_v1', async () => {
    await getClient().execute(
      'CREATE INDEX IF NOT EXISTS idx_tl_company_type ON transporter_ledger(company_id, entry_type)'
    )
  }).catch((e) => console.error('[freight] ledger index failed:', e))
  // A shortage beyond tolerance is not always the transporter's doing. When it
  // is written off instead of claimed, the register has to say so, say who
  // decided and why, and stop the line netting off their bill.
  await runOnce('tledger_waived_v1', async () => {
    const c = getClient()
    for (const col of ['waived_at TEXT', 'waived_by TEXT', 'waived_reason TEXT', 'waived_entry_id INTEGER']) {
      await c.execute(`ALTER TABLE transporter_ledger ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
  }).catch((e) => console.error('[freight] waiver columns failed:', e))
  // The gate register is read on every refresh, and a user held to a moving
  // window now bounds it by date. Small today at 246 rows; indexed before it
  // is not.
  await runOnce('gate_date_idx_v1', async () => {
    await getClient().execute('CREATE INDEX IF NOT EXISTS idx_gate_date ON gate_entries(entry_date)')
  }).catch((e) => console.error('[gate] date index failed:', e))
  // Books beginning from: one opening figure per ledger stands in for
  // everything before the cutoff. Per company, since the two books can start on
  // different days.
  // The fee journal an LC repayment now raises alongside its payment voucher.
  // The payout voucher a preclosure raises when the rebate is passed to the
  // supplier — separate from the reversal, so it needs its own handle to be
  // undone by.
  // The commission voucher an LC raises when the bank opens it.
  await runOnce('lc_charges_je_v1', async () => {
    await getClient()
      .execute('ALTER TABLE letters_of_credit ADD COLUMN charges_journal_entry_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[lc] charges journal column failed:', e))
  await runOnce('lc_preclose_payout_je_v1', async () => {
    await getClient()
      .execute('ALTER TABLE letters_of_credit ADD COLUMN preclose_payout_journal_entry_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[lc] preclose payout column failed:', e))
  await runOnce('lc_fee_je_v1', async () => {
    await getClient()
      .execute('ALTER TABLE lc_repayments ADD COLUMN fee_journal_entry_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
  }).catch((e) => console.error('[lc] fee journal column failed:', e))
  await runOnce('ledger_openings_v1', async () => {
    await getClient().execute(`CREATE TABLE IF NOT EXISTS ledger_openings (
      company_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      dr REAL NOT NULL DEFAULT 0,
      cr REAL NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (company_id, account_id)
    )`)
  }).catch((e) => console.error('[openings] table failed:', e))

  // ---------------------------------------------------------------- factories
  // Stock and production are PHYSICAL: they happen at a site, not in a set of
  // books. Two companies can trade through one plant — one buying, one
  // manufacturing — and the oil in the tank belongs to the tank, not to
  // whichever company's ledger it was booked under.
  //
  // A factory is therefore just a named site with companies attached. There is
  // deliberately NO factory_id on orders, sales or production: stockLevels()
  // already filters by company_id IN (...), so a factory resolves to its
  // companies and the existing filters do the work. A factory stamped on the
  // movement row could disagree with the company's own factory; a lookup
  // cannot.
  await runOnce('factories_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS factories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      location TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c
      .execute('ALTER TABLE companies ADD COLUMN factory_id INTEGER REFERENCES factories(id)')
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    await c.execute('CREATE INDEX IF NOT EXISTS idx_companies_factory ON companies(factory_id)')
  }).catch((e) => console.error('[factory] table failed:', e))

  // Every existing company runs out of the one plant that exists today, so
  // they all land on it. Named Ghaziabad because that is the site; rename it
  // in Settings without touching anything that points at it.
  //
  // Guarded on there being no factories at all rather than on runOnce alone:
  // if someone has already created their own, this must not add a second.
  await runOnce('factory_backfill_v1', async () => {
    const c = getClient()
    const have = await c.execute('SELECT COUNT(*) AS n FROM factories')
    if (!Number(have.rows[0]?.n)) {
      await c.execute({
        sql: 'INSERT INTO factories (name, location) VALUES (?, ?)',
        args: ['Factory 1', null]
      })
    }
    const first = await c.execute('SELECT id FROM factories ORDER BY id LIMIT 1')
    const fid = Number(first.rows[0]?.id || 0)
    if (fid) {
      await c.execute({
        sql: 'UPDATE companies SET factory_id = ? WHERE factory_id IS NULL',
        args: [fid]
      })
    }
  }).catch((e) => console.error('[factory] backfill failed:', e))

  // The first cut of this seeded the site by name. It is renamed from Settings
  // once the real one is decided, so the seed is a placeholder now — and any
  // database that already took the old name gets it back, unless someone has
  // since renamed it themselves.
  await runOnce('factory_rename_placeholder_v1', async () => {
    await getClient().execute({
      sql: "UPDATE factories SET name = ?, location = NULL WHERE name = 'Ghaziabad'",
      args: ['Factory 1']
    })
  }).catch((e) => console.error('[factory] rename failed:', e))

  // Opening stock belongs to the FACTORY, not to a company. It is the oil
  // standing in the tank on the day the books opened, and the tank does not
  // know which company paid for it.
  //
  // This also settles an arithmetic problem the company-level version had. The
  // register cuts history at the opening date, but only when every company in
  // view has an opening of its own — otherwise one company's later start would
  // truncate another's history. With two companies at one site and an opening
  // on only one of them, that rule dropped the cut entirely and replayed the
  // pre-opening movements on top of the opening balance. Keyed to the factory
  // there is exactly one opening set per site, so the cut is always defined.
  await runOnce('stock_openings_factory_v1', async () => {
    const c = getClient()
    for (const t of ['stock_openings', 'sku_openings']) {
      await c
        .execute(`ALTER TABLE ${t} ADD COLUMN factory_id INTEGER`)
        .catch((e: unknown) => {
          if (!/duplicate column/i.test(String((e as Error).message))) throw e
        })
      // Each existing row inherits the factory of the company that wrote it,
      // so nothing has to be re-entered.
      await c.execute(
        `UPDATE ${t} SET factory_id = (SELECT co.factory_id FROM companies co WHERE co.id = ${t}.company_id)
          WHERE factory_id IS NULL`
      )
      await c.execute(`CREATE INDEX IF NOT EXISTS idx_${t}_factory ON ${t}(factory_id)`)
    }
  }).catch((e) => console.error('[stock] openings factory column failed:', e))

  // Production belongs to the FACTORY outright, not to the company that
  // happened to book it. Until now the register found a site's batches by
  // asking which companies belong to it — true, but indirect, and it left the
  // page offering a company filter for something that is not a company fact.
  //
  // company_id stays on every row: it still records whose books the batch was
  // costed into, which is what keeps valuation per company.
  await runOnce('production_factory_v1', async () => {
    const c = getClient()
    await c
      .execute('ALTER TABLE production ADD COLUMN factory_id INTEGER')
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    // Each existing batch inherits the factory of the company that booked it,
    // so nothing has to be re-entered and no run changes hands.
    await c.execute(
      `UPDATE production SET factory_id = (SELECT co.factory_id FROM companies co WHERE co.id = production.company_id)
        WHERE factory_id IS NULL`
    )
    await c.execute('CREATE INDEX IF NOT EXISTS idx_production_factory ON production(factory_id)')
  }).catch((e) => console.error('[production] factory column failed:', e))

  // A product that is real but never stands in a tank — packaging, a service
  // line, a name kept only so an old document still resolves — was still a row
  // on both stock sheets, at nil, forever. Forty-one products with eleven
  // permanently at zero makes the sheet longer than the work in it.
  //
  // Hiding is not deleting and not deactivating: an inactive product leaves
  // the dropdowns and stops being usable, which is far too blunt for something
  // you still buy every week. This says only "do not carry a stock balance
  // for it", and it can be turned back on from Products at any time.
  //
  // Defaults to 1 so every existing product keeps showing until somebody says
  // otherwise — the migration changes nothing on its own.
  await runOnce('products_show_in_stock_v1', async () => {
    const c = getClient()
    await c
      .execute('ALTER TABLE products ADD COLUMN show_in_stock INTEGER NOT NULL DEFAULT 1')
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    await c.execute('UPDATE products SET show_in_stock = 1 WHERE show_in_stock IS NULL')
  }).catch((e) => console.error('[products] show_in_stock column failed:', e))

  // A product that trades on BOTH sides, whatever its sub-category says.
  //
  // The two sides are gated by products.category, not by the Category
  // master's applies_to: a purchase bargain offers only `raw`, a sale invoice
  // only `finished`. That is right for a mill — you buy the raw oil and sell
  // what you refined — and wrong the moment the same product is traded. RPS is
  // filed `finished` because the mill makes it, and it is also BOUGHT for
  // trading, so it could not be put on a purchase bargain at all.
  //
  // This is the per-product escape hatch for exactly that: on, and the product
  // is offered on the purchase side AND the sales side. It is the product-level
  // twin of the Category master's "Used for: Both", and it overrides the
  // sub-category gate rather than the master.
  //
  // Deliberately nothing to do with stock. Stock groups by sub-category and
  // material type and never reads this column, so a flagged product stays in
  // exactly the Raw/Intermediate/Finished sheet it sits in today.
  //
  // Defaults to 0, so the migration changes nothing until somebody turns it on.
  await runOnce('products_use_both_v1', async () => {
    const c = getClient()
    await c
      .execute('ALTER TABLE products ADD COLUMN use_both INTEGER NOT NULL DEFAULT 0')
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    await c.execute('UPDATE products SET use_both = 0 WHERE use_both IS NULL')
  }).catch((e) => console.error('[products] use_both column failed:', e))

  // WHEN a line was written into the gate diary.
  //
  // The diary is counted in rounds — 8 AM, 4 PM, 8 PM — and the round is the
  // only time it carried. So a line added at 8:07 and one added at 11:40 both
  // read as "8 AM round", and nothing on the screen said which of two
  // supervisors wrote what, or how long after the count a lorry was added.
  //
  // created_at cannot answer it: SQLite's datetime('now') is UTC, so the row
  // written at 08:07 IST is stamped 02:37. Same trap as the gate times, and
  // the same fix — the clock comes from JS, in the zone the app is pinned to.
  //
  // Existing rows are backfilled by converting their UTC created_at through
  // that same pinned zone rather than by adding a hardcoded 5.5 hours, so the
  // eleven lines already in the diary get their real wall-clock time and the
  // conversion stays right if the mill is ever read from elsewhere.
  await runOnce('outside_tanker_entry_time_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE outside_tankers ADD COLUMN entry_time TEXT').catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e
    })
    const rows = await c.execute(
      "SELECT id, created_at FROM outside_tankers WHERE COALESCE(entry_time, '') = '' AND created_at IS NOT NULL"
    )
    let done = 0
    for (const r of rows.rows) {
      // 'Z' because the stored stamp is UTC without saying so.
      const d = new Date(`${String(r.created_at).replace(' ', 'T')}Z`)
      if (Number.isNaN(d.getTime())) continue
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      await c.execute({ sql: 'UPDATE outside_tankers SET entry_time = ? WHERE id = ?', args: [hhmm, Number(r.id)] })
      done += 1
    }
    if (done) console.log(`[outside] entry_time backfilled on ${done} diary line(s) from their UTC created_at`)
  }).catch((e) => console.error('[outside] entry_time column failed:', e))

  // What each lab reading is MEASURED IN.
  //
  // The desk printed a fixed "%" beside every reading and carried a footnote
  // apologising for it — "melting point is in degrees, so read that one as the
  // figure the lab gave". Which is a note asking the reader to ignore what the
  // screen says. A tanker's readings are three different kinds of quantity:
  // FFA and moisture are percentages, melting point is degrees, and colour is
  // a bare Lovibond figure with no unit at all.
  //
  // Defaults to '%' so every reading already on the books keeps exactly the
  // suffix it is displayed with today — the migration changes nothing on
  // screen, and a wrong one is now correctable instead of being explained away
  // in a footnote.
  await runOnce('quality_unit_v1', async () => {
    const c = getClient()
    for (const t of ['tanker_quality', 'order_quality']) {
      await c
        .execute(`ALTER TABLE ${t} ADD COLUMN unit TEXT NOT NULL DEFAULT '%'`)
        .catch((e: unknown) => {
          if (!/duplicate column/i.test(String((e as Error).message))) throw e
        })
      await c.execute(`UPDATE ${t} SET unit = '%' WHERE unit IS NULL`)
    }
  }).catch((e) => console.error('[quality] unit column failed:', e))

  // SELLING TO OURSELVES.
  //
  // Two companies on one site trade with each other: KR FOODS sells oil to KR
  // FINMARK, and that is a sale in one set of books and a purchase in the
  // other — two documents, raised together, for one movement of goods.
  //
  // Three things are needed for that and none of them existed:
  //   companies.gst_pct / tds_pct   the terms an inter-company invoice is
  //                                 raised on, kept with the company rather
  //                                 than typed again on every transfer;
  //   *.company_link_id             the customer and supplier rows that stand
  //                                 for a company of ours, so the ledgers,
  //                                 bill-wise and TDS machinery all work
  //                                 unchanged — they only need a party;
  //   orders.intercompany_sale_id   which sale raised this purchase, so the
  //                                 two stay in step when one is edited and
  //                                 neither is left orphaned when it is not.
  await runOnce('intercompany_sales_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE companies ADD COLUMN gst_pct REAL NOT NULL DEFAULT 0')
    await add('ALTER TABLE companies ADD COLUMN tds_pct REAL NOT NULL DEFAULT 0')

    await add('ALTER TABLE customers ADD COLUMN company_link_id INTEGER')
    await add('ALTER TABLE suppliers ADD COLUMN company_link_id INTEGER')
    await add('ALTER TABLE orders ADD COLUMN intercompany_sale_id INTEGER')
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_orders_intercompany ON orders(intercompany_sale_id)'
    )
  }).catch((e) => console.error('[intercompany] columns failed:', e))

  // A COMPANY INVOICING ANOTHER IS A PARTY LIKE ANY OTHER.
  //
  // So it carries what any party carries — a GSTIN, a state, and the TDS terms
  // INCLUDING the slab, which is the part that decides whether TDS is withheld
  // at all. A rate with no threshold beside it withholds from the first rupee,
  // which is neither how the law reads nor how the customer master is set up.
  //
  // Its own key rather than more statements inside intercompany_sales_v1: that
  // one has already run on every database that has seen this feature, and a
  // runOnce that has run is never opened again — statements added to it would
  // take effect on new databases only, which is the worst of both.
  await runOnce('intercompany_company_terms_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE companies ADD COLUMN gstin TEXT')
    await add('ALTER TABLE companies ADD COLUMN state TEXT')
    // The customer master's own defaults: 0.1% past 50,00,000 in the financial
    // year, the slab itself exempt.
    await add('ALTER TABLE companies ADD COLUMN tds_threshold REAL NOT NULL DEFAULT 5000000')
    await add('ALTER TABLE companies ADD COLUMN tds_above_only INTEGER NOT NULL DEFAULT 1')
    await add('ALTER TABLE companies ADD COLUMN credit_period_days INTEGER NOT NULL DEFAULT 0')
  }).catch((e) => console.error('[intercompany] company terms failed:', e))

  // WHAT THE SLAB HAS ALREADY SEEN.
  //
  // TDS is withheld on turnover past a threshold for the financial year, so a
  // party set up mid-year has to be told what it had already billed before the
  // books began — otherwise the slab restarts at zero and nothing is withheld
  // until the threshold is crossed a second time. The supplier master has
  // carried that figure all along ("Purchase bill amount (as on)"); a company
  // trading with another needs it for the same reason.
  await runOnce('intercompany_opening_purchase_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE companies ADD COLUMN opening_purchase_amount REAL NOT NULL DEFAULT 0')
    await add('ALTER TABLE companies ADD COLUMN opening_purchase_date TEXT')
  }).catch((e) => console.error('[intercompany] opening purchase failed:', e))

  // Not runOnce: a company added later needs its party rows too, and the call
  // is idempotent — it adopts a same-named party if one already exists rather
  // than making a second. It also copies the company's terms onto those rows,
  // which is what every slab and voucher downstream actually reads.
  await ensureCompanyParties().catch((e) => console.error('[intercompany] party rows failed:', e))

  // WHICH CARGO A TANKER CAME OFF.
  //
  // Five tankers arrive from BUNGE against one parcel of oil: one LOT at the
  // port, discharged at one TERMINAL. The register knew each vehicle and knew
  // nothing of what they had in common, so reconciling with the supplier meant
  // reading tanker numbers off a sheet and grouping them by hand.
  //
  // Two labels on the deposit rather than a table of their own: a lot number is
  // something the terminal gives us, not a thing this software owns the life
  // of. Nothing hangs off them, and when something does, a table can be added
  // later with these columns still the natural key.
  await runOnce('consignment_lot_terminal_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE consignment_stock ADD COLUMN lot_no TEXT')
    await add('ALTER TABLE consignment_stock ADD COLUMN terminal_no TEXT')
    await c
      .execute('CREATE INDEX IF NOT EXISTS idx_consign_lot ON consignment_stock(company_id, lot_no)')
      .catch(() => {})
  }).catch((e) => console.error('[consignment] lot/terminal failed:', e))

  // A NOTIFICATION THAT ARRIVES WITH THE APP CLOSED.
  //
  // The bell only ever drew a banner while the page was open, which on a phone
  // is almost never — so the mill was told nothing until somebody happened to
  // look. These are the subscriptions the browsers hand over: one row per
  // device, with the endpoint its push service listens on and the two keys the
  // payload is encrypted to. The endpoint is unique because it IS the device;
  // re-subscribing the same browser must update the row, not add a second.
  await runOnce('push_subscriptions_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT,
      last_ok_at TEXT,
      failed_at TEXT
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)')
  }).catch((e) => console.error('[push] subscriptions table failed:', e))

  // A BATCH MIXED FOR ITSELF.
  //
  // With formulation-based production switched off (Settings), a run is not
  // struck on a saved recipe — the operator composes the mix at the sheet. The
  // arithmetic is unchanged; what changes is where the lines came from, and
  // that they belong to that run alone. Kept on the row for the same reason a
  // saved recipe pins its version: an edit has to re-expand exactly what was
  // booked, and there is no master to go back to.
  await runOnce('production_custom_mix_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE production ADD COLUMN custom_items_json TEXT').catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e
    })
  }).catch((e) => console.error('[production] custom mix column failed:', e))

  // A DAY THAT CLOSED WITH WORK STILL IN IT.
  //
  // The board is today's, and a checklist anybody can back-fill at will
  // records nothing worth having. So a closed day is asked for: one login, one
  // date, an admin's answer. Ticks made afterwards still carry the moment they
  // were actually made — this reopens the door, it does not backdate anything.
  await runOnce('work_day_requests_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS work_day_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      reason TEXT,
      -- pending | approved | refused
      state TEXT NOT NULL DEFAULT 'pending',
      decided_by INTEGER,
      decided_at TEXT,
      decided_note TEXT,
      created_at TEXT,
      -- One live ask per person per day: asking twice is the same ask, and a
      -- day already open must not be shut by re-asking.
      UNIQUE(user_id, work_date)
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_work_day_req ON work_day_requests(state, work_date)')
  }).catch((e) => console.error('[work] day requests failed:', e))

  // WHICH PURCHASES ARE THE OTHER HALF OF ONE SALES INVOICE.
  //
  // A transfer of three products raises three purchases here, because a
  // purchase row is one product — but it is ONE invoice, with one number, and
  // all three carry it. The Purchases form refuses a number another row
  // already has, which is right for two unrelated bills and wrong for these:
  // they are not two bills, they are one bill in three rows.
  //
  // So they are stamped with the sales invoice's own group and the clash check
  // lets that group share a number. Null on every ordinary purchase, which
  // keeps the rule exactly as it was for them.
  await runOnce('intercompany_invoice_group_v1', async () => {
    await getClient()
      .execute('ALTER TABLE orders ADD COLUMN intercompany_group TEXT')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[intercompany] invoice group failed:', e))

  // AN OPENING'S PP BREAKDOWN IS PART OF THE OPENING.
  //
  // stock_opening_pp holds one live row per product and vessel — qty and FFA —
  // with no date on it at all. Striking the opening again overwrote it, so the
  // history could say what the tanks held on the 13th but not what was in
  // which vessel, nor at what FFA. That is the part somebody actually goes
  // back for: a blend is argued about by its FFA, not by its tonnage.
  //
  // Filed alongside the set it belongs to, so every opening ever struck keeps
  // its own breakdown — the ones carrying FFA and the ones that never did.
  await runOnce('stock_opening_set_pp_v1', async () => {
    await getClient().execute(
      `CREATE TABLE IF NOT EXISTS stock_opening_set_pp (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         set_id INTEGER NOT NULL,
         product_id INTEGER,
         stage_id INTEGER,
         qty REAL,
         ffa REAL,
         formulation_id INTEGER
       )`
    )
    await getClient().execute(
      'CREATE INDEX IF NOT EXISTS idx_opening_set_pp ON stock_opening_set_pp(set_id)'
    )
  }).catch((e) => console.error('[stock] opening PP history failed:', e))

  // AN LC PAID AND REPAID IN PARTS — one row per part: its LC amount, its own
  // maturity and interest, and when the bank was repaid for it. New table, so
  // no LC already on the books changes. See lc.ts.
  await getClient()
    .execute(`CREATE TABLE IF NOT EXISTS lc_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lc_id INTEGER NOT NULL,
      part_no INTEGER NOT NULL,
      pay_date TEXT NOT NULL,
      amount REAL NOT NULL,
      maturity_date TEXT NOT NULL,
      days INTEGER NOT NULL DEFAULT 0,
      interest REAL NOT NULL DEFAULT 0,
      charges REAL NOT NULL DEFAULT 0,
      net REAL NOT NULL DEFAULT 0,
      repayment_id INTEGER,
      repaid_date TEXT,
      rebate REAL NOT NULL DEFAULT 0,
      rebate_route TEXT,
      rebate_journal_entry_id INTEGER,
      rebate_payout_journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (lc_id, part_no)
    )`)
    .catch((e: unknown) => console.error('[lc] lc_parts table failed:', e))
  // THE SWITCH FOR SELLING ON AT EMPTY (onwardSale.ts). On for every company
  // by default — it only ever acts on a Trading one — so nothing changes until
  // somebody turns it off under Companies.
  await getClient()
    .execute('ALTER TABLE companies ADD COLUMN onward_sale_at_empty INTEGER NOT NULL DEFAULT 1')
    .catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) console.error('[companies] onward_sale_at_empty failed:', e)
    })
  // Each part's own interest and margin rate. NULL on every part already paid,
  // which reads as the LC's own rate — so no existing part's figures move.
  for (const col of ['interest_pct REAL', 'margin_pct REAL']) {
    await getClient()
      .execute(`ALTER TABLE lc_parts ADD COLUMN ${col}`)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error('[lc] lc_parts rate column failed:', e)
      })
  }
  await getClient()
    .execute('ALTER TABLE letters_of_credit ADD COLUMN preclose_parts_repayment_id INTEGER')
    .catch((e: unknown) => {
      if (!/duplicate column/i.test(String((e as Error).message))) console.error('[lc] parts closure column failed:', e)
    })
  // PP vessel Y/N — does production use it? 1 = yes, which is what every
  // vessel counted before this was. On the live breakdown and its history.
  for (const sql of [
    'ALTER TABLE stock_opening_pp ADD COLUMN in_use INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE stock_opening_set_pp ADD COLUMN in_use INTEGER NOT NULL DEFAULT 1'
  ]) {
    await getClient()
      .execute(sql)
      .catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) console.error('[stock] in_use column failed:', e)
      })
  }

  // HOW THE MONEY CAME BACK, not only that it did.
  //
  // A payment IN was an amount and a date. "Has the customer paid?" was
  // answerable; "how did it reach us — RTGS, a cheque, an adjustment?" was
  // not, and that is the question asked when a receipt is being matched
  // against a bank statement. Null on every receipt already recorded, which
  // reads as "not stated" rather than inventing a method for it.
  // WHICH ACCOUNT IT LANDED IN, AND WHAT THE BANK CALLED IT.
  //
  // The receipt already said how much and by what route; it could not say
  // WHERE, so every payment IN was debited to the one generic BANK A/C and a
  // desk reconciling three banks had nothing to go on. The reference is the
  // other half of the same question: a UTR or cheque number is what a line on
  // the statement is found by. Null on everything already recorded, which
  // reads as "not stated" rather than inventing a bank for it.
  await runOnce('bd_payment_in_account_ref_v1', async () => {
    for (const sql of [
      'ALTER TABLE bd_payment_ins ADD COLUMN account TEXT',
      'ALTER TABLE bd_payment_ins ADD COLUMN ref_no TEXT'
    ]) {
      await getClient()
        .execute(sql)
        .catch((e) => {
          if (!/duplicate column/i.test(String(e?.message || e))) throw e
        })
    }
  }).catch((e) => console.error('[bd] payment-in account/ref failed:', e))

  await runOnce('bd_payment_in_method_v1', async () => {
    await getClient()
      .execute('ALTER TABLE bd_payment_ins ADD COLUMN method TEXT')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[bd] payment-in method failed:', e))

  // Move each NBFC's discounted-bill liability onto its own ledger, off the
  // one shared BILLS DISCOUNTED A/C. See migrateBdPerNbfcLedgers.
  await runOnce('bd_per_nbfc_ledger_v1', async () => {
    const out = await migrateBdPerNbfcLedgers()
    if (out.moved) {
      console.log(`[bd] moved ${out.moved} line(s) onto ${out.ledgers} per-NBFC ledger(s)`)
    }
  }).catch((e) => console.error('[bd] per-NBFC ledger migration failed:', e))

  // ONE BILL, SEVERAL PURCHASE ROWS — WHATEVER PUT THEM THERE.
  //
  // intercompany_group was added for transfers, where a sale of three products
  // raises three purchases under one number. A supplier's own invoice can cover
  // tankers of several products and lands in exactly the same shape, so the
  // grouping is no longer about inter-company anything.
  //
  // Renamed by adding the honest column and copying into it, rather than by
  // ALTER ... RENAME: a rename is one statement on a table the mill is writing
  // to, and the old column costs nothing left where it is. Every reader moves
  // to bill_group; intercompany_group is never read again.
  await runOnce('orders_bill_group_v1', async () => {
    const c = getClient()
    await c.execute('ALTER TABLE orders ADD COLUMN bill_group TEXT').catch((e) => {
      if (!/duplicate column/i.test(String(e?.message || e))) throw e
    })
    await c
      .execute(
        `UPDATE orders SET bill_group = intercompany_group
          WHERE bill_group IS NULL AND TRIM(COALESCE(intercompany_group,'')) <> ''`
      )
      .catch((e) => console.error('[orders] bill group backfill:', e))
  }).catch((e) => console.error('[orders] bill group failed:', e))

  // A BROKER IS PAID ONE WAY OR THE OTHER, AND THE MASTER SHOULD SAY WHICH.
  //
  // Brokerage came as a percentage and nothing else, which is only half the
  // trade: plenty of brokers here are engaged at so many rupees a tonne, and
  // recording that as a percentage means working it out against a value that
  // is not agreed yet — and writing down a figure nobody shook hands on.
  //
  // So both are kept, and neither is required. A broker quoted at 0.25% has a
  // percentage and no rate; one at Rs 15 a tonne has a rate and no percentage;
  // one paid partly each way has both, which is exactly what the two boxes
  // then say. Existing brokers keep their percentage untouched and open with
  // a rate of nothing, which is what they were always worth.
  await runOnce('broker_rupee_rate_v1', async () => {
    await getClient()
      .execute('ALTER TABLE brokers ADD COLUMN brokerage_rate REAL NOT NULL DEFAULT 0')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[brokers] rupee brokerage failed:', e))

  // WHAT A LINE IS MADE OF.
  //
  // SALARY A/C 20,000 against BANK A/C is a true posting and a poor record: it
  // is four people, or basic and HRA and an allowance, and a month later
  // nobody can say which. The ledger is right either way — this does not move
  // a rupee and does not touch the double entry — but the voucher can now
  // carry the breakdown that produced the figure, and hand it back when the
  // voucher is read again.
  //
  // A memo, deliberately. Splitting into real ledger postings is what extra
  // journal lines are FOR; what was missing was somewhere to write down how
  // one line's own total was arrived at.
  await runOnce('journal_line_splits_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS journal_line_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_jl_splits ON journal_line_splits(line_id)')
  }).catch((e) => console.error('[accounts] line breakdown table failed:', e))

  // ONE LINE, ONE PERSON — WHERE THAT IS WHAT IS MEANT.
  //
  // A checklist line is written against a PAGE and asked of everyone who can
  // open it, which is what makes the catalogue worth having: nobody is named,
  // and a staff change needs no thought. But some jobs on a shared page belong
  // to one desk — three people can open Stock and only one of them dips the
  // tanks — and until now the only way to say so was to assign a one-off every
  // single day.
  //
  // So a line may name a login. Null, which every existing line is, means what
  // it has always meant: everyone who can open that page. Named, it is asked
  // of that person ALONE — and still only if they can open the page, so this
  // narrows the reach and can never widen it past what access allows.
  await runOnce('work_process_person_v1', async () => {
    await getClient()
      .execute('ALTER TABLE work_processes ADD COLUMN user_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[work] per-person line failed:', e))

  // THE SAME DOOR, OPENED FROM THE OTHER SIDE.
  //
  // An admin can now open a closed day without waiting to be asked, and it
  // writes the very same row — already approved — so nothing that reads this
  // table has to learn a second shape. This flag exists for one job only:
  // shutting it again. A day nobody asked for is withdrawn outright, while a
  // day that WAS asked for is refused, because an ask is owed an answer.
  await runOnce('work_day_admin_open_v1', async () => {
    await getClient()
      .execute('ALTER TABLE work_day_requests ADD COLUMN opened_by_admin INTEGER NOT NULL DEFAULT 0')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
  }).catch((e) => console.error('[work] admin-opened day flag failed:', e))

  // AN INVOICE WITH NOTHING TO SAMPLE.
  //
  // The flask on the Purchases register goes amber the moment a load is
  // emptied without a lab reading against it, and stays amber for ever. That
  // is right for a tanker of oil and wrong for a transfer between our own
  // companies, which has no sample to take — and a warning that can never be
  // cleared is a warning everybody learns to ignore. These let the desk answer
  // "not needed for this transaction", with the reason and the moment it was
  // said, and take it back again.
  await runOnce('orders_quality_waived_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE orders ADD COLUMN quality_waived INTEGER NOT NULL DEFAULT 0')
    await add('ALTER TABLE orders ADD COLUMN quality_waived_note TEXT')
    await add('ALTER TABLE orders ADD COLUMN quality_waived_at TEXT')
  }).catch((e) => console.error('[orders] quality waiver failed:', e))

  // TREASURY IS THREE DESKS, AND ITS CHECKLIST SHOULD BE TOO.
  //
  // The seed asked one line of "Treasury": check the LCs and the bills. But
  // the LC desk and the discounting desk are granted separately everywhere
  // else in the app, and are frequently not the same person — so one line
  // lands on both of them asking half about somebody else's work. Split into
  // the section each half belongs to.
  //
  // Nobody loses the line: grantsOf now fills in the page↔section grants the
  // rest of the app already infers, so a login holding only the old Treasury
  // permission is asked both of these.
  //
  // The combined line is switched off rather than deleted — the days it was
  // already asked on keep it, and it can be switched back on from the Task
  // list if this split is not wanted.
  await runOnce('work_treasury_sections_v1', async () => {
    const c = getClient()
    const OLD = 'Check LCs and bills maturing this week'
    const old = await c.execute({
      sql: "SELECT id, detail, sort_order FROM work_processes WHERE module = 'treasury' AND scope = '' AND title = ?",
      args: [OLD]
    })
    const row = old.rows[0] as { id?: unknown; detail?: unknown; sort_order?: unknown } | undefined
    if (!row) return
    const detail = String(row.detail ?? '') || 'Anything inside seven days needs a plan today.'
    const base = Number(row.sort_order) || 110
    const parts: [string, string, number][] = [
      ['treasuryLc', 'Check LCs maturing this week', base],
      ['treasuryBd', 'Check bills maturing this week', base + 1]
    ]
    for (const [module, title, order] of parts) {
      await c.execute({
        sql: `INSERT INTO work_processes (module, scope, title, detail, sort_order, active)
              VALUES (?, '', ?, ?, ?, 1)
              ON CONFLICT(module, scope, title) DO NOTHING`,
        args: [module, title, detail, order]
      })
    }
    // Off, and off today's boards where nobody has touched it — the same two
    // things switching a line off does by hand.
    await c.execute({ sql: 'UPDATE work_processes SET active = 0 WHERE id = ?', args: [Number(row.id)] })
    await c.execute({
      sql: `DELETE FROM work_tasks
             WHERE process_id = ? AND kind = 'auto' AND state = 'pending' AND work_date >= ?
               AND id NOT IN (SELECT task_id FROM work_notes)`,
      // TODAY ONWARDS. A past day is a record of what was asked of somebody
      // that day, ticked or not — the split changes what is asked from now on,
      // never what was.
      args: [Number(row.id), todayISO()]
    })
  }).catch((e) => console.error('[work] treasury section split failed:', e))

  // A DEADLINE PER DESK, NOT PER MILL.
  //
  // The board has always closed at one time for everybody. A weighbridge that
  // shuts at six and a billing desk still invoicing at nine are not the same
  // day, though, and one deadline across both makes the board wrong about one
  // of them — either half the team is marked late every evening, or nobody
  // ever is. NULL means this login follows the site's cut-off, which is what
  // every login does until an admin says otherwise.
  await runOnce('work_user_cutoff_v1', async () => {
    const c = getClient()
    const add = async (sql: string): Promise<void> => {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
    await add('ALTER TABLE users ADD COLUMN work_cutoff TEXT')
    await add('ALTER TABLE users ADD COLUMN work_cutoff_day TEXT')
  }).catch((e) => console.error('[work] per-user cut-off failed:', e))

  // THE STOCK DESK'S DAILY LINE, REWORDED.
  //
  // The catalogue seeds once and is never re-seeded, precisely so an admin's
  // own wording survives — which means a change to the seed reaches a new
  // database only. This carries the same change to the ones already running.
  //
  // Matched on the old wording, so a desk that had already reworded this line
  // itself keeps what it wrote. Today's board is retitled with it, but only
  // the rows still untouched: a task already ticked, approved or sent back is
  // a record of what was asked at the time, and past days are left as they
  // were read.
  await runOnce('work_stock_receiving_title_v1', async () => {
    const c = getClient()
    const OLD = 'Enter the day-close count'
    const NEW = 'View the receiving stocks'
    const DETAIL = 'What came in today against the book figure, with a note on any difference.'
    // (module, scope, title) is unique — if the new wording is somehow already
    // in the catalogue, the rename would collide, so it is simply skipped.
    const taken = await c.execute({
      sql: "SELECT COUNT(*) AS k FROM work_processes WHERE module = 'stock' AND scope = '' AND title = ?",
      args: [NEW]
    })
    if (Number(taken.rows[0]?.k) > 0) return
    await c.execute({
      sql: "UPDATE work_processes SET title = ?, detail = ? WHERE module = 'stock' AND scope = '' AND title = ?",
      args: [NEW, DETAIL, OLD]
    })
    await c.execute({
      sql: `UPDATE work_tasks SET title = ?, detail = ?
             WHERE title = ? AND kind = 'auto' AND state = 'pending' AND work_date >= ?`,
      args: [NEW, DETAIL, OLD, todayISO()]
    })
  }).catch((e) => console.error('[work] stock process rename failed:', e))

  // A TANKER THAT ARRIVED AS MORE THAN ONE PARCEL.
  //
  // A load is not always one homogeneous lot: a tanker with two compartments,
  // or one filled at two points, is sampled parcel by parcel and comes back
  // with two FFAs rather than one. Recording that as a single reading meant
  // somebody averaging in their head at the desk and typing the result, which
  // is the arithmetic — and the audit trail — this table exists to keep.
  //
  // part_no 0 is the whole load, which is what every reading already on the
  // books is and what an unsplit load keeps writing. So the migration changes
  // nothing that exists: it only makes room for what could not be said before.
  await runOnce('quality_parts_v1', async () => {
    const c = getClient()
    for (const t of ['tanker_quality', 'order_quality']) {
      for (const col of ['part_no INTEGER NOT NULL DEFAULT 0', 'part_qty TEXT']) {
        await c.execute(`ALTER TABLE ${t} ADD COLUMN ${col}`).catch((e: unknown) => {
          if (!/duplicate column/i.test(String((e as Error).message))) throw e
        })
      }
    }
  }).catch((e) => console.error('[quality] part columns failed:', e))

  // The gate supervisor's diary of what is standing OUTSIDE the gate — see
  // outsidetankers.ts for why this is not a flag on gate_entries.
  await runOnce('outside_tankers_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS outside_tankers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      log_date TEXT NOT NULL,
      slot TEXT NOT NULL,
      kind TEXT NOT NULL,
      product_id INTEGER,
      party_id INTEGER,
      tankers INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_outside_tankers_day ON outside_tankers(company_id, log_date)'
    )
  }).catch((e) => console.error('[gate] outside tanker diary failed:', e))

  // The diary asked which PRODUCT was standing outside. Nobody counting lorries
  // from the gate knows whether the load is RPS or CPO — they know it is oil,
  // or husk, or packaging. It asks for the category now, which is the same
  // master Gate Entry's Rec type reads.
  //
  // product_id is left in place rather than dropped: a line already logged
  // against a product must stay readable, and the list falls back to its name.
  await runOnce('outside_tankers_category_v1', async () => {
    await getClient()
      .execute('ALTER TABLE outside_tankers ADD COLUMN category TEXT')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
  }).catch((e) => console.error('[gate] outside tanker category failed:', e))

  // "No gate-out will ever be recorded against this invoice."
  //
  // The Gate Out queue is every dispatched invoice with no weighed exit, which
  // is right for today and wrong for history — invoices billed before the gate
  // register existed, or collected on the customer's own vehicle, sit in it
  // forever and make the list useless as a to-do.
  //
  // Its own pair of columns, deliberately not sales.rejected_at: that one means
  // the customer refused the invoice and the Sales register prints it as
  // "Cancelled". Clearing a gate queue must not restate a delivered sale.
  await runOnce('sales_gate_out_waiver_v1', async () => {
    const c = getClient()
    for (const col of ['gate_out_waived_at TEXT', 'gate_out_waived_reason TEXT']) {
      await c.execute(`ALTER TABLE sales ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
    }
  }).catch((e) => console.error('[gate] gate-out waiver columns failed:', e))

  // The notification store.
  //
  // Three tables and a reason for each. `notifications` is one row per FACT the
  // app wants to state, keyed by dedupe_key so a rule can be re-evaluated as
  // often as we like without the bell filling with the same sentence.
  // `notification_reads` is per user, because read is a property of a person
  // and not of the message — which is also what finally makes "mark unread"
  // possible, something the old localStorage key list could never do.
  // `notification_rules` holds only what has been CHANGED from the catalogue in
  // notify.ts, so a default that is later improved reaches everyone who never
  // touched it.
  await runOnce('notifications_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      rule_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      audience TEXT NOT NULL DEFAULT 'everyone',
      title TEXT NOT NULL,
      body TEXT,
      page TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_notifications_feed ON notifications(company_id, created_at DESC)'
    )
    await c.execute(`CREATE TABLE IF NOT EXISTS notification_reads (
      user_id INTEGER NOT NULL,
      notification_id INTEGER NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, notification_id)
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS notification_rules (
      rule_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      severity TEXT NOT NULL DEFAULT 'normal',
      audience TEXT NOT NULL DEFAULT 'everyone',
      threshold REAL,
      updated_at TEXT
    )`)
  }).catch((e) => console.error('[notify] tables failed:', e))

  // Notifications, second cut. Three things v1 got wrong.
  //
  // 1. dedupe_key was UNIQUE for all time, so a notification could never come
  //    BACK. A credit that expires, is extended, then expires again would be
  //    mentioned once and never again — and, worse, one that stopped being
  //    true stayed on the bell forever because nothing ever took it off. The
  //    key is now unique only among LIVE rows: resolving one frees the key, so
  //    the same fact becoming true again raises a fresh notification.
  //
  // 2. "Who hears it" was admins-or-everyone. A rule can now name the exact
  //    people, and the chosen list is snapshotted onto each notification as it
  //    is raised, so editing the rule later cannot rewrite who was told.
  //
  // 3. There was no "when". A rule can carry a delivery window, so a critical
  //    LC alert is not delivered at three in the morning.
  //
  // The table is rebuilt rather than altered because the UNIQUE lives in its
  // column definition and SQLite cannot drop that in place. Rows are carried
  // across, so nothing already raised is lost.
  await runOnce('notifications_v2', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS notifications_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      rule_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      audience TEXT NOT NULL DEFAULT 'everyone',
      recipients TEXT,
      title TEXT NOT NULL,
      body TEXT,
      page TEXT,
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )`)
    await c.execute(
      `INSERT INTO notifications_v2
         (id, company_id, rule_key, severity, audience, title, body, page, dedupe_key, created_at)
       SELECT id, company_id, rule_key, severity, audience, title, body, page, dedupe_key, created_at
         FROM notifications`
    ).catch(() => {})
    await c.execute('DROP TABLE IF EXISTS notifications')
    await c.execute('ALTER TABLE notifications_v2 RENAME TO notifications')
    // Unique among LIVE rows only — this is the whole point of the rebuild.
    await c.execute(
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_live ON notifications(dedupe_key) WHERE resolved_at IS NULL'
    )
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_notifications_feed ON notifications(company_id, resolved_at, created_at DESC)'
    )
    for (const col of ['recipients TEXT', 'window_from TEXT', 'window_to TEXT']) {
      await c.execute(`ALTER TABLE notification_rules ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
    }
    // A person silencing one notification for themselves, without changing it
    // for the desk. The rule stays on; they simply stop being told.
    await c.execute(`CREATE TABLE IF NOT EXISTS notification_mutes (
      user_id INTEGER NOT NULL,
      rule_key TEXT NOT NULL,
      muted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, rule_key)
    )`)
  }).catch((e) => console.error('[notify] v2 failed:', e))

  // A desk that wants its own wording. Blank means the rule writes its own
  // sentence, which is what everyone starts with.
  await runOnce('notifications_v3_templates', async () => {
    const c = getClient()
    for (const col of ['title_tpl TEXT', 'body_tpl TEXT']) {
      await c.execute(`ALTER TABLE notification_rules ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
    }
  }).catch((e) => console.error('[notify] message templates failed:', e))

  // Readings for an invoice with no tanker to hang them on.
  //
  // A consignment purchase is drawn from stock already in the yard: there is
  // no tanker, so there was nowhere for its lab result to go and the register
  // showed every one of those invoices as having nothing to record. Its own
  // table rather than a nullable order_id on tanker_quality — tanker_id there
  // is NOT NULL, and relaxing it means rebuilding the table for a second key
  // that is never set on the same row.
  await runOnce('order_quality_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS order_quality (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_order_quality_order ON order_quality(order_id)')
  }).catch((e) => console.error('[orders] order quality table failed:', e))

  // Why an EX tanker moved with no freight. A zero with a reason is a
  // decision; a zero on its own is a field somebody skipped, and the two used
  // to be indistinguishable — so the field was simply required.
  await runOnce('tanker_freight_remark_v1', async () => {
    await getClient().execute('ALTER TABLE purchase_tankers ADD COLUMN freight_remark TEXT').catch((e) => {
      if (!/duplicate column/i.test(String(e))) throw e
    })
  }).catch((e) => console.error('[tankers] freight remark column failed:', e))

  // The lorry receipt number, taken when the tanker sets off. It is the
  // transporter's own document for the consignment, and the one reference a
  // dispute over what left the port is argued on — so it belongs on the
  // tanker, beside the transit date it was issued with.
  await runOnce('tanker_lr_no_v1', async () => {
    await getClient().execute('ALTER TABLE purchase_tankers ADD COLUMN lr_no TEXT').catch((e) => {
      if (!/duplicate column/i.test(String(e))) throw e
    })
  }).catch((e) => console.error('[tankers] LR no column failed:', e))

  // What a PP batch used without taking it, for the runs recorded before the
  // line existed. 'pp_equiv' is the formulation's split of a with-FFA vessel
  // draw — shown in the register's Adjusted and Consumed columns at once,
  // where the two cancel. It moves nothing; a run missing it simply reads as
  // though the recipe had done nothing, which is exactly how it did read.
  await runOnce('pp_equiv_backfill_v1', async () => {
    const c = getClient()
    const runs = await c.execute(`
      SELECT p.id AS id, p.formulation_id AS fid, SUM(d.qty) AS drawn
        FROM production p
        JOIN pp_draws d ON d.production_id = p.id AND d.ffa = 'with'
       WHERE p.formulation_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM production_items i
                          WHERE i.production_id = p.id AND i.kind = 'pp_equiv')
       GROUP BY p.id`)
    for (const r of runs.rows) {
      const row = r as unknown as Record<string, unknown>
      const drawn = Number(row.drawn) || 0
      if (!(drawn > 0.0005)) continue
      const res = await c.execute({
        sql: 'SELECT * FROM formulation_items WHERE formulation_id = ?',
        args: [Number(row.fid)]
      })
      const items = res.rows.map((x) => {
        const o: Record<string, unknown> = {}
        for (const col of res.columns) o[col] = (x as unknown as Record<string, unknown>)[col]
        return o
      })
      if (!items.length) continue
      const tor = recipeTor(items)
      if (!(tor > 0)) continue
      // The output that much vessel oil yielded, then the recipe's own input
      // split of it — the same two steps expandBatchWithOutputPp takes.
      const finished = drawn / (tor / 100)
      for (const l of expandRecipe(items, finished)) {
        if (l.kind !== 'input' || !(l.qty > 0.0000005)) continue
        await c.execute({
          sql: 'INSERT INTO production_items (production_id, product_id, qty, kind) VALUES (?, ?, ?, ?)',
          args: [Number(row.id), Number(l.product_id), l.qty, 'pp_equiv']
        })
      }
      console.log(`[stock] pp_equiv backfilled on production ${row.id} (${drawn} drawn)`)
    }
  }).catch((e) => console.error('[stock] pp_equiv backfill failed:', e))

  // THE RECIPE A WITH-FFA VESSEL'S OIL IS MADE TO.
  //
  // Oil counted as PP WITH its free fatty acid still in it is not the finished
  // product it is filed under — it is the blend on the way there. Naming the
  // formulation lets the register restate it as what it actually is: the shea,
  // the RPS and the fatty oil that went into it, on the adjustment column,
  // against the finished oil coming off the same column. No production
  // happened; the tonnage is only being called by its right name.
  await runOnce('pp_formulation_v1', async () => {
    await getClient()
      .execute('ALTER TABLE stock_opening_pp ADD COLUMN formulation_id INTEGER')
      .catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
  }).catch((e) => console.error('[stock] PP formulation column failed:', e))

  // INTEREST SERVICED DURING THE TENOR.
  //
  // A discounted bill has always charged its whole interest at the start —
  // netted out of the disbursement, or settled separately once. Some NBFC
  // terms instead have the interest PAID during the tenor: monthly,
  // fortnightly, or whatever was agreed, with the principal falling due at
  // maturity on its own. Each payment is its own voucher and its own row, so
  // one can be corrected without disturbing the others.
  // AN UPFRONT LC IS TWO VOUCHERS, AND THESE WERE ONE.
  //
  // Where an LC's terms say the interest and commission are paid from our own
  // account rather than kept out of the credit, two different things happen
  // and two different parties settle them:
  //
  //   1  the bank honours the credit out of ITS funds — the supplier is
  //      discharged and the bank takes their place. Nothing of ours moves.
  //   2  the interest and the commission come out of OUR bank.
  //
  // The interest voucher was only raised when the bank statement line was
  // reconciled. Until that happened the fees rode on the settlement journal
  // instead, so both acts arrived as a single entry — which overstates the
  // bank's payable by fees it never lent, and shows no payment out of our own
  // account at all.
  //
  // refreshLcUpfrontInterest now raises the voucher on the LC's own terms, and
  // every such LC re-posts on its next save. This does that once for the ones
  // already on the books rather than waiting for somebody to open each of
  // them. postLcUpfrontInterest re-posts the settlement voucher itself, which
  // is what drops the fee lines from it — so the expense still appears exactly
  // once, on the voucher it belongs to.
  await runOnce('lc_upfront_two_vouchers_v1', async () => {
    const c = getClient()
    const res = await c.execute(
      `SELECT id, lc_no FROM letters_of_credit
        WHERE COALESCE(interest_upfront, 0) = 1
          AND interest_journal_entry_id IS NULL`
    )
    for (const row of res.rows) {
      const id = Number((row as unknown as Record<string, unknown>).id)
      const no = String((row as unknown as Record<string, unknown>).lc_no || id)
      try {
        await refreshLcUpfrontInterest(id)
        console.log(`[lc] ${no}: upfront interest moved onto its own voucher`)
      } catch (e) {
        // One bad LC must not stop the rest, and must not leave the flag
        // unset — the others are already corrected by the time it throws.
        console.error(`[lc] ${no}: could not split the upfront interest —`, (e as Error).message)
      }
    }
  })

  await runOnce('bd_serviced_interest_v1', async () => {
    const c = getClient()
    for (const col of ["interest_mode TEXT", "interest_freq TEXT"]) {
      await c.execute('ALTER TABLE bill_discountings ADD COLUMN ' + col).catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
    }
    // Every bill already on the books keeps exactly what it was posted with.
    await c.execute(
      "UPDATE bill_discountings SET interest_mode = CASE WHEN COALESCE(interest_upfront, 0) = 1 THEN 'upfront' ELSE 'discounted' END WHERE interest_mode IS NULL"
    )
    await c.execute(`CREATE TABLE IF NOT EXISTS bd_interest_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bd_id INTEGER NOT NULL REFERENCES bill_discountings(id),
      -- The stretch of days this payment covers. from_date is the morning
      -- after the previous one ended, so no day is charged twice and none is
      -- skipped between them.
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      days INTEGER NOT NULL DEFAULT 0,
      paid_date TEXT NOT NULL,
      gross REAL NOT NULL DEFAULT 0,
      tds REAL NOT NULL DEFAULT 0,
      net REAL NOT NULL DEFAULT 0,
      note TEXT,
      journal_entry_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    await c.execute('CREATE INDEX IF NOT EXISTS idx_bd_interest_bd ON bd_interest_payments(bd_id)')
  }).catch((e) => console.error('[bd] serviced interest setup failed:', e))

  // Where a heel went, when it did not go for good. A write-off row carrying
  // a destination is a MOVE — the oil left one oil's PP and arrived in
  // another's — and the log answers both questions in one place rather than
  // leaving a transfer looking like a loss.
  await runOnce('pp_writeoffs_move_v1', async () => {
    for (const col of ['to_product_id INTEGER', 'to_stage_id INTEGER']) {
      await getClient()
        .execute('ALTER TABLE pp_writeoffs ADD COLUMN ' + col)
        .catch((e) => {
          if (!/duplicate column/i.test(String(e))) throw e
        })
    }
  }).catch((e) => console.error('[stock] PP move columns failed:', e))

  // The gate times the website wrote while the server ran in UTC — 09:53 IST
  // stored as 04:23, and anything entered before 05:30 IST filed under the
  // day before. src/server/tz.ts stops it recurring; this repairs what is
  // already in the table.
  //
  // It runs here rather than by hand because the affected rows are on the
  // server, which is the one machine none of this can be run against
  // directly. The rule for picking them, and why only these, is in
  // gateTimeFix.ts — it turns on created_at, the only clock in the table that
  // was never wrong. Nothing typed by a person is touched.
  //
  // Every original value is written to gate_time_utc_fix_log first, so this is
  // undoable from the database alone if the count looks wrong.
  await runOnce('gate_time_utc_fix_v1', async () => {
    const rep = await applyGateTimeFix()
    console.log(
      `[gate] UTC time fix: ${rep.utcStamped.length} of ${rep.scanned} timed entries shifted +5:30` +
        (rep.outLeftAlone.length ? `, ${rep.outLeftAlone.length} out-times left alone` : '')
    )
    for (const ch of rep.utcStamped) {
      console.log(
        `[gate]   ${ch.gate_entry_no}  in ${ch.old_entry} -> ${ch.new_entry}` +
          (ch.new_out ? `  out ${ch.old_out} -> ${ch.new_out}` : '') +
          (ch.warn ? `  (${ch.warn})` : '')
      )
    }
  }).catch((e) => console.error('[gate] UTC time fix failed:', e))

  // LC-9's bill was raised for the gross open amount.
  //
  // Every other bill in the book is the open amount LESS the interest and
  // commission the bank keeps out of the credit. LC-9's was raised for the
  // whole ₹88,49,000 — ₹1,74,474.58 more, which is exactly those two fees. Of
  // 52 bills it is the only one billed gross without the "interest settled
  // upfront" flag that makes gross correct. The consequences are in the
  // ledger: ASHOK SHOP shows paid ₹1,74,474.58 more than they received, and
  // the LC draws ₹90,23,474.58 against an ₹88,49,000 facility.
  //
  // Corrected here rather than by hand because it has to happen on the server,
  // where the data is. The same guards the standalone script carries
  // (scripts/fix-lc9-bill.mjs) apply: it touches nothing unless the LC still
  // looks exactly as diagnosed, and runOnce means a second boot is a no-op.
  //
  // It re-posts the settlement voucher through the app's own resync rather
  // than editing journal lines, so the correction is derived the same way
  // every other settlement is.
  await runOnce('lc9_gross_bill_fix_v1', async () => {
    const c = getClient()
    const lcRes = await c.execute({
      sql: `SELECT id, lc_no, amount, interest_pct, usance_days, charges, interest_upfront
              FROM letters_of_credit
             WHERE lc_no = 'LC-9' AND ABS(amount - 8849000) < 1`,
      args: []
    })
    if (lcRes.rows.length !== 1) {
      console.log('[lc9] skipped — expected one LC-9 at 88,49,000, found', lcRes.rows.length)
      return
    }
    const lc = lcRes.rows[0] as unknown as Record<string, unknown>
    const num = (v: unknown): number => Number(v || 0)
    if (num(lc.interest_upfront) === 1) {
      console.log('[lc9] skipped — flagged interest-upfront, a gross bill is correct there')
      return
    }
    const interest =
      Math.round(((num(lc.amount) * num(lc.interest_pct) * num(lc.usance_days)) / 36500) * 100) / 100
    const charges = Math.round(num(lc.charges) * 100) / 100
    const correct = Math.round((num(lc.amount) - interest - charges) * 100) / 100

    const bills = await c.execute({
      sql: 'SELECT id, amount FROM lc_issuances WHERE lc_id = ?',
      args: [num(lc.id)]
    })
    if (bills.rows.length !== 1) {
      console.log('[lc9] skipped — expected one bill, found', bills.rows.length)
      return
    }
    const bill = bills.rows[0] as unknown as Record<string, unknown>
    if (Math.abs(num(bill.amount) - correct) < 0.005) {
      console.log('[lc9] already correct at', correct)
      return
    }
    if (Math.abs(num(bill.amount) - num(lc.amount)) > 0.005) {
      console.log('[lc9] skipped — bill is neither gross nor the correct net:', num(bill.amount))
      return
    }
    // The before-state, in the log, so the change can be reversed by hand.
    console.log('[lc9] BEFORE', JSON.stringify({ lc, bill, correctingTo: correct }))
    await c.execute({
      sql: 'UPDATE lc_issuances SET amount = ? WHERE id = ?',
      args: [correct, num(bill.id)]
    })
    const { resyncLcSettlement } = await import('./treasury')
    await resyncLcSettlement(num(lc.id))
    console.log(`[lc9] bill ${num(bill.amount)} -> ${correct}, settlement voucher re-posted`)
  }).catch((e) => console.error('[lc9] gross bill fix failed:', e))

  // LC-5's "interest settled upfront" flag contradicts its own bill.
  //
  // Upfront means the bank collects its interest and commission separately, so
  // the beneficiary receives the WHOLE open amount — which is how LC-26 and
  // LC-11 are billed, correctly. LC-5 carries the same flag but its bill is
  // ₹1,18,12,440.88 against an open amount of ₹1,20,00,000: BUNGE was paid
  // less than the credit, which by definition means the fees came out of it.
  // The bill is a recorded bank figure; the flag is a tick box. The tick box
  // is the thing that is wrong.
  //
  // This moves no money. None of the upfront LCs carries a separate interest
  // voucher (interest_journal_entry_id is null on all three), so the flag only
  // changes what the app EXPECTS, not what it has posted. Clearing it stops
  // the register expecting a gross bill it was never going to see, which is
  // what made LC-5 read as ₹1,87,559.12 adrift instead of ₹4,241.10.
  await runOnce('lc5_upfront_flag_v1', async () => {
    const c = getClient()
    const res = await c.execute({
      sql: `SELECT id, lc_no, amount, interest_upfront, interest_journal_entry_id,
                   (SELECT COALESCE(SUM(i.amount), 0) FROM lc_issuances i WHERE i.lc_id = l.id) billed
              FROM letters_of_credit l
             WHERE lc_no = 'LC-5' AND ABS(amount - 12000000) < 1 AND interest_upfront = 1`,
      args: []
    })
    if (res.rows.length !== 1) {
      console.log('[lc5] skipped — expected one upfront LC-5 at 1,20,00,000, found', res.rows.length)
      return
    }
    const r = res.rows[0] as unknown as Record<string, unknown>
    const num = (v: unknown): number => Number(v || 0)
    // Only if the bill really is BELOW the open amount. If someone has since
    // re-billed it gross, the flag is right and this must not touch it.
    if (num(r.billed) >= num(r.amount) - 0.005) {
      console.log('[lc5] skipped — billed at or above the open amount, the flag is correct')
      return
    }
    if (r.interest_journal_entry_id != null) {
      console.log('[lc5] skipped — it now carries an upfront interest voucher; clearing the flag would strand it')
      return
    }
    console.log('[lc5] BEFORE', JSON.stringify(r))
    await c.execute({
      sql: 'UPDATE letters_of_credit SET interest_upfront = 0 WHERE id = ?',
      args: [num(r.id)]
    })
    console.log('[lc5] interest_upfront cleared — expectation now matches the recorded bill')
  }).catch((e) => console.error('[lc5] upfront flag fix failed:', e))

  // Lab readings taken when a tanker is emptied.
  //
  // FFA, colour, moisture and melting point are what the mill actually tests
  // an incoming load on, and until now they were nowhere — the tanker recorded
  // how MUCH arrived and nothing about what it was. They belong to the empty
  // stage because that is when the sample is drawn.
  //
  // A row per reading rather than four columns, so a load that needs a fifth
  // test does not need a schema change. `sort_order` keeps the four standard
  // ones in their usual order with anything added falling in after them.
  await runOnce('tanker_quality_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS tanker_quality (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tanker_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_tanker_quality_tanker ON tanker_quality(tanker_id)'
    )
  }).catch((e) => console.error('[tankers] quality table failed:', e))

  // A recipe is edited; the batches already run on it are not.
  //
  // formulation_items is REPLACED on every save — the old lines are deleted
  // and the new ones written in their place — so the recipe a batch was run
  // on stopped existing the moment somebody changed it. That was survivable
  // only because createProduction copies the expanded lines into
  // production_items, which is a real snapshot. updateProduction does not:
  // it re-expands from the recipe as it stands NOW, so correcting the note or
  // the date on a batch from three months ago silently re-costed it on
  // today's recipe.
  //
  // So: every save keeps a full copy of the recipe, stamped with the moment
  // and the person, and every batch records which copy it was run on. An edit
  // now applies to the next batch and to nothing already recorded.
  await runOnce('formulation_versions_v1', async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS formulation_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formulation_id INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      saved_at TEXT,
      saved_by TEXT,
      product_id INTEGER,
      name TEXT,
      uom TEXT,
      subcategory_id INTEGER,
      -- The lines as they stood, verbatim. JSON rather than a second items
      -- table: it is only ever read back whole and handed to expandRecipe,
      -- and a column added to formulation_items later must not need a
      -- matching column here to keep old versions readable.
      items_json TEXT NOT NULL,
      -- What the lines amount to, for deciding whether a save changed
      -- anything at all. Opening a recipe and pressing Save must not mint a
      -- version.
      fingerprint TEXT NOT NULL,
      note TEXT
    )`)
    await c.execute(
      'CREATE INDEX IF NOT EXISTS idx_formulation_versions_f ON formulation_versions(formulation_id, version)'
    )
    for (const sql of [
      'ALTER TABLE formulations ADD COLUMN updated_at TEXT',
      'ALTER TABLE formulations ADD COLUMN updated_by TEXT',
      'ALTER TABLE production ADD COLUMN formulation_version_id INTEGER'
    ]) {
      await c.execute(sql).catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
    }

    // Version 1 of every recipe that already exists, from its current lines.
    //
    // Dated by the recipe's own created_at rather than today: this IS the
    // recipe as it has been standing, and stamping it with the migration's
    // clock would claim every recipe in the mill was rewritten this morning.
    const fs = await c.execute('SELECT * FROM formulations')
    for (const f of fs.rows) {
      const fid = Number(f.id)
      const items = await c.execute({
        sql: `SELECT product_id, qty, kind, auto_calc, ffa_pct, loss_multiplier_pct, moisture_pct, byproduct_product_id
              FROM formulation_items WHERE formulation_id = ? ORDER BY id`,
        args: [fid]
      })
      const rows = items.rows.map((r) => ({
        product_id: Number(r.product_id),
        qty: Number(r.qty) || 0,
        kind: String(r.kind || 'input'),
        auto_calc: r.auto_calc ? 1 : 0,
        ffa_pct: r.ffa_pct == null ? null : Number(r.ffa_pct),
        loss_multiplier_pct: r.loss_multiplier_pct == null ? null : Number(r.loss_multiplier_pct),
        moisture_pct: r.moisture_pct == null ? null : Number(r.moisture_pct),
        byproduct_product_id: r.byproduct_product_id == null ? null : Number(r.byproduct_product_id)
      }))
      const json = JSON.stringify(rows)
      const res = await c.execute({
        sql: `INSERT INTO formulation_versions
                (formulation_id, version, saved_at, saved_by, product_id, name, uom, subcategory_id, items_json, fingerprint, note)
              VALUES (?, 1, ?, 'system', ?, ?, ?, ?, ?, ?, 'The recipe as it stood when versioning was switched on')`,
        args: [
          fid,
          String(f.created_at || '').slice(0, 19) || null,
          f.product_id ?? null,
          f.name ?? null,
          f.uom ?? null,
          f.subcategory_id ?? null,
          json,
          json
        ]
      })
      const vid = Number(res.lastInsertRowid)
      // Every batch already recorded against this recipe is pinned to that
      // version. It changes no figure: re-expanding one of these today would
      // read exactly these lines, because they ARE the current lines. What it
      // changes is tomorrow — after the next edit, these batches still expand
      // from what they were actually run on.
      await c.execute({
        sql: 'UPDATE production SET formulation_version_id = ? WHERE formulation_id = ? AND formulation_version_id IS NULL',
        args: [vid, fid]
      })
    }
  }).catch((e) => console.error('[formulations] version table failed:', e))

  // Oil put back through the machine to keep it turning.
  //
  // When the mill stands idle for a few days the plant is not switched off —
  // finished oil is run through it and comes back out as the same oil. It is
  // real work and worth a record, but it is not production: nothing was made,
  // no raw material was drawn, and the recipe has no part in it. Counted as a
  // batch it would invent output that never existed and consume inputs that
  // were never touched.
  //
  // A kind on the row rather than a table of its own: it IS a production
  // entry — same date, same product, same register — differing only in what
  // it means, and every query that reads production has to make the
  // distinction anyway.
  await runOnce('production_kind_v1', async () => {
    await getClient()
      .execute("ALTER TABLE production ADD COLUMN kind TEXT NOT NULL DEFAULT 'batch'")
      .catch((e) => {
        if (!/duplicate column/i.test(String(e))) throw e
      })
  }).catch((e) => console.error('[production] kind column failed:', e))

  // A CHART OF ACCOUNTS THE MILL CAN ADD TO.
  //
  // Groups were twenty-six names in a TypeScript array — fine until somebody
  // needs TERM LOANS under SECURED LOANS, or a second freight group, which is
  // an ordinary week's work in a set of books and was impossible here.
  //
  // Seeded with Tally's own twenty-eight plus this book's GENERAL, wired up
  // parent to child, and then — the part that matters — every acc_group name
  // already sitting on a ledger is adopted as a primary of its own, so no
  // existing ledger is orphaned into a group that does not exist. Natures are
  // seeded to resolve exactly as the old flat list returned them, so not one
  // figure moves sides on the trial balance.
  await runOnce('ledger_groups_v1', () => seedDefaultGroups()).catch((e) =>
    console.error('[accounting] ledger groups failed:', e)
  )

  // AN LC MARGIN IS NOT A LEDGER ENTRY, AND THE OLD ONES COME OFF.
  //
  // Opening an LC used to post Dr LC MARGIN A/C / Cr the bank for the security
  // the bank holds under lien. Across these books that parked 8.6 crore in a
  // deposit account and took the same out of the bank balances, against money
  // nobody had paid away. It is tracked on the LC and on the bank's own side;
  // it does not belong here. postLcOpening no longer writes it.
  //
  // Two shapes exist. Nearly all are the two-line CONTRA — margin against the
  // bank — and those come off whole. ONE is the original four-line JOURNAL,
  // which also carried that LC's interest and its bank charges: deleting it
  // would take two real expenses with it, so only the margin line is removed
  // and the bank credit is reduced by exactly that much. The voucher stays,
  // still balanced, carrying what it should have carried all along.
  //
  // Only vouchers an LC NAMES as its own opening are touched — never a
  // hand-written journal that happens to mention a margin.
  await runOnce('lc_margin_off_ledger_v1', async () => {
    const c = getClient()
    const acc = await c.execute({
      sql: "SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = 'LC MARGIN A/C'",
      args: []
    })
    const accId = Number(acc.rows[0]?.id || 0)
    if (!accId) return
    const lcs = await c.execute({
      sql: `SELECT id, lc_no, journal_entry_id FROM letters_of_credit WHERE journal_entry_id IS NOT NULL`,
      args: []
    })
    let whole = 0
    let trimmed = 0
    for (const row of lcs.rows) {
      const jeId = Number((row as unknown as Record<string, unknown>).journal_entry_id || 0)
      if (!jeId) continue
      const lines = await c.execute({
        sql: 'SELECT id, account_id, dr, cr FROM journal_lines WHERE entry_id = ?',
        args: [jeId]
      })
      const all = lines.rows.map((r) => r as unknown as Record<string, unknown>)
      const marginLine = all.find((l) => Number(l.account_id) === accId)
      if (!marginLine) continue
      const margin = Number(marginLine.dr) || 0
      if (all.length <= 2) {
        // The plain margin contra: the whole voucher is the margin.
        await c.execute({
          sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
          args: [jeId]
        })
        await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [jeId] })
        await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [jeId] })
        whole += 1
      } else {
        // The old combined voucher: lift the margin out and leave the rest.
        await c.execute({
          sql: 'DELETE FROM journal_bill_allocs WHERE line_id = ?',
          args: [Number(marginLine.id)]
        })
        await c.execute({ sql: 'DELETE FROM journal_lines WHERE id = ?', args: [Number(marginLine.id)] })
        // The credit side loses exactly the margin, so the voucher still
        // balances on what remains.
        await c.execute({
          sql: `UPDATE journal_lines SET cr = ROUND(cr - ?, 2)
                 WHERE entry_id = ? AND cr > 0`,
          args: [margin, jeId]
        })
        await c.execute({
          sql: `UPDATE journal_entries
                   SET narration = TRIM(COALESCE(narration, '')) || ' (margin taken off the books)'
                 WHERE id = ?`,
          args: [jeId]
        })
        trimmed += 1
      }
      await c.execute({
        sql: 'UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?',
        args: [Number((row as unknown as Record<string, unknown>).id)]
      })
    }
    // A margin RELEASE reverses a posting that no longer exists, so it goes
    // too. None had been raised when this was written; a book that preclosed
    // an LC with the old build will have one.
    const rel = await c.execute({
      sql: `SELECT id, preclose_journal_entry_id FROM letters_of_credit
             WHERE preclose_settlement_direction = 'margin_released'
               AND preclose_journal_entry_id IS NOT NULL`,
      args: []
    })
    for (const row of rel.rows) {
      const jeId = Number((row as unknown as Record<string, unknown>).preclose_journal_entry_id || 0)
      if (!jeId) continue
      await c.execute({
        sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
        args: [jeId]
      })
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [jeId] })
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [jeId] })
      await c.execute({
        sql: 'UPDATE letters_of_credit SET preclose_journal_entry_id = NULL WHERE id = ?',
        args: [Number((row as unknown as Record<string, unknown>).id)]
      })
      whole += 1
    }
    console.log(`[lc] margin taken off the ledger — ${whole} voucher(s) removed, ${trimmed} trimmed`)
  }).catch((e) => console.error('[lc] margin off-ledger failed:', e))

  // WHEN THE MONEY IS EXPECTED BACK.
  //
  // A letter of credit and a discounted bill both fund something that is
  // supposed to pay for itself, and the terms for that are agreed in DAYS —
  // "60 days from the LC" — not as a date somebody types and then has to keep
  // in step with whatever the facility was actually opened on.
  //
  // Optional on both, and null on everything already on file, which reads as
  // "not agreed" rather than as nought days.
  await runOnce('facility_payment_in_days_v1', async () => {
    const c = getClient()
    for (const t of ['letters_of_credit', 'bill_discountings']) {
      // Whether money is expected back at all — the switch at the foot of the
      // form. Separate from the term, because "yes, it comes back, we have not
      // agreed when" is a real answer and a blank number cannot say it.
      await c.execute(`ALTER TABLE ${t} ADD COLUMN payment_in_expected INTEGER NOT NULL DEFAULT 0`).catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
      await c.execute(`ALTER TABLE ${t} ADD COLUMN payment_in_days INTEGER`).catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
    }
  }).catch((e) => console.error('[facility] payment-in days failed:', e))

  // WHAT THE BANK TOOK ON TOP OF THE BILL.
  //
  // A discounted bill is repaid at more than its open amount whenever the NBFC
  // keeps its commission and the bank its charges out of the same debit —
  // 79,50,000 against a 77,76,117.45 bill, the difference being exactly those
  // two. The LC side has carried them since it was written; the BD side had
  // nowhere to put them, so the repayment refused the real figure as "more
  // than the bill is for" and the charges never reached the books at all.
  //
  // Null on every repayment already recorded, which reads as "none stated" —
  // those were entered at the principal, which is what they say.
  await runOnce('bd_repayment_charges_v1', async () => {
    const c = getClient()
    for (const col of ['comm_charges REAL', 'bank_charges REAL']) {
      await c.execute(`ALTER TABLE bd_repayments ADD COLUMN ${col}`).catch((e) => {
        if (!/duplicate column/i.test(String(e?.message || e))) throw e
      })
    }
  }).catch((e) => console.error('[bd] repayment charges failed:', e))

  // THE INTER-COMPANY DESK'S OWN LINE ON THE CHECKLIST.
  //
  // Added separately rather than folded into SEED above, because SEED is
  // written once and an admin may have reworded or retired half of it since.
  // Re-running it would undo that. This adds the one row, and only if a row
  // for that desk is not already there.
  await runOnce('work_catalogue_intercompany_v1', async () => {
    const c = getClient()
    const have = await c.execute({
      sql: "SELECT id FROM work_processes WHERE module = 'sales' AND scope = 'intercompany' LIMIT 1",
      args: []
    })
    if (have.rows.length) return
    await c.execute({
      sql: `INSERT INTO work_processes (module, scope, title, detail, active)
            VALUES ('sales', 'intercompany', ?, ?, 1)`,
      args: [
        "Bill today's inter-company transfers",
        'Every movement between our own companies invoiced, so both sets of books show it.'
      ]
    })
  }).catch((e) => console.error('[work] inter-company catalogue line failed:', e))

  // GST, HEAD BY HEAD AND RATE BY RATE — the ledgers a return is filed from.
  // See src/main/gstBackfill.ts for what it moves and why it keeps line ids.
  await runOnce('gst_rate_ledgers_v1', splitGstLedgersByRate).catch((e) =>
    console.error('[gst] rate ledgers failed:', e)
  )

  // LC REPAYMENT CHARGES, FOLDED ONTO THE PAYMENT — once, at start (asked for
  // on 2026-09-30, so nobody has to press the button for the old ones).
  //
  // A repayment with bank charges used to post two vouchers: a journal raising
  // LC PAYABLE by the charges, then a payment clearing it by the whole debit.
  // New ones post one payment (postLcRepaymentEntry). This puts the old ones
  // into that shape with EXACTLY the code the Settings → Accounting checks
  // button runs: only the plain two-voucher shape is touched, every voucher is
  // archived to accounting_repair_log before it changes, the payment keeps its
  // number and date, and no ledger balance moves. Anything unusual (a rescued
  // upfront interest, extra lines, allocations) is left on the Accounting
  // checks list for a person. If it fails, the flag is not set and the next
  // start tries again; a restored database without the flag is caught too.
  await runOnce('lc_repay_charges_fold_v1', async () => {
    const { findings } = await previewLcCharges()
    const ids = findings.filter((f) => !f.review).map((f) => f.repayment_id)
    if (!ids.length) return
    const r = await fixLcCharges(ids)
    console.log(`[lc] folded bank charges onto ${r.fixed} repayment voucher(s) — ${r.charges.toFixed(2)} in all`)
  }).catch((e) => console.error('[lc] repayment charges fold failed:', e))

  // VOUCHER NUMBERS IN THE WRONG SERIES — once, at start (asked for on 2026-10-17).
  //
  // A voucher kept the number it was first given when its type changed later:
  // 17 bill discounting PID openings, posted as receipts and re-posted as
  // journals, still read RCP/5 … RCP/34. Each moves to the next number of its
  // own series in date order; the old code is logged. New changes renumber as
  // they happen (renumberOnTypeChange).
  // LC REPAYMENTS FILED AS JOURNALS — once, at start (asked for on 2026-10-17):
  // JV/33, LC-7's repayment of 29-08, becomes a Payment with the next PAY number.
  await runOnce('lc_repay_as_payment_v1', async () => {
    const moved = await fileLcRepaymentsAsPayments()
    if (moved.length) console.log(`[lc] repayments filed as payments: ${moved.join(', ')}`)
  }).catch((e) => console.error('[lc] repayment voucher type fix failed:', e))

  await runOnce('voucher_series_realign_v1', async () => {
    const moved = await realignVoucherSeries()
    if (moved.length) console.log(`[vouchers] renumbered ${moved.length}: ${moved.join(', ')}`)
  }).catch((e) => console.error('[vouchers] series realign failed:', e))

  // DUPLICATE SALES VOUCHERS — once, at start (asked for on 2026-09-30).
  //
  // The extra component vouchers the 2026-09-03 catch-up bug left on grouped
  // invoices, each counting a line's revenue and the party's debt twice. Plain
  // ones are removed by the reviewed repair; an invoice it would leave for
  // review is re-posted from its own lines, as saving it from Sales does. All
  // archived first — see autoFixDuplicateSales. A failure leaves the flag unset
  // and the next start tries again.
  await runOnce('sales_duplicate_vouchers_v1', async () => {
    const r = await autoFixDuplicateSales()
    if (r.removed || r.reposted.length) {
      console.log(
        `[sales] removed ${r.removed} duplicate sale voucher(s) (${r.revenue.toFixed(2)} of revenue counted twice)` +
          (r.reposted.length ? `; re-posted from their lines: ${r.reposted.join(', ')}` : '')
      )
    }
  }).catch((e) => console.error('[sales] duplicate voucher repair failed:', e))

  // DELIVERY FREIGHT ALREADY ACCRUED, BUT FLAGGED AS NOT — once, at start
  // (asked for on 2026-10-01).
  //
  // A freight line on the Fr. Outward register says whether the sale voucher
  // has already booked it to FREIGHT PAYABLE (accrued = 1). Lines written
  // before that flag existed (2026-08-23) default to 0, and a sale voucher
  // reposted since DOES carry the Cr FREIGHT PAYABLE — so the transporter's
  // bill would debit FREIGHT OUTWARD for it a second time and leave the
  // payable standing for good. KRFL/405's ₹20,595 (Sameer Carriers) was the
  // one on the books when this was found.
  //
  // Only the flag moves, and only on a line that is unbilled, not deducted
  // from the customer, and whose invoice's SALE voucher really carries a
  // FREIGHT PAYABLE credit. No voucher is touched.
  await runOnce('freight_accrued_flag_v1', async () => {
    const c = getClient()
    const map = await c
      .execute("SELECT use_name FROM ledger_map WHERE UPPER(posts_as) = 'FREIGHT PAYABLE A/C'")
      .catch(() => ({ rows: [] as unknown[] }))
    const names = ['FREIGHT PAYABLE A/C', ...(map.rows as Record<string, unknown>[]).map((r) => String(r.use_name || '').toUpperCase())].filter(Boolean)
    const cand = await c.execute(
      `SELECT tl.id, tl.amount, s.id AS sale_id, s.invoice_no, s.invoice_group, s.company_id
         FROM transporter_ledger tl
         JOIN sales s ON s.id = tl.sale_id
        WHERE tl.entry_type = 'freight' AND COALESCE(tl.accrued, 0) = 0 AND tl.bill_id IS NULL
          AND COALESCE(s.deduct_freight, 0) = 0`
    )
    const fixed: string[] = []
    for (const r of cand.rows as Record<string, unknown>[]) {
      const hit = await c.execute({
        sql: `SELECT 1 FROM journal_entries je
                JOIN journal_lines jl ON jl.entry_id = je.id
                JOIN ledger_accounts la ON la.id = jl.account_id
               WHERE je.vch_type = 'SALE' AND jl.cr > 0
                 AND UPPER(la.name) IN (${names.map(() => '?').join(',')})
                 AND je.sale_id IN (SELECT s2.id FROM sales s2
                                     WHERE s2.company_id = ?
                                       AND COALESCE(s2.invoice_group, 'id:' || s2.id) = COALESCE(?, 'id:' || ?))
               LIMIT 1`,
        args: [...names, Number(r.company_id) || 1, r.invoice_group == null ? null : String(r.invoice_group), Number(r.sale_id)]
      })
      if (!hit.rows.length) continue
      await c.execute({ sql: 'UPDATE transporter_ledger SET accrued = 1 WHERE id = ?', args: [Number(r.id)] })
      fixed.push(`${String(r.invoice_no || r.sale_id)} ${Number(r.amount).toFixed(2)}`)
    }
    if (fixed.length) console.log(`[freight] marked ${fixed.length} delivery freight line(s) as already accrued: ${fixed.join(', ')}`)
  }).catch((e) => console.error('[freight] accrued flag repair failed:', e))

  // Every customer, supplier, transporter and broker gets its ledger — the
  // masters added before parties were made ledgers on save. Only creates
  // missing ledgers; nothing existing is changed.
  await runOnce('party_master_ledgers_v1', async () => {
    const { ensureAllPartyMasterLedgers } = await import('./partyLedgers')
    const made = await ensureAllPartyMasterLedgers()
    console.log(`[party ledgers] created ${made} ledger(s) for masters that had none`)
  }).catch((e) => console.error('[party ledgers] backfill failed:', e))

  // DISCOUNTED BILLS STILL READING THE ADJ. THE OLD WAY — once, at start
  // (asked for on 2026-10-01, for FD1). See convertOpenAdjToCharge: the Open
  // amount is what is owed, the Adj. is a BD charge, and the opening voucher is
  // re-posted in place after being archived. Bills with anything paid against
  // them are left for a person.
  await runOnce('bd_open_adj_charge_v1', async () => {
    const done = await convertOpenAdjToCharge()
    if (done.length) console.log(`[bd] moved ${done.length} bill(s) to the Open amount with the Adj. as a charge: ${done.join(', ')}`)
  }).catch((e) => console.error('[bd] open adjustment conversion failed:', e))

  // LC SETTLEMENTS DATED OFF THEIR PAYMENT-RECEIVED DATE — once, at start
  // (asked for on 2026-10-24, for 005LM02262480003/4). A re-save now dates
  // the settlement by Payment received (resyncLcSettlement); this does that
  // re-save for the live LCs whose voucher is still on another day. Repaid and
  // preclosed LCs are skipped inside resyncLcSettlement, as on a save.
  await runOnce('lc_settlement_payment_date_v1', async () => {
    const { resyncLcSettlement } = await import('./treasury')
    const r = await getClient().execute(`
      SELECT DISTINCT l.id, l.lc_no FROM letters_of_credit l
        JOIN lc_issuances i ON i.lc_id = l.id
        JOIN journal_entries je ON je.id = i.journal_entry_id
       WHERE l.payment_received_date IS NOT NULL AND COALESCE(i.installment_no, 1) = 1
         AND l.preclosed_date IS NULL AND NOT EXISTS (SELECT 1 FROM lc_repayments r WHERE r.lc_id = l.id)
         AND (je.entry_date <> l.payment_received_date OR i.settled_date <> l.payment_received_date)`)
    const fixed: string[] = []
    for (const row of r.rows) {
      try {
        await resyncLcSettlement(Number(row.id))
        fixed.push(String(row.lc_no))
      } catch (e) {
        console.error(`[lc] settlement date fix failed for ${String(row.lc_no)}:`, (e as Error).message)
      }
    }
    if (fixed.length) console.log(`[lc] settlement dated by payment received on ${fixed.length} LC(s): ${fixed.join(', ')}`)
  }).catch((e) => console.error('[lc] settlement date fix failed:', e))

  await ensurePpTraceSchema()
  startRevisionWatcher()
}

/**
 * COLUMNS THIS BUILD CANNOT RUN WITHOUT, CHECKED ON EVERY START.
 *
 * Each of these was added by a runOnce migration, and runOnce is exactly right
 * for work that must happen once @D@ moving money, rewriting vouchers. It is the
 * wrong guard for a COLUMN, because a column is not an event: it is a fact
 * about the database that this build's queries assume, and a build whose
 * assumption is false does not fail politely. It fails as
 * `SQLITE_ERROR: no such column`, in front of somebody saving a bill.
 *
 * There are several ways the flag and the column can part company — a restore
 * that brings back a table from before the column and a setting from after it,
 * a startup that threw between the two, a database hand-edited or rolled back.
 * Rather than reason about which happened, this asks the table itself.
 *
 * One PRAGMA per table per start, and an ALTER only where something is
 * genuinely missing. The runOnce versions stay where they are: they cost
 * nothing once recorded, and this is a safety net rather than a replacement.
 */
const REQUIRED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'bill_discountings', column: 'payment_in_expected', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'bill_discountings', column: 'payment_in_days', type: 'INTEGER' },
  { table: 'letters_of_credit', column: 'payment_in_expected', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'letters_of_credit', column: 'payment_in_days', type: 'INTEGER' },
  { table: 'bd_repayments', column: 'comm_charges', type: 'REAL' },
  { table: 'bd_repayments', column: 'bank_charges', type: 'REAL' },
  { table: 'orders', column: 'bill_group', type: 'TEXT' },
  // The parcel a part-withdrawal was cut from, so releasing the invoice can
  // put the two halves back together (see applyConsignmentDraw).
  { table: 'consignment_stock', column: 'split_from', type: 'INTEGER' }
]

async function ensureRequiredColumns(): Promise<void> {
  const c = getClient()
  const seen = new Map<string, Set<string>>()
  let added = 0
  for (const need of REQUIRED_COLUMNS) {
    let have = seen.get(need.table)
    if (!have) {
      try {
        const r = await c.execute(`PRAGMA table_info(${need.table})`)
        have = new Set(r.rows.map((x) => String((x as unknown as Record<string, unknown>).name)))
      } catch {
        // No such table on this build. Whatever creates it will create the
        // column with it.
        have = new Set<string>()
      }
      seen.set(need.table, have)
    }
    // An empty set means the table is not there at all, which is not this
    // function's problem to solve.
    if (!have.size || have.has(need.column)) continue
    await c
      .execute(`ALTER TABLE ${need.table} ADD COLUMN ${need.column} ${need.type}`)
      .then(() => {
        added++
        have!.add(need.column)
      })
      .catch((e) => {
        if (!/duplicate column/i.test(String((e as Error)?.message || e))) {
          console.error(`[schema] could not add ${need.table}.${need.column}:`, (e as Error).message)
        }
      })
  }
  if (added) console.log(`[schema] ${added} missing column(s) added`)
}
