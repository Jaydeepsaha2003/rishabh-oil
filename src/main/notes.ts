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

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

// Next running note number per type, per company: DN/1, CN/1, …
async function nextNoteNo(type: 'debit' | 'credit', companyId?: number): Promise<string> {
  const prefix = type === 'debit' ? 'DN' : 'CN'
  const res = await getClient().execute({
    sql: 'SELECT note_no FROM notes WHERE note_type = ? AND company_id = ?',
    args: [type, companyId || getActiveCompanyId()]
  })
  let max = 0
  for (const r of res.rows) {
    const m = /(\d+)\s*$/.exec(String(r.note_no || ''))
    const v = m ? Number(m[1]) : 0
    if (v > max) max = v
  }
  return `${prefix}/${max + 1}`
}

export async function listNotes(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `SELECT nt.*,
            CASE nt.party_type WHEN 'supplier' THEN s.name WHEN 'customer' THEN c.name END AS party_name,
            (SELECT COUNT(*) FROM note_items ni WHERE ni.note_id = nt.id) AS item_count
          FROM notes nt
          LEFT JOIN suppliers s ON nt.party_type = 'supplier' AND s.id = nt.party_id
          LEFT JOIN customers c ON nt.party_type = 'customer' AND c.id = nt.party_id
          WHERE nt.company_id = ?
          ORDER BY nt.id DESC`
  })
  return toPlain(res)
}

