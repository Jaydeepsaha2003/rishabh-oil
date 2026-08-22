import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postJournal, type JournalLine } from './journal'

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

// ---------------------------------------------------------------------------
// Bill Discounting (PID/SID): an LC-style facility with no stage machine and
// no invoice link — a bill is opened directly with its own Payment Received
// and Maturity dates, priced against an NBFC's margin/interest/TDS terms.
// PID (Purchase Invoice Discounting) draws against a supplier; SID (Sales
// Invoice Discounting) draws against a customer.
// ---------------------------------------------------------------------------

// Same shape LC's netAvailable() uses — kept here (not just in the renderer)
// so the journal always posts exactly what the screen shows.
export function bdCalc(bd: Row): {
  intDays: number
  marginAmount: number
  interestAmount: number
  tdsAmount: number
  receiptAmount: number
} {
  const amount = n(bd.amount)
  const from = String(bd.payment_received_date || '').slice(0, 10)
  const to = String(bd.maturity_date || '').slice(0, 10)
  const intDays = from && to ? Math.max(0, daysBetween(from, to)) : 0
  const marginAmount = round2((amount * n(bd.margin_pct)) / 100)
  const interestAmount = round2((amount * n(bd.interest_pct) * intDays) / (100 * 365))
  const tdsAmount = round2((interestAmount * n(bd.tds_pct)) / 100)
  const receiptAmount = bd.interest_upfront
    ? round2(amount - marginAmount)
    : round2(amount - marginAmount - interestAmount + tdsAmount)
  return { intDays, marginAmount, interestAmount, tdsAmount, receiptAmount }
}

// Remove one manual journal entry (with its bill-wise rows) — used to
// reverse/re-post a voucher we posted ourselves.
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

// Settle a journal line against a named bill reference (bill-wise) or leave
// it general (on account) — the same allocation mechanism LC/orders/sales
// already use.
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

async function loadBd(id: number): Promise<Row> {
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name,
                 s.name AS supplier_name, cu.name AS customer_name
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE bd.id = ?`,
    args: [id]
  })
  if (!res.rows.length) throw new Error('Bill Discounting entry not found')
  return toPlain(res)[0]
}

function partyName(bd: Row): string {
  return String(bd.party_type === 'supplier' ? bd.supplier_name : bd.customer_name || '').trim()
}

// Margin/interest/TDS voucher when a bill is opened (skipped if all three —
// and the amount itself — are zero). Mirrors LC's postLcOpening: the NBFC
// funds the discounted amount net of its own deductions; what we owe it back
// at maturity is the full face amount.
export async function postBdOpening(bdId: number): Promise<void> {
  const c = getClient()
  const bd = await loadBd(bdId)
  await dropEntry(n(bd.journal_entry_id) || null)
  const calc = bdCalc(bd)
  const upfront = !!bd.interest_upfront
  const interest = upfront ? 0 : calc.interestAmount
  const tds = upfront ? 0 : calc.tdsAmount
  const amount = n(bd.amount)
  if (calc.marginAmount < 0.005 && interest < 0.005 && amount < 0.005) {
    await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = NULL WHERE id = ?', args: [bdId] })
    return
  }
  const lines: JournalLine[] = [{ account: 'BANK A/C', group: 'Bank Accounts', dr: calc.receiptAmount }]
  if (calc.marginAmount > 0.005) lines.push({ account: 'BD MARGIN A/C', group: 'Deposits (Asset)', dr: calc.marginAmount })
  if (interest > 0.005) lines.push({ account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: interest })
  if (tds > 0.005) lines.push({ account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: tds })
  lines.push({ account: 'BILLS DISCOUNTED A/C', group: 'Loans (Liability)', cr: amount })
  const je = await postJournal({
    date: String(bd.payment_received_date || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration:
      `Bill Discounting ${bd.bd_no || ''} (${bd.finance_type}) opened with ${bd.nbfc_name || 'the NBFC'} — ` +
      `margin ${calc.marginAmount.toFixed(2)}, interest ${interest.toFixed(2)}, TDS ${tds.toFixed(2)}` +
      (upfront ? ' (interest deferred, settled upfront on reconciliation)' : ''),
    companyId: n(bd.company_id) || undefined,
    lines
  })
  await c.execute({ sql: 'UPDATE bill_discountings SET journal_entry_id = ? WHERE id = ?', args: [je.id, bdId] })
}

// Posts the deferred interest + TDS voucher once reconciled from the bank
// statement, for a bill that was opened with interest_upfront — mirrors LC's
// postLcUpfrontInterest.
export async function postBdUpfrontInterest(bdId: number, dateIn?: string): Promise<{ id: number } | null> {
  const c = getClient()
  const bd = await loadBd(bdId)
  if (!bd.interest_upfront) throw new Error('This Bill Discounting entry was not opened with interest upfront')
  const calc = bdCalc(bd)
  const total = round2(calc.interestAmount)
  if (total < 0.005) return null
  const je = await postJournal({
    date: String(dateIn || todayISO()).slice(0, 10),
    vchType: 'JOURNAL',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} — interest ${calc.interestAmount.toFixed(2)} (TDS ${calc.tdsAmount.toFixed(2)}) settled upfront, per the bank statement`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'INTEREST ON BILL DISCOUNTING A/C', group: 'Indirect Expenses', dr: calc.interestAmount },
      { account: 'TDS ON INTEREST PAYABLE A/C', group: 'Duties & Taxes', cr: calc.tdsAmount },
      { account: 'BANK A/C', group: 'Bank Accounts', cr: round2(calc.interestAmount - calc.tdsAmount) }
    ]
  })
  return { id: je.id }
}

