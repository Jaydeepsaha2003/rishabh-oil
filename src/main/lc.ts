import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { postLcOpening } from './treasury'
import { facilityHeadroom } from './facilities'

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

// LCs / discounting facilities with their utilisation (sum of issuances),
// the invoice they're linked to, the party repayment is expected from, the
// opening-amount breakdown, and how much of the exposure has been repaid.
export async function listLCs(): Promise<Row[]> {
  const res = await getClient().execute({
    args: [getActiveCompanyId()],
    sql: `
    SELECT l.*,
      s.name AS supplier_name,
      f.name AS facility_name,
      rp.name AS receivable_party_name,
      (SELECT GROUP_CONCAT(lo.order_id) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_order_ids_csv,
      (SELECT GROUP_CONCAT(o.invoice_no, ', ') FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_nos,
      (SELECT COALESCE(SUM(o.net_amount), 0) FROM lc_linked_orders lo
         JOIN orders o ON o.id = lo.order_id WHERE lo.lc_id = l.id) AS linked_invoice_amount_total,
      (SELECT COUNT(*) FROM lc_linked_orders lo WHERE lo.lc_id = l.id) AS linked_invoice_count,
      COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS utilized,
      l.amount - COALESCE((SELECT SUM(amount) FROM lc_issuances WHERE lc_id = l.id), 0) AS available,
      COALESCE((SELECT SUM(amount) FROM lc_repayments WHERE lc_id = l.id AND posted = 1), 0) AS repaid,
      (SELECT MIN(due_date) FROM lc_issuances WHERE lc_id = l.id AND COALESCE(status, 'outstanding') != 'settled') AS next_due_date
    FROM letters_of_credit l
    LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
    LEFT JOIN bank_facilities f ON f.id = l.facility_id
    LEFT JOIN customers rp ON rp.id = l.receivable_party_id
    WHERE l.company_id = ?
    ORDER BY l.id DESC
  `
  })
  return toPlain(res).map((l) => {
    const linkedCount = n(l.linked_invoice_count)
    const invoiceAmount = linkedCount > 0 ? n(l.linked_invoice_amount_total) : n(l.amount)
    const margin = Math.round((invoiceAmount * n(l.margin_pct)) / 100 * 100) / 100
    const interest = Math.round(((n(l.amount) * n(l.interest_pct) * n(l.usance_days)) / (100 * 365)) * 100) / 100
    const charges = Math.round(n(l.charges) * 100) / 100
    // Trading LCs are only "compliant" once they carry at least one open
    // invoice and the party repayment will come from — without either, the
    // register can't be trusted to reconcile on its own.
    const compliant = String(l.purpose || '') !== 'trading' || (linkedCount > 0 && !!l.receivable_party_id)
    return {
      ...l,
      linked_order_ids: String(l.linked_order_ids_csv || '')
        .split(',')
        .map((x) => Number(x))
        .filter((x) => x > 0),
      // Back-calculated: the open amount is the limit struck with the bank —
      // interest and charges come OUT of it, not added on top.
      lc_net_available: Math.round((n(l.amount) - interest - charges) * 100) / 100,
      outstanding: Math.round((n(l.amount) - n(l.repaid)) * 100) / 100,
      compliant,
      display_status: !compliant ? 'non_compliant' : String(l.workflow_status || 'in_progress')
    }
  })
}

async function syncLinkedOrders(lcId: number, orderIds: unknown): Promise<void> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [lcId] })
  const ids = Array.isArray(orderIds) ? orderIds.map((x) => n(x)).filter((x) => x > 0) : []
  for (const oid of ids) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO lc_linked_orders (lc_id, order_id) VALUES (?, ?)',
      args: [lcId, oid]
    })
  }
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
  'usance_days',
  'margin_pct',
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
  'note',
  'facility_id',
  'purpose',
  'receivable_party_id',
  'workflow_status',
  'stage',
  'fd_no'
]

function lcArgs(v: Row): (string | number | null)[] {
  return LC_COLS.map((k) => {
    const val = v[k]
    if (val === '' || val === undefined || val === null) {
      if (k === 'workflow_status') return 'in_progress'
      if (k === 'stage') return 'application'
      return null
    }
    if (
      k === 'party_id' ||
      k === 'amount' ||
      k === 'interest_pct' ||
      k === 'charges' ||
      k === 'usance_days' ||
      k === 'margin_pct' ||
      k === 'facility_id' ||
      k === 'receivable_party_id'
    ) {
      return n(val)
    }
    return val as string
  })
}

