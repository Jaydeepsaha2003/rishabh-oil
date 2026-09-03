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
  const adj = n(lc?.interest_adj)
  // Neither option in play: the amount itself, untouched and unrounded. This
  // is every LC already on the books, and it must keep the exact figure it was
  // posted with — rounding it "harmlessly" here would move the interest on any
  // credit whose amount carries more than two decimals.
  if (!lc?.interest_excl_charges && !adj) return amount
  const gross = lc?.interest_excl_charges ? round2(amount - n(lc?.charges)) : amount
  // Then the bank's own arithmetic, which is not always the credit's.
  //
  // A bank charges interest on what its advice says it lent, and that figure
  // can differ from the amount the credit was opened at — a part-cancellation,
  // a rounding of its own, a correction on the statement. `interest_adj` is
  // that difference, signed and entered by hand: an open amount of 100 with an
  // adjustment of -2 accrues interest on 98.
  //
  // It moves the INTEREST BASE. The open amount is still what the bank
  // sanctioned, so the margin, the facility limit and the exposure outstanding
  // are all untouched — the adjustment states what interest was struck on, not
  // what the credit is worth.
  //
  // What does follow is the interest and the vouchers carrying it, and that
  // includes an AUTO-RAISED bill: less interest means the bank released more,
  // and resizeAutoLcBill sizes that bill at what was actually released. A bill
  // entered by hand — one with its own number, or linked to an invoice — is
  // left exactly as recorded.
  //
  // Nil by default, so every LC already on the books keeps the figure it was
  // posted with.
  const adjusted = round2(gross + adj)
  // A base below nil would post negative interest, which no arrangement means.
  return Math.max(0, adjusted)
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
  const base = lc?.interest_excl_charges ? 'open amount less bank charges' : 'open amount'
  const adj = round2(n(lc?.interest_adj))
  if (Math.abs(adj) < 0.005) return base
  return `${base} ${adj < 0 ? 'less' : 'plus'} an adjustment of ${Math.abs(adj).toFixed(2)}`
}

// Whether the base is anything other than the plain open amount — the test for
// whether a voucher's narration owes the reader an explanation of what the
// interest was struck on. Reading the exclude-charges flag alone left an
// adjusted LC's voucher silent about a base its reader could not derive.
export function lcInterestBaseIsCustom(lc: Row): boolean {
  return !!lc?.interest_excl_charges || Math.abs(n(lc?.interest_adj)) >= 0.005
}
