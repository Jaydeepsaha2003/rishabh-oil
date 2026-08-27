import type { ResultSet } from '@libsql/client'
import { getClient, bumpRevision } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'
import { createNote, deleteNote } from './notes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

const n = (v: unknown): number => Number(v) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100
const todayISO = (): string => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Transporter freight, kept off the transporter's own ledger until they bill.
//
// A transporter runs several tankers over a month and raises ONE bill for the
// lot. Crediting them tanker by tanker filled their ledger with amounts they
// had never invoiced, so freight now sits in transporter_ledger (the running
// record of what they have earned) and reaches the books only when their bill
// is entered here.
//
// Two sides, two registers:
//   purchase — freight on inward tankers (transporter_ledger.order_id set)
//   sales    — freight on outward deliveries (transporter_ledger.sale_id set)
// ---------------------------------------------------------------------------

export type FreightSide = 'purchase' | 'sales'

// One line per freight entry, with the document behind it and whether a bill
// has picked it up yet.
export async function listTransporterFreight(
  side: FreightSide,
  opts: { companyId?: number; from?: string; to?: string; transporterId?: number; state?: 'all' | 'unbilled' | 'billed' } = {}
): Promise<Row[]> {
  const c = getClient()
  const cid = opts.companyId ? n(opts.companyId) : getActiveCompanyId()
  const args: (string | number)[] = [cid]
  const where: string[] = ['l.company_id = ?', "l.entry_type IN ('freight', 'shortage_penalty')"]
  where.push(side === 'purchase' ? 'l.order_id IS NOT NULL' : 'l.sale_id IS NOT NULL')
  if (opts.from) {
    where.push('COALESCE(l.entry_date, ?) >= ?')
    args.push(opts.from, opts.from)
  }
  if (opts.to) {
    where.push("COALESCE(l.entry_date, '9999-12-31') <= ?")
    args.push(opts.to)
  }
  if (opts.transporterId) {
    where.push('l.transporter_id = ?')
    args.push(n(opts.transporterId))
  }
  if (opts.state === 'unbilled') where.push('l.bill_id IS NULL')
  if (opts.state === 'billed') where.push('l.bill_id IS NOT NULL')

  const doc =
    side === 'purchase'
      ? `o.invoice_no AS doc_no, o.order_date AS doc_date, s.name AS party_name,
         p.name AS product_name,
         -- Purchase freight is booked per TANKER (one ledger row each) under a
         -- single oil invoice, and the tanker number lives in the note the
         -- ledger writer stamps: "Tanker XX/1234: freight less shortage".
         COALESCE(
           NULLIF(TRIM(SUBSTR(l.note, 8, INSTR(l.note, ':') - 8)), ''),
           o.tanker_no
         ) AS vehicle_no,
         o.ordered_qty AS dispatch_qty, o.received_qty AS received_qty,
         o.status AS dispatch_stage,
         CASE WHEN o.status != 'received' THEN 1 ELSE 0 END AS provisional`
      : `sa.invoice_no AS doc_no, sa.sale_date AS doc_date, COALESCE(cu.name, sa.customer) AS party_name,
         p.name AS product_name,
         -- A sale has no tanker record of its own; the vehicle that carried it
         -- is whatever the gate wrote against the invoice group on the way out.
         (SELECT ge.tanker_no FROM gate_entries ge
           WHERE ge.direction = 'out' AND ge.invoice_group = sa.invoice_group
             AND sa.invoice_group IS NOT NULL ORDER BY ge.id DESC LIMIT 1) AS vehicle_no,
         sa.qty AS dispatch_qty, sa.received_qty AS received_qty, sa.dispatch_stage AS dispatch_stage,
         -- Until the invoice is unloaded there is no weighed-in quantity, so the
         -- freight is still an estimate off the dispatched qty. Flagged so the
         -- register can say "valuation" rather than presenting a provisional
         -- figure as something the transporter can be billed on.
         CASE WHEN sa.dispatch_stage = 'unloaded' OR (sa.dispatch_stage IS NULL AND sa.status = 'done')
              THEN 0 ELSE 1 END AS provisional`
  const joins =
    side === 'purchase'
      ? `LEFT JOIN orders o ON o.id = l.order_id
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         LEFT JOIN products p ON p.id = o.oil_type_id`
      : `LEFT JOIN sales sa ON sa.id = l.sale_id
         LEFT JOIN customers cu ON cu.id = sa.customer_id
         LEFT JOIN products p ON p.id = sa.product_id`

  const res = await c.execute({
    sql: `SELECT l.id, l.transporter_id, l.entry_date, l.entry_type, l.amount, l.note,
                 l.accrued, l.bill_id, l.note_id, nt.note_no, nt.note_date,
                 t.name AS transporter_name,
                 b.bill_no, b.bill_date, ${doc}
          FROM transporter_ledger l
          LEFT JOIN transporters t ON t.id = l.transporter_id
          LEFT JOIN transporter_bills b ON b.id = l.bill_id
          LEFT JOIN notes nt ON nt.id = l.note_id
          ${joins}
          WHERE ${where.join(' AND ')}
          ORDER BY COALESCE(l.entry_date, '') DESC, l.id DESC`,
    args
  })
  return toPlain(res)
}

