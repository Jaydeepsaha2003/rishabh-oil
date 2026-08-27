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
  await backfillJournal().catch((e) => console.error('[journal] backfill failed:', e))
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
