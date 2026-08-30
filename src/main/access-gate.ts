// The write gate. Every non-read channel passes through here before it runs, so
// a permission is a control rather than a hidden button.
//
// Deliberately FAIL-OPEN for anything not listed in CHANNEL_RULES: an unmapped
// channel behaves exactly as it did before. That is what makes it safe to extend
// the map one entity at a time instead of gating everything at once and
// discovering a legitimate edit is now impossible.
import { getClient, todayISO } from './db'
import { getBooksFrom } from './openings'
import { getCurrentUser } from './currentUser'
import {
  can,
  moduleScope,
  modulePerm,
  windowStart,
  viewDays,
  entryDays,
  type Action,
  type AccessUser
} from './access-rules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface Rule {
  // Permission key, matching the module keys the Users page grants.
  module: string
  label: string
  // Where to read the entry's own date from, for the read-only window. Omitted
  // for entities with no business date of their own.
  table?: string
  dateCol?: string
}

// channel namespace -> what it belongs to. The namespace is the part before ':'.
const CHANNEL_RULES: Record<string, Rule> = {
  // module keys MUST match MODULES in src/renderer/src/lib/modules.ts — a key
  // that is not grantable there would read as "no access" and refuse every
  // write. Namespaces with no grantable module are left out on purpose so they
  // keep working exactly as before.
  orders: { module: 'orders', label: 'Purchases', table: 'orders', dateCol: 'order_date' },
  tankers: { module: 'orders', label: 'Purchases', table: 'purchase_tankers', dateCol: 'loaded_date' },
  bargains: { module: 'bargains', label: 'Purchase bargains', table: 'bargains', dateCol: 'bargain_date' },
  sales: { module: 'sales', label: 'Sales', table: 'sales', dateCol: 'sale_date' },
  salesBargains: {
    module: 'salesBargains',
    label: 'Sales bargains',
    table: 'sales_bargains',
    dateCol: 'bargain_date'
  },
  consignment: {
    module: 'consignment',
    label: 'Consignment stock',
    table: 'consignment_stock',
    dateCol: 'deposit_date'
  },
  gate: { module: 'gateEntry', label: 'Gate entries', table: 'gate_entries', dateCol: 'entry_date' },
  payments: { module: 'payments', label: 'Payments', table: 'payments', dateCol: 'payment_date' },
  billDiscounts: { module: 'payments', label: 'Bill discounts' },
  production: { module: 'production', label: 'Production', table: 'production', dateCol: 'prod_date' },
  // One table behind two menus; the Debit note grant governs both.
  notes: { module: 'debitNotes', label: 'Debit/Credit notes', table: 'notes', dateCol: 'note_date' },
  trading: { module: 'trading', label: 'Trading', table: 'trading_deals', dateCol: 'deal_date' },
  stockCount: { module: 'stock', label: 'Stock' },
  skuStock: { module: 'stock', label: 'Stock' },
  formulations: { module: 'formulation', label: 'Formulations' }
}

// Reads are never gated here, whatever the caller passes. ipc.ts already filters
// them out, but a read channel that ever slipped past that regex must not be
// mistaken for an edit and start refusing.
const READ_OPS = new Set([
  'list', 'get', 'items', 'issuances', 'sheet', 'outstanding', 'all', 'summary', 'transfers',
  'fyTaxable', 'needs', 'breakdown', 'nextNo', 'liveUsers', 'ips', 'logs', 'dispatchableSales',
  'mine', 'pendingCount', 'pending', 'lots', 'unmapped', 'unmappedCount', 'bargainLines',
  'consignmentDraws', 'accounts', 'statement', 'suppliers', 'transporters', 'customers',
  'returns', 'unattributedReturns'
])

// What the operation amounts to. Anything that changes an existing row counts as
// an edit, so advancing a stage or adjusting a quantity is gated like one.
function actionFor(op: string): Action {
  if (op === 'create' || op === 'record' || op === 'issue' || op === 'transfer' || op === 'createInvoice') return 'create'
  if (op === 'delete' || op === 'remove' || op === 'removeInvoice' || op === 'deleteEntry' || op === 'deleteTransfer' ||
      op === 'deleteIssuance' || op === 'removeIssuance') return 'delete'
  return 'edit'
}

// The signed-in user's role and permissions. Cached per user id and cleared
// whenever the Users page saves, so a permission change takes effect at once.
let cache: { id: number; user: AccessUser } | null = null
export function clearAccessCache(): void {
  cache = null
}

async function currentAccessUser(): Promise<AccessUser | null> {
  const { id } = getCurrentUser()
  if (!id) return null // not signed in through the app (harness, first run)
  if (cache && cache.id === id) return cache.user
  const res = await getClient().execute({
    sql: 'SELECT role, permissions, active FROM users WHERE id = ? LIMIT 1',
    args: [id]
  })
  if (!res.rows.length) return null
  const r = res.rows[0] as Row
  let permissions: unknown = {}
  try {
    permissions = r.permissions ? JSON.parse(String(r.permissions)) : {}
  } catch {
    permissions = {}
  }
  const user: AccessUser = { role: String(r.role || ''), permissions }
  cache = { id, user }
  return user
}

// The earliest date this user may SEE in a module, or null for no limit.
//
// Enforced HERE, in the query, and never in the page — a row filtered in the
// renderer has already crossed the wire, which is no restriction at all.
//
// This bounds a LIST, and must not be used to bound a figure. A user given a
// seven-day window still owes the full stock balance, the full outstanding, the
// full KPI; those are computed from every row and only the register they read
// is shortened. Bounding a total by the reader's window would not shorten it,
// it would make it wrong.
//
// An admin, an unknown user (harness, first run) and a module with no visible
// window set are all unlimited.
export async function visibleFrom(moduleKey: string): Promise<string | null> {
  const user = await currentAccessUser()
  if (!user) return null
  const days = viewDays(user, moduleKey)
  if (days == null) return null
  return windowStart(days, todayISO())
}

