import type { ResultSet } from '@libsql/client'
import ExcelJS from 'exceljs'
import { readFileSync } from 'fs'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postLcUpfrontInterest, dropLcUpfrontInterest } from './treasury'

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

// ---------------------------------------------------------------------------
// Bank statement import: pulls raw rows out of an .xlsx/.xls/.csv export,
// however its columns happen to be laid out (banks all name these differently).
// ---------------------------------------------------------------------------

type ParsedLine = { txn_date: string; narration: string; debit: number; credit: number; balance: number | null }

function normHeader(h: unknown): string {
  return String(h ?? '').trim().toLowerCase()
}

function findCol(headerRow: string[], keys: string[]): number {
  for (let i = 0; i < headerRow.length; i++) {
    const h = normHeader(headerRow[i])
    if (keys.some((k) => h.includes(k))) return i
  }
  return -1
}

function parseAmount(s: unknown): number {
  const cleaned = String(s ?? '').replace(/[,₹\s]/g, '')
  const x = Number(cleaned)
  return Number.isFinite(x) ? x : 0
}

function parseDate(s: unknown): string | null {
  const raw = String(s ?? '').trim()
  if (!raw) return null
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (m) {
    const d = m[1]
    const mo = m[2]
    let y = m[3]
    if (y.length === 2) y = `20${y}`
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const dt = new Date(raw)
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return null
}

function rowsToLines(rows: string[][]): ParsedLine[] {
  if (!rows.length) return []
  const headerIdx = rows.findIndex(
    (r) => findCol(r, ['date']) >= 0 && (findCol(r, ['debit', 'withdrawal']) >= 0 || findCol(r, ['credit', 'deposit']) >= 0)
  )
  const headerRow = headerIdx >= 0 ? rows[headerIdx] : rows[0]
  const dateCol = findCol(headerRow, ['date'])
  const narrCol = findCol(headerRow, ['narration', 'description', 'particular', 'remark', 'details'])
  const debitCol = findCol(headerRow, ['debit', 'withdrawal'])
  const creditCol = findCol(headerRow, ['credit', 'deposit'])
  const balCol = findCol(headerRow, ['balance'])
  const dataRows = rows.slice((headerIdx >= 0 ? headerIdx : 0) + 1)
  const out: ParsedLine[] = []
  for (const r of dataRows) {
    const date = dateCol >= 0 ? parseDate(r[dateCol]) : null
    if (!date) continue
    const debit = debitCol >= 0 ? parseAmount(r[debitCol]) : 0
    const credit = creditCol >= 0 ? parseAmount(r[creditCol]) : 0
    if (!debit && !credit) continue
    out.push({
      txn_date: date,
      narration: narrCol >= 0 ? String(r[narrCol] ?? '').trim() : '',
      debit,
      credit,
      balance: balCol >= 0 ? parseAmount(r[balCol]) : null
    })
  }
  return out
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field.length || row.length) {
    row.push(field)
    if (row.some((c) => c.trim() !== '')) rows.push(row)
  }
  return rows
}

async function parseXlsxFile(filePath: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const rows: string[][] = []
  ws.eachRow((row) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cell.text ?? '')
    })
    rows.push(cells)
  })
  return rows
}

