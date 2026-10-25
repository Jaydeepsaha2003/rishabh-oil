import { withDbTransaction } from './dbTransaction'
import { ALLOC } from './tankerAlloc'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getBooksFrom, openingMap } from './openings'
import { getOrCreateAccount, postJournal, voucherCodeMap, type JournalLine } from './journal'
import { baseGroupOf, groupNatureMap } from './ledgerGroups'
import { assertManualVoucher, ownedVoucherIds, voucherOwner } from './voucherOwnership'
import { validateCashFlow } from './voucherValidation'
import { ensureVoucherNumbers, renumberOnTypeChange, voucherCodeOf } from './voucherNumbers'

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
const todayISO = (): string => {
  const d = new Date()
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// ---------------------------------------------------------------------------
// Tally's standard ledger groups, with the side of the books each belongs to.
// acc_group on ledger_accounts stores the group name; anything unknown is
// treated as an asset so it still shows up rather than vanishing.
// ---------------------------------------------------------------------------

export type GroupNature = 'asset' | 'liability' | 'income' | 'expense'

export const TALLY_GROUPS: { name: string; nature: GroupNature }[] = [
  { name: 'Capital Account', nature: 'liability' },
  { name: 'Reserves & Surplus', nature: 'liability' },
  { name: 'Loans (Liability)', nature: 'liability' },
  { name: 'Secured Loans', nature: 'liability' },
  { name: 'Unsecured Loans', nature: 'liability' },
  { name: 'Bank OD A/c', nature: 'liability' },
  { name: 'Current Liabilities', nature: 'liability' },
  { name: 'Duties & Taxes', nature: 'liability' },
  { name: 'Provisions', nature: 'liability' },
  { name: 'Sundry Creditors', nature: 'liability' },
  { name: 'Fixed Assets', nature: 'asset' },
  { name: 'Investments', nature: 'asset' },
  { name: 'Current Assets', nature: 'asset' },
  { name: 'Bank Accounts', nature: 'asset' },
  { name: 'Cash-in-Hand', nature: 'asset' },
  { name: 'Deposits (Asset)', nature: 'asset' },
  { name: 'Loans & Advances (Asset)', nature: 'asset' },
  { name: 'Stock-in-Hand', nature: 'asset' },
  { name: 'Sundry Debtors', nature: 'asset' },
  { name: 'Sales Accounts', nature: 'income' },
  { name: 'Direct Incomes', nature: 'income' },
  { name: 'Indirect Incomes', nature: 'income' },
  { name: 'Purchase Accounts', nature: 'expense' },
  { name: 'Direct Expenses', nature: 'expense' },
  { name: 'Indirect Expenses', nature: 'expense' },
  { name: 'General', nature: 'asset' }
]

/**
 * The static fallback, kept deliberately.
 *
 * Nature now comes from ledger_groups, where it is inherited from the root of
 * the tree — see groupNatureMap. This list is what answers when that table has
 * not been seeded yet: a books file restored from a snapshot older than the
 * table, read before bootstrap has finished with it. Every name below resolves
 * to the same side in both, which is why the two can stand in for each other.
 */
export function groupNature(group: string): GroupNature {
  return TALLY_GROUPS.find((g) => g.name === String(group || ''))?.nature || 'asset'
}

const CASH_BANK_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']

// Groups with the ledgers under them and their live balances — the "List of
// Accounts" screen.
export async function listGroups(companyId?: number): Promise<Row[]> {
  const res = await getClient().execute({
    args: [companyId || getActiveCompanyId()],
    sql: `
    SELECT a.id, a.name, a.acc_group,
      COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.company_id = ?), 0) AS balance
    FROM ledger_accounts a ORDER BY a.acc_group, a.name`
  })
  return toPlain(res)
}

// ---------------------------------------------------------------------------
// Manual vouchers (Contra F4 / Payment F5 / Receipt F6 / Journal F7), with
// Tally's own rules about where cash and bank must sit in each type.
// ---------------------------------------------------------------------------

// SALE: only for a sale booked from Tally's Sales Register (Tally File Updation),
// which has no sale lines behind it. The Accounting screen never offers it.
export type VoucherType = 'CONTRA' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'DEBIT NOTE' | 'CREDIT NOTE' | 'SALE'

// One bill-wise adjustment on a party line, Tally style. order_id/sale_invoice_group
// are the exact link to the bill being settled when the UI picked one from the
// pending-refs list — ref_name alone (free text) can collide across bills or
// miss entirely when an invoice number is blank or duplicated.
export interface BillAlloc {
  method: 'agst_ref' | 'advance' | 'on_account' | 'new_ref'
  ref_name?: string | null
  order_id?: number | null
  sale_invoice_group?: string | null
  amount: number
}

/**
 * HOW ONE LINE'S TOTAL WAS ARRIVED AT.
 *
 * Not a posting — the double entry is untouched and the ledger reads exactly
 * as it did. This is the working behind a figure: SALARY 20,000 written out
 * as the four people it paid, or as basic, HRA and allowance. Optional on
 * every line; when it is given, it has to add up to the line, because a
 * breakdown that does not is worse than none.
 */
export interface LineSplit {
  name: string
  amount: number
  note?: string | null
}

export interface VoucherInput {
  date: string
  vchType: VoucherType
  // The desk's own type under the basic one (PURCHASE OTHERS) — a label only;
  // the number stays in the basic type's series. Omitted leaves it as it was.
  subtype?: string | null
  vchNo?: string | null
  narration?: string | null
  companyId?: number
  lines: {
    account: string
    group?: string
    dr?: number
    cr?: number
    allocs?: BillAlloc[]
    splits?: LineSplit[]
  }[]
}

async function accountGroupOf(name: string): Promise<string> {
  const res = await getClient().execute({
    sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?',
    args: [String(name || '').trim().toUpperCase()]
  })
  return String(res.rows[0]?.acc_group || '')
}

type LineWithAllocs = JournalLine & { allocs: BillAlloc[]; splits: LineSplit[] }

/**
 * A BREAKDOWN THAT DOES NOT ADD UP IS WORSE THAN NONE.
 *
 * It is optional — most lines will never carry one — but the moment somebody
 * writes SALARY 20,000 out as its parts, those parts ARE the explanation, and
 * an explanation that comes to 18,500 quietly misinforms every reader after
 * it. Refused here rather than stored and discovered in an audit.
 */
function assertSplitsAddUp(lines: LineWithAllocs[]): void {
  for (const l of lines) {
    if (!l.splits.length) continue
    const total = l.splits.reduce((t, sp) => t + n(sp.amount), 0)
    const line = n(l.dr) || n(l.cr)
    if (Math.abs(total - line) > 0.01) {
      throw new Error(
        `The breakdown on ${l.account} comes to ${total.toFixed(2)}, but the line is ${line.toFixed(2)} — ` +
          `${Math.abs(line - total).toFixed(2)} ${total < line ? 'is unaccounted for' : 'too much'}`
      )
    }
    if (l.splits.some((sp) => !sp.name)) {
      throw new Error(`Every line of the breakdown on ${l.account} needs a description`)
    }
  }
}

async function validateVoucher(v: VoucherInput): Promise<LineWithAllocs[]> {
  const lines = (v.lines || [])
    .map((l) => ({
      account: String(l.account || '').trim(),
      group: l.group,
      dr: n(l.dr),
      cr: n(l.cr),
      splits: (l.splits || [])
        .map((sp) => ({
          name: String(sp?.name || '').trim().slice(0, 200),
          amount: n(sp?.amount),
          note: sp?.note ? String(sp.note).trim().slice(0, 500) : null
        }))
        // A row with neither a name nor a figure is a row somebody started and
        // left; it is dropped rather than refused.
        .filter((sp) => !!sp.name || sp.amount !== 0),
      allocs: (l.allocs || [])
        .map((a) => ({
          method: a.method,
          ref_name: a.ref_name ? String(a.ref_name).trim() : null,
          order_id: a.order_id ? Number(a.order_id) : null,
          sale_invoice_group: a.sale_invoice_group ? String(a.sale_invoice_group).trim() : null,
          amount: n(a.amount)
        }))
        .filter((a) => a.amount > 0.004)
    }))
    .filter((l) => l.account && (l.dr > 0.004 || l.cr > 0.004))
  if (lines.length < 2) throw new Error('A voucher needs at least one Dr and one Cr line')
  if (lines.some((l) => l.dr > 0.004 && l.cr > 0.004)) {
    throw new Error('A line is either Dr or Cr, not both')
  }
  const dr = lines.reduce((s, l) => s + l.dr, 0)
  const cr = lines.reduce((s, l) => s + l.cr, 0)
  if (Math.abs(dr - cr) > 0.005) {
    throw new Error(`Voucher does not balance — Dr ${dr.toFixed(2)} vs Cr ${cr.toFixed(2)}`)
  }
  if (!v.date) throw new Error('Voucher date is required')

  await validateCashFlow(v.vchType, lines, v.companyId)
  // Bill-wise details (payment/receipt): when a party line carries them, they
  // must cover the line exactly, and a named method needs its reference.
  for (const l of lines) {
    if (!l.allocs.length) continue
    const total = l.allocs.reduce((s, a) => s + a.amount, 0)
    const lineAmt = l.dr > 0.004 ? l.dr : l.cr
    if (Math.abs(total - lineAmt) > 0.005) {
      throw new Error(
        `Bill-wise details for "${l.account}" total ${total.toFixed(2)} but the line is ${lineAmt.toFixed(2)}`
      )
    }
    for (const a of l.allocs) {
      if (!['agst_ref', 'advance', 'on_account', 'new_ref'].includes(a.method)) {
        throw new Error(`Unknown adjustment method "${a.method}"`)
      }
      if (a.method !== 'on_account' && !a.ref_name) {
        throw new Error(
          `"${l.account}": ${a.method === 'agst_ref' ? 'Agst Ref' : a.method === 'advance' ? 'Advance' : 'New Ref'} needs a reference name`
        )
      }
    }
  }
  assertSplitsAddUp(lines)
  return lines
}

// A reference name -> the document it actually names, so an allocation carries
// the id and not only the text. Exported because every writer of an allocation
// (payments, notes, treasury, bill discounting) needs the same answer, and a
// row written without ids can only ever be matched by string.
export async function resolveRefIds(
  refName: string,
  companyId: number,
  side: 'customer' | 'supplier'
): Promise<{ order_id: number | null; sale_invoice_group: string | null }> {
  const ref = String(refName || '').trim()
  if (!ref) return { order_id: null, sale_invoice_group: null }
  const c = getClient()
  if (side === 'supplier') {
    const r = await c.execute({
      sql: 'SELECT id FROM orders WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1',
      args: [companyId, ref.toUpperCase()]
    })
    return { order_id: r.rows.length ? Number(r.rows[0].id) : null, sale_invoice_group: null }
  }
  const r = await c.execute({
    sql: `SELECT COALESCE(invoice_group, invoice_no) AS grp FROM sales
           WHERE company_id = ? AND TRIM(UPPER(invoice_no)) = ? LIMIT 1`,
    args: [companyId, ref.toUpperCase()]
  })
  return { order_id: null, sale_invoice_group: r.rows.length ? String(r.rows[0].grp) : null }
}

/** The breakdown rows, against the same freshly written lines as the allocs. */
async function writeSplits(entryId: number, lines: LineWithAllocs[]): Promise<void> {
  const c = getClient()
  const saved = await c.execute({
    sql: 'SELECT id FROM journal_lines WHERE entry_id = ? ORDER BY id ASC',
    args: [entryId]
  })
  for (let i = 0; i < lines.length && i < saved.rows.length; i++) {
    const lineId = n((saved.rows[i] as unknown as Row).id)
    let order = 0
    for (const sp of lines[i].splits) {
      order += 10
      await c.execute({
        sql: `INSERT INTO journal_line_splits (line_id, name, amount, note, sort_order)
              VALUES (?, ?, ?, ?, ?)`,
        args: [lineId, sp.name, n(sp.amount), sp.note || null, order]
      })
    }
  }
}

/**
 * THE BREAKDOWN OF ONE LINE, on its own — for any voucher, including one a
 * purchase, sale, LC or discounted bill posted, whose ledgers and amounts stay
 * locked. Only the working is written: it has to add up to the line (or be
 * empty, to clear it). Nothing posted changes.
 */
export async function setLineSplits(lineId: number, splits: LineSplit[]): Promise<{ id: number; parts: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const line = (await c.execute({ sql: 'SELECT id, dr, cr FROM journal_lines WHERE id = ?', args: [n(lineId)] })).rows[0] as unknown as Row | undefined
    if (!line) throw new Error('That voucher line no longer exists — open the voucher again')
    const amount = Math.round((n(line.dr) || n(line.cr)) * 100) / 100
    const parts = (splits || [])
      .map((s) => ({ name: String(s.name || '').trim(), amount: Math.round(n(s.amount) * 100) / 100, note: s.note ? String(s.note).trim() : null }))
      .filter((s) => s.name || s.amount)
    if (parts.some((s) => !s.name)) throw new Error('Give every part a name')
    if (parts.some((s) => s.amount <= 0)) throw new Error('Every part needs an amount')
    const total = Math.round(parts.reduce((t, s) => t + s.amount, 0) * 100) / 100
    if (parts.length && Math.abs(total - amount) > 0.01) {
      throw new Error(`The parts add up to ${total.toFixed(2)} — the line is ${amount.toFixed(2)}`)
    }
    await c.execute({ sql: 'DELETE FROM journal_line_splits WHERE line_id = ?', args: [n(lineId)] })
    let order = 0
    for (const s of parts) {
      order += 10
      await c.execute({
        sql: 'INSERT INTO journal_line_splits (line_id, name, amount, note, sort_order) VALUES (?, ?, ?, ?, ?)',
        args: [n(lineId), s.name, s.amount, s.note, order]
      })
    }
    return { id: n(lineId), parts: parts.length }
  })
}

