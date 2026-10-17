import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getCurrentUser } from './currentUser'
import { create as repoCreate } from './repos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// Master tables whose CREATION needs admin approval when done by a non-admin.
// (Companies and users are managed by admins only, so they aren't listed.)
const APPROVAL_TABLES = new Set([
  'oil_types',
  'products',
  'suppliers',
  'transporters',
  'customers',
  'sources',
  'uoms',
  'brokers',
  'packagings',
  // Three that were left out and had no business being: a category, a bank
  // account and an NBFC are masters a desk can add like any other, and an
  // unreviewed one is the same problem as an unreviewed supplier — it turns
  // up in every dropdown and gets used before anybody has looked at it.
  'categories',
  'banks',
  'nbfcs'
])

// Look up the acting user's role from the DB (don't trust the renderer). No
// acting user = system/seed path → treated as admin so seeding isn't gated.
async function actingIsAdmin(): Promise<boolean> {
  const u = getCurrentUser()
  if (!u.id) return true
  const r = await getClient().execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [u.id] })
  return r.rows.length ? String(r.rows[0].role) === 'admin' : false
}

/**
 * TELL SOMEBODY. A QUEUE NOBODY IS TOLD ABOUT IS A DRAWER.
 *
 * The whole flow already worked — a non-admin's new supplier was parked
 * instead of inserted, so it never appeared on any list until an admin let it
 * through — and not one word of it was ever said out loud. The admin had to
 * think to open the Approvals page; the person who asked had no idea whether
 * anyone had looked. Both ends get a message now.
 *
 * Raised straight into `notifications` with the recipients named, which is the
 * same shape work.ts posts (see tell() there): the bell reads the named list
 * first, so this reaches exactly the people meant without needing a rule.
 */
async function notify(
  toUserIds: number[],
  title: string,
  body: string,
  tag: string
): Promise<void> {
  const ids = toUserIds.map((x) => Number(x)).filter((x) => x > 0)
  if (!ids.length) return
  await getClient()
    .execute({
      sql: `INSERT INTO notifications
              (company_id, rule_key, severity, audience, recipients, title, body, page, dedupe_key, created_at)
            VALUES ((SELECT COALESCE(MIN(id), 1) FROM companies), 'master:approval', 'normal', 'named', ?, ?, ?, 'approvals', ?, datetime('now'))
            ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO NOTHING`,
      args: [JSON.stringify(ids), title, body, `approval:${tag}`]
    })
    .catch((e) => {
      // The queue is the record; the bell is a courtesy. A message that cannot
      // be raised must never lose the request it was announcing.
      console.error('[approvals] notification failed:', (e as Error).message)
    })
}

/** Everyone who can actually decide this. */
async function adminIds(): Promise<number[]> {
  const r = await getClient().execute("SELECT id FROM users WHERE role = 'admin' AND active = 1")
  return r.rows.map((x) => Number((x as unknown as Row).id)).filter(Boolean)
}

/** What to call a table when speaking to a person about it. */
const TABLE_WORD: Record<string, string> = {
  oil_types: 'oil type',
  products: 'product',
  suppliers: 'supplier',
  transporters: 'transporter',
  customers: 'customer',
  sources: 'source',
  uoms: 'unit',
  brokers: 'broker',
  packagings: 'packed SKU',
  categories: 'category',
  banks: 'bank account',
  nbfcs: 'NBFC'
}
const wordFor = (t: string): string => TABLE_WORD[t] || String(t).replace(/_/g, ' ')

// True when this create should be parked for approval instead of inserted.
export async function needsApproval(table: string): Promise<boolean> {
  if (!APPROVAL_TABLES.has(table)) return false
  return !(await actingIsAdmin())
}

// Park a master creation on the approval queue.
export async function submitApprovalRequest(
  table: string,
  values: Row
): Promise<{ pending: true; requestId: number }> {
  const u = getCurrentUser()
  const label = String(values.name ?? values.code ?? '').trim()
  const res = await getClient().execute({
    sql: `INSERT INTO approval_requests (table_name, action, payload, label, requested_by, requested_by_name, status)
          VALUES (?, 'create', ?, ?, ?, ?, 'pending')`,
    args: [table, JSON.stringify(values), label || null, u.id ?? null, u.username || null]
  })
  const requestId = Number(res.lastInsertRowid)
  await notify(
    await adminIds(),
    `A new ${wordFor(table)} is waiting for you`,
    `${u.username || 'Somebody'} added ${label || `a ${wordFor(table)}`}. It stays off the list until you let it through.`,
    `new:${requestId}`
  )
  return { pending: true, requestId }
}

// Admin view: every request, newest first.
export async function listApprovalRequests(): Promise<Row[]> {
  const res = await getClient().execute(
    "SELECT * FROM approval_requests ORDER BY (status = 'pending') DESC, id DESC"
  )
  return toPlain(res)
}

// Requester view: only the current user's own requests.
export async function myApprovalRequests(): Promise<Row[]> {
  const u = getCurrentUser()
  if (!u.id) return []
  const res = await getClient().execute({
    sql: 'SELECT * FROM approval_requests WHERE requested_by = ? ORDER BY id DESC',
    args: [u.id]
  })
  return toPlain(res)
}

export async function pendingApprovalCount(): Promise<number> {
  const res = await getClient().execute("SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'")
  return Number(res.rows[0]?.n) || 0
}

async function assertAdmin(): Promise<void> {
  if (!(await actingIsAdmin())) throw new Error('Only an admin can decide approvals')
}

async function loadPending(id: number): Promise<Row> {
  const res = await getClient().execute({ sql: 'SELECT * FROM approval_requests WHERE id = ?', args: [id] })
  if (!res.rows.length) throw new Error('Approval request not found')
  const row = toPlain(res)[0]
  if (String(row.status) !== 'pending') throw new Error('This request has already been decided')
  return row
}

// Approve: insert the parked record into its real master table.
export async function approveRequest(id: number): Promise<{ id: number; createdId: number }> {
  await assertAdmin()
  const req = await loadPending(id)
  const values = JSON.parse(String(req.payload)) as Row
  const created = await repoCreate(String(req.table_name), values)
  const u = getCurrentUser()
  await getClient().execute({
    sql: `UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_by_name = ?,
          decided_at = datetime('now'), created_id = ? WHERE id = ?`,
    args: [u.id ?? null, u.username || null, created.id, id]
  })
  await notify(
    [Number(req.requested_by)],
    `Your ${wordFor(String(req.table_name))} was approved`,
    `${String(req.label || '').trim() || `The ${wordFor(String(req.table_name))} you added`} is on the list now.`,
    `done:${id}`
  )
  return { id, createdId: created.id }
}

// Reject: record the reason (shown back to the requester).
export async function rejectRequest(id: number, reason: string): Promise<{ id: number }> {
  await assertAdmin()
  const clean = String(reason || '').trim()
  if (!clean) throw new Error('A reason is required to reject')
  const req = await loadPending(id)
  const u = getCurrentUser()
  await getClient().execute({
    sql: `UPDATE approval_requests SET status = 'rejected', decided_by = ?, decided_by_name = ?,
          decided_at = datetime('now'), reason = ? WHERE id = ?`,
    args: [u.id ?? null, u.username || null, clean, id]
  })
  // The reason travels with it. A refusal nobody explains is one the same
  // person asks for again next week.
  await notify(
    [Number(req.requested_by)],
    `Your ${wordFor(String(req.table_name))} was not added`,
    `${String(req.label || '').trim() || `The ${wordFor(String(req.table_name))} you added`} — ${clean}`,
    `done:${id}`
  )
  return { id }
}
