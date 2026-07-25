import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// Tally-style Daybook: every entry pertaining to a day (or date range) for the
// active company — sale, purchase, receipt/payment, journal / Dr-Cr note, and
// material in/out at the gate. Financial rows come from the double-entry journal
// (the authoritative record); material rows come from gate entries.
export async function daybook(from: string, to: string): Promise<{ vouchers: Row[]; material: Row[] }> {
  const c = getClient()
  const cid = getActiveCompanyId()

  const vres = await c.execute({
    sql: `
      SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration,
             je.order_id, je.sale_id, je.payment_id,
             COALESCE((SELECT SUM(dr) FROM journal_lines WHERE entry_id = je.id), 0) AS amount,
             (SELECT GROUP_CONCAT(a.name, ' + ') FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id AND jl.dr > 0) AS dr_accounts,
             (SELECT GROUP_CONCAT(a.name, ' + ') FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id AND jl.cr > 0) AS cr_accounts
      FROM journal_entries je
      WHERE je.company_id = ? AND substr(je.entry_date, 1, 10) >= ? AND substr(je.entry_date, 1, 10) <= ?
      ORDER BY je.entry_date ASC, je.id ASC`,
    args: [cid, from, to]
  })

  const mres = await c.execute({
    sql: `
      SELECT g.id, g.entry_date, g.direction, g.rec_type, g.gate_entry_no, g.ref_no, g.tanker_no, g.uom,
             CASE WHEN g.direction = 'out' THEN g.dispatch_qty ELSE g.received_qty END AS qty,
             g.status,
             COALESCE(sup.name, (SELECT customer FROM sales WHERE invoice_group = g.invoice_group LIMIT 1), sl.customer) AS party,
             COALESCE(b.bargain_no, (SELECT invoice_no FROM sales WHERE invoice_group = g.invoice_group LIMIT 1)) AS ref_doc
      FROM gate_entries g
      LEFT JOIN purchase_tankers pt ON pt.id = g.tanker_id
      LEFT JOIN bargains b ON b.id = pt.bargain_id
      LEFT JOIN suppliers sup ON sup.id = pt.supplier_id
      LEFT JOIN sales sl ON sl.id = g.sale_id
      WHERE substr(g.entry_date, 1, 10) >= ? AND substr(g.entry_date, 1, 10) <= ?
      ORDER BY g.entry_date ASC, g.id ASC`,
    args: [from, to]
  })

  return { vouchers: toPlain(vres), material: toPlain(mres) }
}
