import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postLcOpening, settleLcBillsCombined, postLcMarginRelease, postLcPrematureInterestRebate, saveLcRepayment } from './treasury'
import { facilityHeadroom } from './facilities'

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

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

// What's actually left to issue bills against: interest and charges come out
// of the LC's own open amount before anything else, the same as the money
// that lands with the bank — issuing bills doesn't get to ignore what the LC
// itself already owes in fees. Unless both are paid upfront (some parties,
// e.g. Bunge-style deals, settle interest and charges straight from the bank
// account) — then the open amount isn't touched by either.
function netAvailable(lc: Row, issued: number): number {
  const interest = lc.interest_upfront ? 0 : round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
  const charges = lc.interest_upfront ? 0 : round2(n(lc.charges))
  return round2(n(lc.amount) - interest - charges - issued)
}

// LCs / discounting facilities with their utilisation (sum of issuances),
// the invoice they're linked to, the party repayment is expected from, the
// opening-amount breakdown, and how much of the exposure has been repaid.
export async function listLCs(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*,
      s.name AS supplier_name,
      f.name AS facility_name,
      rp.name AS receivable_party_name,
      (SELECT GROUP_CONCAT(lo.order_id) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_order_ids_csv,
      (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_nos,
      (SELECT COALESCE(SUM(o.net_amount), 0) FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_amount_total,
      (SELECT COUNT(*) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_invoice_count,
      COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized,
      l.amount - COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS available,
      COALESCE((SELECT SUM(amount) FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid,
      (SELECT MIN(due_date) FROM lc_issuances WHERE lc_id = l.id AND COALESCE(status, 'outstanding') != 'settled') AS next_due_date
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
    LEFT JOIN bank_facilities f ON f.id = l.facility_id
    LEFT JOIN customers rp ON rp.id = l.receivable_party_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res).map((l) => {
    const linkedCount = n(l.linked_invoice_count)
    // Margin is the security deposit the bank asks for on the LC's own open
    // amount — a straight percentage of the credit limit itself, not of
    // whichever invoices happen to be linked to it.
    const margin = Math.round((n(l.amount) * n(l.margin_pct)) / 100 * 100) / 100
    const interest = Math.round(((n(l.amount) * n(l.interest_pct) * n(l.usance_days)) / (100 * 365)) * 100) / 100
    const rawCharges = Math.round(n(l.charges) * 100) / 100
    const chargedInterest = l.interest_upfront ? 0 : interest
    const charges = l.interest_upfront ? 0 : rawCharges
    // Trading LCs are only "compliant" once they carry at least one open
    // invoice and the party repayment will come from — without either, the
    // register can't be trusted to reconcile on its own.
    const compliant = String(l.purpose || '') !== 'trading' || (linkedCount > 0 && !!l.receivable_party_id)
    return {
      ...l,
      linked_order_ids: String(l.linked_order_ids_csv || '')
        .split(',')
        .map((x) => Number(x))
        .filter((x) => x > 0),
      // Back-calculated: the open amount is the limit struck with the bank —
      // interest and charges come OUT of it, not added on top (unless both
      // are paid upfront from the bank instead — see interest_upfront).
      lc_net_available: Math.round((n(l.amount) - chargedInterest - charges) * 100) / 100,
      // What's actually left to issue bills against — interest and charges
      // come out of the open amount before issued bills reduce it further.
      available: netAvailable(l, n(l.utilized)),
      // What's still owed against the LC's full sanctioned limit, net of
      // repayments — explicitly requested this way even for an LC that's
      // barely drawn down, so it reads as the limit's outstanding exposure.
      outstanding: Math.round((n(l.amount) - n(l.repaid)) * 100) / 100,
      compliant,
      display_status: !compliant ? 'non_compliant' : String(l.workflow_status || 'in_progress')
    }
  })
}

// The overall LC book's own limit — Fixed always counts, Convertible only
// when switched on — tracked against every LC's own open amount by stage.
// A preclosed LC has been wound up early, so it no longer holds any of the
// limit; only what's genuinely still open counts against it.
export async function getLcLimit(): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const limitRes = await c.execute({ sql: 'SELECT * FROM lc_limits WHERE company_id = ?', args: [cid] })
  const limit = limitRes.rows.length ? toPlain(limitRes)[0] : { fixed_limit: 0, convertible_limit: 0, convertible_enabled: 0 }

  const sumsRes = await c.execute({
    sql: `SELECT stage, COALESCE(SUM(amount), 0) AS total FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
          GROUP BY stage`,
    args: [cid]
  })
  const byStage: Record<string, number> = { application: 0, open: 0, payment_received: 0 }
  for (const r of toPlain(sumsRes)) {
    const stage = String(r.stage || 'application')
    if (stage in byStage) byStage[stage] = n(r.total)
  }

  const totalLimit = round2(n(limit.fixed_limit) + (limit.convertible_enabled ? n(limit.convertible_limit) : 0))
  const utilized = round2(byStage.application + byStage.open + byStage.payment_received)
  return {
    fixed_limit: n(limit.fixed_limit),
    convertible_limit: n(limit.convertible_limit),
    convertible_enabled: !!n(limit.convertible_enabled),
    total_limit: totalLimit,
    application: round2(byStage.application),
    open: round2(byStage.open),
    payment_received: round2(byStage.payment_received),
    utilized,
    available: round2(totalLimit - utilized)
  }
}

export async function saveLcLimit(v: Row): Promise<{ id: number }> {
  const cid = getActiveCompanyId()
  await getClient().execute({
    sql: `INSERT INTO lc_limits (company_id, fixed_limit, convertible_limit, convertible_enabled, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(company_id) DO UPDATE SET
            fixed_limit = excluded.fixed_limit,
            convertible_limit = excluded.convertible_limit,
            convertible_enabled = excluded.convertible_enabled,
            updated_at = excluded.updated_at`,
    args: [cid, n(v.fixed_limit), n(v.convertible_limit), v.convertible_enabled ? 1 : 0]
  })
  return { id: cid }
}

async function syncLinkedOrders(lcId: number, orderIds: unknown): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [lcId] })
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n(x)).filter((x) => x > 0) : []
  for (const oid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO lc_linked_orders (lc_id, order_id) VALUES (?, ?)',
      args: [lcId, oid]
    })
  }
}

