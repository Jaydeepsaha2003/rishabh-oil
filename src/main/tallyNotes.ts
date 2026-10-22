import ExcelJS from 'exceljs'
import { parsedFile } from './tallyCache'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { createVoucher } from './accounting'
import { createAccount } from './journal'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// TALLY FILE UPDATION — a Tally register brought into these books.
//
// Tally exports a Credit Note or Debit Note register as one row per note:
// Date · Particulars (the party) · Voucher No. · Value · Gross Total, and then
// one column per ledger the note touched (STORAGE, OUTPUT CGST 9%, CPO, Round
// Off…). This reads that sheet, says which notes these books do not have yet,
// and posts the missing ones as ordinary Credit / Debit Note vouchers:
//
//   Credit note: Cr party (Gross Total) · Dr every ledger column
//   Debit note:  Dr party (Gross Total) · Cr every ledger column
//
// The Round Off column is not trusted for its sign (Tally prints it either
// way); the round off posted is whatever makes the note balance, and a note
// that is out by more than a rupee is refused rather than "rounded".
//
// Ledger names in Tally and here rarely agree to the letter, so every name is
// MAPPED: an exact match (after normalising case, A/C, @, 2.50 vs 2.5) maps
// itself, a mapping made by hand is remembered for the next file, and the rest
// are picked — or created — by the user before anything is posted.
// ---------------------------------------------------------------------------

export type TallyNoteKind = 'credit' | 'debit'

export function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}
const n = (v: unknown): number => {
  const x = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(x) ? x : 0
}
const round2 = (x: number): number => Math.round((Number(x) || 0) * 100) / 100

/**
 * TALLY PRINTS EVERY COLUMN WITHOUT ITS SIGN. A freight the customer deducted
 * reads 5,100 beside the sale it came off, not −5,100. When the columns as
 * printed do not make the gross, the column (or pair of columns) whose sign,
 * turned, makes it to the rupee is the one that was deducted.
 */
function settleSigns<T extends { amount: number }>(gross: number, cols: T[], fixed = 0): T[] {
  const total = (cs: T[]): number => cs.reduce((s, c) => s + c.amount, 0) + fixed
  if (Math.abs(gross - total(cols)) <= 1) return cols
  const flip = (idx: number[]): T[] => cols.map((c, i) => (idx.includes(i) ? { ...c, amount: -c.amount } : c))
  for (let i = 0; i < cols.length; i++) {
    const tryIt = flip([i])
    if (Math.abs(gross - total(tryIt)) <= 1) return tryIt
  }
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const tryIt = flip([i, j])
      if (Math.abs(gross - total(tryIt)) <= 1) return tryIt
    }
  }
  return cols
}

/** A ledger name as both systems can agree on it: case, A/C, @ and trailing zeros taken out. */
export function tallyKey(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/\bA\s*\/\s*C\b/g, ' ')
    .replace(/@/g, ' ')
    .replace(/\d+(?:\.\d+)?/g, (m) => String(Number(m)))
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

/** A voucher number as both systems write it: DN/0100 and DN/100 are one note. */
export function vchKey(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/(^|[^0-9])0+(\d)/g, '$1$2')
}

// "K R FOODS LIMITED" and "KR FOODS LTD" are one company.
/**
 * Whether a Tally file's company is this one. Tally's name can carry a
 * bracketed tag the books' name does not — "K R FINMARK PVT LTD.(UP)", a
 * "(2026-27)" — which read as another company and raised the switch-company
 * warning on the right books. Only the company check drops it; party names
 * still compare whole.
 */
export function sameCompany(tally: string, books: string): boolean {
  const k = (x: string): string => companyKey(String(x || '').replace(/\([^)]*\)/g, ' '))
  return k(tally) === k(books)
}

export function companyKey(v: string): string {
  return tallyKey(v)
    .split(' ')
    .filter((t) => !['LTD', 'LIMITED', 'PVT', 'PRIVATE', 'THE', 'CO', 'COMPANY'].includes(t))
    .join('')
}

