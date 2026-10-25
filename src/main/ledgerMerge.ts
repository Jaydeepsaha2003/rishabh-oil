import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { getCurrentUser } from './currentUser'
import { ensureLedgerMap, renameLedger } from './ledgerMap'
import { partySideOfGroup } from './partyLedgers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100
const clean = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase()

// TWO LEDGERS THAT ARE ONE PARTY, MADE ONE.
//
// A party's postings can end up in two ledgers — the app's (named off the
// master, ASHOK SOAP & OIL, TAMIL NADU) and Tally's (ASHOK SOAP AND OILS,
// brought in with an import). Renaming one onto the other is refused because
// the name is taken; this moves everything instead. Every voucher line and
// bill-wise allocation of the merged-away ledger goes to the kept one, its
// opening balances are added in, its Tally mappings and company links follow,
// and its name — with every redirect that pointed at it — becomes a redirect to
// the kept ledger, so a master or an import addressing the old name lands in
// the right place. The emptied ledger is then removed. The kept ledger may take
// either name (or a new one). Vouchers keep their ids and numbers.
//
// A customer's and a supplier's ledger are never merged: the posting rule keeps
// the two sides apart (partyLedgers.ts), and a merge across them would undo it.

async function ledger(id: number): Promise<Row> {
  const r = (await getClient().execute({ sql: 'SELECT id, name, acc_group, is_hidden FROM ledger_accounts WHERE id = ?', args: [n(id)] })).rows[0] as unknown as Row | undefined
  if (!r) throw new Error('That ledger no longer exists')
  return { ...r }
}

/** What a merge of `fromId` into `intoId` would move, per company. Changes nothing. */
export async function previewLedgerMerge(fromId: number, intoId: number): Promise<Row> {
  if (n(fromId) === n(intoId)) throw new Error('Pick a different ledger to merge into')
  const c = getClient()
  const from = await ledger(fromId)
  const into = await ledger(intoId)
  const sf = await partySideOfGroup(from.acc_group)
  const si = await partySideOfGroup(into.acc_group)
  const blocked =
    sf && si && sf !== si
      ? `${from.name} is a ${sf === 'SUNDRY DEBTORS' ? 'customer' : 'supplier'} ledger and ${into.name} a ${si === 'SUNDRY DEBTORS' ? 'customer' : 'supplier'} one — customers and suppliers are never put in one ledger`
      : ''
  const per = await c.execute({
    sql: `SELECT je.company_id, co.name AS company, COUNT(*) AS lines, COUNT(DISTINCT je.id) AS vouchers,
                 ROUND(SUM(jl.dr), 2) AS dr, ROUND(SUM(jl.cr), 2) AS cr
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id LEFT JOIN companies co ON co.id = je.company_id
           WHERE jl.account_id = ? GROUP BY je.company_id ORDER BY je.company_id`,
    args: [n(fromId)]
  })
  const openings = await c.execute({
    sql: `SELECT o.company_id, co.name AS company, o.dr, o.cr FROM ledger_openings o LEFT JOIN companies co ON co.id = o.company_id
           WHERE o.account_id = ? AND (o.dr <> 0 OR o.cr <> 0)`,
    args: [n(fromId)]
  })
  const allocs = n((await c.execute({ sql: 'SELECT COUNT(*) AS k FROM journal_bill_allocs WHERE account_id = ?', args: [n(fromId)] })).rows[0]?.k)
  const redirects = (
    await c.execute({ sql: 'SELECT posts_as FROM ledger_map WHERE TRIM(UPPER(use_name)) = ?', args: [clean(from.name)] }).catch(() => ({ rows: [] }))
  ).rows.map((r) => String((r as unknown as Row).posts_as))
  // LIKELY THE SAME MONEY TWICE, either way round: a line imported from Tally
  // on one ledger and a line the app posted on the other — same company, same
  // side, within a rupee and a week (an LC payment the app posted and Tally's
  // journal for it). Merged as they stand the party carries both, so the merge
  // is refused until each pair is resolved: the Tally copy deleted, or the pair
  // marked as two real entries (`keep`). `copy_id` is the Tally one.
  const IMPORTED = "COALESCE(%s.narration, '') LIKE 'Imported from Tally%%'"
  const copies = await c.execute({
    sql: `SELECT CASE WHEN ${IMPORTED.replace('%s', 'fe')} THEN fe.id ELSE ie.id END AS copy_id,
                 CASE WHEN ${IMPORTED.replace('%s', 'fe')} THEN ie.id ELSE fe.id END AS twin_id,
                 CASE WHEN ${IMPORTED.replace('%s', 'fe')} THEN ? ELSE ? END AS copy_on,
                 fe.company_id, fl.dr, fl.cr, il.dr AS twin_dr, il.cr AS twin_cr,
                 fe.id AS from_entry, fe.entry_date AS from_date, ie.entry_date AS into_date,
                 fe.vch_type AS from_type, ie.vch_type AS into_type,
                 (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = fe.id) AS from_code,
                 (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = ie.id) AS into_code,
                 fe.vch_no AS from_no, ie.vch_no AS into_no
            FROM journal_lines fl JOIN journal_entries fe ON fe.id = fl.entry_id
            JOIN journal_lines il ON il.account_id = ?
                 AND ((fl.dr > 0 AND il.dr > 0 AND ABS(il.dr - fl.dr) <= 1) OR (fl.cr > 0 AND il.cr > 0 AND ABS(il.cr - fl.cr) <= 1))
            JOIN journal_entries ie ON ie.id = il.entry_id AND ie.id <> fe.id AND ie.company_id = fe.company_id
                 AND ABS(julianday(ie.entry_date) - julianday(fe.entry_date)) <= 7
           WHERE fl.account_id = ?
             AND (${IMPORTED.replace('%s', 'fe')}) <> (${IMPORTED.replace('%s', 'ie')})
           ORDER BY fe.entry_date`,
    args: [String(from.name), String(into.name), n(intoId), n(fromId)]
  })
  return {
    from,
    into,
    blocked,
    copies: copies.rows.map((r) => ({ ...(r as unknown as Row) })),
    groups_differ: clean(from.acc_group) !== clean(into.acc_group),
    companies: per.rows.map((r) => ({ ...(r as unknown as Row) })),
    openings: openings.rows.map((r) => ({ ...(r as unknown as Row) })),
    allocs,
    redirects
  }
}

