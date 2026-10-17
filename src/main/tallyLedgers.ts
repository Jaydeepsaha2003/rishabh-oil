import ExcelJS from 'exceljs'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { saveOpenings, getBooksFrom, setBooksFrom } from './openings'
import { createAccount } from './journal'
import { setAccountGroup } from './ledgerGroups'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}

function n(v: unknown): number {
  const x = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(x) ? x : 0
}

function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

/**
 * THE ONE THING TWO SYSTEMS CAN AGREE ON IS A NAME, ROUGHLY.
 *
 * Tally writes "Yes Bank 034827000000105" and this book writes "YES BANK
 * 034827000000105 A/C"; a human reads them as one ledger and a string compare
 * does not. So the key is the name with its case, its spacing and the noise
 * that differs between the two systems taken out — and nothing more clever
 * than that. An aggressive normaliser invents matches, and a wrong match on an
 * opening balance is a wrong balance sheet.
 */
export function ledgerKey(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/\bA\/C\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

export async function ensureTallyTables(): Promise<void> {
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS tally_ledgers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    dr REAL NOT NULL DEFAULT 0,
    cr REAL NOT NULL DEFAULT 0,
    account_id INTEGER,
    file_name TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  // Added after the first build of this, so an upload made before it keeps
  // working and simply has no date until the next one.
  for (const sql of [
    'ALTER TABLE tally_ledgers ADD COLUMN period_from TEXT',
    'ALTER TABLE tally_ledgers ADD COLUMN period_to TEXT'
  ]) {
    await c.execute(sql).catch(() => {})
  }
  await c
    .execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_ledgers_key ON tally_ledgers(company_id, name_key)')
    .catch(() => {})
}

/**
 * A TALLY TRIAL BALANCE, READ AS A LIST OF LEDGERS.
 *
 * The export is eight rows of letterhead, a header block, then one row a
 * ledger: name, opening debit, opening credit. The header is found rather than
 * counted — "Particulars" in the first column — because the letterhead is as
 * many lines as the company's address happens to be.
 *
 * A ledger with neither figure is kept. It has no opening balance, which is
 * not the same as not existing, and the point of this is the names.
 */
export function parseTallyRows(rows: string[][]): { name: string; dr: number; cr: number }[] {
  let start = -1
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[0] ?? '').trim().toLowerCase() === 'particulars') {
      start = i + 1
      break
    }
  }
  if (start < 0) start = 0
  const out: { name: string; dr: number; cr: number }[] = []
  const seen = new Set<string>()
  for (let i = start; i < rows.length; i++) {
    const name = String(rows[i]?.[0] ?? '').trim()
    if (!name) continue
    const low = name.toLowerCase()
    // Tally's own footer and its balancing plug are not ledgers of this book.
    if (low === 'grand total' || low === 'total') continue
    const key = ledgerKey(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ name, dr: round2(n(rows[i]?.[1])), cr: round2(n(rows[i]?.[2])) })
  }
  return out
}


const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
}

/**
 * THE DATE AN OPENING BALANCE IS AN OPENING BALANCE ON.
 *
 * A figure without one is not an opening balance, it is a number. Tally prints
 * the period on its own line above the table — "1-Jul-26 to 16-Sep-26" — and
 * the Opening Balance column is as at the FIRST of those two dates, so the
 * file has always carried the thing that makes its figures mean something.
 * This reads it rather than asking the user to retype a date the export is
 * already holding.
 *
 * Two-digit years are read as this century; Tally writes 26 for 2026, and a
 * trial balance from 1926 is not a case worth handling.
 */
export function parseTallyPeriod(rows: string[][]): { from: string; to: string } {
  const re = /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+to\s+(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/
  const iso = (d: string, mon: string, y: string): string => {
    const m = MONTHS[mon.toUpperCase()]
    if (!m) return ''
    const year = y.length <= 2 ? `20${y.padStart(2, '0')}` : y
    return `${year}-${m}-${d.padStart(2, '0')}`
  }
  for (const r of rows.slice(0, 30)) {
    for (const cell of r || []) {
      const hit = re.exec(String(cell || ''))
      if (!hit) continue
      const from = iso(hit[1], hit[2], hit[3])
      const to = iso(hit[4], hit[5], hit[6])
      if (from) return { from, to }
    }
  }
  return { from: '', to: '' }
}

async function sheetRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const rows: string[][] = []
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value as unknown
      cells.push(
        v == null
          ? ''
          : typeof v === 'object' && v !== null && 'result' in (v as Row)
            ? String((v as Row).result ?? '')
            : String(cell.text ?? '')
      )
    })
    rows.push(cells)
  })
  return rows
}

