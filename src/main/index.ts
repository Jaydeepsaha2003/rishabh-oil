import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { registerUpdater } from './updater'
import { initDb, startRevisionWatcher } from './db'
import { backfillJournal } from './journal'
import { dailyBackup } from './backup'
import { backfillOrderStatuses, backfillPurchaseRoundOff } from './orders'
import { backfillSalesGst, backfillSalesBargainCustomers, backfillSalesRoundOff, backfillExSalesDone } from './sales'
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
  await backfillExSalesDone().catch((e) => console.error('[sales] ex-done sweep failed:', e))
  // First launch of the day: a full portable dump of the cloud database.
  dailyBackup().catch((e) => console.error('[backup] daily backup failed:', e))
  await backfillSalesBargainCustomers().catch((e) => console.error('[sales] bargain-customer link failed:', e))
  await backfillOrderStatuses().catch((e) => console.error('[orders] status backfill failed:', e))
  await backfillPurchaseRoundOff().catch((e) => console.error('[orders] round-off repair failed:', e))
  await seedDefaultAdmin().catch((e) => console.error('[auth] seed failed:', e))
  await seedProducts().catch((e) => console.error('[seed] products failed:', e))
  await seedFormulations().catch((e) => console.error('[seed] formulations failed:', e))
  await seedPackagings().catch((e) => console.error('[seed] packagings failed:', e))
  await cleanupLogs().catch(() => {})
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
