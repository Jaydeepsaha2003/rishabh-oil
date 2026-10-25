import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { getActiveCompanyId } from './company'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

export type GroupNature = 'asset' | 'liability' | 'income' | 'expense'

/**
 * THE CHART OF ACCOUNTS AS A TREE, NOT A LIST.
 *
 * Groups used to be twenty-six fixed names in a TypeScript array. That is the
 * shape Tally's chart LOOKS like from a distance and it is not the shape it
 * is: a group sits UNDER another group, to any depth the books need — LOANS
 * (LIABILITY) → SECURED LOANS → TERM LOANS → HDFC TERM LOAN — and a mill's
 * accountant adds to it constantly, because the whole point of a group is to
 * total up the things that belong together.
 *
 * So the names move into a table with a parent on each row, and a ledger names
 * its group exactly as it did before: ledger_accounts.acc_group is still the
 * group's NAME. Nothing about existing postings changes, no row is rewritten
 * to carry an id, and a book that has never opened this screen reads the same
 * as it always did.
 *
 * WHERE NATURE COMES FROM. A group's side of the books is its ROOT's — the
 * fifteen primaries carry it and everything beneath inherits, which is what
 * makes an infinitely deep tree safe to add to. Create TERM LOANS under
 * SECURED LOANS and it is a liability without anyone being asked, and it is
 * a liability the day it is created rather than after someone remembers.
 */
export const DEFAULT_GROUPS: { name: string; under: string | null; nature: GroupNature }[] = [
  // The fifteen primaries. A primary has no parent and IS the side of the
  // books; everything below takes its nature from whichever of these it
  // ultimately sits under.
  { name: 'Capital Account', under: null, nature: 'liability' },
  { name: 'Loans (Liability)', under: null, nature: 'liability' },
  { name: 'Current Liabilities', under: null, nature: 'liability' },
  { name: 'Fixed Assets', under: null, nature: 'asset' },
  { name: 'Investments', under: null, nature: 'asset' },
  { name: 'Current Assets', under: null, nature: 'asset' },
  { name: 'Branch / Divisions', under: null, nature: 'asset' },
  { name: 'Misc. Expenses (Asset)', under: null, nature: 'asset' },
  { name: 'Suspense A/c', under: null, nature: 'asset' },
  { name: 'Sales Accounts', under: null, nature: 'income' },
  { name: 'Direct Incomes', under: null, nature: 'income' },
  { name: 'Indirect Incomes', under: null, nature: 'income' },
  { name: 'Purchase Accounts', under: null, nature: 'expense' },
  { name: 'Direct Expenses', under: null, nature: 'expense' },
  { name: 'Indirect Expenses', under: null, nature: 'expense' },
  // Tally's thirteen standard sub-groups, under the primary each belongs to.
  // Every one of these resolves to the SAME nature the old flat list gave it —
  // deliberately, because the trial balance and the trading account read
  // nature to decide which side a figure falls on, and this change must not
  // move a single figure.
  { name: 'Reserves & Surplus', under: 'Capital Account', nature: 'liability' },
  { name: 'Secured Loans', under: 'Loans (Liability)', nature: 'liability' },
  { name: 'Unsecured Loans', under: 'Loans (Liability)', nature: 'liability' },
  { name: 'Bank OD A/c', under: 'Loans (Liability)', nature: 'liability' },
  { name: 'Duties & Taxes', under: 'Current Liabilities', nature: 'liability' },
  { name: 'Provisions', under: 'Current Liabilities', nature: 'liability' },
  { name: 'Sundry Creditors', under: 'Current Liabilities', nature: 'liability' },
  { name: 'Bank Accounts', under: 'Current Assets', nature: 'asset' },
  { name: 'Cash-in-Hand', under: 'Current Assets', nature: 'asset' },
  { name: 'Deposits (Asset)', under: 'Current Assets', nature: 'asset' },
  { name: 'Loans & Advances (Asset)', under: 'Current Assets', nature: 'asset' },
  { name: 'Stock-in-Hand', under: 'Current Assets', nature: 'asset' },
  { name: 'Sundry Debtors', under: 'Current Assets', nature: 'asset' },
  // This book's own catch-all. Not Tally's, but every ledger the app has ever
  // auto-created without being told a group landed here, so it has to exist
  // and it has to keep reading as an asset, exactly as it did.
  { name: 'General', under: null, nature: 'asset' }
]

