import ExcelJS from 'exceljs'
import { parsedFile, booksRead } from './tallyCache'
import { getClient, todayISO } from './db'
import { linksFor, recordTallyBatch } from './tallyLinks'
import { withDbTransaction } from './dbTransaction'
import { createVoucher, type VoucherType } from './accounting'
import {
  cellValue,
  companyKey,
  companyOf,
  drFirst,
  isoDate,
  mappingRows,
  periodOf,
  resolveNames,
  saleDateLimits,
  tallyKey,
  toPlain
} from './tallyNotes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// JOURNAL AND PURCHASE REGISTERS FROM TALLY — laid against these books, and
// what is missing booked from the file.
//
// The same desk as the Sales Register check, for the two registers that do not
// key on an invoice of ours:
//
//   PURCHASE — one workbook, a sheet per purchase type (Chemical, Husk,
//   Packing, R&M, Other, Brokerage, Oil, Freight in / out). A purchase here
//   carries the SUPPLIER'S invoice number as its voucher number, so a Tally
//   line is found by that number and the supplier. Oil comes in through
//   Purchases (the order, the tankers, the stock) and freight through the
//   transporter's bill; those two are compared but never booked from here.
//
//   JOURNAL — Tally's own numbers mean nothing in these books: the journals
//   here were posted by the software (LC maturity, bill discounting) under
//   its own numbers, often as a different voucher type. So a Tally journal is
//   found by what it posts — the same total within a few days, the same
//   ledgers on the same sides. A close look-alike is a POSSIBLE MATCH: shown
//   side by side, and never booked unless the user says it is a different one.
//
// Every amount in a Tally columnar export carries its side in the cell's
// number format ("0.00 Dr" / "0.00 Cr"), so the sides are read, not guessed —
// party, every column and the round off. Every name is mapped to a ledger
// before anything posts, through the same remembered map as the note import,
// and the file is read again when booking; nothing on the screen is a figure.
// ---------------------------------------------------------------------------

export type TallyRegisterKind = 'journal' | 'purchase'

const n = (v: unknown): number => {
  const x = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(x) ? x : 0
}
const round2 = (x: number): number => Math.round((Number(x) || 0) * 100) / 100
// A tax head: CGST / SGST / IGST, or an Input / Output GST ledger. A goods
// column that merely says GST ("CPO OIL GST", "MOBILE/LAPTOP GST") is not one.
const GST_COL = /\b[CSIU]GST\b|\bCESS\b|\b(INPUT|OUTPUT)\b.*\bGST\b|\bGST\b.*\b(RCM|REVERSE|PAYABLE|PAYBLE)\b/i
const TDS_COL = /\bTDS\b|\bTCS\b/i
const ROUND_OFF = /round\s*off/i
const SUMMARY =
  /^(date|particulars|voucher\s*type|voucher\s*no\.?|voucher\s*ref\.?\s*no\.?|supplier\s*invoice\s*no\.?|gstin\/?\s*uin|value|addl\.?\s*cost|gross\s*total|narration|quantity|rate)$/i
const NEAR_DAYS = 7

/** A supplier's invoice number as both systems write it: TI/DL-1/26/0339 and TI/DL1/26/339 are one bill. */
function invKey(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/\d+/g, (m) => String(Number(m)))
    .replace(/[^A-Z0-9]/g, '')
}

function daysApart(a: string, b: string): number {
  const x = Date.parse(`${a.slice(0, 10)}T00:00:00Z`)
  const y = Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round(Math.abs(x - y) / 86400000) : 9999
}
function shiftDays(iso: string, d: number): string {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(t)) return iso
  return new Date(t + d * 86400000).toISOString().slice(0, 10)
}

const inr = (v: number): string => `₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dmy = (iso: string): string => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '—')

/** What family a purchase type belongs to, so Tally's sheet and the voucher type here can be compared. */
function family(type: string): string {
  const u = String(type || '').toUpperCase()
  if (/FREIGHT/.test(u)) return /\bOUT/.test(u) ? 'FREIGHT OUT' : 'FREIGHT IN'
  if (/\bOIL\b/.test(u)) return 'OIL'
  return u
    .replace(/^PURC(HASE)?\.?\s*/, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

/** The voucher type a purchase sheet posts as here: Tally's own name, in the purchase series. */
function purchaseTypeOf(type: string): string {
  const u = String(type || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
  return /^PURCHASE\b/.test(u) ? u : `PURCHASE ${u.replace(/^PURC(HASE)?\.?\s*/, '')}`.trim()
}

// ---------------------------------------------------------------------------
// READING THE FILE
// ---------------------------------------------------------------------------

export interface TallyLine {
  name: string
  key: string
  dr: number
  cr: number
  party?: boolean
}

export interface TallyVch {
  key: string
  sheet: string
  title: string
  type: string
  row: number
  date: string
  vch_no: string
  ref_no: string
  gstin: string
  party: string
  party_key: string
  // What the party line carries, on its own side: Cr for a purchase.
  gross: number
  total: number
  lines: TallyLine[]
  cancelled: boolean
  out_by: number
  // A purchase's figures, read off its columns: the goods or service, the GST
  // charged, the TDS held back and the round off.
  taxable: number
  gst: number
  tds: number
  round_off: number
}

interface ParsedRegister {
  company: string
  period: string
  from: string
  to: string
  sheets: { title: string; type: string; count: number; skipped?: string }[]
  vouchers: TallyVch[]
}

type Cell = { v: unknown; side: 'Dr' | 'Cr' | null }

function sideOfFormat(fmt: unknown): 'Dr' | 'Cr' | null {
  const f = String(fmt || '')
  if (/\bCr\b/.test(f)) return 'Cr'
  if (/\bDr\b/.test(f)) return 'Dr'
  return null
}

async function parseTallyRegister(b64: string, kind: TallyRegisterKind): Promise<ParsedRegister> {
  if (!b64) throw new Error(`Choose the Tally ${kind === 'journal' ? 'Journal' : 'Purchase'} Register file to upload`)
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(Buffer.from(b64, 'base64') as unknown as ArrayBuffer)
  } catch {
    throw new Error('That file could not be read — export the register from Tally as Excel (.xlsx)')
  }
  if (!wb.worksheets.length) throw new Error('That workbook has no sheet in it')
  const txt = (v: unknown): string => String(v ?? '').trim()
  const out: ParsedRegister = { company: '', period: '', from: '', to: '', sheets: [], vouchers: [] }
  const seen = new Map<string, number>()
  for (const ws of wb.worksheets) {
    const grid: Cell[][] = []
    ws.eachRow({ includeEmpty: true }, (row, i) => {
      const cells: Cell[] = []
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        cells[c - 1] = { v: cellValue(cell.value), side: sideOfFormat(cell.numFmt) }
      })
      grid[i - 1] = cells
    })
    const at0 = (r: number): string => txt(grid[r]?.[0]?.v)
    const headAt = grid.findIndex(
      (r) => (r || []).some((c) => /^date$/i.test(txt(c?.v))) && (r || []).some((c) => /^particulars$/i.test(txt(c?.v)))
    )
    if (headAt < 0) continue
    // The heading block: company, address lines, "<Type> Register", period.
    let titleAt = -1
    for (let r = 0; r < headAt; r++) if (/register\s*$/i.test(at0(r))) titleAt = r
    const title = titleAt >= 0 ? at0(titleAt) : txt(ws.name)
    const period = titleAt >= 0 ? at0(titleAt + 1) : ''
    const type = title.replace(/\s*register\s*$/i, '').trim()
    if (!out.company) out.company = at0(0)
    if (kind === 'journal' && !/journal/i.test(title)) {
      out.sheets.push({ title, type, count: 0, skipped: `${title} is not a Journal Register` })
      continue
    }
    if (kind === 'purchase' && !/purc/i.test(title)) {
      out.sheets.push({
        title,
        type,
        count: 0,
        skipped: /sale|service/i.test(title) ? `${title} is a sales register — check it under Sales Register` : `${title} is not a purchase register`
      })
      continue
    }
    const p = periodOf(period)
    if (p.from && (!out.from || p.from < out.from)) out.from = p.from
    if (p.to && (!out.to || p.to > out.to)) out.to = p.to
    if (!out.period) out.period = period
    const head = (grid[headAt] || []).map((c) => txt(c?.v))
    const at = (re: RegExp): number => head.findIndex((h) => re.test(h))
    const iDate = at(/^date$/i)
    const iParty = at(/^particulars$/i)
    const iNo = at(/^voucher\s*no\.?$/i)
    const iRef = at(/^(supplier\s*invoice\s*no\.?|voucher\s*ref\.?\s*no\.?)$/i)
    const iGstin = at(/^gstin\/?\s*uin$/i)
    const iGross = at(/^gross\s*total$/i)
    if (iNo < 0 || iGross < 0) throw new Error(`${title}: the sheet needs its Voucher No. and Gross Total columns`)
    const cols = head.map((h, i) => ({ h, i })).filter(({ h }) => !!h && !SUMMARY.test(h))
    let count = 0
    for (let r = headAt + 1; r < grid.length; r++) {
      const row = grid[r] || []
      const partyRaw = txt(row[iParty]?.v)
      if (/^grand\s*total$/i.test(partyRaw)) continue
      const vchNo = txt(row[iNo]?.v)
      const date = isoDate(row[iDate]?.v)
      if (!vchNo || !date) continue
      const party = partyRaw.replace(/\(\s*cancel+ed\s*\)/i, '').trim()
      const grossCell = row[iGross]
      const grossAmt = round2(n(grossCell?.v))
      // An amount with no side in its format is read the usual way round: a
      // purchase's party is credited and its columns debited, TDS credited.
      const defPartySide: 'Dr' | 'Cr' = kind === 'purchase' ? 'Cr' : 'Dr'
      const lines: TallyLine[] = []
      if (party && Math.abs(grossAmt) > 0.004) {
        const sd = grossCell?.side || defPartySide
        lines.push({ name: party, key: tallyKey(party), dr: sd === 'Dr' ? Math.abs(grossAmt) : 0, cr: sd === 'Cr' ? Math.abs(grossAmt) : 0, party: true })
      }
      for (const { h, i } of cols) {
        const c = row[i]
        const amt = round2(n(c?.v))
        if (Math.abs(amt) <= 0.004) continue
        const sd = c?.side || (kind === 'purchase' ? (TDS_COL.test(h) ? 'Cr' : 'Dr') : defPartySide === 'Dr' ? 'Cr' : 'Dr')
        // A negative figure is the other side.
        const real = amt < 0 ? (sd === 'Dr' ? 'Cr' : 'Dr') : sd
        lines.push({ name: h, key: tallyKey(h), dr: real === 'Dr' ? Math.abs(amt) : 0, cr: real === 'Cr' ? Math.abs(amt) : 0 })
      }
      const dr = round2(lines.reduce((t, l) => t + l.dr, 0))
      const cr = round2(lines.reduce((t, l) => t + l.cr, 0))
      const cancelled = /\(\s*cancel+ed\s*\)/i.test(partyRaw) || lines.length === 0
      const pl = lines.find((l) => l.party)
      let taxable = 0
      let gst = 0
      let tds = 0
      let ro = 0
      for (const l of lines) {
        if (l.party) continue
        const v = round2(l.dr - l.cr)
        if (ROUND_OFF.test(l.name)) ro = round2(ro + v)
        else if (TDS_COL.test(l.name)) tds = round2(tds - v)
        else if (GST_COL.test(l.name)) gst = round2(gst + v)
        else taxable = round2(taxable + v)
      }
      const typeName = kind === 'journal' ? 'JOURNAL' : type
      let key = `${typeName.toUpperCase()}|${vchNo}`
      const dup = seen.get(key) || 0
      seen.set(key, dup + 1)
      if (dup) key = `${key}#${r + 1}`
      out.vouchers.push({
        key,
        sheet: ws.name,
        title,
        type: typeName,
        row: r + 1,
        date,
        vch_no: vchNo,
        ref_no: iRef >= 0 ? txt(row[iRef]?.v) : '',
        gstin: iGstin >= 0 ? txt(row[iGstin]?.v) : '',
        party,
        party_key: tallyKey(party),
        gross: pl ? round2(kind === 'purchase' ? pl.cr - pl.dr : pl.dr + pl.cr) : 0,
        total: dr,
        lines,
        cancelled,
        out_by: round2(dr - cr),
        taxable,
        gst,
        tds,
        round_off: ro
      })
      count++
    }
    out.sheets.push({ title, type: kind === 'journal' ? 'JOURNAL' : type, count })
  }
  if (!out.vouchers.length) {
    const why = out.sheets.find((s) => s.skipped)?.skipped
    throw new Error(why || 'No vouchers found under a Date / Particulars header — upload the register exactly as Tally exports it')
  }
  const dates = out.vouchers.map((x) => x.date).sort()
  if (!out.from) out.from = dates[0]
  if (!out.to) out.to = dates[dates.length - 1]
  // The span of every sheet read, not just the first one's heading.
  out.period = `${dmy(out.from)} to ${dmy(out.to)}`
  return out
}