// Store bill-wise rows against the freshly written journal lines. The entry's
// lines are re-read in insert order, which matches the validated array.
async function writeAllocs(entryId: number, lines: LineWithAllocs[]): Promise<void> {
  const c = getClient()
  const saved = await c.execute({
    sql: 'SELECT id, account_id FROM journal_lines WHERE entry_id = ? ORDER BY id ASC',
    args: [entryId]
  })
  // The VOUCHER's company, not the session's: Accounting can be open on KR
  // FINMARK while the app works in KR FOODS, and an Agst Ref looked up in the
  // wrong book links the receipt to the other company's bill of that number.
  const own = await c.execute({ sql: 'SELECT company_id FROM journal_entries WHERE id = ?', args: [entryId] })
  const cid = Number((own.rows[0] as unknown as Row | undefined)?.company_id) || getActiveCompanyId()
  for (let i = 0; i < lines.length && i < saved.rows.length; i++) {
    for (const a of lines[i].allocs) {
      // The caller may already know which document it is settling. When it
      // doesn't — it only picked a reference off a dropdown — resolve the name
      // here rather than storing text alone.
      let orderId = a.order_id || null
      let saleGroup = a.sale_invoice_group || null
      if (a.method === 'agst_ref' && a.ref_name && !orderId && !saleGroup) {
        const grp = await baseGroupOf(lines[i].group)
        const side = grp === 'Sundry Debtors' ? 'customer' : grp === 'Sundry Creditors' ? 'supplier' : null
        if (side) {
          const ids = await resolveRefIds(String(a.ref_name), cid, side)
          orderId = ids.order_id
          saleGroup = ids.sale_invoice_group
        }
      }
      await c.execute({
        sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          Number(saved.rows[i].id),
          Number(saved.rows[i].account_id),
          a.method,
          a.ref_name || null,
          a.amount,
          orderId,
          saleGroup
        ]
      })
    }
  }
}

