import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getCurrentUser } from './currentUser'
import { deleteJournalByRef, postJournal, postSaleJournal, repostJournal } from './journal'
import { getActiveCompanyId } from './company'
import { getSetting } from './repos'
import { productStockAvailable, stockMap } from './stock'
import { deleteSaleProductions } from './production'
import { visibleFromFor } from './access-gate'
import { assertSalesInvoiceNoFree } from './invoiceno'

// Guard: a dispatched (done) sale physically draws finished-goods stock, so the
// available stock (excluding this sale's own effect) must cover the quantity.
// Pending sales are commitments and don't deduct, so they aren't blocked here.
async function assertFinishedStock(
  productId: number,
  qty: number,
  productName: string,
  excludeSaleId?: number
): Promise<void> {
  const avail = await productStockAvailable(productId, { excludeSaleId })
  if (qty > avail + 1e-6) {
    throw new Error(
      `Not enough ${productName || 'finished'} stock to dispatch: need ${qty.toFixed(3)}, only ${Math.max(avail, 0).toFixed(3)} available. Produce more first, or keep the sale as pending.`
    )
  }
}

async function productLabel(productId: number): Promise<string> {
  const r = await getClient().execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [productId] })
  return r.rows.length ? String(r.rows[0].name || '') : ''
}

// Guard for dispatching a made-to-order finished good: the formulation's inputs
// must be in stock to make the dispatched qty. When editing an already-linked
// sale, that sale's existing auto-production consumption is added back first so
export type DispatchStage = 'pending' | 'loaded' | 'transit' | 'unloaded'

// A dispatch moves through loaded → transit → unloaded; any of those three
// means the goods have left the factory (accounting/stock status 'done').
// 'pending' = committed but not yet dispatched (no stock drawn).
function stageOf(v: Row): DispatchStage {
  const s = String(v.dispatch_stage || '').toLowerCase()
  if (s === 'loaded' || s === 'transit' || s === 'unloaded' || s === 'pending') return s
  // Legacy fallback: a sale carrying only status 'done' is treated as delivered.
  return String(v.status) === 'done' ? 'unloaded' : 'pending'
}
const isDispatched = (stage: DispatchStage): boolean => stage !== 'pending'
const statusForStage = (stage: DispatchStage): 'pending' | 'done' => (isDispatched(stage) ? 'done' : 'pending')

const STAGE_ORDER: DispatchStage[] = ['pending', 'loaded', 'transit', 'unloaded']

// Resolve the three stage dates for a target stage: keep/carry any dates for
// stages up to the target (stamping `today` where missing), clear dates for
// stages beyond it. `src` supplies any explicitly-provided dates (edit form).
function resolveStageDates(
  stage: DispatchStage,
  src: Record<string, unknown>,
  today: string
): { loaded_date: string | null; transit_date: string | null; unloaded_date: string | null } {
  const t = STAGE_ORDER.indexOf(stage)
  const val = (x: unknown): string | null => (x ? String(x) : null)
  let loaded = t >= 1 ? val(src.loaded_date) : null
  let transit = t >= 2 ? val(src.transit_date) : null
  let unloaded = t >= 3 ? val(src.unloaded_date) : null
  if (t >= 1 && !loaded) loaded = today
  if (t >= 2 && !transit) transit = today
  if (t >= 3 && !unloaded) unloaded = today
  return { loaded_date: loaded, transit_date: transit, unloaded_date: unloaded }
}

// Today in local time (YYYY-MM-DD). Fine in the main process (not a workflow).
function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const round2 = (v: number): number => Math.round(v * 100) / 100

// Maintain the receivable entry in the customer ledger for a sale.
// Convention (shared with supplier/transporter ledger): amount positive = credit
// (we owe the party), negative = debit. A sale debits the customer (they owe us).
// TDS the customer withholds, on the customer master's terms — mirrors the
// supplier side exactly. Below the FY threshold the base rate applies (0 when
// the master says "no TDS below the slab"); everything above it is charged at
// the invoice's rate.
function tierTds(
  taxable: number,
  prior: number,
  threshold: number,
  basePct: number,
  abovePct: number
): number {
  if (!threshold || threshold <= 0) return (taxable * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, taxable))
  const above = taxable - below
  return (below * basePct) / 100 + (above * abovePct) / 100
}

// Indian FY (Apr–Mar) range for a date.
function fyRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const startY = d.getMonth() + 1 >= 4 ? y : y - 1
  return { start: `${startY}-04-01`, end: `${startY + 1}-03-31` }
}

// A Trading customer can be the same real-world party (PAN) as an existing
// Manufacturing customer, kept as its own row so a trading deal never mixes
// with the manufacturing relationship's bargains. When one is linked to the
// other (customers.linked_party_id), the law's TDS slab is per-PAN, not per
// row — so every id sharing that link resolves together here.
async function relatedCustomerIds(customerId: number): Promise<number[]> {
  const c = getClient()
  const row = await c.execute({ sql: 'SELECT linked_party_id FROM customers WHERE id = ?', args: [customerId] })
  const root = Number(row.rows[0]?.linked_party_id) || customerId
  const linked = await c.execute({ sql: 'SELECT id FROM customers WHERE linked_party_id = ?', args: [root] })
  return Array.from(new Set([root, customerId, ...linked.rows.map((r) => Number(r.id))]))
}

// What has already been billed to this customer this financial year, which is
// where the slab picks up from.
export async function customerFyTaxable(
  customerId: number,
  dateStr: string,
  excludeId: number
): Promise<number> {
  const { start } = fyRange(dateStr)
  const ids = await relatedCustomerIds(customerId)
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS t FROM sales
          WHERE customer_id IN (${ids.map(() => '?').join(',')}) AND sale_date BETWEEN ? AND ? AND id != ? AND company_id = ?`,
    args: [...ids, start, String(dateStr).slice(0, 10), excludeId || 0, getActiveCompanyId()]
  })
  return Number(res.rows[0].t) || 0
}

// The TDS on one sale invoice, given its total and who it is billed to.
// The rate to withhold on a new sale. The invoice form fills this in from the
// customer master the moment a customer is picked, so it is normally stated on
// the payload. When a caller states NOTHING at all — a programmatic create, an
// import — fall back to the master rather than silently billing at 0%.
// An explicit 0 is respected: that is someone deciding not to withhold.
async function resolveTdsPct(v: Row, customerId: number | null): Promise<number> {
  const stated = v.tds_pct
  if (stated !== undefined && stated !== null && String(stated).trim() !== '') return n(stated)
  if (!customerId) return 0
  const cu = await getClient().execute({
    sql: 'SELECT tds_pct FROM customers WHERE id = ?',
    args: [customerId]
  })
  return cu.rows.length ? n(cu.rows[0].tds_pct) : 0
}

// TDS the customer withholds on a sale.
//
// The base is the invoice's TAXABLE VALUE — the goods alone. Not the
// tax-inclusive total: GST is the government's money passing through, so
// withholding a slice of it would withhold tax on tax, and the rupee round-off
// is a presentation artifact that has no business moving the withheld amount.
// The slab (threshold / above-only) runs on the same taxable figures, which is
// what customerFyTaxable already accumulates — so the base and the running
// year-to-date it is measured against are now the same kind of number.
async function saleTds(
  customerId: number | null,
  tdsPct: number,
  taxable: number,
  dateStr: string,
  excludeId: number
): Promise<number> {
  if (!customerId || tdsPct <= 0 || taxable <= 0) return 0
  const cu = await getClient().execute({
    sql: 'SELECT tds_threshold, tds_above_only FROM customers WHERE id = ?',
    args: [customerId]
  })
  const master = cu.rows[0]
  const threshold = Number(master?.tds_threshold) || 0
  const basePct = master?.tds_above_only ? 0 : tdsPct
  const prior = threshold > 0 ? await customerFyTaxable(customerId, dateStr, excludeId) : 0
  return Math.round(tierTds(taxable, prior, threshold, basePct, tdsPct) * 100) / 100
}

async function postCustomerReceivable(
  saleId: number,
  customerId: number | null,
  amount: number,
  date: string
): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'sale'",
    args: [saleId]
  })
  if (customerId && amount > 0) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'sale', ?, 'Sale invoice', (SELECT company_id FROM sales WHERE id = ?))`,
      args: [customerId, saleId, date, -Math.abs(amount), saleId]
    })
  }
}

// Tally journal for a sale: Dr Customer (incl. GST), Cr {FG} SALE A/C (taxable),
// Cr GST OUTPUT A/C (output gst), and — for a FOR delivery — Dr Freight
// Outward / Cr Transporter, so freight actually lands in the books instead of
// only the informal transporter/customer ledgers postSaleFreight maintains.
// ONE VOUCHER PER INVOICE.
//
// An invoice is one or more `sales` rows sharing an invoice_group — different
// products, or the same product in different rate bands. Each row used to post
// a SALE voucher of its own, so a two-line invoice appeared twice in the
// customer's ledger under one Bill Ref and read as a double posting. The money
// was never doubled (each voucher carried its own line's share) but no reader
// could tell that from the ledger.
//
// This posts the invoice: the customer debited once for the whole bill, and one
// credit line per SALE account involved — which is what a sales voucher looks
// like in Tally, and what makes the ledger legible.
//
// The voucher is rewritten in place wherever one already exists, because
// voucher numbers here are positional (see voucherCodeMap): a fresh entry lands
// at the end of the sequence and shifts every voucher after the old one. Where
// several entries exist for one invoice — every multi-line invoice, before this
// — the EARLIEST keeps the number and the rest are dropped.
export async function postSaleInvoiceJournal(saleId: number, reuseEntryId?: number): Promise<void> {
  const c = getClient()
  const seed = await c.execute({
    sql: 'SELECT id, invoice_group, company_id FROM sales WHERE id = ?',
    args: [n(saleId)]
  })
  if (!seed.rows.length) return
  const seedRow = seed.rows[0] as unknown as Row
  const group = seedRow.invoice_group ? String(seedRow.invoice_group) : null

  // Every line of the invoice, with what it sells and what it withheld.
  const rowsRes = group
    ? await c.execute({
        sql: `SELECT s.*, p.code AS product_code, p.name AS product_name, cu.name AS customer_master
              FROM sales s LEFT JOIN products p ON p.id = s.product_id
              LEFT JOIN customers cu ON cu.id = s.customer_id
              WHERE s.invoice_group = ? ORDER BY s.id`,
        args: [group]
      })
    : await c.execute({
        sql: `SELECT s.*, p.code AS product_code, p.name AS product_name, cu.name AS customer_master
              FROM sales s LEFT JOIN products p ON p.id = s.product_id
              LEFT JOIN customers cu ON cu.id = s.customer_id
              WHERE s.id = ?`,
        args: [n(saleId)]
      })
  const rows = toPlain(rowsRes)
  if (!rows.length) return
  const first = rows[0]

  // Which vouchers exist for this invoice today. The earliest is the one whose
  // number the invoice has always had, so that is the one kept.
  const ids = rows.map((r) => n(r.id))
  const priorRes = await c.execute(
    `SELECT id FROM journal_entries WHERE sale_id IN (${ids.join(',')}) ORDER BY id`
  )
  const priorIds = priorRes.rows.map((r) => n((r as unknown as Row).id)).filter(Boolean)
  const target = n(reuseEntryId) || priorIds[0] || 0

  const taxable = round2(rows.reduce((t, r) => t + n(r.amount), 0))
  const gst = round2(rows.reduce((t, r) => t + n(r.gst_amount), 0))
  const ro = round2(rows.reduce((t, r) => t + n(r.round_off), 0))
  const tds = round2(rows.reduce((t, r) => t + n(r.tds_amount), 0))
  const freight = round2(rows.reduce((t, r) => t + n(r.transport_amount), 0))

  if (taxable <= 0 && gst <= 0) {
    for (const id of priorIds) await deleteJournalEntryById(id)
    return
  }

  let customerName = String(first.customer_master || first.customer || '').trim()
  if (!customerName) customerName = 'CASH CUSTOMER A/C'
  let transporterName = ''
  if (freight > 0 && first.transporter_id) {
    const t = await c.execute({ sql: 'SELECT name FROM transporters WHERE id = ?', args: [n(first.transporter_id)] })
    transporterName = t.rows.length ? String(t.rows[0].name).trim() : ''
  }
  const hasFreight = freight > 0 && !!transporterName
  const deducted = !!first.deduct_freight && hasFreight

  // One credit line per SALE account. Two lines of the same product collapse
  // into one line, as they would on the invoice itself; two products keep
  // their own accounts, which is the whole reason to post per invoice.
  const bySaleAcc = new Map<string, number>()
  for (const r of rows) {
    const code = String(r.product_code || r.product_name || 'FG').toUpperCase()
    const acc = `${code} SALE A/C`
    bySaleAcc.set(acc, round2((bySaleAcc.get(acc) || 0) + n(r.amount)))
  }

  // The DEBTOR is the residual of the other lines, and it has to be, because a
  // sale row's `amount` is qty x rate and can carry more than two decimals.
  // Rounding the grand total is then not the same number as adding up the
  // per-account rounded totals — they differ by a paisa on seven real invoices
  // here. Deriving the debtor from lines that are ALL already at two decimals
  // makes the voucher balance exactly, instead of relying on repostJournal's
  // 0.01 tolerance to wave a broken one through and drag the trial balance
  // with it.
  //
  //   custDr = (sale accounts + GST + round off cr + freight payable)
  //          - (TDS + round off dr + freight outward)
  const saleLines = Array.from(bySaleAcc, ([account, cr]) => ({ account, group: 'Sales Accounts', cr }))
  const saleAccounts = round2(saleLines.reduce((t, l) => t + l.cr, 0))
  const freightOutward = hasFreight ? freight : 0
  const freightPayable = hasFreight && !deducted ? freight : 0
  const roCr = ro > 0 ? ro : 0
  const roDr = ro < 0 ? -ro : 0
  const custDr = round2(
    saleAccounts + gst + roCr + freightPayable - tds - roDr - freightOutward
  )

  const lines = [
    { account: customerName, group: 'Sundry Debtors', dr: custDr },
    ...saleLines,
    { account: 'GST OUTPUT A/C', group: 'Duties & Taxes', cr: gst },
    { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: roCr, dr: roDr }
  ]
  if (tds > 0.004) lines.push({ account: 'TDS RECEIVABLE A/C', group: 'Deposits (Asset)', dr: tds })
  if (hasFreight) {
    lines.push({ account: 'FREIGHT OUTWARD A/C', group: 'Direct Expenses', dr: freightOutward })
    if (!deducted) lines.push({ account: 'FREIGHT PAYABLE A/C', group: 'Current Liabilities', cr: freightPayable })
  }

  const args = {
    date: String(first.sale_date),
    vchType: 'SALE',
    vchNo: first.invoice_no ? String(first.invoice_no) : null,
    // The voucher is filed under the invoice's FIRST line, so deleting that
    // line has to hand the voucher on rather than take it down — see deleteSale.
    saleId: n(first.id),
    companyId: n(first.company_id) || undefined,
    lines
  }

  if (target) {
    await repostJournal(target, args)
    for (const id of priorIds) if (id !== target) await deleteJournalEntryById(id)
    return
  }
  await postJournal(args)
}