// An LC drawing on a sanctioned facility cannot quietly take it past its
// limit. `force` lets an authorised person proceed anyway — the notes ask for
// an override path, not a hard wall — and the reason lands in the LC's note.
async function assertWithinFacility(v: Row, excludeLcId = 0): Promise<void> {
  const facilityId = n(v.facility_id)
  if (!facilityId || v.force_over_limit) return
  const h = await facilityHeadroom(facilityId, excludeLcId)
  const amount = n(v.amount)
  if (amount > n(h.available) + 0.005) {
    throw new Error(
      `${h.name} has ${Number(h.available).toFixed(2)} left of its ${Number(h.sanctioned).toFixed(2)} sanction ` +
        `(${Number(h.lc_committed).toFixed(2)} on other LCs, ${Number(h.other_outstanding).toFixed(2)} other outstanding). ` +
        `This LC of ${amount.toFixed(2)} would exceed it.`
    )
  }
}

export async function createLC(v: Row): Promise<{ id: number }> {
  if (!v.lc_no || !v.bank) throw new Error('LC number and bank are required')
  if (!String(v.fd_no || '').trim()) throw new Error('FD No is required')
  await assertWithinFacility(v)
  const res = await getClient().execute({
    sql: `INSERT INTO letters_of_credit (company_id, ${LC_COLS.join(', ')})
          VALUES (?, ${LC_COLS.map(() => '?').join(', ')})`,
    args: [getActiveCompanyId(), ...lcArgs(v)]
  })
  const id = Number(res.lastInsertRowid)
  await syncLinkedOrders(id, v.linked_order_ids)
  // Margin + charges voucher into the books (skipped when both are zero).
  await postLcOpening(id).catch((e) => console.error('[lc] opening voucher failed:', (e as Error).message))
  return { id }
}

export async function updateLC(id: number, v: Row): Promise<{ id: number }> {
  if (!String(v.fd_no || '').trim()) throw new Error('FD No is required')
  await assertWithinFacility(v, id)
  await getClient().execute({
    sql: `UPDATE letters_of_credit SET ${LC_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...lcArgs(v), id]
  })
  await syncLinkedOrders(id, v.linked_order_ids)
  await postLcOpening(id).catch((e) => console.error('[lc] opening voucher failed:', (e as Error).message))
  return { id }
}

export async function deleteLC(id: number): Promise<{ id: number }> {
  const c = getClient()
  // Reverse everything the LC put into the books before it goes.
  const bills = await c.execute({ sql: 'SELECT journal_entry_id FROM lc_issuances WHERE lc_id = ?', args: [id] })
  for (const b of bills.rows) if (b.journal_entry_id) await dropTreasuryEntry(Number(b.journal_entry_id))
  const lc = await c.execute({ sql: 'SELECT journal_entry_id FROM letters_of_credit WHERE id = ?', args: [id] })
  if (lc.rows.length && lc.rows[0].journal_entry_id) await dropTreasuryEntry(Number(lc.rows[0].journal_entry_id))
  await c.execute({ sql: 'DELETE FROM lc_issuances WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM lc_linked_orders WHERE lc_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM letters_of_credit WHERE id = ?', args: [id] })
  return { id }
}

async function dropTreasuryEntry(entryId: number): Promise<void> {
  const c = getClient()
  await c.execute({
    sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)',
    args: [entryId]
  })
  await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [entryId] })
  await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [entryId] })
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
  const lc = lcRes.rows[0]
  const issueDate = String(v.issue_date || '').slice(0, 10)
  if (lc.expiry_date && issueDate > String(lc.expiry_date)) {
    throw new Error(`The LC expired on ${lc.expiry_date} — a bill cannot be issued after that`)
  }
  // Every bill carries its maturity: explicit, or issue date + the LC's usance.
  let dueDate = String(v.due_date || '').slice(0, 10)
  if (!dueDate) {
    const d = new Date(`${issueDate}T00:00:00`)
    d.setDate(d.getDate() + (n(lc.usance_days) || 0))
    dueDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const ins = await c.execute({
    sql: `INSERT INTO lc_issuances (lc_id, issue_date, amount, order_id, bill_no, note, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding')`,
    args: [
      lcId,
      issueDate,
      amount,
      v.order_id ? n(v.order_id) : null,
      v.bill_no || null,
      v.note || null,
      dueDate
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
  const res = await c.execute({ sql: 'SELECT lc_id, journal_entry_id FROM lc_issuances WHERE id = ?', args: [id] })
  if (res.rows.length && res.rows[0].journal_entry_id) await dropTreasuryEntry(Number(res.rows[0].journal_entry_id))
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
