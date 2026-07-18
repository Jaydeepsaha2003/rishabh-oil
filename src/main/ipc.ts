import { ipcMain } from 'electron'
import { ping, bumpRevision, getRevision, initDb, resetClient, getConfiguredUrl } from './db'
import { saveStoredConfig } from './config'
import { seedDefaultAdmin } from './auth'
import { seedProducts, seedFormulations } from './seed'
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
  listPurchaseTankers,
  createPurchaseTanker,
  updateTankerDetails,
  deletePurchaseTanker,
  advancePurchaseTanker,
  supplierFyTaxable,
  listSupplierLedger,
  listTransporterLedger,
  addLedgerEntry,
  deleteLedgerEntry
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
import {
  listConsignment,
  consignmentSummary,
  createConsignment,
  updateConsignment,
  deleteConsignment
} from './consignment'
import { login, listUsers, createUser, updateUser, deleteUser } from './auth'
import { heartbeat, liveUsers, listIps, setIpActive, listLogs } from './access'
import {
  listFormulations,
  getFormulationItems,
  createFormulation,
  updateFormulation,
  deleteFormulation
} from './formulations'
import {
  stockLevels,
  productionNeeds,
  listStockTransfers,
  createStockTransfer,
  deleteStockTransfer
} from './stock'
import { stockCountSheet, listStockCounts, saveStockCounts } from './stockcount'
import {
  listProduction,
  getProductionItems,
  createProduction,
  deleteProduction
} from './production'
import {
  listGateEntries,
  nextGateEntryNo,
  createGateEntry,
  updateGateEntry,
  completeGateEntry,
  deleteGateEntry
} from './gate'
import { listCompanies, setActiveCompany, getActiveCompanyId } from './company'
import {
  listAccounts,
  createAccount,
  accountStatement,
  addManualJournal,
  deleteManualEntry
} from './journal'
import {
  listLCs,
  listLCIssuances,
  createLC,
  updateLC,
  deleteLC,
  issueLC,
  deleteLCIssuance
} from './lc'
import {
  listSales,
  createSale,
  updateSale,
  setSaleStatus,
  deleteSale,
  listSalesBargains,
  createSalesBargain,
  updateSalesBargain,
  deleteSalesBargain,
  listCustomerLedger
} from './sales'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// All database access lives here in the main process. The renderer (UI) can
// only call the specific channels we expose through the preload bridge, so the
// Turso token never reaches the UI layer.
export function registerIpc(): void {
  // Read-only channels don't change data, so they must not bump the revision.
  const READONLY =
    /:list$|:get$|:items$|:issuances$|:sheet$|:outstanding$|:all$|:summary$|:transfers$|:fyTaxable$|:needs$|:nextNo$|:liveUsers$|:ips$|:logs$|^access:heartbeat$|^db:ping$|^app:revision$|^auth:login$|^journal:accounts$|^journal:statement$|^company:setActive$|^company:getActive$/
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
    await seedProducts().catch(() => {})
    await seedFormulations().catch(() => {})
    return ping()
  })

  handle('company:list', () => listCompanies())
  handle('company:setActive', (_e, { id }: { id: number }) => setActiveCompany(id))
  handle('company:getActive', () => ({ id: getActiveCompanyId() }))

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
  handle('tankers:list', (_e, args?: { all?: boolean }) => listPurchaseTankers(!!args?.all))
  handle('tankers:create', (_e, { values }: { values: Row }) => createPurchaseTanker(values))
  handle('tankers:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateTankerDetails(id, values)
  )
  handle('tankers:delete', (_e, { id }: { id: number }) => deletePurchaseTanker(id))
  handle(
    'tankers:advance',
    (_e, { id, toStatus, data }: { id: number; toStatus: string; data: Row }) =>
      advancePurchaseTanker(id, toStatus, data)
  )
  handle('orders:create', (_e, { values }: { values: Row }) => createOrder(values))
  handle('orders:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateOrder(id, values)
  )
  handle('orders:delete', (_e, { id }: { id: number }) => deleteOrder(id))
  handle(
    'orders:fyTaxable',
    (_e, { supplierId, date, excludeId }: { supplierId: number; date: string; excludeId: number }) =>
      supplierFyTaxable(supplierId, date, excludeId)
  )
  handle(
    'orders:advance',
    (_e, { id, toStatus, data }: { id: number; toStatus: string; data: Row }) =>
      advanceOrder(id, toStatus, data)
  )

  handle('consignment:list', () => listConsignment())
  handle('consignment:summary', () => consignmentSummary())
  handle('consignment:create', (_e, { values }: { values: Row }) => createConsignment(values))
  handle('consignment:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateConsignment(id, values)
  )
  handle('consignment:delete', (_e, { id }: { id: number }) => deleteConsignment(id))

  handle('journal:accounts', () => listAccounts())
  handle('journal:createAccount', (_e, { name }: { name: string }) => createAccount(name))
  handle('journal:statement', (_e, { accountId }: { accountId: number }) =>
    accountStatement(accountId)
  )
  handle('journal:addEntry', (_e, { data }: { data: Row }) => addManualJournal(data))
  handle('journal:deleteEntry', (_e, { id }: { id: number }) => deleteManualEntry(id))

  handle('ledger:suppliers', () => listSupplierLedger())
  handle('ledger:transporters', () => listTransporterLedger())
  handle('ledger:customers', () => listCustomerLedger())
  handle('ledger:addEntry', (_e, { data }: { data: Row }) => addLedgerEntry(data))
  handle('ledger:deleteEntry', (_e, { partyType, id }: { partyType: string; id: number }) =>
    deleteLedgerEntry(partyType, id)
  )

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

  handle('access:heartbeat', (_e, { userId, username }: { userId: number; username: string }) =>
    heartbeat(userId, username)
  )
  handle('access:liveUsers', () => liveUsers())
  handle('access:ips', () => listIps())
  handle('access:setIp', (_e, { id, active }: { id: number; active: boolean }) =>
    setIpActive(id, active)
  )
  handle('access:logs', () => listLogs())

  handle('formulations:list', () => listFormulations())
  handle('formulations:items', (_e, { id }: { id: number }) => getFormulationItems(id))
  handle('formulations:create', (_e, { values }: { values: Row }) => createFormulation(values))
  handle('formulations:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateFormulation(id, values)
  )
  handle('formulations:delete', (_e, { id }: { id: number }) => deleteFormulation(id))

  handle('stock:list', () => stockLevels())
  handle('stock:needs', () => productionNeeds())
  handle('stock:transfers', () => listStockTransfers())
  handle('stock:transfer', (_e, { values }: { values: Row }) => createStockTransfer(values))
  handle('stock:deleteTransfer', (_e, { id }: { id: number }) => deleteStockTransfer(id))
  handle('stockCount:sheet', (_e, { date }: { date: string }) => stockCountSheet(date))
  handle('stockCount:list', (_e, { date }: { date: string }) => listStockCounts(date))
  handle('stockCount:save', (_e, { date, items }: { date: string; items: Row[] }) =>
    saveStockCounts(date, items)
  )

  handle('production:list', () => listProduction())
  handle('production:items', (_e, { id }: { id: number }) => getProductionItems(id))
  handle('production:create', (_e, { values }: { values: Row }) => createProduction(values))
  handle('production:delete', (_e, { id }: { id: number }) => deleteProduction(id))

  handle('sales:list', () => listSales())
  handle('sales:create', (_e, { values }: { values: Row }) => createSale(values))
  handle('sales:update', (_e, { id, values }: { id: number; values: Row }) => updateSale(id, values))
  handle('sales:setStatus', (_e, { id, status }: { id: number; status: string }) =>
    setSaleStatus(id, status)
  )
  handle('sales:delete', (_e, { id }: { id: number }) => deleteSale(id))

  handle('salesBargains:list', () => listSalesBargains())
  handle('salesBargains:create', (_e, { values }: { values: Row }) => createSalesBargain(values))
  handle('salesBargains:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateSalesBargain(id, values)
  )
  handle('salesBargains:delete', (_e, { id }: { id: number }) => deleteSalesBargain(id))

  handle('gate:list', () => listGateEntries())
  handle('gate:nextNo', () => nextGateEntryNo())
  handle('gate:create', (_e, { values }: { values: Row }) => createGateEntry(values))
  handle('gate:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateGateEntry(id, values)
  )
  handle('gate:complete', (_e, { id, receivedQty }: { id: number; receivedQty: number }) =>
    completeGateEntry(id, receivedQty)
  )
  handle('gate:delete', (_e, { id }: { id: number }) => deleteGateEntry(id))

  handle('lc:list', () => listLCs())
  handle('lc:issuances', (_e, { lcId }: { lcId: number }) => listLCIssuances(lcId))
  handle('lc:create', (_e, { values }: { values: Row }) => createLC(values))
  handle('lc:update', (_e, { id, values }: { id: number; values: Row }) => updateLC(id, values))
  handle('lc:delete', (_e, { id }: { id: number }) => deleteLC(id))
  handle('lc:issue', (_e, { values }: { values: Row }) => issueLC(values))
  handle('lc:deleteIssuance', (_e, { id }: { id: number }) => deleteLCIssuance(id))
}