// One entry and its lines, by id. deleteJournalByRef works off the source
// document; the strays this collapses are found by id instead.
async function deleteJournalEntryById(entryId: number): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [n(entryId)]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [n(entryId)] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [n(entryId)] })
}

async function postSaleEntry(
  saleId: number,
  v: Row,
  taxable: number,
  gst: number,
  roundOff = 0,
  freightAmount = 0,
  tds = 0
): Promise<void> {
  const prod = await getClient().execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [n(v.product_id)]
  })
  const code = String(prod.rows[0]?.code || prod.rows[0]?.name || 'FG').toUpperCase()
  // The MASTER's name first, then the free text.
  //
  // The voucher used to read v.customer alone — the free-text column — and a
  // sale booked from the Trading page sets customer_id and leaves that text
  // NULL. The name came out empty and the whole invoice was debited to CASH
  // CUSTOMER A/C, while every screen showed the real party (they read the
  // master through the join). So the customer's own ledger was missing invoices
  // that the register said were theirs.
  let customerName = String(v.customer || '').trim()
  if (v.customer_id) {
    const cu = await getClient().execute({ sql: 'SELECT name FROM customers WHERE id = ?', args: [n(v.customer_id)] })
    if (cu.rows.length) customerName = String(cu.rows[0].name || '').trim() || customerName
  }
  let transporterName: string | null = null
  if (freightAmount > 0 && v.transporter_id) {
    const t = await getClient().execute({ sql: 'SELECT name FROM transporters WHERE id = ?', args: [n(v.transporter_id)] })
    transporterName = t.rows.length ? String(t.rows[0].name) : null
  }
  // The voucher belongs to the INVOICE, not to this line. Saving any line
  // re-posts the whole invoice from what is in the database, so a three-line
  // invoice ends up with one voucher no matter which order its lines were
  // written in. Every figure is read back off the rows, so the arguments
  // gathered above are only still used for the free-text fallbacks.
  void code
  void customerName
  void transporterName
  void taxable
  void gst
  void roundOff
  void freightAmount
  void tds
  await postSaleInvoiceJournal(saleId).catch((e) =>
    console.error('[journal] sale post failed:', (e as Error).message)
  )
}

// Re-post one sale's voucher from what is already stored on it.
//
// Nothing about the sale changes — the figures are read back off the row and
// handed to the same posting function a save uses, so the only thing that can
// come out different is what the posting rules now do with them. Written for
// the CASH CUSTOMER repair (a trading sale's party name was resolved from a
// column the Trading page leaves empty), and useful for any future rule change
// that should reach vouchers already written.
export async function repostSaleJournal(saleId: number): Promise<{ id: number; party: string }> {
  const r = await getClient().execute({
    sql: `SELECT s.*, cu.name AS customer_master FROM sales s
            LEFT JOIN customers cu ON cu.id = s.customer_id WHERE s.id = ?`,
    args: [n(saleId)]
  })
  if (!r.rows.length) throw new Error('Sale not found')
  const row = r.rows[0] as unknown as Row
  await postSaleEntry(
    n(saleId),
    row,
    n(row.amount),
    n(row.gst_amount),
    n(row.round_off),
    n(row.transport_amount),
    n(row.tds_amount)
  )
  return { id: n(saleId), party: String(row.customer_master || row.customer || 'CASH CUSTOMER A/C') }
}

export async function listCustomerLedger(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*, c.name AS customer_name, s.invoice_no
    FROM customer_ledger l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN sales s ON s.id = l.sale_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res)
}

// The unloading desk's own read. A user granted the 'unload' scope on Sales
// gets a deliberately thin row: enough to identify the delivery and record what
// arrived, and NOT ONE MONEY FIELD — no rate, no invoice value, no GST, no
// freight. The restriction is in the SQL rather than in the page, so the
// confidential columns never cross the IPC boundary in the first place.
//
// Rows: FOR deliveries only (an Ex sale is lifted by the customer, so there is
// nothing for this desk to receive) that have not been unloaded yet, and no
// cancelled or trading invoices.
export async function listSalesForUnloadDesk(companyIds?: number[]): Promise<Row[]> {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  const res = await getClient().execute({
    args: cos.length ? [] : [getActiveCompanyId()],
    sql: `
    WITH gate_out AS (
      -- Which gate entry carried each invoice group out. A gate entry names its
      -- group directly, or reaches it through gate_entry_sales when one vehicle
      -- carried several invoices; both are the same question, so they are one
      -- UNION rather than an OR nobody can index.
      SELECT grp, MAX(id) AS ge_id FROM (
        SELECT ge.invoice_group AS grp, ge.id AS id
          FROM gate_entries ge
         WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
        UNION ALL
        SELECT gs.invoice_group AS grp, ge.id AS id
          FROM gate_entry_sales gs
          JOIN gate_entries ge ON ge.id = gs.gate_entry_id AND ge.direction = 'out'
      ) GROUP BY grp
    )
    SELECT s.id, s.invoice_no, s.invoice_group, s.sale_date, s.customer, s.customer_id,
           s.product_id, s.packaging_id, s.qty, s.uom, s.received_qty,
           s.dispatch_stage, s.status, s.freight_term, s.track_stock, s.is_trading,
           s.allowed_shortage_pct, sb.allowed_shortage_pct AS bargain_allowed_shortage_pct,
           s.loaded_date, s.transit_date, s.unloaded_date, s.rejected_at, s.company_id,
           pr.name AS product_name, pr.material_type AS product_category,
           pr.category AS product_sub_category, pk.name AS packaging_name,
           cu.name AS customer_master, co.name AS company_name,
           gv.tanker_no AS gate_vehicle_no
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    LEFT JOIN companies co ON co.id = s.company_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN gate_out go2 ON go2.grp = s.invoice_group
    LEFT JOIN gate_entries gv ON gv.id = go2.ge_id
    WHERE ${cos.length ? `s.company_id IN (${cos.join(',')})` : 's.company_id = ?'}
      AND COALESCE(s.freight_term, 'FREIGHT_ON_GOODS') = 'DLD'
      AND COALESCE(s.dispatch_stage, CASE WHEN s.status = 'done' THEN 'unloaded' ELSE 'pending' END) <> 'unloaded'
      AND s.rejected_at IS NULL
      AND COALESCE(s.is_trading, 0) = 0
    ORDER BY s.sale_date DESC, s.id DESC
  `
  })
  return toPlain(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }))
}

// companyIds is for the readers that have to span companies — the sales-bargain
// register counts every company's dispatch in its balance, so its drilldown has
// to be able to list them all. Left empty (the default) it stays on the active
// company, which is what the invoice screens want.
export async function listSales(companyIds?: number[], forModule?: string): Promise<Row[]> {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const vis = await visibleFromFor('sales', forModule)
  const res = await getClient().execute({
    args: vis
      ? cos.length
        ? [vis]
        : [getActiveCompanyId(), vis]
      : cos.length
        ? []
        : [getActiveCompanyId()],
    sql: `
    WITH gate_out AS (
      -- Which gate entry carried each invoice group out. A gate entry names its
      -- group directly, or reaches it through gate_entry_sales when one vehicle
      -- carried several invoices; both are the same question, so they are one
      -- UNION rather than an OR nobody can index.
      SELECT grp, MAX(id) AS ge_id FROM (
        SELECT ge.invoice_group AS grp, ge.id AS id
          FROM gate_entries ge
         WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
        UNION ALL
        SELECT gs.invoice_group AS grp, ge.id AS id
          FROM gate_entry_sales gs
          JOIN gate_entries ge ON ge.id = gs.gate_entry_id AND ge.direction = 'out'
      ) GROUP BY grp
    )
    SELECT s.*, pr.name AS product_name, pr.material_type AS product_category,
           pr.category AS product_sub_category, sb.bargain_no AS sales_bargain_no,
           -- The allowance falls back invoice -> bargain -> mill default, so
           -- the bargain's figure has to travel with the line.
           sb.allowed_shortage_pct AS bargain_allowed_shortage_pct,
           pk.name AS packaging_name, tr.name AS transporter_name, cu.name AS customer_master,
           co.name AS company_name,
           COALESCE((SELECT SUM(cl.amount) FROM customer_ledger cl
                      WHERE cl.sale_id = s.id AND cl.entry_type = 'payment'), 0) AS received_amount,
           -- The vehicle that actually carried this invoice out, from the
           -- gate register — Gate Out already links to a sale by invoice
           -- group; this is that link read back onto the invoice itself.
           gv.tanker_no AS gate_vehicle_no,
           gv.gate_entry_no AS gate_entry_no,
           gv.status AS gate_status
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN packagings pk ON pk.id = s.packaging_id
    LEFT JOIN transporters tr ON tr.id = s.transporter_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    LEFT JOIN companies co ON co.id = s.company_id
    LEFT JOIN gate_out go2 ON go2.grp = s.invoice_group
    LEFT JOIN gate_entries gv ON gv.id = go2.ge_id
    WHERE ${cos.length ? `s.company_id IN (${cos.join(',')})` : 's.company_id = ?'}${vis ? ' AND s.sale_date >= ?' : ''}
    ORDER BY s.sale_date DESC, s.id DESC
  `
  })
  // Show the customer master's current name when the sale is linked to it.
  return toPlain(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }))
}

// --- sales bargains (rate contracts for finished goods) ---

