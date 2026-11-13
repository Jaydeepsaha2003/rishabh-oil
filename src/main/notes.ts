import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'
import { gstLines, asGstType, DEFAULT_GST_TYPE, type GstType } from './gstLedgers'
import { resolveRefIds } from './accounting'
import { resolveAccountName } from './ledgerMap'
import { baseGroupOf } from './ledgerGroups'

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
            (SELECT COUNT(*) FROM journal_entries je WHERE je.id = nt.journal_entry_id) AS has_voucher,
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
  supplier: { master: 'suppliers', ledger: 'supplier_ledger', idCol: 'supplier_id', refCol: 'order_id', group: 'Sundry Creditors', gst: 'INPUT' },
  customer: { master: 'customers', ledger: 'customer_ledger', idCol: 'customer_id', refCol: 'sale_id', group: 'Sundry Debtors', gst: 'OUTPUT' },
  transporter: { master: 'transporters', ledger: 'transporter_ledger', idCol: 'transporter_id', refCol: 'order_id', group: 'Sundry Creditors', gst: 'INPUT' }
} as const
type PartyKind = keyof typeof PARTY_KINDS

/**
 * THE PARTY BEHIND A LEDGER, THROUGH A RENAME.
 *
 * The website enters a note in the accounting grid, where the party is a
 * ledger, and the note needs the MASTER behind it. They used to be matched by
 * name alone — which fails the moment a ledger has been renamed to the name
 * the books use: the supplier master still reads DIL EXIM while its ledger
 * reads DIL EXIM COMMODITIES PRIVATE LIMITED(CR), and every note on it was
 * refused with "Select the supplier" although the party was right there.
 *
 * A rename leaves its trail in ledger_map (posts_as = the old name, use_name =
 * the ledger), so the ledger's name and every old name redirected to it are
 * all tried. The kinds tried are the ones the ledger's group allows: a debtor
 * is a customer; a creditor is a supplier, or a transporter.
 */
async function partyByLedgerName(
  name: string,
  cid: number,
  preferred: PartyKind,
  group?: string
): Promise<{ id: number; kind: PartyKind } | null> {
  const c = getClient()
  const want = String(name || '').trim().toUpperCase()
  if (!want) return null
  const aliases = [want]
  const map = await c
    .execute({
      sql: `SELECT posts_as FROM ledger_map
             WHERE UPPER(TRIM(use_name)) = ? AND (company_id = ? OR company_id IS NULL)
             ORDER BY company_id IS NULL, id`,
      args: [want, cid]
    })
    .catch(() => null)
  for (const r of map?.rows || []) {
    const a = String((r as unknown as Row).posts_as || '').trim().toUpperCase()
    if (a && !aliases.includes(a)) aliases.push(a)
  }
  const g = await baseGroupOf(group)
  const kinds: PartyKind[] =
    g === 'Sundry Debtors'
      ? ['customer']
      : g === 'Sundry Creditors'
        ? preferred === 'transporter'
          ? ['transporter', 'supplier']
          : ['supplier', 'transporter']
        : [preferred, ...(['supplier', 'customer', 'transporter'] as PartyKind[]).filter((k) => k !== preferred)]
  for (const k of kinds) {
    for (const a of aliases) {
      const hit = await c.execute({
        sql: `SELECT id FROM ${PARTY_KINDS[k].master} WHERE UPPER(TRIM(name)) = ? LIMIT 1`,
        args: [a]
      })
      if (hit.rows.length) return { id: n(hit.rows[0].id), kind: k }
    }
  }
  return null
}

// Create a Debit or Credit note against ANY party — supplier, customer or
// transporter. Posts a balanced journal voucher and a signed party-ledger row.
//   Debit note (debits the party, so it reduces what we owe them):
//     Dr Party (base+gst)  Cr {against A/C} (base)  Cr {GST A/C} (gst)
//   Credit note (credits the party, so it reduces what they owe us):
//     Dr {against A/C} (base)  Dr {GST A/C} (gst)  Cr Party (base+gst)
// A RETURN UNDOES ITS INVOICE'S TOP-UP FIRST. A sale bigger than its bargain's
// balance grows the bargain ("Top-up for invoice KRFIN/149", +19.61); when that
// invoice comes back on a credit note, the top-up goes back off before anything
// else, up to the quantity returned — the bargain is left where it stood before
// the sale (RPO/07-07/SURYAFOODS/07: 15.295, not 34.905). Logged as an
// adjustment carrying the note's id, so altering or deleting the note restores it.
export async function undoNoteTopups(noteId: number): Promise<void> {
  const c = getClient()
  const rows = (await c.execute({ sql: 'SELECT id, bargain_id, delta FROM bargain_adjustments WHERE note_id = ?', args: [n(noteId)] })).rows as unknown as Row[]
  for (const r of rows) {
    await c.execute({ sql: 'UPDATE sales_bargains SET qty = ROUND(qty - ?, 3) WHERE id = ?', args: [n(r.delta), n(r.bargain_id)] })
    await c.execute({ sql: 'DELETE FROM bargain_adjustments WHERE id = ?', args: [n(r.id)] })
  }
}

