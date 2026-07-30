import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Status = { state: string; version?: string; percent?: number; message?: string }

// Wires up in-app auto-update against the public releases repo (see the
// `publish` block in package.json). Update files are downloaded in the
// background; the renderer is notified so the UI can offer "Restart to update".
export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  const send = (status: Status): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'none' }))
  autoUpdater.on('error', (err) => send({ state: 'error', message: String(err?.message || err) }))
  autoUpdater.on('download-progress', (p) =>
    send({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    send({ state: 'downloaded', version: info.version })
  )

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      return { ok: false, message: 'Updates are only available in the installed app.' }
    }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version }
    } catch (e) {
      return { ok: false, message: String((e as Error).message) }
    }
  })

  ipcMain.handle('update:install', () => {
    // Silent NSIS run (/S) + relaunch: no Next/Next/Finish, the app just
    // comes back on the new version.
    if (app.isPackaged) autoUpdater.quitAndInstall(true, true)
    return { ok: app.isPackaged }
  })

  // Auto-check a few seconds after launch (installed builds only).
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 4000)
  }
}