// "DD-MM" from an ISO date string. e.g. 2025-06-13 -> "13-06".
function dayMonth(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '')
  if (m) return `${m[3]}-${m[2]}`
  const d = new Date(dateStr)
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Which bargain a customer credit note gives its quantity back to. A sales
// return is not guessed from the customer and product — a customer can hold
// several bargains for the same oil and there would be no way to know which one
// the goods left on. It is resolved from what the note already states:
//
//   1. the bargain named on the note itself (the picker on the note form), or
//   2. the ORIGINAL INVOICE the note was raised against — that invoice's own
//      lines say which bargain they drew on, and for which product.
//
// A note that names neither is left unattributed rather than allocated to a
// guess; listUnattributedReturns reports those so they can be pointed at a
// bargain instead of quietly going missing.
const RETURN_MATCH = `(
  nt.bargain_id = b.id
  OR (nt.bargain_id IS NULL
      AND COALESCE(nt.against_ref, '') <> ''
      AND EXISTS (SELECT 1 FROM sales s2
                   WHERE s2.sales_bargain_id = b.id
                     AND s2.product_id = ni.product_id
                     AND TRIM(UPPER(s2.invoice_no)) = TRIM(UPPER(nt.against_ref))))
)`

// SUM of returned quantity for bargain b, over whatever date window is passed.
function returnSum(dateWhere: string, coWhere: string): string {
  return `COALESCE((SELECT SUM(ni.qty)
      FROM notes nt JOIN note_items ni ON ni.note_id = nt.id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       AND ${RETURN_MATCH}${coWhere}${dateWhere}), 0)`
}

// The prefix this company's sales invoices carry, and the next free number.
//
// Typed by hand, a prefix goes wrong in ways a gap report then reports as lost
// bills: "KRFL." with a stray stop, a bare "KRFL", a party name in the field.
// Handing the prefix to the form fixes the class of mistake rather than the
// instances.
//
// Not configured anywhere: it is read from the series the company already
// uses, taking whichever prefix the most invoices carry. A book with a history
// has already decided what its invoices are called, and asking again would only
// invite a second answer.
export async function salesInvoiceSeries(companyId?: number): Promise<Row> {
  const cid = companyId || getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT invoice_no FROM sales
           WHERE company_id = ? AND invoice_no IS NOT NULL AND TRIM(invoice_no) <> ''`,
    args: [cid]
  })
  const count = new Map<string, number>()
  const highest = new Map<string, number>()
  for (const r of toPlain(res)) {
    const m = String(r.invoice_no || '').trim().match(/^(.*?)[/\-]?(\d+)$/)
    if (!m || !m[1]) continue
    // Punctuation and case are noise here: KRFL, KRFL. and krfl are one series,
    // and the tidiest spelling should win rather than the first seen.
    const prefix = m[1].replace(/[/\-]+$/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    count.set(prefix, (count.get(prefix) || 0) + 1)
    const num = Number(m[2])
    if (num > (highest.get(prefix) || 0)) highest.set(prefix, num)
  }
  let prefix = ''
  let best = 0
  for (const [p, c] of count) {
    if (c > best) {
      best = c
      prefix = p
    }
  }
  return {
    company_id: cid,
    prefix,
    highest: prefix ? highest.get(prefix) || 0 : 0,
    // The obvious next one. A suggestion only — a gap being filled in is a
    // perfectly good reason to type something else.
    next: prefix ? (highest.get(prefix) || 0) + 1 : 1,
    invoices: best
  }
}

// Which invoice numbers are missing from the series.
//
// Invoices run KRFL/1 … KRFL/n and KRFIN/1 … KRFIN/n, and a number that was
// never used is a number somebody has to account for — a cancelled bill, a
// spoiled form, or one issued and never keyed. The only way to find them is to
// walk the range and see what is not there.
//
// Bounded by the lowest and highest number actually present, not by 1: a book
// that starts mid-year at 367 has not "missed" 366 invoices, and reporting it
// that way would bury the twenty-five that matter.
//
// A near-miss prefix is called out rather than silently counted as a gap.
// "KRFL." holding 490 while "KRFL" appears to be missing 490 is a typo in one
// invoice, not a lost bill, and the two facts belong together.
export async function salesInvoiceGaps(
  companyId?: number,
  range?: { from?: string; to?: string }
): Promise<Row> {
  const cid = companyId || getActiveCompanyId()
  const conds = ['s.company_id = ?', "s.invoice_no IS NOT NULL", "TRIM(s.invoice_no) <> ''"]
  const args: (string | number)[] = [cid]
  if (range?.from) {
    conds.push('s.sale_date >= ?')
    args.push(range.from)
  }
  if (range?.to) {
    conds.push('s.sale_date <= ?')
    args.push(range.to)
  }
  const res = await getClient().execute({
    sql: `SELECT DISTINCT s.invoice_no, MIN(s.sale_date) AS first_date
            FROM sales s WHERE ${conds.join(' AND ')}
           GROUP BY s.invoice_no ORDER BY s.invoice_no`,
    args
  })

  // Numbers deliberately voided — a spoiled form, a cancelled bill. They are
  // accounted for, so they are not missing; but they are still shown, because
  // "24 missing" and "18 missing, 6 cancelled" are different answers and only
  // the second one can be signed off.
  const voidRes = await getClient().execute({
    sql: `SELECT prefix, number, reason, cancelled_on FROM cancelled_invoice_nos
           WHERE company_id = ? ORDER BY prefix, number`,
    args: [cid]
  })
  const voided = new Map<string, Map<number, Row>>()
  for (const r of toPlain(voidRes)) {
    const pfx = String(r.prefix || '')
    if (!voided.has(pfx)) voided.set(pfx, new Map())
    voided.get(pfx)!.set(n(r.number), r)
  }

  // prefix -> the numbers seen under it, and the date each was first used
  const series = new Map<string, Map<number, string>>()
  const unparsed: string[] = []
  for (const r of toPlain(res)) {
    const inv = String(r.invoice_no || '').trim()
    const m = inv.match(/^(.*?)[/\\-]?(\d+)$/)
    if (!m || !m[1]) {
      unparsed.push(inv)
      continue
    }
    const prefix = m[1].replace(/[/\\-]+$/, '')
    if (!series.has(prefix)) series.set(prefix, new Map())
    series.get(prefix)!.set(Number(m[2]), String(r.first_date || '').slice(0, 10))
  }

  // A prefix differing from another only by punctuation or case is the same
  // series mistyped, so what it holds is NOT missing from the real one.
  const bare = (v: string): string => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const rows: Row[] = []
  for (const [prefix, nums] of series) {
    const keys = [...nums.keys()].sort((a, b) => a - b)
    if (!keys.length) continue
    const lo = keys[0]
    const hi = keys[keys.length - 1]

    // Everything the same series holds, however it was spelled.
    const held = new Set<number>()
    const strays: Row[] = []
    for (const [other, otherNums] of series) {
      if (bare(other) !== bare(prefix)) continue
      for (const k of otherNums.keys()) held.add(k)
      if (other !== prefix) {
        for (const k of otherNums.keys()) strays.push({ number: k, as: `${other}/${k}` })
      }
    }
    // Voided numbers under this series, however the prefix was punctuated.
    const voidHere = new Map<number, Row>()
    for (const [vp, vnums] of voided) {
      if (bare(vp) !== bare(prefix)) continue
      for (const [num, row] of vnums) voidHere.set(num, row)
    }

    const missing = []
    const cancelled: Row[] = []
    for (let i = lo; i <= hi; i++) {
      if (held.has(i)) continue
      const v = voidHere.get(i)
      if (v) {
        cancelled.push({ number: i, reason: v.reason ?? null, cancelled_on: v.cancelled_on ?? null })
        continue
      }
      missing.push(i)
    }

    rows.push({
      prefix,
      used: keys.length,
      cancelled,
      cancelled_count: cancelled.length,
      from: lo,
      to: hi,
      expected: hi - lo + 1,
      missing,
      missing_count: missing.length,
      // Numbers that exist, but keyed under a misspelt prefix — a typo to fix,
      // not a bill to hunt for.
      strays
    })
  }
  // The real series first: a mistyped prefix holding one invoice is not the one
  // anybody came here to read.
  rows.sort((a, b) => n(b.used) - n(a.used))
  return {
    company_id: cid,
    series: rows.filter((r) => n(r.used) > 1 || !rows.some((o) => o !== r && bare(String(o.prefix)) === bare(String(r.prefix)))),
    // Invoice numbers with no number in them at all — a party name typed into
    // the invoice field, most often.
    unparsed
  }
}

export async function listSalesBargains(
  from?: string,
  to?: string,
  companyIds?: number[],
  forModule?: string
): Promise<Row[]> {
  // Sales bargains are GENERAL — shared across every company, like purchase
  // bargains (no company filter; sold sums sales from all companies).
  // Period register fields (relative to [from,to]): disp_before = dispatched
  // before the period, disp_period = dispatched within it, last_dispatch_date =
  // the date the last dispatch happened (used for the "finished this period" rule).
  const f = from || '0000-01-01'
  const t = to || '9999-12-31'
  // Whose dispatches count. Empty = every company, which is the register's
  // default reading; a picked company narrows the figures so they agree with
  // the invoice list shown underneath them.
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  const sCo = cos.length ? ` AND company_id IN (${cos.join(',')})` : ''
  const nCo = cos.length ? ` AND nt.company_id IN (${cos.join(',')})` : ''
  // Bounded to what this user may see. The bound goes in the SQL so the older
  // rows are never fetched; `forModule` lets a page that only borrows this
  // register (Accounts, Treasury) keep its own window instead of this one.
  const vis = await visibleFromFor('salesBargains', forModule)
  const res = await getClient().execute({
    sql: `
    SELECT b.*, pr.name AS product_name, pk.name AS packaging_name, cu.name AS customer_master,
      co.name AS company_name,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id${sCo}), 0) AS sold_qty,
      b.qty - COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id${sCo}), 0)
            + ${returnSum('', nCo)} AS balance_qty,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) < ?${sCo}), 0) AS disp_before,
      COALESCE((SELECT SUM(qty) FROM sales WHERE sales_bargain_id = b.id AND substr(sale_date, 1, 10) >= ? AND substr(sale_date, 1, 10) <= ?${sCo}), 0) AS disp_period,
      (SELECT MAX(substr(sale_date, 1, 10)) FROM sales WHERE sales_bargain_id = b.id${sCo}) AS last_dispatch_date,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) < ?), 0) AS adj_before,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) >= ? AND substr(adj_date, 1, 10) <= ?), 0) AS adj_in,
      COALESCE((SELECT SUM(delta) FROM bargain_adjustments WHERE kind = 'sales' AND bargain_id = b.id AND substr(adj_date, 1, 10) > ?), 0) AS adj_after,
      ${returnSum('', nCo)} AS returned_qty,
      ${returnSum(" AND substr(nt.note_date, 1, 10) < ?", nCo)} AS ret_before,
      ${returnSum(" AND substr(nt.note_date, 1, 10) >= ? AND substr(nt.note_date, 1, 10) <= ?", nCo)} AS ret_in,
      ${returnSum(" AND substr(nt.note_date, 1, 10) > ?", nCo)} AS ret_after
    FROM sales_bargains b
    LEFT JOIN products pr ON pr.id = b.product_id
    LEFT JOIN packagings pk ON pk.id = b.packaging_id
    LEFT JOIN customers cu ON cu.id = b.customer_id
    LEFT JOIN companies co ON co.id = b.company_id
    ${vis ? 'WHERE b.bargain_date >= ?' : ''}
    ORDER BY b.id DESC
  `,
    args: vis ? [f, f, t, f, f, t, t, f, f, t, t, vis] : [f, f, t, f, f, t, t, f, f, t, t]
  })
  // When linked to the master, always show the master's current name (renames
  // propagate); otherwise fall back to the free-text name stored on the bargain.
  return toPlain(res).map((r) => ({ ...r, customer: r.customer_master || r.customer }))
}

// The return lines behind the register's Return figure, so a balance that went
// up can be traced to the note that put it back.
export async function listSalesBargainReturns(companyIds?: number[]): Promise<Row[]> {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  const res = await getClient().execute(`
    SELECT b.id AS bargain_id, nt.id AS note_id, nt.note_no, nt.note_date, nt.against_ref,
           nt.company_id, co.name AS company_name, ni.qty, ni.rate, ni.amount,
           nt.gst_pct,
           -- The registers show a dispatch INCLUDING GST (amount + gst_amount),
           -- so a return has to be stated on the same basis or netting the two
           -- silently drops the tax. note_items.amount is taxable only.
           ROUND(ni.amount * (1 + COALESCE(nt.gst_pct, 0) / 100.0), 2) AS amount_incl,
           p.name AS product_name, nt.bargain_id AS explicit_bargain_id
      FROM notes nt
      JOIN note_items ni ON ni.note_id = nt.id
      JOIN sales_bargains b ON ${RETURN_MATCH}
      LEFT JOIN products p ON p.id = ni.product_id
      LEFT JOIN companies co ON co.id = nt.company_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       ${cos.length ? `AND nt.company_id IN (${cos.join(',')})` : ''}
     ORDER BY nt.note_date, nt.id`)
  return toPlain(res)
}

// Customer credit notes carrying goods that no bargain could be matched to:
// no bargain named on the note, and no original invoice (or one that never drew
// on a bargain). Their quantity is NOT added to any balance, so they are
// reported rather than silently dropped.
export async function listUnattributedReturns(companyIds?: number[]): Promise<Row[]> {
  const cos = (companyIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
  const res = await getClient().execute(`
    SELECT nt.id AS note_id, nt.note_no, nt.note_date, nt.against_ref, nt.company_id,
           cu.name AS customer, ni.qty, p.name AS product_name
      FROM notes nt
      JOIN note_items ni ON ni.note_id = nt.id
      LEFT JOIN customers cu ON cu.id = nt.party_id
      LEFT JOIN products p ON p.id = ni.product_id
     WHERE nt.note_type = 'credit' AND nt.party_type = 'customer'
       ${cos.length ? `AND nt.company_id IN (${cos.join(',')})` : ''}
       AND NOT EXISTS (SELECT 1 FROM sales_bargains b WHERE ${RETURN_MATCH})
     ORDER BY nt.note_date, nt.id`)
  return toPlain(res)
}

// Format: FGCODE/DD-MM/PARTY/SERIAL (mirrors the purchase bargain number).
// FGCODE = finished-good product code; PARTY = customer; SERIAL = continuous.
async function nextSalesBargainNo(
  productId: number,
  customer: string,
  dateStr: string
): Promise<string> {
  const c = getClient()
  const prodRes = await c.execute({
    sql: 'SELECT code, name FROM products WHERE id = ?',
    args: [productId]
  })
  const fg = (
    prodRes.rows.length ? String(prodRes.rows[0].code || prodRes.rows[0].name || 'FG') : 'FG'
  )
    .replace(/\s+/g, '')
    .toUpperCase()
  const party = String(customer || 'PARTY').replace(/\s+/g, '').toUpperCase() || 'PARTY'

  // Serial resets every calendar month, GLOBAL across companies (bargains are
  // general), mirroring purchase bargains.
  const monthKey = String(dateStr).slice(0, 7) // yyyy-mm
  const res = await c.execute({
    sql: 'SELECT bargain_no FROM sales_bargains WHERE substr(bargain_date, 1, 7) = ?',
    args: [monthKey]
  })
  let maxSeq = 0
  for (const r of res.rows) {
    const parts = String(r.bargain_no).split('/')
    const seq = parseInt(parts[parts.length - 1] ?? '0', 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  const serial = String(maxSeq + 1).padStart(2, '0')
  return `${fg}/${dayMonth(dateStr)}/${party}/${serial}`
}

// Quantity already sold against a sales bargain.
async function salesBargainSold(id: number): Promise<number> {
  const r = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ?',
    args: [id]
  })
  return n(r.rows[0]?.q)
}

// Sale-bargain classification (mirrors the purchase-bargain type tabs).
const SALE_CATEGORIES = ['FINISHED_OIL', 'FATTY', 'SCRAP', 'SPENT_EARTH', 'MISC']
function saleCategory(v: unknown): string {
  const s = String(v || '').toUpperCase()
  return SALE_CATEGORIES.includes(s) ? s : 'FINISHED_OIL'
}

// Shared field checks (mirrors the purchase bargain validation).
function validateSalesBargainInput(v: Row): void {
  if (!v.customer || !String(v.customer).trim()) throw new Error('Customer is required')
  if (!v.product_id) throw new Error('Product is required')
  if (n(v.qty) <= 0) throw new Error('Quantity must be greater than zero')
  if (n(v.rate) <= 0) throw new Error('Rate must be greater than zero')
  // A contract cannot expire on or before the day it was struck — a rate that
  // expires the same day was never valid for anything, and one expiring earlier
  // is a typo. Same rule the purchase bargain enforces.
  const struck = String(v.bargain_date || '').slice(0, 10)
  const expires = String(v.rate_expiry_date || '').slice(0, 10)
  if (struck && expires && expires <= struck) {
    throw new Error(
      expires === struck
        ? 'Rate expiry cannot be the same day as the bargain — it has to be after it'
        : 'Rate expiry cannot be before the bargain date'
    )
  }
}

export async function createSalesBargain(v: Row): Promise<{ id: number; bargain_no: string }> {
  validateSalesBargainInput(v)
  const bargain_no = await nextSalesBargainNo(
    n(v.product_id),
    String(v.customer || ''),
    String(v.bargain_date)
  )
  const res = await getClient().execute({
    sql: `INSERT INTO sales_bargains (company_id, bargain_no, manual_bargain_no, bargain_date, customer, customer_id, product_id, qty, uom, rate, rate_expiry_date, status, note, sale_type, sale_category, packaging_id, freight_term, gst_pct, gst_type, allowed_shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      bargain_no,
      v.manual_bargain_no ? String(v.manual_bargain_no).trim() : null,
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n(v.customer_id) : null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      saleCategory(v.sale_category),
      v.packaging_id ? n(v.packaging_id) : null,
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      n(v.gst_pct),
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      shortagePct(v)
    ]
  })
  return { id: Number(res.lastInsertRowid), bargain_no }
}