const STOP = new Set(['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'CO', 'THE', 'AND', 'OF', 'M', 'S', 'CR', 'DR', 'R'])
function tokens(v: string): Set<string> {
  return new Set(tallyKey(v).split(' ').filter((t) => t.length >= 2 && !STOP.has(t)))
}

async function ensureMapTable(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS tally_import_map (
    name_key TEXT PRIMARY KEY,
    tally_name TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
}

// Columns that describe the note rather than name a ledger.
const SUMMARY_COLS = /^(date|particulars|voucher\s*type|voucher\s*no\.?|value|addl\.?\s*cost|gross\s*total|narration)$/i
const ROUND_OFF = /round\s*off/i

interface ParsedNote {
  row: number
  date: string
  party: string
  vch_no: string
  gross: number
  cols: { name: string; amount: number }[]
  round_off: number
  balanced: boolean
}

export function cellValue(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as Row
    if ('result' in o) return o.result
    if ('richText' in o) return (o.richText as Row[]).map((t) => t.text).join('')
    if ('text' in o) return o.text
  }
  return v
}

export function isoDate(v: unknown): string {
  if (v instanceof Date) {
    // ExcelJS gives dates at UTC midnight.
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  }
  const s = String(v ?? '').trim()
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{2,4})$/.exec(s)
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const mon = /\d/.test(m[2]) ? Number(m[2]) : months.indexOf(m[2].toLowerCase()) + 1
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    if (mon >= 1) return `${yr}-${String(mon).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return ''
}

async function parseRegister(b64: string, kind: TallyNoteKind): Promise<{ company: string; title: string; period: string; notes: ParsedNote[] }> {
  if (!b64) throw new Error('Choose the Tally register file to upload')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(Buffer.from(b64, 'base64') as unknown as ArrayBuffer)
  } catch {
    throw new Error('That file could not be read — export the register from Tally as Excel (.xlsx)')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('That workbook has no sheet in it')
  const grid: unknown[][] = []
  ws.eachRow({ includeEmpty: true }, (row, i) => {
    const cells: unknown[] = []
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      cells[c - 1] = cellValue(cell.value)
    })
    grid[i - 1] = cells
  })
  const txt = (v: unknown): string => String(v ?? '').trim()
  const headAt = grid.findIndex((r) => (r || []).some((c) => /^date$/i.test(txt(c))) && (r || []).some((c) => /^particulars$/i.test(txt(c))))
  if (headAt < 0) throw new Error('No Date / Particulars header found — upload the register exactly as Tally exports it')
  const head = (grid[headAt] || []).map(txt)
  const at = (re: RegExp): number => head.findIndex((h) => re.test(h))
  const iDate = at(/^date$/i)
  const iParty = at(/^particulars$/i)
  const iNo = at(/^voucher\s*no\.?$/i)
  const iGross = at(/^gross\s*total$/i)
  if (iNo < 0 || iGross < 0) throw new Error('The sheet needs its Voucher No. and Gross Total columns')
  const title = txt(grid[1]?.[0])
  if (kind === 'credit' && /debit/i.test(title)) throw new Error(`This is a ${title} — upload it under Debit Notes`)
  if (kind === 'debit' && /credit/i.test(title)) throw new Error(`This is a ${title} — upload it under Credit Notes`)
  const ledgerCols = head
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !!h && !SUMMARY_COLS.test(h) && i !== iDate && i !== iParty && i !== iNo && i !== iGross)
  const notes: ParsedNote[] = []
  for (let r = headAt + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const party = txt(row[iParty])
    if (!party || /^grand\s*total$/i.test(party)) continue
    const date = isoDate(row[iDate])
    const vchNo = txt(row[iNo])
    if (!date || !vchNo) continue
    const gross = round2(n(row[iGross]))
    const cols = settleSigns(
      gross,
      ledgerCols
        .filter(({ h }) => !ROUND_OFF.test(h))
        .map(({ h, i }) => ({ name: h, amount: round2(n(row[i])) }))
        .filter((c) => Math.abs(c.amount) > 0.004)
    )
    const roundOff = round2(gross - cols.reduce((t, c) => t + c.amount, 0))
    notes.push({ row: r + 1, date, party, vch_no: vchNo, gross, cols, round_off: roundOff, balanced: Math.abs(roundOff) <= 1 && gross > 0 })
  }
  if (!notes.length) throw new Error('No notes found under the header row')
  return { company: txt(grid[0]?.[0]), title, period: txt(grid[2]?.[0]), notes }
}

/** What each Tally name maps to here: remembered, matched exactly, or nothing yet. */
export async function resolveNames(names: string[]): Promise<Map<string, { account_id: number; account_name: string; how: 'saved' | 'auto' }>> {
  await ensureMapTable()
  const c = getClient()
  const accts = toPlain(await c.execute('SELECT id, name FROM ledger_accounts'))
  const byId = new Map(accts.map((a) => [Number(a.id), String(a.name)]))
  const byKey = new Map<string, number>()
  for (const a of accts) {
    const k = tallyKey(a.name)
    if (k && !byKey.has(k)) byKey.set(k, Number(a.id))
  }
  // A rename redirect names the same ledger under its old name.
  const redirects = await c.execute('SELECT posts_as, use_name FROM ledger_map').catch(() => null)
  for (const r of toPlain(redirects || ({ rows: [] } as unknown as ResultSet))) {
    const to = byKey.get(tallyKey(r.use_name))
    const k = tallyKey(r.posts_as)
    if (to && k && !byKey.has(k)) byKey.set(k, to)
  }
  const saved = new Map(toPlain(await c.execute('SELECT name_key, account_id FROM tally_import_map')).map((r) => [String(r.name_key), Number(r.account_id)]))
  const out = new Map<string, { account_id: number; account_name: string; how: 'saved' | 'auto' }>()
  for (const nm of names) {
    const k = tallyKey(nm)
    const s = saved.get(k)
    if (s && byId.has(s)) {
      out.set(k, { account_id: s, account_name: byId.get(s) as string, how: 'saved' })
      continue
    }
    const a = byKey.get(k)
    if (a && byId.has(a)) out.set(k, { account_id: a, account_name: byId.get(a) as string, how: 'auto' })
  }
  return out
}

function suggestGroupFor(name: string, role: 'party' | 'ledger', kind: TallyNoteKind): string {
  const s = name.toUpperCase()
  if (role === 'party') return kind === 'credit' ? 'Sundry Debtors' : 'Sundry Creditors'
  if (/\b(C|S|I)GST\b|\bGST\b|\bTDS\b|\bTCS\b/.test(s)) return 'Duties & Taxes'
  if (/ROUND\s*OFF/.test(s)) return 'Indirect Expenses'
  if (/FREIGHT|CARTAGE/.test(s)) return 'Direct Expenses'
  if (/EXPENSE|INSURANCE|TRAVEL|BROKER|BROKRAGE|BROKERAGE|SERVICE|COMMISSION|RENT|REPAIR|MATERIAL|MATRIEL/.test(s)) return 'Indirect Expenses'
  if (/SALE|SETTLEMENT|SETTELMENT|STORAGE/.test(s)) return kind === 'credit' ? 'Sales Accounts' : 'Indirect Incomes'
  return kind === 'credit' ? 'Sales Accounts' : 'Purchase Accounts'
}

async function existingNotes(kind: TallyNoteKind, companyId: number): Promise<Row[]> {
  return toPlain(
    await getClient().execute({
      sql: `SELECT je.id, je.vch_no, je.entry_date,
                   ROUND(COALESCE((SELECT SUM(jl.dr) FROM journal_lines jl WHERE jl.entry_id = je.id), 0), 2) AS total
              FROM journal_entries je
             WHERE je.company_id = ? AND UPPER(je.vch_type) = ?`,
      args: [companyId, kind === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE']
    })
  )
}

function statusOf(note: ParsedNote, existing: Row[]): { status: 'new' | 'exists' | 'clash' | 'maybe' | 'unbalanced'; match?: Row } {
  if (!note.balanced) return { status: 'unbalanced' }
  const k = vchKey(note.vch_no)
  const same = existing.find((e) => vchKey(e.vch_no) === k)
  if (same) return { status: Math.abs(n(same.total) - note.gross) <= 1 ? 'exists' : 'clash', match: same }
  const twin = existing.find((e) => String(e.entry_date).slice(0, 10) === note.date && Math.abs(n(e.total) - note.gross) <= 1)
  if (twin) return { status: 'maybe', match: twin }
  return { status: 'new' }
}

/**
 * Every name a file uses, with what it maps to here — or, for a name that
 * matched nothing, a few likely ledgers (offered, never applied) and the group
 * a new ledger for it would most likely go in. Unmapped names come first.
 */
export async function mappingRows(
  roles: Map<string, { name: string; role: 'party' | 'ledger'; count: number; amount: number }>,
  groupFor: (name: string, role: 'party' | 'ledger') => string
): Promise<Row[]> {
  const mapped = await resolveNames([...roles.values()].map((r) => r.name))
  const accts = toPlain(await getClient().execute('SELECT id, name, acc_group FROM ledger_accounts ORDER BY name'))
  const ledgers = [...roles.entries()].map(([key, r]) => {
    const m = mapped.get(key)
    // A few likely ledgers for a name that matched nothing — offered, never applied.
    let suggest: Row[] = []
    if (!m) {
      const want = tokens(r.name)
      suggest = accts
        .map((a) => {
          const have = tokens(String(a.name))
          const both = [...want].filter((t) => have.has(t)).length
          const score = want.size && have.size ? both / Math.max(want.size, have.size) : 0
          return { id: Number(a.id), name: String(a.name), group: String(a.acc_group || ''), score: Math.round(score * 100) / 100 }
        })
        .filter((a) => a.score >= 0.34)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
    }
    return {
      key,
      tally_name: r.name,
      role: r.role,
      used_in: r.count,
      amount: r.amount,
      account_id: m?.account_id ?? null,
      account_name: m?.account_name ?? null,
      how: m?.how ?? null,
      suggest,
      suggested_group: groupFor(r.name, r.role)
    }
  })
  ledgers.sort((a, b) => (a.account_id ? 1 : 0) - (b.account_id ? 1 : 0) || (a.role === b.role ? 0 : a.role === 'party' ? -1 : 1) || a.tally_name.localeCompare(b.tally_name))

  return ledgers
}

/** Read the file: every note with its status here, and every ledger name with its mapping. */
export async function previewTallyNotes(v: { kind: TallyNoteKind; data_base64: string; file_name?: string; company_id?: number }): Promise<Row> {
  const kind: TallyNoteKind = v.kind === 'debit' ? 'debit' : 'credit'
  const cid = await companyOf(v)
  const reg = await parseRegister(String(v.data_base64 || ''), kind)
  const existing = await existingNotes(kind, cid)

  const roles = new Map<string, { name: string; role: 'party' | 'ledger'; count: number; amount: number }>()
  const note = (nm: string, role: 'party' | 'ledger', amt: number): void => {
    const k = tallyKey(nm)
    const g = roles.get(k) || { name: nm, role, count: 0, amount: 0 }
    g.count += 1
    g.amount = round2(g.amount + Math.abs(amt))
    roles.set(k, g)
  }
  for (const x of reg.notes) {
    note(x.party, 'party', x.gross)
    for (const c of x.cols) note(c.name, 'ledger', c.amount)
  }
  const ledgers = await mappingRows(roles, (nm, role) => suggestGroupFor(nm, role, kind))

  const companyName = String(
    ((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || ''
  )
  return {
    kind,
    file_name: String(v.file_name || ''),
    file_company: reg.company,
    company: companyName,
    company_mismatch: !!reg.company && !!companyName && !sameCompany(reg.company, companyName),
    title: reg.title,
    period: reg.period,
    notes: reg.notes.map((x) => {
      const st = statusOf(x, existing)
      return {
        ...x,
        party_key: tallyKey(x.party),
        cols: x.cols.map((c) => ({ ...c, key: tallyKey(c.name) })),
        status: st.status,
        match: st.match ? { id: Number(st.match.id), vch_no: String(st.match.vch_no || ''), date: String(st.match.entry_date || ''), total: n(st.match.total) } : null
      }
    }),
    ledgers
  }
}

/** Remember a mapping by hand, so the next file maps this name by itself. */
export async function saveTallyNoteMap(v: { tally_name: string; account_id: number | null }): Promise<{ key: string }> {
  await ensureMapTable()
  const key = tallyKey(v.tally_name)
  if (!key) throw new Error('No Tally name to map')
  const c = getClient()
  if (!v.account_id) {
    await c.execute({ sql: 'DELETE FROM tally_import_map WHERE name_key = ?', args: [key] })
    return { key }
  }
  const a = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE id = ?', args: [Number(v.account_id)] })
  if (!a.rows.length) throw new Error('That ledger no longer exists')
  await c.execute({
    sql: `INSERT INTO tally_import_map (name_key, tally_name, account_id) VALUES (?, ?, ?)
          ON CONFLICT(name_key) DO UPDATE SET tally_name = excluded.tally_name, account_id = excluded.account_id, updated_at = datetime('now')`,
    args: [key, String(v.tally_name).trim(), Number(v.account_id)]
  })
  return { key }
}

/** A ledger Tally has and these books do not — made here, and mapped to the Tally name at once. */
export async function createTallyNoteLedger(v: { tally_name: string; name: string; group: string; company_id?: number }): Promise<{ id: number; name: string }> {
  const name = String(v.name || v.tally_name || '').trim().toUpperCase()
  if (!name) throw new Error('Give the new ledger a name')
  const group = String(v.group || '').trim()
  if (!group) throw new Error('Pick the group the new ledger belongs to')
  const c = getClient()
  const clash = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [name] })
  if (clash.rows.length) throw new Error(`A ledger called ${name} already exists — pick it from the list instead`)
  const { id } = await createAccount(name, group, await companyOf(v))
  await saveTallyNoteMap({ tally_name: v.tally_name, account_id: id })
  return { id, name }
}

/**
 * Post the notes picked. The file is read again here rather than trusting
 * figures sent back from the screen, every name must be mapped, and each note
 * is its own voucher — one that cannot post is reported and the rest still go.
 */
export async function postTallyNotes(v: {
  kind: TallyNoteKind
  data_base64: string
  file_name?: string
  vch_nos: string[]
  allow_maybe?: boolean
  company_id?: number
}): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> {
  const kind: TallyNoteKind = v.kind === 'debit' ? 'debit' : 'credit'
  const cid = await companyOf(v)
  const reg = await parseRegister(String(v.data_base64 || ''), kind)
  const wanted = new Set((v.vch_nos || []).map(vchKey))
  if (!wanted.size) throw new Error('Tick the notes to create')
  const names = new Set<string>()
  for (const x of reg.notes) {
    names.add(x.party)
    for (const c of x.cols) names.add(c.name)
  }
  const mapped = await resolveNames([...names])
  const created: { vch_no: string; id: number }[] = []
  const skipped: { vch_no: string; reason: string }[] = []
  const fileLabel = String(v.file_name || '').trim()
  for (const x of reg.notes) {
    if (!wanted.has(vchKey(x.vch_no))) continue
    // Re-checked on every note, so one just created cannot be posted twice.
    const st = statusOf(x, await existingNotes(kind, cid))
    if (st.status === 'exists') {
      skipped.push({ vch_no: x.vch_no, reason: 'already in the books' })
      continue
    }
    if (st.status === 'clash') {
      skipped.push({ vch_no: x.vch_no, reason: `the number ${x.vch_no} is already used by a different note here` })
      continue
    }
    if (st.status === 'unbalanced') {
      skipped.push({ vch_no: x.vch_no, reason: `its ledgers do not add up to the gross total (out by ${Math.abs(x.round_off).toFixed(2)})` })
      continue
    }
    if (st.status === 'maybe' && !v.allow_maybe) {
      skipped.push({ vch_no: x.vch_no, reason: 'a note of the same date and amount is already here — tick "create anyway" if it is a different one' })
      continue
    }
    const party = mapped.get(tallyKey(x.party))
    const missing = [x.party, ...x.cols.map((c) => c.name)].filter((nm) => !mapped.get(tallyKey(nm)))
    if (!party || missing.length) {
      skipped.push({ vch_no: x.vch_no, reason: `not mapped yet: ${[...new Set(missing)].join(', ')}` })
      continue
    }
    // Credit note: the party is credited, the ledgers debited. Debit note the other way.
    const partySide = kind === 'credit' ? 'cr' : 'dr'
    const colSide = kind === 'credit' ? 'dr' : 'cr'
    const lines: { account: string; dr?: number; cr?: number }[] = [{ account: party.account_name, [partySide]: x.gross }]
    for (const c of x.cols) {
      const m = mapped.get(tallyKey(c.name)) as { account_name: string }
      const amt = round2(Math.abs(c.amount))
      lines.push({ account: m.account_name, [c.amount >= 0 ? colSide : partySide]: amt })
    }
    if (Math.abs(x.round_off) > 0.004) {
      lines.push({ account: 'ROUND OFF A/C', [x.round_off > 0 ? colSide : partySide]: round2(Math.abs(x.round_off)) })
    }
    try {
      const res = await createVoucher({
        date: x.date,
        vchType: kind === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE',
        vchNo: x.vch_no,
        narration: `Imported from Tally — ${reg.title || (kind === 'credit' ? 'Credit Note Register' : 'Debit Note Register')}${fileLabel ? ` (${fileLabel})` : ''}`,
        companyId: cid,
        lines: drFirst(lines)
      })
      created.push({ vch_no: x.vch_no, id: res.id })
    } catch (e) {
      skipped.push({ vch_no: x.vch_no, reason: (e as Error).message })
    }
  }
  return { created, skipped }
}

// ---------------------------------------------------------------------------
// SALES REGISTER CHECK — Tally's Sales Register laid against these books.
//
// Nothing is posted. Every Tally invoice is found here by its number and the
// two are compared figure by figure: date, party, quantity, taxable value, GST,
// round off and gross total. What comes back says, invoice by invoice, whether
// the two books agree, where they differ and by how much, which invoices one
// side has and the other does not, and which Tally cancelled.
//
// The books' side is read from the SALE voucher itself — what the ledgers
// actually say — with the quantity from the sale lines behind it:
//   gross   = the party's debit
//   GST     = the output GST lines (Cr − Dr)
//   round   = the ROUND OFF line (Cr − Dr)
//   taxable = every other line (Cr − Dr) — the sale ledgers, freight…
// Tally's side the same way from its columns. A rupee either way is agreement.
// ---------------------------------------------------------------------------

const SALES_SUMMARY = /^(date|particulars|voucher\s*type|voucher\s*no\.?|quantity|gross\s*weight|rate|value|addl\.?\s*cost|gross\s*total|narration)$/i
const GST_COL = /\b(C|S|I|U)?GST\b|\bTCS\b|\bCESS\b/i

interface TallySale {
  row: number
  date: string
  party: string
  vch_no: string
  cancelled: boolean
  qty: number | null
  gross_weight: string
  taxable: number
  gst: number
  round_off: number
  gross: number
  ledgers: string[]
  // Every column of the invoice except round off, signed (a deduction is
  // negative) — what a voucher made from this line is built from.
  cols: { name: string; amount: number; tax: boolean }[]
  // Columns that came OFF the invoice (freight the customer deducted…), and
  // the GST heads charged — for the line's explanation.
  deducted: { name: string; amount: number }[]
  gst_heads: { name: string; amount: number }[]
}

export function periodOf(s: string): { from: string; to: string } {
  const m = /(\d{1,2}-[A-Za-z]{3}-\d{2,4})\s*to\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4})/.exec(s)
  return m ? { from: isoDate(m[1]), to: isoDate(m[2]) } : { from: '', to: '' }
}

async function parseSalesRegister(b64: string): Promise<{ company: string; title: string; period: string; from: string; to: string; sales: TallySale[] }> {
  if (!b64) throw new Error('Choose the Tally Sales Register file to upload')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(Buffer.from(b64, 'base64') as unknown as ArrayBuffer)
  } catch {
    throw new Error('That file could not be read — export the register from Tally as Excel (.xlsx)')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('That workbook has no sheet in it')
  const grid: unknown[][] = []
  ws.eachRow({ includeEmpty: true }, (row, i) => {
    const cells: unknown[] = []
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      cells[c - 1] = cellValue(cell.value)
    })
    grid[i - 1] = cells
  })
  const txt = (v: unknown): string => String(v ?? '').trim()
  const title = txt(grid[1]?.[0])
  if (title && !/sales/i.test(title)) throw new Error(`This is a ${title} — upload a Sales Register here`)
  const headAt = grid.findIndex((r) => (r || []).some((c) => /^date$/i.test(txt(c))) && (r || []).some((c) => /^particulars$/i.test(txt(c))))
  if (headAt < 0) throw new Error('No Date / Particulars header found — upload the register exactly as Tally exports it')
  const head = (grid[headAt] || []).map(txt)
  const at = (re: RegExp): number => head.findIndex((h) => re.test(h))
  const iDate = at(/^date$/i)
  const iParty = at(/^particulars$/i)
  const iNo = at(/^voucher\s*no\.?$/i)
  const iGross = at(/^gross\s*total$/i)
  const iQty = at(/^quantity$/i)
  const iGw = at(/^gross\s*weight$/i)
  if (iNo < 0 || iGross < 0) throw new Error('The sheet needs its Voucher No. and Gross Total columns')
  const cols = head.map((h, i) => ({ h, i })).filter(({ h }) => !!h && !SALES_SUMMARY.test(h))
  const sales: TallySale[] = []
  for (let r = headAt + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const party = txt(row[iParty])
    if (!party || /^grand\s*total$/i.test(party)) continue
    const vchNo = txt(row[iNo])
    const date = isoDate(row[iDate])
    if (!vchNo || !date) continue
    const cancelled = /\(\s*cancel+ed\s*\)/i.test(party) || (!n(row[iGross]) && cols.every(({ i }) => !n(row[i])))
    const gross = round2(n(row[iGross]))
    const parts = settleSigns(
      gross,
      cols
        .filter(({ h }) => !/round\s*off/i.test(h))
        .map(({ h, i }) => ({ name: h, amount: round2(n(row[i])), tax: GST_COL.test(h) }))
        .filter((c) => Math.abs(c.amount) > 0.004)
    )
    let taxable = 0
    let gst = 0
    const ledgers: string[] = []
    const deducted: { name: string; amount: number }[] = []
    const gstHeads: { name: string; amount: number }[] = []
    for (const c of parts) {
      if (c.tax) {
        gst = round2(gst + c.amount)
        gstHeads.push({ name: c.name, amount: c.amount })
      } else {
        taxable = round2(taxable + c.amount)
        ledgers.push(c.amount < 0 ? `${c.name} (less)` : c.name)
        if (c.amount < 0) deducted.push({ name: c.name, amount: -c.amount })
      }
    }
    sales.push({
      row: r + 1,
      date,
      party: cancelled ? party.replace(/\(\s*cancel+ed\s*\)/i, '').trim() : party,
      vch_no: vchNo,
      cancelled,
      qty: iQty >= 0 && txt(row[iQty]) !== '' ? n(row[iQty]) : null,
      gross_weight: iGw >= 0 ? txt(row[iGw]) : '',
      taxable,
      gst,
      // Whatever makes the invoice balance — Tally prints its sign either way.
      round_off: round2(gross - taxable - gst),
      gross,
      ledgers,
      cols: parts.map((c) => ({ name: c.name, amount: c.amount, tax: c.tax })),
      deducted,
      gst_heads: gstHeads
    })
  }
  if (!sales.length) throw new Error('No invoices found under the header row')
  const period = txt(grid[2]?.[0])
  const p = periodOf(period)
  const dates = sales.map((s) => s.date).sort()
  return { company: txt(grid[0]?.[0]), title, period, from: p.from || dates[0], to: p.to || dates[dates.length - 1], sales }
}

interface BookSale {
  id: number
  // The sale the voucher was posted from (its first line); 0 for a sales
  // voucher keyed in by hand. What "Use Tally's date" re-dates.
  sale_id: number
  vch_no: string
  date: string
  party: string
  party_id: number
  gross: number
  gst: number
  round_off: number
  taxable: number
  qty: number | null
  boxes: number | null
  // The sale was debited to a SUPPLIER's ledger — the shared-ledger fault the
  // Accounting checks split; never something to "link" away.
  party_is_creditor: boolean
  deducted: { name: string; amount: number }[]
  gst_heads: { name: string; amount: number }[]
}

async function bookSales(companyId: number): Promise<BookSale[]> {
  const c = getClient()
  const lines = toPlain(
    await c.execute({
      sql: `SELECT je.id, je.vch_no, je.entry_date, je.sale_id, jl.dr, jl.cr, a.id AS account_id, a.name AS account, a.acc_group
              FROM journal_entries je
              JOIN journal_lines jl ON jl.entry_id = je.id
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.company_id = ? AND UPPER(je.vch_type) IN ('SALE', 'SALES')
             ORDER BY je.id, jl.id`,
      args: [companyId]
    })
  )
  const qty = new Map(
    toPlain(
      await c.execute({
        sql: `SELECT TRIM(UPPER(invoice_no)) AS k, SUM(qty) AS qty, SUM(COALESCE(boxes, 0)) AS boxes
                FROM sales WHERE company_id = ? AND invoice_no IS NOT NULL GROUP BY TRIM(UPPER(invoice_no))`,
        args: [companyId]
      })
    ).map((r) => [String(r.k), { qty: n(r.qty), boxes: n(r.boxes) }])
  )
  const byEntry = new Map<number, Row[]>()
  for (const l of lines) {
    const id = Number(l.id)
    if (!byEntry.has(id)) byEntry.set(id, [])
    ;(byEntry.get(id) as Row[]).push(l)
  }
  const { partySideOfGroup } = await import('./partyLedgers')
  const sideOf = new Map<string, string | null>()
  const out: BookSale[] = []
  for (const [id, ls] of byEntry) {
    // The party is the debit the invoice is raised for — the largest one.
    const party = ls.filter((l) => n(l.dr) > 0).sort((a, b) => n(b.dr) - n(a.dr))[0]
    let gst = 0
    let ro = 0
    let taxable = 0
    const deducted: { name: string; amount: number }[] = []
    const gstHeads: { name: string; amount: number }[] = []
    for (const l of ls) {
      if (l === party) continue
      const v = round2(n(l.cr) - n(l.dr))
      const name = String(l.account)
      if (GST_COL.test(name)) {
        gst = round2(gst + v)
        gstHeads.push({ name, amount: v })
      } else if (/round\s*off/i.test(name)) ro = round2(ro + v)
      else {
        taxable = round2(taxable + v)
        if (v < 0) deducted.push({ name, amount: -v })
      }
    }
    const vchNo = String(ls[0].vch_no || '')
    const q = qty.get(vchNo.trim().toUpperCase())
    const grp = String(party?.acc_group || '')
    if (!sideOf.has(grp)) sideOf.set(grp, await partySideOfGroup(grp))
    out.push({
      id,
      sale_id: Number(ls[0].sale_id) || 0,
      vch_no: vchNo,
      date: String(ls[0].entry_date || '').slice(0, 10),
      party: party ? String(party.account) : '',
      party_id: party ? Number(party.account_id) : 0,
      gross: party ? round2(n(party.dr)) : 0,
      gst,
      round_off: ro,
      taxable,
      qty: q ? round2(q.qty * 1000) / 1000 : null,
      boxes: q && q.boxes ? q.boxes : null,
      party_is_creditor: sideOf.get(grp) === 'SUNDRY CREDITORS',
      deducted,
      gst_heads: gstHeads
    })
  }
  return out
}

/** Tally's Sales Register against these books, invoice by invoice. Reads only. */
export async function reconcileTallySales(v: { data_base64: string; file_name?: string; company_id?: number }): Promise<Row> {
  const cid = await companyOf(v)
  const reg = await parsedFile('sales', String(v.data_base64 || ''), () => parseSalesRegister(String(v.data_base64 || '')))
  const books = await bookSales(cid)
  const byNo = new Map<string, BookSale[]>()
  for (const b of books) {
    const k = vchKey(b.vch_no)
    if (!byNo.has(k)) byNo.set(k, [])
    ;(byNo.get(k) as BookSale[]).push(b)
  }
  const partyMap = await resolveNames([...new Set(reg.sales.map((s) => s.party))])
  const used = new Set<number>()
  const close = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol
  const rows: Row[] = []
  for (const t of reg.sales) {
    const hits = byNo.get(vchKey(t.vch_no)) || []
    const b = hits[0]
    if (b) hits.forEach((h) => used.add(h.id))
    if (t.cancelled) {
      rows.push({ vch_no: t.vch_no, status: b ? 'cancelled_here' : 'cancelled', tally: t, books: b || null, diffs: [] })
      continue
    }
    if (!b) {
      rows.push({ vch_no: t.vch_no, status: 'missing_here', tally: t, books: null, diffs: [] })
      continue
    }
    const diffs: Row[] = []
    if (t.date !== b.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
    // The party agrees when the names match, or when this Tally name has been
    // linked to that ledger (the same map the note import uses).
    const pm = partyMap.get(tallyKey(t.party))
    const samePartyByName = companyKey(t.party) === companyKey(b.party)
    if (!samePartyByName && (!pm || pm.account_id !== b.party_id)) diffs.push({ field: 'party', tally: t.party, books: b.party })
    for (const f of ['taxable', 'gst', 'round_off', 'gross'] as const) {
      if (!close(t[f], b[f], f === 'round_off' ? 1 : 1)) diffs.push({ field: f, tally: t[f], books: b[f], diff: round2(t[f] - b[f]) })
    }
    // Loose oil: Tally's quantity is MT, as here. Packed: Tally counts cartons,
    // so it is set against the boxes the invoice carried.
    if (t.qty != null) {
      const packed = !!t.gross_weight
      const here = packed ? b.boxes : b.qty
      // Tally may count in kg what is held here in MT (165 kg = 0.165 MT).
      const sameInKg = !packed && here != null && close(t.qty, here * 1000, 0.5)
      if (here != null && !sameInKg && !close(t.qty, here, packed ? 0.5 : 0.001)) {
        diffs.push({ field: 'qty', tally: t.qty, books: here, unit: packed ? 'boxes' : 'MT', diff: round2((t.qty - here) * 1000) / 1000 })
      }
    }
    if (hits.length > 1) diffs.push({ field: 'duplicate', tally: 1, books: hits.length })
    rows.push({ vch_no: t.vch_no, status: diffs.length ? 'mismatch' : 'matched', tally: t, books: b, diffs })
  }
  // In these books for the file's period and not in Tally at all.
  for (const b of books) {
    if (used.has(b.id)) continue
    if (b.date < reg.from || b.date > reg.to) continue
    rows.push({ vch_no: b.vch_no || '(no number)', status: 'missing_tally', tally: null, books: b, diffs: [] })
  }
  const ownName = String(
    ((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || ''
  )
  explainRows(rows, reg.sales, books, ownName)
  const count = (s: string): number => rows.filter((r) => r.status === s).length
  const sum = (arr: Row[], side: 'tally' | 'books'): number => round2(arr.reduce((t, r) => t + n(r[side]?.gross), 0))
  const companyName = String(
    ((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || ''
  )
  return {
    file_name: String(v.file_name || ''),
    file_company: reg.company,
    company: companyName,
    company_mismatch: !!reg.company && !!companyName && !sameCompany(reg.company, companyName),
    title: reg.title,
    period: reg.period,
    from: reg.from,
    to: reg.to,
    counts: {
      matched: count('matched'),
      mismatch: count('mismatch'),
      missing_here: count('missing_here'),
      missing_tally: count('missing_tally'),
      cancelled: count('cancelled'),
      cancelled_here: count('cancelled_here')
    },
    totals: {
      tally: sum(rows.filter((r) => r.tally && !r.tally.cancelled), 'tally'),
      books: sum(rows.filter((r) => r.books && r.status !== 'cancelled_here'), 'books')
    },
    rows: rows.sort((a, b) => String((a.tally || a.books).date).localeCompare(String((b.tally || b.books).date)) || String(a.vch_no).localeCompare(String(b.vch_no), undefined, { numeric: true }))
  }
}

/** "These are the same party" — Tally's name linked to the ledger here, for every later check and import. */
export async function linkTallyParty(v: { tally_name: string; account_id: number }): Promise<{ key: string }> {
  return saveTallyNoteMap({ tally_name: v.tally_name, account_id: v.account_id })
}

// ---------------------------------------------------------------------------
// WHAT EACH LINE MEANS, IN WORDS.
//
// A red figure says two books disagree; it does not say why, or what to do.
// Every row gets sentences that do: what Tally says, what these books say, by
// how much they differ — and, where the two sides between them show it, the
// likely reason (freight deducted on one side only, GST not charged, the same
// invoice under a slightly different number, a sale posted to a supplier).
// ---------------------------------------------------------------------------

const inr = (v: number): string =>
  `₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dmyOf = (iso: string): string => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '—')
const looseKey = (v: unknown): string => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+/, '$1')

