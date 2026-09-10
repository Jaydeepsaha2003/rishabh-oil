import { ipcMain, dialog, shell } from 'electron'
import { ping, bumpRevision, getRevision, initDb, resetClient, getConfiguredUrl, notifyDataChanged, getClient } from './db'
import {
  listNotificationRules, saveNotificationRule, resetNotificationRule, runNotificationRules,
  listNotifications, markNotificationsRead, markNotificationUnread, clearNotifications,
  previewNotificationRule, notificationRecipients, listNotificationMutes, muteNotificationRule
} from './notify'
import { snapshotGz } from './dbsnapshot'
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
  listTankerQuality,
  listFfaHistory,
  saveTankerQuality,
  listOrderQuality,
  saveOrderQuality,
  supplierFyTaxable,
  listOrderBargains,
  listOrderBargainInterest,
  listConsignmentDraws,
  listSupplierLedger,
  listTransporterLedger,
  addLedgerEntry,
  deleteLedgerEntry, purchaseBargainNotes } from './orders'
import { listUnmappedOrders, unmappedCount, mapOrderToBargains } from './unmapped'
import { listTradingDeals, createTradingDeal, updateTradingDeal, deleteTradingDeal } from './trading'
import { assertAllowed, clearAccessCache, currentScope, entryWindows } from './access-gate'
import { listSkuRates, saveSkuRates, listPackagingParties, setPackagingParties, packagingPartyCounts } from './skurates'
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
import { heartbeat, liveUsers, listIps, setIpActive, listLogs, logEvent, machineIp, type LogFilter, entityHistory } from './access'
import { getCurrentUser, setCurrentUser } from './currentUser'
import { getBooksFrom, setBooksFrom, listOpenings, saveOpenings, ledgerOpening } from './openings'
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
  stockRegisters,
  listStockTransfers,
  createStockTransfer,
  deleteStockTransfer
} from './stock'
import {
  addWorkNote,
  approveWorkTask,
  assignWorkTask,
  listWorkBoard,
  listWorkProcesses,
  redoWorkTask,
  removeWorkProcess,
  removeWorkTask,
  saveWorkProcess,
  sendBackWorkTask,
  setWorkCutoff,
  tickWorkTask,
  workCutoff
} from './work'
import {
  addPpStage,
  listPpStages,
  listStockOpenings,
  removePpStage,
  savePpLines,
  saveStockOpenings,
  stockOpeningDate
} from './stockopenings'
import { listOutsideTankers, saveOutsideTanker, recordNilRound, removeOutsideTanker } from './outsidetankers'
import {
  listFormulationSubcategories,
  listFormulationVersions,
  saveFormulationSubcategory,
  deleteFormulationSubcategory
} from './formulations'
import { stockCountSheet, listStockCounts, saveStockCounts, previousStockCount, stockCountHistory } from './stockcount'
import { listSkuStock, adjustSkuStock, skuMovementBreakdown, listSkuAdjustments, deleteSkuAdjustment,
  listSkuOpenings, saveSkuOpenings, skuOpeningDate } from './skustock'
import { listNotes, listNoteItems, createNote, updateNote, deleteNote } from './notes'
import { daybook } from './daybook'
import { dashboardStats } from './dashboard'
import {
  treasuryAlerts,
  listPaymentTracker,
  settleLcBill,
  reopenLcBill,
  listLcRepayments,
  saveLcRepayment,
  deleteLcRepayment,
  postLcPaymentIn,
  listLcPaymentIns,
  deleteLcPaymentIn,
  listLcOpenTradingInvoices,
  postBdPaymentIn,
  listBdPaymentIns,
  deleteBdPaymentIn,
  listBdOpenTradingInvoices,
  listAllLcRepayments
} from './treasury'
import {
  createVoucher,
  updateVoucher,
  getVoucher,
  listVouchers,
  trialBalance,
  listGroups,
  listPendingRefs,
  billsOutstanding,
  tradingAccount,
  TALLY_GROUPS,
  type VoucherInput
} from './accounting'
import {
  listProduction,
  productionReport,
  getProductionItems,
  createProduction,
  updateProduction,
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
  waiveGateOut, unwaiveGateOut, waiveGateOuts, listWaivedGateOuts,
  rejectGateEntry, unrejectGateEntry, gateEntriesFor } from './gate'
