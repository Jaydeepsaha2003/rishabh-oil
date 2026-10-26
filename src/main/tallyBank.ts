import ExcelJS from 'exceljs'
import { parsedFile, booksRead } from './tallyCache'
import { getClient } from './db'
import { createVoucher, type VoucherType } from './accounting'
import { checkedFor, linksFor, recordTallyBatch, saveTallyLink } from './tallyLinks'
import { withDbTransaction } from './dbTransaction'
import { cellValue, companyKey, companyOf, sameCompany, isoDate, mappingRows, periodOf, resolveNames, saleDateLimits, tallyKey, toPlain } from './tallyNotes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// A BANK'S BOOK FROM TALLY — laid against the same bank's ledger here.
//
// The desk first says WHICH bank (a ledger under Bank Accounts / Bank OD A/c),
// then uploads Tally's book of it: Display → Account Books → Cash/Bank Book →
// the bank → Export. One line per voucher — the date, the ledger on the other
// side ("Dr"/"Cr" before it), the voucher type and number, and what came in
// (Debit) or went out (Credit) — between the opening and the closing balance.
//
// The software posts its own payments and receipts (LC charges, bill
// discounting, supplier payments) under its own numbers, so a Tally line is
// found by what it is: the same direction and amount, within a few days, to
// the same party. Same day and party is a match; another day is a date to
// fix; same amount without the party is a POSSIBLE MATCH, never booked twice
// without a word. What Tally has and these books do not is booked as a
// PAYMENT, RECEIPT or CONTRA on this bank — two lines, the bank and the ledger
// Tally names — under Tally's number.
// ---------------------------------------------------------------------------

const n = (v: unknown): number => {
  const x = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(x) ? x : 0
}
const round2 = (x: number): number => Math.round((Number(x) || 0) * 100) / 100
const inr = (v: number): string => `₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dmy = (iso: string): string => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '—')
const NEAR_DAYS = 7
// THE VOUCHER NUMBER, as a witness. A line booked from Tally keeps Tally's
// number (No. 186); one with the same number and amount here is the same entry
// even a month apart. Plain numbers only, leading zeros ignored — "I1" or a
// cheque reference is not a voucher number.
const NUM_DAYS = 45
const vchNum = (v: unknown): string => {
  const s = String(v ?? '').trim()
  return /^\d+$/.test(s) ? String(Number(s)) : ''
}
const sameNum = (a: unknown, b: unknown): boolean => !!vchNum(a) && vchNum(a) === vchNum(b)
const MONEY_GROUPS = ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand']

function daysApart(a: string, b: string): number {
  const x = Date.parse(`${a.slice(0, 10)}T00:00:00Z`)
  const y = Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round(Math.abs(x - y) / 86400000) : 9999
}
function shiftDays(iso: string, d: number): string {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(t) ? new Date(t + d * 86400000).toISOString().slice(0, 10) : iso
}
/** The account number in a bank's name — what the two systems are most likely to agree on. */
function acctDigits(s: string): string {
  const runs = String(s || '').match(/\d{4,}/g) || []
  return runs.sort((a, b) => b.length - a.length)[0] || ''
}

export interface BankLine {
  key: string
  row: number
  date: string
  party: string
  party_key: string
  vch_type: string
  vch_no: string
  dir: 'in' | 'out'
  amount: number
  // Tally prints "(as per details)" for a voucher of several ledgers. From
  // the condensed book such a line cannot be rebuilt; the DETAILED book (Alt+F1
  // in Tally before exporting) lists each ledger under it — `details` — and
  // then it can be booked like any other.
  multi: boolean
  cancelled: boolean
  details?: BankDetail[]
}

// One ledger of an "as per details" voucher, from Tally's detailed book.
interface BankDetail {
  name: string
  party_key: string
  amount: number
  side: 'dr' | 'cr'
}

// A multi-ledger voucher whose detail rows were read and add up to its amount
// — the ledgers on the other side of the bank, net, equal what moved.
function detailsReady(t: BankLine): boolean {
  const d = t.details || []
  if (!d.length || d.some((x) => !x.name || !(x.amount > 0))) return false
  const towardsBank = t.dir === 'out' ? 'dr' : 'cr'
  const net = d.reduce((sum, x) => sum + (x.side === towardsBank ? x.amount : -x.amount), 0)
  return Math.abs(round2(net) - t.amount) < 0.02
}

interface ParsedBook {
  company: string
  bank: string
  period: string
  from: string
  to: string
  opening: number
  closing: number
  closing_stated: number | null
  lines: BankLine[]
}

async function parseBankBook(b64: string): Promise<ParsedBook> {
  if (!b64) throw new Error('Choose the Tally bank book to upload')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(Buffer.from(b64, 'base64') as unknown as ArrayBuffer)
  } catch {
    throw new Error('That file could not be read — export the bank book from Tally as Excel (.xlsx)')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('That workbook has no sheet in it')
  const grid: unknown[][] = []
  // Each figure's display format — the detailed book prints a ledger's amount
  // as 202604.62 with a "Dr" or "Cr" in the format rather than the value.
  const fmts: string[][] = []
  ws.eachRow({ includeEmpty: true }, (row, i) => {
    const cells: unknown[] = []
    const f: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      cells[c - 1] = cellValue(cell.value)
      f[c - 1] = String(cell.numFmt || '')
    })
    fmts[i - 1] = f
    grid[i - 1] = cells
  })
  const txt = (v: unknown): string => String(v ?? '').trim()
  const headAt = grid.findIndex(
    (r) => (r || []).some((c) => /^date$/i.test(txt(c))) && (r || []).some((c) => /^debit$/i.test(txt(c))) && (r || []).some((c) => /^credit$/i.test(txt(c)))
  )
  if (headAt < 0) throw new Error('No Date / Debit / Credit header found — export the bank book from Tally exactly as it shows')
  const head = (grid[headAt] || []).map(txt)
  const at = (re: RegExp): number => head.findIndex((h) => re.test(h))
  const iDate = at(/^date$/i)
  const iPart = at(/^particulars$/i)
  const iType = at(/^vch\.?\s*type$|^voucher\s*type$/i)
  const iNo = at(/^vch\.?\s*no\.?$|^voucher\s*no\.?$/i)
  const iDr = at(/^debit$/i)
  const iCr = at(/^credit$/i)
  if (iType < 0 || iNo < 0) throw new Error('The book needs its Vch Type and Vch No. columns — export it with them shown')
  // The heading: company, then "<Bank> Book", then the address and period.
  let bank = ''
  let period = ''
  for (let r = 0; r < headAt; r++) {
    const s = txt(grid[r]?.[0])
    if (!bank && /\bbook\s*$/i.test(s)) bank = s.replace(/\s*book\s*$/i, '').trim()
    if (/\d{1,2}-[A-Za-z]{3}-\d{2,4}\s*to\s*\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test(s)) period = s
  }
  if (!bank) bank = txt(grid[1]?.[0])
  // The ledger named on a line sits after the Dr/Cr word, in whichever cell of
  // the merged Particulars block holds it.
  const partOf = (row: unknown[]): { side: string; name: string } => {
    let side = ''
    let name = ''
    const last = iType > iPart ? iType : row.length
    for (let i = Math.max(0, iPart); i < last; i++) {
      const s = txt(row[i])
      if (!s) continue
      if (!side && /^(dr|cr|to|by)$/i.test(s)) side = s
      else if (!name && typeof row[i] === 'string') name = s
    }
    return { side, name }
  }
  const out: ParsedBook = { company: txt(grid[0]?.[0]), bank, period, from: '', to: '', opening: 0, closing: 0, closing_stated: null, lines: [] }
  const seen = new Map<string, number>()
  // A ledger row of the DETAILED book: no date, no voucher number, a ledger in
  // Particulars and its amount — "202604.62 Dr" as text, or a bare figure.
  const detailOf = (row: unknown[], dir: 'in' | 'out', fmt: string[] = []): { amount: number; side: 'dr' | 'cr' } | null => {
    for (let i = 0; i < row.length; i++) {
      const m = /^(-?[\d,]+(?:\.\d+)?)\s*(Dr|Cr)\.?$/i.exec(txt(row[i]))
      if (m) return { amount: round2(Math.abs(n(m[1].replace(/,/g, '')))), side: m[2].toLowerCase() === 'dr' ? 'dr' : 'cr' }
    }
    for (let i = 0; i < row.length; i++) {
      if (i === iDate || i === iNo) continue
      const v = row[i]
      if (typeof v === 'number' && Math.abs(v) > 0.004) {
        // A bare figure: its format's Dr/Cr first; else the book's own
        // Debit/Credit column; else Dr for a payment's ledgers, Cr for a
        // receipt's — and a negative figure is the other side.
        const f = String(fmt[i] || '')
        const fDr = /"?\bDr\b/i.test(f)
        const fCr = /"?\bCr\b/i.test(f)
        let side: 'dr' | 'cr' =
          fDr && !fCr ? 'dr' : fCr && !fDr ? 'cr' : i === iDr ? 'dr' : i === iCr ? 'cr' : dir === 'out' ? 'dr' : 'cr'
        if (fDr && fCr && v < 0) side = 'cr'
        else if (fDr && fCr) side = 'dr'
        else if (!fDr && !fCr && v < 0) side = side === 'dr' ? 'cr' : 'dr'
        return { amount: round2(Math.abs(v)), side }
      }
    }
    return null
  }
  let last: BankLine | null = null
  let openingRead = false
  for (let r = headAt + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const { side, name } = partOf(row)
    // The detailed book's ledger rows belong to the voucher just above them.
    if (last && !isoDate(row[iDate]) && !txt(row[iNo]) && name && !/^(opening|closing)\s*balance$/i.test(name)) {
      const d = detailOf(row, last.dir, fmts[r] || [])
      if (d) {
        last.details = [...(last.details || []), { name, party_key: tallyKey(name), amount: d.amount, side: d.side }]
        continue
      }
    }
    const dr = round2(n(row[iDr]))
    const cr = round2(n(row[iCr]))
    if (/^opening\s*balance$/i.test(name)) {
      out.opening = round2(dr - cr)
      openingRead = true
      continue
    }
    if (/^closing\s*balance$/i.test(name)) {
      // Printed on the side that balances the columns; its own Dr/Cr word says
      // which way the bank stands.
      const amt = [...row].map((c) => n(c)).find((x) => Math.abs(x) > 0) || 0
      out.closing_stated = round2(/^(cr|by)$/i.test(side) ? -Math.abs(amt) : Math.abs(amt))
      continue
    }
    const date = isoDate(row[iDate])
    const vchNo = txt(row[iNo])
    const vchType = txt(row[iType])
    if (!date || !vchNo || !vchType) continue
    const cancelled = /\(\s*cancel+ed\s*\)/i.test(name) || (dr === 0 && cr === 0)
    const party = name.replace(/\(\s*cancel+ed\s*\)/i, '').trim()
    let key = `${vchType.toUpperCase()}|${vchNo}`
    const dup = seen.get(key) || 0
    seen.set(key, dup + 1)
    if (dup) key = `${key}#${r + 1}`
    const line: BankLine = {
      key,
      row: r + 1,
      date,
      party,
      party_key: tallyKey(party),
      vch_type: vchType,
      vch_no: vchNo,
      dir: dr > 0 ? 'in' : 'out',
      amount: dr > 0 ? dr : cr,
      multi: /as\s*per\s*details/i.test(party),
      cancelled
    }
    out.lines.push(line)
    last = line
  }
  // A single-ledger voucher's own detail row says nothing new; only the
  // "as per details" ones keep theirs.
  for (const l of out.lines) if (!l.multi) delete l.details
  if (!out.lines.length) throw new Error('No vouchers found in the book — check it is the bank book exported from Tally')
  const p = periodOf(period)
  const dates = out.lines.map((x) => x.date).sort()
  out.from = p.from || dates[0]
  out.to = p.to || dates[dates.length - 1]
  const net = out.lines.filter((l) => !l.cancelled).reduce((t, l) => t + (l.dir === 'in' ? l.amount : -l.amount), 0)
  // NO OPENING ROW, BUT A CLOSING ONE: the opening is what the closing says it
  // must have been. A book exported without its Opening Balance line read as
  // opening ₹0, and the whole ₹11.11 Cr opening showed as a Tally difference.
  if (!openingRead && out.closing_stated != null) out.opening = round2(out.closing_stated - net)
  out.closing = round2(out.opening + net)
  return out
}

