import { withDbTransaction } from './dbTransaction'
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postLcOpening, postLcFees, resyncLcSettlement, settleLcBillsCombined, postLcMarginRelease, postLcPrematureInterestRebate, saveLcRepayment, refreshLcUpfrontInterest, syncLcFeeAdjustment, lcFeeDelta } from './treasury'
import { facilityHeadroom } from './facilities'
import { linkTradingDealsToLc } from './trading'
import { getSetting } from './repos'
import { lcInterest, lcInterestBase, lcInterestBasis } from './lcInterest'
import { logLimitChange } from './facilityLimits'

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

// What's left to issue bills against: the open amount, less the interest and
// commission the bank keeps out of it, less what has already been drawn.
//
// The bank releases the NET to the beneficiary — it takes its interest and its
// commission out of the credit first — so a bill raised for the gross would
// credit the supplier with money that never left the bank. That difference is
// exactly what showed up on LC-15, where a commission set after the bill was
// raised left the supplier ₹3,360 better off in the ledger than in fact.
//
// Unless both are settled upfront from the account instead (interest_upfront),
// in which case the credit is untouched and the full amount is available.
function netAvailable(lc: Row, issued: number): number {
  const interest = lc.interest_upfront ? 0 : lcInterest(lc)
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
      l.bank AS bank_name,
      ob.name AS our_bank_name,
      f.name AS facility_name,
      rp.name AS receivable_party_name,
      (SELECT GROUP_CONCAT(lo.order_id) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_order_ids_csv,
      (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_nos,
      (SELECT COALESCE(SUM(o.net_amount), 0) FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_amount_total,
      (SELECT COUNT(*) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_invoice_count,
      (SELECT GROUP_CONCAT(td.id) FROM trading_deals td WHERE td.lc_id = l.id) AS linked_deal_ids_csv,
      COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized,
      COALESCE((SELECT SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END) FROM lc_issuances WHERE lc_id = l.id), 0) AS settled_total,
      COALESCE((SELECT COUNT(CASE WHEN order_id IS NOT NULL THEN 1 END) FROM lc_issuances WHERE lc_id = l.id), 0) AS linked_bill_count,
      l.amount - COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS available,
      COALESCE((SELECT SUM(amount) FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid,
      -- THE PRINCIPAL, APART FROM WHAT RODE OUT WITH IT.
      -- A repayment debits the bank for the LC plus the bank's own charges in
      -- one figure, because that is the one line on the statement. Measured
      -- against the limit, though, only the principal repays anything: netting
      -- the whole debit off drove Outstanding to minus the charges on an LC
      -- that was square to the rupee.
      COALESCE((SELECT SUM(amount - COALESCE(comm_charges, 0) - COALESCE(bank_charges, 0) - COALESCE(charges_total, 0))
                  FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid_principal,
      COALESCE((SELECT SUM(COALESCE(comm_charges, 0) + COALESCE(bank_charges, 0) + COALESCE(charges_total, 0))
                  FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid_charges,
      (SELECT COUNT(*) FROM lc_repayments WHERE lc_id = l.id) AS repayment_count,
      -- Parts the bank has paid the supplier in; 0 for an LC paid in one go.
      (SELECT COUNT(DISTINCT installment_no) FROM lc_issuances WHERE lc_id = l.id AND installment_no IS NOT NULL) AS installment_count,
      (SELECT MAX(settled_date) FROM lc_issuances WHERE lc_id = l.id AND installment_no IS NOT NULL) AS last_installment_date,
      -- What has actually come back, so the countdown chip can stand down and
      -- the Payment IN action knows there is nothing left to receive.
      COALESCE((SELECT SUM(amount) FROM lc_payment_ins WHERE lc_id = l.id), 0) AS payment_in_total,
      (SELECT COUNT(*) FROM lc_payment_ins WHERE lc_id = l.id) AS payment_in_count,
      COALESCE(
        (SELECT MIN(p.maturity_date) FROM lc_parts p WHERE p.lc_id = l.id AND p.repaid_date IS NULL),
        (SELECT MIN(due_date) FROM lc_issuances WHERE lc_id = l.id AND COALESCE(status, 'outstanding') != 'settled')
      ) AS next_due_date,
      -- Paid in parts: how many, their LC amounts, the interest each kept, and
      -- what is still owed to the bank.
      (SELECT COUNT(*) FROM lc_parts p WHERE p.lc_id = l.id) AS parts_count,
      -- Each part on its own, for the register: its maturity, days and state.
      (SELECT json_group_array(json_object('part_no', p.part_no, 'amount', p.amount, 'pay_date', p.pay_date,
                'maturity_date', p.maturity_date, 'days', p.days, 'interest', p.interest, 'repaid_date', p.repaid_date))
         FROM (SELECT * FROM lc_parts WHERE lc_id = l.id ORDER BY part_no) p) AS parts_json,
      COALESCE((SELECT SUM(p.amount) FROM lc_parts p WHERE p.lc_id = l.id), 0) AS parts_amount,
      COALESCE((SELECT SUM(p.interest) FROM lc_parts p WHERE p.lc_id = l.id), 0) AS parts_interest,
      COALESCE((SELECT SUM(p.net) FROM lc_parts p WHERE p.lc_id = l.id), 0) AS parts_net,
      COALESCE((SELECT SUM(p.amount) FROM lc_parts p WHERE p.lc_id = l.id AND p.repaid_date IS NOT NULL), 0) AS parts_repaid,
      (SELECT COUNT(*) FROM lc_parts p WHERE p.lc_id = l.id AND p.repaid_date IS NULL) AS parts_open,
      -- A part with its own margin % moves the LC's margin by the difference
      -- on that part's amount; 0 for every LC whose parts use the LC's rate.
      COALESCE((SELECT SUM(p.amount * (p.margin_pct - COALESCE(l.margin_pct, 0)) / 100) FROM lc_parts p
                 WHERE p.lc_id = l.id AND p.margin_pct IS NOT NULL), 0) AS parts_margin_adj
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
    LEFT JOIN banks ob ON ob.id = l.our_bank_id
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
    const margin = Math.round(((n(l.amount) * n(l.margin_pct)) / 100 + n(l.parts_margin_adj)) * 100) / 100
    const interest = lcInterest(l)
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
      linked_deal_ids: String(l.linked_deal_ids_csv || '')
        .split(',')
        .map((x) => Number(x))
        .filter((x) => x > 0),
      // Back-calculated: the open amount is the limit struck with the bank —
      // interest and charges come OUT of it, not added on top (unless both
      // are paid upfront from the bank instead — see interest_upfront).
      lc_net_available: Math.round((n(l.amount) - chargedInterest - charges) * 100) / 100,
      // What the beneficiary was ACTUALLY paid: the bills the bank honoured.
      //
      // lc_net_available above is a back-calculation — open amount less what
      // the fees ought to be — and the two disagreed. LC-15's bill was raised
      // for 1,60,57,801.64 while the back-calculation said 1,60,54,441.64,
      // because the bill deducted the interest and not the ₹3,360 charges. The
      // ledger carried one figure and the register showed the other.
      //
      // A recorded amount beats a formula, every time. Until a bill exists
      // there is nothing recorded, so the expectation stands in — and says so.
      paid_to_party: n(l.utilized) > 0.004 ? round2(n(l.utilized)) : null,
      paid_expected: Math.round((n(l.amount) - chargedInterest - charges) * 100) / 100,
      // What's actually left to issue bills against — interest and charges
      // come out of the open amount before issued bills reduce it further.
      // The shortfall an over-drawn LC used to show as a negative balance is
      // now credited back to the party instead (syncLcFeeAdjustment), so the
      // LC itself is square — reporting it as still negative would double-count
      // a correction that has already been posted.
      interest_basis: lcInterestBasis(l),
      interest_base_amount: lcInterestBase(l),
      fee_adjustment: lcFeeDelta(),
      available: round2(netAvailable(l, n(l.utilized)) - lcFeeDelta()),
      // What's still owed against the LC's full sanctioned limit, net of
      // repayments — explicitly requested this way even for an LC that's
      // barely drawn down, so it reads as the limit's outstanding exposure.
      // Against the limit, so the blocked figure less what has been repaid.
      // Never below nothing: an LC repaid in full is repaid in full, and the
      // charges that shared its debit are an expense, not an overpayment.
      // A rejected application never became a credit: nothing outstanding.
      outstanding:
        String(l.workflow_status || '') === 'rejected'
          ? 0
          : // Closed by repaying its parts: what was never drawn is not owed.
            n(l.parts_count) > 0 && l.preclosed_date
            ? 0
            : round2(Math.max(0, (n(l.blocked_amount) || n(l.amount)) - n(l.repaid_principal))),
      repaid_principal: round2(n(l.repaid_principal)),
      repaid_charges: round2(n(l.repaid_charges)),
      // Resolved once here so the register and the forms never have to repeat
      // the fallback — and cannot disagree about it.
      blocked_effective: round2(n(l.blocked_amount) || n(l.amount)),
      // The bank's security on this LC, in rupees rather than as a percentage
      // of a figure the reader has to go and find. Computed here already; it
      // was simply never handed out.
      margin_amount: margin,
      interest_amount: n(l.parts_count) > 0 ? round2(n(l.parts_interest)) : round2(interest),
      // Paid in parts: what of the LC is still undrawn, as an LC amount.
      parts_left: n(l.parts_count) > 0 ? round2(Math.max(0, n(l.amount) - n(l.parts_amount))) : null,
      compliant,
      display_status:
        String(l.workflow_status || '') === 'rejected'
          ? 'rejected'
          : !compliant
            ? 'non_compliant'
            : String(l.workflow_status || 'in_progress')
    }
  })
}

// The overall LC book's own limit — Fixed always counts, Convertible only
// when switched on — tracked against every LC's own open amount by stage.
// A preclosed LC has been wound up early, so it no longer holds any of the
// limit; only what's genuinely still open counts against it.
// The LC book's limit, per bank. Each bank sanctions its own line, so a bank
// id scopes both the limit and the utilisation to that bank. Passing none rolls
// every bank up into one view ("All banks") — the limits summed, the stage
// figures summed — which is what the register shows when no bank is selected.
//
// Fixed always counts, Convertible only when switched on. A preclosed LC has
// been wound up early, so it no longer holds any of the limit; only what is
// genuinely still open counts against it.
export async function getLcLimit(bankId?: number, from?: string, to?: string): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  let bank = n(bankId)
  // A bank now belongs to one company — a stale bank id left over from
  // switching companies (rather than a real cross-company mix-up) is treated
  // as "no bank picked" instead of quietly showing another company's figures.
  if (bank) {
    const owner = await c.execute({ sql: 'SELECT company_id FROM banks WHERE id = ?', args: [bank] })
    if (n(owner.rows[0]?.company_id) !== cid) bank = 0
  }
  const limitRes = bank
    ? await c.execute({
        sql: 'SELECT fixed_limit, convertible_limit, convertible_enabled FROM bank_lc_limits WHERE company_id = ? AND bank_id = ?',
        args: [cid, bank]
      })
    : await c.execute({
        sql: `SELECT COALESCE(SUM(fixed_limit), 0) AS fixed_limit,
                     COALESCE(SUM(convertible_limit), 0) AS convertible_limit,
                     MAX(convertible_enabled) AS convertible_enabled
              FROM bank_lc_limits WHERE company_id = ?`,
        args: [cid]
      })
  let limit = limitRes.rows.length
    ? toPlain(limitRes)[0]
    : { fixed_limit: 0, convertible_limit: 0, convertible_enabled: 0 }
  // Until a limit has been sanctioned against one of our own accounts, fall
  // back to the single company-wide figure the books were kept on before
  // limits became per-bank. Without this the dashboard would read zero — and
  // every LC as over limit — purely because the new figure isn't entered yet.
  if (!bank && n(limit.fixed_limit) === 0 && n(limit.convertible_limit) === 0) {
    const legacy = await c.execute({
      sql: 'SELECT fixed_limit, convertible_limit, convertible_enabled FROM lc_limits WHERE company_id = ?',
      args: [cid]
    })
    if (legacy.rows.length) limit = toPlain(legacy)[0]
  }

  // A period narrows utilisation to the cohort of LCs actually OPENED in that
  // window — still only counting what is genuinely still outstanding today,
  // same as the unfiltered figure. It never touches the facility ceiling
  // itself (fixed/convertible/total), which is a bank-sanctioned limit, not
  // something that resets period to period.
  const f = from ? String(from).slice(0, 10) : ''
  const t = to ? String(to).slice(0, 10) : ''
  const sumsRes = await c.execute({
    // Against the LIMIT it is the blocked amount that counts, not the amount
    // opened: the bank is holding the figure it blocked whether or not the bill
    // came in for that much. Interest and margin still work off the open
    // amount, which is why only the limit sums coalesce this way.
    sql: `SELECT stage, COALESCE(SUM(COALESCE(NULLIF(blocked_amount, 0), amount)
                - COALESCE((SELECT SUM(p.amount) FROM lc_parts p WHERE p.lc_id = letters_of_credit.id AND p.repaid_date IS NOT NULL), 0)), 0) AS total,
                 COUNT(*) AS cnt FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
            AND COALESCE(workflow_status, '') <> 'rejected'
            ${bank ? 'AND our_bank_id = ?' : ''}
            ${f ? 'AND open_date >= ?' : ''}
            ${t ? 'AND open_date <= ?' : ''}
          GROUP BY stage`,
    args: [cid, ...(bank ? [bank] : []), ...(f ? [f] : []), ...(t ? [t] : [])]
  })
  const byStage: Record<string, number> = { application: 0, open: 0, payment_received: 0 }
  let periodCount = 0
  for (const r of toPlain(sumsRes)) {
    const stage = String(r.stage || 'application')
    if (stage in byStage) byStage[stage] = n(r.total)
    periodCount += n(r.cnt)
  }
  // The all-time count, ignoring the period, so the KPI can always show
  // "N of M" — how many of the facility's LCs the current window covers.
  const totalCountRes = await c.execute({
    sql: `SELECT COUNT(*) AS cnt FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
            AND COALESCE(workflow_status, '') <> 'rejected'
            ${bank ? 'AND our_bank_id = ?' : ''}`,
    args: bank ? [cid, bank] : [cid]
  })
  const totalCount = n(totalCountRes.rows[0]?.cnt)

  const totalLimit = round2(n(limit.fixed_limit) + (limit.convertible_enabled ? n(limit.convertible_limit) : 0))
  const utilized = round2(byStage.application + byStage.open + byStage.payment_received)
  return {
    bank_id: bank || null,
    fixed_limit: n(limit.fixed_limit),
    convertible_limit: n(limit.convertible_limit),
    convertible_enabled: !!n(limit.convertible_enabled),
    total_limit: totalLimit,
    lc_count: totalCount,
    period_lc_count: periodCount,
    application: round2(byStage.application),
    open: round2(byStage.open),
    payment_received: round2(byStage.payment_received),
    utilized,
    available: round2(totalLimit - utilized),
    period_from: f || null,
    period_to: t || null
  }
}

// Per-bank limits, one row per bank the company has a line with — for the
// bank-wise breakdown beside the register.
export async function listBankLcLimits(): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const res = await getClient().execute({
    sql: `SELECT b.id AS bank_id, b.name AS bank, b.active,
                 COALESCE(l.fixed_limit, 0) AS fixed_limit,
                 COALESCE(l.convertible_limit, 0) AS convertible_limit,
                 COALESCE(l.convertible_enabled, 0) AS convertible_enabled,
                 (SELECT COUNT(*) FROM letters_of_credit x WHERE x.company_id = ? AND x.our_bank_id = b.id
                     AND COALESCE(x.workflow_status, '') <> 'rejected') AS lc_count,
                 COALESCE((SELECT SUM(COALESCE(NULLIF(x.blocked_amount, 0), x.amount)) FROM letters_of_credit x
                           WHERE x.company_id = ? AND x.our_bank_id = b.id
                             AND COALESCE(x.facility_type, 'lc') = 'lc' AND x.preclosed_date IS NULL
                             AND COALESCE(x.workflow_status, '') <> 'rejected'), 0) AS utilized
          FROM banks b
          LEFT JOIN bank_lc_limits l ON l.bank_id = b.id AND l.company_id = ?
          WHERE b.company_id = ?
          ORDER BY b.name`,
    args: [cid, cid, cid, cid]
  })
  return toPlain(res).map((r) => {
    const total = round2(n(r.fixed_limit) + (n(r.convertible_enabled) ? n(r.convertible_limit) : 0))
    return { ...r, convertible_enabled: !!n(r.convertible_enabled), total_limit: total, available: round2(total - n(r.utilized)) }
  })
}

// A limit belongs to one bank, so which bank has to be named — there is no
// company-wide figure to fall back on once several banks are in play.
export async function saveLcLimit(v: Row): Promise<{ id: number }> {
  const cid = getActiveCompanyId()
  const bankId = n(v.bank_id)
  if (!bankId) throw new Error('Pick which bank this limit is sanctioned by')
  const owner = await getClient().execute({ sql: 'SELECT company_id FROM banks WHERE id = ?', args: [bankId] })
  if (n(owner.rows[0]?.company_id) !== cid) throw new Error('That bank belongs to a different company')
  // What it was, before it stops being that. The screen saves every bank at
  // once, so most of these are unchanged and record nothing.
  const was = await getClient().execute({
    sql: 'SELECT COALESCE(fixed_limit, 0) AS v FROM bank_lc_limits WHERE company_id = ? AND bank_id = ?',
    args: [cid, bankId]
  })
  const priorFixed = was.rows.length ? n(was.rows[0].v) : 0
  await getClient().execute({
    sql: `INSERT INTO bank_lc_limits (company_id, bank_id, fixed_limit, convertible_limit, convertible_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(company_id, bank_id) DO UPDATE SET
            fixed_limit = excluded.fixed_limit,
            convertible_limit = excluded.convertible_limit,
            convertible_enabled = excluded.convertible_enabled,
            updated_at = excluded.updated_at`,
    args: [cid, bankId, n(v.fixed_limit), n(v.convertible_limit), v.convertible_enabled ? 1 : 0]
  })
  await logLimitChange({
    kind: 'bank',
    refId: bankId,
    oldAmount: priorFixed,
    newAmount: n(v.fixed_limit),
    note: 'edited on the LC limit screen',
    companyId: cid
  })
  return { id: bankId }
}

// A purchase invoice belongs to at most one LC at a time — the real
// exclusivity boundary (a Trading deal's several invoices can each go to a
// DIFFERENT LC, but the same invoice can't fund two). Refused rather than
// silently stolen, same spirit as the old deal-level guard this replaced.
async function syncLinkedOrders(lcId: number, orderIds: unknown): Promise<void> {
  const c = getClient()
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n(x)).filter((x) => x > 0) : []
  if (ids.length) {
    const taken = await c.execute({
      sql: `SELECT lo.order_id, o.invoice_no, l.lc_no
            FROM lc_linked_orders lo
            JOIN orders o ON o.id = lo.order_id
            LEFT JOIN letters_of_credit l ON l.id = lo.lc_id
            WHERE lo.order_id IN (${ids.join(',')}) AND lo.lc_id != ?`,
      args: [lcId]
    })
    if (taken.rows.length) {
      const t = taken.rows[0] as Row
      throw new Error(`Invoice ${t.invoice_no || `#${t.order_id}`} is already linked to ${t.lc_no ? `LC ${t.lc_no}` : 'another LC'}`)
    }
  }
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [lcId] })
  for (const oid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO lc_linked_orders (lc_id, order_id) VALUES (?, ?)',
      args: [lcId, oid]
    })
  }
}

