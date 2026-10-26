import type { InValue } from '@libsql/client'
import { getClient, onDataChanged } from './db'
import { ensureCompanyParties } from './intercompany'
import { getActiveCompanyId } from './company'
import { bankLedgerName } from './treasury'
import { renameLedger, ensureLedgerMap, resolveAccountName } from './ledgerMap'
import { logLimitChange } from './facilityLimits'
import { OPENING_FIELDS, overlayOpenings, setPartyOpening } from './partyOpenings'

// Whitelist of writable columns per table. Table names and column names only
// ever come from this map (never from the renderer), so the dynamic SQL below
// is safe — all *values* are passed as bound parameters.
const TABLES: Record<string, string[]> = {
  banks: ['name', 'branch', 'account_no', 'ifsc', 'note', 'active', 'company_id'],
  // days_year belongs here: the Manage NBFCs form offers it, but a column
  // missing from this list is silently DROPPED by pickKeys — so changing the
  // year basis from 360 to 365 saved without complaint and changed nothing.
  nbfcs: ['name', 'finance_type', 'tds_pct', 'interest_pct', 'interest_days', 'days_year', 'days_incl_start', 'sanctioned_limit', 'note', 'active', 'company_id'],
  categories: ['name', 'applies_to', 'note', 'active'],
  oil_types: ['code', 'name', 'active'],
  products: ['code', 'name', 'category', 'material_type', 'uom', 'active', 'show_in_stock', 'use_both'],
  suppliers: [
    'name',
    'supplier_type',
    'company_type',
    'business_type',
    'linked_party_id',
    'gstin',
    'state',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_pct_above',
    'tds_above_only',
    'gst_rates',
    // Its other GST Nos. — [{gstin, state, gst_rates, gst_type}] (GstRegsPanel).
    'gst_regs',
    'credit_period_days',
    'adds_interest',
    'interest_pct',
    'interest_days',
    // opening_purchase_amount / _date are the open company's own now — see
    // partyOpenings.ts; the shared column is no longer written.
    'skip_tanker_stages',
    'active'
  ],
  transporters: [
    'name',
    'company_type',
    'contact',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_pct_above',
    'default_rate_per_ton',
    'reverse_charge',
    'gst_registration',
    'active'
  ],
  customers: [
    'name',
    'category',
    'company_type',
    'business_type',
    'linked_party_id',
    'gstin',
    'state',
    'gst_pct',
    'tds_pct',
    'tds_threshold',
    'tds_above_only',
    'gst_rates',
    // Its other GST Nos. — [{gstin, state, gst_rates, gst_type}] (GstRegsPanel).
    'gst_regs',
    'adds_interest',
    'interest_pct',
    'interest_days',
    'credit_period_days',
    'active'
  ],
  sources: ['name', 'transit_days', 'active'],
  uoms: ['name', 'active'],
  brokers: ['name', 'contact_person', 'phone', 'brokerage_pct', 'brokerage_rate', 'address', 'note', 'active'],
  companies: [
    'name', 'company_type', 'colour', 'active', 'factory_id', 'priority',
    'gstin', 'state', 'gst_pct', 'tds_pct', 'tds_threshold', 'tds_above_only', 'credit_period_days',
    'opening_purchase_amount', 'opening_purchase_date', 'onward_sale_at_empty'
  ],
  factories: ['name', 'location', 'active'],
  packagings: ['name', 'box_label', 'pouch_label', 'pouches_per_box', 'unit_size', 'unit_uom', 'base_per_pouch', 'base_uom', 'product_id', 'product_label', 'active']
}

type Row = Record<string, unknown>

// Most masters (suppliers, products, categories...) are shared across every
// company's books. Banks and NBFCs are the odd ones out — a bank ACCOUNT or a
// discounting line belongs to one company, not to the business in general —
// so these get scoped like the transactional tables (orders, bargains) do,
// instead of sitting in the generic shared-master pool with everything else.
const COMPANY_SCOPED_TABLES = new Set(['banks', 'nbfcs'])

