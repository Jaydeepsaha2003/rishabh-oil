import { getClient } from './db'
import { resolveAccountName } from './ledgerMap'

export interface VoucherLine { account: string; group?: string; dr?: number; cr?: number }
const amount = (v: unknown): number => v == null ? 0 : Number(v)
const round = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

export function normalizedJournalLines(input: VoucherLine[]): VoucherLine[] {
  for (const l of input) {
    const dr = amount(l.dr), cr = amount(l.cr)
    if (!Number.isFinite(dr) || !Number.isFinite(cr) || dr < 0 || cr < 0) throw new Error('Voucher amounts must be finite and non-negative')
    if (dr > 0 && cr > 0) throw new Error('A line is either Dr or Cr, not both')
    if ((dr || cr) && !String(l.account || '').trim()) throw new Error('Choose an account for every amount')
  }
  const rawDifference = input.reduce((sum, l) => sum + amount(l.dr) - amount(l.cr), 0)
  if (Math.abs(rawDifference) > 0.0100001) throw new Error('Journal not balanced')
  const lines = input.map((l) => ({ ...l, dr: round(amount(l.dr)), cr: round(amount(l.cr)) })).filter((l) => l.dr || l.cr)
  if (lines.length < 2) throw new Error('A voucher needs at least one Dr and one Cr line')
  const difference = round(lines.reduce((sum, l) => sum + l.dr - l.cr, 0))
  // Retain sub-paisa legacy calculations, but record their rounding explicitly.
  if (difference) lines.push({ account: 'ROUND OFF A/C', group: 'Indirect Expenses', dr: difference < 0 ? -difference : 0, cr: difference > 0 ? difference : 0 })
  return lines
}

export async function validateCashFlow(type: string, lines: VoucherLine[], companyId?: number): Promise<void> {
  if (!['PAYMENT', 'RECEIPT', 'CONTRA'].includes(type)) return
  const accounts = await getClient().execute('SELECT name, acc_group FROM ledger_accounts')
  const groups = new Map(accounts.rows.map((r) => [String(r.name).trim().toUpperCase(), String(r.acc_group)]))
  const kinds = await Promise.all(lines.map(async (l) => {
    const name = await resolveAccountName(l.account, companyId)
    return groups.get(name.trim().toUpperCase()) || l.group || ''
  }))
  const cash = (i: number): boolean => ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c'].includes(kinds[i])
  if (type === 'CONTRA') {
    if (lines.some((_, i) => !cash(i))) throw new Error('Contra moves money between cash and bank only')
    return
  }
  const side = type === 'PAYMENT' ? 'cr' : 'dr'
  if (!lines.some((l, i) => amount(l[side]) > 0 && cash(i))) throw new Error(`${type === 'PAYMENT' ? 'Payment needs a paying' : 'Receipt needs a receiving'} cash or bank account; use Journal for a noncash adjustment`)
  for (let i = 0; i < lines.length; i++) {
    if (!(amount(lines[i][side]) > 0) || cash(i)) continue
    const allowed = type === 'PAYMENT'
      ? ['Duties & Taxes', 'Direct Incomes', 'Indirect Incomes', 'Indirect Expenses']
      : ['Direct Expenses', 'Indirect Expenses', 'Deposits (Asset)', 'Duties & Taxes']
    if (!allowed.includes(kinds[i])) throw new Error(`"${lines[i].account}" is not a ${type === 'PAYMENT' ? 'payment withholding' : 'receipt deduction'} account; use Journal for a noncash settlement`)
  }
}