export async function updateSalesBargain(id: number, v: Row): Promise<{ id: number }> {
  validateSalesBargainInput(v)
  // Once anything is sold against it, the customer and product are locked and
  // the quantity can't drop below what's already been sold.
  const cur = await getClient().execute({
    sql: 'SELECT customer, customer_id, product_id FROM sales_bargains WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Sales bargain not found')
  const sold = await salesBargainSold(id)
  if (sold > 1e-6) {
    // Compare by master id when linked (so a rename isn't seen as a change);
    // fall back to the free-text name for un-linked legacy bargains.
    const curId = n(cur.rows[0].customer_id)
    const newId = n(v.customer_id)
    const changed =
      curId > 0 || newId > 0
        ? curId !== newId
        : String(v.customer || '').trim() !== String(cur.rows[0].customer || '').trim()
    if (changed) {
      throw new Error('Cannot change the customer — this bargain already has sales')
    }
    if (n(v.product_id) !== n(cur.rows[0].product_id)) {
      throw new Error('Cannot change the product — this bargain already has sales')
    }
    if (n(v.qty) < sold - 1e-6) {
      throw new Error(`Quantity cannot be below the ${sold.toFixed(3)} already sold on this bargain`)
    }
  }
  await getClient().execute({
    sql: `UPDATE sales_bargains SET bargain_date = ?, customer = ?, customer_id = ?, product_id = ?, qty = ?, uom = ?,
          rate = ?, rate_expiry_date = ?, note = ?, sale_type = ?, sale_category = ?, packaging_id = ?, freight_term = ?, gst_pct = ?, gst_type = ?, manual_bargain_no = ?, allowed_shortage_pct = ? WHERE id = ?`,
    args: [
      v.bargain_date,
      v.customer || null,
      v.customer_id ? n(v.customer_id) : null,
      n(v.product_id),
      n(v.qty),
      v.uom || 'MT',
      n(v.rate),
      v.rate_expiry_date || null,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      saleCategory(v.sale_category),
      v.packaging_id ? n(v.packaging_id) : null,
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      n(v.gst_pct),
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      v.manual_bargain_no ? String(v.manual_bargain_no).trim() : null,
      shortagePct(v),
      id
    ]
  })
  return { id }
}

export async function deleteSalesBargain(id: number): Promise<{ id: number }> {
  if ((await salesBargainSold(id)) > 1e-6) {
    throw new Error('This sales bargain has sales linked to it. Delete those sales first.')
  }
  await getClient().execute({ sql: 'DELETE FROM sales_bargains WHERE id = ?', args: [id] })
  return { id }
}

// Add to (delta > 0) or remove from (delta < 0) a sales bargain's quantity,
// moving its open balance by the same amount. Can't drop below what's sold.
export async function adjustSalesBargainQty(
  id: number,
  delta: number,
  note?: string,
  date?: string
): Promise<{ id: number; qty: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM sales_bargains WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Sales bargain not found')
  const b = toPlain(res)[0]
  const d = Number(delta) || 0
  if (d === 0) throw new Error('Enter a quantity to add or remove')
  // Rounded to the same 3 decimals qty is stored at — sold is a SUM() over
  // many dispatch rows and can carry residue past that (6.7034999...), which
  // a 1e-6 tolerance is too tight to absorb and refuses a square-off to
  // exactly what the screen already shows as fully sold.
  const sold = Math.round((await salesBargainSold(id)) * 1000) / 1000
  const newQty = Math.round((n(b.qty) + d) * 1000) / 1000
  // Zeroing out a bargain that is otherwise fully drawn is a legitimate
  // square-off, not an error — only a genuinely negative result is refused.
  if (newQty < -1e-9) throw new Error('The resulting quantity cannot go below zero')
  if (newQty < sold - 1e-6) {
    throw new Error(`Cannot remove below the ${sold.toFixed(3)} already sold on this bargain`)
  }
  const newNote = note ? `${b.note ? String(b.note) + '\n' : ''}${String(note).trim()}` : b.note
  await c.execute({
    sql: 'UPDATE sales_bargains SET qty = ?, note = ? WHERE id = ?',
    args: [newQty, newNote || null, id]
  })
  // Dated log so the top-up shows under "Addition" for its month in the register.
  const adjDate = (date && String(date).slice(0, 10)) || todayISO()
  await c.execute({
    sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note) VALUES ('sales', ?, ?, ?, ?)",
    args: [id, d, adjDate, note ? String(note).trim() : null]
  })
  return { id, qty: newQty }
}

// Balance available on a sales bargain for a (possibly editing) sale.
async function salesBargainBalanceFor(bargainId: number, excludeSaleId: number): Promise<number> {
  const c = getClient()
  const b = await c.execute({ sql: 'SELECT qty FROM sales_bargains WHERE id = ?', args: [bargainId] })
  if (!b.rows.length) return Infinity
  const sold = await c.execute({
    sql: 'SELECT COALESCE(SUM(qty), 0) AS q FROM sales WHERE sales_bargain_id = ? AND id != ?',
    args: [bargainId, excludeSaleId || 0]
  })
  // Returned goods are back in our hands, so the bargain has room for them
  // again — the register says so, and this check has to agree or a quantity
  // shown as available would be refused on the invoice.
  const ret = await c.execute({
    sql: `SELECT COALESCE(SUM(ni.qty), 0) AS q
            FROM notes nt JOIN note_items ni ON ni.note_id = nt.id
            JOIN sales_bargains b ON b.id = ?
           WHERE nt.note_type = 'credit' AND nt.party_type = 'customer' AND ${RETURN_MATCH}`,
    args: [bargainId]
  })
  return n(b.rows[0].qty) - n(sold.rows[0]?.q) + n(ret.rows[0]?.q)
}

// Convert a quantity between units of the SAME dimension (mass or volume).
// Mismatched dimensions (e.g. L → MT, which needs density) are left as-is.
const UNIT_FACTOR: Record<string, { dim: 'mass' | 'vol'; f: number }> = {
  KG: { dim: 'mass', f: 1 },
  QUINTAL: { dim: 'mass', f: 100 },
  MT: { dim: 'mass', f: 1000 },
  TON: { dim: 'mass', f: 1000 },
  ML: { dim: 'vol', f: 0.001 },
  L: { dim: 'vol', f: 1 },
  KL: { dim: 'vol', f: 1000 }
}
export function convertQty(qty: number, from: string, to: string): number {
  const a = UNIT_FACTOR[String(from || '').toUpperCase()]
  const b = UNIT_FACTOR[String(to || '').toUpperCase()]
  if (!a || !b || a.dim !== b.dim) return qty
  return (qty * a.f) / b.f
}

