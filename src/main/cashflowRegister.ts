import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { listVouchers } from './accounting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100
const toPlain = (rs: { rows: unknown[] }): Row[] => rs.rows.map((r) => ({ ...(r as Row) }))

// THE CASHFLOW REGISTER — every voucher of a period on one page, opened up.
//
// The Day Book says "Dr these → Cr those". This says everything a reader needs
// to check an entry without opening it: the document it came from (invoice no),
// the bills it was set against (ref no), the party, every ledger line with its
// Dr or Cr, the bill references on each party line, and the breakdown written
// under any line ("what this line is made of"). Each voucher also states the
// money it moved through bank or cash — in or out — and what about it is not
// right: a voucher whose two sides differ, a breakdown that does not add up to
// its line, a payment or receipt to a party set against no bill, a party line
// with no party.
//
// Read only. Three queries for the lines, the bill references and the
// breakdowns of every voucher in the period, so a month reads as fast as a day.
export async function cashflowRegister(from?: string, to?: string, companyId?: number, onlySplits = false, vchType?: string): Promise<Row> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const all = await listVouchers(from, to, undefined, cid)
  const total = all.length
  // ONLY THE BROKEN-DOWN ONES (the register's own view): a year is ~3,000
  // vouchers and 2.7 MB opened up, of which a handful carry a breakdown.
  let heads = all
  let withSplits: Set<number> | null = null
  if (onlySplits) {
    withSplits = new Set(
      toPlain(
        await c
          .execute({
            sql: `SELECT DISTINCT jl.entry_id AS id FROM journal_line_splits s JOIN journal_lines jl ON jl.id = s.line_id
                    JOIN journal_entries je ON je.id = jl.entry_id WHERE je.company_id = ?`,
            args: [cid]
          })
          .catch(() => ({ rows: [] }))
      ).map((r) => n(r.id))
    )
    heads = all.filter((h) => withSplits!.has(n(h.id)))
  }
  // One kind of voucher only (the Journal Register asks for JOURNAL).
  if (vchType) {
    const want = vchType.toUpperCase()
    heads = heads.filter((h) => String(h.vch_type || '').toUpperCase().startsWith(want))
    withSplits = new Set(heads.map((h) => n(h.id)))
  }
  if (!heads.length) return { from: from || null, to: to || null, vouchers: [], total, openings: {} }

  const conds = ['je.company_id = ?']
  const args: (string | number)[] = [cid]
  if (from) {
    conds.push('je.entry_date >= ?')
    args.push(from)
  }
  if (to) {
    conds.push('je.entry_date <= ?')
    args.push(to)
  }
  if (withSplits) conds.push(`je.id IN (${[...withSplits].map((id) => Number(id)).join(',') || '0'})`)
  const inPeriod = `SELECT je.id FROM journal_entries je WHERE ${conds.join(' AND ')}`

  // Which group each ledger's group sits under, to the top — so a party ledger
  // in a sub-group of Sundry Debtors is still read as a customer.
  const groups = toPlain(await c.execute('SELECT id, name, parent_id FROM ledger_groups').catch(() => ({ rows: [] })))
  const gById = new Map(groups.map((g) => [n(g.id), g]))
  const gByName = new Map(groups.map((g) => [String(g.name).trim().toUpperCase(), g]))
  const rootsOf = (name: string): string[] => {
    const out: string[] = [String(name || '').trim().toUpperCase()]
    let g = gByName.get(out[0])
    const seen = new Set<number>()
    while (g && g.parent_id != null && !seen.has(n(g.id))) {
      seen.add(n(g.id))
      g = gById.get(n(g.parent_id))
      if (g) out.push(String(g.name).trim().toUpperCase())
    }
    return out
  }
  const kindOf = (group: string): 'customer' | 'supplier' | 'money' | 'tax' | 'other' => {
    const chain = rootsOf(group)
    if (chain.includes('SUNDRY DEBTORS')) return 'customer'
    if (chain.includes('SUNDRY CREDITORS')) return 'supplier'
    if (chain.some((x) => x === 'BANK ACCOUNTS' || x === 'BANK OD A/C' || x === 'CASH-IN-HAND')) return 'money'
    if (chain.includes('DUTIES & TAXES')) return 'tax'
    return 'other'
  }

  const lines = toPlain(
    await c.execute({
      sql: `SELECT jl.id, jl.entry_id, jl.dr, jl.cr, jl.account_id, a.name AS account, a.acc_group AS acc_group
              FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE jl.entry_id IN (${inPeriod})
             ORDER BY jl.entry_id, jl.id`,
      args
    })
  )
  const allocs = toPlain(
    await c.execute({
      sql: `SELECT ba.line_id, ba.method, ba.ref_name, ba.amount
              FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id
             WHERE jl.entry_id IN (${inPeriod})
             ORDER BY ba.id`,
      args
    })
  )
  const splits = toPlain(
    await c
      .execute({
        sql: `SELECT s.line_id, s.name, s.amount, s.note, s.branch
                FROM journal_line_splits s JOIN journal_lines jl ON jl.id = s.line_id
               WHERE jl.entry_id IN (${inPeriod})
               ORDER BY s.line_id, s.sort_order, s.id`,
        args
      })
      .catch(() => ({ rows: [] }))
  )
  const allocsOf = new Map<number, Row[]>()
  for (const a of allocs) {
    const k = n(a.line_id)
    if (!allocsOf.has(k)) allocsOf.set(k, [])
    allocsOf.get(k)!.push({ method: String(a.method || ''), ref: String(a.ref_name || ''), amount: round2(n(a.amount)) })
  }
  const splitsOf = new Map<number, Row[]>()
  for (const s of splits) {
    const k = n(s.line_id)
    if (!splitsOf.has(k)) splitsOf.set(k, [])
    splitsOf.get(k)!.push({ name: String(s.name || ''), amount: round2(n(s.amount)), note: s.note ? String(s.note) : '', branch: s.branch ? String(s.branch) : '' })
  }
  const linesOf = new Map<number, Row[]>()
  for (const l of lines) {
    const k = n(l.entry_id)
    if (!linesOf.has(k)) linesOf.set(k, [])
    const dr = round2(n(l.dr))
    const cr = round2(n(l.cr))
    linesOf.get(k)!.push({
      id: n(l.id),
      account_id: n(l.account_id),
      account: String(l.account || ''),
      group: String(l.acc_group || ''),
      kind: kindOf(String(l.acc_group || '')),
      side: dr > 0 ? 'dr' : 'cr',
      amount: dr > 0 ? dr : cr,
      refs: allocsOf.get(n(l.id)) || [],
      splits: splitsOf.get(n(l.id)) || []
    })
  }

  const vouchers = heads.map((h) => {
    const ls = linesOf.get(n(h.id)) || []
    const dr = round2(ls.filter((l) => l.side === 'dr').reduce((t, l) => t + l.amount, 0))
    const cr = round2(ls.filter((l) => l.side === 'cr').reduce((t, l) => t + l.amount, 0))
    const money = ls.filter((l) => l.kind === 'money')
    const moneyIn = round2(money.filter((l) => l.side === 'dr').reduce((t, l) => t + l.amount, 0))
    const moneyOut = round2(money.filter((l) => l.side === 'cr').reduce((t, l) => t + l.amount, 0))
    const parties = ls.filter((l) => l.kind === 'customer' || l.kind === 'supplier')
    const type = String(h.vch_type || '').toUpperCase()
    const refs = [...new Set(ls.flatMap((l) => (l.refs as Row[]).filter((r) => r.method === 'agst_ref' || r.method === 'new_ref').map((r) => r.ref)).filter(Boolean))]
    // WHAT IS NOT RIGHT about it, said in words.
    const issues: string[] = []
    if (Math.abs(dr - cr) > 0.01) issues.push(`Dr ${dr.toFixed(2)} and Cr ${cr.toFixed(2)} differ by ${Math.abs(dr - cr).toFixed(2)}`)
    for (const l of ls) {
      const sp = l.splits as Row[]
      if (sp.length) {
        const t = round2(sp.reduce((s, x) => s + n(x.amount), 0))
        if (Math.abs(t - l.amount) > 0.01) issues.push(`${l.account}: its breakdown comes to ${t.toFixed(2)}, the line is ${Number(l.amount).toFixed(2)}`)
      }
    }
    if ((type.startsWith('PAYMENT') || type.startsWith('RECEIPT')) && parties.length && !parties.some((p) => (p.refs as Row[]).length)) {
      issues.push(`${type.startsWith('PAYMENT') ? 'Payment' : 'Receipt'} to a party set against no bill — no Agst Ref, New Ref or On Account`)
    }
    if (!ls.length) issues.push('No lines on this voucher')
    return {
      id: n(h.id),
      date: String(h.entry_date || '').slice(0, 10),
      type: String(h.vch_type || ''),
      code: String(h.voucher_code || h.vch_no || ''),
      vch_no: String(h.vch_no || ''),
      invoice_no: String(h.order_invoice_no || h.sale_invoice_no || h.lc_no || h.bd_no || ''),
      refs,
      party: parties.length ? String(parties[0].account) : '',
      party_kind: parties.length ? String(parties[0].kind) : '',
      narration: String(h.narration || ''),
      dr,
      cr,
      money_in: moneyIn,
      money_out: moneyOut,
      lines: ls,
      issues,
      // Where the voucher came from, for opening it.
      order_id: h.order_id ?? null,
      sale_id: h.sale_id ?? null,
      lc_id: h.lc_id ?? null,
      bd_id: h.bd_id ?? null,
      note_id: h.note_id ?? null,
      trading_deal_id: h.trading_deal_id ?? null,
      order_company_id: h.order_company_id ?? null,
      sale_company_id: h.sale_company_id ?? null
    }
  })
  // EACH BANK AND CASH LEDGER'S BALANCE AS THE PERIOD OPENS, so a register
  // read one bank at a time can run its balance from the right figure.
  const moneyIds = new Map<number, string>()
  for (const ls of linesOf.values()) for (const l of ls) if (l.kind === 'money') moneyIds.set(n(l.account_id), String(l.account))
  const openings: Row = {}
  if (from) {
    const { bankBalanceBefore } = await import('./tallyBank')
    for (const [aid, name] of moneyIds) openings[name] = await bankBalanceBefore(cid, aid, from).catch(() => 0)
  }
  return { from: from || null, to: to || null, vouchers, total, openings }
}