// Pasting a Payment received date means the loop is closed: the bill(s) it
// covers should show up under the LC rather than leaving "No bills issued
// under this LC yet" (created once, per linked invoice, or one for the whole
// open amount if there's no invoice to split by — never touches an issuance
// the user already has), AND the beneficiary should get paid through the
// books straight away, the same as a manual Settle.
async function syncPaymentReceivedIssuance(lcId: number, v: Row): Promise<void> {
  const paymentDate = String(v.payment_received_date || '').slice(0, 10)
  if (!paymentDate) return
  const c = getClient()
  const existing = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM lc_issuances WHERE lc_id = ?', args: [lcId] })
  if (n(existing.rows[0]?.n) === 0) {
    const issueDate = String(v.open_date || paymentDate).slice(0, 10)
    const dueDate = String(v.expiry_date || paymentDate).slice(0, 10)
    const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x: unknown) => n(x)).filter((x: number) => x > 0) : []
    if (ids.length) {
      // The LC can cover less than the linked invoices' full total (partly
      // financed another way) but never more — so each auto-issued bill is
      // capped to what's still left of the LC's own net available (open
      // amount less interest and charges), same rule issueLC() applies to a
      // manual issuance.
      let remaining = netAvailable(v, 0)
      for (const oid of ids) {
        const o = await c.execute({ sql: 'SELECT invoice_no, net_amount FROM orders WHERE id = ?', args: [oid] })
        if (!o.rows.length) continue
        const issueAmount = Math.min(remaining, n(o.rows[0].net_amount))
        if (issueAmount <= 0.005) continue
        await c.execute({
          sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, due_date, status)
                VALUES (?, ?, ?, ?, ?, ?, 'outstanding')`,
          args: [lcId, issueDate, Math.round(issueAmount * 100) / 100, oid, String(o.rows[0].invoice_no || ''), dueDate]
        })
        remaining -= issueAmount
      }
    } else if (netAvailable(v, 0) > 0) {
      await c.execute({
        sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, bill_no, due_date, status)
              VALUES (?, ?, ?, ?, ?, 'outstanding')`,
        args: [lcId, issueDate, netAvailable(v, 0), String(v.lc_no || ''), dueDate]
      })
    }
  }
  // Pay the beneficiary through the books for every bill still outstanding —
  // receiving payment closes the loop, so settling is automatic here rather
  // than a separate manual step. Every bill on this LC settles as ONE
  // combined payment (one bank withdrawal), each keeping its own bill-wise
  // allocation so the ledger shows what squared off against which invoice.
  const outstanding = await c.execute({
    sql: "SELECT id FROM lc_issuances WHERE lc_id = ? AND COALESCE(status, 'outstanding') != 'settled'",
    args: [lcId]
  })
  await settleLcBillsCombined(outstanding.rows.map((r) => Number(r.id)), paymentDate).catch((e) =>
    console.error('[lc] auto-settle on payment received failed:', (e as Error).message)
  )
}