// Base quantity a sale actually draws from stock, IN THE SALE/BARGAIN UNIT. For
// PACKED sales the packaging nesting (boxes × pouches_per_box × base_per_pouch
// + loose pouches × base_per_pouch) is computed in the packaging's base unit,
// then converted to the sale unit (e.g. 1000 cases × 15 KG = 15,000 KG = 15 MT).
// The value of one sale line. A PACKED line is priced on the cases it carries
// (rate_per_case x cases-equivalent, so a part box counts as its fraction) —
// never on the MT figure, because converting a case weight to MT is not always
// exact and the error lands straight on the money. Everything else is
// rate x quantity as before.
//
// Falls back to qty x rate when no per-case rate came in, so a line saved
// before this existed keeps valuing exactly as it did.
async function resolveSaleAmount(v: Row, qty: number, rate: number): Promise<number> {
  const perCase = n(v.rate_per_case)
  if (String(v.sale_type) !== 'PACKED' || !v.packaging_id || perCase <= 0) return qty * rate
  const p = await getClient().execute({
    sql: 'SELECT pouches_per_box, base_per_pouch FROM packagings WHERE id = ?',
    args: [n(v.packaging_id)]
  })
  if (!p.rows.length) return qty * rate
  const ppb = n(p.rows[0].pouches_per_box)
  const bpp = n(p.rows[0].base_per_pouch)
  if (ppb <= 0 || bpp <= 0) return qty * rate
  // Cases, plus any loose pouches as their fraction of a case.
  const cases = n(v.boxes) + n(v.pouches) / ppb
  return round2(cases * perCase)
}

async function resolveSaleQty(v: Row): Promise<{ qty: number; uom: string }> {
  // The sale's unit follows its bargain (falls back to the entered uom, then MT).
  let target = String(v.uom || '').trim()
  if (v.sales_bargain_id) {
    const b = await getClient().execute({
      sql: 'SELECT uom FROM sales_bargains WHERE id = ?',
      args: [n(v.sales_bargain_id)]
    })
    if (b.rows.length && b.rows[0].uom) target = String(b.rows[0].uom)
  }
  if (!target) target = 'MT'

  if (String(v.sale_type) === 'PACKED' && v.packaging_id) {
    const p = await getClient().execute({
      sql: 'SELECT pouches_per_box, base_per_pouch, base_uom FROM packagings WHERE id = ?',
      args: [n(v.packaging_id)]
    })
    if (p.rows.length) {
      const ppb = n(p.rows[0].pouches_per_box)
      const bpp = n(p.rows[0].base_per_pouch)
      const baseUom = String(p.rows[0].base_uom || 'KG')
      const baseQty = n(v.boxes) * ppb * bpp + n(v.pouches) * bpp
      const qty = Math.round(convertQty(baseQty, baseUom, target) * 1e6) / 1e6
      return { qty, uom: target }
    }
  }
  return { qty: n(v.qty), uom: target }
}

// Freight is billed per the unit the transporter actually charges against —
// per CASE for a packed dispatch, per TONNE (the resolved sale qty) for a
// loose one — not the tonnage-equivalent quantity resolveSaleQty resolves
// for stock-drawing purposes (1000 cases of 15kg reads as 15 MT there, but
// the transporter's rate is quoted per case, not per those 15 MT).
// The quantity the transporter is paid on. Loose oil is billed on what the
// customer actually took in (received_qty, captured when the invoice is marked
// Unloaded) rather than what left the gate — the client's rule, and the same
// basis the purchase side uses. Until it is weighed in, the dispatched qty
// stands in, so freight is never understated while a tanker is in transit.
async function resolveFreightQty(v: Row, qty: number): Promise<number> {
  if (String(v.sale_type) === 'PACKED' && v.packaging_id) {
    const p = await getClient().execute({
      sql: 'SELECT pouches_per_box FROM packagings WHERE id = ?',
      args: [n(v.packaging_id)]
    })
    const ppb = p.rows.length ? n(p.rows[0].pouches_per_box) : 0
    const boxes = n(v.boxes)
    const pouches = n(v.pouches)
    return ppb > 0 ? boxes + pouches / ppb : boxes
  }
  return v.received_qty != null && n(v.received_qty) > 0 ? n(v.received_qty) : qty
}

// Blank means "no override" and must stay NULL, so the invoice keeps falling
// back to its bargain and then to the mill-wide default. A typed 0 is a real
// answer -- no tolerance at all -- and is not the same thing.
function shortagePct(v: Row): number | null {
  return v.allowed_shortage_pct != null && v.allowed_shortage_pct !== ''
    ? Number(v.allowed_shortage_pct)
    : null
}

// A shortage beyond the agreed tolerance on a delivered load, as a debit note
// against the transporter.
//
// Mirrors advancePurchaseTanker on the buying side down to the entry type, so
// one rule produces one kind of row whichever direction the tanker was
// travelling — and the Freight Working register, which already reads
// 'shortage_penalty' rows, picks it up on the outward side with no change.
//
// Negative, because it is money coming BACK off what the transporter is owed:
// their freight line and this debit note sit under the same bill, and the bill
// nets to what is actually payable.
async function postSaleShortageDebit(saleId: number): Promise<number> {
  const c = getClient()
  await c.execute({
    sql: "DELETE FROM transporter_ledger WHERE sale_id = ? AND entry_type = 'shortage_penalty'",
    args: [saleId]
  })
  const r = await c.execute({
    sql: `SELECT s.*, sb.allowed_shortage_pct AS bargain_allowed_shortage_pct
            FROM sales s LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
           WHERE s.id = ?`,
    args: [saleId]
  })
  if (!r.rows.length) return 0
  const row = r.rows[0] as unknown as Row

  // Only a delivered load that we carried and have actually weighed in.
  if (String(row.freight_term) !== 'DLD') return 0
  if (row.received_qty == null) return 0
  if (n(row.is_trading) === 1) return 0
  const transporterId = row.transporter_id ? n(row.transporter_id) : null
  if (!transporterId) return 0
  // The customer settling the truck directly means we hold no transporter
  // ledger for this delivery, so there is nothing to debit — the same reason
  // the freight itself is not posted.
  if (n(row.deduct_freight) === 1) return 0

  const dispatched = n(row.qty)
  if (dispatched <= 0) return 0
  const pct = await allowedShortagePct(row)
  const shortage = Math.max(0, dispatched - n(row.received_qty))
  const excess = Math.max(0, shortage - (dispatched * pct) / 100)
  const charge = round2(excess * n(row.rate))
  if (charge <= 0.004) return 0

  await c.execute({
    sql: `INSERT INTO transporter_ledger (transporter_id, sale_id, entry_date, entry_type, amount, note, company_id)
          VALUES (?, ?, ?, 'shortage_penalty', ?, ?, ?)`,
    args: [
      transporterId,
      saleId,
      row.unloaded_date || row.sale_date || null,
      -charge,
      `Oil shortage ${excess.toFixed(3)} ${String(row.uom || '')} beyond ${pct}% tolerance`,
      n(row.company_id) || getActiveCompanyId()
    ]
  })
  return charge
}

// Invoice first, then its rate contract, then the mill-wide default. A blank
// is "not answered here" and passes the question up; a stored 0 is an answer.
async function allowedShortagePct(row: Row): Promise<number> {
  if (row.allowed_shortage_pct != null && row.allowed_shortage_pct !== '') return n(row.allowed_shortage_pct)
  if (row.bargain_allowed_shortage_pct != null && row.bargain_allowed_shortage_pct !== '') {
    return n(row.bargain_allowed_shortage_pct)
  }
  return n((await getSetting('allowed_shortage_pct')) ?? '0')
}

// DLD deliveries: we manage the transporter, so post the freight to the
// transporter ledger (we owe them) and recover it from the customer (they owe
// us). Freight-on-goods deliveries post nothing. Replaces any prior entries.
async function postSaleFreight(saleId: number, v: Row, qty: number): Promise<number> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE sale_id = ?', args: [saleId] })
  await c.execute({ sql: "DELETE FROM customer_ledger WHERE sale_id = ? AND entry_type = 'freight'", args: [saleId] })
  if (String(v.freight_term) !== 'DLD') return 0
  const transporterId = v.transporter_id ? n(v.transporter_id) : null
  // Same basis as the invoice's own figure: rate x the qty resolved by
  // resolveFreightQty (received once unloaded, dispatched until then).
  const amount = n(v.transport_rate) > 0 ? round2(qty * n(v.transport_rate)) : n(v.transport_amount)
  if (!transporterId || amount <= 0) return amount > 0 ? amount : 0
  const companyId = getActiveCompanyId()
  // Deducted from the invoice = the customer settles the truck, so this freight
  // is NOT ours to pay: no transporter-ledger row, and nothing for it to reach
  // the Freight Outward Working register with. The sale voucher still carries
  // the cost (Dr FREIGHT OUTWARD) and the customer's bill is already net of it.
  if (v.deduct_freight) return amount
  await c.execute({
    // accrued = 1: the sale voucher already carried Dr FREIGHT OUTWARD /
    // Cr FREIGHT PAYABLE for this, so the transporter's bill must debit the
    // payable rather than book the expense a second time.
    sql: `INSERT INTO transporter_ledger (transporter_id, sale_id, entry_date, entry_type, amount, note, company_id, accrued)
          VALUES (?, ?, ?, 'freight', ?, 'Delivery freight', ?, 1)`,
    args: [transporterId, saleId, v.sale_date, amount, companyId]
  })
  // Freight recovered from the customer, on top of the goods value.
  const customerId = v.customer_id ? n(v.customer_id) : null
  if (customerId) {
    await c.execute({
      sql: `INSERT INTO customer_ledger (customer_id, sale_id, entry_date, entry_type, amount, note, company_id)
            VALUES (?, ?, ?, 'freight', ?, 'Delivery freight recovered', ?)`,
      args: [customerId, saleId, v.sale_date, -Math.abs(amount), companyId]
    })
  }
  return amount
}

