// THE BANK'S REFUND OF WHAT WAS PAID OVER THE BALANCE.
//
// A BD or LC repayment of 102 against 100 books the 2 to REFUND DUE - <lender>
// (lib/refundDue.ts). When the bank gives it back, the refund is either
//   * a receipt already in the books — booked from Tally or by hand, credited
//     to some holding ledger — which is LINKED: its credit line moves onto the
//     refund-due ledger, the bank line untouched; or
//   * RECORDED here as a receipt: Bank Dr / REFUND DUE Cr.
// Each is remembered against the bill or LC, so the register can say what is
// still due and an undo can put a linked receipt back exactly as it was.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { getOrCreateAccount, postJournal } from './journal'
import { groupsUnder } from './ledgerGroups'
import { isRefundDue, refundLedgerFor, REFUND_DUE_GROUP } from '../renderer/src/lib/refundDue'

type Row = Record<string, unknown>
type Kind = 'bd' | 'lc'
const n = (v: unknown): number => Number(v) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS facility_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      facility_id INTEGER NOT NULL,
      entry_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      refund_date TEXT,
      how TEXT NOT NULL,
      old_account_id INTEGER,
      line_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
  ready = true
}

/** The bill or LC: its company, its lender, and what its repayments booked as refund due. */
async function facility(kind: Kind, id: number): Promise<{ company_id: number; label: string; lender: string; booked: number; first: string; bank: string }> {
  const c = getClient()
  const head = toPlain(
    await c.execute(
      kind === 'bd'
        ? { sql: `SELECT b.company_id, b.bd_no AS label, nb.name AS lender FROM bill_discountings b LEFT JOIN nbfcs nb ON nb.id = b.nbfc_id WHERE b.id = ?`, args: [id] }
        : { sql: 'SELECT company_id, lc_no AS label, bank AS lender FROM letters_of_credit WHERE id = ?', args: [id] }
    )
  )[0]
  if (!head) throw new Error(kind === 'bd' ? 'Bill not found' : 'LC not found')
  const reps = toPlain(
    await c.execute(
      kind === 'bd'
        ? { sql: 'SELECT repay_date AS d, charges, journal_entry_id FROM bd_repayments WHERE bd_id = ? ORDER BY repay_date', args: [id] }
        : { sql: 'SELECT repay_date AS d, charges, journal_entry_id FROM lc_repayments WHERE lc_id = ? ORDER BY repay_date', args: [id] }
    )
  )
  let booked = 0
  let first = ''
  let bank = ''
  for (const r of reps) {
    let list: Row[] = []
    try {
      list = JSON.parse(String(r.charges || '[]'))
    } catch {
      list = []
    }
    const due = (Array.isArray(list) ? list : []).filter((x) => isRefundDue(String(x?.account || ''))).reduce((t, x) => t + n(x.amount), 0)
    if (due > 0.004) {
      booked += due
      if (!first) first = String(r.d || '').slice(0, 10)
      // The bank the repayment went out of is where the refund comes back.
      const bl = toPlain(
        await c.execute({
          sql: `SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                 WHERE jl.entry_id = ? AND jl.cr > 0 ORDER BY jl.cr DESC LIMIT 1`,
          args: [n(r.journal_entry_id)]
        })
      )[0]
      if (bl) bank = String(bl.name)
    }
  }
  return { company_id: n(head.company_id), label: String(head.label || ''), lender: String(head.lender || ''), booked: round2(booked), first, bank }
}

/** Refund due per bill or LC of one kind — for the register. */
export async function refundDues(kind: Kind): Promise<Record<string, number>> {
  await ensure()
  const c = getClient()
  const reps = toPlain(
    await c.execute(
      kind === 'bd'
        ? "SELECT bd_id AS fid, charges FROM bd_repayments WHERE charges LIKE '%REFUND DUE%'"
        : "SELECT lc_id AS fid, charges FROM lc_repayments WHERE charges LIKE '%REFUND DUE%'"
    )
  )
  const out: Record<string, number> = {}
  for (const r of reps) {
    let list: Row[] = []
    try {
      list = JSON.parse(String(r.charges || '[]'))
    } catch {
      list = []
    }
    const due = (Array.isArray(list) ? list : []).filter((x) => isRefundDue(String(x?.account || ''))).reduce((t, x) => t + n(x.amount), 0)
    if (due > 0.004) out[String(r.fid)] = round2((out[String(r.fid)] || 0) + due)
  }
  for (const r of toPlain(await c.execute({ sql: 'SELECT facility_id AS fid, SUM(amount) AS amt FROM facility_refunds WHERE kind = ? GROUP BY facility_id', args: [kind] }))) {
    if (out[String(r.fid)] != null) out[String(r.fid)] = round2(out[String(r.fid)] - n(r.amt))
  }
  for (const k of Object.keys(out)) if (out[k] <= 0.004) delete out[k]
  return out
}

