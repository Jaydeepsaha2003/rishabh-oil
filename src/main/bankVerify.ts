// BANK BOOK VERIFICATION (admin only).
//
// Every payment / receipt through a bank, one row each, for an admin to check
// by hand: open it, set its Agst Ref (bill-wise) where it needs one, and mark it
// done. The mark is a record of who checked it and when — it changes nothing in
// the books.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { getCurrentUser } from './currentUser'
import { baseGroupOf } from './ledgerGroups'

type Row = Record<string, unknown>
const n = (v: unknown): number => Number(v) || 0
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS voucher_verifications (
    entry_id INTEGER PRIMARY KEY,
    verified_by TEXT,
    verified_at TEXT DEFAULT (datetime('now')),
    note TEXT
  )`)
  ready = true
}

export async function listBankVerify(v: { companyId?: number; from?: string; to?: string; state?: 'pending' | 'done' | 'all' } = {}): Promise<Row[]> {
  await ensure()
  const c = getClient()
  const cid = n(v.companyId) || getActiveCompanyId()
  const where = [`je.company_id = ?`, `je.vch_type IN ('PAYMENT', 'RECEIPT')`]
  const args: (string | number)[] = [cid]
  if (v.from) {
    where.push('je.entry_date >= ?')
    args.push(String(v.from))
  }
  if (v.to) {
    where.push('je.entry_date <= ?')
    args.push(String(v.to))
  }
  if (v.state === 'pending') where.push('vv.entry_id IS NULL')
  if (v.state === 'done') where.push('vv.entry_id IS NOT NULL')
  const heads = toPlain(
    await c.execute({
      sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, vv.verified_by, vv.verified_at,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
              FROM journal_entries je
              LEFT JOIN voucher_verifications vv ON vv.entry_id = je.id
             WHERE ${where.join(' AND ')}
               AND EXISTS (SELECT 1 FROM journal_lines bl JOIN ledger_accounts ba ON ba.id = bl.account_id
                            WHERE bl.entry_id = je.id AND ba.acc_group IN ('Bank Accounts', 'Bank OD A/c'))
             ORDER BY je.entry_date, je.id`,
      args
    })
  )
  if (!heads.length) return []
  const ids = heads.map((h) => n(h.id))
  const lines = toPlain(
    await c.execute(`SELECT jl.id, jl.entry_id, jl.dr, jl.cr, la.name, la.acc_group,
                            (SELECT GROUP_CONCAT(COALESCE(a.ref_name, a.method) || ':' || a.amount, ';') FROM journal_bill_allocs a WHERE a.line_id = jl.id) AS allocs
                       FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
                      WHERE jl.entry_id IN (${ids.join(',')}) ORDER BY jl.id`)
  )
  const byEntry = new Map<number, Row[]>()
  for (const l of lines) {
    const k = n(l.entry_id)
    if (!byEntry.has(k)) byEntry.set(k, [])
    byEntry.get(k)!.push(l)
  }
  // Only a party's ledger keeps bills (Sundry Debtors / Creditors, and groups under them).
  const bw = new Map<string, boolean>()
  for (const g of new Set(lines.map((l) => String(l.acc_group || '')))) bw.set(g, ['Sundry Debtors', 'Sundry Creditors'].includes(String(await baseGroupOf(g))))
  return heads.map((h) => {
    const ls = byEntry.get(n(h.id)) || []
    const bank = ls.filter((l) => ['Bank Accounts', 'Bank OD A/c'].includes(String(l.acc_group)))
    const others = ls.filter((l) => !['Bank Accounts', 'Bank OD A/c'].includes(String(l.acc_group)))
    return {
      ...h,
      bank: bank.map((l) => String(l.name)).join(', '),
      amount: Math.round(bank.reduce((t, l) => t + n(l.dr) + n(l.cr), 0) * 100) / 100,
      parties: others.map((l) => ({
        name: String(l.name),
        group: String(l.acc_group || ''),
        amount: Math.round((n(l.dr) + n(l.cr)) * 100) / 100,
        side: n(l.dr) > 0 ? 'Dr' : 'Cr',
        billwise: !!bw.get(String(l.acc_group || '')),
        // The Agst Ref set on the line, or none yet (On Account).
        refs: String(l.allocs || '')
          .split(';')
          .filter(Boolean)
          .map((x) => {
            const i = x.lastIndexOf(':')
            return { ref: x.slice(0, i), amount: n(x.slice(i + 1)) }
          })
      })),
      done: !!h.verified_by || !!h.verified_at
    }
  })
}

/** Mark a bank voucher checked (or take the mark back). */
export async function setBankVerified(entryId: number, done: boolean, note?: string): Promise<{ id: number; done: boolean }> {
  await ensure()
  const c = getClient()
  if (done) {
    await c.execute({
      sql: `INSERT INTO voucher_verifications (entry_id, verified_by, verified_at, note) VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(entry_id) DO UPDATE SET verified_by = excluded.verified_by, verified_at = excluded.verified_at, note = excluded.note`,
      args: [n(entryId), getCurrentUser().username || null, note ? String(note) : null]
    })
  } else {
    await c.execute({ sql: 'DELETE FROM voucher_verifications WHERE entry_id = ?', args: [n(entryId)] })
  }
  return { id: n(entryId), done }
}
