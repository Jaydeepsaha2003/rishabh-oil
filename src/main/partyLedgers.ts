import { getClient } from './db'
import { resolveAccountName } from './ledgerMap'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A CUSTOMER'S SALES NEVER LAND IN A SUPPLIER'S LEDGER — AND THE OTHER WAY ROUND.
//
// Ledgers are found by name, so a customer and a supplier who share a name —
// or whose names meet through a rename redirect — post into ONE account, and
// what we are owed nets silently against what we owe. That is how 87 Bunge
// sale invoices came to sit in the supplier's ledger BUNGE INDIA PVT
// LTD(OIL PUR), reading as one net ₹9 Cr where ₹16.5 Cr was receivable and
// ₹7.5 Cr payable.
//
// So a party line asked for under Sundry Debtors that would resolve to a
// CREDITOR's ledger posts instead to "NAME (DR)" — the books' own convention
// for a party's debtor ledger (K R FOODS LIMITED (DR)) — and a Sundry
// Creditors line that would resolve to a DEBTOR's ledger to "NAME (CR)".
// Parties whose names do not collide post exactly as before.

const SIDE_ROOT: Record<string, string> = {
  'SUNDRY DEBTORS': 'SUNDRY DEBTORS',
  'SUNDRY CREDITORS': 'SUNDRY CREDITORS'
}

/** Which of Sundry Debtors / Sundry Creditors a ledger group sits under, if either. */
export async function partySideOfGroup(group: unknown): Promise<'SUNDRY DEBTORS' | 'SUNDRY CREDITORS' | null> {
  const g = String(group || '').trim().toUpperCase()
  if (!g) return null
  if (SIDE_ROOT[g]) return SIDE_ROOT[g] as 'SUNDRY DEBTORS' | 'SUNDRY CREDITORS'
  try {
    // A sub-group made under either primary — walk up the chart.
    const res = await getClient().execute({
      sql: `WITH RECURSIVE up(id, name, parent_id, d) AS (
              SELECT id, name, parent_id, 0 FROM ledger_groups WHERE TRIM(UPPER(name)) = ?
              UNION ALL
              SELECT g.id, g.name, g.parent_id, up.d + 1 FROM ledger_groups g JOIN up ON g.id = up.parent_id WHERE up.d < 12
            )
            SELECT UPPER(TRIM(name)) AS name FROM up`,
      args: [g]
    })
    for (const r of res.rows as unknown as Row[]) {
      const nm = String(r.name || '')
      if (SIDE_ROOT[nm]) return SIDE_ROOT[nm] as 'SUNDRY DEBTORS' | 'SUNDRY CREDITORS'
    }
  } catch {
    /* no groups table — only the two names above count */
  }
  return null
}

/**
 * The ledger a party line should post to. Anything that is not a party line,
 * or a party whose name does not collide with the other side's ledger, comes
 * back exactly as asked.
 */
export async function partyAccountName(name: string, group: string | undefined, companyId?: number): Promise<string> {
  const side = await partySideOfGroup(group)
  if (!side) return name
  const asked = String(name || '').trim().toUpperCase()
  if (!asked || /\s\((DR|CR)\)$/.test(asked)) return name
  const resolved = String((await resolveAccountName(asked, companyId)) || asked).trim().toUpperCase()
  const r = await getClient().execute({ sql: 'SELECT acc_group FROM ledger_accounts WHERE name = ?', args: [resolved] })
  if (!r.rows.length) return name
  const existingSide = await partySideOfGroup((r.rows[0] as unknown as Row).acc_group)
  if (!existingSide || existingSide === side) return name
  return `${asked} (${side === 'SUNDRY DEBTORS' ? 'DR' : 'CR'})`
}

/**
 * A customer and a supplier whose names would meet in one ledger — the same
 * name, or a name whose redirect lands on the other's ledger. For the warning
 * in the masters; the posting rule above already keeps their entries apart.
 */
export async function partyNameClashes(name: string, side: 'customer' | 'supplier'): Promise<Row[]> {
  const asked = String(name || '').trim().toUpperCase()
  if (!asked) return []
  const other = side === 'customer' ? 'suppliers' : 'customers'
  const res = await getClient().execute({
    sql: `SELECT id, name FROM ${other} WHERE TRIM(UPPER(name)) = ?`,
    args: [asked]
  })
  return (res.rows as unknown as Row[]).map((r) => ({ id: Number(r.id), name: String(r.name), side: side === 'customer' ? 'supplier' : 'customer' }))
}

// ---------------------------------------------------------------------------
// EVERY PARTY IS A LEDGER FROM THE DAY IT IS ADDED.
//
// A party's ledger used to come into being only when something first posted
// to it, so a transporter not yet billed, or a supplier not yet bought from,
// could not be picked anywhere a ledger is chosen — the Tally import's mapping
// was the place it showed: QUILON LOGISTICS was a master but no ledger. Now a
// customer, supplier, transporter or broker gets its ledger when it is saved
// (and the ones that already exist get theirs once, at the next start).
//
// The ledger is the one their postings would make: the master's name, under
// Sundry Debtors for a customer and Sundry Creditors for the rest, through the
// same rule postings follow — a rename redirect is followed rather than a
// second ledger opened, and a customer whose name a supplier's ledger already
// holds gets "NAME (DR)" (and the other way round "NAME (CR)"). An existing
// ledger is never touched: nothing is renamed, regrouped or posted.
// ---------------------------------------------------------------------------

export type PartyMasterTable = 'customers' | 'suppliers' | 'transporters' | 'brokers'

export async function ensurePartyMasterLedger(table: PartyMasterTable, name: unknown): Promise<boolean> {
  const nm = String(name || '').trim()
  if (!nm) return false
  const group = table === 'customers' ? 'Sundry Debtors' : 'Sundry Creditors'
  const { getOrCreateAccount } = await import('./journal')
  const asName = String(await partyAccountName(nm.toUpperCase(), group)).trim().toUpperCase()
  const before = await getClient().execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [asName] })
  const resolved = String((await resolveAccountName(asName)) || asName).trim().toUpperCase()
  const viaRedirect = resolved !== asName
    ? await getClient().execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [resolved] })
    : null
  if (before.rows.length || (viaRedirect && viaRedirect.rows.length)) return false
  await getOrCreateAccount(asName, group)
  return true
}

/** Give every party master that has none its ledger. Returns how many were made. */
export async function ensureAllPartyMasterLedgers(): Promise<number> {
  let made = 0
  for (const table of ['customers', 'suppliers', 'transporters', 'brokers'] as PartyMasterTable[]) {
    const rows = await getClient()
      .execute(`SELECT name FROM ${table}`)
      .catch(() => null)
    for (const r of (rows?.rows || []) as unknown as Row[]) {
      try {
        if (await ensurePartyMasterLedger(table, r.name)) made += 1
      } catch (e) {
        console.error(`[party ledgers] ${table} "${String(r.name)}":`, (e as Error).message)
      }
    }
  }
  return made
}