/** Paid over, refunded and still due, per bill or LC — the register's marker stays once refunded. */
export async function refundTotals(kind: Kind): Promise<Record<string, { booked: number; refunded: number; due: number }>> {
  await ensure()
  const c = getClient()
  const reps = toPlain(
    await c.execute(
      kind === 'bd'
        ? "SELECT bd_id AS fid, charges FROM bd_repayments WHERE charges LIKE '%REFUND DUE%'"
        : "SELECT lc_id AS fid, charges FROM lc_repayments WHERE charges LIKE '%REFUND DUE%'"
    )
  )
  const out: Record<string, { booked: number; refunded: number; due: number }> = {}
  for (const r of reps) {
    let list: Row[] = []
    try {
      list = JSON.parse(String(r.charges || '[]'))
    } catch {
      list = []
    }
    const amt = (Array.isArray(list) ? list : []).filter((x) => isRefundDue(String(x?.account || ''))).reduce((t, x) => t + n(x.amount), 0)
    if (amt <= 0.004) continue
    const k = String(r.fid)
    out[k] = out[k] || { booked: 0, refunded: 0, due: 0 }
    out[k].booked = round2(out[k].booked + amt)
  }
  for (const r of toPlain(await c.execute({ sql: 'SELECT facility_id AS fid, SUM(amount) AS amt FROM facility_refunds WHERE kind = ? GROUP BY facility_id', args: [kind] }))) {
    const k = String(r.fid)
    if (out[k]) out[k].refunded = round2(n(r.amt))
  }
  for (const k of Object.keys(out)) out[k].due = round2(Math.max(0, out[k].booked - out[k].refunded))
  return out
}