export async function importBankStatement(v: Row): Promise<{ id: number; count: number }> {
  const filePath = String(v.file_path || '').trim()
  if (!filePath) throw new Error('Pick a bank statement file')
  const bank = String(v.bank || '').trim()
  if (!bank) throw new Error('Bank is required')

  const rows = /\.xlsx?$/i.test(filePath) ? await parseXlsxFile(filePath) : parseCsv(readFileSync(filePath, 'utf8'))
  const lines = rowsToLines(rows)
  if (!lines.length) {
    throw new Error('No usable transaction rows found — the file needs Date and Debit/Credit columns')
  }

  const c = getClient()
  const companyId = getActiveCompanyId() || 1
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const ins = await c.execute({
    sql: 'INSERT INTO bank_statement_imports (bank, file_name, company_id) VALUES (?, ?, ?)',
    args: [bank, fileName, companyId]
  })
  const importId = Number(ins.lastInsertRowid)
  for (const l of lines) {
    await c.execute({
      sql: `INSERT INTO bank_statement_lines (import_id, bank, txn_date, narration, debit, credit, balance)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [importId, bank, l.txn_date, l.narration, l.debit, l.credit, l.balance]
    })
  }
  return { id: importId, count: lines.length }
}

export async function listBankStatementImports(): Promise<Row[]> {
  const res = await getClient().execute(
    `SELECT i.*,
       (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = i.id) AS line_count,
       (SELECT COUNT(*) FROM bank_statement_lines WHERE import_id = i.id AND status = 'pending') AS pending_count
     FROM bank_statement_imports i ORDER BY i.id DESC`
  )
  return toPlain(res)
}

export async function deleteBankStatementImport(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM bank_statement_lines WHERE import_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bank_statement_imports WHERE id = ?', args: [id] })
  return { id }
}

export async function listBankStatementLines(filter: Row): Promise<Row[]> {
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter?.import_id) {
    where.push('import_id = ?')
    args.push(n(filter.import_id))
  }
  if (filter?.status) {
    where.push('status = ?')
    args.push(String(filter.status))
  }
  const sql = `SELECT * FROM bank_statement_lines ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY txn_date DESC, id DESC`
  const res = await getClient().execute({ sql, args })
  return toPlain(res)
}

// ---------------------------------------------------------------------------
// Suggested match: find something the line's amount + date + narration could
// be against ALREADY-posted records (an LC's commission/repayment, or a
// supplier/customer/transporter payment) — never a new posting, just a
// pointer for the reviewer to confirm or reject.
// ---------------------------------------------------------------------------

const DATE_WINDOW_DAYS = 5
const AMOUNT_TOLERANCE = 0.5

function withinDateWindow(a: string, b: string, days: number): boolean {
  const diff = Math.abs(new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime())
  return diff <= days * 86400000
}

export async function suggestBankLineMatch(lineId: number): Promise<Row | null> {
  const c = getClient()
  const lineRes = await c.execute({ sql: 'SELECT * FROM bank_statement_lines WHERE id = ?', args: [lineId] })
  if (!lineRes.rows.length) throw new Error('Statement line not found')
  const line = toPlain(lineRes)[0]
  const amount = n(line.debit) > 0 ? n(line.debit) : n(line.credit)
  const narration = String(line.narration || '').toUpperCase()

  // 1. LC number appearing in the narration — check charges (opening),
  //    upfront interest (paid straight from the bank, not netted off the
  //    open amount), and repayments (incl. maturity charges) for an amount
  //    match near the line's date.
  const lcRes = await c.execute(
    `SELECT id, lc_no, charges, opened_date, open_date, amount, interest_pct, usance_days, interest_upfront
     FROM letters_of_credit WHERE lc_no IS NOT NULL AND lc_no != ''`
  )
  for (const lc of toPlain(lcRes)) {
    const lcNo = String(lc.lc_no || '').toUpperCase()
    if (!lcNo || !narration.includes(lcNo)) continue

    // Charges only post via the opening voucher when they're NOT paid
    // upfront — an upfront LC's charges are bundled into the lc_interest
    // match below instead, since that's the one voucher this line matches.
    if (!n(lc.interest_upfront) && n(lc.charges) > 0 && Math.abs(n(lc.charges) - amount) <= AMOUNT_TOLERANCE) {
      return {
        category: 'lc',
        link_type: 'lc_opening',
        link_ref_id: n(lc.id),
        label: `LC ${lc.lc_no} — opening commission/charges ${n(lc.charges).toFixed(2)}`
      }
    }

    if (n(lc.interest_upfront)) {
      const interest = round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
      const charges = round2(n(lc.charges))
      const total = round2(interest + charges)
      if (total > 0 && Math.abs(total - amount) <= AMOUNT_TOLERANCE) {
        return {
          category: 'lc',
          link_type: 'lc_interest',
          link_ref_id: n(lc.id),
          label: `LC ${lc.lc_no} — interest ${interest.toFixed(2)} + charges ${charges.toFixed(2)} paid upfront (${total.toFixed(2)})`
        }
      }
    }

    const repRes = await c.execute({
      sql: 'SELECT id, amount, maturity_charges, repay_date FROM lc_repayments WHERE lc_id = ?',
      args: [lc.id]
    })
    for (const rep of toPlain(repRes)) {
      const total = round2(n(rep.amount) + n(rep.maturity_charges))
      if (Math.abs(total - amount) <= AMOUNT_TOLERANCE && withinDateWindow(String(rep.repay_date), String(line.txn_date), DATE_WINDOW_DAYS)) {
        return {
          category: 'lc',
          link_type: 'lc_repayment',
          link_ref_id: n(rep.id),
          label: `LC ${lc.lc_no} — repayment ${total.toFixed(2)} on ${rep.repay_date}`
        }
      }
    }
  }

  // 2. A supplier/customer/transporter payment of the same amount, near the
  //    same date, whose party name shows up in the narration.
  const payRes = await c.execute({
    sql: `SELECT p.*,
       CASE p.party_type WHEN 'supplier' THEN s.name WHEN 'transporter' THEN t.name WHEN 'customer' THEN c.name END AS party_name
     FROM payments p
     LEFT JOIN suppliers s ON p.party_type = 'supplier' AND s.id = p.party_id
     LEFT JOIN transporters t ON p.party_type = 'transporter' AND t.id = p.party_id
     LEFT JOIN customers c ON p.party_type = 'customer' AND c.id = p.party_id
     WHERE ABS(p.amount - ?) <= ?`,
    args: [amount, AMOUNT_TOLERANCE]
  })
  let best: Row | null = null
  for (const pay of toPlain(payRes)) {
    if (!withinDateWindow(String(pay.payment_date), String(line.txn_date), DATE_WINDOW_DAYS)) continue
    const nameMatches = pay.party_name && narration.includes(String(pay.party_name).toUpperCase())
    if (nameMatches || !best) {
      best = {
        category: 'oil',
        link_type: 'payment',
        link_ref_id: n(pay.id),
        label: `Payment to ${pay.party_name || pay.party_type} — ${n(pay.amount).toFixed(2)} on ${pay.payment_date}`
      }
      if (nameMatches) break
    }
  }
  return best
}

// Interest paid upfront (see interest_upfront on the LC) isn't posted
// anywhere else, so — unlike every other link type here, which only points
// at an ALREADY-posted record — reconciling this one is what actually posts
// it. Reclassifying a line away from that link (misc, or back to pending)
// has to reverse the same posting, so both paths share this.
async function reverseLcInterestLink(lineId: number): Promise<void> {
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT link_type, link_ref_id FROM bank_statement_lines WHERE id = ?', args: [lineId] })
  const row = cur.rows[0]
  if (!row || !row.link_ref_id) return
  if (String(row.link_type) === 'lc_interest') await dropLcUpfrontInterest(n(row.link_ref_id))
}

export async function reconcileBankLine(lineId: number, v: Row): Promise<{ id: number }> {
  const category = String(v.category || '').trim()
  if (!category) throw new Error('Pick what this line is')
  const c = getClient()
  const linkType = v.link_type ? String(v.link_type) : null
  const linkRefId = v.link_ref_id ? n(v.link_ref_id) : null
  if (linkType === 'lc_interest' && linkRefId) {
    const line = await c.execute({ sql: 'SELECT txn_date FROM bank_statement_lines WHERE id = ?', args: [lineId] })
    await postLcUpfrontInterest(linkRefId, String(line.rows[0]?.txn_date || ''))
  }
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = ?, link_type = ?, link_ref_id = ?, status = 'reconciled', reviewed_at = datetime('now')
          WHERE id = ?`,
    args: [category, linkType, linkRefId, lineId]
  })
  return { id: lineId }
}

export async function markBankLineMisc(lineId: number): Promise<{ id: number }> {
  const c = getClient()
  await reverseLcInterestLink(lineId)
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = 'misc', link_type = NULL, link_ref_id = NULL, status = 'misc', reviewed_at = datetime('now')
          WHERE id = ?`,
    args: [lineId]
  })
  return { id: lineId }
}

export async function unreconcileBankLine(lineId: number): Promise<{ id: number }> {
  const c = getClient()
  await reverseLcInterestLink(lineId)
  await c.execute({
    sql: `UPDATE bank_statement_lines SET category = NULL, link_type = NULL, link_ref_id = NULL, status = 'pending', reviewed_at = NULL
          WHERE id = ?`,
    args: [lineId]
  })
  return { id: lineId }
}

// The sub-entry toggle is a manual party/purpose note kept alongside the
// line — deliberately separate from category/status so it never affects
// reconciliation, and gated behind a confirm dialog in the UI since an
// accidental flip would otherwise silently wipe a recorded note.
export async function setBankLineSubEntry(lineId: number, v: Row): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({
    sql: 'UPDATE bank_statement_lines SET sub_entry_enabled = ?, sub_entry_note = ? WHERE id = ?',
    args: [v.enabled ? 1 : 0, v.note ? String(v.note).trim() : null, lineId]
  })
  return { id: lineId }
}
