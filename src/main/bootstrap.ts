import { getClient, initDb, runDaily, runOnce, startRevisionWatcher } from './db'
import { backfillJournal } from './journal'
import { dailyBackup } from './backup'
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
import { applyGateTimeFix } from './gateTimeFix'
import { startNotificationWatcher, pruneNotifications } from './notify'

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
      'ALTER TABLE companies ADD COLUMN colour TEXT'
    ]) {
      await c.execute(sql).catch((e: unknown) => {
        if (!/duplicate column/i.test(String((e as Error).message))) throw e
      })
    }
  })().catch((e: unknown) => console.error('[companies] column repair failed:', e))

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

  startRevisionWatcher()
}