function daysApart(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000)
}

function explainRows(rows: Row[], tallySales: TallySale[], books: BookSale[], ownCompany = ''): void {
  const tallyLoose = new Map<string, TallySale>()
  for (const s of tallySales) tallyLoose.set(looseKey(s.vch_no), s)
  const booksLoose = new Map<string, BookSale>()
  for (const b of books) booksLoose.set(looseKey(b.vch_no), b)

  for (const r of rows) {
    const t = r.tally as TallySale | null
    const b = r.books as BookSale | null
    const say: string[] = []
    let fix = ''

    if (r.status === 'matched') {
      say.push(`Agrees with Tally — ${dmyOf(t?.date || '')}, ${inr(t?.gross || 0)}, same party, quantity and tax.`)
    } else if (r.status === 'cancelled') {
      say.push('Tally shows this invoice as cancelled, and these books have no sale under this number either.')
      fix = 'Nothing to do.'
    } else if (r.status === 'cancelled_here') {
      say.push(`Tally shows this invoice as cancelled, but these books still carry it — ${dmyOf(b?.date || '')}, ${b?.party}, ${inr(b?.gross || 0)}.`)
      fix = 'Cancel or delete the sale here, or reinstate it in Tally — the two books cannot both be right.'
    } else if (r.status === 'missing_here' && t) {
      say.push(`In Tally on ${dmyOf(t.date)} for ${t.party}, ${inr(t.gross)} (${t.ledgers.join(', ') || 'no ledger'}), but no sale numbered ${t.vch_no} is in these books.`)
      const twin = booksLoose.get(looseKey(t.vch_no))
      const sameDay = books.find((x) => x.date === t.date && Math.abs(x.gross - t.gross) <= 1)
      if (twin && vchKey(twin.vch_no) !== vchKey(t.vch_no)) {
        say.push(`A sale numbered "${twin.vch_no}" is here${Math.abs(twin.gross - t.gross) <= 1 ? ' for the same amount' : ` for ${inr(twin.gross)}`} — most likely this invoice with its number typed differently.`)
        fix = `Correct the invoice number here to ${t.vch_no}.`
      } else if (sameDay) {
        say.push(`A sale of the same date and amount is here as "${sameDay.vch_no}" — possibly this invoice under another number.`)
        fix = `Check ${sameDay.vch_no} here; if it is this invoice, renumber it ${t.vch_no}.`
      } else if (/^SER\//i.test(t.vch_no)) {
        fix = 'A service invoice — enter it here as a sale (or journal) if these books should carry it.'
      } else {
        fix = 'Enter this sale here, or check whether it was booked in the other company.'
      }
    } else if (r.status === 'missing_tally' && b) {
      say.push(`In these books on ${dmyOf(b.date)} for ${b.party}, ${inr(b.gross)}, but Tally has no invoice numbered ${b.vch_no || '(blank)'} in this period.`)
      const twin = tallyLoose.get(looseKey(b.vch_no))
      const sameDay = tallySales.find((x) => !x.cancelled && x.date === b.date && Math.abs(x.gross - b.gross) <= 1)
      if (twin && vchKey(twin.vch_no) !== vchKey(b.vch_no)) {
        say.push(`Tally has "${twin.vch_no}"${Math.abs(twin.gross - b.gross) <= 1 ? ' for the same amount' : ''} — the number here looks mistyped.`)
        fix = `Renumber this sale ${twin.vch_no}.`
      } else if (sameDay) {
        say.push(`Tally has ${sameDay.vch_no} on the same date for the same amount — possibly this sale under another number.`)
        fix = `Check it against ${sameDay.vch_no}.`
      } else if (ownCompany && companyKey(b.party).startsWith(companyKey(ownCompany).slice(0, 6)) && companyKey(b.party).includes('FOOD') === companyKey(ownCompany).includes('FOOD')) {
        say.push(`The party here is ${b.party} — this company itself. It looks like the other company's sale entered in these books.`)
        fix = 'Check which company this invoice belongs to, and move it there.'
      } else if (!/\d/.test(String(b.vch_no || '')) || !/[\/]/.test(String(b.vch_no || ''))) {
        say.push(`The number "${b.vch_no || ''}" does not look like an invoice number.`)
        fix = 'Open the sale here and give it its proper invoice number, or delete it if it was a test entry.'
      } else {
        fix = 'Enter it in Tally, or remove it here if it should not be in these books.'
      }
    } else if (t && b) {
      // ---- in both, something differs ----
      const d = (f: string): Row | undefined => (r.diffs as Row[]).find((x) => x.field === f)
      if (d('date')) {
        const gap = daysApart(t.date, b.date)
        say.push(`Dated ${dmyOf(t.date)} in Tally but ${dmyOf(b.date)} here — ${Math.abs(gap)} day${Math.abs(gap) === 1 ? '' : 's'} ${gap > 0 ? 'later' : 'earlier'} here.`)
      }
      if (d('party')) {
        if (b.party_is_creditor) {
          say.push(`Tally bills ${t.party}; here the sale is posted to ${b.party}, which is a SUPPLIER ledger — what the customer owes is netting off against what we owe them.`)
          fix = 'Settings → Accounting checks → "Customers and suppliers sharing a ledger" moves these sales to the customer\'s own ledger.'
        } else {
          say.push(`Tally bills ${t.party}; here it is posted to ${b.party}.`)
        }
      }
      const tFr = t.deducted.reduce((s, x) => s + x.amount, 0)
      const bFr = b.deducted.reduce((s, x) => s + x.amount, 0)
      const dGross = d('gross')
      const dTax = d('taxable')
      const dGst = d('gst')
      if (tFr > 0.5 && bFr < 0.5 && dGross && Math.abs(Math.abs(dGross.diff) - tFr) <= Math.max(10, tFr * 0.01) + Math.abs(t.gst - b.gst) + 1) {
        say.push(`Tally deducts ${inr(tFr)} ${t.deducted.map((x) => x.name).join(' + ')} from this invoice; here nothing is deducted, so the customer is charged ${inr(dGross.diff)} more here (${inr(b.gross)} against Tally's ${inr(t.gross)}).`)
        fix = fix || 'Tick "freight deducted by customer" on the sale here (or enter the freight), so the party is charged what Tally charges.'
      } else if (bFr > 0.5 && tFr < 0.5 && dGross) {
        say.push(`Here ${inr(bFr)} ${b.deducted.map((x) => x.name).join(' + ')} is deducted from the invoice; Tally deducts nothing, so Tally charges ${inr(dGross.diff)} more.`)
      } else {
        if (dTax) say.push(`Taxable value ${inr(t.taxable)} in Tally, ${inr(b.taxable)} here — ${inr(dTax.diff)} ${dTax.diff > 0 ? 'more in Tally' : 'more here'}.`)
      }
      if (dGst) {
        if (Math.abs(b.gst) < 0.5 && t.gst > 0.5) {
          say.push(`Tally charges GST of ${inr(t.gst)} (${t.gst_heads.map((x) => x.name.trim()).join(' + ')}); here no GST was posted on this sale.`)
          fix = fix || 'Re-post the sale here with its GST, so the output tax and the party balance match Tally.'
        } else if (Math.abs(t.gst) < 0.5 && b.gst > 0.5) {
          say.push(`Here GST of ${inr(b.gst)} is posted; Tally charges none.`)
        } else {
          say.push(`GST ${inr(t.gst)} in Tally, ${inr(b.gst)} here — ${inr(dGst.diff)} ${dGst.diff > 0 ? 'more in Tally' : 'more here'}.`)
        }
      }
      if (dGross && !say.some((s) => s.includes('charged') || s.includes('charges'))) {
        say.push(`Invoice total ${inr(t.gross)} in Tally, ${inr(b.gross)} here — the party's balance differs by ${inr(dGross.diff)}.`)
      }
      if (d('round_off') && !dGross) say.push(`Round off ${inr(t.round_off)} in Tally, ${inr(b.round_off)} here.`)
      const dq = d('qty')
      if (dq) {
        say.push(`Quantity ${dq.tally} ${dq.unit === 'boxes' ? 'cartons' : 'MT'} in Tally, ${dq.books} here.`)
      }
      const dd = d('duplicate')
      if (dd) {
        say.push(`This invoice number is posted ${dd.books} times here — the extra voucher doubles the sale in the books.`)
        fix = fix || `Delete the duplicate ${t.vch_no} here.`
      }
      if (d('date') && !fix) fix = 'Correct the date on whichever side is wrong — usually the sale here was entered later and kept the entry date.'
      if (d('party') && !fix) fix = 'If these are the same party, click "Same party" — it is remembered from then on.'
    }
    r.explain = say
    r.fix = fix
  }
}

