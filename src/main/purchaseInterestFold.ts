import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

// A SUPPLIER'S INTEREST IS PART OF WHAT THE OIL COST.
//
// The interest a supplier adds to the invoice (credit-period interest built
// into the rate) was posted on its own line, Dr INTEREST A/C, beside the
// purchase account — so the oil read cheaper than the bill and an expense
// appeared that is really part of the purchase. From 2026-10-23 a purchase
// posts it inside {OIL} PUR A/C (postPurchaseJournal). The vouchers posted
// before that are found here and corrected in place, after review: the
// interest line's amount goes onto the voucher's purchase line and the
// interest line is removed — the voucher keeps its id, number, date and total,
// and each is archived in accounting_repair_log first. INTEREST A/C's other
// postings (LC and bill-discounting interest) are not touched.

async function findings(companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId ?? null
  const res = await c.execute({
    sql: `SELECT je.id AS entry_id, je.company_id, je.entry_date, je.vch_no, je.order_id,
                 (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code,
                 co.name AS company, o.invoice_no, s.name AS supplier,
                 jl.id AS interest_line_id, jl.dr AS interest,
                 (SELECT pl.id FROM journal_lines pl JOIN ledger_accounts pa ON pa.id = pl.account_id
                   WHERE pl.entry_id = je.id AND pa.acc_group = 'Purchase Accounts' AND pl.dr > 0 ORDER BY pl.dr DESC LIMIT 1) AS purchase_line_id,
                 (SELECT pa.name FROM journal_lines pl JOIN ledger_accounts pa ON pa.id = pl.account_id
                   WHERE pl.entry_id = je.id AND pa.acc_group = 'Purchase Accounts' AND pl.dr > 0 ORDER BY pl.dr DESC LIMIT 1) AS purchase_account,
                 (SELECT pl.dr FROM journal_lines pl JOIN ledger_accounts pa ON pa.id = pl.account_id
                   WHERE pl.entry_id = je.id AND pa.acc_group = 'Purchase Accounts' AND pl.dr > 0 ORDER BY pl.dr DESC LIMIT 1) AS purchase_before,
                 (SELECT COUNT(*) FROM journal_lines pl JOIN ledger_accounts pa ON pa.id = pl.account_id
                   WHERE pl.entry_id = je.id AND pa.acc_group = 'Purchase Accounts' AND pl.dr > 0) AS purchase_lines
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN ledger_accounts la ON la.id = jl.account_id
            LEFT JOIN orders o ON o.id = je.order_id
            LEFT JOIN suppliers s ON s.id = o.supplier_id
            LEFT JOIN companies co ON co.id = je.company_id
           WHERE la.name = 'INTEREST A/C' AND jl.dr > 0 AND jl.cr = 0
             AND je.order_id IS NOT NULL AND UPPER(je.vch_type) LIKE 'PURCHASE%'
             ${cid ? 'AND je.company_id = ?' : ''}
           ORDER BY je.company_id, je.entry_date, je.id`,
    args: cid ? [cid] : []
  })
  return res.rows.map((r) => {
    const x = { ...(r as unknown as Row) }
    const interest = round2(n(x.interest))
    return {
      key: `${n(x.entry_id)}:${n(x.interest_line_id)}`,
      entry_id: n(x.entry_id),
      code: String(x.code || x.vch_no || ''),
      date: String(x.entry_date || '').slice(0, 10),
      company: String(x.company || ''),
      invoice_no: String(x.invoice_no || x.vch_no || ''),
      supplier: String(x.supplier || ''),
      interest,
      purchase_account: String(x.purchase_account || ''),
      purchase_before: round2(n(x.purchase_before)),
      purchase_after: round2(n(x.purchase_before) + interest),
      // No purchase line to put it on — left for a look rather than guessed at.
      review: x.purchase_line_id ? null : 'No purchase account line on this voucher — open it and re-save the purchase'
    }
  })
}

/** Purchase vouchers that still post the supplier's interest to INTEREST A/C. */
export async function previewPurchaseInterest(): Promise<Row> {
  const f = await findings()
  return { findings: f, total: round2(f.reduce((t, x) => t + n(x.interest), 0)), company_id: getActiveCompanyId() }
}

/** Fold the ticked vouchers' interest into their purchase line. */
export async function foldPurchaseInterest(entryIds: number[]): Promise<{ changed: number }> {
  const want = new Set(entryIds.map(n).filter(Boolean))
  const list = (await findings()).filter((x) => want.has(n(x.entry_id)) && !x.review)
  let changed = 0
  for (const x of list) {
    await withDbTransaction(async () => {
      // The transaction's own handle.
      const c = getClient()
      const lines = await c.execute({ sql: 'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id', args: [x.entry_id] })
      const before = lines.rows.map((r) => ({ ...(r as unknown as Row) }))
      const interestLine = before.find((l) => `${x.entry_id}:${n(l.id)}` === x.key)
      if (!interestLine) return
      const purchase = await c.execute({
        sql: `SELECT pl.id, pl.dr FROM journal_lines pl JOIN ledger_accounts pa ON pa.id = pl.account_id
               WHERE pl.entry_id = ? AND pa.acc_group = 'Purchase Accounts' AND pl.dr > 0 ORDER BY pl.dr DESC LIMIT 1`,
        args: [x.entry_id]
      })
      const p = purchase.rows[0] as unknown as Row | undefined
      if (!p) return
      await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
          repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`purchase_interest_fold:${x.entry_id}:${Date.now()}`, x.entry_id, JSON.stringify(before)]
      })
      const amt = round2(n(interestLine.dr))
      await c.execute({ sql: 'UPDATE journal_lines SET dr = ? WHERE id = ?', args: [round2(n(p.dr) + amt), n(p.id)] })
      await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id = ?', args: [n(interestLine.id)] })
      await c.execute({ sql: 'DELETE FROM journal_line_splits WHERE line_id = ?', args: [n(interestLine.id)] }).catch(() => undefined)
      await c.execute({ sql: 'DELETE FROM journal_lines WHERE id = ?', args: [n(interestLine.id)] })
      const bal = await c.execute({ sql: 'SELECT ROUND(SUM(dr), 2) AS dr, ROUND(SUM(cr), 2) AS cr FROM journal_lines WHERE entry_id = ?', args: [x.entry_id] })
      const b = bal.rows[0] as unknown as Row
      if (Math.abs(n(b.dr) - n(b.cr)) > 0.01) throw new Error(`${x.invoice_no}: the voucher would not balance — left as it was`)
      changed++
    })
  }
  return { changed }
}
