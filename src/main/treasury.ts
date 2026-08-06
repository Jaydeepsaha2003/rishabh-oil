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

// Buckets a due date's days-left into the categories the dashboard filters by.
export function duePeriodOf(daysLeft: number | null): string {
  if (daysLeft == null) return 'none'
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= 1) return 't1'
  if (daysLeft <= 7) return 'week'
  if (daysLeft <= 14) return 'fortnight'
  if (daysLeft <= 30) return 'month'
  if (daysLeft <= 90) return 'quarter'
  return 'later'
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

// Margin + usance interest + bank charges voucher when an LC is opened
// (skipped when all three are zero). Interest is simple interest over the
// usance period: amount x interest_pct x usance_days / 365 — the same
// day-count convention interest already uses elsewhere in the books.
export async function postLcOpening(lcId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!res.rows.length) return
  const lc = toPlain(res)[0]
  await dropEntry(n(lc.journal_entry_id) || null)
  const margin = round2((n(lc.amount) * n(lc.margin_pct)) / 100)
  const interest = round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
  const charges = round2(n(lc.charges))
  if (margin < 0.005 && interest < 0.005 && charges < 0.005) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET journal_entry_id = NULL WHERE id = ?', args: [lcId] })
    return
  }
  const je = await postJournal({
    date: String(lc.open_date || todayISO()),
    vchType: 'JOURNAL',
    vchNo: String(lc.lc_no || ''),
    narration: `LC ${lc.lc_no} opened at ${lc.bank} — margin ${margin.toFixed(2)}, interest ${interest.toFixed(2)}, charges ${charges.toFixed(2)}`,
    companyId: n(lc.company_id) || undefined,
    lines: [
      { account: 'LC MARGIN A/C', group: 'Deposits (Asset)', dr: margin },
      { account: 'INTEREST A/C', group: 'Indirect Expenses', dr: interest },
      { account: 'BANK CHARGES A/C', group: 'Indirect Expenses', dr: charges },
      { account: 'BANK A/C', group: 'Bank Accounts', cr: round2(margin + interest + charges) }
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
// LC repayment: US repaying the BANK against a Trading LC's exposure — an
// outflow, not the receivable party paying us (that's tracked separately via
// the LC's own payment-received date). The bank often deducts a variable
// maturity charge at the same moment, so both come off our account as ONE
// combined withdrawal. Logged first (with its bank document), posted to the
// books only once confirmed — `posted` is the yes/no gate the notes ask for.
// ---------------------------------------------------------------------------

export async function listLcRepayments(lcId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT r.*, cu.name AS party_name FROM lc_repayments r
          LEFT JOIN customers cu ON cu.id = r.party_id
          WHERE r.lc_id = ? ORDER BY r.id DESC`,
    args: [lcId]
  })
  return toPlain(res)
}

// Posts (or re-posts) the repayment's journal entry: money leaves our bank —
// the repayment itself and any maturity charge combine into that one Bank
// credit line, matching the single combined debit the bank statement shows.
async function postLcRepaymentEntry(repaymentId: number): Promise<void> {
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT r.*, l.lc_no, l.company_id, l.bank
          FROM lc_repayments r
          JOIN letters_of_credit l ON l.id = r.lc_id
          WHERE r.id = ?`,
    args: [repaymentId]
  })
  if (!res.rows.length) throw new Error('Repayment not found')
  const rep = toPlain(res)[0]
  await dropEntry(n(rep.journal_entry_id) || null)
  const amount = round2(n(rep.amount))
  const maturityCharges = round2(n(rep.maturity_charges))
  const date = String(rep.repay_date || todayISO()).slice(0, 10)
  const lines: { account: string; group: string; dr?: number; cr?: number }[] = [
    { account: 'LC REPAYMENT A/C', group: 'Loans (Liability)', dr: amount }
  ]
  if (maturityCharges > 0.005) {
    lines.push({ account: 'MATURITY CHARGES A/C', group: 'Indirect Expenses', dr: maturityCharges })
  }
  lines.push({ account: 'BANK A/C', group: 'Bank Accounts', cr: round2(amount + maturityCharges) })
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: rep.lc_no ? String(rep.lc_no) : null,
    narration: `LC ${rep.lc_no} repaid to ${rep.bank || 'the bank'}${maturityCharges > 0.005 ? ` (incl. ${maturityCharges.toFixed(2)} maturity charges)` : ''}`,
    companyId: n(rep.company_id) || undefined,
    lines
  })
  await c.execute({ sql: 'UPDATE lc_repayments SET journal_entry_id = ? WHERE id = ?', args: [je.id, repaymentId] })
}

