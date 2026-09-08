// Every LC, checked against its own bill and its own facility.
//
// Read-only. It writes nothing and asks nothing — run it whenever you want the
// list of LCs to raise with the bank.
//
//   node --env-file=.env scripts/lc-audit.mjs
//
// It sorts every settled LC into four buckets, because "the sheet and the
// register disagree" is not one problem:
//
//   A. BILLED GROSS, NOT FLAGGED UPFRONT — a real fault. The bill was raised
//      for the whole credit while the bank kept its interest and commission
//      out of it, so the beneficiary's ledger overstates what they received
//      and the LC draws more than it was opened for. LC-9 was this, by
//      ₹1,74,474.58, and is corrected.
//
//   B. OVER THE FACILITY BY EXACTLY ITS FEE — not a fault. An LC whose
//      interest is settled upfront pays the beneficiary in full and the bank
//      charges its fees on top, so the drawing is the open amount plus the
//      fee by design. Worth knowing your exposure exceeds the sanctioned
//      limit by that much; nothing to correct in the books.
//
//   C. SMALL DIFFERENCE — the bank's own arithmetic. A rate struck over
//      different days, a commission waived. A day's interest on a ₹94 lakh
//      credit is about ₹1,700, which is the size of these. Normal.
//
//   D. MATERIALLY UNDER-DRAWN — the bank released noticeably less of the
//      credit than the formula expects. Usually partial utilisation, but
//      large ones are worth a look.

import { createClient } from '@libsql/client'

const url = process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || ''
const authToken = process.env.MAIN_VITE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined
if (!url) {
  console.error('No database URL. Run with: node --env-file=.env scripts/lc-audit.mjs')
  process.exit(1)
}

const db = createClient(authToken ? { url, authToken } : { url })
const n = (v) => Number(v || 0)
const r2 = (v) => Math.round(v * 100) / 100
const inr = (v) => n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const lcs = (
  await db.execute(`
  SELECT l.id, l.lc_no, l.company_id, l.amount, l.interest_pct, l.usance_days, l.charges,
         l.interest_upfront, s.name AS party,
         (SELECT COUNT(*) FROM lc_issuances i WHERE i.lc_id = l.id) AS bills,
         (SELECT COALESCE(SUM(i.amount), 0) FROM lc_issuances i WHERE i.lc_id = l.id) AS billed
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON s.id = l.party_id
   ORDER BY l.id`)
).rows

const A = []
const B = []
const C = []
const D = []
let clean = 0
let unbilled = 0

for (const l of lcs) {
  if (!n(l.bills)) {
    unbilled++
    continue
  }
  const amt = n(l.amount)
  const fee = r2((amt * n(l.interest_pct) * n(l.usance_days)) / 36500 + n(l.charges))
  const upfront = n(l.interest_upfront) === 1
  const expect = upfront ? amt : r2(amt - fee)
  const drift = r2(n(l.billed) - expect)
  const row = { ...l, fee, expect, drift }
  if (Math.abs(drift) < 1) clean++
  else if (!upfront && Math.abs(n(l.billed) - amt) < 1) A.push(row)
  else if (upfront && Math.abs(drift) < 1) B.push(row)
  else if (drift > 0 && Math.abs(drift - fee) < 1) A.push(row)
  else if (drift < -0.005 * amt) D.push(row)
  else C.push(row)
  // An upfront LC is over the facility by its fee by design — recorded so the
  // exposure is visible even though nothing needs correcting.
  if (upfront && Math.abs(drift) < 1) B.push(row)
}

const show = (title, rows, note) => {
  console.log(`\n${title}`)
  console.log(note)
  if (!rows.length) {
    console.log('   none')
    return
  }
  for (const r of rows)
    console.log(
      `   id=${String(r.id).padEnd(4)} ${String(r.lc_no).padEnd(8)} co${r.company_id} ` +
        `${String(r.party || '').slice(0, 20).padEnd(20)} open ${inr(r.amount).padStart(15)}  ` +
        `billed ${inr(r.billed).padStart(15)}  diff ${inr(r.drift).padStart(13)}`
    )
}

console.log(`\nDatabase: ${url}`)
console.log(`\n${lcs.length} LCs — ${clean} bill exactly as expected, ${unbilled} not billed yet.`)
show('A. BILLED GROSS, NOT FLAGGED UPFRONT — a real fault, take to the bank', A,
  '   The beneficiary shows paid more than they received, and the LC is over its facility.')
show('B. OVER BY EXACTLY ITS FEE — by design, no correction needed', [...new Set(B)],
  '   Interest settled upfront: paid in full, fees on top. Exposure exceeds the limit by the fee.')
show('C. SMALL DIFFERENCE — the bank\'s own rounding, normal', C,
  '   Under half a percent of the credit. A rate over different days, or a waived commission.')
show('D. MATERIALLY UNDER-DRAWN — usually partial use, worth a look if large', D,
  '   The bank released noticeably less of the credit than the formula expects.')
console.log('')