/**
 * Replace this company's Tally list with the one just uploaded.
 *
 * Replaced rather than merged: a trial balance is a statement of what Tally
 * holds today, and a ledger that has gone from it has gone. Mappings made by
 * hand survive, keyed by the name, so re-uploading next month does not undo an
 * afternoon of matching.
 */
export async function importTallyLedgers(v: {
  file_name?: string
  data_base64?: string
}): Promise<{ imported: number; file_name: string; opening_date: string }> {
  await ensureTallyTables()
  const c = getClient()
  const cid = getActiveCompanyId()
  const b64 = String(v.data_base64 || '')
  if (!b64) throw new Error('Choose the Tally trial balance file to upload')
  const rows = await sheetRows(Buffer.from(b64, 'base64'))
  const period = parseTallyPeriod(rows)
  const parsed = parseTallyRows(rows)
  if (!parsed.length) {
    throw new Error(
      'No ledgers found in that file — a Tally trial balance export has a Particulars column with one ledger a row'
    )
  }
  // What was mapped by hand last time, so it is not lost to the replace.
  const kept = new Map<string, number>()
  for (const r of toPlain(
    await c.execute({
      sql: 'SELECT name_key, account_id FROM tally_ledgers WHERE company_id = ? AND account_id IS NOT NULL',
      args: [cid]
    })
  )) {
    kept.set(String(r.name_key), n(r.account_id))
  }
  await c.execute({ sql: 'DELETE FROM tally_ledgers WHERE company_id = ?', args: [cid] })
  const fileName = String(v.file_name || 'tally.xlsx')
  for (const r of parsed) {
    const key = ledgerKey(r.name)
    await c.execute({
      sql: `INSERT INTO tally_ledgers (company_id, name, name_key, dr, cr, account_id, file_name, period_from, period_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cid, r.name, key, r.dr, r.cr, kept.get(key) ?? null, fileName, period.from || null, period.to || null]
    })
  }
  return { imported: parsed.length, file_name: fileName, opening_date: period.from }
}

/**
 * The two lists side by side: what Tally has, what this book has, and which of
 * them are the same ledger.
 *
 * Our side is scoped to the company by what the company has actually used — a
 * ledger account is shared across books, but a ledger with no posting and no
 * opening in THIS company is not this company's chart, and listing all 115
 * against every book would make the unmatched column meaningless.
 */
export async function tallyLedgerMap(): Promise<Row> {
  await ensureTallyTables()
  const c = getClient()
  const cid = getActiveCompanyId()
  const tally = toPlain(
    await c.execute({
      sql: `SELECT id, name, name_key, dr, cr, account_id, file_name, imported_at, period_from, period_to
              FROM tally_ledgers WHERE company_id = ? ORDER BY name COLLATE NOCASE`,
      args: [cid]
    })
  )
  const ours = toPlain(
    await c.execute({
      sql: `SELECT a.id, a.name, a.acc_group,
                   COALESCE((SELECT o.dr FROM ledger_openings o WHERE o.account_id = a.id AND o.company_id = ?), 0) AS open_dr,
                   COALESCE((SELECT o.cr FROM ledger_openings o WHERE o.account_id = a.id AND o.company_id = ?), 0) AS open_cr
              FROM ledger_accounts a
             WHERE EXISTS (SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                            WHERE jl.account_id = a.id AND je.company_id = ?)
                OR EXISTS (SELECT 1 FROM ledger_openings o WHERE o.account_id = a.id AND o.company_id = ?)
                -- AND ANY LEDGER THIS UPLOAD HAS ALREADY CLAIMED.
                -- Postings and an opening are what make a ledger this
                -- company's, and a ledger created from Tally with a nil
                -- opening has neither yet. Without this it fell straight back
                -- out of "in both" into "only in Tally" the moment it was
                -- made — 216 of 840 on the real file — and the next press of
                -- Create would have offered to make them all over again.
                OR EXISTS (SELECT 1 FROM tally_ledgers tl
                            WHERE tl.account_id = a.id AND tl.company_id = ?)
             ORDER BY a.name COLLATE NOCASE`,
      args: [cid, cid, cid, cid, cid]
    })
  )
  const byKey = new Map<string, Row>()
  const byId = new Map<number, Row>()
  for (const a of ours) {
    byId.set(n(a.id), a)
    const k = ledgerKey(a.name)
    if (k && !byKey.has(k)) byKey.set(k, a)
  }
  const matched: Row[] = []
  const onlyTally: Row[] = []
  const takenIds = new Set<number>()
  for (const t of tally) {
    // A mapping made by hand wins over the name, always: it is somebody saying
    // these two are the same ledger, which is more than a string can know.
    const hand = n(t.account_id) ? byId.get(n(t.account_id)) : undefined
    const hit = hand || byKey.get(String(t.name_key))
    if (hit) {
      takenIds.add(n(hit.id))
      matched.push({
        ...t,
        account_id: n(hit.id),
        our_name: String(hit.name),
        acc_group: String(hit.acc_group || ''),
        open_dr: round2(n(hit.open_dr)),
        open_cr: round2(n(hit.open_cr)),
        by_hand: !!hand,
        // Whether this book already carries the figure Tally does.
        in_step:
          Math.abs(round2(n(hit.open_dr)) - round2(n(t.dr))) < 0.005 &&
          Math.abs(round2(n(hit.open_cr)) - round2(n(t.cr))) < 0.005
      })
    } else {
      onlyTally.push({ ...t, suggested_group: suggestGroup(String(t.name), n(t.dr), n(t.cr)) })
    }
  }
  const onlyOurs = ours.filter((a) => !takenIds.has(n(a.id)))
  return {
    file_name: tally.length ? String(tally[0].file_name || '') : '',
    imported_at: tally.length ? String(tally[0].imported_at || '') : '',
    // The date these figures are an opening ON, off the file, beside the date
    // this book says it begins. When the two disagree the openings are being
    // written as at a day the ledgers do not start on, which is worth saying
    // before it is done rather than discovering in a trial balance.
    opening_date: tally.length ? String(tally[0].period_from || '') : '',
    period_to: tally.length ? String(tally[0].period_to || '') : '',
    books_from: (await getBooksFrom(cid)) || '',
    counts: {
      tally: tally.length,
      ours: ours.length,
      matched: matched.length,
      only_tally: onlyTally.length,
      only_ours: onlyOurs.length,
      out_of_step: matched.filter((m) => !m.in_step).length
    },
    matched,
    only_tally: onlyTally,
    only_ours: onlyOurs
  }
}

/** Say by hand that a Tally name and one of our ledgers are the same thing. */
export async function mapTallyLedger(v: {
  id?: number | string
  account_id?: number | string | null
}): Promise<{ id: number }> {
  await ensureTallyTables()
  const id = n(v.id)
  if (!id) throw new Error('Which Tally ledger?')
  const acc = v.account_id == null || String(v.account_id) === '' ? null : n(v.account_id)
  await getClient().execute({
    sql: 'UPDATE tally_ledgers SET account_id = ? WHERE id = ? AND company_id = ?',
    args: [acc, id, getActiveCompanyId()]
  })
  return { id }
}

/**
 * Write the openings Tally holds onto the ledgers they were matched to.
 *
 * Only what is asked for. Applying all of them by default would be one button
 * that rewrites every opening balance in the book, which is not a thing to
 * offer without naming the rows first.
 */
export async function applyTallyOpenings(v: {
  ids?: unknown
  set_books_from?: boolean
}): Promise<{ saved: number; books_from: string }> {
  await ensureTallyTables()
  const want = Array.isArray(v?.ids) ? v.ids.map((x) => n(x)).filter((x) => x > 0) : []
  if (!want.length) throw new Error('Pick the ledgers whose opening balances should be written')
  const map = await tallyLedgerMap()
  const all = map.matched as Row[]
  const pick = all.filter((m) => want.includes(n(m.id)))
  if (!pick.length) throw new Error('None of those are matched to a ledger in this book')
  const cid = getActiveCompanyId()
  const out = await saveOpenings(
    pick.map((m) => ({ account_id: n(m.account_id), dr: n(m.dr), cr: n(m.cr) })),
    cid
  )
  // The date the figures belong to, moved across with them when asked. Books
  // that begin on one day carrying openings struck on another is the quiet
  // way a trial balance stops agreeing with itself.
  const date = String(map.opening_date || '')
  if (v.set_books_from && date) await setBooksFrom(date, cid)
  return { ...out, books_from: v.set_books_from && date ? date : String(map.books_from || '') }
}


/**
 * WHICH HEAD A TALLY LEDGER PROBABLY BELONGS UNDER.
 *
 * Eight hundred ledgers is not a list anybody is going to classify one at a
 * time from nothing, so each arrives with a group already proposed. The
 * proposal is read off the name first, because a name is what an accountant
 * reads too — BANK, GST, SALE, FREIGHT — and off the side of the opening
 * balance only when the name says nothing: a debit nobody recognises is
 * almost always somebody who owes us, a credit somebody we owe.
 *
 * It is a suggestion and it is shown as one. Every row can be changed before
 * anything is created, and every ledger can be re-grouped afterwards; the
 * point is to start from something a person edits rather than from a list of
 * eight hundred blanks.
 */
const GROUP_HINTS: { re: RegExp; group: string }[] = [
  { re: /\bCASH\b/, group: 'Cash-in-hand' },
  { re: /\bBANK\b|\bA\/C\s*NO\b|\bCC\s*A\/C\b|\bOD\s*A\/C\b/, group: 'Bank Accounts' },
  { re: /\bGST\b|\bCGST\b|\bSGST\b|\bIGST\b|\bTDS\b|\bTCS\b|\bDUTY\b|\bDUTIES\b|\bCESS\b/, group: 'Duties & Taxes' },
  { re: /\bSALES?\b/, group: 'Sales Accounts' },
  { re: /\bPURCHASES?\b|\bPUR\s*A\/C\b/, group: 'Purchase Accounts' },
  { re: /\bSTOCK\b/, group: 'Stock-in-hand' },
  { re: /\bCAPITAL\b|\bPARTNER/, group: 'Capital Account' },
  { re: /\bLOAN\b|\bBORROW/, group: 'Loans (Liability)' },
  { re: /\bDEPRECIATION\b|\bMACHINER|\bBUILDING\b|\bVEHICLE|\bFURNITURE|\bPLANT\b|\bLAND\b/, group: 'Fixed Assets' },
  { re: /\bFD\b|\bFIXED\s+DEPOSIT\b|\bINVESTMENT/, group: 'Investments' },
  { re: /\bFREIGHT\s+INWARD\b|\bWAGES\b|\bPOWER\b|\bFUEL\b|\bLABOUR\b/, group: 'Direct Expenses' },
  { re: /\bINTEREST\s+(RECEIVED|INCOME)\b|\bCOMMISSION\s+RECEIVED\b|\bDISCOUNT\s+RECEIVED\b/, group: 'Indirect Incomes' },
  { re: /\bCHARGES?\b|\bEXPENSES?\b|\bEXP\b|\bSALARY\b|\bRENT\b|\bINSURANCE\b|\bINTEREST\b|\bFEES?\b|\bAUDIT\b|\bTELEPHONE\b|\bPRINTING\b|\bTRAVEL|\bFREIGHT\b|\bTRANSPORT/, group: 'Indirect Expenses' },
  { re: /\bADVANCE\b|\bDEPOSIT\b|\bPREPAID\b|\bRECEIVABLE\b|\bACCRUED\b/, group: 'Current Assets' },
  { re: /\bPAYABLE\b|\bPROVISION\b|\bOUTSTANDING\b|\bACCUMULATED\b/, group: 'Current Liabilities' }
]

export function suggestGroup(name: string, dr: number, cr: number): string {
  const up = String(name || '').toUpperCase()
  for (const h of GROUP_HINTS) if (h.re.test(up)) return h.group
  if (round2(cr) > 0.004) return 'Sundry Creditors'
  if (round2(dr) > 0.004) return 'Sundry Debtors'
  // Nothing in the name, nothing in the figures. Suspense is the honest answer
  // and the one a reader will notice and fix, which "General" is not.
  return 'Suspense A/C'
}

/**
 * Create the ledgers Tally has and this book does not, as they are named.
 *
 * Each is created under the group it was given — the suggestion, or whatever
 * it was changed to — and linked back to its Tally row, so it moves out of
 * "Only in Tally" and into "In both" on the next read. Opening balances are
 * written only when asked for, on the same rule as everywhere else here.
 */
export async function createTallyLedgers(v: {
  rows?: unknown
  with_openings?: boolean
  set_books_from?: boolean
}): Promise<{ created: number; openings: number }> {
  await ensureTallyTables()
  const c = getClient()
  const cid = getActiveCompanyId()
  const want = Array.isArray(v?.rows) ? (v.rows as Row[]) : []
  if (!want.length) throw new Error('Pick the ledgers to create')
  const ids = want.map((r) => n(r.id)).filter((x) => x > 0)
  if (!ids.length) throw new Error('Pick the ledgers to create')
  const rows = toPlain(
    await c.execute({
      sql: `SELECT id, name, dr, cr, account_id FROM tally_ledgers
             WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      args: [cid, ...ids]
    })
  )
  const groupOf = new Map<number, string>()
  for (const r of want) {
    const g = String(r.group || '').trim()
    if (n(r.id) && g) groupOf.set(n(r.id), g)
  }
  const openings: { account_id: number; dr: number; cr: number }[] = []
  let created = 0
  for (const r of rows) {
    // Already pointing at a ledger: creating a second one of the same name is
    // how a chart of accounts grows a duplicate.
    if (n(r.account_id)) continue
    const name = String(r.name || '').trim()
    if (!name) continue
    const group = groupOf.get(n(r.id)) || suggestGroup(name, n(r.dr), n(r.cr))
    const made = await createAccount(name.toUpperCase(), group, cid)
    await c.execute({
      sql: 'UPDATE tally_ledgers SET account_id = ? WHERE id = ? AND company_id = ?',
      args: [made.id, n(r.id), cid]
    })
    created++
    if (v.with_openings) openings.push({ account_id: made.id, dr: n(r.dr), cr: n(r.cr) })
  }
  const saved = openings.length ? await saveOpenings(openings, cid) : { saved: 0 }
  if (v.set_books_from && openings.length) {
    const date = String((await tallyLedgerMap()).opening_date || '')
    if (date) await setBooksFrom(date, cid)
  }
  return { created, openings: saved.saved }
}