import {
  listCompanies,
  setActiveCompany,
  getActiveCompanyId,
  listFactories,
  saveFactory,
  companiesOfFactory,
  activeFactory
} from './company'
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
  unPrecloseLC,
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
import { listBd, createBd, updateBd, deleteBd, repayBd, reopenBd, postBdUpfrontInterest, bdKpis, listBdRepayments, deleteBdRepayment, markBdPaymentReceived, unmarkBdPaymentReceived, listAllBdRepayments, listBdLinkedOrders, bdLimits, setBdCombinedLimit, listBdParties, listAllBdParties } from './billDiscounting'
import {
  listTransporterFreight,
  transporterFreightKpis,
  listOrphanedTransporterBills,
  listTransporterBills,
  createTransporterBill,
  updateTransporterBill,
  deleteTransporterBill,
  raiseFreightShortageNote,
  unraiseFreightShortageNote,
  waiveFreightShortage,
  unwaiveFreightShortage,
  type FreightSide
} from './transporterBilling'
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
  listSalesForUnloadDesk,
  cancelSaleDelivery,
  listSalesBargainReturns,
  listUnattributedReturns,
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
  listCustomerLedger,
  salesInvoiceGaps,
  cancelInvoiceNo,
  uncancelInvoiceNo,
  salesInvoiceSeries
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
  bd: 'Bill discount',
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
  // These were falling through and being stored as the raw channel word
  // ('preclose', 'unpreclose'), which read like code in the trail.
  preclose: 'Preclosed',
  unpreclose: 'Undid preclosure',
  markReceived: 'Marked payment received',
  unmarkReceived: 'Undid payment received',
  repay: 'Repaid',
  deleteRepayment: 'Removed a repayment',
  deleteAdjustment: 'Removed a packed-stock entry',
  reopen: 'Reopened',
  saveLimit: 'Changed the facility limit',
  upfrontInterest: 'Posted upfront interest',
  createInvoice: 'Created',
  updateInvoice: 'Updated',
  deleteInvoice: 'Deleted',
  rejectInvoice: 'Rejected',
  unrejectInvoice: 'Un-rejected',
  setInvoiceStage: 'Moved the dispatch stage',
  setStage: 'Moved the dispatch stage',
  cancelDelivery: 'Cancelled the delivery',
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
  // Not every record has a numeric id to be logged against. A sales invoice is
  // a GROUP of line rows addressed by its group string, so every sales event
  // used to land with no record key at all and the trail could not say which
  // invoice it belonged to. Whatever names the record gets recorded too.
  const key = args?.group ?? args?.invoice_group ?? result?.group ?? result?.invoice_group ?? null
  const entityKey = key == null || key === '' ? null : String(key)
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
    entityId,
    entityKey
  )
}

