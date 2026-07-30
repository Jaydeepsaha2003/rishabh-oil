import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

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

// --- accounts ---

export async function getOrCreateAccount(name: string, group = 'General'): Promise<number> {
  const c = getClient()
  const clean = String(name || '').trim().toUpperCase()
  if (!clean) throw new Error('Account name is required')
  await c.execute({
    sql: 'INSERT OR IGNORE INTO ledger_accounts (name, acc_group) VALUES (?, ?)',
    args: [clean, group]
  })
  const res = await c.execute({
    sql: 'SELECT id FROM ledger_accounts WHERE name = ?',
    args: [clean]
  })
  return Number(res.rows[0].id)
}

export async function listAccounts(companyId?: number): Promise<Row[]> {
  // Accounts are shared; balances are per company (separate books) — the
  // caller may pin one, else the active company.
  const res = await getClient().execute({
    args: [companyId || getActiveCompanyId()],
    sql: `
    SELECT a.*,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance
    FROM ledger_accounts a ORDER BY a.name
  `
  })
  return toPlain(res)
}

export async function createAccount(name: string, group = 'General'): Promise<{ id: number }> {
  return { id: await getOrCreateAccount(name, group) }
}

// --- posting ---

export interface JournalLine {
  account: string
  group?: string
  dr?: number
  cr?: number
}

interface PostArgs {
  date: string
  vchType: string
  vchNo?: string | null
  narration?: string | null
  orderId?: number | null
  saleId?: number | null
  paymentId?: number | null
  companyId?: number
  lines: JournalLine[]
}

// Insert a balanced journal entry. Lines with zero amounts are skipped.
export async function postJournal(a: PostArgs): Promise<{ id: number }> {
  const c = getClient()
  const lines = a.lines.filter((l) => n(l.dr) > 0.004 || n(l.cr) > 0.004)
  if (!lines.length) throw new Error('Journal entry has no amounts')
  const dr = lines.reduce((s, l) => s + n(l.dr), 0)
  const cr = lines.reduce((s, l) => s + n(l.cr), 0)
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error(`Journal not balanced (Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)})`)
  }
  const ins = await c.execute({
    sql: `INSERT INTO journal_entries (company_id, entry_date, vch_type, vch_no, narration, order_id, sale_id, payment_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      a.companyId ?? getActiveCompanyId(),
      a.date,
      a.vchType,
      a.vchNo || null,
      a.narration || null,
      a.orderId ?? null,
      a.saleId ?? null,
      a.paymentId ?? null
    ]
  })
  const entryId = Number(ins.lastInsertRowid)
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group)
    await c.execute({
      sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
      args: [entryId, accountId, n(l.dr), n(l.cr)]
    })
  }
  return { id: entryId }
}

// Remove auto-posted entries tied to a source document (used before reposting).
export async function deleteJournalByRef(
  refCol: 'order_id' | 'sale_id' | 'payment_id',
  refId: number
): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT id FROM journal_entries WHERE ${refCol} = ?`,
    args: [refId]
  })
  for (const r of res.rows) {
    await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [r.id] })
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [r.id] })
  }
}

// Manual entries (Journal / Dr Note / Cr Note / Opening) have no source refs.
export async function deleteManualEntry(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT order_id, sale_id, payment_id FROM journal_entries WHERE id = ?',
    args: [id]
  })
  if (!res.rows.length) return { id }
  const r = res.rows[0]
  if (r.order_id != null || r.sale_id != null || r.payment_id != null) {
    throw new Error('This entry was posted automatically — adjust its source document instead')
  }
  const noteRef = await c.execute({
    sql: 'SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1',
    args: [id]
  })
  if (noteRef.rows.length) {
    throw new Error('This voucher belongs to a Debit/Credit note — delete the note itself')
  }
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [id] })
  return { id }
}

// --- statements ---