function assertTable(table: string): string[] {
  const cols = TABLES[table]
  if (!cols) throw new Error(`Unknown table: ${table}`)
  return cols
}

// Coerce JS values into something libsql accepts as a bound parameter.
// An id column left blank in a form arrives as '' — store it as NULL, since
// "no link" is checked with IS NULL everywhere and '' would match neither
// that nor a real id.
function toArg(v: unknown, key?: string): InValue {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === undefined) return null
  if (v === '' && key?.endsWith('_id')) return null
  return v as InValue
}

function pickKeys(values: Row, allowed: string[]): string[] {
  return Object.keys(values).filter((k) => allowed.includes(k))
}

// Two masters with the same name are indistinguishable in every dropdown and
// split a party's history in two, so a duplicate is refused at the write path
// — the UI warns, this makes it impossible.
//
// A row that is ALREADY a duplicate can still be edited (that is how it gets
// fixed); only creating a clash, or renaming into one, is blocked.
async function assertUniqueName(table: string, values: Row, excludeId?: number): Promise<void> {
  if (!('name' in values)) return
  const name = String(values.name ?? '').trim()
  if (!name) return
  const c = getClient()
  const scoped = COMPANY_SCOPED_TABLES.has(table)
  // Whichever company the row is actually going into — the form's own
  // picker, not necessarily the one currently active in the sidebar.
  const targetCompany = Number(values.company_id) || getActiveCompanyId()
  const scopeSql = scoped ? ' AND company_id = ?' : ''
  const scopeArg = scoped ? [targetCompany] : []
  if (excludeId) {
    const cur = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [excludeId] })
    const before = String(cur.rows[0]?.name ?? '').trim().toLowerCase()
    if (before === name.toLowerCase()) return // not a rename — leave it alone
  }
  const hit = await c.execute({
    sql: `SELECT id, name FROM ${table} WHERE TRIM(LOWER(name)) = ?${scopeSql}${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
    args: [name.toLowerCase(), ...scopeArg, ...(excludeId ? [excludeId] : [])]
  })
  if (hit.rows.length) {
    throw new Error(`"${String(hit.rows[0].name)}" already exists — give this one a different name`)
  }
}

// ---------------------------------------------------------------------------
// Master lists in memory.
//
// These tables are the dropdowns -- products, customers, suppliers, tankers,
// packagings, oil types. Every page reloads its whole dataset whenever the DB
// revision changes, which is after EVERY write anywhere in the app, and most of
// those reloads asked for the same master lists again: the Sales page alone
// fetched seven of them per refresh, and a master cannot have changed because
// an invoice was raised. On a database this small the hosting bill is made of
// how often a query runs, not how big the table is, so these were a large share
// of it for no new information.
//
// Held per table per company, thrown away wholesale by notifyDataChanged --
// which fires on our own writes immediately and within 15s of another machine's
// -- so a cached list is never staler than anything else on screen. Deliberately
// coarse: correctness first, and a master edit is rare enough that re-reading
// every list after one costs nothing.
const masterCache = new Map<string, Row[]>()

onDataChanged(() => masterCache.clear())

export function clearMasterCache(): void {
  masterCache.clear()
}

export async function list(table: string): Promise<Row[]> {
  assertTable(table)
  const scoped = COMPANY_SCOPED_TABLES.has(table)
  const key = `${table}|${scoped ? getActiveCompanyId() : 0}`
  const hit = masterCache.get(key)
  // Copied out, so a caller mutating what it got cannot corrupt the cache.
  if (hit) return overlayOpenings(table, hit.map((r) => ({ ...r })))
  // Every master table has a `name` and feeds dropdowns across the app —
  // always list A→Z. Company-scoped tables only ever show the active
  // company's own rows (a bank with no company set yet — there isn't a way
  // to create one, but one could exist from before this was added — simply
  // won't appear until it's given one).
  const res = await getClient().execute(
    scoped
      ? { sql: `SELECT * FROM ${table} WHERE company_id = ? ORDER BY name COLLATE NOCASE ASC`, args: [getActiveCompanyId()] }
      : `SELECT * FROM ${table} ORDER BY name COLLATE NOCASE ASC`
  )
  const rows = res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
  masterCache.set(key, rows)
  return overlayOpenings(table, rows.map((r) => ({ ...r })))
}

/** A supplier's / customer's opening billing, written for the company open. */
async function saveOpening(table: string, id: number, values: Row): Promise<void> {
  const f = OPENING_FIELDS[table as 'suppliers' | 'customers']
  if (!f || !id || !(f.amount in values || f.date in values)) return
  await setPartyOpening(f.kind, id, Number(values.opening_company_id) || getActiveCompanyId(), values[f.amount], values[f.date])
}

export async function get(table: string, id: number): Promise<Row | null> {
  assertTable(table)
  const res = await getClient().execute({
    sql: `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
    args: [id]
  })
  if (res.rows.length === 0) return null
  const r = res.rows[0] as unknown as Row
  const o: Row = {}
  for (const col of res.columns) o[col] = r[col]
  return (await overlayOpenings(table, [o]))[0]
}

