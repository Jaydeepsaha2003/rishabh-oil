import { contextBridge, ipcRenderer } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The single, controlled surface the UI is allowed to call.
const api = {
  dbPing: (): Promise<{ ok: boolean; message: string; offline?: boolean }> => ipcRenderer.invoke('db:ping'),
  revision: (): Promise<number> => ipcRenderer.invoke('app:revision'),
  db: {
    // The whole database as gzipped SQL, base64 for the trip across the
    // bridge. Settings -> Database turns it back into a file to save.
    snapshot: (): Promise<{
      at: string
      tables: number
      rows: number
      bytes: number
      gz: string
      gzBytes: number
      fileName: string
    }> => ipcRenderer.invoke('db:snapshot')
  },
  config: {
    get: (): Promise<{ url: string }> => ipcRenderer.invoke('config:get'),
    save: (url: string, token: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('config:save', { url, token })
  },
  suppliers: {
    purchaseCounts: (): Promise<Record<string, number>> => ipcRenderer.invoke('suppliers:purchases:summary')
  },
  bankLedgers: {
    // bank id → the exact ledger name it posts to.
    names: (): Promise<Record<string, string>> => ipcRenderer.invoke('banks:ledgers:summary')
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
  // Web push: the key a browser subscribes with, the subscription it hands
  // back, and the two ways of firing one.
  push: {
    key: (): Promise<{ key: string }> => ipcRenderer.invoke('push:key'),
    status: (): Promise<Row> => ipcRenderer.invoke('push:status'),
    subscribe: (subscription: Row, userId: number, ua?: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('push:subscribe', { subscription, userId, ua }),
    unsubscribe: (endpoint: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('push:unsubscribe', { endpoint }),
    test: (userId: number): Promise<{ sent: number; gone: number; failed: number; devices: number }> =>
      ipcRenderer.invoke('push:test', { userId }),
    broadcast: (
      title: string,
      body: string,
      userId: number
    ): Promise<{ sent: number; gone: number; failed: number; devices: number }> =>
      ipcRenderer.invoke('push:broadcast', { title, body, userId })
  },
  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('settings:get', { key }),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('settings:set', { key, value }),
    all: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:all')
  },
  notify: {
    rules: (): Promise<Row[]> => ipcRenderer.invoke('notify:rules'),
    saveRule: (v: Row): Promise<{ key: string }> => ipcRenderer.invoke('notify:saveRule', v),
    resetRule: (key: string): Promise<{ key: string }> => ipcRenderer.invoke('notify:resetRule', { key }),
    preview: (key: string): Promise<Row[]> => ipcRenderer.invoke('notify:preview', { key }),
    people: (): Promise<Row[]> => ipcRenderer.invoke('notify:people'),
    mutes: (userId: number): Promise<string[]> => ipcRenderer.invoke('notify:mutes', { userId }),
    mute: (userId: number, key: string, muted: boolean): Promise<{ key: string }> =>
      ipcRenderer.invoke('notify:mute', { userId, key, muted }),
    run: (): Promise<{ raised: number; resolved: number; held: number; failed: string[] }> =>
      ipcRenderer.invoke('notify:run'),
    list: (userId: number, isAdmin: boolean, limit?: number): Promise<Row[]> =>
      ipcRenderer.invoke('notify:list', { userId, isAdmin, limit }),
    markRead: (userId: number, ids: number[]): Promise<{ read: number }> =>
      ipcRenderer.invoke('notify:markRead', { userId, ids }),
    markUnread: (userId: number, id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('notify:markUnread', { userId, id }),
    clear: (userId: number, isAdmin: boolean): Promise<{ read: number }> =>
      ipcRenderer.invoke('notify:clear', { userId, isAdmin })
  },
  history: {
    list: (entity: string, id: number): Promise<Row[]> => ipcRenderer.invoke('history:list', { entity, id })
  },
  bargains: {
    list: (from?: string, to?: string, companyIds?: number[], forModule?: string): Promise<Row[]> =>
      ipcRenderer.invoke('bargains:list', { from, to, companyIds, forModule }),
    create: (values: Row): Promise<{ id: number; bargain_no: string }> =>
      ipcRenderer.invoke('bargains:create', { values }),
    update: (
      id: number,
      values: Row
    ): Promise<{ id: number; bargain_no: string; rate_changed_from: number | null; rate: number }> =>
      ipcRenderer.invoke('bargains:update', { id, values }),
    linkedInvoices: (id: number): Promise<Row[]> => ipcRenderer.invoke('bargains:linkedInvoices', { id }),
    linkedVouchers: (id: number): Promise<Row[]> => ipcRenderer.invoke('bargains:linkedVouchers', { id }),
    voucherChoices: (id: number, vchType?: string): Promise<Row> =>
      ipcRenderer.invoke('bargains:voucherChoices', { id, vchType }),
    linkVoucher: (id: number, entryId: number, note?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('bargains:linkVoucher', { id, entryId, note }),
    unlinkVoucher: (id: number, linkId: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('bargains:unlinkVoucher', { id, linkId }),
    adjustments: (id: number): Promise<Row[]> => ipcRenderer.invoke('bargains:adjustments', { id }),
    moveBalance: (id: number, values: Row): Promise<{ id: number; bargain_no: string; moved: number }> =>
      ipcRenderer.invoke('bargains:moveBalance', { id, values }),
    rerateInvoices: (
      bargainId: number,
      rate: number,
      orderIds: number[]
    ): Promise<{ updated: Row[]; failed: Row[] }> =>
      ipcRenderer.invoke('bargains:rerateInvoices', { bargainId, rate, orderIds }),
    setInvoiceRate: (
      orderId: number,
      bargainId: number,
      rate: number
    ): Promise<{ order_id: number; bargain_id: number; rate: number }> =>
      ipcRenderer.invoke('bargains:setInvoiceRate', { orderId, bargainId, rate }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bargains:delete', { id }),
    adjust: (id: number, delta: number, note?: string, date?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('bargains:adjust', { id, delta, note, date })
  },
  orders: {
    bargainNotes: (id: number): Promise<Row[]> => ipcRenderer.invoke('orders:bargainNotes', { id }),
    list: (forModule?: string): Promise<Row[]> => ipcRenderer.invoke('orders:list', { forModule }),
    intercompanySource: (id: number): Promise<Row | null> =>
      ipcRenderer.invoke('orders:intercompanySource', { id }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('orders:create', { values }),
    randomInvoiceNo: (companyId?: number): Promise<string> =>
      ipcRenderer.invoke('orders:randomInvoiceNo', { companyId }),
    // A whole invoice at once: one line per product, one number for the bill.
    createInvoice: (values: Row): Promise<{ group: string; ids: number[] }> =>
      ipcRenderer.invoke('orders:createInvoice', { values }),
    updateInvoice: (group: string, values: Row): Promise<{ group: string; ids: number[] }> =>
      ipcRenderer.invoke('orders:updateInvoice', { group, values }),
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
  // The physical site a company's stock and production belong to. Purchases,
  // sales and the ledgers stay with the company itself.
  factory: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('factory:list'),
    save: (v: Row): Promise<{ id: number }> => ipcRenderer.invoke('factory:save', v),
    active: (): Promise<Row | null> => ipcRenderer.invoke('factory:active'),
    companies: (factoryId?: number): Promise<number[]> =>
      ipcRenderer.invoke('factory:companies', factoryId)
  },
  consignment: {
    list: (forModule?: string): Promise<Row[]> => ipcRenderer.invoke('consignment:list', { forModule }),
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
      ipcRenderer.invoke('consignment:openingLog', { supplierId, productId }),
    // The parcels the opening is made of — lot, terminal and quantity, and
    // whether a purchase has already drawn on one.
    openingLots: (supplierId: number, productId: number): Promise<Row[]> =>
      ipcRenderer.invoke('consignment:openingLots', { supplierId, productId }),
    assignGroup: (
      ids: number[],
      v: { lot_no?: string; terminal_no?: string }
    ): Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }> =>
      ipcRenderer.invoke('consignment:assignGroup', { ids, ...v }),
    unlinkDraw: (orderId: number): Promise<{ id: number; freed: number }> =>
      ipcRenderer.invoke('consignment:unlinkDraw', { orderId }),
    unlinkDrawsFor: (
      supplierId: number,
      productId: number
    ): Promise<{ invoices: number; freed: number }> =>
      ipcRenderer.invoke('consignment:unlinkDrawsFor', { supplierId, productId }),
    renameLot: (values: {
      supplier_id: number
      product_id: number
      from_lot?: string | null
      from_terminal?: string | null
      to_lot?: string | null
      to_terminal?: string | null
    }): Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }> =>
      ipcRenderer.invoke('consignment:renameLot', { values }),
    kin: (id: number): Promise<Row> => ipcRenderer.invoke('consignment:kin', { id })
  },
  orderQuality: {
    list: (id: number): Promise<Row[]> => ipcRenderer.invoke('orders:quality', { id }),
    save: (id: number, rows: Row[]): Promise<{ id: number }> => ipcRenderer.invoke('orders:saveQuality', { id, rows }),
    waive: (id: number, waived: boolean, note?: string): Promise<{ id: number; waived: boolean }> =>
      ipcRenderer.invoke('orders:waiveQuality', { id, waived, note })
  },
  tankers: {
    list: (all?: boolean, forModule?: string): Promise<Row[]> =>
      ipcRenderer.invoke('tankers:list', { all, forModule }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('tankers:delete', { id }),
    advance: (id: number, toStatus: string, data: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:advance', { id, toStatus, data }),
    revert: (id: number): Promise<{ id: number; status: string }> => ipcRenderer.invoke('tankers:revert', { id }),
    replace: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('tankers:replace', { id, values }),
    quality: (id: number): Promise<Row[]> => ipcRenderer.invoke('tankers:quality', { id }),
    qualityMany: (ids: number[]): Promise<Row[]> => ipcRenderer.invoke('tankers:qualityMany', { ids }),
    // Every FFA the lab has recorded, newest first. 0 for the product means
    // "whatever came in", any other id narrows it to that oil.
    ffaHistory: (productId?: number, limit?: number): Promise<Row[]> =>
      ipcRenderer.invoke('tankers:ffaHistory', { productId, limit }),
    saveQuality: (id: number, rows: Row[]): Promise<{ id: number }> =>
      ipcRenderer.invoke('tankers:saveQuality', { id, rows })
  },
  dashboard: {
    // `all`: every company's figures together (the dashboard's All companies).
    stats: (all?: boolean): Promise<Row> => ipcRenderer.invoke('dashboard:stats', { all }),
    position: (all?: boolean): Promise<Row> => ipcRenderer.invoke('dashboard:position', { all }),
    layout: (): Promise<Row> => ipcRenderer.invoke('dashboard:layout'),
    saveLayout: (hidden: string[]): Promise<Row> => ipcRenderer.invoke('dashboard:saveLayout', { hidden })
  },
  productMerge: {
    preview: (fromId: number, toId: number): Promise<Row> => ipcRenderer.invoke('productMerge:preview', { fromId, toId }),
    apply: (fromId: number, toId: number): Promise<Row> => ipcRenderer.invoke('productMerge:apply', { fromId, toId }),
    list: (): Promise<Row[]> => ipcRenderer.invoke('productMerge:list')
  },
  productionPlan: {
    get: (date: string): Promise<Row> => ipcRenderer.invoke('productionPlan:get', { date }),
    save: (date: string, rows: Row[]): Promise<{ count: number }> =>
      ipcRenderer.invoke('productionPlan:save', { date, rows })
  },
  vouchers: {
    list: (args?: { from?: string; to?: string; vchType?: string | string[]; companyId?: number }): Promise<Row[]> =>
      ipcRenderer.invoke('vouchers:list', args),
    cashflow: (args?: { from?: string; to?: string; companyId?: number }): Promise<Row> => ipcRenderer.invoke('vouchers:cashflow', args),
    summary: (args?: { from?: string; to?: string; companyId?: number }): Promise<Row> => ipcRenderer.invoke('vouchers:summary', args),
    get: (id: number): Promise<Row | null> => ipcRenderer.invoke('vouchers:get', { id }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('vouchers:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('vouchers:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('vouchers:delete', { id }),
    // A voucher a document wrote: how it is altered, and the alter for the
    // ones changed through a form (see src/main/voucherAlter.ts).
    alterInfo: (id: number): Promise<Row> => ipcRenderer.invoke('vouchers:alterInfo', { id }),
    alterOwned: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('vouchers:alterOwned', { id, values }),
    // The number the next voucher of a type will take — a forecast for the screen.
    nextCode: (vchType: string, companyId?: number): Promise<string> =>
      ipcRenderer.invoke('vouchers:nextCode', { vchType, companyId }),
    // Every voucher one purchase / sale / LC / discounted bill wrote, with its
    // ledgers — read from the link the posting itself recorded.
    forDocument: (entity: 'order' | 'sale' | 'lc' | 'bd' | 'trading', id: number): Promise<Row> =>
      ipcRenderer.invoke('vouchers:forDocument', { entity, id })
  },
  // The mill's own labels, on anything with a page of its own.
  tags: {
    list: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('tags:list', { companyId }),
    create: (name: string, colour?: string, companyId?: number): Promise<Row> =>
      ipcRenderer.invoke('tags:create', { name, colour, companyId }),
    rename: (id: number, name: string, colour?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('tags:rename', { id, name, colour }),
    remove: (id: number): Promise<{ id: number; removed: number }> => ipcRenderer.invoke('tags:delete', { id }),
    // Every tag on a page of rows at once — a register asking one row at a
    // time is a hundred round trips to paint one screen.
    forRefs: (entity: string, refs: unknown[], companyId?: number): Promise<Record<string, Row[]>> =>
      ipcRenderer.invoke('tags:for', { entity, refs, companyId }),
    set: (entity: string, ref: unknown, tagIds: number[]): Promise<{ tags: number }> =>
      ipcRenderer.invoke('tags:set', { entity, ref, tagIds }),
    contents: (id: number): Promise<Row[]> => ipcRenderer.invoke('tags:contents', { id })
  },
  journal: {
    trialBalance: (args?: { from?: string; to?: string; companyId?: number }): Promise<Row> =>
      ipcRenderer.invoke('journal:trialBalance', args),
    groups: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:groups', { companyId }),
    // Every group in the books, each carrying where it sits — parent, depth
    // and the full path — so a caller that only wanted a name and a nature
    // still gets exactly that, and the Masters tree gets the rest.
    groupNames: (): Promise<Row[]> => ipcRenderer.invoke('journal:groupNames'),
    groupTree: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:groupTree', { companyId }),
    // Renaming a ledger the app posts to: the account takes the new name and a
    // redirect is written, so the next posting follows it rather than opening
    // a second account under the old one.
    ledgerMap: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:ledgerMap', { companyId }),
    renameLedger: (id: number, name: string, companyId?: number): Promise<{ id: number; from: string; to: string }> =>
      ipcRenderer.invoke('journal:renameLedger', { id, name, companyId }),
    mapLedger: (postsAs: string, useName: string, note?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:mapLedger', { postsAs, useName, note }),
    unmapLedger: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('journal:unmapLedger', { id }),
    createGroup: (a: { name: string; under?: string | number | null; nature?: string }): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:createGroup', a),
    renameGroup: (id: number, name: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:renameGroup', { id, name }),
    moveGroup: (id: number, parentId: number | null, nature?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:moveGroup', { id, parentId, nature }),
    deleteGroup: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('journal:deleteGroup', { id }),
    setAccountGroup: (id: number, group: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:setAccountGroup', { id, group }),
    setAccountsGroup: (ids: number[], group: string): Promise<{ moved: number; group: string }> =>
      ipcRenderer.invoke('journal:setAccountsGroup', { ids, group }),
    setAccountsHidden: (ids: number[], hidden: boolean): Promise<{ changed: number; hidden: boolean }> =>
      ipcRenderer.invoke('journal:setAccountsHidden', { ids, hidden }),
    billsOutstanding: (
      account: string,
      companyId?: number,
      opts: { asOf?: string; side?: 'customer' | 'supplier' } = {}
    ): Promise<Row> => ipcRenderer.invoke('journal:billsOutstanding', { account, companyId, ...opts }),
    // `all` adds the party's settled bills (each marked `settled`), for linking.
    pendingRefs: (account: string, companyId?: number, side?: 'customer' | 'supplier', all?: boolean): Promise<Row[]> =>
      ipcRenderer.invoke('journal:pendingRefs', { account, companyId, side, all }),
    tradingAccount: (from?: string, to?: string, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('journal:tradingAccount', { from, to, companyId }),
    booksFrom: (companyId?: number): Promise<string | null> =>
      ipcRenderer.invoke('journal:booksFrom', { companyId }),
    setBooksFrom: (date: string | null, companyId?: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke('journal:setBooksFrom', { date, companyId }),
    openings: (companyId?: number): Promise<Row> => ipcRenderer.invoke('journal:openings', { companyId }),
    moveOpenings: (accountIds: number[], fromCompanyId: number, toCompanyId: number): Promise<{ moved: number; rows: Row[] }> =>
      ipcRenderer.invoke('journal:moveOpenings', { accountIds, fromCompanyId, toCompanyId }),
    saveOpenings: (rows: Row[], companyId?: number): Promise<{ saved: number }> =>
      ipcRenderer.invoke('journal:saveOpenings', { rows, companyId }),
    opening: (accountId: number, companyId?: number): Promise<Row> =>
      ipcRenderer.invoke('journal:opening', { accountId, companyId }),
    accounts: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('journal:accounts', { companyId }),
    createAccount: (name: string, group?: string, companyId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('journal:createAccount', { name, group, companyId }),
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
    entityHistory: (
      entity: string | string[],
      selector: { id?: number | null; key?: string | null; detail?: string | null; limit?: number }
    ): Promise<Row[]> => ipcRenderer.invoke('access:entityHistory', { entity, ...selector }),
    heartbeat: (
      userId: number,
      username: string
    ): Promise<{ blocked: boolean; revoked?: boolean; role?: string; full_name?: string; permissions?: unknown }> =>
      ipcRenderer.invoke('access:heartbeat', { userId, username }),
    entryWindows: (): Promise<Record<string, string>> => ipcRenderer.invoke('access:entryWindows'),
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
    list: (opts?: { includeHidden?: boolean }): Promise<Row[]> => ipcRenderer.invoke('formulations:list', opts),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('formulations:items', { id }),
    // The recipe's edit history — when each version was saved, by whom, and
    // how many batches were run on it.
    versions: (id: number): Promise<Row[]> => ipcRenderer.invoke('formulations:versions', { id }),
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
    fifoMap: (args: { productId: number; companyIds?: number[]; asOf?: string; qty: number; all?: boolean }): Promise<Row> => ipcRenderer.invoke('stock:fifo:breakdown', args),
    breakdown: (companyIds?: number[], range?: { from?: string; to?: string }): Promise<Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[]; produced: Row[]; consumed: Row[]; recirculated: Row[] }>> =>
      ipcRenderer.invoke('stock:breakdown', { companyIds, range }),
    registers: (companyIds?: number[], range?: { from?: string; to?: string }): Promise<{ receipts: Row[]; dispatches: Row[] }> =>
      ipcRenderer.invoke('stock:registers', { companyIds, range }),
    daybook: (from: string, to: string): Promise<{ vouchers: Row[]; material: Row[] }> => ipcRenderer.invoke('daybook:list', { from, to }),
    transfers: (): Promise<Row[]> => ipcRenderer.invoke('stock:transfers'),
    // Hand adjustments to a product's book stock.
    adjustments: (productId: number, companyIds?: number[]): Promise<Row[]> =>
      ipcRenderer.invoke('stockAdj:list', { productId, companyIds }),
    adjust: (values: { product_id: number; qty: number; date?: string; note: string; company_id?: number }): Promise<{ id: number }> =>
      ipcRenderer.invoke('stockAdj:create', { values }),
    deleteAdjustment: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('stockAdj:delete', { id }),
    transfer: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('stock:transfer', { values }),
    deleteTransfer: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('stock:deleteTransfer', { id })
  },
  stockCount: {
    previous: (date: string): Promise<{ source_date: string | null; items: Row[] }> =>
      ipcRenderer.invoke('stockCount:previous', { date }),
    sheet: (date: string): Promise<Row[]> => ipcRenderer.invoke('stockCount:sheet', { date }),
    list: (date: string): Promise<Row[]> => ipcRenderer.invoke('stockCount:list', { date }),
    save: (date: string, items: Row[]): Promise<{ count: number }> =>
      ipcRenderer.invoke('stockCount:save', { date, items }),
    history: (from: string, to: string): Promise<Row[]> =>
      ipcRenderer.invoke('stockCount:history', { from, to })
  },
  formulationSubcategory: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('formulationSubcategory:list'),
    save: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('formulationSubcategory:save', { values }),
    delete: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('formulationSubcategory:delete', { id })
  },
  outsideTanker: {
    list: (date?: string): Promise<Row[]> => ipcRenderer.invoke('outsideTanker:list', { date }),
    save: (v: Row): Promise<{ id: number }> => ipcRenderer.invoke('outsideTanker:save', v),
    nil: (date: string, slot: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('outsideTanker:nil', { date, slot }),
    remove: (id: number): Promise<{ ok: true }> => ipcRenderer.invoke('outsideTanker:remove', { id })
  },
  // The day's work board: everyone's own checklist, and the admin's review of
  // it. Every write carries the user making it — the server decides what that
  // user is allowed to do with it.
  work: {
    board: (date?: string, userId?: number): Promise<Row> =>
      ipcRenderer.invoke('work:board', { date, userId }),
    cutoff: (): Promise<string> => ipcRenderer.invoke('work:cutoff'),
    setDayOpen: (
      userIds: number[],
      date: string,
      open: boolean,
      userId: number,
      note?: string
    ): Promise<{ opened: number; closed: number; work_date: string }> =>
      ipcRenderer.invoke('work:setDayOpen', { userIds, date, open, userId, note }),
    requestDay: (date: string, userId: number, reason?: string): Promise<{ id: number; work_date: string; state: string }> =>
      ipcRenderer.invoke('work:requestDay', { date, userId, reason }),
    decideDay: (id: number, approve: boolean, userId: number, note?: string): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:decideDay', { id, approve, userId, note }),
    setCutoff: (cutoff: string, userId?: number, day?: string): Promise<{ cutoff: string; cutoff_day: string }> =>
      ipcRenderer.invoke('work:setCutoff', { cutoff, userId, day }),
    setUserCutoff: (
      targetId: number,
      cutoff: string,
      day?: string,
      userId?: number
    ): Promise<{ id: number; cutoff: string; cutoff_day: string; own: boolean }> =>
      ipcRenderer.invoke('work:setUserCutoff', { targetId, cutoff, day, userId }),
    processes: (): Promise<Row[]> => ipcRenderer.invoke('work:processes'),
    saveProcess: (values: Row, userId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('work:saveProcess', { values, userId }),
    removeProcess: (id: number, userId?: number): Promise<{ id: number; retired: boolean }> =>
      ipcRenderer.invoke('work:removeProcess', { id, userId }),
    reorderProcesses: (ids: number[], userId?: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke('work:reorderProcesses', { ids, userId }),
    tick: (taskId: number, userId: number): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:tick', { taskId, userId }),
    untick: (taskId: number, userId: number): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:untick', { taskId, userId }),
    redo: (taskId: number, userId: number): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:redo', { taskId, userId }),
    approve: (taskId: number, userId: number, note?: string): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:approve', { taskId, userId, note }),
    sendBack: (taskId: number, userId: number, note: string): Promise<{ id: number; state: string }> =>
      ipcRenderer.invoke('work:sendBack', { taskId, userId, note }),
    note: (taskId: number, userId: number, text: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('work:note', { taskId, userId, text }),
    assign: (values: Row, userId: number): Promise<{ id: number; ids: number[] }> =>
      ipcRenderer.invoke('work:assign', { values, userId }),
    removeTask: (taskId: number, userId: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('work:removeTask', { taskId, userId })
  },
  stockOpening: {
    list: (companyId?: number): Promise<Row> => ipcRenderer.invoke('stockOpening:list', { companyId }),
    save: (
      rows: Row[],
      asOf: string,
      companyId?: number,
      version?: string
    ): Promise<{ saved: number; cleared: number }> =>
      ipcRenderer.invoke('stockOpening:save', { rows, asOf, companyId, version }),
    // Re-dating an opening: the outgoing morning's vessel breakdown goes to
    // history and the live one is emptied, so the new morning can be set
    // against a blank panel. Put back undoes it.
    handOverPp: (date: string, companyId?: number): Promise<{ from: string; moved: number; rows: Row[] }> =>
      ipcRenderer.invoke('stockOpening:handOverPp', { date, companyId }),
    putBackPp: (rows: Row[], companyId?: number): Promise<{ restored: number }> =>
      ipcRenderer.invoke('stockOpening:putBackPp', { rows, companyId }),
    date: (companyId?: number): Promise<string> =>
      ipcRenderer.invoke('stockOpening:date', { companyId }),
    sets: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('stockOpening:sets', { companyId }),
    setLines: (setId: number): Promise<Row[]> => ipcRenderer.invoke('stockOpening:setLines', { setId }),
    // The site's list of in-process stages, and one product's breakdown.
    ppStages: (companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('stockOpening:ppStages', { companyId }),
    addPpStage: (name: string, companyId?: number): Promise<Row> =>
      ipcRenderer.invoke('stockOpening:addPpStage', { name, companyId }),
    removePpStage: (
      stageId: number,
      companyId?: number
    ): Promise<{ removed: number; kept: number; retired: boolean; name: string }> =>
      ipcRenderer.invoke('stockOpening:removePpStage', { stageId, companyId }),
    savePp: (
      productId: number,
      lines: Row[],
      companyId?: number,
      version?: string
    ): Promise<{ total: number; lines: number }> =>
      ipcRenderer.invoke('stockOpening:savePp', { productId, lines, companyId, version }),
    // Both PP buckets for a set of products — what the Production entry
    // sheet's preview draws against before a batch is saved.
    ppVessels: (productId: number, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('stockOpening:ppVessels', { productId, companyId }),
    ppWriteoffs: (productId: number, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('stockOpening:ppWriteoffs', { productId, companyId }),
    writeOffPp: (
      productId: number,
      stageId: number,
      qty: number,
      note: string,
      companyId?: number
    ): Promise<{ product_id: number; stage_id: number; qty: number }> =>
      ipcRenderer.invoke('stockOpening:writeOffPp', { productId, stageId, qty, note, companyId }),
    ppReceivers: (productId: number, companyId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('stockOpening:ppReceivers', { productId, companyId }),
    movePp: (
      productId: number,
      stageId: number,
      qty: number,
      toProductId: number,
      toStageId: number,
      note: string,
      companyId?: number
    ): Promise<{ product_id: number; to_product_id: number; qty: number }> =>
      ipcRenderer.invoke('stockOpening:movePp', {
        productId,
        stageId,
        qty,
        toProductId,
        toStageId,
        note,
        companyId
      }),
    ppFreeTotals: (
      productIds: number[],
      companyId?: number,
      asOf?: string
    ): Promise<Record<number, { without: number; with: number }>> =>
      ipcRenderer.invoke('stockOpening:ppFreeTotals', { productIds, companyId, asOf })
  },
  // The packed shelf's opening count — what was in packs the morning the
  // books began. Mirrors stockOpening, which does the same for the tanks.
  skuOpening: {
    list: (asOf?: string): Promise<Row> => ipcRenderer.invoke('skuOpening:list', { asOf }),
    date: (): Promise<string> => ipcRenderer.invoke('skuOpening:date'),
    save: (rows: Row[], asOf: string): Promise<{ saved: number; cleared: number }> =>
      ipcRenderer.invoke('skuOpening:save', { rows, asOf })
  },
  skuStock: {
    breakdown: (date?: string | { from?: string; to?: string }): Promise<Row[]> => ipcRenderer.invoke('skuStock:breakdown', { date }),
    // A single date is the day sheet; { from, to } is a period.
    list: (date?: string | { from?: string; to?: string }): Promise<Row[]> => ipcRenderer.invoke('skuStock:list', { date }),
    // The hand entries behind one SKU, and removing one of them.
    adjustments: (id: number): Promise<Row[]> => ipcRenderer.invoke('skuStock:adjustments', { id }),
    deleteAdjustment: (id: number): Promise<{ id: number; packaging_id: number }> =>
      ipcRenderer.invoke('skuStock:deleteAdjustment', { id }),
    adjust: (
      id: number,
      delta: number,
      note?: string,
      date?: string,
      kind?: string
    ): Promise<{ id: number; on_hand: number }> =>
      ipcRenderer.invoke('skuStock:adjust', { id, delta, note, date, kind })
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
    orphanBills: (companyId?: number): Promise<Row[]> => ipcRenderer.invoke('tbill:orphans', { companyId }),
    raiseShortageNote: (lineId: number, date?: string, companyId?: number): Promise<{ note_id: number; note_no: string }> =>
      ipcRenderer.invoke('tfreight:raiseNote', { lineId, date, companyId }),
    unraiseShortageNote: (lineId: number, companyId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('tfreight:unraiseNote', { lineId, companyId }),
    waiveShortage: (lineId: number, reason: string, companyId?: number): Promise<{ id: number; entry_id: number | null }> =>
      ipcRenderer.invoke('tfreight:waive', { lineId, reason, companyId }),
    unwaiveShortage: (lineId: number, companyId?: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('tfreight:unwaive', { lineId, companyId })
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
    list: (forModule?: string): Promise<Row[]> => ipcRenderer.invoke('production:list', { forModule }),
    items: (id: number): Promise<Row[]> => ipcRenderer.invoke('production:items', { id }),
    // The run's short formulation: its pinned recipe's parts and what it drew.
    mix: (id: number): Promise<Row> => ipcRenderer.invoke('production:mix', { id }),
    // The whole Complete Production Report in one call — columns, the
    // opening/receiving band, and every batch of the period with its lines
    // and its recipe ratio.
    report: (
      range?: { from?: string; to?: string },
      companyIds?: number[]
    ): Promise<{ from: string; to: string; products: Row[]; batches: Row[] }> =>
      ipcRenderer.invoke('production:report', { range, companyIds }),
    create: (values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('production:delete', { id }),
    // What one run took off PP, vessel by vessel — the entry sheet's preview
    // gives this back to the pool it is simulating against before showing
    // that run's own edited amount, the same way the run's Raw consumption
    // is already given back for the projection.
    ppDraws: (productionId: number): Promise<{ product_id: number; ffa: string; qty: number }[]> =>
      ipcRenderer.invoke('production:ppDraws', { productionId })
  },
  sales: {
    list: (companyIds?: number[], forModule?: string): Promise<Row[]> =>
      ipcRenderer.invoke('sales:list', { companyIds, forModule }),
    randomInvoiceNo: (companyId?: number): Promise<string> =>
      ipcRenderer.invoke('sales:randomInvoiceNo', { companyId }),
    invoiceGaps: (companyId?: number, from?: string, to?: string): Promise<Row> =>
      ipcRenderer.invoke('sales:invoiceGaps', { companyId, from, to }),
    cancelInvoiceNo: (values: Row): Promise<{ prefix: string; number: number }> =>
      ipcRenderer.invoke('sales:cancelInvoiceNo', { values }),
    uncancelInvoiceNo: (values: Row): Promise<{ prefix: string; number: number }> =>
      ipcRenderer.invoke('sales:uncancelInvoiceNo', { values }),
    series: (companyId?: number): Promise<Row> => ipcRenderer.invoke('sales:series', { companyId }),
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
    // Re-date an invoice (every line, its voucher in place) — the Tally check's fix.
    fixDate: (id: number, date: string): Promise<{ id: number; from: string; to: string }> =>
      ipcRenderer.invoke('sales:fixDate', { id, date }),
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
    partyCounts: (): Promise<Row[]> => ipcRenderer.invoke('skuRates:partyCounts'),
    parties: (packagingId: number): Promise<number[]> => ipcRenderer.invoke('skuRates:parties', { packagingId }),
    setParties: (packagingId: number, customerIds: number[]): Promise<{ count: number }> =>
      ipcRenderer.invoke('skuRates:setParties', { packagingId, customerIds }),
    list: (id: number): Promise<Row[]> => ipcRenderer.invoke('skuRates:list', { id }),
    save: (id: number, rows: Row[]): Promise<{ saved: number; cleared: number }> =>
      ipcRenderer.invoke('skuRates:save', { id, rows })
  },
  salesBargains: {
    list: (from?: string, to?: string, companyIds?: number[], forModule?: string): Promise<Row[]> =>
      ipcRenderer.invoke('salesBargains:list', { from, to, companyIds, forModule }),
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
    linkedInvoices: (id: number): Promise<Row[]> =>
      ipcRenderer.invoke('salesBargains:linkedInvoices', { id }),
    linkedVouchers: (id: number): Promise<Row[]> => ipcRenderer.invoke('salesBargains:linkedVouchers', { id }),
    voucherChoices: (id: number, vchType?: string): Promise<Row> =>
      ipcRenderer.invoke('salesBargains:voucherChoices', { id, vchType }),
    linkVoucher: (id: number, entryId: number, note?: string): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:linkVoucher', { id, entryId, note }),
    unlinkVoucher: (id: number, linkId: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('salesBargains:unlinkVoucher', { id, linkId }),
    rerateInvoices: (
      id: number,
      rate: number,
      saleIds: number[]
    ): Promise<{ updated: Row[]; failed: Row[] }> =>
      ipcRenderer.invoke('salesBargains:rerateInvoices', { id, rate, saleIds }),
    adjust: (id: number, delta: number, note?: string, date?: string): Promise<{ id: number; qty: number }> =>
      ipcRenderer.invoke('salesBargains:adjust', { id, delta, note, date }),
    moveBalance: (id: number, values: Row): Promise<{ id: number; bargain_no: string; moved: number }> =>
      ipcRenderer.invoke('salesBargains:moveBalance', { id, values })
  },
  gate: {
    list: (): Promise<Row[]> => ipcRenderer.invoke('gate:list'),
    nextNo: (direction?: 'in' | 'out'): Promise<string> => ipcRenderer.invoke('gate:nextNo', { direction }),
    dispatchableSales: (): Promise<Row[]> => ipcRenderer.invoke('gate:dispatchableSales'),
    waivedOuts: (): Promise<Row[]> => ipcRenderer.invoke('gate:waivedOuts'),
    waiveOut: (group: string, reason: string): Promise<{ group: string }> =>
      ipcRenderer.invoke('gate:waiveOut', { group, reason }),
    unwaiveOut: (group: string): Promise<{ group: string }> =>
      ipcRenderer.invoke('gate:unwaiveOut', { group }),
    waiveOuts: (groups: string[], reason: string): Promise<{ done: string[]; failed: { group: string; error: string }[] }> =>
      ipcRenderer.invoke('gate:waiveOuts', { groups, reason }),
    partyCategories: (): Promise<Row[]> => ipcRenderer.invoke('gate:partyCategories'),
    // Every gate entry behind one purchase or one sales invoice.
    forRecord: (q: { orderId?: number; saleIds?: number[]; invoiceGroup?: string }): Promise<{ rows: Row[]; hidden: number; window_from: string }> =>
      ipcRenderer.invoke('gate:forRecord', q),
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
      invoiceGroup?: string | string[] | null,
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
    alerts: (all?: boolean): Promise<Row> => ipcRenderer.invoke('treasury:alerts', { all }),
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
    // The bank rejected the application — and undoing that.
    reject: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('lc:reject', { id, values }),
    reinstate: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('lc:reinstate', { id }),
    issue: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('lc:issue', { values }),
    removeIssuance: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:deleteIssuance', { id }),
    editPreclosure: (id: number, values: Row): Promise<{ id: number }> =>
      ipcRenderer.invoke('lc:editPreclosure', { id, values }),
    payParty: (id: number, values: Row): Promise<{ id: number; installment_no: number }> =>
      ipcRenderer.invoke('lc:payParty', { id, values }),
    removeInstallment: (id: number): Promise<{ installment_no: number }> =>
      ipcRenderer.invoke('lc:deleteInstallment', { id }),
    // An LC paid in parts: each part, and repaying the bank part by part.
    parts: (id: number): Promise<Row[]> => ipcRenderer.invoke('lc:parts', { id }),
    repayParts: (id: number, values: Row): Promise<{ repayment_id: number; closed: boolean; rebate: number }> =>
      ipcRenderer.invoke('lc:repayParts', { id, values }),
    undoPartRepayment: (id: number): Promise<{ parts: number[] }> => ipcRenderer.invoke('lc:undoPartRepayment', { id }),
    allRepayments: (): Promise<Row[]> => ipcRenderer.invoke('lc:allRepayments'),
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
        charges?: { account?: string; amount?: number | string }[]
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
        // What the bank took on top of the principal, in the same debit.
        comm_charges?: number | string | null
        bank_charges?: number | string | null
        // Interest paid in the same debit — gross.
        interest?: number | string | null
        // Other charges in the same debit, each on a ledger the user picked.
        charges?: { account: string; amount: number }[]
        note?: string | null
        party_id?: number | null
        // The bank the money left from; the bill's own bank when left out.
        bank_account?: string | null
        // Other bills this same bank debit also settled.
        also?: { bd_id?: number | string; amount?: number | string }[]
      }
    ): Promise<{ id: number; amount: number; outstanding: number; closed: boolean }> =>
      ipcRenderer.invoke('bd:repay', { id, values }),
    repayments: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:repayments', { id }),
    interestSchedule: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:interestSchedule', { id }),
    // The stretch of days that is payable right now, and what it comes to.
    interestWindow: (id: number, toDate?: string): Promise<Row> =>
      ipcRenderer.invoke('bd:interestWindow', { id, toDate }),
    payInterestUpto: (
      id: number,
      v: { to_date: string; note?: string | null; post?: boolean; bank_account?: string | null }
    ): Promise<{ id: number; gross: number; tds: number; net: number; days: number; posted: boolean }> =>
      ipcRenderer.invoke('bd:payInterestUpto', { id, ...v }),
    interestPayments: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:interestPayments', { id }),
    payInterest: (
      id: number,
      values: {
        to_date: string
        paid_date?: string
        amount?: number | string | null
        note?: string | null
        post?: boolean
        bank_account?: string | null
      }
    ): Promise<{ id: number; gross: number; net: number; posted: boolean }> =>
      ipcRenderer.invoke('bd:payInterest', { id, values }),
    deleteInterest: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:deleteInterest', { id }),
    postInterest: (id: number): Promise<{ id: number; journal_entry_id: number }> =>
      ipcRenderer.invoke('bd:postInterest', { id }),
    allRepayments: (): Promise<Row[]> => ipcRenderer.invoke('bd:allRepayments'),
    linkedOrders: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:linkedOrders', { id }),
    parties: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:parties', { id }),
    allParties: (): Promise<Row[]> => ipcRenderer.invoke('bd:allParties'),
    openTradingInvoices: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:openTradingInvoices', { id }),
    paymentIns: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:paymentIns', { id }),
    paymentIn: (
      id: number,
      amount: number,
      date?: string,
      keys?: string[],
      method?: string,
      account?: string,
      ref?: string
    ): Promise<{ id: number; date: string }> =>
      ipcRenderer.invoke('bd:paymentIn', { id, amount, date, keys, method, account, ref }),
    deletePaymentIn: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:deletePaymentIn', { id }),
    deleteRepayment: (id: number): Promise<{ id: number; bd_id: number }> =>
      ipcRenderer.invoke('bd:deleteRepayment', { id }),
    editRepayment: (id: number, values: Row): Promise<{ id: number; bd_id: number; entry_id: number }> =>
      ipcRenderer.invoke('bd:editRepayment', { id, values }),
    markReceived: (
      id: number,
      date?: string,
      route?: string,
      account?: string | null,
      firstPart?: number | null,
      firstReceipt?: number | null,
      legs?: Row[] | null
    ): Promise<{ id: number; date: string }> =>
      ipcRenderer.invoke('bd:markReceived', {
        id,
        date,
        route,
        account,
        ...(legs ? { legs } : {}),
        ...(firstPart === undefined ? {} : { firstPart }),
        ...(firstReceipt === undefined ? {} : { firstReceipt })
      }),
    receiptParts: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:receiptParts', { id }),
    receivePart: (id: number, values: Row): Promise<{ id: number; part_no: number; ref: string; interest: number }> =>
      ipcRenderer.invoke('bd:receivePart', { id, values }),
    removeReceiptPart: (id: number): Promise<{ part_no: number; ref: string }> => ipcRenderer.invoke('bd:deleteReceiptPart', { id }),
    partyPayments: (id: number): Promise<Row[]> => ipcRenderer.invoke('bd:partyPayments', { id }),
    payParty: (id: number, values: Row): Promise<{ id: number; part_no: number }> => ipcRenderer.invoke('bd:payParty', { id, values }),
    removePartyPayment: (id: number): Promise<{ part_no: number }> => ipcRenderer.invoke('bd:deletePartyPayment', { id }),
    unmarkReceived: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:unmarkReceived', { id }),
    reopen: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('bd:reopen', { id }),
    upfrontInterest: (id: number, date?: string, account?: string): Promise<{ id: number } | null> =>
      ipcRenderer.invoke('bd:upfrontInterest', { id, date, account }),
    reverseUpfrontInterest: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('bd:reverseUpfrontInterest', { id }),
    setVoucherBank: (id: number, entryId: number, account: string): Promise<{ id: number; account: string }> =>
      ipcRenderer.invoke('bd:setVoucherBank', { id, entryId, account }),
    setRoute: (id: number, route: string, account?: string, shares?: Row[]): Promise<{ id: number; route: string }> =>
      ipcRenderer.invoke('bd:setRoute', { id, route, account, shares }),
    kpis: (): Promise<Row> => ipcRenderer.invoke('bd:kpis'),
    chargeTypes: (): Promise<{ label: string; ledger: string; preset: boolean }[]> => ipcRenderer.invoke('bd:chargeTypes:list'),
    addChargeType: (label: string): Promise<{ label: string; ledger: string; preset: boolean }> => ipcRenderer.invoke('bd:addChargeType', { label }),
    limits: (): Promise<Row> => ipcRenderer.invoke('bd:limits'),
    setCombinedLimit: (value: number | string | null): Promise<{ value: number | null }> =>
      ipcRenderer.invoke('bd:setCombinedLimit', { value }),
    limitReductions: (nbfcId?: number): Promise<Row[]> =>
      ipcRenderer.invoke('bd:limitReductions', { nbfcId }),
    addLimitReduction: (
      values: Row
    ): Promise<{ id: number; sanctioned: number; limit_now: number }> =>
      ipcRenderer.invoke('bd:addLimitReduction', { values }),
    deleteLimitReduction: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('bd:deleteLimitReduction', { id })

  },
  // Books repairs from the accounting audit — administrator only.
  repairs: {
    duplicateSales: (companyId?: number): Promise<Row> =>
      ipcRenderer.invoke('repairs:duplicateSales:list', { companyId }),
    checks: (companyId?: number): Promise<Row> => ipcRenderer.invoke('repairs:checks:list', { companyId }),
    genericBank: (): Promise<Row[]> => ipcRenderer.invoke('repairs:genericBank:list'),
    moveGenericBank: (companyId: number, account: string): Promise<{ lines: number; vouchers: number; account: string }> =>
      ipcRenderer.invoke('repairs:genericBankMove', { companyId, account }),
    removeDuplicateSales: (entryIds: number[], companyId?: number): Promise<{ removed: number; revenue: number }> =>
      ipcRenderer.invoke('repairs:duplicateSalesRemove', { entryIds, companyId }),
    saleTds: (companyId?: number): Promise<Row> => ipcRenderer.invoke('repairs:saleTds:list', { companyId }),
    clearSaleTds: (keys: string[], companyId?: number): Promise<{ invoices: number; vouchers: number; tds: number }> =>
      ipcRenderer.invoke('repairs:saleTdsClear', { keys, companyId }),
    lcCharges: (): Promise<Row> => ipcRenderer.invoke('repairs:lcCharges:list'),
    fixLcCharges: (ids: number[]): Promise<{ fixed: number; charges: number }> => ipcRenderer.invoke('repairs:lcChargesFix', { ids }),
    outwardFreight: (): Promise<Row> => ipcRenderer.invoke('repairs:outwardFreight:list'),
    fixOutwardFreight: (ids: number[]): Promise<{ fixed: number; freight: number }> => ipcRenderer.invoke('repairs:outwardFreightFix', { ids }),
    wrongCompany: (): Promise<Row> => ipcRenderer.invoke('repairs:wrongCompany:list'),
    splitTanker: (): Promise<Row> => ipcRenderer.invoke('repairs:splitTanker:list'),
    staleTds: (): Promise<Row> => ipcRenderer.invoke('repairs:staleTds:list'),
    paymentIns: (): Promise<Row> => ipcRenderer.invoke('repairs:paymentIns:list'),
    lcLedgers: (): Promise<Row> => ipcRenderer.invoke('repairs:lcLedgers:list'),
    saveLcLedgers: (values: Row): Promise<Row> => ipcRenderer.invoke('repairs:lcLedgersSave', { values }),
    fixLcLedgers: (ids: number[]): Promise<{ moved: number; vouchers: number }> => ipcRenderer.invoke('repairs:lcLedgersFix', { ids }),
    fixPaymentIns: (keys: string[]): Promise<{ removed: number }> => ipcRenderer.invoke('repairs:paymentInsFix', { keys }),
    parkingCopies: (): Promise<Row> => ipcRenderer.invoke('repairs:parkingCopies:list'),
    fixParkingCopies: (keys: string[]): Promise<{ removed: number; chains: number }> => ipcRenderer.invoke('repairs:parkingCopiesFix', { keys }),
    fixStaleTds: (ids: number[]): Promise<Row> => ipcRenderer.invoke('repairs:staleTdsFix', { ids }),
    paisa: (): Promise<Row> => ipcRenderer.invoke('repairs:paisa:list'),
    fixPaisa: (ids: number[]): Promise<Row> => ipcRenderer.invoke('repairs:paisaFix', { ids }),
    fixSplitTanker: (ids: number[]): Promise<Row> => ipcRenderer.invoke('repairs:splitTankerFix', { ids }),
    moveWrongCompany: (ids: number[]): Promise<{ moved: number; codes: string[] }> => ipcRenderer.invoke('repairs:wrongCompanyMove', { ids }),
    sharedLedgers: (): Promise<Row> => ipcRenderer.invoke('repairs:sharedLedgers:list'),
    fixSharedLedgers: (keys: string[]): Promise<{ fixed: number; lines: number; ledgers: string[] }> =>
      ipcRenderer.invoke('repairs:sharedLedgersFix', { keys }),
    partyClashes: (name: string, side: 'customer' | 'supplier'): Promise<Row[]> => ipcRenderer.invoke('parties:clashes:list', { name, side })
  },
  trading: {
    list: (forModule?: string): Promise<Row[]> => ipcRenderer.invoke('trading:list', { forModule }),
    create: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('trading:create', { values }),
    update: (id: number, values: Row): Promise<{ id: number }> => ipcRenderer.invoke('trading:update', { id, values }),
    remove: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('trading:delete', { id }),
    // Every trading invoice, both sides, with what is still open and what
    // settled the rest — LC, BD, bank or adjustment. Read-only.
    payments: (): Promise<Row[]> => ipcRenderer.invoke('tradingPayments:list')
  },
  tallyNotes: {
    preview: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:preview', { values }),
    saveMap: (values: Row): Promise<{ key: string }> => ipcRenderer.invoke('tallyNotes:saveMap', { values }),
    createLedger: (values: Row): Promise<{ id: number; name: string }> => ipcRenderer.invoke('tallyNotes:createLedger', { values }),
    post: (values: Row): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> =>
      ipcRenderer.invoke('tallyNotes:post', { values }),
    salesCheck: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:salesCheck', { values }),
    // Book the Sales Register's missing-here lines as SALE vouchers.
    salesPreview: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:salesPreview', { values }),
    postSales: (values: Row): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> =>
      ipcRenderer.invoke('tallyNotes:postSales', { values }),
    registerCheck: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:registerCheck', { values }),
    registerPreview: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:registerPreview', { values }),
    postRegister: (values: Row): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> =>
      ipcRenderer.invoke('tallyNotes:postRegister', { values }),
    health: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:health', { values }),
    link: (values: Row): Promise<{ ok: true }> => ipcRenderer.invoke('tallyNotes:link', { values }),
    unlink: (values: Row): Promise<{ ok: true }> => ipcRenderer.invoke('tallyNotes:unlink', { values }),
    batches: (values: Row): Promise<Row[]> => ipcRenderer.invoke('tallyNotes:batches', { values }),
    undoBatch: (values: Row): Promise<{ removed: number; kept: { id: number; reason: string }[] }> => ipcRenderer.invoke('tallyNotes:undoBatch', { values }),
    companyBanks: (values: Row): Promise<{ chosen: boolean; banks: Row[] }> => ipcRenderer.invoke('tallyNotes:companyBanks', { values }),
    setCompanyBank: (values: Row): Promise<{ ok: true }> => ipcRenderer.invoke('tallyNotes:setCompanyBank', { values }),
    bankSuggest: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:bankSuggest', { values }),
    bankCheck: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:bankCheck', { values }),
    bankBooks: (values: Row): Promise<Row[]> => ipcRenderer.invoke('tallyNotes:bankBooks', { values }),
    bankBook: (values: Row): Promise<Row | null> => ipcRenderer.invoke('tallyNotes:bankBook', { values }),
    bankPreview: (values: Row): Promise<Row> => ipcRenderer.invoke('tallyNotes:bankPreview', { values }),
    postBank: (values: Row): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> =>
      ipcRenderer.invoke('tallyNotes:postBank', { values }),
    fixRegisterDate: (values: Row): Promise<{ entry_id: number; from: string; to: string; moved: string }> =>
      ipcRenderer.invoke('tallyNotes:fixRegisterDate', { values }),
    linkParty: (values: Row): Promise<{ key: string }> => ipcRenderer.invoke('tallyNotes:linkParty', { values }),
    saveDraft: (values: Row): Promise<{ saved_at: string }> => ipcRenderer.invoke('tallyNotes:saveDraft', { values }),
    drafts: (values?: Row): Promise<Row[]> => ipcRenderer.invoke('tallyNotes:drafts', { values }),
    clearDraft: (values: Row): Promise<{ cleared: boolean }> => ipcRenderer.invoke('tallyNotes:clearDraft', { values })
  },
  tally: {
    import: (values: Row): Promise<{ imported: number; file_name: string }> =>
      ipcRenderer.invoke('tally:import', { values }),
    map: (): Promise<Row> => ipcRenderer.invoke('tally:map'),
    link: (values: Row): Promise<{ id: number }> => ipcRenderer.invoke('tally:link', { values }),
    applyOpenings: (values: Row): Promise<{ saved: number }> =>
      ipcRenderer.invoke('tally:applyOpenings', { values }),
    clear: (): Promise<{ cleared: number }> => ipcRenderer.invoke('tally:clear'),
    create: (values: Row): Promise<{ created: number; openings: number }> =>
      ipcRenderer.invoke('tally:create', { values }),
    regroup: (values: Row): Promise<{ moved: number }> => ipcRenderer.invoke('tally:regroup', { values })
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
    removeExposure: (id: number): Promise<{ id: number }> => ipcRenderer.invoke('facility:deleteExposure', { id }),
    limitHistory: (kind: string, refId: number): Promise<Row[]> =>
      ipcRenderer.invoke('facility:limitHistory', { kind, refId }),
    addLimitRevision: (values: Row): Promise<{ from: number; to: number; delta: number }> =>
      ipcRenderer.invoke('facility:addLimitRevision', { values }),
    deleteLimitRevision: (id: number): Promise<{ id: number }> =>
      ipcRenderer.invoke('facility:deleteLimitRevision', { id })
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
