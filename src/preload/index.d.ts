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
    summary: () => Promise<Row[]>
    pending: () => Promise<Row[]>
    lots: (supplierId?: number, productId?: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  tankers: {
    list: (all?: boolean) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
  }
  journal: {
    accounts: () => Promise<Row[]>
    createAccount: (name: string) => Promise<{ id: number }>
    statement: (accountId: number) => Promise<Row[]>
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
  payments: {
    list: () => Promise<Row[]>
    record: (data: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    outstanding: (partyType: string, partyId: number) => Promise<Row[]>
  }
  billDiscounts: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
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
    list: () => Promise<Row[]>
    needs: () => Promise<Row[]>
    breakdown: () => Promise<Record<number, { receipt: Row[]; dispatch: Row[] }>>
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
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    complete: (id: number, gross: number, tare: number) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  lc: {
    list: () => Promise<Row[]>
    issuances: (lcId: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    issue: (values: Row) => Promise<{ id: number }>
    removeIssuance: (id: number) => Promise<{ id: number }>
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