/**
 * Merge `fromId` into `intoId`; the kept ledger then carries `keepName`
 * (its own name when blank). Everything happens in one transaction.
 */
export async function mergeLedgers(
  fromId: number,
  intoId: number,
  keepName?: string,
  // Tally copies the desk has looked at and says are real, separate entries.
  keep: number[] = []
): Promise<{ id: number; name: string; lines: number }> {
  const pv = await previewLedgerMerge(fromId, intoId)
  if (pv.blocked) throw new Error(String(pv.blocked))
  // No merge that leaves the same money on the ledger twice.
  const kept = new Set(keep.map(Number))
  const open = (pv.copies as Row[]).filter((x) => !kept.has(n(x.copy_id)))
  if (open.length) {
    throw new Error(
      `${open.length} entr${open.length === 1 ? 'y looks' : 'ies look'} like the same money booked twice (a Tally copy of an app entry) — delete the copy or mark it as a separate entry, then merge`
    )
  }
  await ensureLedgerMap()
  return withDbTransaction(async () => {
    // The transaction's own handle.
    const c = getClient()
    const from = pv.from as Row
    const into = pv.into as Row
    const fid = n(from.id)
    const iid = n(into.id)
    const fromName = clean(from.name)
    const intoName = clean(into.name)

    await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
        repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    await c.execute({
      sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
      args: [
        `ledger_merge:${fid}:${iid}:${Date.now()}`,
        0,
        JSON.stringify({ from, into, keepName: keepName || null, companies: pv.companies, openings: pv.openings, redirects: pv.redirects, by: getCurrentUser().username || null })
      ]
    })

    const moved = await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE account_id = ?', args: [iid, fid] })
    await c.execute({ sql: 'UPDATE journal_bill_allocs SET account_id = ? WHERE account_id = ?', args: [iid, fid] })

    // Openings add up, company by company.
    for (const o of (await c.execute({ sql: 'SELECT company_id, dr, cr FROM ledger_openings WHERE account_id = ?', args: [fid] })).rows as unknown as Row[]) {
      const have = (await c.execute({ sql: 'SELECT dr, cr FROM ledger_openings WHERE company_id = ? AND account_id = ?', args: [n(o.company_id), iid] })).rows[0] as unknown as Row | undefined
      const net = round2(n(have?.dr) - n(have?.cr) + n(o.dr) - n(o.cr))
      await c.execute({
        sql: `INSERT INTO ledger_openings (company_id, account_id, dr, cr, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT(company_id, account_id) DO UPDATE SET dr = excluded.dr, cr = excluded.cr, updated_at = excluded.updated_at`,
        args: [n(o.company_id), iid, net > 0 ? net : 0, net < 0 ? -net : 0]
      })
    }
    await c.execute({ sql: 'DELETE FROM ledger_openings WHERE account_id = ?', args: [fid] })

    // Links keyed by the ledger follow it; where the kept one already has the
    // same link, the duplicate goes.
    for (const t of ['ledger_homes', 'company_bank_accounts']) {
      await c.execute({ sql: `UPDATE OR IGNORE ${t} SET account_id = ? WHERE account_id = ?`, args: [iid, fid] }).catch(() => undefined)
      await c.execute({ sql: `DELETE FROM ${t} WHERE account_id = ?`, args: [fid] }).catch(() => undefined)
    }
    for (const t of ['tally_import_map', 'tally_ledgers']) {
      await c.execute({ sql: `UPDATE ${t} SET account_id = ? WHERE account_id = ?`, args: [iid, fid] }).catch(() => undefined)
    }
    // A few records keep a ledger by NAME.
    for (const [t, col] of [
      ['bd_payment_ins', 'account'],
      ['bd_receipt_parts', 'account'],
      ['sale_tds_journals', 'ledger']
    ]) {
      await c.execute({ sql: `UPDATE ${t} SET ${col} = ? WHERE TRIM(UPPER(${col})) = ?`, args: [intoName, fromName] }).catch(() => undefined)
    }

    // The old name, and everything that reached it, now reaches the kept ledger.
    await c.execute({ sql: 'UPDATE ledger_map SET use_name = ? WHERE TRIM(UPPER(use_name)) = ?', args: [intoName, fromName] })
    await c.execute({
      sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
            VALUES (NULL, ?, ?, ?, ?)
            ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name, note = excluded.note`,
      args: [fromName, intoName, `merged from ${fromName}`, getCurrentUser().username || null]
    })
    await c.execute('DELETE FROM ledger_map WHERE TRIM(UPPER(posts_as)) = TRIM(UPPER(use_name))')

    await c.execute({ sql: 'DELETE FROM ledger_accounts WHERE id = ?', args: [fid] })

    let name = intoName
    const want = clean(keepName)
    if (want && want !== intoName) name = (await renameLedger(iid, want)).to
    return { id: iid, name, lines: n(moved.rowsAffected) }
  })
}