// A MAIN PARTY AND ITS SUB-LEDGERS (DIL EXIM → DIL EXIM – UP, – RAJKOT).
//
// A sub-ledger is a party of its own — its own name, ledger, GSTIN, state and
// GST rates — that names its main party in linked_party_id. One level only: a
// sub-ledger cannot have sub-ledgers, and a party with sub-ledgers cannot itself
// become one. TDS belongs to the main party: a sub-ledger takes the main's TDS
// settings whenever it is saved, and a change to the main's flows down to every
// sub-ledger (the TDS slab is already pooled across them by linked_party_id).
const TDS_COLS: Record<string, string[]> = {
  suppliers: ['tds_pct', 'tds_threshold', 'tds_pct_above', 'tds_above_only'],
  customers: ['tds_pct', 'tds_threshold', 'tds_above_only']
}
async function applyMainParty(table: string, values: Row, id?: number): Promise<Row> {
  if (!TDS_COLS[table] || !('linked_party_id' in values)) return values
  const main = Number(values.linked_party_id) || 0
  if (!main) return { ...values, linked_party_id: null }
  if (id && main === Number(id)) throw new Error('A party cannot be its own main party')
  const c = getClient()
  const m = (await c.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [main] })).rows[0] as unknown as Row | undefined
  if (!m) throw new Error('That main party no longer exists')
  if (m.linked_party_id) throw new Error(`${String(m.name)} is itself a sub-ledger of another party — pick the main party`)
  if (id) {
    const subs = await c.execute({ sql: `SELECT COUNT(*) AS k FROM ${table} WHERE linked_party_id = ?`, args: [Number(id)] })
    if (Number(subs.rows[0]?.k) > 0) throw new Error('This party has sub-ledgers of its own, so it cannot be made a sub-ledger')
  }
  const out = { ...values }
  for (const k of TDS_COLS[table]) out[k] = m[k]
  return out
}
async function pushTdsToSubLedgers(table: string, id: number): Promise<void> {
  const cols = TDS_COLS[table]
  if (!cols) return
  await getClient().execute({
    sql: `UPDATE ${table} SET ${cols.map((k) => `${k} = (SELECT m.${k} FROM ${table} m WHERE m.id = ?)`).join(', ')} WHERE linked_party_id = ?`,
    args: [...cols.map(() => id), id]
  })
}

