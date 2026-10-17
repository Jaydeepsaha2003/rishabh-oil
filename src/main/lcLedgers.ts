// THE LEDGERS AN LC POSTS TO — the books' own choice, not the code's.
//
// The LC code addressed fixed names: INTEREST A/C, BANK CHARGES A/C and
// LC PAYABLE - <bank>. The accountants keep LCs in Tally under ledgers of their
// own — INTEREST (LC), LC CHARGES, LC WITH HDFC BANK LTD — so every LC voucher
// here sat on different ledgers from Tally's for the same money (JV/15 against
// Tally's No. 637). This is where the choice is made (Settings → Accounting
// checks → "LC vouchers on Tally's ledgers"), every LC posting reads it, and
// the same screen moves the LC vouchers already posted onto it.
//
// Nothing is set until somebody saves it, so until then every LC posts exactly
// as it always did.
import { getClient } from './db'
import { getSetting, setSetting } from './repos'
import { withDbTransaction } from './dbTransaction'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => Number(v) || 0
const up = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
const KEY = 'lc_ledgers'

export interface LcLedgerSettings {
  interest: string
  charges: string
  // The app's own LC liability name ("LC PAYABLE - HDFCBANK") → the ledger to use.
  payables: Record<string, string>
}

export async function getLcLedgerSettings(): Promise<LcLedgerSettings> {
  try {
    const v = JSON.parse(String((await getSetting(KEY)) || '{}'))
    return {
      interest: up(v.interest),
      charges: up(v.charges),
      payables: Object.fromEntries(Object.entries((v.payables as Record<string, string>) || {}).map(([k, x]) => [up(k), up(x)]).filter(([k, x]) => k && x))
    }
  } catch {
    return { interest: '', charges: '', payables: {} }
  }
}

/** The names an LC posting uses — the saved choice, or what it always used. */
export async function lcLedgerNames(): Promise<{ interest: string; charges: string; comm: string; payable: (asked: string) => string }> {
  const s = await getLcLedgerSettings()
  return {
    interest: s.interest || 'INTEREST A/C',
    charges: s.charges || 'BANK CHARGES A/C',
    comm: s.charges || 'COMM. CHARGES A/C',
    payable: (asked: string) => s.payables[up(asked)] || asked
  }
}

async function ledgerExists(name: string): Promise<boolean> {
  const r = await getClient().execute({ sql: 'SELECT 1 FROM ledger_accounts WHERE TRIM(UPPER(name)) = ? LIMIT 1', args: [up(name)] })
  return r.rows.length > 0
}

export async function saveLcLedgerSettings(v: Partial<LcLedgerSettings>): Promise<LcLedgerSettings> {
  const next: LcLedgerSettings = {
    interest: up(v.interest),
    charges: up(v.charges),
    payables: Object.fromEntries(Object.entries(v.payables || {}).map(([k, x]) => [up(k), up(x)]).filter(([k, x]) => k && x && k !== x))
  }
  for (const nm of [next.interest, next.charges, ...Object.values(next.payables)]) {
    if (nm && !(await ledgerExists(nm))) throw new Error(`There is no ledger called ${nm} — create it in Accounting → Masters first`)
  }
  await setSetting(KEY, JSON.stringify(next))
  return next
}

/** Every voucher an LC wrote, with the LC that wrote it. */
async function lcVouchers(): Promise<Map<number, Row>> {
  const c = getClient()
  const out = new Map<number, Row>()
  const safe = async (sql: string): Promise<Row[]> => {
    try {
      const r = await c.execute(sql)
      return r.rows.map((x) => ({ ...(x as unknown as Row) }))
    } catch {
      return []
    }
  }
  const lcs = await safe(`SELECT l.id, l.lc_no, l.bank, l.our_bank_id, l.company_id, l.party_type, s.name AS supplier_name,
                                 l.journal_entry_id, l.interest_journal_entry_id, l.preclose_journal_entry_id, l.preclose_interest_journal_entry_id,
                                 l.preclose_payout_journal_entry_id, l.charges_journal_entry_id, l.fee_adjust_journal_entry_id, l.payment_in_journal_entry_id
                            FROM letters_of_credit l LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id`)
  const byId = new Map(lcs.map((l) => [n(l.id), l]))
  const put = (je: unknown, lcId: number): void => {
    const k = n(je)
    const lc = byId.get(lcId)
    if (k && lc && !out.has(k)) out.set(k, lc)
  }
  for (const l of lcs)
    for (const col of ['journal_entry_id', 'interest_journal_entry_id', 'preclose_journal_entry_id', 'preclose_interest_journal_entry_id', 'preclose_payout_journal_entry_id', 'charges_journal_entry_id', 'fee_adjust_journal_entry_id', 'payment_in_journal_entry_id'])
      put(l[col], n(l.id))
  for (const r of await safe('SELECT lc_id, journal_entry_id FROM lc_issuances')) put(r.journal_entry_id, n(r.lc_id))
  for (const r of await safe('SELECT lc_id, journal_entry_id, fee_journal_entry_id FROM lc_repayments')) {
    put(r.journal_entry_id, n(r.lc_id))
    put(r.fee_journal_entry_id, n(r.lc_id))
  }
  for (const r of await safe('SELECT lc_id, rebate_journal_entry_id, rebate_payout_journal_entry_id FROM lc_parts')) {
    put(r.rebate_journal_entry_id, n(r.lc_id))
    put(r.rebate_payout_journal_entry_id, n(r.lc_id))
  }
  return out
}

