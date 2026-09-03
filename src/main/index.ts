import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { registerUpdater } from './updater'
import { getClient, initDb, runDaily, runOnce, startRevisionWatcher } from './db'
import { backfillJournal } from './journal'
import { dailyBackup } from './backup'
import { backfillOrderStatuses, backfillPurchaseRoundOff } from './orders'
import { backfillSalesGst, backfillSalesBargainCustomers, backfillSalesRoundOff, restateStaleSalesRoundOff, backfillExSalesDone } from './sales'
import { seedDefaultAdmin } from './auth'
import { seedProducts, seedFormulations, seedPackagings } from './seed'
import { cleanupLogs } from './access'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    // The size the window returns to when un-maximized — it always OPENS
    // maximized (below), since every register and ledger on here is a wide
    // table that reads badly in a small window.
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'Database Management Software',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // Maximize BEFORE showing, so the window never flashes at 1280×800 first.
  win.on('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
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
  await seedDefaultAdmin().catch((e) => console.error('[auth] seed failed:', e))
  await seedProducts().catch((e) => console.error('[seed] products failed:', e))
  await seedFormulations().catch((e) => console.error('[seed] formulations failed:', e))
  await seedPackagings().catch((e) => console.error('[seed] packagings failed:', e))
  await runDaily('cleanup_logs', () => cleanupLogs()).catch(() => {})
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
  await runOnce('bd_tables_repair_v1', async () => {
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
  }).catch((e) => console.error('[bd] table repair failed:', e))
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
    await c.execute('ALTER TABLE bd_parties ADD COLUMN amount REAL NOT NULL DEFAULT 0')
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
  startRevisionWatcher()
  registerIpc()
  registerUpdater(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
