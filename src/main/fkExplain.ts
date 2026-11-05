import { getClient } from './db'

// A DELETE (or save) the database refused because other records still point at
// the row. SQLite only says "FOREIGN KEY constraint failed"; this says WHICH
// records, so the user knows what to unlink first.

/** The table each delete channel removes from (data:delete names its own). */
const DELETE_TABLE: Record<string, string> = {
  'bargains:delete': 'bargains',
  'tankers:delete': 'purchase_tankers',
  'orders:delete': 'orders',
  'vouchers:delete': 'journal_entries',
  'journal:deleteEntry': 'journal_entries',
  'ledger:deleteEntry': 'journal_entries',
  'journal:deleteLedger': 'ledger_accounts',
  'journal:deleteGroup': 'ledger_groups',
  'formulations:delete': 'formulations',
  'formulationSubcategory:delete': 'formulation_subcategories',
  'production:delete': 'production',
  'sales:delete': 'sales',
  'salesBargains:delete': 'sales_bargains',
  'gate:delete': 'gate_entries',
  'lc:delete': 'letters_of_credit',
  'bd:delete': 'bill_discountings',
  'trading:delete': 'trading_deals',
  'facility:delete': 'bank_facilities',
  'tags:delete': 'tags',
  'bankRecon:deleteImport': 'bank_statement_imports'
}

/** What a row of each table is called on screen (singular, plural). */
const NOUN: Record<string, [string, string]> = {
  orders: ['purchase', 'purchases'],
  purchase_tankers: ['tanker', 'tankers'],
  gate_entries: ['gate entry', 'gate entries'],
  bargains: ['purchase bargain', 'purchase bargains'],
  sales: ['sale', 'sales'],
  sales_bargains: ['sales bargain', 'sales bargains'],
  journal_entries: ['voucher', 'vouchers'],
  journal_lines: ['voucher line', 'voucher lines'],
  journal_bill_allocs: ['bill-wise reference', 'bill-wise references'],
  letters_of_credit: ['LC', 'LCs'],
  lc_issuances: ['LC issuance', 'LC issuances'],
  lc_linked_orders: ['LC-linked purchase', 'LC-linked purchases'],
  bill_discountings: ['bill discounting', 'bill discountings'],
  bd_linked_orders: ['BD-linked purchase', 'BD-linked purchases'],
  trading_deals: ['trading deal', 'trading deals'],
  production: ['production batch', 'production batches'],
  production_items: ['production item', 'production items'],
  formulations: ['formulation', 'formulations'],
  formulation_items: ['formulation item', 'formulation items'],
  supplier_ledger: ['supplier ledger entry', 'supplier ledger entries'],
  customer_ledger: ['customer ledger entry', 'customer ledger entries'],
  transporter_ledger: ['transporter ledger entry', 'transporter ledger entries'],
  transporter_bills: ['transporter bill', 'transporter bills'],
  payment_allocations: ['payment allocation', 'payment allocations'],
  tanker_replacements: ['tanker swap', 'tanker swaps'],
  tag_links: ['tagged record', 'tagged records'],
  stock_transfers: ['stock transfer', 'stock transfers'],
  stock_openings: ['opening stock line', 'opening stock lines'],
  order_bargain_interest: ['bargain interest line', 'bargain interest lines'],
  order_bargains: ['bargain share of a purchase', 'bargain shares of purchases'],
  suppliers: ['supplier', 'suppliers'],
  customers: ['customer', 'customers'],
  transporters: ['transporter', 'transporters'],
  products: ['product', 'products'],
  oil_types: ['oil type', 'oil types'],
  packagings: ['packaging', 'packagings'],
  sources: ['source / port', 'sources / ports'],
  banks: ['bank', 'banks'],
  nbfcs: ['NBFC', 'NBFCs'],
  ledger_accounts: ['ledger', 'ledgers'],
  ledger_groups: ['ledger group', 'ledger groups'],
  companies: ['company', 'companies'],
  factories: ['factory', 'factories'],
  tags: ['tag', 'tags'],
  bank_facilities: ['bank facility', 'bank facilities'],
  bank_statement_imports: ['bank statement import', 'bank statement imports'],
  formulation_subcategories: ['formulation sub-category', 'formulation sub-categories'],
  stock_pp_stages: ['PP stage', 'PP stages']
}
const noun = (t: string, k: number): string => {
  const x = NOUN[t] || [t.replace(/_/g, ' '), `${t.replace(/_/g, ' ')} rows`]
  return k === 1 ? x[0] : x[1]
}

// The column that reads as the record's number on screen, first found wins.
const LABEL_COLS = ['gate_entry_no', 'entry_no', 'invoice_no', 'vch_no', 'code', 'bargain_no', 'tanker_no', 'lc_no', 'bd_no', 'name']

export const isForeignKeyError = (e: unknown): boolean => /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(String((e as Error)?.message || e))

export async function explainForeignKey(channel: string, args: unknown): Promise<string> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const isDelete = /:(delete|remove)/i.test(channel)
  if (!isDelete) {
    return 'This could not be saved: something it refers to (a party, product, bargain or voucher) no longer exists. Refresh the page and pick it again.'
  }
  const generic = "This can't be deleted: other records still refer to it. Remove or change those first."
  const table = channel === 'data:delete' ? String(a.table || '') : DELETE_TABLE[channel]
  const id = Number(a.id ?? a.entryId ?? (typeof args === 'number' ? args : NaN))
  if (!table || !/^[a-z_]+$/.test(table) || !Number.isFinite(id)) return generic
  try {
    const c = getClient()
    const refs = (
      await c.execute({
        sql: `SELECT m.name AS child, p."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) p
               WHERE m.type = 'table' AND p."table" = ?`,
        args: [table]
      })
    ).rows.map((r) => ({ child: String(r.child), col: String(r.col) }))
    const parts: string[] = []
    for (const { child, col } of refs) {
      if (child === table) continue
      const k = Number((await c.execute({ sql: `SELECT COUNT(*) AS k FROM "${child}" WHERE "${col}" = ?`, args: [id] })).rows[0]?.k) || 0
      if (!k) continue
      const cols = new Set((await c.execute(`PRAGMA table_info("${child}")`)).rows.map((r) => String(r.name)))
      const lc = LABEL_COLS.find((x) => cols.has(x))
      let names = ''
      if (lc) {
        const vals = (await c.execute({ sql: `SELECT DISTINCT "${lc}" AS v FROM "${child}" WHERE "${col}" = ? AND "${lc}" IS NOT NULL LIMIT 3`, args: [id] })).rows
          .map((r) => String(r.v).trim())
          .filter(Boolean)
        if (vals.length) names = ` (${vals.join(', ')}${k > vals.length ? ', …' : ''})`
      }
      parts.push(`${k} ${noun(child, k)}${names}`)
    }
    if (!parts.length) return generic
    return `This ${noun(table, 1)} can't be deleted: it is still used by ${parts.join(', ')}. Remove or change those first.`
  } catch {
    return generic
  }
}
