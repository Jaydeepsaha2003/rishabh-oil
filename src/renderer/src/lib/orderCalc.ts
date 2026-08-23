// Mirror of computeMoney in src/main/orders.ts — used for the live preview in the
// order form. The main process recomputes authoritatively on save.

export interface MoneyInput {
  orderedQty: number
  invoiceRate: number
  bargainRate: number
  gstPct: number
  tdsPct: number
  addsInterest: boolean
  interestPct: number
  interestDays: number
  additionalInterest?: number // manual per-unit interest added to the adjusted rate
  tdsThreshold?: number
  tdsPctAbove?: number
  tdsPrior?: number
  // Per-bargain shares when the invoice spans more than one bargain rate.
  // additionalInterest/interestDays on a line override the invoice-level ones
  // for just that line — absent means it inherits the shared value.
  lines?: { rate: number; qty: number; additionalInterest?: number; interestDays?: number }[]
  // Applied to the total excluding TDS, which then becomes the TDS base.
  roundOff?: number
}

function tierTds(
  taxable: number,
  prior: number,
  threshold: number,
  basePct: number,
  abovePct: number
): number {
  if (!threshold || threshold <= 0) return (taxable * basePct) / 100
  const below = Math.max(0, Math.min(threshold - prior, taxable))
  const above = taxable - below
  return (below * basePct) / 100 + (above * abovePct) / 100
}

export interface MoneyResult {
  interestPerUnit: number
  adjustedRate: number
  taxableValue: number
  gstAmount: number
  tdsAmount: number
  // taxable + GST, before the round off.
  totalExclTds: number
  // taxable + GST + round off — what TDS is charged on.
  roundedTotal: number
  netAmount: number
  finalTaxableValue: number
  finalGstAmount: number
  finalTdsAmount: number
  finalNetAmount: number
}

export function computeMoney(i: MoneyInput): MoneyResult {
  const interestPct = i.addsInterest ? i.interestPct : 0
  const interestDays = i.addsInterest ? i.interestDays : 0
  // Simple interest on the GST-inclusive bargain rate:
  // I = BG rate × (1 + GST%) × Int% × days / 365
  const interestPerUnit =
    i.bargainRate * (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (interestDays / 365)
  // Manual additional interest (₹ per unit) folds into the adjusted rate too.
  const rawAdjustedRate = i.invoiceRate + interestPerUnit + (i.additionalInterest || 0)
  const threshold = i.tdsThreshold || 0
  const abovePct = i.tdsPctAbove || 0
  const prior = i.tdsPrior || 0
  // Mirrors main: each bargain line is billed at a whole-rupee rate (rounded
  // up), so taxable = Σ line values. One bargain → ceil(rate) × qty.
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const r2 = (v: number): number => Math.round(v * 100) / 100
  const lines = (i.lines || []).filter((l) => num(l.qty) > 0)
  const lineQty = lines.reduce((s, l) => s + num(l.qty), 0)
  // Mirrors main: an invoice rate above the blended bargain rate (supplier
  // freight in the rate) is spread onto every line, with a paisa guard so the
  // blended average's own rounding is not mistaken for a premium.
  const blended = lineQty > 0 ? r2(lines.reduce((s, l) => s + num(l.rate) * num(l.qty), 0) / lineQty) : 0
  const rawPremium = r2(i.invoiceRate - blended)
  const ratePremium = Math.abs(rawPremium) < 0.01 ? 0 : rawPremium
  const taxableValue =
    lines.length > 1 && lineQty > 0
      ? lines.reduce((s, l) => {
          const days = l.interestDays != null ? num(l.interestDays) : interestDays
          const addl = l.additionalInterest != null ? num(l.additionalInterest) : i.additionalInterest || 0
          const kF = (1 + (i.gstPct || 0) / 100) * (interestPct / 100) * (days / 365)
          return s + Math.ceil(num(l.rate) + num(l.rate) * kF + addl + ratePremium) * num(l.qty)
        }, 0)
      : Math.ceil(rawAdjustedRate) * i.orderedQty
  const adjustedRate = i.orderedQty > 0 ? taxableValue / i.orderedQty : Math.ceil(rawAdjustedRate)
  const gstAmount = (taxableValue * i.gstPct) / 100
  // The round off lands on the total excluding TDS, and that rounded figure is
  // what TDS is deducted on — so the rounding flows through to TDS and the net.
  const roundOff = num(i.roundOff)
  const totalExclTds = taxableValue + gstAmount
  const roundedTotal = totalExclTds + roundOff
  // TDS is rounded to paise ONCE and the net derived from that rounded
  // figure, so the summary and the ledger cannot disagree by a paisa.
  const round2 = (v: number): number => Math.round(v * 100) / 100
  const tdsAmount = round2(tierTds(roundedTotal, prior, threshold, i.tdsPct, abovePct))
  const netAmount = round2(roundedTotal - tdsAmount)
  const finalTaxableValue = i.bargainRate * i.orderedQty
  const finalGstAmount = (finalTaxableValue * i.gstPct) / 100
  const finalRoundedTotal = finalTaxableValue + finalGstAmount + roundOff
  const finalTdsAmount = round2(tierTds(finalRoundedTotal, prior, threshold, i.tdsPct, abovePct))
  const finalNetAmount = round2(finalRoundedTotal - finalTdsAmount)
  return {
    interestPerUnit,
    adjustedRate,
    taxableValue,
    gstAmount,
    tdsAmount,
    totalExclTds,
    roundedTotal,
    netAmount,
    finalTaxableValue,
    finalGstAmount,
    finalTdsAmount,
    finalNetAmount
  }
}

export interface ShortageInput {
  orderedQty: number
  receivedQty: number
  allowedPct: number
  bargainRate: number
  transportRatePerTon: number
}

export interface ShortageResult {
  allowedQty: number
  actualShortage: number
  excessShortage: number
  shortageCharge: number
  transportAmount: number
}

export function computeShortage(i: ShortageInput): ShortageResult {
  const allowedQty = (i.orderedQty * i.allowedPct) / 100
  const actualShortage = Math.max(0, i.orderedQty - i.receivedQty)
  const excessShortage = Math.max(0, actualShortage - allowedQty)
  const shortageCharge = excessShortage * i.bargainRate
  // Freight is earned on what arrived, matching advancePurchaseTanker — a
  // preview off the loaded qty would disagree with the figure that posts.
  const transportAmount = i.receivedQty * i.transportRatePerTon
  return { allowedQty, actualShortage, excessShortage, shortageCharge, transportAmount }
}

// Tanker lifecycle, in order.
export const STAGES = [
  'supplier_factory',
  'loaded',
  'transit',
  'outside_factory',
  'inside_factory',
  'empty'
] as const

export const STATUS_LABEL: Record<string, string> = {
  supplier_factory: 'Inside supplier factory',
  loaded: 'Loaded',
  transit: 'In transit',
  empty: 'Empty',
  outside_factory: 'Outside factory',
  inside_factory: 'Inside factory',
  received: 'Completed'
}

// Stages where the tanker is moving and can therefore run late.
export const EN_ROUTE = ['transit', 'outside_factory', 'inside_factory']

export function nextStage(s: string): string | null {
  const i = STAGES.indexOf(s as (typeof STAGES)[number])
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null
}