// Headline figures for the register: what each side has earned, and how much of
// it the transporters have not yet invoiced.
export async function transporterFreightKpis(
  side: FreightSide,
  opts: { companyId?: number; from?: string; to?: string } = {}
): Promise<Row> {
  const rows = await listTransporterFreight(side, { ...opts, state: 'all' })
  const total = round2(rows.reduce((t, r) => t + n(r.amount), 0))
  const unbilled = round2(rows.filter((r) => r.bill_id == null).reduce((t, r) => t + n(r.amount), 0))
  const parties = new Set(rows.filter((r) => r.bill_id == null).map((r) => String(r.transporter_id)))
  // The part of "not booked" that is still only an estimate — worth showing
  // apart, since it is not yet a figure anyone should raise a bill on.
  const provisional = round2(
    rows.filter((r) => r.bill_id == null && n(r.provisional) === 1).reduce((t, r) => t + n(r.amount), 0)
  )
  return {
    lines: rows.length,
    unbilled_lines: rows.filter((r) => r.bill_id == null).length,
    total,
    billed: round2(total - unbilled),
    unbilled,
    provisional,
    firm: round2(unbilled - provisional),
    transporters_pending: parties.size
  }
}

export async function listTransporterBills(companyId?: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT b.*, t.name AS transporter_name,
                 (SELECT COUNT(*) FROM transporter_ledger l WHERE l.bill_id = b.id) AS line_count
          FROM transporter_bills b
          LEFT JOIN transporters t ON t.id = b.transporter_id
          WHERE b.company_id = ?
          ORDER BY b.id DESC`,
    args: [companyId ? n(companyId) : getActiveCompanyId()]
  })
  return toPlain(res)
}

async function dropEntry(entryId?: number | null): Promise<void> {
  if (!entryId) return
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [entryId]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [entryId] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [entryId] })
}

// Enter the transporter's bill for a set of freight lines, and post it.
//
//   Dr FREIGHT PAYABLE A/C   the part already accrued when the goods moved
//   Dr FREIGHT INWARD A/C    the part never accrued (inward freight is not on
//                            the purchase voucher, so the expense lands here)
//   Dr GST INPUT A/C         gst
//     Cr TDS PAYABLE A/C     tds
//     Cr {Transporter}       what they are actually owed
//   Dr/Cr ROUND OFF A/C
//
// Splitting the debit by the accrued flag is what lets one bill cover tankers
// from both sides without either double-counting the expense or debiting a
// payable that was never credited.
export async function createTransporterBill(v: Row, existingId?: number): Promise<{ id: number }> {
  const c = getClient()
  const cid = v.company_id ? n(v.company_id) : getActiveCompanyId()
  const transporterId = n(v.transporter_id)
  if (!transporterId) throw new Error('Select the transporter')
  const side: FreightSide = v.side === 'sales' ? 'sales' : 'purchase'
  const lineIds = (Array.isArray(v.line_ids) ? v.line_ids : []).map(n).filter((x) => x > 0)
  if (!lineIds.length) throw new Error('Tick at least one freight line for this bill')

  const ph = lineIds.map(() => '?').join(', ')
  const linesRes = await c.execute({
    sql: `SELECT id, transporter_id, amount, accrued, bill_id FROM transporter_ledger
          WHERE id IN (${ph}) AND company_id = ?`,
    args: [...lineIds, cid]
  })
  const picked = toPlain(linesRes)
  if (picked.length !== lineIds.length) throw new Error('Some of those freight lines no longer exist')
  for (const l of picked) {
    if (n(l.transporter_id) !== transporterId) throw new Error('Every line on one bill must belong to the same transporter')
    if (l.bill_id != null && n(l.bill_id) !== n(existingId)) throw new Error('One of those lines is already on another bill')
    // Claimed on its own debit note, so it has already come off what the
    // transporter is owed. Netting it into the bill as well would recover the
    // same shortage twice.
    if (l.note_id != null) {
      throw new Error('That shortage is already on a debit note — leave it off the bill, which books the freight in full')
    }
  }

  const accrued = round2(picked.filter((l) => n(l.accrued) === 1).reduce((t, l) => t + n(l.amount), 0))
  const unaccrued = round2(picked.filter((l) => n(l.accrued) !== 1).reduce((t, l) => t + n(l.amount), 0))
  // A shortage penalty is stored negative, so the taxable value is the net of
  // what they earned less what we are holding back.
  const lineTotal = round2(accrued + unaccrued)
  // What the transporter actually billed, less/more than the tanker lines come
  // to. It rides on the same expense as the freight it adjusts, so the register
  // and the ledger stay reconcilable.
  const adjustment = round2(n(v.adjustment))
  const taxable = round2(lineTotal + adjustment)
  if (taxable <= 0) throw new Error('The bill nets to zero or less — check the adjustment')
  const gstPct = n(v.gst_pct)
  const gst = round2((taxable * gstPct) / 100)
  const tdsPct = n(v.tds_pct)
  const tds = round2((taxable * tdsPct) / 100)
  const raw = round2(taxable + gst - tds)
  const total = Math.round(raw)
  const roundOff = round2(total - raw)
  const billDate = String(v.bill_date || todayISO()).slice(0, 10)
  const billNo = v.bill_no ? String(v.bill_no).trim() : null
  const note = v.note ? String(v.note).trim() : null

  const partyRes = await c.execute({ sql: 'SELECT name FROM transporters WHERE id = ?', args: [transporterId] })
  if (!partyRes.rows.length) throw new Error('Transporter not found')
  const partyName = String(partyRes.rows[0].name || '').trim()

  const prior = existingId
    ? ((await c.execute({ sql: 'SELECT * FROM transporter_bills WHERE id = ? AND company_id = ?', args: [existingId, cid] })).rows[0] as Row | undefined)
    : undefined
  if (existingId && !prior) throw new Error('That bill no longer exists')
  if (prior) {
    await dropEntry(n(prior.journal_entry_id) || null)
    // Release the lines it used to cover; the ones still picked are re-tagged
    // below, any dropped line goes back to unbilled.
    await c.execute({ sql: 'UPDATE transporter_ledger SET bill_id = NULL WHERE bill_id = ?', args: [existingId as number] })
  }

  const je = await postJournal({
    date: billDate,
    // A freight bill IS a purchase of a service, so it belongs in the purchase
    // series and reads as PUR in the ledger — not as an unexplained JV.
    vchType: side === 'purchase' ? 'PURCHASE FREIGHT INWARD' : 'PURCHASE FREIGHT OUTWARD',
    vchNo: billNo,
    narration:
      `Transporter bill ${billNo || ''} — ${partyName} (${side === 'purchase' ? 'inward' : 'outward'} freight, ` +
      `${picked.length} line${picked.length === 1 ? '' : 's'}` +
      (adjustment ? `, adjusted by ${adjustment > 0 ? '+' : ''}${adjustment.toFixed(2)}` : '') +
      ')' +
      (v.adjustment_note ? ` — ${String(v.adjustment_note).trim()}` : ''),
    companyId: cid,
    lines: [
      { account: 'FREIGHT PAYABLE A/C', group: 'Current Liabilities', dr: accrued },
      {
        account: side === 'purchase' ? 'FREIGHT INWARD A/C' : 'FREIGHT OUTWARD A/C',
        group: 'Direct Expenses',
        // The adjustment is freight too, so it lands on the same expense —
        // positive as more cost, negative as less.
        dr: round2(unaccrued + adjustment) > 0 ? round2(unaccrued + adjustment) : 0,
        cr: round2(unaccrued + adjustment) < 0 ? -round2(unaccrued + adjustment) : 0
      },
      { account: 'GST INPUT A/C', group: 'Duties & Taxes', dr: gst },
      { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
      { account: 'TDS PAYABLE A/C', group: 'Duties & Taxes', cr: tds },
      { account: partyName, group: 'Sundry Creditors', cr: total }
    ]
  })

  let billId: number
  if (prior) {
    await c.execute({
      sql: `UPDATE transporter_bills SET transporter_id = ?, side = ?, bill_no = ?, bill_date = ?,
              taxable = ?, gst_pct = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?,
              total = ?, journal_entry_id = ?, note = ?, adjustment = ?, adjustment_note = ?
            WHERE id = ? AND company_id = ?`,
      args: [transporterId, side, billNo, billDate, taxable, gstPct, gst, tdsPct, tds, roundOff, total, je.id ?? null, note,
             adjustment, v.adjustment_note ? String(v.adjustment_note).trim() : null, existingId as number, cid]
    })
    billId = existingId as number
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO transporter_bills
              (company_id, transporter_id, side, bill_no, bill_date, taxable, gst_pct, gst_amount,
               tds_pct, tds_amount, round_off, total, journal_entry_id, note, adjustment, adjustment_note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cid, transporterId, side, billNo, billDate, taxable, gstPct, gst, tdsPct, tds, roundOff, total, je.id, note,
             adjustment, v.adjustment_note ? String(v.adjustment_note).trim() : null]
    })
    billId = Number(ins.lastInsertRowid)
  }
  await c.execute({ sql: `UPDATE transporter_ledger SET bill_id = ? WHERE id IN (${ph})`, args: [billId, ...lineIds] })
  return { id: billId }
}

// Raise a debit note on the transporter for one shortage line.
//
// The alternative is to let it net into their freight bill, which is what
// happens if this is never called — the register line is a deduction either
// way. This makes it a document: the transporter's own ledger shows the debit,
// and there is something to send them.
//
// Credit goes to FREIGHT OUTWARD, because the recovery reduces what the
// delivery cost rather than earning anything, and no GST: a shortage recovery
// is not a supply.
export async function raiseFreightShortageNote(
  lineId: number,
  v: { date?: string; companyId?: number } = {}
): Promise<{ note_id: number; note_no: string }> {
  const c = getClient()
  const cid = v.companyId ? n(v.companyId) : getActiveCompanyId()
  const r = await c.execute({
    sql: `SELECT l.*, s.invoice_no AS sale_invoice, o.invoice_no AS order_invoice
            FROM transporter_ledger l
            LEFT JOIN sales s ON s.id = l.sale_id
            LEFT JOIN orders o ON o.id = l.order_id
           WHERE l.id = ? AND l.company_id = ?`,
    args: [n(lineId), cid]
  })
  if (!r.rows.length) throw new Error('That freight line no longer exists')
  const line = toPlain(r)[0]
  if (String(line.entry_type) !== 'shortage_penalty') {
    throw new Error('Only a shortage line can be raised as a debit note')
  }
  if (line.note_id != null) throw new Error('A debit note has already been raised on this shortage')
  if (line.bill_id != null) {
    throw new Error('That shortage is already netted into a booked bill — delete the bill first if it should be claimed separately')
  }
  const amount = round2(Math.abs(n(line.amount)))
  if (amount <= 0) throw new Error('Nothing to claim on this line')
  if (!line.transporter_id) throw new Error('This line has no transporter to raise a note against')

  const inv = String(line.sale_invoice || line.order_invoice || '')
  const note = await createNote({
    company_id: cid,
    note_type: 'debit',
    party_type: 'transporter',
    party_id: n(line.transporter_id),
    note_date: String(v.date || line.entry_date || todayISO()).slice(0, 10),
    against_account: 'FREIGHT OUTWARD A/C',
    base_amount: amount,
    gst_pct: 0,
    against_invoice: inv || null,
    narration: `Shortage recovery${inv ? ` on ${inv}` : ''}${line.note ? ` — ${String(line.note)}` : ''}`
  })
  await c.execute({
    sql: 'UPDATE transporter_ledger SET note_id = ? WHERE id = ?',
    args: [note.id, n(lineId)]
  })
  await bumpRevision()
  return { note_id: note.id, note_no: note.note_no }
}

// Undo it: the note is deleted (reversing its voucher and its ledger row) and
// the shortage goes back to being a deduction on the freight bill.
export async function unraiseFreightShortageNote(lineId: number, companyId?: number): Promise<{ id: number }> {
  const c = getClient()
  const cid = companyId ? n(companyId) : getActiveCompanyId()
  const r = await c.execute({
    sql: 'SELECT note_id FROM transporter_ledger WHERE id = ? AND company_id = ?',
    args: [n(lineId), cid]
  })
  if (!r.rows.length) throw new Error('That freight line no longer exists')
  const noteId = r.rows[0].note_id
  // Cleared FIRST: if deleting the note fails the line must not be left
  // pointing at a note that is half gone.
  await c.execute({ sql: 'UPDATE transporter_ledger SET note_id = NULL WHERE id = ?', args: [n(lineId)] })
  if (noteId != null) await deleteNote(n(noteId), cid)
  await bumpRevision()
  return { id: n(lineId) }
}

export async function updateTransporterBill(id: number, v: Row): Promise<{ id: number }> {
  return createTransporterBill(v, n(id))
}

// Bills whose journal voucher no longer exists. Before the guard in
// deleteManualEntry, a freight voucher could be deleted from the Day Book on
// its own — which left the bill row standing and its freight lines flagged as
// billed, so the Freight Working register still read as booked with nothing
// behind it. Reported so the state can be seen rather than guessed at.
export async function listOrphanedTransporterBills(companyId?: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT tb.*, tr.name AS transporter_name,
                 (SELECT COUNT(*) FROM transporter_ledger l WHERE l.bill_id = tb.id) AS line_count,
                 (SELECT ROUND(SUM(l.amount), 2) FROM transporter_ledger l WHERE l.bill_id = tb.id) AS line_amount
            FROM transporter_bills tb
            LEFT JOIN transporters tr ON tr.id = tb.transporter_id
           WHERE tb.company_id = ?
             AND tb.journal_entry_id IS NOT NULL
             AND tb.journal_entry_id NOT IN (SELECT id FROM journal_entries)
           ORDER BY tb.id`,
    args: [companyId ? n(companyId) : getActiveCompanyId()]
  })
  return toPlain(res)
}

// companyId comes from the caller: the Accounting module pins its own company
// (F3) rather than following the app-wide one, and reading the active company
// here meant a delete issued from a register showing company A could silently
// match nothing while the register kept showing the bill.
export async function deleteTransporterBill(id: number, companyId?: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: 'SELECT * FROM transporter_bills WHERE id = ? AND company_id = ?',
    args: [id, companyId ? n(companyId) : getActiveCompanyId()]
  })
  if (!res.rows.length) throw new Error('That transporter bill no longer exists in this company')
  const bill = res.rows[0] as Row
  await dropEntry(n(bill.journal_entry_id) || null)
  // The freight itself is not deleted — it was still earned. It simply goes
  // back to unbilled.
  await c.execute({ sql: 'UPDATE transporter_ledger SET bill_id = NULL WHERE bill_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_bills WHERE id = ?', args: [id] })
  return { id }
}