export async function ensureGroupTable(): Promise<void> {
  const c = getClient()
  await c.execute(
    `CREATE TABLE IF NOT EXISTS ledger_groups (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL UNIQUE,
       parent_id INTEGER REFERENCES ledger_groups(id),
       nature TEXT NOT NULL DEFAULT 'asset',
       is_system INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  )
  await c.execute('CREATE INDEX IF NOT EXISTS idx_ledger_groups_parent ON ledger_groups(parent_id)')
}

/**
 * EVERY NAME THE BOOKS ALREADY USE, AND NOT ONE FEWER.
 *
 * Seeding the twenty-nine standard groups is the easy half. The half that
 * matters is the acc_group values already sitting on ledgers: a book that was
 * given a group name this list has never heard of must not have its ledgers
 * orphaned into a group that does not exist, because the Masters screen would
 * then simply not show them and the trial balance would lose their heading.
 *
 * Anything unrecognised is adopted as a primary of its own with nature
 * 'asset' — which is precisely what the old groupNature() returned for an
 * unknown name, so nothing moves sides.
 */
export async function seedDefaultGroups(): Promise<void> {
  const c = getClient()
  await ensureGroupTable()
  for (const g of DEFAULT_GROUPS) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO ledger_groups (name, parent_id, nature, is_system) VALUES (?, NULL, ?, 1)',
      args: [g.name, g.nature]
    })
  }
  // Parents in a second pass: a sub-group's parent may be inserted after it.
  for (const g of DEFAULT_GROUPS) {
    if (!g.under) continue
    await c.execute({
      sql: `UPDATE ledger_groups SET parent_id = (SELECT id FROM ledger_groups WHERE name = ?)
             WHERE name = ? AND parent_id IS NULL`,
      args: [g.under, g.name]
    })
  }
  const strays = toPlain(
    await c.execute(
      `SELECT DISTINCT TRIM(acc_group) AS g FROM ledger_accounts
        WHERE TRIM(COALESCE(acc_group,'')) <> ''
          AND TRIM(acc_group) NOT IN (SELECT name FROM ledger_groups)`
    )
  )
  for (const s of strays) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO ledger_groups (name, parent_id, nature, is_system) VALUES (?, NULL, 'asset', 0)",
      args: [String(s.g)]
    })
  }
}

async function rawGroups(): Promise<Row[]> {
  await ensureGroupTable()
  const rows = toPlain(
    await getClient().execute('SELECT id, name, parent_id, nature, is_system FROM ledger_groups ORDER BY name')
  )
  // An empty table means this book has not run the seed yet — a fresh restore,
  // a snapshot taken before this existed. Seed on the spot rather than hand
  // back nothing: a chart of accounts with no groups in it is not a state any
  // screen should have to render.
  if (!rows.length) {
    await seedDefaultGroups()
    return toPlain(
      await getClient().execute('SELECT id, name, parent_id, nature, is_system FROM ledger_groups ORDER BY name')
    )
  }
  return rows
}

// Depth, path and the inherited nature, worked out once for the whole table.
function decorate(rows: Row[]): Row[] {
  const byId = new Map<number, Row>()
  for (const r of rows) byId.set(Number(r.id), r)
  const seen = (r: Row): { depth: number; path: string; nature: GroupNature; root: string; base: string } => {
    const chain: Row[] = []
    let cur: Row | undefined = r
    // A guard, not a formality: a cycle here would hang the process, and the
    // only thing standing between the books and one is a move that was
    // checked. Checks can be wrong; a loop that never ends cannot be debugged
    // from a screen that never paints.
    const guard = new Set<number>()
    while (cur && !guard.has(Number(cur.id))) {
      guard.add(Number(cur.id))
      chain.unshift(cur)
      cur = cur.parent_id == null ? undefined : byId.get(Number(cur.parent_id))
    }
    const root = chain[0] || r
    // The nearest standard group at or above it — SC-OIL, a group of the
    // books' own under Sundry Creditors, is Sundry Creditors for bill-wise,
    // party matching and the rest; a standard group is itself.
    const base = [...chain].reverse().find((x) => Number(x.is_system) === 1) || root
    return {
      base: String(base.name || ''),
      depth: chain.length - 1,
      path: chain.map((x) => String(x.name)).join(' › '),
      nature: (String(root.nature || 'asset') as GroupNature) || 'asset',
      root: String(root.name || '')
    }
  }
  return rows.map((r) => ({ ...r, ...seen(r) }))
}

/** Every group, flat, each carrying its depth, its full path and its nature. */
export async function listGroupNames(): Promise<Row[]> {
  const rows = decorate(await rawGroups())
  const byId = new Map<number, Row>()
  for (const r of rows) byId.set(Number(r.id), r)
  return rows
    .map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      parent_id: r.parent_id == null ? null : Number(r.parent_id),
      parent: r.parent_id == null ? null : String(byId.get(Number(r.parent_id))?.name || ''),
      nature: r.nature,
      root: r.root,
      depth: r.depth,
      path: r.path,
      base: r.base,
      is_system: Number(r.is_system) ? 1 : 0
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** group name → the nearest standard group at or above it (itself if standard). */
export async function groupBaseMap(): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  try {
    for (const r of decorate(await rawGroups())) m.set(String(r.name), String(r.base))
  } catch {
    // An older books file: names read as themselves.
  }
  return m
}

/** The standard group a group name stands for — Sundry Creditors for SC-OIL. */
export async function baseGroupOf(group: unknown): Promise<string> {
  const g = String(group || '').trim()
  if (!g) return ''
  return (await groupBaseMap()).get(g) || g
}

/** Every group name that is, or sits under, the given standard group. */
export async function groupsUnder(base: string): Promise<string[]> {
  const out = [base]
  for (const [name, b] of await groupBaseMap()) if (b === base && name !== base) out.push(name)
  return out
}

/** group name → the side of the books it falls on, inherited from its root. */
export async function groupNatureMap(): Promise<Map<string, GroupNature>> {
  const m = new Map<string, GroupNature>()
  try {
    for (const r of decorate(await rawGroups())) m.set(String(r.name), r.nature as GroupNature)
  } catch {
    // The caller has a static fallback for exactly this — a books file older
    // than the table, read before bootstrap has finished with it.
  }
  return m
}

/**
 * THE MASTERS SCREEN'S OWN LIST: every group with what hangs off it.
 *
 * Direct counts and balances come from the ledgers naming this group; the
 * totals are the subtree's, because the reason a group exists at all is to
 * total up what sits under it. A group with nothing in it still comes back —
 * it was just created, and a newly made group that does not appear looks like
 * a failed save.
 */
export async function groupTree(companyId?: number): Promise<Row[]> {
  const cid = companyId || getActiveCompanyId()
  const rows = decorate(await rawGroups())
  const direct = toPlain(
    await getClient().execute({
      args: [cid],
      sql: `SELECT TRIM(a.acc_group) AS g, COUNT(*) AS n,
                   COALESCE(SUM((SELECT COALESCE(SUM(jl.dr) - SUM(jl.cr), 0)
                                   FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                                  WHERE jl.account_id = a.id AND je.company_id = ?)), 0) AS bal
              FROM ledger_accounts a GROUP BY TRIM(a.acc_group)`
    })
  )
  const own = new Map<string, { n: number; bal: number }>()
  for (const d of direct) own.set(String(d.g || ''), { n: Number(d.n) || 0, bal: Number(d.bal) || 0 })

  const kids = new Map<number, number[]>()
  for (const r of rows) {
    const p = r.parent_id == null ? 0 : Number(r.parent_id)
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p)!.push(Number(r.id))
  }
  const byId = new Map<number, Row>()
  for (const r of rows) byId.set(Number(r.id), r)

  const totals = new Map<number, { n: number; bal: number; groups: number }>()
  const roll = (id: number, guard: Set<number>): { n: number; bal: number; groups: number } => {
    if (totals.has(id)) return totals.get(id)!
    if (guard.has(id)) return { n: 0, bal: 0, groups: 0 }
    guard.add(id)
    const me = byId.get(id)
    const o = own.get(String(me?.name || '')) || { n: 0, bal: 0 }
    let n = o.n
    let bal = o.bal
    let groups = 0
    for (const k of kids.get(id) || []) {
      const sub = roll(k, guard)
      n += sub.n
      bal += sub.bal
      groups += 1 + sub.groups
    }
    const out = { n, bal, groups }
    totals.set(id, out)
    return out
  }

  return rows
    .map((r) => {
      const id = Number(r.id)
      const o = own.get(String(r.name)) || { n: 0, bal: 0 }
      const t = roll(id, new Set())
      return {
        id,
        name: String(r.name),
        parent_id: r.parent_id == null ? null : Number(r.parent_id),
        parent: r.parent_id == null ? null : String(byId.get(Number(r.parent_id))?.name || ''),
        nature: r.nature,
        root: r.root,
        depth: r.depth,
        path: r.path,
        is_system: Number(r.is_system) ? 1 : 0,
        child_groups: (kids.get(id) || []).length,
        ledgers: o.n,
        balance: Math.round(o.bal * 100) / 100,
        total_ledgers: t.n,
        total_groups: t.groups,
        total_balance: Math.round(t.bal * 100) / 100
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

const clean = (s: unknown): string => String(s ?? '').trim().replace(/\s+/g, ' ')

async function groupByName(name: string): Promise<Row | null> {
  const res = await getClient().execute({
    sql: 'SELECT id, name, parent_id, nature, is_system FROM ledger_groups WHERE TRIM(UPPER(name)) = TRIM(UPPER(?))',
    args: [name]
  })
  return res.rows.length ? toPlain(res)[0] : null
}

async function groupById(id: number): Promise<Row | null> {
  const res = await getClient().execute({
    sql: 'SELECT id, name, parent_id, nature, is_system FROM ledger_groups WHERE id = ?',
    args: [id]
  })
  return res.rows.length ? toPlain(res)[0] : null
}

/**
 * A NEW GROUP, UNDER WHICHEVER ONE IT BELONGS TO.
 *
 * "Under" is the whole feature: a group with no parent is a sixteenth primary
 * and a new side of the books, which is almost never what anybody means. So a
 * parent is required unless the caller says outright that it wants a primary,
 * and a primary has to declare its nature, because there is nothing above it
 * to inherit from.
 */
export async function createGroup(a: {
  name: string
  under?: string | number | null
  nature?: GroupNature
}): Promise<{ id: number }> {
  await ensureGroupTable()
  const name = clean(a.name)
  if (!name) throw new Error('A group needs a name')
  if (await groupByName(name)) throw new Error(`There is already a group called ${name}`)
  let parent: Row | null = null
  if (a.under != null && String(a.under) !== '') {
    parent = typeof a.under === 'number' ? await groupById(a.under) : await groupByName(String(a.under))
    if (!parent) throw new Error(`No group called ${String(a.under)} to put this under`)
  }
  const nature: GroupNature = parent ? 'asset' : a.nature || 'asset'
  const res = await getClient().execute({
    sql: 'INSERT INTO ledger_groups (name, parent_id, nature, is_system) VALUES (?, ?, ?, 0)',
    args: [name, parent ? Number(parent.id) : null, nature]
  })
  return { id: Number(res.lastInsertRowid || 0) }
}

/**
 * A RENAME IS A RENAME EVERYWHERE, OR IT IS A LOST GROUP.
 *
 * Ledgers name their group by its name, so renaming the row alone would leave
 * every ledger under it pointing at a group that no longer exists — they would
 * vanish from Masters and reappear in the trial balance under a heading with
 * no ledgers in it. The two go together or neither happens.
 */
export async function renameGroup(id: number, name: string): Promise<{ id: number }> {
  const c = getClient()
  const g = await groupById(Number(id))
  if (!g) throw new Error('No such group')
  const next = clean(name)
  if (!next) throw new Error('A group needs a name')
  if (String(g.name) === next) return { id: Number(id) }
  const clash = await groupByName(next)
  if (clash && Number(clash.id) !== Number(id)) throw new Error(`There is already a group called ${next}`)
  await c.execute({ sql: 'UPDATE ledger_groups SET name = ? WHERE id = ?', args: [next, Number(id)] })
  await c.execute({
    sql: 'UPDATE ledger_accounts SET acc_group = ? WHERE TRIM(acc_group) = ?',
    args: [next, String(g.name)]
  })
  return { id: Number(id) }
}

/** Move a group under another one — or to the top, where it becomes a primary. */
export async function moveGroup(id: number, parentId: number | null, nature?: GroupNature): Promise<{ id: number }> {
  const c = getClient()
  const g = await groupById(Number(id))
  if (!g) throw new Error('No such group')
  if (parentId != null && Number(parentId) === Number(id)) throw new Error('A group cannot sit under itself')
  if (parentId != null) {
    // WALK UP BEFORE WRITING. Putting a group under its own descendant makes a
    // ring, and a ring in a chart of accounts is not a wrong total — it is a
    // report that never finishes drawing.
    const rows = await rawGroups()
    const byId = new Map<number, Row>()
    for (const r of rows) byId.set(Number(r.id), r)
    let cur = byId.get(Number(parentId))
    const guard = new Set<number>()
    while (cur && !guard.has(Number(cur.id))) {
      if (Number(cur.id) === Number(id)) throw new Error('That would put the group inside itself')
      guard.add(Number(cur.id))
      cur = cur.parent_id == null ? undefined : byId.get(Number(cur.parent_id))
    }
    if (!byId.has(Number(parentId))) throw new Error('No such parent group')
  }
  await c.execute({
    sql: 'UPDATE ledger_groups SET parent_id = ?, nature = ? WHERE id = ?',
    args: [parentId == null ? null : Number(parentId), parentId == null ? nature || String(g.nature) : String(g.nature), Number(id)]
  })
  return { id: Number(id) }
}

/**
 * Deleting a group is only ever safe when nothing depends on it. Tally's own
 * groups are never deletable at all — a chart missing SUNDRY DEBTORS is not a
 * customised chart, it is a broken one.
 */
export async function deleteGroup(id: number): Promise<{ id: number }> {
  const c = getClient()
  const g = await groupById(Number(id))
  if (!g) throw new Error('No such group')
  if (Number(g.is_system)) throw new Error(`${String(g.name)} is one of the standard groups and cannot be deleted`)
  const kids = await c.execute({ sql: 'SELECT COUNT(*) AS n FROM ledger_groups WHERE parent_id = ?', args: [Number(id)] })
  if (Number(kids.rows[0]?.n || 0) > 0) throw new Error('Move or delete the groups under it first')
  const used = await c.execute({
    sql: 'SELECT COUNT(*) AS n FROM ledger_accounts WHERE TRIM(acc_group) = ?',
    args: [String(g.name)]
  })
  if (Number(used.rows[0]?.n || 0) > 0) {
    throw new Error(`${Number(used.rows[0].n)} ledger(s) still sit under ${String(g.name)} — move them first`)
  }
  await c.execute({ sql: 'DELETE FROM ledger_groups WHERE id = ?', args: [Number(id)] })
  return { id: Number(id) }
}

/**
 * DELETING A LEDGER — only one nothing uses: no voucher line, no bill
 * allocation, no opening figure, no party record of that name (which would
 * re-create it on the next save) and no rename redirect pointing at it. A
 * ledger with history is merged or hidden instead, never deleted.
 */
export async function deleteLedger(id: number): Promise<{ id: number; name: string }> {
  const c = getClient()
  const a = (await c.execute({ sql: 'SELECT id, name FROM ledger_accounts WHERE id = ?', args: [Number(id)] })).rows[0] as unknown as Row | undefined
  if (!a) throw new Error('No such ledger')
  const name = String(a.name || '')
  const key = name.trim().toUpperCase()
  const count = async (sql: string, args: (string | number)[]): Promise<number> =>
    Number(((await c.execute({ sql, args })).rows[0] as unknown as Row | undefined)?.n || 0)
  const lines = await count('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', [Number(id)])
  if (lines) throw new Error(`${name} has ${lines} voucher line(s) — merge it into another ledger or hide it instead`)
  if (await count('SELECT COUNT(*) AS n FROM journal_bill_allocs WHERE account_id = ?', [Number(id)]))
    throw new Error(`${name} has bill allocations — merge it into another ledger or hide it instead`)
  if (await count('SELECT COUNT(*) AS n FROM ledger_openings WHERE account_id = ? AND (ABS(COALESCE(dr, 0)) > 0.004 OR ABS(COALESCE(cr, 0)) > 0.004)', [Number(id)]))
    throw new Error(`${name} has an opening balance — clear it under Opening balances first`)
  // The party masters name their ledger; "X (DR)"/"X (CR)" is party X's split ledger.
  const bare = key.replace(/\s*\((DR|CR)\)$/, '')
  for (const [t, what] of [
    ['suppliers', 'supplier'],
    ['customers', 'customer'],
    ['transporters', 'transporter'],
    ['brokers', 'broker']
  ]) {
    const hit = await count(`SELECT COUNT(*) AS n FROM ${t} WHERE TRIM(UPPER(name)) IN (?, ?)`, [key, bare]).catch(() => 0)
    if (hit) throw new Error(`${name} is the ledger of a ${what} of that name — rename or remove the ${what} first, or it comes back on its next save`)
  }
  if (await count('SELECT COUNT(*) AS n FROM ledger_map WHERE TRIM(UPPER(use_name)) = ?', [key]))
    throw new Error(`Old names are redirected to ${name} — it cannot be deleted while they point here`)
  await withDbTransaction(async () => {
    const tx = getClient() // the transaction's client inside withDbTransaction
    await tx.execute({ sql: 'DELETE FROM ledger_openings WHERE account_id = ?', args: [Number(id)] })
    for (const t of ['ledger_homes', 'company_bank_accounts']) {
      await tx.execute({ sql: `DELETE FROM ${t} WHERE account_id = ?`, args: [Number(id)] }).catch(() => undefined)
    }
    for (const t of ['tally_import_map', 'tally_ledgers']) {
      await tx.execute({ sql: `UPDATE ${t} SET account_id = NULL WHERE account_id = ?`, args: [Number(id)] }).catch(() => undefined)
    }
    await tx.execute({ sql: 'DELETE FROM ledger_accounts WHERE id = ?', args: [Number(id)] })
  })
  return { id: Number(id), name }
}

/**
 * MOVING A LEDGER, NOT RENAMING IT.
 *
 * Which group a ledger sits under is presentation — it decides the heading it
 * prints under and the side it falls on, and nothing else in the app reads it.
 * The NAME is different: half this app's postings find their ledger by name
 * (getOrCreateAccount), so renaming one would quietly strand its history and
 * open a fresh account under the new name at the next posting. That is why
 * only the group moves here.
 */
/** Several ledgers into one group at once — Masters' multi-select. All or none. */
export async function setAccountsGroup(accountIds: number[], group: string): Promise<{ moved: number; group: string }> {
  const ids = Array.from(new Set((accountIds || []).map(Number).filter((x) => x > 0)))
  if (!ids.length) throw new Error('Pick the ledgers to move')
  const g = await groupByName(String(group))
  if (!g) throw new Error(`No group called ${String(group)}`)
  return withDbTransaction(async () => {
    const c = getClient()
    const found = await c.execute(`SELECT COUNT(*) AS n FROM ledger_accounts WHERE id IN (${ids.join(',')})`)
    if (Number(found.rows[0]?.n) !== ids.length) throw new Error('Some of those ledgers no longer exist — refresh and try again')
    await c.execute({ sql: `UPDATE ledger_accounts SET acc_group = ? WHERE id IN (${ids.join(',')})`, args: [String(g.name)] })
    return { moved: ids.length, group: String(g.name) }
  })
}

/** Hide ledgers from the pickers and the chart's list, or bring them back. */
export async function setAccountsHidden(accountIds: number[], hidden: boolean): Promise<{ changed: number; hidden: boolean }> {
  const ids = Array.from(new Set((accountIds || []).map(Number).filter((x) => x > 0)))
  if (!ids.length) throw new Error('Pick the ledgers to hide')
  const c = getClient()
  const r = await c.execute({ sql: `UPDATE ledger_accounts SET is_hidden = ? WHERE id IN (${ids.join(',')})`, args: [hidden ? 1 : 0] })
  return { changed: Number(r.rowsAffected) || 0, hidden: !!hidden }
}

export async function setAccountGroup(accountId: number, group: string): Promise<{ id: number }> {
  const c = getClient()
  const g = await groupByName(String(group))
  if (!g) throw new Error(`No group called ${String(group)}`)
  const acc = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE id = ?', args: [Number(accountId)] })
  if (!acc.rows.length) throw new Error('No such ledger')
  await c.execute({
    sql: 'UPDATE ledger_accounts SET acc_group = ? WHERE id = ?',
    args: [String(g.name), Number(accountId)]
  })
  return { id: Number(accountId) }
}
