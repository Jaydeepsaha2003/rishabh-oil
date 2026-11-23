// ONE PARTY, TWO SUPPLIER MASTERS — folded into one.
// ---------------------------------------------------------------------------
// "LEGACY COMMODITIES PVT. LTD" (with a dot) was the same party as "LEGACY
// COMMODITIES PVT LTD", keyed twice. Its bills landed on the right ledger in
// KR FOODS only by an old site-wide redirect; in KR FINMARK the same redirect
// would have posted to KR FOODS' ledger name. Everything that names the
// duplicate is moved onto the master that stays, then the duplicate goes.
// No voucher is touched: in the books both masters resolve to the same
// ledgers. The rows moved are logged in accounting_repair_log.
import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

// Every place a supplier is named: table, column, and an extra condition.
const REFS: [string, string, string?][] = [
  ['bargains', 'supplier_id'],
  ['orders', 'supplier_id'],
  ['purchase_tankers', 'supplier_id'],
  ['supplier_ledger', 'supplier_id'],
  ['gate_entries', 'supplier_id'],
  ['consignment_stock', 'supplier_id'],
  ['consignment_opening_log', 'supplier_id'],
  ['bill_discounts', 'supplier_id'],
  ['sales', 'return_supplier_id'],
  ['letters_of_credit', 'party_id', "party_type = 'supplier'"],
  ['notes', 'party_id', "party_type = 'supplier'"],
  ['payments', 'party_id', "party_type = 'supplier'"]
]

export async function mergeSupplier(fromId: number, toId: number): Promise<Row> {
  return withDbTransaction(async () => {
    const c = getClient()
    if (!n(fromId) || !n(toId) || n(fromId) === n(toId)) throw new Error('Pick two different suppliers')
    const from = (await c.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [n(fromId)] })).rows[0] as unknown as Row | undefined
    const to = (await c.execute({ sql: 'SELECT * FROM suppliers WHERE id = ?', args: [n(toId)] })).rows[0] as unknown as Row | undefined
    if (!from || !to) throw new Error('Supplier not found')
    const schema = (await c.execute(`SELECT m.name AS t, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`)).rows as unknown as Row[]
    const has = (t: string, col: string): boolean => schema.some((r) => r.t === t && r.col === col)
    const moved: Record<string, number[]> = {}
    for (const [t, col, extra] of REFS) {
      if (!has(t, col)) continue
      const where = `${col} = ?${extra ? ` AND ${extra}` : ''}`
      const ids = (await c.execute({ sql: `SELECT rowid AS id FROM ${t} WHERE ${where}`, args: [n(fromId)] })).rows.map((r) => n((r as unknown as Row).id))
      if (!ids.length) continue
      await c.execute({ sql: `UPDATE ${t} SET ${col} = ? WHERE ${where}`, args: [n(toId), n(fromId)] })
      moved[`${t}.${col}`] = ids
    }
    // The opening purchase billing (TDS slab seed) is one party's: added together per company.
    if (has('party_openings', 'party_id')) {
      const ops = (await c.execute({ sql: "SELECT company_id, amount FROM party_openings WHERE kind = 'supplier' AND party_id = ?", args: [n(fromId)] })).rows as unknown as Row[]
      for (const o of ops) {
        const cur = (await c.execute({ sql: "SELECT amount FROM party_openings WHERE kind = 'supplier' AND party_id = ? AND company_id = ?", args: [n(toId), n(o.company_id)] })).rows[0] as unknown as Row | undefined
        if (cur) await c.execute({ sql: "UPDATE party_openings SET amount = ? WHERE kind = 'supplier' AND party_id = ? AND company_id = ?", args: [n(cur.amount) + n(o.amount), n(toId), n(o.company_id)] })
        else await c.execute({ sql: "UPDATE party_openings SET party_id = ? WHERE kind = 'supplier' AND party_id = ? AND company_id = ?", args: [n(toId), n(fromId), n(o.company_id)] })
      }
      await c.execute({ sql: "DELETE FROM party_openings WHERE kind = 'supplier' AND party_id = ?", args: [n(fromId)] })
      moved['party_openings'] = ops.map((o) => n(o.company_id))
    }
    await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    await c.execute({
      sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
      args: [`supplier_merge_v1:${n(fromId)}`, 0, JSON.stringify({ from, to: { id: to.id, name: to.name }, moved })]
    })
    await c.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [n(fromId)] })
    return { from: String(from.name), to: String(to.name), moved }
  })
}

/** One-time (asked for 2026-11-23): Legacy's duplicate supplier master, and its unused ledger hidden. */
export async function legacySupplierCleanup(): Promise<string> {
  const c = getClient()
  const find = async (name: string): Promise<number> =>
    n((await c.execute({ sql: 'SELECT id FROM suppliers WHERE UPPER(TRIM(name)) = ? ORDER BY id LIMIT 1', args: [name] })).rows[0]?.id)
  const keep = await find('LEGACY COMMODITIES PVT LTD')
  const dup = await find('LEGACY COMMODITIES PVT. LTD')
  const out: string[] = []
  if (keep && dup) {
    const r = await mergeSupplier(dup, keep)
    out.push(`merged ${r.from} into ${r.to}: ${Object.entries(r.moved as Record<string, unknown[]>).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
  }
  // A ledger with no entry at all, hidden in every company (Masters → Show hidden brings it back).
  const led = (await c.execute("SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = 'LEGACY COMMODITIES PRIVATE LIMITED'")).rows[0] as unknown as Row | undefined
  if (led) {
    const used = n((await c.execute({ sql: 'SELECT COUNT(*) AS k FROM journal_lines WHERE account_id = ?', args: [n(led.id)] })).rows[0]?.k)
    const open = n((await c.execute({ sql: 'SELECT COUNT(*) AS k FROM ledger_openings WHERE account_id = ? AND (dr <> 0 OR cr <> 0)', args: [n(led.id)] }).catch(() => ({ rows: [{ k: 0 }] }))).rows[0]?.k)
    if (!used && !open) {
      const cos = (await c.execute('SELECT id FROM companies')).rows.map((r) => n((r as unknown as Row).id))
      for (const co of cos) await c.execute({ sql: 'INSERT OR IGNORE INTO ledger_hidden (account_id, company_id) VALUES (?, ?)', args: [n(led.id), co] })
      out.push('hid LEGACY COMMODITIES PRIVATE LIMITED (no entries)')
    }
  }
  return out.join('; ') || 'nothing to do'
}
