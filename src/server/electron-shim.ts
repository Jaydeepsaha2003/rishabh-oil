import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

// A stand-in for the `electron` module, so the SERVER can run src/main/* as-is.
// -----------------------------------------------------------------------------
// The condition on this migration is that the logic, the rules and the schema
// do not change and the desktop build is not disturbed. That is achievable
// because src/main/* is already almost free of Electron: of 38 business modules
// and 22,786 lines, not one imports it. Only the plumbing does — ipc.ts,
// config.ts, backup.ts, updater.ts and index.ts.
//
// And ipc.ts needs remarkably little. Its `handle()` wrapper carries the access
// gate, the audit trail and the revision bump, and the only Electron thing it
// touches is `ipcMain.handle` — somewhere to register a channel. So the server
// build aliases `electron` to this file, ipc.ts registers its channels into the
// plain Map below, and the HTTP layer dispatches through that same wrapper.
//
// The result: every rule, every SQL statement, every permission check is the
// one the desktop app runs. Nothing is forked, so nothing can drift.

type Handler = (event: unknown, args: unknown) => unknown

export const handlers = new Map<string, Handler>()

export const ipcMain = {
  handle(channel: string, fn: Handler): void {
    handlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(): void {
    // Fire-and-forget channels: the desktop uses these for window plumbing,
    // which a request/response server has no equivalent of.
  }
}

// Where a server keeps the things the desktop keeps in userData. One directory
// beside the app, made on demand, so config.ts and backup.ts work untouched.
const dataDir = process.env.DATA_DIR || join(process.cwd(), '.server-data')

export const app = {
  getPath(name: string): string {
    const dir = name === 'userData' ? dataDir : join(dataDir, name)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Read-only disk: config and backup already tolerate a failed write.
    }
    return dir
  },
  getVersion(): string {
    return process.env.APP_VERSION || '0.0.0-web'
  },
  getName(): string {
    return 'rishabh-oil-web'
  },
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  on(): void {},
  quit(): void {},
  isPackaged: true
}

// Everything below exists so an import resolves. Each one is a WINDOW or an OS
// act, which a browser tab cannot be asked to perform from the server — so they
// say so plainly rather than failing in some way the caller has to guess at.
const notOnTheWeb = (what: string) => (): never => {
  throw new Error(`${what} is only available in the desktop app`)
}

export const shell = {
  openExternal: notOnTheWeb('Opening a link from the server'),
  openPath: notOnTheWeb('Opening a file on the server'),
  showItemInFolder: notOnTheWeb('Showing a file on the server')
}

export const dialog = {
  showOpenDialog: notOnTheWeb('Choosing a file from the server'),
  showSaveDialog: notOnTheWeb('Saving a file from the server'),
  showMessageBox: notOnTheWeb('A message box')
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  webContents = { send(): void {} }
  on(): void {}
  once(): void {}
  show(): void {}
  loadURL(): void {}
  loadFile(): void {}
}

export default { ipcMain, app, shell, dialog, BrowserWindow }