// ── AN LC PAID AND REPAID IN PARTS ──────────────────────────────────────────
//
// The bank can pay the supplier an LC in parts, and each part runs to its OWN
// maturity: part 1 of ₹60L paid 01-10 falls due 30-12, part 2 of ₹40L paid
// 15-10 falls due 12-01. So each part carries its own interest — its LC amount
// × the rate × the days from the day it was paid to its own maturity — taken
// out of that part when it is paid, exactly as the bank's advice does. The
// bank's charges are taken once, on part 1.
//
// One row per part in lc_parts: the part's LC amount (what the user types, off
// the bank's bill), its maturity, the interest and charges kept, and what the
// supplier received. The bills under it (lc_issuances, installment_no = part)
// carry what reached the supplier; the settlement voucher is
//   Dr supplier (net) · Dr Interest · Dr Bank charges (part 1) / Cr LC payable (LC amount)
//
// The bank is repaid part by part (repayLcParts): each repayment clears whole
// parts, a part repaid before its maturity gets the unexpired interest back,
// and the last repayment closes the LC.
export interface LcPart {
  id: number
  lc_id: number
  part_no: number
  pay_date: string
  amount: number
  maturity_date: string
  days: number
  interest: number
  charges: number
  net: number
  repayment_id: number | null
  repaid_date: string | null
  rebate: number
  interest_pct: number | null
  margin_pct: number | null
}

