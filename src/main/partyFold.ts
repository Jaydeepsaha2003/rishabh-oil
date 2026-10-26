import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { resolveAccountName, renameLedger } from './ledgerMap'
import { mergeLedgers, previewLedgerMerge } from './ledgerMerge'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// FOLDING A BRANCH SUB-LEDGER INTO ITS MAIN PARTY.
//
// A party with several GST registrations is now ONE party with a row per GST
// No. (suppliers/customers.gst_regs), not a ledger per branch. The branches
// made the old way (DEEP CHAND ARYA INDUSTRIES-UP, -OTHERS — linked, of the
// same Trading/Manufacturing type as their main) are folded in, reviewed, per
// database:
//   1. its ledger is merged into the main party's (ledgerMerge — refused while
//      something looks booked twice; that party is then left as it is);
//   2. every record that names it — purchases, sales, bargains, gate entries,
//      LCs, discounted bills… found by their supplier_id / customer_id /
//      (party_type, party_id) columns — names the main party, the bill keeping
//      the branch's GST No. (orders/sales.party_gstin);
//   3. its GSTIN, state and rates become a GST row on the main party, its
//      opening purchase/sale figure is added to the main's, and it is removed.
// A Trading counterpart (a linked party of the OTHER type) is not a branch and
// is never folded.
// ---------------------------------------------------------------------------

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const up = (s: unknown): string => String(s ?? '').trim().toUpperCase()
const typeOf = (p: Row): string => String(p.business_type ?? '').trim().toLowerCase()

type Kind = 'suppliers' | 'customers'
const ID_COL: Record<Kind, string> = { suppliers: 'supplier_id', customers: 'customer_id' }
const PARTY_TYPE: Record<Kind, string> = { suppliers: 'supplier', customers: 'customer' }
// Text copies of the party's name kept beside its id on some records.
const NAME_COLS: Record<Kind, string[]> = { suppliers: ['supplier', 'supplier_name'], customers: ['customer', 'customer_name'] }

async function tablesWith(cols: string[]): Promise<{ table: string; cols: Set<string> }[]> {
  const c = getClient()
  const names = (await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).rows.map((r) => String(r.name))
  const out: { table: string; cols: Set<string> }[] = []
  for (const t of names) {
    const have = new Set((await c.execute(`PRAGMA table_info("${t}")`)).rows.map((r) => String(r.name)))
    if (cols.some((x) => have.has(x))) out.push({ table: t, cols: have })
  }
  return out
}

/** The branch's ledgers and where each goes in the main party's: the name, and its (DR)/(CR) twin. */
async function ledgerPairs(branch: Row, main: Row, cid: number): Promise<{ from: Row; intoName: string; into: Row | null }[]> {
  const c = getClient()
  const find = async (name: string): Promise<Row | null> =>
    ((await c.execute({ sql: 'SELECT id, name, acc_group FROM ledger_accounts WHERE name = ?', args: [up(name)] })).rows[0] as unknown as Row) || null
  const bBase = up(await resolveAccountName(up(branch.name), cid))
  const mBase = up(await resolveAccountName(up(main.name), cid))
  const out: { from: Row; intoName: string; into: Row | null }[] = []
  for (const suf of ['', ' (DR)', ' (CR)']) {
    const from = await find(bBase + suf)
    if (!from) continue
    const intoName = mBase + suf
    out.push({ from, intoName, into: await find(intoName) })
  }
  return out
}

async function branches(): Promise<{ kind: Kind; branch: Row; main: Row }[]> {
  const c = getClient()
  const out: { kind: Kind; branch: Row; main: Row }[] = []
  for (const kind of ['suppliers', 'customers'] as Kind[]) {
    const all = (await c.execute(`SELECT * FROM ${kind}`)).rows as unknown as Row[]
    const byId = new Map(all.map((p) => [n(p.id), p]))
    for (const b of all) {
      const m = b.linked_party_id ? byId.get(n(b.linked_party_id)) : undefined
      if (m && typeOf(m) === typeOf(b)) out.push({ kind, branch: b, main: m })
    }
  }
  return out
}

