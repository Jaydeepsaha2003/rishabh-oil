import { getClient } from './db'

// All ownership links use IDs. A repeated narration or voucher reference is
// never evidence that a voucher is manual or that it belongs to another source.
const sources: Record<string, string[]> = {
  journal_entries: ['order_id', 'sale_id', 'payment_id'],
  notes: ['journal_entry_id'],
  transporter_bills: ['journal_entry_id'],
  letters_of_credit: ['journal_entry_id', 'charges_journal_entry_id', 'interest_journal_entry_id', 'fee_adjust_journal_entry_id', 'preclose_journal_entry_id', 'preclose_interest_journal_entry_id', 'preclose_payout_journal_entry_id', 'payment_in_journal_entry_id'],
  lc_issuances: ['journal_entry_id'],
  lc_repayments: ['journal_entry_id', 'fee_journal_entry_id'],
  lc_payment_ins: ['journal_entry_id'],
  bill_discountings: ['journal_entry_id', 'repay_journal_entry_id', 'margin_release_journal_entry_id', 'upfront_interest_journal_entry_id'],
  bd_repayments: ['journal_entry_id', 'interest_entry_id'],
  bd_interest_payments: ['journal_entry_id'],
  bd_payment_ins: ['journal_entry_id'],
  bill_discounts: ['journal_entry_id', 'realize_entry_id'],
  transporter_ledger: ['accrual_entry_id', 'waived_entry_id']
}

export async function ownedVoucherIds(): Promise<Set<number>> {
  const c = getClient()
  const ids = new Set<number>()
  const schema = await c.execute(`SELECT m.name AS table_name, p.name AS column_name
    FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table'`)
  const queries: string[] = []
  for (const [table, wanted] of Object.entries(sources)) {
    const have = new Set(schema.rows.filter((r) => r.table_name === table).map((r) => String(r.column_name)))
    const cols = wanted.filter((col) => have.has(col))
    if (!cols.length) continue
    const sql = table === 'journal_entries'
      ? `SELECT id AS entry_id FROM journal_entries WHERE ${cols.map((col) => `${col} IS NOT NULL`).join(' OR ')}`
      : cols.map((col) => `SELECT ${col} AS entry_id FROM ${table} WHERE ${col} IS NOT NULL`).join(' UNION ')
    queries.push(sql)
  }
  if (queries.length) for (const row of (await c.execute(queries.join(' UNION '))).rows) if (Number(row.entry_id)) ids.add(Number(row.entry_id))
  return ids
}

export async function assertManualVoucher(id: number): Promise<void> {
  if ((await ownedVoucherIds()).has(id)) {
    throw new Error('This voucher belongs to a source document — change or reverse it from that document')
  }
}

export interface VoucherOwner {
  /** What owns it, in the words the screens use to open it. */
  kind: 'order' | 'sale' | 'payment' | 'lc' | 'bd' | 'note' | 'freight' | 'discount' | 'transporter'
  id: number
  /** The owning document's own number, for a label — "BD B1", "LC LC-9". */
  label: string
}

// Which document wrote a voucher — the first source that names it. Only for
// display and for a link back to that document: whether a voucher may be
// edited is still ownedVoucherIds' question.
export async function voucherOwner(entryId: number): Promise<VoucherOwner | null> {
  const c = getClient()
  const id = Number(entryId)
  if (!id) return null
  const e = await c.execute({ sql: 'SELECT order_id, sale_id, payment_id FROM journal_entries WHERE id = ?', args: [id] })
  const er = e.rows[0]
  if (er?.order_id != null) return { kind: 'order', id: Number(er.order_id), label: 'Purchase' }
  if (er?.sale_id != null) return { kind: 'sale', id: Number(er.sale_id), label: 'Sale' }
  if (er?.payment_id != null) return { kind: 'payment', id: Number(er.payment_id), label: 'Payment' }
  const schema = await c.execute(`SELECT m.name AS table_name, p.name AS column_name
    FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table'`)
  const has = (table: string, col: string): boolean =>
    schema.rows.some((r) => r.table_name === table && r.column_name === col)
  const first = async (table: string, cols: string[], pick: string): Promise<number | null> => {
    const usable = cols.filter((col) => has(table, col))
    if (!usable.length || !has(table, pick)) return null
    const r = await c.execute({
      sql: `SELECT ${pick} AS owner FROM ${table} WHERE ${usable.map((col) => `${col} = ?`).join(' OR ')} LIMIT 1`,
      args: usable.map(() => id)
    })
    return r.rows.length ? Number(r.rows[0].owner) || null : null
  }
  const lcNo = async (lcId: number): Promise<string> => {
    const r = await c.execute({ sql: 'SELECT lc_no FROM letters_of_credit WHERE id = ?', args: [lcId] })
    return `LC ${String(r.rows[0]?.lc_no || lcId)}`
  }
  const bdNo = async (bdId: number): Promise<string> => {
    const r = await c.execute({ sql: 'SELECT bd_no FROM bill_discountings WHERE id = ?', args: [bdId] })
    return `BD ${String(r.rows[0]?.bd_no || bdId)}`
  }
  let hit: number | null
  if ((hit = await first('bill_discountings', sources.bill_discountings, 'id'))) return { kind: 'bd', id: hit, label: await bdNo(hit) }
  for (const t of ['bd_repayments', 'bd_interest_payments', 'bd_payment_ins']) {
    if ((hit = await first(t, sources[t], 'bd_id'))) return { kind: 'bd', id: hit, label: await bdNo(hit) }
  }
  if ((hit = await first('letters_of_credit', sources.letters_of_credit, 'id'))) return { kind: 'lc', id: hit, label: await lcNo(hit) }
  for (const t of ['lc_issuances', 'lc_repayments', 'lc_payment_ins']) {
    if ((hit = await first(t, sources[t], 'lc_id'))) return { kind: 'lc', id: hit, label: await lcNo(hit) }
  }
  if ((hit = await first('notes', sources.notes, 'id'))) return { kind: 'note', id: hit, label: 'Debit / Credit note' }
  if ((hit = await first('transporter_bills', sources.transporter_bills, 'id'))) return { kind: 'freight', id: hit, label: 'Transporter bill' }
  if ((hit = await first('bill_discounts', sources.bill_discounts, 'id'))) return { kind: 'discount', id: hit, label: 'Discounted bill' }
  if ((hit = await first('transporter_ledger', sources.transporter_ledger, 'id'))) return { kind: 'transporter', id: hit, label: 'Transporter ledger' }
  return null
}