/**
 * THE LC VOUCHER LINES NOT ON THE LEDGERS CHOSEN FOR LCs — and the supplier
 * lines an LC put on a CUSTOMER ledger (JV/15: Siddharth's payment on
 * SIDDHARTH OILS, Sundry Debtors, where Tally has Siddharth Oils (Cr)).
 * Each line with where it is and where it goes. Nothing moves here.
 */
export async function previewLcLedgerMoves(): Promise<Row> {
  const c = getClient()
  const s = await getLcLedgerSettings()
  const { partyAccountName } = await import('./partyLedgers')
  const vouchers = await lcVouchers()
  const ids = [...vouchers.keys()]
  const findings: Row[] = []
  if (!ids.length) return { settings: s, payables: [], findings }
  // The app's own payable names in use, so each can be paired with a ledger.
  const payableNames = new Set<string>()
  const lines: Row[] = []
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    const r = await c.execute({
      sql: `SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.dr, jl.cr, a.name AS account, a.acc_group,
                   je.entry_date, je.company_id, (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
              FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.entry_id IN (${chunk.map(() => '?').join(',')})`,
      args: chunk
    })
    lines.push(...r.rows.map((x) => ({ ...(x as unknown as Row) })))
  }
  const debtorGroups = await debtorGroupNames()
  const coNames = new Map(
    (await c.execute('SELECT id, name FROM companies')).rows.map((r) => [n((r as unknown as Row).id), String((r as unknown as Row).name || '')])
  )
  for (const l of lines) {
    const lc = vouchers.get(n(l.entry_id)) as Row
    const name = up(l.account)
    let to = ''
    let why = ''
    if (/^LC PAYABLE( - |$)/.test(name)) {
      payableNames.add(name)
      if (s.payables[name] && s.payables[name] !== name) {
        to = s.payables[name]
        why = 'LC liability'
      }
    } else if (name === 'INTEREST A/C' && s.interest && s.interest !== name) {
      to = s.interest
      why = 'LC interest'
    } else if ((name === 'BANK CHARGES A/C' || name === 'COMM. CHARGES A/C') && s.charges && s.charges !== name) {
      to = s.charges
      why = 'LC charges'
    } else if (debtorGroups.has(up(l.acc_group)) && String(lc.party_type) === 'supplier' && up(lc.supplier_name) && up(lc.supplier_name).replace(/\s*\((DR|CR)\)$/, '') === name.replace(/\s*\((DR|CR)\)$/, '')) {
      const want = up(await partyAccountName(String(lc.supplier_name), 'Sundry Creditors', n(l.company_id)))
      if (want && want !== name) {
        to = want
        why = 'supplier on a customer ledger'
      }
    }
    if (!to) continue
    if (!(await ledgerExistsCached(to))) continue
    findings.push({
      line_id: n(l.line_id),
      entry_id: n(l.entry_id),
      code: String(l.code || ''),
      date: String(l.entry_date || '').slice(0, 10),
      company_id: n(l.company_id),
      company: coNames.get(n(l.company_id)) || '',
      lc_no: String(lc.lc_no || ''),
      from: String(l.account),
      to,
      why,
      dr: n(l.dr),
      cr: n(l.cr)
    })
  }
  findings.sort((a, b) => String(a.date).localeCompare(String(b.date)) || n(a.entry_id) - n(b.entry_id))
  return { settings: s, payables: [...payableNames].sort(), findings }
}

const existsCache = new Map<string, boolean>()
async function ledgerExistsCached(name: string): Promise<boolean> {
  const k = up(name)
  if (!existsCache.has(k)) existsCache.set(k, await ledgerExists(k))
  return existsCache.get(k) as boolean
}

/** The debtor group and every group under it (SC-OIL style sub-groups included). */
async function debtorGroupNames(): Promise<Set<string>> {
  try {
    const { groupsUnder } = await import('./ledgerGroups')
    return new Set((await groupsUnder('Sundry Debtors')).map(up))
  } catch {
    return new Set(['SUNDRY DEBTORS'])
  }
}

/**
 * Move the picked lines. Only the ledger a line sits on changes — amount,
 * side, date and voucher number stay — and every move is logged.
 */
export async function applyLcLedgerMoves(lineIds: number[]): Promise<{ moved: number; vouchers: number }> {
  const want = new Set((lineIds || []).map(n).filter(Boolean))
  if (!want.size) throw new Error('Pick at least one line')
  existsCache.clear()
  const { findings } = await previewLcLedgerMoves()
  return withDbTransaction(async () => {
    const c = getClient()
    await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
        repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    let moved = 0
    const touched = new Set<number>()
    for (const f of findings as Row[]) {
      if (!want.has(n(f.line_id))) continue
      const acc = await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE TRIM(UPPER(name)) = ? LIMIT 1', args: [up(f.to)] })
      if (!acc.rows.length) continue
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`lc-ledger-move:${n(f.line_id)}:${Date.now()}`, n(f.entry_id), JSON.stringify({ line_id: f.line_id, from: f.from, to: f.to, why: f.why, by: getCurrentUser().username || null })]
      })
      await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ?', args: [n(acc.rows[0].id), n(f.line_id)] })
      moved++
      touched.add(n(f.entry_id))
    }
    return { moved, vouchers: touched.size }
  })
}