// ---------------------------------------------------------------------------
// WHAT THESE BOOKS HAVE
// ---------------------------------------------------------------------------

interface BookLine {
  account_id: number
  account: string
  group: string
  dr: number
  cr: number
}

export interface BookVch {
  id: number
  code: string
  type: string
  vch_no: string
  date: string
  narration: string
  order_id: number
  party: string
  party_id: number
  gross: number
  total: number
  taxable: number
  gst: number
  tds: number
  round_off: number
  lines: BookLine[]
}

async function bookVouchers(companyId: number, kind: TallyRegisterKind, from: string, to: string): Promise<BookVch[]> {
  // Purchases: every purchase-series voucher. Journals: every voucher in the
  // window that is not a sale, a purchase or a note — the software posts what
  // Tally calls a journal as a payment or a receipt as often as a journal.
  const where =
    kind === 'purchase'
      ? "UPPER(je.vch_type) LIKE 'PURCHASE%'"
      : "UPPER(je.vch_type) NOT LIKE 'PURCHASE%' AND UPPER(je.vch_type) NOT IN ('SALE', 'SALES', 'CREDIT NOTE', 'DEBIT NOTE') AND substr(je.entry_date, 1, 10) >= ? AND substr(je.entry_date, 1, 10) <= ?"
  const args: (string | number)[] = [companyId]
  if (kind === 'journal') args.push(shiftDays(from, -NEAR_DAYS - 3), shiftDays(to, NEAR_DAYS + 3))
  const rows = toPlain(
    await getClient().execute({
      sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, je.order_id,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code,
                   jl.dr, jl.cr, a.id AS account_id, a.name AS account, a.acc_group
              FROM journal_entries je
              JOIN journal_lines jl ON jl.entry_id = je.id
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.company_id = ? AND ${where}
             ORDER BY je.id, jl.id`,
      args
    }).catch(async (e) => {
      // A database without voucher numbers yet still compares, without codes.
      if (!/voucher_numbers/i.test(String((e as Error)?.message))) throw e
      return getClient().execute({
        sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, je.order_id, NULL AS code,
                     jl.dr, jl.cr, a.id AS account_id, a.name AS account, a.acc_group
                FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN ledger_accounts a ON a.id = jl.account_id
               WHERE je.company_id = ? AND ${where} ORDER BY je.id, jl.id`,
        args
      })
    })
  )
  const by = new Map<number, Row[]>()
  for (const r of rows) {
    const id = Number(r.id)
    if (!by.has(id)) by.set(id, [])
    ;(by.get(id) as Row[]).push(r)
  }
  const out: BookVch[] = []
  for (const [id, ls] of by) {
    const lines: BookLine[] = ls.map((l) => ({
      account_id: Number(l.account_id),
      account: String(l.account),
      group: String(l.acc_group || ''),
      dr: round2(n(l.dr)),
      cr: round2(n(l.cr))
    }))
    // The party of a purchase is the creditor credited — the largest such.
    const crs = lines.filter((l) => l.cr > 0).sort((a, b) => b.cr - a.cr)
    const drs = lines.filter((l) => l.dr > 0).sort((a, b) => b.dr - a.dr)
    const party =
      kind === 'purchase' ? crs.find((l) => l.group === 'Sundry Creditors') || crs.find((l) => !TDS_COL.test(l.account)) || crs[0] : drs[0]
    let taxable = 0
    let gst = 0
    let tds = 0
    let ro = 0
    for (const l of lines) {
      if (l === party) continue
      const v = round2(l.dr - l.cr)
      if (ROUND_OFF.test(l.account)) ro = round2(ro + v)
      else if (TDS_COL.test(l.account)) tds = round2(tds - v)
      else if (GST_COL.test(l.account)) gst = round2(gst + v)
      else taxable = round2(taxable + v)
    }
    out.push({
      id,
      code: String(ls[0].code || ''),
      type: String(ls[0].vch_type || ''),
      vch_no: String(ls[0].vch_no || ''),
      date: String(ls[0].entry_date || '').slice(0, 10),
      narration: String(ls[0].narration || ''),
      order_id: Number(ls[0].order_id) || 0,
      party: party ? party.account : '',
      party_id: party ? party.account_id : 0,
      gross: party ? (kind === 'purchase' ? round2(party.cr - party.dr) : round2(party.dr)) : 0,
      total: round2(lines.reduce((t, l) => t + l.dr, 0)),
      taxable,
      gst,
      tds,
      round_off: ro,
      lines
    })
  }
  return kind === 'purchase' ? mergeBills(out) : out
}

// ONE BILL, ONE VOUCHER TO COMPARE.
//
// A bill of two lines — an inter-company transfer of two tankers, KRFIN/116 —
// is two purchase rows here sharing one bill_group, and each posts its own
// voucher. Tally holds it as the one bill it is. Laid against either half,
// Tally's ₹44.3 L read as "not matching" the ₹10.3 L half. So the halves are
// added back into one voucher before anything is compared: lines summed by
// ledger and side, the figures summed. The first voucher's id stands for the
// bill — re-dating and opening already work on the whole bill_group from it.
async function mergeBills(vs: BookVch[]): Promise<BookVch[]> {
  const orderIds = [...new Set(vs.map((v) => v.order_id).filter((x) => x > 0))]
  if (!orderIds.length) return vs
  const groupOf = new Map<number, string>()
  for (let i = 0; i < orderIds.length; i += 400) {
    const chunk = orderIds.slice(i, i + 400)
    const rs = await getClient().execute({
      sql: `SELECT id, bill_group FROM orders WHERE id IN (${chunk.map(() => '?').join(',')}) AND COALESCE(bill_group, '') <> ''`,
      args: chunk
    })
    for (const r of rs.rows as unknown as Row[]) groupOf.set(Number(r.id), String(r.bill_group))
  }
  if (!groupOf.size) return vs
  const out: BookVch[] = []
  const byGroup = new Map<string, BookVch>()
  for (const v of vs) {
    const g = groupOf.get(v.order_id)
    if (!g) {
      out.push(v)
      continue
    }
    const into = byGroup.get(g)
    if (!into) {
      const copy: BookVch = { ...v, lines: v.lines.map((l) => ({ ...l })) }
      byGroup.set(g, copy)
      out.push(copy)
      continue
    }
    for (const l of v.lines) {
      const side = l.dr > 0 ? 'dr' : 'cr'
      const hit = into.lines.find((x) => x.account_id === l.account_id && (side === 'dr' ? x.dr > 0 : x.cr > 0))
      if (hit) {
        hit.dr = round2(hit.dr + l.dr)
        hit.cr = round2(hit.cr + l.cr)
      } else into.lines.push({ ...l })
    }
    into.gross = round2(into.gross + v.gross)
    into.total = round2(into.total + v.total)
    into.taxable = round2(into.taxable + v.taxable)
    into.gst = round2(into.gst + v.gst)
    into.tds = round2(into.tds + v.tds)
    into.round_off = round2(into.round_off + v.round_off)
  }
  return out
}