// The margin/security deposit released back as cash once the bill is
// repaid and the NBFC no longer needs it held — mirrors postLcMarginRelease.
async function postBdMarginRelease(bd: Row): Promise<{ id: number } | null> {
  const calc = bdCalc(bd)
  if (calc.marginAmount < 0.005) return null
  const je = await postJournal({
    date: String(bd.repaid_date || todayISO()).slice(0, 10),
    vchType: 'RECEIPT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} repaid — margin of ${calc.marginAmount.toFixed(2)} refunded by ${bd.nbfc_name || 'the NBFC'}`,
    companyId: n(bd.company_id) || undefined,
    lines: [
      { account: 'BANK A/C', group: 'Bank Accounts', dr: calc.marginAmount },
      { account: 'BD MARGIN A/C', group: 'Deposits (Asset)', cr: calc.marginAmount }
    ]
  })
  await getClient().execute({
    sql: 'UPDATE bill_discountings SET margin_release_journal_entry_id = ? WHERE id = ?',
    args: [je.id, n(bd.id)]
  })
  return { id: je.id }
}

const BD_COLS = [
  'bd_no',
  'nbfc_id',
  'finance_type',
  'party_type',
  'party_id',
  'purpose',
  'amount',
  'payment_received_date',
  'maturity_date',
  'margin_pct',
  'interest_pct',
  'tds_pct',
  'interest_upfront',
  'note'
]

function bdArgs(v: Row): (string | number | null)[] {
  return BD_COLS.map((k) => {
    if (k === 'interest_upfront') return v[k] ? 1 : 0
    if (['amount', 'margin_pct', 'interest_pct', 'tds_pct'].includes(k)) return n(v[k])
    if (k === 'nbfc_id') return v[k] ? n(v[k]) : null
    const val = v[k]
    return val === '' || val === undefined || val === null ? null : String(val)
  })
}

// Every check a Bill Discounting entry has to pass, on create or edit.
async function validateBd(v: Row): Promise<void> {
  if (!['PID', 'SID'].includes(String(v.finance_type))) throw new Error('Choose PID or SID')
  const partyType = String(v.finance_type) === 'PID' ? 'supplier' : 'customer'
  if (String(v.party_type) !== partyType) throw new Error('Party type must follow the finance type')
  if (!n(v.party_id)) throw new Error(partyType === 'supplier' ? 'Choose the supplier' : 'Choose the customer')
  if (n(v.amount) <= 0) throw new Error('Enter the bill amount')
  if (!v.payment_received_date) throw new Error('Enter the payment received date')
  if (!v.maturity_date) throw new Error('Enter the maturity date')
  if (String(v.maturity_date).slice(0, 10) < String(v.payment_received_date).slice(0, 10)) {
    throw new Error('Maturity date cannot be before the payment received date')
  }
  const table = partyType === 'supplier' ? 'suppliers' : 'customers'
  const party = await getClient().execute({ sql: `SELECT id, active FROM ${table} WHERE id = ?`, args: [n(v.party_id)] })
  if (!party.rows.length) throw new Error('That party no longer exists')
  if (!n(party.rows[0].active)) throw new Error('That party is marked inactive')
}

export async function listBd(filter?: Row): Promise<Row[]> {
  const where: string[] = ['bd.company_id = ?']
  const args: (string | number)[] = [getActiveCompanyId()]
  if (filter?.status) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(String).filter(Boolean)
    if (statuses.length) {
      where.push(`bd.status IN (${statuses.map(() => '?').join(',')})`)
      args.push(...statuses)
    }
  }
  if (filter?.finance_type) {
    where.push('bd.finance_type = ?')
    args.push(String(filter.finance_type))
  }
  if (filter?.nbfc_id) {
    where.push('bd.nbfc_id = ?')
    args.push(n(filter.nbfc_id))
  }
  const res = await getClient().execute({
    sql: `SELECT bd.*, nb.name AS nbfc_name, nb.finance_type AS nbfc_finance_type,
                 s.name AS supplier_name, cu.name AS customer_name
          FROM bill_discountings bd
          LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
          LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
          LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
          WHERE ${where.join(' AND ')}
          ORDER BY bd.payment_received_date DESC, bd.id DESC`,
    args
  })
  return toPlain(res).map((bd) => ({ ...bd, party_name: partyName(bd), ...bdCalc(bd) }))
}