/** Every branch sub-ledger, with what folding it would move and whether it can. */
export async function previewBranchFold(companyId?: number): Promise<Row[]> {
  const cid = n(companyId) || 1
  const c = getClient()
  const out: Row[] = []
  for (const { kind, branch, main } of await branches()) {
    let docs = 0
    for (const { table, cols } of await tablesWith([ID_COL[kind]])) {
      if (table === kind) continue
      if (cols.has(ID_COL[kind])) docs += n((await c.execute({ sql: `SELECT COUNT(*) AS k FROM "${table}" WHERE ${ID_COL[kind]} = ?`, args: [n(branch.id)] })).rows[0]?.k)
    }
    const pairs = await ledgerPairs(branch, main, cid)
    let lines = 0
    let blocked = ''
    for (const p of pairs) {
      lines += n((await c.execute({ sql: 'SELECT COUNT(*) AS k FROM journal_lines WHERE account_id = ?', args: [n(p.from.id)] })).rows[0]?.k)
      if (p.into && n(p.into.id) !== n(p.from.id)) {
        const pv = await previewLedgerMerge(n(p.from.id), n(p.into.id))
        if (pv.blocked) blocked = String(pv.blocked)
        else if ((pv.copies as Row[]).length)
          blocked = `${(pv.copies as Row[]).length} entr${(pv.copies as Row[]).length === 1 ? 'y looks' : 'ies look'} booked twice between ${p.from.name} and ${p.intoName} — resolve them in Masters → Merge first`
      }
    }
    out.push({
      key: `${kind}:${n(branch.id)}`,
      kind: PARTY_TYPE[kind],
      branch_id: n(branch.id),
      branch: String(branch.name),
      main_id: n(main.id),
      main: String(main.name),
      gstin: branch.gstin || null,
      state: branch.state || null,
      gst_rates: branch.gst_rates || (n(branch.gst_pct) ? String(n(branch.gst_pct)) : null),
      documents: docs,
      ledger_lines: lines,
      ledgers: pairs.map((p) => `${p.from.name} → ${p.intoName}${p.into ? '' : ' (renamed)'}`),
      blocked: blocked || null
    })
  }
  return out
}

