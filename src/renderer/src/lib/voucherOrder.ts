// The order a voucher's lines are read in, wherever they are shown.
//
// Every debit first, then every credit — and within each side the biggest
// figure first, so the line the voucher is about (the goods, the party, the
// bank) leads and the small legs follow. The taxes land at the foot of their
// side on their own, being the smaller figures; where two lines are the same
// amount a tax still comes after a non-tax (GST before TDS/TCS), and otherwise
// the order it was written in holds (the sort is stable).
export const GST_NAME = /\b[CSIU]?GST\b/i
export const TAX_NAME = /\b[CSIU]?GST\b|\bTDS\b|\bTCS\b/i

const PARTY_OR_MONEY = ['Sundry Creditors', 'Sundry Debtors', 'Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']

export function orderVoucherLines<T>(
  lines: T[],
  pick: (l: T) => { account: string; dr: boolean; tax: boolean; amount: number }
): T[] {
  const taxRank = (p: { account: string; tax: boolean }): number => (!p.tax ? 0 : GST_NAME.test(p.account) ? 1 : 2)
  return [...lines].sort((a, b) => {
    const pa = pick(a)
    const pb = pick(b)
    if (pa.dr !== pb.dr) return pa.dr ? -1 : 1
    const byAmount = Math.abs(Number(pb.amount) || 0) - Math.abs(Number(pa.amount) || 0)
    if (Math.abs(byAmount) > 0.004) return byAmount
    return taxRank(pa) - taxRank(pb)
  })
}

/** A line is a tax when its ledger sits under Duties & Taxes, or is named like
 * one outside it (a TDS RECEIVABLE kept under Loans & Advances). A party or a
 * bank is never one, whatever its name says. */
export function isTaxByGroup(account: string, group: string): boolean {
  if (group === 'Duties & Taxes') return true
  if (PARTY_OR_MONEY.includes(group)) return false
  return TAX_NAME.test(account)
}