/** An LC paid in parts carries, as its charges, what its parts were charged. */
async function syncPartsCharges(lcId: number): Promise<void> {
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET charges = (SELECT ROUND(COALESCE(SUM(charges), 0), 2) FROM lc_parts WHERE lc_id = ?)
           WHERE id = ? AND EXISTS (SELECT 1 FROM lc_parts WHERE lc_id = ?)`,
    args: [n(lcId), n(lcId), n(lcId)]
  })
}

/** The margin held on an LC paid in parts: each part at its own margin %
 *  (the LC's where it has none), and what is still undrawn at the LC's. */
export function lcPartsMargin(lc: Row, parts: Row[]): number {
  const rate = n(lc.margin_pct)
  const drawn = parts.reduce((s, p) => s + n(p.amount), 0)
  const onParts = parts.reduce((s, p) => s + (n(p.amount) * (p.margin_pct == null ? rate : n(p.margin_pct))) / 100, 0)
  return round2(onParts + (Math.max(0, n(lc.amount) - drawn) * rate) / 100)
}

/** A part's own rate as sent from a form: blank means "the LC's". */
const partRate = (v: unknown): number | null => {
  if (v == null || String(v).trim() === '') return null
  const x = Number(v)
  if (!Number.isFinite(x) || x < 0) throw new Error('A part\'s interest or margin % must be a number, 0 or more')
  return x
}

export async function lcParts(lcId: number): Promise<LcPart[]> {
  const r = await getClient()
    .execute({ sql: 'SELECT * FROM lc_parts WHERE lc_id = ? ORDER BY part_no', args: [n(lcId)] })
    .catch(() => null)
  return r ? (toPlain(r) as unknown as LcPart[]) : []
}

/** One part's interest, charges and what reaches the supplier. */
function partFigures(
  lc: Row,
  amount: number,
  payDate: string,
  maturity: string,
  first: boolean,
  ratePct?: number | null,
  ownCharges?: number | null
): { days: number; interest: number; charges: number; net: number } {
  const days = Math.max(0, daysBetween(payDate, maturity))
  // Each part's own bank charges where it was given them; otherwise, as
  // before, the LC's charges on part 1 and none on the rest.
  const charges = ownCharges != null ? round2(ownCharges) : first ? round2(n(lc.charges)) : 0
  // The same base the whole-LC interest uses: the amount, less the bank's
  // charges where the LC says interest runs on what was actually advanced.
  const base = Math.max(0, round2(amount - (lc.interest_excl_charges ? charges : 0)))
  const interest = round2((base * n(ratePct == null ? lc.interest_pct : ratePct) * days) / (100 * 365))
  return { days, interest, charges, net: round2(amount - interest - charges) }
}

async function insertLcPart(
  lcId: number,
  partNo: number,
  lc: Row,
  amount: number,
  payDate: string,
  maturity: string,
  rates: { interest_pct?: unknown; margin_pct?: unknown; charges?: unknown } = {}
): Promise<{ net: number; interest: number }> {
  if (lc.interest_upfront) {
    throw new Error("This LC's interest is paid upfront from the bank account, so it cannot be split into parts with their own maturities.")
  }
  if (!maturity) throw new Error(`Pick the maturity of part ${partNo}`)
  if (maturity < payDate) throw new Error(`Part ${partNo} cannot mature (${dmy(maturity)}) before it was paid (${dmy(payDate)})`)
  const ip = partRate(rates.interest_pct)
  const mp = partRate(rates.margin_pct)
  const ch = partRate(rates.charges)
  const f = partFigures(lc, amount, payDate, maturity, partNo === 1, ip, ch)
  if (f.net <= 0.005) throw new Error(`Part ${partNo}'s interest and charges are more than its amount`)
  await getClient().execute({
    sql: `INSERT INTO lc_parts (lc_id, part_no, pay_date, amount, maturity_date, days, interest, charges, net, interest_pct, margin_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [n(lcId), partNo, payDate, round2(amount), maturity, f.days, f.interest, f.charges, f.net, ip, mp]
  })
  return { net: f.net, interest: f.interest }
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
  // PAID IN INSTALLMENTS: the bank paid only part of the net to the supplier
  // on this date. That part becomes installment 1; the rest is paid later
  // through payLcParty, each part on its own date with its own voucher.
  // first_installment is part 1's LC AMOUNT (off the bank's bill), with its
  // own maturity; the interest and what the supplier got are worked from it.
  const firstPart = round2(n(v.first_installment))
  // SEVERAL PARTS AT ONCE: parts_plan lists every part the bank has paid so
  // far — its LC amount, the day it was paid, its own maturity, and its own
  // interest and margin % (blank = the LC's). Part 1 is paid on the payment
  // received date; each part is posted as its own voucher on its own date,
  // exactly as if the later ones had come through Pay party one by one.
  const plan: Row[] = Array.isArray(v.parts_plan) ? v.parts_plan.filter((p: Row) => round2(n(p?.amount)) > 0.005) : []
  if (n(existing.rows[0]?.n) === 0 && plan.length) {
    const total = round2(plan.reduce((s, p) => s + round2(n(p.amount)), 0))
    if (total > n(v.amount) + 0.005) {
      throw new Error(`The parts come to ${total.toFixed(2)}, more than the LC's ${n(v.amount).toFixed(2)}`)
    }
    await c.execute({ sql: 'DELETE FROM lc_parts WHERE lc_id = ?', args: [lcId] })
    const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x: unknown) => n(x)).filter((x: number) => x > 0) : []
    let prev = paymentDate
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]
      const no = i + 1
      const payOn = i === 0 ? paymentDate : String(p.pay_date || '').slice(0, 10)
      if (!payOn) throw new Error(`Pick the day part ${no} was paid`)
      if (payOn > todayISO()) throw new Error(`Part ${no} cannot be paid on a future date`)
      if (payOn < prev) throw new Error(`Part ${no} cannot be paid (${dmy(payOn)}) before part ${no - 1} (${dmy(prev)})`)
      prev = payOn
      const maturity = String(p.maturity || '').slice(0, 10)
      const fig = await insertLcPart(lcId, no, v, round2(n(p.amount)), payOn, maturity, p)
      const billIds = await insertInstallmentBills(lcId, fig.net, payOn, maturity, no, ids)
      const memo = String(p.note || '').trim()
      if (memo && billIds.length) {
        await c.execute({
          sql: `UPDATE lc_issuances SET note = ? WHERE id IN (${billIds.map(() => '?').join(',')})`,
          args: [memo, ...billIds]
        })
      }
      await settleLcBillsCombined(billIds, payOn)
    }
    await syncPartsCharges(lcId)
  } else if (n(existing.rows[0]?.n) === 0 && firstPart > 0.005) {
    if (firstPart > n(v.amount) + 0.005) {
      throw new Error(`Part 1 (${firstPart.toFixed(2)}) is more than the LC's ${n(v.amount).toFixed(2)}`)
    }
    const maturity = String(v.first_installment_maturity || v.expiry_date || '').slice(0, 10)
    await c.execute({ sql: 'DELETE FROM lc_parts WHERE lc_id = ?', args: [lcId] })
    const p1 = await insertLcPart(lcId, 1, v, firstPart, paymentDate, maturity)
    const ids = Array.isArray(v.linked_order_ids) ? v.linked_order_ids.map((x: unknown) => n(x)).filter((x: number) => x > 0) : []
    await insertInstallmentBills(lcId, p1.net, paymentDate, maturity, 1, ids)
  } else if (n(existing.rows[0]?.n) === 0) {
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
      // No real invoice to name it after (relaxed rule or back-entry) — leave
      // bill_no unset rather than filling it with the LC's own number, so
      // settlement below falls through to a true ON ACCOUNT allocation
      // instead of a synthetic "reference" that isn't really an invoice.
      await c.execute({
        sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, bill_no, due_date, status)
              VALUES (?, ?, ?, ?, ?, 'outstanding')`,
        args: [lcId, issueDate, netAvailable(v, 0), null, dueDate]
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
  await settleLcBillsCombined(outstanding.rows.map((r) => Number(r.id)), paymentDate)
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
  'our_bank_id',
  'usance_days',
  'margin_pct',
  'lc_no',
  'facility_type',
  'bank',
  'party_type',
  'party_id',
  'amount',
  // What the bank blocks against the facility. Nullable on purpose: an LC that
  // has never been told otherwise reads its blocked figure as the open amount,
  // which is what every LC opened before this column existed means.
  'blocked_amount',
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
  'interest_upfront',
  'interest_excl_charges',
  'interest_adj',
  // HOW LONG BEFORE THE MONEY COMES BACK.
  //
  // Optional, and a plain number of days rather than a date, because that is
  // how the terms are agreed — "60 days from the LC" — and a date typed by
  // hand drifts from whatever the LC was actually opened on. Counted from the
  // opening; the register turns it into a date and says whether it is due.
  'payment_in_expected',
  'payment_in_days'
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
      // blocked_amount is deliberately NOT in this list. Blank means "same as
      // the open amount", and 0 would mean the bank blocked nothing at all.
      if (
        k === 'amount' ||
        k === 'usance_days' ||
        k === 'margin_pct' ||
        k === 'interest_upfront' ||
        k === 'interest_excl_charges' ||
        k === 'interest_adj'
      ) {
        return 0
      }
      // lc_no is NOT NULL but genuinely unknown until Open — an empty string
      // satisfies the column without pretending to have a real number.
      if (k === 'lc_no') return ''
      if (k === 'payment_in_expected') return 0
      return null
    }
    if (
      k === 'our_bank_id' ||
      k === 'party_id' ||
      k === 'amount' ||
      k === 'blocked_amount' ||
      k === 'interest_pct' ||
      k === 'charges' ||
      k === 'usance_days' ||
      k === 'margin_pct' ||
      k === 'facility_id' ||
      k === 'receivable_party_id' ||
      k === 'interest_upfront' ||
      // Signed: a negative adjustment is the ordinary case, so this must not
      // be floored or read as a string.
      k === 'interest_adj' ||
      // A number of days, kept as one — blank has already fallen through to
      // null above, which is "no term agreed" rather than nought days.
      k === 'payment_in_days' ||
      k === 'payment_in_expected'
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
  // The blocked amount is what the facility has to carry.
  const amount = n(v.blocked_amount) || n(v.amount)
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

// An LC number identifies one credit with one bank, so two of them in the same
// company is not a variation on a theme — it is two different liabilities
// wearing the same name. Both settlement journals then carry the same vch_no,
// the register shows two rows you cannot tell apart, and a ledger reference to
// "LC-1" no longer points at anything in particular.
//
// Scoped to the company, because the two books number their credits
// independently — KR FOODS LC-1 and KR FINMARK LC-1 are unrelated documents and
// always were. Compared trimmed and case-insensitively, since "lc-1 " and
// "LC-1" are the same number typed twice, and a collision that slips through on
// whitespace is worse than none at all.
//
// Blank passes: an LC still at Application has no number yet, and
// assertLcNoIfPastApplication is what requires one later.
//
// A NUMBER ALREADY IN THE BOOKS IS LEFT ALONE. KR FINMARK has eight numbers on
// two LCs each — a genuine restart of the series in July, not duplicate data —
// and refusing those saves would lock sixteen live LCs out of every edit,
// including the corrections needed to sort them out. So an existing LC keeping
// the number it already has is allowed through; what is refused is CREATING a
// collision, or CHANGING a number into one.
async function assertLcNoNotTaken(v: Row, id?: number): Promise<void> {
  const lcNo = String(v.lc_no || '').trim()
  if (!lcNo) return
  const c = getClient()
  const cid = n(v.company_id) || getActiveCompanyId()

  if (id) {
    const own = await c.execute({ sql: 'SELECT lc_no FROM letters_of_credit WHERE id = ?', args: [id] })
    const was = String(own.rows[0]?.lc_no || '').trim()
    // Unchanged — grandfathered, per the note above.
    if (was.toUpperCase() === lcNo.toUpperCase()) return
  }

  const res = await c.execute({
    sql: `SELECT id, lc_no, bank, amount, open_date FROM letters_of_credit
           WHERE company_id = ? AND UPPER(TRIM(COALESCE(lc_no,''))) = ? AND id <> ?
           ORDER BY id LIMIT 1`,
    args: [cid, lcNo.toUpperCase(), n(id)]
  })
  if (!res.rows.length) return
  const clash = toPlain(res)[0]
  const when = String(clash.open_date || '').slice(0, 10)
  throw new Error(
    `LC ${lcNo} already exists in this company — ${clash.bank || 'unknown bank'}` +
      `${when ? `, opened ${when}` : ''}. Give this one a number of its own.`
  )
}

// An LC past Application is financing actual goods, so it has to name the
// purchase invoice(s) it covers — without one the LC has nothing to draw
// against, and the bill it auto-issues on Payment received ends up named
// after the LC itself rather than a real invoice. At Application it is still
// only a request to the bank, so the invoice isn't required yet.
async function assertHasLinkedInvoice(v: Row): Promise<void> {
  if (String(v.stage || 'application') === 'application') return
  const ids = Array.isArray(v.linked_order_ids)
    ? v.linked_order_ids.map((x: unknown) => n(x)).filter((x: number) => x > 0)
    : []
  if (ids.length) return
  // Admin-only override (Settings → General): when off, every LC is treated
  // like the back-entry case below regardless of date — there just isn't
  // always a real invoice to point at, and the business still needs to open
  // the LC and record payment against it as an on-account receipt.
  if ((await getSetting('lc_require_linked_invoice')) === '0') return
  // Back-entered history is exempt. The books only start partway through, so
  // an LC opened before that has no invoice on file to point at — the goods it
  // financed were invoiced long before anything was keyed in. Demanding a link
  // there is a dead end, not a control. So the rule only bites once the
  // supplier actually HAS an invoice dated on or before this LC's own
  // application date: nothing to link, nothing to insist on. It needs no
  // configured start date and stops exempting anything by itself, the moment
  // real invoices exist to choose from.
  const res = await getClient().execute({
    sql: `SELECT COUNT(*) AS n FROM orders
          WHERE supplier_id = ? AND company_id = ? AND COALESCE(is_trading, 0) = ? AND order_date <= ?`,
    args: [
      n(v.party_id),
      n(v.company_id) || getActiveCompanyId(),
      String(v.purpose || '') === 'trading' ? 1 : 0,
      String(v.open_date || '').slice(0, 10)
    ]
  })
  if (n(res.rows[0]?.n) === 0) return
  throw new Error(
    'Link at least one purchase invoice before the LC leaves Application — an LC that is Open or has received payment must name the invoice(s) it covers.'
  )
}

// THE DATES A STAGE STANDS ON.
//
// A stage is a claim about what has already happened, and each claim carries
// its own facts. Open says the bank opened the credit — on a day. Payment
// received says the money arrived and the credit falls due — two more days,
// and the interest is the gap between them, so an LC left at Payment received
// without them has no interest, no maturity and nothing to preclose against.
//
// The form asks for the same set and names the stage while doing it; this is
// the side a script or a second window cannot go around.
function assertStageDates(v: Row): void {
  const stage = String(v.stage || 'application')
  const has = (k: string): boolean => !!String(v[k] ?? '').trim()
  if ((stage === 'open' || stage === 'payment_received') && !has('opened_date')) {
    throw new Error('Open date is required once the LC is Open — the day the bank opened the credit')
  }
  if (stage === 'payment_received') {
    if (!has('payment_received_date')) {
      throw new Error('Payment received date is required once payment has been received')
    }
    if (!has('expiry_date')) {
      throw new Error('Maturity date is required once payment has been received — it is what the interest days are counted to')
    }
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

// Re-post every voucher whose figures come off the LC's own fields, so the
// books always match what was just saved. Failures are COLLECTED rather than
// swallowed: the LC row itself is already written by this point, so throwing
// would strand the caller, but staying silent used to leave the ledger quietly
// out of step with the LC (the bug this replaces). The caller passes the
// warning back to the user instead.
// Keep the auto-issued bill in step with the LC's own figures.
//
// A whole-limit bill is RAISED at net available — open amount less interest and
// charges — but only at the moment it is first created. Change the interest
// afterwards and the bill keeps yesterday's number: turning off interest on the
// bank charges lowered LC-15's interest by 70.11, so the beneficiary was owed
// 70.11 more, and the bill still said the old figure. The LC then reported
// 70.11 of undrawn limit that was never really undrawn.
//
// Only the auto-issued whole-limit bill is touched — one bill, tied to no
// purchase invoice, which is exactly the shape the `else if` branch of
// syncPaymentReceivedIssuance creates. A bill sized to a specific invoice is a
// deliberate figure and is left alone.
async function resizeAutoLcBill(lcId: number): Promise<void> {
  const c = getClient()
  const lcRes = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [n(lcId)] })
  if (!lcRes.rows.length) return
  const lc = toPlain(lcRes)[0]
  const res = await c.execute({
    sql: 'SELECT id, amount, order_id, bill_no, installment_no FROM lc_issuances WHERE lc_id = ?',
    args: [n(lcId)]
  })
  if (res.rows.length !== 1) return
  const bill = toPlain(res)[0]
  if (n(bill.order_id)) return
  // A first installment is a deliberate part-payment, not the whole limit.
  if (n(bill.installment_no)) return
  if (String(bill.bill_no || '').trim()) return

  const want = netAvailable(lc, 0)
  if (want <= 0.005) return
  if (Math.abs(want - n(bill.amount)) < 0.005) return

  await c.execute({
    sql: 'UPDATE lc_issuances SET amount = ? WHERE id = ?',
    args: [round2(want), n(bill.id)]
  })
}

async function syncLcVouchers(id: number): Promise<string | undefined> {
  const problems: string[] = []
  try {
    await postLcOpening(id)
  } catch (e) {
    problems.push(`the margin voucher (${(e as Error).message})`)
  }
  try {
    // Clears the separate fee voucher earlier versions raised; the fees ride on
    // the settlement journal now.
    await postLcFees(id)
  } catch (e) {
    problems.push(`the stray fee voucher (${(e as Error).message})`)
  }
  try {
    // Before anything is posted: the settlement voucher is written from the
    // bill's amount, so the bill has to be right first.
    await resizeAutoLcBill(id)
  } catch (e) {
    problems.push(`the bill amount (${(e as Error).message})`)
  }
  try {
    // Before the settlement, because the settlement's fee lines depend on
    // whether an upfront voucher is carrying them. Re-posting it first would
    // only be undone a moment later.
    await refreshLcUpfrontInterest(id)
  } catch (e) {
    problems.push(`the upfront interest voucher (${(e as Error).message})`)
  }
  try {
    // The settlement journal carries the supplier's discharge AND the bank's
    // interest and commission, so a change to the rate, the days or the
    // commission has to re-derive it. Without this the ledger would keep
    // whatever those were on the day the bank paid.
    await resyncLcSettlement(id)
  } catch (e) {
    problems.push(`the settlement journal (${(e as Error).message})`)
  }
  try {
    await syncLcFeeAdjustment(id)
  } catch (e) {
    problems.push(`the party's fee adjustment (${(e as Error).message})`)
  }
  if (!problems.length) return undefined
  throw new Error(`LC not saved: ${problems.join(' and ')} could not be posted. The previous books were retained.`)
}