/** Fold the ticked branches (keys from previewBranchFold). One party failing leaves the others done. */
export async function foldBranches(keys: string[], companyId?: number): Promise<{ folded: string[]; skipped: { branch: string; reason: string }[] }> {
  const cid = n(companyId) || 1
  const want = new Set(keys)
  const folded: string[] = []
  const skipped: { branch: string; reason: string }[] = []
  for (const { kind, branch, main } of await branches()) {
    if (!want.has(`${kind}:${n(branch.id)}`)) continue
    try {
      // 1. The ledger(s) — merged, or renamed onto the main's name when it has none.
      for (const p of await ledgerPairs(branch, main, cid)) {
        if (!p.into) await renameLedger(n(p.from.id), p.intoName, cid)
        else if (n(p.into.id) !== n(p.from.id)) await mergeLedgers(n(p.from.id), n(p.into.id))
      }
      // 2–3. The records, the GST row, the opening, the party itself — together.
      await withDbTransaction(async () => {
        const c = getClient()
        const b = n(branch.id)
        const m = n(main.id)
        await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
          repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
        await c.execute({
          sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
          args: [`party_fold:${kind}:${b}:${Date.now()}`, 0, JSON.stringify({ branch, main, by: getCurrentUser().username || null })]
        })
        // The bills keep the GST No. they were made under.
        if (branch.gstin) {
          const docTable = kind === 'suppliers' ? 'orders' : 'sales'
          await c.execute({ sql: `UPDATE ${docTable} SET party_gstin = COALESCE(party_gstin, ?) WHERE ${ID_COL[kind]} = ?`, args: [up(branch.gstin), b] })
        }
        // The GST type its bills mostly carried, for its GST row.
        const typeRow = (
          await c.execute({
            sql: `SELECT gst_type, COUNT(*) AS k FROM ${kind === 'suppliers' ? 'orders' : 'sales'} WHERE ${ID_COL[kind]} = ? AND gst_type IS NOT NULL GROUP BY gst_type ORDER BY k DESC LIMIT 1`,
            args: [b]
          })
        ).rows[0]
        for (const { table, cols } of await tablesWith([ID_COL[kind], 'party_id'])) {
          if (table === kind || table === 'party_openings') continue
          if (cols.has(ID_COL[kind])) {
            for (const nc of NAME_COLS[kind]) {
              if (cols.has(nc)) await c.execute({ sql: `UPDATE "${table}" SET ${nc} = ? WHERE ${ID_COL[kind]} = ?`, args: [String(main.name), b] })
            }
            await c.execute({ sql: `UPDATE "${table}" SET ${ID_COL[kind]} = ? WHERE ${ID_COL[kind]} = ?`, args: [m, b] })
          }
          if (cols.has('party_id') && cols.has('party_type')) {
            await c.execute({ sql: `UPDATE "${table}" SET party_id = ? WHERE party_id = ? AND LOWER(party_type) = ?`, args: [m, b, PARTY_TYPE[kind]] })
          }
        }
        // The opening purchase/sale figure (TDS slab) adds to the main's.
        for (const o of (await c.execute({ sql: 'SELECT * FROM party_openings WHERE kind = ? AND party_id = ?', args: [PARTY_TYPE[kind], b] }).catch(() => ({ rows: [] }))).rows as unknown as Row[]) {
          const have = (await c.execute({ sql: 'SELECT amount FROM party_openings WHERE kind = ? AND party_id = ? AND company_id = ?', args: [PARTY_TYPE[kind], m, n(o.company_id)] })).rows[0]
          if (have) await c.execute({ sql: 'UPDATE party_openings SET amount = amount + ? WHERE kind = ? AND party_id = ? AND company_id = ?', args: [n(o.amount), PARTY_TYPE[kind], m, n(o.company_id)] })
          else await c.execute({ sql: 'UPDATE party_openings SET party_id = ? WHERE kind = ? AND party_id = ? AND company_id = ?', args: [m, PARTY_TYPE[kind], b, n(o.company_id)] })
        }
        await c.execute({ sql: 'DELETE FROM party_openings WHERE kind = ? AND party_id = ?', args: [PARTY_TYPE[kind], b] }).catch(() => undefined)
        // Its GST No. becomes a row on the main party.
        let regs: Row[] = []
        try {
          regs = JSON.parse(String(main.gst_regs || '[]'))
        } catch {
          regs = []
        }
        if (branch.gstin && !regs.some((r) => up(r.gstin) === up(branch.gstin)) && up(branch.gstin) !== up(main.gstin)) {
          regs.push({
            gstin: up(branch.gstin),
            state: String(branch.state || '').trim(),
            gst_rates: String(branch.gst_rates || (n(branch.gst_pct) ? n(branch.gst_pct) : '')).trim(),
            gst_type: String(typeRow?.gst_type || 'CGST_SGST') === 'IGST' ? 'IGST' : 'CGST_SGST'
          })
          await c.execute({ sql: `UPDATE ${kind} SET gst_regs = ? WHERE id = ?`, args: [JSON.stringify(regs), m] })
        }
        await c.execute({ sql: `DELETE FROM ${kind} WHERE id = ?`, args: [b] })
      })
      folded.push(String(branch.name))
    } catch (e) {
      skipped.push({ branch: String(branch.name), reason: (e as Error).message })
    }
  }
  return { folded, skipped }
}
