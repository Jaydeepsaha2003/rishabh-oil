import type { InValue, ResultSet } from '@libsql/client'
import { getClient } from './db'

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

// Outstanding invoices for a party.
// supplier invoice value = net_amount; transporter invoice value = freight − shortage penalty.
export async function outstandingInvoices(
  partyType: string,
  partyId: number
): Promise<Row[]> {
  const c = getClient()
  const sql =
    partyType === 'supplier'
      ? `SELECT o.id, o.invoice_no, o.order_date, o.net_amount AS invoice_amount,
           COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                     JOIN payments p ON p.id = a.payment_id
                     WHERE a.order_id = o.id AND p.party_type = 'supplier'), 0) AS allocated
         FROM orders o WHERE o.supplier_id = ? ORDER BY o.order_date ASC, o.id ASC`
      : `SELECT o.id, o.invoice_no, o.order_date,
           (o.transport_amount - o.shortage_charge_amount) AS invoice_amount,
           COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                     JOIN payments p ON p.id = a.payment_id
                     WHERE a.order_id = o.id AND p.party_type = 'transporter'), 0) AS allocated
         FROM orders o WHERE o.transporter_id = ? AND o.status = 'delivered'
         ORDER BY o.order_date ASC, o.id ASC`
  const res = await c.execute({ sql, args: [partyId] })
  return toPlain(res)
    .map((r) => ({ ...r, outstanding: n(r.invoice_amount) - n(r.allocated) }))
    .filter((r) => r.outstanding > 0.005)
}

export async function listPayments(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT p.*,
      CASE WHEN p.party_type = 'supplier' THEN s.name ELSE t.name END AS party_name
    FROM payments p
    LEFT JOIN suppliers s ON p.party_type = 'supplier' AND s.id = p.party_id
    LEFT JOIN transporters t ON p.party_type = 'transporter' AND t.id = p.party_id
    ORDER BY p.id DESC
  `)
  return toPlain(res)
}

export async function recordPayment(data: Row): Promise<{ id: number }> {
  const c = getClient()
  const partyType = data.party_type === 'transporter' ? 'transporter' : 'supplier'
  const partyId = n(data.party_id)
  const amount = n(data.amount)
  const method = data.is_advance ? 'on_account' : data.method || 'on_account'

  const ins = await c.execute({
    sql: `INSERT INTO payments
      (party_type, party_id, payment_date, amount, source, method, is_advance, reference, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      partyType,
      partyId,
      data.payment_date,
      amount,
      data.source || null,
      method,
      data.is_advance ? 1 : 0,
      data.reference || null,
      data.note || null
    ]
  })
  const paymentId = Number(ins.lastInsertRowid)

  // Work out allocations.
  let allocs: { order_id: number; amount: number }[] = []
  if (!data.is_advance && method === 'specific') {
    allocs = (data.allocations || [])
      .map((a: Row) => ({ order_id: n(a.order_id), amount: n(a.amount) }))
      .filter((a: Row) => a.amount > 0)
  } else if (!data.is_advance && method === 'fifo') {
    const outs = await outstandingInvoices(partyType, partyId)
    let remaining = amount
    for (const o of outs) {
      if (remaining <= 0.005) break
      const alloc = Math.min(remaining, n(o.outstanding))
      allocs.push({ order_id: n(o.id), amount: alloc })
      remaining -= alloc
    }
  }

  const ledgerTable = partyType === 'supplier' ? 'supplier_ledger' : 'transporter_ledger'
  const partyCol = partyType === 'supplier' ? 'supplier_id' : 'transporter_id'

  let allocatedSum = 0
  for (const a of allocs) {
    allocatedSum += a.amount
    await c.execute({
      sql: 'INSERT INTO payment_allocations (payment_id, order_id, amount) VALUES (?, ?, ?)',
      args: [paymentId, a.order_id, a.amount]
    })
    await c.execute({
      sql: `INSERT INTO ${ledgerTable} (${partyCol}, order_id, payment_id, entry_date, entry_type, amount, note)
            VALUES (?, ?, ?, ?, 'payment', ?, ?)`,
      args: [partyId, a.order_id, paymentId, data.payment_date, -a.amount, data.source || 'Payment']
    })
  }

  // Unallocated remainder → advance / on-account credit.
  const remainder = amount - allocatedSum
  if (remainder > 0.005) {
    await c.execute({
      sql: `INSERT INTO ${ledgerTable} (${partyCol}, order_id, payment_id, entry_date, entry_type, amount, note)
            VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      args: [
        partyId,
        paymentId,
        data.payment_date,
        data.is_advance ? 'advance' : 'payment',
        -remainder,
        data.is_advance ? 'Advance' : data.source || 'On account'
      ]
    })
  }
  return { id: paymentId }
}

export async function deletePayment(id: number): Promise<{ id: number }> {
  const c = getClient()
  await c.execute({ sql: 'DELETE FROM payment_allocations WHERE payment_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM supplier_ledger WHERE payment_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM transporter_ledger WHERE payment_id = ?', args: [id] })
  await c.execute({ sql: 'DELETE FROM payments WHERE id = ?', args: [id] })
  return { id }
}

// --- bill discounting ---

export async function listBillDiscounts(): Promise<Row[]> {
  const res = await getClient().execute(`
    SELECT b.*, s.name AS supplier_name
    FROM bill_discounts b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    ORDER BY b.id DESC
  `)
  return toPlain(res)
}

const BD_COLS = [
  'supplier_id',
  'party_name',
  'medium',
  'lc_open_amount',
  'open_date',
  'maturity_date',
  'payment_received_date',
  'disc_bank',
  'bill_nos',
  'amount',
  'status',
  'note'
]

function bdArgs(v: Row): InValue[] {
  return BD_COLS.map((k) => {
    const val = v[k]
    if (val === '' || val === undefined || val === null) return null
    return val as InValue
  })
}

export async function createBillDiscount(v: Row): Promise<{ id: number }> {
  const res = await getClient().execute({
    sql: `INSERT INTO bill_discounts (${BD_COLS.join(', ')})
          VALUES (${BD_COLS.map(() => '?').join(', ')})`,
    args: bdArgs(v)
  })
  return { id: Number(res.lastInsertRowid) }
}

export async function updateBillDiscount(id: number, v: Row): Promise<{ id: number }> {
  await getClient().execute({
    sql: `UPDATE bill_discounts SET ${BD_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    args: [...bdArgs(v), id]
  })
  return { id }
}

export async function deleteBillDiscount(id: number): Promise<{ id: number }> {
  await getClient().execute({ sql: 'DELETE FROM bill_discounts WHERE id = ?', args: [id] })
  return { id }
}
