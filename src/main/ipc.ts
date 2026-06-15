import { ipcMain } from 'electron'
import { ping, bumpRevision, getRevision, initDb, resetClient, getConfiguredUrl } from './db'
import { saveStoredConfig } from './config'
import { seedDefaultAdmin } from './auth'
import {
  list,
  get,
  create,
  update,
  remove,
  getSetting,
  setSetting,
  allSettings
} from './repos'
import { listBargains, createBargain, updateBargain, deleteBargain } from './bargains'
import {
  listOrders,
  createOrder,
  updateOrder,
  deleteOrder,
  advanceOrder,
  listSupplierLedger,
  listTransporterLedger
} from './orders'
import {
  listPayments,
  recordPayment,
  deletePayment,
  outstandingInvoices,
  listBillDiscounts,
  createBillDiscount,
  updateBillDiscount,
  deleteBillDiscount
} from './payments'
import { login, listUsers, createUser, updateUser, deleteUser } from './auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// All database access lives here in the main process. The renderer (UI) can
// only call the specific channels we expose through the preload bridge, so the
// Turso token never reaches the UI layer.
export function registerIpc(): void {
  // Read-only channels don't change data, so they must not bump the revision.
  const READONLY = /:list$|:get$|:outstanding$|:all$|^db:ping$|^app:revision$|^auth:login$/
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...a: any[]) => unknown): void => {
    ipcMain.handle(channel, async (e, args) => {
      const result = await fn(e, args)
      if (!READONLY.test(channel)) await bumpRevision().catch(() => {})
      return result
    })
  }

  handle('app:revision', () => getRevision())

  handle('db:ping', () => ping())

  handle('config:get', () => ({ url: getConfiguredUrl() }))
  handle('config:save', async (_e, { url, token }: { url: string; token: string }) => {
    saveStoredConfig(url, token)
    resetClient()
    await initDb()
    await seedDefaultAdmin().catch(() => {})
    return ping()
  })

  handle('data:list', (_e, { table }: { table: string }) => list(table))
  handle('data:get', (_e, { table, id }: { table: string; id: number }) => get(table, id))
  handle('data:create', (_e, { table, values }: { table: string; values: Row }) =>
    create(table, values)
  )
  handle(
    'data:update',
    (_e, { table, id, values }: { table: string; id: number; values: Row }) =>
      update(table, id, values)
  )
  handle('data:delete', (_e, { table, id }: { table: string; id: number }) =>
    remove(table, id)
  )

  handle('settings:get', (_e, { key }: { key: string }) => getSetting(key))
  handle('settings:set', (_e, { key, value }: { key: string; value: string }) =>
    setSetting(key, value)
  )
  handle('settings:all', () => allSettings())

  handle('bargains:list', () => listBargains())
  handle('bargains:create', (_e, { values }: { values: Row }) => createBargain(values))
  handle('bargains:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateBargain(id, values)
  )
  handle('bargains:delete', (_e, { id }: { id: number }) => deleteBargain(id))

  handle('orders:list', () => listOrders())
  handle('orders:create', (_e, { values }: { values: Row }) => createOrder(values))
  handle('orders:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateOrder(id, values)
  )
  handle('orders:delete', (_e, { id }: { id: number }) => deleteOrder(id))
  handle(
    'orders:advance',
    (_e, { id, toStatus, data }: { id: number; toStatus: string; data: Row }) =>
      advanceOrder(id, toStatus, data)
  )

  handle('ledger:suppliers', () => listSupplierLedger())
  handle('ledger:transporters', () => listTransporterLedger())

  handle('payments:list', () => listPayments())
  handle('payments:record', (_e, { data }: { data: Row }) => recordPayment(data))
  handle('payments:delete', (_e, { id }: { id: number }) => deletePayment(id))
  handle(
    'payments:outstanding',
    (_e, { partyType, partyId }: { partyType: string; partyId: number }) =>
      outstandingInvoices(partyType, partyId)
  )

  handle('billDiscounts:list', () => listBillDiscounts())
  handle('billDiscounts:create', (_e, { values }: { values: Row }) =>
    createBillDiscount(values)
  )
  handle('billDiscounts:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateBillDiscount(id, values)
  )
  handle('billDiscounts:delete', (_e, { id }: { id: number }) => deleteBillDiscount(id))

  handle('auth:login', (_e, { username, password }: { username: string; password: string }) =>
    login(username, password)
  )
  handle('users:list', () => listUsers())
  handle('users:create', (_e, { values }: { values: Row }) => createUser(values))
  handle('users:update', (_e, { id, values }: { id: number; values: Row }) => updateUser(id, values))
  handle('users:delete', (_e, { id }: { id: number }) => deleteUser(id))
}