export async function createBd(v: Row): Promise<{ id: number }> {
  await validateBd(v)
  const res = await getClient().execute({
    sql: `INSERT INTO bill_discountings (company_id, ${BD_COLS.join(', ')}, status)
          VALUES (?, ${BD_COLS.map(() => '?').join(', ')}, 'open')`,
    args: [getActiveCompanyId(), ...bdArgs(v)]
  })
  const id = Number(res.lastInsertRowid)
  await postBdOpening(id)
  return { id }
}

export async function updateBd(id: number, v: Row): Promise<{ id: number }> {
  const cur = await loadBd(id)
  if (String(cur.status) === 'repaid') throw new Error('This bill is already repaid — reopen it first if it needs correcting')
  await validateBd(v)
  await getClient().execute({
    sql: `UPDATE bill_discountings SET ${BD_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...bdArgs(v), id]
  })
  await postBdOpening(id)
  return { id }
}

export async function deleteBd(id: number): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  await dropEntry(n(bd.journal_entry_id) || null)
  await dropEntry(n(bd.repay_journal_entry_id) || null)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  await c.execute({ sql: 'DELETE FROM bill_discountings WHERE id = ?', args: [id] })
  return { id }
}

// Repay/settle the bill at (or before) maturity. `settleVia: 'bank'` posts the
// payment straight from our own bank; `'party'` posts it against the
// supplier/customer ledger instead — bill-wise (a ref) or on account (blank),
// the same allocation choice LC/orders/sales already use.
export async function repayBd(
  id: number,
  v: { repay_date?: string; settle_via?: 'bank' | 'party'; ref?: string | null; release_margin?: boolean }
): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  if (String(bd.status) === 'repaid') throw new Error('This bill is already repaid')
  const amount = n(bd.amount)
  const date = String(v.repay_date || todayISO()).slice(0, 10)
  const settleVia = v.settle_via === 'party' ? 'party' : 'bank'
  const party = partyName(bd)
  if (settleVia === 'party' && !party) throw new Error('This bill has no linked party to settle against')
  const lines: JournalLine[] = [{ account: 'BILLS DISCOUNTED A/C', group: 'Loans (Liability)', dr: amount }]
  if (settleVia === 'party') {
    lines.push({
      account: party,
      group: bd.party_type === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors',
      cr: amount
    })
  } else {
    lines.push({ account: 'BANK A/C', group: 'Bank Accounts', cr: amount })
  }
  const je = await postJournal({
    date,
    vchType: 'PAYMENT',
    vchNo: String(bd.bd_no || ''),
    narration: `Bill Discounting ${bd.bd_no} repaid to ${bd.nbfc_name || 'the NBFC'}${settleVia === 'party' ? ` — settled against ${party}` : ''}`,
    companyId: n(bd.company_id) || undefined,
    lines
  })
  if (settleVia === 'party') await allocAgainst(je.id, party, v.ref || null, amount)
  await c.execute({
    sql: "UPDATE bill_discountings SET status = 'repaid', repaid_date = ?, repaid_amount = ?, repay_journal_entry_id = ? WHERE id = ?",
    args: [date, amount, je.id, id]
  })
  if (v.release_margin) {
    const fresh = await loadBd(id)
    await postBdMarginRelease(fresh)
  }
  return { id }
}

export async function reopenBd(id: number): Promise<{ id: number }> {
  const c = getClient()
  const bd = await loadBd(id)
  await dropEntry(n(bd.repay_journal_entry_id) || null)
  await dropEntry(n(bd.margin_release_journal_entry_id) || null)
  await c.execute({
    sql: "UPDATE bill_discountings SET status = 'open', repaid_date = NULL, repaid_amount = NULL, repay_journal_entry_id = NULL, margin_release_journal_entry_id = NULL WHERE id = ?",
    args: [id]
  })
  return { id }
}

// KPI rollup for the page header, mirroring getLcLimit's shape — outstanding
// exposure, margin held, interest and TDS, across every open bill.
export async function bdKpis(): Promise<Row> {
  const rows = await listBd({ status: ['open'] })
  return {
    count: rows.length,
    outstanding_total: round2(rows.reduce((s, r) => s + n(r.amount), 0)),
    margin_total: round2(rows.reduce((s, r) => s + n(r.marginAmount), 0)),
    interest_total: round2(rows.reduce((s, r) => s + n(r.interestAmount), 0)),
    tds_total: round2(rows.reduce((s, r) => s + n(r.tdsAmount), 0)),
    receipt_total: round2(rows.reduce((s, r) => s + n(r.receiptAmount), 0))
  }
}
