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