// A bank belongs to one company (own-account, not the financing/discounting
// bank) — this catches a stale picker left over from switching companies
// before saving, rather than letting an LC quietly point at another
// company's account.
async function assertOwnBankBelongsToCompany(v: Row): Promise<void> {
  const bankId = n(v.our_bank_id)
  if (!bankId) return
  const cid = n(v.company_id) || getActiveCompanyId()
  const owner = await getClient().execute({ sql: 'SELECT company_id FROM banks WHERE id = ?', args: [bankId] })
  if (n(owner.rows[0]?.company_id) !== cid) {
    throw new Error("That bank belongs to a different company — pick one of this company's own banks")
  }
}

export async function createLC(v: Row): Promise<{ id: number; warning?: string }> {
  return withDbTransaction(async () => {
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
  assertStageDates(v)
  await assertLcNoNotTaken(v)
  await assertHasLinkedInvoice(v)
  await assertOwnBankBelongsToCompany(v)
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
  await linkTradingDealsToLc(id, v.linked_deal_ids)
  await syncPaymentReceivedIssuance(id, v)
  // Margin + charges voucher into the books (skipped when both are zero).
  const warning = await syncLcVouchers(id)
  return { id, warning }
  })
}

export async function updateLC(id: number, v: Row): Promise<{ id: number; warning?: string }> {
  return withDbTransaction(async () => {
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
  assertStageDates(v)
  await assertLcNoNotTaken(v, id)
  await assertHasLinkedInvoice(v)
  await assertOwnBankBelongsToCompany(v)
  assertPaymentReceivedNotBeforeOpen(v)
  if (!String(v.fd_no || '').trim()) throw new Error('FD No is required')
  await assertWithinFacility(v, id)
  await assertWithinInvoiceCover(v)
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET ${LC_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...lcArgs(v), id]
  })
  await syncLinkedOrders(id, v.linked_order_ids)
  await linkTradingDealsToLc(id, v.linked_deal_ids)
  await syncPaymentReceivedIssuance(id, v)
  const warning = await syncLcVouchers(id)
  return { id, warning }
  })
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
    // Charges on ledgers the user picks — as many rows as the debit carried.
    charges?: { account?: string; amount?: number | string }[]
    premature_interest?: number
    premature_interest_direction?: 'credit_to_us' | 'pay_to_party'
    release_margin?: boolean
  }
): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  if (lc.preclosed_date) throw new Error('This LC is already preclosed')
  if ((await lcParts(id)).length) {
    throw new Error('This LC was paid in parts — repay it part by part from ⋮ → Parts (each part has its own maturity and rebate).')
  }
  // Winding up early only means something once the bank has PAID under the
  // credit. Before that there is no advance to repay and no interest running —
  // an LC still with the bank is cancelled, not preclosed, and this routine
  // would compute its interest from a payout date that does not exist.
  if (String(lc.stage || 'application') !== 'payment_received') {
    throw new Error(
      String(lc.stage || 'application') === 'application'
        ? 'This LC is still an application — the bank has not opened it, so there is nothing to wind up. Mark it Open first.'
        : 'The bank has not paid the beneficiary under this LC yet, so there is nothing to repay. Mark Payment received first.'
    )
  }
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
    await c.execute({
      sql: `UPDATE letters_of_credit
               SET preclose_interest_journal_entry_id = ?, preclose_payout_journal_entry_id = ?
             WHERE id = ?`,
      args: [rebate.id, rebate.payoutId ?? null, id]
    })
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
    charges: v.charges || [],
    repay_date: precloseDate,
    posted: true,
    note: 'Preclosure repayment'
  })
  if (v.release_margin) {
    const margin = round2((n(lc.amount) * n(lc.margin_pct)) / 100)
    // Records the release whether or not it raises a voucher. The margin is
    // off the books now (see postLcMarginRelease), so there is no entry to
    // write — but that the bank let it go, and how much, is a fact about this
    // LC and belongs on the row either way.
    const settlement = await postLcMarginRelease(id, margin, precloseDate)
    await c.execute({
      sql: `UPDATE letters_of_credit SET preclose_settlement_direction = 'margin_released',
            preclose_settlement_amount = ?, preclose_journal_entry_id = ? WHERE id = ?`,
      args: [margin, settlement ? settlement.id : null, id]
    })
  }
  await c.execute({ sql: "UPDATE letters_of_credit SET workflow_status = 'preclosed' WHERE id = ?", args: [id] })
  return { id }
  })
}

