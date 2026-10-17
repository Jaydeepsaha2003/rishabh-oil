// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface Api {
  dbPing: () => Promise<{ ok: boolean; message: string; offline?: boolean }>
  revision: () => Promise<number>
  db: {
    snapshot: () => Promise<{
      at: string
      tables: number
      rows: number
      bytes: number
      gz: string
      gzBytes: number
      fileName: string
    }>
  }
  config: {
    get: () => Promise<{ url: string }>
    save: (url: string, token: string) => Promise<{ ok: boolean; message: string }>
  }
  suppliers: {
    purchaseCounts: () => Promise<Record<string, number>>
  }
  bankLedgers: {
    names: () => Promise<Record<string, string>>
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
  push: {
    key: () => Promise<{ key: string }>
    status: () => Promise<Row>
    subscribe: (subscription: Row, userId: number, ua?: string) => Promise<{ ok: true }>
    unsubscribe: (endpoint: string) => Promise<{ ok: true }>
    test: (userId: number) => Promise<{ sent: number; gone: number; failed: number; devices: number }>
    broadcast: (
      title: string,
      body: string,
      userId: number
    ) => Promise<{ sent: number; gone: number; failed: number; devices: number }>
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    all: () => Promise<Record<string, string>>
  }
  notify: {
    rules: () => Promise<Row[]>
    saveRule: (v: Row) => Promise<{ key: string }>
    resetRule: (key: string) => Promise<{ key: string }>
    preview: (key: string) => Promise<Row[]>
    people: () => Promise<Row[]>
    mutes: (userId: number) => Promise<string[]>
    mute: (userId: number, key: string, muted: boolean) => Promise<{ key: string }>
    run: () => Promise<{ raised: number; resolved: number; held: number; failed: string[] }>
    list: (userId: number, isAdmin: boolean, limit?: number) => Promise<Row[]>
    markRead: (userId: number, ids: number[]) => Promise<{ read: number }>
    markUnread: (userId: number, id: number) => Promise<{ id: number }>
    clear: (userId: number, isAdmin: boolean) => Promise<{ read: number }>
  }
  history: {
    list: (entity: string, id: number) => Promise<Row[]>
  }
  bargains: {
    list: (from?: string, to?: string, companyIds?: number[], forModule?: string) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (
      id: number,
      values: Row
    ) => Promise<{ id: number; bargain_no: string; rate_changed_from: number | null; rate: number }>
    linkedInvoices: (id: number) => Promise<Row[]>
    linkedVouchers: (id: number) => Promise<Row[]>
    voucherChoices: (id: number, vchType?: string) => Promise<Row>
    linkVoucher: (id: number, entryId: number, note?: string) => Promise<{ id: number }>
    unlinkVoucher: (id: number, linkId: number) => Promise<{ id: number }>
    adjustments: (id: number) => Promise<Row[]>
    rerateInvoices: (
      bargainId: number,
      rate: number,
      orderIds: number[]
    ) => Promise<{ updated: Row[]; failed: Row[] }>
    setInvoiceRate: (
      orderId: number,
      bargainId: number,
      rate: number
    ) => Promise<{ order_id: number; bargain_id: number; rate: number }>
    remove: (id: number) => Promise<{ id: number }>
    adjust: (id: number, delta: number, note?: string, date?: string) => Promise<{ id: number; qty: number }>
    moveBalance: (id: number, values: Row) => Promise<{ id: number; bargain_no: string; moved: number }>
  }
  orders: {
    bargainNotes: (id: number) => Promise<Row[]>
    list: (forModule?: string) => Promise<Row[]>
    intercompanySource: (id: number) => Promise<Row | null>
    create: (values: Row) => Promise<{ id: number }>
    randomInvoiceNo: (companyId?: number) => Promise<string>
    createInvoice: (values: Row) => Promise<{ group: string; ids: number[] }>
    updateInvoice: (group: string, values: Row) => Promise<{ group: string; ids: number[] }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
    fyTaxable: (supplierId: number, date: string, excludeId: number) => Promise<number>
    unmapped: () => Promise<Row[]>
    bargainLines: (id: number) => Promise<Row[]>
    bargainInterest: (id: number) => Promise<Row[]>
    consignmentDraws: (companyIds?: number[]) => Promise<Row[]>
    unmappedCount: () => Promise<number>
    map: (id: number, lines: Row[], force?: boolean) => Promise<{ id: number; bargain_id: number; valueDiff: number; toppedUp: { bargain_no: string; qty: number }[] }>
  }
  company: {
    list: () => Promise<Row[]>
    setActive: (id: number) => Promise<{ id: number }>
    getActive: () => Promise<{ id: number }>
  }
  factory: {
    list: () => Promise<Row[]>
    save: (v: Row) => Promise<{ id: number }>
    active: () => Promise<Row | null>
    companies: (factoryId?: number) => Promise<number[]>
  }
  consignment: {
    list: (forModule?: string) => Promise<Row[]>
    summary: (range?: { from?: string; to?: string }) => Promise<Row[]>
    invoices: (range?: { from?: string; to?: string }) => Promise<Row[]>
    pending: () => Promise<Row[]>
    lots: (supplierId?: number, productId?: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    saveOpening: (values: Row) => Promise<{ id: number }>
    openingLog: (supplierId: number, productId: number) => Promise<Row[]>
    openingLots: (supplierId: number, productId: number) => Promise<Row[]>
    assignGroup: (
      ids: number[],
      v: { lot_no?: string; terminal_no?: string }
    ) => Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }>
    unlinkDraw: (orderId: number) => Promise<{ id: number; freed: number }>
    unlinkDrawsFor: (
      supplierId: number,
      productId: number
    ) => Promise<{ invoices: number; freed: number }>
    renameLot: (values: {
      supplier_id: number
      product_id: number
      from_lot?: string | null
      from_terminal?: string | null
      to_lot?: string | null
      to_terminal?: string | null
    }) => Promise<{ updated: number; lot_no: string | null; terminal_no: string | null }>
    kin: (id: number) => Promise<Row>
  }
  orderQuality: {
    list: (id: number) => Promise<Row[]>
    save: (id: number, rows: Row[]) => Promise<{ id: number }>
    waive: (id: number, waived: boolean, note?: string) => Promise<{ id: number; waived: boolean }>
  }
  tankers: {
    list: (all?: boolean, forModule?: string) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    advance: (id: number, toStatus: string, data: Row) => Promise<{ id: number }>
    revert: (id: number) => Promise<{ id: number; status: string }>
    replace: (id: number, values: Row) => Promise<{ id: number }>
    quality: (id: number) => Promise<Row[]>
    qualityMany: (ids: number[]) => Promise<Row[]>
    ffaHistory: (productId?: number, limit?: number) => Promise<Row[]>
    saveQuality: (id: number, rows: Row[]) => Promise<{ id: number }>
  }
  dashboard: {
    stats: (all?: boolean) => Promise<Row>
    position: (all?: boolean) => Promise<Row>
    layout: () => Promise<Row>
    saveLayout: (hidden: string[]) => Promise<Row>
  }
  productMerge: {
    preview: (fromId: number, toId: number) => Promise<Row>
    apply: (fromId: number, toId: number) => Promise<Row>
    list: () => Promise<Row[]>
  }
  productionPlan: {
    get: (date: string) => Promise<Row>
    save: (date: string, rows: Row[]) => Promise<{ count: number }>
  }
  vouchers: {
    list: (args?: { from?: string; to?: string; vchType?: string | string[]; companyId?: number }) => Promise<Row[]>
    cashflow: (args?: { from?: string; to?: string; companyId?: number }) => Promise<Row>
    summary: (args?: { from?: string; to?: string; companyId?: number }) => Promise<Row>
    get: (id: number) => Promise<Row | null>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    alterInfo: (id: number) => Promise<Row>
    alterOwned: (id: number, values: Row) => Promise<{ id: number }>
    nextCode: (vchType: string, companyId?: number) => Promise<string>
    forDocument: (entity: 'order' | 'sale' | 'lc' | 'bd' | 'trading', id: number) => Promise<Row>
  }
  tags: {
    list: (companyId?: number) => Promise<Row[]>
    create: (name: string, colour?: string, companyId?: number) => Promise<Row>
    rename: (id: number, name: string, colour?: string) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number; removed: number }>
    forRefs: (entity: string, refs: unknown[], companyId?: number) => Promise<Record<string, Row[]>>
    set: (entity: string, ref: unknown, tagIds: number[]) => Promise<{ tags: number }>
    contents: (id: number) => Promise<Row[]>
  }
  journal: {
    trialBalance: (args?: { from?: string; to?: string; companyId?: number }) => Promise<Row>
    groups: (companyId?: number) => Promise<Row[]>
    groupNames: () => Promise<Row[]>
    groupTree: (companyId?: number) => Promise<Row[]>
    ledgerMap: (companyId?: number) => Promise<Row[]>
    renameLedger: (id: number, name: string, companyId?: number) => Promise<{ id: number; from: string; to: string }>
    mapLedger: (postsAs: string, useName: string, note?: string) => Promise<{ id: number }>
    unmapLedger: (id: number) => Promise<{ id: number }>
    createGroup: (a: { name: string; under?: string | number | null; nature?: string }) => Promise<{ id: number }>
    renameGroup: (id: number, name: string) => Promise<{ id: number }>
    moveGroup: (id: number, parentId: number | null, nature?: string) => Promise<{ id: number }>
    deleteGroup: (id: number) => Promise<{ id: number }>
    setAccountGroup: (id: number, group: string) => Promise<{ id: number }>
    setAccountsGroup: (ids: number[], group: string) => Promise<{ moved: number; group: string }>
    setAccountsHidden: (ids: number[], hidden: boolean) => Promise<{ changed: number; hidden: boolean }>
    billsOutstanding: (
      account: string,
      companyId?: number,
      opts?: { asOf?: string; side?: 'customer' | 'supplier' }
    ) => Promise<Row>
    pendingRefs: (account: string, companyId?: number, side?: 'customer' | 'supplier', all?: boolean) => Promise<Row[]>
    tradingAccount: (from?: string, to?: string, companyId?: number) => Promise<Row[]>
    booksFrom: (companyId?: number) => Promise<string | null>
    setBooksFrom: (date: string | null, companyId?: number) => Promise<{ ok: true }>
    openings: (companyId?: number) => Promise<Row>
    moveOpenings: (accountIds: number[], fromCompanyId: number, toCompanyId: number) => Promise<{ moved: number; rows: Row[] }>
    saveOpenings: (rows: Row[], companyId?: number) => Promise<{ saved: number }>
    opening: (accountId: number, companyId?: number) => Promise<Row>
    accounts: (companyId?: number) => Promise<Row[]>
    createAccount: (name: string, group?: string, companyId?: number) => Promise<{ id: number }>
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
  auth: {
    login: (username: string, password: string) => Promise<Row>
  }
  access: {
    entityHistory: (
      entity: string | string[],
      selector: { id?: number | null; key?: string | null; detail?: string | null; limit?: number }
    ) => Promise<Row[]>
    heartbeat: (
      userId: number,
      username: string
    ) => Promise<{ blocked: boolean; revoked?: boolean; role?: string; full_name?: string; permissions?: unknown }>
    entryWindows: () => Promise<Record<string, string>>
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
    list: (opts?: { includeHidden?: boolean }) => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    versions: (id: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
  }
  stock: {
    list: (range?: { from?: string; to?: string }, companyIds?: number[]) => Promise<Row[]>
    needs: () => Promise<Row[]>
    fifoMap: (args: { productId: number; companyIds?: number[]; asOf?: string; qty: number; all?: boolean }) => Promise<Row>
    breakdown: (companyIds?: number[], range?: { from?: string; to?: string }) => Promise<Record<number, { receipt: Row[]; dispatch: Row[]; packed: Row[]; produced: Row[]; consumed: Row[]; recirculated: Row[] }>>
    registers: (companyIds?: number[], range?: { from?: string; to?: string }) => Promise<{ receipts: Row[]; dispatches: Row[] }>
    daybook: (from: string, to: string) => Promise<{ vouchers: Row[]; material: Row[] }>
    transfers: () => Promise<Row[]>
    adjustments: (productId: number, companyIds?: number[]) => Promise<Row[]>
    adjust: (values: { product_id: number; qty: number; date?: string; note: string; company_id?: number }) => Promise<{ id: number }>
    deleteAdjustment: (id: number) => Promise<{ id: number }>
    transfer: (values: Row) => Promise<{ id: number }>
    deleteTransfer: (id: number) => Promise<{ id: number }>
  }
  stockCount: {
    previous: (date: string) => Promise<{ source_date: string | null; items: Row[] }>
    sheet: (date: string) => Promise<Row[]>
    list: (date: string) => Promise<Row[]>
    save: (date: string, items: Row[]) => Promise<{ count: number }>
    history: (from: string, to: string) => Promise<Row[]>
  }
  formulationSubcategory: {
    list: () => Promise<Row[]>
    save: (values: Row) => Promise<{ id: number }>
    delete: (id: number) => Promise<{ id: number }>
  }
  outsideTanker: {
    list: (date?: string) => Promise<Row[]>
    save: (v: Row) => Promise<{ id: number }>
    nil: (date: string, slot: string) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ ok: true }>
  }
  work: {
    board: (date?: string, userId?: number) => Promise<Row>
    cutoff: () => Promise<string>
    requestDay: (date: string, userId: number, reason?: string) => Promise<{ id: number; work_date: string; state: string }>
    decideDay: (id: number, approve: boolean, userId: number, note?: string) => Promise<{ id: number; state: string }>
    setDayOpen: (
      userIds: number[],
      date: string,
      open: boolean,
      userId: number,
      note?: string
    ) => Promise<{ opened: number; closed: number; work_date: string }>
    setCutoff: (cutoff: string, userId?: number, day?: string) => Promise<{ cutoff: string; cutoff_day: string }>
    setUserCutoff: (
      targetId: number,
      cutoff: string,
      day?: string,
      userId?: number
    ) => Promise<{ id: number; cutoff: string; cutoff_day: string; own: boolean }>
    processes: () => Promise<Row[]>
    saveProcess: (values: Row, userId?: number) => Promise<{ id: number }>
    removeProcess: (id: number, userId?: number) => Promise<{ id: number; retired: boolean }>
    reorderProcesses: (ids: number[], userId?: number) => Promise<{ ok: true }>
    tick: (taskId: number, userId: number) => Promise<{ id: number; state: string }>
    untick: (taskId: number, userId: number) => Promise<{ id: number; state: string }>
    redo: (taskId: number, userId: number) => Promise<{ id: number; state: string }>
    approve: (taskId: number, userId: number, note?: string) => Promise<{ id: number; state: string }>
    sendBack: (taskId: number, userId: number, note: string) => Promise<{ id: number; state: string }>
    note: (taskId: number, userId: number, text: string) => Promise<{ id: number }>
    assign: (values: Row, userId: number) => Promise<{ id: number; ids: number[] }>
    removeTask: (taskId: number, userId: number) => Promise<{ id: number }>
  }
  stockOpening: {
    list: (companyId?: number) => Promise<Row>
    save: (
      rows: Row[],
      asOf: string,
      companyId?: number,
      version?: string
    ) => Promise<{ saved: number; cleared: number }>
    handOverPp: (date: string, companyId?: number) => Promise<{ from: string; moved: number; rows: Row[] }>
    putBackPp: (rows: Row[], companyId?: number) => Promise<{ restored: number }>
    date: (companyId?: number) => Promise<string>
    sets: (companyId?: number) => Promise<Row[]>
    setLines: (setId: number) => Promise<Row[]>
    ppStages: (companyId?: number) => Promise<Row[]>
    addPpStage: (name: string, companyId?: number) => Promise<Row>
    removePpStage: (
      stageId: number,
      companyId?: number
    ) => Promise<{ removed: number; kept: number; retired: boolean; name: string }>
    savePp: (
      productId: number,
      lines: Row[],
      companyId?: number,
      version?: string
    ) => Promise<{ total: number; lines: number; saved_lines?: Row[] }>
    ppVessels: (productId: number, companyId?: number) => Promise<Row[]>
    ppWriteoffs: (productId: number, companyId?: number) => Promise<Row[]>
    writeOffPp: (
      productId: number,
      stageId: number,
      qty: number,
      note: string,
      companyId?: number
    ) => Promise<{ product_id: number; stage_id: number; qty: number }>
    ppReceivers: (productId: number, companyId?: number) => Promise<Row[]>
    movePp: (
      productId: number,
      stageId: number,
      qty: number,
      toProductId: number,
      toStageId: number,
      note: string,
      companyId?: number
    ) => Promise<{ product_id: number; to_product_id: number; qty: number }>
    ppFreeTotals: (productIds: number[], companyId?: number, asOf?: string) => Promise<Record<number, { without: number; with: number }>>
  }
  skuOpening: {
    list: (asOf?: string) => Promise<Row>
    date: () => Promise<string>
    save: (rows: Row[], asOf: string) => Promise<{ saved: number; cleared: number }>
  }
  skuStock: {
    breakdown: (date?: string | { from?: string; to?: string }) => Promise<Row[]>
    list: (date?: string | { from?: string; to?: string }) => Promise<Row[]>
    adjustments: (id: number) => Promise<Row[]>
    deleteAdjustment: (id: number) => Promise<{ id: number; packaging_id: number }>
    adjust: (
      id: number,
      delta: number,
      note?: string,
      date?: string,
      kind?: string
    ) => Promise<{ id: number; on_hand: number }>
  }
  transporterFreight: {
    list: (
      side: 'purchase' | 'sales',
      opts?: { companyId?: number; from?: string; to?: string; transporterId?: number; state?: 'all' | 'unbilled' | 'billed' }
    ) => Promise<Row[]>
    kpis: (side: 'purchase' | 'sales', opts?: { companyId?: number; from?: string; to?: string }) => Promise<Row>
    bills: (companyId?: number) => Promise<Row[]>
    createBill: (values: Row) => Promise<{ id: number }>
    updateBill: (id: number, values: Row) => Promise<{ id: number }>
    deleteBill: (id: number, companyId?: number) => Promise<{ id: number }>
    orphanBills: (companyId?: number) => Promise<Row[]>
    raiseShortageNote: (lineId: number, date?: string, companyId?: number) => Promise<{ note_id: number; note_no: string }>
    unraiseShortageNote: (lineId: number, companyId?: number) => Promise<{ id: number }>
    waiveShortage: (lineId: number, reason: string, companyId?: number) => Promise<{ id: number; entry_id: number | null }>
    unwaiveShortage: (lineId: number, companyId?: number) => Promise<{ id: number }>
  }
  notes: {
    list: (companyId?: number) => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; note_no: string }>
    update: (id: number, values: Row) => Promise<{ id: number; note_no: string }>
    remove: (id: number, companyId?: number) => Promise<{ id: number }>
  }
  production: {
    list: (forModule?: string) => Promise<Row[]>
    items: (id: number) => Promise<Row[]>
    mix: (id: number) => Promise<Row>
    // The Complete Production Report in one call: the product columns with
    // their opening/receiving, and every batch of the period with its
    // consumption lines and its recipe ratio.
    report: (
      range?: { from?: string; to?: string },
      companyIds?: number[]
    ) => Promise<{ from: string; to: string; products: Row[]; batches: Row[] }>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    ppDraws: (productionId: number) => Promise<{ product_id: number; ffa: string; qty: number }[]>
  }
  sales: {
    list: (companyIds?: number[], forModule?: string) => Promise<Row[]>
    randomInvoiceNo: (companyId?: number) => Promise<string>
    invoiceGaps: (companyId?: number, from?: string, to?: string) => Promise<Row>
    cancelInvoiceNo: (values: Row) => Promise<{ prefix: string; number: number }>
    uncancelInvoiceNo: (values: Row) => Promise<{ prefix: string; number: number }>
    series: (companyId?: number) => Promise<Row>
    fyTaxable: (customerId: number, date: string, excludeId: number) => Promise<number>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    setStatus: (id: number, status: string) => Promise<{ id: number }>
    setStage: (id: number, stage: string, force?: boolean, date?: string) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    createInvoice: (values: Row) => Promise<{ group: string; ids: number[] }>
    updateInvoice: (group: string, values: Row) => Promise<{ group: string; ids: number[] }>
    fixDate: (id: number, date: string) => Promise<{ id: number; from: string; to: string }>
    setInvoiceStage: (group: string, stage: string, force?: boolean, date?: string, received?: Record<string, number | null>) => Promise<{ group: string }>
    removeInvoice: (group: string) => Promise<{ group: string }>
    rejectInvoice: (group: string, reason: string) => Promise<{ group: string }>
    cancelDelivery: (
      group: string,
      reason: string,
      freightQty?: Record<string, number | null>
    ) => Promise<{ group: string; lines: number }>
    unrejectInvoice: (group: string) => Promise<{ group: string }>
  }
  skuRates: {
    partyCounts: () => Promise<Row[]>
    parties: (packagingId: number) => Promise<number[]>
    setParties: (packagingId: number, customerIds: number[]) => Promise<{ count: number }>
    list: (id: number) => Promise<Row[]>
    save: (id: number, rows: Row[]) => Promise<{ saved: number; cleared: number }>
  }
  salesBargains: {
    list: (from?: string, to?: string, companyIds?: number[], forModule?: string) => Promise<Row[]>
    returns: (companyIds?: number[]) => Promise<Row[]>
    unattributedReturns: (companyIds?: number[]) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; bargain_no: string }>
    update: (
      id: number,
      values: Row
    ) => Promise<{ id: number; bargain_no: string; rate_changed_from: number | null; rate: number }>
    remove: (id: number) => Promise<{ id: number }>
    linkedInvoices: (id: number) => Promise<Row[]>
    linkedVouchers: (id: number) => Promise<Row[]>
    voucherChoices: (id: number, vchType?: string) => Promise<Row>
    linkVoucher: (id: number, entryId: number, note?: string) => Promise<{ id: number }>
    unlinkVoucher: (id: number, linkId: number) => Promise<{ id: number }>
    rerateInvoices: (id: number, rate: number, saleIds: number[]) => Promise<{ updated: Row[]; failed: Row[] }>
    adjust: (id: number, delta: number, note?: string, date?: string) => Promise<{ id: number; qty: number }>
    moveBalance: (id: number, values: Row) => Promise<{ id: number; bargain_no: string; moved: number }>
  }
  gate: {
    list: () => Promise<Row[]>
    nextNo: (direction?: 'in' | 'out') => Promise<string>
    dispatchableSales: () => Promise<Row[]>
    waivedOuts: () => Promise<Row[]>
    waiveOut: (group: string, reason: string) => Promise<{ group: string }>
    unwaiveOut: (group: string) => Promise<{ group: string }>
    waiveOuts: (groups: string[], reason: string) => Promise<{ done: string[]; failed: { group: string; error: string }[] }>
    partyCategories: () => Promise<Row[]>
    forRecord: (q: { orderId?: number; saleIds?: number[]; invoiceGroup?: string }) => Promise<{ rows: Row[]; hidden: number; window_from: string }>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    complete: (id: number, gross: number, tare: number) => Promise<{ id: number }>
    weights: (
      id: number,
      gross: number | null,
      tare: number | null,
      awaitingGrossOut?: boolean | null,
      dispatchQty?: number | string | null,
      invoiceGroup?: string | string[] | null,
      outDate?: string | null,
      outTime?: string | null
    ) => Promise<{ id: number; status: string; net: number | null; missing: string | null }>
    skipWeighment: (id: number) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    reject: (id: number, reason: string) => Promise<{ id: number }>
    unreject: (id: number) => Promise<{ id: number }>
  }
  treasury: {
    alerts: (all?: boolean) => Promise<Row>
    paymentTracker: () => Promise<Row[]>
    settleLcBill: (id: number, date?: string) => Promise<{ id: number }>
    reopenLcBill: (id: number) => Promise<{ id: number }>
  }
  lc: {
    list: () => Promise<Row[]>
    issuances: (lcId: number) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number; warning?: string }>
    update: (id: number, values: Row) => Promise<{ id: number; warning?: string }>
    remove: (id: number) => Promise<{ id: number }>
    reject: (id: number, values: Row) => Promise<{ id: number }>
    reinstate: (id: number) => Promise<{ id: number }>
    parts: (id: number) => Promise<Row[]>
    repayParts: (id: number, values: Row) => Promise<{ repayment_id: number; closed: boolean; rebate: number }>
    undoPartRepayment: (id: number) => Promise<{ parts: number[] }>
    issue: (values: Row) => Promise<{ id: number }>
    removeIssuance: (id: number) => Promise<{ id: number }>
    editPreclosure: (id: number, values: Row) => Promise<{ id: number }>
    payParty: (id: number, values: Row) => Promise<{ id: number; installment_no: number }>
    removeInstallment: (id: number) => Promise<{ installment_no: number }>
    allRepayments: () => Promise<Row[]>
    repayments: (lcId: number) => Promise<Row[]>
    saveRepayment: (values: Row) => Promise<{ id: number }>
    removeRepayment: (id: number) => Promise<{ id: number }>
    paymentIn: (id: number, amount: number, date?: string, selectedKeys?: string[]) => Promise<{ id: number; date: string }>
    paymentIns: (lcId: number) => Promise<Row[]>
    removePaymentIn: (id: number) => Promise<{ id: number }>
    openTradingInvoices: (lcId: number) => Promise<Row[]>
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
    ) => Promise<{ id: number }>
    unpreclose: (id: number) => Promise<{ id: number; removed: string[] }>
    getLimit: (bankId?: number, from?: string, to?: string) => Promise<Row>
    bankLimits: () => Promise<Row[]>
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
    list: (filter?: Row) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
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
        charges?: { account: string; amount: number }[]
        note?: string | null
        party_id?: number | null
        // The bank the money left from; the bill's own bank when left out.
        bank_account?: string | null
        // Other bills this same bank debit also settled.
        also?: { bd_id?: number | string; amount?: number | string }[]
      }
    ) => Promise<{ id: number; amount: number; outstanding: number; closed: boolean }>
    repayments: (id: number) => Promise<Row[]>
    interestSchedule: (id: number) => Promise<Row[]>
    interestWindow: (id: number, toDate?: string) => Promise<Row>
    payInterestUpto: (
      id: number,
      v: { to_date: string; note?: string | null; post?: boolean; bank_account?: string | null }
    ) => Promise<{ id: number; gross: number; tds: number; net: number; days: number; posted: boolean }>
    interestPayments: (id: number) => Promise<Row[]>
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
    ) => Promise<{ id: number; gross: number; net: number; posted: boolean }>
    deleteInterest: (id: number) => Promise<{ id: number }>
    postInterest: (id: number) => Promise<{ id: number; journal_entry_id: number }>
    allRepayments: () => Promise<Row[]>
    linkedOrders: (id: number) => Promise<Row[]>
    parties: (id: number) => Promise<Row[]>
    allParties: () => Promise<Row[]>
    openTradingInvoices: (id: number) => Promise<Row[]>
    paymentIns: (id: number) => Promise<Row[]>
    paymentIn: (
      id: number,
      amount: number,
      date?: string,
      keys?: string[],
      method?: string,
      account?: string,
      ref?: string
    ) => Promise<{ id: number; date: string }>
    deletePaymentIn: (id: number) => Promise<{ id: number }>
    deleteRepayment: (id: number) => Promise<{ id: number; bd_id: number }>
    editRepayment: (id: number, values: Row) => Promise<{ id: number; bd_id: number; entry_id: number }>
    markReceived: (id: number, date?: string, route?: string, account?: string | null, firstPart?: number | null, firstReceipt?: number | null, legs?: Row[] | null) => Promise<{ id: number; date: string }>
    receiptParts: (id: number) => Promise<Row[]>
    receivePart: (id: number, values: Row) => Promise<{ id: number; part_no: number; ref: string; interest: number }>
    removeReceiptPart: (id: number) => Promise<{ part_no: number; ref: string }>
    partyPayments: (id: number) => Promise<Row[]>
    payParty: (id: number, values: Row) => Promise<{ id: number; part_no: number }>
    removePartyPayment: (id: number) => Promise<{ part_no: number }>
    unmarkReceived: (id: number) => Promise<{ id: number }>
    reopen: (id: number) => Promise<{ id: number }>
    upfrontInterest: (id: number, date?: string, account?: string) => Promise<{ id: number } | null>
    reverseUpfrontInterest: (id: number) => Promise<{ id: number }>
    setVoucherBank: (id: number, entryId: number, account: string) => Promise<{ id: number; account: string }>
    setRoute: (id: number, route: string, account?: string, shares?: Row[]) => Promise<{ id: number; route: string }>
    kpis: () => Promise<Row>
    chargeTypes: () => Promise<{ label: string; ledger: string; preset: boolean }[]>
    addChargeType: (label: string) => Promise<{ label: string; ledger: string; preset: boolean }>
    limits: () => Promise<Row>
    setCombinedLimit: (value: number | string | null) => Promise<{ value: number | null }>
    limitReductions: (nbfcId?: number) => Promise<Row[]>
    addLimitReduction: (values: Row) => Promise<{ id: number; sanctioned: number; limit_now: number }>
    deleteLimitReduction: (id: number) => Promise<{ id: number }>

  }
  repairs: {
    duplicateSales: (companyId?: number) => Promise<Row>
    checks: (companyId?: number) => Promise<Row>
    genericBank: () => Promise<Row[]>
    moveGenericBank: (companyId: number, account: string) => Promise<{ lines: number; vouchers: number; account: string }>
    removeDuplicateSales: (entryIds: number[], companyId?: number) => Promise<{ removed: number; revenue: number }>
    saleTds: (companyId?: number) => Promise<Row>
    clearSaleTds: (keys: string[], companyId?: number) => Promise<{ invoices: number; vouchers: number; tds: number }>
    lcCharges: () => Promise<Row>
    outwardFreight: () => Promise<Row>
    fixOutwardFreight: (ids: number[]) => Promise<{ fixed: number; freight: number }>
    wrongCompany: () => Promise<Row>
    splitTanker: () => Promise<Row>
    paisa: () => Promise<Row>
    fixPaisa: (ids: number[]) => Promise<Row>
    fixSplitTanker: (ids: number[]) => Promise<Row>
    staleTds: () => Promise<Row>
    paymentIns: () => Promise<Row>
    lcLedgers: () => Promise<Row>
    saveLcLedgers: (values: Row) => Promise<Row>
    fixLcLedgers: (ids: number[]) => Promise<{ moved: number; vouchers: number }>
    fixPaymentIns: (keys: string[]) => Promise<{ removed: number }>
    fixStaleTds: (ids: number[]) => Promise<Row>
    moveWrongCompany: (ids: number[]) => Promise<{ moved: number; codes: string[] }>
    sharedLedgers: () => Promise<Row>
    fixSharedLedgers: (keys: string[]) => Promise<{ fixed: number; lines: number; ledgers: string[] }>
    partyClashes: (name: string, side: 'customer' | 'supplier') => Promise<Row[]>
    fixLcCharges: (ids: number[]) => Promise<{ fixed: number; charges: number }>
  }
  trading: {
    list: (forModule?: string) => Promise<Row[]>
    create: (values: Row) => Promise<{ id: number }>
    update: (id: number, values: Row) => Promise<{ id: number }>
    remove: (id: number) => Promise<{ id: number }>
    payments: () => Promise<Row[]>
  }
  tallyNotes: {
    preview: (values: Row) => Promise<Row>
    saveMap: (values: Row) => Promise<{ key: string }>
    createLedger: (values: Row) => Promise<{ id: number; name: string }>
    post: (values: Row) => Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }>
    salesCheck: (values: Row) => Promise<Row>
    salesPreview: (values: Row) => Promise<Row>
    postSales: (values: Row) => Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }>
    registerCheck: (values: Row) => Promise<Row>
    registerPreview: (values: Row) => Promise<Row>
    postRegister: (values: Row) => Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }>
    health: (values: Row) => Promise<Row>
    link: (values: Row) => Promise<{ ok: true }>
    unlink: (values: Row) => Promise<{ ok: true }>
    batches: (values: Row) => Promise<Row[]>
    undoBatch: (values: Row) => Promise<{ removed: number; kept: { id: number; reason: string }[] }>
    companyBanks: (values: Row) => Promise<{ chosen: boolean; banks: Row[] }>
    setCompanyBank: (values: Row) => Promise<{ ok: true }>
    bankSuggest: (values: Row) => Promise<Row>
    bankCheck: (values: Row) => Promise<Row>
    bankBooks: (values: Row) => Promise<Row[]>
    bankBook: (values: Row) => Promise<Row | null>
    bankPreview: (values: Row) => Promise<Row>
    postBank: (values: Row) => Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }>
    fixRegisterDate: (values: Row) => Promise<{ entry_id: number; from: string; to: string; moved: string }>
    linkParty: (values: Row) => Promise<{ key: string }>
    saveDraft: (values: Row) => Promise<{ saved_at: string }>
    drafts: (values?: Row) => Promise<Row[]>
    clearDraft: (values: Row) => Promise<{ cleared: boolean }>
  }
  tally: {
    import: (values: Row) => Promise<{ imported: number; file_name: string }>
    map: () => Promise<Row>
    link: (values: Row) => Promise<{ id: number }>
    applyOpenings: (values: Row) => Promise<{ saved: number }>
    clear: () => Promise<{ cleared: number }>
    create: (values: Row) => Promise<{ created: number; openings: number }>
    regroup: (values: Row) => Promise<{ moved: number }>
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
    limitHistory: (kind: string, refId: number) => Promise<Row[]>
    addLimitRevision: (values: Row) => Promise<{ from: number; to: number; delta: number }>
    deleteLimitRevision: (id: number) => Promise<{ id: number }>
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