/**
 * Move ledgers this window is showing to another group.
 *
 * One at a time for a correction, and many at once because that is the shape
 * of the job: eight hundred ledgers arrive from Tally classified by a guess,
 * and sorting them is done in handfuls — all the ones that are really
 * suppliers, all the ones that are really expenses — not one row at a time.
 */
export async function regroupTallyLedger(v: {
  account_id?: number | string
  account_ids?: unknown
  group?: string
}): Promise<{ moved: number }> {
  const many = Array.isArray(v.account_ids) ? v.account_ids.map((x) => n(x)).filter((x) => x > 0) : []
  const ids = many.length ? many : n(v.account_id) ? [n(v.account_id)] : []
  const group = String(v.group || '').trim()
  if (!ids.length) throw new Error('Which ledger?')
  if (!group) throw new Error('Pick the group it belongs under')
  let moved = 0
  for (const id of ids) {
    await setAccountGroup(id, group)
    moved++
  }
  return { moved }
}

/** Throw the uploaded list away, so a wrong file is one click undone. */
export async function clearTallyLedgers(): Promise<{ cleared: number }> {
  await ensureTallyTables()
  const c = getClient()
  const cid = getActiveCompanyId()
  const before = await c.execute({
    sql: 'SELECT COUNT(*) AS n FROM tally_ledgers WHERE company_id = ?',
    args: [cid]
  })
  await c.execute({ sql: 'DELETE FROM tally_ledgers WHERE company_id = ?', args: [cid] })
  return { cleared: n(before.rows[0]?.n) }
}