// ---------------------------------------------------------------------------
// THE BANK HERE
// ---------------------------------------------------------------------------

interface BookEntry {
  id: number
  code: string
  vch_type: string
  vch_no: string
  date: string
  narration: string
  payment_id: number
  dir: 'in' | 'out'
  amount: number
  // The other side of the voucher: the ledgers moving the other way.
  counter: { account_id: number; name: string; group: string; amount: number }[]
}

async function bankAccount(accountId: number): Promise<Row> {
  const r = (await getClient().execute({ sql: 'SELECT id, name, acc_group FROM ledger_accounts WHERE id = ?', args: [accountId] })).rows[0] as unknown as Row | undefined
  if (!r) throw new Error('Pick the bank this book is for')
  if (!MONEY_GROUPS.includes(String(r.acc_group))) throw new Error(`${String(r.name)} is not a bank or cash ledger — pick the bank this book is for`)
  return r
}

async function bankEntries(cid: number, accountId: number, from: string, to: string): Promise<BookEntry[]> {
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, je.payment_id,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code,
                   jl.account_id, jl.dr, jl.cr, a.name, a.acc_group
              FROM journal_entries je
              JOIN journal_lines jl ON jl.entry_id = je.id
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.company_id = ? AND substr(je.entry_date, 1, 10) BETWEEN ? AND ?
               AND je.id IN (SELECT entry_id FROM journal_lines WHERE account_id = ?)
             ORDER BY je.id, jl.id`,
      args: [cid, shiftDays(from, -NEAR_DAYS - 3), shiftDays(to, NEAR_DAYS + 3), accountId]
    })
  )
  const by = new Map<number, Row[]>()
  for (const r of rows) {
    const id = Number(r.id)
    if (!by.has(id)) by.set(id, [])
    ;(by.get(id) as Row[]).push(r)
  }
  const out: BookEntry[] = []
  for (const [id, ls] of by) {
    const mine = ls.filter((l) => Number(l.account_id) === accountId)
    const net = round2(mine.reduce((t, l) => t + n(l.dr) - n(l.cr), 0))
    if (Math.abs(net) < 0.005) continue
    const dir: 'in' | 'out' = net > 0 ? 'in' : 'out'
    const counter = ls
      .filter((l) => Number(l.account_id) !== accountId && (dir === 'in' ? n(l.cr) > 0 : n(l.dr) > 0))
      .map((l) => ({ account_id: Number(l.account_id), name: String(l.name), group: String(l.acc_group || ''), amount: round2(n(dir === 'in' ? l.cr : l.dr)) }))
      .sort((a, b) => b.amount - a.amount)
    out.push({
      id,
      code: String(ls[0].code || ''),
      vch_type: String(ls[0].vch_type || ''),
      vch_no: String(ls[0].vch_no || ''),
      date: String(ls[0].entry_date || '').slice(0, 10),
      narration: String(ls[0].narration || ''),
      payment_id: Number(ls[0].payment_id) || 0,
      dir,
      amount: Math.abs(net),
      counter
    })
  }
  return out
}

/** What the bank stood at here at the start of a day: the entered opening and everything since the books began. */
export async function bankBalanceBefore(cid: number, accountId: number, day: string): Promise<number> {
  const { getBooksFrom } = await import('./openings')
  const booksFrom = String((await getBooksFrom(cid)) || '')
  const op = (await getClient().execute({ sql: 'SELECT dr, cr FROM ledger_openings WHERE company_id = ? AND account_id = ?', args: [cid, accountId] })).rows[0] as unknown as Row | undefined
  const r = (
    await getClient().execute({
      sql: `SELECT COALESCE(SUM(jl.dr - jl.cr), 0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.account_id = ? AND je.company_id = ? AND substr(je.entry_date, 1, 10) < ?${booksFrom ? ' AND substr(je.entry_date, 1, 10) >= ?' : ''}`,
      args: booksFrom ? [accountId, cid, day, booksFrom] : [accountId, cid, day]
    })
  ).rows[0] as unknown as Row
  return round2((op ? n(op.dr) - n(op.cr) : 0) + n(r?.v))
}

type Mapped = Map<string, { account_id: number; account_name: string; how: 'saved' | 'auto' }>

function samePartyLine(t: BankLine, b: BookEntry, mapped: Mapped): boolean {
  const same = (key: string, name: string): boolean => {
    const m = mapped.get(key)
    return b.counter.some((c) => (m ? c.account_id === m.account_id : tallyKey(c.name) === key || companyKey(c.name) === companyKey(name)))
  }
  // "(AS PER DETAILS)" IS NOT A PARTY. A voucher of several ledgers names its
  // party in its detail rows, and the biggest of them is what it is for — LC
  // PAYABLE HDFCBANK under an LC repayment's ₹1,180 charges, the bills
  // discounted ledger under a repayment's interest. Compared as the words "(as
  // per details)", every such voucher could only ever be a "possible match".
  if (t.multi && t.details?.length) {
    const main = t.details.reduce((a, d) => (d.amount > a.amount ? d : a), t.details[0])
    return same(main.party_key, main.name)
  }
  return same(t.party_key, t.party)
}

const narrationHead = (bank: string, t: BankLine): string => `Imported from Tally — ${bank} Book · ${t.vch_type} No. ${t.vch_no}`

/**
 * WHO EACH IMPORTED BANK VOUCHER NAMED, IN TALLY.
 *
 * Every bank book uploaded under Tally File Updation is kept (tally_import_drafts,
 * kind bank:<ledger>), and every voucher booked from one is narrated with its
 * head. Read back together they say which Tally ledger a booked line was for —
 * the evidence a repair needs when a voucher landed on the wrong ledger here.
 * Keyed by narration head; the party per ledger leg (one, or a detailed
 * voucher's several).
 */
export async function tallyBankParties(): Promise<Map<string, { date: string; legs: { name: string; amount: number }[] }>> {
  const out = new Map<string, { date: string; legs: { name: string; amount: number }[] }>()
  const drafts = toPlain(
    await getClient()
      .execute("SELECT data_base64 FROM tally_import_drafts WHERE kind LIKE 'bank:%' AND data_base64 IS NOT NULL")
      .catch(() => ({ rows: [], columns: [] }) as never)
  )
  for (const d of drafts) {
    try {
      const book = await parseBankBook(String(d.data_base64))
      for (const t of book.lines) {
        const legs = t.multi ? (t.details || []).map((x) => ({ name: x.name, amount: x.amount })) : [{ name: t.party, amount: t.amount }]
        out.set(narrationHead(book.bank, t), { date: t.date, legs })
      }
    } catch {
      // A file that no longer parses says nothing either way.
    }
  }
  return out
}

interface StatementLine {
  date: string
  narration: string
  dir: 'in' | 'out'
  amount: number
  balance: number | null
}

interface Statement {
  name: string
  lines: StatementLine[]
  from: string
  to: string
  opening: number | null
  closing: number | null
}

/**
 * The bank's own statement, as the third witness. Debit on a statement is a
 * withdrawal (money out), Credit a deposit (money in). Its opening is worked
 * back from the first running balance; banks print newest-first as often as
 * oldest-first, so the order is read from the dates.
 */
async function readStatement(b64: string, name: string): Promise<Statement | null> {
  if (!b64) return null
  const { parseStatementFile } = await import('./bankRecon')
  const raw = await parseStatementFile(b64, name)
  if (!raw.length) throw new Error("No transactions found in the bank's statement — it needs Date and Withdrawal/Deposit (or Debit/Credit) columns")
  const newestFirst = raw.length > 1 && raw[0].txn_date > raw[raw.length - 1].txn_date
  const chrono = newestFirst ? [...raw].reverse() : raw
  const lines: StatementLine[] = chrono.map((l) => ({
    date: l.txn_date,
    narration: l.narration,
    dir: n(l.credit) > 0 ? 'in' : 'out',
    amount: round2(n(l.credit) > 0 ? n(l.credit) : n(l.debit)),
    balance: l.balance == null ? null : round2(n(l.balance))
  }))
  const first = lines[0]
  const last = lines[lines.length - 1]
  return {
    name,
    lines,
    from: first.date,
    to: last.date,
    opening: first.balance == null ? null : round2(first.balance - (first.dir === 'in' ? first.amount : -first.amount)),
    closing: last.balance
  }
}

interface Reconciled {
  statement: Statement | null
  book: ParsedBook
  account: Row
  mapped: Mapped
  rows: Row[]
  entries: BookEntry[]
}

async function reconcileBank(v: { account_id: number; data_base64: string; company_id?: number; statement_base64?: string; statement_name?: string }): Promise<Reconciled> {
  const cid = await companyOf(v)
  const account = await bankAccount(Number(v.account_id) || 0)
  const book = await parsedFile('bank', String(v.data_base64 || ''), () => parseBankBook(String(v.data_base64 || '')))
  const entries = await booksRead(`bank:${cid}:${Number(account.id)}:${book.from}:${book.to}`, () => bankEntries(cid, Number(account.id), book.from, book.to))
  const mapped: Mapped = await resolveNames([
    ...new Set([...book.lines.map((l) => l.party), ...book.lines.flatMap((l) => (l.details || []).map((d) => d.name))].filter(Boolean))
  ])
  const used = new Set<number>()
  const rows: Row[] = []
  const short = (b: BookEntry): Row => ({ id: b.id, code: b.code, vch_type: b.vch_type, vch_no: b.vch_no, date: b.date, dir: b.dir, amount: b.amount, payment_id: b.payment_id, party: b.counter[0]?.name || '', counter: b.counter, narration: b.narration })
  const tal = (t: BankLine): Row => ({ ...t })

  // What the desk has already said is the same entry comes first.
  const linked = await linksFor(cid, `bank:${Number(account.id)}`)
  const handled = new Set<string>()
  // SEVERAL TALLY LINES REMEMBERED AS ONE VOUCHER. Tally paid ₹2,82,984 into
  // a parking ledger and took ₹6,696 back; the LC here paid its ₹2,76,288 in
  // one (PAY/18). Lines linked to the same voucher are read together: their
  // net is what is compared.
  const byEntry = new Map<number, BankLine[]>()
  for (const t of book.lines) {
    const id = linked.get(t.key)
    if (!id) continue
    if (!byEntry.has(id)) byEntry.set(id, [])
    ;(byEntry.get(id) as BankLine[]).push(t)
  }
  for (const [id, ts] of byEntry) {
    if (ts.length < 2) continue
    const b = entries.find((e) => e.id === id && !used.has(e.id))
    if (!b) continue
    used.add(b.id)
    const sign = (dir: string, amt: number): number => (dir === 'in' ? amt : -amt)
    const net = round2(ts.reduce((s, t) => s + sign(t.dir, t.amount), 0))
    const ok = Math.abs(net - sign(b.dir, b.amount)) <= 1
    // Only the main line answers for the voucher's date. The lines that came
    // back (Receipt 477's ₹6,696 refunded ten days after PAY/18) are on their
    // own days by nature — comparing those to the voucher flagged a match as
    // "Date not matching".
    const main = ts.reduce((a, t) => (t.amount > a.amount ? t : a), ts[0])
    for (const t of ts) {
      handled.add(t.key)
      const diffs: Row[] = []
      if (t === main && b.date !== t.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
      if (!ok) diffs.push({ field: 'amount', tally: Math.abs(net), books: b.amount, diff: round2(Math.abs(net) - b.amount) })
      rows.push({
        key: t.key,
        status: t.cancelled ? 'cancelled_here' : diffs.length ? 'mismatch' : 'matched',
        tally: tal(t),
        books: short(b),
        diffs: t.cancelled ? [] : diffs,
        linked: true,
        net_of: ts.length
      })
    }
  }
  for (const t of book.lines) {
    if (handled.has(t.key)) continue
    const id = linked.get(t.key)
    const b = id ? entries.find((e) => e.id === id && !used.has(e.id)) : undefined
    if (!b) continue
    used.add(b.id)
    handled.add(t.key)
    const diffs: Row[] = []
    if (b.date !== t.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
    if (Math.abs(b.amount - t.amount) > 1 || b.dir !== t.dir) diffs.push({ field: 'amount', tally: t.amount, books: b.amount, diff: round2(t.amount - b.amount) })
    rows.push({ key: t.key, status: t.cancelled ? 'cancelled_here' : diffs.length ? 'mismatch' : 'matched', tally: tal(t), books: short(b), diffs: t.cancelled ? [] : diffs, linked: true })
  }

  // Booked from this book before: found by the number written into its narration.
  const rest: BankLine[] = []
  for (const t of book.lines) {
    if (handled.has(t.key)) continue
    const head = narrationHead(book.bank, t)
    const b = entries.find((e) => !used.has(e.id) && (e.narration === head || e.narration.startsWith(`${head} (`)))
    if (b) {
      used.add(b.id)
      const diffs: Row[] = []
      if (t.cancelled) {
        rows.push({ key: t.key, status: 'cancelled_here', tally: tal(t), books: short(b), diffs })
        continue
      }
      if (b.date !== t.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
      if (Math.abs(b.amount - t.amount) > 1 || b.dir !== t.dir) diffs.push({ field: 'amount', tally: t.amount, books: b.amount, diff: round2(t.amount - b.amount) })
      rows.push({ key: t.key, status: diffs.length ? 'mismatch' : 'matched', tally: tal(t), books: short(b), diffs })
    } else rest.push(t)
  }
  // Then by what it is: direction, amount, day and party. Closest first, so
  // one voucher here answers for one line of the book at most.
  // The same voucher number goes first, then the same party, then the nearest day.
  const pairs: { t: BankLine; b: BookEntry; party: boolean; gap: number; num: boolean }[] = []
  for (const t of rest) {
    if (t.cancelled) continue
    for (const b of entries) {
      if (used.has(b.id) || b.dir !== t.dir || Math.abs(b.amount - t.amount) > 1) continue
      const gap = daysApart(b.date, t.date)
      const party = samePartyLine(t, b, mapped)
      const num = sameNum(t.vch_no, b.vch_no)
      if (gap > (num ? NUM_DAYS : party ? NEAR_DAYS : 3)) continue
      pairs.push({ t, b, party, gap, num })
    }
  }
  pairs.sort((x, y) => Number(y.num) - Number(x.num) || Number(y.party) - Number(x.party) || x.gap - y.gap)
  const found = new Map<string, { b: BookEntry; party: boolean }>()
  for (const p of pairs) {
    if (found.has(p.t.key) || used.has(p.b.id)) continue
    used.add(p.b.id)
    found.set(p.t.key, { b: p.b, party: p.party })
  }
  for (const t of rest) {
    if (t.cancelled) {
      rows.push({ key: t.key, status: 'cancelled', tally: tal(t), books: null, diffs: [] })
      continue
    }
    const f = found.get(t.key)
    if (!f) {
      rows.push({ key: t.key, status: 'missing_here', tally: tal(t), books: null, diffs: [] })
      continue
    }
    const diffs: Row[] = []
    if (f.b.date !== t.date) diffs.push({ field: 'date', tally: t.date, books: f.b.date })
    if (!f.party) diffs.push({ field: 'party', tally: t.party, books: f.b.counter.map((c) => c.name).join(', ') })
    rows.push({ key: t.key, status: f.party ? (diffs.length ? 'mismatch' : 'matched') : 'possible', tally: tal(t), books: short(f.b), diffs })
  }
  for (const b of entries) {
    if (used.has(b.id) || b.date < book.from || b.date > book.to) continue
    rows.push({ key: `BOOKS|${b.id}`, status: 'missing_tally', tally: null, books: short(b), diffs: [] })
  }
  // Paired, but numbered differently on the two sides — said, not counted as a
  // mismatch (the app's own vouchers carry their own numbers).
  for (const r of rows) {
    if (!r.tally || !r.books) continue
    if (vchNum(r.tally.vch_no) && vchNum(r.books.vch_no)) r.same_no = sameNum(r.tally.vch_no, r.books.vch_no)
  }

  // THE BANK'S OWN STATEMENT, when there is one: each line of Tally or these
  // books finds the statement line of the same direction and amount nearest
  // its date (within five days); what is left on the statement is in neither.
  const statement = await readStatement(String(v.statement_base64 || ''), String(v.statement_name || ''))
  if (statement) {
    const cand: { r: Row; i: number; gap: number }[] = []
    statement.lines.forEach((s, i) => {
      for (const r of rows) {
        const lead = r.tally || r.books
        if (!lead || lead.dir !== s.dir || Math.abs(n(lead.amount) - s.amount) > 1) continue
        const gap = Math.min(r.tally ? daysApart(r.tally.date, s.date) : 99, r.books ? daysApart(r.books.date, s.date) : 99)
        if (gap <= 5) cand.push({ r, i, gap })
      }
    })
    cand.sort((a, b) => a.gap - b.gap)
    const takenLine = new Set<number>()
    for (const c of cand) {
      if (takenLine.has(c.i) || c.r.stmt) continue
      takenLine.add(c.i)
      const s = statement.lines[c.i]
      c.r.stmt = { date: s.date, narration: s.narration, amount: s.amount }
    }
    // A line dated outside the statement's own days cannot be looked for on it.
    for (const r of rows) {
      const lead = r.tally || r.books
      if (!r.stmt && lead && (lead.date < statement.from || lead.date > statement.to)) r.stmt_out = true
    }
    statement.lines.forEach((s, i) => {
      if (takenLine.has(i) || s.date < book.from || s.date > book.to) return
      rows.push({ key: `STMT|${i}`, status: 'statement_only', tally: null, books: null, stmt: { date: s.date, narration: s.narration, amount: s.amount, dir: s.dir }, diffs: [] })
    })
  }
  // NEAR PAIRS — one payment, two figures: Tally has what the bank actually
  // took (₹1,25,755.00), these books what was worked out (₹1,25,753.43). Same
  // direction, within three days, apart by no more than ₹500 or 1%. Offered,
  // never assumed: the desk settles it with one press (settleTallyBankDifference).
  const nearCand: { m: Row; e: Row; gap: number; d: number }[] = []
  for (const m of rows) {
    if (m.status !== 'missing_here' || !m.tally || m.tally.multi) continue
    for (const e of rows) {
      if (e.status !== 'missing_tally' || !e.books || e.books.dir !== m.tally.dir) continue
      const d = Math.abs(n(m.tally.amount) - n(e.books.amount))
      const gap = daysApart(m.tally.date, e.books.date)
      if (d < 0.005 || d > Math.max(500, n(m.tally.amount) * 0.01) || gap > 3) continue
      nearCand.push({ m, e, gap, d })
    }
  }
  nearCand.sort((a, b) => a.gap - b.gap || a.d - b.d)
  for (const p of nearCand) {
    if (p.m.near || p.e.near_of) continue
    p.m.near = { id: p.e.books.id, code: p.e.books.code, date: p.e.books.date, amount: p.e.books.amount, diff: round2(n(p.m.tally.amount) - n(p.e.books.amount)) }
    p.e.near_of = { key: p.m.key, vch_type: p.m.tally.vch_type, vch_no: p.m.tally.vch_no, amount: p.m.tally.amount }
  }
  explainBank(rows, !!statement)
  return { statement, book, account, mapped, rows, entries }
}

function explainBank(rows: Row[], hasStatement = false): void {
  for (const r of rows) {
    const t = r.tally as Row | null
    const b = r.books as Row | null
    const st = r.stmt as Row | null
    const say: string[] = []
    let fix = ''
    const way = (d: string): string => (d === 'in' ? 'received into the bank' : 'paid out of the bank')
    const tName = t ? `${t.vch_type} No. ${t.vch_no}` : ''
    const bName = b ? `${b.code || b.vch_type}${b.vch_no ? ` · ${b.vch_no}` : ''}` : ''
    if (r.status === 'missing_here' && t && r.near) {
      const nr = r.near as Row
      say.push(
        `In Tally on ${dmy(t.date)}: ${inr(t.amount)} ${way(t.dir)}${t.party ? `, ${t.dir === 'in' ? 'from' : 'to'} ${t.party}` : ''} (${tName}). ` +
          `It looks like ${String(nr.code || 'a voucher')} here on ${dmy(nr.date)} for ${inr(nr.amount)} — the same ${t.dir === 'in' ? 'receipt' : 'payment'}, ${inr(Math.abs(n(nr.diff)))} ${n(nr.diff) > 0 ? 'more' : 'less'} in Tally.`
      )
      fix = `If it is the same, press "Same — take Tally's figure": it is linked, and ${String(nr.code || 'the voucher')} takes the bank's ${inr(t.amount)}, the ${inr(Math.abs(n(nr.diff)))} going to its own ledger. The bill or LC it came from keeps its worked-out figure.`
    } else if (r.status === 'missing_here' && t) {
      say.push(`In Tally on ${dmy(t.date)}: ${inr(t.amount)} ${way(t.dir)}${t.party ? `, ${t.dir === 'in' ? 'from' : 'to'} ${t.party}` : ''} (${tName}) — not in this bank here.`)
      if (t.multi && Array.isArray(t.details) && t.details.length) {
        say.push(`Its ledgers: ${(t.details as Row[]).map((d) => `${d.name} ${inr(d.amount)} ${d.side === 'dr' ? 'Dr' : 'Cr'}`).join(', ')}.`)
      }
      fix = t.multi
        ? detailsReady(t as unknown as BankLine)
          ? 'Book it from Tally — every ledger under it is in the detailed book, and it posts with all of them.'
          : 'Tally shows it "as per details" — a voucher of several ledgers. Export the bank book from Tally in Detailed view (Alt+F1) so its ledgers come with it, or enter it here by hand.'
        : `Book it from Tally — it posts as a ${t.dir === 'in' ? 'RECEIPT' : 'PAYMENT'} (or CONTRA, between banks and cash) on this bank under Tally's number.`
    } else if (r.status === 'possible' && t && b) {
      // WHY "POSSIBLE": the money and the day agree, the ledger does not. Said
      // in that order, so what to look at is the one thing that differs.
      const tLedgers =
        t.multi && Array.isArray(t.details) && t.details.length
          ? (t.details as Row[]).map((d) => `${d.name} ${inr(d.amount)}`).join(', ')
          : String(t.party || 'no ledger')
      const sameDay = t.date === b.date
      say.push(
        `Same amount (${inr(t.amount)} ${way(t.dir)})${sameDay ? ` and same day (${dmy(t.date)})` : `, ${dmy(t.date)} in Tally and ${dmy(b.date)} here`} — but not the same ledger.`
      )
      say.push(`Tally ${tName}: ${tLedgers}. Here ${bName}: ${b.party || 'no ledger'}.`)
      // "(as per details)" is not a ledger — Tally's word for a voucher of
      // several — so it is never offered for mapping; nor is a party this
      // voucher was posted by a document (an LC, a discounted bill) under its
      // own ledger name. The same entry is remembered instead.
      const detailed = !!t.multi || /as per details/i.test(String(t.party || ''))
      fix = detailed
        ? `If it is the same entry, press "Same entry — remember" — it then reads as matched in every check. If it is a different one, book it and tick "Book anyway".`
        : `If it is the same entry, press "Same entry — remember", or map "${t.party}" to ${b.party || 'that ledger'} (Book from Tally → Ledgers) and check again. If it is a different one, book it and tick "Book anyway".`
    } else if (r.status === 'mismatch' && t && b) {
      for (const d of r.diffs as Row[]) {
        if (d.field === 'date') say.push(`Dated ${dmy(d.tally)} in Tally, ${dmy(d.books)} here (${bName}).`)
        if (d.field === 'amount') say.push(`${inr(d.tally)} in Tally, ${inr(d.books)} here.`)
        if (d.field === 'party') say.push(`${t.party} in Tally, ${d.books} here.`)
      }
      fix = (r.diffs as Row[]).every((d) => d.field === 'date') ? 'Correct the date on whichever side is wrong — the bank’s own statement says which.' : 'Open the voucher here and correct it to Tally — or correct Tally.'
      // BOOKED FROM TALLY, THEN REDATED IN TALLY. Tally numbers vouchers in date
      // order, so moving one (19-10 → 23-10) also renumbers it (No. 186 → 189):
      // the same payment, which is why both the date and the number differ.
      const dd = (r.diffs as Row[]).find((d) => d.field === 'date')
      if (dd && r.same_no === false && String(b.narration || '').startsWith('Imported from Tally')) {
        say.push(
          `${String(b.code || 'It')} was booked from Tally as No. ${String(b.vch_no)} dated ${dmy(dd.books)}; Tally now has it on ${dmy(dd.tally)} as No. ${String(t.vch_no)} — its date was changed in Tally after it was booked here, and Tally renumbers vouchers by date.`
        )
        if ((r.diffs as Row[]).length === 1)
          fix = `If ${dmy(dd.tally)} is right, press "Use Tally's date". If ${dmy(dd.books)} is right, put the date back in Tally — or press "Our date is right".`
      }
    } else if (r.status === 'missing_tally' && b && r.near_of) {
      const no = r.near_of as Row
      say.push(`In this bank here (${bName}, ${dmy(b.date)}, ${inr(b.amount)} ${way(b.dir)}) — Tally has it as ${String(no.vch_type || '')} No. ${String(no.vch_no || '')} for ${inr(no.amount)}.`)
      fix = `Settle it from Tally's line above ("Same — take Tally's figure").`
    } else if (r.status === 'missing_tally' && b) {
      say.push(`In this bank here (${bName}, ${dmy(b.date)}${b.party ? `, ${b.party}` : ''}, ${inr(b.amount)} ${way(b.dir)}) but not in Tally's book for the period.`)
      fix = 'Enter it in Tally — or, if it never went through the bank, correct it here.'
    } else if (r.status === 'cancelled_here' && t && b) {
      say.push(`Tally shows ${tName} cancelled, but these books still carry ${bName}.`)
      fix = 'Delete it here if the cancellation in Tally is right.'
    } else if (r.status === 'cancelled') say.push('Cancelled in Tally, and not in these books either.')
    else if (r.status === 'statement_only' && st) {
      say.push(`On the bank's statement on ${dmy(st.date)}: ${inr(st.amount)} ${way(st.dir)}${st.narration ? ` (${st.narration})` : ''} — in neither Tally nor these books.`)
      fix = 'Find what it was — bank charges, interest, a transfer, a cheque — and enter it in Tally and here.'
    }
    // What the bank itself says settles which side is right.
    if (hasStatement && r.status !== 'statement_only' && r.status !== 'cancelled') {
      const lead = t || b
      if (st) {
        const dd = ((r.diffs as Row[]) || []).find((d) => d.field === 'date')
        if (dd && t && b) {
          const right = st.date === t.date ? 'Tally is right' : st.date === b.date ? 'these books are right' : 'neither date is the bank’s'
          say.push(`The bank's statement has it on ${dmy(st.date)} — ${right}.`)
        } else if (r.status === 'missing_here') say.push(`The bank's statement shows it on ${dmy(st.date)}${st.narration ? ` (${st.narration})` : ''} — it did go through the bank.`)
        else if (r.status === 'missing_tally') say.push(`The bank's statement shows it on ${dmy(st.date)} — Tally is the one missing it.`)
      } else if (lead && !r.stmt_out && (r.status === 'missing_here' || r.status === 'missing_tally')) {
        say.push("It is not on the bank's statement either — check it ever went through the bank before booking or entering it.")
      }
    }
    r.explain = say
    r.fix = fix
  }
}