export async function create(table: string, values: Row): Promise<{ id: number }> {
  const allowed = assertTable(table)
  values = await applyMainParty(table, values)
  // The form carries its own company picker — respect whichever company was
  // actually chosen there, only falling back to the active one if somehow
  // nothing was picked at all.
  if (COMPANY_SCOPED_TABLES.has(table) && !values.company_id) {
    values = { ...values, company_id: getActiveCompanyId() }
  }
  await assertUniqueName(table, values)
  const keys = pickKeys(values, allowed)
  if (keys.length === 0) throw new Error('No valid columns to insert')
  const placeholders = keys.map(() => '?').join(', ')
  const res = await getClient().execute({
    sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
    args: keys.map((k) => toArg(values[k], k))
  })
  await saveOpening(table, Number(res.lastInsertRowid), values)
  // A new company needs the customer and supplier rows that stand for it, or
  // it cannot be picked as the other side of an inter-company sale.
  if (table === 'companies') await ensureCompanyParties().catch(() => undefined)
  if (table === 'banks') await ensureBankLedger(values).catch((e) => console.error('[banks] ledger not created:', e))
  // A new party is a ledger at once — see ensurePartyMasterLedger.
  if (table === 'customers' || table === 'suppliers' || table === 'transporters' || table === 'brokers') {
    const { ensurePartyMasterLedger } = await import('./partyLedgers')
    await ensurePartyMasterLedger(table, values.name).catch((e) => console.error(`[${table}] ledger not created:`, e))
  }
  return { id: Number(res.lastInsertRowid) }
}

/**
 * A NEW BANK IS A LEDGER AT ONCE.
 *
 * The bank pickers — where a disbursement landed, which bank a repayment or an
 * interest payment left from, moving a voucher to another bank — list the bank
 * LEDGERS, and a bank's ledger used to come into being only when something
 * first posted to it. So a bank added here could not be picked anywhere until
 * an LC happened to use it. It is created with the bank now, under the name
 * the bank posts as (with the last four of its account number).
 */
async function ensureBankLedger(v: Row): Promise<void> {
  const want = bankLedgerName(v.name, v.account_no)
  if (!want) return
  const name = String(await resolveAccountName(want, n(v.company_id) || undefined)).trim().toUpperCase()
  if (!name) return
  await getClient().execute({
    sql: "INSERT OR IGNORE INTO ledger_accounts (name, acc_group) VALUES (?, 'Bank Accounts')",
    args: [name]
  })
}

// A party's ledger account is keyed by NAME (getOrCreateAccount), so renaming
// the master used to strand the old account and start a fresh one on the next
// voucher — the same party showing twice in Ledgers, its history on one line and
// its new postings on the other. The rename now follows through:
//   * no account under the old name  -> nothing to do
//   * no account under the new name  -> rename it, history intact
//   * both exist                     -> the old one's lines and allocations are
//                                       repointed at the new one and the empty
//                                       shell is dropped
const LEDGER_MASTERS = new Set(['customers', 'suppliers', 'transporters', 'brokers'])

const n = (v: unknown): number => Number(v) || 0

/**
 * A REDIRECT THAT POINTED AT THIS LEDGER HAS TO FOLLOW IT.
 *
 * ledger_map says "postings addressed to X go to Y", and Y is a NAME. Rename
 * the ledger Y without touching the map and the redirect points at a name
 * that no longer exists — so the next posting addressed to X resolves to a
 * dead name and getOrCreateAccount opens a fresh ledger under it. That is the
 * exact duplicate the map exists to prevent, arrived at from the other side.
 *
 * renameLedger already does this for a rename made in Masters; a party rename
 * comes through here instead, so it has to do it too.
 *
 * What this deliberately does NOT do is write a redirect from the party's old
 * name to its new one. A party's postings are addressed by reading its name
 * off the master at the time, so they follow a rename on their own — and a
 * standing redirect would be a trap: create a NEW party later under the old
 * name and its postings would be silently swept into the renamed party's
 * ledger.
 */
async function followLedgerMap(from: string, to: string): Promise<void> {
  await ensureLedgerMap().catch(() => undefined)
  await getClient()
    .execute({
      sql: 'UPDATE ledger_map SET use_name = ? WHERE TRIM(UPPER(use_name)) = ?',
      args: [to, from]
    })
    .catch(() => undefined)
}

