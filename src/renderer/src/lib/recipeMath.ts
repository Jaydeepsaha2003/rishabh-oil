// The recipe arithmetic, in one place.
//
// A production run and the sheet that previews it MUST agree. They did not:
// the main process expanded a recipe properly — each input at its own TOR
// multiplier, loss and manual by-products struck on the real total, and the
// fatty acid an auto-calculated input recovers added back — while the entry
// sheet in the renderer multiplied the raw percentages and stopped there. A
// 100 MT batch on a 106.952% recipe previewed as drawing 100 of CPO and
// recovering no fatty acid at all, then posted something else.
//
// So the maths lives here, imported by BOTH sides. Deliberately free of
// imports, framework and platform: it is bundled into the Electron main
// process and into the browser build alike.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const num = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : 0
}

const kindOf = (it: Row): string => String(it.kind || 'input')

const sumOf = (items: Row[], kind: string): number =>
  items.filter((it) => kindOf(it) === kind).reduce((s, it) => s + num(it.qty), 0)

// The recipe-wide multiplier shared by every input that does not carry its
// own — by-products and loss come off the oil going in, so the yield is
// (100 − their total)% and the requirement is 100 ÷ that yield.
export function uniformRecipeTor(items: Row[]): number {
  const lossPct = sumOf(items, 'output') + sumOf(items, 'loss')
  // A recipe claiming to lose everything (or more) has no sane answer; leave
  // it at 100% rather than dividing by zero or going negative.
  if (lossPct <= 0 || lossPct >= 100) return 100
  return (100 * 100) / (100 - lossPct)
}

// A single input's own fatty-acid loss — FFA% x (1 + loss multiplier%) — as a
// % of THAT INPUT's own quantity, not of the output.
export function inputFattyAcidPct(it: Row): number {
  return num(it.ffa_pct) * (1 + num(it.loss_multiplier_pct) / 100)
}

// A single input's OWN TOR multiplier, when a blend mixes raw oils of
// differing quality and each needs its own answer rather than one shared
// across the whole blend — SHEA at 23% FFA needs far more raw material per
// unit of output than RPS at 0.15% does. Dead loss is NOT per-input: it is the
// recipe's own shared 'loss' total, the same standing assumption for every
// ingredient.
export function inputTorMultiplier(it: Row, sharedDeadLossPct: number): number {
  const yieldPct = 100 - inputFattyAcidPct(it) - sharedDeadLossPct
  // No sane answer if this ingredient claims to lose everything (or more).
  if (yieldPct <= 0) return 1
  return 100 / yieldPct
}

// The recipe's total oil required, per 100 of output. With one shared loss
// this is exactly the uniform TOR; once an input carries its own
// auto-calculated multiplier, that input takes its own share × its own
// multiplier and the total is the sum.
export function recipeTor(items: Row[]): number {
  const inputs = items.filter((it) => kindOf(it) === 'input')
  const blend = inputs.reduce((s, it) => s + num(it.qty), 0)
  const uniformTor = uniformRecipeTor(items)
  if (blend <= 0) return uniformTor
  const deadLoss = sumOf(items, 'loss')
  return inputs.reduce((s, it) => {
    const mult = it.auto_calc ? inputTorMultiplier(it, deadLoss) : uniformTor / 100
    return s + num(it.qty) * mult
  }, 0)
}