// ---------------------------------------------------------------------------
// WORK IN PROGRESS IS KEPT.
//
// An upload is an afternoon's work — the file read, notes ticked, a judgement
// on the possible duplicates — and none of it is in the books until Process
// is pressed. So it is kept here, per user, per company, per kind, the moment
// it changes: leaving the screen, a reload, a different PC brings it back as
// it was. Processing clears it; so does Discard. (Ledger mappings are saved
// on their own the moment they are made.)
// ---------------------------------------------------------------------------

// A bank's book and its own statement are kept per bank: bank:<ledger id>, bankstmt:<ledger id>.
export type TallyDraftKind = 'credit' | 'debit' | 'sales' | 'journal' | 'purchase' | `bank:${number}` | `bankstmt:${number}`

// ---------------------------------------------------------------------------
// BOOK A MISSING SALE FROM TALLY — the "Missing here" lines of the Sales
// Register check, made into SALE vouchers here exactly as Tally has them.
//
// Built the way a credit note is imported: the party is debited the gross,
// every column is credited (a deducted one debited), and what is left over is
// the round off. Every name must be mapped to a ledger first — mapped by hand,
// remembered, or made new from the screen. The file is read again here; no
// figure is taken from the screen.
//
// It is a VOUCHER, not a sale: no sale lines, no stock, no dispatch. That is
// right for what Tally shows as missing here (storage and service invoices,
// commitment charges) — goods that left the yard belong on the Sales page.
// ---------------------------------------------------------------------------

