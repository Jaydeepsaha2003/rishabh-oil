import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'
import { resolveRefIds } from './accounting'

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

// The Accounting module pins itself to its own F3 company rather than the
// app-wide one, so the company has to come in with the call — reading the global
// active company here showed an empty register whenever the two differed.
export async function listNotes(companyId?: number): Promise<Row[]> {
  const res = await getClient().execute({
    args: [companyId ? n(companyId) : getActiveCompanyId()],
    sql: `SELECT nt.*,
            CASE nt.party_type WHEN 'supplier' THEN s.name WHEN 'customer' THEN c.name WHEN 'transporter' THEN tr.name END AS party_name,
            (SELECT COUNT(*) FROM note_items ni WHERE ni.note_id = nt.id) AS item_count,
            sb.bargain_no AS bargain_no
          FROM notes nt
          LEFT JOIN sales_bargains sb ON sb.id = nt.bargain_id
          LEFT JOIN suppliers s ON nt.party_type = 'supplier' AND s.id = nt.party_id
          LEFT JOIN customers c ON nt.party_type = 'customer' AND c.id = nt.party_id
          LEFT JOIN transporters tr ON nt.party_type = 'transporter' AND tr.id = nt.party_id
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

// Which side of the books a party sits on, and therefore how a note against
// them posts. Note TYPE decides the direction (a debit note debits the party, a
// credit note credits them); PARTY TYPE decides the ledger it lands in, the
// Trial Balance group, and which GST account is touched — tax you pay a
// supplier is Input, tax you charge a customer is Output, whichever kind of
// note adjusts it.
const PARTY_KINDS = {
  supplier: { master: 'suppliers', ledger: 'supplier_ledger', idCol: 'supplier_id', refCol: 'order_id', group: 'Sundry Creditors', gst: 'GST INPUT A/C' },
  customer: { master: 'customers', ledger: 'customer_ledger', idCol: 'customer_id', refCol: 'sale_id', group: 'Sundry Debtors', gst: 'GST OUTPUT A/C' },
  transporter: { master: 'transporters', ledger: 'transporter_ledger', idCol: 'transporter_id', refCol: 'order_id', group: 'Sundry Creditors', gst: 'GST INPUT A/C' }
} as const
type PartyKind = keyof typeof PARTY_KINDS

// Create a Debit or Credit note against ANY party — supplier, customer or
// transporter. Posts a balanced journal voucher and a signed party-ledger row.
//   Debit note (debits the party, so it reduces what we owe them):
//     Dr Party (base+gst)  Cr {against A/C} (base)  Cr {GST A/C} (gst)
//   Credit note (credits the party, so it reduces what they owe us):
//     Dr {against A/C} (base)  Dr {GST A/C} (gst)  Cr Party (base+gst)
export async function createNote(v: Row, existingId?: number): Promise<{ id: number; note_no: string }> {
  const c = getClient()
  const cid = v.company_id ? n(v.company_id) : getActiveCompanyId()
  const type: 'debit' | 'credit' = v.note_type === 'credit' ? 'credit' : 'debit'
  // Defaults preserve the old behaviour for any caller that doesn't say.
  const requested = String(v.party_type || '').trim().toLowerCase()
  const partyType: PartyKind = (requested in PARTY_KINDS ? requested : type === 'debit' ? 'supplier' : 'customer') as PartyKind
  const kind = PARTY_KINDS[partyType]
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
  // Which bargain this return goes back onto, when the note does not name an
  // original invoice to read it off. Stored, not acted on: the sales-bargain
  // register derives the Return figure from the note itself, so there is one
  // mechanism and nothing to unwind when the note is altered or deleted.
  const wantsBargain = type === 'credit' && partyType === 'customer'
  const bargainId = wantsBargain && v.bargain_id ? n(v.bargain_id) : 0

  // Party name (must match the journal account used elsewhere for this party).
  const partyRes = await c.execute({
    sql: `SELECT name FROM ${kind.master} WHERE id = ?`,
    args: [partyId]
  })
  if (!partyRes.rows.length) throw new Error('Party not found')
  const partyName = String(partyRes.rows[0].name || '').trim()

  // A return account only makes sense on the side the goods came from: a
  // supplier/transporter note is a purchase-side adjustment, a customer note a
  // sales-side one. Whatever is defaulted here, the form lets it be overridden.
  const purchaseSide = partyType !== 'customer'
  const defaultAgainst = purchaseSide ? 'PURCHASE RETURN A/C' : 'SALES RETURN A/C'
  const againstGroup = purchaseSide ? 'Purchase Accounts' : 'Sales Accounts'
  const against = (String(v.against_account || '').trim() || defaultAgainst).toUpperCase()
  // An edit keeps its own number — re-issuing one would renumber the register
  // and break any reference already written against it.
  const prior = existingId
    ? ((await c.execute({ sql: 'SELECT * FROM notes WHERE id = ? AND company_id = ?', args: [existingId, cid] })).rows[0] as Row | undefined)
    : undefined
  if (existingId && !prior) throw new Error('That note no longer exists')
  const noteNo = prior ? String(prior.note_no) : await nextNoteNo(type, cid)

  // Reverse whatever the note posted before re-posting it, so an edit never
  // leaves a stale voucher, ledger row or item line behind. Same
  // reverse-then-repost shape the LC and purchase edits use.
  if (prior) {
    if (prior.journal_entry_id != null) {
      await c.execute({
        sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
        args: [n(prior.journal_entry_id)]
      })
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [n(prior.journal_entry_id)] })
      await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [n(prior.journal_entry_id)] })
    }
    const priorLedger = String(prior.ledger_table || '')
    if (['customer_ledger', 'transporter_ledger', 'supplier_ledger'].includes(priorLedger) && prior.ledger_id != null) {
      await c.execute({ sql: `DELETE FROM ${priorLedger} WHERE id = ?`, args: [n(prior.ledger_id)] })
    }
    // Item lines are what move stock, so they go too — the re-insert below is
    // what puts the new quantities back.
    await c.execute({ sql: 'DELETE FROM note_items WHERE note_id = ?', args: [n(existingId)] })
  }
  const date = String(v.note_date || todayISO()).slice(0, 10)
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
            { account: partyName, group: kind.group, dr: total },
            { account: against, group: againstGroup, cr: base },
            { account: kind.gst, group: 'Duties & Taxes', cr: gst },
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: roundOff > 0 ? roundOff : 0, dr: roundOff < 0 ? -roundOff : 0 }
          ]
        : [
            { account: against, group: againstGroup, dr: base },
            { account: kind.gst, group: 'Duties & Taxes', dr: gst },
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
            { account: partyName || 'CASH CUSTOMER A/C', group: kind.group, cr: total }
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
    // The id of the document the ref names, not just its text: an allocation
    // with no id can only be matched by string, which is fragile and was how a
    // credit note against a sales invoice ended up settling nothing.
    const ids = againstRef
      ? await resolveRefIds(againstRef, cid, partyType === 'customer' ? 'customer' : 'supplier')
      : { order_id: null, sale_invoice_group: null }
    await c.execute({
      sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Number(partyLine.rows[0].id),
        Number(partyLine.rows[0].account_id),
        againstRef ? 'agst_ref' : 'on_account',
        againstRef,
        total,
        ids.order_id,
        ids.sale_invoice_group
      ]
    })
  }

  // 2) Signed party-ledger row (amount +ve = we owe the party, -ve = party owes
  //    us). Debit note debits the supplier (payable ↓ → negative); credit note
  //    credits the customer (receivable ↓ → positive).
  const table = kind.ledger
  const partyCol = kind.idCol
  const refCol = kind.refCol
  const signedAmount = type === 'debit' ? -total : total
  const led = await c.execute({
    sql: `INSERT INTO ${table} (${partyCol}, ${refCol}, entry_date, entry_type, amount, note, company_id)
          VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    args: [partyId, date, type === 'debit' ? 'dr_note' : 'cr_note', signedAmount, `${noteNo} — ${against}`, cid]
  })

  let noteId: number
  if (prior) {
    await c.execute({
      sql: `UPDATE notes SET
        note_type = ?, note_date = ?, party_type = ?, party_id = ?, against_account = ?,
        base_amount = ?, gst_pct = ?, gst_amount = ?, total_amount = ?, narration = ?,
        journal_entry_id = ?, ledger_table = ?, ledger_id = ?, against_ref = ?, bargain_id = ?
        WHERE id = ? AND company_id = ?`,
      args: [
        type, date, partyType, partyId, against,
        base, gstPct, gst, total, narration,
        je.id, table, Number(led.lastInsertRowid), againstRef, bargainId || null,
        existingId as number, cid
      ]
    })
    noteId = existingId as number
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO notes
        (company_id, note_type, note_no, note_date, party_type, party_id, against_account,
         base_amount, gst_pct, gst_amount, total_amount, narration, journal_entry_id, ledger_table, ledger_id, against_ref, bargain_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cid, type, noteNo, date, partyType, partyId, against,
        base, gstPct, gst, total, narration,
        je.id, table, Number(led.lastInsertRowid), againstRef, bargainId || null
      ]
    })
    noteId = Number(ins.lastInsertRowid)
  }
  for (const it of items) {
    await c.execute({
      sql: 'INSERT INTO note_items (note_id, product_id, description, qty, rate, amount) VALUES (?, ?, ?, ?, ?, ?)',
      args: [noteId, it.product_id, it.description, it.qty, it.rate, it.amount]
    })
  }
  return { id: noteId, note_no: noteNo }
}

// Alter a posted note: its voucher, party-ledger row and item lines (and so any
// stock the items moved) are reversed and re-posted from the new values, under
// the same note number.
export async function updateNote(id: number, v: Row): Promise<{ id: number; note_no: string }> {
  return createNote(v, n(id))
}

export async function deleteNote(id: number, companyId?: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT * FROM notes WHERE id = ? AND company_id = ?',
    args: [id, companyId ? n(companyId) : getActiveCompanyId()]
  })
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
    const stored = String(note.ledger_table)
    const table = ['customer_ledger', 'transporter_ledger', 'supplier_ledger'].includes(stored)
      ? stored
      : 'supplier_ledger'
    await c.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [Number(note.ledger_id)] })
  }
  await c.execute({ sql: 'DELETE FROM note_items WHERE note_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [id] })
  return { id }
}