// Undo a preclosure booked by mistake. Everything precloseLC wrote comes back
// out, in reverse:
//   * the premature-interest rebate voucher
//   * the margin-release voucher and the settlement it recorded
//   * the repayment row it logged (and that row's own voucher)
//   * usance_days, which preclosing overwrote with the days actually elapsed —
//     restored to the planned figure it was struck from at Payment Received
//     (expiry − payment received), the same derivation as the original
//   * the opening voucher, re-struck on that full planned interest period
//
// Bills issued under the LC and any Payment IN are left alone: they are not
// part of the preclosure, and undoing it must not disturb them.
export async function unPrecloseLC(id: number): Promise<{ id: number; removed: string[] }> {
  return withDbTransaction(async () => {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  if (!lc.preclosed_date) throw new Error('This LC is not preclosed, so there is nothing to undo')
  if ((await lcParts(id)).length) {
    throw new Error('This LC was closed by repaying its parts — undo the last part repayment from ⋮ → Parts instead.')
  }
  const removed: string[] = []

  if (lc.preclose_payout_journal_entry_id) {
    // The rebate raises two vouchers when it is passed on — the reversal and
    // the payout — so undoing a preclosure has to take both.
    await dropTreasuryEntry(n(lc.preclose_payout_journal_entry_id))
  }
  if (lc.preclose_interest_journal_entry_id) {
    await dropTreasuryEntry(n(lc.preclose_interest_journal_entry_id))
    removed.push('premature-interest rebate voucher')
  }
  if (lc.preclose_journal_entry_id) {
    await dropTreasuryEntry(n(lc.preclose_journal_entry_id))
    removed.push('margin-release voucher')
  }

  // The repayment preclosing logged for itself — matched on the LC, the
  // preclosure date and the note it was written with, so a repayment the user
  // entered by hand on the same day is not swept up with it.
  const reps = await c.execute({
    sql: `SELECT id, journal_entry_id FROM lc_repayments
           WHERE lc_id = ? AND substr(repay_date, 1, 10) = ? AND COALESCE(note, '') = 'Preclosure repayment'`,
    args: [id, String(lc.preclosed_date).slice(0, 10)]
  })
  for (const r of reps.rows) {
    if (r.journal_entry_id) await dropTreasuryEntry(n(r.journal_entry_id))
    await c.execute({ sql: 'DELETE FROM lc_repayments WHERE id = ?', args: [n(r.id)] })
  }
  if (reps.rows.length) removed.push(`${reps.rows.length} preclosure repayment row(s)`)

  // Back to the planned interest period. Same start point precloseLC counted
  // from, run to the LC's own maturity instead of the preclosure date.
  const interestStart = lc.payment_received_date || lc.opened_date || lc.open_date
  const plannedDays =
    interestStart && lc.expiry_date ? Math.max(0, daysBetween(String(interestStart), String(lc.expiry_date))) : n(lc.usance_days)
  await c.execute({
    sql: `UPDATE letters_of_credit
             SET usance_days = ?, preclosed_date = NULL, preclose_premature_interest = NULL,
                 preclose_interest_route = NULL, preclose_interest_journal_entry_id = NULL,
                 preclose_payout_journal_entry_id = NULL,
                 preclose_settlement_direction = NULL, preclose_settlement_amount = NULL,
                 preclose_journal_entry_id = NULL, workflow_status = 'in_progress'
           WHERE id = ?`,
    args: [plannedDays, id]
  })
  // Re-strikes margin/interest/charges on the restored period.
  await postLcOpening(id)
  removed.push(`interest days back to ${plannedDays}`)
  return { id, removed }
  })
}