function salesGroupFor(name: string, role: 'party' | 'ledger'): string {
  const s = name.toUpperCase()
  if (role === 'party') return 'Sundry Debtors'
  if (GST_COL.test(s)) return 'Duties & Taxes'
  if (/ROUND\s*OFF/.test(s)) return 'Indirect Expenses'
  if (/FREIGHT|CARTAGE/.test(s)) return 'Direct Expenses'
  return 'Sales Accounts'
}

async function existingSaleNos(companyId: number): Promise<Set<string>> {
  const r = await getClient().execute({
    sql: "SELECT vch_no FROM journal_entries WHERE company_id = ? AND UPPER(vch_type) IN ('SALE', 'SALES') AND vch_no IS NOT NULL",
    args: [companyId]
  })
  return new Set(toPlain(r).map((x) => vchKey(x.vch_no)))
}

/** The limits a booked sale answers to: the books' start and the user's working window. */
export async function saleDateLimits(cid: number): Promise<{ booksFrom: string; windowFrom: string }> {
  const { getBooksFrom } = await import('./openings')
  const booksFrom = String((await getBooksFrom(cid)) || '')
  const { entryWindows } = await import('./access-gate')
  const win = await entryWindows()
  const windowFrom = [win.accountsTallyImport, win.accounts].filter(Boolean).sort().pop() || ''
  return { booksFrom, windowFrom }
}

