// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface Api {
  dbPing: () => Promise<{ ok: boolean; message: string; offline?: boolean }>
  revision: () => Promise<number>
  config: {
    get: () => Promise<{ url: string }>
    save: (url: string, token: string) => Promise<{ ok: boolean; message: string }>
  }
  data: {
    list: (table: string) => Promise<Row[]>
    get: (table: string, id: number) => Promise<Row | null>
    create: (table: string, values: Row) => Promise<{ id?: number; pending?: boolean }>
    update: (table: string, id: number, values: Row) => Promise<{ id: number }>
    remove: (table: string, id: number) => Promise<{ id: number }>
  }
  approvals: {
    list: () => Promise<Row[]>
    mine: () => Promise<Row[]>
    pendingCount: () => Promise<number>
    approve: (id: number) => Promise<{ id: number; createdId: number }>
    reject: (id: number, reason: string) => Promise<{ id: number }>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    all: () => Promise<Record<string, string>>
  }
  bargains: {
    list: (from?: string, to?: string) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    adjust: (id: number, delta: number, note?: string, date?: string) => Promise<{ id: number; qty: number }>
  }
  orders: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
    fyTaxable: (supplierId: number, date: string, excludeId: number) => Promise<number>
    unmapped: () => Promise<Row[]>
    bargainLines: (id: number) => Promise<Row[]>
    consignmentDraws: () => Promise<Row[]>
    unmappedCount: () => Promise<number>
    map: (id: number, lines: Row[], force?: boolean) => Promise<{ id: number; bargain_id: number; valueDiff: number; toppedUp: { bargain_no: string; qty: number }[] }>
  }
  company: {
    list: () => Promise<Row[]>
    setActive: (id: number) => Promise<{ id: number }>
    getActive: () => Promise<{ id: number }>
  }
  consignment: {
    list: () => Promise<Row[]>
    summary: (range?: { from?: string; to?: string }) => Promise<Row[]>
    invoices: (range?: { from?: string; to?: string }) => Promise<Row[]>
    pending: () => Promise<Row[]>
    lots: (supplierId?: number, productId?: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    saveOpening: (values: Row) => Promise<{ id: number }>
    openingLog: (supplierId: number, productId: number) => Promise<Row[]>
  }
  tankers: {
    list: (all?: boolean) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
    revert: (id: number) => Promise<{ id: number; status: string }>
    replace: (id: number, values: Row) => Promise<{ id: number }>
  }
  dashboard: {
    stats: () => Promise<Row>
  }
  vouchers: {
    list: (args?: { from?: string; to?: string; vchType?: string; companyId?: number }) => Promise<Row[]>
    get: (id: number) => Promise<Row | null>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  journal: {
    trialBalance: (args?: { from?: string; to?: string; companyId?: number }) => Promise<Row>
    groups: (companyId?: number) => Promise<Row[]>
    groupNames: () => Promise<{ name: string; nature: string }[]>
    pendingRefs: (account: string, companyId?: number) => Promise<Row[]>
    tradingAccount: (from?: string, to?: string, companyId?: number) => Promise<Row[]>
    accounts: (companyId?: number) => Promise<Row[]>
    createAccount: (name: string, group?: string) => Promise<{ id: number }>
    statement: (accountId: number, companyId?: number) => Promise<Row[]>
    addEntry: (data: Row) => Promise<{ id: number }>
    deleteEntry: (id: number) => Promise<{ id: number }>
  }
  ledger: {
    suppliers: () => Promise<Row[]>
    transporters: () => Promise<Row[]>
    customers: () => Promise<Row[]>
    addEntry: (data: Row) => Promise<{ id: number }>
    deleteEntry: (partyType: string, id: number) => Promise<{ id: number }>
  }
  billDiscounts: {
    list: () => Promise<Row[]>
  }
  auth: {
    login: (username: string, password: string) => Promise<Row>
  }
  access: {
    heartbeat: (userId: number, username: string) => Promise<{ blocked: boolean }>
    liveUsers: () => Promise<Row[]>
    ips: () => Promise<Row[]>
    setIp: (id: number, active: boolean) => Promise<{ id: number }>
    logs: (filter?: Row) => Promise<{ rows: Row[]; users: string[]; entities: string[] }>
  }
  session: {
    setUser: (id: number | null, username: string) => Promise<{ ok: true }>
  }
  users: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  formulations: {
    list: () => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  stock: {
    list: (range?: { from?: string; to?: string }, companyIds?: number[]) => Promise<Row[]>
    needs: () => Promise<Row[]>
    breakdown: (companyIds?: number[], range?: { from?: string; to?: string }) => Promise<Record<number, { receipt: Row[]; dispatch: Row[] }>>
    daybook: (from: string, to: string) => Promise<{ vouchers: Row[]; material: Row[] }>
    transfers: () => Promise<Row[]>
    transfer: (values: Row) => Promise<{ id: number }>
    deleteTransfer: (id: number) => Promise<{ id: number }>
  }
  stockCount: {
    sheet: (date: string) => Promise<Row[]>
    list: (date: string) => Promise<Row[]>
    save: (date: string, items: Row[]) => Promise<{ count: number }>
  }
  skuStock: {
    list: (date?: string) => Promise<Row[]>
    adjust: (id: number, delta: number, note?: string, date?: string) => Promise<{ id: number; on_hand: number }>
  }
  notes: {
    list: () => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; note_no: string }>
    remove: (id: number) => Promise<{ id: number }>
  }
  production: {
    list: () => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  sales: {
    list: () => Promise<Row[]>
    fyTaxable: (customerId: number, date: string, excludeId: number) => Promise<number>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    setStatus: (id: number, status: string) => Promise<{ id: number }>
    setStage: (id: number, stage: string, force?: boolean, date?: string) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    createInvoice: (values: Row) => Promise<{ group: string; ids: number[] }>
    updateInvoice: (group: string, values: Row) => Promise<{ group: string; ids: number[] }>
    setInvoiceStage: (group: string, stage: string, force?: boolean, date?: string) => Promise<{ group: string }>
    removeInvoice: (group: string) => Promise<{ group: string }>
  }
  skuRates: {
    parties: (packagingId: number) => Promise<number[]>
    setParties: (packagingId: number, customerIds: number[]) => Promise<{ count: number }>
    list: (id: number) => Promise<Row[]>
    save: (id: number, rows: Row[]) => Promise<{ saved: number; cleared: number }>
  }
  salesBargains: {
    list: (from?: string, to?: string) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    adjust: (id: number, delta: number, note?: string, date?: string) => Promise<{ id: number; qty: number }>
  }
  gate: {
    list: () => Promise<Row[]>
    nextNo: (direction?: 'in' | 'out') => Promise<string>
    dispatchableSales: () => Promise<Row[]>
    partyCategories: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    complete: (id: number, gross: number, tare: number) => Promise<{ id: number }>
    weights: (
      id: number,
      gross: number | null,
      tare: number | null,
      awaitingGrossOut?: boolean | null,
      dispatchQty?: number | string | null,
      invoiceGroup?: string | null,
      outDate?: string | null
    ) => Promise<{ id: number; status: string; net: number | null; missing: string | null }>
    skipWeighment: (id: number) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  treasury: {
    alerts: () => Promise<Row>
    paymentTracker: () => Promise<Row[]>
    settleLcBill: (id: number, date?: string) => Promise<{ id: number }>
    reopenLcBill: (id: number) => Promise<{ id: number }>
    discount: (values: Row) => Promise<{ id: number }>
    realize: (id: number, date?: string) => Promise<{ id: number }>
    unrealize: (id: number) => Promise<{ id: number }>
    deleteDiscount: (id: number) => Promise<{ id: number }>
  }
  lc: {
    list: () => Promise<Row[]>
    issuances: (lcId: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    issue: (values: Row) => Promise<{ id: number }>
    removeIssuance: (id: number) => Promise<{ id: number }>
    repayments: (lcId: number) => Promise<Row[]>
    saveRepayment: (values: Row) => Promise<{ id: number }>
    removeRepayment: (id: number) => Promise<{ id: number }>
    preclose: (
      id: number,
      values: { preclose_date: string; direction: 'credit_to_us' | 'pay_to_party'; amount: number }
    ) => Promise<{ id: number }>
    getLimit: () => Promise<Row>
    saveLimit: (values: Row) => Promise<{ id: number }>
  }
  files: {
    pickDocument: () => Promise<{ path: string | null }>
    openDocument: (path: string) => Promise<{ ok: boolean }>
  }
  bankRecon: {
    import: (values: Row) => Promise<{ id: number; count: number }>
    imports: () => Promise<Row[]>
    deleteImport: (id: number) => Promise<{ id: number }>
    list: (filter: Row) => Promise<Row[]>
    suggest: (lineId: number) => Promise<Row | null>
    reconcile: (lineId: number, values: Row) => Promise<{ id: number }>
    markMisc: (lineId: number) => Promise<{ id: number }>
    unreconcile: (lineId: number) => Promise<{ id: number }>
    setSubEntry: (lineId: number, values: Row) => Promise<{ id: number }>
  }
  billDiscounting: {
    parties: () => Promise<Row[]>
    createParty: (values: Row) => Promise<{ id: number }>
    updateParty: (id: number, values: Row) => Promise<{ id: number }>
    deleteParty: (id: number) => Promise<{ id: number }>
    entries: (filter: Row) => Promise<Row[]>
    createEntry: (values: Row) => Promise<{ id: number }>
    markPaid: (id: number, date?: string) => Promise<{ id: number }>
    markRepaid: (id: number, date?: string) => Promise<{ id: number }>
    recordInterest: (id: number, values: Row) => Promise<{ id: number }>
    deleteEntry: (id: number) => Promise<{ id: number }>
    fundFlow: () => Promise<Row>
  }
  trading: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  facility: {
    list: () => Promise<Row[]>
    exposures: (facilityId: number) => Promise<Row[]>
    headroom: (facilityId: number, excludeLcId?: number) => Promise<Row>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    saveExposure: (values: Row) => Promise<{ id: number }>
    removeExposure: (id: number) => Promise<{ id: number }>
  }
  updates: {
    version: () => Promise<string>
    check: () => Promise<{ ok: boolean; version?: string; message?: string }>
    install: () => Promise<{ ok: boolean }>
    onStatus: (cb: (status: Row) => void) => () => void
  }
}

declare global {
  interface Window {
    api: Api
  }
}
