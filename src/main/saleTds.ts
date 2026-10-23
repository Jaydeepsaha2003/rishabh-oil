import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { createVoucher } from './accounting'
import { deleteManualEntry } from './journal'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

// TDS A CUSTOMER DEDUCTS FROM OUR INVOICE (from 2026-10-21).
//
// A sale posts no TDS (SALE_TDS_PCT in sales.ts): the customer is debited the
// whole bill. When they pay it short by the TDS they withheld, that is a
// Journal of its own — Dr the TDS ledger the user picks, Cr the customer —
// with the customer's line Agst Ref the invoice, so the bill shows the TDS as
// settled in Bill-wise exactly as a receipt would.
//
// The amount is offered off the customer master's TDS terms (tds_pct,
// tds_threshold, tds_above_only) over the financial year's taxable to that
// customer — the same slab a purchase reads off the supplier — and can be
// changed before it is posted.
//
// The voucher is an ordinary manual Journal (it can be opened and altered in
// Accounting like any other); this table only remembers which invoice it was
// raised for, so the Sales page can show it and an invoice deleted takes its
// TDS journal with it.
async function ensureTable(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS sale_tds_journals (
    invoice_key TEXT NOT NULL,
    company_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    ledger TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, invoice_key)
  )`)
}

function fyStart(date: string): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  return `${m >= 4 ? y : y - 1}-04-01`
}

/** Every line of the invoice the sale belongs to, and its key (as Agst Ref allocs store it). */
async function invoiceOf(saleId: number): Promise<{ key: string; rows: Row[] }> {
  const c = getClient()
  const seed = await c.execute({ sql: 'SELECT id, invoice_group, invoice_no FROM sales WHERE id = ?', args: [n(saleId)] })
  if (!seed.rows.length) throw new Error('That invoice is no longer there')
  const s = seed.rows[0] as unknown as Row
  const res = s.invoice_group
    ? await c.execute({
        sql: `SELECT s.*, cu.name AS customer_master, cu.tds_pct AS cu_tds_pct, cu.tds_threshold AS cu_tds_threshold,
                     cu.tds_above_only AS cu_tds_above_only, cu.linked_party_id AS cu_linked
                FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
               WHERE s.invoice_group = ? ORDER BY s.id`,
        args: [String(s.invoice_group)]
      })
    : await c.execute({
        sql: `SELECT s.*, cu.name AS customer_master, cu.tds_pct AS cu_tds_pct, cu.tds_threshold AS cu_tds_threshold,
                     cu.tds_above_only AS cu_tds_above_only, cu.linked_party_id AS cu_linked
                FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
               WHERE s.id = ?`,
        args: [n(saleId)]
      })
  const rows = res.rows.map((r) => ({ ...(r as unknown as Row) }))
  return { key: String(s.invoice_group || s.invoice_no || `sale-${s.id}`), rows }
}

/** What this customer (and any row linked to it by PAN) was billed earlier in the year, in the invoice's book. */
async function priorTaxable(first: Row, ids: number[]): Promise<number> {
  const c = getClient()
  const cust = n(first.customer_id)
  if (!cust) return 0
  const root = n(first.cu_linked) || cust
  const linked = await c.execute({ sql: 'SELECT id FROM customers WHERE linked_party_id = ?', args: [root] })
  const custIds = Array.from(new Set([root, cust, ...linked.rows.map((r) => n((r as unknown as Row).id))]))
  const date = String(first.sale_date).slice(0, 10)
  const minId = Math.min(...ids)
  const res = await c.execute({
    sql: `SELECT COALESCE(SUM(amount), 0) AS t FROM sales
           WHERE customer_id IN (${custIds.map(() => '?').join(',')}) AND company_id = ?
             AND rejected_at IS NULL
             AND sale_date >= ? AND (sale_date < ? OR (sale_date = ? AND id < ?))
             AND id NOT IN (${ids.map(() => '?').join(',')})`,
    args: [...custIds, n(first.company_id), fyStart(date), date, date, minId, ...ids]
  })
  // And what was billed to them before these books, in this company.
  const { partyOpeningInYear } = await import('./partyOpenings')
  const start = fyStart(date)
  const end = `${Number(start.slice(0, 4)) + 1}-03-31`
  const opening = await partyOpeningInYear('customer', n(first.company_id), custIds, start, end)
  return n((res.rows[0] as unknown as Row).t) + opening
}

export async function saleTdsPreview(saleId: number): Promise<Row> {
  await ensureTable()
  const c = getClient()
  const { key, rows } = await invoiceOf(saleId)
  const first = rows[0]
  const cid = n(first.company_id)
  const base = round2(rows.reduce((t, r) => t + n(r.amount), 0))
  const prior = await priorTaxable(first, rows.map((r) => n(r.id)))
  const pct = n(first.cu_tds_pct)
  const threshold = n(first.cu_tds_threshold)
  const aboveOnly = !!n(first.cu_tds_above_only)
  // Above-only: TDS on the part of the year's billing past the threshold that
  // falls in this invoice. Otherwise: on the whole invoice, once the year's
  // billing has passed the threshold.
  const liable = aboveOnly ? Math.max(0, prior + base - Math.max(prior, threshold)) : prior + base > threshold ? base : 0
  const amount = pct > 0 ? round2((liable * pct) / 100) : 0

  const led = await c.execute(
    `SELECT name, acc_group FROM ledger_accounts
      WHERE UPPER(name) LIKE '%TDS%' AND UPPER(name) NOT LIKE '%PAYABLE%' AND COALESCE(is_hidden, 0) = 0
        AND UPPER(COALESCE(acc_group, '')) NOT LIKE '%EXPENSE%' AND UPPER(COALESCE(acc_group, '')) NOT LIKE '%INCOME%'
      ORDER BY name`
  )
  const ledgers = led.rows.map((r) => ({ name: String((r as unknown as Row).name), acc_group: String((r as unknown as Row).acc_group || '') }))
  // The year's "TDS receivable on sale" ledger when there is one.
  const fy = fyStart(String(first.sale_date).slice(0, 10)).slice(0, 4)
  const onSale = ledgers.filter((l) => /RECE|RECOV/.test(l.name.toUpperCase()) && /SALE/.test(l.name.toUpperCase()))
  const suggested = (onSale.find((l) => l.name.includes(fy)) || onSale[0] || ledgers.find((l) => l.name === 'TDS RECEIVABLE A/C'))?.name || ''

  const ex = await c.execute({
    sql: `SELECT t.entry_id, t.amount, t.ledger, je.vch_no, je.entry_date
            FROM sale_tds_journals t LEFT JOIN journal_entries je ON je.id = t.entry_id
           WHERE t.company_id = ? AND t.invoice_key = ?`,
    args: [cid, key]
  })
  const e = ex.rows[0] as unknown as Row | undefined
  return {
    sale_id: n(first.id),
    invoice_key: key,
    invoice_no: String(first.invoice_no || ''),
    date: String(first.sale_date).slice(0, 10),
    customer: String(first.customer_master || first.customer || ''),
    company_id: cid,
    base,
    prior: round2(prior),
    pct,
    threshold,
    above_only: aboveOnly,
    amount,
    ledgers,
    suggested_ledger: suggested,
    existing: e && e.entry_date ? { entry_id: n(e.entry_id), amount: n(e.amount), ledger: String(e.ledger), vch_no: String(e.vch_no || ''), date: String(e.entry_date) } : null
  }
}

async function dropExisting(cid: number, key: string): Promise<void> {
  const c = getClient()
  const ex = await c.execute({ sql: 'SELECT entry_id FROM sale_tds_journals WHERE company_id = ? AND invoice_key = ?', args: [cid, key] })
  for (const r of ex.rows) {
    const id = n((r as unknown as Row).entry_id)
    const still = await c.execute({ sql: 'SELECT id FROM journal_entries WHERE id = ?', args: [id] })
    if (still.rows.length) await deleteManualEntry(id)
  }
  await c.execute({ sql: 'DELETE FROM sale_tds_journals WHERE company_id = ? AND invoice_key = ?', args: [cid, key] })
}

/** Post (or re-post) the customer's TDS on this invoice as a Journal, Agst Ref the invoice. */
export async function postSaleTds(v: { sale_id: number; amount: number; ledger: string; date?: string }): Promise<{ entry_id: number }> {
  await ensureTable()
  const amount = round2(n(v.amount))
  const ledger = String(v.ledger || '').trim()
  if (amount <= 0) throw new Error('Enter the TDS the customer deducted')
  if (!ledger) throw new Error('Pick the TDS ledger')
  return withDbTransaction(async () => {
    const c = getClient()
    const { key, rows } = await invoiceOf(v.sale_id)
    const first = rows[0]
    const cid = n(first.company_id)
    const customer = String(first.customer_master || first.customer || '').trim()
    if (!customer) throw new Error('The invoice has no customer')
    const bill = round2(rows.reduce((t, r) => t + n(r.amount) + n(r.gst_amount) + n(r.round_off), 0))
    if (bill > 0 && amount > bill) throw new Error('The TDS is more than the invoice')
    const date = String(v.date || first.sale_date).slice(0, 10)
    if (date < String(first.sale_date).slice(0, 10)) throw new Error('The TDS cannot be dated before the invoice')
    const led = await c.execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?', args: [ledger] })
    const ledgerGroup = led.rows.length ? String((led.rows[0] as unknown as Row).acc_group || '') : 'Current Assets'
    await dropExisting(cid, key)
    const invNo = String(first.invoice_no || '')
    const res = await createVoucher({
      date,
      vchType: 'JOURNAL',
      companyId: cid,
      narration: `TDS deducted by ${customer} on invoice ${invNo}`,
      lines: [
        { account: ledger, group: ledgerGroup, dr: amount },
        {
          account: customer,
          group: 'Sundry Debtors',
          cr: amount,
          allocs: [{ method: 'agst_ref', ref_name: invNo || key, amount, sale_invoice_group: key }]
        }
      ]
    })
    await c.execute({
      sql: 'INSERT INTO sale_tds_journals (invoice_key, company_id, entry_id, amount, ledger) VALUES (?, ?, ?, ?, ?)',
      args: [key, cid, res.id, amount, ledger]
    })
    return { entry_id: res.id }
  })
}

export async function removeSaleTds(saleId: number): Promise<{ ok: true }> {
  await ensureTable()
  return withDbTransaction(async () => {
    const { key, rows } = await invoiceOf(saleId)
    await dropExisting(n(rows[0].company_id), key)
    return { ok: true as const }
  })
}

/** An invoice gone entirely takes its TDS journal with it (deleteSale, last line). */
export async function dropSaleTdsForInvoice(companyId: number, key: string): Promise<void> {
  await ensureTable()
  await dropExisting(n(companyId), key)
}

// THE CUSTOMER-TDS DESK'S OWN READ. A user granted the 'tds' scope on Sales
// sees the invoices still waiting for their customer's TDS and nothing else:
// a customer whose master carries a TDS rate, an invoice not rejected, and no
// TDS journal on it yet. One row per invoice, and only what booking the TDS
// needs — date, number, customer, taxable — never a rate, GST, freight or
// bill total, so the page cannot show them and the channel cannot be asked.
export async function listSalesForTdsDesk(companyIds?: number[]): Promise<Row[]> {
  await ensureTable()
  const c = getClient()
  const ids = (companyIds || []).map(n).filter(Boolean)
  // Every invoice of the year, oldest first, so each one's TDS is worked from
  // what the customer (and any row linked to it by PAN) was billed before it —
  // the same slab saleTdsPreview reads. Only the ones with TDS due and none
  // booked are handed back.
  const res = await c.execute({
      sql: `SELECT MIN(s.id) AS id, s.company_id, COALESCE(s.invoice_group, s.invoice_no, 'sale-' || s.id) AS invoice_key,
                   MAX(s.invoice_no) AS invoice_no, MIN(s.sale_date) AS sale_date, cu.name AS customer, cu.id AS customer_id,
                   COALESCE(cu.linked_party_id, cu.id) AS root, cu.tds_pct, cu.tds_threshold, cu.tds_above_only,
                   ROUND(SUM(s.amount), 2) AS taxable, co.name AS company_name
              FROM sales s JOIN customers cu ON cu.id = s.customer_id LEFT JOIN companies co ON co.id = s.company_id
             WHERE s.rejected_at IS NULL ${ids.length ? `AND s.company_id IN (${ids.map(() => '?').join(',')})` : ''}
             GROUP BY s.company_id, COALESCE(s.invoice_group, s.invoice_no, 'sale-' || s.id)
             ORDER BY MIN(s.sale_date) ASC, MIN(s.id) ASC`,
      args: ids
  })
  const all = res.rows.map((r) => ({ ...(r as unknown as Row) }))
  const booked = new Set(
    (await c.execute('SELECT t.company_id, t.invoice_key FROM sale_tds_journals t JOIN journal_entries je ON je.id = t.entry_id')).rows.map(
      (r) => `${n((r as unknown as Row).company_id)}|${String((r as unknown as Row).invoice_key)}`
    )
  )
  const { partyOpeningInYear } = await import('./partyOpenings')
  const running = new Map<string, number>()
  const out: Row[] = []
  for (const r of all) {
    const date = String(r.sale_date || '').slice(0, 10)
    const start = fyStart(date)
    const k = `${n(r.company_id)}|${n(r.root)}|${start}`
    if (!running.has(k)) {
      const linked = await c.execute({ sql: 'SELECT id FROM customers WHERE id = ? OR linked_party_id = ?', args: [n(r.root), n(r.root)] })
      const custIds = linked.rows.map((x) => n((x as unknown as Row).id))
      const end = `${Number(start.slice(0, 4)) + 1}-03-31`
      running.set(k, await partyOpeningInYear('customer', n(r.company_id), custIds, start, end))
    }
    const prior = running.get(k) as number
    const base = n(r.taxable)
    running.set(k, prior + base)
    const pct = n(r.tds_pct)
    if (pct <= 0) continue
    if (booked.has(`${n(r.company_id)}|${String(r.invoice_key)}`)) continue
    const threshold = n(r.tds_threshold)
    const liable = n(r.tds_above_only) ? Math.max(0, prior + base - Math.max(prior, threshold)) : prior + base > threshold ? base : 0
    const tds = round2((liable * pct) / 100)
    if (tds <= 0) continue
    out.push({
      id: r.id,
      company_id: r.company_id,
      company_name: r.company_name,
      invoice_key: r.invoice_key,
      invoice_no: r.invoice_no,
      sale_date: r.sale_date,
      customer: r.customer,
      customer_id: r.customer_id,
      taxable: base,
      tds_pct: pct,
      tds
    })
  }
  return out.reverse()
}

/** Whether the invoice this sale belongs to already carries a TDS journal. */
export async function saleHasTds(saleId: number): Promise<boolean> {
  await ensureTable()
  const { key, rows } = await invoiceOf(saleId)
  const r = await getClient().execute({
    sql: `SELECT 1 FROM sale_tds_journals t JOIN journal_entries je ON je.id = t.entry_id WHERE t.company_id = ? AND t.invoice_key = ? LIMIT 1`,
    args: [n(rows[0].company_id), key]
  })
  return r.rows.length > 0
}

/** Which invoices of these carry a TDS journal: invoice_key → amount. For the Sales list. */
export async function saleTdsMap(companyIds?: number[]): Promise<Row[]> {
  await ensureTable()
  const ids = (companyIds || []).map(n).filter(Boolean)
  const res = await getClient().execute({
    sql: `SELECT t.company_id, t.invoice_key, t.amount, t.ledger, t.entry_id, je.vch_no
            FROM sale_tds_journals t JOIN journal_entries je ON je.id = t.entry_id
           ${ids.length ? `WHERE t.company_id IN (${ids.map(() => '?').join(',')})` : ''}`,
    args: ids
  })
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}