// Tally-style ledger for one account. "Particulars" shows the PRINCIPAL contra
// account — the largest line on the opposite side of the voucher (Tally style),
// e.g. the supplier ledger shows "SHEA PUR A/C", not the GST/TDS legs.
// Short voucher-type prefix for the running voucher serial (PUR/1, DN/1, …).
function vchPrefix(t: string): string {
  const u = String(t || '').toUpperCase()
  if (u.includes('PURCHASE')) return 'PUR'
  if (u.includes('SALE')) return 'SAL'
  if (u.includes('DEBIT')) return 'DN'
  if (u.includes('CREDIT')) return 'CN'
  if (u.includes('RECEIPT')) return 'RCP'
  if (u.includes('PAYMENT')) return 'PAY'
  if (u.includes('CONTRA')) return 'CON'
  if (u.includes('OPENING')) return 'OB'
  if (u.includes('JOURNAL')) return 'JV'
  const letters = u.replace(/[^A-Z]/g, '')
  return letters.slice(0, 3) || 'VCH'
}

// A stable running serial per voucher type across the company, keyed by entry id
// (ordered by id so a voucher always keeps the same number).
async function voucherCodeMap(companyId: number): Promise<Map<number, string>> {
  const res = await getClient().execute({
    sql: 'SELECT id, vch_type FROM journal_entries WHERE company_id = ? ORDER BY id ASC',
    args: [companyId]
  })
  const counters = new Map<string, number>()
  const map = new Map<number, string>()
  for (const r of res.rows) {
    const pre = vchPrefix(String(r.vch_type))
    const seq = (counters.get(pre) || 0) + 1
    counters.set(pre, seq)
    map.set(Number(r.id), `${pre}/${seq}`)
  }
  return map
}

export async function accountStatement(accountId: number, companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const res = await c.execute({
    sql: `SELECT jl.id, je.id AS entry_id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 jl.dr, jl.cr, je.order_id, je.sale_id, je.payment_id
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_id = ? AND je.company_id = ?
          ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC`,
    args: [accountId, cid]
  })
  const lines = toPlain(res)
  if (!lines.length) return lines

  // All other lines of the same vouchers, to derive the principal contra name.
  const others = await c.execute({
    sql: `SELECT jl.entry_id, jl.dr, jl.cr, a.name
          FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.account_id != ?
            AND jl.entry_id IN (SELECT entry_id FROM journal_lines WHERE account_id = ?)`,
    args: [accountId, accountId]
  })
  const byEntry = new Map<number, Row[]>()
  for (const r of toPlain(others)) {
    const k = Number(r.entry_id)
    if (!byEntry.has(k)) byEntry.set(k, [])
    byEntry.get(k)!.push(r)
  }

  const codes = await voucherCodeMap(cid)
  for (const l of lines) {
    const rest = byEntry.get(Number(l.entry_id)) || []
    const opposite = Number(l.dr) > 0
      ? rest.filter((r) => n(r.cr) > 0).sort((a, b) => n(b.cr) - n(a.cr))
      : rest.filter((r) => n(r.dr) > 0).sort((a, b) => n(b.dr) - n(a.dr))
    l.particulars = String((opposite[0] || rest[0])?.name || '')
    l.voucher_code = codes.get(Number(l.entry_id)) || ''
    // Every other leg of the voucher, for the ledger's DETAILED (Alt+F1) mode.
    l.legs = rest.map((r) => ({ name: String(r.name), dr: n(r.dr), cr: n(r.cr) }))
  }
  return lines
}

// --- auto-posting helpers ---

// Purchase (Tally style):
//   Dr {OILCODE} PUR A/C   taxable value less interest
//   Dr INTEREST A/C        supplier interest portion
//   Dr GST INPUT A/C       gst amount
//   Dr/Cr ROUND OFF A/C    rounding difference
//     Cr TDS PAYABLE A/C   tds amount
//     Cr {Supplier}        net amount (incl. round off)
export async function postPurchaseJournal(v: {
  orderId: number
  date: string
  invoiceNo: string
  oilCode: string
  supplierName: string
  taxable: number
  gst: number
  tds: number
  net: number
  roundOff?: number
  interest?: number
  companyId?: number
}): Promise<void> {
  await deleteJournalByRef('order_id', v.orderId)
  const ro = n(v.roundOff)
  const interest = Math.min(Math.max(0, n(v.interest)), n(v.taxable))
  await postJournal({
    date: v.date,
    vchType: 'PURCHASE OIL',
    vchNo: v.invoiceNo,
    narration: `Purchase ${v.invoiceNo}`,
    orderId: v.orderId,
    companyId: v.companyId,
    lines: [
      { account: `${v.oilCode} PUR A/C`, group: 'Purchase Accounts', dr: v.taxable - interest },
      { account: 'INTEREST A/C', group: 'Indirect Expenses', dr: interest },
      { account: 'GST INPUT A/C', group: 'Duties & Taxes', dr: v.gst },
      { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: ro > 0 ? ro : 0, cr: ro < 0 ? -ro : 0 },
      { account: 'TDS PAYABLE A/C', group: 'Duties & Taxes', cr: v.tds },
      { account: v.supplierName, group: 'Sundry Creditors', cr: v.net }
    ]
  })
}

