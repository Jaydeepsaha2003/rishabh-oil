// PAID THE BANK MORE THAN WAS OWED — THE BANK WILL GIVE IT BACK.
//
// A repayment of 102 against a balance of 100: the 2 is neither principal nor a
// charge. It is money the bank owes us until it refunds it, so it is booked to
// a receivable per lender — REFUND DUE - <bank or NBFC> (Loans & Advances) —
// and cleared when the refund comes in (bankRefunds.ts).
//
// On the repayment forms it is one more row among the charges, picked with
// "Excess — bank will refund"; the server turns the token into that lender's
// ledger.

export const REFUND_DUE_TOKEN = 'REFUND DUE FROM BANK'
export const REFUND_DUE_GROUP = 'Loans & Advances (Asset)'

export function refundLedgerFor(lender: string): string {
  const name = String(lender || '').trim().replace(/\s+/g, ' ').toUpperCase()
  return name ? `REFUND DUE - ${name}` : 'REFUND DUE - BANK'
}

/** The token on a form, or a lender's refund ledger itself. */
export function isRefundDue(account: string): boolean {
  const a = String(account || '').trim().toUpperCase()
  return a === REFUND_DUE_TOKEN || a.startsWith('REFUND DUE - ')
}
