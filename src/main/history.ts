// What changed on a record, field by field.
// -----------------------------------------------------------------------------
// The activity log next door (user_logs) answers "who touched this, and when".
// It cannot answer the question that actually gets asked a month later: WHAT did
// they change it from? A rate corrected from 1,30,000 to 1,27,000 and a rate
// corrected the other way look identical in an activity log, and the invoices
// that were raised in between are argued about on memory.
//
// So every field that carries money, quantity or identity is diffed on save and
// the pair is kept. One row per field, not per save: a save that moved the rate
// and nothing else leaves one line saying so, rather than a blob nobody reads.
//
// Nothing here can refuse a save. A history that blocks the work it records
// would be turned off inside a week — every write is best-effort and its
// failure is logged to the console, never thrown.
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type FieldSpec = { key: string; label: string; kind?: 'money' | 'qty' | 'text' }

/** The fields worth keeping a history of on a purchase invoice. */
export const ORDER_FIELDS: FieldSpec[] = [
  { key: 'invoice_no', label: 'Invoice no' },
  { key: 'order_date', label: 'Purchase date' },
  { key: 'company_id', label: 'Booked into company' },
  { key: 'supplier_id', label: 'Supplier' },
  { key: 'ordered_qty', label: 'Quantity', kind: 'qty' },
  { key: 'bargain_rate', label: 'Bargain rate', kind: 'money' },
  { key: 'invoice_rate', label: 'Invoice rate', kind: 'money' },
  { key: 'adjusted_rate', label: 'Adjusted rate', kind: 'money' },
  { key: 'additional_interest', label: 'Additional interest', kind: 'money' },
  { key: 'interest_pct', label: 'Interest %' },
  { key: 'interest_days', label: 'Interest days' },
  { key: 'rate_round_off', label: 'Rate adjustment', kind: 'money' },
  { key: 'gst_pct', label: 'GST %' },
  { key: 'gst_type', label: 'GST type' },
  { key: 'tds_pct', label: 'TDS %' },
  { key: 'taxable_value', label: 'Taxable value', kind: 'money' },
  { key: 'net_amount', label: 'Net amount', kind: 'money' },
  { key: 'round_off', label: 'Round off', kind: 'money' },
  { key: 'remarks', label: 'Remarks', kind: 'text' }
]

/** The same, for a purchase bargain. */
export const BARGAIN_FIELDS: FieldSpec[] = [
  { key: 'bargain_no', label: 'Bargain no' },
  { key: 'bargain_date', label: 'Bargain date' },
  { key: 'supplier_id', label: 'Supplier' },
  { key: 'oil_type_id', label: 'Product' },
  { key: 'bargain_type', label: 'Condition' },
  { key: 'qty', label: 'Quantity', kind: 'qty' },
  { key: 'uom', label: 'Unit' },
  { key: 'rate_per_uom', label: 'Bargain rate', kind: 'money' },
  { key: 'base_rate', label: 'Base rate', kind: 'money' },
  { key: 'duty', label: 'Duty', kind: 'money' },
  { key: 'rate_expiry_date', label: 'Rate expiry' },
  { key: 'allowed_shortage_pct', label: 'Allowed shortage %' },
  { key: 'broker_id', label: 'Broker' },
  { key: 'remarks', label: 'Remarks', kind: 'text' }
]

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// A value as it will be read back. Numbers are compared as numbers — 130000 and
// "130000.00" are the same rate and must not read as a change — and everything
// else on its trimmed string.
function shown(v: unknown, kind?: string): string {
  if (v == null || v === '') return '—'
  if (kind === 'money' || kind === 'qty') {
    const x = n(v)
    return kind === 'qty' ? String(Math.round(x * 1000) / 1000) : String(Math.round(x * 100) / 100)
  }
  return String(v).trim()
}

function same(a: unknown, b: unknown, kind?: string): boolean {
  if (kind === 'money' || kind === 'qty') {
    const tol = kind === 'qty' ? 0.0005 : 0.005
    return Math.abs(n(a) - n(b)) < tol
  }
  const x = a == null ? '' : String(a).trim()
  const y = b == null ? '' : String(b).trim()
  return x === y
}

/**
 * Diff two versions of a record and keep whatever moved.
 *
 * `after` may be a partial: a field absent from it was not part of the save and
 * is left alone, rather than being recorded as a change to nothing.
 */
export async function recordChanges(
  entity: string,
  entityId: number,
  entityKey: string,
  before: Row | null,
  after: Row | null,
  spec: FieldSpec[],
  action = 'updated'
): Promise<void> {
  try {
    const rows: { field: string; label: string; from: string; to: string }[] = []
    for (const f of spec) {
      const had = before ? before[f.key] : null
      const has = after ? after[f.key] : undefined
      if (after && !(f.key in after)) continue
      if (same(had, has, f.kind)) continue
      rows.push({ field: f.key, label: f.label, from: shown(had, f.kind), to: shown(has, f.kind) })
    }
    // A save that changed nothing leaves nothing behind. Creation and deletion
    // are events in their own right and are kept even with no field to show.
    if (!rows.length && action === 'updated') return
    const u = getCurrentUser()
    const c = getClient()
    if (!rows.length) {
      await c.execute({
        sql: `INSERT INTO change_log (entity, entity_id, entity_key, action, field, label, old_value, new_value,
                                      changed_by, changed_by_name, company_id)
              VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        args: [entity, entityId, entityKey, action, u.id, u.username, getActiveCompanyId()]
      })
      return
    }
    for (const r of rows) {
      await c.execute({
        sql: `INSERT INTO change_log (entity, entity_id, entity_key, action, field, label, old_value, new_value,
                                      changed_by, changed_by_name, company_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [entity, entityId, entityKey, action, r.field, r.label, r.from, r.to, u.id, u.username, getActiveCompanyId()]
      })
    }
  } catch (e) {
    // Never at the cost of the save itself — see the note at the top.
    console.error('[history] could not record a change:', (e as Error).message)
  }
}

/** Everything kept about one record, newest first. */
export async function listChanges(entity: string, entityId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT id, entity, entity_id, entity_key, action, field, label, old_value, new_value,
                 changed_by, changed_by_name, changed_at
          FROM change_log
          WHERE entity = ? AND entity_id = ?
          ORDER BY changed_at DESC, id DESC
          LIMIT 400`,
    args: [entity, Number(entityId)]
  })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}
