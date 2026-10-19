import type { ResultSet } from '@libsql/client'
import { getClient, bumpRevision, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { postJournal } from './journal'
import { createNote, deleteNote } from './notes'
import { gstLines, DEFAULT_GST_TYPE } from './gstLedgers'
import { getCurrentUser } from './currentUser'

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
  if (side === 'sales') {
    // Freight the CUSTOMER settles with the truck is not ours to pay, so it has
    // no business on a register of what we owe transporters. postSaleFreight
    // already refuses to post it; this applies the same rule on the way out, so
    // an invoice created before the box was ticked cannot leave a row behind
    // that someone then bills to a transporter we owe nothing.
    where.push("COALESCE((SELECT sa2.deduct_freight FROM sales sa2 WHERE sa2.id = l.sale_id), 0) <> 1")
  }
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
      ? `o.invoice_no AS doc_no, o.order_date AS doc_date, s.name AS party_name, o.gst_pct AS oil_gst_pct,
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
      : `sa.invoice_no AS doc_no, sa.sale_date AS doc_date, COALESCE(cu.name, sa.customer) AS party_name, sa.gst_pct AS oil_gst_pct,
         p.name AS product_name,
         -- A sale has no tanker record of its own; the vehicle that carried it
         -- is whatever the gate wrote against the invoice group on the way out.
         -- Resolved through the join below rather than a subquery per row.
         gv.tanker_no AS vehicle_no,
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
         LEFT JOIN products p ON p.id = sa.product_id
         LEFT JOIN (SELECT ge.invoice_group AS grp, MAX(ge.id) AS ge_id
                      FROM gate_entries ge
                     WHERE ge.direction = 'out' AND ge.invoice_group IS NOT NULL
                     GROUP BY ge.invoice_group) go2 ON go2.grp = sa.invoice_group
         LEFT JOIN gate_entries gv ON gv.id = go2.ge_id`

  const res = await c.execute({
    sql: `SELECT l.id, l.transporter_id, l.order_id, l.sale_id, l.entry_date, l.entry_type, l.amount, l.note,
                 l.accrued, l.bill_id, l.note_id, l.waived_at, l.waived_by, l.waived_reason,
                 nt.note_no, nt.note_date,
                 t.name AS transporter_name, COALESCE(t.gst_registration, 'registered') AS gst_registration,
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
  // AN UNREGISTERED TRANSPORTER CANNOT TAKE A DEBIT NOTE WITH GST, so the oil
  // they lost is recovered at what it cost us with its GST — oil rate plus
  // the invoice's GST % — straight off their freight. The ledger row keeps
  // the plain value (amount_base); the register and the bill read the
  // recovered figure.
  return toPlain(res).map((r) =>
    String(r.entry_type) === 'shortage_penalty' && String(r.gst_registration) === 'unregistered'
      ? { ...r, amount_base: n(r.amount), amount: shortageRecovered(n(r.amount), n(r.oil_gst_pct)) }
      : r
  )
}

/** A shortage as recovered from an unregistered transporter: its value plus the oil's GST. */
function shortageRecovered(base: number, gstPct: number): number {
  return round2(base * (1 + Math.max(0, gstPct) / 100))
}