export async function deleteLC(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
  const c = getClient()
  // Reverse everything the LC put into the books before it goes.
  const bills = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE lc_id = ?', args: [id] })
  for (const b of bills.rows) if (b.journal_entry_id) await dropTreasuryEntry(Number(b.journal_entry_id))
  const repayments = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_repayments WHERE lc_id = ?', args: [id] })
  for (const r of repayments.rows) if (r.journal_entry_id) await dropTreasuryEntry(Number(r.journal_entry_id))
  const paymentIns = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_payment_ins WHERE lc_id = ?', args: [id] })
  for (const p of paymentIns.rows) if (p.journal_entry_id) await dropTreasuryEntry(Number(p.journal_entry_id))
  const lc = await c.execute({
    sql: `SELECT journal_entry_id, preclose_journal_entry_id, interest_journal_entry_id, preclose_interest_journal_entry_id,
                 preclose_payout_journal_entry_id, charges_journal_entry_id
          FROM letters_of_credit WHERE id = ?`,
    args: [id]
  })
  if (lc.rows.length && lc.rows[0].journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].journal_entry_id))
  if (lc.rows.length && lc.rows[0].preclose_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_journal_entry_id))
  if (lc.rows.length && lc.rows[0].interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].interest_journal_entry_id))
  if (lc.rows.length && lc.rows[0].preclose_interest_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_interest_journal_entry_id))
  if (lc.rows.length && lc.rows[0].preclose_payout_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].preclose_payout_journal_entry_id))
  if (lc.rows.length && lc.rows[0].charges_journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].charges_journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_repayments WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_payment_ins WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [id] })
  await linkTradingDealsToLc(id, [])
  await c.execute({ sql: 'DELETE FROM letters_of_credit WHERE id = ?', args: [id] })
  return { id }
  })
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
  return withDbTransaction(async () => {
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
  })
}

export async function deleteLCIssuance(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
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
  })
}

// A REPAID OR PRECLOSED LC IS CLOSED BOOKS.
//
// Once the bank has been repaid, the LC's figures are what that repayment,
// its interest rebate and its margin release were worked out from — and
// preclosing even rewrites usance_days to the days actually run. Editing an
// amount, a rate or a date afterwards would leave those vouchers answering to
// numbers that are no longer on the LC. So the only way back in is Undo
// preclosure, which reverses all of it first; then edit, then close again.
export async function assertLcNotClosed(lcId: number, what = 'edited'): Promise<void> {
  if (!lcId) return
  const r = await getClient().execute({
    sql: 'SELECT lc_no, preclosed_date, workflow_status, rejected_date FROM letters_of_credit WHERE id = ?',
    args: [lcId]
  })
  const row = r.rows[0] as unknown as
    | { lc_no?: string; preclosed_date?: string; workflow_status?: string; rejected_date?: string }
    | undefined
  if (String(row?.workflow_status || '') === 'rejected') {
    const [ry, rm, rd] = String(row?.rejected_date || '').slice(0, 10).split('-')
    throw new Error(
      `This LC application was rejected${ry ? ` on ${rd}-${rm}-${ry}` : ''}, so it can no longer be ${what}. ` +
        'Use ⋮ → Reinstate application first if the rejection was a mistake.'
    )
  }
  const closed = String(row?.preclosed_date || '').slice(0, 10)
  if (!closed) return
  const [y, m, d] = closed.split('-')
  if ((await lcParts(lcId)).length) {
    throw new Error(
      `LC ${String(row?.lc_no || '')} was closed on ${d}-${m}-${y} by repaying its last part, so it can no longer be ${what}. ` +
        'Use ⋮ → Parts → Undo last repayment to reopen it.'
    )
  }
  throw new Error(
    `LC ${String(row?.lc_no || '')} was repaid on ${d}-${m}-${y} and is closed, so it can no longer be ${what}. ` +
      'To change how it was closed, use ⋮ → Edit preclosure; to change the LC itself, Undo preclosure first.'
  )
}

// ── REJECTED AT APPLICATION ──────────────────────────────────────────────────
//
// The bank can turn an LC application down. Nothing was ever posted for it —
// an application carries no voucher (see postLcOpening) — so rejecting it is a
// statement, not a reversal: the LC stays in the register, marked Rejected with
// the day and the reason, and stops counting anywhere a figure is added up —
// the LC limit and its Application bucket, the bank-wise utilisation, the
// facility headroom, Outstanding, the expiry alert. It cannot be edited,
// advanced or drawn on until it is reinstated.
//
// Only an application can be rejected, and only one nothing has happened to:
// no bill, no repayment, no Payment IN, no upfront interest voucher. Anything
// further along was opened by the bank, which is not a rejection.
export async function rejectLC(
  id: number,
  v: { date?: string; reason?: string }
): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const r = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [n(id)] })
    if (!r.rows.length) throw new Error('That LC no longer exists')
    const lc = toPlain(r)[0]
    if (String(lc.workflow_status || '') === 'rejected') throw new Error('This application is already rejected')
    if (String(lc.stage || 'application') !== 'application') {
      throw new Error('Only an LC still at Application can be rejected — this one has been opened by the bank.')
    }
    if (lc.preclosed_date) throw new Error('This LC is closed')
    const counts = toPlain(
      await c.execute({
        sql: `SELECT (SELECT COUNT(*) FROM lc_issuances WHERE lc_id = ?) AS bills,
                     (SELECT COUNT(*) FROM lc_repayments WHERE lc_id = ?) AS repayments,
                     (SELECT COUNT(*) FROM lc_payment_ins WHERE lc_id = ?) AS ins`,
        args: [n(id), n(id), n(id)]
      })
    )[0]
    if (n(counts.bills) || n(counts.repayments) || n(counts.ins) || n(lc.interest_journal_entry_id)) {
      throw new Error('This application already has bills, repayments or vouchers against it, so it cannot simply be rejected.')
    }
    const date = String(v?.date || '').slice(0, 10) || todayISO()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the date the bank rejected it')
    if (date > todayISO()) throw new Error('The rejection date cannot be in the future')
    const applied = String(lc.open_date || '').slice(0, 10)
    if (applied && date < applied) throw new Error(`The bank cannot have rejected it before it was applied for (${applied})`)
    const reason = String(v?.reason || '').trim()
    if (!reason) throw new Error('Say why the bank rejected it')
    await c.execute({
      sql: `UPDATE letters_of_credit
               SET workflow_status = 'rejected', rejected_date = ?, rejected_reason = ?, rejected_by = ?
             WHERE id = ?`,
      args: [date, reason.slice(0, 500), String((await import('./currentUser')).getCurrentUser()?.username || '') || null, n(id)]
    })
    return { id: n(id) }
  })
}