// ---------------------------------------------------------------------------
// LAYING ONE AGAINST THE OTHER
// ---------------------------------------------------------------------------

type Mapped = Map<string, { account_id: number; account_name: string; how: 'saved' | 'auto' }>

/** Tally's purchase party and the books' are one: by the remembered map, or by name. */
function sameParty(t: TallyVch, b: BookVch, mapped: Mapped): boolean {
  if (!t.party || !b.party) return false
  const m = mapped.get(t.party_key)
  if (m && m.account_id === b.party_id) return true
  return companyKey(t.party) === companyKey(b.party)
}

/**
 * Does this line here stand for that Tally name? By the remembered map when
 * the name is mapped; otherwise only by the name itself (SIDDHARTH OILS for
 * "Siddharth Oils (Cr)") — never by a guess at a different ledger.
 */
function sameLedger(l: TallyLine, p: BookLine, mapped: Mapped): boolean {
  const m = mapped.get(l.key)
  if (m) return p.account_id === m.account_id
  return tallyKey(p.account) === l.key || companyKey(p.account) === companyKey(l.name)
}

/** How many of Tally's lines the books' voucher carries — same ledger, same side, same amount. */
function lineScore(t: TallyVch, b: BookVch, mapped: Mapped): { hit: number; known: number } {
  const pool = b.lines.map((l) => ({ ...l, used: false }))
  let hit = 0
  let known = 0
  for (const l of t.lines) {
    const want = l.dr > 0 ? 'dr' : 'cr'
    const amt = l.dr || l.cr
    const f = pool.find((p) => !p.used && sameLedger(l, p, mapped) && Math.abs(p[want] - amt) <= 1)
    if (mapped.get(l.key) || f) known++
    if (f) {
      f.used = true
      hit++
    }
  }
  return { hit, known }
}

/** Line by line, what Tally posts against what the books posted — for a voucher that does not agree. */
function lineDiffs(t: TallyVch, b: BookVch, mapped: Mapped): Row[] {
  const out: Row[] = []
  const pool = b.lines.map((l) => ({ ...l, used: false }))
  for (const l of t.lines) {
    const side = l.dr > 0 ? 'Dr' : 'Cr'
    const amt = l.dr || l.cr
    const f = pool.find((p) => !p.used && sameLedger(l, p, mapped) && (side === 'Dr' ? p.dr > 0 : p.cr > 0))
    if (f) {
      f.used = true
      const here = side === 'Dr' ? f.dr : f.cr
      if (Math.abs(here - amt) > 1) out.push({ name: l.name, side, tally: amt, books: here })
    } else out.push({ name: l.name, side, tally: amt, books: null, unmapped: !mapped.get(l.key) })
  }
  for (const p of pool) if (!p.used) out.push({ name: p.account, side: p.dr > 0 ? 'Dr' : 'Cr', tally: null, books: p.dr || p.cr })
  return out
}

const shortBook = (b: BookVch): Row => ({
  id: b.id,
  code: b.code,
  type: b.type,
  vch_no: b.vch_no,
  date: b.date,
  party: b.party,
  party_id: b.party_id,
  gross: b.gross,
  total: b.total,
  taxable: b.taxable,
  gst: b.gst,
  tds: b.tds,
  round_off: b.round_off,
  order_id: b.order_id,
  narration: b.narration,
  lines: drFirst(b.lines).map((l) => ({ name: l.account, dr: l.dr, cr: l.cr }))
})

const shortTally = (t: TallyVch): Row => ({
  key: t.key,
  type: t.type,
  title: t.title,
  date: t.date,
  vch_no: t.vch_no,
  ref_no: t.ref_no,
  gstin: t.gstin,
  party: t.party,
  gross: t.gross,
  total: t.total,
  taxable: t.taxable,
  gst: t.gst,
  tds: t.tds,
  round_off: t.round_off,
  cancelled: t.cancelled,
  out_by: t.out_by,
  lines: drFirst(t.lines).map((l) => ({ name: l.name, dr: l.dr, cr: l.cr }))
})

/** Why a purchase cannot be booked from Tally whatever is mapped — it has a home of its own. */
function purchaseRoute(t: TallyVch): 'purchases' | 'freight_in' | 'freight_out' | null {
  const f = family(t.type)
  if (f === 'OIL') return 'purchases'
  if (f === 'FREIGHT IN') return 'freight_in'
  if (f === 'FREIGHT OUT') return 'freight_out'
  return null
}

interface Reconciled {
  reg: ParsedRegister
  books: BookVch[]
  mapped: Mapped
  rows: Row[]
}

