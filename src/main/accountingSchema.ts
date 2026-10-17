import { getClient } from './db'

/** Additive only: historical cash-flow routes remain unconfirmed. */
export async function ensureBdPostingFields(): Promise<void> {
  const c = getClient()
  const cols = new Set((await c.execute('PRAGMA table_info(bill_discountings)')).rows.map((r) => String(r.name)))
  for (const [name, type] of Object.entries({
    disbursement_route: "TEXT NOT NULL DEFAULT 'unconfirmed'",
    disbursement_account: 'TEXT',
    upfront_interest_journal_entry_id: 'INTEGER',
    upfront_interest_paid_date: 'TEXT',
    upfront_interest_account: 'TEXT'
  })) {
    if (!cols.has(name)) await c.execute(`ALTER TABLE bill_discountings ADD COLUMN ${name} ${type}`)
  }
  if (!cols.has('margin_release_account')) await c.execute('ALTER TABLE bill_discountings ADD COLUMN margin_release_account TEXT')
  // WHICH BANK each repayment and interest payment went through, so a
  // re-post keeps it and the screen can show it. Additive; a missing table
  // (an older book) is simply skipped.
  for (const table of ['bd_repayments', 'bd_interest_payments']) {
    const have = new Set((await c.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)))
    if (have.size && !have.has('bank_account')) await c.execute(`ALTER TABLE ${table} ADD COLUMN bank_account TEXT`)
  }
}