// The same window, handed to the renderer: the earliest date each module's
// forms may offer. A date picker that presents a day the save is going to
// refuse is a trap, so the pages ask once and set it as the minimum.
//
// This is a courtesy to the user, NOT the control — the control is `can()`,
// which refuses the write whatever the form sent. Keyed by module, so one call
// answers for every page instead of one call per page.
export async function entryWindows(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const user = await currentAccessUser()
  if (!user) return out
  if (String(user.role || '').toLowerCase() === 'admin') return out
  const perms = user.permissions
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return out
  const today = todayISO()
  for (const key of Object.keys(perms as Record<string, unknown>)) {
    const days = entryDays(user, key)
    if (days != null) out[key] = windowStart(days, today)
  }
  return out
}

// The visible window for a list channel that serves more than one page.
//
// `sales:list` is read by the Sales register, but also by Accounts and Treasury,
// which reconcile money against it. Bounding those two by the SALES window would
// not shorten their pages — it would make their figures wrong, quietly, for one
// user only. So the caller names the module it is actually rendering and the
// bound comes from THAT module's window.
//
// The escape hatch cannot be used to widen anything: naming a module the user
// has no view rights on falls straight back to the owning module's window. A
// user who cannot open Treasury gains nothing by claiming to be it.
export async function visibleFromFor(ownModule: string, callerModule?: string): Promise<string | null> {
  if (!callerModule || callerModule === ownModule) return visibleFrom(ownModule)
  const user = await currentAccessUser()
  if (!user) return null
  if (!modulePerm(user, callerModule).view) return visibleFrom(ownModule)
  return visibleFrom(callerModule)
}

// The narrowed job the signed-in user holds in a module, for the readers that
// have to hand back less than the full row set. Null for an admin, for a user
// the app does not know (harness, first run), or for an unrestricted grant.
export async function currentScope(moduleKey: string): Promise<string | null> {
  const user = await currentAccessUser()
  if (!user) return null
  return moduleScope(user, moduleKey)
}

// An entry dated before the books begin would land nowhere at all — the ledger
// starts after it, and the opening balance that covers that period was entered
// by hand. So it is refused for EVERYONE, admin included: this is not a
// permission, it is a statement about which period these books cover.
async function assertOnOrAfterBooksStart(rule: Rule, op: string, args: unknown): Promise<void> {
  if (!rule.dateCol) return
  if (actionFor(op) !== 'create') return
  const a = args as Row
  const raw = a?.values?.[rule.dateCol] ?? a?.[rule.dateCol]
  const d = String(raw ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return
  const from = await getBooksFrom()
  if (!from || d >= from) return
  throw new Error(
    `These books begin on ${from}. An entry dated ${d} falls before that, where the opening balances already account for it — it would be counted twice.`
  )
}

// The unload desk may record exactly one thing: that a delivery arrived, and
// what was weighed in. Everything else on the sales channel is refused here, so
// the restriction is a control and not a hidden button.
function assertScopedSales(op: string, args: unknown): void {
  const stage = String((args as Row)?.stage || '')
  const isUnload = (op === 'setInvoiceStage' || op === 'setStage') && stage === 'unloaded'
  if (!isUnload) {
    throw new Error(
      'Your access to Sales covers recording received quantities on deliveries only — nothing else on this page can be changed.'
    )
  }
}

// Throws with a sentence the renderer shows verbatim. Returns quietly when the
// channel is unmapped, the user is unknown, or the action is allowed.
export async function assertAllowed(channel: string, args: unknown): Promise<void> {
  const [ns, op] = String(channel).split(':')
  const rule = CHANNEL_RULES[ns]
  if (!rule || !op) return
  if (READ_OPS.has(op)) return
  await assertOnOrAfterBooksStart(rule, op, args)
  const user = await currentAccessUser()
  if (!user) return
  if (user.role === 'admin') return

  // A narrowed job answers the whole question on its own — the ordinary
  // per-action rights below would let an 'edit' grant through everything.
  if (moduleScope(user, rule.module) === 'unload' && rule.module === 'sales') {
    assertScopedSales(op, args)
    return
  }

  const action = actionFor(op)
  // The row's own date decides the read-only window; without one, only the
  // right itself is checked.
  let entryDate: unknown
  const id = Number((args as Row)?.id) || 0
  // For a create there is no row yet, so the date being written IS the date to
  // judge. It arrives on the values object under its own column name.
  if (action === 'create' && rule.dateCol) {
    const a = args as Row
    entryDate = a?.values?.[rule.dateCol] ?? a?.[rule.dateCol]
  }
  if ((action === 'edit' || action === 'delete') && rule.table && rule.dateCol && id) {
    try {
      const res = await getClient().execute({
        sql: `SELECT ${rule.dateCol} AS d FROM ${rule.table} WHERE id = ? LIMIT 1`,
        args: [id]
      })
      entryDate = res.rows[0]?.d
    } catch {
      // A table without that column must never block the write.
      entryDate = undefined
    }
  }
  const verdict = can(user, rule.module, action, {
    entryDate,
    today: todayISO(),
    moduleLabel: rule.label
  })
  if (!verdict.allowed) throw new Error(verdict.reason || 'You are not allowed to do that')
}