/** Which bank ledger a book is most likely for — by its account number, then its name. */
async function suggestBank(bank: string): Promise<Row | null> {
  const banks = toPlain(await getClient().execute({ sql: `SELECT id, name, acc_group FROM ledger_accounts WHERE acc_group IN ('Bank Accounts', 'Bank OD A/c') ORDER BY name`, args: [] }))
  const m = (await resolveNames([bank])).get(tallyKey(bank))
  if (m && banks.some((b) => Number(b.id) === m.account_id)) return banks.find((b) => Number(b.id) === m.account_id) || null
  const dg = acctDigits(bank)
  if (dg) {
    const hit = banks.find((b) => String(b.name).replace(/\s+/g, '').includes(dg) || acctDigits(String(b.name)).endsWith(dg.slice(-6)))
    if (hit) return hit
  }
  return banks.find((b) => companyKey(String(b.name)) === companyKey(bank)) || null
}

export async function suggestTallyBank(v: { data_base64: string }): Promise<Row> {
  const book = await parsedFile('bank', String(v.data_base64 || ''), () => parseBankBook(String(v.data_base64 || '')))
  const s = await suggestBank(book.bank)
  return { bank: book.bank, period: book.period, suggested: s ? { id: Number(s.id), name: String(s.name) } : null }
}