/** A rejection made in error, undone: the application counts again, as it did. */
export async function reinstateLC(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const r = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [n(id)] })
    if (!r.rows.length) throw new Error('That LC no longer exists')
    const lc = toPlain(r)[0]
    if (String(lc.workflow_status || '') !== 'rejected') throw new Error('This LC is not rejected')
    // It takes limit again, so it has to fit — the same check a new LC meets.
    await assertWithinFacility(lc, n(id))
    await c.execute({
      sql: `UPDATE letters_of_credit
               SET workflow_status = 'in_progress', rejected_date = NULL, rejected_reason = NULL, rejected_by = NULL
             WHERE id = ?`,
      args: [n(id)]
    })
    return { id: n(id) }
  })
}

/**
 * Repay the bank for one or more whole parts. One lc_repayments row and its
 * voucher (Dr LC payable / Cr bank, with any charges on the day); a part
 * repaid before its own maturity gets the unexpired share of ITS interest
 * back (Cr Interest — kept, or passed on to the supplier). The repayment that
 * clears the last part closes the LC — optionally releasing the margin.
 */
export async function repayLcParts(
  lcId: number,
  v: {
    date: string
    parts: number[]
    comm_charges?: number
    bank_charges?: number
    charges?: { account?: string; amount?: number | string }[]
    rebate_route?: 'credit_to_us' | 'pay_to_party'
    release_margin?: boolean
    note?: string
  }
): Promise<{ repayment_id: number; closed: boolean; rebate: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const r = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [n(lcId)] })
    if (!r.rows.length) throw new Error('LC not found')
    const lc = toPlain(r)[0]
    if (lc.preclosed_date) throw new Error('This LC is already closed')
    const all = await lcParts(n(lcId))
    if (!all.length) throw new Error('This LC was not paid in parts — use Repay / Preclose')
    const want = new Set((v.parts || []).map((x) => n(x)).filter((x) => x > 0))
    const pick = all.filter((p) => want.has(n(p.part_no)))
    if (!pick.length) throw new Error('Tick the parts this repayment clears')
    const done = pick.find((p) => p.repaid_date)
    if (done) throw new Error(`Part ${done.part_no} was already repaid on ${dmy(String(done.repaid_date))}`)
    const date = String(v.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick the repayment date')
    if (date > todayISO()) throw new Error('The repayment date cannot be in the future')
    const early = pick.find((p) => date < String(p.pay_date).slice(0, 10))
    if (early) throw new Error(`Part ${early.part_no} was only paid on ${dmy(String(early.pay_date))} — it cannot be repaid before that`)
    const comm = round2(n(v.comm_charges))
    const bankCh = round2(n(v.bank_charges))
    const { lcChargeRows } = await import('./treasury')
    const chargeRows = await lcChargeRows(v.charges)
    const rowsTotal = round2(chargeRows.reduce((s, x) => s + x.amount, 0))
    const principal = round2(pick.reduce((s, p) => s + n(p.amount), 0))
    const label = pick.map((p) => p.part_no).join(', ')
    // REPAID BEFORE ITS MATURITY: the bank charged interest to the part's own
    // maturity when it paid, so it now debits that much less — the unexpired
    // share comes back off the debit, and a rebate voucher (Dr LC payable / Cr
    // Interest) takes the same off the interest. Worked first, because the
    // debit depends on it.
    const route = v.rebate_route === 'pay_to_party' ? 'pay_to_party' : 'credit_to_us'
    const rebates = pick.map((p) => {
      const left = Math.max(0, daysBetween(date, String(p.maturity_date)))
      return n(p.days) > 0 && left > 0 ? round2((n(p.interest) * left) / n(p.days)) : 0
    })
    const rebateTotal = round2(rebates.reduce((s, x) => s + x, 0))
    const ins = await c.execute({
      sql: `INSERT INTO lc_repayments (lc_id, party_id, amount, maturity_charges, comm_charges, bank_charges, repay_date, posted, document_path, note)
            VALUES (?, NULL, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      args: [n(lcId), round2(principal - rebateTotal + comm + bankCh + rowsTotal), round2(comm + bankCh + rowsTotal), comm, bankCh, date,
        `Part repayment — part${pick.length === 1 ? '' : 's'} ${label}${String(v.note || '').trim() ? ` · ${String(v.note).trim()}` : ''}`]
    })
    const repId = Number(ins.lastInsertRowid)
    if (chargeRows.length) {
      await c.execute({
        sql: 'UPDATE lc_repayments SET charges = ?, charges_total = ? WHERE id = ?',
        args: [JSON.stringify(chargeRows), rowsTotal, repId]
      })
    }
    const { postLcRepaymentEntry } = await import('./treasury')
    await postLcRepaymentEntry(repId)
    // The unexpired interest on each part repaid early comes back.
    for (let i = 0; i < pick.length; i++) {
      const p = pick[i]
      const rebate = rebates[i]
      let je: { id: number; payoutId?: number } | null = null
      if (rebate > 0.005) je = await postLcPrematureInterestRebate(n(lcId), route, rebate, date)
      await c.execute({
        sql: `UPDATE lc_parts SET repaid_date = ?, repayment_id = ?, rebate = ?, rebate_route = ?,
                     rebate_journal_entry_id = ?, rebate_payout_journal_entry_id = ? WHERE id = ?`,
        args: [date, repId, rebate, rebate > 0.005 ? route : null, je?.id ?? null, je?.payoutId ?? null, n(p.id)]
      })
    }
    // The last part repaid closes the LC — what was never drawn is not owed.
    const open = all.filter((p) => !p.repaid_date && !want.has(n(p.part_no)))
    let closed = false
    if (!open.length) {
      closed = true
      await c.execute({
        sql: `UPDATE letters_of_credit SET preclosed_date = ?, workflow_status = 'preclosed', preclose_parts_repayment_id = ? WHERE id = ?`,
        args: [date, repId, n(lcId)]
      })
      if (v.release_margin) {
        // Each part's own margin %, where it has one.
        const margin = lcPartsMargin(lc, all)
        const settlement = await postLcMarginRelease(n(lcId), margin, date)
        await c.execute({
          sql: `UPDATE letters_of_credit SET preclose_settlement_direction = 'margin_released',
                preclose_settlement_amount = ?, preclose_journal_entry_id = ? WHERE id = ?`,
          args: [margin, settlement ? settlement.id : null, n(lcId)]
        })
      }
    }
    return { repayment_id: repId, closed, rebate: rebateTotal }
  })
}

/** Take back the LATEST part repayment — its vouchers, its rebates, and the closure it made. */
export async function undoLcPartRepayment(lcId: number): Promise<{ parts: number[] }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const parts = (await lcParts(n(lcId))).filter((p) => n(p.repayment_id) > 0)
    if (!parts.length) throw new Error('No part of this LC has been repaid yet')
    const repId = Math.max(...parts.map((p) => n(p.repayment_id)))
    const mine = parts.filter((p) => n(p.repayment_id) === repId)
    for (const p of mine) {
      const row = toPlain(await c.execute({ sql: 'SELECT rebate_journal_entry_id, rebate_payout_journal_entry_id FROM lc_parts WHERE id = ?', args: [n(p.id)] }))[0] || {}
      if (n(row.rebate_payout_journal_entry_id)) await dropTreasuryEntry(n(row.rebate_payout_journal_entry_id))
      if (n(row.rebate_journal_entry_id)) await dropTreasuryEntry(n(row.rebate_journal_entry_id))
      await c.execute({
        sql: `UPDATE lc_parts SET repaid_date = NULL, repayment_id = NULL, rebate = 0, rebate_route = NULL,
                     rebate_journal_entry_id = NULL, rebate_payout_journal_entry_id = NULL WHERE id = ?`,
        args: [n(p.id)]
      })
    }
    const rep = toPlain(await c.execute({ sql: 'SELECT journal_entry_id, fee_journal_entry_id FROM lc_repayments WHERE id = ?', args: [repId] }))[0] || {}
    if (n(rep.journal_entry_id)) await dropTreasuryEntry(n(rep.journal_entry_id))
    if (n(rep.fee_journal_entry_id)) await dropTreasuryEntry(n(rep.fee_journal_entry_id))
    await c.execute({ sql: 'DELETE FROM lc_repayments WHERE id = ?', args: [repId] })
    // If this repayment closed the LC, it is open again.
    const lc = toPlain(await c.execute({ sql: 'SELECT preclose_parts_repayment_id, preclose_journal_entry_id FROM letters_of_credit WHERE id = ?', args: [n(lcId)] }))[0] || {}
    if (n(lc.preclose_parts_repayment_id) === repId) {
      if (n(lc.preclose_journal_entry_id)) await dropTreasuryEntry(n(lc.preclose_journal_entry_id))
      await c.execute({
        sql: `UPDATE letters_of_credit SET preclosed_date = NULL, workflow_status = 'in_progress', preclose_parts_repayment_id = NULL,
                     preclose_settlement_direction = NULL, preclose_settlement_amount = NULL, preclose_journal_entry_id = NULL
               WHERE id = ?`,
        args: [n(lcId)]
      })
    }
    return { parts: mine.map((p) => n(p.part_no)) }
  })
}

export async function lcIdOfRepayment(id: number): Promise<number> {
  const r = await getClient().execute({ sql: 'SELECT lc_id FROM lc_repayments WHERE id = ?', args: [id] })
  return Number((r.rows[0] as unknown as { lc_id?: number } | undefined)?.lc_id || 0)
}

export async function lcIdOfIssuance(id: number): Promise<number> {
  const r = await getClient().execute({ sql: 'SELECT lc_id FROM lc_issuances WHERE id = ?', args: [id] })
  return Number((r.rows[0] as unknown as { lc_id?: number } | undefined)?.lc_id || 0)
}

// ── PAYMENT TO THE PARTY IN INSTALLMENTS ────────────────────────────────────
//
// The bank does not always release an LC's whole net to the supplier at once.
// Each part it pays is one installment: a set of bills (lc_issuances) sharing
// an installment_no, settled together by ONE journal on the day it was paid —
// Dr supplier / Cr LC payable — exactly as the single payment always was. The
// bank's interest and commission still ride on the first settlement only
// (settleLcBillsCombined), so the fees are taken once however many parts
// there are, and interest still runs from Payment received to maturity.
//
// A part is spread over the LC's linked invoices first-come, so the supplier's
// bill-wise ledger shows each invoice paid down; with no invoice linked it is
// one on-account bill.
async function insertInstallmentBills(
  lcId: number,
  amount: number,
  date: string,
  dueDate: string,
  instNo: number,
  orderIds: number[]
): Promise<number[]> {
  const c = getClient()
  const ids: number[] = []
  let left = round2(amount)
  for (const oid of orderIds) {
    if (left <= 0.005) break
    const o = await c.execute({ sql: 'SELECT invoice_no, net_amount FROM orders WHERE id = ?', args: [oid] })
    if (!o.rows.length) continue
    const used = await c.execute({
      sql: 'SELECT COALESCE(SUM(amount), 0) AS u FROM lc_issuances WHERE lc_id = ? AND order_id = ?',
      args: [lcId, oid]
    })
    const room = round2(n(o.rows[0].net_amount) - n(used.rows[0]?.u))
    const part = round2(Math.min(left, room))
    if (part <= 0.005) continue
    const ins = await c.execute({
      sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, due_date, status, installment_no)
            VALUES (?, ?, ?, ?, ?, ?, 'outstanding', ?)`,
      args: [lcId, date, part, oid, String(o.rows[0].invoice_no || ''), dueDate, instNo]
    })
    ids.push(Number(ins.lastInsertRowid))
    left = round2(left - part)
  }
  if (left > 0.005) {
    const ins = await c.execute({
      sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, bill_no, due_date, status, installment_no)
            VALUES (?, ?, ?, NULL, ?, 'outstanding', ?)`,
      args: [lcId, date, left, dueDate, instNo]
    })
    ids.push(Number(ins.lastInsertRowid))
  }
  return ids
}

function dmy(iso: string): string {
  return iso.slice(0, 10).split('-').reverse().join('-')
}

/** The next part the bank pays the supplier under this LC. */
export async function payLcParty(lcId: number, v: Row): Promise<{ id: number; installment_no: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [n(lcId)] })
    if (!res.rows.length) throw new Error('LC not found')
    const lc = toPlain(res)[0]
    if (String(lc.stage || '') !== 'payment_received') {
      throw new Error('Mark Payment received first — that records the first part the bank paid')
    }
    // The part's LC AMOUNT, as on the bank's bill — not what reached the
    // supplier, which is worked from it.
    const amount = round2(n(v.amount))
    if (amount <= 0.005) throw new Error("Enter this part's LC amount")
    const date = String(v.date || '').slice(0, 10)
    if (!date) throw new Error('Pick the date the bank paid it')
    if (date > todayISO()) throw new Error('The payment date cannot be in the future')
    const paidFrom = String(lc.payment_received_date || '').slice(0, 10)
    if (paidFrom && date < paidFrom) throw new Error(`An installment cannot be dated before the first payment on ${dmy(paidFrom)}`)
    const bills = toPlain(
      await c.execute({
        sql: 'SELECT amount, installment_no, settled_date FROM lc_issuances WHERE lc_id = ?',
        args: [n(lcId)]
      })
    )
    if (bills.length && !bills.some((b) => n(b.installment_no))) {
      throw new Error('This LC was paid to the supplier in one go — there is nothing left to pay in installments')
    }
    const last = bills.reduce((m, b) => (String(b.settled_date || '') > m ? String(b.settled_date) : m), '')
    if (last && date < last.slice(0, 10)) {
      throw new Error(`The last installment was paid on ${dmy(last)} — this one cannot be dated before it`)
    }
    const parts = await lcParts(n(lcId))
    if (!parts.length) throw new Error('This LC was not paid in parts — there is no next part to record')
    const used = round2(parts.reduce((s, p) => s + n(p.amount), 0))
    const left = round2(n(lc.amount) - used)
    if (left <= 0.005) throw new Error('This LC has been drawn in full — there is nothing left for another part')
    if (amount > left + 0.005) throw new Error(`Only ${left.toFixed(2)} of this LC is still undrawn`)
    const instNo = parts.reduce((m, p) => Math.max(m, n(p.part_no)), 0) + 1
    const maturity = String(v.maturity || '').slice(0, 10)
    const fig = await insertLcPart(n(lcId), instNo, lc, amount, date, maturity, v)
    const linked = await c.execute({
      sql: 'SELECT order_id FROM lc_linked_orders WHERE lc_id = ? ORDER BY order_id',
      args: [n(lcId)]
    })
    const ids = await insertInstallmentBills(
      n(lcId),
      fig.net,
      date,
      maturity,
      instNo,
      linked.rows.map((r) => n((r as unknown as Row).order_id)).filter((x) => x > 0)
    )
    const memo = String(v.note || '').trim()
    if (memo) {
      await c.execute({
        sql: `UPDATE lc_issuances SET note = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        args: [memo, ...ids]
      })
    }
    const je = await settleLcBillsCombined(ids, date)
    if (!je) throw new Error('The installment could not be posted')
    await syncPartsCharges(n(lcId))
    return { id: je.id, installment_no: instNo }
  })
}

