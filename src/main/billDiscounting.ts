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

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Bill Discounting: unlike an LC, there's no stage gate — submit an invoice,
// the discounter pays out (T/T+1) on its own advice, and we just record it.
// Each party carries its own rate, finance type (PID/SID), security and
// interest terms, and a sanctioned limit that entries draw against.
//
// This tracks the facility for limit/interest/fund-flow visibility only —
// it does NOT post journal entries, since the exact Dr/Cr direction (who the
// discounter actually pays, and when the liability lands on us) depends on
// specifics not yet confirmed. Post the actual bank movement through
// Payments/Journal Voucher as usual once that's settled.
// ---------------------------------------------------------------------------

const PARTY_COLS = [
  'party_name',
  'discounter',
  'rate_pct',
  'finance_type',
  'purpose',
  'security_given',
  'interest_bearing',
  'interest_payment_schedule',
  'sanctioned_limit',
  'active',
  'note'
]

const PARTY_FALLBACK: Record<string, string | number> = {
  finance_type: 'PID',
  rate_pct: 0,
  sanctioned_limit: 0,
  security_given: 0,
  interest_bearing: 0,
  active: 1
}

function partyArgs(v: Row): (string | number | null)[] {
  return PARTY_COLS.map((k) => {
    const val = v[k]
    if (k === 'security_given' || k === 'interest_bearing') return val ? 1 : 0
    if (k === 'active') return val === undefined ? PARTY_FALLBACK.active : val ? 1 : 0
    if (k === 'rate_pct' || k === 'sanctioned_limit') return n(val)
    if (val === '' || val === undefined || val === null) return PARTY_FALLBACK[k] ?? null
    return String(val)
  })
}

export async function listBdParties(): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT p.*,
            COALESCE((SELECT SUM(e.amount) FROM bd_entries e WHERE e.bd_party_id = p.id AND e.status != 'repaid'), 0) AS outstanding,
            COALESCE((SELECT SUM(e.interest_amount) FROM bd_entries e WHERE e.bd_party_id = p.id), 0) AS total_interest,
            COALESCE((SELECT SUM(e.interest_amount) FROM bd_entries e WHERE e.bd_party_id = p.id AND e.interest_received_date IS NOT NULL), 0) AS interest_received,
            (SELECT COUNT(*) FROM bd_entries e WHERE e.bd_party_id = p.id AND e.status != 'repaid') AS open_entries
          FROM bd_parties p WHERE p.company_id = ? ORDER BY p.active DESC, p.party_name`,
    args: [getActiveCompanyId()]
  })
  return toPlain(res).map((p) => ({
    ...p,
    available: n(p.sanctioned_limit) - n(p.outstanding),
    interest_pending: n(p.total_interest) - n(p.interest_received)
  }))
}

export async function createBdParty(v: Row): Promise<{ id: number }> {
  if (!String(v.party_name || '').trim()) throw new Error('Name the party')
  const res = await getClient().execute({
    sql: `INSERT INTO bd_parties (company_id, ${PARTY_COLS.join(', ')}) VALUES (?, ${PARTY_COLS.map(() => '?').join(', ')})`,
    args: [getActiveCompanyId(), ...partyArgs(v)]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateBdParty(id: number, v: Row): Promise<{ id: number }> {
  if (!String(v.party_name || '').trim()) throw new Error('Name the party')
  await getClient().execute({
    sql: `UPDATE bd_parties SET ${PARTY_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...partyArgs(v), id]
  })
  return { id }
}

export async function deleteBdParty(id: number): Promise<{ id: number }> {
  const c = getClient()
  const entries = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM bd_entries WHERE bd_party_id = ?', args: [id] })
  if (n(entries.rows[0].n) > 0) {
    throw new Error(`${n(entries.rows[0].n)} entr${n(entries.rows[0].n) === 1 ? 'y' : 'ies'} logged against this party — delete those first, or switch the party off instead.`)
  }
  await c.execute({ sql: 'DELETE FROM bd_parties WHERE id = ?', args: [id] })
  return { id }
}