/** Everything the Refund received dialog shows. */
export async function refundInfo(kind: Kind, id: number): Promise<Row> {
  await ensure()
  const c = getClient()
  const f = await facility(kind, id)
  const done = toPlain(
    await c.execute({
      sql: `SELECT fr.id, fr.entry_id, fr.amount, fr.refund_date, fr.how, je.vch_type, je.vch_no,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
              FROM facility_refunds fr LEFT JOIN journal_entries je ON je.id = fr.entry_id
             WHERE fr.kind = ? AND fr.facility_id = ? ORDER BY fr.id`,
      args: [kind, id]
    })
  )
  const refunded = round2(done.reduce((t, x) => t + n(x.amount), 0))
  const due = round2(Math.max(0, f.booked - refunded))
  const bankGroups = await groupsUnder('Bank Accounts')
  const ph = bankGroups.map(() => '?').join(',')
  const banks = toPlain(
    await c.execute({ sql: `SELECT name FROM ledger_accounts WHERE acc_group IN (${ph}) AND COALESCE(is_hidden, 0) = 0 ORDER BY name`, args: bankGroups })
  ).map((r) => String(r.name))
  // Receipts that could be the refund: money INTO one of our banks, on or after
  // the repayment, two lines, not already a refund, no more than is due.
  let candidates: Row[] = []
  if (due > 0.004 && f.first) {
    const taken = new Set(toPlain(await c.execute('SELECT entry_id FROM facility_refunds')).map((r) => n(r.entry_id)))
    const rows = toPlain(
      await c.execute({
        sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                     (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code,
                     jl.dr AS amount, a.name AS bank,
                     (SELECT a2.name FROM journal_lines l2 JOIN ledger_accounts a2 ON a2.id = l2.account_id WHERE l2.entry_id = je.id AND l2.cr > 0 LIMIT 1) AS from_ledger,
                     (SELECT COUNT(*) FROM journal_lines l3 WHERE l3.entry_id = je.id) AS nlines,
                     (SELECT a3.acc_group FROM journal_lines l4 JOIN ledger_accounts a3 ON a3.id = l4.account_id WHERE l4.entry_id = je.id AND l4.cr > 0 LIMIT 1) AS from_group
                FROM journal_entries je
                JOIN journal_lines jl ON jl.entry_id = je.id AND jl.dr > 0
                JOIN ledger_accounts a ON a.id = jl.account_id AND a.acc_group IN (${ph})
               WHERE je.company_id = ? AND je.entry_date >= ? AND je.entry_date <= date(?, '+180 days') AND jl.dr <= ?
               ORDER BY ABS(jl.dr - ?) ASC, je.entry_date ASC
               LIMIT 60`,
        args: [...bankGroups, f.company_id, f.first, f.first, due + 0.01, due]
      })
    )
    candidates = rows
      .filter((r) => !taken.has(n(r.id)) && n(r.nlines) === 2 && !bankGroups.includes(String(r.from_group || '')) && !isRefundDue(String(r.from_ledger || '')))
      .slice(0, 25)
      .map((r) => ({
        id: n(r.id),
        date: String(r.entry_date || '').slice(0, 10),
        code: String(r.code || r.vch_no || ''),
        vch_no: String(r.vch_no || ''),
        amount: round2(n(r.amount)),
        bank: String(r.bank || ''),
        from_ledger: String(r.from_ledger || ''),
        narration: String(r.narration || ''),
        exact: Math.abs(n(r.amount) - due) < 0.01
      }))
  }
  return {
    kind,
    id,
    label: f.label,
    lender: f.lender,
    ledger: refundLedgerFor(f.lender),
    booked: f.booked,
    refunded,
    due,
    bank: f.bank,
    banks,
    since: f.first,
    refunds: done.map((x) => ({ id: n(x.id), amount: round2(n(x.amount)), date: String(x.refund_date || ''), how: String(x.how), code: String(x.code || x.vch_no || '') })),
    candidates
  }
}

/** A receipt already in the books is the refund: its credit line moves onto the refund-due ledger. */
export async function linkRefund(kind: Kind, id: number, entryId: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    await ensure()
    const c = getClient()
    const info = await refundInfo(kind, id)
    const cand = ((info.candidates as Row[]) || []).find((x) => n(x.id) === n(entryId))
    if (!cand) throw new Error('That receipt cannot be linked — it is already a refund, is more than is due, or is not a receipt into a bank')
    const line = toPlain(await c.execute({ sql: 'SELECT id, account_id, cr FROM journal_lines WHERE entry_id = ? AND cr > 0', args: [entryId] }))
    if (line.length !== 1) throw new Error('That receipt has more than one credit line — record the refund instead')
    const f = await facility(kind, id)
    const acc = await getOrCreateAccount(refundLedgerFor(f.lender), REFUND_DUE_GROUP, f.company_id || undefined)
    await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id = ?', args: [n(line[0].id)] })
    await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?', args: [acc, n(line[0].id)] })
    const ins = await c.execute({
      sql: `INSERT INTO facility_refunds (kind, facility_id, entry_id, amount, refund_date, how, old_account_id, line_id)
            VALUES (?, ?, ?, ?, ?, 'linked', ?, ?)`,
      args: [kind, id, entryId, round2(n(cand.amount)), String(cand.date), n(line[0].account_id), n(line[0].id)]
    })
    console.log(`[refunds] ${kind} ${id}: receipt ${String(cand.code)} (${n(cand.amount)}) linked as the bank's refund — credit moved from ${String(cand.from_ledger)} to ${refundLedgerFor(f.lender)}`)
    return { id: Number(ins.lastInsertRowid || 0) }
  })
}

/** The refund recorded here: Bank Dr / REFUND DUE Cr. */
export async function recordRefund(kind: Kind, id: number, v: { date: string; amount: number; bank: string }): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    await ensure()
    const c = getClient()
    const info = await refundInfo(kind, id)
    const amount = round2(n(v.amount))
    const date = String(v.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the date the refund came in')
    if (date < String(info.since || '')) throw new Error('The refund cannot be before the repayment it refunds')
    if (!(amount > 0)) throw new Error('Enter the amount refunded')
    if (amount > n(info.due) + 0.01) throw new Error(`Only ${n(info.due).toFixed(2)} is due back`)
    const bank = String(v.bank || info.bank || '').trim()
    if (!bank) throw new Error('Pick the bank the refund came into')
    const f = await facility(kind, id)
    const je = await postJournal({
      date,
      vchType: 'RECEIPT',
      narration: `Refund from ${f.lender || 'the bank'} of the excess paid on ${kind === 'bd' ? 'bill' : 'LC'} ${f.label}`,
      companyId: f.company_id || undefined,
      lines: [
        { account: bank, group: 'Bank Accounts', dr: amount },
        { account: refundLedgerFor(f.lender), group: REFUND_DUE_GROUP, cr: amount }
      ]
    })
    const ins = await c.execute({
      sql: `INSERT INTO facility_refunds (kind, facility_id, entry_id, amount, refund_date, how) VALUES (?, ?, ?, ?, ?, 'posted')`,
      args: [kind, id, je.id, amount, date]
    })
    return { id: Number(ins.lastInsertRowid || 0) }
  })
}

/** Take a refund back: a linked receipt returns to the ledger it came from; a recorded one is removed. */
export async function undoRefund(refundId: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    await ensure()
    const c = getClient()
    const r = toPlain(await c.execute({ sql: 'SELECT * FROM facility_refunds WHERE id = ?', args: [refundId] }))[0]
    if (!r) throw new Error('Refund not found')
    if (String(r.how) === 'linked') {
      if (n(r.line_id) && n(r.old_account_id)) await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?', args: [n(r.old_account_id), n(r.line_id)] })
    } else {
      const eid = n(r.entry_id)
      await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [eid] })
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [eid] })
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [eid] })
    }
    await c.execute({ sql: 'DELETE FROM facility_refunds WHERE id = ?', args: [refundId] })
    return { id: refundId }
  })
}