/** Why a line cannot be booked whatever is mapped — or null when nothing stops it. */
function saleBlock(x: { date: string; gross: number; round_off: number }, lim: { booksFrom: string; windowFrom: string }): string | null {
  if (lim.booksFrom && x.date < lim.booksFrom) return `dated before these books begin (${lim.booksFrom})`
  if (lim.windowFrom && x.date < lim.windowFrom) return `dated before your working window (${lim.windowFrom})`
  if (!(x.gross > 0)) return 'it has no gross total'
  if (Math.abs(x.round_off) > 1) return `its columns do not add up to the gross total (out by ${Math.abs(x.round_off).toFixed(2)})`
  return null
}

/** Debits first, then credits, each biggest first — how a voucher is read. */
export function drFirst<L extends { dr?: number; cr?: number }>(lines: L[]): L[] {
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const ad = (a.l.dr || 0) > 0 ? 1 : 0
      const bd = (b.l.dr || 0) > 0 ? 1 : 0
      if (ad !== bd) return bd - ad
      return (b.l.dr || b.l.cr || 0) - (a.l.dr || a.l.cr || 0) || a.i - b.i
    })
    .map((x) => x.l)
}

/** The lines asked for, and every name they use with its mapping. */
export async function previewTallySalesVouchers(v: { data_base64: string; vch_nos: string[]; company_id?: number }): Promise<Row> {
  const reg = await parsedFile('sales', String(v.data_base64 || ''), () => parseSalesRegister(String(v.data_base64 || '')))
  const wanted = new Set((v.vch_nos || []).map(vchKey))
  const cid = await companyOf(v)
  const have = await existingSaleNos(cid)
  const lim = await saleDateLimits(cid)
  const picked = reg.sales.filter((x) => wanted.has(vchKey(x.vch_no)) && !x.cancelled && !have.has(vchKey(x.vch_no)))
  const roles = new Map<string, { name: string; role: 'party' | 'ledger'; count: number; amount: number }>()
  const note = (nm: string, role: 'party' | 'ledger', amt: number): void => {
    const k = tallyKey(nm)
    const g = roles.get(k) || { name: nm, role, count: 0, amount: 0 }
    g.count += 1
    g.amount = round2(g.amount + Math.abs(amt))
    roles.set(k, g)
  }
  for (const x of picked) {
    note(x.party, 'party', x.gross)
    for (const c of x.cols) note(c.name, 'ledger', c.amount)
  }
  return {
    sales: picked.map((x) => ({
      vch_no: x.vch_no,
      date: x.date,
      party: x.party,
      party_key: tallyKey(x.party),
      gross: x.gross,
      taxable: x.taxable,
      gst: x.gst,
      round_off: x.round_off,
      cols: x.cols.map((c) => ({ ...c, key: tallyKey(c.name) })),
      blocked: saleBlock(x, lim)
    })),
    ledgers: await mappingRows(roles, salesGroupFor)
  }
}