// Payment / receipt: party vs the money source (Bank, LC, …).
export async function postPaymentJournal(v: {
  paymentId: number
  date: string
  partyName: string
  partyGroup: string
  source: string
  amount: number
  isReceipt: boolean
  reference?: string | null
  companyId?: number
}): Promise<void> {
  await deleteJournalByRef('payment_id', v.paymentId)
  const sourceAccount = `${String(v.source || 'BANK').toUpperCase()} A/C`
  await postJournal({
    date: v.date,
    vchType: v.isReceipt ? 'RECEIPT' : 'PAYMENT',
    vchNo: v.reference || null,
    paymentId: v.paymentId,
    companyId: v.companyId,
    lines: v.isReceipt
      ? [
          { account: sourceAccount, group: 'Bank Accounts', dr: v.amount },
          { account: v.partyName, group: v.partyGroup, cr: v.amount }
        ]
      : [
          { account: v.partyName, group: v.partyGroup, dr: v.amount },
          { account: sourceAccount, group: 'Bank Accounts', cr: v.amount }
        ]
  })
}

// Sale:  Dr {Customer}   amount
//          Cr {FG} SALE A/C amount
// Sale:  Dr {Customer}          net (taxable + output GST)
//          Cr {FG} SALE A/C      taxable
//          Cr GST OUTPUT A/C     gst
export async function postSaleJournal(v: {
  saleId: number
  date: string
  invoiceNo: string | null
  productCode: string
  customerName: string
  amount: number
  gst?: number
  roundOff?: number
  companyId?: number
}): Promise<void> {
  await deleteJournalByRef('sale_id', v.saleId)
  const taxable = n(v.amount)
  const gst = n(v.gst)
  // Round off shifts the customer's net: +ve rounds the invoice up (customer
  // owes more, Cr ROUND OFF), −ve rounds down (Dr ROUND OFF).
  const ro = n(v.roundOff)
  if (taxable <= 0 && gst <= 0) return
  await postJournal({
    date: v.date,
    vchType: 'SALE',
    vchNo: v.invoiceNo,
    saleId: v.saleId,
    companyId: v.companyId,
    lines: [
      { account: v.customerName || 'CASH CUSTOMER A/C', group: 'Sundry Debtors', dr: taxable + gst + ro },
      { account: `${v.productCode} SALE A/C`, group: 'Sales Accounts', cr: taxable },
      { account: 'GST OUTPUT A/C', group: 'Duties & Taxes', cr: gst },
      { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: ro > 0 ? ro : 0, dr: ro < 0 ? -ro : 0 }
    ]
  })
}