// Item lines for one note (for the expand row).
export async function listNoteItems(noteId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT ni.*, p.code AS product_code, p.name AS product_name
          FROM note_items ni LEFT JOIN products p ON p.id = ni.product_id
          WHERE ni.note_id = ? ORDER BY ni.id`,
    args: [noteId]
  })
  return toPlain(res)
}

// Create a Debit note (against a supplier) or Credit note (against a customer).
// Posts a balanced journal voucher and a signed party-ledger row.
//   Debit note (supplier, reduces payable):
//     Dr Supplier (base+gst)  Cr {against A/C} (base)  Cr GST INPUT A/C (gst)
//   Credit note (customer, reduces receivable):
//     Dr {against A/C} (base)  Dr GST OUTPUT A/C (gst)  Cr Customer (base+gst)
export async function createNote(v: Row): Promise<{ id: number; note_no: string }> {
  const c = getClient()
  const cid = v.company_id ? n(v.company_id) : getActiveCompanyId()
  const type: 'debit' | 'credit' = v.note_type === 'credit' ? 'credit' : 'debit'
  const partyType = type === 'debit' ? 'supplier' : 'customer'
  const partyId = n(v.party_id)
  if (!partyId) throw new Error(`Select the ${partyType}`)
  // Optional item lines. When present, they compute the base amount.
  const rawItems: Row[] = Array.isArray(v.items) ? v.items : []
  const items = rawItems
    .map((it) => ({
      product_id: it.product_id ? n(it.product_id) : null,
      description: it.description ? String(it.description).trim() : null,
      qty: n(it.qty),
      rate: n(it.rate),
      amount: round2(n(it.qty) * n(it.rate))
    }))
    .filter((it) => it.amount > 0 || it.qty > 0)
  const base = items.length
    ? round2(items.reduce((s, it) => s + it.amount, 0))
    : round2(n(v.base_amount))
  const gstPct = n(v.gst_pct)
  if (base <= 0) throw new Error('Enter a base amount (or item lines) greater than zero')
  const gst = round2(base * (gstPct / 100))
  // Tally rounds the note to the whole rupee against the party; the paise sit
  // on the ROUND OFF ledger.
  const rawTotal = round2(base + gst)
  const total = Math.round(rawTotal)
  const roundOff = round2(total - rawTotal)
  // The original invoice this note adjusts (GST's "original invoice no").
  const againstRef = v.against_invoice ? String(v.against_invoice).trim() : null

  // Party name (must match the journal account used elsewhere for this party).
  const partyRes = await c.execute({
    sql: `SELECT name FROM ${partyType === 'supplier' ? 'suppliers' : 'customers'} WHERE id = ?`,
    args: [partyId]
  })
  if (!partyRes.rows.length) throw new Error('Party not found')
  const partyName = String(partyRes.rows[0].name || '').trim()

  const defaultAgainst = type === 'debit' ? 'PURCHASE RETURN A/C' : 'SALES RETURN A/C'
  const against = (String(v.against_account || '').trim() || defaultAgainst).toUpperCase()
  const noteNo = await nextNoteNo(type, cid)
  const date = String(v.note_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const narration = v.narration ? String(v.narration).trim() : null

  // 1) Double-entry journal voucher.
  const je = await postJournal({
    date,
    vchType: type === 'debit' ? 'DEBIT NOTE' : 'CREDIT NOTE',
    vchNo: noteNo,
    narration: narration || `${type === 'debit' ? 'Debit' : 'Credit'} note ${noteNo}`,
    companyId: cid,
    lines:
      type === 'debit'
        ? [
            { account: partyName, group: 'Sundry Creditors', dr: total },
            { account: against, group: 'Purchase Accounts', cr: base },
            { account: 'GST INPUT A/C', group: 'Duties & Taxes', cr: gst },
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: roundOff > 0 ? roundOff : 0, dr: roundOff < 0 ? -roundOff : 0 }
          ]
        : [
            { account: against, group: 'Sales Accounts', dr: base },
            { account: 'GST OUTPUT A/C', group: 'Duties & Taxes', dr: gst },
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
            { account: partyName || 'CASH CUSTOMER A/C', group: 'Sundry Debtors', cr: total }
          ]
  })

  // Bill-wise: the note settles against the original invoice when one is
  // named, otherwise it stays On Account — exactly like a payment would.
  const partyLine = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND a.name = ? LIMIT 1`,
    args: [je.id, partyName.toUpperCase()]
  })
  if (partyLine.rows.length) {
    await c.execute({
      sql: 'INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount) VALUES (?, ?, ?, ?, ?)',
      args: [
        Number(partyLine.rows[0].id),
        Number(partyLine.rows[0].account_id),
        againstRef ? 'agst_ref' : 'on_account',
        againstRef,
        total
      ]
    })
  }

  // 2) Signed party-ledger row (amount +ve = we owe the party, -ve = party owes
  //    us). Debit note debits the supplier (payable ↓ → negative); credit note
  //    credits the customer (receivable ↓ → positive).
  const table = partyType === 'supplier' ? 'supplier_ledger' : 'customer_ledger'
  const partyCol = partyType === 'supplier' ? 'supplier_id' : 'customer_id'
  const refCol = partyType === 'supplier' ? 'order_id' : 'sale_id'
  const signedAmount = type === 'debit' ? -total : total
  const led = await c.execute({
    sql: `INSERT INTO ${table} (${partyCol}, ${refCol}, entry_date, entry_type, amount, note, company_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    args: [partyId, date, type === 'debit' ? 'dr_note' : 'cr_note', signedAmount, `${noteNo} — ${against}`, cid]
  })

  const ins = await c.execute({
    sql: `INSERT INTO notes
      (company_id, note_type, note_no, note_date, party_type, party_id, against_account,
       base_amount, gst_pct, gst_amount, total_amount, narration, journal_entry_id, ledger_table, ledger_id, against_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cid, type, noteNo, date, partyType, partyId, against,
      base, gstPct, gst, total, narration,
      je.id, table, Number(led.lastInsertRowid), againstRef
    ]
  })
  const noteId = Number(ins.lastInsertRowid)
  for (const it of items) {
    await c.execute({
      sql: 'INSERT INTO note_items (note_id, product_id, description, qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?)',
      args: [noteId, it.product_id, it.description, it.qty, it.rate, it.amount]
    })
  }
  return { id: noteId, note_no: noteNo }
}

export async function deleteNote(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM notes WHERE id = ? AND company_id = ?', args: [id, getActiveCompanyId()] })
  if (!res.rows.length) return { id }
  const note = res.rows[0]
  // Reverse the journal voucher (both legs) and the party-ledger row.
  if (note.journal_entry_id != null) {
    await c.execute({
      sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
      args: [Number(note.journal_entry_id)]
    })
    await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [Number(note.journal_entry_id)] })
    await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [Number(note.journal_entry_id)] })
  }
  if (note.ledger_table && note.ledger_id != null) {
    const table = String(note.ledger_table) === 'customer_ledger' ? 'customer_ledger' : 'supplier_ledger'
    await c.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [Number(note.ledger_id)] })
  }
  await c.execute({ sql: 'DELETE FROM note_items WHERE note_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [id] })
  return { id }
}
