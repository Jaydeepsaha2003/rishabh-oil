import { withDbTransaction } from './dbTransaction'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { resolveAccountName } from './ledgerMap'
import { partyAccountName } from './partyLedgers'
import { getBooksFrom } from './openings'
import { ALLOC } from './tankerAlloc'
import { gstLines, asGstType, gstLedgerName } from './gstLedgers'
import { assertManualVoucher } from './voucherOwnership'
import { ensureVoucherNumbers, permanentVoucherCodes, renumberOnTypeChange } from './voucherNumbers'
import { normalizedJournalLines, validateCashFlow } from './voucherValidation'

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

export async function getOrCreateAccount(
  name: string,
  group = 'General',
  companyId?: number
): Promise<number> {
  const c = getClient()
  // WHAT THE CODE ASKS FOR IS NOT ALWAYS WHAT IT POSTS TO.
  //
  // Half this app addresses ledgers by name — `{OIL} PUR A/C`, `GST INPUT
  // A/C`, `HDFCBANK A/C` — and this function makes the account if the name is
  // not there. That is exactly why renaming one used to be unsafe: the next
  // posting opened a SECOND account under the old name and left the history
  // behind in the first.
  //
  // ledger_map is checked first, so a renamed or re-pointed ledger is followed
  // instead of re-created. A book with no map behaves exactly as it always
  // did. See src/main/ledgerMap.ts.
  const wanted = await resolveAccountName(name, companyId)
  const clean = String(wanted || '').trim().toUpperCase()
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

// WHICH BOOKS A LEDGER BELONGS TO.
//
// Ledgers are one shared list — a name is unique across both companies — so
// KR FINMARK's LC PAYABLE - CSB sat in KR FOODS' chart of accounts as well. A
// ledger is a company's when it has postings in that company's books, an
// opening entered there, or was CREATED while that company was open (recorded
// here, since a new ledger has neither yet). One no company has used at all —
// CASH A/C, a party not yet traded with — belongs to every book.
let homesReady = false
export async function ensureLedgerHomes(): Promise<void> {
  if (homesReady) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS ledger_homes (
    account_id INTEGER NOT NULL,
    company_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, company_id)
  )`)
  homesReady = true
}

export async function listAccounts(companyId?: number): Promise<Row[]> {
  // Accounts are shared; balances are per company (separate books) — the
  // caller may pin one, else the active company.
  await ensureLedgerHomes()
  const cid = companyId || getActiveCompanyId()
  const booksFrom = await getBooksFrom(cid)
  const res = await getClient().execute({
    args: [cid, cid, cid, cid, cid, cid, booksFrom || '0000-00-00'],
    sql: `
    SELECT a.*,
      -- Whether this ledger belongs to the company in view (see ensureLedgerHomes).
      CASE
        WHEN EXISTS (SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                      WHERE jl.account_id = a.id AND je.company_id = ?) THEN 1
        WHEN EXISTS (SELECT 1 FROM ledger_openings lo
                      WHERE lo.account_id = a.id AND lo.company_id = ? AND (ABS(lo.dr) > 0.004 OR ABS(lo.cr) > 0.004)) THEN 1
        WHEN EXISTS (SELECT 1 FROM ledger_homes lh WHERE lh.account_id = a.id AND lh.company_id = ?) THEN 1
        WHEN NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM ledger_openings lo WHERE lo.account_id = a.id AND (ABS(lo.dr) > 0.004 OR ABS(lo.cr) > 0.004))
         AND NOT EXISTS (SELECT 1 FROM ledger_homes lh WHERE lh.account_id = a.id) THEN 1
        ELSE 0
      END AS in_company,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance,
      -- WHAT THE LEDGER ITSELF CLOSES AT: the opening entered for this book,
      -- plus the postings from the day the books start. \`balance\` above is
      -- every posting ever, opening left out — a bank whose BD and LC
      -- vouchers from before the books start were already inside its opening
      -- read ₹4.39 Cr Dr in the picker while the ledger closed at ₹10.89 Cr Cr.
      COALESCE((SELECT SUM(lo.dr) - SUM(lo.cr) FROM ledger_openings lo
                WHERE lo.account_id = a.id AND lo.company_id = ?), 0)
      + COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                  FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                  WHERE jl.account_id = a.id AND je.company_id = ? AND je.entry_date >= ?), 0) AS closing,
      -- Postings across EVERY company, not just the one in view.
      (SELECT COUNT(*) FROM journal_lines jl2 WHERE jl2.account_id = a.id) AS line_count,
      (SELECT COUNT(*) FROM journal_bill_allocs ba WHERE ba.account_id = a.id) AS alloc_count,
      -- Whether a master still claims this name. A party or a standing account
      -- with no postings YET is perfectly normal — CASH A/C, FREIGHT INWARD
      -- A/C, a transporter not yet billed — and must never be offered for
      -- deletion. Only a name nothing claims is a genuine leftover, which is
      -- what a rename used to strand.
      (SELECT COUNT(*) FROM customers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM suppliers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM transporters m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) +
      (SELECT COUNT(*) FROM brokers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name))) AS claimed_by_master,
      -- The party behind this ledger runs a Trading or a Manufacturing book;
      -- read off the master that names it (a debtor is a customer, a creditor a
      -- supplier). A ledger no party claims — a purchase head, a bank — has none.
      --
      -- A RENAMED LEDGER STILL HAS A PARTY. Renaming the ledger does not rename
      -- the customer or supplier, so the master keeps the old name while the
      -- ledger wears the new one; the rename records the two in ledger_map
      -- (posts_as = the old name, use_name = this ledger). So when the name on
      -- the ledger finds no master, the redirected-from name is tried too.
      COALESCE(
        (SELECT m.business_type FROM customers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name)) LIMIT 1),
        (SELECT m.business_type FROM suppliers m WHERE TRIM(UPPER(m.name)) = TRIM(UPPER(a.name)) LIMIT 1),
        (SELECT m.business_type FROM customers m
           JOIN ledger_map lm ON TRIM(UPPER(lm.posts_as)) = TRIM(UPPER(m.name))
          WHERE TRIM(UPPER(lm.use_name)) = TRIM(UPPER(a.name)) LIMIT 1),
        (SELECT m.business_type FROM suppliers m
           JOIN ledger_map lm ON TRIM(UPPER(lm.posts_as)) = TRIM(UPPER(m.name))
          WHERE TRIM(UPPER(lm.use_name)) = TRIM(UPPER(a.name)) LIMIT 1)
      ) AS business_type
    FROM ledger_accounts a ORDER BY a.name
  `
  })
  return toPlain(res)
}

