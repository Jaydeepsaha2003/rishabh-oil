import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'

// PERMANENT VOUCHER NUMBERS.
//
// A ledger used to number vouchers by position — every entry of a type for the
// company, ordered by id, counted 1..n — so deleting JV/3 turned JV/4 into JV/3
// and every number after it moved. A number that changes is no use as an audit
// reference. Each voucher is now given its serial once, stored, and never
// reused: a deleted voucher's number stays taken.
//
// The first fill numbers existing vouchers exactly the way the positional
// scheme did (per company, per type, in id order), so nothing anyone has
// already written down or printed changes.

const WORDS: Array<[string, string]> = [
  ['PURCHASE', 'PUR'],
  ['SALE', 'SAL'],
  ['DEBIT', 'DN'],
  ['CREDIT', 'CN'],
  ['RECEIPT', 'RCP'],
  ['PAYMENT', 'PAY'],
  ['CONTRA', 'CON'],
  ['OPENING', 'OB'],
  ['JOURNAL', 'JV']
]

/** The number series a voucher type falls in — PURCHASE OIL and PURCHASE OTHERS both PUR. */
export const voucherSeriesOf = (type: string): string => prefix(type)

function prefix(type: string): string {
  const u = type.toUpperCase()
  for (const [word, code] of WORDS) if (u.includes(word)) return code
  return u.replace(/[^A-Z]/g, '').slice(0, 3) || 'VCH'
}

// The same test in SQL, first match wins — so the bulk fill and the one-off
// fallback below can never disagree about a type.
const PREFIX_SQL = `CASE ${WORDS.map(([w, c]) => `WHEN UPPER(e.vch_type) LIKE '%${w}%' THEN '${c}'`).join(' ')} ELSE NULL END`

let tableReady = false