export async function applyNoteTopupUndo(noteId: number): Promise<void> {
  const c = getClient()
  // Whatever this note undid before goes back first, so applying twice never doubles.
  await undoNoteTopups(noteId)
  const note = (await c.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [n(noteId)] })).rows[0] as unknown as Row | undefined
  if (!note || String(note.note_type) !== 'credit' || String(note.party_type) !== 'customer') return
  const inv = String(note.against_ref || '').trim()
  if (!inv) return
  const items = (await c.execute({ sql: 'SELECT product_id, qty FROM note_items WHERE note_id = ? AND qty > 0', args: [n(noteId)] })).rows as unknown as Row[]
  for (const it of items) {
    // The bargain that invoice line drew on, for this product.
    const sale = (
      await c.execute({
        sql: `SELECT sales_bargain_id FROM sales WHERE TRIM(UPPER(invoice_no)) = TRIM(UPPER(?)) AND product_id = ? AND sales_bargain_id IS NOT NULL LIMIT 1`,
        args: [inv, n(it.product_id)]
      })
    ).rows[0] as unknown as Row | undefined
    const bid = n(sale?.sales_bargain_id)
    if (!bid) continue
    const topup = n(
      (await c.execute({
        sql: `SELECT COALESCE(SUM(delta), 0) AS t FROM bargain_adjustments
               WHERE kind = 'sales' AND bargain_id = ? AND note_id IS NULL AND delta > 0
                 AND TRIM(UPPER(note)) = TRIM(UPPER(?))`,
        args: [bid, `Top-up for invoice ${inv}`]
      })).rows[0]?.t
    )
    // Already undone by other notes against the same invoice.
    const undone = -n(
      (await c.execute({
        sql: `SELECT COALESCE(SUM(delta), 0) AS t FROM bargain_adjustments
               WHERE kind = 'sales' AND bargain_id = ? AND note_id IS NOT NULL AND note_id <> ? AND note LIKE ?`,
        args: [bid, n(noteId), `Top-up for invoice ${inv} undone%`]
      })).rows[0]?.t
    )
    const take = Math.round(Math.min(Math.max(0, topup - undone), n(it.qty)) * 1000) / 1000
    if (take <= 0) continue
    await c.execute({ sql: 'UPDATE sales_bargains SET qty = ROUND(qty - ?, 3) WHERE id = ?', args: [take, bid] })
    await c.execute({
      sql: "INSERT INTO bargain_adjustments (kind, bargain_id, delta, adj_date, note, note_id) VALUES ('sales', ?, ?, ?, ?, ?)",
      args: [bid, -take, String(note.note_date || '').slice(0, 10), `Top-up for invoice ${inv} undone — returned on ${String(note.note_no)}`, n(noteId)]
    })
  }
}