export async function createAccount(name: string, group = 'General', companyId?: number): Promise<{ id: number }> {
  const id = await getOrCreateAccount(name, group)
  // Made while a company was open: it is that company's ledger from now on,
  // before it has a posting or an opening to say so.
  await ensureLedgerHomes()
  await getClient().execute({
    sql: 'INSERT OR IGNORE INTO ledger_homes (account_id, company_id) VALUES (?, ?)',
    args: [id, companyId || getActiveCompanyId()]
  })
  return { id }
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
  return withDbTransaction(async () => {
  const c = getClient()
  const lines = normalizedJournalLines(a.lines)
  await validateCashFlow(a.vchType, lines, a.companyId)
  await ensureVoucherNumbers()
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
    // A party line never lands on the other side's ledger (partyLedgers.ts).
    const accountId = await getOrCreateAccount(await partyAccountName(l.account, l.group, a.companyId), l.group, a.companyId)
    await c.execute({
      sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
      args: [entryId, accountId, n(l.dr), n(l.cr)]
    })
  }
  await ensureVoucherNumbers()
  return { id: entryId }
  })
}

// Re-post an EXISTING entry in place, keeping its id.
//
// The voucher number a ledger shows is positional: every journal for the
// company, ordered by id, numbered 1..n (see voucherCodeMap). So deleting a
// voucher and inserting its replacement does two unwanted things — the new one
// lands at the END of the sequence with a different number, and every voucher
// after the deleted one shifts down by one.
//
// That is why LC-15 read JV/46 on one page and JV/23 on another: the same
// settlement had been re-posted between the two renders. Updating in place
// keeps the id, so the number stays put and nothing around it moves.
//
// Same balance check as postJournal — an in-place update must not be a way to
// write an unbalanced entry.
export async function repostJournal(entryId: number, a: PostArgs): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const id = n(entryId)
  if (!id) throw new Error('No entry to re-post')
  const exists = await c.execute({ sql: 'SELECT id, company_id FROM journal_entries WHERE id = ?', args: [id] })
  if (!exists.rows.length) throw new Error('That journal entry no longer exists')
  if (a.companyId && a.companyId !== Number(exists.rows[0].company_id)) throw new Error('A voucher cannot move between companies')
  a = { ...a, companyId: Number(exists.rows[0].company_id) }
  await ensureVoucherNumbers()

  const lines = normalizedJournalLines(a.lines)
  await validateCashFlow(a.vchType, lines, a.companyId)
  if (!lines.length) throw new Error('Journal entry has no amounts')
  const dr = lines.reduce((s, l) => s + n(l.dr), 0)
  const cr = lines.reduce((s, l) => s + n(l.cr), 0)
  if (Math.abs(dr - cr) > 0.01) {
    throw new Error(`Journal not balanced (Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)})`)
  }

  await c.execute({
    sql: `UPDATE journal_entries
             SET entry_date = ?, vch_type = ?, vch_no = ?, narration = ?,
                 order_id = ?, sale_id = ?, payment_id = ?
           WHERE id = ?`,
    args: [
      a.date,
      a.vchType,
      a.vchNo || null,
      a.narration || null,
      a.orderId ?? null,
      a.saleId ?? null,
      a.paymentId ?? null,
      id
    ]
  })
  await renumberOnTypeChange(id, a.vchType)
  // The lines themselves are replaced: which accounts appear can change between
  // one posting and the next (a nil interest line simply is not written), so
  // matching them up would be guesswork. Their bill allocations go with them and
  // are re-made by the caller.
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM journal_line_splits WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [id] })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
  for (const l of lines) {
    // A party line never lands on the other side's ledger (partyLedgers.ts).
    const accountId = await getOrCreateAccount(await partyAccountName(l.account, l.group, a.companyId), l.group, a.companyId)
    await c.execute({
      sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
      args: [id, accountId, n(l.dr), n(l.cr)]
    })
  }
  return { id }
  })
}