async function ensureTable(): Promise<void> {
  if (tableReady) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS voucher_numbers (
      entry_id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL,
      prefix TEXT NOT NULL, serial INTEGER NOT NULL,
      UNIQUE(company_id, prefix, serial))`)
  tableReady = true
}

/** Give every voucher without a permanent number its number. Cheap when none is missing. */
export async function ensureVoucherNumbers(): Promise<void> {
  await ensureTable()
  const c = getClient()
  // Read first, outside any write: this runs on every ledger view, and a
  // statement read should not have to queue behind the write lock to learn
  // that there is nothing to do.
  const gapSql = 'SELECT 1 FROM journal_entries e LEFT JOIN voucher_numbers n ON n.entry_id = e.id WHERE n.entry_id IS NULL LIMIT 1'
  const gap = await c.execute(gapSql).catch(async (e) => {
    // A database restored from an older snapshot has no table yet.
    if (!/no such table/i.test(String(e?.message || e))) throw e
    tableReady = false
    await ensureTable()
    return c.execute(gapSql)
  })
  if (!gap.rows.length) return
  await withDbTransaction(async () => {
    const tx = getClient()
    // One statement for the common types. The base serial is read from a
    // materialised snapshot so rows inserted by this statement never feed
    // back into their own numbering.
    await tx.execute(`
      WITH base AS MATERIALIZED (
        SELECT company_id, prefix, MAX(serial) AS mx FROM voucher_numbers GROUP BY company_id, prefix
      ),
      todo AS MATERIALIZED (
        SELECT e.id, e.company_id, ${PREFIX_SQL} AS pre
          FROM journal_entries e LEFT JOIN voucher_numbers n ON n.entry_id = e.id
         WHERE n.entry_id IS NULL
      )
      INSERT INTO voucher_numbers (entry_id, company_id, prefix, serial)
      SELECT t.id, t.company_id, t.pre,
             COALESCE(b.mx, 0) + ROW_NUMBER() OVER (PARTITION BY t.company_id, t.pre ORDER BY t.id)
        FROM todo t LEFT JOIN base b ON b.company_id = t.company_id AND b.prefix = t.pre
       WHERE t.pre IS NOT NULL`)
    // Anything left is an unusual type the SQL does not name — rare, so one
    // at a time is fine.
    const rest = await tx.execute(`SELECT e.id, e.company_id, e.vch_type FROM journal_entries e
      LEFT JOIN voucher_numbers n ON n.entry_id = e.id WHERE n.entry_id IS NULL ORDER BY e.id`)
    for (const e of rest.rows) {
      const pre = prefix(String(e.vch_type))
      await tx.execute({
        sql: `INSERT INTO voucher_numbers(entry_id, company_id, prefix, serial)
          SELECT ?, ?, ?, COALESCE(MAX(serial),0)+1 FROM voucher_numbers WHERE company_id=? AND prefix=?`,
        args: [e.id, e.company_id, pre, e.company_id, pre]
      })
    }
  })
}

/** A voucher whose type changed after it was numbered moves to the new type's
 * series: a bill discounting first posted to our bank (RCP) and later switched
 * to pay the supplier (a journal) must read JV/n, not keep RCP/n. */
export async function renumberOnTypeChange(entryId: number, vchType: string): Promise<void> {
  await ensureTable()
  const c = getClient()
  const cur = await c.execute({ sql: 'SELECT company_id, prefix FROM voucher_numbers WHERE entry_id = ?', args: [entryId] })
  const p = prefix(String(vchType || ''))
  if (!cur.rows.length || String(cur.rows[0].prefix) === p) return
  const co = Number(cur.rows[0].company_id)
  await c.execute({
    sql: `UPDATE voucher_numbers SET prefix = ?,
            serial = (SELECT COALESCE(MAX(serial), 0) + 1 FROM voucher_numbers WHERE company_id = ? AND prefix = ?)
          WHERE entry_id = ?`,
    args: [p, co, p, entryId]
  })
}

/** Every voucher still carrying the series of a type it no longer is, moved to
 * its own — in date order, so the new numbers run with the dates. The old code
 * is logged to accounting_repair_log first. Returns "RCP/34 → JV/61" lines. */
export async function realignVoucherSeries(): Promise<string[]> {
  await ensureVoucherNumbers()
  const c = getClient()
  const bad = await c.execute(`SELECT e.id, e.vch_type, n.prefix, n.serial FROM journal_entries e
      JOIN voucher_numbers n ON n.entry_id = e.id
     WHERE n.prefix <> COALESCE(${PREFIX_SQL}, n.prefix)
     ORDER BY e.company_id, e.entry_date, e.id`)
  if (!bad.rows.length) return []
  await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  const moved: string[] = []
  await withDbTransaction(async () => {
    for (const r of bad.rows) {
      const id = Number(r.id)
      const was = `${r.prefix}/${r.serial}`
      // The transaction's own connection — `c` above is outside it.
      await getClient().execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`voucher-series:${id}`, id, JSON.stringify({ code: was, vch_type: r.vch_type })]
      })
      await renumberOnTypeChange(id, String(r.vch_type))
      moved.push(`${was} → ${await voucherCodeOf(id)}`)
    }
  })
  return moved
}

/** The number the next voucher of this type takes in this company, shown on
 * the entry screen before it is accepted. It is only a forecast — the serial is
 * given at the moment of posting — which is why the screen says so beside it. */
export async function nextVoucherCode(companyId: number, vchType: string): Promise<string> {
  await ensureVoucherNumbers()
  const p = prefix(String(vchType || ''))
  const r = await getClient().execute({
    sql: 'SELECT COALESCE(MAX(serial), 0) + 1 AS nx FROM voucher_numbers WHERE company_id = ? AND prefix = ?',
    args: [Number(companyId) || 1, p]
  })
  return `${p}/${Number(r.rows[0]?.nx) || 1}`
}

/** One voucher's permanent number, as the ledgers print it. */
export async function voucherCodeOf(entryId: number): Promise<string | null> {
  await ensureTable()
  const r = await getClient().execute({ sql: 'SELECT prefix, serial FROM voucher_numbers WHERE entry_id = ?', args: [entryId] })
  return r.rows.length ? `${r.rows[0].prefix}/${r.rows[0].serial}` : null
}

export async function permanentVoucherCodes(companyId: number): Promise<Map<number, string>> {
  await ensureVoucherNumbers()
  const result = await getClient().execute({
    sql: `SELECT n.entry_id, n.prefix, n.serial FROM voucher_numbers n
      JOIN journal_entries e ON e.id=n.entry_id WHERE e.company_id=?`,
    args: [companyId]
  })
  return new Map(result.rows.map((r) => [Number(r.entry_id), `${r.prefix}/${r.serial}`]))
}