export async function saveLcRepayment(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const lcId = n(v.lc_id)
  if (!lcId) throw new Error('Pick the LC this repayment is against')
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the repayment amount')
  const posted = v.posted ? 1 : 0
  const args = [
    lcId,
    v.party_id ? n(v.party_id) : null,
    amount,
    n(v.maturity_charges),
    v.repay_date ? String(v.repay_date).slice(0, 10) : todayISO(),
    posted,
    v.document_path ? String(v.document_path) : null,
    v.note ? String(v.note).trim() : null
  ]
  let id: number
  if (v.id) {
    id = n(v.id)
    const prev = await c.execute({ sql: 'SELECT posted, journal_entry_id FROM lc_repayments WHERE id = ?', args: [id] })
    if (!prev.rows.length) throw new Error('Repayment not found')
    await c.execute({
      sql: `UPDATE lc_repayments SET lc_id = ?, party_id = ?, amount = ?, maturity_charges = ?, repay_date = ?, posted = ?,
            document_path = ?, note = ? WHERE id = ?`,
      args: [...args, id]
    })
    if (n(prev.rows[0].posted) && !posted) {
      await dropEntry(n(prev.rows[0].journal_entry_id) || null)
      await c.execute({ sql: 'UPDATE lc_repayments SET journal_entry_id = NULL WHERE id = ?', args: [id] })
    }
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO lc_repayments (lc_id, party_id, amount, maturity_charges, repay_date, posted, document_path, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args
    })
    id = Number(ins.lastInsertRowid)
  }
  if (posted) {
    try {
      await postLcRepaymentEntry(id)
    } catch (e) {
      // Never leave a row flagged posted (and so counted against the LC's
      // outstanding/headroom) when the journal it claims to back doesn't exist.
      await c.execute({ sql: 'UPDATE lc_repayments SET posted = 0 WHERE id = ?', args: [id] })
      throw e
    }
  }
  return { id }
}

export async function deleteLcRepayment(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_repayments WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropEntry(n(res.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_repayments WHERE id = ?', args: [id] })
  return { id }
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

// Every payment obligation being run through treasury, in one place — LC
// bills and discounted bills, regardless of how close their due date is
// (treasuryAlerts only surfaces what's urgent). One list, one status, one
// due date, sorted soonest-first, so nothing tracked here needs checking in
// three different tabs.
export async function listPaymentTracker(): Promise<Row[]> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const today = todayISO()

  const lcBills = toPlain(
    await c.execute({
      sql: `SELECT i.id, i.amount, i.due_date, i.status, i.issue_date,
                   l.lc_no AS ref, l.bank, s.name AS party, o.invoice_no
            FROM lc_issuances i
            JOIN letters_of_credit l ON l.id = i.lc_id
            LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
            LEFT JOIN orders o ON o.id = i.order_id
            WHERE l.company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: 'lc_bill' as const,
    kind_label: 'LC bill',
    ref: String(r.ref || ''),
    detail: `${r.bank || ''}${r.invoice_no ? ` · inv ${r.invoice_no}` : ''}`,
    party: String(r.party || ''),
    amount: n(r.amount),
    due_date: r.due_date ? String(r.due_date) : null,
    status: String(r.status || 'outstanding'),
    settled: String(r.status || 'outstanding') === 'settled'
  }))

  const bd = toPlain(
    await c.execute({
      sql: `SELECT id, amount, net_received, maturity_date, status, disc_bank, party_name, invoice_group, bill_nos
            FROM bill_discounts WHERE company_id = ?`,
      args: [cid]
    })
  ).map((r) => ({
    kind: 'bill_discount' as const,
    kind_label: 'Bill discounting',
    ref: String(r.bill_nos || r.invoice_group || ''),
    detail: String(r.disc_bank || ''),
    party: String(r.party_name || ''),
    amount: n(r.amount),
    due_date: r.maturity_date ? String(r.maturity_date) : null,
    status: String(r.status || 'outstanding'),
    settled: String(r.status || '') === 'realized'
  }))

  const all = [...lcBills, ...bd].map((r) => {
    const daysLeft = r.due_date ? daysBetween(today, r.due_date) : null
    return {
      ...r,
      days_left: daysLeft,
      due_period: duePeriodOf(daysLeft),
      overdue: !r.settled && daysLeft != null && daysLeft < 0
    }
  })
  all.sort((a, b) => {
    if (a.settled !== b.settled) return a.settled ? 1 : -1 // open items first
    const ad = a.days_left ?? Infinity
    const bd2 = b.days_left ?? Infinity
    return ad - bd2
  })
  return all
}
