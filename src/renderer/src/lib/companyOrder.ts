// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE ORDER COMPANIES ARE OFFERED IN.
//
// Set per company in Manage Companies (Priority): 1 is listed first, then 2,
// and so on. A company with no priority (blank, which the form saves as 0)
// comes after every numbered one, A–Z by name — so nothing moves until
// somebody sets a number, and a new company never jumps the queue.
const rank = (c: Row): number => {
  const p = Number(c?.priority)
  return Number.isFinite(p) && p > 0 ? p : Number.POSITIVE_INFINITY
}

export function byCompanyPriority(a: Row, b: Row): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' })
}

export function sortCompanies<T extends Row>(rows: T[]): T[] {
  return [...(Array.isArray(rows) ? rows : [])].sort(byCompanyPriority)
}