export async function createVoucher(v: VoucherInput): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const lines = await validateVoucher(v)
  const res = await postJournal({
    date: v.date,
    vchType: v.vchType,
    vchNo: v.vchNo || null,
    narration: v.narration || null,
    companyId: v.companyId ? n(v.companyId) : undefined,
    lines
  })
  await writeAllocs(res.id, lines)
  await writeSplits(res.id, lines)
  if (v.subtype !== undefined) {
    const { checkedSubtype } = await import('./voucherSubtypes')
    await getClient().execute({ sql: 'UPDATE journal_entries SET vch_subtype = ? WHERE id = ?', args: [await checkedSubtype(v.vchType, v.subtype), res.id] })
  }
  return res
  })
}

// Alter a MANUAL voucher in place (same entry id, so its voucher serial in the
// day book does not move). Auto-posted vouchers must be changed through their
// source document.
export async function updateVoucher(id: number, v: VoucherInput): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  await assertManualVoucher(id)
  await ensureVoucherNumbers()
  const c = getClient()
  const cur = await c.execute({
    sql: 'SELECT company_id, order_id, sale_id, payment_id FROM journal_entries WHERE id = ?',
    args: [id]
  })
  if (!cur.rows.length) throw new Error('Voucher not found')
  const r = cur.rows[0]
  if (r.order_id != null || r.sale_id != null || r.payment_id != null) {
    throw new Error('This voucher was posted automatically — alter its source document instead')
  }
  const isNote = await c.execute({ sql: 'SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1', args: [id] })
  if (isNote.rows.length) {
    throw new Error('This voucher belongs to a Debit/Credit note — delete the note and enter it afresh')
  }
  const lines = await validateVoucher(v)
  await c.execute({
    sql: 'UPDATE journal_entries SET entry_date = ?, vch_type = ?, vch_no = ?, narration = ? WHERE id = ?',
    args: [v.date, v.vchType, v.vchNo || null, v.narration || null, id]
  })
  await renumberOnTypeChange(id, v.vchType)
  if (v.subtype !== undefined) {
    const { checkedSubtype } = await import('./voucherSubtypes')
    await c.execute({ sql: 'UPDATE journal_entries SET vch_subtype = ? WHERE id = ?', args: [await checkedSubtype(v.vchType, v.subtype), id] })
  }
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  // The breakdown hangs off the line, and the lines are about to be rewritten.
  await c.execute({
    sql: 'DELETE FROM journal_line_splits WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [id]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
  for (const l of lines) {
    const accountId = await getOrCreateAccount(l.account, l.group, Number(r.company_id))
    await c.execute({
      sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, ?)',
      args: [id, accountId, n(l.dr), n(l.cr)]
    })
  }
  await writeAllocs(id, lines)
  await writeSplits(id, lines)
  return { id }
  })
}

export async function getVoucher(id: number): Promise<Row | null> {
  const c = getClient()
  const e = await c.execute({
    sql: 'SELECT * FROM journal_entries WHERE id = ?',
    args: [id]
  })
  if (!e.rows.length) return null
  const lines = await c.execute({
    sql: `SELECT jl.id, jl.dr, jl.cr, a.name AS account, a.acc_group
          FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
          -- Debits first, then credits — the way a voucher is read (Tally
          -- lists it by side too). Within a side, the order it was written.
          WHERE jl.entry_id = ? ORDER BY CASE WHEN jl.dr > 0 THEN 0 ELSE 1 END, jl.id`,
    args: [id]
  })
  const entry = toPlain(e)[0]
  const noteRef = await c.execute({
    sql: 'SELECT id FROM notes WHERE journal_entry_id = ? LIMIT 1',
    args: [id]
  })
  entry.note_id = noteRef.rows.length ? Number(noteRef.rows[0].id) : null
  entry.lines = toPlain(lines)
  for (const l of entry.lines as Row[]) {
    const al = await c.execute({
      sql: 'SELECT method, ref_name, order_id, sale_invoice_group, amount FROM journal_bill_allocs WHERE line_id = ? ORDER BY id',
      args: [Number(l.id)]
    })
    l.allocs = toPlain(al)
    // The working behind this line's figure, if somebody wrote one down.
    const sp = await c.execute({
      sql: 'SELECT name, amount, note FROM journal_line_splits WHERE line_id = ? ORDER BY sort_order, id',
      args: [Number(l.id)]
    })
    l.splits = toPlain(sp)
  }
  // ONE DEBIT, SEVERAL DISCOUNTED BILLS: the line the bills came off reads as
  // its parts — B2 33,96,340 and B1 13,03,660 — from the repayment rows. Only
  // shown, never saved: it is the repayments that say it, not the voucher.
  {
    const parts = toPlain(
      await c
        .execute({
          sql: `SELECT b.bd_no, r.amount FROM bd_repayments r JOIN bill_discountings b ON b.id = r.bd_id
                 WHERE r.journal_entry_id = ? ORDER BY r.amount DESC, r.id`,
          args: [id]
        })
        .catch(() => ({ rows: [], columns: [] }) as unknown as ResultSet)
    )
    if (parts.length > 1) {
      const sum = parts.reduce((t, p) => t + (Number(p.amount) || 0), 0)
      const line = (entry.lines as Row[]).find((l) => Number(l.dr) > 0 && !(l.splits as Row[])?.length && Math.abs(Number(l.dr) - sum) < 0.01)
      if (line) line.splits = parts.map((p) => ({ name: `${String(p.bd_no)} repaid`, amount: Number(p.amount) || 0, note: null, derived: true }))
    }
  }
  entry.manual = !(await ownedVoucherIds()).has(id)
  // Who wrote it, so a voucher that cannot be edited here can still be shown
  // in full and link straight back to the document that can change it.
  entry.owner = entry.manual ? null : await voucherOwner(id).catch(() => null)
  // The number the ledgers print for it — PAY/12 — for the voucher's own header.
  entry.code = await voucherCodeOf(id).catch(() => null)
  return entry
}

