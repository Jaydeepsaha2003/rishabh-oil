// MERGING ONE PRODUCT INTO ANOTHER — once, reviewed, by an administrator.
// -----------------------------------------------------------------------------
// A product opened twice under two names (CPO and CPO-BUNGE: the same oil,
// booked for one supplier under a name of its own) splits everything that
// should add up — the stock, the bargains, the purchase ledger, the day-close
// counts. This moves every record from one to the other and retires the first.
//
// It is the preview-then-apply pattern the books repairs use, and for the same
// reason: it changes historical rows, so it is never a startup job. The
// preview lists every table it will touch and how many rows; nothing changes
// until an administrator confirms; the whole move is ONE transaction; and every
// row moved, combined or removed is written to product_merge_log first, so the
// merge can be traced — and, if it ever had to be, reversed — row by row.
//
// What it will not do is guess. Where a table allows only one row per product
// per day or per sheet and BOTH products have one, the rows are added together
// only when that is plainly right (quantities counted or planned on the same
// day). Where it is not (a PP lot's frozen snapshot, an opening PP line with
// its own FFA) the merge is refused and the preview says which rows are in the
// way.
import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { assertAdmin } from './access-gate'
import { getCurrentUser } from './currentUser'
import { ensureLedgerMap } from './ledgerMap'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

// Every column in the schema that holds a product id, and what to do when the
// same key already exists under the product being merged INTO.
type Ref = {
  table: string
  col: string
  label: string
  // Unique per product on these columns: rows that meet are added together…
  combine?: { keys: string[]; sum: string[] }
  // …or, where adding them together would not be right, the merge is refused.
  blockOn?: string[]
}
const REFS: Ref[] = [
  { table: 'bargains', col: 'oil_type_id', label: 'Purchase bargains' },
  { table: 'orders', col: 'oil_type_id', label: 'Purchase invoices' },
  { table: 'purchase_tankers', col: 'oil_type_id', label: 'Tankers' },
  { table: 'gate_entries', col: 'oil_type_id', label: 'Gate entries' },
  { table: 'outside_tankers', col: 'product_id', label: 'Outside tankers' },
  { table: 'consignment_stock', col: 'product_id', label: 'Consignment stock' },
  { table: 'consignment_opening_log', col: 'product_id', label: 'Consignment opening log' },
  { table: 'sales', col: 'product_id', label: 'Sales lines' },
  { table: 'sales_bargains', col: 'product_id', label: 'Sales bargains' },
  { table: 'trading_deals', col: 'product_id', label: 'Trading deals' },
  { table: 'note_items', col: 'product_id', label: 'Debit / credit note lines' },
  { table: 'production', col: 'product_id', label: 'Production runs' },
  { table: 'production_items', col: 'product_id', label: 'Production inputs and outputs' },
  { table: 'pp_draws', col: 'product_id', label: 'PP draws' },
  { table: 'pp_writeoffs', col: 'product_id', label: 'PP write-offs' },
  { table: 'pp_writeoffs', col: 'to_product_id', label: 'PP write-offs (to)' },
  { table: 'formulations', col: 'product_id', label: 'Recipes' },
  { table: 'formulation_items', col: 'product_id', label: 'Recipe lines' },
  { table: 'formulation_items', col: 'byproduct_product_id', label: 'Recipe by-products' },
  { table: 'formulation_versions', col: 'product_id', label: 'Recipe versions' },
  { table: 'packagings', col: 'product_id', label: 'Packed SKUs' },
  { table: 'stock_transfers', col: 'product_id', label: 'Stock transfers' },
  { table: 'stock_opening_set_pp', col: 'product_id', label: 'Opening PP on saved sheets' },
  {
    table: 'stock_counts',
    col: 'product_id',
    label: 'Day close counts',
    combine: { keys: ['company_id', 'count_date'], sum: ['book_qty', 'actual_qty', 'pp_qty', 'actual_value'] }
  },
  {
    table: 'stock_openings',
    col: 'product_id',
    label: 'Opening stock',
    combine: { keys: ['company_id'], sum: ['qty', 'pp_qty', 'adj_qty'] }
  },
  {
    table: 'stock_opening_set_lines',
    col: 'product_id',
    label: 'Opening stock sheets',
    combine: { keys: ['set_id'], sum: ['qty', 'pp_qty', 'adj_qty'] }
  },
  {
    table: 'production_plans',
    col: 'product_id',
    label: 'Production plans',
    combine: { keys: ['factory_id', 'company_id', 'plan_date'], sum: ['planned_qty'] }
  },
  { table: 'stock_opening_pp', col: 'product_id', label: 'Opening PP', blockOn: ['scope', 'stage_id'] },
  { table: 'pp_lots', col: 'product_id', label: 'PP lots', blockOn: ['scope', 'opening_date', 'stage_id'] }
]