export async function listBdEntries(filter?: Row): Promise<Row[]> {
  const where: string[] = []
  const args: (string | number)[] = []
  if (filter?.bd_party_id) {
    where.push('e.bd_party_id = ?')
    args.push(n(filter.bd_party_id))
  }
  if (filter?.status) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map(String).filter(Boolean)
    if (statuses.length) {
      where.push(`e.status IN (${statuses.map(() => '?').join(',')})`)
      args.push(...statuses)
    }
  }
  const res = await getClient().execute({
    sql: `SELECT e.*, p.party_name, p.discounter, p.rate_pct, p.finance_type
          FROM bd_entries e JOIN bd_parties p ON p.id = e.bd_party_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY e.submitted_date DESC, e.id DESC`,
    args
  })
  return toPlain(res)
}

export async function createBdEntry(v: Row): Promise<{ id: number }> {
  const partyId = n(v.bd_party_id)
  if (!partyId) throw new Error('Pick the party this bill is discounted with')
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the bill amount')
  const c = getClient()

  const party = await c.execute({ sql: 'SELECT sanctioned_limit FROM bd_parties WHERE id = ?', args: [partyId] })
  if (!party.rows.length) throw new Error('Party not found')
  const outstanding = await c.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) AS a FROM bd_entries WHERE bd_party_id = ? AND status != 'repaid'",
    args: [partyId]
  })
  const sanctioned = n(party.rows[0].sanctioned_limit)
  const alreadyOut = n(outstanding.rows[0].a)
  if (sanctioned > 0 && alreadyOut + amount > sanctioned + 0.005) {
    throw new Error(`This would take outstanding to ${round2(alreadyOut + amount).toFixed(2)}, over the ${sanctioned.toFixed(2)} sanctioned limit (${round2(sanctioned - alreadyOut).toFixed(2)} available)`)
  }

  const res = await c.execute({
    sql: `INSERT INTO bd_entries (bd_party_id, invoice_no, amount, submitted_date, note)
          VALUES (?, ?, ?, ?, ?)`,
    args: [partyId, v.invoice_no ? String(v.invoice_no).trim() : null, amount, v.submitted_date ? String(v.submitted_date).slice(0, 10) : todayISO(), v.note ? String(v.note).trim() : null]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function markBdEntryPaid(id: number, paymentDate?: string): Promise<{ id: number }> {
  await getClient().execute({
    sql: "UPDATE bd_entries SET status = 'paid', payment_date = ? WHERE id = ?",
    args: [paymentDate ? String(paymentDate).slice(0, 10) : todayISO(), id]
  })
  return { id }
}

export async function markBdEntryRepaid(id: number, repaidDate?: string): Promise<{ id: number }> {
  await getClient().execute({
    sql: "UPDATE bd_entries SET status = 'repaid', repaid_date = ? WHERE id = ?",
    args: [repaidDate ? String(repaidDate).slice(0, 10) : todayISO(), id]
  })
  return { id }
}

export async function recordBdInterest(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'UPDATE bd_entries SET interest_amount = ?, interest_received_date = ? WHERE id = ?',
    args: [n(v.interest_amount), v.interest_received_date ? String(v.interest_received_date).slice(0, 10) : null, id]
  })
  return { id }
}

export async function deleteBdEntry(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM bd_entries WHERE id = ?', args: [id] })
  return { id }
}

// Fund-flow rollup: what's out, what's coming back as interest, and how much
// headroom is left across every party — the "ultimate goal" the notes call out.
export async function bdFundFlowSummary(): Promise<Row> {
  const parties = await listBdParties()
  return {
    sanctioned_total: round2(parties.reduce((s, p) => s + n(p.sanctioned_limit), 0)),
    outstanding_total: round2(parties.reduce((s, p) => s + n(p.outstanding), 0)),
    available_total: round2(parties.reduce((s, p) => s + n(p.available), 0)),
    interest_pending_total: round2(parties.reduce((s, p) => s + n(p.interest_pending), 0)),
    interest_received_total: round2(parties.reduce((s, p) => s + n(p.interest_received), 0)),
    parties
  }
}