export async function createSale(v: Row): Promise<{ id: number }> {
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select a product')
  // One invoice number, one invoice — though an invoice may of course run to
  // several products, and each of those is a row of its own sharing this
  // group, so lines of the same invoice are not rivals. Trading sales come
  // through here as well, line by line and with no group, each counting as an
  // invoice in its own right.
  await assertSalesInvoiceNoFree(v, getActiveCompanyId(), undefined, !!v.invoice_no_grandfathered)
  const { qty, uom } = await resolveSaleQty(v)
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const rate = n(v.rate)
  if (rate < 0) throw new Error('Rate cannot be negative')
  const amount = await resolveSaleAmount(v, qty, rate)
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  // Invoice-level round off (carried on the first line of the group only).
  const roundOff = Math.round((n(v.round_off) || 0) * 100) / 100
  const customerId = v.customer_id ? n(v.customer_id) : null
  // TDS the customer withholds, charged on the invoice total like the purchase
  // side and applied on the customer master's slab terms. With no rate set it
  // is 0, so the receivable is unchanged for a sale that carries no TDS.
  const tdsPct = await resolveTdsPct(v, customerId)
  const tdsAmount = await saleTds(customerId, tdsPct, amount, String(v.sale_date), 0)
  const net = amount + gstAmount + roundOff - tdsAmount
  // Can't dispatch more than the chosen sales bargain still has open.
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), 0)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  // Ex (customer lifts): there is no delivery journey to track — the goods
  // leave with the customer at invoicing, so the sale books straight to Done,
  // stamped with the sale date.
  const exTerm = v.freight_term !== 'DLD'
  const stage: DispatchStage = exTerm ? 'unloaded' : stageOf(v)
  const status = statusForStage(stage)
  const dates = resolveStageDates(stage, v, (exTerm && String(v.sale_date || '')) || todayLocal())
  // A finished good WITH a formulation is made-to-order: dispatching it consumes
  // the recipe's raw/intermediate inputs (via a linked auto-production), not
  // finished stock. Without a formulation it draws finished stock as before.
  // Trading: bought from one party and resold straight to another — no
  // formulation draw, no stock guard, and (affects_stock, below) never counted
  // in stock at all, on either the purchase or the sale side.
  const isTrading = !!v.is_trading
  // Off-stock: dispatch is allowed without booking stock only when explicitly
  // forced (confirmed in the UI) or the sale is a Trading pass-through. Such a
  // sale is not stock-tracked.
  const trackStock = isTrading || (isDispatched(stage) && v.force_no_stock) ? 0 : 1
  // A dispatch draws FINISHED stock, whatever the product's recipe says.
  //
  // It used to check the recipe's raw inputs instead and then post a production
  // run of its own to cover the sale. That run consumed the inputs and produced
  // the dispatched quantity, so the finished side always netted to nothing and
  // the shortage moved onto the raw materials — where it had no receipt behind
  // it and simply went negative. IVF reached -532.7 MT that way, and RPO raw
  // -291.5, without a single real batch being entered.
  //
  // Production is a thing that happens on the floor and gets recorded. A sale
  // cannot manufacture it. So the guard is now the same one every other product
  // gets: is there any of this to send? If not, say so — and let the user
  // dispatch off-stock deliberately if that is really what they mean.
  if (isDispatched(stage) && !isTrading && trackStock === 1) {
    await assertFinishedStock(productId, qty, await productLabel(productId))
  }
  const freightQty = await resolveFreightQty(v, qty)
  // FOR freight is received qty x rate, always recomputed from the rate rather
  // than trusting a stored total — the total has to move when the invoice is
  // unloaded and the real received qty replaces the dispatched one. A lump-sum
  // freight (no rate) still stands on its stored amount.
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_rate) > 0 ? round2(freightQty * n(v.transport_rate)) : n(v.transport_amount))
    : 0
  const res = await getClient().execute({
    sql: `INSERT INTO sales (company_id, sale_date, invoice_no, invoice_group, customer, customer_id, product_id, sales_bargain_id,
            qty, uom, rate, amount, gst_pct, gst_amount, gst_type, round_off, round_off_manual, tds_pct, tds_amount, status, dispatch_stage, track_stock, loaded_date, transit_date, unloaded_date, note, sale_type, packaging_id, boxes, pouches, freight_term,
            transporter_id, transport_rate, transport_amount, is_trading, affects_stock, deduct_freight, rate_per_case,
            allowed_shortage_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      getActiveCompanyId(),
      v.sale_date,
      v.invoice_no || null,
      v.invoice_group || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      roundOff,
      v.round_off_manual ? 1 : 0,
      tdsPct,
      tdsAmount,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      n(v.boxes),
      n(v.pouches),
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      v.transporter_id ? n(v.transporter_id) : null,
      n(v.transport_rate),
      transportAmount,
      isTrading ? 1 : 0,
      isTrading ? 0 : 1,
      v.deduct_freight ? 1 : 0,
      n(v.rate_per_case) > 0 ? round2(n(v.rate_per_case)) : null,
      shortagePct(v)
    ]
  })
  const id = Number(res.lastInsertRowid)
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount, roundOff, transportAmount, tdsAmount)
  await postSaleFreight(id, v, freightQty)
  await postSaleShortageDebit(id)
  return { id }
}

export async function updateSale(id: number, v: Row): Promise<{ id: number }> {
  const productId = n(v.product_id)
  if (!productId) throw new Error('Select a product')
  {
    // Against the company and the invoice this row is actually filed under —
    // updateSale is handed the header's fields, which do not carry either.
    const own = await getClient().execute({
      sql: 'SELECT company_id, invoice_group FROM sales WHERE id = ? LIMIT 1',
      args: [id]
    })
    const cid = n(own.rows[0]?.company_id) || getActiveCompanyId()
    const grp = v.invoice_group || own.rows[0]?.invoice_group || null
    await assertSalesInvoiceNoFree({ ...v, invoice_group: grp }, cid, id, !!v.invoice_no_grandfathered)
  }
  const { qty, uom } = await resolveSaleQty(v)
  if (qty <= 0) throw new Error('Quantity must be greater than zero')
  const rate = n(v.rate)
  if (rate < 0) throw new Error('Rate cannot be negative')
  const amount = await resolveSaleAmount(v, qty, rate)
  const gstPct = n(v.gst_pct)
  const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
  // Invoice-level round off (carried on the first line of the group only).
  const roundOff = Math.round((n(v.round_off) || 0) * 100) / 100
  const customerId = v.customer_id ? n(v.customer_id) : null
  // TDS the customer withholds — see createSale. This sale is left out of its
  // own prior-billed figure so re-saving cannot inflate the slab.
  const tdsPct = n(v.tds_pct)
  const tdsAmount = await saleTds(customerId, tdsPct, amount, String(v.sale_date), id)
  const net = amount + gstAmount + roundOff - tdsAmount
  if (v.sales_bargain_id) {
    const bal = await salesBargainBalanceFor(n(v.sales_bargain_id), id)
    if (qty > bal + 1e-6) {
      throw new Error(`Sale qty exceeds the sales bargain balance (${bal.toFixed(3)})`)
    }
  }
  // Ex (customer lifts): there is no delivery journey to track — the goods
  // leave with the customer at invoicing, so the sale books straight to Done,
  // stamped with the sale date.
  const exTerm = v.freight_term !== 'DLD'
  const stage: DispatchStage = exTerm ? 'unloaded' : stageOf(v)
  const status = statusForStage(stage)
  const dates = resolveStageDates(stage, v, (exTerm && String(v.sale_date || '')) || todayLocal())
  const isTrading = !!v.is_trading
  // Keeping or putting this sale in a dispatched stage must be backed by
  // FINISHED stock — see the note in createSale on why a recipe no longer
  // stands in for it — unless explicitly forced off-stock, or it is a Trading
  // pass-through.
  const trackStock = isTrading || (isDispatched(stage) && v.force_no_stock) ? 0 : 1
  if (isDispatched(stage) && !isTrading && trackStock === 1) {
    await assertFinishedStock(productId, qty, await productLabel(productId), id)
  }
  const freightQty = await resolveFreightQty(v, qty)
  // FOR freight is received qty x rate, always recomputed from the rate rather
  // than trusting a stored total — the total has to move when the invoice is
  // unloaded and the real received qty replaces the dispatched one. A lump-sum
  // freight (no rate) still stands on its stored amount.
  const transportAmount = String(v.freight_term) === 'DLD'
    ? (n(v.transport_rate) > 0 ? round2(freightQty * n(v.transport_rate)) : n(v.transport_amount))
    : 0
  await getClient().execute({
    sql: `UPDATE sales SET sale_date = ?, invoice_no = ?, customer = ?, customer_id = ?, product_id = ?, sales_bargain_id = ?,
          qty = ?, uom = ?, rate = ?, amount = ?, gst_pct = ?, gst_amount = ?, gst_type = ?, round_off = ?, round_off_manual = ?, tds_pct = ?, tds_amount = ?, status = ?, dispatch_stage = ?, track_stock = ?, loaded_date = ?, transit_date = ?, unloaded_date = ?, note = ?, sale_type = ?, packaging_id = ?, boxes = ?,
          pouches = ?, freight_term = ?, transporter_id = ?, transport_rate = ?, transport_amount = ?, deduct_freight = ?,
          rate_per_case = ?, allowed_shortage_pct = ? WHERE id = ?`,
    args: [
      v.sale_date,
      v.invoice_no || null,
      v.customer || null,
      customerId,
      n(v.product_id),
      v.sales_bargain_id ? n(v.sales_bargain_id) : null,
      qty,
      uom,
      rate,
      amount,
      gstPct,
      gstAmount,
      v.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST',
      roundOff,
      v.round_off_manual ? 1 : 0,
      tdsPct,
      tdsAmount,
      status,
      stage,
      trackStock,
      dates.loaded_date,
      dates.transit_date,
      dates.unloaded_date,
      v.note || null,
      v.sale_type === 'PACKED' ? 'PACKED' : 'LOOSE',
      v.packaging_id ? n(v.packaging_id) : null,
      n(v.boxes),
      n(v.pouches),
      v.freight_term === 'DLD' ? 'DLD' : 'FREIGHT_ON_GOODS',
      v.transporter_id ? n(v.transporter_id) : null,
      n(v.transport_rate),
      transportAmount,
      v.deduct_freight ? 1 : 0,
      n(v.rate_per_case) > 0 ? round2(n(v.rate_per_case)) : null,
      shortagePct(v),
      id
    ]
  })
  // Sales no longer post production of their own. Any auto-production an
  // earlier version left against this sale is removed as it is re-saved, so
  // editing an old invoice cleans up after that behaviour rather than
  // preserving it.
  await deleteSaleProductions(id)
  await postCustomerReceivable(id, customerId, net, String(v.sale_date))
  await postSaleEntry(id, v, amount, gstAmount, roundOff, transportAmount, tdsAmount)
  await postSaleFreight(id, v, freightQty)
  await postSaleShortageDebit(id)
  return { id }
}

// Move a dispatch through its stages (pending → loaded → transit → unloaded).
// Advancing from pending into any dispatched stage draws finished stock (guarded);
// dropping back to pending releases it. Moving between dispatched stages is free.
// Re-strike a FOR sale's freight from its own row, after something other than
// an invoice edit changed the quantity it is priced on.
async function recomputeSaleFreight(id: number): Promise<void> {
  const c = getClient()
  const r = await c.execute({ sql: 'SELECT * FROM sales WHERE id = ?', args: [id] })
  if (!r.rows.length) return
  const row = r.rows[0] as unknown as Row
  // First, and unconditionally: this runs when the weighed-in quantity has just
  // changed, which moves the shortage whether or not it moves the freight —
  // and on a delivery with no freight rate at all it moves ONLY the shortage,
  // which the early return below would otherwise skip entirely.
  await postSaleShortageDebit(id)
  if (String(row.freight_term) !== 'DLD' || n(row.transport_rate) <= 0) return
  const qty = await resolveFreightQty(row, n(row.qty))
  const amount = round2(qty * n(row.transport_rate))
  if (Math.abs(amount - n(row.transport_amount)) < 0.005) return
  await c.execute({ sql: 'UPDATE sales SET transport_amount = ? WHERE id = ?', args: [amount, id] })
  await postSaleFreight(id, { ...row, transport_amount: amount }, qty)
  // The sale voucher carries the freight leg, so it has to be re-posted too or
  // FREIGHT OUTWARD / FREIGHT PAYABLE would keep the old figure.
  await postSaleEntry(
    id,
    { ...row, transport_amount: amount },
    n(row.amount),
    n(row.gst_amount),
    n(row.round_off),
    amount,
    // Carried through, or re-striking the freight would silently drop the
    // TDS leg and put the whole invoice back on the customer.
    n(row.tds_amount)
  )
}

export async function setSaleStage(
  id: number,
  stageIn: string,
  force = false,
  dateIn?: string,
  // Weighed in at the customer's end. Only meaningful on Unloaded; anything
  // earlier clears it, so stepping a stage back never leaves a stale figure.
  receivedQty?: number | null
): Promise<{ id: number }> {
  const stage = stageOf({ dispatch_stage: stageIn })
  const status = statusForStage(stage)
  const r = await getClient().execute({
    sql: 'SELECT product_id, qty, uom, status, track_stock, loaded_date, transit_date, unloaded_date, received_qty FROM sales WHERE id = ?',
    args: [id]
  })
  if (!r.rows.length) throw new Error('Sale not found')
  const row = r.rows[0]
  const pid = n(row.product_id)
  const saleQty = n(row.qty)
  const wasDispatched = String(row.status) === 'done'
  let trackStock = n(row.track_stock)
  if (!isDispatched(stage)) {
    // Back to pending → release stock and re-enable tracking for next time.
    trackStock = 1
  } else if (!wasDispatched) {
    // Dispatching now: force → off-stock; otherwise there has to be finished
    // stock to send, recipe or no recipe.
    trackStock = force ? 0 : 1
    if (trackStock === 1) {
      await assertFinishedStock(pid, saleQty, await productLabel(pid), id)
    }
  }
  // Stamp the reached stage's date (carrying earlier ones, clearing later ones).
  const dates = resolveStageDates(stage, row as unknown as Record<string, unknown>, dateIn || todayLocal())
  // Keep whatever was already recorded when the caller says nothing, so an
  // unrelated re-save of the same stage does not wipe it.
  const recQty =
    stage !== 'unloaded' ? null : receivedQty === undefined ? (row.received_qty == null ? null : n(row.received_qty)) : receivedQty
  await getClient().execute({
    sql: `UPDATE sales SET status = ?, dispatch_stage = ?, track_stock = ?,
            loaded_date = ?, transit_date = ?, unloaded_date = ?, received_qty = ? WHERE id = ?`,
    args: [status, stage, trackStock, dates.loaded_date, dates.transit_date, dates.unloaded_date, recQty, id]
  })
  // The freight is priced on what arrived, so the moment a received qty is
  // recorded the FOR freight has to be re-struck and re-posted — otherwise the
  // transporter would stay billed on the dispatched quantity. Nothing to do for
  // a lump-sum freight (no rate) or an Ex sale.
  await recomputeSaleFreight(id)
  // As in updateSale: no production is posted from here any more, and a legacy
  // auto row against this sale is cleared as the sale moves.
  await deleteSaleProductions(id)
  return { id }
}

// Backwards-compatible status toggle (pending/done) — maps done → unloaded.
export async function setSaleStatus(id: number, status: string): Promise<{ id: number }> {
  return setSaleStage(id, status === 'done' ? 'unloaded' : 'pending')
}

export async function deleteSale(id: number): Promise<{ id: number }> {
  const c = getClient()
  // Reverse the linked auto-production first (releases the raw it consumed).
  await deleteSaleProductions(id)
  // The invoice's voucher is filed under its first line. Removing that line
  // from a multi-line invoice must HAND THE VOUCHER ON to a surviving line,
  // not take it down — dropping it and posting a fresh one would give the
  // invoice a new number and shift every voucher after it. Only when the last
  // line goes does the voucher go with it.
  const own = await c.execute({ sql: 'SELECT invoice_group FROM sales WHERE id = ?', args: [id] })
  const grp = own.rows[0] ? (own.rows[0] as unknown as Row).invoice_group : null
  let survivor = 0
  if (grp) {
    const rest = await c.execute({
      sql: 'SELECT id FROM sales WHERE invoice_group = ? AND id != ? ORDER BY id LIMIT 1',
      args: [String(grp), id]
    })
    survivor = rest.rows.length ? n((rest.rows[0] as unknown as Row).id) : 0
  }
  if (survivor) {
    await c.execute({ sql: 'UPDATE journal_entries SET sale_id = ? WHERE sale_id = ?', args: [survivor, id] })
  } else {
    await deleteJournalByRef('sale_id', id)
  }
  await c.execute({ sql: 'DELETE FROM payment_allocations WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM customer_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE sale_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM sales WHERE id = ?', args: [id] })
  // What is left of the invoice is re-posted, so the voucher it kept now
  // states the reduced bill rather than the one that included this line.
  if (survivor) {
    await postSaleInvoiceJournal(survivor).catch((e) =>
      console.error('[journal] invoice re-post after line delete failed:', (e as Error).message)
    )
  }
  return { id }
}

// --- multi-item sale invoices ---
// An invoice is one or more line items (each a sales row) sharing an
// invoice_group plus a common header (date, invoice no, customer, freight,
// dispatch stage). Each item is created through createSale so all the per-line
// guards (stock, bargain balance, packaging conversion, GST, journal, ledger)
// still apply.

let invoiceSeq = 0
function newInvoiceGroup(): string {
  invoiceSeq += 1
  return `INV-${Date.now().toString(36)}-${invoiceSeq}`
}

// Merge the shared invoice header onto each line item.
function mergeInvoiceItem(header: Row, item: Row, group: string): Row {
  return {
    ...item,
    invoice_group: group,
    sale_date: header.sale_date,
    invoice_no: header.invoice_no,
    customer: header.customer,
    customer_id: header.customer_id,
    freight_term: header.freight_term,
    transporter_id: header.transporter_id,
    transport_rate: header.transport_rate,
    dispatch_stage: header.dispatch_stage,
    loaded_date: header.loaded_date,
    transit_date: header.transit_date,
    unloaded_date: header.unloaded_date,
    force_no_stock: header.force_no_stock,
    is_trading: header.is_trading,
    deduct_freight: header.deduct_freight,
    // Agreed for the whole delivery, not per line — one tanker, one tolerance.
    allowed_shortage_pct: header.allowed_shortage_pct
  }
}

export async function createSaleInvoice(v: Row): Promise<{ group: string; ids: number[] }> {
  const items: Row[] = Array.isArray(v.items) ? v.items : []
  if (!items.length) throw new Error('Add at least one item to the invoice')
  const group = newInvoiceGroup()
  const ids: number[] = []
  for (let i = 0; i < items.length; i++) {
    // Invoice-level round off rides on the FIRST line only (others 0).
    const res = await createSale({ ...mergeInvoiceItem(v, items[i], group), round_off: i === 0 ? v.round_off : 0, round_off_manual: i === 0 ? v.round_off_manual : 0 })
    ids.push(res.id)
  }
  return { group, ids }
}

// Edit an invoice: reverse its existing lines and recreate from the new set
// (keeps the same group). Simpler and always consistent versus diffing.
export async function updateSaleInvoice(group: string, v: Row): Promise<{ group: string; ids: number[] }> {
  const items: Row[] = Array.isArray(v.items) ? v.items : []
  if (!items.length) throw new Error('Add at least one item to the invoice')
  const existing = await getClient().execute({
    sql: 'SELECT id, product_id, packaging_id, received_qty, invoice_no FROM sales WHERE invoice_group = ? ORDER BY id',
    args: [group]
  })
  // This edit works by deleting every line and building them again, so by the
  // time they are re-created the originals are gone. A number the invoice has
  // held all along would then read as a stranger's — unless we look first and
  // say so. Only an UNCHANGED number is waved through; changing it to one
  // another invoice holds is still refused.
  const heldBefore = String(existing.rows[0]?.invoice_no || '').trim().toUpperCase()
  const keepsItsNumber = !!heldBefore && heldBefore === String(v.invoice_no || '').trim().toUpperCase()
  // What the customer's weighbridge said is a MEASUREMENT, not something the
  // invoice form holds — and this function works by deleting every line and
  // building it again, so without carrying it across, editing a delivered
  // invoice threw it away. The freight then silently went back to being priced
  // on the dispatched quantity and any shortage with it.
  //
  // Matched back by product (and packaging, since one product can go out in two
  // pack sizes), first-come, so re-ordering the lines cannot cross the figures
  // over. A line that has been removed simply takes its measurement with it.
  const weighed = toPlain(existing)
    .filter((r) => r.received_qty != null)
    .map((r) => ({ product_id: n(r.product_id), packaging_id: n(r.packaging_id), qty: n(r.received_qty), used: false }))

  // NOTE on voucher numbers: this edit deletes every line and builds them
  // again, so the invoice's voucher goes with its last line and the rebuilt
  // invoice is posted a fresh one at the end of the numbering. That is what
  // editing an invoice has always done here. Holding the old id across the
  // rebuild would mean detaching the entry first and leaving an orphan
  // voucher behind on any failure mid-way, which is worse than a changed
  // number — so it is left as it is, deliberately. Saving a single line, and
  // deleting one line of several, both keep the number (see deleteSale).
  for (const r of existing.rows) await deleteSale(Number(r.id))
  const ids: number[] = []
  for (let i = 0; i < items.length; i++) {
    const res = await createSale({
      ...mergeInvoiceItem(v, items[i], group),
      round_off: i === 0 ? v.round_off : 0,
      round_off_manual: i === 0 ? v.round_off_manual : 0,
      invoice_no_grandfathered: keepsItsNumber
    })
    ids.push(res.id)
    const match = weighed.find(
      (w) => !w.used && w.product_id === n(items[i].product_id) && w.packaging_id === n(items[i].packaging_id)
    )
    if (match) {
      match.used = true
      await getClient().execute({
        sql: 'UPDATE sales SET received_qty = ? WHERE id = ?',
        args: [match.qty, res.id]
      })
      // The freight and the shortage are both priced off it, so both are
      // re-struck now that it is back.
      await recomputeSaleFreight(res.id)
    }
  }
  return { group, ids }
}

// Move a whole invoice through a dispatch stage (all its line items together).
export async function setInvoiceStage(
  group: string,
  stage: string,
  force = false,
  date?: string,
  // Received qty per LINE id — an invoice can carry several products and the
  // transporter weighs each one, so a single number would not do.
  received?: Record<string, number | null>
): Promise<{ group: string }> {
  const rows = await getClient().execute({
    sql: 'SELECT id FROM sales WHERE invoice_group = ? ORDER BY id',
    args: [group]
  })
  for (const r of rows.rows) {
    const id = Number(r.id)
    const q = received ? received[String(id)] : undefined
    await setSaleStage(id, stage, force, date, q === undefined ? undefined : q)
  }
  return { group }
}

export async function deleteSaleInvoice(group: string): Promise<{ group: string }> {
  const rows = await getClient().execute({
    sql: 'SELECT id FROM sales WHERE invoice_group = ?',
    args: [group]
  })
  for (const r of rows.rows) await deleteSale(Number(r.id))
  return { group }
}

// An invoice the customer refused to accept — kept on record (a Credit Note
// against it is the real correction, done separately) but pulled out of every
// "still needs to happen" view: the Gate Out picker, and the "Produce more"
// demand calc. Applies to every line row sharing the group, same as
// setInvoiceStage/deleteSaleInvoice above.
export async function rejectSaleInvoice(group: string, reason: string): Promise<{ group: string }> {
  const trimmed = String(reason || '').trim()
  if (!trimmed) throw new Error('Enter a reason for rejecting this invoice')
  await getClient().execute({
    sql: "UPDATE sales SET rejected_at = datetime('now'), rejected_reason = ? WHERE invoice_group = ?",
    args: [trimmed, group]
  })
  return { group }
}

// The delivery is called off mid-journey: the customer says on the road that
// they no longer want the load, so nothing is ever unloaded and there is no
// weighed-in quantity to record.
//
// The transporter still carried it, though, and still has to be paid. So the
// freight is struck on an ASSUMED received quantity — the dispatched figure by
// default, which the caller can override per line (a part-delivery that was
// turned away at the gate, say). That is the only reason a received qty is
// written here; the invoice is marked cancelled, not unloaded, so nothing
// downstream reads it as delivered.
//
// Everything else is left exactly as the existing Reject does it: the invoice
// stays on record, its credit note remains a separate manual step, and stock and
// the journal are untouched.
export async function cancelSaleDelivery(
  group: string,
  reason: string,
  freightQty?: Record<string, number | null>
): Promise<{ group: string; lines: number }> {
  const c = getClient()
  const trimmed = String(reason || '').trim()
  if (!trimmed) throw new Error('Enter why the delivery was cancelled')
  const rows = await c.execute({
    sql: 'SELECT id, qty, received_qty FROM sales WHERE invoice_group = ?',
    args: [group]
  })
  if (!rows.rows.length) throw new Error('That invoice no longer exists')
  for (const r of rows.rows) {
    const id = n(r.id)
    const supplied = freightQty ? freightQty[String(id)] : undefined
    // No figure given -> assume the whole dispatched quantity travelled.
    const assumed = supplied == null ? n(r.qty) : n(supplied)
    if (assumed < 0) throw new Error('The freight quantity cannot be negative')
    await c.execute({ sql: 'UPDATE sales SET received_qty = ? WHERE id = ?', args: [round2(assumed), id] })
    // Re-price the FOR freight on what we have just agreed the transporter
    // carried, so the transporter register and its accrual line agree with it.
    await recomputeSaleFreight(id)
  }
  await c.execute({
    sql: "UPDATE sales SET rejected_at = datetime('now'), rejected_reason = ? WHERE invoice_group = ?",
    args: [trimmed, group]
  })
  return { group, lines: rows.rows.length }
}

export async function unrejectSaleInvoice(group: string): Promise<{ group: string }> {
  await getClient().execute({
    sql: 'UPDATE sales SET rejected_at = NULL, rejected_reason = NULL WHERE invoice_group = ?',
    args: [group]
  })
  return { group }
}

// One-time backfill: apply output GST to sales booked before GST existed. The
// rate is taken from the sale's bargain, else the customer master; sales with
// no derivable rate are left untouched. Each affected sale is re-posted
// (journal GST OUTPUT leg + customer receivable at net incl. GST). Guarded by
// a settings flag so it runs only once.
export async function backfillSalesGst(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_gst_backfilled'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.sale_date, s.invoice_no, s.customer, s.customer_id, s.amount,
           pr.code AS product_code, pr.name AS product_name,
           sb.gst_pct AS bargain_gst, cu.gst_pct AS customer_gst
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    LEFT JOIN sales_bargains sb ON sb.id = s.sales_bargain_id
    LEFT JOIN customers cu ON cu.id = s.customer_id
    WHERE COALESCE(s.gst_pct, 0) = 0 AND COALESCE(s.gst_amount, 0) = 0
  `)
  let applied = 0
  for (const r of toPlain(sales)) {
    const gstPct = n(r.bargain_gst) > 0 ? n(r.bargain_gst) : n(r.customer_gst)
    if (gstPct <= 0) continue
    const amount = n(r.amount)
    const gstAmount = Math.round(amount * (gstPct / 100) * 100) / 100
    if (gstAmount <= 0) continue
    await c.execute({
      sql: 'UPDATE sales SET gst_pct = ?, gst_amount = ? WHERE id = ?',
      args: [gstPct, gstAmount, n(r.id)]
    })
    const code = String(r.product_code || r.product_name || 'FG').toUpperCase()
    await postSaleJournal({
      saleId: n(r.id),
      date: String(r.sale_date),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      productCode: code,
      customerName: String(r.customer || '').trim(),
      amount,
      gst: gstAmount,
      companyId: n(r.company_id) || 1
    }).catch(() => {})
    if (r.customer_id) {
      await postCustomerReceivable(n(r.id), n(r.customer_id), amount + gstAmount, String(r.sale_date)).catch(() => {})
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_gst_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[sales] backfilled output GST on ${applied} sales`)
}

// One-time sweep for the "Ex sales are simply Done" rule: any customer-lifts
// sale still parked in a tracking stage is moved to Done through the normal
// stage mover, so the stock draw and any linked auto-production run. Forced,
// because the goods physically left with the customer regardless of the books.
export async function backfillExSalesDone(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'ex_sales_done_backfilled'")
  if (done.rows.length && String(done.rows[0].value) === '1') return
  const rows = await c.execute(
    "SELECT id, invoice_no, sale_date FROM sales WHERE COALESCE(freight_term, 'FREIGHT_ON_GOODS') != 'DLD' AND status != 'done' ORDER BY id"
  )
  for (const r of rows.rows) {
    // Normal dispatch first (stock-guarded); only when that refuses does the
    // sale go through off-stock — the goods left with the customer either way.
    await setSaleStage(n(r.id), 'unloaded', false, String(r.sale_date))
      .catch(() => setSaleStage(n(r.id), 'unloaded', true, String(r.sale_date)))
      .catch((e) => console.error(`[sales] ex-done sweep failed for #${r.id}:`, (e as Error).message))
    console.log(`[sales] ex sale #${r.id} ${r.invoice_no || ''} marked done as of ${r.sale_date}`)
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('ex_sales_done_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (rows.rows.length) console.log(`[sales] ex-done sweep completed ${rows.rows.length} sales`)
}

// One-time backfill: auto round-off on existing sale invoices (created before
// the round_off column). For every invoice group whose lines all have 0 round
// off and whose total isn't already a whole rupee, the "Auto" rounding is
// applied: ro = round(total) − total, stored on the group's FIRST line, with
// that line's journal voucher and customer receivable re-posted at the rounded
// net. Guarded by a settings flag so it runs once.
export async function backfillSalesRoundOff(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_round_off_backfilled_2'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.invoice_group, s.sale_date, s.invoice_no, s.customer, s.customer_id,
           s.amount, s.gst_amount, s.round_off, pr.code AS product_code, pr.name AS product_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    ORDER BY s.id ASC
  `)
  // Group into invoices the same way the UI does (legacy rows stand alone).
  const groups = new Map<string, Row[]>()
  for (const r of toPlain(sales)) {
    const g = String(r.invoice_group || `LEGACY-${r.id}`)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(r)
  }
  let applied = 0
  for (const lines of groups.values()) {
    // Don't touch invoices that already carry a round off.
    if (lines.some((l) => Math.abs(n(l.round_off)) > 0.004)) continue
    const raw = Math.round(lines.reduce((s, l) => s + n(l.amount) + n(l.gst_amount), 0) * 100) / 100
    const ro = Math.round((Math.round(raw) - raw) * 100) / 100
    if (Math.abs(ro) < 0.005) continue
    const first = lines[0]
    await c.execute({ sql: 'UPDATE sales SET round_off = ? WHERE id = ?', args: [ro, n(first.id)] })
    const code = String(first.product_code || first.product_name || 'FG').toUpperCase()
    await postSaleJournal({
      saleId: n(first.id),
      date: String(first.sale_date),
      invoiceNo: first.invoice_no ? String(first.invoice_no) : null,
      productCode: code,
      customerName: String(first.customer || '').trim(),
      amount: n(first.amount),
      gst: n(first.gst_amount),
      roundOff: ro,
      companyId: n(first.company_id) || 1
    }).catch(() => {})
    if (first.customer_id) {
      await postCustomerReceivable(
        n(first.id),
        n(first.customer_id),
        n(first.amount) + n(first.gst_amount) + ro,
        String(first.sale_date)
      ).catch(() => {})
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_round_off_backfilled_2', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[sales] backfilled round off on ${applied} invoices`)
}

// One-time restatement: invoices whose round off is STALE — it exists, so the
// backfill above skipped it, but it no longer makes the total a whole rupee
// because the invoice was edited afterwards (a qty or rate changed) while the
// form treated the stored figure as a manual override and never recomputed it.
// Restates it to the correct auto value and re-posts that line's voucher and
// customer receivable at the corrected net, same as the backfill does.
export async function restateStaleSalesRoundOff(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sales_round_off_restated_3'")
  if (done.rows.length && String(done.rows[0].value) === '1') return

  const sales = await c.execute(`
    SELECT s.id, s.company_id, s.invoice_group, s.sale_date, s.invoice_no, s.customer, s.customer_id,
           s.amount, s.gst_amount, s.round_off, s.round_off_manual, pr.code AS product_code, pr.name AS product_name
    FROM sales s
    LEFT JOIN products pr ON pr.id = s.product_id
    ORDER BY s.id ASC
  `)
  const groups = new Map<string, Row[]>()
  for (const r of toPlain(sales)) {
    const g = String(r.invoice_group || `LEGACY-${r.id}`)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(r)
  }
  let applied = 0
  for (const lines of groups.values()) {
    // A round off the user typed by hand is theirs — never restate it.
    if (lines.some((l) => n(l.round_off_manual) === 1)) continue
    const raw = Math.round(lines.reduce((s, l) => s + n(l.amount) + n(l.gst_amount), 0) * 100) / 100
    if (raw <= 0) continue
    const should = Math.round((Math.round(raw) - raw) * 100) / 100
    const stored = Math.round(lines.reduce((s, l) => s + n(l.round_off), 0) * 100) / 100
    if (Math.abs(stored - should) < 0.005) continue

    // The round off belongs on the group's first line; clear any that drifted
    // onto the others so the group's total is exactly `should`.
    const first = lines[0]
    await c.execute({ sql: 'UPDATE sales SET round_off = ? WHERE id = ?', args: [should, n(first.id)] })
    for (const l of lines.slice(1)) {
      if (Math.abs(n(l.round_off)) > 0.004) {
        await c.execute({ sql: 'UPDATE sales SET round_off = 0 WHERE id = ?', args: [n(l.id)] })
      }
    }
    const code = String(first.product_code || first.product_name || 'FG').toUpperCase()
    await postSaleJournal({
      saleId: n(first.id),
      date: String(first.sale_date),
      invoiceNo: first.invoice_no ? String(first.invoice_no) : null,
      productCode: code,
      customerName: String(first.customer || '').trim(),
      amount: n(first.amount),
      gst: n(first.gst_amount),
      roundOff: should,
      companyId: n(first.company_id) || 1
    }).catch(() => {})
    if (first.customer_id) {
      await postCustomerReceivable(
        n(first.id),
        n(first.customer_id),
        n(first.amount) + n(first.gst_amount) + should,
        String(first.sale_date)
      ).catch(() => {})
    }
    applied++
  }
  await c.execute(
    "INSERT INTO app_settings (key, value) VALUES ('sales_round_off_restated_3', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  )
  if (applied > 0) console.log(`[sales] restated stale round off on ${applied} invoices`)
}

// One-time backfill: link existing sales bargains to the customer master by
// name (trimmed, case-insensitive), so a customer rename thereafter propagates
// everywhere. Bargains whose name has no exact master match (typos, or
// customers not in the master) are left unlinked and keep their stored name —
// re-picking the customer on the bargain links them. Runs once (per new links).
export async function backfillSalesBargainCustomers(): Promise<void> {
  const c = getClient()
  const rows = await c.execute(
    'SELECT id, customer FROM sales_bargains WHERE customer_id IS NULL AND customer IS NOT NULL'
  )
  if (!rows.rows.length) return
  const custs = await c.execute('SELECT id, name FROM customers')
  const byName = new Map<string, number>()
  for (const cu of custs.rows) {
    byName.set(String(cu.name || '').trim().toLowerCase(), Number(cu.id))
  }
  let linked = 0
  for (const r of rows.rows) {
    const id = byName.get(String(r.customer || '').trim().toLowerCase())
    if (!id) continue
    await c.execute({ sql: 'UPDATE sales_bargains SET customer_id = ? WHERE id = ?', args: [id, Number(r.id)] })
    linked++
  }
  if (linked > 0) console.log(`[sales] linked ${linked} sales bargains to the customer master`)
}

// Void one unused invoice number, so the gap report can tell a spoiled form
// from a bill nobody can account for.
//
// Refuses a number that IS in use: cancelling a real invoice is a different act
// with real consequences (stock, ledger, a credit note), and it already has its
// own path on the register. This is only for a number that was never issued.
export async function cancelInvoiceNo(v: Row): Promise<{ prefix: string; number: number }> {
  const cid = n(v?.company_id) || getActiveCompanyId()
  const prefix = String(v?.prefix || '').trim()
  const num = n(v?.number)
  const reason = String(v?.reason || '').trim()
  if (!prefix || !num) throw new Error('Pick the invoice number to cancel')
  if (!reason) {
    throw new Error('Say why it was cancelled — a voided number with no reason cannot be checked later')
  }
  const c = getClient()

  // Same tolerant match the gap report uses, so a number keyed as KRFL-380
  // still counts as in use against a KRFL/380 cancellation.
  const inUse = await c.execute({
    sql: `SELECT invoice_no FROM sales
           WHERE company_id = ?
             AND UPPER(REPLACE(REPLACE(REPLACE(TRIM(COALESCE(invoice_no,'')), '/', ''), '-', ''), ' ', ''))
                 = UPPER(REPLACE(REPLACE(REPLACE(? , '/', ''), '-', ''), ' ', ''))
           LIMIT 1`,
    args: [cid, `${prefix}${num}`]
  })
  if (inUse.rows.length) {
    throw new Error(
      `${String(inUse.rows[0].invoice_no)} is a real invoice — cancel it from the register instead, so its stock and ledger are reversed too.`
    )
  }

  await c.execute({
    sql: `INSERT INTO cancelled_invoice_nos (company_id, prefix, number, reason, cancelled_on, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, prefix, number) DO UPDATE SET
            reason = excluded.reason, cancelled_on = excluded.cancelled_on, created_by = excluded.created_by`,
    args: [cid, prefix, num, reason, todayISO(), getCurrentUser().username || null]
  })
  return { prefix, number: num }
}

// Put a voided number back into the missing list — for when it was voided by
// mistake, or the bill turns out to exist after all.
export async function uncancelInvoiceNo(v: Row): Promise<{ prefix: string; number: number }> {
  const cid = n(v?.company_id) || getActiveCompanyId()
  const prefix = String(v?.prefix || '').trim()
  const num = n(v?.number)
  if (!prefix || !num) throw new Error('Pick the invoice number')
  await getClient().execute({
    sql: 'DELETE FROM cancelled_invoice_nos WHERE company_id = ? AND prefix = ? AND number = ?',
    args: [cid, prefix, num]
  })
  return { prefix, number: num }
}