async function transporterRegistration(transporterId: number): Promise<'registered' | 'unregistered'> {
  const r = await getClient().execute({ sql: 'SELECT gst_registration FROM transporters WHERE id = ?', args: [n(transporterId)] })
  return String((r.rows[0] as unknown as Row | undefined)?.gst_registration || '') === 'unregistered' ? 'unregistered' : 'registered'
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

// RCM — GST ON AN UNREGISTERED TRANSPORTER'S FREIGHT, PAID BY US.
//
// A transporter who bills without GST leaves the tax to the recipient under
// reverse charge: 5% on the freight, paid in cash with the return and then
// claimed back as input. So the bill's own JV carries both halves —
//   Dr RCM INPUT CGST 2.5% / RCM INPUT SGST 2.5%      the credit we can take
//     Cr RCM PAYABLE CGST 2.5% / RCM PAYABLE SGST 2.5%  the tax we owe
// — which net to nothing on the transporter, and leave the liability and the
// credit standing for GSTR-3B (3.1(d) and 4(A)(3)). Their own names, not the
// INPUT/OUTPUT GST ledgers, so the GST registers of bills stay as they were.
export const RCM_DEFAULT_PCT = 5

function rcmJournalLines(pct: number, amount: number): ReturnType<typeof gstLines> {
  if (!(amount > 0.004)) return []
  return [
    ...gstLines({ side: 'INPUT', pct, type: DEFAULT_GST_TYPE, dr: amount }).map((l) => ({ ...l, account: `RCM ${l.account}` })),
    ...gstLines({ side: 'OUTPUT', pct, type: DEFAULT_GST_TYPE, cr: amount }).map((l) => ({
      ...l,
      account: l.account.replace(/^OUTPUT /, 'RCM PAYABLE ')
    }))
  ]
}

// Enter the transporter's bill for a set of freight lines, and post it.
//
//   Dr FREIGHT PAYABLE A/C   the part already accrued when the goods moved
//   Dr FREIGHT INWARD A/C    the part never accrued (inward freight is not on
//                            the purchase voucher, so the expense lands here)
//   Dr INPUT CGST/SGST       gst — a carrier is in the same state, so two heads
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
    sql: `SELECT l.id, l.transporter_id, l.amount, l.accrued, l.bill_id, l.note_id, l.waived_at, l.entry_type,
                 COALESCE(o.gst_pct, sa.gst_pct, 0) AS oil_gst_pct
          FROM transporter_ledger l
          LEFT JOIN orders o ON o.id = l.order_id
          LEFT JOIN sales sa ON sa.id = l.sale_id
          WHERE l.id IN (${ph}) AND l.company_id = ?`,
    args: [...lineIds, cid]
  })
  const reg = await transporterRegistration(transporterId)
  // Unregistered: each shortage comes off at its value plus the oil's GST.
  const picked = toPlain(linesRes).map((l) =>
    reg === 'unregistered' && String(l.entry_type) === 'shortage_penalty'
      ? { ...l, amount: shortageRecovered(n(l.amount), n(l.oil_gst_pct)) }
      : l
  )
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
    // Written off rather than claimed, so the transporter is owed the freight
    // in full and this line has nothing left to net.
    if (l.waived_at != null) {
      throw new Error('That shortage was written off — leave it off the bill, which books the freight in full')
    }
    // A REGISTERED transporter's shortage is claimed on a debit note with GST,
    // never netted into the bill. A line already on this bill (an older bill
    // being re-saved) is left as it was booked.
    if (reg === 'registered' && String(l.entry_type) === 'shortage_penalty' && !(existingId && n(l.bill_id) === n(existingId))) {
      throw new Error('This transporter is GST registered — raise a debit note (NOTE) for the shortage instead of netting it into the bill')
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
  // Unregistered: no GST on their freight (it is under reverse charge — marked
  // on the voucher, accounted for separately).
  const gstPct = reg === 'unregistered' ? 0 : n(v.gst_pct)
  const gst = round2((taxable * gstPct) / 100)
  // Unregistered: the RCM we owe on it (5% unless the bill says otherwise; 0
  // books the freight with no RCM, as every bill before this did).
  const rcmPct = reg === 'unregistered' ? (v.rcm_pct == null || v.rcm_pct === '' ? RCM_DEFAULT_PCT : Math.max(0, n(v.rcm_pct))) : 0
  const rcm = round2((taxable * rcmPct) / 100)
  const tdsPct = n(v.tds_pct)
  const tds = round2((taxable * tdsPct) / 100)
  // OTHERS: anything else recovered on this bill — damage, detention, a
  // short-loaded drum — taken off what the transporter is paid and credited to
  // the ledger named. It is not freight, so it leaves the GST and TDS alone.
  const frAccount = side === 'purchase' ? 'FREIGHT INWARD A/C' : 'FREIGHT OUTWARD A/C'
  // AS MANY DEDUCTIONS AS THE BILL HAS — detention, damage, a short drum —
  // each its own JV line on the ledger it names (freight by default). The
  // single Others of a bill booked before reads as a list of one.
  const deductions = (
    Array.isArray(v.deductions)
      ? (v.deductions as Row[])
      : n(v.others_amount) > 0.004
        ? [{ amount: v.others_amount, ledger: v.others_ledger, note: v.others_note }]
        : []
  )
    .map((d) => ({
      amount: round2(Math.max(0, n(d.amount))),
      ledger: (String(d.ledger || '').trim() || frAccount).toUpperCase(),
      note: String(d.note || '').trim()
    }))
    .filter((d) => d.amount > 0.004)
  const othersAmt = round2(deductions.reduce((t, d) => t + d.amount, 0))
  // The first deduction's ledger, kept on the bill row as before.
  const othersLedger = deductions.length ? deductions[0].ledger : null
  const raw = round2(taxable + gst - tds - othersAmt)
  if (raw <= 0) throw new Error('After the deductions nothing is left to pay the transporter — check the Others amount')
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
    // An unregistered transporter's freight is booked as a JV (no GST bill to
    // record against); a registered one's stays in the purchase series.
    vchType: reg === 'unregistered' ? 'JOURNAL' : side === 'purchase' ? 'PURCHASE FREIGHT INWARD' : 'PURCHASE FREIGHT OUTWARD',
    vchNo: billNo,
    narration:
      `Transporter bill ${billNo || ''} — ${partyName} (${side === 'purchase' ? 'inward' : 'outward'} freight, ` +
      `${picked.length} line${picked.length === 1 ? '' : 's'}` +
      (adjustment ? `, adjusted by ${adjustment > 0 ? '+' : ''}${adjustment.toFixed(2)}` : '') +
      ')' +
      (v.adjustment_note ? ` — ${String(v.adjustment_note).trim()}` : '') +
      (deductions.length
        ? `; deducted ${deductions.map((d) => `${d.amount.toFixed(2)}${d.note ? ` ${d.note}` : ''}`).join(', ')}`
        : '') +
      (reg === 'unregistered'
        ? rcm > 0.004
          ? ` — unregistered transporter, RCM ${rcmPct}% ${rcm.toFixed(2)} booked`
          : ' — unregistered transporter, RCM applicable'
        : ''),
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
      // A freight bill records no head of its own. A carrier billing this
      // site is in the same state, which is the conservative reading anyway:
      // it splits into central and state tax rather than lumping a state tax
      // into the central one.
      ...gstLines({ side: 'INPUT', pct: n(v.gst_pct), type: DEFAULT_GST_TYPE, dr: gst }),
      ...rcmJournalLines(rcmPct, rcm),
      { account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: roundOff > 0 ? roundOff : 0, cr: roundOff < 0 ? -roundOff : 0 },
      { account: 'TDS PAYABLE A/C', group: 'Duties & Taxes', cr: tds },
      ...deductions.map((d) => ({ account: d.ledger, group: d.ledger === frAccount ? 'Direct Expenses' : 'Indirect Incomes', cr: d.amount })),
      { account: partyName, group: 'Sundry Creditors', cr: total }
    ]
  })

  let billId: number
  if (prior) {
    await c.execute({
      sql: `UPDATE transporter_bills SET transporter_id = ?, side = ?, bill_no = ?, bill_date = ?,
              taxable = ?, gst_pct = ?, gst_amount = ?, tds_pct = ?, tds_amount = ?, round_off = ?,
              total = ?, journal_entry_id = ?, note = ?, adjustment = ?, adjustment_note = ?,
              others_amount = ?, others_ledger = ?, rcm_pct = ?, rcm_amount = ?, deductions_json = ?
            WHERE id = ? AND company_id = ?`,
      args: [transporterId, side, billNo, billDate, taxable, gstPct, gst, tdsPct, tds, roundOff, total, je.id ?? null, note,
             adjustment, v.adjustment_note ? String(v.adjustment_note).trim() : null, othersAmt, othersLedger,
             rcmPct, rcm, deductions.length ? JSON.stringify(deductions) : null, existingId as number, cid]
    })
    billId = existingId as number
  } else {
    const ins = await c.execute({
      sql: `INSERT INTO transporter_bills
              (company_id, transporter_id, side, bill_no, bill_date, taxable, gst_pct, gst_amount,
               tds_pct, tds_amount, round_off, total, journal_entry_id, note, adjustment, adjustment_note,
               others_amount, others_ledger, rcm_pct, rcm_amount, deductions_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cid, transporterId, side, billNo, billDate, taxable, gstPct, gst, tdsPct, tds, roundOff, total, je.id, note,
             adjustment, v.adjustment_note ? String(v.adjustment_note).trim() : null, othersAmt, othersLedger, rcmPct, rcm,
             deductions.length ? JSON.stringify(deductions) : null]
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
// Credit goes to the freight expense the recovery reduces — OUTWARD on a sale,
// INWARD on a purchase — because it reduces what the movement cost rather than
// earning anything. No GST either way: a shortage recovery is not a supply.
export async function raiseFreightShortageNote(
  lineId: number,
  v: { date?: string; companyId?: number } = {}
): Promise<{ note_id: number; note_no: string }> {
  const c = getClient()
  const cid = v.companyId ? n(v.companyId) : getActiveCompanyId()
  const r = await c.execute({
    sql: `SELECT l.*, s.invoice_no AS sale_invoice, o.invoice_no AS order_invoice,
                 o.gst_pct AS order_gst_pct, s.gst_pct AS sale_gst_pct
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
  if (line.waived_at != null) {
    throw new Error('This shortage was written off as not the transporter\'s — undo that first to claim it')
  }
  if (line.bill_id != null) {
    throw new Error('That shortage is already netted into a booked bill — delete the bill first if it should be claimed separately')
  }
  const amount = round2(Math.abs(n(line.amount)))
  if (amount <= 0) throw new Error('Nothing to claim on this line')
  if (!line.transporter_id) throw new Error('This line has no transporter to raise a note against')
  // Unregistered: no debit note — the shortage comes off their freight JV,
  // at the oil's value plus GST, when the bill is booked.
  if ((await transporterRegistration(n(line.transporter_id))) === 'unregistered') {
    throw new Error('This transporter is unregistered — no debit note; the shortage is deducted on their freight bill (with GST) when you book it')
  }
  // Registered: the note carries the oil's own GST on top of its value.
  const oilGst = n(line.order_id != null ? line.order_gst_pct : line.sale_gst_pct)

  const inv = String(line.sale_invoice || line.order_invoice || '')
  // Which side this line belongs to decides which freight expense the recovery
  // comes off. A purchase tanker's shortage reduces inward freight; a delivery's
  // reduces outward.
  const inward = line.order_id != null
  const note = await createNote({
    company_id: cid,
    note_type: 'debit',
    party_type: 'transporter',
    party_id: n(line.transporter_id),
    note_date: String(v.date || line.entry_date || todayISO()).slice(0, 10),
    against_account: inward ? 'FREIGHT INWARD A/C' : 'FREIGHT OUTWARD A/C',
    base_amount: amount,
    gst_pct: oilGst,
    against_invoice: inv || null,
    narration: `Oil shortage recovery${inv ? ` on ${inv}` : ''}${line.note ? ` — ${String(line.note)}` : ''}`
  })
  await c.execute({
    sql: 'UPDATE transporter_ledger SET note_id = ? WHERE id = ?',
    args: [note.id, n(lineId)]
  })
  await bumpRevision()
  return { note_id: note.id, note_no: note.note_no }
}

// Write the shortage off instead of claiming it — a tanker accident, a leak in
// transit, anything that is not the carrier's to answer for.
//
// Two things follow. The transporter is paid IN FULL, so the line stops netting
// off their bill exactly as a raised note does. And the loss is named: it is
// reclassified out of the goods it was bought as and into OIL SHORTAGE LOSS, so
// a year's accidents can be reported on rather than sitting invisibly inside
// material cost.
//
// The credit is the PURCHASE/SALE account, not the freight. The oil was already
// paid for on the invoice — bought 100 MT, received 99.8 — so its cost is
// already in the books; crediting freight would understate the freight the
// transporter is about to be paid in full, and invent a loss that is already
// counted. Naming it is the job here, not booking it twice.
export async function waiveFreightShortage(
  lineId: number,
  v: { reason: string; date?: string; companyId?: number }
): Promise<{ id: number; entry_id: number | null }> {
  const c = getClient()
  const cid = v.companyId ? n(v.companyId) : getActiveCompanyId()
  const reason = String(v.reason || '').trim()
  if (!reason) throw new Error('Say why this shortage is not the transporter\'s — a waiver without a reason cannot be reviewed later')

  const r = await c.execute({
    sql: `SELECT l.*, o.invoice_no AS order_invoice, s.invoice_no AS sale_invoice,
                 pr.code AS oil_code, pr.name AS oil_name, sp.code AS sale_code, sp.name AS sale_name
            FROM transporter_ledger l
            LEFT JOIN orders o ON o.id = l.order_id
            LEFT JOIN products pr ON pr.id = o.oil_type_id
            LEFT JOIN sales s ON s.id = l.sale_id
            LEFT JOIN products sp ON sp.id = s.product_id
           WHERE l.id = ? AND l.company_id = ?`,
    args: [n(lineId), cid]
  })
  if (!r.rows.length) throw new Error('That freight line no longer exists')
  const line = toPlain(r)[0]
  if (String(line.entry_type) !== 'shortage_penalty') throw new Error('Only a shortage line can be written off')
  if (line.note_id != null) throw new Error('A debit note has already been raised on this shortage — delete it first')
  if (line.waived_at != null) throw new Error('This shortage has already been written off')
  if (line.bill_id != null) throw new Error('That shortage is already netted into a booked bill — delete the bill first')
  const amount = round2(Math.abs(n(line.amount)))
  if (amount <= 0) throw new Error('Nothing to write off on this line')

  const inward = line.order_id != null
  const goods = inward
    ? `${String(line.oil_code || line.oil_name || 'OIL').toUpperCase()} PUR A/C`
    : `${String(line.sale_code || line.sale_name || 'FG').toUpperCase()} SALE A/C`
  const inv = String(line.order_invoice || line.sale_invoice || '')
  const je = await postJournal({
    date: String(v.date || line.entry_date || todayISO()).slice(0, 10),
    vchType: 'JOURNAL',
    vchNo: null,
    narration: `Oil shortage written off${inv ? ` on ${inv}` : ''} — not the transporter's: ${reason}`,
    companyId: cid,
    lines: [
      { account: 'OIL SHORTAGE LOSS A/C', group: 'Indirect Expenses', dr: amount },
      { account: goods, group: inward ? 'Purchase Accounts' : 'Sales Accounts', cr: amount }
    ]
  })
  await c.execute({
    sql: `UPDATE transporter_ledger
             SET waived_at = ?, waived_by = ?, waived_reason = ?, waived_entry_id = ?
           WHERE id = ?`,
    args: [todayISO(), getCurrentUser().username || null, reason, je.id ?? null, n(lineId)]
  })
  await bumpRevision()
  return { id: n(lineId), entry_id: je.id ?? null }
}

// Undo a write-off: the voucher is reversed and the shortage goes back to being
// a claim waiting to be made.
export async function unwaiveFreightShortage(lineId: number, companyId?: number): Promise<{ id: number }> {
  const c = getClient()
  const cid = companyId ? n(companyId) : getActiveCompanyId()
  const r = await c.execute({
    sql: 'SELECT waived_entry_id FROM transporter_ledger WHERE id = ? AND company_id = ?',
    args: [n(lineId), cid]
  })
  if (!r.rows.length) throw new Error('That freight line no longer exists')
  const entryId = r.rows[0].waived_entry_id
  await c.execute({
    sql: `UPDATE transporter_ledger
             SET waived_at = NULL, waived_by = NULL, waived_reason = NULL, waived_entry_id = NULL
           WHERE id = ?`,
    args: [n(lineId)]
  })
  if (entryId != null) await dropEntry(n(entryId))
  await bumpRevision()
  return { id: n(lineId) }
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

// THE RCM REGISTER: every freight bill on which RCM falls — the unregistered
// transporters' — with what was booked on each. A bill booked before RCM was
// posted reads 0, flagged, and can be posted from the register.
export async function rcmRegister(opts: { companyId?: number; from?: string; to?: string } = {}): Promise<Row[]> {
  const cid = opts.companyId ? n(opts.companyId) : getActiveCompanyId()
  const args: (string | number)[] = [cid]
  const where = ['b.company_id = ?', "(b.rcm_amount > 0 OR COALESCE(t.gst_registration, '') = 'unregistered')"]
  if (opts.from) {
    where.push('b.bill_date >= ?')
    args.push(String(opts.from).slice(0, 10))
  }
  if (opts.to) {
    where.push('b.bill_date <= ?')
    args.push(String(opts.to).slice(0, 10))
  }
  const res = await getClient().execute({
    sql: `SELECT b.id, b.side, b.bill_no, b.bill_date, b.taxable, b.total, b.tds_amount, b.rcm_pct, b.rcm_amount,
                 b.journal_entry_id, je.vch_type, je.vch_no, t.name AS transporter_name, t.gst_registration,
                 (SELECT COUNT(*) FROM transporter_ledger l WHERE l.bill_id = b.id) AS line_count
            FROM transporter_bills b
            JOIN transporters t ON t.id = b.transporter_id
            LEFT JOIN journal_entries je ON je.id = b.journal_entry_id
           WHERE ${where.join(' AND ')}
           ORDER BY b.bill_date, b.id`,
    args
  })
  return toPlain(res)
}

// Post RCM on a bill booked without it: the bill is re-booked exactly as it
// stands (same lines, bill no, date, TDS, adjustment and others) with the RCM
// lines added — the same path an edit of the bill takes.
export async function postBillRcm(billId: number, pct?: number, companyId?: number): Promise<{ id: number }> {
  const c = getClient()
  const cid = companyId ? n(companyId) : getActiveCompanyId()
  const b = toPlain(await c.execute({ sql: 'SELECT * FROM transporter_bills WHERE id = ? AND company_id = ?', args: [n(billId), cid] }))[0]
  if (!b) throw new Error('That bill no longer exists')
  if ((await transporterRegistration(n(b.transporter_id))) !== 'unregistered') {
    throw new Error('This transporter is GST registered — their bill carries GST, so there is no RCM to post')
  }
  if (n(b.rcm_amount) > 0.004) throw new Error('RCM is already posted on this bill')
  const lines = toPlain(await c.execute({ sql: 'SELECT id FROM transporter_ledger WHERE bill_id = ?', args: [n(billId)] }))
  if (!lines.length) throw new Error('This bill has no freight lines left — delete and book it again')
  return createTransporterBill(
    {
      company_id: cid,
      transporter_id: b.transporter_id,
      side: b.side,
      bill_no: b.bill_no,
      bill_date: b.bill_date,
      gst_pct: 0,
      tds_pct: b.tds_pct,
      adjustment: b.adjustment,
      adjustment_note: b.adjustment_note,
      others_amount: b.others_amount,
      others_ledger: b.others_ledger,
      ...(b.deductions_json ? { deductions: JSON.parse(String(b.deductions_json)) } : {}),
      note: b.note,
      rcm_pct: pct == null ? RCM_DEFAULT_PCT : n(pct),
      line_ids: lines.map((l) => n(l.id))
    },
    n(billId)
  )
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