export async function listLCIssuances(lcId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT i.*, o.invoice_no
          FROM lc_issuances i
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.lc_id = ? ORDER BY i.id DESC`,
    args: [lcId]
  })
  return toPlain(res)
}

const LC_COLS = [
  'usance_days',
  'margin_pct',
  'lc_no',
  'facility_type',
  'bank',
  'party_type',
  'party_id',
  'amount',
  'open_date',
  'expiry_date',
  'interest_pct',
  'charges',
  'status',
  'note',
  'facility_id',
  'purpose',
  'receivable_party_id',
  'workflow_status',
  'stage',
  'fd_no',
  'payment_received_date',
  'opened_date',
  'interest_upfront'
]

function lcArgs(v: Row): (string | number | null)[] {
  return LC_COLS.map((k) => {
    const val = v[k]
    if (val === '' || val === undefined || val === null) {
      if (k === 'workflow_status') return 'in_progress'
      if (k === 'stage') return 'application'
      // NOT NULL columns — Interest days in particular is blank until both
      // maturity and payment-received dates are set, so a fresh LC must still
      // insert cleanly with 0 rather than null.
      if (k === 'amount' || k === 'usance_days' || k === 'margin_pct' || k === 'interest_upfront') return 0
      // lc_no is NOT NULL but genuinely unknown until Open — an empty string
      // satisfies the column without pretending to have a real number.
      if (k === 'lc_no') return ''
      return null
    }
    if (
      k === 'party_id' ||
      k === 'amount' ||
      k === 'interest_pct' ||
      k === 'charges' ||
      k === 'usance_days' ||
      k === 'margin_pct' ||
      k === 'facility_id' ||
      k === 'receivable_party_id' ||
      k === 'interest_upfront'
    ) {
      return n(val)
    }
    return val as string
  })
}

// An LC drawing on a sanctioned facility cannot quietly take it past its
// limit. `force` lets an authorised person proceed anyway — the notes ask for
// an override path, not a hard wall — and the reason lands in the LC's note.
async function assertWithinFacility(v: Row, excludeLcId = 0): Promise<void> {
  const facilityId = n(v.facility_id)
  if (!facilityId || v.force_over_limit) return
  const h = await facilityHeadroom(facilityId, excludeLcId)
  const amount = n(v.amount)
  if (amount > n(h.available) + 0.005) {
    throw new Error(
      `${h.name} has ${Number(h.available).toFixed(2)} left of its ${Number(h.sanctioned).toFixed(2)} sanction ` +
        `(${Number(h.lc_committed).toFixed(2)} on other LCs, ${Number(h.other_outstanding).toFixed(2)} other outstanding). ` +
        `This LC of ${amount.toFixed(2)} would exceed it.`
    )
  }
}

// An LC covering specific invoices can be struck for less than their total
// (part-covered by the LC, the rest funded another way) but never for more —
// the bank isn't extending credit beyond the trade it's backing.
async function assertWithinInvoiceCover(v: Row): Promise<void> {
  const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x: unknown) => n(x)).filter((x: number) => x > 0) : []
  if (!ids.length) return
  const res = await getClient().execute({
    sql: `SELECT COALESCE(SUM(net_amount), 0) AS total FROM orders WHERE id IN (${ids.map(() => '?').join(', ')})`,
    args: ids
  })
  const total = n(res.rows[0]?.total)
  const amount = n(v.amount)
  if (amount > total + 0.005) {
    throw new Error(
      `The open amount (${amount.toFixed(2)}) cannot exceed the ${total.toFixed(2)} total of the selected invoices.`
    )
  }
}

// The LC number itself isn't known until the bank actually opens the LC —
// at Application it's just a request, so only Open onward requires it.
function assertLcNoIfPastApplication(v: Row): void {
  if (String(v.stage || 'application') !== 'application' && !String(v.lc_no || '').trim()) {
    throw new Error('LC number is required once the LC is Open')
  }
}

// The bank can't have paid the beneficiary before it even opened the LC.
function assertPaymentReceivedNotBeforeOpen(v: Row): void {
  if (
    String(v.stage || 'application') === 'payment_received' &&
    v.opened_date &&
    v.payment_received_date &&
    String(v.payment_received_date) < String(v.opened_date)
  ) {
    throw new Error('Payment received date cannot be before the date the LC was opened')
  }
}

export async function createLC(v: Row): Promise<{ id: number }> {
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
  assertPaymentReceivedNotBeforeOpen(v)
  if (!String(v.fd_no || '').trim()) throw new Error('FD No is required')
  await assertWithinFacility(v)
  await assertWithinInvoiceCover(v)
  const res = await getClient().execute({
    sql: `INSERT INTO letters_of_credit (company_id, ${LC_COLS.join(', ')})
          VALUES (?, ${LC_COLS.map(() => '?').join(', ')})`,
    args: [getActiveCompanyId(), ...lcArgs(v)]
  })
  const id = Number(res.lastInsertRowid)
  await syncLinkedOrders(id, v.linked_order_ids)
  await syncPaymentReceivedIssuance(id, v)
  // Margin + charges voucher into the books (skipped when both are zero).
  await postLcOpening(id).catch((e) => console.error('[lc] opening voucher failed:', (e as Error).message))
  return { id }
}

export async function updateLC(id: number, v: Row): Promise<{ id: number }> {
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
  assertPaymentReceivedNotBeforeOpen(v)
  if (!String(v.fd_no || '').trim()) throw new Error('FD No is required')
  await assertWithinFacility(v, id)
  await assertWithinInvoiceCover(v)
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET ${LC_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...lcArgs(v), id]
  })
  await syncLinkedOrders(id, v.linked_order_ids)
  await syncPaymentReceivedIssuance(id, v)
  await postLcOpening(id).catch((e) => console.error('[lc] opening voucher failed:', (e as Error).message))
  return { id }
}

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000)
}

// Winds the LC up before its natural maturity. Interest is recalculated over
// the days actually elapsed (open date -> preclose date) by refreshing
// usance_days and reposting the opening voucher — the same entry every save
// already keeps in sync — rather than a bespoke correction. Whatever's left
// settles as its own entry, one way or the other, per the user's own choice.
export async function precloseLC(
  id: number,
  v: {
    preclose_date: string
    amount: number
    comm_charges?: number
    bank_charges?: number
    premature_interest?: number
    premature_interest_direction?: 'credit_to_us' | 'pay_to_party'
    release_margin?: boolean
  }
): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  if (lc.preclosed_date) throw new Error('This LC is already preclosed')
  const precloseDate = String(v.preclose_date || '').slice(0, 10)
  if (!precloseDate) throw new Error('Pick the preclosure date')
  // Interest accrues from when the bank actually paid out (or, failing that,
  // when the LC opened) — the same start point usance_days was originally
  // struck from at Payment Received (expiry_date − payment_received_date) —
  // not from the Application date, which can predate that by days or weeks
  // and would otherwise inflate this recalculation.
  const interestStart = lc.payment_received_date || lc.opened_date || lc.open_date
  if (!interestStart) throw new Error('The LC has no date yet to count interest days from')
  const actualDays = Math.max(0, daysBetween(String(interestStart), precloseDate))
  const prematureInterest = round2(n(v.premature_interest))
  const rebateDirection = v.premature_interest_direction === 'pay_to_party' ? 'pay_to_party' : 'credit_to_us'
  await c.execute({
    sql: `UPDATE letters_of_credit SET usance_days = ?, preclosed_date = ?, preclose_premature_interest = ?,
          preclose_interest_route = ? WHERE id = ?`,
    args: [actualDays, precloseDate, prematureInterest, rebateDirection, id]
  })
  // Re-strikes the margin/interest/charges voucher with the corrected
  // (shorter) interest period now stored on the record.
  await postLcOpening(id)
  // The pending days (preclose -> original maturity) never happen, so the
  // interest netAvailable() already deducted from the supplier's payment for
  // that stretch is a rebate now, not a charge — either refunded straight to
  // the company, or passed on to the supplier who was underpaid by exactly
  // this much when their bill was settled.
  const rebate = await postLcPrematureInterestRebate(id, rebateDirection, prematureInterest, precloseDate)
  if (rebate) {
    await c.execute({ sql: 'UPDATE letters_of_credit SET preclose_interest_journal_entry_id = ? WHERE id = ?', args: [rebate.id, id] })
  }
  // Preclosing is ALSO the same event as logging an LC repayment — the bank
  // still wants its full open amount back, just before maturity instead of
  // at it. Any additional Comm./Bank charges here are unrelated to the
  // rebate above — they're only for when the bank statement shows the total
  // debit running higher than the open amount for some other reason.
  await saveLcRepayment({
    lc_id: id,
    amount: n(v.amount),
    comm_charges: n(v.comm_charges),
    bank_charges: n(v.bank_charges),
    repay_date: precloseDate,
    posted: true,
    note: 'Preclosure repayment'
  })
  if (v.release_margin) {
    const margin = round2((n(lc.amount) * n(lc.margin_pct)) / 100)
    const settlement = await postLcMarginRelease(id, margin, precloseDate)
    if (settlement) {
      await c.execute({
        sql: `UPDATE letters_of_credit SET preclose_settlement_direction = 'margin_released',
              preclose_settlement_amount = ?, preclose_journal_entry_id = ? WHERE id = ?`,
        args: [margin, settlement.id, id]
      })
    }
  }
  await c.execute({ sql: "UPDATE letters_of_credit SET workflow_status = 'preclosed' WHERE id = ?", args: [id] })
  return { id }
}

export async function deleteLC(id: number): Promise<{ id: number }> {
  const c = getClient()
  // Reverse everything the LC put into the books before it goes.
  const bills = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE lc_id = ?', args: [id] })
  for (const b of bills.rows) if (b.journal_entry_id) await dropTreasuryEntry(Number(b.journal_entry_id))
  const repayments = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_repayments WHERE lc_id = ?', args: [id] })
  for (const r of repayments.rows) if (r.journal_entry_id) await dropTreasuryEntry(Number(r.journal_entry_id))
  const lc = await c.execute({
    sql: `SELECT journal_entry_id, preclose_journal_entry_id, interest_journal_entry_id, preclose_interest_journal_entry_id
          FROM letters_of_credit WHERE id = ?`,
    args: [id]
  })
  if (lc.rows.length && lc.rows[0].journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].journal_entry_id))
  if (lc.rows.length && lc.rows[0].preclose_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_journal_entry_id))
  if (lc.rows.length && lc.rows[0].interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].interest_journal_entry_id))
  if (lc.rows.length && lc.rows[0].preclose_interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_interest_journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_repayments WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM letters_of_credit WHERE id = ?', args: [id] })
  return { id }
}

async function dropTreasuryEntry(entryId: number): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [entryId]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [entryId] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [entryId] })
}

// Issue (draw down) against an LC. Cannot exceed the available balance.
export async function issueLC(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const lcId = n(v.lc_id)
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the issuance amount')
  const lcRes = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!lcRes.rows.length) throw new Error('LC not found')
  const used = await c.execute({
    sql: 'SELECT COALESCE(SUM(amount), 0) AS u FROM lc_issuances WHERE lc_id = ?',
    args: [lcId]
  })
  const available = netAvailable(lcRes.rows[0], n(used.rows[0].u))
  if (amount > available + 0.005) {
    throw new Error(`Issuance exceeds available LC balance (${available.toFixed(2)})`)
  }
  const lc = lcRes.rows[0]
  const issueDate = String(v.issue_date || '').slice(0, 10)
  if (lc.expiry_date && issueDate > String(lc.expiry_date)) {
    throw new Error(`The LC expired on ${lc.expiry_date} — a bill cannot be issued after that`)
  }
  // Every bill carries its maturity: explicit, or issue date + the LC's usance.
  let dueDate = String(v.due_date || '').slice(0, 10)
  if (!dueDate) {
    const d = new Date(`${issueDate}T00:00:00`)
    d.setDate(d.getDate() + (n(lc.usance_days) || 0))
    dueDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const ins = await c.execute({
    sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, note, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding')`,
    args: [
      lcId,
      issueDate,
      amount,
      v.order_id ? n(v.order_id) : null,
      v.bill_no || null,
      v.note || null,
      dueDate
    ]
  })
  // Mark the LC utilised/closed once fully drawn.
  if (amount >= available - 0.005) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'utilized' WHERE id = ?",
      args: [lcId]
    })
  }
  return { id: Number(ins.lastInsertRowid) }
}

export async function deleteLCIssuance(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT lc_id, journal_entry_id FROM lc_issuances WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropTreasuryEntry(Number(res.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE id = ?', args: [id] })
  // Re-open the LC if it now has headroom.
  if (res.rows.length) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'open' WHERE id = ? AND status = 'utilized'",
      args: [n(res.rows[0].lc_id)]
    })
  }
  return { id }
}
