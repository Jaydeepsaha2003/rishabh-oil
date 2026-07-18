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

// LCs / discounting facilities with their utilisation (sum of issuances).
export async function listLCs(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*,
      s.name AS supplier_name,
      COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized,
      l.amount - COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS available
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res)
}

export async function listLCIssuances(lcId: number): Promise<Row[]> {
  const res = await getClient().execute({
    sql: `SELECT i.*, o.invoice_no
          FROM lc_issuances i
          LEFT JOIN orders o ON o.id = i.order_id
          WHERE i.lc_id = ? ORDER BY i.id DESC`,
    args: [lcId]
  })
  return toPlain(res)
}

const LC_COLS = [
  'lc_no',
  'facility_type',
  'bank',
  'party_type',
  'party_id',
  'amount',
  'open_date',
  'expiry_date',
  'interest_pct',
  'charges',
  'status',
  'note'
]

function lcArgs(v: Row): (string | number | null)[] {
  return LC_COLS.map((k) => {
    const val = v[k]
    if (val === '' || val === undefined || val === null) return null
    if (k === 'party_id' || k === 'amount' || k === 'interest_pct' || k === 'charges') return n(val)
    return val as string
  })
}

export async function createLC(v: Row): Promise<{ id: number }> {
  if (!v.lc_no || !v.bank) throw new Error('LC number and bank are required')
  const res = await getClient().execute({
    sql: `INSERT INTO letters_of_credit (company_id, ${LC_COLS.join(', ')})
          VALUES (?, ${LC_COLS.map(() => '?').join(', ')})`,
    args: [getActiveCompanyId(), ...lcArgs(v)]
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateLC(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET ${LC_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...lcArgs(v), id]
  })
  return { id }
}

export async function deleteLC(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM letters_of_credit WHERE id = ?', args: [id] })
  return { id }
}

// Issue (draw down) against an LC. Cannot exceed the available balance.
export async function issueLC(v: Row): Promise<{ id: number }> {
  const c = getClient()
  const lcId = n(v.lc_id)
  const amount = n(v.amount)
  if (amount <= 0) throw new Error('Enter the issuance amount')
  const lcRes = await c.execute({ sql: 'SELECT * FROM letters_of_credit WHERE id = ?', args: [lcId] })
  if (!lcRes.rows.length) throw new Error('LC not found')
  const used = await c.execute({
    sql: 'SELECT COALESCE(SUM(amount), 0) AS u FROM lc_issuances WHERE lc_id = ?',
    args: [lcId]
  })
  const available = n(lcRes.rows[0].amount) - n(used.rows[0].u)
  if (amount > available + 0.005) {
    throw new Error(`Issuance exceeds available LC balance (${available.toFixed(2)})`)
  }
  const ins = await c.execute({
    sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, note)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      lcId,
      v.issue_date,
      amount,
      v.order_id ? n(v.order_id) : null,
      v.bill_no || null,
      v.note || null
    ]
  })
  // Mark the LC utilised/closed once fully drawn.
  if (amount >= available - 0.005) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'utilized' WHERE id = ?",
      args: [lcId]
    })
  }
  return { id: Number(ins.lastInsertRowid) }
}

export async function deleteLCIssuance(id: number): Promise<{ id: number }> {
  const c = getClient()
  const res = await c.execute({ sql: 'SELECT lc_id FROM lc_issuances WHERE id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE id = ?', args: [id] })
  // Re-open the LC if it now has headroom.
  if (res.rows.length) {
    await c.execute({
      sql: "UPDATE letters_of_credit SET status = 'open' WHERE id = ? AND status = 'utilized'",
      args: [n(res.rows[0].lc_id)]
    })
  }
  return { id }
}
