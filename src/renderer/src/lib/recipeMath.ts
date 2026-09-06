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