// All database access lives here in the main process. The renderer (UI) can
// only call the specific channels we expose through the preload bridge, so the
// Turso token never reaches the UI layer.
export function registerIpc(): void {
  // Read-only channels don't change data, so they must not bump the revision.
  const READONLY =
    /:list$|:get$|:items$|:issuances$|:sheet$|:outstanding$|:all$|:summary$|:transfers$|:fyTaxable$|:needs$|:breakdown$|:nextNo$|:liveUsers$|:ips$|:logs$|:dispatchableSales$|:mine$|:pendingCount$|:pending$|:lots$|:unmapped$|:unmappedCount$|:bargainLines$|:bargainNotes$|:bargainInterest$|:consignmentDraws$|^access:heartbeat$|^db:ping$|^db:snapshot$|^app:revision$|^auth:login$|^journal:booksFrom$|^journal:openings$|^journal:opening$|^journal:accounts$|^journal:statement$|^journal:trialBalance$|^journal:groups$|^journal:groupNames$|^journal:pendingRefs$|^journal:billsOutstanding$|^journal:tradingAccount$|^dashboard:stats$|^skuRates:parties$|^skuRates:partyCounts$|^consignment:openingLog$|^consignment:invoices$|^tankers:quality$|^tankers:ffaHistory$|^orders:quality$|^gate:partyCategories$|^gate:waivedOuts$|^gate:forRecord$|^notify:rules$|^notify:list$|^notify:run$|^notify:preview$|^notify:people$|^notify:mutes$|^treasury:alerts$|^treasury:paymentTracker$|^facility:exposures$|^facility:headroom$|^company:setActive$|^company:getActive$|^factory:active$|^factory:companies$|^session:setUser$|^lc:repayments$|^lc:allRepayments$|^lc:getLimit$|^lc:bankLimits$|^lc:paymentIns$|^lc:openTradingInvoices$|^files:pickDocument$|^files:openDocument$|^bankRecon:imports$|^bankRecon:list$|^bankRecon:suggest$|^bd:kpis$|^bd:limits$|^skuStock:adjustments$|^skuOpening:list$|^skuOpening:date$|^stockCount:previous$|^stockOpening:list$|^stockOpening:date$|^stockOpening:ppStages$|^work:board$|^work:cutoff$|^work:processes$|^formulationSubcategory:list$|^formulations:versions$|^bd:allRepayments$|^bd:linkedOrders$|^bd:parties$|^bd:allParties$|^bd:openTradingInvoices$|^bd:paymentIns$|^access:entryWindows$|^access:entityHistory$|^trading:list$|^sales:series$|^sales:invoiceGaps$|^salesBargains:returns$|^salesBargains:unattributedReturns$|^tbill:orphans$|^production:report$/
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
        // Anything cached off the old data is now wrong. Done here as well as
        // inside bumpRevision because that call is allowed to fail on a bad
        // connection, and a failed revision bump must not leave a stale master
        // list being served from memory after a write that did land.
        notifyDataChanged()
        await bumpRevision().catch(() => {})
        if (!AUDIT_SKIP.has(channel)) await recordAudit(channel, args, result).catch(() => {})
      }
      return result
    })
  }

  handle('app:revision', () => getRevision())

  handle('db:ping', () => ping())

  // A full copy of this database as portable SQL, gzipped, for the website to
  // be restored from. Whatever THIS build is pointed at: Turso in the desktop
  // app, the local file on the server.
  //
  // Read-only, so it is in the list above and does not bump the revision — a
  // download is not a change and must not make every open screen refetch. The
  // audit note is written here instead, because handing someone the entire
  // database is precisely the kind of thing the trail exists to record.
  handle('db:snapshot', async () => {
    const user = getCurrentUser()
    const who = await getClient()
      .execute({ sql: 'SELECT role FROM users WHERE id = ? AND active = 1', args: [user.id] })
      .catch(() => null)
    if (String(who?.rows[0]?.role || '') !== 'admin') {
      throw new Error('Only an administrator can download the database.')
    }
    const snap = await snapshotGz()
    await logEvent(
      user.id,
      user.username,
      machineIp(),
      'Downloaded a database snapshot',
      `${snap.rows.toLocaleString()} rows across ${snap.tables} tables · ${(snap.gzBytes / 1048576).toFixed(2)} MB`,
      getActiveCompanyId(),
      'Database',
      null,
      null
    ).catch(() => {
      // The snapshot is made; failing to note it must not fail the download.
    })
    return snap
  })

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
  // Factories: the physical sites stock and production belong to. Companies
  // are attached to one; everything else about a company is unchanged.
  handle('factory:list', () => listFactories())
  handle('factory:save', (_e, v: Record<string, unknown>) => saveFactory(v))
  handle('factory:active', () => activeFactory())
  handle('factory:companies', (_e, factoryId?: number) => companiesOfFactory(factoryId))
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

  // forModule: the page doing the reading. A register borrowed by another page
  // keeps THAT page's visible window, so a narrow window on one module never
  // silently shortens another module's figures.
  handle('bargains:list', (_e, args?: { from?: string; to?: string; companyIds?: number[]; forModule?: string }) =>
    listBargains(args?.from, args?.to, args?.companyIds, args?.forModule)
  )
  handle('bargains:create', (_e, { values }: { values: Row }) => createBargain(values))
  handle('bargains:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateBargain(id, values)
  )
  handle('bargains:delete', (_e, { id }: { id: number }) => deleteBargain(id))
  handle('bargains:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustBargainQty(id, delta, note, date)
  )

  handle('orders:bargainNotes', (_e, { id }: { id: number }) => purchaseBargainNotes(id))
  handle('orders:list', (_e, args?: { forModule?: string }) => listOrders(args?.forModule))
  handle('skuRates:list', (_e, { id }: { id: number }) => listSkuRates(id))
  handle('skuRates:partyCounts', () => packagingPartyCounts())
  handle('skuRates:parties', (_e, { packagingId }: { packagingId: number }) => listPackagingParties(packagingId))
  handle('skuRates:setParties', (_e, { packagingId, customerIds }: { packagingId: number; customerIds: number[] }) => setPackagingParties(packagingId, customerIds))
  handle('skuRates:save', (_e, { id, rows }: { id: number; rows: Row[] }) => saveSkuRates(id, rows))
  handle('orders:consignmentDraws', (_e, args?: { companyIds?: number[] }) => listConsignmentDraws(args?.companyIds))
  handle('orders:bargainLines', (_e, { id }: { id: number }) => listOrderBargains(id))
  handle('orders:bargainInterest', (_e, { id }: { id: number }) => listOrderBargainInterest(id))
  handle('tankers:list', (_e, args?: { all?: boolean; forModule?: string }) =>
    listPurchaseTankers(!!args?.all, args?.forModule)
  )
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
  handle('tankers:quality', (_e, { id }: { id: number }) => listTankerQuality(Number(id)))
  // Read-only, and listed in READONLY above so it neither passes the write
  // gate nor bumps the data revision — it answers a question, it changes
  // nothing.
  handle('tankers:ffaHistory', (_e, a: { productId?: number; limit?: number }) =>
    listFfaHistory(Number(a?.productId || 0), Number(a?.limit || 60))
  )
  handle('tankers:saveQuality', async (_e, { id, rows }: { id: number; rows: Row[] }) => {
    await saveTankerQuality(Number(id), Array.isArray(rows) ? rows : [])
    return { id: Number(id) }
  })
  handle('orders:quality', (_e, { id }: { id: number }) => listOrderQuality(Number(id)))
  handle('orders:saveQuality', async (_e, { id, rows }: { id: number; rows: Row[] }) => {
    await saveOrderQuality(Number(id), Array.isArray(rows) ? rows : [])
    return { id: Number(id) }
  })
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
  handle('consignment:list', (_e, args?: { forModule?: string }) => listConsignment(args?.forModule))
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

  // Books beginning from, and the opening balance grid that stands in for
  // everything before it.
  handle('journal:booksFrom', (_e, args?: { companyId?: number }) => getBooksFrom(args?.companyId))
  handle('journal:setBooksFrom', (_e, { date, companyId }: { date: string | null; companyId?: number }) =>
    setBooksFrom(date, companyId)
  )
  handle('journal:openings', (_e, args?: { companyId?: number }) => listOpenings(args?.companyId))
  handle('journal:saveOpenings', (_e, { rows, companyId }: { rows: Row[]; companyId?: number }) =>
    saveOpenings(rows as { account_id: number; dr?: number; cr?: number }[], companyId)
  )
  handle('journal:opening', (_e, { accountId, companyId }: { accountId: number; companyId?: number }) =>
    ledgerOpening(accountId, companyId)
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
  handle(
    'journal:billsOutstanding',
    (_e, a: { account: string; companyId?: number; asOf?: string; side?: 'customer' | 'supplier' }) =>
      billsOutstanding(a.account, a.companyId, { asOf: a.asOf, side: a.side })
  )
  handle(
    'journal:pendingRefs',
    (_e, { account, companyId, side }: { account: string; companyId?: number; side?: 'customer' | 'supplier' }) =>
      listPendingRefs(account, companyId, side)
  )
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
  // The earliest date each module's forms may offer this user. A read, and a
  // hint only — the gate refuses the write regardless of what the form sends.
  handle('access:entryWindows', () => entryWindows())
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
  handle('formulations:versions', (_e, { id }: { id: number }) => listFormulationVersions(Number(id)))
  handle('formulations:create', (_e, { values }: { values: Row }) => createFormulation(values))
  handle('formulations:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateFormulation(id, values)
  )
  handle('formulations:delete', (_e, { id }: { id: number }) => deleteFormulation(id))

  handle('stock:list', (_e, args?: { range?: { from?: string; to?: string }; companyIds?: number[] }) => stockLevels(args?.range, args?.companyIds))
  handle('stock:needs', () => productionNeeds())
  handle('stock:registers', (_e, args?: { companyIds?: number[]; range?: { from?: string; to?: string } }) =>
    stockRegisters(args?.companyIds, args?.range)
  )
  handle('stock:breakdown', (_e, args?: { companyIds?: number[]; range?: { from?: string; to?: string } }) =>
    stockPartyBreakdown(args?.companyIds, args?.range)
  )
  handle('daybook:list', (_e, { from, to }: { from: string; to: string }) => daybook(from, to))
  handle('stock:transfers', () => listStockTransfers())
  handle('stock:transfer', (_e, { values }: { values: Row }) => createStockTransfer(values))
  handle('stock:deleteTransfer', (_e, { id }: { id: number }) => deleteStockTransfer(id))
  handle('stockCount:previous', (_e, { date }: { date: string }) => previousStockCount(date))
  handle('stockCount:sheet', (_e, { date }: { date: string }) => stockCountSheet(date))
  handle('stockCount:list', (_e, { date }: { date: string }) => listStockCounts(date))
  handle('stockCount:save', (_e, { date, items }: { date: string; items: Row[] }) =>
    saveStockCounts(date, items)
  )

  handle('formulationSubcategory:list', () => listFormulationSubcategories())
  handle('formulationSubcategory:save', (_e, { values }: { values: Row }) =>
    saveFormulationSubcategory(values)
  )
  handle('formulationSubcategory:delete', (_e, { id }: { id: number }) =>
    deleteFormulationSubcategory(id)
  )
  handle('sales:cancelInvoiceNo', (_e, { values }: { values: Row }) => cancelInvoiceNo(values))
  handle('sales:uncancelInvoiceNo', (_e, { values }: { values: Row }) => uncancelInvoiceNo(values))
  handle('outsideTanker:list', (_e, { date }: { date?: string } = {}) => listOutsideTankers(date))
  handle('outsideTanker:save', (_e, v: Record<string, unknown>) => saveOutsideTanker(v))
  handle('outsideTanker:remove', (_e, { id }: { id: number }) => removeOutsideTanker(id))
  handle('outsideTanker:nil', (_e, { date, slot }: { date: string; slot: string }) => recordNilRound(date, slot))
  handle('stockOpening:list', (_e, { companyId }: { companyId?: number } = {}) =>
    listStockOpenings(companyId)
  )
  handle('stockOpening:save', (_e, { rows, asOf, companyId }: { rows: Row[]; asOf: string; companyId?: number }) =>
    saveStockOpenings(rows, asOf, companyId)
  )
  // Just the date, for the app's default period. The full sheet is far too
  // heavy to fetch at startup for one string.
  handle('stockOpening:date', (_e, { companyId }: { companyId?: number } = {}) =>
    stockOpeningDate(companyId)
  )
  // What a PP figure is made of, stage by stage. The stage list is the SITE's
  // and is shared by every product on the sheet, which is why adding and
  // removing one are channels of their own rather than part of the save: they
  // change what every other row is offered.
  handle('stockOpening:ppStages', (_e, { companyId }: { companyId?: number } = {}) =>
    listPpStages(companyId)
  )
  handle('stockOpening:addPpStage', (_e, { name, companyId }: { name: string; companyId?: number }) =>
    addPpStage(name, companyId)
  )
  handle(
    'stockOpening:removePpStage',
    (_e, { stageId, companyId }: { stageId: number; companyId?: number }) =>
      removePpStage(stageId, companyId)
  )
  handle(
    'stockOpening:savePp',
    (_e, { productId, lines, companyId }: { productId: number; lines: Row[]; companyId?: number }) =>
      savePpLines(productId, lines, companyId)
  )
  // The day's work board. Read by everyone — the whole point is that each
  // person sees their own checklist — and every write names the user making
  // it, because who ticked and who approved is the record.
  handle('work:board', (_e, { date }: { date?: string } = {}) => listWorkBoard(date))
  handle('work:cutoff', () => workCutoff())
  handle('work:setCutoff', (_e, { cutoff }: { cutoff: string }) => setWorkCutoff(cutoff))
  handle('work:processes', () => listWorkProcesses())
  handle('work:saveProcess', (_e, { values }: { values: Row }) => saveWorkProcess(values))
  handle('work:removeProcess', (_e, { id }: { id: number }) => removeWorkProcess(id))
  handle('work:tick', (_e, { taskId, userId }: { taskId: number; userId: number }) =>
    tickWorkTask(taskId, userId)
  )
  handle('work:redo', (_e, { taskId, userId }: { taskId: number; userId: number }) =>
    redoWorkTask(taskId, userId)
  )
  handle(
    'work:approve',
    (_e, { taskId, userId, note }: { taskId: number; userId: number; note?: string }) =>
      approveWorkTask(taskId, userId, note)
  )
  handle(
    'work:sendBack',
    (_e, { taskId, userId, note }: { taskId: number; userId: number; note: string }) =>
      sendBackWorkTask(taskId, userId, note)
  )
  handle('work:note', (_e, { taskId, userId, text }: { taskId: number; userId: number; text: string }) =>
    addWorkNote(taskId, userId, text)
  )
  handle('work:assign', (_e, { values, userId }: { values: Row; userId: number }) =>
    assignWorkTask(values, userId)
  )
  handle('work:removeTask', (_e, { taskId, userId }: { taskId: number; userId: number }) =>
    removeWorkTask(taskId, userId)
  )
  handle('stockCount:history', (_e, { from, to }: { from: string; to: string }) => stockCountHistory(from, to))
  handle(
    'skuStock:breakdown',
    (_e, { date }: { date?: string | { from?: string; to?: string } } = {}) => skuMovementBreakdown(date)
  )
  handle(
    'skuStock:list',
    (_e, args?: { date?: string | { from?: string; to?: string } }) => listSkuStock(args?.date)
  )
  handle('skuStock:adjustments', (_e, { id }: { id: number }) => listSkuAdjustments(id))
  handle('skuOpening:list', (_e, args?: { asOf?: string }) => listSkuOpenings(undefined, args?.asOf))
  handle('skuOpening:date', () => skuOpeningDate())
  handle('skuOpening:save', (_e, { rows, asOf }: { rows: Row[]; asOf: string }) => saveSkuOpenings(rows, asOf))
  handle('skuStock:deleteAdjustment', (_e, { id }: { id: number }) => deleteSkuAdjustment(id))
  handle(
    'skuStock:adjust',
    (
      _e,
      { id, delta, note, date, kind }: { id: number; delta: number; note?: string; date?: string; kind?: string }
    ) => adjustSkuStock(id, delta, note, date, kind)
  )

  handle(
    'tfreight:list',
    (_e, a: { side: FreightSide; companyId?: number; from?: string; to?: string; transporterId?: number; state?: 'all' | 'unbilled' | 'billed' }) =>
      listTransporterFreight(a.side, a)
  )
  handle('tfreight:kpis', (_e, a: { side: FreightSide; companyId?: number; from?: string; to?: string }) =>
    transporterFreightKpis(a.side, a)
  )
  handle('tbill:list', (_e, a: { companyId?: number } = {}) => listTransporterBills(a?.companyId))
  handle('tbill:create', (_e, { values }: { values: Row }) => createTransporterBill(values))
  handle(
    'tfreight:raiseNote',
    (_e, { lineId, date, companyId }: { lineId: number; date?: string; companyId?: number }) =>
      raiseFreightShortageNote(lineId, { date, companyId })
  )
  handle('tfreight:unraiseNote', (_e, { lineId, companyId }: { lineId: number; companyId?: number }) =>
    unraiseFreightShortageNote(lineId, companyId)
  )
  handle(
    'tfreight:waive',
    (_e, { lineId, reason, date, companyId }: { lineId: number; reason: string; date?: string; companyId?: number }) =>
      waiveFreightShortage(lineId, { reason, date, companyId })
  )
  handle('tfreight:unwaive', (_e, { lineId, companyId }: { lineId: number; companyId?: number }) =>
    unwaiveFreightShortage(lineId, companyId)
  )
  handle('tbill:update', (_e, { id, values }: { id: number; values: Row }) => updateTransporterBill(id, values))
  handle('tbill:delete', (_e, { id, companyId }: { id: number; companyId?: number }) =>
    deleteTransporterBill(id, companyId)
  )
  handle('tbill:orphans', (_e, a: { companyId?: number } = {}) => listOrphanedTransporterBills(a?.companyId))
  handle('notes:list', (_e, a: { companyId?: number } = {}) => listNotes(a?.companyId))
  handle('notes:items', (_e, { id }: { id: number }) => listNoteItems(id))
  handle('notes:create', (_e, { values }: { values: Row }) => createNote(values))
  handle('notes:update', (_e, { id, values }: { id: number; values: Row }) => updateNote(id, values))
  handle('notes:delete', (_e, { id, companyId }: { id: number; companyId?: number }) => deleteNote(id, companyId))

  handle('production:list', (_e, args?: { forModule?: string }) => listProduction(args?.forModule))
  handle('production:items', (_e, { id }: { id: number }) => getProductionItems(id))
  // Read-only. The name ends in :report, which the READONLY regex below also
  // has to match — a channel that misses it passes the write gate and bumps
  // the revision, so every open page would treat drawing this report as
  // somebody else's edit and refresh itself in a loop.
  handle('production:report', (_e, args?: { range?: { from?: string; to?: string }; companyIds?: number[] }) =>
    productionReport(args?.range, args?.companyIds)
  )
  handle('production:create', (_e, { values }: { values: Row }) => createProduction(values))
  handle('production:update', (_e, { id, values }: { id: number; values: Row }) => updateProduction(id, values))
  handle('production:delete', (_e, { id }: { id: number }) => deleteProduction(id))

  // The unload desk's grant hands back its own thin row set — the money columns
  // are never selected, so a restricted user cannot reach them even by calling
  // the channel directly.
  handle('sales:list', async (_e, args?: { companyIds?: number[]; forModule?: string }) =>
    (await currentScope('sales')) === 'unload'
      ? listSalesForUnloadDesk(args?.companyIds)
      : listSales(args?.companyIds, args?.forModule)
  )
  // Which numbers are missing from the KRFL / KRFIN invoice series.
  handle('sales:series', (_e, args?: { companyId?: number }) => salesInvoiceSeries(args?.companyId))
  handle('sales:invoiceGaps', (_e, args?: { companyId?: number; from?: string; to?: string }) =>
    salesInvoiceGaps(args?.companyId, { from: args?.from, to: args?.to })
  )
  handle('sales:create', (_e, { values }: { values: Row }) => createSale(values))
  handle('sales:update', (_e, { id, values }: { id: number; values: Row }) => updateSale(id, values))
  handle('sales:createInvoice', (_e, { values }: { values: Row }) => createSaleInvoice(values))
  handle('sales:updateInvoice', (_e, { group, values }: { group: string; values: Row }) => updateSaleInvoice(group, values))
  handle(
    'sales:setInvoiceStage',
    (
      _e,
      { group, stage, force, date, received }: { group: string; stage: string; force?: boolean; date?: string; received?: Record<string, number | null> }
    ) => setInvoiceStage(group, stage, force, date, received)
  )
  handle('sales:deleteInvoice', (_e, { group }: { group: string }) => deleteSaleInvoice(group))
  handle('sales:rejectInvoice', (_e, { group, reason }: { group: string; reason: string }) => rejectSaleInvoice(group, reason))
  handle(
    'sales:cancelDelivery',
    (_e, { group, reason, freightQty }: { group: string; reason: string; freightQty?: Record<string, number | null> }) =>
      cancelSaleDelivery(group, reason, freightQty)
  )
  handle('sales:unrejectInvoice', (_e, { group }: { group: string }) => unrejectSaleInvoice(group))
  handle('sales:setStatus', (_e, { id, status }: { id: number; status: string }) =>
    setSaleStatus(id, status)
  )
  handle('sales:setStage', (_e, { id, stage, force, date }: { id: number; stage: string; force?: boolean; date?: string }) =>
    setSaleStage(id, stage, force, date)
  )
  handle('sales:delete', (_e, { id }: { id: number }) => deleteSale(id))

  handle('salesBargains:list', (_e, args?: { from?: string; to?: string; companyIds?: number[]; forModule?: string }) =>
    listSalesBargains(args?.from, args?.to, args?.companyIds, args?.forModule)
  )
  handle('salesBargains:returns', (_e, args?: { companyIds?: number[] }) => listSalesBargainReturns(args?.companyIds))
  handle('salesBargains:unattributedReturns', (_e, args?: { companyIds?: number[] }) =>
    listUnattributedReturns(args?.companyIds)
  )
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
  handle('gate:waivedOuts', () => listWaivedGateOuts())
  handle('notify:rules', () => listNotificationRules())
  handle('notify:saveRule', (_e, a) => saveNotificationRule(a))
  handle('notify:resetRule', (_e, a) => resetNotificationRule(String(a.key)))
  handle('notify:run', () => runNotificationRules())
  handle('notify:preview', (_e, a) => previewNotificationRule(String(a.key)))
  handle('notify:people', () => notificationRecipients())
  handle('notify:mutes', (_e, a) => listNotificationMutes(Number(a?.userId) || 0))
  handle('notify:mute', (_e, a) => muteNotificationRule(Number(a.userId) || 0, String(a.key), !!a.muted))
  handle('notify:list', (_e, a) =>
    listNotifications(Number(a?.userId) || 0, !!a?.isAdmin, Number(a?.limit) || 50))
  handle('notify:markRead', (_e, a) =>
    markNotificationsRead(Number(a.userId) || 0, (a.ids as number[]) || []))
  handle('notify:markUnread', (_e, a) =>
    markNotificationUnread(Number(a.userId) || 0, Number(a.id) || 0))
  handle('notify:clear', (_e, a) => clearNotifications(Number(a.userId) || 0, !!a.isAdmin))
  handle('gate:waiveOut', (_e, a) => waiveGateOut(String(a.group), String(a.reason || '')))
  handle('gate:unwaiveOut', (_e, a) => unwaiveGateOut(String(a.group)))
  handle('gate:waiveOuts', (_e, a) => waiveGateOuts((a.groups as string[]) || [], String(a.reason || '')))
  handle('gate:partyCategories', () => partyCategories())
  handle(
    'gate:forRecord',
    (_e, args: { orderId?: number; saleIds?: number[]; invoiceGroup?: string }) => gateEntriesFor(args)
  )
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
        outDate,
        outTime
      }: {
        id: number
        gross: number | null
        tare: number | null
        awaitingGrossOut?: boolean | null
        dispatchQty?: number | string | null
        // One or more: a tanker can carry several bills out on one trip.
        invoiceGroup?: string | string[] | null
        outDate?: string | null
        outTime?: string | null
      }
    ) => saveGateWeights(id, gross, tare, awaitingGrossOut, dispatchQty, invoiceGroup, outDate, outTime)
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
  handle('lc:issuances', (_e, { lcId }: { lcId: number }) => listLCIssuances(lcId))
  handle('lc:create', (_e, { values }: { values: Row }) => createLC(values))
  handle('lc:update', (_e, { id, values }: { id: number; values: Row }) => updateLC(id, values))
  handle('lc:delete', (_e, { id }: { id: number }) => deleteLC(id))
  handle('lc:issue', (_e, { values }: { values: Row }) => issueLC(values))
  handle('lc:deleteIssuance', (_e, { id }: { id: number }) => deleteLCIssuance(id))
  handle('lc:unpreclose', (_e, { id }: { id: number }) => unPrecloseLC(id))
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
  handle('lc:allRepayments', () => listAllLcRepayments())
  handle('lc:paymentIns', (_e, { lcId }: { lcId: number }) => listLcPaymentIns(lcId))
  handle('lc:deletePaymentIn', (_e, { id }: { id: number }) => deleteLcPaymentIn(id))
  handle('lc:openTradingInvoices', (_e, { lcId }: { lcId: number }) => listLcOpenTradingInvoices(lcId))
  handle('lc:repayments', (_e, { lcId }: { lcId: number }) => listLcRepayments(lcId))
  handle('lc:saveRepayment', (_e, { values }: { values: Row }) => saveLcRepayment(values))
  handle('lc:deleteRepayment', (_e, { id }: { id: number }) => deleteLcRepayment(id))
  handle('lc:getLimit', (_e, args?: { bankId?: number; from?: string; to?: string }) =>
    getLcLimit(args?.bankId, args?.from, args?.to)
  )
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

  handle('bd:list', (_e, { filter }: { filter?: Row } = {}) => listBd(filter))
  handle('bd:create', (_e, { values }: { values: Row }) => createBd(values))
  handle('bd:update', (_e, { id, values }: { id: number; values: Row }) => updateBd(id, values))
  handle('bd:delete', (_e, { id }: { id: number }) => deleteBd(id))
  handle(
    'bd:repay',
    (
      _e,
      {
        id,
        values
      }: {
        id: number
        values: {
          repay_date?: string
          settle_via?: 'bank' | 'party'
          ref?: string | null
          release_margin?: boolean
          amount?: number | string | null
          note?: string | null
          party_id?: number | null
        }
      }
    ) => repayBd(id, values)
  )
  handle('bd:repayments', (_e, { id }: { id: number }) => listBdRepayments(id))
  handle('bd:allRepayments', () => listAllBdRepayments())
  handle('bd:linkedOrders', (_e, { id }: { id: number }) => listBdLinkedOrders(id))
  handle('bd:parties', (_e, { id }: { id: number }) => listBdParties(id))
  handle('bd:allParties', () => listAllBdParties())
  handle('bd:openTradingInvoices', (_e, { id }: { id: number }) => listBdOpenTradingInvoices(id))
  handle('bd:paymentIns', (_e, { id }: { id: number }) => listBdPaymentIns(id))
  handle(
    'bd:paymentIn',
    (
      _e,
      { id, amount, date, keys }: { id: number; amount: number; date?: string; keys?: string[] }
    ) => postBdPaymentIn(id, amount, date, keys)
  )
  handle('bd:deletePaymentIn', (_e, { id }: { id: number }) => deleteBdPaymentIn(id))
  handle('bd:deleteRepayment', (_e, { id }: { id: number }) => deleteBdRepayment(id))
  handle('bd:markReceived', (_e, { id, date }: { id: number; date?: string }) => markBdPaymentReceived(id, date))
  handle('bd:unmarkReceived', (_e, { id }: { id: number }) => unmarkBdPaymentReceived(id))
  handle('bd:reopen', (_e, { id }: { id: number }) => reopenBd(id))
  handle('bd:upfrontInterest', (_e, { id, date }: { id: number; date?: string }) => postBdUpfrontInterest(id, date))
  handle('bd:kpis', () => bdKpis())
  handle('bd:limits', () => bdLimits())
  handle('bd:setCombinedLimit', (_e, { value }: { value: number | string | null }) => setBdCombinedLimit(value))

  handle(
    'access:entityHistory',
    (
      _e,
      {
        entity,
        id,
        key,
        detail,
        limit
      }: { entity: string | string[]; id?: number | null; key?: string | null; detail?: string | null; limit?: number }
    ) => entityHistory(entity, { id, key, detail, limit })
  )

  handle('trading:list', (_e, args?: { forModule?: string }) => listTradingDeals(args?.forModule))
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