/**
 * THE PARTY'S LEDGER MAY NOT BE CALLED WHAT THE PARTY IS CALLED.
 *
 * This is handed the party's OLD name and looks for a ledger under it. That
 * holds right up until somebody renames the ledger itself in Masters: the
 * ledger is then ASHOK SHOP LTD while the party is still ASHOK SHOP, so the
 * lookup finds nothing, this function quietly does nothing, and the party's
 * ledger is left behind under a name nothing addresses any more. The next
 * posting asks for the party's NEW name, finds no ledger, and opens an empty
 * one — the history stranded in the old row.
 *
 * The map is what knows where the old name actually points, so it is asked
 * before giving up.
 */
async function ledgerIdFor(name: string): Promise<{ id: number; name: string } | null> {
  const c = getClient()
  const want = String(name || '').trim().toUpperCase()
  if (!want) return null
  const hit = await c.execute({
    sql: 'SELECT id, name FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?',
    args: [want]
  })
  if (hit.rows.length) return { id: Number(hit.rows[0].id), name: want }
  const via = String(await resolveAccountName(want).catch(() => '') || '').trim().toUpperCase()
  if (!via || via === want) return null
  const second = await c.execute({
    sql: 'SELECT id, name FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?',
    args: [via]
  })
  return second.rows.length ? { id: Number(second.rows[0].id), name: via } : null
}

async function renameLedgerAccount(oldName: string, newName: string): Promise<void> {
  const c = getClient()
  const asked = String(oldName || '').trim().toUpperCase()
  const to = String(newName || '').trim().toUpperCase()
  if (!asked || !to || asked === to) return
  const found = await ledgerIdFor(asked)
  if (!found) return
  // The name the ledger is ACTUALLY under, which is what the map rows and the
  // merge check below have to be matched against.
  const from = found.name
  if (from === to) return
  const srcId = found.id
  const dst = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?', args: [to] })
  if (!dst.rows.length) {
    await c.execute({ sql: 'UPDATE ledger_accounts SET name = ? WHERE id = ?', args: [to, srcId] })
    await followLedgerMap(from, to)
    return
  }
  const dstId = Number(dst.rows[0].id)
  if (dstId === srcId) return
  await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE account_id = ?', args: [dstId, srcId] })
  await c.execute({ sql: 'UPDATE journal_bill_allocs SET account_id = ? WHERE account_id = ?', args: [dstId, srcId] })
  await c.execute({ sql: 'DELETE FROM ledger_accounts WHERE id = ?', args: [srcId] })
  // The source ledger is gone; anything aimed at its name now aims at the one
  // its history was merged into.
  await followLedgerMap(from, to)
}

/**
 * A BANK'S LEDGER CARRIES THE LAST FOUR OF ITS ACCOUNT NUMBER.
 *
 * Two accounts at the same bank are two ledgers, and a name stopping at the
 * bank lumps them into one figure nobody can match against a statement. So the
 * ledger reads HDFCBANK A/C · 4521, and the moment a bank's number is filled
 * in — or changed — its ledger follows.
 *
 * Which is only safe because of ledger_map: the app posts by asking for
 * `HDFCBANK A/C`, and renaming the account would otherwise have the next LC
 * open a SECOND one under the old name. renameLedger writes the redirect at
 * the same time, so the ask keeps landing on the same row.
 */
async function syncBankLedgerName(bankId: number, before: Row | null, after: Row): Promise<void> {
  const was = bankLedgerName(before?.name, before?.account_no)
  const now = bankLedgerName(after?.name, after?.account_no)
  if (!was || !now || was === now) return
  const c = getClient()
  const src = await c.execute({
    sql: 'SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ?',
    args: [was.toUpperCase()]
  })
  if (!src.rows.length) return
  await renameLedger(Number(src.rows[0].id), now, n(after?.company_id) || undefined).catch((e) =>
    console.error('[banks] could not carry the ledger name across:', e)
  )
}

