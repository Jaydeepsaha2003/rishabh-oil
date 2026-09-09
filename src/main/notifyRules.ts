// The catalogue of things the app can tell you about.
//
// One entry per event, and the entry is the whole definition: what it is
// called, what it means, whether it is on by default, how severe it is, the
// number that governs it, and who hears it. The settings page renders itself
// from this list and the engine evaluates from the same list, so an event
// cannot exist in one and not the other, and adding a new one is adding a row
// here plus its evaluate().
//
// IN-APP ONLY. There is deliberately no channel concept — no email, no SMS, no
// messaging. Every notification lands on the bell and nowhere else. If that
// ever changes it changes here, once.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type Severity = 'critical' | 'warning' | 'normal'
/**
 * Who a notification reaches.
 *
 * `access` is the useful one and the reason the other two are not enough:
 * a Treasury alert should reach the people who work in Treasury, which is
 * neither "every admin" (too narrow — the treasury clerk is not one) nor
 * "everyone" (too wide — the gate supervisor has no use for an LC expiring).
 * It resolves against the same module permissions that decide whether the
 * page is even visible to them, so the two can never disagree.
 */
export type Audience = 'admins' | 'everyone' | 'access'

/** A notification the engine is asked to raise. */
export type Candidate = {
  /** Stable per real-world fact, so re-running cannot duplicate it. */
  dedupe: string
  title: string
  body: string
  /** Page to open when it is clicked. */
  page?: string
  /** Overrides the rule's severity where one instance is worse than another. */
  severity?: Severity
  /**
   * The exact people this ONE fact concerns, overriding the rule's audience.
   *
   * Some facts are inherently personal — "the supplier you added was approved"
   * belongs to whoever added it and to nobody else. Without this the audience
   * would have to be Everyone, and the whole desk would read about each
   * other's submissions.
   */
  recipients?: number[]
}

export type ThresholdSpec = {
  /** Shown before the box, e.g. LEAD. */
  label: string
  /** Shown after it, e.g. "days before". */
  unit: string
  def: number
  min?: number
  max?: number
  step?: number
}

export type RuleDef = {
  key: string
  module: 'approvals' | 'treasury' | 'purchase' | 'sales' | 'stock'
  label: string
  desc: string
  severity: Severity
  enabled: boolean
  audience: Audience
  threshold?: ThresholdSpec
  /** Where clicking one of these should take you. */
  page?: string
  /**
   * Reads the books and returns what is true right now. Pure: it must not
   * write, and it must return the same set for the same data so the dedupe
   * key holds. Omitted for a rule the engine does not poll — an event rule
   * that is raised at the moment something is saved instead.
   */
  evaluate?: (ctx: RuleCtx) => Promise<Candidate[]>
}

export type RuleCtx = {
  /** The rule's threshold, already resolved from the saved setting or default. */
  threshold: number
  companyId: number
  today: string
}

// A rule's module named the way the PERMISSION system names it. They differ
// in one place — purchases are 'orders' to the access list — and getting that
// wrong would silently send nothing to anybody.
export const MODULE_PERM: Record<RuleDef['module'], string> = {
  approvals: 'approvals',
  treasury: 'treasury',
  purchase: 'orders',
  sales: 'sales',
  stock: 'stock'
}

export const MODULE_LABEL: Record<RuleDef['module'], string> = {
  approvals: 'Approvals',
  treasury: 'Treasury',
  purchase: 'Purchases',
  sales: 'Sales',
  stock: 'Stock'
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  normal: 'Normal'
}

export const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export const inr = (v: unknown): string =>
  `₹${(Math.round(n(v) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const num3 = (v: unknown): string =>
  (Math.round(n(v) * 1000) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })

export const ddmmyyyy = (iso: unknown): string => String(iso || '').slice(0, 10).split('-').reverse().join('-')

export const daysBetween = (fromISO: string, toISO: string): number => {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

/** Rows out of a libSQL result, without dragging the client's types in here. */
export const plain = (res: { columns: string[]; rows: unknown[] }): Row[] =>
  res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as Row)[col]
    return o
  })
