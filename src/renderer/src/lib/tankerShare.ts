// ONE TANKER, SEVERAL INVOICES, TWO BARGAINS.
//
// A lorry that loaded more than its bargain had left carries two bargains: its
// own (loaded − extra) and the excess one (extra). When the lorry is billed on
// several invoices, each invoice's share uses up the FIRST bargain before it
// touches the second — 5.43 MT left on CPO/01 and a 5.43 MT invoice is all
// CPO/01, the rest of the lorry falls to the excess bargain.
//
// Shared by the server (pricing and what is stored) and the purchase form (what
// it shows), so the two can never disagree.

export type OtherShare = { qty: number; extra_part?: number | null }

/** What an earlier invoice took of the excess bargain. Rows saved before this rule carry none: theirs was in proportion. */
export function extraPartOf(o: OtherShare, loaded: number, extra: number): number {
  if (o.extra_part != null && Number.isFinite(Number(o.extra_part))) return Number(o.extra_part)
  return loaded > 0 ? (extra * o.qty) / loaded : 0
}

/** This invoice's share split over the tanker's two bargains: the own bargain first, then the excess. */
export function splitShare(
  loaded: number,
  extra: number,
  share: number,
  others: OtherShare[]
): { own: number; extra: number } {
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  if (!(extra > 0)) return { own: r3(share), extra: 0 }
  const takenExtra = others.reduce((t, o) => t + extraPartOf(o, loaded, extra), 0)
  const takenOwn = others.reduce((t, o) => t + o.qty, 0) - takenExtra
  const ownLeft = Math.max(0, loaded - extra - takenOwn)
  const own = r3(Math.min(share, ownLeft))
  return { own, extra: r3(Math.max(0, share - own)) }
}
