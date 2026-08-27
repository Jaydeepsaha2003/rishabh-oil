// What a shortage on a delivered (FOR) sale actually costs, and who wears it.
//
// A tanker weighed 24.500 MT leaving the mill and 24.100 at the customer's
// weighbridge. Some of that 400 kg is real -- oil clings to the shell, and no
// two weighbridges agree to the last kilo -- so the trade allows a tolerance,
// and only what falls BEYOND the tolerance is anyone's fault. The register used
// to print "short 0.400" and leave it there, which says nothing about whether
// that is a normal delivery or four hundred kilos somebody owes for.
//
// The arithmetic deliberately matches computeShortage() on the purchase side:
// the mill applies one rule to a tanker whichever direction it is travelling,
// and two implementations of one rule is two implementations to disagree.

export type ShortageBasis = 'invoice' | 'bargain' | 'default'

export type SaleShortage = {
  // Whether there is anything to judge: a delivered sale, actually unloaded,
  // with a dispatched quantity to compare against.
  applies: boolean
  dispatched: number
  received: number
  // Everything that went missing, allowed or not.
  shortage: number
  pct: number
  // Which of the three settings the percentage came from, so the reader can
  // see whether it was agreed on this invoice, on the rate contract, or is
  // just the mill's standing default.
  basis: ShortageBasis
  allowedQty: number
  // The part beyond the tolerance -- the deductible bit.
  excessQty: number
  rate: number
  // excessQty x rate: the value of goods that left the mill and never arrived.
  deductible: number
  // Freight is earned on what ARRIVED, so a shortage has already shrunk the
  // transporter's bill by this much before any deduction is even considered.
  freightRate: number
  freightForgone: number
  // True when the delivery came in inside its tolerance.
  within: boolean
}

const num = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// A blank allowance means "not answered here" and passes the question up the
// chain; a typed 0 is a real answer -- no tolerance at all -- and stops it.
function pick(...vals: unknown[]): { pct: number; basis: ShortageBasis } {
  const order: ShortageBasis[] = ['invoice', 'bargain', 'default']
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (v != null && v !== '' && Number.isFinite(Number(v))) {
      return { pct: Number(v), basis: order[i] ?? 'default' }
    }
  }
  return { pct: 0, basis: 'default' }
}

// `line` is a row from listSales; `defaultPct` is the mill-wide setting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function saleShortage(line: Record<string, any>, defaultPct: unknown): SaleShortage {
  const isFor = String(line.freight_term || 'FREIGHT_ON_GOODS') === 'DLD'
  const dispatched = num(line.qty)
  const received = num(line.received_qty)
  const { pct, basis } = pick(line.allowed_shortage_pct, line.bargain_allowed_shortage_pct, defaultPct)
  const shortage = Math.max(0, dispatched - received)
  const allowedQty = (dispatched * pct) / 100
  const excessQty = Math.max(0, shortage - allowedQty)
  const rate = num(line.rate)
  const freightRate = num(line.transport_rate)
  return {
    // A trading pass-through never touched our weighbridge, and a line with no
    // received figure has not been unloaded yet -- nothing to judge in either.
    applies: isFor && line.received_qty != null && dispatched > 0 && Number(line.is_trading) !== 1,
    dispatched,
    received,
    shortage,
    pct,
    basis,
    allowedQty,
    excessQty,
    rate,
    deductible: excessQty * rate,
    freightRate,
    freightForgone: shortage * freightRate,
    within: excessQty <= 0.0000005
  }
}

export const BASIS_LABEL: Record<ShortageBasis, string> = {
  invoice: 'agreed on this invoice',
  bargain: 'from the sales bargain',
  default: "the mill's standing default"
}
