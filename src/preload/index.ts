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
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bargains:delete', { id })
  },
  orders: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('orders:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('orders:delete', { id }),
    advance: (id: number, toStatus: string, data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:advance', { id, toStatus, data })
  },
  ledger: {
    suppliers: (): Promise<Row[]> => ipcRenderer.invoke('ledger:suppliers'),
    transporters: (): Promise<Row[]> => ipcRenderer.invoke('ledger:transporters')
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
  users: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('users:list'),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('users:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('users:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('users:delete', { id })
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