/**
 * Take back the LATEST installment — its bills and its voucher. Only the last,
 * so the parts stay in date order, and never the first: that one is the
 * Payment received stage itself.
 */
export async function deleteLastLcInstallment(lcId: number): Promise<{ installment_no: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    const r = await c.execute({ sql: 'SELECT MAX(installment_no) AS m FROM lc_issuances WHERE lc_id = ?', args: [n(lcId)] })
    const instNo = n(r.rows[0]?.m)
    if (!instNo) throw new Error('This LC has no installments')
    if (instNo === 1) throw new Error('The first installment is the Payment received itself — it cannot be removed here')
    const part = (await lcParts(n(lcId))).find((p) => n(p.part_no) === instNo)
    if (part?.repaid_date) throw new Error(`Part ${instNo} has already been repaid to the bank — undo that repayment first`)
    const rows = toPlain(
      await c.execute({
        sql: 'SELECT id, journal_entry_id FROM lc_issuances WHERE lc_id = ? AND installment_no = ?',
        args: [n(lcId), instNo]
      })
    )
    const entries = [...new Set(rows.map((x) => n(x.journal_entry_id)).filter(Boolean))]
    for (const e of entries) await dropTreasuryEntry(e)
    await c.execute({ sql: 'DELETE FROM lc_issuances WHERE lc_id = ? AND installment_no = ?', args: [n(lcId), instNo] })
    await c.execute({ sql: 'DELETE FROM lc_parts WHERE lc_id = ? AND part_no = ?', args: [n(lcId), instNo] })
    await syncPartsCharges(n(lcId))
    return { installment_no: instNo }
  })
}

// EDIT A PRECLOSURE IN PLACE.
//
// The closure's own figures — its date, what the bank debited and how that
// split into commission and charges, the interest rebate and where it went,
// whether the margin was released — corrected without the user having to undo
// the preclosure and redo it by hand. It is still exactly that underneath:
// everything the closure posted is taken out (unPrecloseLC) and the closure is
// posted again from the corrected figures (precloseLC), as ONE transaction, so
// the books are never left half-closed and a refusal changes nothing.
export async function editPreclosure(
  id: number,
  v: Parameters<typeof precloseLC>[1]
): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const res = await getClient().execute({ sql: 'SELECT preclosed_date FROM letters_of_credit WHERE id = ?', args: [n(id)] })
    if (!res.rows.length) throw new Error('LC not found')
    if (!res.rows[0].preclosed_date) throw new Error('This LC is not closed — use Preclose instead')
    await unPrecloseLC(n(id))
    return precloseLC(n(id), v)
  })
}
