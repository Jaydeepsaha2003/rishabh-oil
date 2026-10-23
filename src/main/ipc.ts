import { tallyHealth } from './tallyDesk'
import { listCancelledInvoiceNos } from './sales'
import { shortageNoteCandidates, setShortageNotes, shortageNoteMap } from './saleShortageNotes'
import { saleTdsPreview, postSaleTds, removeSaleTds, saleTdsMap } from './saleTds'
import { saveTallyLink, removeTallyLink, listTallyBatches, undoTallyBatch } from './tallyLinks'
import { listCompanyBanks, setCompanyBank, suggestTallyBank, checkTallyBank, previewTallyBankVouchers, postTallyBankVouchers } from './tallyBank'
import { checkTallyRegister, previewTallyRegisterVouchers, postTallyRegisterVouchers, setRegisterVoucherDate } from './tallyRegisters'
import { previewTallyNotes, saveTallyNoteMap, createTallyNoteLedger, postTallyNotes, reconcileTallySales, previewTallySalesVouchers, postTallySalesVouchers, linkTallyParty, saveTallyDraft, listTallyDrafts, clearTallyDraft } from './tallyNotes'
import { addStockAdjustment, deleteStockAdjustment, listStockAdjustments } from './stockAdjust'
import { ipcMain, dialog, shell } from 'electron'
import { voucherAlterInfo, alterOwnedVoucher } from './voucherAlter'
import { intercompanySource } from './intercompany'
import { randomPurchaseInvoiceNo, randomSalesInvoiceNo } from './invoiceno'
import { withDbTransaction } from './dbTransaction'
import { ping, bumpRevision, getRevision, initDb, resetClient, getConfiguredUrl, notifyDataChanged, getClient } from './db'
import {
  listNotificationRules, saveNotificationRule, resetNotificationRule, runNotificationRules,
  listNotifications, markNotificationsRead, markNotificationUnread, clearNotifications,
  previewNotificationRule, notificationRecipients, listNotificationMutes, muteNotificationRule
} from './notify'
import { snapshotGz } from './dbsnapshot'
import { vapidKeys, pushStatus, pushTo, saveSubscription, dropSubscription } from './webpush'
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
import {
  listBargains,
  createBargain,
  updateBargain,
  deleteBargain,
  adjustBargainQty,
  moveBargainBalance,
  bargainLinkedInvoices,
  setInvoiceBargainRate,
  bargainAdjustments
} from './bargains'
import {
  listOrders,
  createOrder,
  createTankerInvoice,
  updateTankerInvoice,
  updateOrder,
  deleteOrder,
  rerateInvoicesForBargain,
  advanceOrder,
  listPurchaseTankers,
  createPurchaseTanker,
  updateTankerDetails,
  deletePurchaseTanker,
  advancePurchaseTanker,
  revertPurchaseTanker,
  replaceTanker,
  listTankerQuality,
  listTankerQualityMany,
  listFfaHistory,
  saveTankerQuality,
  listOrderQuality,
  saveOrderQuality,
  waiveOrderQuality,
  supplierFyTaxable,
  listOrderBargains,
  listOrderBargainInterest,
  listConsignmentDraws,
  listSupplierLedger,
  listTransporterLedger,
  addLedgerEntry,
  deleteLedgerEntry, purchaseBargainNotes } from './orders'
import { listUnmappedOrders, unmappedCount, mapOrderToBargains } from './unmapped'
import { documentPostings, type PostingEntity } from './postings'
import { listTradingDeals, createTradingDeal, updateTradingDeal, deleteTradingDeal, listTradingPayments } from './trading'
import { assertAdmin, assertAllowed, clearAccessCache, currentScope, entryWindows } from './access-gate'
import {
  accountingChecks,
  clearSaleTds,
  fixLcCharges,
  genericBankPostings,
  moveGenericBankPostings,
  previewDuplicateInvoicePostings,
  previewLcCharges,
  previewSaleTds,
  repairDuplicateInvoicePostings,
  previewOutwardFreight,
  fixOutwardFreight,
  previewSharedLedgers,
  fixSharedLedgers
} from './accountingRepairs'
import { listSkuRates, saveSkuRates, listPackagingParties, setPackagingParties, packagingPartyCounts } from './skurates'
import {
  listConsignment,
  consignmentSummary,
  listPendingGateArrivals,
  assignConsignmentGroup,
  unlinkConsignmentDraw,
  unlinkConsignmentDrawsFor,
  renameConsignmentLot,
  consignmentKin,
  listConsignmentInvoices,
  listUnbookedLots,
  createConsignment,
  updateConsignment,
  deleteConsignment, saveOpeningStock, listOpeningLog, listOpeningLots } from './consignment'
