/**
 * A COLOUR PER LOT · TERMINAL, THE SAME ONE EVERYWHERE, FOR GOOD.
 * ---------------------------------------------------------------------------
 * The pair identifies a parcel — the same lot number off a different terminal
 * is a different parcel — so the colour belongs to the COMBINATION, and both
 * halves of the label wear it.
 *
 * WHY A HASH AND NOT "FIRST COME, FIRST COLOUR".
 *
 * Handing colours out in the order the pairs are met reads well until the
 * register changes under it. A tanker recorded late but dated earlier lands in
 * the middle of a date-ordered list, and every pair after it shifts one colour
 * along: nothing about those parcels changed, but the page looks different
 * from the one somebody was reading a minute ago. The same list shown on two
 * screens — the consignment register and the deposits panel inside Stock —
 * would disagree for the same reason, because each sees a different set of
 * rows.
 *
 * So the colour is computed FROM THE PAIR and from nothing else. A parcel's
 * colour is fixed the moment it is named, never moves when another parcel is
 * added or removed, and is identical on every screen that shows it. A new
 * combination simply gets whatever its own name gives it.
 *
 * The cost is honest and small: two unrelated pairs can land on one tint, the
 * same way the twenty-first pair would have anyway. The hash is FNV-1a, which
 * mixes properly — "A|AB" and "B|ABB" are not neighbours in it, which a naive
 * sum of character codes would have made them.
 */

export interface LotTint {
  bg: string
  fg: string
}

/**
 * Twenty distinct, legible tints, then round again.
 *
 * Twenty is about as far as colour can be pushed before two of them stop being
 * tellable apart, and a twenty-first invented tint that looks like the fourth
 * is worse than an honest repeat. Text on its own pale ground rather than
 * white on a strong fill: a register is read for its figures, and twenty
 * saturated blocks down one column would shout over them.
 */
export const LOT_TINTS: LotTint[] = [
  { bg: '#EAF0FA', fg: '#1B4E82' },
  { bg: '#E9F5EE', fg: '#0B6B45' },
  { bg: '#FBEDE6', fg: '#9A4A18' },
  { bg: '#F1EAF8', fg: '#5B3A8C' },
  { bg: '#FFF3D6', fg: '#8A5300' },
  { bg: '#E6F4F6', fg: '#0F5E69' },
  { bg: '#FBE9EF', fg: '#9B2C4E' },
  { bg: '#EEF3E2', fg: '#4A6113' },
  { bg: '#E8EEF9', fg: '#2B4A8F' },
  { bg: '#F7ECDC', fg: '#7A5218' },
  { bg: '#E4F2EA', fg: '#186A4A' },
  { bg: '#F3E8F1', fg: '#7A2E6B' },
  { bg: '#E7F0F3', fg: '#1F5566' },
  { bg: '#FDEBE0', fg: '#A4491B' },
  { bg: '#ECEDF8', fg: '#3B3E92' },
  { bg: '#EFF5E6', fg: '#3F6118' },
  { bg: '#FAEBF3', fg: '#8C2F66' },
  { bg: '#E5F1F7', fg: '#14577F' },
  { bg: '#F6EFE1', fg: '#6E5514' },
  { bg: '#EAF2EC', fg: '#2C5E42' }
]

/** The parcel's name: the pair, trimmed and case-folded. Empty when unnamed. */
export function lotKey(lot: unknown, terminal: unknown): string {
  const a = String(lot ?? '').trim().toUpperCase()
  const b = String(terminal ?? '').trim().toUpperCase()
  return a || b ? `${a}|${b}` : ''
}

/** FNV-1a, so neighbouring names do not land on neighbouring colours. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The tint this lot · terminal wears, or null when it has no name yet. */
export function lotTint(lot: unknown, terminal: unknown): LotTint | null {
  const k = lotKey(lot, terminal)
  if (!k) return null
  return LOT_TINTS[hash(k) % LOT_TINTS.length]
}
