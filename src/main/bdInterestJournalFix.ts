import { getClient } from './db'
import { editBdRepayment } from './billDiscounting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

// BD REPAYMENTS WITH THE INTEREST STILL ON THE PAYMENT VOUCHER.
//
// Since 2026-10-29 a repayment pays the bill discounter for principal AND
// interest (Bills Discounted A/C To Bank A/C) and a journal of its own books
// the interest: Interest on Bill Discounting To Bills Discounted (less TDS),
// To the TDS ledger. Repayments entered before carry Dr INTEREST ON BILL
// DISCOUNTING on the payment itself and no TDS. Each is re-entered, after
// review, through editBdRepayment — its payment keeps its id and number, so
// Tally links stay — with the TDS ledger and % picked here. Bank-settled
// repayments only: a party-settled one is removed and entered again by hand.
export async function previewBdInterestJournals(): Promise<Row> {
  const c = getClient()
  const res = await c.execute(`
    SELECT r.id, r.bd_id, r.repay_date, r.interest, r.journal_entry_id, b.bd_no, b.tds_pct,
           nb.name AS nbfc, co.name AS company, je.vch_no
      FROM bd_repayments r
      JOIN bill_discountings b ON b.id = r.bd_id
      LEFT JOIN nbfcs nb ON nb.id = b.nbfc_id
      LEFT JOIN companies co ON co.id = b.company_id
      LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
     WHERE COALESCE(r.interest, 0) > 0.004
       AND r.interest_entry_id IS NULL
       AND COALESCE(r.settle_via, 'bank') = 'bank'
       AND r.journal_entry_id IS NOT NULL
     ORDER BY r.repay_date, r.id`)
  const findings = (res.rows as unknown as Row[]).map((r) => ({
    id: n(r.id),
    bd_no: String(r.bd_no || ''),
    nbfc: String(r.nbfc || ''),
    company: String(r.company || ''),
    date: String(r.repay_date || '').slice(0, 10),
    vch_no: String(r.vch_no || ''),
    interest: round2(n(r.interest)),
    bill_tds_pct: n(r.tds_pct)
  }))
  return { findings, total: round2(findings.reduce((t, f) => t + f.interest, 0)) }
}

export async function fixBdInterestJournals(
  ids: number[],
  tdsLedger: string,
  tdsPct: number
): Promise<{ changed: number; failed: { id: number; error: string }[] }> {
  if (tdsPct < 0 || tdsPct > 100) throw new Error('TDS % must be between 0 and 100')
  if (tdsPct > 0 && !String(tdsLedger || '').trim()) throw new Error('Pick the TDS ledger')
  const c = getClient()
  let changed = 0
  const failed: { id: number; error: string }[] = []
  // One at a time: each re-entry is its own transaction, so one refusal
  // (a released margin on another bill, say) leaves the rest done.
  for (const id of ids) {
    const r = (await c.execute({ sql: 'SELECT interest, interest_entry_id FROM bd_repayments WHERE id = ?', args: [id] })).rows[0]
    if (!r || n(r.interest_entry_id)) continue
    const tds = round2((n(r.interest) * tdsPct) / 100)
    try {
      await editBdRepayment(id, { tds_ledger: tds > 0 ? tdsLedger.trim() : null, tds_amount: tds > 0 ? tds : 0 })
      changed++
    } catch (e) {
      failed.push({ id, error: (e as Error).message })
    }
  }
  return { changed, failed }
}