export async function update(table: string, id: number, values: Row): Promise<{ id: number }> {
  const allowed = assertTable(table)
  values = await applyMainParty(table, values, id)
  await assertUniqueName(table, values, id)
  const keys = pickKeys(values, allowed)
  // A renamed company renames the parties that stand for it.
  if (table === 'companies') await ensureCompanyParties().catch(() => undefined)
  await saveOpening(table, id, values)
  if (keys.length === 0) return { id }
  // Read the old name BEFORE the update, so a rename can be detected.
  let priorName = ''
  if (LEDGER_MASTERS.has(table) && keys.includes('name')) {
    const prev = await getClient().execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [id] })
    priorName = prev.rows.length ? String(prev.rows[0].name || '') : ''
  }
  /**
   * A SANCTIONED LIMIT CHANGING IS NOT THE SAME AS A FIELD CHANGING.
   *
   * Every other column on an NBFC is a property of the party — its name, its
   * rate, its TDS. The limit is an event: somebody negotiated it, on a date,
   * and next year the question will be when. Read before the write so the move
   * can be recorded from what to what, and only for this one column, so the
   * log stays a record of sanctions rather than of edits.
   */
  let priorLimit: number | null = null
  if (table === 'nbfcs' && keys.includes('sanctioned_limit')) {
    const prev = await getClient().execute({
      sql: 'SELECT COALESCE(sanctioned_limit, 0) AS v FROM nbfcs WHERE id = ?',
      args: [id]
    })
    priorLimit = prev.rows.length ? Number(prev.rows[0].v) || 0 : 0
  }
  // Same idea for a bank, but its ledger name is built from two fields.
  let priorBank: Row | null = null
  if (table === 'banks') {
    const prev = await getClient().execute({
      sql: 'SELECT name, account_no, company_id FROM banks WHERE id = ?',
      args: [id]
    })
    priorBank = prev.rows.length ? (prev.rows[0] as unknown as Row) : null
  }
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  await getClient().execute({
    sql: `UPDATE ${table} SET ${setClause} WHERE id = ?`,
    args: [...keys.map((k) => toArg(values[k], k)), id]
  })
  // A main party's TDS is its sub-ledgers' TDS.
  if (TDS_COLS[table]) await pushTdsToSubLedgers(table, id)
  if (priorLimit != null) {
    await logLimitChange({
      kind: 'nbfc',
      refId: id,
      oldAmount: priorLimit,
      newAmount: Number(values.sanctioned_limit) || 0,
      note: 'edited on the NBFC master'
    })
  }
  if (priorName) await renameLedgerAccount(priorName, String(values.name || ''))
  if (table === 'banks') {
    const now = await getClient().execute({
      sql: 'SELECT name, account_no, company_id FROM banks WHERE id = ?',
      args: [id]
    })
    if (now.rows.length) {
      await syncBankLedgerName(id, priorBank, now.rows[0] as unknown as Row)
      // A bank that never had a ledger gets one now, rather than on first use.
      await ensureBankLedger(now.rows[0] as unknown as Row).catch(() => undefined)
    }
  }
  return { id }
}

