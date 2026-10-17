import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/** An NBFC discounting line, or a bank's LC line. */
export type FacilityKind = 'nbfc' | 'bank'

/**
 * WHAT A LIMIT IS TODAY IS NOT THE INTERESTING QUESTION.
 *
 * Both facilities held one number and nothing else: nbfcs.sanctioned_limit and
 * bank_lc_limits.fixed_limit, each overwritten in place. So a line that went
 * from 3 crore to 3.5 and back to 3.25 read, at every point, as though it had
 * always been whatever it was last saved as. There was no way to answer when it
 * was raised, by how much, or on whose sanction — and those are the questions
 * asked when the next enhancement is being negotiated.
 *
 * Every change now leaves a dated row behind, whether it came from the limit
 * screen, from the master, or from someone adding a new sanction outright. The
 * current figure still lives where it always did, so nothing that reads a limit
 * had to change; this sits beside it and remembers.
 *
 * Deliberately one table for both sides. An NBFC line and a bank's LC line are
 * the same object to the person tracking them — a sanctioned amount that moves
 * on a date for a reason — and two tables would mean two of everything above
 * them for no difference anybody can name.
 */
export async function ensureFacilityLimitLog(): Promise<void> {
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS facility_limit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    field TEXT NOT NULL DEFAULT 'sanctioned',
    old_amount REAL,
    new_amount REAL NOT NULL DEFAULT 0,
    effective_date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  await c
    .execute(
      'CREATE INDEX IF NOT EXISTS idx_facility_limit_log ON facility_limit_log(company_id, kind, ref_id)'
    )
    .catch(() => {})
}

/**
 * Record a limit moving, wherever it moved from.
 *
 * Never throws into its caller: a facility's limit having been saved is the
 * thing that matters, and losing the save because the note about it could not
 * be written would be the wrong way round. A change of nothing is not recorded
 * — saving a screen without touching the figure is not an event.
 */