/**
 * The journal booked from Tally that takes a copy's payment on from a parking
 * ledger the document's own voucher never touches: same amount, within a
 * week, on the other side of that ledger. Null when the copy's ledger is the
 * document's own (or kin to it), or no such journal is booked.
 */
async function clearingJournal(cid: number, bankId: number, copyId: number, ownId: number, date: string): Promise<Row | null> {
  const linesOf = async (id: number): Promise<Row[]> =>
    toPlain(
      await getClient().execute({
        sql: `SELECT jl.account_id, a.name, a.acc_group, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?`,
        args: [id]
      })
    )
  const bankish = (l: Row): boolean => Number(l.account_id) === bankId || /^bank (accounts|od)/i.test(String(l.acc_group || ''))
  const word = (v: string): string =>
    String(v || '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)[0] || ''
  const copyOther = (await linesOf(copyId)).filter((l) => !bankish(l))
  if (copyOther.length !== 1) return null
  const via = copyOther[0]
  const own = (await linesOf(ownId)).filter((l) => !bankish(l))
  if (own.some((l) => Number(l.account_id) === Number(via.account_id) || word(String(l.name)) === word(String(via.name)))) return null
  const side = n(via.dr) > 0 ? 'cr' : 'dr'
  const amt = n(via.dr) || n(via.cr)
  const r = await getClient().execute({
    sql: `SELECT je.id, je.vch_no, je.entry_date, (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
            FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
           WHERE je.company_id = ? AND UPPER(je.vch_type) = 'JOURNAL' AND je.narration LIKE 'Imported from Tally%'
             AND jl.account_id = ? AND ABS(jl.${side} - ?) <= 1
             AND julianday(substr(je.entry_date, 1, 10)) BETWEEN julianday(?) - 7 AND julianday(?) + 7
           ORDER BY ABS(julianday(substr(je.entry_date, 1, 10)) - julianday(?)) LIMIT 1`,
    args: [cid, Number(via.account_id), amt, date, date, date]
  })
  const j = r.rows[0] as unknown as Row | undefined
  if (!j) return null
  return { id: Number(j.id), code: String(j.code || 'the journal'), vch_no: String(j.vch_no || ''), date: String(j.entry_date).slice(0, 10), via: String(via.name) }
}

async function linesOfEntry(id: number): Promise<Row[]> {
  return toPlain(
    await getClient().execute({
      sql: `SELECT jl.account_id, a.name, a.acc_group, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?`,
      args: [id]
    })
  )
}

/** The journal booked from Tally that moves `amt` on out of a parking ledger. */
async function clearingBy(cid: number, accountId: number, side: 'dr' | 'cr', amt: number, date: string, via: string): Promise<Row | null> {
  const r = await getClient().execute({
    sql: `SELECT je.id, je.vch_no, je.entry_date, (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
            FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
           WHERE je.company_id = ? AND UPPER(je.vch_type) = 'JOURNAL' AND je.narration LIKE 'Imported from Tally%'
             AND jl.account_id = ? AND ABS(jl.${side} - ?) <= 1
             AND julianday(substr(je.entry_date, 1, 10)) BETWEEN julianday(?) - 14 AND julianday(?) + 14
           ORDER BY ABS(julianday(substr(je.entry_date, 1, 10)) - julianday(?)) LIMIT 1`,
    args: [cid, accountId, amt, date, date, date]
  })
  const j = r.rows[0] as unknown as Row | undefined
  if (!j) return null
  return { id: Number(j.id), code: String(j.code || 'the journal'), vch_no: String(j.vch_no || ''), date: String(j.entry_date).slice(0, 10), via }
}

export async function checkTallyBank(v: {
  account_id: number
  data_base64: string
  file_name?: string
  company_id?: number
  statement_base64?: string
  statement_name?: string
}): Promise<Row> {
  const cid = await companyOf(v)
  const { book, account, rows, statement } = await reconcileBank({ ...v, company_id: cid })
  const { ownedVoucherIds } = await import('./voucherOwnership')
  const owned = await ownedVoucherIds()
  const { bdMovableEntryIds } = await import('./tallyRegisters')
  const bdMovable = await bdMovableEntryIds()
  for (const r of rows) {
    r.bookable =
      (r.status === 'missing_here' || r.status === 'possible') && !!r.tally && !r.tally.cancelled && (!r.tally.multi || detailsReady(r.tally as BankLine))
    if (r.status === 'mismatch' && r.books?.id && (r.diffs as Row[]).length === 1 && r.diffs[0].field === 'date') {
      r.redate = owned.has(Number(r.books.id)) && !bdMovable.has(Number(r.books.id)) ? 'owned' : 'yes'
    }
  }

  // THE SAME PAYMENT IN THE BOOKS TWICE. A Tally line booked from Tally
  // (a plain payment) and, later, the same payment entered on its own
  // document — a discounted bill's repayment, an LC's — which posts a voucher
  // of its own. The Tally line matches the booked copy, and the document's
  // voucher is left "not in Tally". Same way, same amount, within three days:
  // say on both that one of them is a copy, and which to take back.
  const fromTally = (b: Row | null | undefined): boolean => /^imported from tally/i.test(String(b?.narration || ''))
  const extra = rows.filter((r) => r.status === 'missing_tally' && r.books?.id && owned.has(Number(r.books.id)) && !fromTally(r.books))
  const takenCopy = new Set<string>()
  // THE BANK'S OWN CHARGES. Tally books an LC's repayment as the whole debit —
  // LC 88,00,000 and the bank's ₹1,180 — where the LC here may hold the
  // principal alone (LC-10: PAY/24 88,00,000 against Tally's 88,01,180). A
  // copy up to ₹10,000 (and a tenth of a percent) MORE than the document's
  // voucher is the same payment with the charges on it; the exact amount is
  // still preferred when both exist.
  const overBy = (copy: number, own: number): number => round2(copy - own)
  const chargesFit = (copy: number, own: number): boolean => {
    const d = overBy(copy, own)
    return Math.abs(d) <= 1 || (d > 0 && d <= Math.min(10000, own * 0.001 + 1))
  }
  // TALLY'S PAYMENT INTO A PARKING LEDGER, LESS WHAT CAME BACK, FOR THE
  // DOCUMENT'S ONE. LC 027LC03262250002: Tally paid ₹2,82,984 into the RTGS
  // NEFT parking account (PAY/273), took ₹6,696 back (RCP/297) and journaled
  // ₹2,76,288 on to interest (JV/477); the LC here paid its ₹2,76,288 in one
  // (PAY/18). The three booked from Tally are the copy, together.
  const nettedParking = async (x: Row): Promise<void> => {
    const xb = x.books as Row
    const xLines = (await linesOfEntry(Number(xb.id))).filter((l) => Number(l.account_id) !== Number(account.id))
    const word = (v: string): string => String(v || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)[0] || ''
    const pool: { r: Row; via: Row }[] = []
    for (const r of rows) {
      if (!(r.status === 'matched' || r.status === 'mismatch') || takenCopy.has(String(r.key)) || !fromTally(r.books) || !r.books?.id) continue
      if (daysApart(String(r.books.date), String(xb.date)) > 14) continue
      const other = (await linesOfEntry(Number(r.books.id))).filter((l) => Number(l.account_id) !== Number(account.id))
      if (other.length !== 1) continue
      const via = other[0]
      if (xLines.some((l) => Number(l.account_id) === Number(via.account_id) || word(String(l.name)) === word(String(via.name)))) continue
      pool.push({ r, via })
    }
    const sign = (dir: string, amt: number): number => (dir === 'in' ? amt : -amt)
    const want = sign(String(xb.dir), n(xb.amount))
    for (const o of pool.filter((p) => p.r.books.dir === xb.dir)) {
      const back = pool.filter((p) => p !== o && p.r.books.dir !== xb.dir && Number(p.via.account_id) === Number(o.via.account_id))
      // The payment alone, or less one or two lines that came back.
      const tries: { r: Row; via: Row }[][] = [[]]
      for (const a of back) tries.push([a])
      for (let i = 0; i < back.length; i++) for (let j = i + 1; j < back.length; j++) tries.push([back[i], back[j]])
      for (const ins of tries) {
        if (!ins.length) continue
        const net = round2(sign(o.r.books.dir, n(o.r.books.amount)) + ins.reduce((s, p) => s + sign(p.r.books.dir, n(p.r.books.amount)), 0))
        if (Math.abs(net - want) > 1) continue
        const chain = await clearingBy(cid, Number(o.via.account_id), n(o.via.dr) > 0 ? 'cr' : 'dr', n(xb.amount), String(xb.date), String(o.via.name))
        const own = String(xb.code || 'the document voucher')
        const copies = [o, ...ins]
        for (const p of copies) {
          takenCopy.add(String(p.r.key))
          p.r.duplicate = { id: Number(xb.id), code: own }
          p.r.explain = [...((p.r.explain as string[]) || []), `${String(p.r.books.code)} was booked from Tally, and ${own} — posted by its own document — already carries this money.`]
          p.r.fix = `Reverse the copies from ${own}'s row — ${own} stays.`
        }
        const codes = copies.map((p) => String(p.r.books.code))
        x.duplicate_of = {
          id: Number(o.r.books.id),
          code: codes[0],
          extra: ins.map((p) => ({ id: Number(p.r.books.id), code: String(p.r.books.code) })),
          links: copies.map((p) => String(p.r.key)),
          ...(chain ? { chain } : {})
        }
        x.explain = [
          ...((x.explain as string[]) || []),
          `Tally paid ${inr(n(o.r.books.amount))} into ${String(o.via.name)} (${codes[0]}) and took ${inr(ins.reduce((s, p) => s + n(p.r.books.amount), 0))} back (${codes.slice(1).join(', ')})${chain ? `, then journaled it on (${chain.code}, No. ${chain.vch_no})` : ''} — all booked from Tally. Net, that is ${own}'s ${inr(n(xb.amount))}: the same money twice.`
        ]
        x.fix = `Reverse ${[...codes, ...(chain ? [chain.code] : [])].join(', ')} together. ${own} stays, and stands for Tally's ${copies.length} bank lines${chain ? ` and journal No. ${chain.vch_no}` : ''}.`
        return
      }
    }
  }
  for (const x of extra) {
    const xb = x.books as Row
    const twin = rows
      .filter(
        (r) =>
          (r.status === 'matched' || r.status === 'mismatch') &&
          !takenCopy.has(String(r.key)) &&
          fromTally(r.books) &&
          r.books.dir === xb.dir &&
          chargesFit(n(r.books.amount), n(xb.amount)) &&
          daysApart(String(r.books.date), String(xb.date)) <= 3
      )
      .sort(
        (a, b) =>
          Math.abs(overBy(n(a.books.amount), n(xb.amount))) - Math.abs(overBy(n(b.books.amount), n(xb.amount))) ||
          daysApart(String(a.books.date), String(xb.date)) - daysApart(String(b.books.date), String(xb.date))
      )[0]
    if (!twin) {
      await nettedParking(x)
      continue
    }
    takenCopy.add(String(twin.key))
    const copy = String(twin.books.code || 'the voucher booked from Tally')
    const own = String(xb.code || 'the document voucher')
    const tName = `${String(twin.tally?.vch_type || '')} No. ${String(twin.tally?.vch_no || '')}`.trim()
    x.duplicate_of = { id: Number(twin.books.id), code: copy }
    twin.duplicate = { id: Number(xb.id), code: own }
    x.explain = [
      ...((x.explain as string[]) || []),
      `This is very likely Tally's ${tName}, which was also booked from Tally as ${copy} — the same ${inr(n(xb.amount))} is in these books twice.`
    ]
    x.fix = `Reverse ${copy} (the copy booked from Tally, on ${tName}). This one, ${own}, then matches Tally on the next check.`
    const extraCharges = overBy(n(twin.books.amount), n(xb.amount))
    if (extraCharges > 1) {
      x.duplicate_of.charges = extraCharges
      ;(x.explain as string[]).push(
        `Tally's ${inr(n(twin.books.amount))} carries ${inr(extraCharges)} of bank charges that ${own} (${inr(n(xb.amount))}) does not.`
      )
      x.fix = `Reverse ${copy} (the copy booked from Tally, on ${tName}). Then add the ${inr(extraCharges)} as Bank charges on the LC behind ${own} — ⋮ → Edit preclosure when the LC is closed, Edit on the repayment when it is not — and it matches Tally's ${inr(n(twin.books.amount))} on the next check.`
    }
    // TALLY'S TWO STEPS FOR THE DOCUMENT'S ONE. Tally pays into a parking or
    // transfer ledger, then journals it on (PAY/467: HDFC -> RTGS NEFT parking;
    // JV/490: parking -> INTEREST (LC)) where the LC here paid its interest in
    // one voucher (PAY/36). Reversing the payment alone would leave the journal
    // — the parking ledger hanging, the interest twice. The journal booked
    // from Tally that clears the parking ledger goes back with it, and Tally's
    // journal is then remembered as this document's voucher.
    const chain = await clearingJournal(cid, Number(account.id), Number(twin.books.id), Number(xb.id), String(twin.books.date))
    if (chain) {
      x.duplicate_of.chain = chain
      ;(x.explain as string[]).push(
        `Tally pays it into ${chain.via} and moves it on by journal No. ${chain.vch_no} (${chain.code}, also booked from Tally) — ${own} does both in one voucher.`
      )
      x.fix = `Reverse ${copy} and ${chain.code} together (Tally's payment and the journal that clears ${chain.via}). ${own} stays, and stands for both Tally's ${tName} and journal No. ${chain.vch_no}.`
    }
    twin.explain = [
      ...((twin.explain as string[]) || []),
      `${copy} was booked from Tally, and ${own} — posted by its own document — is the same ${inr(n(xb.amount))} ${xb.dir === 'in' ? 'received' : 'paid'} on ${dmy(String(xb.date))}. One of the two is a copy.`
    ]
    twin.fix = `Reverse ${copy} here — ${own} stays, and matches this Tally line instead.`
  }
  // ONE ROW PER VOUCHER HERE. Where several Tally lines net into one voucher
  // (the parking chain: Payment 255 out, Receipt 477 back, against PAY/18) they
  // are one row, the main line leading and the rest under it as \`also\` — so
  // the check counts what the ledger counts (1093, not 1094). The money in the
  // tiles still adds every Tally line.
  {
    const lead = new Map<number, Row>()
    for (const r of rows) {
      if (!r.linked || n(r.net_of) < 2 || !r.books?.id || !r.tally) continue
      const cur = lead.get(Number(r.books.id))
      if (!cur || n(r.tally.amount) > n(cur.tally.amount)) lead.set(Number(r.books.id), r)
    }
    if (lead.size) {
      const keep: Row[] = []
      for (const r of rows) {
        const l = r.books?.id && r.linked && n(r.net_of) > 1 ? lead.get(Number(r.books.id)) : undefined
        if (!l || l === r) {
          keep.push(r)
          continue
        }
        l.also = [...((l.also as Row[]) || []), r.tally]
        // The worse of the two answers for the row.
        if (r.status !== 'matched' && l.status === 'matched') {
          l.status = r.status
          l.diffs = [...((l.diffs as Row[]) || []), ...((r.diffs as Row[]) || [])]
        }
      }
      rows.length = 0
      rows.push(...keep)
    }
  }
  const openHere = await bankBalanceBefore(cid, Number(account.id), book.from)
  const closeHere = await bankBalanceBefore(cid, Number(account.id), shiftDays(book.to, 1))
  const count = (s: string): number => rows.filter((r) => r.status === s).length
  const sum = (side: 'tally' | 'books', dir: 'in' | 'out'): number =>
    round2(
      rows
        .filter((r) => r[side] && r[side].dir === dir && (side === 'books' ? r.status !== 'cancelled_here' : !r.tally.cancelled))
        .filter((r) => side === 'tally' || (r.books.date >= book.from && r.books.date <= book.to))
        // ONE VOUCHER HERE COUNTS ONCE. Two Tally lines can meet one voucher —
        // the LC parking chain: Tally's ₹2,82,984 out and ₹6,696 back against
        // PAY/18's ₹2,76,288 — and adding the voucher per line put it in Money
        // out twice, a ₹2.70 L gap between two books that agree.
        .filter((r, i, all) => side === 'tally' || !r.books.id || all.findIndex((x) => x.books?.id === r.books.id) === i)
        .reduce((t, r) => t + n(r[side].amount), 0) +
      // The Tally lines folded under a row (see ONE ROW PER VOUCHER HERE).
      (side === 'tally'
        ? rows.reduce((t, r) => t + ((r.also as Row[]) || []).filter((a) => a.dir === dir && !a.cancelled).reduce((x, a) => x + n(a.amount), 0), 0)
        : 0)
    )
  // Lines the desk marked Checked (tally_checked) — out of "To look at".
  const checked = await checkedFor(cid, `bank:${Number(account.id)}`)
  for (const r of rows) if (checked.has(String(r.key))) r.checked = true
  const fileDigits = acctDigits(book.bank)
  const companyName = String(((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || '')
  return {
    file_name: String(v.file_name || ''),
    file_company: book.company,
    company: companyName,
    company_mismatch: !!book.company && !!companyName && !sameCompany(book.company, companyName),
    bank: book.bank,
    account: { id: Number(account.id), name: String(account.name), group: String(account.acc_group) },
    // The book's bank and the ledger picked do not share an account number.
    bank_mismatch: !!fileDigits && !String(account.name).replace(/\s+/g, '').includes(fileDigits) && companyKey(String(account.name)) !== companyKey(book.bank),
    period: book.period,
    from: book.from,
    to: book.to,
    balances: {
      tally: { opening: book.opening, in: sum('tally', 'in'), out: sum('tally', 'out'), closing: book.closing, closing_stated: book.closing_stated },
      // The bank's own figures. A positive running balance is money in the
      // bank — the same sign as a debit balance here.
      bank: statement
        ? {
            opening: statement.opening,
            in: round2(statement.lines.filter((s) => s.dir === 'in' && s.date >= book.from && s.date <= book.to).reduce((x, s) => x + s.amount, 0)),
            out: round2(statement.lines.filter((s) => s.dir === 'out' && s.date >= book.from && s.date <= book.to).reduce((x, s) => x + s.amount, 0)),
            closing: statement.closing,
            from: statement.from,
            to: statement.to
          }
        : null,
      books: { opening: openHere, in: sum('books', 'in'), out: sum('books', 'out'), closing: closeHere }
    },
    counts: {
      matched: count('matched'),
      mismatch: count('mismatch'),
      possible: count('possible'),
      missing_here: count('missing_here'),
      missing_tally: count('missing_tally'),
      cancelled: count('cancelled'),
      cancelled_here: count('cancelled_here'),
      statement_only: count('statement_only'),
      // Checked lines that would otherwise be To look at.
      checked: rows.filter((r) => r.checked && r.status !== 'matched' && r.status !== 'cancelled').length
    },
    statement: statement ? { name: statement.name, lines: statement.lines.length, from: statement.from, to: statement.to } : null,
    vch_types: [...new Set(book.lines.map((l) => l.vch_type))].sort(),
    rows: rows.sort(
      (a, b) =>
        String((a.tally || a.books || a.stmt).date).localeCompare(String((b.tally || b.books || b.stmt).date)) ||
        String(a.tally?.vch_no || a.books?.code || '').localeCompare(String(b.tally?.vch_no || b.books?.code || ''), undefined, { numeric: true })
    )
  }
}

// ---------------------------------------------------------------------------
// BOOKING WHAT IS MISSING — two lines: this bank and the ledger Tally names.
// ---------------------------------------------------------------------------

function bankGroupFor(name: string): string {
  const s = name.toUpperCase()
  if (/\bCASH\b/.test(s)) return 'Cash-in-Hand'
  if (/\bHDFC\b|\bBANK\b|\bSBI\b|\bICICI\b|\bAXIS\b|\bKOTAK\b|\bYES\b/.test(s) && /\d{6,}/.test(s)) return 'Bank Accounts'
  if (/\bTDS\b|\bTCS\b|\bGST\b/.test(s)) return 'Duties & Taxes'
  // Income first: "Interest Received on FD" is income, not an interest cost.
  if (/INCOME|RECEIVED|WRITTEN BACK/.test(s)) return 'Indirect Incomes'
  if (/SALARY|WAGES|EXP|CHARGES|INTEREST|FEE|WELFARE|RENT|REPAIR|TRAVEL|CONVEYANCE|ELECTRICITY|PENALTY|MEDICAL|LEGAL/.test(s)) return 'Indirect Expenses'
  return ''
}

function blockOf(t: BankLine, lim: { booksFrom: string; windowFrom: string }): string | null {
  if (t.multi && !detailsReady(t)) return 'Tally shows it "as per details" — export the detailed book (Alt+F1) or enter it by hand'
  if (!t.party && !t.multi) return 'Tally names no ledger on it'
  if (lim.booksFrom && t.date < lim.booksFrom) return `dated before these books begin (${lim.booksFrom})`
  if (lim.windowFrom && t.date < lim.windowFrom) return `dated before your working window (${lim.windowFrom})`
  if (!(t.amount > 0)) return 'it has no amount'
  return null
}

export async function previewTallyBankVouchers(v: { account_id: number; data_base64: string; keys: string[]; company_id?: number }): Promise<Row> {
  const cid = await companyOf(v)
  const { book, account, rows } = await reconcileBank({ ...v, company_id: cid })
  const lim = await saleDateLimits(cid)
  const statusOf = new Map(rows.filter((r) => r.tally).map((r) => [String(r.tally.key), r]))
  const wanted = new Set((v.keys || []).map(String))
  const picked = book.lines.filter((t) => wanted.has(t.key) && !t.cancelled && ['missing_here', 'possible'].includes(String(statusOf.get(t.key)?.status)))
  const roles = new Map<string, { name: string; role: 'party' | 'ledger'; count: number; amount: number }>()
  for (const t of picked) {
    if (t.multi) {
      if (!detailsReady(t)) continue
      for (const d of t.details || []) {
        const g = roles.get(d.party_key) || { name: d.name, role: 'ledger' as const, count: 0, amount: 0 }
        g.count += 1
        g.amount = round2(g.amount + d.amount)
        roles.set(d.party_key, g)
      }
      continue
    }
    if (!t.party) continue
    const g = roles.get(t.party_key) || { name: t.party, role: 'ledger' as const, count: 0, amount: 0 }
    g.count += 1
    g.amount = round2(g.amount + t.amount)
    roles.set(t.party_key, g)
  }
  const bankName = String(account.name)
  return {
    vouchers: picked.map((t) => {
      const r = statusOf.get(t.key) as Row
      return {
        key: t.key,
        vch_no: t.vch_no,
        ref_no: '',
        type: `${t.vch_type}`,
        date: t.date,
        party: t.party,
        amount: t.amount,
        lines: t.multi
          ? [
              // The detailed book's ledgers, then the bank for the whole amount.
              ...(t.details || []).map((d) => ({ name: d.name, key: d.party_key, dr: d.side === 'dr' ? d.amount : 0, cr: d.side === 'cr' ? d.amount : 0 })),
              t.dir === 'in'
                ? { name: bankName, key: null, fixed: bankName, dr: t.amount, cr: 0 }
                : { name: bankName, key: null, fixed: bankName, dr: 0, cr: t.amount }
            ]
          : t.dir === 'in'
            ? [
                { name: bankName, key: null, fixed: bankName, dr: t.amount, cr: 0 },
                { name: t.party, key: t.party_key, dr: 0, cr: t.amount }
              ]
            : [
                { name: t.party, key: t.party_key, dr: t.amount, cr: 0 },
                { name: bankName, key: null, fixed: bankName, dr: 0, cr: t.amount }
              ],
        round_off: 0,
        blocked: blockOf(t, lim),
        possible: r.status === 'possible' && r.books ? { code: r.books.code, type: r.books.vch_type, vch_no: r.books.vch_no, date: r.books.date, amount: r.books.amount, party: r.books.party } : null
      }
    }),
    ledgers: await mappingRows(roles, bankGroupFor)
  }
}

export async function postTallyBankVouchers(v: {
  account_id: number
  data_base64: string
  file_name?: string
  keys: string[]
  force_keys?: string[]
  company_id?: number
}): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> {
  const cid = await companyOf(v)
  const wanted = new Set((v.keys || []).map(String))
  if (!wanted.size) throw new Error('Pick the entries to book')
  const force = new Set((v.force_keys || []).map(String))
  const lim = await saleDateLimits(cid)
  const fileLabel = String(v.file_name || '').trim()
  const state = await reconcileBank({ ...v, company_id: cid })
  const bankName = String(state.account.name)
  const groups = new Map(
    toPlain(await getClient().execute('SELECT id, acc_group FROM ledger_accounts')).map((r) => [Number(r.id), String(r.acc_group || '')])
  )
  const created: { vch_no: string; id: number }[] = []
  const skipped: { vch_no: string; reason: string }[] = []
  for (const t of state.book.lines.filter((x) => wanted.has(x.key))) {
    const label = `${t.vch_type} ${t.vch_no}`
    const row = state.rows.find((r) => r.tally?.key === t.key)
    const status = String(row?.status || '')
    if (t.cancelled) {
      skipped.push({ vch_no: label, reason: 'Tally shows it cancelled' })
      continue
    }
    if (status !== 'missing_here' && status !== 'possible') {
      skipped.push({ vch_no: label, reason: `it is already in this bank here${row?.books?.code ? ` (${row.books.code})` : ''}` })
      continue
    }
    if (status === 'possible' && !force.has(t.key)) {
      skipped.push({ vch_no: label, reason: `it looks like ${row?.books?.code || 'an entry'} already here — tick "Book anyway" if it is a different one` })
      continue
    }
    const block = blockOf(t, lim)
    if (block) {
      skipped.push({ vch_no: label, reason: block })
      continue
    }
    // Every ledger the voucher names — one, or the detailed book's several.
    const legs = t.multi
      ? (t.details || []).map((d) => ({ name: d.name, key: d.party_key, amount: d.amount, side: d.side }))
      : [{ name: t.party, key: t.party_key, amount: t.amount, side: (t.dir === 'in' ? 'cr' : 'dr') as 'dr' | 'cr' }]
    const unmapped = legs.filter((g) => !state.mapped.get(g.key))
    if (unmapped.length) {
      skipped.push({ vch_no: label, reason: `not mapped yet: ${unmapped.map((g) => g.name).join(', ')}` })
      continue
    }
    const sameBank = legs.find((g) => state.mapped.get(g.key)?.account_id === Number(state.account.id))
    if (sameBank) {
      skipped.push({ vch_no: label, reason: `${sameBank.name} is mapped to this same bank` })
      continue
    }
    const m = state.mapped.get(legs[0].key)!
    const head = narrationHead(state.book.bank, t)
    const again = await getClient().execute({
      sql: "SELECT 1 FROM journal_entries WHERE company_id = ? AND (narration = ? OR narration LIKE ?) LIMIT 1",
      args: [cid, head, `${head.replace(/[%_]/g, '')} (%`]
    })
    if (again.rows.length) {
      skipped.push({ vch_no: label, reason: 'it was booked a moment ago' })
      continue
    }
    // Between two banks, or a bank and cash, it is a contra; otherwise money
    // in is a receipt and money out a payment.
    const contra = legs.every((g) => MONEY_GROUPS.includes(groups.get(state.mapped.get(g.key)!.account_id) || ''))
    void m
    const vchType: VoucherType = contra ? 'CONTRA' : t.dir === 'in' ? 'RECEIPT' : 'PAYMENT'
    const legLines = legs.map((g) => {
      const acc = state.mapped.get(g.key)!.account_name
      return g.side === 'dr' ? { account: acc, dr: g.amount } : { account: acc, cr: g.amount }
    })
    const lines =
      t.dir === 'in'
        ? [{ account: bankName, dr: t.amount }, ...legLines]
        : [...legLines, { account: bankName, cr: t.amount }]
    try {
      const res = await createVoucher({
        date: t.date,
        vchType,
        vchNo: t.vch_no,
        narration: `${head}${fileLabel ? ` (${fileLabel})` : ''}`,
        companyId: cid,
        lines
      })
      created.push({ vch_no: label, id: res.id })
    } catch (e) {
      skipped.push({ vch_no: label, reason: (e as Error).message })
    }
  }
  await recordTallyBatch({ company_id: cid, kind: 'bank', scope: `bank:${Number(state.account.id)}`, file_name: fileLabel, entry_ids: created.map((x) => x.id) })
  return { created, skipped }
}

// ---------------------------------------------------------------------------
// THIS COMPANY'S OWN BANK ACCOUNTS — the ones a bank book is checked against.
//
// Ledgers are shared across companies, so the plain list of everything under
// Bank Accounts shows another company's banks, the LC side's banks and the
// generic BANK A/C the software falls back to. The desk ticks which are this
// company's business accounts, once; until it has, the accounts this company
// has actually used (an opening, or postings) stand in.
// ---------------------------------------------------------------------------

let ownTable = false
async function ensureOwnBanks(): Promise<void> {
  if (ownTable) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS company_bank_accounts (
    company_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, account_id)
  )`)
  ownTable = true
}

/**
 * ONE PAYMENT, TWO FIGURES — settled to the bank's.
 *
 * The voucher here (a BD's interest, an LC's charges) was worked out; Tally
 * has what the bank actually took. The bank line takes Tally's figure, the
 * difference goes on its own line to the voucher's main ledger (the interest,
 * the charges), the narration says so, and the Tally line is linked — so the
 * bank ledger reads as Tally and the check shows Matched. The bill or LC that
 * posted it keeps its own worked-out figure; re-posting it from there puts the
 * worked-out figure back, and the check flags it again.
 */
export async function settleTallyBankDifference(v: {
  company_id?: number
  account_id: number
  tally_key: string
  entry_id: number
  tally_amount: number
  tally_label?: string
}): Promise<{ id: number; diff: number }> {
  const cid = await companyOf(v)
  return withDbTransaction(async () => {
    const c = getClient()
    const id = Number(v.entry_id) || 0
    const head = toPlain(await c.execute({ sql: 'SELECT id, company_id, narration FROM journal_entries WHERE id = ?', args: [id] }))[0]
    if (!head) throw new Error('That voucher no longer exists — check the file again')
    if (Number(head.company_id) !== cid) throw new Error('That voucher belongs to another company')
    const lines = toPlain(await c.execute({ sql: 'SELECT id, account_id, dr, cr FROM journal_lines WHERE entry_id = ? ORDER BY id', args: [id] }))
    const bank = lines.filter((l) => Number(l.account_id) === Number(v.account_id))
    if (bank.length !== 1) throw new Error('This voucher has the bank on more than one line — correct it by hand')
    const bl = bank[0]
    const out = n(bl.cr) > 0
    const was = round2(out ? n(bl.cr) : n(bl.dr))
    const want = round2(n(v.tally_amount))
    const diff = round2(want - was)
    if (want <= 0) throw new Error("Tally's figure is missing")
    if (Math.abs(diff) > Math.max(500, was * 0.01)) throw new Error(`${inr(want)} and ${inr(was)} are too far apart to be one payment — correct it by hand`)
    if (Math.abs(diff) >= 0.005) {
      // The ledger the money was for: the biggest line on the other side.
      const main = lines
        .filter((l) => l.id !== bl.id && (out ? n(l.dr) > 0 : n(l.cr) > 0))
        .sort((a, b) => (out ? n(b.dr) - n(a.dr) : n(b.cr) - n(a.cr)))[0]
      if (!main) throw new Error('This voucher has no ledger on the other side of the bank')
      await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
        repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`bank_difference:${id}:${Date.now()}`, id, JSON.stringify({ lines, narration: head.narration, tally_key: v.tally_key, tally_amount: want })]
      })
      await c.execute({ sql: `UPDATE journal_lines SET ${out ? 'cr' : 'dr'} = ? WHERE id = ?`, args: [want, Number(bl.id)] })
      // On its own line, so the worked-out figure stays readable beside it.
      const more = diff > 0
      const onMainSide = out ? (more ? 'dr' : 'cr') : more ? 'cr' : 'dr'
      await c.execute({
        sql: `INSERT INTO journal_lines (entry_id, account_id, ${onMainSide}) VALUES (?, ?, ?)`,
        args: [id, Number(main.account_id), Math.abs(diff)]
      })
      const note = ` — bank's figure ${inr(want)}${v.tally_label ? ` (Tally ${v.tally_label})` : ''}, ${inr(Math.abs(diff))} ${more ? 'more' : 'less'} than worked out`
      await c.execute({ sql: 'UPDATE journal_entries SET narration = ? WHERE id = ?', args: [`${String(head.narration || '')}${note}`, id] })
    }
    await saveTallyLink({ company_id: cid, scope: `bank:${Number(v.account_id)}`, tally_key: String(v.tally_key), entry_id: id })
    return { id, diff }
  })
}