async function reconcile(v: { kind: TallyRegisterKind; data_base64: string; company_id?: number; tolerance?: number }): Promise<Reconciled> {
  const kind: TallyRegisterKind = v.kind === 'journal' ? 'journal' : 'purchase'
  const cid = await companyOf(v)
  const reg = await parsedFile(`register:${kind}`, String(v.data_base64 || ''), () => parseTallyRegister(String(v.data_base64 || ''), kind))
  const books = await booksRead(`register:${kind}:${cid}:${reg.from}:${reg.to}`, () => bookVouchers(cid, kind, reg.from, reg.to))
  const names = new Set<string>()
  for (const t of reg.vouchers) for (const l of t.lines) names.add(l.name)
  const mapped: Mapped = await resolveNames([...names])
  const used = new Set<number>()
  const rows: Row[] = []
  // HOW CLOSE IS THE SAME. ₹1 by default. A supplier's printed bill and
  // quantity × rate here can part by a few rupees of rounding (Dil Exim's ₹2,
  // ₹9), and the desk can widen this on the screen so those read as matched.
  const tol = Math.min(1000, Math.max(1, Number(v.tolerance) || 1))
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= tol + 1e-9
  // The same bill with TDS posted on one side only: Tally deducted it on the
  // purchase, these books (below their slab) did not — the totals part by
  // exactly that TDS, and it is still the same bill.
  // More generally the two split one bill between "payable" and "TDS"
  // differently — KRFIN/94: Tally 53,41,131 + TDS 5,092, here 53,46,131.52 +
  // TDS 91.64 — and payable + TDS is the bill on both sides.
  const sameBill = (t: TallyVch, b: BookVch): boolean =>
    close(b.gross, t.gross) || close(b.gross, t.gross + t.tds) || close(b.gross + b.tds, t.gross) || close(b.gross + b.tds, t.gross + t.tds)
  // Names that are plainly one party though spelt apart: "Legacy Commodities
  // Pvt Ltd, Delhi" and "LEGACY COMMODITIES PRIVATE LIMITED" — two words in
  // common past the Pvt/Ltd noise, the first of them the same.
  const looseParty = (t: TallyVch, b: BookVch): boolean => {
    const words = (s: string): string[] =>
      String(s || '')
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'CO', 'THE', 'AND', 'OF', 'CR', 'DR', 'MS'].includes(w))
    const a = words(t.party)
    const bb = words(b.party)
    if (!a.length || !bb.length || a[0] !== bb[0]) return false
    const set = new Set(bb)
    return a.filter((w) => set.has(w)).length >= Math.min(2, a.length, bb.length)
  }
  const partyLike = (t: TallyVch, b: BookVch, m: Mapped): boolean => sameParty(t, b, m) || looseParty(t, b)

  // What the desk has already said is the same voucher comes first — as
  // matched, whatever the numbers or the ledgers look like.
  const linked = await linksFor(cid, kind)
  const handled = new Set<string>()
  for (const t of reg.vouchers) {
    const id = linked.get(t.key)
    const b = id ? books.find((x) => x.id === id && !used.has(x.id)) : undefined
    if (!b) continue
    used.add(b.id)
    handled.add(t.key)
    const diffs: Row[] = []
    if (t.date !== b.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
    const tAmt = kind === 'journal' ? t.total : t.gross
    const bAmt = kind === 'journal' ? b.total : b.gross
    if (!close(tAmt, bAmt)) diffs.push({ field: kind === 'journal' ? 'lines' : 'gross', tally: tAmt, books: bAmt, diff: round2(tAmt - bAmt), lines: kind === 'journal' ? lineDiffs(t, b, mapped) : undefined })
    rows.push({ key: t.key, status: t.cancelled ? 'cancelled_here' : diffs.length ? 'mismatch' : 'matched', tally: shortTally(t), books: shortBook(b), diffs: t.cancelled ? [] : diffs, linked: true })
  }

  if (kind === 'purchase') {
    const byInv = new Map<string, BookVch[]>()
    for (const b of books) {
      const k = invKey(b.vch_no)
      if (!k) continue
      if (!byInv.has(k)) byInv.set(k, [])
      ;(byInv.get(k) as BookVch[]).push(b)
    }
    const pending: TallyVch[] = []
    for (const t of reg.vouchers) {
      if (handled.has(t.key)) continue
      // Short supplier numbers (0104, 01) repeat across suppliers: a number
      // only finds the bill together with the supplier, or the same amount.
      //
      // BY EITHER NUMBER. Tally keeps the supplier's bill number as the
      // reference and its own as the voucher number — and a bill booked here
      // from an inter-company transfer carries the voucher number (KRFIN/94 in
      // Tally's reference, 178 on both sides as the voucher). The reference is
      // tried first; the voucher number only with the same party.
      const byRef = (byInv.get(invKey(t.ref_no || t.vch_no)) || []).filter(
        (b) => !used.has(b.id) && (partyLike(t, b, mapped) || sameBill(t, b))
      )
      const byVch =
        byRef.length || !t.ref_no || !t.vch_no
          ? []
          : (byInv.get(invKey(t.vch_no)) || []).filter((b) => !used.has(b.id) && partyLike(t, b, mapped) && sameBill(t, b))
      const hits = byRef.length ? byRef : byVch
      hits.sort((a, b) => Number(partyLike(t, b, mapped)) - Number(partyLike(t, a, mapped)) || daysApart(a.date, t.date) - daysApart(b.date, t.date))
      const b = hits[0]
      if (!b) {
        pending.push(t)
        continue
      }
      used.add(b.id)
      if (t.cancelled) {
        rows.push({ key: t.key, status: 'cancelled_here', tally: shortTally(t), books: shortBook(b), diffs: [] })
        continue
      }
      const diffs: Row[] = []
      if (t.date !== b.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
      if (!partyLike(t, b, mapped)) diffs.push({ field: 'party', tally: t.party, books: b.party })
      if (family(t.type) !== family(b.type)) diffs.push({ field: 'type', tally: purchaseTypeOf(t.type), books: b.type })
      for (const f of ['taxable', 'gst', 'tds', 'gross'] as const) {
        if (!close(t[f], b[f])) diffs.push({ field: f, tally: t[f], books: b[f], diff: round2(t[f] - b[f]) })
      }
      if (hits.length > 1 && hits.slice(1).some((h) => sameParty(t, h, mapped) && close(h.gross, t.gross))) {
        diffs.push({ field: 'duplicate', tally: 1, books: hits.filter((h) => sameParty(t, h, mapped) && close(h.gross, t.gross)).length })
      }
      rows.push({ key: t.key, status: diffs.length ? 'mismatch' : 'matched', tally: shortTally(t), books: shortBook(b), diffs })
    }
    // Not found by number: the same supplier and amount within a week, under
    // another number, is a possible match — never booked without a word.
    for (const t of pending) {
      if (t.cancelled) {
        rows.push({ key: t.key, status: 'cancelled', tally: shortTally(t), books: null, diffs: [] })
        continue
      }
      const look = books
        .filter((b) => !used.has(b.id) && sameBill(t, b) && daysApart(b.date, t.date) <= NEAR_DAYS && partyLike(t, b, mapped))
        .sort((a, b) => daysApart(a.date, t.date) - daysApart(b.date, t.date))[0]
      if (look) {
        used.add(look.id)
        rows.push({ key: t.key, status: 'possible', tally: shortTally(t), books: shortBook(look), diffs: [] })
      } else rows.push({ key: t.key, status: 'missing_here', tally: shortTally(t), books: null, diffs: [] })
    }
    // In these books, in the file's period and in a register the file has, and
    // not in Tally at all.
    const families = new Set(reg.sheets.filter((s) => !s.skipped).map((s) => family(s.type)))
    for (const b of books) {
      if (used.has(b.id) || b.date < reg.from || b.date > reg.to || !families.has(family(b.type))) continue
      rows.push({ key: `BOOKS|${b.id}`, status: 'missing_tally', tally: null, books: shortBook(b), diffs: [] })
    }
  } else {
    // By number first: a journal booked from Tally keeps Tally's number.
    const journals = books.filter((b) => b.type.toUpperCase() === 'JOURNAL')
    const byNo = new Map<string, BookVch>()
    for (const b of journals) if (b.vch_no) byNo.set(b.vch_no.trim().toUpperCase(), b)
    const rest: TallyVch[] = []
    // Tally's journal behind each row matched to a copy booked from Tally.
    const byNumber = new Map<string, { t: TallyVch; row: Row; copy: BookVch }>()
    for (const t of reg.vouchers) {
      if (handled.has(t.key)) continue
      const b = byNo.get(t.vch_no.trim().toUpperCase())
      if (b && !used.has(b.id) && /imported from tally/i.test(b.narration)) {
        used.add(b.id)
        if (t.cancelled) {
          rows.push({ key: t.key, status: 'cancelled_here', tally: shortTally(t), books: shortBook(b), diffs: [] })
          continue
        }
        const ld = lineDiffs(t, b, mapped)
        const diffs: Row[] = []
        if (t.date !== b.date) diffs.push({ field: 'date', tally: t.date, books: b.date })
        if (ld.length) diffs.push({ field: 'lines', tally: t.total, books: b.total, lines: ld })
        const row: Row = { key: t.key, status: diffs.length ? 'mismatch' : 'matched', tally: shortTally(t), books: shortBook(b), diffs }
        rows.push(row)
        if (!ld.length) byNumber.set(t.key, { t, row, copy: b })
      } else rest.push(t)
    }

    // A VOUCHER A DOCUMENT POSTED HERE, AND TALLY'S OWN JOURNALS FOR IT. A
    // discounted bill opened here (B4: Dr Bunge, Cr Bills Discounted
    // 1,34,80,000 on RCP/18) is two journals in Tally (95,00,000 + 39,80,000);
    // an LC that matured here (JV/15: Dr Siddharth, interest, charges, Cr LC
    // Payable 46,00,000) is one journal in Tally under Tally's own ledger names
    // (LC WITH HDFC BANK LTD, INTEREST (LC)). Tally's journals that add up to
    // such a voucher — the same main Dr and Cr ledger (by the map, or the same
    // first word of the name), within a week — are that voucher, not missing:
    // never offered to book. One already booked from Tally is a copy — the
    // same money in these books twice — said so on its row, with the copy to
    // take back.
    const fromTally = (b: BookVch): boolean => /imported from tally/i.test(b.narration)
    const NOISE = new Set(['M', 'S', 'MS', 'THE', 'SHRI', 'SRI', 'NEW'])
    const firstWord = (v: string): string =>
      String(v || '')
        .toUpperCase()
        // The app's discounted-bill ledgers carry a prefix Tally's may not:
        // "BILLS DISCOUNTED - INFOTEL FINANCE" is Tally's "INFOTEL FINANCE PVT
        // LTD (NEW 1 CR.)", the same lender. (LC names keep theirs — "LC" is
        // what pairs LC PAYABLE with Tally's LC WITH …)
        .replace(/^\s*BILLS DISCOUNTED\s*-?\s*/, '')
        .replace(/[^A-Z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w && !NOISE.has(w))[0] || ''
    const kin = (l: TallyLine, p: BookLine): boolean => sameLedger(l, p, mapped) || (!!firstWord(l.name) && firstWord(l.name) === firstWord(p.account))
    const top = <T extends { dr: number; cr: number }>(ls: T[], side: 'dr' | 'cr'): T | undefined => ls.filter((l) => l[side] > 0).sort((a, b) => b[side] - a[side])[0]
    const owners = books.filter((b) => !used.has(b.id) && !fromTally(b) && b.total > 0 && b.date >= shiftDays(reg.from, -NEAR_DAYS) && b.date <= shiftDays(reg.to, NEAR_DAYS))
    const partTaken = new Set<string>()
    const coveredBy = new Map<string, BookVch>()
    for (const b of owners.sort((x, y) => y.total - x.total)) {
      const bDr = top(b.lines, 'dr')
      const bCr = top(b.lines, 'cr')
      if (!bDr || !bCr) continue
      const fits = (t: TallyVch): boolean => {
        if (t.cancelled || partTaken.has(t.key) || t.total > b.total + tol || daysApart(t.date, b.date) > NEAR_DAYS) return false
        const tDr = top(t.lines, 'dr')
        const tCr = top(t.lines, 'cr')
        // Its main Cr the voucher's main Cr; its main Dr ANY of the voucher's
        // Dr ledgers — Tally journals a bill's interest on its own (Dr
        // Interest, Cr Bills Discounted) beside the supplier's part.
        return !!tDr && !!tCr && kin(tCr, bCr) && b.lines.some((l) => l.dr > 0 && kin(tDr, l))
      }
      // Tally's own journals still unmatched, and those already booked from
      // Tally — alone (the whole amount) or as parts. The fewest parts win,
      // so a whole-amount journal is taken before any split.
      const loose = rest.filter((t) => fits(t))
      const copies = [...byNumber.values()].filter((x) => fits(x.t)).map((x) => x.t)
      const cands = [...loose, ...copies].sort((x, y) => daysApart(x.date, b.date) - daysApart(y.date, b.date)).slice(0, 14)
      if (!cands.length) continue
      // The fewest parts, nearest in date, that make the voucher's amount.
      let best = 0
      let bestScore = Infinity
      for (let m = 1; m < 1 << cands.length; m++) {
        let sum = 0
        let k = 0
        let gap = 0
        for (let i = 0; i < cands.length; i++)
          if (m & (1 << i)) {
            sum += cands[i].total
            k++
            gap += daysApart(cands[i].date, b.date)
          }
        if (!close(sum, b.total)) continue
        const score = k * 100 + gap
        if (score < bestScore) {
          bestScore = score
          best = m
        }
      }
      if (!best) continue
      // A lone copy must look like the voucher line by line too — its main
      // ledger the same amount, not only the same total.
      const parts0 = cands.filter((_, i) => best & (1 << i))
      if (parts0.length === 1) {
        const tDr = top(parts0[0].lines, 'dr') as TallyLine
        if (Math.abs(tDr.dr - bDr.dr) > Math.max(1, tol)) continue
      }
      used.add(b.id)
      const parts = cands.filter((_, i) => best & (1 << i))
      // Tally's parts on one day can move the voucher to it; on several, not.
      const of = { id: b.id, code: b.code, vch_no: b.vch_no, total: b.total, date: b.date, parts: parts.length, one_day: new Set(parts.map((t) => t.date)).size === 1 }
      for (const t of parts) {
        partTaken.add(t.key)
        const copy = byNumber.get(t.key)
        if (copy) {
          copy.row.copy_of = of
          copy.row.status = 'mismatch'
          ;(copy.row.diffs as Row[]).push({ field: 'copy', tally: 1, books: 2 })
          continue
        }
        coveredBy.set(t.key, b)
        rows.push({
          key: t.key,
          status: t.date === b.date ? 'matched' : 'mismatch',
          tally: shortTally(t),
          books: shortBook(b),
          diffs: t.date === b.date ? [] : [{ field: 'date', tally: t.date, books: b.date }],
          part_of: of
        })
      }
    }
    if (coveredBy.size) for (let i = rest.length - 1; i >= 0; i--) if (coveredBy.has(rest[i].key)) rest.splice(i, 1)
    // Then by what it posts. Every pairing that could be the same voucher is
    // scored, and the closest are taken first, so one voucher here answers
    // for one journal in Tally at most.
    const pairs: { t: TallyVch; b: BookVch; full: boolean; hit: number; gap: number }[] = []
    for (const t of rest) {
      if (t.cancelled || t.total <= 0) continue
      for (const b of books) {
        if (used.has(b.id) || !close(b.total, t.total)) continue
        const gap = daysApart(b.date, t.date)
        if (gap > NEAR_DAYS) continue
        const s = lineScore(t, b, mapped)
        const allKnown = s.known === t.lines.length
        const full = allKnown && s.hit === t.lines.length && b.lines.length === t.lines.length
        // A look-alike needs a ledger in common — two salary journals of the
        // same figure are not the same voucher — unless Tally's names are not
        // mapped yet and the dates are the same or next to each other.
        if (!full && s.hit === 0 && !(s.known < t.lines.length && gap <= 2)) continue
        pairs.push({ t, b, full, hit: s.hit, gap })
      }
    }
    pairs.sort((x, y) => Number(y.full) - Number(x.full) || x.gap - y.gap || y.hit - x.hit)
    const taken = new Set<string>()
    const found = new Map<string, { b: BookVch; full: boolean }>()
    for (const p of pairs) {
      if (taken.has(p.t.key) || used.has(p.b.id)) continue
      taken.add(p.t.key)
      used.add(p.b.id)
      found.set(p.t.key, { b: p.b, full: p.full })
    }
    for (const t of rest) {
      if (t.cancelled) {
        rows.push({ key: t.key, status: 'cancelled', tally: shortTally(t), books: null, diffs: [] })
        continue
      }
      const f = found.get(t.key)
      if (!f) {
        rows.push({ key: t.key, status: 'missing_here', tally: shortTally(t), books: null, diffs: [] })
        continue
      }
      const diffs: Row[] = []
      if (t.date !== f.b.date) diffs.push({ field: 'date', tally: t.date, books: f.b.date })
      if (!f.full) diffs.push({ field: 'lines', tally: t.total, books: f.b.total, lines: lineDiffs(t, f.b, mapped) })
      rows.push({
        key: t.key,
        status: f.full ? (diffs.length ? 'mismatch' : 'matched') : 'possible',
        tally: shortTally(t),
        books: shortBook(f.b),
        diffs
      })
    }
    for (const b of journals) {
      if (used.has(b.id) || b.date < reg.from || b.date > reg.to) continue
      rows.push({ key: `BOOKS|${b.id}`, status: 'missing_tally', tally: null, books: shortBook(b), diffs: [] })
    }
  }
  explain(rows, kind)
  return { reg, books, mapped, rows }
}

// ---------------------------------------------------------------------------
// WHAT EACH LINE MEANS, IN WORDS — and what to do about it.
// ---------------------------------------------------------------------------

const FIELD_WORD: Record<string, string> = {
  date: 'date',
  party: 'supplier',
  type: 'voucher type',
  taxable: 'taxable value',
  gst: 'GST',
  tds: 'TDS',
  gross: 'bill total'
}

function explain(rows: Row[], kind: TallyRegisterKind): void {
  for (const r of rows) {
    const t = r.tally as Row | null
    const b = r.books as Row | null
    const say: string[] = []
    let fix = ''
    const what = kind === 'journal' ? 'journal' : 'purchase'
    const tName = t ? (kind === 'journal' ? `No. ${t.vch_no}` : `${t.ref_no || t.vch_no} (${t.type} No. ${t.vch_no})`) : ''
    const bName = b ? `${b.code || b.type}${b.vch_no ? ` · ${b.vch_no}` : ''}` : ''
    if (r.status === 'missing_here' && t) {
      say.push(`In Tally on ${dmy(t.date)}${t.party ? ` for ${t.party}` : ''}, ${inr(kind === 'journal' ? t.total : t.gross)} — ${tName} — but nothing like it is in these books.`)
      if (kind === 'purchase') {
        const route = purchaseRoute(t as unknown as TallyVch)
        fix =
          route === 'purchases'
            ? 'An oil purchase comes in through Purchases — enter the bill on its order there, so the stock and the order follow. It is not booked from here.'
            : route === 'freight_in'
              ? "Freight on purchases is billed in Accounting → Fr. Inward (the transporter's bill against its trips). It is not booked from here."
              : route === 'freight_out'
                ? "Freight on sales is billed in Accounting → Fr. Outward (the transporter's bill against its trips). It is not booked from here."
                : `Book it from Tally — it posts as a ${purchaseTypeOf(String(t.type))} voucher under the supplier's invoice number.`
      } else fix = 'Book it from Tally — it posts as a JOURNAL voucher under Tally’s number.'
      if (Math.abs(n(t.out_by)) > 1) {
        say.push(`Its Dr and Cr do not agree in the file (out by ${inr(n(t.out_by))}).`)
        fix = 'Correct it in Tally and export again — a voucher that does not balance is not booked.'
      }
    } else if (r.status === 'possible' && t && b) {
      say.push(
        `Tally has ${tName} on ${dmy(t.date)} for ${inr(kind === 'journal' ? t.total : t.gross)}. These books have ${bName} on ${dmy(b.date)} for ${inr(kind === 'journal' ? b.total : b.gross)}${kind === 'purchase' ? ` from ${b.party}` : ''} — very likely the same ${what}, under ${kind === 'journal' ? 'the software’s own number' : 'another invoice number'}.`
      )
      const ld = ((r.diffs as Row[]).find((d) => d.field === 'lines')?.lines as Row[]) || []
      const loose = ld.filter((d) => d.unmapped)
      const real = ld.filter((d) => !d.unmapped && !(d.tally == null && loose.some((u) => u.side === d.side && Math.abs(n(u.tally) - n(d.books)) <= 1)))
      if (loose.length)
        say.push(`${loose.length === 1 ? 'One of Tally’s names is' : `${loose.length} of Tally’s names are`} not mapped to a ledger here yet (${loose.map((d) => d.name).join(', ')}), so ${loose.length === 1 ? 'that line' : 'those lines'} cannot be compared one by one — the amounts agree.`)
      if (real.length) say.push(`Where they part: ${real.slice(0, 4).map((d) => `${d.side} ${d.name} ${d.tally == null ? 'only here' : d.books == null ? 'only in Tally' : `${inr(d.tally)} in Tally, ${inr(d.books)} here`}`).join('; ')}${real.length > 4 ? '…' : ''}.`)
      fix = loose.length
        ? `Map ${loose.length === 1 ? 'that name' : 'those names'} (Book from Tally → Ledgers) and check again — if every line then agrees, it shows as Matched. If it is a different ${what}, book it and tick "Book anyway".`
        : `If it is the same ${what}, nothing needs doing. If it is a different one, book it from Tally and tick "Book anyway".`
    } else if (r.status === 'mismatch' && t && b) {
      for (const d of r.diffs as Row[]) {
        if (d.field === 'date') say.push(`Dated ${dmy(d.tally)} in Tally, ${dmy(d.books)} here.`)
        else if (d.field === 'party') say.push(`Supplier ${d.tally} in Tally, ${d.books} here.`)
        else if (d.field === 'type') say.push(`Booked as ${d.books} here; Tally has it under ${d.tally}.`)
        else if (d.field === 'copy') continue
        else if (d.field === 'duplicate') say.push(`This bill is in these books ${d.books} times — the extra voucher doubles it.`)
        else if (d.field === 'lines') {
          const ld = (d.lines as Row[]) || []
          say.push(`The lines differ: ${ld.slice(0, 4).map((x) => `${x.side} ${x.name} ${x.tally == null ? 'only here' : x.books == null ? 'only in Tally' : `${inr(x.tally)} in Tally, ${inr(x.books)} here`}`).join('; ')}${ld.length > 4 ? '…' : ''}.`)
        } else say.push(`${FIELD_WORD[d.field] || d.field} ${inr(d.tally)} in Tally, ${inr(d.books)} here (${d.diff > 0 ? 'Tally higher' : 'here higher'} by ${inr(d.diff)}).`)
      }
      fix = (r.diffs as Row[]).some((d) => d.field === 'duplicate')
        ? 'Delete the extra voucher here.'
        : (r.diffs as Row[]).every((d) => d.field === 'date')
          ? 'Correct the date on whichever side is wrong.'
          : `Open the ${what} here and correct it to the bill — or correct Tally, if Tally is the one that is wrong.`
    } else if (r.status === 'missing_tally' && b) {
      say.push(`In these books (${bName}, ${dmy(b.date)}${b.party ? `, ${b.party}` : ''}, ${inr(kind === 'journal' ? b.total : b.gross)}) but not in Tally's register for the period.`)
      fix =
        kind === 'journal'
          ? 'Tally may hold it under another voucher type (Payment, Receipt). If it is not in Tally at all, enter it there.'
          : 'Enter it in Tally under the same supplier invoice number — or delete it here if it was entered by mistake.'
    } else if (r.status === 'cancelled_here' && b) {
      say.push(`Tally shows ${tName} cancelled, but these books still carry ${bName}.`)
      fix = 'Delete it here if the cancellation in Tally is right.'
    } else if (r.status === 'cancelled') {
      say.push('Cancelled in Tally, and not in these books either.')
    }
    // Part of one voucher here, or a copy of one — said whatever the status.
    const of = (r.part_of || r.copy_of) as Row | undefined
    if (of && t) {
      const ofName = `${String(of.code || 'the voucher')}${of.vch_no ? ` · ${String(of.vch_no)}` : ''}`
      if (r.part_of) {
        say.unshift(
          n(of.parts) > 1
            ? `One of ${n(of.parts)} journals in Tally that together make ${ofName} here (${inr(n(of.total))}, ${dmy(String(of.date))}) — the same entry, split in Tally.`
            : `The same entry as ${ofName} here (${inr(n(of.total))}, ${dmy(String(of.date))}), posted by its own document.`
        )
        fix = (r.diffs as Row[]).some((d) => d.field === 'date') && of.one_day ? fix : ''
      } else {
        say.unshift(
          `${String(b?.code || 'This voucher')} was booked from Tally, but ${ofName} — posted by its own document — already carries it: ${n(of.parts) > 1 ? `Tally's ${n(of.parts)} journals together make its ${inr(n(of.total))}` : `the same ${inr(n(of.total))} on ${dmy(String(of.date))}`}. The same money is in these books twice.`
        )
        fix = `Reverse ${String(b?.code || 'this copy')} (booked from Tally). ${String(of.code || 'The document voucher')} stays, and stands for Tally's No. ${String(t.vch_no)} on the next check.`
      }
    }
    r.explain = say
    r.fix = fix
  }
}

// ---------------------------------------------------------------------------
// THE CHECK, AS THE SCREEN READS IT
// ---------------------------------------------------------------------------

export async function checkTallyRegister(v: { kind: TallyRegisterKind; data_base64: string; file_name?: string; company_id?: number; tolerance?: number }): Promise<Row> {
  const kind: TallyRegisterKind = v.kind === 'journal' ? 'journal' : 'purchase'
  const cid = await companyOf(v)
  const { reg, rows } = await reconcile({ ...v, kind, company_id: cid })
  const companyName = String(
    ((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || ''
  )
  const count = (s: string): number => rows.filter((r) => r.status === s).length
  const amt = (x: Row | null): number => (x ? n(kind === 'journal' ? x.total : x.gross) : 0)
  const route = (r: Row): string | null => (kind === 'purchase' && r.tally ? purchaseRoute(r.tally as TallyVch) : null)
  // Which lines "Use Tally's date" can move: a date that differs on a voucher
  // the software may re-date (an oil purchase, or one booked by hand or from
  // Tally). One another document wrote is changed there, and says so.
  const { ownedVoucherIds } = await import('./voucherOwnership')
  const owned = await ownedVoucherIds()
  const bdMovable = await bdMovableEntryIds()
  for (const r of rows) {
    const dateDiff = ((r.diffs as Row[]) || []).some((d) => d.field === 'date')
    if (r.status === 'mismatch' && dateDiff && r.books?.id && r.tally?.date && !(r.part_of && !r.part_of.one_day)) {
      const id = Number(r.books.id)
      r.redate = Number(r.books.order_id) > 0 || !owned.has(id) || bdMovable.has(id) ? 'yes' : 'owned'
    }
  }
  // WHICH REGISTER EACH ROW BELONGS TO — a Tally bill by its own sheet, a
  // bill here with no Tally match by the sheet of its family (the same rule
  // the matching uses), so a register picked on screen counts its own bills
  // on both sides.
  const famSheet = new Map(reg.sheets.filter((s) => !s.skipped).map((s) => [family(s.type), s.type]))
  for (const r of rows) {
    r.reg_type = r.tally ? String(r.tally.type || '') : r.books ? famSheet.get(family(String(r.books.type || ''))) || '' : ''
  }
  for (const r of rows) {
    r.route = route(r)
    r.bookable = (r.status === 'missing_here' || r.status === 'possible') && !!r.tally && !r.tally.cancelled && !r.route && Math.abs(n(r.tally.out_by)) <= 1
  }
  return {
    kind,
    file_name: String(v.file_name || ''),
    file_company: reg.company,
    company: companyName,
    company_mismatch: !!reg.company && !!companyName && companyKey(reg.company) !== companyKey(companyName),
    period: reg.period,
    from: reg.from,
    to: reg.to,
    sheets: reg.sheets.map((s) => ({
      ...s,
      family: family(s.type),
      route: kind === 'purchase' && !s.skipped ? purchaseRoute({ type: s.type } as TallyVch) : null,
      missing: rows.filter((r) => r.tally && r.tally.type === s.type && r.status === 'missing_here').length
    })),
    counts: {
      matched: count('matched'),
      mismatch: count('mismatch'),
      possible: count('possible'),
      missing_here: count('missing_here'),
      missing_tally: count('missing_tally'),
      cancelled: count('cancelled'),
      cancelled_here: count('cancelled_here')
    },
    totals: {
      tally: round2(rows.filter((r) => r.tally && !r.tally.cancelled).reduce((t, r) => t + amt(r.tally), 0)),
      books: round2(rows.filter((r) => r.books && r.status !== 'cancelled_here').reduce((t, r) => t + amt(r.books), 0))
    },
    rows: rows.sort(
      (a, b) =>
        String((a.tally || a.books).date).localeCompare(String((b.tally || b.books).date)) ||
        String(a.tally?.vch_no || a.books?.code || '').localeCompare(String(b.tally?.vch_no || b.books?.code || ''), undefined, { numeric: true })
    )
  }
}

// ---------------------------------------------------------------------------
// BOOKING WHAT IS MISSING
// ---------------------------------------------------------------------------

function groupFor(kind: TallyRegisterKind) {
  return (name: string, role: 'party' | 'ledger'): string => {
    const s = name.toUpperCase()
    if (role === 'party') return 'Sundry Creditors'
    if (GST_COL.test(s) || TDS_COL.test(s)) return 'Duties & Taxes'
    if (/ROUND\s*OFF/.test(s)) return 'Indirect Expenses'
    if (/FREIGHT|CARTAGE/.test(s)) return 'Direct Expenses'
    if (/INCOME|WRITTEN\s*BACK|REBATE|DISCOUNT\s*RECEIVED/.test(s)) return 'Indirect Incomes'
    if (/MACHINERY|PLANT|FURNITURE|FIXT|VEHICLE|CAR\b|MERCEDES|EQUIPMENT|EQUPMENT|CCTV|BUILDING\s*MAT/.test(s)) return 'Fixed Assets'
    if (/SALARY|WAGES|INTEREST|CHARGES|EXP|FEE|RENT|REPAIR|MAINT|WELFARE|TRAVEL|CONVEYANCE|PENALTY|BROKERAGE|BROKRAGE|COMMISSION|PRINTING|STATIONAR|PROFESSIONAL|RETAINER|SECURITY|LABOUR|ELECTRICITY|MEDICAL|LEGAL/.test(s))
      return 'Indirect Expenses'
    if (kind === 'purchase' && /PUR|PACKING|CHEMICAL|HUSK|OIL|CONSUM|GOODS|MATERIAL|MATRIEL/.test(s)) return 'Purchase Accounts'
    return kind === 'purchase' ? 'Purchase Accounts' : ''
  }
}

/** The lines asked for, what stops any of them, and every name they use with its mapping. */
export async function previewTallyRegisterVouchers(v: { kind: TallyRegisterKind; data_base64: string; keys: string[]; company_id?: number }): Promise<Row> {
  const kind: TallyRegisterKind = v.kind === 'journal' ? 'journal' : 'purchase'
  const cid = await companyOf(v)
  const { reg, rows } = await reconcile({ ...v, kind, company_id: cid })
  const lim = await saleDateLimits(cid)
  const statusOf = new Map(rows.filter((r) => r.tally).map((r) => [String(r.tally.key), r]))
  const wanted = new Set((v.keys || []).map(String))
  const picked = reg.vouchers.filter((t) => wanted.has(t.key) && !t.cancelled && ['missing_here', 'possible'].includes(String(statusOf.get(t.key)?.status)))
  const roles = new Map<string, { name: string; role: 'party' | 'ledger'; count: number; amount: number }>()
  for (const t of picked) {
    for (const l of t.lines) {
      const g = roles.get(l.key) || { name: l.name, role: l.party && kind === 'purchase' ? ('party' as const) : ('ledger' as const), count: 0, amount: 0 }
      g.count += 1
      g.amount = round2(g.amount + (l.dr || l.cr))
      roles.set(l.key, g)
    }
  }
  return {
    vouchers: picked.map((t) => {
      const r = statusOf.get(t.key) as Row
      return {
        key: t.key,
        vch_no: t.vch_no,
        ref_no: t.ref_no,
        type: kind === 'journal' ? 'JOURNAL' : purchaseTypeOf(t.type),
        date: t.date,
        party: t.party,
        amount: kind === 'journal' ? t.total : t.gross,
        lines: t.lines.map((l) => ({ name: l.name, key: l.key, dr: l.dr, cr: l.cr })),
        round_off: Math.abs(t.out_by) > 0.004 && Math.abs(t.out_by) <= 1 ? -t.out_by : 0,
        blocked: blockOf(t, kind, lim),
        possible: r.status === 'possible' && r.books ? { code: r.books.code, type: r.books.type, vch_no: r.books.vch_no, date: r.books.date, amount: kind === 'journal' ? r.books.total : r.books.gross, party: r.books.party } : null
      }
    }),
    ledgers: await mappingRows(roles, groupFor(kind))
  }
}

function blockOf(t: TallyVch, kind: TallyRegisterKind, lim: { booksFrom: string; windowFrom: string }): string | null {
  if (kind === 'purchase') {
    const route = purchaseRoute(t)
    if (route === 'purchases') return 'an oil purchase — enter it on its order in Purchases'
    if (route === 'freight_in') return 'freight — bill it in Accounting → Fr. Inward'
    if (route === 'freight_out') return 'freight — bill it in Accounting → Fr. Outward'
  }
  if (lim.booksFrom && t.date < lim.booksFrom) return `dated before these books begin (${lim.booksFrom})`
  if (lim.windowFrom && t.date < lim.windowFrom) return `dated before your working window (${lim.windowFrom})`
  if (t.lines.length < 2 || t.total <= 0) return 'it has nothing to post'
  if (Math.abs(t.out_by) > 1) return `its Dr and Cr do not agree in the file (out by ${Math.abs(t.out_by).toFixed(2)})`
  return null
}

/** Post the picked lines; one that cannot post is reported and the rest still go. */
export async function postTallyRegisterVouchers(v: {
  kind: TallyRegisterKind
  data_base64: string
  file_name?: string
  keys: string[]
  /** Possible matches the user has said are different vouchers. */
  force_keys?: string[]
  company_id?: number
}): Promise<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] }> {
  const kind: TallyRegisterKind = v.kind === 'journal' ? 'journal' : 'purchase'
  const cid = await companyOf(v)
  const wanted = new Set((v.keys || []).map(String))
  if (!wanted.size) throw new Error('Pick the vouchers to book')
  const force = new Set((v.force_keys || []).map(String))
  const lim = await saleDateLimits(cid)
  const fileLabel = String(v.file_name || '').trim()
  const created: { vch_no: string; id: number }[] = []
  const skipped: { vch_no: string; reason: string }[] = []
  // Read afresh from the file and the books — and, just before each voucher,
  // the books once more for its number, so nothing booked a moment ago (here
  // or from another desk) is booked twice.
  const state = await reconcile({ ...v, kind, company_id: cid })
  const picked = state.reg.vouchers.filter((t) => wanted.has(t.key))
  // Tally's own number is unique within its register, and it is written into
  // the narration of every voucher booked from it — a supplier's short bill
  // number (0104) is not, so it cannot be the test.
  const alreadyBooked = async (t: TallyVch): Promise<boolean> => {
    const r = await getClient().execute({
      sql: "SELECT narration FROM journal_entries WHERE company_id = ? AND narration LIKE 'Imported from Tally%'",
      args: [cid]
    })
    const head = `Imported from Tally — ${t.title} No. ${t.vch_no}`
    return r.rows.some((x) => {
      const s = String((x as unknown as Row).narration || '')
      return s === head || s.startsWith(`${head},`) || s.startsWith(`${head} (`)
    })
  }
  for (const t of picked) {
    const label = kind === 'journal' ? t.vch_no : `${t.ref_no || t.vch_no} (${t.type})`
    const row = state.rows.find((r) => r.tally?.key === t.key)
    const status = String(row?.status || '')
    if (t.cancelled) {
      skipped.push({ vch_no: label, reason: 'Tally shows it cancelled' })
      continue
    }
    if (status !== 'missing_here' && status !== 'possible') {
      skipped.push({ vch_no: label, reason: `it is already in these books${row?.books?.code ? ` (${row.books.code})` : ''}` })
      continue
    }
    if (status === 'possible' && !force.has(t.key)) {
      skipped.push({ vch_no: label, reason: `it looks like ${row?.books?.code || 'a voucher'} already here — tick "Book anyway" if it is a different one` })
      continue
    }
    const block = blockOf(t, kind, lim)
    if (block) {
      skipped.push({ vch_no: label, reason: block })
      continue
    }
    const missing = [...new Set(t.lines.filter((l) => !state.mapped.get(l.key)).map((l) => l.name))]
    if (missing.length) {
      skipped.push({ vch_no: label, reason: `not mapped yet: ${missing.join(', ')}` })
      continue
    }
    if (await alreadyBooked(t)) {
      skipped.push({ vch_no: label, reason: 'it was booked a moment ago' })
      continue
    }
    const lines: { account: string; dr?: number; cr?: number }[] = t.lines.map((l) => {
      const m = state.mapped.get(l.key) as { account_name: string }
      return l.dr > 0 ? { account: m.account_name, dr: l.dr } : { account: m.account_name, cr: l.cr }
    })
    if (Math.abs(t.out_by) > 0.004) lines.push(t.out_by > 0 ? { account: 'ROUND OFF A/C', cr: Math.abs(t.out_by) } : { account: 'ROUND OFF A/C', dr: Math.abs(t.out_by) })
    try {
      const res = await createVoucher({
        date: t.date,
        vchType: (kind === 'journal' ? 'JOURNAL' : purchaseTypeOf(t.type)) as VoucherType,
        vchNo: kind === 'journal' ? t.vch_no : t.ref_no || t.vch_no,
        narration:
          `Imported from Tally — ${t.title} No. ${t.vch_no}` +
          (kind === 'purchase' && t.ref_no ? `, supplier invoice ${t.ref_no}` : '') +
          (fileLabel ? ` (${fileLabel})` : ''),
        companyId: cid,
        lines: drFirst(lines)
      })
      created.push({ vch_no: label, id: res.id })
    } catch (e) {
      skipped.push({ vch_no: label, reason: (e as Error).message })
    }
  }
  await recordTallyBatch({ company_id: cid, kind, scope: kind, file_name: fileLabel, entry_ids: created.map((x) => x.id) })
  return { created, skipped }
}

// ---------------------------------------------------------------------------
// "USE TALLY'S DATE" — a voucher here moved to the date Tally has.
//
// Tally is taken as right: it is where the bill was entered, on the day it
// was entered. What moves depends on who wrote the voucher here:
//
//   an oil purchase (an order on the Purchases page) — the bill: every row of
//   it (a bill of several products is one bill), its supplier payable and its
//   purchase voucher, which keeps its number. A payment-cleared date that was
//   simply the bill date follows it; tanker and stock dates are real events and stay.
//   A transfer from another of our companies, a consignment, or a move across
//   financial years (TDS is counted per year) is refused — those are changed
//   on Purchases → Edit, where everything that follows is worked again.
//
//   a voucher booked by hand or from Tally — its date, nothing else.
//
//   anything another document wrote (a freight bill, an LC, a discounted
//   bill, a note) — refused, naming where it is changed.
// ---------------------------------------------------------------------------

function fyStart(iso: string): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  return `${m >= 4 ? y : y - 1}-04-01`
}

/** Which discounted-bill vouchers can be moved to Tally's date from a check. */
export async function bdMovableEntryIds(): Promise<Set<number>> {
  const c = getClient()
  const ids = new Set<number>()
  for (const sql of [
    'SELECT journal_entry_id AS id FROM bill_discountings WHERE journal_entry_id IS NOT NULL',
    'SELECT journal_entry_id AS id FROM bd_repayments WHERE journal_entry_id IS NOT NULL',
    'SELECT journal_entry_id AS id FROM bd_interest_payments WHERE journal_entry_id IS NOT NULL'
  ]) {
    const r = await c.execute(sql).catch(() => null)
    for (const x of r?.rows || []) if (Number(x.id)) ids.add(Number(x.id))
  }
  return ids
}

// Move a discounted bill's voucher and the bill's matching date together.
// Returns what moved, or null when the voucher is not one of the bill's.
async function moveBdVoucherDate(entryId: number, from: string, to: string): Promise<string | null> {
  const c = getClient()
  const one = async (sql: string): Promise<Row | null> =>
    ((await c.execute({ sql, args: [entryId] }).catch(() => null))?.rows[0] as unknown as Row | undefined) || null
  const dmy2 = (d: string): string => String(d || '').slice(0, 10).split('-').reverse().join('-')

  // The NBFC's money landing — the payment received date.
  const bd = await one('SELECT * FROM bill_discountings WHERE journal_entry_id = ?')
  if (bd) {
    const maturity = String(bd.maturity_date || '').slice(0, 10)
    if (maturity && to > maturity) throw new Error(`${String(bd.bd_no)} matures on ${dmy2(maturity)} — its money cannot have landed after that`)
    const firstRepaid = await c.execute({ sql: 'SELECT MIN(repay_date) AS d FROM bd_repayments WHERE bd_id = ?', args: [Number(bd.id)] })
    const fr = String(firstRepaid.rows[0]?.d || '').slice(0, 10)
    if (fr && to > fr) throw new Error(`${String(bd.bd_no)} was first repaid on ${dmy2(fr)} — it cannot be received after that`)
    const leg = await c.execute({ sql: 'SELECT MIN(receipt_date) AS d FROM bd_receipt_parts WHERE bd_id = ?', args: [Number(bd.id)] }).catch(() => null)
    const lg = String(leg?.rows[0]?.d || '').slice(0, 10)
    if (lg && to > lg) throw new Error(`Part 2 of ${String(bd.bd_no)} came on ${dmy2(lg)} — the first part cannot be dated after it`)
    await c.execute({ sql: 'UPDATE bill_discountings SET payment_received_date = ? WHERE id = ?', args: [to, Number(bd.id)] })
    await c.execute({ sql: 'UPDATE journal_entries SET entry_date = ? WHERE id = ?', args: [to, entryId] })
    return `${String(bd.bd_no)}'s payment received date`
  }

  // A repayment — one bank debit can be several bills' repayment rows.
  const rep = await one('SELECT * FROM bd_repayments WHERE journal_entry_id = ?')
  if (rep) {
    const rows = (await c.execute({ sql: 'SELECT r.*, b.bd_no, b.payment_received_date, b.repaid_date AS bill_repaid FROM bd_repayments r JOIN bill_discountings b ON b.id = r.bd_id WHERE r.journal_entry_id = ?', args: [entryId] })).rows as unknown as Row[]
    for (const r of rows) {
      const recd = String(r.payment_received_date || '').slice(0, 10)
      if (recd && to < recd) throw new Error(`${String(r.bd_no)} was received on ${dmy2(recd)} — it cannot be repaid before that`)
    }
    for (const r of rows) {
      await c.execute({ sql: 'UPDATE bd_repayments SET repay_date = ? WHERE id = ?', args: [to, Number(r.id)] })
      // A bill this repayment closed carries its closing date too.
      if (String(r.bill_repaid || '').slice(0, 10) === from) {
        await c.execute({ sql: 'UPDATE bill_discountings SET repaid_date = ? WHERE id = ?', args: [to, Number(r.bd_id)] })
      }
    }
    await c.execute({ sql: 'UPDATE journal_entries SET entry_date = ? WHERE id = ?', args: [to, entryId] })
    return `the repayment of ${[...new Set(rows.map((r) => String(r.bd_no)))].join(', ')}`
  }

  // Interest paid to the NBFC.
  const ip = await one('SELECT i.*, b.bd_no FROM bd_interest_payments i JOIN bill_discountings b ON b.id = i.bd_id WHERE i.journal_entry_id = ?')
  if (ip) {
    await c.execute({ sql: 'UPDATE bd_interest_payments SET paid_date = ? WHERE id = ?', args: [to, Number(ip.id)] })
    await c.execute({ sql: 'UPDATE journal_entries SET entry_date = ? WHERE id = ?', args: [to, entryId] })
    return `${String(ip.bd_no)}'s interest payment`
  }
  return null
}

export async function setRegisterVoucherDate(v: { entry_id: number; date: string; company_id?: number }): Promise<{ entry_id: number; from: string; to: string; moved: string }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const cid = await companyOf(v)
    const to = String(v.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Pick a valid date')
    if (to > todayISO()) throw new Error('A voucher cannot be moved into the future')
    const e = (await c.execute({ sql: 'SELECT id, company_id, entry_date, vch_type, vch_no, order_id, sale_id, payment_id FROM journal_entries WHERE id = ?', args: [Number(v.entry_id) || 0] })).rows[0] as unknown as Row | undefined
    if (!e) throw new Error('That voucher no longer exists — check the file again')
    if (Number(e.company_id) !== cid) throw new Error('That voucher belongs to another company — switch company (F3) first')
    const from = String(e.entry_date || '').slice(0, 10)
    if (from === to) return { entry_id: Number(e.id), from, to, moved: 'nothing' }
    // Both the day it leaves and the day it goes to answer to the books' start
    // and the user's working window.
    const lim = await saleDateLimits(cid)
    for (const d of [from, to]) {
      if (lim.booksFrom && d < lim.booksFrom) throw new Error(`These books begin on ${lim.booksFrom} — a voucher cannot be moved from or to ${dmy(d)}`)
      if (lim.windowFrom && d < lim.windowFrom) throw new Error(`Your working window starts on ${dmy(lim.windowFrom)} — ${dmy(d)} is outside it`)
    }

    // An oil purchase: the bill on the Purchases page.
    if (e.order_id != null) {
      const head = (await c.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [Number(e.order_id)] })).rows[0] as unknown as Row | undefined
      if (!head) throw new Error('The purchase behind this voucher no longer exists')
      const bill = head.bill_group
        ? toPlain(await c.execute({ sql: 'SELECT * FROM orders WHERE bill_group = ? ORDER BY id', args: [String(head.bill_group)] }))
        : [head]
      for (const o of bill) {
        if (Number(o.intercompany_sale_id) > 0)
          throw new Error(`${String(o.invoice_no)} is a transfer from another of our companies, dated by its sale there. Change the sale's date and both sides move together.`)
        if (Number(o.is_consignment) === 1)
          throw new Error(`${String(o.invoice_no)} is a consignment — its date is also the day the goods were taken in. Change it on Purchases → Edit.`)
      }
      const was = String(head.order_date || '').slice(0, 10)
      if (fyStart(was) !== fyStart(to))
        throw new Error(`That moves ${String(head.invoice_no)} into another financial year, which changes its TDS. Change it on Purchases → Edit, where the TDS is worked again.`)
      for (const o of bill) {
        const od = String(o.order_date || '').slice(0, 10)
        const pay = String(o.payment_cleared_date || '').slice(0, 10)
        await c.execute({
          sql: 'UPDATE orders SET order_date = ?, payment_cleared_date = ? WHERE id = ?',
          args: [to, !pay || pay === od ? to : o.payment_cleared_date, Number(o.id)]
        })
        await c.execute({ sql: "UPDATE supplier_ledger SET entry_date = ? WHERE order_id = ? AND entry_type = 'payable'", args: [to, Number(o.id)] })
        await c.execute({
          sql: "UPDATE journal_entries SET entry_date = ? WHERE order_id = ? AND UPPER(vch_type) LIKE 'PURCHASE%'",
          args: [to, Number(o.id)]
        })
      }
      return { entry_id: Number(e.id), from, to, moved: bill.length > 1 ? `the bill (${bill.length} rows)` : 'the purchase' }
    }
    if (e.sale_id != null) throw new Error('This voucher was posted by a sale — use the Sales Register check to re-date it')
    if (e.payment_id != null) throw new Error('This voucher was posted by a payment — change it from that payment')

    // A DISCOUNTED BILL'S VOUCHER: the bill's own date moves with it — the
    // day the NBFC's money landed, a repayment's day, an interest payment's
    // day — and nothing else. The amounts are what the NBFC actually paid or
    // took, which is why re-marking the receipt (and so re-working a day's
    // interest) is not how a date is corrected.
    const bdMoved = await moveBdVoucherDate(Number(e.id), from, to)
    if (bdMoved) return { entry_id: Number(e.id), from, to, moved: bdMoved }

    // Written by another document: say which, and leave it.
    const { voucherOwner, ownedVoucherIds } = await import('./voucherOwnership')
    if ((await ownedVoucherIds()).has(Number(e.id))) {
      const o = await voucherOwner(Number(e.id))
      const where: Record<string, string> = {
        freight: 'the transporter’s bill in Fr. Inward / Fr. Outward',
        transporter: 'the freight in Fr. Inward / Fr. Outward',
        lc: 'the LC in Treasury',
        bd: 'the discounted bill in Bill Discounting',
        discount: 'the discounted bill',
        note: 'the note (delete it and enter it afresh)',
        order: 'the purchase on the Purchases page',
        sale: 'the sale on the Sales page',
        payment: 'that payment'
      }
      throw new Error(`This voucher was posted by ${o?.label ? `${o.label} — ` : 'another document — '}change its date from ${where[String(o?.kind)] || 'that document'}.`)
    }
    // Booked by hand or from Tally: its date, nothing else.
    await c.execute({ sql: 'UPDATE journal_entries SET entry_date = ? WHERE id = ?', args: [to, Number(e.id)] })
    return { entry_id: Number(e.id), from, to, moved: 'the voucher' }
  })
}
