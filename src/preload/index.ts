import { contextBridge, ipcRenderer } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The single, controlled surface the UI is allowed to call.
const api = {
  dbPing: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('db:ping'),
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
    create: (table: string, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('data:create', { table, values }),
    update: (table: string, id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('data:update', { table, id, values }),
    remove: (table: string, id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('data:delete', { table, id })
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', { key }),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('settings:set', { key, value }),
    all: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:all')
  },
  bargains: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('bargains:list'),
    create: (values: Row): Promise<{ id: number; bargain_no: string }> =>
      ipcRenderer.invoke('bargains:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('bargains:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bargains:delete', { id }),
    adjust: (id: number, delta: number, note?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('bargains:adjust', { id, delta, note })
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
    summary: (): Promise<Row[]> => ipcRenderer.invoke('consignment:summary'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('consignment:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('consignment:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('consignment:delete', { id })
  },
  tankers: {
    list: (all?: boolean): Promise<Row[]> => ipcRenderer.invoke('tankers:list', { all }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('tankers:delete', { id }),
    advance: (id: number, toStatus: string, data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:advance', { id, toStatus, data })
  },
  journal: {
    accounts: (): Promise<Row[]> => ipcRenderer.invoke('journal:accounts'),
    createAccount: (name: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:createAccount', { name }),
    statement: (accountId: number): Promise<Row[]> =>
      ipcRenderer.invoke('journal:statement', { accountId }),
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
  payments: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('payments:list'),
    record: (data: Row): Promise<{ id: number }> => ipcRenderer.invoke('payments:record', { data }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('payments:delete', { id }),
    outstanding: (partyType: string, partyId: number): Promise<Row[]> =>
      ipcRenderer.invoke('payments:outstanding', { partyType, partyId })
  },
  billDiscounts: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('billDiscounts:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('billDiscounts:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('billDiscounts:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('billDiscounts:delete', { id })
  },
  auth: {
    login: (username: string, password: string): Promise<Row> =>
      ipcRenderer.invoke('auth:login', { username, password })
  },
  access: {
    heartbeat: (userId: number, username: string): Promise<{ blocked: boolean }> =>
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
    list: (): Promise<Row[]> => ipcRenderer.invoke('stock:list'),
    needs: (): Promise<Row[]> => ipcRenderer.invoke('stock:needs'),
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
  production: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('production:list'),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('production:items', { id }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:create', { values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:delete', { id })
  },
  sales: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('sales:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:update', { id, values }),
    setStatus: (id: number, status: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:setStatus', { id, status }),
    setStage: (id: number, stage: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('sales:setStage', { id, stage }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('sales:delete', { id })
  },
  salesBargains: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('salesBargains:list'),
    create: (values: Row): Promise<{ id: number; bargain_no: string }> =>
      ipcRenderer.invoke('salesBargains:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:delete', { id }),
    adjust: (id: number, delta: number, note?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('salesBargains:adjust', { id, delta, note })
  },
  gate: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('gate:list'),
    nextNo: (): Promise<string> => ipcRenderer.invoke('gate:nextNo'),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('gate:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('gate:update', { id, values }),
    complete: (id: number, receivedQty: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('gate:complete', { id, receivedQty }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('gate:delete', { id })
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
      ipcRenderer.invoke('lc:deleteIssuance', { id })
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