/** Post the picked lines as SALE vouchers; one that cannot post is reported and the rest still go. */
export async function postTallySalesVouchers(v: {
  data_base64: string
  file_name?: string
  vch_nos: string[]
  company_id?: number
}): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> {
  const cid = await companyOf(v)
  const reg = await parsedFile('sales', String(v.data_base64 || ''), () => parseSalesRegister(String(v.data_base64 || '')))
  const wanted = new Set((v.vch_nos || []).map(vchKey))
  if (!wanted.size) throw new Error('Pick the invoices to book')
  const names = new Set<string>()
  for (const x of reg.sales) {
    if (!wanted.has(vchKey(x.vch_no))) continue
    names.add(x.party)
    for (const c of x.cols) names.add(c.name)
  }
  const mapped = await resolveNames([...names])
  // The date limits a hand-made voucher answers to: the books' start, and the
  // user's own working window for this screen.
  const lim = await saleDateLimits(cid)
  const created: { vch_no: string; id: number }[] = []
  const skipped: { vch_no: string; reason: string }[] = []
  const fileLabel = String(v.file_name || '').trim()
  for (const x of reg.sales) {
    if (!wanted.has(vchKey(x.vch_no))) continue
    if (x.cancelled) {
      skipped.push({ vch_no: x.vch_no, reason: 'Tally shows it cancelled' })
      continue
    }
    // Re-checked on every line, so one just booked cannot be booked twice.
    if ((await existingSaleNos(cid)).has(vchKey(x.vch_no))) {
      skipped.push({ vch_no: x.vch_no, reason: 'a sale with this number is already in the books' })
      continue
    }
    const block = saleBlock(x, lim)
    if (block) {
      skipped.push({ vch_no: x.vch_no, reason: block })
      continue
    }
    const party = mapped.get(tallyKey(x.party))
    const missing = [x.party, ...x.cols.map((c) => c.name)].filter((nm) => !mapped.get(tallyKey(nm)))
    if (!party || missing.length) {
      skipped.push({ vch_no: x.vch_no, reason: `not mapped yet: ${[...new Set(missing)].join(', ')}` })
      continue
    }
    const lines: { account: string; dr?: number; cr?: number }[] = [{ account: party.account_name, dr: x.gross }]
    for (const c of x.cols) {
      const m = mapped.get(tallyKey(c.name)) as { account_name: string }
      lines.push({ account: m.account_name, [c.amount >= 0 ? 'cr' : 'dr']: round2(Math.abs(c.amount)) })
    }
    if (Math.abs(x.round_off) > 0.004) {
      lines.push({ account: 'ROUND OFF A/C', [x.round_off > 0 ? 'cr' : 'dr']: round2(Math.abs(x.round_off)) })
    }
    try {
      const res = await createVoucher({
        date: x.date,
        vchType: 'SALE',
        vchNo: x.vch_no,
        narration: `Imported from Tally — ${reg.title || 'Sales Register'}${fileLabel ? ` (${fileLabel})` : ''}`,
        companyId: cid,
        lines: drFirst(lines)
      })
      created.push({ vch_no: x.vch_no, id: res.id })
    } catch (e) {
      skipped.push({ vch_no: x.vch_no, reason: (e as Error).message })
    }
  }
  const { recordTallyBatch } = await import('./tallyLinks')
  await recordTallyBatch({ company_id: cid, kind: 'sales', scope: 'sales', file_name: fileLabel, entry_ids: created.map((x) => x.id) })
  return { created, skipped }
}