// One-time (idempotent) backfill: post journal vouchers for documents created
// before the journal engine existed. Anything already posted is skipped.
export async function backfillJournal(): Promise<void> {
  const c = getClient()

  // Core accounts always exist, even before any voucher touches them.
  await getOrCreateAccount('ROUND OFF A/C', 'Indirect Expenses').catch(() => {})
  await getOrCreateAccount('INTEREST A/C', 'Indirect Expenses').catch(() => {})
  await getOrCreateAccount('GST INPUT A/C', 'Duties & Taxes').catch(() => {})
  await getOrCreateAccount('GST OUTPUT A/C', 'Duties & Taxes').catch(() => {})
  await getOrCreateAccount('TDS PAYABLE A/C', 'Duties & Taxes').catch(() => {})
  await getOrCreateAccount('BANK A/C', 'Bank Accounts').catch(() => {})

  const orders = await c.execute(`
    SELECT o.id, o.invoice_no, o.order_date, o.taxable_value, o.gst_amount, o.tds_amount, o.round_off, o.net_amount,
           o.interest_pct, o.interest_days, o.bargain_rate, o.ordered_qty, o.company_id,
           s.name AS supplier_name, p.code AS oil_code, p.name AS oil_name
    FROM orders o
    LEFT JOIN suppliers s ON s.id = o.supplier_id
    LEFT JOIN products p ON p.id = o.oil_type_id
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.order_id = o.id)
  `)
  for (const r of orders.rows) {
    const interest =
      n(r.bargain_rate) * (n(r.interest_pct) / 100) * (n(r.interest_days) / 365) * n(r.ordered_qty)
    await postPurchaseJournal({
      orderId: Number(r.id),
      date: String(r.order_date),
      invoiceNo: String(r.invoice_no || ''),
      oilCode: String(r.oil_code || r.oil_name || 'OIL').toUpperCase(),
      supplierName: String(r.supplier_name || 'SUPPLIER'),
      taxable: n(r.taxable_value),
      gst: n(r.gst_amount),
      tds: n(r.tds_amount),
      net: n(r.net_amount),
      roundOff: n(r.round_off),
      interest,
      companyId: n(r.company_id) || 1
    }).catch(() => {})
  }

  const pays = await c.execute(`
    SELECT p.id, p.party_type, p.payment_date, p.amount, p.source, p.reference, p.company_id,
           CASE p.party_type WHEN 'supplier' THEN s.name WHEN 'transporter' THEN t.name ELSE cu.name END AS party_name
    FROM payments p
    LEFT JOIN suppliers s ON p.party_type = 'supplier' AND s.id = p.party_id
    LEFT JOIN transporters t ON p.party_type = 'transporter' AND t.id = p.party_id
    LEFT JOIN customers cu ON p.party_type = 'customer' AND cu.id = p.party_id
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.payment_id = p.id)
  `)
  for (const r of pays.rows) {
    await postPaymentJournal({
      paymentId: Number(r.id),
      date: String(r.payment_date),
      partyName: String(r.party_name || 'PARTY'),
      partyGroup: String(r.party_type) === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors',
      source: String(r.source || 'BANK'),
      amount: n(r.amount),
      isReceipt: String(r.party_type) === 'customer',
      reference: r.reference ? String(r.reference) : null,
      companyId: n(r.company_id) || 1
    }).catch(() => {})
  }

  const sales = await c.execute(`
    SELECT s.id, s.sale_date, s.invoice_no, s.customer, s.amount, s.company_id, p.code, p.name
    FROM sales s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.sale_id = s.id)
  `)
  for (const r of sales.rows) {
    await postSaleJournal({
      saleId: Number(r.id),
      date: String(r.sale_date),
      invoiceNo: r.invoice_no ? String(r.invoice_no) : null,
      productCode: String(r.code || r.name || 'FG').toUpperCase(),
      customerName: String(r.customer || '').trim(),
      amount: n(r.amount),
      companyId: n(r.company_id) || 1
    }).catch(() => {})
  }

  const total = orders.rows.length + pays.rows.length + sales.rows.length
  if (total > 0) {
    console.log(
      `[journal] backfilled ${orders.rows.length} purchases, ${pays.rows.length} payments, ${sales.rows.length} sales`
    )
  }
}

// Manual voucher from the UI: one Dr account, one Cr account.
export async function addManualJournal(d: Row): Promise<{ id: number }> {
  const amount = n(d.amount)
  if (amount <= 0) throw new Error('Enter an amount')
  if (!d.dr_account || !d.cr_account) throw new Error('Pick the Dr and Cr accounts')
  return postJournal({
    date: String(d.entry_date),
    vchType: String(d.vch_type || 'JOURNAL'),
    vchNo: d.vch_no || null,
    narration: d.narration || null,
    lines: [
      { account: String(d.dr_account), dr: amount },
      { account: String(d.cr_account), cr: amount }
    ]
  })
}
