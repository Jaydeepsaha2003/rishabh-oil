// Books beginning from, and the opening balances that stand in for everything
// before it.
//
// The books start partway through the business, not at its beginning. Entries
// keyed for the period before that date exist for their own reasons — an LC has
// to know what it advanced, a tanker has to know when it loaded — but they are
// not this company's accounts. What the accounts carry instead is one figure
// per ledger: what was owed, held or owned on the morning the books opened.
//
// So a pre-cutoff voucher is never deleted; it simply stops reaching the ledger,
// and the entered opening takes its place.
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { getSetting, setSetting } from './repos'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => Number(v ?? 0) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100

function key(companyId: number): string {
  return `books_from:${companyId}`
}

// The date this company's books begin, or null when they run from the start.
export async function getBooksFrom(companyId?: number): Promise<string | null> {
  const cid = companyId || getActiveCompanyId()
  const v = await getSetting(key(cid))
  const d = String(v || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

export async function setBooksFrom(date: string | null, companyId?: number): Promise<{ ok: true }> {
  const cid = companyId || getActiveCompanyId()
  const d = String(date || '').slice(0, 10)
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('Give the date as YYYY-MM-DD')
  await setSetting(key(cid), d)
  return { ok: true }
}

// Every ledger with what it is carrying today and what has been entered as its
// opening, so the screen can show both side by side: the figure you are typing,
// and the movement the books have recorded since.
export async function listOpenings(companyId?: number): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const from = await getBooksFrom(cid)
  const res = await c.execute({
    sql: `SELECT a.id, a.name, a.acc_group,
                 COALESCE(o.dr, 0) AS dr, COALESCE(o.cr, 0) AS cr,
                 COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                             FROM journal_lines jl
                             JOIN journal_entries je ON je.id = jl.entry_id
                            WHERE jl.account_id = a.id AND je.company_id = ?
                              ${from ? 'AND je.entry_date >= ?' : ''}), 0) AS movement,
                 COALESCE((SELECT SUM(jl.dr) - SUM(jl.cr)
                             FROM journal_lines jl
                             JOIN journal_entries je ON je.id = jl.entry_id
                            WHERE jl.account_id = a.id AND je.company_id = ?
                              ${from ? 'AND je.entry_date < ?' : 'AND 0'}), 0) AS before_cutoff
            FROM ledger_accounts a
            LEFT JOIN ledger_openings o ON o.account_id = a.id AND o.company_id = ?
           ORDER BY a.acc_group, a.name`,
    args: from ? [cid, from, cid, from, cid] : [cid, cid, cid]
  })
  const rows = res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
  const dr = round2(rows.reduce((s, r) => s + n(r.dr), 0))
  const cr = round2(rows.reduce((s, r) => s + n(r.cr), 0))
  return {
    books_from: from,
    rows,
    total_dr: dr,
    total_cr: cr,
    // Tally calls this "Difference in opening balances". A non-zero figure is
    // not an error to be hidden — it is the part of the opening position you
    // have not accounted for yet, and it belongs on screen until it is nil.
    difference: round2(dr - cr)
  }
}

// Save the whole grid at once. A row with nothing on either side is removed
// rather than stored as a pair of zeros, so the table only holds real figures.
export async function saveOpenings(
  rows: { account_id: number; dr?: number; cr?: number }[],
  companyId?: number
): Promise<{ saved: number }> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  let saved = 0
  for (const r of rows || []) {
    const id = n(r.account_id)
    if (!id) continue
    const dr = round2(Math.max(0, n(r.dr)))
    const cr = round2(Math.max(0, n(r.cr)))
    if (dr > 0.004 && cr > 0.004) {
      throw new Error('An opening balance is either a debit or a credit, not both')
    }
    if (dr < 0.005 && cr < 0.005) {
      await c.execute({
        sql: 'DELETE FROM ledger_openings WHERE company_id = ? AND account_id = ?',
        args: [cid, id]
      })
      continue
    }
    await c.execute({
      sql: `INSERT INTO ledger_openings (company_id, account_id, dr, cr, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company_id, account_id)
            DO UPDATE SET dr = excluded.dr, cr = excluded.cr, updated_at = excluded.updated_at`,
      args: [cid, id, dr, cr, todayISO()]
    })
    saved += 1
  }
  return { saved }
}

// One ledger's entered opening, for the statement view. Returned alongside the
// cutoff so the page can say WHY the older entries are not listed.
export async function ledgerOpening(accountId: number, companyId?: number): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const res = await c.execute({
    sql: 'SELECT dr, cr FROM ledger_openings WHERE company_id = ? AND account_id = ?',
    args: [cid, n(accountId)]
  })
  const r = (res.rows[0] as Row) || {}
  return {
    books_from: await getBooksFrom(cid),
    // Signed the way the ledger runs its balance: positive is a debit.
    opening: round2(n(r.dr) - n(r.cr))
  }
}

// Every entered opening for a company, keyed by account, for the trial balance.
export async function openingMap(companyId?: number): Promise<Map<number, number>> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const res = await c.execute({
    sql: 'SELECT account_id, dr, cr FROM ledger_openings WHERE company_id = ?',
    args: [cid]
  })
  const m = new Map<number, number>()
  for (const r of res.rows as unknown as Row[]) {
    m.set(Number(r.account_id), round2(n(r.dr) - n(r.cr)))
  }
  return m
}