// The Day Book: every voucher in the period, one row each, with the principal
// debit and credit ledgers as Tally shows them.
export async function listVouchers(
  from?: string,
  to?: string,
  vchType?: string | string[],
  companyId?: number
): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const conds = ['je.company_id = ?']
  const args: (string | number)[] = [cid]
  if (from) {
    conds.push('je.entry_date >= ?')
    args.push(from)
  }
  if (to) {
    conds.push('je.entry_date <= ?')
    args.push(to)
  }
  if (vchType) {
    const types = (Array.isArray(vchType) ? vchType : [vchType]).filter(Boolean)
    if (types.length) {
      conds.push(`je.vch_type IN (${types.map(() => '?').join(',')})`)
      args.push(...types)
    }
  }
  const res = await c.execute({
    sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_subtype, je.vch_no, je.narration,
                 je.order_id, je.sale_id, je.payment_id,
                 -- The document's own number and its own book, for the Day
                 -- Book's Ref column and for the drill-through — see the note
                 -- on the same two columns in accountStatement.
                 (SELECT o.invoice_no FROM orders o WHERE o.id = je.order_id) AS order_invoice_no,
                 (SELECT sl.invoice_no FROM sales sl WHERE sl.id = je.sale_id) AS sale_invoice_no,
                 (SELECT o.company_id FROM orders o WHERE o.id = je.order_id) AS order_company_id,
                 (SELECT sl.company_id FROM sales sl WHERE sl.id = je.sale_id) AS sale_company_id,
                 -- WHICH LETTER OF CREDIT / DISCOUNTED BILL POSTED THIS
                 -- VOUCHER is read once for the whole list (docLinks below),
                 -- not looked up voucher by voucher: those lookups were three
                 -- quarters of the Day Book's time.
                 -- A TRADING DEAL IS TWO INVOICES, so its vouchers are their
                 -- vouchers. A purchase or sale that belongs to one opens the
                 -- deal, where both sides and the margin are, rather than one
                 -- half of it on the purchase page.
                 COALESCE(
                   (SELECT tdo.deal_id FROM trading_deal_orders tdo WHERE tdo.order_id = je.order_id LIMIT 1),
                   (SELECT ds.deal_id FROM trading_deal_sales ds WHERE ds.sale_id = je.sale_id LIMIT 1),
                   (SELECT td.id FROM trading_deals td WHERE td.order_id = je.order_id OR td.sale_id = je.sale_id LIMIT 1)
                 ) AS trading_deal_id,
                 (SELECT nt.id FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS note_id,
                 (SELECT SUM(dr) FROM journal_lines WHERE entry_id = je.id) AS amount,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC LIMIT 1) AS dr_account,
                 (SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                  WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC LIMIT 1) AS cr_account,
                 -- EVERY account on each side, not only the principal one.
                 -- A day book line reads "Dr these → Cr those", and a voucher
                 -- that splits a side across two ledgers — interest and bank
                 -- charges out of one bank, say — was showing only the larger
                 -- of them, which reads as a different entry from the one that
                 -- was posted. The single-name fields stay for the callers
                 -- that want the principal.
                 -- Biggest first on each side, the order a voucher's own lines
                 -- are shown in: the party or the goods leads, the taxes and
                 -- round off follow. Ordered in a subquery because a bare
                 -- GROUP_CONCAT takes the rows in whatever order they are read.
                 (SELECT GROUP_CONCAT(nm, ', ') FROM (
                    SELECT a.name AS nm FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                     WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC, jl.id)) AS dr_accounts,
                 (SELECT GROUP_CONCAT(nm, ', ') FROM (
                    SELECT a.name AS nm FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                     WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC, jl.id)) AS cr_accounts,
                 -- EACH LINE WITH ITS OWN AMOUNT, for the Day Book that prints
                 -- a voucher the way it was posted: ledger id, name and amount
                 -- per line (unit separator between fields, record separator
                 -- between lines), biggest first on each side.
                 (SELECT GROUP_CONCAT(ln, char(30)) FROM (
                    SELECT jl.account_id || char(31) || a.name || char(31) || jl.dr AS ln
                      FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                     WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC, jl.id)) AS dr_lines,
                 (SELECT GROUP_CONCAT(ln, char(30)) FROM (
                    SELECT jl.account_id || char(31) || a.name || char(31) || jl.cr AS ln
                      FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
                     WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC, jl.id)) AS cr_lines,
                 -- The bills the voucher was set against (Agst Ref), and
                 -- whether any of it went on account — what a note entered on
                 -- the voucher screen was raised against.
                 (SELECT GROUP_CONCAT(DISTINCT ba.ref_name) FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id
                   WHERE jl.entry_id = je.id AND ba.method = 'agst_ref' AND COALESCE(TRIM(ba.ref_name), '') <> '') AS agst_refs,
                 (SELECT COUNT(*) FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id
                   WHERE jl.entry_id = je.id AND ba.method = 'on_account') AS on_account_allocs
          FROM journal_entries je
          WHERE ${conds.join(' AND ')}
          ORDER BY je.entry_date DESC, je.id DESC`,
    args
  })
  const rows = toPlain(res)
  const owned = await ownedVoucherIds()
  // The voucher's own number (DN/10), as the ledger and the voucher screen
  // show it — vch_no is the reference typed on it.
  const codes = await voucherCodeMap(cid).catch(() => new Map<number, string>())
  const links = await docLinks()
  for (const r of rows) {
    r.manual = !owned.has(Number(r.id))
    r.voucher_code = codes.get(Number(r.id)) || ''
    const lc = links.lc.get(Number(r.id))
    const bd = links.bd.get(Number(r.id))
    r.lc_id = lc ? lc.id : null
    r.lc_no = lc ? lc.no : null
    r.bd_id = bd ? bd.id : null
    r.bd_no = bd ? bd.no : null
  }
  return rows
}

/**
 * WHICH LETTER OF CREDIT, AND WHICH DISCOUNTED BILL, POSTED EACH VOUCHER.
 *
 * Every LC and BD voucher is named by the row that wrote it — the LC or bill
 * itself, or one of its issuances, payment-ins, repayments or interest
 * payments — so the link is read, never guessed from a number that repeats
 * (LC-1 to LC-8 exist twice over in one company). The same order of
 * precedence as before: the LC's or bill's own columns first, then its
 * children, the first row found winning.
 */
async function docLinks(): Promise<{ lc: Map<number, { id: number; no: string }>; bd: Map<number, { id: number; no: string }> }> {
  const c = getClient()
  const lc = new Map<number, { id: number; no: string }>()
  const bd = new Map<number, { id: number; no: string }>()
  const put = (m: Map<number, { id: number; no: string }>, je: unknown, id: number, no: string): void => {
    const k = Number(je) || 0
    if (k && !m.has(k)) m.set(k, { id, no })
  }
  const safe = async (sql: string): Promise<Row[]> => {
    try {
      return toPlain(await c.execute({ sql, args: [] }))
    } catch {
      return []
    }
  }
  const lcs = await safe(`SELECT id, lc_no, journal_entry_id, interest_journal_entry_id, preclose_journal_entry_id, preclose_interest_journal_entry_id,
                                 preclose_payout_journal_entry_id, charges_journal_entry_id, fee_adjust_journal_entry_id, payment_in_journal_entry_id
                            FROM letters_of_credit ORDER BY id`)
  const lcNo = new Map<number, string>(lcs.map((l) => [Number(l.id), l.lc_no == null ? '' : String(l.lc_no)]))
  for (const l of lcs)
    for (const col of ['journal_entry_id', 'interest_journal_entry_id', 'preclose_journal_entry_id', 'preclose_interest_journal_entry_id', 'preclose_payout_journal_entry_id', 'charges_journal_entry_id', 'fee_adjust_journal_entry_id', 'payment_in_journal_entry_id'])
      put(lc, l[col], Number(l.id), lcNo.get(Number(l.id)) || '')
  for (const sql of [
    'SELECT lc_id, journal_entry_id AS je FROM lc_issuances ORDER BY rowid',
    'SELECT lc_id, journal_entry_id AS je FROM lc_payment_ins ORDER BY rowid',
    'SELECT lc_id, journal_entry_id AS je, fee_journal_entry_id AS je2 FROM lc_repayments ORDER BY rowid'
  ]) {
    const rs = await safe(sql)
    for (const r of rs) {
      const id = Number(r.lc_id)
      if (!id) continue
      put(lc, r.je, id, lcNo.get(id) ?? '')
      if (r.je2 != null) put(lc, r.je2, id, lcNo.get(id) ?? '')
    }
  }
  const bds = await safe('SELECT id, bd_no, journal_entry_id, repay_journal_entry_id, margin_release_journal_entry_id FROM bill_discountings ORDER BY id')
  const bdNo = new Map<number, string>(bds.map((x) => [Number(x.id), x.bd_no == null ? '' : String(x.bd_no)]))
  for (const x of bds)
    for (const col of ['journal_entry_id', 'repay_journal_entry_id', 'margin_release_journal_entry_id']) put(bd, x[col], Number(x.id), bdNo.get(Number(x.id)) || '')
  for (const sql of ['SELECT bd_id, journal_entry_id AS je FROM bd_repayments ORDER BY rowid', 'SELECT bd_id, journal_entry_id AS je FROM bd_interest_payments ORDER BY rowid']) {
    const rs = await safe(sql)
    for (const r of rs) {
      const id = Number(r.bd_id)
      if (id) put(bd, r.je, id, bdNo.get(id) ?? '')
    }
  }
  return { lc, bd }
}

/**
 * THE ACCOUNTING GATEWAY'S FIGURES, without the vouchers themselves: how many
 * of each type and what they turned over. The gateway read the whole Day Book
 * (1.8 MB, every line of every voucher) only to count it.
 */
export async function voucherSummary(from?: string, to?: string, companyId?: number): Promise<Row> {
  const cid = companyId || getActiveCompanyId()
  const conds = ['je.company_id = ?']
  const args: (string | number)[] = [cid]
  if (from) {
    conds.push('je.entry_date >= ?')
    args.push(from)
  }
  if (to) {
    conds.push('je.entry_date <= ?')
    args.push(to)
  }
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT UPPER(je.vch_type) AS vch_type, COUNT(*) AS n, COALESCE(SUM(t.amt), 0) AS amount
              FROM journal_entries je
              LEFT JOIN (SELECT entry_id, SUM(dr) AS amt FROM journal_lines GROUP BY entry_id) t ON t.entry_id = je.id
             WHERE ${conds.join(' AND ')}
             GROUP BY UPPER(je.vch_type)`,
      args
    })
  )
  const byType: Record<string, number> = {}
  let count = 0
  let amount = 0
  for (const r of rows) {
    byType[String(r.vch_type || '')] = Number(r.n) || 0
    count += Number(r.n) || 0
    amount += Number(r.amount) || 0
  }
  return { count, amount: Math.round(amount * 100) / 100, by_type: byType }
}

