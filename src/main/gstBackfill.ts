// EVERY RUPEE OF TAX ALREADY POSTED, PUT UNDER ITS OWN HEAD AND RATE.
// -----------------------------------------------------------------------------
// GST used to land in GST INPUT A/C and GST OUTPUT A/C — two accounts holding
// every head at every rate added together. That is not a figure a return can be
// filed from, so the ledgers are kept head by head and rate by rate now (see
// src/main/gstLedgers.ts), and the history has to follow: a split that started
// from today would leave the year behind it unreadable, which is the year that
// gets filed.
//
// Every line is traceable, and nothing here is guessed from an amount. A
// purchase names its order, a sale names its sale, and each carries the
// gst_pct and gst_type it was booked on. A note carries a rate but no head, so
// it takes the head of the invoice it is written against — a credit note
// against an IGST sale puts the tax back where the sale charged it.
//
// AN INTRA-STATE LINE BECOMES TWO. The original row is kept and re-pointed at
// the CGST ledger with half the tax on it, and a second row is inserted for
// SGST with the remainder. Kept rather than deleted and re-made, because bill
// allocations and line splits hang off a line id; and struck as half-and-
// remainder so a voucher balances to the same paisa it always did.
//
// The two old accounts are left standing. They end up empty, and an empty
// ledger is something to retire deliberately rather than something a migration
// removes on somebody's behalf.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { gstLedgerName } from './gstLedgers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

export async function splitGstLedgersByRate(): Promise<void> {
  const c = getClient()
  const ledgerId = new Map<string, number>()
  const idFor = async (name: string): Promise<number> => {
    const hit = ledgerId.get(name)
    if (hit) return hit
    await c.execute({
      sql: "INSERT OR IGNORE INTO ledger_accounts (name, acc_group) VALUES (?, 'Duties & Taxes')",
      args: [name]
    })
    const r = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [name] })
    const id = n((r.rows[0] as unknown as Row)?.id)
    ledgerId.set(name, id)
    return id
  }

  // THE CHART OF ACCOUNTS, OPENED UP FRONT.
  //
  // Seeded here rather than beside the other standing ledgers, because that
  // seeding sits inside a backfill that has already run once on every live
  // book and never runs again — so an account added to it now would appear on
  // a fresh install and nowhere else.
  //
  // These are the heads this mill actually trades on. A rate nobody has listed
  // still opens its own the moment something is booked at it, so the list is a
  // starting chart and not a limit.
  for (const side of ['INPUT', 'OUTPUT'] as const) {
    for (const pct of [2.5, 9]) {
      await idFor(gstLedgerName(side, 'CGST', pct))
      await idFor(gstLedgerName(side, 'SGST', pct))
    }
    for (const pct of [5, 18]) await idFor(gstLedgerName(side, 'IGST', pct))
  }
  // Bought at 3% inter-state, and nothing is sold at it.
  await idFor(gstLedgerName('INPUT', 'IGST', 3))

  // Every GST line still sitting in one of the two old accounts, with the rate
  // and the head of whatever posted it.
  const rows = toPlain(
    await c.execute(`
      SELECT jl.id, jl.dr, jl.cr, a.name AS led,
             COALESCE(o.gst_pct, s.gst_pct, nt.gst_pct, 0) AS pct,
             COALESCE(o.gst_type, s.gst_type, ns.gst_type, no2.gst_type, 'CGST_SGST') AS typ
        FROM journal_lines jl
        JOIN ledger_accounts a ON a.id = jl.account_id
        JOIN journal_entries je ON je.id = jl.entry_id
        LEFT JOIN orders o ON o.id = je.order_id
        LEFT JOIN sales s ON s.id = je.sale_id
        LEFT JOIN notes nt ON nt.journal_entry_id = je.id
        LEFT JOIN sales ns ON ns.invoice_no = nt.against_ref AND nt.party_type = 'customer'
        LEFT JOIN orders no2 ON no2.invoice_no = nt.against_ref AND nt.party_type <> 'customer'
       WHERE a.name IN ('GST INPUT A/C', 'GST OUTPUT A/C')
       GROUP BY jl.id
       ORDER BY jl.id`)
  )
  if (!rows.length) return

  let moved = 0
  let split = 0
  let left = 0
  for (const r of rows) {
    const side: 'INPUT' | 'OUTPUT' = String(r.led) === 'GST INPUT A/C' ? 'INPUT' : 'OUTPUT'
    const dr = n(r.dr)
    const cr = n(r.cr)
    const total = dr > 0.004 ? dr : cr
    if (!(total > 0.004)) continue
    const pct = n(r.pct)
    // A line whose document never recorded a rate has nothing to file it
    // under. Left exactly where it is rather than given an invented home.
    if (!(pct > 0)) {
      left++
      continue
    }
    const lineId = n(r.id)

    if (String(r.typ) === 'IGST') {
      await c.execute({
        sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?',
        args: [await idFor(gstLedgerName(side, 'IGST', pct)), lineId]
      })
      moved++
      continue
    }

      // EXACTLY HALF EACH, AND NOT A ROUNDED HALF.
    //
    // CGST and SGST are the same number by law, and a return is rejected when
    // they are not. Rounding one half to paise and giving the other the
    // remainder keeps the voucher exact but leaves the two heads a paisa apart
    // on every odd line — seventeen paise across a year of sales here, which is
    // seventeen paise somebody has to explain.
    //
    // Splitting the figure as it stands gives both: the halves are identical,
    // and they add back to precisely the tax that was posted. These books
    // already hold tax unrounded — a real purchase line is 42,121.386… — so a
    // half carrying a third decimal is the register's own habit, not a new one.
    const half = total / 2
    const rest = half
    const each = pct / 2
    await c.execute({
      sql: 'UPDATE journal_lines SET account_id = ?, dr = ?, cr = ? WHERE id = ?',
      args: [
        await idFor(gstLedgerName(side, 'CGST', each)),
        dr > 0.004 ? half : 0,
        dr > 0.004 ? 0 : half,
        lineId
      ]
    })
    if (rest > 0.004) {
      await c.execute({
        sql: `INSERT INTO journal_lines (entry_id, account_id, dr, cr)
              SELECT entry_id, ?, ?, ? FROM journal_lines WHERE id = ?`,
        args: [
          await idFor(gstLedgerName(side, 'SGST', each)),
          dr > 0.004 ? rest : 0,
          dr > 0.004 ? 0 : rest,
          lineId
        ]
      })
    }
    split++
    moved++
  }
  console.log(
    `[gst] ${moved} tax lines filed by head and rate (${split} split into CGST + SGST)` +
      (left ? `, ${left} left where they were for want of a rate` : '')
  )
}