import {
  listTags,
  createTag,
  renameTag,
  deleteTag,
  tagsFor,
  setTags,
  tagContents
} from './tags'
import { login, listUsers, createUser, updateUser, deleteUser } from './auth'
import { heartbeat, liveUsers, listIps, setIpActive, listLogs, logEvent, machineIp, type LogFilter, entityHistory } from './access'
import { getCurrentUser, setCurrentUser } from './currentUser'
import { listChanges } from './history'
import { getBooksFrom, setBooksFrom, listOpenings, saveOpenings, ledgerOpening, moveOpenings } from './openings'
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
  reorderWorkProcesses,
  requestWorkDay,
  decideWorkDay,
  setWorkDayOpen,
  setUserWorkCutoff,
  listWorkProcesses,
  redoWorkTask,
  removeWorkProcess,
  removeWorkTask,
  saveWorkProcess,
  sendBackWorkTask,
  setWorkCutoff,
  tickWorkTask,
  untickWorkTask,
  workCutoff
} from './work'
import {
  addPpStage,
  listPpStages,
  listStockOpenings,
  ppDrawsForProduction,
  ppTotalsBothByProduct,
  ppVesselBalances,
  writeOffPp,
  movePp,
  ppVesselsForReceiving,
  listPpWriteoffs,
  removePpStage,
  savePpLines,
  saveStockOpenings,
  handOverOpeningPp,
  putBackOpeningPp,
  stockOpeningDate,
  listOpeningSets,
  openingSetLines
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
import { dailyPosition } from './dailyPosition'
import { listPaymentTracker } from './paymentTracker'
import { getDashLayout, saveDashLayout } from './dashLayout'
import { applyProductMerge, listProductMerges, previewProductMerge } from './productMerge'
import { getProductionPlan, saveProductionPlan } from './productionPlan'
import {
  treasuryAlerts,
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
  type VoucherInput
} from './accounting'
import { nextVoucherCode } from './voucherNumbers'
import { linkedVouchers, linkVoucher, unlinkVoucher, voucherChoices } from './bargainVouchers'
import {
  listLedgerMap,
  renameLedger,
  setLedgerMap,
  dropLedgerMap
} from './ledgerMap'
import {
  groupTree,
  listGroupNames,
  createGroup,
  renameGroup,
  moveGroup,
  deleteGroup,
  setAccountGroup,
  setAccountsGroup,
  setAccountsHidden,
  type GroupNature
} from './ledgerGroups'
import {
  listProduction,
  productionReport,
  getProductionItems,
  batchMix,
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
  rejectLC,
  reinstateLC,
  issueLC,
  deleteLCIssuance,
  precloseLC,
  unPrecloseLC,
  getLcLimit,
  listBankLcLimits,
  saveLcLimit,
  assertLcNotClosed,
  lcIdOfRepayment,
  lcIdOfIssuance,
  payLcParty,
  deleteLastLcInstallment,
  repayLcParts,
  undoLcPartRepayment,
  lcParts,
  editPreclosure
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
  listBd,
  createBd,
  updateBd,
  deleteBd,
  repayBd,
  reopenBd,
  postBdUpfrontInterest,
  reverseBdUpfrontInterest,
  setBdVoucherBank,
  bdKpis,
  listBdRepayments,
  deleteBdRepayment,
  editBdRepayment,
  markBdPaymentReceived,
  unmarkBdPaymentReceived,
  listAllBdRepayments,
  listBdLinkedOrders,
  bdLimits,
  setBdCombinedLimit,
  listBdParties,
  listAllBdParties,
  bdInterestSchedule,
  listBdInterestPayments,
  payBdInterest,
  deleteBdInterestPayment,
  postBdInterestPayment,
  bdInterestWindow,
  payBdInterestUpto,
  listBdLimitReductions,
  addBdLimitReduction,
  deleteBdLimitReduction,
  listBdChargeTypes,
  addBdChargeType,
  listBdPartyPayments,
  payBdParty,
  deleteLastBdPartyPayment,
  listBdReceiptParts,
  receiveBdPart,
  deleteLastBdReceiptPart
} from './billDiscounting'
import {
  listTransporterFreight,
  transporterFreightKpis,
  listOrphanedTransporterBills,
  listTransporterBills,
  createTransporterBill,
  rcmRegister,
  postBillRcm,
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
import { listLimitHistory, addLimitRevision, deleteLimitRevision } from './facilityLimits'
import { importTallyLedgers, tallyLedgerMap, mapTallyLedger, applyTallyOpenings, clearTallyLedgers, createTallyLedgers, regroupTallyLedger } from './tallyLedgers'
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
  setSaleInvoiceDate,
  setInvoiceStage,
  deleteSaleInvoice,
  rejectSaleInvoice,
  unrejectSaleInvoice,
  listSalesBargains,
  createSalesBargain,
  updateSalesBargain,
  deleteSalesBargain,
  adjustSalesBargainQty,
  moveSalesBargainBalance,
  listCustomerLedger,
  salesInvoiceGaps,
  cancelInvoiceNo,
  uncancelInvoiceNo,
  salesInvoiceSeries, salesBargainLinkedInvoices, rerateSalesForBargain } from './sales'

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
  stockAdj: 'Stock adjustment',
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
  // A production run: its date, whether it ran on its own mix, and the note —
  // the things a run's history is read for.
  add('Date', v.prod_date)
  if (Array.isArray(v.custom_items) && v.custom_items.length) parts.push(`own mix (${v.custom_items.length} lines)`)
  if (typeof v.note === 'string' && v.note.trim()) add('Note', v.note.trim().slice(0, 80))
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
    /:list$|:get$|:items$|:issuances$|:sheet$|:outstanding$|:all$|:summary$|:transfers$|:fyTaxable$|:needs$|:breakdown$|:nextNo$|:liveUsers$|:ips$|:logs$|:dispatchableSales$|:mine$|:pendingCount$|:pending$|:lots$|:unmapped$|:unmappedCount$|:bargainLines$|:bargainNotes$|:bargainInterest$|:consignmentDraws$|^access:heartbeat$|^db:ping$|^db:snapshot$|^app:revision$|^auth:login$|^journal:booksFrom$|^tally:map$|^journal:openings$|^journal:opening$|^journal:accounts$|^journal:statement$|^journal:trialBalance$|^journal:groups$|^journal:groupNames$|^journal:groupTree$|^journal:ledgerMap$|^journal:pendingRefs$|^journal:billsOutstanding$|^journal:tradingAccount$|^dashboard:stats$|^vouchers:nextCode$|^vouchers:forDocument$|^vouchers:alterInfo$|^tfreight:kpis$|^dashboard:position$|^dashboard:layout$|^dashboard:saveLayout$|^productMerge:preview$|^skuRates:parties$|^skuRates:partyCounts$|^consignment:openingLog$|^tags:list$|^tags:for$|^tags:contents$|^consignment:openingLots$|^consignment:invoices$|^tankers:quality$|^tankers:qualityMany$|^tankers:ffaHistory$|^orders:quality$|^gate:partyCategories$|^gate:waivedOuts$|^gate:forRecord$|^notify:rules$|^notify:list$|^notify:run$|^notify:preview$|^notify:people$|^notify:mutes$|^treasury:alerts$|^treasury:paymentTracker$|^facility:exposures$|^facility:headroom$|^company:setActive$|^company:getActive$|^factory:active$|^factory:companies$|^session:setUser$|^lc:repayments$|^lc:parts$|^lc:parts$|^lc:allRepayments$|^lc:getLimit$|^lc:bankLimits$|^lc:paymentIns$|^lc:openTradingInvoices$|^files:pickDocument$|^files:openDocument$|^bankRecon:imports$|^bankRecon:list$|^bankRecon:suggest$|^bd:kpis$|^bd:limits$|^skuStock:adjustments$|^skuOpening:list$|^skuOpening:date$|^stockCount:previous$|^orders:intercompanySource$|^stockOpening:list$|^stockOpening:date$|^stockOpening:sets$|^stockOpening:setLines$|^stockOpening:ppStages$|^stockOpening:ppFreeTotals$|^production:ppDraws$|^bargains:linkedInvoices$|^bargains:linkedVouchers$|^bargains:voucherChoices$|^salesBargains:linkedVouchers$|^salesBargains:voucherChoices$|^bargains:adjustments$|^history:list$|^stockOpening:ppVessels$|^stockOpening:ppReceivers$|^stockOpening:ppWriteoffs$|^work:board$|^work:cutoff$|^work:processes$|^formulationSubcategory:list$|^formulations:versions$|^facility:limitHistory$|^bd:limitReductions$|^bd:allRepayments$|^bd:interestSchedule$|^bd:interestWindow$|^bd:interestPayments$|^bd:linkedOrders$|^bd:parties$|^bd:allParties$|^bd:openTradingInvoices$|^bd:paymentIns$|^bd:partyPayments$|^bd:receiptParts$|^access:entryWindows$|^access:entityHistory$|^trading:list$|^sales:series$|^sales:invoiceGaps$|^salesBargains:returns$|^salesBargains:linkedInvoices$|^salesBargains:unattributedReturns$|^tbill:orphans$|^tbill:rcmRegister$|^production:report$|^production:mix$|^repairs:splitTanker:list$|^vouchers:cashflow$|^repairs:paisa:list$|^tallyNotes:(preview|salesCheck|salesPreview|registerCheck|registerPreview|health|batches|companyBanks|bankSuggest|bankCheck|bankPreview|drafts|bankBooks|bankBook)$|^sales:(tdsPreview|tdsMap|cancelledNos|shortageNotes|shortageNoteMap)$|^suppliers:tdsRecalc$/
  // The Tally checks and previews only READ: they compare a file with the books
  // and post nothing. Gated as writes, every click logged the whole uploaded
  // file to the audit trail and woke every open screen to re-read — which is
  // what made Book from Tally take seconds to open.
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
  handle('data:create', async (_e, { table, values }: { table: string; values: Row }) => {
    // A party's opening billing belongs to the company it was entered under,
    // even when somebody approves it later with the other company open.
    const v = table === 'suppliers' || table === 'customers' ? { ...values, opening_company_id: getActiveCompanyId() } : values
    return (await needsApproval(table)) ? submitApprovalRequest(table, v) : create(table, v)
  })
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
  handle('bargains:linkedInvoices', (_e, { id }: { id: number }) => bargainLinkedInvoices(id))
  handle('bargains:adjustments', (_e, { id }: { id: number }) => bargainAdjustments(id))
  // Vouchers linked to a bargain by hand — an advance, a receipt, a note —
  // see src/main/bargainVouchers.ts. `id` is the bargain's, so linking and
  // unlinking answer to the same edit right and window as editing it.
  handle('bargains:linkedVouchers', (_e, { id }: { id: number }) => linkedVouchers('purchase', id))
  handle('bargains:voucherChoices', (_e, { id, vchType }: { id: number; vchType?: string }) =>
    voucherChoices('purchase', id, vchType)
  )
  handle('bargains:linkVoucher', (_e, { id, entryId, note }: { id: number; entryId: number; note?: string }) =>
    linkVoucher('purchase', id, entryId, note)
  )
  handle('bargains:unlinkVoucher', (_e, { id, linkId }: { id: number; linkId: number }) =>
    unlinkVoucher('purchase', id, linkId)
  )
  handle(
    'bargains:rerateInvoices',
    (_e, { bargainId, rate, orderIds }: { bargainId: number; rate: number; orderIds: number[] }) =>
      rerateInvoicesForBargain(bargainId, rate, orderIds)
  )
  handle('history:list', (_e, { entity, id }: { entity: string; id: number }) => listChanges(entity, id))
  handle('stockOpening:ppVessels', (_e, { productId, companyId }: { productId: number; companyId?: number }) =>
    ppVesselBalances(productId, companyId)
  )
  handle('stockOpening:ppWriteoffs', (_e, { productId, companyId }: { productId: number; companyId?: number }) =>
    listPpWriteoffs(productId, companyId)
  )
  handle(
    'stockOpening:writeOffPp',
    (
      _e,
      { productId, stageId, qty, note, companyId }:
        { productId: number; stageId: number; qty: number; note: string; companyId?: number }
    ) => writeOffPp(productId, stageId, qty, note, companyId)
  )
  handle('stockOpening:ppReceivers', (_e, { productId, companyId }: { productId: number; companyId?: number }) =>
    ppVesselsForReceiving(productId, companyId)
  )
  handle(
    'stockOpening:movePp',
    (
      _e,
      { productId, stageId, qty, toProductId, toStageId, note, companyId }:
        {
          productId: number
          stageId: number
          qty: number
          toProductId: number
          toStageId: number
          note: string
          companyId?: number
        }
    ) => movePp(productId, stageId, qty, toProductId, toStageId, note, companyId)
  )
  handle(
    'bargains:setInvoiceRate',
    (_e, { orderId, bargainId, rate }: { orderId: number; bargainId: number; rate: number }) =>
      setInvoiceBargainRate(orderId, bargainId, rate)
  )
  handle('bargains:delete', (_e, { id }: { id: number }) => deleteBargain(id))
  handle('bargains:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustBargainQty(id, delta, note, date)
  )
  // The open balance struck again under another product: a new bargain for it,
  // and the same quantity off this one, together. See moveBargainBalance.
  handle('bargains:moveBalance', (_e, { id, values }: { id: number; values: { oil_type_id: number; qty: number; rate?: number; date?: string; note?: string } }) =>
    moveBargainBalance(id, values)
  )

  handle('orders:bargainNotes', (_e, { id }: { id: number }) => purchaseBargainNotes(id))
  handle('orders:list', (_e, args?: { forModule?: string; companyId?: number }) => listOrders(args?.forModule, args?.companyId))
  // The selling company's own invoice, read from the purchase it raised here.
  // Read-only by design — see intercompanySource.
  handle('orders:intercompanySource', (_e, { id }: { id: number }) => intercompanySource(Number(id)))
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
      // One transaction: a trading company's tanker is emptied AND sold on, or neither.
      withDbTransaction(() => advancePurchaseTanker(id, toStatus, data))
  )
  handle('tankers:revert', (_e, { id }: { id: number }) => withDbTransaction(() => revertPurchaseTanker(id)))
  handle('tankers:replace', (_e, { id, values }: { id: number; values: Row }) => replaceTanker(id, values))
  handle('tankers:quality', (_e, { id }: { id: number }) => listTankerQuality(Number(id)))
  handle('tankers:qualityMany', (_e, { ids }: { ids: number[] }) => listTankerQualityMany(ids))
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
  // "Not needed for this transaction" — an answer, not a gap.
  handle(
    'orders:waiveQuality',
    (_e, { id, waived, note }: { id: number; waived: boolean; note?: string }) =>
      waiveOrderQuality(Number(id), waived !== false, note)
  )
  handle('orders:saveQuality', async (_e, { id, rows }: { id: number; rows: Row[] }) => {
    await saveOrderQuality(Number(id), Array.isArray(rows) ? rows : [])
    return { id: Number(id) }
  })
  handle('orders:create', (_e, { values }: { values: Row }) => createOrder(values))
  // A placeholder invoice number for a supplier that never printed one on the
  // paper handed over — seven digits, checked against every other purchase
  // already booked for this company so it can never collide.
  handle('orders:randomInvoiceNo', (_e, { companyId }: { companyId?: number }) =>
    randomPurchaseInvoiceNo(companyId || getActiveCompanyId())
  )
  // One supplier invoice covering tankers of several products: one row per
  // product, all under the real number. See createTankerInvoice.
  handle('orders:createInvoice', (_e, { values }: { values: Row }) => createTankerInvoice(values))
  handle('orders:updateInvoice', (_e, { group, values }: { group: string; values: Row }) =>
    updateTankerInvoice(group, values)
  )
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
  // Which cargo a set of tankers came off: the lot at the port, the terminal
  // it was discharged at, put on several arrivals at once.
  handle(
    'consignment:assignGroup',
    (_e, { ids, lot_no, terminal_no }: { ids: number[]; lot_no?: string; terminal_no?: string }) =>
      assignConsignmentGroup(ids, { lot_no, terminal_no })
  )
  // Taking an invoice back off the parcels it drew, one invoice or a whole
  // party's product at once. The invoice itself is untouched — see
  // unlinkConsignmentDraw.
  handle('consignment:unlinkDraw', (_e, { orderId }: { orderId: number }) =>
    unlinkConsignmentDraw(orderId)
  )
  handle(
    'consignment:unlinkDrawsFor',
    (_e, { supplierId, productId }: { supplierId: number; productId: number }) =>
      unlinkConsignmentDrawsFor(supplierId, productId)
  )
  // One cargo's number, corrected on every row that carries it.
  handle('consignment:renameLot', (_e, { values }: { values: Row }) => renameConsignmentLot(values as never))
  handle('consignment:kin', (_e, { id }: { id: number }) => consignmentKin(id))
  handle('consignment:saveOpening', (_e, { values }: { values: Row }) => saveOpeningStock(values))
  // ── TAGS ────────────────────────────────────────────────────────────
  // The mill's own word for something the software has no field for, put on
  // any purchase, sale, LC, discounted bill or voucher. See src/main/tags.ts.
  handle('tags:list', (_e, args?: { companyId?: number }) => listTags(args?.companyId))
  handle('tags:create', (_e, a: { name: string; colour?: string; companyId?: number }) => createTag(a))
  handle('tags:rename', (_e, { id, name, colour }: { id: number; name: string; colour?: string }) =>
    renameTag(id, name, colour)
  )
  handle('tags:delete', (_e, { id }: { id: number }) => deleteTag(id))
  handle('tags:for', (_e, { entity, refs, companyId }: { entity: string; refs: unknown[]; companyId?: number }) =>
    tagsFor(entity, refs, companyId)
  )
  handle('tags:set', (_e, { entity, ref, tagIds }: { entity: string; ref: unknown; tagIds: unknown[] }) =>
    setTags(entity, ref, tagIds)
  )
  handle('tags:contents', (_e, { id }: { id: number }) => tagContents(id))

  handle('consignment:openingLots', (_e, { supplierId, productId }: { supplierId: number; productId: number }) =>
    listOpeningLots(supplierId, productId)
  )
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
  handle('tally:import', (_e, { values }: { values: Row }) => importTallyLedgers(values))
  // Tally File Updation: a Credit / Debit Note register read, mapped and posted.
  handle('tallyNotes:preview', (_e, { values }: { values: Row }) => previewTallyNotes(values as Parameters<typeof previewTallyNotes>[0]))
  handle('tallyNotes:saveMap', (_e, { values }: { values: Row }) => saveTallyNoteMap(values as Parameters<typeof saveTallyNoteMap>[0]))
  handle('tallyNotes:createLedger', (_e, { values }: { values: Row }) =>
    createTallyNoteLedger(values as Parameters<typeof createTallyNoteLedger>[0])
  )
  handle('tallyNotes:post', (_e, { values }: { values: Row }) => postTallyNotes(values as Parameters<typeof postTallyNotes>[0]))
  // The Sales Register check: read only, and the party link it can save.
  handle('tallyNotes:salesCheck', (_e, { values }: { values: Row }) => reconcileTallySales(values as Parameters<typeof reconcileTallySales>[0]))
  handle('tallyNotes:salesPreview', (_e, { values }: { values: Row }) =>
    previewTallySalesVouchers(values as Parameters<typeof previewTallySalesVouchers>[0])
  )
  handle('tallyNotes:postSales', (_e, { values }: { values: Row }) =>
    postTallySalesVouchers(values as Parameters<typeof postTallySalesVouchers>[0])
  )
  // Journal and Purchase Registers: the check, the booking preview, the booking.
  handle('tallyNotes:registerCheck', (_e, { values }: { values: Row }) => checkTallyRegister(values as Parameters<typeof checkTallyRegister>[0]))
  handle('tallyNotes:registerPreview', (_e, { values }: { values: Row }) =>
    previewTallyRegisterVouchers(values as Parameters<typeof previewTallyRegisterVouchers>[0])
  )
  handle('tallyNotes:postRegister', (_e, { values }: { values: Row }) =>
    postTallyRegisterVouchers(values as Parameters<typeof postTallyRegisterVouchers>[0])
  )
  // The desk at a glance; what it has decided (links); what it has booked (batches).
  handle('tallyNotes:health', (_e, { values }: { values: Row }) => tallyHealth(values as Parameters<typeof tallyHealth>[0]))
  handle('tallyNotes:link', (_e, { values }: { values: Row }) => saveTallyLink(values as Parameters<typeof saveTallyLink>[0]))
  handle('tallyNotes:unlink', (_e, { values }: { values: Row }) => removeTallyLink(values as Parameters<typeof removeTallyLink>[0]))
  handle('tallyNotes:batches', (_e, { values }: { values: Row }) => listTallyBatches(values as Parameters<typeof listTallyBatches>[0]))
  handle('tallyNotes:undoBatch', (_e, { values }: { values: Row }) => undoTallyBatch(values as Parameters<typeof undoTallyBatch>[0]))
  // A bank's book from Tally, against the same bank here.
  handle('tallyNotes:companyBanks', (_e, { values }: { values: Row }) => listCompanyBanks(values as Parameters<typeof listCompanyBanks>[0]))
  handle('tallyNotes:setCompanyBank', (_e, { values }: { values: Row }) => setCompanyBank(values as Parameters<typeof setCompanyBank>[0]))
  handle('tallyNotes:bankSuggest', (_e, { values }: { values: Row }) => suggestTallyBank(values as Parameters<typeof suggestTallyBank>[0]))
  handle('tallyNotes:bankBooks', async (_e, { values }: { values?: Row } = {}) => {
    const { listBankBooks } = await import('./tallyNotes')
    return listBankBooks(values)
  })
  handle('tallyNotes:bankBook', async (_e, { values }: { values: Row }) => {
    const { getBankBook } = await import('./tallyNotes')
    return getBankBook(values as Parameters<typeof getBankBook>[0])
  })
  handle('tallyNotes:bankCheck', (_e, { values }: { values: Row }) => checkTallyBank(values as Parameters<typeof checkTallyBank>[0]))
  handle('tallyNotes:bankPreview', (_e, { values }: { values: Row }) =>
    previewTallyBankVouchers(values as Parameters<typeof previewTallyBankVouchers>[0])
  )
  handle('tallyNotes:postBank', (_e, { values }: { values: Row }) => postTallyBankVouchers(values as Parameters<typeof postTallyBankVouchers>[0]))
  handle('tallyNotes:fixRegisterDate', (_e, { values }: { values: Row }) =>
    setRegisterVoucherDate(values as Parameters<typeof setRegisterVoucherDate>[0])
  )
  handle('tallyNotes:linkParty', (_e, { values }: { values: Row }) => linkTallyParty(values as Parameters<typeof linkTallyParty>[0]))
  // The user's uploads kept as drafts until Process.
  handle('tallyNotes:saveDraft', (_e, { values }: { values: Row }) => saveTallyDraft(values as Parameters<typeof saveTallyDraft>[0]))
  handle('tallyNotes:drafts', (_e, a?: { values?: Row }) => listTallyDrafts(a?.values))
  handle('tallyNotes:clearDraft', (_e, { values }: { values: Row }) => clearTallyDraft(values as Parameters<typeof clearTallyDraft>[0]))
  handle('tally:map', () => tallyLedgerMap())
  handle('tally:link', (_e, { values }: { values: Row }) => mapTallyLedger(values))
  handle('tally:applyOpenings', (_e, { values }: { values: Row }) => applyTallyOpenings(values))
  handle('tally:clear', () => clearTallyLedgers())
  handle('tally:create', (_e, { values }: { values: Row }) => createTallyLedgers(values))
  handle('tally:regroup', (_e, { values }: { values: Row }) => regroupTallyLedger(values))
  handle('journal:moveOpenings', (_e, a: { accountIds: number[]; fromCompanyId: number; toCompanyId: number }) =>
    moveOpenings(a.accountIds, a.fromCompanyId, a.toCompanyId)
  )
  handle('journal:saveOpenings', (_e, { rows, companyId }: { rows: Row[]; companyId?: number }) =>
    saveOpenings(rows as { account_id: number; dr?: number; cr?: number }[], companyId)
  )
  handle('journal:opening', (_e, { accountId, companyId }: { accountId: number; companyId?: number }) =>
    ledgerOpening(accountId, companyId)
  )
  handle('journal:accounts', (_e, args?: { companyId?: number }) => listAccounts(args?.companyId))
  handle('journal:createAccount', (_e, { name, group, companyId }: { name: string; group?: string; companyId?: number }) =>
    createAccount(name, group, companyId)
  )
  handle('journal:statement', (_e, { accountId, companyId }: { accountId: number; companyId?: number }) =>
    accountStatement(accountId, companyId)
  )
  handle('journal:addEntry', (_e, { data }: { data: Row }) => addManualJournal(data))
  handle('journal:trialBalance', (_e, args?: { from?: string; to?: string; companyId?: number }) =>
    trialBalance(args?.from, args?.to, args?.companyId)
  )
  handle('journal:groups', (_e, args?: { companyId?: number }) => listGroups(args?.companyId))
  // Every group the books actually have, not a fixed list of twenty-six —
  // shape unchanged for the callers that only wanted {name, nature}, with the
  // parent, depth and path added for the ones that draw the tree.
  handle('journal:groupNames', () => listGroupNames())
  // WHAT THE APP POSTS AS ONE NAME, AND WHICH LEDGER THAT REALLY IS.
  // Renaming a ledger the app posts to is only safe because of this — see
  // src/main/ledgerMap.ts.
  handle('journal:ledgerMap', (_e, args?: { companyId?: number }) => listLedgerMap(args?.companyId))
  handle('journal:renameLedger', (_e, { id, name, companyId }: { id: number; name: string; companyId?: number }) =>
    renameLedger(id, name, companyId)
  )
  handle('journal:mapLedger', (_e, a: { postsAs: string; useName: string; companyId?: number; note?: string }) =>
    setLedgerMap(a)
  )
  handle('journal:unmapLedger', (_e, { id }: { id: number }) => dropLedgerMap(id))
  handle('journal:groupTree', (_e, args?: { companyId?: number }) => groupTree(args?.companyId))
  handle('journal:createGroup', (_e, a: { name: string; under?: string | number | null; nature?: GroupNature }) =>
    createGroup(a)
  )
  handle('journal:renameGroup', (_e, { id, name }: { id: number; name: string }) => renameGroup(id, name))
  handle('journal:moveGroup', (_e, { id, parentId, nature }: { id: number; parentId: number | null; nature?: GroupNature }) =>
    moveGroup(id, parentId, nature)
  )
  handle('journal:deleteGroup', (_e, { id }: { id: number }) => deleteGroup(id))
  handle('journal:setAccountGroup', (_e, { id, group }: { id: number; group: string }) => setAccountGroup(id, group))
  handle('journal:setAccountsGroup', (_e, { ids, group }: { ids: number[]; group: string }) => setAccountsGroup(ids, group))
  handle('journal:setAccountsHidden', (_e, { ids, hidden }: { ids: number[]; hidden: boolean }) => setAccountsHidden(ids, hidden))
  handle(
    'journal:billsOutstanding',
    (_e, a: { account: string; companyId?: number; asOf?: string; side?: 'customer' | 'supplier'; settled?: boolean }) =>
      billsOutstanding(a.account, a.companyId, { asOf: a.asOf, side: a.side, settled: a.settled })
  )
  handle(
    'journal:pendingRefs',
    (_e, { account, companyId, side, all }: { account: string; companyId?: number; side?: 'customer' | 'supplier'; all?: boolean }) =>
      listPendingRefs(account, companyId, side, !!all)
  )
  handle('journal:tradingAccount', (_e, { from, to, companyId }: { from?: string; to?: string; companyId?: number }) =>
    tradingAccount(from, to, companyId)
  )
  handle('dashboard:stats', (_e, a?: { all?: boolean }) => dashboardStats({ all: !!a?.all }))
  handle('dashboard:position', (_e, a?: { all?: boolean }) => dailyPosition({ all: !!a?.all }))
  handle('dashboard:layout', () => getDashLayout())
  handle('dashboard:saveLayout', (_e, { hidden }: { hidden: string[] }) => saveDashLayout(hidden))
  // Settings → Merge products. The preview reads; the merge is an
  // administrator's, checked inside applyProductMerge as well as here.
  handle('productMerge:preview', (_e, { fromId, toId }: { fromId: number; toId: number }) => previewProductMerge(fromId, toId))
  handle('productMerge:apply', (_e, { fromId, toId }: { fromId: number; toId: number }) => applyProductMerge(fromId, toId))
  handle('productMerge:list', () => listProductMerges())
  handle('productionPlan:get', (_e, { date }: { date: string }) => getProductionPlan(date))
  handle('productionPlan:save', (_e, { date, rows }: { date: string; rows: Row[] }) => saveProductionPlan(date, rows))
  // The gateway's counts and turnover — read-only (the :summary ending).
  handle('vouchers:summary', async (_e, args?: { from?: string; to?: string; companyId?: number }) => {
    const { voucherSummary } = await import('./accounting')
    return voucherSummary(args?.from, args?.to, args?.companyId)
  })
  handle('vouchers:list', (_e, args?: { from?: string; to?: string; vchType?: string | string[]; companyId?: number }) =>
    listVouchers(args?.from, args?.to, args?.vchType, args?.companyId)
  )
  // Read-only: every voucher of a period opened up — see cashflowRegister.
  // How many purchase entries each supplier has, across every company — the
  // count beside the Trading / Manufacturing tag on the Suppliers list. Read
  // only; the :summary ending keeps it in READONLY.
  // THE LEDGER EACH BANK ACTUALLY POSTS TO — its name and last four digits
  // (bankLedgerName), then any rename in the ledger map, so a picker can show
  // the very ledger the books carry ("HDFC50200022765385 ( SWASTHYA VIHAR)")
  // rather than the master's short name. Read only (:summary).
  handle('banks:ledgers:summary', async () => {
    const { bankLedgerName } = await import('./treasury')
    const { resolveAccountName } = await import('./ledgerMap')
    const rs = await getClient().execute('SELECT id, name, account_no, company_id FROM banks')
    const out: Record<string, string> = {}
    for (const r of rs.rows as unknown as Row[]) {
      const posts = bankLedgerName(r.name, r.account_no)
      out[String(r.id)] = await resolveAccountName(posts, Number(r.company_id) || undefined).catch(() => posts)
    }
    return out
  })
  handle('suppliers:purchases:summary', async () => {
    const rs = await getClient().execute(
      'SELECT supplier_id, COUNT(*) AS n FROM orders WHERE supplier_id IS NOT NULL GROUP BY supplier_id'
    )
    const out: Record<string, number> = {}
    for (const r of rs.rows) out[String(r.supplier_id)] = Number(r.n) || 0
    return out
  })
  handle('vouchers:cashflow', async (_e, args?: { from?: string; to?: string; companyId?: number }) => {
    const { cashflowRegister } = await import('./cashflowRegister')
    return cashflowRegister(args?.from, args?.to, args?.companyId)
  })
  handle('vouchers:get', (_e, { id }: { id: number }) => getVoucher(id))
  // WHAT THIS DOCUMENT PUT IN THE LEDGERS — read-only, see src/main/postings.ts.
  handle('vouchers:forDocument', (_e, { entity, id }: { entity: PostingEntity; id: number }) =>
    documentPostings({ entity, id })
  )
  handle('vouchers:create', (_e, { values }: { values: VoucherInput }) => createVoucher(values))
  handle('vouchers:update', (_e, { id, values }: { id: number; values: VoucherInput }) =>
    updateVoucher(id, values)
  )
  handle('vouchers:nextCode', (_e, a: { vchType: string; companyId?: number }) =>
    nextVoucherCode(Number(a?.companyId) || getActiveCompanyId(), String(a?.vchType || ''))
  )
  handle('vouchers:delete', (_e, { id }: { id: number }) => deleteManualEntry(id))
  // A voucher a document wrote: how it is altered (voucherAlter.ts), and the
  // alter itself for the ones changed through a form here.
  handle('vouchers:alterInfo', (_e, { id }: { id: number }) => voucherAlterInfo(id))
  handle('vouchers:alterOwned', (_e, { id, values }: { id: number; values: Row }) => alterOwnedVoucher(id, values))
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

  handle('formulations:list', (_e, opts?: { includeHidden?: boolean }) => listFormulations(opts))
  handle('formulations:items', (_e, { id }: { id: number }) => getFormulationItems(id))
  handle('formulations:versions', (_e, { id }: { id: number }) => listFormulationVersions(Number(id)))
  handle('formulations:create', (_e, { values }: { values: Row }) => createFormulation(values))
  handle('formulations:update', (_e, { id, values }: { id: number; values: Row }) =>
    updateFormulation(id, values)
  )
  handle('formulations:delete', (_e, { id }: { id: number }) => deleteFormulation(id))

  handle('stock:list', (_e, args?: { range?: { from?: string; to?: string }; companyIds?: number[] }) => stockLevels(args?.range, args?.companyIds))
  handle('stock:needs', () => productionNeeds())
  // STOCK MAPPING: a balance traced back to the entries it came from, FIFO.
  // Read only — the :breakdown ending keeps it in READONLY.
  handle('stock:fifo:breakdown', async (_e, a: { productId: number; companyIds?: number[]; asOf?: string; qty: number; all?: boolean }) => {
    const { stockFifoMap } = await import('./stockFifo')
    return stockFifoMap(a)
  })
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
  handle('stockOpening:handOverPp', (_e, { date, companyId }: { date: string; companyId?: number }) =>
    handOverOpeningPp(date, companyId)
  )
  handle('stockOpening:putBackPp', (_e, { rows, companyId }: { rows: Row[]; companyId?: number }) =>
    putBackOpeningPp(rows, companyId)
  )
  handle(
    'stockOpening:save',
    (
      _e,
      { rows, asOf, companyId, version }: { rows: Row[]; asOf: string; companyId?: number; version?: string }
    ) => saveStockOpenings(rows, asOf, companyId, version)
  )
  // Just the date, for the app's default period. The full sheet is far too
  // heavy to fetch at startup for one string.
  handle('stockOpening:date', (_e, { companyId }: { companyId?: number } = {}) =>
    stockOpeningDate(companyId)
  )
  // Every opening ever struck here, and what any one of them said. Read-only:
  // an old count is evidence, and evidence is not edited in place.
  handle('stockOpening:sets', (_e, { companyId }: { companyId?: number } = {}) =>
    listOpeningSets(companyId)
  )
  handle('stockOpening:setLines', (_e, { setId }: { setId: number }) => openingSetLines(Number(setId)))
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
    (
      _e,
      { productId, lines, companyId, version }: { productId: number; lines: Row[]; companyId?: number; version?: string }
    ) => savePpLines(productId, lines, companyId, version)
  )
  // What the Production entry sheet's preview needs before a batch is saved:
  // both PP buckets for every auto-calculated input on the sheet, and — when
  // editing a run that already drew some — exactly what that run took, so the
  // preview can give it back before showing the edited amount.
  handle(
    'stockOpening:ppFreeTotals',
    (_e, { productIds, companyId, asOf }: { productIds: number[]; companyId?: number; asOf?: string }) =>
      ppTotalsBothByProduct(productIds, companyId, asOf)
  )
  handle('production:ppDraws', (_e, { productionId }: { productionId: number }) =>
    ppDrawsForProduction(productionId)
  )
  // The day's work board. Read by everyone — the whole point is that each
  // person sees their own checklist — and every write names the user making
  // it, because who ticked and who approved is the record.
  handle('work:board', (_e, { date, userId }: { date?: string; userId?: number } = {}) =>
    listWorkBoard(date, userId)
  )
  // A closed day, asked for and answered. The server decides both: a day is
  // open for one login and one date, or it is not.
  handle('work:requestDay', (_e, { date, userId, reason }: { date: string; userId: number; reason?: string }) =>
    requestWorkDay(date, userId, reason)
  )
  handle(
    'work:decideDay',
    (_e, { id, approve, userId, note }: { id: number; approve: boolean; userId: number; note?: string }) =>
      decideWorkDay(id, approve !== false, userId, note)
  )
  // The same door from the admin's side: no ask, no approval, just opened.
  handle(
    'work:setDayOpen',
    (
      _e,
      { userIds, date, open, userId, note }: { userIds: number[]; date: string; open: boolean; userId: number; note?: string }
    ) => setWorkDayOpen(userIds, date, open !== false, userId, note)
  )
  handle('work:cutoff', () => workCutoff())
  // One login's own deadline, where the site's does not fit its shift.
  handle(
    'work:setUserCutoff',
    (_e, { targetId, cutoff, day, userId }: { targetId: number; cutoff: string; day?: string; userId?: number }) =>
      setUserWorkCutoff(targetId, cutoff, day, userId)
  )
  handle('work:setCutoff', (_e, { cutoff, userId, day }: { cutoff: string; userId?: number; day?: string }) =>
    setWorkCutoff(cutoff, userId, day)
  )
  handle('work:processes', () => listWorkProcesses())
  // The catalogue every board is built from. Admin only, asserted on the
  // server: this is the one list where a wrong hand costs the whole team a day.
  handle('work:saveProcess', (_e, { values, userId }: { values: Row; userId?: number }) =>
    saveWorkProcess(values, userId)
  )
  handle('work:removeProcess', (_e, { id, userId }: { id: number; userId?: number }) =>
    removeWorkProcess(id, userId)
  )
  handle('work:reorderProcesses', (_e, { ids, userId }: { ids: number[]; userId?: number }) =>
    reorderWorkProcesses(ids, userId)
  )
  handle('work:tick', (_e, { taskId, userId }: { taskId: number; userId: number }) =>
    tickWorkTask(taskId, userId)
  )
  handle('work:untick', (_e, { taskId, userId }: { taskId: number; userId: number }) =>
    untickWorkTask(taskId, userId)
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
  // Hand adjustments to a product's book stock (stockAdjust.ts).
  handle('stockAdj:list', (_e, a: { productId: number; companyIds?: number[] }) => listStockAdjustments(a?.productId, a?.companyIds))
  handle(
    'stockAdj:create',
    (_e, { values }: { values: { product_id: number; qty: number; date?: string; note: string; company_id?: number } }) =>
      addStockAdjustment(values)
  )
  handle('stockAdj:delete', (_e, { id }: { id: number }) => deleteStockAdjustment(id))
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
  handle('tbill:rcmRegister', (_e, a: { companyId?: number; from?: string; to?: string } = {}) => rcmRegister(a))
  handle('tbill:postRcm', (_e, a: { id: number; pct?: number; companyId?: number }) => postBillRcm(a.id, a.pct, a.companyId))
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
  // Read-only: the short formulation the register shows on hover.
  handle('production:mix', (_e, { id }: { id: number }) => batchMix(Number(id)))
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
  handle('sales:list', async (_e, args?: { companyIds?: number[]; forModule?: string }) => {
    const scope = await currentScope('sales')
    if (scope === 'unload') return listSalesForUnloadDesk(args?.companyIds)
    // The customer-TDS desk: invoices still missing their TDS, and only the
    // figures booking it needs (saleTds.listSalesForTdsDesk).
    if (scope === 'tds') {
      const { listSalesForTdsDesk } = await import('./saleTds')
      return listSalesForTdsDesk(args?.companyIds)
    }
    return listSales(args?.companyIds, args?.forModule)
  })
  // Which numbers are missing from the KRFL / KRFIN invoice series.
  handle('sales:series', (_e, args?: { companyId?: number }) => salesInvoiceSeries(args?.companyId))
  handle('sales:invoiceGaps', (_e, args?: { companyId?: number; from?: string; to?: string }) =>
    salesInvoiceGaps(args?.companyId, { from: args?.from, to: args?.to })
  )
  handle('sales:create', (_e, { values }: { values: Row }) => createSale(values))
  handle('sales:randomInvoiceNo', (_e, { companyId }: { companyId?: number }) =>
    randomSalesInvoiceNo(companyId || getActiveCompanyId())
  )
  handle('sales:update', (_e, { id, values }: { id: number; values: Row }) => updateSale(id, values))
  handle('sales:createInvoice', (_e, { values }: { values: Row }) => createSaleInvoice(values))
  handle('sales:updateInvoice', (_e, { group, values }: { group: string; values: Row }) => updateSaleInvoice(group, values))
  handle('sales:fixDate', (_e, { id, date }: { id: number; date: string }) => setSaleInvoiceDate(id, date))
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
  handle('sales:shortageNotes', (_e, { id }: { id: number }) => shortageNoteCandidates(id))
  handle('sales:shortageNotesSet', (_e, { id, entryIds }: { id: number; entryIds: number[] }) => setShortageNotes(id, entryIds))
  handle('sales:shortageNoteMap', () => shortageNoteMap())
  handle('sales:cancelledNos', (_e, args?: { companyId?: number }) => listCancelledInvoiceNos(args?.companyId))
  handle('sales:tdsPreview', (_e, { id }: { id: number }) => saleTdsPreview(id))
  handle('sales:tdsPost', (_e, { values }: { values: { sale_id: number; amount: number; ledger: string; date?: string } }) => postSaleTds(values))
  handle('sales:tdsRemove', (_e, { id }: { id: number }) => removeSaleTds(id))
  handle('sales:tdsMap', (_e, args?: { companyIds?: number[] }) => saleTdsMap(args?.companyIds))

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
  handle('salesBargains:linkedInvoices', (_e, { id }: { id: number }) => salesBargainLinkedInvoices(id))
  handle('salesBargains:linkedVouchers', (_e, { id }: { id: number }) => linkedVouchers('sales', id))
  handle('salesBargains:voucherChoices', (_e, { id, vchType }: { id: number; vchType?: string }) =>
    voucherChoices('sales', id, vchType)
  )
  handle('salesBargains:linkVoucher', (_e, { id, entryId, note }: { id: number; entryId: number; note?: string }) =>
    linkVoucher('sales', id, entryId, note)
  )
  handle('salesBargains:unlinkVoucher', (_e, { id, linkId }: { id: number; linkId: number }) =>
    unlinkVoucher('sales', id, linkId)
  )
  handle(
    'salesBargains:rerateInvoices',
    (_e, { id, rate, saleIds }: { id: number; rate: number; saleIds: number[] }) =>
      rerateSalesForBargain(id, rate, saleIds)
  )
  handle('salesBargains:delete', (_e, { id }: { id: number }) => deleteSalesBargain(id))
  handle('salesBargains:adjust', (_e, { id, delta, note, date }: { id: number; delta: number; note?: string; date?: string }) =>
    adjustSalesBargainQty(id, delta, note, date)
  )
  handle('salesBargains:moveBalance', (_e, { id, values }: { id: number; values: { product_id: number; qty: number; rate?: number; date?: string; note?: string } }) =>
    moveSalesBargainBalance(id, values)
  )

  handle('gate:list', () => listGateEntries())
  handle('gate:nextNo', (_e, args?: { direction?: 'in' | 'out' }) => nextGateEntryNo(args?.direction))
  handle('gate:dispatchableSales', () => listDispatchableSales())
  handle('gate:waivedOuts', () => listWaivedGateOuts())
  // ------------------------------------------------------------- web push --
  // The public key a browser needs to subscribe, the subscription it hands
  // back, and the two ways of firing one: at this device, or at every device
  // the site knows about.
  handle('push:key', async () => ({ key: (await vapidKeys()).publicKey }))
  handle('push:status', () => pushStatus())
  handle('push:subscribe', (_e, { subscription, userId, ua }: { subscription: Row; userId: number; ua?: string }) =>
    saveSubscription(subscription, userId, ua)
  )
  handle('push:unsubscribe', (_e, { endpoint }: { endpoint: string }) => dropSubscription(endpoint))
  handle('push:test', async (_e, { userId }: { userId: number }) =>
    pushTo([Number(userId) || 0], {
      title: 'Rishabh Oil — test',
      body: 'Push is working on this device. Real notifications will arrive the same way.',
      tag: `rishabhoil-test-${Date.now()}`
    })
  )
  // EVERY DEVICE, ON PURPOSE. An admin telling the whole mill something the
  // rules engine has no rule for — a shutdown, a stock count, a visit.
  handle(
    'push:broadcast',
    async (_e, { title, body, userId }: { title: string; body: string; userId: number }) => {
      const who = await getClient().execute({
        sql: 'SELECT role FROM users WHERE id = ?',
        args: [Number(userId) || 0]
      })
      if (String((who.rows[0] as unknown as Row)?.role || '') !== 'admin') {
        throw new Error('Only an admin can send to every device')
      }
      const t = String(title || '').trim()
      if (!t) throw new Error('Say what the notification should say')
      return pushTo('all', {
        title: t.slice(0, 120),
        body: String(body || '').trim().slice(0, 300),
        tag: `rishabhoil-bcast-${Date.now()}`
      })
    }
  )

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

  handle('lc:list', (_e, args?: { companyId?: number }) => listLCs(args?.companyId))
  handle('treasury:alerts', (_e, a?: { all?: boolean }) => treasuryAlerts({ all: !!a?.all }))
  handle('treasury:paymentTracker', () => listPaymentTracker())
  handle('treasury:settleLcBill', (_e, { id, date }: { id: number; date?: string }) => settleLcBill(id, date))
  handle('treasury:reopenLcBill', (_e, { id }: { id: number }) => reopenLcBill(id))
  handle('lc:issuances', (_e, { lcId }: { lcId: number }) => listLCIssuances(lcId))
  handle('lc:create', (_e, { values }: { values: Row }) => createLC(values))
  // A repaid/preclosed LC is closed: its figures, issuances and repayments
  // stay as they were closed on until the closure is undone.
  handle('lc:update', async (_e, { id, values }: { id: number; values: Row }) => {
    await assertLcNotClosed(Number(id))
    return updateLC(id, values)
  })
  handle('lc:delete', (_e, { id }: { id: number }) => deleteLC(id))
  // The bank turned an application down; and undoing that when it was a mistake.
  handle('lc:reject', (_e, { id, values }: { id: number; values: Row }) => rejectLC(Number(id), values || {}))
  handle('lc:reinstate', (_e, { id }: { id: number }) => reinstateLC(Number(id)))
  handle('lc:issue', async (_e, { values }: { values: Row }) => {
    await assertLcNotClosed(Number(values?.lc_id), 'drawn on')
    return issueLC(values)
  })
  // The bank paying the supplier in parts: the next part, and taking back
  // the latest one.
  handle('lc:payParty', async (_e, { id, values }: { id: number; values: Row }) => {
    await assertLcNotClosed(Number(id), 'paid on')
    return payLcParty(Number(id), values)
  })
  // The parts of an LC paid in parts — and repaying the bank for them.
  handle('lc:parts', (_e, { id }: { id: number }) => lcParts(Number(id)))
  handle('lc:repayParts', async (_e, { id, values }: { id: number; values: Row }) => {
    await assertLcNotClosed(Number(id), 'repaid')
    return repayLcParts(Number(id), values as Parameters<typeof repayLcParts>[1])
  })
  // Not behind the closed-LC lock: undoing the repayment that closed it is
  // exactly how a closure by parts is taken back.
  handle('lc:undoPartRepayment', (_e, { id }: { id: number }) => undoLcPartRepayment(Number(id)))
  handle('lc:deleteInstallment', async (_e, { id }: { id: number }) => {
    await assertLcNotClosed(Number(id), 'changed')
    return deleteLastLcInstallment(Number(id))
  })
  handle('lc:deleteIssuance', async (_e, { id }: { id: number }) => {
    await assertLcNotClosed(await lcIdOfIssuance(Number(id)), 'changed')
    return deleteLCIssuance(id)
  })
  handle('lc:unpreclose', (_e, { id }: { id: number }) => unPrecloseLC(id))
  // Corrects a closure's own figures and re-posts its vouchers, in one go.
  handle('lc:editPreclosure', (_e, { id, values }: { id: number; values: Parameters<typeof editPreclosure>[1] }) =>
    editPreclosure(Number(id), values)
  )
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
          charges?: { account?: string; amount?: number | string }[]
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
  handle('lc:saveRepayment', async (_e, { values }: { values: Row }) => {
    await assertLcNotClosed(Number(values?.lc_id) || (values?.id ? await lcIdOfRepayment(Number(values.id)) : 0), 'changed')
    return saveLcRepayment(values)
  })
  handle('lc:deleteRepayment', async (_e, { id }: { id: number }) => {
    await assertLcNotClosed(await lcIdOfRepayment(Number(id)), 'changed')
    return deleteLcRepayment(id)
  })
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

  // Paid the NBFC over the balance: what it owes back, and the refund that clears it (bankRefunds.ts).
  handle('bd:refundDues', async () => (await import('./bankRefunds')).refundDues('bd'))
  handle('bd:refundTotals', async () => (await import('./bankRefunds')).refundTotals('bd'))
  handle('bd:refundInfo', async (_e, { id }: { id: number }) => (await import('./bankRefunds')).refundInfo('bd', Number(id)))
  handle('bd:refundLink', async (_e, { id, entryId }: { id: number; entryId: number }) => (await import('./bankRefunds')).linkRefund('bd', Number(id), Number(entryId)))
  handle('bd:refundRecord', async (_e, { id, values }: { id: number; values: { date: string; amount: number; bank: string } }) =>
    (await import('./bankRefunds')).recordRefund('bd', Number(id), values)
  )
  handle('bd:refundUndo', async (_e, { refundId }: { refundId: number }) => (await import('./bankRefunds')).undoRefund(Number(refundId)))
  // Paid the bank over the balance: what it owes back, and the refund that clears it (bankRefunds.ts).
  handle('lc:refundDues', async () => (await import('./bankRefunds')).refundDues('lc'))
  handle('lc:refundTotals', async () => (await import('./bankRefunds')).refundTotals('lc'))
  handle('lc:refundInfo', async (_e, { id }: { id: number }) => (await import('./bankRefunds')).refundInfo('lc', Number(id)))
  handle('lc:refundLink', async (_e, { id, entryId }: { id: number; entryId: number }) => (await import('./bankRefunds')).linkRefund('lc', Number(id), Number(entryId)))
  handle('lc:refundRecord', async (_e, { id, values }: { id: number; values: { date: string; amount: number; bank: string } }) =>
    (await import('./bankRefunds')).recordRefund('lc', Number(id), values)
  )
  handle('lc:refundUndo', async (_e, { refundId }: { refundId: number }) => (await import('./bankRefunds')).undoRefund(Number(refundId)))
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
  // WHAT IS PAYABLE NOW. Read-only, so the form can recompute as the date is
  // moved without writing an audit row on every keystroke.
  handle('bd:interestWindow', (_e, { id, toDate }: { id: number; toDate?: string }) =>
    bdInterestWindow(id, toDate)
  )
  handle(
    'bd:payInterestUpto',
    (_e, { id, ...v }: { id: number; to_date: string; note?: string; post?: boolean }) =>
      payBdInterestUpto(id, v)
  )
  handle('bd:interestSchedule', (_e, { id }: { id: number }) => bdInterestSchedule(id))
  handle('bd:interestPayments', (_e, { id }: { id: number }) => listBdInterestPayments(id))
  handle(
    'bd:payInterest',
    (
      _e,
      {
        id,
        values
      }: {
        id: number
        values: {
          to_date: string
          paid_date?: string
          amount?: number | string | null
          note?: string | null
          post?: boolean
        }
      }
    ) => payBdInterest(id, values)
  )
  handle('bd:deleteInterest', (_e, { id }: { id: number }) => deleteBdInterestPayment(id))
  handle('bd:postInterest', (_e, { id }: { id: number }) => postBdInterestPayment(id))
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
      {
        id,
        amount,
        date,
        keys,
        method,
        account,
        ref
      }: {
        id: number
        amount: number
        date?: string
        keys?: string[]
        method?: string
        account?: string
        ref?: string
      }
    ) => postBdPaymentIn(id, amount, date, keys, method, account, ref)
  )
  handle('bd:deletePaymentIn', (_e, { id }: { id: number }) => deleteBdPaymentIn(id))
  handle('bd:deleteRepayment', (_e, { id }: { id: number }) => deleteBdRepayment(id))
  handle('bd:editRepayment', (_e, { id, values }: { id: number; values: Row }) => editBdRepayment(id, values))
  handle(
    'bd:markReceived',
    (
      _e,
      { id, date, route, account, firstPart, firstReceipt, legs }: { id: number; date?: string; route?: string; account?: string | null; firstPart?: number | null; firstReceipt?: number | null; legs?: Row[] | null }
    ) =>
      markBdPaymentReceived(id, date, {
        route,
        account,
        ...(Array.isArray(legs) ? { legs } : {}),
        ...(firstPart === undefined ? {} : { firstPart }),
        ...(firstReceipt === undefined ? {} : { firstReceipt })
      })
  )
  // A SID bill the NBFC released in parts.
  handle('bd:receiptParts', (_e, { id }: { id: number }) => listBdReceiptParts(Number(id)))
  handle('bd:receivePart', (_e, { id, values }: { id: number; values: Row }) => receiveBdPart(Number(id), values))
  handle('bd:deleteReceiptPart', (_e, { id }: { id: number }) => deleteLastBdReceiptPart(Number(id)))
  // The NBFC paying the supplier in parts.
  handle('bd:partyPayments', (_e, { id }: { id: number }) => listBdPartyPayments(Number(id)))
  handle('bd:payParty', (_e, { id, values }: { id: number; values: Row }) => payBdParty(Number(id), values))
  handle('bd:deletePartyPayment', (_e, { id }: { id: number }) => deleteLastBdPartyPayment(Number(id)))
  handle('bd:unmarkReceived', (_e, { id }: { id: number }) => unmarkBdPaymentReceived(id))
  handle('bd:reopen', (_e, { id }: { id: number }) => reopenBd(id))
  handle('bd:upfrontInterest', (_e, { id, date, account }: { id: number; date?: string; account?: string }) =>
    postBdUpfrontInterest(id, date, account)
  )
  handle('bd:reverseUpfrontInterest', (_e, { id }: { id: number }) => reverseBdUpfrontInterest(id))
  handle('bd:setRoute', async (_e, { id, route, account, shares }: { id: number; route: string; account?: string; shares?: Row[] }) => {
    const { setBdDisbursementRoute } = await import('./billDiscounting')
    return setBdDisbursementRoute(Number(id), String(route || ''), account, shares)
  })
  handle('bd:setVoucherBank', (_e, { id, entryId, account }: { id: number; entryId: number; account: string }) =>
    setBdVoucherBank(id, entryId, account)
  )
  // Books repairs (accounting audit). The preview is read-only and ends in
  // :list; removing vouchers is an administrator's reviewed action.
  handle('repairs:duplicateSales:list', async (_e, a?: { companyId?: number }) => {
    await assertAdmin('The books repair')
    return previewDuplicateInvoicePostings(a?.companyId)
  })
  handle('repairs:checks:list', async (_e, a?: { companyId?: number }) => {
    await assertAdmin('The accounting checks')
    return accountingChecks(a?.companyId)
  })
  handle('repairs:genericBank:list', async () => {
    await assertAdmin('The accounting checks')
    return genericBankPostings()
  })
  handle('repairs:genericBankMove', async (_e, a: { companyId: number; account: string }) => {
    await assertAdmin('Moving BANK A/C postings')
    return moveGenericBankPostings(a?.companyId, a?.account)
  })
  handle('repairs:duplicateSalesRemove', async (_e, a: { entryIds: number[]; companyId?: number }) => {
    await assertAdmin('The books repair')
    return repairDuplicateInvoicePostings(a?.entryIds || [], a?.companyId)
  })
  // TDS left on sales invoices from before sales stopped carrying it.
  handle('repairs:saleTds:list', async (_e, a?: { companyId?: number }) => {
    await assertAdmin('The accounting checks')
    return previewSaleTds(a?.companyId)
  })
  handle('repairs:saleTdsClear', async (_e, a: { keys: string[]; companyId?: number }) => {
    await assertAdmin('Clearing TDS from sales')
    return clearSaleTds(a?.keys || [], a?.companyId)
  })
  // LC repayments whose charges went through the payable in a second voucher.
  handle('repairs:lcCharges:list', async () => {
    await assertAdmin('The accounting checks')
    return previewLcCharges()
  })
  handle('repairs:lcChargesFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Re-posting LC repayment charges')
    return fixLcCharges(a?.ids || [])
  })
  // Sale vouchers still carrying their delivery freight from before it waited
  // for the transporter's bill.
  handle('repairs:outwardFreight:list', async () => {
    await assertAdmin('The accounting checks')
    return previewOutwardFreight()
  })
  handle('repairs:outwardFreightFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Taking delivery freight off sale vouchers')
    return fixOutwardFreight(a?.ids || [])
  })
  // Purchase / sale vouchers filed in the other company's books.
  handle('repairs:wrongCompany:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewWrongCompany } = await import('./accountingRepairs')
    return previewWrongCompany()
  })
  handle('repairs:wrongCompanyMove', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Moving vouchers to their own company')
    const { moveWrongCompany } = await import('./accountingRepairs')
    return moveWrongCompany(a?.ids || [])
  })
  // Vouchers whose Dr and Cr are a paisa or so apart.
  handle('repairs:paisa:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewPaisaImbalance } = await import('./accountingRepairs')
    return previewPaisaImbalance()
  })
  handle('repairs:paisaFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Balancing vouchers a paisa out')
    const { fixPaisaImbalance } = await import('./accountingRepairs')
    return fixPaisaImbalance(a?.ids || [])
  })
  // LC vouchers on the ledgers chosen for LCs (Tally's): the choice, a
  // preview of the lines that would move, and the move.
  handle('repairs:lcLedgers:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewLcLedgerMoves } = await import('./lcLedgers')
    return previewLcLedgerMoves()
  })
  handle('repairs:lcLedgersSave', async (_e, a: { values: Row }) => {
    await assertAdmin('Choosing the LC ledgers')
    const { saveLcLedgerSettings } = await import('./lcLedgers')
    return saveLcLedgerSettings(a?.values || {})
  })
  handle('repairs:lcLedgersFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Moving LC vouchers onto their ledgers')
    const { applyLcLedgerMoves } = await import('./lcLedgers')
    return applyLcLedgerMoves((a?.ids || []).map(Number))
  })
  // BD / LC payment-in vouchers — the same money as the bank receipt booked
  // from Tally. Removed on review; the payment in stays as a record.
  handle('repairs:paymentIns:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewPaymentInVouchers } = await import('./treasury')
    return previewPaymentInVouchers()
  })
  handle('repairs:paymentInsFix', async (_e, a: { keys: string[] }) => {
    await assertAdmin('Removing payment-in vouchers')
    const { removePaymentInVouchers } = await import('./treasury')
    return removePaymentInVouchers((a?.keys || []).map(String))
  })
  // Tally's payment → parking → journal (→ refund) chain for money an LC/BD
  // voucher here already pays. Removed on review; the app's voucher stays.
  handle('repairs:parkingCopies:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewParkingCopies } = await import('./parkingCopies')
    return previewParkingCopies()
  })
  handle('repairs:parkingCopiesFix', async (_e, a: { keys: string[] }) => {
    await assertAdmin('Removing Tally copies')
    const { removeParkingCopies } = await import('./parkingCopies')
    return removeParkingCopies((a?.keys || []).map(String))
  })
  // Purchase vouchers that still post the supplier's interest to INTEREST A/C.
  handle('repairs:purchaseInterest:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewPurchaseInterest } = await import('./purchaseInterestFold')
    return previewPurchaseInterest()
  })
  handle('repairs:purchaseInterestFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Moving supplier interest into the purchase account')
    const { foldPurchaseInterest } = await import('./purchaseInterestFold')
    return foldPurchaseInterest((a?.ids || []).map(Number))
  })
  // Purchases whose TDS was worked before their slab's figures were known.
  handle('repairs:staleTds:list', async () => {
    await assertAdmin('The accounting checks')
    const { refreshStalePurchaseTds } = await import('./orders')
    return refreshStalePurchaseTds(false)
  })
  // After a supplier's opening figure changes in a company: that supplier's
  // bills there whose TDS no longer fits the slab, and their recalculation.
  handle('suppliers:tdsRecalc', async (_e, a: { supplierId: number; companyId: number }) => {
    const { refreshStalePurchaseTds } = await import('./orders')
    return refreshStalePurchaseTds(false, undefined, { supplierId: Number(a.supplierId), companyId: Number(a.companyId) })
  })
  handle('suppliers:tdsRecalcFix', async (_e, a: { supplierId: number; companyId: number; ids: number[] }) => {
    const { refreshStalePurchaseTds } = await import('./orders')
    const ids = (Array.isArray(a?.ids) ? a.ids : []).map(Number).filter((x) => x > 0)
    if (!ids.length) return { findings: [], changed: 0 }
    return refreshStalePurchaseTds(true, ids, { supplierId: Number(a.supplierId), companyId: Number(a.companyId) })
  })
  handle('repairs:staleTdsFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Re-working purchase TDS')
    const ids = (a?.ids || []).map((x) => Number(x)).filter((x) => x > 0)
    if (!ids.length) throw new Error('Pick at least one purchase')
    const { refreshStalePurchaseTds } = await import('./orders')
    return refreshStalePurchaseTds(true, ids)
  })
  // Purchases whose tanker is split across two bargains but billed at one rate.
  handle('repairs:splitTanker:list', async () => {
    await assertAdmin('The accounting checks')
    const { repriceSplitTankerInvoices } = await import('./orders')
    return repriceSplitTankerInvoices(false)
  })
  handle('repairs:splitTankerFix', async (_e, a: { ids: number[] }) => {
    await assertAdmin('Re-pricing split-tanker purchases')
    const ids = (a?.ids || []).map((x) => Number(x)).filter((x) => x > 0)
    if (!ids.length) throw new Error('Pick at least one purchase')
    const { repriceSplitTankerInvoices } = await import('./orders')
    return repriceSplitTankerInvoices(true, ids)
  })
  // Customer postings in a supplier's ledger, and the other way round.
  handle('repairs:sharedLedgers:list', async () => {
    await assertAdmin('The accounting checks')
    return previewSharedLedgers()
  })
  handle('repairs:sharedLedgersFix', async (_e, a: { keys: string[] }) => {
    await assertAdmin('Splitting shared party ledgers')
    return fixSharedLedgers(a?.keys || [])
  })
  // A rename redirect hijacking a live ledger, and the lines it misdirected.
  handle('repairs:shadowedRedirects:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewShadowedRedirects } = await import('./shadowedRedirects')
    return previewShadowedRedirects()
  })
  handle('repairs:shadowedRedirectsFix', async (_e, a: { moves: { line_id: number; to_id: number }[] }) => {
    await assertAdmin('Moving misdirected lines to their own ledger')
    const { fixShadowedRedirects } = await import('./shadowedRedirects')
    return fixShadowedRedirects(a?.moves || [])
  })
  handle('repairs:legacySplit:list', async () => {
    await assertAdmin('The accounting checks')
    const { previewLegacySplit } = await import('./shadowedRedirects')
    return previewLegacySplit()
  })
  handle('repairs:legacySplitFix', async () => {
    await assertAdmin('Moving Legacy postings to their own ledger')
    const { fixLegacySplit } = await import('./shadowedRedirects')
    return fixLegacySplit()
  })
  // Whether a customer's or supplier's name is also the other side's.
  handle('parties:clashes:list', async (_e, a: { name: string; side: 'customer' | 'supplier' }) => {
    const { partyNameClashes } = await import('./partyLedgers')
    return partyNameClashes(a?.name || '', a?.side === 'supplier' ? 'supplier' : 'customer')
  })
  handle('bd:kpis', () => bdKpis())
  // The kinds of charge an Adj. can be, and adding one.
  handle('bd:chargeTypes:list', () => listBdChargeTypes())
  handle('bd:addChargeType', (_e, a: { label: string }) => addBdChargeType(a?.label))
  handle('bd:limits', () => bdLimits())
  handle('bd:setCombinedLimit', (_e, { value }: { value: number | string | null }) => setBdCombinedLimit(value))
  handle('facility:limitHistory', (_e, { kind, refId }: { kind: string; refId: number }) =>
    listLimitHistory(kind, refId)
  )
  handle('facility:addLimitRevision', (_e, { values }: { values: Row }) => addLimitRevision(values))
  handle('facility:deleteLimitRevision', (_e, { id }: { id: number }) => deleteLimitRevision(id))
  handle('bd:limitReductions', (_e, { nbfcId }: { nbfcId?: number }) => listBdLimitReductions(nbfcId))
  handle('bd:addLimitReduction', (_e, { values }: { values: Row }) => addBdLimitReduction(values))
  handle('bd:deleteLimitReduction', (_e, { id }: { id: number }) => deleteBdLimitReduction(id))

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
  // Named for the read pattern (…:list), so it skips the write gate and the
  // revision bump like every other register read.
  handle('tradingPayments:list', () => listTradingPayments())
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
