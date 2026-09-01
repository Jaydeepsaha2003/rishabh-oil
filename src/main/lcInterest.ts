// The one place an LC's interest is worked out.
//
// The formula lived in five copies — lc.ts twice, treasury.ts twice and
// bankRecon.ts once — all reading `amount` directly. Five copies of an
// arithmetic rule is fine until the rule gains an option, at which point four
// of them quietly keep the old answer and the ledger disagrees with the
// register. So it lives here now, and every caller asks this.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

// What the bank charges interest ON.
//
// Normally the whole open amount: the bank funds the credit in full and takes
// its commission on top, so the commission does not reduce what it has lent.
//
// Under some arrangements the commission is deducted from the credit before it
// is funded, and interest then runs only on what was actually advanced — on a
// ₹1,64,00,000 credit with ₹3,360 of commission, on ₹1,63,96,640. The
// difference is small per LC and wrong in the accounts every time if the base
// cannot be stated: at 6.55% over 84 days it is ₹50.65.
//
// Off by default, so every LC already on the books keeps the figure it was
// posted with. Nothing recalculates until somebody edits an LC and says so.
export function lcInterestBase(lc: Row): number {
  const amount = n(lc?.amount)
  if (!lc?.interest_excl_charges) return amount
  // A commission larger than the credit is not a real arrangement, but a
  // negative base would post negative interest — so the floor is nil.
  return round2(Math.max(0, amount - n(lc?.charges)))
}

// Interest for the full usance, at the LC's own rate.
//
// Simple interest on a 365-day year, which is what the bank's own advice uses
// — not compounded, and not 360.
export function lcInterest(lc: Row): number {
  return round2((lcInterestBase(lc) * n(lc?.interest_pct) * n(lc?.usance_days)) / (100 * 365))
}

// Interest for a given number of days rather than the whole usance — used when
// an LC is wound up early and the unexpired days come back as a rebate.
export function lcInterestForDays(lc: Row, days: number): number {
  return round2((lcInterestBase(lc) * n(lc?.interest_pct) * n(days)) / (100 * 365))
}

// A one-line description of the base, for a narration or a hover. The reader of
// a voucher should not have to open the LC to know what the interest was struck
// on.
export function lcInterestBasis(lc: Row): string {
  return lc?.interest_excl_charges ? 'open amount less bank charges' : 'open amount'
}
