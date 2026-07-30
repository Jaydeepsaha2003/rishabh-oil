import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'

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

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000)
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Remove one manual journal entry (with its bill-wise rows) by id — used to
// reverse treasury vouchers we posted ourselves.
async function dropEntry(entryId?: number | null): Promise<void> {
  if (!entryId) return
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [entryId]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [entryId] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [entryId] })
}

// Settle the party line of an entry against a named bill reference.
async function allocAgainst(entryId: number, partyName: string, ref: string | null, amount: number): Promise<void> {
  const c = getClient()
  const line = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [entryId, partyName.toUpperCase()]
  })
  if (!line.rows.length) return
  await c.execute({
    sql: 'INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount) VALUES (?, ?, ?, ?, ?)',
    args: [Number(line.rows[0].id), Number(line.rows[0].account_id), ref ? 'agst_ref' : 'on_account', ref, amount]
  })
}

// ---------------------------------------------------------------------------
// Letter of Credit: open charges, usance due dates, maturity settlement.
// ---------------------------------------------------------------------------

// Margin + bank charges voucher when an LC is opened (skipped when both zero).
export async function postLcOpening(lcId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) return
  const lc = toPlain(res)[0]
  await dropEntry(n(lc.journal_entry_id) || null)
  const margin = round2((n(lc.amount) * n(lc.margin_pct)) / 100)
  const charges = round2(n(lc.charges))
  if (margin < 0.005 && charges < 0.005) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    return
  }
  const je = await postJournal({
    date: String(lc.open_date || todayISO()),
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} opened at ${lc.bank} — margin ${margin.toFixed(2)}, charges ${charges.toFixed(2)}`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: 'LC MARGIN A/C', group: 'Deposits (Asset)', dr: margin },
      { account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: charges },
      { account: 'BANK A/C', group: 'Bank Accounts', cr: round2(margin + charges) }
    ]
  })
  await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = ? WHERE id = ?', args: [je.id, lcId] })
}

// A bill under the LC matures and the bank pays the supplier: the payable
// clears against the original invoice, money leaves the bank.
export async function settleLcBill(issuanceId: number, dateIn?: string): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT i.*, l.lc_no, l.bank, l.party_type, l.party_id, l.company_id, s.name AS supplier_name, o.invoice_no
          FROM lc_issuances i
          JOIN letters_of_credit l ON l.id = i.lc_id
          LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.id = ?`,
    args: [issuanceId]
  })
  if (!res.rows.length) throw new Error('LC bill not found')
  const b = toPlain(res)[0]
  if (String(b.status) === 'settled') throw new Error('This bill is already settled')
  const party = String(b.supplier_name || '').trim()
  if (!party) throw new Error('The LC has no supplier party — set it on the LC first')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const amount = round2(n(b.amount))
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(b.bill_no || b.lc_no || ''),
    narration: `LC ${b.lc_no} bill ${b.bill_no || ''} matured — paid by ${b.bank}`,
    companyId: n(b.company_id) || undefined,
    lines: [
      { account: party, group: 'Sundry Creditors', dr: amount },
      { account: 'BANK A/C', group: 'Bank Accounts', cr: amount }
    ]
  })
  await allocAgainst(je.id, party, b.invoice_no ? String(b.invoice_no) : b.bill_no ? String(b.bill_no) : null, amount)
  await c.execute({
    sql: "UPDATE lc_issuances SET status = 'settled', settled_date = ?, journal_entry_id = ? WHERE id = ?",
    args: [date, je.id, issuanceId]
  })
  return { id: issuanceId }
}

export async function reopenLcBill(issuanceId: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE id = ?', args: [issuanceId] })
  if (!res.rows.length) throw new Error('LC bill not found')
  await dropEntry(n(res.rows[0].journal_entry_id) || null)
  await c.execute({
    sql: "UPDATE lc_issuances SET status = 'outstanding', settled_date = NULL, journal_entry_id = NULL WHERE id = ?",
    args: [issuanceId]
  })
  return { id: issuanceId }
}

// ---------------------------------------------------------------------------
// Bill discounting (receivables): discount now, realize at maturity.
//   Discount:  Dr BANK (net)  Dr BILL DISCOUNTING CHARGES (interest+charges)
//                Cr BILLS DISCOUNTED (bill amount)
//   Realize:   Dr BILLS DISCOUNTED (bill amount)  Cr Customer (agst ref)
// ---------------------------------------------------------------------------