// Remove auto-posted entries tied to a source document (used before reposting).
export async function deleteJournalByRef(
  refCol: 'order_id' | 'sale_id' | 'payment_id',
  refId: number
): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT id FROM journal_entries WHERE ${refCol} = ?`,
    args: [refId]
  })
  for (const r of res.rows) {
    await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [r.id] })
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [r.id] })
  }
  })
}

// Manual entries (Journal / Dr Note / Cr Note / Opening) have no source refs.
export async function deleteManualEntry(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  await assertManualVoucher(id)
  await ensureVoucherNumbers()
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
  // Same rule for a transporter's freight bill. Deleting its voucher here used
  // to leave the bill row behind with its freight lines still flagged as
  // billed, so they never came back to Unbilled on the Freight Working
  // register — the voucher was gone but the register still read as booked.
  const billRef = await c.execute({
    sql: 'SELECT id, bill_no FROM transporter_bills WHERE journal_entry_id = ? LIMIT 1',
    args: [id]
  })
  if (billRef.rows.length) {
    throw new Error(
      `This voucher is transporter bill ${String(billRef.rows[0].bill_no || billRef.rows[0].id)} — delete it from the Freight Working register so its freight lines go back to unbilled`
    )
  }
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [id] })
  return { id }
  })
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
export async function voucherCodeMap(companyId: number): Promise<Map<number, string>> {
  return permanentVoucherCodes(companyId)
}

export async function accountStatement(accountId: number, companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  // Nothing before the books begin. Those vouchers still exist — an LC needs to
  // know what it advanced — but the ledger's answer for that period is the
  // entered opening balance, not a list of entries that were never this
  // company's accounts.
  const booksFrom = await getBooksFrom(cid)
  const res = await c.execute({
    sql: `SELECT jl.id, je.id AS entry_id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 jl.dr, jl.cr, je.order_id, je.sale_id, je.payment_id,
                 -- THE DOCUMENT'S OWN NUMBER, for the Ref no column.
                 -- A purchase voucher's reference is the supplier's invoice
                 -- number and a sale's is the invoice raised — which is what
                 -- anybody reading a ledger line is looking for, and what they
                 -- would otherwise have to open the voucher to find. Read from
                 -- the document itself rather than guessed at from the
                 -- narration, which is prose and can be edited.
                 (SELECT o.invoice_no FROM orders o WHERE o.id = je.order_id) AS order_invoice_no,
                 -- THE PURCHASE'S TANKERS, and how many are emptied — so the
                 -- statement can leave out a bill whose oil is still on the
                 -- road (Tanker empty view).
                 (SELECT COUNT(*) FROM ${ALLOC} ta WHERE ta.order_id = je.order_id) AS tanker_total,
                 (SELECT COUNT(*) FROM ${ALLOC} ta JOIN purchase_tankers tp ON tp.id = ta.tanker_id
                   WHERE ta.order_id = je.order_id AND tp.status = 'empty') AS tanker_empty,
                 -- The day the bill's last tanker was emptied (Empty date view).
                 (SELECT MAX(tp.empty_date) FROM ${ALLOC} ta JOIN purchase_tankers tp ON tp.id = ta.tanker_id
                   WHERE ta.order_id = je.order_id AND tp.status = 'empty') AS tanker_last_empty,
                 (SELECT sl.invoice_no FROM sales sl WHERE sl.id = je.sale_id) AS sale_invoice_no,
                 -- AND WHOSE BOOK THE DOCUMENT IS IN.
                 -- Almost always this ledger's own, and once in a while not:
                 -- an inter-company transfer can post its voucher in one
                 -- company while the purchase itself belongs to the other. The
                 -- drill-through switches company before it opens the page, so
                 -- it has to switch to the DOCUMENT's — sent to the ledger's,
                 -- the page opens in a book the bill does not exist in and the
                 -- click looks like it did nothing.
                 (SELECT o.company_id FROM orders o WHERE o.id = je.order_id) AS order_company_id,
                 (SELECT sl.company_id FROM sales sl WHERE sl.id = je.sale_id) AS sale_company_id,
                 -- WHICH LETTER OF CREDIT POSTED THIS VOUCHER.
                 --
                 -- Every LC voucher is already named exactly, by the LC itself
                 -- or by one of its issuances, repayments or payment-ins —
                 -- each of those rows holds the journal_entry_id it wrote. So
                 -- the link is looked up, not guessed at from the narration.
                 --
                 -- It has to be looked up, because an LC NUMBER does not
                 -- identify an LC: this book has LC-1 through LC-8 twice over
                 -- in one company, and matching by number opened whichever the
                 -- register happened to return first.
                 COALESCE(
                   (SELECT lc.id FROM letters_of_credit lc
                     WHERE lc.journal_entry_id = je.id
                        OR lc.interest_journal_entry_id = je.id
                        OR lc.preclose_journal_entry_id = je.id
                        OR lc.preclose_interest_journal_entry_id = je.id
                        OR lc.preclose_payout_journal_entry_id = je.id
                        OR lc.charges_journal_entry_id = je.id
                        OR lc.fee_adjust_journal_entry_id = je.id
                        OR lc.payment_in_journal_entry_id = je.id
                     LIMIT 1),
                   (SELECT i.lc_id FROM lc_issuances i WHERE i.journal_entry_id = je.id LIMIT 1),
                   (SELECT pi.lc_id FROM lc_payment_ins pi WHERE pi.journal_entry_id = je.id LIMIT 1),
                   (SELECT r.lc_id FROM lc_repayments r
                     WHERE r.journal_entry_id = je.id OR r.fee_journal_entry_id = je.id LIMIT 1)
                 ) AS lc_id,
                 (SELECT l3.lc_no FROM letters_of_credit l3 WHERE l3.id = COALESCE(
                   (SELECT lc.id FROM letters_of_credit lc
                     WHERE lc.journal_entry_id = je.id
                        OR lc.interest_journal_entry_id = je.id
                        OR lc.preclose_journal_entry_id = je.id
                        OR lc.preclose_interest_journal_entry_id = je.id
                        OR lc.preclose_payout_journal_entry_id = je.id
                        OR lc.charges_journal_entry_id = je.id
                        OR lc.fee_adjust_journal_entry_id = je.id
                        OR lc.payment_in_journal_entry_id = je.id
                     LIMIT 1),
                   (SELECT i.lc_id FROM lc_issuances i WHERE i.journal_entry_id = je.id LIMIT 1),
                   (SELECT pi.lc_id FROM lc_payment_ins pi WHERE pi.journal_entry_id = je.id LIMIT 1),
                   (SELECT r.lc_id FROM lc_repayments r
                     WHERE r.journal_entry_id = je.id OR r.fee_journal_entry_id = je.id LIMIT 1)
                 )) AS lc_no,
                 -- WHICH DISCOUNTED BILL POSTED THIS VOUCHER, and which
                 -- trading deal, by the same rule as the LC above: the row
                 -- that wrote the voucher holds its id, so the link is read
                 -- rather than matched on a number that repeats.
                 COALESCE(
                   (SELECT bd.id FROM bill_discountings bd
                     WHERE bd.journal_entry_id = je.id
                        OR bd.repay_journal_entry_id = je.id
                        OR bd.margin_release_journal_entry_id = je.id
                     LIMIT 1),
                   (SELECT r2.bd_id FROM bd_repayments r2 WHERE r2.journal_entry_id = je.id LIMIT 1),
                   (SELECT ip.bd_id FROM bd_interest_payments ip WHERE ip.journal_entry_id = je.id LIMIT 1)
                 ) AS bd_id,
                 (SELECT b3.bd_no FROM bill_discountings b3 WHERE b3.id = COALESCE(
                   (SELECT bd.id FROM bill_discountings bd
                     WHERE bd.journal_entry_id = je.id
                        OR bd.repay_journal_entry_id = je.id
                        OR bd.margin_release_journal_entry_id = je.id
                     LIMIT 1),
                   (SELECT r2.bd_id FROM bd_repayments r2 WHERE r2.journal_entry_id = je.id LIMIT 1),
                   (SELECT ip.bd_id FROM bd_interest_payments ip WHERE ip.journal_entry_id = je.id LIMIT 1)
                 )) AS bd_no,
                 -- A TRADING DEAL IS TWO INVOICES, so its vouchers are their
                 -- vouchers. A purchase or sale that belongs to one opens the
                 -- deal, where both sides and the margin are, rather than one
                 -- half of it on the purchase page.
                 COALESCE(
                   (SELECT tdo.deal_id FROM trading_deal_orders tdo WHERE tdo.order_id = je.order_id LIMIT 1),
                   (SELECT ds.deal_id FROM trading_deal_sales ds WHERE ds.sale_id = je.sale_id LIMIT 1),
                   (SELECT td.id FROM trading_deals td WHERE td.order_id = je.order_id OR td.sale_id = je.sale_id LIMIT 1)
                 ) AS trading_deal_id,
                 -- THE DEAL BEHIND THE POSTING, for the columnar view.
                 -- A purchase voucher is struck on a bargain and a sale on a
                 -- sales bargain; each carries that bargain's number, its rate
                 -- and its quantity. A voucher with no purchase or sale link —
                 -- a receipt, a journal — carries none, and the column stays
                 -- blank on its row.
                 COALESCE(
                   (SELECT b.bargain_no FROM bargains b JOIN orders o ON o.bargain_id = b.id WHERE o.id = je.order_id LIMIT 1),
                   (SELECT COALESCE(NULLIF(TRIM(sb.manual_bargain_no), ''), sb.bargain_no)
                      FROM sales_bargains sb JOIN sales sl ON sl.sales_bargain_id = sb.id WHERE sl.id = je.sale_id LIMIT 1)
                 ) AS bargain_no,
                 COALESCE(
                   (SELECT o.bargain_rate FROM orders o WHERE o.id = je.order_id),
                   (SELECT sl.rate FROM sales sl WHERE sl.id = je.sale_id)
                 ) AS deal_rate,
                 COALESCE(
                   (SELECT o.ordered_qty FROM orders o WHERE o.id = je.order_id),
                   (SELECT sl.qty FROM sales sl WHERE sl.id = je.sale_id)
                 ) AS deal_qty,
                 -- Interest this voucher carries: a bill-discounting interest
                 -- payment posts its gross here, and a purchase on credit the
                 -- interest worked out for its terms.
                 COALESCE(
                   (SELECT ip.gross FROM bd_interest_payments ip WHERE ip.journal_entry_id = je.id LIMIT 1),
                   (SELECT NULLIF(COALESCE(o.credit_interest_amount, 0) + COALESCE(o.additional_interest, 0), 0)
                      FROM orders o WHERE o.id = je.order_id)
                 ) AS interest_amt
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_id = ? AND je.company_id = ?
            ${booksFrom ? 'AND je.entry_date >= ?' : ''}
          ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC`,
    args: booksFrom ? [accountId, cid, booksFrom] : [accountId, cid]
  })
  const lines = toPlain(res)
  if (!lines.length) return lines

  // THE BREAKDOWN BEHIND EACH ROW, for the ledger's Excel: this ledger's own
  // line's parts when it has them (ABDUL's ledger, the parts written under
  // ABDUL), otherwise the parts written on the voucher's other lines (the
  // bank's ledger, for that payment) — each part with its remark.
  {
    const entryIds = [...new Set(lines.map((l) => Number(l.entry_id)).filter((x) => x > 0))]
    const byEntry = new Map<number, Row[]>()
    for (let i = 0; i < entryIds.length; i += 400) {
      const chunk = entryIds.slice(i, i + 400)
      const sp = await c
        .execute({
          sql: `SELECT jl.entry_id, jl.id AS line_id, s.name, s.amount, s.note
                  FROM journal_line_splits s JOIN journal_lines jl ON jl.id = s.line_id
                 WHERE jl.entry_id IN (${chunk.map(() => '?').join(',')})
                 ORDER BY jl.id, s.sort_order, s.id`,
          args: chunk
        })
        .catch(() => ({ rows: [] }) as unknown as ResultSet)
      for (const r of sp.rows as unknown as Row[]) {
        const k = Number(r.entry_id)
        if (!byEntry.has(k)) byEntry.set(k, [])
        ;(byEntry.get(k) as Row[]).push({ line_id: Number(r.line_id), name: String(r.name || ''), amount: Number(r.amount) || 0, note: r.note ? String(r.note) : null })
      }
    }
    for (const l of lines) {
      const all = byEntry.get(Number(l.entry_id)) || []
      if (!all.length) continue
      const own = all.filter((x) => x.line_id === Number(l.id))
      l.splits = (own.length ? own : all).map(({ name, amount, note }) => ({ name, amount, note }))
    }
  }

  // A purchase's interest as an AMOUNT, worked out line by line from its
  // bargains — see orderInterestAmounts. The column used to read the
  // invoice-level additional interest, which is a rate per MT and is empty on
  // an invoice struck on two bargains.
  {
    const { orderInterestAmounts } = await import('./orders')
    const amounts = await orderInterestAmounts(lines.map((l) => Number(l.order_id)).filter((x) => x > 0))
    for (const l of lines) {
      if (!Number(l.order_id)) continue
      const a = amounts.get(Number(l.order_id))
      l.interest_amt = a && Math.abs(a) > 0.004 ? a : null
    }
  }

  // ONE BANK DEBIT THAT REPAID SEVERAL DISCOUNTED BILLS — which bill took
  // what, read from the repayment rows that share the voucher. Shown under the
  // line; the voucher itself keeps its one figure.
  {
    const ids = [...new Set(lines.map((l) => Number(l.entry_id)))]
    const split = ids.length
      ? await c
          .execute({
            sql: `SELECT r.journal_entry_id AS je, b.bd_no, r.amount FROM bd_repayments r JOIN bill_discountings b ON b.id = r.bd_id
                   WHERE r.journal_entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.amount DESC, r.id`,
            args: ids
          })
          .catch(() => null)
      : null
    const byJe = new Map<number, { bd_no: string; amount: number }[]>()
    for (const x of split ? toPlain(split) : []) {
      const k = Number(x.je)
      byJe.set(k, [...(byJe.get(k) || []), { bd_no: String(x.bd_no || ''), amount: Number(x.amount) || 0 }])
    }
    for (const l of lines) {
      const parts = byJe.get(Number(l.entry_id))
      if (parts && parts.length > 1) l.bd_split = parts
    }
  }

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

  // Bill-wise allocations on this account's own line — a lump payment/receipt
  // can settle several invoices at once, so the ledger can expand a row to
  // show exactly how it squares off invoice by invoice.
  const allocRes = await c.execute({
    sql: `SELECT line_id, method, ref_name, order_id, sale_invoice_group, amount
          FROM journal_bill_allocs WHERE line_id IN (${lines.map(() => '?').join(',')})`,
    args: lines.map((l) => Number(l.id))
  })
  const allocsByLine = new Map<number, Row[]>()
  for (const a of toPlain(allocRes)) {
    const k = Number(a.line_id)
    if (!allocsByLine.has(k)) allocsByLine.set(k, [])
    allocsByLine.get(k)!.push(a)
  }

  for (const l of lines) {
    const rest = byEntry.get(Number(l.entry_id)) || []
    const opposite = Number(l.dr) > 0
      ? rest.filter((r) => n(r.cr) > 0).sort((a, b) => n(b.cr) - n(a.cr))
      : rest.filter((r) => n(r.dr) > 0).sort((a, b) => n(b.dr) - n(a.dr))
    // The opposite line that carries EXACTLY this one's amount is what it was
    // posted against — a sale voucher's freight line (Dr FREIGHT OUTWARD
    // 20,595) read "RPO SALE A/C" because the sale was the biggest credit,
    // when its counterpart is Cr FREIGHT PAYABLE 20,595. Otherwise the largest.
    const own = n(l.dr) > 0 ? n(l.dr) : n(l.cr)
    const exact = opposite.filter((r) => Math.abs((n(l.dr) > 0 ? n(r.cr) : n(r.dr)) - own) < 0.005)
    l.particulars = String((exact.length === 1 ? exact[0] : opposite[0] || rest[0])?.name || '')
    l.voucher_code = codes.get(Number(l.entry_id)) || ''
    // Every other leg of the voucher, for the ledger's DETAILED (Alt+F1) mode.
    l.legs = rest.map((r) => ({ name: String(r.name), dr: n(r.dr), cr: n(r.cr) }))
    l.allocs = allocsByLine.get(Number(l.id)) || []
  }
  return lines
}

// --- auto-posting helpers ---

// Purchase (Tally style):
//   Dr {OILCODE} PUR A/C   taxable value — the supplier's interest included
//                          (it is part of what the oil cost; no INTEREST A/C
//                          line since 2026-10-23 — purchaseInterestFold.ts)
//   Dr INPUT CGST/SGST     gst amount, split by head and rate — see gstLedgers.ts
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
  // The rate and the head this bill was taxed at, so the tax lands in the
  // ledger a return is filed from rather than in one lump.
  gstPct?: number
  gstType?: string | null
  companyId?: number
}): Promise<void> {
  return withDbTransaction(async () => {
  const c = getClient()
  // RE-SAVED, NOT RE-MADE. A purchase edited in Purchases (a rate, a quantity)
  // updates the voucher it already has — same id, same PUR number — instead of
  // deleting it and posting a new one at the end of the sequence. A new id
  // every save left anything holding the voucher (the screen showing it, a
  // link, the number noted down) on one that no longer existed, while the
  // ledger showed the new figures. Only a voucher in the purchase's own
  // company is kept; one filed elsewhere is replaced as before.
  const prior = (await c.execute({ sql: 'SELECT id, company_id FROM journal_entries WHERE order_id = ? ORDER BY id', args: [v.orderId] }))
    .rows as unknown as { id: number; company_id: number }[]
  const want = n(v.companyId) || getActiveCompanyId()
  const keep = prior.find((r) => n(r.company_id) === want)
  for (const r of prior) {
    if (keep && n(r.id) === n(keep.id)) continue
    await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [n(r.id)] })
    await c.execute({ sql: 'DELETE FROM journal_line_splits WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [n(r.id)] }).catch(() => undefined)
    await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [n(r.id)] })
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [n(r.id)] })
  }
  const ro = n(v.roundOff)
  const args: PostArgs = {
    date: v.date,
    vchType: 'PURCHASE OIL',
    vchNo: v.invoiceNo,
    narration: `Purchase ${v.invoiceNo}`,
    orderId: v.orderId,
    companyId: want,
    lines: [
      { account: `${v.oilCode} PUR A/C`, group: 'Purchase Accounts', dr: v.taxable },
      ...gstLines({ side: 'INPUT', pct: n(v.gstPct), type: asGstType(v.gstType), dr: n(v.gst) }),
      { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: ro > 0 ? ro : 0, cr: ro < 0 ? -ro : 0 },
      { account: 'TDS PAYABLE A/C', group: 'Duties & Taxes', cr: v.tds },
      { account: v.supplierName, group: 'Sundry Creditors', cr: v.net }
    ]
  }
  if (keep) await repostJournal(n(keep.id), args)
  else await postJournal(args)
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
  return withDbTransaction(async () => {
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
  })
}

// Sale:  Dr {Customer}          net (taxable + output GST) — no TDS leg; a
//                               sale posts none (see SALE_TDS_PCT in sales.ts)
//          Cr {FG} SALE A/C      taxable
//          Cr OUTPUT CGST/SGST   gst, split by head and rate — see gstLedgers.ts
// FOR delivery (we run and pay the transporter): NOTHING for the freight on
// this voucher since 2026-10-01. It waits on the Fr. Outward Working register,
// provisional, and is booked when the transporter's bill is entered there —
// Dr FREIGHT OUTWARD, Cr the transporter. (It used to accrue here, Dr FREIGHT
// OUTWARD / Cr FREIGHT PAYABLE, on a rate and quantity that could still move.)
// Freight DEDUCTED from the customer stays on this voucher — Dr FREIGHT
// OUTWARD against the smaller customer debit — because their bill is net of
// it. It has to be in THIS voucher, not a second one keyed by the same
// sale_id: deleteJournalByRef below wipes every entry for a ref regardless of
// vchType, so two independent postJournal calls would erase each other.
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

export async function postSaleJournal(v: {
  saleId: number
  date: string
  invoiceNo: string | null
  productCode: string
  customerName: string
  amount: number
  gst?: number
  roundOff?: number
  freightAmount?: number
  transporterName?: string | null
  // The customer settles the transporter directly and the freight comes OFF
  // their bill. See the freight legs below for why that changes the posting
  // rather than just the wording.
  deductFreight?: boolean
  // No longer posted: a sale carries no TDS (see SALE_TDS_PCT in sales.ts).
  // Kept so an old caller still type-checks; whatever it passes is ignored.
  tds?: number
  // The rate and the head this invoice was taxed at.
  gstPct?: number
  gstType?: string | null
  companyId?: number
}): Promise<void> {
  return withDbTransaction(async () => {
  // The sale's EXISTING voucher, if it has one. It is rewritten in place
  // rather than deleted and re-inserted, because voucher numbers here are
  // positional: voucherCodeMap() orders a company's entries by id and numbers
  // them 1..n per prefix, so a fresh entry lands at the end of the sequence
  // with a new number and shifts every voucher after the old one. Editing a
  // sale used to do exactly that to its own SALE number.
  const prior = await getClient().execute({
    sql: 'SELECT id FROM journal_entries WHERE sale_id = ? ORDER BY id',
    args: [v.saleId]
  })
  const priorIds = prior.rows.map((r) => n((r as unknown as Row).id)).filter(Boolean)
  const taxable = n(v.amount)
  const gst = n(v.gst)
  // Round off shifts the customer's net: +ve rounds the invoice up (customer
  // owes more, Cr ROUND OFF), −ve rounds down (Dr ROUND OFF).
  const ro = n(v.roundOff)
  const freight = n(v.freightAmount)
  const transporterName = String(v.transporterName || '').trim()
  // Nothing left to post — the voucher goes, as it did before.
  if (taxable <= 0 && gst <= 0) {
    await deleteJournalByRef('sale_id', v.saleId)
    return
  }
  // Freight deducted from the invoice: the customer pays the truck, so their
  // bill drops by it and we never owe the transporter for it.
  //
  //   Dr Customer   t + g + ro − f
  //   Dr Freight outward       f      (still our cost)
  //   Cr Sales / GST / Round off
  //
  // The arithmetic forces the pairing: the customer paying f less and us still
  // owing the transporter f cannot both hold without expensing the freight
  // twice. So a deducted freight books NO payable — which is exactly why it
  // also stops showing as ours to pay on the freight register.
  const hasFreight = freight > 0 && !!transporterName
  const deducted = !!v.deductFreight && hasFreight
  const customerDr = round2(taxable + gst + ro - (deducted ? freight : 0))
  // The round off takes the paisa the GST split rounds away, so the voucher
  // balances with the customer's total unchanged — see postSaleInvoiceJournal.
  const gstL = gstLines({ side: 'OUTPUT', pct: n(v.gstPct), type: asGstType(v.gstType), cr: gst })
  const gstStored = round2(gstL.reduce((t, l) => t + round2(n(l.cr)), 0))
  const roNet = round2(customerDr + (deducted ? freight : 0) - round2(taxable) - gstStored)
  const lines: JournalLine[] = [
    { account: v.customerName || 'CASH CUSTOMER A/C', group: 'Sundry Debtors', dr: customerDr },
    { account: `${v.productCode} SALE A/C`, group: 'Sales Accounts', cr: taxable },
    ...gstL,
    { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: roNet > 0 ? roNet : 0, dr: roNet < 0 ? -roNet : 0 }
  ]
  // Delivery freight we pay is NOT posted with the sale: it waits on the
  // Fr. Outward Working register until the transporter's bill is booked (see
  // postSaleInvoiceJournal in sales.ts). Only freight deducted from the
  // customer belongs here, because their bill is net of it.
  if (deducted) lines.push({ account: 'FREIGHT OUTWARD A/C', group: 'Direct Expenses', dr: freight })
  const args = {
    date: v.date,
    vchType: 'SALE',
    vchNo: v.invoiceNo,
    saleId: v.saleId,
    companyId: v.companyId,
    lines
  }
  if (priorIds.length) {
    // More than one entry against a single sale should not happen; if it ever
    // did, the earliest keeps the number and the strays go.
    for (const extra of priorIds.slice(1)) {
      await getClient().execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [extra] })
      await getClient().execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [extra] })
    }
    await repostJournal(priorIds[0], args)
    return
  }
  await postJournal(args)
  })
}

// One-time (idempotent) backfill: post journal vouchers for documents created
// before the journal engine existed. Anything already posted is skipped.
export async function backfillJournal(): Promise<void> {
  const c = getClient()

  // Core accounts always exist, even before any voucher touches them.
  await getOrCreateAccount('ROUND OFF A/C', 'Indirect Expenses').catch(() => {})
  await getOrCreateAccount('INTEREST A/C', 'Indirect Expenses').catch(() => {})
  // The tax ledgers a mill on these rates actually files from. Opened up
  // front so a trial balance shows the whole shape of the tax position even
  // before a rate has been used — and a rate nobody has listed here still
  // opens its own the moment something is booked at it (see gstLedgers.ts).
  for (const side of ['INPUT', 'OUTPUT'] as const) {
    for (const pct of [2.5, 9]) {
      await getOrCreateAccount(gstLedgerName(side, 'CGST', pct), 'Duties & Taxes').catch(() => {})
      await getOrCreateAccount(gstLedgerName(side, 'SGST', pct), 'Duties & Taxes').catch(() => {})
    }
    for (const pct of [3, 5, 18]) {
      await getOrCreateAccount(gstLedgerName(side, 'IGST', pct), 'Duties & Taxes').catch(() => {})
    }
  }
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

  // One voucher per INVOICE, and the "already posted" test has to be per
  // invoice too.
  //
  // This used to ask whether each sales ROW had a voucher of its own. Since a
  // sale voucher now covers the whole invoice and is filed under its first
  // line, every other line of a multi-line invoice looked unposted — so on the
  // next start this backfill cheerfully wrote a fresh two-line voucher for each
  // of them, double-counting the revenue and the debtor and quietly undoing the
  // consolidation. It asks about the INVOICE now, and posts the invoice's total
  // rather than one line's.
  const sales = await c.execute(`
    SELECT MIN(s.id) AS id, MIN(s.sale_date) AS sale_date, MIN(s.invoice_no) AS invoice_no,
           MIN(s.customer) AS customer, SUM(s.amount) AS amount, MIN(s.company_id) AS company_id,
           MIN(p.code) AS code, MIN(p.name) AS name
    FROM sales s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries je
      JOIN sales s2 ON s2.id = je.sale_id
      WHERE COALESCE(s2.invoice_group, 'L' || s2.id) = COALESCE(s.invoice_group, 'L' || s.id)
    )
    GROUP BY COALESCE(s.invoice_group, 'L' || s.id)
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
