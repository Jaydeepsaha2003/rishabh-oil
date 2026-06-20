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
  tdsThreshold?: number
  tdsPctAbove?: number
  tdsPrior?: number
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
  netAmount: number
  finalTaxableValue: number
  finalGstAmount: number
  finalTdsAmount: number
  finalNetAmount: number
}

export function computeMoney(i: MoneyInput): MoneyResult {
  const interestPct = i.addsInterest ? i.interestPct : 0
  const interestDays = i.addsInterest ? i.interestDays : 0
  const interestPerUnit = i.bargainRate * (interestPct / 100) * (interestDays / 365)
  const adjustedRate = i.invoiceRate + interestPerUnit
  const threshold = i.tdsThreshold || 0
  const abovePct = i.tdsPctAbove || 0
  const prior = i.tdsPrior || 0
  const taxableValue = adjustedRate * i.orderedQty
  const gstAmount = (taxableValue * i.gstPct) / 100
  const tdsAmount = tierTds(taxableValue, prior, threshold, i.tdsPct, abovePct)
  const netAmount = taxableValue + gstAmount - tdsAmount
  const finalTaxableValue = i.bargainRate * i.orderedQty
  const finalGstAmount = (finalTaxableValue * i.gstPct) / 100
  const finalTdsAmount = tierTds(finalTaxableValue, prior, threshold, i.tdsPct, abovePct)
  const finalNetAmount = finalTaxableValue + finalGstAmount - finalTdsAmount
  return {
    interestPerUnit,
    adjustedRate,
    taxableValue,
    gstAmount,
    tdsAmount,
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
  const transportAmount = i.orderedQty * i.transportRatePerTon
  return { allowedQty, actualShortage, excessShortage, shortageCharge, transportAmount }
}

// Tanker lifecycle, in order.
export const STAGES = [
  'ordered',
  'at_port',
  'payment_cleared',
  'in_transit',
  'outside_factory',
  'inside_factory',
  'received'
] as const

export const STATUS_LABEL: Record<string, string> = {
  ordered: 'Ordered',
  at_port: 'At supplier port',
  payment_cleared: 'Payment cleared',
  in_transit: 'In transit',
  outside_factory: 'Outside factory',
  inside_factory: 'Inside factory',
  received: 'Received'
}

// Stages where the tanker is moving and can therefore run late.
export const EN_ROUTE = ['in_transit', 'outside_factory', 'inside_factory']

export function nextStage(s: string): string | null {
  const i = STAGES.indexOf(s as (typeof STAGES)[number])
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null
}