export async function createNote(v: Row, existingId?: number): Promise<{ id: number; note_no: string }> {
  const c = getClient()
  const cid = v.company_id ? n(v.company_id) : getActiveCompanyId()
  const type: 'debit' | 'credit' = v.note_type === 'credit' ? 'credit' : 'debit'
  // Defaults preserve the old behaviour for any caller that doesn't say.
  const requested = String(v.party_type || '').trim().toLowerCase()
  let partyType: PartyKind = (requested in PARTY_KINDS ? requested : type === 'debit' ? 'supplier' : 'customer') as PartyKind
  let kind: (typeof PARTY_KINDS)[PartyKind] = PARTY_KINDS[partyType]
  let partyId = n(v.party_id)
  // A caller that only knows the ledger name — the website enters a note in the
  // accounting grid, where the party is a ledger account, not a picked id — can
  // pass party_name instead, and the master is found through the ledger (see
  // partyByLedgerName). The id path above is untouched.
  if (!partyId && v.party_name) {
    const hit = await partyByLedgerName(String(v.party_name), cid, partyType, v.party_group ? String(v.party_group) : undefined)
    if (hit) {
      partyId = hit.id
      partyType = hit.kind
      kind = PARTY_KINDS[partyType]
    }
  }
  if (!partyId) {
    throw new Error(
      v.party_name
        ? `${String(v.party_name).trim()} is not linked to any ${partyType === 'customer' ? 'customer' : 'supplier or transporter'} in the masters. Add it there (or rename that party's ledger from Masters so the two are linked), then save again.`
        : `Select the ${partyType}`
    )
  }
  // Optional item lines. When present, they compute the base amount.
  const rawItems: Row[] = Array.isArray(v.items) ? v.items : []
  const items = rawItems
    .map((it) => {
      const qty = n(it.qty)
      const rate = n(it.rate)
      // WITH vs WITHOUT quantity, the Tally way. A line that carries a quantity
      // prices itself qty × rate and its quantity moves stock (for a real
      // return). A line with no quantity is a value-only adjustment against the
      // product — a rate difference, a discount, a claim — so its amount is
      // taken as entered and it never touches stock (SUM(qty) stays nil).
      const amount = qty > 0 ? round2(qty * rate) : round2(n(it.amount))
      return {
        product_id: it.product_id ? n(it.product_id) : null,
        description: it.description ? String(it.description).trim() : null,
        qty,
        rate,
        amount
      }
    })
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
  // THE BILL-WISE SPLIT, when the screen sends one — the party line's own
  // allocations (Agst Ref against one or more invoices, New Ref, Advance, On
  // Account). Without it the note settles against the one invoice named, or
  // stays On Account, as it always has.
  const METHODS = ['agst_ref', 'advance', 'on_account', 'new_ref']
  const splitIn: Row[] = (Array.isArray(v.allocs) ? (v.allocs as Row[]) : []).filter((a) => Number(a?.amount) > 0)
  for (const a of splitIn) {
    if (!METHODS.includes(String(a.method))) throw new Error(`Unknown bill-wise method "${String(a.method)}"`)
    if (String(a.method) !== 'on_account' && !String(a.ref_name || '').trim()) {
      throw new Error('Every bill-wise line except On Account needs a reference')
    }
  }
  const againstRef = v.against_invoice
    ? String(v.against_invoice).trim()
    : String(splitIn.find((a) => String(a.method) === 'agst_ref')?.ref_name || '').trim() || null
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
    await undoNoteTopups(n(existingId))
    if (prior.journal_entry_id != null) {
      await c.execute({ sql: 'UPDATE notes SET journal_entry_id = NULL WHERE id = ?', args: [n(existingId)] })
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
  // WHICH HEAD THIS NOTE ADJUSTS.
  //
  // A note carries a rate but not a head, because it is written against
  // something else and takes that thing's treatment: a credit note against an
  // IGST sale must put the tax back where the sale charged it, not split it
  // into two state heads that were never touched. So the original invoice
  // decides where one is named, and intra-state stands in where it is not.
  const noteGstType: GstType = await (async (): Promise<GstType> => {
    // Picked on the note itself — the website's GST panel names it — wins.
    if (v.gst_type === 'IGST' || v.gst_type === 'CGST_SGST') return v.gst_type
    const ref = String(againstRef || '').trim()
    if (!ref) return DEFAULT_GST_TYPE
    const table = partyType === 'customer' ? 'sales' : 'orders'
    const r = await c
      .execute({
        sql: `SELECT gst_type FROM ${table} WHERE TRIM(UPPER(invoice_no)) = ? LIMIT 1`,
        args: [ref.toUpperCase()]
      })
      .catch(() => null)
    const row = r ? (r.rows[0] as unknown as Row | undefined) : undefined
    return row ? asGstType(row.gst_type) : DEFAULT_GST_TYPE
  })()

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
            ...gstLines({ side: kind.gst, pct: gstPct, type: noteGstType, cr: gst }),
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', cr: roundOff > 0 ? roundOff : 0, dr: roundOff < 0 ? -roundOff : 0 }
          ]
        : [
            { account: against, group: againstGroup, dr: base },
            ...gstLines({ side: kind.gst, pct: gstPct, type: noteGstType, dr: gst }),
            { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
            { account: partyName || 'CASH CUSTOMER A/C', group: kind.group, cr: total }
          ]
  })

  // Bill-wise: the note settles against the original invoice when one is
  // named, otherwise it stays On Account — exactly like a payment would.
  // The party line is found under the ledger the posting actually landed on,
  // which for a renamed party is the new name, not the master's — matched on
  // the old one it was never found, and the note carried no bill-wise line.
  const partyAccount = (await resolveAccountName(partyName, cid)).trim().toUpperCase()
  const partyLine = await c.execute({
    sql: `SELECT jl.id, jl.account_id FROM journal_lines jl
          JOIN ledger_accounts a ON a.id = jl.account_id
          WHERE jl.entry_id = ? AND UPPER(TRIM(a.name)) IN (?, ?) LIMIT 1`,
    args: [je.id, partyAccount, partyName.toUpperCase()]
  })
  if (partyLine.rows.length && splitIn.length) {
    const sum = Math.round(splitIn.reduce((s, a) => s + Number(a.amount), 0) * 100) / 100
    if (Math.abs(sum - total) > 0.01) {
      throw new Error(`The bill-wise split (${sum.toFixed(2)}) must add up to the note total (${total.toFixed(2)})`)
    }
    for (const a of splitIn) {
      const method = String(a.method)
      const ref = method === 'on_account' ? null : String(a.ref_name || '').trim()
      // The ids the screen picked the bill by; looked up by the reference only
      // when it did not send them.
      let ids = { order_id: a.order_id ? Number(a.order_id) : null, sale_invoice_group: a.sale_invoice_group ? String(a.sale_invoice_group) : null }
      if (method === 'agst_ref' && ref && !ids.order_id && !ids.sale_invoice_group) {
        ids = await resolveRefIds(ref, cid, partyType === 'customer' ? 'customer' : 'supplier')
      }
      await c.execute({
        sql: `INSERT INTO journal_bill_allocs (line_id, account_id, method, ref_name, amount, order_id, sale_invoice_group)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          Number(partyLine.rows[0].id),
          Number(partyLine.rows[0].account_id),
          method,
          ref,
          Math.round(Number(a.amount) * 100) / 100,
          ids.order_id,
          ids.sale_invoice_group
        ]
      })
    }
  } else if (partyLine.rows.length) {
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
  await applyNoteTopupUndo(noteId)
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
  await undoNoteTopups(id)
  // Reverse the journal voucher (both legs) and the party-ledger row.
  if (note.journal_entry_id != null) {
    await c.execute({ sql: 'UPDATE notes SET journal_entry_id = NULL WHERE id = ?', args: [id] })
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

// A NOTE WHOSE VOUCHER IS GONE (CN/3: its voucher #8070 was removed by a Tally
// clean-up, which left the note — its stock return and ledger row — behind).
// It can be tied to the voucher that books the same thing now (Tally's copy of
// the same return), after which opening that voucher opens the note.
export async function noteRelinkCandidates(noteId: number): Promise<Row[]> {
  const c = getClient()
  const note = (await c.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [n(noteId)] })).rows[0] as Row | undefined
  if (!note) throw new Error('That note no longer exists')
  const vt = String(note.note_type) === 'credit' ? 'CREDIT NOTE' : 'DEBIT NOTE'
  const res = await c.execute({
    sql: `SELECT je.id, je.entry_date, je.vch_no, je.narration,
                 (SELECT vn.prefix || '/' || vn.serial FROM voucher_numbers vn WHERE vn.entry_id = je.id) AS code,
                 (SELECT SUM(jl.dr) FROM journal_lines jl WHERE jl.entry_id = je.id) AS amount
            FROM journal_entries je
           WHERE je.company_id = ? AND je.vch_type = ?
             AND NOT EXISTS (SELECT 1 FROM notes o WHERE o.journal_entry_id = je.id)
             AND ABS(julianday(je.entry_date) - julianday(?)) <= 60`,
    args: [n(note.company_id), vt, String(note.note_date)]
  })
  return toPlain(res)
    .filter((r) => Math.abs(n(r.amount) - n(note.total_amount)) <= 1)
    .sort((a, b) => Math.abs(Date.parse(String(a.entry_date)) - Date.parse(String(note.note_date))) - Math.abs(Date.parse(String(b.entry_date)) - Date.parse(String(note.note_date))))
}

export async function relinkNote(noteId: number, entryId: number): Promise<{ id: number; entry_id: number }> {
  const c = getClient()
  const note = (await c.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [n(noteId)] })).rows[0] as Row | undefined
  if (!note) throw new Error('That note no longer exists')
  const has = (await c.execute({ sql: 'SELECT id FROM journal_entries WHERE id = ?', args: [n(note.journal_entry_id)] })).rows.length
  if (has) throw new Error(`${String(note.note_no)} still has its voucher — nothing to tie`)
  const ok = (await noteRelinkCandidates(noteId)).some((r) => n(r.id) === n(entryId))
  if (!ok) throw new Error('That voucher is not one this note can be tied to (same company, type and amount, not another note\'s)')
  await c.execute({ sql: 'UPDATE notes SET journal_entry_id = ? WHERE id = ?', args: [n(entryId), n(noteId)] })
  return { id: n(noteId), entry_id: n(entryId) }
}
