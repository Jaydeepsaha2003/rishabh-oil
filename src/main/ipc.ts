import { ipcMain, dialog, shell } from 'electron'
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
import { listBargains, createBargain, updateBargain, deleteBargain, adjustBargainQty } from './bargains'
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
  revertPurchaseTanker,
  replaceTanker,
  supplierFyTaxable,
  listOrderBargains,
  listConsignmentDraws,
  listSupplierLedger,
  listTransporterLedger,
  addLedgerEntry,
  deleteLedgerEntry
} from './orders'
import { listBillDiscounts } from './payments'
import { listUnmappedOrders, unmappedCount, mapOrderToBargains } from './unmapped'
import { listTradingDeals, createTradingDeal, updateTradingDeal, deleteTradingDeal } from './trading'
import { assertAllowed, clearAccessCache } from './access-gate'
import { listSkuRates, saveSkuRates, listPackagingParties, setPackagingParties } from './skurates'
import {
  listConsignment,
  consignmentSummary,
  listPendingGateArrivals,
  listConsignmentInvoices,
  listUnbookedLots,
  createConsignment,
  updateConsignment,
  deleteConsignment, saveOpeningStock, listOpeningLog } from './consignment'
import { login, listUsers, createUser, updateUser, deleteUser } from './auth'
import { heartbeat, liveUsers, listIps, setIpActive, listLogs, logEvent, machineIp, type LogFilter } from './access'
import { getCurrentUser, setCurrentUser } from './currentUser'
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
  stockPartyBreakdown,
  listStockTransfers,
  createStockTransfer,
  deleteStockTransfer
} from './stock'
import { stockCountSheet, listStockCounts, saveStockCounts } from './stockcount'
import { listSkuStock, adjustSkuStock } from './skustock'
import { listNotes, listNoteItems, createNote, deleteNote } from './notes'
import { daybook } from './daybook'
import { dashboardStats } from './dashboard'
import {
  treasuryAlerts,
  listPaymentTracker,
  settleLcBill,
  reopenLcBill,
  discountBill,
  realizeBill,
  unrealizeBill,
  deleteDiscountedBill,
  listLcRepayments,
  saveLcRepayment,
  deleteLcRepayment,
  postLcPaymentIn,
  listLcPaymentIns,
  deleteLcPaymentIn,
  listLcOpenTradingInvoices
} from './treasury'
import {
  createVoucher,
  updateVoucher,
  getVoucher,
  listVouchers,
  trialBalance,
  listGroups,
  listPendingRefs,
  tradingAccount,
  TALLY_GROUPS,
  type VoucherInput
} from './accounting'
import {
  listProduction,
  getProductionItems,
  createProduction,
  deleteProduction
} from './production'
import {
  listGateEntries,
  nextGateEntryNo,
  listDispatchableSales,
  createGateEntry,
  updateGateEntry,
  completeGateEntry,
  deleteGateEntry, saveGateWeights, skipGateWeighment, partyCategories,
  rejectGateEntry, unrejectGateEntry } from './gate'
import { listCompanies, setActiveCompany, getActiveCompanyId } from './company'
import {
  needsApproval,
  submitApprovalRequest,
  listApprovalRequests,
  myApprovalRequests,
  pendingApprovalCount,
  approveRequest,
  rejectRequest
} from './approvals'
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
  deleteLCIssuance,
  precloseLC,
  getLcLimit,
  listBankLcLimits,
  saveLcLimit
} from './lc'
import {
  importBankStatement,
  listBankStatementImports,
  deleteBankStatementImport,
  listBankStatementLines,
  suggestBankLineMatch,
  reconcileBankLine,
  markBankLineMisc,
  unreconcileBankLine,
  setBankLineSubEntry
} from './bankRecon'
import {
  listBdParties,
  createBdParty,
  updateBdParty,
  deleteBdParty,
  listBdEntries,
  createBdEntry,
  markBdEntryPaid,
  markBdEntryRepaid,
  recordBdInterest,
  deleteBdEntry,
  bdFundFlowSummary
} from './billDiscounting'
import {
  listFacilities,
  listFacilityExposures,
  facilityHeadroom,
  createFacility,
  updateFacility,
  deleteFacility,
  saveExposure,
  deleteExposure
} from './facilities'
import {
  listSales,
  customerFyTaxable,
  createSale,
  updateSale,
  setSaleStatus,
  setSaleStage,
  deleteSale,
  createSaleInvoice,
  updateSaleInvoice,
  setInvoiceStage,
  deleteSaleInvoice,
  rejectSaleInvoice,
  unrejectSaleInvoice,
  listSalesBargains,
  createSalesBargain,
  updateSalesBargain,
  deleteSalesBargain,
  adjustSalesBargainQty,
  listCustomerLedger
} from './sales'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// --- Audit trail ---------------------------------------------------------
// Turn a channel + its args/result into a human-readable log line. Only a few
// safe fields are summarised — never the full payload (which can hold images).

