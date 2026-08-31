import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postLcOpening, postLcFees, resyncLcSettlement, settleLcBillsCombined, postLcMarginRelease, postLcPrematureInterestRebate, saveLcRepayment, refreshLcUpfrontInterest, syncLcFeeAdjustment, lcFeeDelta } from './treasury'
import { facilityHeadroom } from './facilities'
import { linkTradingDealsToLc } from './trading'
import { getSetting } from './repos'

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
  const interest = lc.interest_upfront
    ? 0
    : round2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / (100 * 365))
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
      (SELECT MIN(due_date) FROM lc_issuances WHERE lc_id = l.id AND COALESCE(status, 'outstanding') != 'settled') AS next_due_date
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
      fee_adjustment: lcFeeDelta(),
      available: round2(netAvailable(l, n(l.utilized)) - lcFeeDelta()),
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
    sql: `SELECT stage, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt FROM letters_of_credit
          WHERE company_id = ? AND COALESCE(facility_type, 'lc') = 'lc' AND preclosed_date IS NULL
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
                 (SELECT COUNT(*) FROM letters_of_credit x WHERE x.company_id = ? AND x.our_bank_id = b.id) AS lc_count,
                 COALESCE((SELECT SUM(x.amount) FROM letters_of_credit x
                           WHERE x.company_id = ? AND x.our_bank_id = b.id
                             AND COALESCE(x.facility_type, 'lc') = 'lc' AND x.preclosed_date IS NULL), 0) AS utilized
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
  'our_bank_id',
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
      k === 'our_bank_id' ||
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
    // The settlement journal carries the supplier's discharge AND the bank's
    // interest and commission, so a change to the rate, the days or the
    // commission has to re-derive it. Without this the ledger would keep
    // whatever those were on the day the bank paid.
    await resyncLcSettlement(id)
  } catch (e) {
    problems.push(`the settlement journal (${(e as Error).message})`)
  }
  try {
    await refreshLcUpfrontInterest(id)
  } catch (e) {
    problems.push(`the upfront interest voucher (${(e as Error).message})`)
  }
  try {
    await syncLcFeeAdjustment(id)
  } catch (e) {
    problems.push(`the party's fee adjustment (${(e as Error).message})`)
  }
  if (!problems.length) return undefined
  return `The LC saved, but ${problems.join(' and ')} could not be re-posted — the books are out of step until that is fixed.`
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
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
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
}

export async function updateLC(id: number, v: Row): Promise<{ id: number; warning?: string }> {
  if (!v.bank) throw new Error('Bank is required')
  if (!String(v.open_date || '').trim()) throw new Error('Application date is required')
  assertLcNoIfPastApplication(v)
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
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('LC not found')
  const lc = toPlain(res)[0]
  if (!lc.preclosed_date) throw new Error('This LC is not preclosed, so there is nothing to undo')
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
}

export async function deleteLC(id: number): Promise<{ id: number }> {
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
