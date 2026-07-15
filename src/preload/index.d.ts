// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface Api {
  dbPing: () => Promise<{ ok: boolean; message: string }>
  revision: () => Promise<number>
  config: {
    get: () => Promise<{ url: string }>
    save: (url: string, token: string) => Promise<{ ok: boolean; message: string }>
  }
  data: {
    list: (table: string) => Promise<Row[]>
    get: (table: string, id: number) => Promise<Row | null>
    create: (table: string, values: Row) => Promise<{ id: number }>
    update: (table: string, id: number, values: Row) => Promise<{ id: number }>
    remove: (table: string, id: number) => Promise<{ id: number }>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    all: () => Promise<Record<string, string>>
  }
  bargains: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  orders: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
    fyTaxable: (supplierId: number, date: string, excludeId: number) => Promise<number>
  }
  tankers: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
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
    logs: () => Promise<Row[]>
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
  }
  stockCount: {
    sheet: (date: string) => Promise<Row[]>
    list: (date: string) => Promise<Row[]>
    save: (date: string, items: Row[]) => Promise<{ count: number }>
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
    remove: (id: number) => Promise<{ id: number }>
  }
  salesBargains: {
    list: () => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  gate: {
    list: () => Promise<Row[]>
    nextNo: () => Promise<string>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    complete: (id: number, receivedQty: number) => Promise<{ id: number }>
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
