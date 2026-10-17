// FIFO — MONEY WITH NO AGST REF SETTLES THE OLDEST BILLS FIRST.
//
// Receipts and payments booked from Tally's bank books carry no bill-wise
// allocation, so a party's bills read as unpaid however much it has paid.
// The rule: a receipt or payment (or any line on the party's paying side)
// allocated Agst Ref settles that bill; whatever is NOT allocated is applied
// to the party's open bills oldest first — the opening balance before them.
//
// Worked out fresh on every read and never written to the books: a receipt
// deleted, added or re-dated in between simply moves the FIFO with it.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { baseGroupOf } from './ledgerGroups'

type Row = Record<string, unknown>
const n = (v: unknown): number => Number(v) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100
const up = (v: unknown): string => String(v ?? '').trim().toUpperCase()
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

/** A piece of FIFO money landing on one bill — shaped like an allocation row. */
export type FifoPiece = { amount: number; side: 'dr' | 'cr'; eid: number; vch_type: string; vch_no: string; entry_date: string }

/**
 * For the party ledgers given, every bill voucher (by its entry id) and the
 * FIFO money that settles it. Only money with no Agst Ref is spread; what was
 * allocated to a bill stays where it was put.
 */
export async function fifoSettlement(companyId: number, accountIds: number[]): Promise<Map<number, FifoPiece[]>> {
  const out = new Map<number, FifoPiece[]>()
  const c = getClient()
  const ids = [...new Set(accountIds.filter((x) => x > 0))]
  if (!ids.length) return out
  const accts = toPlain(await c.execute({ sql: `SELECT id, acc_group FROM ledger_accounts WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids }))
  for (const a of accts) {
    const base = await baseGroupOf(a.acc_group)
    const billSide: 'dr' | 'cr' | null = base === 'Sundry Debtors' ? 'dr' : base === 'Sundry Creditors' ? 'cr' : null
    if (!billSide) continue
    const payDr = billSide === 'cr'
    const lines = toPlain(
      await c.execute({
        sql: `SELECT jl.id AS lid, jl.dr, jl.cr, je.id AS eid, je.entry_date, je.vch_type, je.vch_no, je.order_id, je.sale_id,
                     s.invoice_group, s.invoice_no AS sale_no, o.invoice_no AS order_no
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                LEFT JOIN sales s ON s.id = je.sale_id
                LEFT JOIN orders o ON o.id = je.order_id
               WHERE jl.account_id = ? AND je.company_id = ?
               ORDER BY je.entry_date, je.id`,
        args: [n(a.id), companyId]
      })
    )
    if (!lines.length) continue
    const allocs = toPlain(
      await c.execute({
        sql: `SELECT ba.line_id, ba.method, ba.amount, ba.order_id, ba.ref_name, ba.sale_invoice_group
                FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id JOIN journal_entries je ON je.id = jl.entry_id
               WHERE jl.account_id = ? AND je.company_id = ?`,
        args: [n(a.id), companyId]
      })
    )
    const byLine = new Map<number, Row[]>()
    for (const x of allocs) byLine.set(n(x.line_id), [...(byLine.get(n(x.line_id)) || []), x])

    // The bills: every line on the side the party is owed on (or owes us on).
    type Bill = { eid: number; date: string; left: number; refs: Set<string>; order_id: number; group: string }
    const bills: Bill[] = []
    const opening = toPlain(await c.execute({ sql: 'SELECT dr, cr FROM ledger_openings WHERE account_id = ? AND company_id = ?', args: [n(a.id), companyId] }))[0]
    const openAmt = opening ? round2(billSide === 'dr' ? n(opening.dr) - n(opening.cr) : n(opening.cr) - n(opening.dr)) : 0
    // The opening is the oldest bill; a negative one is money already in hand.
    type Pay = { amount: number; eid: number; date: string; vch_type: string; vch_no: string }
    const pool: Pay[] = []
    if (openAmt > 0.004) bills.push({ eid: 0, date: '', left: openAmt, refs: new Set(), order_id: 0, group: '' })
    else if (openAmt < -0.004) pool.push({ amount: -openAmt, eid: 0, date: '', vch_type: 'OPENING', vch_no: '' })
    for (const l of lines) {
      const amt = round2(billSide === 'dr' ? n(l.dr) : n(l.cr))
      if (amt <= 0.004) continue
      const refs = new Set<string>([up(l.vch_no), up(l.sale_no), up(l.order_no), up(l.invoice_group)].filter(Boolean))
      for (const x of byLine.get(n(l.lid)) || []) if (x.ref_name) refs.add(up(x.ref_name))
      bills.push({ eid: n(l.eid), date: String(l.entry_date || ''), left: amt, refs, order_id: n(l.order_id), group: up(l.invoice_group || l.sale_no) })
    }
    // What was paid AGAINST a named bill comes off it first; the rest is the pool.
    for (const l of lines) {
      const amt = round2(payDr ? n(l.dr) : n(l.cr))
      if (amt <= 0.004) continue
      let named = 0
      for (const x of byLine.get(n(l.lid)) || []) {
        if (String(x.method) !== 'agst_ref') continue
        named += n(x.amount)
        const ref = up(x.ref_name)
        const grp = up(x.sale_invoice_group)
        const bill =
          bills.find((b) => n(x.order_id) && b.order_id === n(x.order_id)) ||
          bills.find((b) => grp && b.group === grp) ||
          bills.find((b) => ref && b.refs.has(ref))
        if (bill) bill.left = round2(bill.left - n(x.amount))
      }
      const free = round2(amt - named)
      if (free > 0.004) pool.push({ amount: free, eid: n(l.eid), date: String(l.entry_date || ''), vch_type: String(l.vch_type || ''), vch_no: String(l.vch_no || '') })
    }
    // Oldest bill first, oldest money first.
    bills.sort((x, y) => x.date.localeCompare(y.date) || x.eid - y.eid)
    let pi = 0
    for (const b of bills) {
      while (b.left > 0.004 && pi < pool.length) {
        const p = pool[pi]
        const take = round2(Math.min(b.left, p.amount))
        if (b.eid) {
          out.set(b.eid, [
            ...(out.get(b.eid) || []),
            { amount: take, side: payDr ? 'dr' : 'cr', eid: p.eid, vch_type: p.vch_type, vch_no: p.vch_no, entry_date: p.date }
          ])
        }
        b.left = round2(b.left - take)
        p.amount = round2(p.amount - take)
        if (p.amount <= 0.004) pi++
      }
      if (pi >= pool.length) break
    }
  }
  return out
}