export async function discountBill(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const amount = round2(n(v.amount))
  if (amount <= 0) throw new Error('Enter the bill amount')
  if (!v.disc_bank) throw new Error('Name the discounting bank')
  const openDate = String(v.open_date || todayISO()).slice(0, 10)
  const due = String(v.maturity_date || '').slice(0, 10) || addDays(openDate, n(v.tenor_days) || 0)
  if (!due || due <= openDate) throw new Error('The maturity date must fall after the discount date')
  const ratePct = n(v.rate_pct)
  const days = daysBetween(openDate, due)
  const interest = round2((amount * ratePct * days) / 36500)
  const charges = round2(n(v.charges))
  const net = round2(amount - interest - charges)
  if (net <= 0) throw new Error('Interest and charges eat the whole bill — check the rate')

  const partyName = String(v.party_name || '').trim()
  const je = await postJournal({
    date: openDate,
    vchType: 'RECEIPT',
    vchNo: v.bill_nos ? String(v.bill_nos) : null,
    narration: `Bill ${v.bill_nos || ''} of ${partyName || 'party'} discounted at ${v.disc_bank} (${ratePct}% for ${days} days)`,
    companyId: cid,
    lines: [
      { account: 'BANK A/C', group: 'Bank Accounts', dr: net },
      { account: 'BILL DISCOUNTING CHARGES A/C', group: 'Indirect Expenses', dr: round2(interest + charges) },
      { account: 'BILLS DISCOUNTED A/C', group: 'Current Liabilities', cr: amount }
    ]
  })
  const ins = await c.execute({
    sql: `INSERT INTO bill_discounts
      (company_id, party_name, customer_id, invoice_group, disc_bank, bill_nos, amount, open_date, maturity_date,
       rate_pct, charges, interest_amount, net_received, status, journal_entry_id, note, medium)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'bill_discounting')`,
    args: [
      cid,
      partyName || null,
      v.customer_id ? n(v.customer_id) : null,
      v.invoice_group ? String(v.invoice_group) : null,
      String(v.disc_bank),
      v.bill_nos ? String(v.bill_nos) : null,
      amount,
      openDate,
      due,
      ratePct,
      charges,
      interest,
      net,
      je.id,
      v.note ? String(v.note) : null
    ]
  })
  return { id: Number(ins.lastInsertRowid) }
}

// The customer's payment reaches the bank at maturity: the contingent
// liability clears and the customer's bill is settled against its invoice.
export async function realizeBill(id: number, dateIn?: string): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM bill_discounts WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Discounted bill not found')
  const b = toPlain(res)[0]
  if (String(b.status) === 'realized') throw new Error('Already realized')
  const date = String(dateIn || todayISO()).slice(0, 10)
  const amount = round2(n(b.amount))
  const party = String(b.party_name || '').trim()
  const je = await postJournal({
    date,
    vchType: 'JOURNAL',
    vchNo: b.bill_nos ? String(b.bill_nos) : null,
    narration: `Discounted bill ${b.bill_nos || ''} realized — ${party || 'party'} paid ${b.disc_bank}`,
    companyId: n(b.company_id) || undefined,
    lines: [
      { account: 'BILLS DISCOUNTED A/C', group: 'Current Liabilities', dr: amount },
      { account: party || 'CASH CUSTOMER A/C', group: 'Sundry Debtors', cr: amount }
    ]
  })
  await allocAgainst(je.id, party || 'CASH CUSTOMER A/C', b.bill_nos ? String(b.bill_nos) : null, amount)
  await c.execute({
    sql: "UPDATE bill_discounts SET status = 'realized', payment_received_date = ?, realize_entry_id = ? WHERE id = ?",
    args: [date, je.id, id]
  })
  return { id }
}

export async function unrealizeBill(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT realize_entry_id FROM bill_discounts WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Discounted bill not found')
  await dropEntry(n(res.rows[0].realize_entry_id) || null)
  await c.execute({
    sql: "UPDATE bill_discounts SET status = 'pending', payment_received_date = NULL, realize_entry_id = NULL WHERE id = ?",
    args: [id]
  })
  return { id }
}

export async function deleteDiscountedBill(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id, realize_entry_id FROM bill_discounts WHERE id = ?', args: [id] })
  if (res.rows.length) {
    await dropEntry(n(res.rows[0].realize_entry_id) || null)
    await dropEntry(n(res.rows[0].journal_entry_id) || null)
  }
  await c.execute({ sql: 'DELETE FROM bill_discounts WHERE id = ?', args: [id] })
  return { id }
}

// ---------------------------------------------------------------------------
// Monitoring: everything the treasury needs eyes on, in one call.
// ---------------------------------------------------------------------------

export async function treasuryAlerts(): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const today = todayISO()

  const lcs = toPlain(
    await c.execute({
      sql: `SELECT l.*, s.name AS supplier_name,
                   COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized
            FROM letters_of_credit l
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            WHERE l.company_id = ? AND l.status != 'closed'`,
      args: [cid]
    })
  )
  const lcExpiring = lcs
    .map((l) => ({ ...l, days_left: l.expiry_date ? daysBetween(today, String(l.expiry_date)) : null }))
    .filter((l) => l.days_left != null && l.days_left <= 15)
    .sort((a, b) => (a.days_left as number) - (b.days_left as number))

  const lcBills = toPlain(
    await c.execute({
      sql: `SELECT i.*, l.lc_no, l.bank, s.name AS supplier_name, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ? AND COALESCE(i.status, 'outstanding') = 'outstanding' AND i.due_date IS NOT NULL`,
      args: [cid]
    })
  )
  const lcBillsDue = lcBills
    .map((b) => ({ ...b, days_left: daysBetween(today, String(b.due_date)) }))
    .filter((b) => b.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left)

  const bd = toPlain(
    await c.execute({
      sql: `SELECT * FROM bill_discounts
            WHERE company_id = ? AND status != 'realized' AND maturity_date IS NOT NULL`,
      args: [cid]
    })
  )
  const billsDue = bd
    .map((b) => ({ ...b, days_left: daysBetween(today, String(b.maturity_date)) }))
    .filter((b) => b.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left)

  return {
    lcExpiring,
    lcBillsDue,
    billsDue,
    overdue:
      lcBillsDue.filter((b) => b.days_left < 0).length +
      billsDue.filter((b) => b.days_left < 0).length +
      lcExpiring.filter((l) => (l.days_left as number) < 0).length
  }
}