// What points at each master. Deleting a row the books still reference throws
// a bare "FOREIGN KEY constraint failed" from SQLite, which tells the person at
// the screen nothing — so the references are counted first and named.
const DEPENDENTS: Record<string, { table: string; column: string; label: string }[]> = {
  banks: [
    { table: 'letters_of_credit', column: 'our_bank_id', label: 'LC' },
    { table: 'bank_lc_limits', column: 'bank_id', label: 'sanctioned limit' }
  ],
  nbfcs: [{ table: 'bill_discountings', column: 'nbfc_id', label: 'discounted bill' }],
  suppliers: [
    { table: 'bargains', column: 'supplier_id', label: 'purchase bargain' },
    { table: 'orders', column: 'supplier_id', label: 'purchase' },
    { table: 'purchase_tankers', column: 'supplier_id', label: 'tanker' },
    { table: 'consignment_stock', column: 'supplier_id', label: 'consignment lot' },
    { table: 'supplier_ledger', column: 'supplier_id', label: 'ledger entry' },
    { table: 'gate_entries', column: 'supplier_id', label: 'gate entry' }
  ],
  customers: [
    { table: 'sales', column: 'customer_id', label: 'sale' },
    { table: 'sales_bargains', column: 'customer_id', label: 'sales bargain' },
    { table: 'customer_ledger', column: 'customer_id', label: 'ledger entry' },
    { table: 'gate_entries', column: 'customer_id', label: 'gate entry' },
    { table: 'packaging_parties', column: 'customer_id', label: 'packed-SKU link' }
  ],
  products: [
    { table: 'sales', column: 'product_id', label: 'sale' },
    { table: 'sales_bargains', column: 'product_id', label: 'sales bargain' },
    { table: 'orders', column: 'oil_type_id', label: 'purchase' },
    { table: 'production', column: 'product_id', label: 'production run' },
    { table: 'production_items', column: 'product_id', label: 'production input' },
    { table: 'formulation_items', column: 'product_id', label: 'formulation line' },
    { table: 'consignment_stock', column: 'product_id', label: 'consignment lot' },
    { table: 'stock_counts', column: 'product_id', label: 'day-close count' },
    { table: 'stock_transfers', column: 'product_id', label: 'stock transfer' },
    { table: 'packagings', column: 'product_id', label: 'packed SKU' }
  ],
  transporters: [
    { table: 'purchase_tankers', column: 'transporter_id', label: 'tanker' },
    { table: 'orders', column: 'transporter_id', label: 'purchase' },
    { table: 'sales', column: 'transporter_id', label: 'sale' },
    { table: 'transporter_ledger', column: 'transporter_id', label: 'ledger entry' }
  ],
  sources: [{ table: 'bargains', column: 'source_id', label: 'purchase bargain' }],
  brokers: [{ table: 'bargains', column: 'broker_id', label: 'purchase bargain' }],
  packagings: [
    { table: 'sales', column: 'packaging_id', label: 'sale' },
    { table: 'sales_bargains', column: 'packaging_id', label: 'sales bargain' },
    { table: 'sales_bargain_sku_rates', column: 'packaging_id', label: 'rate-card line' },
    { table: 'packaging_parties', column: 'packaging_id', label: 'party link' }
  ],
  oil_types: [
    { table: 'bargains', column: 'oil_type_id', label: 'purchase bargain' },
    { table: 'purchase_tankers', column: 'oil_type_id', label: 'tanker' }
  ]
}

async function assertNotInUse(table: string, id: number): Promise<void> {
  const deps = DEPENDENTS[table]
  if (!deps) return
  const c = getClient()
  const held: string[] = []
  for (const d of deps) {
    const r = await c
      .execute({ sql: `SELECT COUNT(*) AS n FROM ${d.table} WHERE ${d.column} = ?`, args: [id] })
      .catch(() => null) // a table this build does not have is simply skipped
    const n = r ? Number(r.rows[0].n) : 0
    if (n > 0) held.push(`${n} ${d.label}${n === 1 ? '' : 's'}`)
  }
  if (!held.length) return
  const who = await c.execute({ sql: `SELECT name FROM ${table} WHERE id = ?`, args: [id] })
  const name = String(who.rows[0]?.name ?? 'This record')
  throw new Error(
    `"${name}" is still used by ${held.join(', ')} — deleting it would orphan them. ` +
      'Switch it off with the Active toggle instead, so it stops being offered but its history stays.'
  )
}

export async function remove(table: string, id: number): Promise<{ id: number }> {
  assertTable(table)
  await assertNotInUse(table, id)
  await getClient().execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] })
  return { id }
}

// --- app_settings (simple key/value) ---

export async function getSetting(key: string): Promise<string | null> {
  const res = await getClient().execute({
    sql: 'SELECT value FROM app_settings WHERE key = ? LIMIT 1',
    args: [key]
  })
  return res.rows.length ? (res.rows[0].value as string) : null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getClient().execute({
    sql: 'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value]
  })
}

export async function allSettings(): Promise<Record<string, string>> {
  const res = await getClient().execute('SELECT key, value FROM app_settings')
  const out: Record<string, string> = {}
  for (const r of res.rows) out[r.key as string] = r.value as string
  return out
}
