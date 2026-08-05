import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Sanctioned facilities with everything committed against them broken out:
//   available = sanctioned − LCs drawn under it − other named outstanding
// Both components are returned, not just the net, because the notes are
// explicit that the figures making up total outstanding must stay visible.
export async function listFacilities(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT f.*,
            COALESCE((SELECT SUM(l.amount - COALESCE((SELECT SUM(r.amount) FROM lc_repayments r
                       WHERE r.lc_id = l.id AND r.posted = 1), 0)) FROM letters_of_credit l
                       WHERE l.facility_id = f.id AND l.status != 'closed'), 0) AS lc_committed,
            COALESCE((SELECT SUM(i.amount) FROM lc_issuances i
                       JOIN letters_of_credit l2 ON l2.id = i.lc_id
                      WHERE l2.facility_id = f.id), 0) AS lc_utilized,
            COALESCE((SELECT SUM(e.amount) FROM facility_exposures e
                       WHERE e.facility_id = f.id AND e.kind = 'outstanding'), 0) AS other_outstanding,
            COALESCE((SELECT SUM(e.amount) FROM facility_exposures e
                       WHERE e.facility_id = f.id AND e.kind = 'planned'), 0) AS planned
          FROM bank_facilities f
          WHERE f.company_id = ?
          ORDER BY f.active DESC, f.name`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res).map((f) => {
    const committed = n(f.lc_committed) + n(f.other_outstanding)
    return {
      ...f,
      total_outstanding: committed,
      available: n(f.sanctioned_limit) - committed,
      // What would be left if everything currently planned were also drawn.
      available_after_planned: n(f.sanctioned_limit) - committed - n(f.planned)
    }
  })
}

// The named lines behind one facility's outstanding / planned figures.
export async function listFacilityExposures(facilityId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: 'SELECT * FROM facility_exposures WHERE facility_id = ? ORDER BY kind, id',
    args: [facilityId]
  })
  return toPlain(res)
}

const FACILITY_COLS = ['name', 'bank', 'facility_type', 'sanctioned_limit', 'sanction_date', 'review_date', 'note', 'active']

// Columns the table declares NOT NULL need a real value even when the form
// leaves them blank — passing null there fails the constraint instead of
// falling back to the schema default.
const FACILITY_FALLBACK: Record<string, string | number> = {
  facility_type: 'lc',
  sanctioned_limit: 0,
  active: 1
}

function facilityArgs(v: Row): (string | number | null)[] {
  return FACILITY_COLS.map((k) => {
    const val = v[k]
    if (val === '' || val === undefined || val === null) return FACILITY_FALLBACK[k] ?? null
    if (k === 'sanctioned_limit') return n(val)
    if (k === 'active') return val ? 1 : 0
    return String(val)
  })
}

export async function createFacility(v: Row): Promise<{ id: number }> {
  if (!String(v.name || '').trim()) throw new Error('Give the facility a name')
  if (!String(v.bank || '').trim()) throw new Error('Name the bank')
  const res = await getClient().execute({
    sql: `INSERT INTO bank_facilities (company_id, ${FACILITY_COLS.join(', ')})
          VALUES (?, ${FACILITY_COLS.map(() => '?').join(', ')})`,
    args: [getActiveCompanyId(), ...facilityArgs(v)]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateFacility(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: `UPDATE bank_facilities SET ${FACILITY_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...facilityArgs(v), id]
  })
  return { id }
}

export async function deleteFacility(id: number): Promise<{ id: number }> {
  const c = getClient()
  // An LC still pointing here would be orphaned, so say so by name rather
  // than letting the reference dangle.
  const lc = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM letters_of_credit WHERE facility_id = ?', args: [id] })
  if (n(lc.rows[0].n) > 0) {
    throw new Error(
      `${n(lc.rows[0].n)} LC(s) draw against this facility — unlink them first, or switch the facility off instead so its history stays.`
    )
  }
  await c.execute({ sql: 'DELETE FROM facility_exposures WHERE facility_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM bank_facilities WHERE id = ?', args: [id] })
  return { id }
}

export async function saveExposure(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const facilityId = n(v.facility_id)
  if (!facilityId) throw new Error('Pick the facility this balance sits under')
  if (!String(v.label || '').trim()) throw new Error('Name this balance (e.g. the account it belongs to)')
  const args = [
    String(v.label).trim(),
    n(v.amount),
    String(v.kind || 'outstanding'),
    v.as_of ? String(v.as_of).slice(0, 10) : null,
    v.note ? String(v.note).trim() : null
  ]
  if (v.id) {
    await c.execute({
      sql: 'UPDATE facility_exposures SET label = ?, amount = ?, kind = ?, as_of = ?, note = ? WHERE id = ?',
      args: [...args, n(v.id)]
    })
    return { id: n(v.id) }
  }
  const res = await c.execute({
    sql: `INSERT INTO facility_exposures (facility_id, label, amount, kind, as_of, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [facilityId, ...args]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function deleteExposure(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM facility_exposures WHERE id = ?', args: [id] })
  return { id }
}

// Headroom left on a facility, and what it is made of. Used before an LC is
// opened or grown so the person can be told exactly what they would breach.
export async function facilityHeadroom(facilityId: number, excludeLcId = 0): Promise<Row> {
  const c = getClient()
  const f = await c.execute({ sql: 'SELECT * FROM bank_facilities WHERE id = ?', args: [facilityId] })
  if (!f.rows.length) throw new Error('That facility no longer exists')
  const lc = await c.execute({
    sql: `SELECT COALESCE(SUM(l.amount - COALESCE((SELECT SUM(r.amount) FROM lc_repayments r
                 WHERE r.lc_id = l.id AND r.posted = 1), 0)), 0) AS a
          FROM letters_of_credit l WHERE l.facility_id = ? AND l.status != 'closed' AND l.id != ?`,
    args: [facilityId, excludeLcId]
  })
  const other = await c.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS a FROM facility_exposures WHERE facility_id = ? AND kind = 'outstanding'",
    args: [facilityId]
  })
  const sanctioned = n(f.rows[0].sanctioned_limit)
  const lcCommitted = n(lc.rows[0].a)
  const otherOutstanding = n(other.rows[0].a)
  return {
    facility_id: facilityId,
    name: f.rows[0].name,
    sanctioned,
    lc_committed: lcCommitted,
    other_outstanding: otherOutstanding,
    total_outstanding: lcCommitted + otherOutstanding,
    available: sanctioned - lcCommitted - otherOutstanding
  }
}

