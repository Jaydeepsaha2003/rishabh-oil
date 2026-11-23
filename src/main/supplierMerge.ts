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

/**
 * UNDO legacy_supplier_merge_v1 from its own log (accounting_repair_log
 * 'supplier_merge_v1:<id>'): the supplier row comes back with its own id, every
 * row it moved goes back, its opening billing is taken off the kept master again,
 * and the ledger the clean-up hid is shown again. No log, nothing done.
 */
export async function undoLegacySupplierMerge(): Promise<string> {
  return withDbTransaction(async () => {
    const c = getClient()
    const has = (await c.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounting_repair_log'")).rows.length > 0
    if (!has) return 'no merge to undo'
    const logs = (await c.execute("SELECT repair_key, before_json FROM accounting_repair_log WHERE repair_key LIKE 'supplier_merge_v1:%'")).rows as unknown as Row[]
    const out: string[] = []
    for (const l of logs) {
      const b = JSON.parse(String(l.before_json)) as { from: Row; to: { id: number; name: string }; moved: Record<string, number[]> }
      const from = b.from
      const fromId = n(from.id)
      const toId = n(b.to.id)
      if ((await c.execute({ sql: 'SELECT 1 FROM suppliers WHERE id = ?', args: [fromId] })).rows.length) continue
      // The supplier, column for column as it was.
      const cols = (await c.execute('PRAGMA table_info(suppliers)')).rows.map((r) => String((r as unknown as Row).name)).filter((k) => k in from)
      await c.execute({ sql: `INSERT INTO suppliers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, args: cols.map((k) => from[k] ?? null) })
      // Every row the merge moved, back.
      for (const [key, ids] of Object.entries(b.moved)) {
        if (key === 'party_openings' || !ids.length) continue
        const [t, col] = key.split('.')
        await c.execute({ sql: `UPDATE ${t} SET ${col} = ? WHERE rowid IN (${ids.map(() => '?').join(',')}) AND ${col} = ?`, args: [fromId, ...ids, toId] })
      }
      // The opening billing it added to the kept master, per company, split off again.
      const amt = n(from.opening_purchase_amount)
      for (const co of b.moved.party_openings || []) {
        await c.execute({ sql: "UPDATE party_openings SET amount = amount - ? WHERE kind = 'supplier' AND party_id = ? AND company_id = ?", args: [amt, toId, n(co)] })
        await c.execute({
          sql: "INSERT INTO party_openings (kind, party_id, company_id, amount, as_on) VALUES ('supplier', ?, ?, ?, ?)",
          args: [fromId, n(co), amt, from.opening_purchase_date ?? null]
        })
      }
      await c.execute({ sql: 'DELETE FROM accounting_repair_log WHERE repair_key = ?', args: [String(l.repair_key)] })
      out.push(`restored ${String(from.name)} (#${fromId})`)
    }
    // The ledger the clean-up hid.
    const led = (await c.execute("SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = 'LEGACY COMMODITIES PRIVATE LIMITED'")).rows[0] as unknown as Row | undefined
    if (led && out.length) {
      await c.execute({ sql: 'DELETE FROM ledger_hidden WHERE account_id = ?', args: [n(led.id)] })
      out.push('LEGACY COMMODITIES PRIVATE LIMITED shown again')
    }
    return out.join('; ') || 'no merge to undo'
  })
}

/**
 * One-time (asked for 2026-11-23): LEGACY's Manufacturing master ("LEGACY
 * COMMODITIES PVT. LTD") posts to LEGACY COMMODITIES PRIVATE LIMITED(RAJKOT),
 * not the Trading ledger ", TRAD.". The site-wide redirect is re-pointed and the
 * party lines of that master's own purchase bills move over (logged first).
 * The LC-14 / LC-15 journals stay on TRAD.: Tally settles RAJKOT's opening with
 * its own two payments, so those LCs paid the Trading account.
 */
export async function legacyMfgLedger(): Promise<string> {
  return withDbTransaction(async () => {
    const c = getClient()
    const MFG = 'LEGACY COMMODITIES PVT. LTD'
    const RAJKOT = 'LEGACY COMMODITIES PRIVATE LIMITED(RAJKOT)'
    const TRAD = 'LEGACY COMMODITIES PVT LTD, TRAD.'
    const sup = n((await c.execute({ sql: 'SELECT id FROM suppliers WHERE UPPER(TRIM(name)) = ? ORDER BY id LIMIT 1', args: [MFG] })).rows[0]?.id)
    const led = async (name: string): Promise<number> =>
      n((await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = ? ORDER BY id LIMIT 1', args: [name] })).rows[0]?.id)
    const raj = await led(RAJKOT)
    const trad = await led(TRAD)
    if (!sup || !raj) return 'nothing to do'
    const out: string[] = []
    const up = await c.execute({ sql: 'UPDATE ledger_map SET use_name = ? WHERE company_id IS NULL AND TRIM(UPPER(posts_as)) = ?', args: [RAJKOT, MFG] })
    if (!up.rowsAffected) {
      await c.execute({ sql: "INSERT INTO ledger_map (company_id, posts_as, use_name, note) VALUES (NULL, ?, ?, 'Manufacturing master posts to Rajkot')", args: [MFG, RAJKOT] })
    }
    out.push(`${MFG} → ${RAJKOT}`)
    if (trad) {
      const lines = (await c.execute({
        sql: `SELECT jl.id, jl.entry_id, jl.dr, jl.cr FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.account_id = ? AND je.order_id IN (SELECT id FROM orders WHERE supplier_id = ?)`,
        args: [trad, sup]
      })).rows as unknown as Row[]
      if (lines.length) {
        await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
          repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
        await c.execute({
          sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
          args: ['legacy_mfg_ledger_v1', 0, JSON.stringify({ from: trad, to: raj, lines })]
        })
        await c.execute({ sql: `UPDATE journal_lines SET account_id = ? WHERE id IN (${lines.map(() => '?').join(',')})`, args: [raj, ...lines.map((l) => n(l.id))] })
        out.push(`${lines.length} bill line(s) moved to RAJKOT`)
      }
    }
    return out.join('; ')
  })
}