// Trial balance as on a date (or over a period with an opening column):
// per-ledger closing Dr/Cr, grouped by acc_group, plus group subtotals — the
// grand totals must agree or the books are broken.
export async function trialBalance(from?: string, to?: string, companyId?: number): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  // The books' own start, and the opening each ledger was given as at that
  // date. Everything before the cutoff is excluded and the entered figure
  // stands in its place — otherwise the pre-book entries would be counted
  // twice, once as themselves and once inside the opening.
  const booksFrom = await getBooksFrom(cid)
  const entered = await openingMap(cid)
  const period = async (lo?: string, hi?: string): Promise<Map<number, { dr: number; cr: number }>> => {
    const conds = ['je.company_id = ?']
    const args: (string | number)[] = [cid]
    if (booksFrom) {
      conds.push('je.entry_date >= ?')
      args.push(booksFrom)
    }
    if (lo) {
      conds.push('je.entry_date >= ?')
      args.push(lo)
    }
    if (hi) {
      conds.push('je.entry_date <= ?')
      args.push(hi)
    }
    const res = await c.execute({
      sql: `SELECT jl.account_id AS aid, SUM(jl.dr) AS dr, SUM(jl.cr) AS cr
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE ${conds.join(' AND ')} GROUP BY jl.account_id`,
      args
    })
    const m = new Map<number, { dr: number; cr: number }>()
    for (const r of res.rows) m.set(Number(r.aid), { dr: n(r.dr), cr: n(r.cr) })
    return m
  }

  const accounts = toPlain(await c.execute('SELECT id, name, acc_group FROM ledger_accounts ORDER BY acc_group, name'))
  // Which side each group falls on, read from the tree so a group somebody
  // created this morning under CURRENT ASSETS is an asset in this report —
  // rather than dropping to the unknown-name default and printing as one by
  // luck. The static list still answers for a book whose table is not there.
  const natures = await groupNatureMap()
  const [inPeriod, before] = await Promise.all([
    period(from, to),
    from ? period(undefined, dayBefore(from)) : Promise.resolve(new Map<number, { dr: number; cr: number }>())
  ])

  const rows: Row[] = []
  for (const a of accounts) {
    const p = inPeriod.get(Number(a.id)) || { dr: 0, cr: 0 }
    const o = before.get(Number(a.id)) || { dr: 0, cr: 0 }
    // The entered opening seeds the account; the movement between the cutoff
    // and the period start is added on top of it.
    const opening = (entered.get(Number(a.id)) || 0) + o.dr - o.cr
    const closing = opening + p.dr - p.cr
    if (Math.abs(opening) < 0.005 && Math.abs(p.dr) < 0.005 && Math.abs(p.cr) < 0.005) continue
    rows.push({
      id: a.id,
      name: a.name,
      acc_group: a.acc_group,
      nature: natures.get(String(a.acc_group)) || groupNature(String(a.acc_group)),
      opening,
      period_dr: p.dr,
      period_cr: p.cr,
      closing,
      closing_dr: closing > 0 ? closing : 0,
      closing_cr: closing < 0 ? -closing : 0
    })
  }
  const totals = {
    opening_dr: rows.reduce((s, r) => s + (r.opening > 0 ? r.opening : 0), 0),
    opening_cr: rows.reduce((s, r) => s + (r.opening < 0 ? -r.opening : 0), 0),
    period_dr: rows.reduce((s, r) => s + r.period_dr, 0),
    period_cr: rows.reduce((s, r) => s + r.period_cr, 0),
    closing_dr: rows.reduce((s, r) => s + r.closing_dr, 0),
    closing_cr: rows.reduce((s, r) => s + r.closing_cr, 0)
  }
  return { rows, totals }
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Pending bill references for a party ledger — what Tally offers under "Agst
// Ref". Supplier bills come from purchase invoices (what we owe), customer
// bills from sale invoices (what they owe), each net of everything already
// allocated against that reference. References created by Advance / New Ref
// lines appear too, so an advance can be settled later.
//
// Real bills carry an exact id (order_id for a purchase — one order is one
// bill; sale_invoice_group for a sale — one invoice can span several `sales`
// rows sharing that group) rather than relying on the invoice_no TEXT alone,
// which can be blank or duplicated across unrelated bills. Advance/New Ref
// entries have no such id — they're a hand-typed name from the start — so
// those stay matched by ref_name as before.
// `side` says which of the party's documents to offer, for a caller that knows:
// a credit note to a customer wants their SALES invoices, a debit note to a
// supplier wants their PURCHASE bills. Left unset, the party's ledger group
// decides, as before.
//
// This matters for a party that trades both ways — Bunge sells us oil and buys
// finished goods, so its ledger sits under Sundry Creditors and the group alone
// would only ever offer purchase bills, hiding every sales invoice from a credit
// note against them.
export async function listPendingRefs(
  accountName: string,
  companyId?: number,
  side?: 'customer' | 'supplier',
  /**
   * Every bill of the party, settled ones included (each carries `settled`).
   * For LINKING: a debit note for a shortage is raised against the purchase
   * bill it concerns even when that bill is already paid — Tally lets you pick
   * it, and so does this. Without it only bills with something pending come
   * back, which is what every other caller wants.
   */
  all = false
): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const name = String(accountName || '').trim().toUpperCase()
  if (!name) return []
  // THE MASTERS THIS LEDGER STANDS FOR. A ledger renamed from Masters keeps
  // its party's documents under the party's own name ("DEEPCHAND") while the
  // postings go to the new one ("DEEP CHAND ARYA INDUSTRIES (CR)") through
  // ledger_map — so matching the ledger's name alone found no bills at all for
  // any renamed party. Its own name, and every name that posts as it.
  const aliasRes = await c
    .execute({
      sql: `SELECT posts_as FROM ledger_map
             WHERE TRIM(UPPER(use_name)) = ? AND (company_id = ? OR company_id IS NULL)`,
      args: [name, cid]
    })
    .catch(() => null)
  const names = Array.from(
    new Set([name, ...(aliasRes ? toPlain(aliasRes).map((r) => String(r.posts_as || '').trim().toUpperCase()) : [])].filter(Boolean))
  )
  const nameIn = `(${names.map(() => '?').join(',')})`
  // TRIM both sides. The incoming name is trimmed, so a master name carrying
  // a trailing space could never match it — and a few do, which made every
  // one of that party's invoices invisible here.
  const acc = await c.execute({ sql: 'SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?', args: [name] })
  // A party with no ledger account yet still has documents worth offering when
  // the caller has told us which side to look at — a trading-only customer
  // never posts to these books, so no account exists for it.
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0
  if (!accountId && !side) return []
  const group = side === 'customer' ? 'Sundry Debtors' : side === 'supplier' ? 'Sundry Creditors' : await baseGroupOf(acc.rows[0]?.acc_group)

  // origin_id: the voucher that RAISED the bill — the purchase, the sale, the
  // freight bill, the advance — shown as the first line of its bill-wise detail.
  type Bill = { ref: string; bill_date: string; amount: number; order_id: number | null; sale_invoice_group: string | null; origin_id?: number | null }
  const bills: Bill[] = []
  if (group === 'Sundry Creditors') {
    const r = await c.execute({
      sql: `SELECT o.id AS order_id, o.invoice_no AS ref, o.order_date AS bill_date, o.net_amount AS amount,
                   (SELECT je.id FROM journal_entries je WHERE je.order_id = o.id ORDER BY je.id LIMIT 1) AS origin_id
            FROM orders o JOIN suppliers s ON s.id = o.supplier_id
            WHERE o.company_id = ? AND TRIM(UPPER(s.name)) IN ${nameIn} AND o.invoice_no IS NOT NULL AND o.invoice_no != ''`,
      args: [cid, ...names]
    })
    for (const b of toPlain(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ''), amount: n(b.amount), order_id: n(b.order_id), sale_invoice_group: null, origin_id: n(b.origin_id) || null })
    }
    // A TRANSPORTER'S OWN BILLS. A freight bill credits the carrier's ledger
    // (under Sundry Creditors, named after the transporter master), so paying
    // it is a payment against that bill — but only purchase invoices were
    // offered here, and a carrier's ledger listed nothing to pick. Matched by
    // the bill number, like any bill without an order behind it.
    const tb = await c
      .execute({
        sql: `SELECT tb.bill_no AS ref, tb.bill_date, tb.total AS amount, tb.journal_entry_id AS origin_id
              FROM transporter_bills tb JOIN transporters t ON t.id = tb.transporter_id
              WHERE tb.company_id = ? AND TRIM(UPPER(t.name)) IN ${nameIn} AND tb.bill_no IS NOT NULL AND TRIM(tb.bill_no) != ''`,
        args: [cid, ...names]
      })
      .catch(() => null)
    for (const b of tb ? toPlain(tb) : []) {
      bills.push({ ref: String(b.ref).trim(), bill_date: String(b.bill_date || ''), amount: n(b.amount), order_id: null, sale_invoice_group: null, origin_id: n(b.origin_id) || null })
    }
  } else if (group === 'Sundry Debtors') {
    const r = await c.execute({
      // Match the CUSTOMER MASTER's name first, falling back to the sale's own
      // free-text customer field. Matching the free text alone made every
      // invoice booked against a customer record with that text blank or
      // spelled differently invisible here — whole customers offered no
      // invoices at all to a credit note.
      sql: `SELECT COALESCE(s.invoice_group, s.invoice_no) AS grp, MIN(s.invoice_no) AS ref, MIN(s.sale_date) AS bill_date,
                   SUM(s.amount + s.gst_amount + s.round_off) AS amount,
                   MIN((SELECT MIN(je.id) FROM journal_entries je WHERE je.sale_id = s.id)) AS origin_id
            FROM sales s
            LEFT JOIN customers cu ON cu.id = s.customer_id
            WHERE s.company_id = ? AND TRIM(UPPER(COALESCE(cu.name, s.customer, ''))) IN ${nameIn}
              AND s.invoice_no IS NOT NULL AND s.invoice_no != ''
            GROUP BY grp`,
      args: [cid, ...names]
    })
    for (const b of toPlain(r)) {
      bills.push({ ref: String(b.ref), bill_date: String(b.bill_date || ''), amount: n(b.amount), order_id: null, sale_invoice_group: String(b.grp), origin_id: n(b.origin_id) || null })
    }
  }

  // A real bill's ref name, before anything hand-typed can touch it — a New
  // Ref/Advance that happens to spell the same name as an actual invoice must
  // never inflate that invoice's total, only its own separate running total.
  const realRefs = new Set(bills.map((b) => b.ref))

  // References this ledger's vouchers created (advances, opening bills) — no
  // id of their own, so still grouped and matched purely by name.
  const made = await c.execute({
    sql: `SELECT ba.ref_name AS ref, MIN(je.entry_date) AS bill_date, SUM(ba.amount) AS amount, MIN(je.id) AS origin_id
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method IN ('advance', 'new_ref') AND ba.ref_name IS NOT NULL
          GROUP BY ba.ref_name`,
    args: [accountId, cid]
  })
  const madeRows: Bill[] = []
  for (const m of toPlain(made)) {
    if (realRefs.has(String(m.ref))) {
      // Don't just drop it — a colliding New Ref/Advance is a real amount
      // someone allocated, it just can't share the real bill's row. Keep it
      // visible as its own flagged line so it gets reconciled, not lost.
      madeRows.push({ ref: `${m.ref} (duplicate ref — check this)`, bill_date: String(m.bill_date || ''), amount: n(m.amount), order_id: null, sale_invoice_group: null, origin_id: n(m.origin_id) || null })
      continue
    }
    madeRows.push({ ref: String(m.ref), bill_date: String(m.bill_date || ''), amount: n(m.amount), order_id: null, sale_invoice_group: null, origin_id: n(m.origin_id) || null })
  }

  // THE VOUCHER EACH BILL WAS RAISED BY — its date, type, number and the side
  // it put this ledger on — for the first line of the bill's detail, the way
  // Tally opens a bill with the SALE that made it. The number is the voucher's
  // own (JV/25, SAL/12), falling back to the reference typed on it.
  const vnum = async <T,>(withCode: () => Promise<T>, without: () => Promise<T>): Promise<T> => {
    try {
      return await withCode()
    } catch {
      return without()
    }
  }
  const originIds = Array.from(new Set([...bills, ...madeRows].map((b) => n(b.origin_id)).filter((x) => x > 0)))
  const origins = new Map<number, Row>()
  if (originIds.length && accountId) {
    const list = originIds.join(',')
    const sideSql = `(SELECT CASE WHEN COALESCE(SUM(jl.dr), 0) >= COALESCE(SUM(jl.cr), 0) THEN 'dr' ELSE 'cr' END
                        FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = ?) AS side`
    const res = await vnum(
      () =>
        c.execute({
          sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.order_id, je.sale_id, ${sideSql},
                       (SELECT vn.prefix || '/' || vn.serial FROM voucher_numbers vn WHERE vn.entry_id = je.id) AS code
                  FROM journal_entries je WHERE je.id IN (${list})`,
          args: [accountId]
        }),
      () => c.execute({ sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.order_id, je.sale_id, ${sideSql} FROM journal_entries je WHERE je.id IN (${list})`, args: [accountId] })
    )
    for (const r of toPlain(res)) {
      // The document behind it too, so the bill-wise detail can open the
      // purchase or sale rather than only its voucher.
      origins.set(n(r.id), {
        entry_id: n(r.id),
        entry_date: r.entry_date,
        vch_type: r.vch_type,
        vch_no: r.vch_no ?? null,
        code: r.code ?? null,
        side: r.side || null,
        order_id: n(r.order_id) || null,
        sale_id: n(r.sale_id) || null
      })
    }
  }

  // Every settlement against this ledger, fetched once — matched per bill
  // below by whichever key that bill actually has (id first, name as the
  // fallback for entries with no id, e.g. advances).
  // Which side each settlement put this ledger on, and its voucher number, so
  // the bill-wise detail can print it the way Tally does ("Journal 25 · 3,867 Cr").
  const settledSql = (withCode: boolean): string => `SELECT ba.ref_name AS ref, ba.order_id AS order_id, ba.sale_invoice_group AS sale_invoice_group,
                 ba.amount AS amount, je.id AS entry_id, je.entry_date, je.vch_type, je.vch_no, je.narration,
                 je.order_id AS doc_order_id, je.sale_id AS doc_sale_id,
                 CASE WHEN jl.dr > 0 THEN 'dr' ELSE 'cr' END AS side
                 ${withCode ? ", (SELECT vn.prefix || '/' || vn.serial FROM voucher_numbers vn WHERE vn.entry_id = je.id) AS code" : ''}
          FROM journal_bill_allocs ba
          JOIN journal_lines jl ON jl.id = ba.line_id
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ba.account_id = ? AND je.company_id = ? AND ba.method = 'agst_ref'
          ORDER BY je.entry_date, je.id`
  const settled = await vnum(
    () => c.execute({ sql: settledSql(true), args: [accountId, cid] }),
    () => c.execute({ sql: settledSql(false), args: [accountId, cid] })
  )
  const settledRows = toPlain(settled)
  // A settlement carrying an id matches its bill by that id. One carrying NONE
  // — a credit/debit note booked against an invoice number, an advance, an
  // opening bill — can only be matched by the name it names. That branch used
  // to also demand the BILL had no ids, and a sales invoice always has an
  // invoice_group, so a credit note raised against one never matched it: the
  // invoice stayed fully pending and the note fell through to On Account.
  const sameRef = (a: unknown, b: unknown): boolean =>
    String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
  const matches = (s2: Row, b: Bill): boolean => {
    const hasIds = !!s2.order_id || !!s2.sale_invoice_group
    if (hasIds) {
      if (b.order_id != null && n(s2.order_id) === b.order_id) return true
      if (b.sale_invoice_group != null && String(s2.sale_invoice_group || '') === b.sale_invoice_group) return true
      return false
    }
    return sameRef(s2.ref, b.ref)
  }
  // Every voucher that settled this bill, not just the total — a bill-wise
  // view has to be able to answer "paid by what" as well as "how much".
  const settlementsFor = (b: Bill): Row[] => {
    const out: Row[] = []
    for (const s of settledRows) {
      if (matches(s, b)) {
        out.push({
          entry_id: n(s.entry_id) || null,
          entry_date: s.entry_date,
          vch_type: s.vch_type,
          vch_no: s.vch_no,
          code: s.code ?? null,
          side: s.side || null,
          narration: s.narration,
          amount: round2(n(s.amount)),
          order_id: n(s.doc_order_id) || null,
          sale_id: n(s.doc_sale_id) || null
        })
      }
    }
    return out
  }

  // WHICH WAY A SETTLEMENT MOVES A BILL. A receipt against a sale (Cr against
  // a Dr bill) reduces it; a journal that DEBITS the same party against that
  // bill adds to it — Tally reads it so. Every allocation used to be counted
  // as a payment whichever side it was on, so a Dr ₹1,000 against a customer's
  // bill took ₹1,000 OFF what they owed instead of adding it. The bill's own
  // side is the side its voucher put this ledger on; a settlement on the other
  // side settles it, one on the same side adds to it. A settlement whose side
  // is not known reads as settling, as before.
  const billSideOf = (b: Bill): 'dr' | 'cr' => {
    const s2 = String(origins.get(n(b.origin_id))?.side || '')
    if (s2 === 'dr' || s2 === 'cr') return s2
    return group === 'Sundry Debtors' ? 'dr' : 'cr'
  }

  return [...bills, ...madeRows]
    .map((b) => {
      const settlements = settlementsFor(b)
      const side = billSideOf(b)
      const paid = round2(settlements.reduce((t, x) => t + (x.side === side ? -n(x.amount) : n(x.amount)), 0))
      return {
        ref: b.ref,
        bill_date: b.bill_date,
        amount: n(b.amount),
        order_id: b.order_id,
        sale_invoice_group: b.sale_invoice_group,
        paid,
        settlements,
        origin: origins.get(n(b.origin_id)) || null,
        pending: round2(n(b.amount) - paid),
        settled: round2(n(b.amount) - paid) <= 0.005
      }
    })
    .filter((b) => all || b.pending > 0.005)
    .sort((a, b) => a.bill_date.localeCompare(b.bill_date))
}

