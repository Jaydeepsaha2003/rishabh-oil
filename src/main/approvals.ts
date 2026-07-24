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
  'packagings'
])

// Look up the acting user's role from the DB (don't trust the renderer). No
// acting user = system/seed path → treated as admin so seeding isn't gated.
async function actingIsAdmin(): Promise<boolean> {
  const u = getCurrentUser()
  if (!u.id) return true
  const r = await getClient().execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [u.id] })
  return r.rows.length ? String(r.rows[0].role) === 'admin' : false
}

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
  return { pending: true, requestId: Number(res.lastInsertRowid) }
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
  return { id, createdId: created.id }
}

// Reject: record the reason (shown back to the requester).
export async function rejectRequest(id: number, reason: string): Promise<{ id: number }> {
  await assertAdmin()
  const clean = String(reason || '').trim()
  if (!clean) throw new Error('A reason is required to reject')
  await loadPending(id)
  const u = getCurrentUser()
  await getClient().execute({
    sql: `UPDATE approval_requests SET status = 'rejected', decided_by = ?, decided_by_name = ?,
          decided_at = datetime('now'), reason = ? WHERE id = ?`,
    args: [u.id ?? null, u.username || null, clean, id]
  })
  return { id }
}
