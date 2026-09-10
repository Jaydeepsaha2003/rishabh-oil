// How TDS is struck when the party carries a yearly slab.
// -----------------------------------------------------------------------------
// Withholding is not a flat percentage of an invoice. Each party has a
// threshold for the financial year, and where an invoice falls against that
// threshold decides the rate: the part still inside the slab is charged at the
// base rate — nil, when the master says "no TDS below the slab" — and only the
// part above it at the full rate. So the SAME invoice to the SAME party
// withholds different amounts depending on what has already been billed that
// year, which is the single most-asked question about these figures.
//
// Extracted so the deal form (which previews the figure) and the explainer
// (which shows the working) cannot drift apart. The main process holds the
// authoritative copy — this must agree with it, and the explainer says plainly
// what was actually posted alongside what it reconstructs.

const round2 = (v: number): number => Math.round(v * 100) / 100
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// TDS on one invoice, given what the party has already been billed this year.
export function tierTds(
  base: number,
  prior: number,
  threshold: number,
  basePct: number,
  abovePct: number
): number {
  if (!threshold || threshold <= 0) return (base * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, base))
  return (below * basePct) / 100 + ((base - below) * abovePct) / 100
}

export type SlabStep = {
  label: string
  // What the withholding is struck ON for this invoice: the goods alone, on
  // both sides. (A purchase was struck on goods plus GST plus the round-off
  // until that was corrected — the caller decides, and every live caller now
  // passes the taxable value.)
  base: number
  // Where the party's year-to-date stood as this invoice was posted.
  priorBefore: number
  below: number
  above: number
  belowTds: number
  aboveTds: number
  tds: number
}

// Every invoice on one side, in the order they were posted — because each one
// moves the party's year-to-date along and the next starts further up the
// slab. Walking them in that order is the only way a reconstruction can agree
// with what was saved.
export function walkSlab(
  invoices: { label: string; taxable: number; base: number }[],
  priorAtStart: number,
  threshold: number,
  basePct: number,
  abovePct: number
): { steps: SlabStep[]; total: number; priorEnd: number } {
  let prior = num(priorAtStart)
  const steps: SlabStep[] = []
  let total = 0
  for (const inv of invoices) {
    const base = num(inv.base)
    const below = threshold > 0 ? Math.max(0, Math.min(threshold - prior, base)) : 0
    const above = round2(base - below)
    const belowTds = round2((below * basePct) / 100)
    const aboveTds = round2((above * abovePct) / 100)
    const tds = round2(threshold > 0 ? belowTds + aboveTds : (base * basePct) / 100)
    steps.push({
      label: inv.label,
      base: round2(base),
      priorBefore: round2(prior),
      below: round2(below),
      above,
      belowTds,
      aboveTds,
      tds
    })
    total += tds
    prior += num(inv.taxable)
  }
  return { steps, total: round2(total), priorEnd: round2(prior) }
}