// ---------------------------------------------------------------------------
// Bills Outstanding for one party, the way Tally's "Ledger Voucher Outstanding"
// reads: a line per bill with what it was raised for, what is still open, when
// it falls due, and how long it has been overdue — then a sub total, and an
// "On Account" line for the part of the balance no bill claims.
//
// On Account is DERIVED (closing balance less the open bills) rather than
// summed from on-account allocations. That way the report always ties to the
// ledger it is reporting on: anything the bills do not explain has to be
// on account by definition, including a payment entered before its invoice.
// ---------------------------------------------------------------------------
export async function billsOutstanding(
  accountName: string,
  companyId?: number,
  opts: { asOf?: string; side?: 'customer' | 'supplier'; settled?: boolean } = {}
): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const name = String(accountName || '').trim().toUpperCase()
  if (!name) return { rows: [], on_account: 0, total_opening: 0, total_pending: 0, as_of: opts.asOf || todayISO() }
  const asOf = String(opts.asOf || todayISO()).slice(0, 10)

  const acc = await c.execute({
    sql: 'SELECT id, acc_group FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?',
    args: [name]
  })
  const accountId = acc.rows.length ? Number(acc.rows[0].id) : 0
  const group = await baseGroupOf(acc.rows[0]?.acc_group)
  // Which way round this party's balance runs, so Dr/Cr reads correctly.
  const debtor = opts.side === 'customer' || group === 'Sundry Debtors'

  // The credit period the party was granted, for the due date.
  const master = debtor ? 'customers' : 'suppliers'
  // A renamed ledger's master still carries the party's own name — the one
  // that posts as this ledger through ledger_map — so look there too.
  const cp = await c.execute({
    sql: `SELECT credit_period_days FROM ${master}
           WHERE TRIM(UPPER(name)) = ?
              OR TRIM(UPPER(name)) IN (SELECT TRIM(UPPER(posts_as)) FROM ledger_map
                                        WHERE TRIM(UPPER(use_name)) = ? AND (company_id = ? OR company_id IS NULL))
           ORDER BY CASE WHEN TRIM(UPPER(name)) = ? THEN 0 ELSE 1 END
           LIMIT 1`,
    args: [name, name, cid, name]
  }).catch(() => c.execute({ sql: `SELECT credit_period_days FROM ${master} WHERE TRIM(UPPER(name)) = ? LIMIT 1`, args: [name] }))
  const creditDays = cp.rows.length ? n(cp.rows[0].credit_period_days) : 0

  // Settled bills too when asked (Bill-wise → Settled: Show); the totals and
  // On Account are worked out on the open bills either way.
  const bills = await listPendingRefs(accountName, cid, opts.side, !!opts.settled)
  const dayMs = 86400000
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`)
  const rows = bills
    .filter((b) => String(b.bill_date || '').slice(0, 10) <= asOf)
    .map((b) => {
      const billDate = String(b.bill_date || '').slice(0, 10)
      let dueOn = billDate
      if (billDate && creditDays > 0) {
        const d = new Date(`${billDate}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() + creditDays)
        dueOn = d.toISOString().slice(0, 10)
      }
      const dueMs = dueOn ? Date.parse(`${dueOn}T00:00:00Z`) : NaN
      const overdue = Number.isFinite(dueMs) && asOfMs > dueMs ? Math.floor((asOfMs - dueMs) / dayMs) : 0
      return {
        bill_date: billDate,
        ref: b.ref,
        opening: round2(n(b.amount)),
        paid: round2(n(b.paid)),
        pending: round2(n(b.pending)),
        settlements: Array.isArray(b.settlements) ? b.settlements : [],
        origin: b.origin ?? null,
        due_on: dueOn,
        overdue_days: overdue,
        order_id: b.order_id,
        sale_invoice_group: b.sale_invoice_group
      }
    })

  // DUE FROM THE DAY THE TANKER WAS EMPTIED, for a reader who counts credit
  // from there rather than from the invoice. A purchase's tanker empties at
  // our plant (its last tanker, when there were several; an order received
  // without a tanker, its received date); a sale's empties at the customer —
  // its Unloaded date, once every line of the invoice is unloaded. A tanker
  // still on the road has no such date yet ('awaiting'); a bill with no
  // tanker behind it — a freight bill, an advance — has none at all (null),
  // and the screen falls back to the invoice date for it.
  const emptyOf = new Map<string, { on: string | null; state: 'empty' | 'awaiting' }>()
  const orderIds = [...new Set(rows.map((r) => n(r.order_id)).filter((x) => x > 0))]
  if (orderIds.length) {
    const er = await c.execute({
      sql: `SELECT o.id, o.status, o.received_date,
                   (SELECT COUNT(*) FROM ${ALLOC} a JOIN purchase_tankers pt ON pt.id = a.tanker_id WHERE a.order_id = o.id) AS tk,
                   (SELECT COUNT(*) FROM ${ALLOC} a JOIN purchase_tankers pt ON pt.id = a.tanker_id WHERE a.order_id = o.id AND COALESCE(pt.empty_date, '') != '') AS tk_empty,
                   (SELECT MAX(pt.empty_date) FROM ${ALLOC} a JOIN purchase_tankers pt ON pt.id = a.tanker_id WHERE a.order_id = o.id AND COALESCE(pt.empty_date, '') != '') AS last_empty
              FROM orders o WHERE o.id IN (${orderIds.map(() => '?').join(', ')})`,
      args: orderIds
    })
    for (const o of toPlain(er)) {
      const tk = n(o.tk)
      const on = tk > 0 ? (n(o.tk_empty) >= tk ? String(o.last_empty || '').slice(0, 10) : '') : String(o.status) === 'received' ? String(o.received_date || '').slice(0, 10) : ''
      emptyOf.set(`o${n(o.id)}`, on ? { on, state: 'empty' } : { on: null, state: 'awaiting' })
    }
  }
  const groups = [...new Set(rows.map((r) => String(r.sale_invoice_group || '')).filter(Boolean))]
  if (groups.length) {
    const sr = await c.execute({
      sql: `SELECT COALESCE(invoice_group, invoice_no) AS grp, COUNT(*) AS k,
                   SUM(CASE WHEN dispatch_stage = 'unloaded' AND COALESCE(unloaded_date, '') != '' THEN 1 ELSE 0 END) AS done,
                   MAX(unloaded_date) AS last_unloaded
              FROM sales
             WHERE company_id = ? AND COALESCE(invoice_group, invoice_no) IN (${groups.map(() => '?').join(', ')})
             GROUP BY grp`,
      args: [cid, ...groups]
    })
    for (const s of toPlain(sr)) {
      const on = n(s.done) >= n(s.k) && n(s.k) > 0 ? String(s.last_unloaded || '').slice(0, 10) : ''
      emptyOf.set(`s${String(s.grp)}`, on ? { on, state: 'empty' } : { on: null, state: 'awaiting' })
    }
  }
  for (const r of rows as Row[]) {
    const e = r.order_id ? emptyOf.get(`o${n(r.order_id)}`) : r.sale_invoice_group ? emptyOf.get(`s${String(r.sale_invoice_group)}`) : undefined
    r.empty_state = e ? e.state : null
    r.empty_on = e?.on || null
    if (e?.on) {
      const d = new Date(`${e.on}T00:00:00Z`)
      if (creditDays > 0) d.setUTCDate(d.getUTCDate() + creditDays)
      const due = d.toISOString().slice(0, 10)
      const dueMs = Date.parse(`${due}T00:00:00Z`)
      r.due_on_empty = due
      r.overdue_days_empty = asOfMs > dueMs ? Math.floor((asOfMs - dueMs) / dayMs) : 0
    } else {
      r.due_on_empty = null
      r.overdue_days_empty = 0
    }
  }

  // The ledger's own closing balance as at asOf, signed the same way the
  // statement shows it (positive = Dr).
  const balRes = accountId
    ? await c.execute({
        sql: `SELECT ROUND(COALESCE(SUM(jl.dr), 0) - COALESCE(SUM(jl.cr), 0), 2) AS bal
              FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.account_id = ? AND je.company_id = ? AND je.entry_date <= ?`,
        args: [accountId, cid, asOf]
      })
    : null
  const balance = balRes ? n(balRes.rows[0]?.bal) : 0

  // CREDITORS: PAYMENTS WITH NO AGST REF CLEAR THE OLDEST BILLS FIRST.
  //
  // A payment booked from a bank book carries no bill-wise allocation, so it
  // sat in On Account while every bill read as unpaid. What the bills do not
  // claim of the money paid is spread over the open bills oldest first — each
  // piece named by the payment it came from, oldest payment first — the same
  // rule Trading Payments applies (fifoSettle.ts). Worked out on each read and
  // never written to the books: a payment added or deleted moves it at once.
  if (!debtor && accountId) {
    const pendingNow = round2(rows.reduce((t, r) => t + n(r.pending), 0))
    let spare = round2(balance + pendingNow) // the Dr the bills do not explain
    if (spare > 0.005) {
      const pays = toPlain(
        await c.execute({
          sql: `SELECT je.id AS entry_id, je.entry_date, je.vch_type, je.vch_no, je.narration, jl.dr,
                       COALESCE((SELECT SUM(ba.amount) FROM journal_bill_allocs ba WHERE ba.line_id = jl.id AND ba.method = 'agst_ref'), 0) AS named
                  FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                 WHERE jl.account_id = ? AND je.company_id = ? AND je.entry_date <= ? AND jl.dr > 0
                 ORDER BY je.entry_date, je.id`,
          args: [accountId, cid, asOf]
        })
      )
        .map((x): Row => ({ ...x, free: round2(n(x.dr) - n(x.named)) }))
        .filter((x) => n(x.free) > 0.005)
      let pi = 0
      for (const r of rows as Row[]) {
        while (spare > 0.005 && n(r.pending) > 0.005 && pi < pays.length) {
          const p = pays[pi]
          const take = round2(Math.min(n(r.pending), n(p.free), spare))
          r.settlements = [
            ...(r.settlements as Row[]),
            { entry_id: n(p.entry_id), entry_date: p.entry_date, vch_type: p.vch_type, vch_no: p.vch_no, side: 'dr', narration: p.narration, amount: take, fifo: true }
          ]
          r.paid = round2(n(r.paid) + take)
          r.pending = round2(n(r.pending) - take)
          r.fifo = true
          p.free = round2(n(p.free) - take)
          spare = round2(spare - take)
          if (n(p.free) <= 0.005) pi++
        }
        if (spare <= 0.005 || pi >= pays.length) break
      }
    }
  }
  // Settled bills drop off the list, as they always did.
  const open = (rows as Row[]).filter((r) => n(r.pending) > 0.005)
  const totalPending = round2(open.reduce((t, r) => t + n(r.pending), 0))
  // A debtor's bills are Dr, a creditor's are Cr — compare like for like before
  // calling the remainder On Account.
  const billsSigned = debtor ? totalPending : -totalPending
  const onAccount = round2(balance - billsSigned)

  return {
    as_of: asOf,
    debtor,
    credit_days: creditDays,
    rows: opts.settled ? (rows as Row[]).map((r) => ({ ...r, settled: n(r.pending) <= 0.005 })) : open,
    settled_count: (rows as Row[]).length - open.length,
    total_opening: round2(open.reduce((t, r) => t + n(r.opening), 0)),
    total_paid: round2(open.reduce((t, r) => t + n(r.paid), 0)),
    total_pending: totalPending,
    balance: round2(balance),
    on_account: onAccount
  }
}