export async function listCompanyBanks(v: { company_id?: number }): Promise<{ chosen: boolean; banks: Row[] }> {
  await ensureOwnBanks()
  const cid = await companyOf(v)
  const c = getClient()
  const own = new Set(
    (await c.execute({ sql: 'SELECT account_id FROM company_bank_accounts WHERE company_id = ?', args: [cid] })).rows.map((r) => Number(r.account_id))
  )
  const rows = toPlain(
    await c.execute({
      sql: `SELECT a.id, a.name, a.acc_group,
                   (SELECT COUNT(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = a.id AND je.company_id = ?) AS lines,
                   (SELECT o.dr - o.cr FROM ledger_openings o WHERE o.account_id = a.id AND o.company_id = ?) AS opening
              FROM ledger_accounts a
             WHERE a.acc_group IN ('Bank Accounts', 'Bank OD A/c')
             ORDER BY a.name`,
      args: [cid, cid]
    })
  )
  const banks: Row[] = []
  for (const r of rows) {
    const id = Number(r.id)
    const used = Number(r.lines) > 0 || Math.abs(n(r.opening)) > 0.004
    banks.push({
      id,
      name: String(r.name),
      acc_group: String(r.acc_group),
      business: own.has(id),
      used,
      generic: /^BANK A\/C$/i.test(String(r.name).trim()),
      lines: Number(r.lines) || 0,
      balance: used ? await bankBalanceBefore(cid, id, '9999-12-31') : 0
    })
  }
  return { chosen: own.size > 0, banks }
}

export async function setCompanyBank(v: { company_id?: number; account_id: number; on: boolean }): Promise<{ ok: true }> {
  await ensureOwnBanks()
  const cid = await companyOf(v)
  const id = Number(v.account_id) || 0
  await bankAccount(id)
  if (v.on) await getClient().execute({ sql: 'INSERT OR IGNORE INTO company_bank_accounts (company_id, account_id) VALUES (?, ?)', args: [cid, id] })
  else await getClient().execute({ sql: 'DELETE FROM company_bank_accounts WHERE company_id = ? AND account_id = ?', args: [cid, id] })
  return { ok: true }
}
