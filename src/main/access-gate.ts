// The write gate. Every non-read channel passes through here before it runs, so
// a permission is a control rather than a hidden button.
//
// Deliberately FAIL-OPEN for anything not listed in CHANNEL_RULES: an unmapped
// channel behaves exactly as it did before. That is what makes it safe to extend
// the map one entity at a time instead of gating everything at once and
// discovering a legitimate edit is now impossible.
import { getClient } from './db'
import { getCurrentUser } from './currentUser'
import { can, type Action, type AccessUser } from './access-rules'

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
  production: { module: 'production', label: 'Production', table: 'production', dateCol: 'production_date' },
  // One table behind two menus; the Debit note grant governs both.
  notes: { module: 'debitNotes', label: 'Debit/Credit notes', table: 'notes', dateCol: 'note_date' },
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
  'consignmentDraws', 'accounts', 'statement', 'suppliers', 'transporters', 'customers'
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Throws with a sentence the renderer shows verbatim. Returns quietly when the
// channel is unmapped, the user is unknown, or the action is allowed.
export async function assertAllowed(channel: string, args: unknown): Promise<void> {
  const [ns, op] = String(channel).split(':')
  const rule = CHANNEL_RULES[ns]
  if (!rule || !op) return
  if (READ_OPS.has(op)) return
  const user = await currentAccessUser()
  if (!user) return
  if (user.role === 'admin') return

  const action = actionFor(op)
  // The row's own date decides the read-only window; without one, only the
  // right itself is checked.
  let entryDate: unknown
  const id = Number((args as Row)?.id) || 0
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