async function ensureDraftTable(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS tally_import_drafts (
    company_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_name TEXT,
    data_base64 TEXT NOT NULL,
    picked_json TEXT,
    allow_maybe INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, username, kind)
  )`)
  // The period a kept bank book covers, so a one-day file cannot quietly
  // replace the whole quarter (see saveTallyDraft).
  for (const col of ['period_from TEXT', 'period_to TEXT']) {
    await getClient()
      .execute(`ALTER TABLE tally_import_drafts ADD COLUMN ${col}`)
      .catch(() => undefined)
  }
}

/**
 * THE COMPANY A TALLY FILE IS WORKED AGAINST — the one picked in Accounting,
 * sent with every call.
 *
 * Accounting keeps its own company (F3) and names it on every request; the
 * login session's company is a different thing, set by the rest of the app.
 * Reading the session here meant a KR Foods file, saved as a draft, came back
 * on KR Finmark's screen — compared with KR Foods' books, and anything posted
 * from it would have gone into KR Foods. The session is only the fallback for
 * a caller that names no company.
 */
export async function companyOf(v: unknown): Promise<number> {
  const id = Number((v as Row | null)?.company_id) || 0
  if (!id) return getActiveCompanyId()
  const r = await getClient().execute({ sql: 'SELECT id FROM companies WHERE id = ?', args: [id] })
  if (!r.rows.length) throw new Error('That company no longer exists — pick it again with F3')
  return id
}

function draftOwner(): string {
  return String(getCurrentUser().username || '').trim() || 'local'
}

function draftKind(v: unknown): TallyDraftKind {
  if (typeof v === 'string' && /^bank(stmt)?:\d+$/.test(v)) return v as TallyDraftKind
  return v === 'debit' || v === 'sales' || v === 'journal' || v === 'purchase' ? v : 'credit'
}

/** Keep (or update) the user's work on one kind of upload. */
export async function saveTallyDraft(v: {
  kind: TallyDraftKind
  file_name?: string
  data_base64?: string
  picked?: string[]
  allow_maybe?: boolean
  company_id?: number
  /** A bank book's period, when the caller knows it (the check just read it). */
  period_from?: string
  period_to?: string
  /** Keep this file even though it covers less than the one kept now. */
  replace?: boolean
}): Promise<{ saved_at: string; kept?: { file_name: string; from: string; to: string } }> {
  await ensureDraftTable()
  const c = getClient()
  const kind = draftKind(v.kind)
  const cid = await companyOf(v)
  const who = draftOwner()
  const picked = JSON.stringify(Array.isArray(v.picked) ? v.picked.map(String) : [])
  const from = v.period_from ? String(v.period_from).slice(0, 10) : null
  const to = v.period_to ? String(v.period_to).slice(0, 10) : null
  if (v.data_base64) {
    if (String(v.data_base64).length > 12_000_000) throw new Error('That file is too large to keep as a draft')
    // A BANK BOOK THAT DOES NOT COVER THE ONE KEPT DOES NOT REPLACE IT. On 19-Oct a
    // one-day book (17-Oct, 13 vouchers) took the place of HDFC 5385's
    // 1-Jul to 3-Oct book, and every other day dropped out of the check. The
    // file is still checked; it is only not kept, unless asked.
    if (/^bank:/.test(kind) && from && to && !v.replace) {
      const cur = toPlain(
        await c.execute({
          sql: 'SELECT file_name, period_from, period_to, updated_at FROM tally_import_drafts WHERE company_id = ? AND username = ? AND kind = ?',
          args: [cid, who, kind]
        })
      )[0]
      const cf = String(cur?.period_from || '')
      const ct = String(cur?.period_to || '')
      // Kept automatically only when the new book covers every day the kept
      // one does (a longer or later-ending export of the same bank).
      if (cf && ct && !(from <= cf && to >= ct)) {
        return { saved_at: String(cur?.updated_at || ''), kept: { file_name: String(cur?.file_name || ''), from: cf, to: ct } }
      }
    }
    await c.execute({
      sql: `INSERT INTO tally_import_drafts (company_id, username, kind, file_name, data_base64, picked_json, allow_maybe, updated_at, period_from, period_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
            ON CONFLICT(company_id, username, kind) DO UPDATE SET
              file_name = excluded.file_name, data_base64 = excluded.data_base64,
              picked_json = excluded.picked_json, allow_maybe = excluded.allow_maybe, updated_at = excluded.updated_at,
              period_from = excluded.period_from, period_to = excluded.period_to`,
      args: [cid, who, kind, String(v.file_name || ''), String(v.data_base64), picked, v.allow_maybe ? 1 : 0, from, to]
    })
  } else {
    // Only the choices changed — the file stays as it was kept.
    await c.execute({
      sql: `UPDATE tally_import_drafts SET picked_json = ?, allow_maybe = ?, updated_at = datetime('now')
             WHERE company_id = ? AND username = ? AND kind = ?`,
      args: [picked, v.allow_maybe ? 1 : 0, cid, who, kind]
    })
  }
  const r = await c.execute({
    sql: 'SELECT updated_at FROM tally_import_drafts WHERE company_id = ? AND username = ? AND kind = ?',
    args: [cid, who, kind]
  })
  return { saved_at: String((r.rows[0] as unknown as Row | undefined)?.updated_at || '') }
}

/** The user's kept work in this company, one per kind. */
export async function listTallyDrafts(v?: { company_id?: number }): Promise<Row[]> {
  await ensureDraftTable()
  const cid = await companyOf(v)
  return toPlain(
    await getClient().execute({
      sql: `SELECT kind, file_name, data_base64, picked_json, allow_maybe, updated_at
              FROM tally_import_drafts WHERE company_id = ? AND username = ?`,
      args: [cid, draftOwner()]
    })
  ).map((r) => {
    let picked: string[] = []
    try {
      picked = JSON.parse(String(r.picked_json || '[]'))
    } catch {
      picked = []
    }
    return { kind: String(r.kind), file_name: String(r.file_name || ''), data_base64: String(r.data_base64), picked, allow_maybe: !!Number(r.allow_maybe), saved_at: String(r.updated_at || '') }
  })
}

/**
 * EVERY BANK BOOK UPLOADED IN THIS COMPANY — by anybody. Each accountant keeps
 * their own (the drafts are per user), so one can work the HDFC 5385 book
 * while another works YES BANK: the Bank Book tab lists them all, each with
 * who put it there and when, and the desk picks one. No file bytes here —
 * the list is read on every visit to the tab.
 */
export async function listBankBooks(v?: { company_id?: number }): Promise<Row[]> {
  await ensureDraftTable()
  const cid = await companyOf(v)
  return toPlain(
    await getClient().execute({
      sql: `SELECT kind, username, file_name, updated_at FROM tally_import_drafts
             WHERE company_id = ? AND kind LIKE 'bank:%' ORDER BY updated_at DESC`,
      args: [cid]
    })
  ).map((r) => ({
    kind: String(r.kind),
    account_id: Number(String(r.kind).slice(5)) || 0,
    username: String(r.username),
    mine: String(r.username) === draftOwner(),
    file_name: String(r.file_name || ''),
    saved_at: String(r.updated_at || '')
  }))
}

/** One bank book from the list above — the user's own, or a colleague's. */
export async function getBankBook(v: { company_id?: number; account_id: number; username?: string }): Promise<Row | null> {
  await ensureDraftTable()
  const cid = await companyOf(v)
  const kind = `bank:${Number(v.account_id) || 0}`
  const who = String(v.username || '').trim()
  const r = await getClient().execute({
    sql: who
      ? 'SELECT kind, username, file_name, data_base64, updated_at FROM tally_import_drafts WHERE company_id = ? AND kind = ? AND username = ?'
      : 'SELECT kind, username, file_name, data_base64, updated_at FROM tally_import_drafts WHERE company_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 1',
    args: who ? [cid, kind, who] : [cid, kind]
  })
  const x = r.rows[0] as unknown as Row | undefined
  if (!x) return null
  return { kind: String(x.kind), username: String(x.username), file_name: String(x.file_name || ''), data_base64: String(x.data_base64), saved_at: String(x.updated_at || '') }
}

/** Let one kind's kept work go — after Process, or on Discard. */
export async function clearTallyDraft(v: { kind: TallyDraftKind; company_id?: number }): Promise<{ cleared: boolean }> {
  await ensureDraftTable()
  const cid = await companyOf(v)
  const r = await getClient().execute({
    sql: 'DELETE FROM tally_import_drafts WHERE company_id = ? AND username = ? AND kind = ?',
    args: [cid, draftOwner(), draftKind(v.kind)]
  })
  return { cleared: r.rowsAffected > 0 }
}
