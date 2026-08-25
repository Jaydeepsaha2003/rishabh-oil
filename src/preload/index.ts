import { contextBridge, ipcRenderer } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The single, controlled surface the UI is allowed to call.
const api = {
  dbPing: (): Promise<{ ok: boolean; message: string; offline?: boolean }> => ipcRenderer.invoke('db:ping'),
  revision: (): Promise<number> => ipcRenderer.invoke('app:revision'),
  config: {
    get: (): Promise<{ url: string }> => ipcRenderer.invoke('config:get'),
    save: (url: string, token: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('config:save', { url, token })
  },
  data: {
    list: (table: string): Promise<Row[]> => ipcRenderer.invoke('data:list', { table }),
    get: (table: string, id: number): Promise<Row | null> =>
      ipcRenderer.invoke('data:get', { table, id }),
    create: (table: string, values: Row): Promise<{ id?: number; pending?: boolean }> =>
      ipcRenderer.invoke('data:create', { table, values }),
    update: (table: string, id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('data:update', { table, id, values }),
    remove: (table: string, id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('data:delete', { table, id })
  },
  approvals: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('approvals:list'),
    mine: (): Promise<Row[]> => ipcRenderer.invoke('approvals:mine'),
    pendingCount: (): Promise<number> => ipcRenderer.invoke('approvals:pendingCount'),
    approve: (id: number): Promise<{ id: number; createdId: number }> =>
      ipcRenderer.invoke('approvals:approve', { id }),
    reject: (id: number, reason: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('approvals:reject', { id, reason })
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', { key }),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('settings:set', { key, value }),
    all: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:all')
  },
  bargains: {
    list: (from?: string, to?: string, companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('bargains:list', { from, to, companyIds }),
    create: (values: Row): Promise<{ id: number; bargain_no: string }> =>
      ipcRenderer.invoke('bargains:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('bargains:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bargains:delete', { id }),
    adjust: (id: number, delta: number, note?: string, date?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('bargains:adjust', { id, delta, note, date })
  },
  orders: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('orders:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('orders:delete', { id }),
    advance: (id: number, toStatus: string, data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:advance', { id, toStatus, data }),
    unmapped: (): Promise<Row[]> => ipcRenderer.invoke('orders:unmapped'),
    bargainLines: (id: number): Promise<Row[]> => ipcRenderer.invoke('orders:bargainLines', { id }),
    bargainInterest: (id: number): Promise<Row[]> => ipcRenderer.invoke('orders:bargainInterest', { id }),
    consignmentDraws: (companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('orders:consignmentDraws', { companyIds }),
    unmappedCount: (): Promise<number> => ipcRenderer.invoke('orders:unmappedCount'),
    map: (id: number, lines: Row[], force?: boolean): Promise<Row> =>
      ipcRenderer.invoke('orders:map', { id, lines, force }),
    fyTaxable: (supplierId: number, date: string, excludeId: number): Promise<number> =>
      ipcRenderer.invoke('orders:fyTaxable', { supplierId, date, excludeId })
  },
  company: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('company:list'),
    setActive: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('company:setActive', { id }),
    getActive: (): Promise<{ id: number }> => ipcRenderer.invoke('company:getActive')
  },
  consignment: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('consignment:list'),
    summary: (range?: { from?: string; to?: string }): Promise<Row[]> =>
      ipcRenderer.invoke('consignment:summary', { range }),
    invoices: (range?: { from?: string; to?: string }): Promise<Row[]> =>
      ipcRenderer.invoke('consignment:invoices', { range }),
    pending: (): Promise<Row[]> => ipcRenderer.invoke('consignment:pending'),
    lots: (supplierId?: number, productId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('consignment:lots', { supplierId, productId }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('consignment:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('consignment:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('consignment:delete', { id }),
    saveOpening: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('consignment:saveOpening', { values }),
    openingLog: (supplierId: number, productId: number): Promise<Row[]> =>
      ipcRenderer.invoke('consignment:openingLog', { supplierId, productId })
  },
  tankers: {
    list: (all?: boolean): Promise<Row[]> => ipcRenderer.invoke('tankers:list', { all }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('tankers:delete', { id }),
    advance: (id: number, toStatus: string, data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:advance', { id, toStatus, data }),
    revert: (id: number): Promise<{ id: number; status: string }> => ipcRenderer.invoke('tankers:revert', { id }),
    replace: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('tankers:replace', { id, values })
  },
  dashboard: {
    stats: (): Promise<Row> => ipcRenderer.invoke('dashboard:stats')
  },
  vouchers: {
    list: (args?: { from?: string; to?: string; vchType?: string | string[]; companyId?: number }): Promise<Row[]> =>
      ipcRenderer.invoke('vouchers:list', args),
    get: (id: number): Promise<Row | null> => ipcRenderer.invoke('vouchers:get', { id }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('vouchers:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('vouchers:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('vouchers:delete', { id })
  },
  journal: {
    trialBalance: (args?: { from?: string; to?: string; companyId?: number }): Promise<Row> =>
      ipcRenderer.invoke('journal:trialBalance', args),
    groups: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:groups', { companyId }),
    groupNames: (): Promise<{ name: string; nature: string }[]> => ipcRenderer.invoke('journal:groupNames'),
    billsOutstanding: (
      account: string,
      companyId?: number,
      opts: { asOf?: string; side?: 'customer' | 'supplier' } = {}
    ): Promise<Row> => ipcRenderer.invoke('journal:billsOutstanding', { account, companyId, ...opts }),
    pendingRefs: (account: string, companyId?: number, side?: 'customer' | 'supplier'): Promise<Row[]> =>
      ipcRenderer.invoke('journal:pendingRefs', { account, companyId, side }),
    tradingAccount: (from?: string, to?: string, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('journal:tradingAccount', { from, to, companyId }),
    accounts: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:accounts', { companyId }),
    createAccount: (name: string, group?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:createAccount', { name, group }),
    statement: (accountId: number, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('journal:statement', { accountId, companyId }),
    addEntry: (data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:addEntry', { data }),
    deleteEntry: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:deleteEntry', { id })
  },
  ledger: {
    suppliers: (): Promise<Row[]> => ipcRenderer.invoke('ledger:suppliers'),
    transporters: (): Promise<Row[]> => ipcRenderer.invoke('ledger:transporters'),
    customers: (): Promise<Row[]> => ipcRenderer.invoke('ledger:customers'),
    addEntry: (data: Row): Promise<{ id: number }> => ipcRenderer.invoke('ledger:addEntry', { data }),
    deleteEntry: (partyType: string, id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('ledger:deleteEntry', { partyType, id })
  },
  auth: {
    login: (username: string, password: string): Promise<Row> =>
      ipcRenderer.invoke('auth:login', { username, password })
  },
  access: {
    heartbeat: (
      userId: number,
      username: string
    ): Promise<{ blocked: boolean; revoked?: boolean; role?: string; full_name?: string; permissions?: unknown }> =>
      ipcRenderer.invoke('access:heartbeat', { userId, username }),
    liveUsers: (): Promise<Row[]> => ipcRenderer.invoke('access:liveUsers'),
    ips: (): Promise<Row[]> => ipcRenderer.invoke('access:ips'),
    setIp: (id: number, active: boolean): Promise<{ id: number }> =>
      ipcRenderer.invoke('access:setIp', { id, active }),
    logs: (filter?: Row): Promise<{ rows: Row[]; users: string[]; entities: string[] }> =>
      ipcRenderer.invoke('access:logs', { filter })
  },
  session: {
    setUser: (id: number | null, username: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('session:setUser', { id, username })
  },
  users: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('users:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('users:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('users:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('users:delete', { id })
  },
  formulations: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('formulations:list'),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('formulations:items', { id }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('formulations:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('formulations:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('formulations:delete', { id })
  },
  stock: {
    list: (range?: { from?: string; to?: string }, companyIds?: number[]): Promise<Row[]> => ipcRenderer.invoke('stock:list', { range, companyIds }),
    needs: (): Promise<Row[]> => ipcRenderer.invoke('stock:needs'),
    breakdown: (companyIds?: number[], range?: { from?: string; to?: string }): Promise<Record<number, { receipt: Row[]; dispatch: Row[] }>> =>
      ipcRenderer.invoke('stock:breakdown', { companyIds, range }),
    registers: (companyIds?: number[], range?: { from?: string; to?: string }): Promise<{ receipts: Row[]; dispatches: Row[] }> =>
      ipcRenderer.invoke('stock:registers', { companyIds, range }),
    daybook: (from: string, to: string): Promise<{ vouchers: Row[]; material: Row[] }> => ipcRenderer.invoke('daybook:list', { from, to }),
    transfers: (): Promise<Row[]> => ipcRenderer.invoke('stock:transfers'),
    transfer: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('stock:transfer', { values }),
    deleteTransfer: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('stock:deleteTransfer', { id })
  },
  stockCount: {
    sheet: (date: string): Promise<Row[]> => ipcRenderer.invoke('stockCount:sheet', { date }),
    list: (date: string): Promise<Row[]> => ipcRenderer.invoke('stockCount:list', { date }),
    save: (date: string, items: Row[]): Promise<{ count: number }> =>
      ipcRenderer.invoke('stockCount:save', { date, items })
  },
  skuStock: {
    list: (date?: string): Promise<Row[]> => ipcRenderer.invoke('skuStock:list', { date }),
    adjust: (id: number, delta: number, note?: string, date?: string): Promise<{ id: number; on_hand: number }> =>
      ipcRenderer.invoke('skuStock:adjust', { id, delta, note, date })
  },
  transporterFreight: {
    list: (
      side: 'purchase' | 'sales',
      opts: { companyId?: number; from?: string; to?: string; transporterId?: number; state?: 'all' | 'unbilled' | 'billed' } = {}
    ): Promise<Row[]> => ipcRenderer.invoke('tfreight:list', { side, ...opts }),
    kpis: (side: 'purchase' | 'sales', opts: { companyId?: number; from?: string; to?: string } = {}): Promise<Row> =>
      ipcRenderer.invoke('tfreight:kpis', { side, ...opts }),
    bills: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('tbill:list', { companyId }),
    createBill: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('tbill:create', { values }),
    updateBill: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('tbill:update', { id, values }),
    deleteBill: (id: number, companyId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('tbill:delete', { id, companyId }),
    orphanBills: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('tbill:orphans', { companyId })
  },
  notes: {
    list: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('notes:list', { companyId }),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('notes:items', { id }),
    create: (values: Row): Promise<{ id: number; note_no: string }> =>
      ipcRenderer.invoke('notes:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number; note_no: string }> =>
      ipcRenderer.invoke('notes:update', { id, values }),
    remove: (id: number, companyId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('notes:delete', { id, companyId })
  },
  production: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('production:list'),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('production:items', { id }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:create', { values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:delete', { id })
  },
  sales: {
    list: (companyIds?: number[]): Promise<Row[]> => ipcRenderer.invoke('sales:list', { companyIds }),
    fyTaxable: (customerId: number, date: string, excludeId: number): Promise<number> =>
      ipcRenderer.invoke('sales:fyTaxable', { customerId, date, excludeId }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:update', { id, values }),
    setStatus: (id: number, status: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:setStatus', { id, status }),
    setStage: (id: number, stage: string, force?: boolean, date?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:setStage', { id, stage, force, date }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('sales:delete', { id }),
    createInvoice: (values: Row): Promise<{ group: string; ids: number[] }> =>
      ipcRenderer.invoke('sales:createInvoice', { values }),
    updateInvoice: (group: string, values: Row): Promise<{ group: string; ids: number[] }> =>
      ipcRenderer.invoke('sales:updateInvoice', { group, values }),
    setInvoiceStage: (
      group: string,
      stage: string,
      force?: boolean,
      date?: string,
      received?: Record<string, number | null>
    ): Promise<{ group: string }> =>
      ipcRenderer.invoke('sales:setInvoiceStage', { group, stage, force, date, received }),
    removeInvoice: (group: string): Promise<{ group: string }> =>
      ipcRenderer.invoke('sales:deleteInvoice', { group }),
    rejectInvoice: (group: string, reason: string): Promise<{ group: string }> =>
      ipcRenderer.invoke('sales:rejectInvoice', { group, reason }),
    cancelDelivery: (
      group: string,
      reason: string,
      freightQty?: Record<string, number | null>
    ): Promise<{ group: string; lines: number }> =>
      ipcRenderer.invoke('sales:cancelDelivery', { group, reason, freightQty }),
    unrejectInvoice: (group: string): Promise<{ group: string }> =>
      ipcRenderer.invoke('sales:unrejectInvoice', { group })
  },
  skuRates: {
    parties: (packagingId: number): Promise<number[]> => ipcRenderer.invoke('skuRates:parties', { packagingId }),
    setParties: (packagingId: number, customerIds: number[]): Promise<{ count: number }> =>
      ipcRenderer.invoke('skuRates:setParties', { packagingId, customerIds }),
    list: (id: number): Promise<Row[]> => ipcRenderer.invoke('skuRates:list', { id }),
    save: (id: number, rows: Row[]): Promise<{ saved: number; cleared: number }> =>
      ipcRenderer.invoke('skuRates:save', { id, rows })
  },
  salesBargains: {
    list: (from?: string, to?: string, companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('salesBargains:list', { from, to, companyIds }),
    returns: (companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('salesBargains:returns', { companyIds }),
    unattributedReturns: (companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('salesBargains:unattributedReturns', { companyIds }),
    create: (values: Row): Promise<{ id: number; bargain_no: string }> =>
      ipcRenderer.invoke('salesBargains:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:delete', { id }),
    adjust: (id: number, delta: number, note?: string, date?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('salesBargains:adjust', { id, delta, note, date })
  },
  gate: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('gate:list'),
    nextNo: (direction?: 'in' | 'out'): Promise<string> => ipcRenderer.invoke('gate:nextNo', { direction }),
    dispatchableSales: (): Promise<Row[]> => ipcRenderer.invoke('gate:dispatchableSales'),
    partyCategories: (): Promise<Row[]> => ipcRenderer.invoke('gate:partyCategories'),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('gate:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('gate:update', { id, values }),
    complete: (id: number, gross: number, tare: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('gate:complete', { id, gross, tare }),
    weights: (
      id: number,
      gross: number | null,
      tare: number | null,
      awaitingGrossOut?: boolean | null,
      dispatchQty?: number | string | null,
      invoiceGroup?: string | null,
      outDate?: string | null,
      outTime?: string | null
    ): Promise<{ id: number; status: string; net: number | null; missing: string | null }> =>
      ipcRenderer.invoke('gate:weights', { id, gross, tare, awaitingGrossOut, dispatchQty, invoiceGroup, outDate, outTime }),
    skipWeighment: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('gate:skipWeighment', { id }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('gate:delete', { id }),
    reject: (id: number, reason: string): Promise<{ id: number }> => ipcRenderer.invoke('gate:reject', { id, reason }),
    unreject: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('gate:unreject', { id })
  },
  treasury: {
    alerts: (): Promise<Row> => ipcRenderer.invoke('treasury:alerts'),
    paymentTracker: (): Promise<Row[]> => ipcRenderer.invoke('treasury:paymentTracker'),
    settleLcBill: (id: number, date?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('treasury:settleLcBill', { id, date }),
    reopenLcBill: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('treasury:reopenLcBill', { id })
  },
  lc: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('lc:list'),
    issuances: (lcId: number): Promise<Row[]> => ipcRenderer.invoke('lc:issuances', { lcId }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('lc:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('lc:delete', { id }),
    issue: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('lc:issue', { values }),
    removeIssuance: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:deleteIssuance', { id }),
    repayments: (lcId: number): Promise<Row[]> => ipcRenderer.invoke('lc:repayments', { lcId }),
    saveRepayment: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:saveRepayment', { values }),
    removeRepayment: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:deleteRepayment', { id }),
    paymentIn: (id: number, amount: number, date?: string, selectedKeys?: string[]): Promise<{ id: number; date: string }> =>
      ipcRenderer.invoke('lc:paymentIn', { id, amount, date, selectedKeys }),
    paymentIns: (lcId: number): Promise<Row[]> => ipcRenderer.invoke('lc:paymentIns', { lcId }),
    removePaymentIn: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('lc:deletePaymentIn', { id }),
    openTradingInvoices: (lcId: number): Promise<Row[]> => ipcRenderer.invoke('lc:openTradingInvoices', { lcId }),
    preclose: (
      id: number,
      values: {
        preclose_date: string
        amount: number
        comm_charges?: number
        bank_charges?: number
        premature_interest?: number
        premature_interest_direction?: 'credit_to_us' | 'pay_to_party'
        release_margin?: boolean
      }
    ): Promise<{ id: number }> => ipcRenderer.invoke('lc:preclose', { id, values }),
    unpreclose: (id: number): Promise<{ id: number; removed: string[] }> =>
      ipcRenderer.invoke('lc:unpreclose', { id }),
    getLimit: (bankId?: number, from?: string, to?: string): Promise<Row> =>
      ipcRenderer.invoke('lc:getLimit', { bankId, from, to }),
    bankLimits: (): Promise<Row[]> => ipcRenderer.invoke('lc:bankLimits'),
    saveLimit: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('lc:saveLimit', { values })
  },
  files: {
    pickDocument: (): Promise<{ path: string | null }> => ipcRenderer.invoke('files:pickDocument'),
    openDocument: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('files:openDocument', { path })
  },
  bankRecon: {
    import: (values: Row): Promise<{ id: number; count: number }> =>
      ipcRenderer.invoke('bankRecon:import', { values }),
    imports: (): Promise<Row[]> => ipcRenderer.invoke('bankRecon:imports'),
    deleteImport: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bankRecon:deleteImport', { id }),
    list: (filter: Row): Promise<Row[]> => ipcRenderer.invoke('bankRecon:list', { filter }),
    suggest: (lineId: number): Promise<Row | null> => ipcRenderer.invoke('bankRecon:suggest', { lineId }),
    reconcile: (lineId: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('bankRecon:reconcile', { lineId, values }),
    markMisc: (lineId: number): Promise<{ id: number }> => ipcRenderer.invoke('bankRecon:markMisc', { lineId }),
    unreconcile: (lineId: number): Promise<{ id: number }> => ipcRenderer.invoke('bankRecon:unreconcile', { lineId }),
    setSubEntry: (lineId: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('bankRecon:setSubEntry', { lineId, values })
  },
  billDiscounting: {
    list: (filter?: Row): Promise<Row[]> => ipcRenderer.invoke('bd:list', { filter }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('bd:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('bd:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:delete', { id }),
    repay: (
      id: number,
      values: {
        repay_date?: string
        settle_via?: 'bank' | 'party'
        ref?: string | null
        release_margin?: boolean
        amount?: number | string | null
        note?: string | null
      }
    ): Promise<{ id: number; amount: number; outstanding: number; closed: boolean }> =>
      ipcRenderer.invoke('bd:repay', { id, values }),
    repayments: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:repayments', { id }),
    deleteRepayment: (id: number): Promise<{ id: number; bd_id: number }> =>
      ipcRenderer.invoke('bd:deleteRepayment', { id }),
    reopen: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:reopen', { id }),
    upfrontInterest: (id: number, date?: string): Promise<{ id: number } | null> =>
      ipcRenderer.invoke('bd:upfrontInterest', { id, date }),
    kpis: (): Promise<Row> => ipcRenderer.invoke('bd:kpis')
  },
  trading: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('trading:list'),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('trading:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('trading:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('trading:delete', { id })
  },
  facility: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('facility:list'),
    exposures: (facilityId: number): Promise<Row[]> => ipcRenderer.invoke('facility:exposures', { facilityId }),
    headroom: (facilityId: number, excludeLcId?: number): Promise<Row> =>
      ipcRenderer.invoke('facility:headroom', { facilityId, excludeLcId }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('facility:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('facility:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('facility:delete', { id }),
    saveExposure: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('facility:saveExposure', { values }),
    removeExposure: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('facility:deleteExposure', { id })
  },
  updates: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    check: (): Promise<{ ok: boolean; version?: string; message?: string }> =>
      ipcRenderer.invoke('update:check'),
    install: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (status: Row) => void): (() => void) => {
      const listener = (_e: unknown, data: Row): void => cb(data)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.removeListener('update:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