let logReady = false
async function ensureLog(): Promise<void> {
  if (logReady) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS product_merge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    from_name TEXT,
    to_id INTEGER NOT NULL,
    to_name TEXT,
    summary_json TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  logReady = true
}

// Which of the listed tables and columns this database actually has — a table
// created on first use (production_plans) may not exist yet.
async function presentRefs(): Promise<Ref[]> {
  const c = getClient()
  const out: Ref[] = []
  const cache = new Map<string, Set<string>>()
  for (const r of REFS) {
    let cols = cache.get(r.table)
    if (!cols) {
      const res = await c.execute(`PRAGMA table_info("${r.table}")`).catch(() => null)
      cols = new Set((res?.rows || []).map((x) => String((x as unknown as Row).name)))
      cache.set(r.table, cols)
    }
    if (cols.has(r.col)) out.push(r)
  }
  return out
}

async function productRow(id: number): Promise<Row | null> {
  const res = await getClient().execute({
    sql: 'SELECT id, name, code, category, uom, active FROM products WHERE id = ?',
    args: [id]
  })
  return (res.rows[0] as unknown as Row) || null
}

// Anything besides journal lines that still points at a ledger by id — a bank
// account, a Tally mapping. A ledger with such a reference is kept (empty)
// rather than deleted out from under it.
async function otherAccountRefs(accountId: number): Promise<number> {
  const c = getClient()
  const tables = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  let hits = 0
  for (const t of tables.rows as unknown as Row[]) {
    const name = String(t.name)
    if (name === 'journal_lines' || name === 'ledger_accounts') continue
    const cols = await c.execute(`PRAGMA table_info("${name}")`)
    for (const col of cols.rows as unknown as Row[]) {
      const k = String(col.name)
      if (!/(^|_)(account|ledger)_id$/.test(k)) continue
      const r = await c.execute({ sql: `SELECT COUNT(*) AS n FROM "${name}" WHERE "${k}" = ?`, args: [accountId] })
      hits += n((r.rows[0] as unknown as Row).n)
    }
  }
  return hits
}

// The name a product's ledgers are opened under: its code, or its name.
const ledgerKey = (p: Row): string => String(p.code || p.name || '').trim().toUpperCase()

async function ledgerPlan(from: Row, to: Row): Promise<Row[]> {
  const c = getClient()
  const fromKey = ledgerKey(from)
  const toKey = ledgerKey(to)
  if (!fromKey || fromKey === toKey) return []
  const res = await c.execute({
    sql: `SELECT la.id, la.name, la.acc_group,
                 (SELECT COUNT(*) FROM journal_lines jl WHERE jl.account_id = la.id) AS lines,
                 (SELECT ROUND(COALESCE(SUM(jl.dr), 0), 2) FROM journal_lines jl WHERE jl.account_id = la.id) AS dr,
                 (SELECT ROUND(COALESCE(SUM(jl.cr), 0), 2) FROM journal_lines jl WHERE jl.account_id = la.id) AS cr
            FROM ledger_accounts la
           WHERE UPPER(TRIM(la.name)) LIKE ? ESCAPE '\\'`,
    args: [`${fromKey.replace(/[%_\\]/g, (m) => `\\${m}`)} %`]
  })
  const out: Row[] = []
  for (const r of res.rows as unknown as Row[]) {
    const name = String(r.name).trim().toUpperCase()
    const toName = `${toKey}${name.slice(fromKey.length)}`
    const t = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE UPPER(TRIM(name)) = ?', args: [toName] })
    out.push({
      from_id: n(r.id),
      from_name: name,
      to_name: toName,
      to_id: t.rows.length ? n((t.rows[0] as unknown as Row).id) : null,
      group: r.acc_group ?? null,
      lines: n(r.lines),
      dr: n(r.dr),
      cr: n(r.cr),
      action: t.rows.length ? 'move' : 'rename'
    })
  }
  return out
}