export async function logLimitChange(v: {
  kind: FacilityKind
  refId: number
  field?: string
  oldAmount?: number | null
  newAmount: number
  effectiveDate?: string | null
  note?: string | null
  companyId?: number
}): Promise<void> {
  try {
    const before = v.oldAmount == null ? null : round2(n(v.oldAmount))
    const after = round2(n(v.newAmount))
    if (before != null && Math.abs(after - before) < 0.005) return
    await getClient().execute({
      sql: `INSERT INTO facility_limit_log
              (company_id, kind, ref_id, field, old_amount, new_amount, effective_date, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        v.companyId || getActiveCompanyId(),
        v.kind,
        n(v.refId),
        String(v.field || 'sanctioned'),
        before,
        after,
        String(v.effectiveDate || todayISO()).slice(0, 10),
        v.note ? String(v.note).trim() : null
      ]
    })
  } catch (e) {
    console.error('[limits] could not record the change:', (e as Error).message)
  }
}

/** The current sanctioned figure on a facility, whichever kind it is. */
async function currentLimit(kind: FacilityKind, refId: number, cid: number): Promise<number> {
  const c = getClient()
  if (kind === 'nbfc') {
    const r = await c.execute({
      sql: 'SELECT COALESCE(sanctioned_limit, 0) AS v FROM nbfcs WHERE id = ? AND company_id = ? LIMIT 1',
      args: [refId, cid]
    })
    if (!r.rows.length) throw new Error('That NBFC is not in this company')
    return round2(n(r.rows[0].v))
  }
  const own = await c.execute({ sql: 'SELECT company_id FROM banks WHERE id = ? LIMIT 1', args: [refId] })
  if (!own.rows.length) throw new Error('That bank no longer exists')
  if (n(own.rows[0].company_id) !== cid) throw new Error('That bank belongs to a different company')
  const r = await c.execute({
    sql: 'SELECT COALESCE(fixed_limit, 0) AS v FROM bank_lc_limits WHERE bank_id = ? AND company_id = ? LIMIT 1',
    args: [refId, cid]
  })
  return r.rows.length ? round2(n(r.rows[0].v)) : 0
}

/**
 * A NEW SANCTION, ADDED RATHER THAN TYPED OVER.
 *
 * The master field is still where the current figure lives, so this writes it;
 * what it adds is that the move itself is kept — from what, to what, on which
 * date, and why. An enhancement entered this way answers "when did we get it"
 * a year later, which editing a box never could.
 */
export async function addLimitRevision(v: {
  kind?: string
  ref_id?: number | string
  amount?: number | string
  effective_date?: string | null
  note?: string | null
}): Promise<{ from: number; to: number; delta: number }> {
  const c = getClient()
  const cid = getActiveCompanyId()
  const kind: FacilityKind = String(v.kind) === 'bank' ? 'bank' : 'nbfc'
  const refId = n(v.ref_id)
  if (!refId) throw new Error(kind === 'bank' ? 'Pick the bank' : 'Pick the NBFC')
  const amount = round2(n(v.amount))
  if (amount < 0) throw new Error('A sanctioned limit cannot be negative')
  const date = String(v.effective_date || todayISO()).slice(0, 10)
  if (date > todayISO()) {
    // A sanction dated ahead would read as today's drawing power while the
    // paper it rests on has not been signed.
    throw new Error('The effective date cannot be in the future')
  }
  const from = await currentLimit(kind, refId, cid)
  if (Math.abs(amount - from) < 0.005) {
    throw new Error('That is the limit already — enter the new sanctioned figure')
  }
  if (kind === 'nbfc') {
    await c.execute({
      sql: 'UPDATE nbfcs SET sanctioned_limit = ? WHERE id = ? AND company_id = ?',
      args: [amount, refId, cid]
    })
  } else {
    await c.execute({
      sql: `INSERT INTO bank_lc_limits (company_id, bank_id, fixed_limit, convertible_limit, convertible_enabled, updated_at)
            VALUES (?, ?, ?, 0, 0, datetime('now'))
            ON CONFLICT(company_id, bank_id) DO UPDATE SET
              fixed_limit = excluded.fixed_limit,
              updated_at = excluded.updated_at`,
      args: [cid, refId, amount]
    })
  }
  await logLimitChange({
    kind,
    refId,
    field: 'sanctioned',
    oldAmount: from,
    newAmount: amount,
    effectiveDate: date,
    note: v.note ?? null,
    companyId: cid
  })
  return { from, to: amount, delta: round2(amount - from) }
}

/**
 * The whole story of one facility's limit, newest first.
 *
 * For an NBFC the principal repayments are folded in, because they move the
 * limit as surely as a sanction does and a timeline that showed only half the
 * movements would be worse than none — it would look complete. They are marked
 * as what they are, so an enhancement and a step-down never read alike.
 */
export async function listLimitHistory(kind?: string, refId?: number): Promise<Row[]> {
  const cid = getActiveCompanyId()
  const k: FacilityKind = String(kind) === 'bank' ? 'bank' : 'nbfc'
  const id = n(refId)
  if (!id) return []
  const c = getClient()
  const rows: Row[] = toPlain(
    await c.execute({
      sql: `SELECT id, field, old_amount, new_amount, effective_date, note, created_at
              FROM facility_limit_log
             WHERE company_id = ? AND kind = ? AND ref_id = ?`,
      args: [cid, k, id]
    })
  ).map((r) => ({
    id: n(r.id),
    kind: 'sanction',
    field: String(r.field || 'sanctioned'),
    old_amount: r.old_amount == null ? null : round2(n(r.old_amount)),
    new_amount: round2(n(r.new_amount)),
    delta: r.old_amount == null ? null : round2(n(r.new_amount) - n(r.old_amount)),
    effective_date: String(r.effective_date || '').slice(0, 10),
    note: r.note ? String(r.note) : null,
    created_at: String(r.created_at || '')
  }))

  if (k === 'nbfc') {
    // The table arrives with the principal-repayment feature; a database that
    // has not met it yet simply has no step-downs to show.
    const cuts = await c
      .execute({
        sql: `SELECT lr.id, lr.amount, lr.reduce_date, lr.note, lr.created_at, bd.bd_no
                FROM bd_limit_reductions lr
                LEFT JOIN bill_discountings bd ON bd.id = lr.bd_id
               WHERE lr.company_id = ? AND lr.nbfc_id = ?`,
        args: [cid, id]
      })
      .then(toPlain)
      .catch(() => [] as Row[])
    for (const r of cuts) {
      rows.push({
        id: n(r.id),
        kind: 'principal',
        field: 'principal',
        old_amount: null,
        new_amount: null,
        delta: -round2(n(r.amount)),
        effective_date: String(r.reduce_date || '').slice(0, 10),
        note: [r.bd_no ? `entered on ${String(r.bd_no)}` : '', r.note ? String(r.note) : '']
          .filter(Boolean)
          .join(' · '),
        created_at: String(r.created_at || '')
      })
    }
  }
  // Newest first, and within a day the later entry first — two sanctions on
  // one date are still in the order they were made.
  rows.sort((a, b) => {
    const d = String(b.effective_date).localeCompare(String(a.effective_date))
    return d !== 0 ? d : String(b.created_at).localeCompare(String(a.created_at))
  })
  return rows
}

/** Undo a sanction row. The figure it set is left alone — see the note in the UI. */
export async function deleteLimitRevision(id: number): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'DELETE FROM facility_limit_log WHERE id = ? AND company_id = ?',
    args: [id, getActiveCompanyId()]
  })
  return { id }
}
