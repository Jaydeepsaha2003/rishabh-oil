import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
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

// UNDO OF THE RE-POST, after review.
//
// The repayments the re-post (or an edit) turned from the old shape into the
// interest journal: their payment voucher's log entry shows the rows as they
// were, with interest and no interest journal. Undone, the payment goes back
// to the old shape in place — the interest leaves the bill discounter's line
// and returns as Dr INTEREST ON BILL DISCOUNTING on the payment, the interest
// journal is removed, and the TDS on it with it. The payment keeps its id,
// number, date and bank total; each is logged before it changes.
export async function previewBdInterestUndo(): Promise<Row> {
  const c = getClient()
  const logs = await c
    .execute("SELECT entry_id, before_json FROM accounting_repair_log WHERE repair_key LIKE 'bd_repayment_edit:%' ORDER BY created_at, rowid")
    .catch(() => null)
  // The last edit of each payment decides: an edit made after the re-post
  // would make that log's "before" no longer what the voucher was.
  const lastBefore = new Map<number, Row[]>()
  for (const l of (logs?.rows || []) as unknown as Row[]) {
    try {
      lastBefore.set(n(l.entry_id), (JSON.parse(String(l.before_json)).siblings || []) as Row[])
    } catch {
      // a log that does not parse is not one of ours
    }
  }
  const res = await c.execute(`
    SELECT r.id, r.journal_entry_id, r.interest_entry_id, r.repay_date, r.interest, r.tds_ledger, r.tds_amount,
           b.bd_no, nb.name AS nbfc, co.name AS company, je.vch_no
      FROM bd_repayments r
      JOIN bill_discountings b ON b.id = r.bd_id
      LEFT JOIN nbfcs nb ON nb.id = b.nbfc_id
      LEFT JOIN companies co ON co.id = b.company_id
      LEFT JOIN journal_entries je ON je.id = r.journal_entry_id
     WHERE r.interest_entry_id IS NOT NULL AND r.journal_entry_id IS NOT NULL
     ORDER BY r.repay_date, r.id`)
  const findings = (res.rows as unknown as Row[])
    .filter((r) => {
      const before = lastBefore.get(n(r.journal_entry_id))
      return !!before && before.some((s) => n(s.interest) > 0.004) && before.every((s) => !n(s.interest_entry_id))
    })
    .map((r) => ({
      id: n(r.id),
      entry_id: n(r.journal_entry_id),
      bd_no: String(r.bd_no || ''),
      nbfc: String(r.nbfc || ''),
      company: String(r.company || ''),
      date: String(r.repay_date || '').slice(0, 10),
      vch_no: String(r.vch_no || ''),
      interest: round2(n(r.interest)),
      tds_ledger: String(r.tds_ledger || ''),
      tds: round2(n(r.tds_amount))
    }))
  return { findings, total: round2(findings.reduce((t, f) => t + f.interest, 0)) }
}

export async function undoBdInterestJournals(entryIds: number[]): Promise<{ changed: number; failed: { id: number; error: string }[] }> {
  const want = new Set(entryIds.map(n).filter(Boolean))
  const list = ((await previewBdInterestUndo()).findings as Row[]).filter((f) => want.has(n(f.entry_id)))
  let changed = 0
  const failed: { id: number; error: string }[] = []
  for (const f of list) {
    try {
      await withDbTransaction(async () => {
        const c = getClient()
        const payJe = n(f.entry_id)
        const rows = (await c.execute({ sql: 'SELECT * FROM bd_repayments WHERE journal_entry_id = ?', args: [payJe] })).rows as unknown as Row[]
        const intJe = n(rows.find((r) => n(r.interest_entry_id))?.interest_entry_id)
        const intLines = (await c.execute({ sql: 'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id', args: [intJe] })).rows as unknown as Row[]
        // Dr interest ledger, Cr the bill discounter (interest less TDS), Cr TDS.
        const drLine = intLines.find((l) => n(l.dr) > 0.004)
        if (!drLine || intLines.filter((l) => n(l.dr) > 0.004).length !== 1) throw new Error(`${f.bd_no}: its interest journal has been changed — undo it by hand`)
        const interest = round2(n(drLine.dr))
        const payLines = (await c.execute({ sql: 'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id', args: [payJe] })).rows as unknown as Row[]
        const crAccounts = new Set(intLines.filter((l) => n(l.cr) > 0.004).map((l) => n(l.account_id)))
        const payable = payLines
          .filter((l) => crAccounts.has(n(l.account_id)) && n(l.dr) >= interest - 0.004)
          .sort((a, b) => n(b.dr) - n(a.dr))[0]
        if (!payable) throw new Error(`${f.bd_no}: the bill discounter's line is not on the payment — undo it by hand`)
        await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
            repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
        await c.execute({
          sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
          args: [`bd_interest_undo:${payJe}:${Date.now()}`, payJe, JSON.stringify({ rows, payLines, intLines })]
        })
        const newDr = round2(n(payable.dr) - interest)
        await c.execute({ sql: 'UPDATE journal_lines SET dr = ? WHERE id = ?', args: [newDr, n(payable.id)] })
        // A single allocation for the whole line follows it.
        await c.execute({ sql: 'UPDATE journal_bill_allocs SET amount = ? WHERE line_id = ? AND ABS(amount - ?) < 0.01', args: [newDr, n(payable.id), n(payable.dr)] })
        await c.execute({ sql: 'INSERT INTO journal_lines (entry_id, account_id, dr, cr) VALUES (?, ?, ?, 0)', args: [payJe, n(drLine.account_id), interest] })
        await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [intJe] })
        await c.execute({ sql: 'DELETE FROM journal_line_splits WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [intJe] }).catch(() => undefined)
        await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [intJe] })
        await c.execute({ sql: 'DELETE FROM voucher_numbers WHERE entry_id = ?', args: [intJe] }).catch(() => undefined)
        await c.execute({ sql: 'DELETE FROM tally_links WHERE entry_id = ?', args: [intJe] }).catch(() => undefined)
        await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [intJe] })
        await c.execute({
          sql: 'UPDATE bd_repayments SET interest_entry_id = NULL, tds_ledger = NULL, tds_amount = NULL WHERE journal_entry_id = ?',
          args: [payJe]
        })
        const bal = (await c.execute({ sql: 'SELECT ROUND(SUM(dr), 2) AS dr, ROUND(SUM(cr), 2) AS cr FROM journal_lines WHERE entry_id = ?', args: [payJe] })).rows[0] as unknown as Row
        if (Math.abs(n(bal.dr) - n(bal.cr)) > 0.01) throw new Error(`${f.bd_no}: the payment would not balance — left as it was`)
      })
      changed++
    } catch (e) {
      failed.push({ id: n(f.entry_id), error: (e as Error).message })
    }
  }
  return { changed, failed }
}