// Every stock movement one batch makes: what it draws in, what it loses, and
// what it puts back — the recovered fatty acid included.
export function expandRecipe(
  items: Row[],
  outputQty: number
): { product_id: number; qty: number; kind: string }[] {
  const blend = sumOf(items, 'input')
  const uniformTor = uniformRecipeTor(items)
  // A loss or manual by-product line is a % OF THE INPUT, so it rides on what
  // the recipe ACTUALLY draws in — recipeTor, not the uniform figure. The two
  // coincide only while no input carries its own multiplier; once one does,
  // uniformTor is the smaller, wrong number and understates the loss.
  const tor = recipeTor(items)
  const deadLoss = sumOf(items, 'loss')

  const lines = items.map((it) => {
    const kind = kindOf(it)
    let pct: number
    if (kind === 'input') {
      // Guard a malformed recipe whose blend does not total 100 — scale by the
      // share it actually has rather than dividing by zero.
      const mult = it.auto_calc ? inputTorMultiplier(it, deadLoss) : uniformTor / 100
      pct = blend > 0 ? num(it.qty) * mult : 0
    } else {
      pct = (tor * num(it.qty)) / 100
    }
    return { product_id: Number(it.product_id), qty: (outputQty * pct) / 100, kind }
  })

  // What each auto-calculated input recovers as fatty acid, pooled by whichever
  // product it names. This is the part the entry sheet used to miss entirely.
  const byproductAdds = new Map<number, number>()
  for (const it of items) {
    if (kindOf(it) !== 'input' || !it.auto_calc || !num(it.byproduct_product_id)) continue
    const mult = inputTorMultiplier(it, deadLoss)
    const pct = blend > 0 ? num(it.qty) * mult : 0
    const inputQty = (outputQty * pct) / 100
    const pid = num(it.byproduct_product_id)
    byproductAdds.set(pid, (byproductAdds.get(pid) || 0) + (inputQty * inputFattyAcidPct(it)) / 100)
  }
  for (const [pid, qty] of byproductAdds) {
    const existing = lines.find((l) => l.kind === 'output' && l.product_id === pid)
    if (existing) existing.qty += qty
    else lines.push({ product_id: pid, qty, kind: 'output' })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Drawing part of an input from PP that carries no free fatty acid.
// ---------------------------------------------------------------------------
// PP is the oil already in process, and it comes in two kinds. Oil marked
// W/O FFA has had its free fatty acid stripped already — it is most of the way
// to finished — so a batch drawing on it loses nothing to FFA. Oil marked
// With FFA has not, and sheds its FFA% on the way through exactly as raw oil
// does.
//
// So an input can no longer have ONE multiplier. Needing ten tonnes of usable
// oil, with four available as W/O-FFA PP, is four tonnes drawn one-for-one plus
// six tonnes' worth lifted by the FFA yield — and only the second part sheds
// any fatty acid to recover.
//
// Stated as: dead loss applies to everything (it is the recipe's own shared
// assumption, not a property of the oil), and the FFA uplift applies only to
// the FFA-bearing part.
//
//   need      = output x share / (1 - deadLoss)          <- usable oil wanted
//   grossFree = the W/O-FFA PP taken, one for one
//   grossFfa  = (need - grossFree) x (1 - d) / (1 - f - d)
//
// With no W/O-FFA PP available this reduces EXACTLY to what the recipe already
// computed — grossFfa = need x (1-d)/(1-f-d) = output x share / (1-f-d) —
// which is the property that matters most here: turning the feature on must not
// move a single existing batch. splitInputDraw is checked against that.
export type InputDraw = {
  /** Taken from PP marked W/O FFA — no fatty-acid uplift, none recovered. */
  fromFree: number
  /** Taken from everything else — lifted by the FFA yield, and sheds FFA. */
  fromFfa: number
  /** Gross oil the batch actually draws: fromFree + fromFfa. */
  gross: number
  /** Fatty acid recovered, off the FFA-bearing part alone. */
  fattyAcid: number
}

/**
 * How one input's draw splits, given how much W/O-FFA PP is on hand.
 *
 * `freeAvailable` is capped by what the input needs: PP left over is still PP,
 * and a vessel is never emptied further than the batch requires.
 */
export function splitInputDraw(
  it: Row,
  outputQty: number,
  blendShare: number,
  sharedDeadLossPct: number,
  freeAvailable: number
): InputDraw {
  const share = num(it.qty)
  const d = sharedDeadLossPct / 100
  // A recipe claiming to lose everything has no sane answer; fall back to no
  // uplift rather than dividing by zero or going negative.
  const need = blendShare > 0 && d < 1 ? (outputQty * share) / 100 / (1 - d) : 0
  const f = (it.auto_calc ? inputFattyAcidPct(it) : 0) / 100
  const fromFree = Math.max(0, Math.min(num(freeAvailable), need))
  const remaining = Math.max(0, need - fromFree)
  const yieldLeft = 1 - f - d
  const fromFfa = yieldLeft > 0 ? (remaining * (1 - d)) / yieldLeft : remaining
  return {
    fromFree,
    fromFfa,
    gross: fromFree + fromFfa,
    fattyAcid: fromFfa * f
  }
}

/**
 * The same expansion as expandRecipe, but told how much W/O-FFA PP each input
 * may draw on first — `freeByProduct` maps product id to the quantity
 * available. An input with none behaves exactly as before.
 *
 * Returns the movement lines AND, per input, how the draw was split, so the
 * entry sheet can show it and the PP balance can be reduced by the right
 * amount against the right bucket.
 */
export function expandRecipeWithPp(
  items: Row[],
  outputQty: number,
  freeByProduct: Record<number, number> = {}
): {
  lines: { product_id: number; qty: number; kind: string }[]
  draws: { product_id: number; fromFree: number; fromFfa: number; gross: number; fattyAcid: number }[]
} {
  const inputs = items.filter((it) => kindOf(it) === 'input')
  const blend = sumOf(items, 'input')
  const deadLoss = sumOf(items, 'loss')
  const uniformTor = uniformRecipeTor(items)

  // Each input's own split. A non-auto_calc input has no FFA of its own, so
  // W/O-FFA PP buys it nothing — its gross is the uniform figure either way,
  // and it is left exactly where it was.
  const left = { ...freeByProduct }
  const draws: { product_id: number; fromFree: number; fromFfa: number; gross: number; fattyAcid: number }[] = []
  const lines: { product_id: number; qty: number; kind: string }[] = []

  for (const it of inputs) {
    const pid = Number(it.product_id)
    if (!it.auto_calc) {
      const qty = blend > 0 ? (outputQty * num(it.qty) * (uniformTor / 100)) / 100 : 0
      lines.push({ product_id: pid, qty, kind: 'input' })
      draws.push({ product_id: pid, fromFree: 0, fromFfa: qty, gross: qty, fattyAcid: 0 })
      continue
    }
    const split = splitInputDraw(it, outputQty, blend, deadLoss, left[pid] || 0)
    left[pid] = Math.max(0, (left[pid] || 0) - split.fromFree)
    lines.push({ product_id: pid, qty: split.gross, kind: 'input' })
    draws.push({ product_id: pid, ...split })
  }

  // Loss and manual by-product lines are a % OF THE INPUT, so they ride on
  // what the recipe ACTUALLY draws — which now depends on the split, and is
  // smaller when part of the oil came from PP that sheds nothing.
  const torActual = outputQty > 0 ? (lines.reduce((a, l) => a + l.qty, 0) / outputQty) * 100 : 0
  for (const it of items) {
    const kind = kindOf(it)
    if (kind === 'input') continue
    lines.push({ product_id: Number(it.product_id), qty: (outputQty * ((torActual * num(it.qty)) / 100)) / 100, kind })
  }

  // The fatty acid each auto-calculated input recovers, pooled by the product
  // it names — off the FFA-bearing part of the draw only.
  const adds = new Map<number, number>()
  for (const it of inputs) {
    if (!it.auto_calc || !num(it.byproduct_product_id)) continue
    const d = draws.find((x) => x.product_id === Number(it.product_id))
    if (!d) continue
    const pid = num(it.byproduct_product_id)
    adds.set(pid, (adds.get(pid) || 0) + d.fattyAcid)
  }
  for (const [pid, qty] of adds) {
    const existing = lines.find((l) => l.kind === 'output' && l.product_id === pid)
    if (existing) existing.qty += qty
    else lines.push({ product_id: pid, qty, kind: 'output' })
  }
  return { lines, draws }
}

// -----------------------------------------------------------------------------
// PP OF THE PRODUCT ITSELF
// -----------------------------------------------------------------------------
// The PP handled above is an INPUT substitute: shea in a vessel saves shea from
// the yard. This is the other case, and the commoner one — the vessel holds the
// thing being MADE. RPO part-way through the plant is already RPO, already
// blended, so finishing it draws no shea, no RPS and no fatty oil: the vessel
// supplies what all three would have, and none of them is bought a second time.
//
// The rest of the formulation still applies to it, though. The oil in the
// vessel has not shed its free fatty acid, and it has the plant's dead loss
// still ahead of it, so putting it through costs exactly what the recipe says
// oil costs — its TOR — and gives back exactly what the recipe says comes back.
//
// So a batch is supplied in three steps, and only what is left over is a
// recipe problem:
//
//   1. PP of the product, W/O FFA  — one for one, straight to finished. It has
//      already shed everything it was going to; no recipe touches it again.
//   2. PP of the product, WITH FFA — the recipe's own arithmetic over oil that
//      is already blended: TOR in, finished out, fatty acid and dead loss off.
//   3. Whatever remains                — the formulation, exactly as before.
//
// With both vessels empty this collapses to step 3 and nothing changes.

/**
 * How much vessel oil one unit of finished output costs, WITH-FFA.
 *
 * Not the dominant input's FFA, which is what this used to be. What stands in
 * an RPO vessel is not shea — it is the whole blend, part-way through: shea,
 * RPS and fatty oil already mixed, still carrying the free fatty acid none of
 * them has shed yet. Finishing it is therefore the recipe's own arithmetic run
 * once more over oil that is already blended: the same total oil required, the
 * same by-product yield, the same dead loss. Only the INPUT side differs — the
 * vessel supplies what shea, RPS and fatty oil would have, so none of the
 * three is drawn a second time.
 *
 * So the rate is the recipe's own TOR: 127.052 of oil in for 100 out, and the
 * 27.052 that does not survive leaves as fatty acid and dead loss in exactly
 * the proportions the recipe states.
 */
export function outputPpTorFraction(items: Row[]): number {
  const tor = recipeTor(items)
  return tor > 0 ? tor / 100 : 1
}

export type OutputPpPlan = {
  /** Vessel oil taken 1:1 — finished, no inputs, no fatty acid. */
  fromPpFree: number
  /** Vessel oil taken out of the WITH-FFA vessels. */
  ppWithUsed: number
  /** What that oil yields once the recipe has had it. */
  finishedFromWith: number
  /** What it gives back — every by-product the recipe names, pooled. */
  fattyAcidFromWith: number
  /** Output still to be made from raw, through the formulation. */
  fromRecipe: number
  /** That recovery as a % of the vessel oil, for the screen to show. */
  ffaPct: number
}

/**
 * How much of a batch its own PP can supply, and what is left for the recipe.
 *
 * `pools` is what stands in the product's own vessels. Nothing here reads or
 * writes stock — the caller draws against the plan.
 */
export function planOutputPp(
  items: Row[],
  outputQty: number,
  pools: { without?: number; with?: number } = {}
): OutputPpPlan {
  const want = Math.max(0, num(outputQty))
  const freeHave = Math.max(0, num(pools.without))
  const withHave = Math.max(0, num(pools.with))

  // 1. One for one, and never more than the batch needs — PP left over is
  //    still PP, and a vessel is not emptied further than the run requires.
  //    Oil marked W/O FFA has already shed everything it was going to: no
  //    recipe applies to it a second time, no by-product, no dead loss.
  const fromPpFree = Math.min(freeHave, want)
  const afterFree = want - fromPpFree

  // 2. The WITH-FFA vessels, at the recipe's own rate. A tonne in the vessel
  //    is not a tonne of output — it still has to go through the plant — so
  //    supplying `afterFree` costs afterFree x TOR of vessel oil, the same as
  //    it would cost in raw material.
  const tor = outputPpTorFraction(items)
  const needFromWith = afterFree * tor
  const ppWithUsed = Math.min(withHave, needFromWith)
  const finishedFromWith = tor > 0 ? ppWithUsed / tor : ppWithUsed

  // What that oil gives back, by the recipe's own reckoning. Kept on the plan
  // so the screen can say it without expanding the recipe a second time; the
  // lines themselves are built in expandBatchWithOutputPp, from this same
  // expansion, so the two cannot disagree.
  const recovered = expandRecipe(items, finishedFromWith)
    .filter((l) => l.kind === 'output')
    .reduce((s, l) => s + l.qty, 0)

  return {
    fromPpFree,
    ppWithUsed,
    finishedFromWith,
    fattyAcidFromWith: recovered,
    fromRecipe: Math.max(0, want - fromPpFree - finishedFromWith),
    ffaPct: ppWithUsed > 0 ? (recovered / ppWithUsed) * 100 : 0
  }
}

/**
 * A whole batch: its own PP first, then the formulation for the remainder.
 *
 * The returned lines are the movements to write. The output product itself is
 * NOT a line — the production row carries it — so a batch supplied entirely
 * from PP returns only the fatty acid it shed.
 */
export function expandBatchWithOutputPp(
  items: Row[],
  outputQty: number,
  outputPools: { without?: number; with?: number } = {},
  freeByProduct: Record<number, number> = {},
  outputProductId = 0
): {
  lines: { product_id: number; qty: number; kind: string }[]
  draws: { product_id: number; fromFree: number; fromFfa: number; gross: number; fattyAcid: number }[]
  plan: OutputPpPlan
} {
  const plan = planOutputPp(items, outputQty, outputPools)
  // Only the part still to be MADE goes through the recipe. With empty vessels
  // this is the whole batch and the result is identical to before.
  const base = expandRecipeWithPp(items, plan.fromRecipe, freeByProduct)
  const lines = base.lines

  // THE MINUS HALF OF THE PAIR.
  //
  // PP is already inside the product's own stock figure — an opening of 75.15
  // RPO is 22.15 in tanks plus 53 standing in vessels. So finishing 35 of it
  // makes nothing NEW: booking the batch as +35 without taking the same 35 out
  // of PP would count that oil twice.
  //
  // The batch is therefore recorded as the paired +/- a recirculation already
  // is — produced 35, consumed 35, closing unmoved — except that here the pair
  // runs through the real movement lines, so the vessel it came out of comes
  // down with it. For the WITH-FFA half the two sides differ by exactly the
  // fatty acid it shed, which is what leaves the product's balance.
  const fromOwnPp = plan.fromPpFree + plan.ppWithUsed
  if (outputProductId && fromOwnPp > 0.0005) {
    lines.push({ product_id: Number(outputProductId), qty: fromOwnPp, kind: 'input' })
  }

  // WHAT THE VESSEL OIL GIVES BACK — the recipe's own lines, not just its FFA.
  //
  // The with-FFA half is the recipe run over oil that is already blended, so
  // everything the recipe produces for that much output it produces here too:
  // the fatty acid each input recovers, pooled where the recipe pools it, any
  // by-product line struck by hand, and the dead loss. Only the input side is
  // replaced — by the vessel draw pushed above.
  //
  // This used to add the dominant input's FFA and nothing else, which quietly
  // dropped the dead loss and every by-product but one.
  if (plan.finishedFromWith > 0.0005) {
    for (const l of expandRecipe(items, plan.finishedFromWith)) {
      if (l.kind === 'input') {
        // WHAT THE VESSEL OIL IS, kept as a line of its own.
        //
        // 'pp_equiv' is not a movement and nothing may treat it as one: the
        // shea, RPS and fatty oil it names left the tanks when this PP was
        // MADE, and taking them again now would count the same oil twice. It
        // is recorded so the registers can SAY what was used without moving
        // anything — the stock register shows it in Adjusted and in Consumed
        // at once, where the two cancel to nothing.
        if (l.qty > 0.0000005) {
          const had = lines.find((x) => x.kind === 'pp_equiv' && x.product_id === l.product_id)
          if (had) had.qty += l.qty
          else lines.push({ product_id: l.product_id, qty: l.qty, kind: 'pp_equiv' })
        }
        continue
      }
      const existing = lines.find((x) => x.kind === l.kind && x.product_id === l.product_id)
      if (existing) existing.qty += l.qty
      else lines.push({ product_id: l.product_id, qty: l.qty, kind: l.kind })
    }
  }
  return { lines, draws: base.draws, plan }
}