export async function previewProductMerge(fromId: number, toId: number): Promise<Row> {
  const from = await productRow(n(fromId))
  const to = await productRow(n(toId))
  if (!from || !to) throw new Error('Pick both products')
  if (n(from.id) === n(to.id)) throw new Error('Pick two different products')
  const blockers: string[] = []
  const warnings: string[] = []
  if (String(from.uom || 'MT').toUpperCase() !== String(to.uom || 'MT').toUpperCase()) {
    blockers.push(`${from.name} is kept in ${from.uom || 'MT'} and ${to.name} in ${to.uom || 'MT'} — their quantities cannot be added together`)
  }
  if (String(from.category || '') !== String(to.category || '')) {
    warnings.push(`${from.name} is ${from.category || 'uncategorised'} and ${to.name} is ${to.category || 'uncategorised'} — check they really are the same goods`)
  }

  const c = getClient()
  const rows: Row[] = []
  for (const r of await presentRefs()) {
    const cnt = await c.execute({ sql: `SELECT COUNT(*) AS n FROM "${r.table}" WHERE "${r.col}" = ?`, args: [from.id] })
    const count = n((cnt.rows[0] as unknown as Row).n)
    if (!count) continue
    let meets = 0
    const keys = r.combine?.keys || r.blockOn
    if (keys) {
      const on = keys.map((k) => `COALESCE(b."${k}", '') = COALESCE(a."${k}", '')`).join(' AND ')
      const m = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM "${r.table}" a JOIN "${r.table}" b ON ${on} AND b."${r.col}" = ?
               WHERE a."${r.col}" = ?`,
        args: [to.id, from.id]
      })
      meets = n((m.rows[0] as unknown as Row).n)
      if (meets && r.blockOn) {
        blockers.push(`${r.label}: ${meets} row${meets === 1 ? '' : 's'} exist under both products for the same key — merge those by hand first`)
      }
    }
    rows.push({ table: r.table, col: r.col, label: r.label, count, combined: r.combine ? meets : 0 })
  }
  const ledgers = await ledgerPlan(from, to)
  const oilType = await c
    .execute({ sql: 'SELECT id FROM oil_types WHERE id = ?', args: [from.id] })
    .then((x) => x.rows.length > 0)
    .catch(() => false)

  return {
    from,
    to,
    rows,
    ledgers,
    oilType,
    total: rows.reduce((a, r) => a + n(r.count), 0),
    blockers,
    warnings
  }
}

export async function applyProductMerge(fromId: number, toId: number): Promise<Row> {
  await assertAdmin('Merging products')
  await ensureLog()
  await ensureLedgerMap()
  return withDbTransaction(async () => {
    // Asked again inside the transaction: the preview the admin saw may be
    // minutes old, and what is merged must be what is there now.
    const plan = await previewProductMerge(fromId, toId)
    if (plan.blockers.length) throw new Error(plan.blockers.join(' · '))
    const from = plan.from as Row
    const to = plan.to as Row
    const c = getClient()
    const details: Row = { tables: [], ledgers: [], product: null }
    const refs = (await presentRefs()).filter((r) => (plan.rows as Row[]).some((x) => x.table === r.table && x.col === r.col))

    for (const r of refs) {
      const src = await c.execute({ sql: `SELECT * FROM "${r.table}" WHERE "${r.col}" = ?`, args: [from.id] })
      const moved: number[] = []
      const combined: Row[] = []
      for (const row of src.rows as unknown as Row[]) {
        if (r.combine) {
          const where = r.combine.keys.map((k) => `COALESCE("${k}", '') = COALESCE(?, '')`).join(' AND ')
          const hit = await c.execute({
            sql: `SELECT * FROM "${r.table}" WHERE "${r.col}" = ? AND ${where} LIMIT 1`,
            args: [to.id, ...r.combine.keys.map((k) => row[k] ?? null)]
          })
          const dst = hit.rows[0] as unknown as Row | undefined
          if (dst) {
            // The same day, the same sheet: what was counted or planned under
            // both names is one figure under the one name.
            const sets = r.combine.sum.filter((k) => k in row)
            const vals = sets.map((k) => (row[k] == null && dst[k] == null ? null : r3(n(dst[k]) + n(row[k]))))
            if (sets.length) {
              await c.execute({
                sql: `UPDATE "${r.table}" SET ${sets.map((k) => `"${k}" = ?`).join(', ')} WHERE id = ?`,
                args: [...vals, dst.id]
              })
            }
            await c.execute({ sql: `DELETE FROM "${r.table}" WHERE id = ?`, args: [row.id] })
            combined.push({ removed: row, into: n(dst.id), before: Object.fromEntries(sets.map((k) => [k, dst[k] ?? null])) })
            continue
          }
        }
        await c.execute({ sql: `UPDATE "${r.table}" SET "${r.col}" = ? WHERE id = ?`, args: [to.id, row.id] })
        moved.push(n(row.id))
      }
      details.tables.push({ table: r.table, col: r.col, moved, combined })
    }

    // The ledgers opened under the old name follow it: into the existing
    // ledger of the same kind where there is one, renamed where there is not —
    // and the old name redirected for every book, so nothing reposts onto it.
    for (const l of plan.ledgers as Row[]) {
      if (l.action === 'move' && l.to_id) {
        const lines = await c.execute({ sql: 'SELECT id FROM journal_lines WHERE account_id = ?', args: [l.from_id] })
        await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE account_id = ?', args: [l.to_id, l.from_id] })
        await c.execute({ sql: 'UPDATE ledger_map SET use_name = ? WHERE TRIM(UPPER(use_name)) = ?', args: [l.to_name, l.from_name] })
        await c.execute({
          sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
                VALUES (NULL, ?, ?, ?, ?)
                ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name`,
          args: [l.from_name, l.to_name, `merged ${from.name} into ${to.name}`, getCurrentUser().username || null]
        })
        // The emptied ledger goes, so the chart of accounts does not keep a
        // second, zero-balance purchase ledger for an oil that no longer exists
        // — unless something else still points at it by id.
        const kept = (await otherAccountRefs(n(l.from_id))) > 0
        if (!kept) await c.execute({ sql: 'DELETE FROM ledger_accounts WHERE id = ?', args: [l.from_id] })
        details.ledgers.push({ ...l, kept_empty: kept, line_ids: (lines.rows as unknown as Row[]).map((x) => n(x.id)) })
      } else {
        await c.execute({ sql: 'UPDATE ledger_accounts SET name = ? WHERE id = ?', args: [l.to_name, l.from_id] })
        await c.execute({ sql: 'UPDATE ledger_map SET use_name = ? WHERE TRIM(UPPER(use_name)) = ?', args: [l.to_name, l.from_name] })
        await c.execute({
          sql: `INSERT INTO ledger_map (company_id, posts_as, use_name, note, created_by)
                VALUES (NULL, ?, ?, ?, ?)
                ON CONFLICT(COALESCE(company_id, 0), posts_as) DO UPDATE SET use_name = excluded.use_name`,
          args: [l.from_name, l.to_name, `merged ${from.name} into ${to.name}`, getCurrentUser().username || null]
        })
        details.ledgers.push(l)
      }
    }

    // Retired, not deleted: every register and history row that still names it
    // keeps a name to show, and it no longer appears in any picker.
    await c.execute({ sql: 'UPDATE products SET active = 0, show_in_stock = 0 WHERE id = ?', args: [from.id] })
    if (plan.oilType) await c.execute({ sql: 'UPDATE oil_types SET active = 0 WHERE id = ?', args: [from.id] }).catch(() => undefined)
    details.product = { id: from.id, name: from.name, was_active: from.active }

    const summary = {
      rows: (plan.rows as Row[]).map((r) => ({ label: r.label, count: r.count, combined: r.combined })),
      ledgers: (plan.ledgers as Row[]).map((l) => ({ from: l.from_name, to: l.to_name, lines: l.lines, action: l.action })),
      total: plan.total
    }
    const log = await c.execute({
      sql: `INSERT INTO product_merge_log (from_id, from_name, to_id, to_name, summary_json, details_json, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [from.id, from.name, to.id, to.name, JSON.stringify(summary), JSON.stringify(details), getCurrentUser().username || null]
    })
    return { ok: true, id: Number(log.lastInsertRowid), from: from.name, to: to.name, ...summary }
  })
}

export async function listProductMerges(): Promise<Row[]> {
  await ensureLog()
  const res = await getClient().execute(
    'SELECT id, from_id, from_name, to_id, to_name, summary_json, created_by, created_at FROM product_merge_log ORDER BY id DESC LIMIT 50'
  )
  return (res.rows as unknown as Row[]).map((r) => {
    let summary: Row = {}
    try {
      summary = JSON.parse(String(r.summary_json || '{}'))
    } catch {
      summary = {}
    }
    return { ...r, summary }
  })
}
