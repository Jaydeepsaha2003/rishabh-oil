// One-off correction: LC-9's bill was raised for the gross open amount.
//
// WHAT IS WRONG
// -------------
// Every other LC in the book has its bill raised for what the bank actually
// released — the open amount less the interest and commission the bank keeps
// out of the credit. LC-9's bill was raised for the full ₹88,49,000, which is
// ₹1,74,474.58 more, and that ₹1,74,474.58 is exactly the interest plus the
// charges. Of 52 bills, it is the only one billed gross without the "interest
// settled upfront" flag that makes gross correct.
//
// It has two consequences, both already in the ledger (voucher JOURNAL LC-9,
// 29-05-2026):
//   1. ASHOK SHOP's ledger shows them paid ₹1,74,474.58 more than they got.
//   2. The LC draws ₹90,23,474.58 against an ₹88,49,000 facility.
//
// WHAT THIS DOES
// --------------
// Corrects the BILL only, to `open amount − interest − charges`. It does not
// touch a single journal line: the settlement voucher is re-derived from the
// bill by the app's own resyncLcSettlement() when the LC is next saved, and
// letting the app do its own posting is the whole point — a script that
// rewrites vouchers by hand is a script that invents a second source of truth.
//
// So this is a TWO-STEP fix, and the second step is yours:
//   1. node scripts/fix-lc9-bill.mjs        (this script; --apply to write)
//   2. Open Treasury → LC-9 → Save changes  (re-posts the voucher)
//
// SAFETY
// ------
//   * Dry run by default. Nothing is written without --apply.
//   * Guarded: it refuses unless the LC still looks exactly as diagnosed —
//     right party, right amount, not flagged upfront, exactly one bill, and
//     that bill still at the gross figure. If someone has already fixed it by
//     hand, it says so and stops.
//   * Idempotent: run it twice and the second run is a no-op.
//   * Writes the before-state to lc9-bill-before.json first, so the change can
//     be undone by hand from a file rather than from memory.
//   * Reads the same DATABASE_URL the app does, so it acts on whichever
//     database you point it at. CHECK THAT FIRST — it prints which one.
//
// BEFORE YOU RUN IT: confirm against the bank advice for 23-05-2026 what South
// Indian Bank actually credited ASHOK SHOP. If they were paid the full
// ₹88,49,000, the bill is right and this script must not be run — the LC is
// then genuinely over-drawn and that is a conversation with the bank.

import { createClient } from '@libsql/client'
import { writeFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')

const url =
  process.env.MAIN_VITE_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL || ''
const authToken =
  process.env.MAIN_VITE_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || undefined

if (!url) {
  console.error('No database URL. Run with --env-file=.env, e.g.\n')
  console.error('  node --env-file=.env scripts/fix-lc9-bill.mjs\n')
  process.exit(1)
}

const db = createClient(authToken ? { url, authToken } : { url })
const n = (v) => Number(v || 0)
const r2 = (v) => Math.round(v * 100) / 100
const inr = (v) => '₹' + n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

console.log(`\nDatabase : ${url}`)
console.log(`Mode     : ${APPLY ? 'APPLY — this will write' : 'DRY RUN — nothing will be written'}\n`)

const lcRes = await db.execute({
  sql: `SELECT l.id, l.lc_no, l.amount, l.interest_pct, l.usance_days, l.charges,
               l.interest_upfront, s.name AS party
          FROM letters_of_credit l
          LEFT JOIN suppliers s ON s.id = l.party_id
         WHERE l.lc_no = 'LC-9' AND ABS(l.amount - 8849000) < 1`,
  args: []
})

if (lcRes.rows.length !== 1) {
  console.error(`Expected exactly one LC-9 at ₹88,49,000 — found ${lcRes.rows.length}. Stopping.`)
  process.exit(1)
}

const lc = lcRes.rows[0]
const interest = r2((n(lc.amount) * n(lc.interest_pct) * n(lc.usance_days)) / 36500)
const charges = r2(n(lc.charges))
const correct = r2(n(lc.amount) - interest - charges)

console.log(`LC       : ${lc.lc_no}  (id ${lc.id})   party ${lc.party}`)
console.log(`Open     : ${inr(lc.amount)}`)
console.log(`Interest : ${inr(interest)}   (${lc.interest_pct}% × ${lc.usance_days}d ÷ 365)`)
console.log(`Charges  : ${inr(charges)}`)
console.log(`Correct  : ${inr(correct)}\n`)

if (n(lc.interest_upfront) === 1) {
  console.error('This LC is flagged "interest settled upfront" — a gross bill is CORRECT for it. Stopping.')
  process.exit(1)
}

const bills = (
  await db.execute({
    sql: 'SELECT id, amount, bill_no, status, journal_entry_id FROM lc_issuances WHERE lc_id = ?',
    args: [lc.id]
  })
).rows

if (bills.length !== 1) {
  console.error(`Expected exactly one bill on this LC — found ${bills.length}. Stopping, this needs a human.`)
  process.exit(1)
}

const bill = bills[0]
console.log(`Bill     : id ${bill.id}   ${inr(bill.amount)}   status ${bill.status}   voucher ${bill.journal_entry_id}`)

if (Math.abs(n(bill.amount) - correct) < 0.005) {
  console.log('\nAlready correct. Nothing to do.')
  process.exit(0)
}

if (Math.abs(n(bill.amount) - n(lc.amount)) > 0.005) {
  console.error(
    `\nThe bill is neither the gross amount nor the correct net — it is ${inr(bill.amount)}.\n` +
      'That is not the fault this script was written for. Stopping.'
  )
  process.exit(1)
}

console.log(`\nWould change the bill: ${inr(bill.amount)}  ->  ${inr(correct)}   (${inr(n(bill.amount) - correct)} off)`)

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write it.\n')
  process.exit(0)
}

writeFileSync(
  'lc9-bill-before.json',
  JSON.stringify({ savedAt: new Date().toISOString(), lc, bill, correctedTo: correct }, null, 2)
)
console.log('\nBefore-state written to lc9-bill-before.json')

await db.execute({ sql: 'UPDATE lc_issuances SET amount = ? WHERE id = ?', args: [correct, bill.id] })

const after = (await db.execute({ sql: 'SELECT amount FROM lc_issuances WHERE id = ?', args: [bill.id] })).rows[0]
console.log(`Bill updated. It now reads ${inr(after.amount)}.`)

console.log(
  '\nNOT DONE YET — the ledger still carries the old figure.\n' +
    '  Open Treasury -> LC-9 -> Save changes.\n' +
    "  That runs the app's own resyncLcSettlement(), which rewrites the maturity\n" +
    '  voucher from the corrected bill: ASHOK SHOP debited ' +
    inr(correct) +
    ',\n  interest and charges unchanged, LC PAYABLE credited ' +
    inr(n(lc.amount)) +
    ' instead of\n  ' +
    inr(n(lc.amount) + interest + charges) +
    '. The LC then sits inside its facility again.\n'
)