// Turnover per oil, over a period: what was loaded in (purchases) against
// what went out (sales) — quantity and value both, so this doubles as the
// oil-loading figures and the trading/turnover account in one table instead
// of two disconnected screens.
export async function tradingAccount(from?: string, to?: string, companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const f = from || '0000-01-01'
  const t = to || '9999-12-31'

  const purchases = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(COALESCE(o.received_qty, o.ordered_qty)) AS qty, SUM(o.taxable_value) AS value
          FROM orders o JOIN products p ON p.id = o.oil_type_id
          WHERE o.company_id = ? AND o.order_date BETWEEN ? AND ?
          GROUP BY code`,
    args: [cid, f, t]
  })

  const sales = await c.execute({
    sql: `SELECT COALESCE(NULLIF(p.code, ''), p.name) AS code, p.name AS name,
                 SUM(s.qty) AS qty, SUM(s.amount) AS value
          FROM sales s JOIN products p ON p.id = s.product_id
          WHERE s.company_id = ? AND s.sale_date BETWEEN ? AND ? AND s.status = 'done'
          GROUP BY code`,
    args: [cid, f, t]
  })

  const m = new Map<string, Row>()
  for (const r of toPlain(purchases)) {
    m.set(String(r.code), {
      code: r.code, name: r.name,
      purchase_qty: n(r.qty), purchase_value: n(r.value),
      sale_qty: 0, sale_value: 0
    })
  }
  for (const r of toPlain(sales)) {
    const key = String(r.code)
    const g = m.get(key) || { code: key, name: r.name, purchase_qty: 0, purchase_value: 0, sale_qty: 0, sale_value: 0 }
    g.sale_qty = n(r.qty)
    g.sale_value = n(r.value)
    m.set(key, g)
  }
  const list: Row[] = Array.from(m.values()).map((g) => ({
    ...g,
    gross: Math.round((n(g.sale_value) - n(g.purchase_value)) * 100) / 100
  }))
  return list.sort((a, b) => String(a.code).localeCompare(String(b.code)))
}