const NS_ENTITY: Record<string, string> = {
  bargains: 'Bargain',
  orders: 'Purchase',
  tankers: 'Tanker',
  consignment: 'Consignment',
  sales: 'Sale',
  salesBargains: 'Sales bargain',
  billDiscount: 'Bill discount',
  lc: 'Letter of credit',
  journal: 'Journal',
  ledger: 'Ledger',
  production: 'Production',
  formulation: 'Formulation',
  stock: 'Stock',
  stockCount: 'Stock count',
  skuStock: 'Packed SKU stock',
  notes: 'Debit/Credit note',
  gate: 'Gate entry',
  users: 'User',
  access: 'Access',
  settings: 'Settings',
  company: 'Company'
}

const OP_VERB: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  advance: 'Advanced',
  record: 'Recorded',
  save: 'Saved',
  setStatus: 'Changed status',
  issue: 'Issued',
  addEntry: 'Added entry',
  deleteEntry: 'Deleted entry',
  createAccount: 'Created account',
  deleteIssuance: 'Deleted issuance',
  transfer: 'Transferred',
  deleteTransfer: 'Reversed transfer',
  setIp: 'Changed device',
  set: 'Changed setting'
}

function tableLabel(table: string): string {
  const map: Record<string, string> = {
    suppliers: 'Supplier',
    customers: 'Customer',
    transporters: 'Transporter',
    brokers: 'Broker',
    products: 'Product',
    sources: 'Port',
    uoms: 'UOM',
    companies: 'Company'
  }
  return map[table] || (table ? table.charAt(0).toUpperCase() + table.slice(1) : 'Record')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeArgs(args: any): string {
  const v = args?.values || args?.data || args || {}
  const parts: string[] = []
  const add = (label: string, val: unknown): void => {
    if (val != null && val !== '') parts.push(label ? `${label} ${val}` : String(val))
  }
  add('', v.name)
  add('Inv', v.invoice_no)
  add('', v.bargain_no)
  add('Tanker', v.tanker_no)
  add('LC', v.lc_no)
  add('Qty', v.qty ?? v.ordered_qty)
  add('₹', v.amount)
  if (args?.toStatus) parts.push(`→ ${args.toStatus}`)
  if (args?.key) parts.push(`${args.key} = ${args.value}`)
  return parts.join(' · ').slice(0, 220)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recordAudit(channel: string, args: any, result: any): Promise<void> {
  const [ns, op] = channel.split(':')
  const entity = ns === 'data' ? tableLabel(String(args?.table || '')) : NS_ENTITY[ns] || ns
  const action = OP_VERB[op] || op
  const entityId = Number(result?.id ?? args?.id) || null
  const detail = summarizeArgs(args)
  const user = getCurrentUser()
  await logEvent(
    user.id,
    user.username,
    machineIp(),
    action,
    detail,
    getActiveCompanyId(),
    entity,
    entityId
  )
}

// All database access lives here in the main process. The renderer (UI) can
// only call the specific channels we expose through the preload bridge, so the
// Turso token never reaches the UI layer.
export function registerIpc(): void {
  // Read-only channels don't change data, so they must not bump the revision.
  const READONLY =
    /:list$|:get$|:items$|:issuances$|:sheet$|:outstanding$|:all$|:summary$|:transfers$|:fyTaxable$|:needs$|:breakdown$|:nextNo$|:liveUsers$|:ips$|:logs$|:dispatchableSales$|:mine$|:pendingCount$|:pending$|:lots$|:unmapped$|:unmappedCount$|:bargainLines$|:consignmentDraws$|^access:heartbeat$|^db:ping$|^app:revision$|^auth:login$|^journal:accounts$|^journal:statement$|^journal:trialBalance$|^journal:groups$|^journal:groupNames$|^journal:pendingRefs$|^journal:tradingAccount$|^dashboard:stats$|^skuRates:parties$|^consignment:openingLog$|^consignment:invoices$|^gate:partyCategories$|^treasury:alerts$|^treasury:paymentTracker$|^facility:exposures$|^facility:headroom$|^company:setActive$|^company:getActive$|^session:setUser$|^lc:repayments$|^lc:getLimit$|^lc:bankLimits$|^lc:paymentIns$|^lc:openTradingInvoices$|^files:pickDocument$|^files:openDocument$|^bankRecon:imports$|^bankRecon:list$|^bankRecon:suggest$|^bd:parties$|^bd:entries$|^bd:fundFlow$|^trading:list$/
  // Writes that shouldn't clutter the audit trail (infra / no business meaning).
  const AUDIT_SKIP = new Set(['config:get', 'config:save', 'session:setUser'])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...a: any[]) => unknown): void => {
    ipcMain.handle(channel, async (e, args) => {
      // Writes pass the access gate first: the right itself, then the read-only
      // window on the entry's own date. Unmapped channels are untouched.
      if (!READONLY.test(channel)) await assertAllowed(channel, args)
      const result = await fn(e, args)
      if (!READONLY.test(channel)) {
        await bumpRevision().catch(() => {})
        if (!AUDIT_SKIP.has(channel)) await recordAudit(channel, args, result).catch(() => {})
      }
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
  handle('data:create', async (_e, { table, values }: { table: string; values: Row }) =>
    (await needsApproval(table)) ? submitApprovalRequest(table, values) : create(table, values)
  )
  handle(
    'data:update',
    (_e, { table, id, values }: { table: string; id: number; values: Row }) =>
      update(table, id, values)
  )
  handle('data:delete', (_e, { table, id }: { table: string; id: number }) =>
    remove(table, id)
  )

  handle('approvals:list', () => listApprovalRequests())
  handle('approvals:mine', () => myApprovalRequests())
  handle('approvals:pendingCount', () => pendingApprovalCount())
  handle('approvals:approve', (_e, { id }: { id: number }) => approveRequest(id))
  handle('approvals:reject', (_e, { id, reason }: { id: number; reason: string }) =>
    rejectRequest(id, reason)
  )

  handle('settings:get', (_e, { key }: { key: string }) => getSetting(key))
  handle('settings:set', (_e, { key, value }: { key: string; value: string }) =>
    setSetting(key, value)
  )
  handle('settings:all', () => allSettings())

  handle('bargains:list', (_e, args?: { from?: string; to?: string }) => listBargains(args?.from, args?.to))
  handle('bargains:create', (_e, { values }: { values: Row }) => createBargain(values))
  handle('bargains:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateBargain(id, values)
  )
  handle('bargains:delete', (_e, { id }: { id: number }) => deleteBargain(id))
  handle('bargains:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustBargainQty(id, delta, note, date)
  )

  handle('orders:list', () => listOrders())
  handle('skuRates:list', (_e, { id }: { id: number }) => listSkuRates(id))
  handle('skuRates:parties', (_e, { packagingId }: { packagingId: number }) => listPackagingParties(packagingId))
  handle('skuRates:setParties', (_e, { packagingId, customerIds }: { packagingId: number; customerIds: number[] }) => setPackagingParties(packagingId, customerIds))
  handle('skuRates:save', (_e, { id, rows }: { id: number; rows: Row[] }) => saveSkuRates(id, rows))
  handle('orders:consignmentDraws', () => listConsignmentDraws())
  handle('orders:bargainLines', (_e, { id }: { id: number }) => listOrderBargains(id))
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
  handle('tankers:revert', (_e, { id }: { id: number }) => revertPurchaseTanker(id))
  handle('tankers:replace', (_e, { id, values }: { id: number; values: Row }) => replaceTanker(id, values))
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
    'sales:fyTaxable',
    (_e, { customerId, date, excludeId }: { customerId: number; date: string; excludeId: number }) =>
      customerFyTaxable(customerId, date, excludeId)
  )
  handle(
    'orders:advance',
    (_e, { id, toStatus, data }: { id: number; toStatus: string; data: Row }) =>
      advanceOrder(id, toStatus, data)
  )

  handle('orders:unmapped', () => listUnmappedOrders())
  handle('orders:unmappedCount', () => unmappedCount())
  handle('orders:map', (_e, { id, lines, force }: { id: number; lines: Row[]; force?: boolean }) =>
    mapOrderToBargains(id, lines, !!force)
  )
  handle('consignment:list', () => listConsignment())
  handle('consignment:summary', (_e, args?: { range?: { from?: string; to?: string } }) => consignmentSummary(args?.range))
  handle('consignment:pending', () => listPendingGateArrivals())
  handle('consignment:invoices', (_e, args?: { range?: { from?: string; to?: string } }) =>
    listConsignmentInvoices(args?.range)
  )
  handle('consignment:lots', (_e, { supplierId, productId }: { supplierId?: number; productId?: number }) =>
    listUnbookedLots(supplierId, productId)
  )
  handle('consignment:create', (_e, { values }: { values: Row }) => createConsignment(values))
  handle('consignment:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateConsignment(id, values)
  )
  handle('consignment:delete', (_e, { id }: { id: number }) => deleteConsignment(id))
  handle('consignment:saveOpening', (_e, { values }: { values: Row }) => saveOpeningStock(values))
  handle('consignment:openingLog', (_e, { supplierId, productId }: { supplierId: number; productId: number }) =>
    listOpeningLog(supplierId, productId)
  )

  handle('journal:accounts', (_e, args?: { companyId?: number }) => listAccounts(args?.companyId))
  handle('journal:createAccount', (_e, { name, group }: { name: string; group?: string }) => createAccount(name, group))
  handle('journal:statement', (_e, { accountId, companyId }: { accountId: number; companyId?: number }) =>
    accountStatement(accountId, companyId)
  )
  handle('journal:addEntry', (_e, { data }: { data: Row }) => addManualJournal(data))
  handle('journal:trialBalance', (_e, args?: { from?: string; to?: string; companyId?: number }) =>
    trialBalance(args?.from, args?.to, args?.companyId)
  )
  handle('journal:groups', (_e, args?: { companyId?: number }) => listGroups(args?.companyId))
  handle('journal:groupNames', () => TALLY_GROUPS)
  handle('journal:pendingRefs', (_e, { account, companyId }: { account: string; companyId?: number }) => listPendingRefs(account, companyId))
  handle('journal:tradingAccount', (_e, { from, to, companyId }: { from?: string; to?: string; companyId?: number }) =>
    tradingAccount(from, to, companyId)
  )
  handle('dashboard:stats', () => dashboardStats())
  handle('vouchers:list', (_e, args?: { from?: string; to?: string; vchType?: string | string[]; companyId?: number }) =>
    listVouchers(args?.from, args?.to, args?.vchType, args?.companyId)
  )
  handle('vouchers:get', (_e, { id }: { id: number }) => getVoucher(id))
  handle('vouchers:create', (_e, { values }: { values: VoucherInput }) => createVoucher(values))
  handle('vouchers:update', (_e, { id, values }: { id: number; values: VoucherInput }) =>
    updateVoucher(id, values)
  )
  handle('vouchers:delete', (_e, { id }: { id: number }) => deleteManualEntry(id))
  handle('journal:deleteEntry', (_e, { id }: { id: number }) => deleteManualEntry(id))

  handle('ledger:suppliers', () => listSupplierLedger())
  handle('ledger:transporters', () => listTransporterLedger())
  handle('ledger:customers', () => listCustomerLedger())
  handle('ledger:addEntry', (_e, { data }: { data: Row }) => addLedgerEntry(data))
  handle('ledger:deleteEntry', (_e, { partyType, id }: { partyType: string; id: number }) =>
    deleteLedgerEntry(partyType, id)
  )

  // Bill discounting is read-only here — creating/altering happens from
  // Treasury now, which owns that flow end to end.
  handle('billDiscounts:list', () => listBillDiscounts())

  handle('auth:login', (_e, { username, password }: { username: string; password: string }) =>
    login(username, password)
  )
  handle('users:list', () => listUsers())
  handle('users:create', (_e, { values }: { values: Row }) => createUser(values))
  handle('users:update', (_e, { id, values }: { id: number; values: Row }) => {
    clearAccessCache()
    return updateUser(id, values)
  })
  handle('users:delete', (_e, { id }: { id: number }) => deleteUser(id))

  handle('access:heartbeat', (_e, { userId, username }: { userId: number; username: string }) =>
    heartbeat(userId, username)
  )
  handle('access:liveUsers', () => liveUsers())
  handle('access:ips', () => listIps())
  handle('access:setIp', (_e, { id, active }: { id: number; active: boolean }) =>
    setIpActive(id, active)
  )
  handle('access:logs', (_e, args?: { filter?: LogFilter }) => listLogs(args?.filter || {}))

  handle('session:setUser', (_e, { id, username }: { id: number | null; username: string }) =>
    setCurrentUser(id, username)
  )

  handle('formulations:list', () => listFormulations())
  handle('formulations:items', (_e, { id }: { id: number }) => getFormulationItems(id))
  handle('formulations:create', (_e, { values }: { values: Row }) => createFormulation(values))
  handle('formulations:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateFormulation(id, values)
  )
  handle('formulations:delete', (_e, { id }: { id: number }) => deleteFormulation(id))

  handle('stock:list', (_e, args?: { range?: { from?: string; to?: string }; companyIds?: number[] }) => stockLevels(args?.range, args?.companyIds))
  handle('stock:needs', () => productionNeeds())
  handle('stock:breakdown', (_e, args?: { companyIds?: number[]; range?: { from?: string; to?: string } }) =>
    stockPartyBreakdown(args?.companyIds, args?.range)
  )
  handle('daybook:list', (_e, { from, to }: { from: string; to: string }) => daybook(from, to))
  handle('stock:transfers', () => listStockTransfers())
  handle('stock:transfer', (_e, { values }: { values: Row }) => createStockTransfer(values))
  handle('stock:deleteTransfer', (_e, { id }: { id: number }) => deleteStockTransfer(id))
  handle('stockCount:sheet', (_e, { date }: { date: string }) => stockCountSheet(date))
  handle('stockCount:list', (_e, { date }: { date: string }) => listStockCounts(date))
  handle('stockCount:save', (_e, { date, items }: { date: string; items: Row[] }) =>
    saveStockCounts(date, items)
  )

  handle('skuStock:list', (_e, args?: { date?: string }) => listSkuStock(args?.date))
  handle('skuStock:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustSkuStock(id, delta, note, date)
  )

  handle('notes:list', () => listNotes())
  handle('notes:items', (_e, { id }: { id: number }) => listNoteItems(id))
  handle('notes:create', (_e, { values }: { values: Row }) => createNote(values))
  handle('notes:delete', (_e, { id }: { id: number }) => deleteNote(id))

  handle('production:list', () => listProduction())
  handle('production:items', (_e, { id }: { id: number }) => getProductionItems(id))
  handle('production:create', (_e, { values }: { values: Row }) => createProduction(values))
  handle('production:delete', (_e, { id }: { id: number }) => deleteProduction(id))

  handle('sales:list', () => listSales())
  handle('sales:create', (_e, { values }: { values: Row }) => createSale(values))
  handle('sales:update', (_e, { id, values }: { id: number; values: Row }) => updateSale(id, values))
  handle('sales:createInvoice', (_e, { values }: { values: Row }) => createSaleInvoice(values))
  handle('sales:updateInvoice', (_e, { group, values }: { group: string; values: Row }) => updateSaleInvoice(group, values))
  handle('sales:setInvoiceStage', (_e, { group, stage, force, date }: { group: string; stage: string; force?: boolean; date?: string }) =>
    setInvoiceStage(group, stage, force, date)
  )
  handle('sales:deleteInvoice', (_e, { group }: { group: string }) => deleteSaleInvoice(group))
  handle('sales:rejectInvoice', (_e, { group, reason }: { group: string; reason: string }) => rejectSaleInvoice(group, reason))
  handle('sales:unrejectInvoice', (_e, { group }: { group: string }) => unrejectSaleInvoice(group))
  handle('sales:setStatus', (_e, { id, status }: { id: number; status: string }) =>
    setSaleStatus(id, status)
  )
  handle('sales:setStage', (_e, { id, stage, force, date }: { id: number; stage: string; force?: boolean; date?: string }) =>
    setSaleStage(id, stage, force, date)
  )
  handle('sales:delete', (_e, { id }: { id: number }) => deleteSale(id))

  handle('salesBargains:list', (_e, args?: { from?: string; to?: string }) => listSalesBargains(args?.from, args?.to))
  handle('salesBargains:create', (_e, { values }: { values: Row }) => createSalesBargain(values))
  handle('salesBargains:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateSalesBargain(id, values)
  )
  handle('salesBargains:delete', (_e, { id }: { id: number }) => deleteSalesBargain(id))
  handle('salesBargains:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustSalesBargainQty(id, delta, note, date)
  )

  handle('gate:list', () => listGateEntries())
  handle('gate:nextNo', (_e, args?: { direction?: 'in' | 'out' }) => nextGateEntryNo(args?.direction))
  handle('gate:dispatchableSales', () => listDispatchableSales())
  handle('gate:partyCategories', () => partyCategories())
  handle('gate:create', (_e, { values }: { values: Row }) => createGateEntry(values))
  handle('gate:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateGateEntry(id, values)
  )
  handle('gate:complete', (_e, { id, gross, tare }: { id: number; gross: number; tare: number }) =>
    completeGateEntry(id, gross, tare)
  )
  handle(
    'gate:weights',
    (
      _e,
      {
        id,
        gross,
        tare,
        awaitingGrossOut,
        dispatchQty,
        invoiceGroup,
        outDate
      }: {
        id: number
        gross: number | null
        tare: number | null
        awaitingGrossOut?: boolean | null
        dispatchQty?: number | string | null
        invoiceGroup?: string | null
        outDate?: string | null
      }
    ) => saveGateWeights(id, gross, tare, awaitingGrossOut, dispatchQty, invoiceGroup, outDate)
  )
  handle('gate:skipWeighment', (_e, { id }: { id: number }) => skipGateWeighment(id))
  handle('gate:delete', (_e, { id }: { id: number }) => deleteGateEntry(id))
  handle('gate:reject', (_e, { id, reason }: { id: number; reason: string }) => rejectGateEntry(id, reason))
  handle('gate:unreject', (_e, { id }: { id: number }) => unrejectGateEntry(id))

  handle('lc:list', () => listLCs())
  handle('treasury:alerts', () => treasuryAlerts())
  handle('treasury:paymentTracker', () => listPaymentTracker())
  handle('treasury:settleLcBill', (_e, { id, date }: { id: number; date?: string }) => settleLcBill(id, date))
  handle('treasury:reopenLcBill', (_e, { id }: { id: number }) => reopenLcBill(id))
  handle('treasury:discount', (_e, { values }: { values: Row }) => discountBill(values))
  handle('treasury:realize', (_e, { id, date }: { id: number; date?: string }) => realizeBill(id, date))
  handle('treasury:unrealize', (_e, { id }: { id: number }) => unrealizeBill(id))
  handle('treasury:deleteDiscount', (_e, { id }: { id: number }) => deleteDiscountedBill(id))
  handle('lc:issuances', (_e, { lcId }: { lcId: number }) => listLCIssuances(lcId))
  handle('lc:create', (_e, { values }: { values: Row }) => createLC(values))
  handle('lc:update', (_e, { id, values }: { id: number; values: Row }) => updateLC(id, values))
  handle('lc:delete', (_e, { id }: { id: number }) => deleteLC(id))
  handle('lc:issue', (_e, { values }: { values: Row }) => issueLC(values))
  handle('lc:deleteIssuance', (_e, { id }: { id: number }) => deleteLCIssuance(id))
  handle(
    'lc:preclose',
    (
      _e,
      {
        id,
        values
      }: {
        id: number
        values: {
          preclose_date: string
          amount: number
          comm_charges?: number
          bank_charges?: number
          premature_interest?: number
          premature_interest_direction?: 'credit_to_us' | 'pay_to_party'
          release_margin?: boolean
        }
      }
    ) => precloseLC(id, values)
  )
  handle(
    'lc:paymentIn',
    (
      _e,
      { id, amount, date, selectedKeys }: { id: number; amount: number; date?: string; selectedKeys?: string[] }
    ) => postLcPaymentIn(id, amount, date, selectedKeys)
  )
  handle('lc:paymentIns', (_e, { lcId }: { lcId: number }) => listLcPaymentIns(lcId))
  handle('lc:deletePaymentIn', (_e, { id }: { id: number }) => deleteLcPaymentIn(id))
  handle('lc:openTradingInvoices', (_e, { lcId }: { lcId: number }) => listLcOpenTradingInvoices(lcId))
  handle('lc:repayments', (_e, { lcId }: { lcId: number }) => listLcRepayments(lcId))
  handle('lc:saveRepayment', (_e, { values }: { values: Row }) => saveLcRepayment(values))
  handle('lc:deleteRepayment', (_e, { id }: { id: number }) => deleteLcRepayment(id))
  handle('lc:getLimit', (_e, args?: { bankId?: number }) => getLcLimit(args?.bankId))
  handle('lc:bankLimits', () => listBankLcLimits())
  handle('lc:saveLimit', (_e, { values }: { values: Row }) => saveLcLimit(values))

  // File picker for the repayment's bank document — kept as a plain path to
  // the source file (no copy) rather than reading it into the DB; "Open" just
  // hands that path to the OS. Read-only: nothing changes until saved.
  handle('files:pickDocument', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] })
    return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] }
  })
  handle('files:openDocument', (_e, { path }: { path: string }) => {
    void shell.openPath(path)
    return { ok: true }
  })

  handle('bankRecon:import', (_e, { values }: { values: Row }) => importBankStatement(values))
  handle('bankRecon:imports', () => listBankStatementImports())
  handle('bankRecon:deleteImport', (_e, { id }: { id: number }) => deleteBankStatementImport(id))
  handle('bankRecon:list', (_e, { filter }: { filter: Row }) => listBankStatementLines(filter))
  handle('bankRecon:suggest', (_e, { lineId }: { lineId: number }) => suggestBankLineMatch(lineId))
  handle('bankRecon:reconcile', (_e, { lineId, values }: { lineId: number; values: Row }) => reconcileBankLine(lineId, values))
  handle('bankRecon:markMisc', (_e, { lineId }: { lineId: number }) => markBankLineMisc(lineId))
  handle('bankRecon:unreconcile', (_e, { lineId }: { lineId: number }) => unreconcileBankLine(lineId))
  handle('bankRecon:setSubEntry', (_e, { lineId, values }: { lineId: number; values: Row }) => setBankLineSubEntry(lineId, values))

  handle('bd:parties', () => listBdParties())
  handle('bd:createParty', (_e, { values }: { values: Row }) => createBdParty(values))
  handle('bd:updateParty', (_e, { id, values }: { id: number; values: Row }) => updateBdParty(id, values))
  handle('bd:deleteParty', (_e, { id }: { id: number }) => deleteBdParty(id))
  handle('bd:entries', (_e, { filter }: { filter: Row }) => listBdEntries(filter))
  handle('bd:createEntry', (_e, { values }: { values: Row }) => createBdEntry(values))
  handle('bd:markPaid', (_e, { id, date }: { id: number; date?: string }) => markBdEntryPaid(id, date))
  handle('bd:markRepaid', (_e, { id, date }: { id: number; date?: string }) => markBdEntryRepaid(id, date))
  handle('bd:recordInterest', (_e, { id, values }: { id: number; values: Row }) => recordBdInterest(id, values))
  handle('bd:deleteEntry', (_e, { id }: { id: number }) => deleteBdEntry(id))
  handle('bd:fundFlow', () => bdFundFlowSummary())

  handle('trading:list', () => listTradingDeals())
  handle('trading:create', (_e, { values }: { values: Row }) => createTradingDeal(values))
  handle('trading:update', (_e, { id, values }: { id: number; values: Row }) => updateTradingDeal(id, values))
  handle('trading:delete', (_e, { id }: { id: number }) => deleteTradingDeal(id))

  handle('facility:list', () => listFacilities())
  handle('facility:exposures', (_e, { facilityId }: { facilityId: number }) => listFacilityExposures(facilityId))
  handle('facility:headroom', (_e, { facilityId, excludeLcId }: { facilityId: number; excludeLcId?: number }) =>
    facilityHeadroom(facilityId, excludeLcId || 0)
  )
  handle('facility:create', (_e, { values }: { values: Row }) => createFacility(values))
  handle('facility:update', (_e, { id, values }: { id: number; values: Row }) => updateFacility(id, values))
  handle('facility:delete', (_e, { id }: { id: number }) => deleteFacility(id))
  handle('facility:saveExposure', (_e, { values }: { values: Row }) => saveExposure(values))
  handle('facility:deleteExposure', (_e, { id }: { id: number }) => deleteExposure(id))
}
