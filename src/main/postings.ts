// WHAT A DOCUMENT PUT IN THE LEDGERS.
// -----------------------------------------------------------------------------
// The books already answer the question the other way round: open the Day Book,
// find a voucher, and it tells you which invoice or letter posted it. Going the
// other way — "this purchase bill is in front of me, what did it actually do to
// the accounts?" — meant knowing which ledgers to open and reading down them
// for a figure that matched. On a bill that posts one voucher that is tedious;
// on a letter of credit, which posts its opening, its interest, its charges,
// every bill settled against it, every repayment and every receipt, it is not
// realistically doable at all.
//
// So this reads the link the posting itself recorded. Every voucher this app
// writes is owned by a row that keeps its id — orders and sales through
// journal_entries' own order_id/sale_id, an LC and a discounted bill through
// the columns on themselves and on their issuances, repayments, interest
// payments and receipts. Nothing here is matched on a narration or a number:
// LC-1 through LC-8 exist twice over in one of these books, and a number is
// not an identity.
//
// Two lists come back, because they are two different facts:
//   POSTED BY this document  — the vouchers it wrote itself;
//   SETTLED AGAINST it       — the receipts and payments that squared it off,
//                              which belong to the money coming in, not to the
//                              invoice, and are bill-allocated rather than owned.
//
// Read-only throughout. Nothing in this file writes.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { voucherCodeMap } from './journal'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const s = (v: unknown): string => (v == null ? '' : String(v))
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100
const dmy = (v: unknown): string => {
  const d = s(v).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`
}

export type PostingEntity = 'order' | 'sale' | 'lc' | 'bd' | 'trading'

export interface PostingLine {
  account: string
  acc_group: string
  dr: number
  cr: number
}

export interface Posting {
  id: number
  company_id: number
  entry_date: string
  vch_type: string
  vch_no: string | null
  /** The running serial the ledgers show — PUR/12, JV/46. See voucherCodeMap. */
  code: string
  narration: string | null
  /** What in the document wrote it: "Repayment · 16-09-2026", "Interest". */
  role: string
  amount: number
  /** The credit side, summed the same way — see the note in loadEntries. */
  credit: number
  balanced: boolean
  /** For a settlement, how much of that voucher was put against this bill. */
  allocated?: number
  lines: PostingLine[]
}

export interface DocumentPostings {
  entity: PostingEntity
  id: number
  /** Every row of the document, where a bill runs to more than one. */
  ids: number[]
  posted: Posting[]
  settled: Posting[]
  totals: { count: number; dr: number; cr: number }
}

/**
 * WHICH COLUMNS THIS BOOK ACTUALLY HAS.
 *
 * These tables have been extended a dozen times and the columns arrive with
 * the migration that adds them — bill_group on orders, comm_charges on a BD
 * repayment. A book that has not run one yet is a book where the column is not
 * there, and naming it in a SELECT is an error that takes the whole panel down
 * rather than leaving out one line of it. So the query is built from what is
 * there.
 *
 * Cached for a minute: the schema settles at startup and does not move again,
 * but a short life means a restore is picked up without a restart.
 */
const colCache = new Map<string, { at: number; cols: Set<string> }>()
async function columnsOf(table: string): Promise<Set<string>> {
  const hit = colCache.get(table)
  if (hit && Date.now() - hit.at < 60_000) return hit.cols
  let cols = new Set<string>()
  try {
    const r = await getClient().execute(`PRAGMA table_info(${table})`)
    cols = new Set(r.rows.map((x) => s((x as unknown as Row).name)))
  } catch {
    // No such table in this book — an empty set, and every caller skips it.
  }
  colCache.set(table, { at: Date.now(), cols })
  return cols
}

/** An entry id with the label saying what part of the document wrote it. */
interface Source {
  id: number
  role: string
}

/**
 * The vouchers owned by a row of the document itself — the columns it keeps on
 * its own record, each standing for one thing it did.
 */
async function ownColumns(
  table: string,
  id: number,
  spec: [string, string][]
): Promise<Source[]> {
  const have = await columnsOf(table)
  const wanted = spec.filter(([col]) => have.has(col))
  if (!wanted.length || !have.has('id')) return []
  const res = await getClient().execute({
    sql: `SELECT ${wanted.map(([c]) => c).join(', ')} FROM ${table} WHERE id = ?`,
    args: [id]
  })
  if (!res.rows.length) return []
  const r = toPlain(res)[0]
  const out: Source[] = []
  for (const [col, role] of wanted) {
    const je = n(r[col])
    if (je > 0) out.push({ id: je, role })
  }
  return out
}

/**
 * The vouchers owned by the document's child rows — its repayments, receipts,
 * issuances and interest payments, each of which keeps the id of the voucher
 * it posted.
 */
async function childRows(
  table: string,
  parentCol: string,
  parentId: number,
  jeCols: [string, (r: Row) => string][],
  extra: string[] = []
): Promise<Source[]> {
  const have = await columnsOf(table)
  if (!have.has(parentCol)) return []
  const cols = jeCols.map(([c]) => c).filter((c) => have.has(c))
  if (!cols.length) return []
  const pick = ['id', ...cols, ...extra.filter((c) => have.has(c))]
  const res = await getClient().execute({
    sql: `SELECT ${pick.join(', ')} FROM ${table} WHERE ${parentCol} = ? ORDER BY id`,
    args: [parentId]
  })
  const out: Source[] = []
  for (const r of toPlain(res)) {
    for (const [col, label] of jeCols) {
      if (!have.has(col)) continue
      const je = n(r[col])
      if (je > 0) out.push({ id: je, role: label(r) })
    }
  }
  return out
}

/**
 * EVERY ROW OF THE BILL, NOT JUST THE ONE CLICKED.
 *
 * One invoice number over three products is three rows in these tables, and
 * each of them posts. Opening the panel on any one of them has to answer for
 * the bill, which is the thing the user is holding.
 */
async function billRows(table: string, groupCol: string, id: number): Promise<number[]> {
  const have = await columnsOf(table)
  if (!have.has(groupCol)) return [id]
  const c = getClient()
  const own = await c.execute({
    sql: `SELECT ${groupCol} AS g FROM ${table} WHERE id = ?`,
    args: [id]
  })
  // A bill with no group of its own — which is most of them — answers for
  // itself alone.
  const group = s(own.rows[0]?.g).trim()
  if (!group) return [id]
  const res = await c.execute({
    sql: `SELECT id FROM ${table} WHERE ${groupCol} = ? OR id = ? ORDER BY id`,
    args: [group, id]
  })
  const ids = res.rows.map((r) => n((r as unknown as Row).id)).filter((x) => x > 0)
  return ids.length ? ids : [id]
}

/** The entries themselves, with their lines, in one pass. */
async function loadEntries(ids: number[]): Promise<Map<number, Posting>> {
  const out = new Map<number, Posting>()
  const uniq = Array.from(new Set(ids.filter((x) => x > 0)))
  if (!uniq.length) return out
  const c = getClient()
  const marks = uniq.map(() => '?').join(',')
  const entries = toPlain(
    await c.execute({
      sql: `SELECT id, company_id, entry_date, vch_type, vch_no, narration
              FROM journal_entries WHERE id IN (${marks})`,
      args: uniq
    })
  )
  if (!entries.length) return out
  const lines = toPlain(
    await c.execute({
      sql: `SELECT jl.entry_id, jl.dr, jl.cr, a.name AS account, a.acc_group
              FROM journal_lines jl
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE jl.entry_id IN (${marks})
             ORDER BY CASE WHEN jl.dr > 0 THEN 0 ELSE 1 END, jl.id`,
      args: uniq
    })
  )
  // ROUND FOR SHOWING, ADD BEFORE ROUNDING.
  //
  // A purchase line is stored at full precision — 42,54,194.986664385 — and
  // paise is what anybody reads. But rounding each line and then adding them
  // turns a voucher that is out by a quarter of a paisa into one that is out
  // by a whole one, and the panel would then accuse a perfectly good voucher
  // of not balancing. So the figures shown are rounded and the figures added
  // are not.
  const byEntry = new Map<number, PostingLine[]>()
  const rawSum = new Map<number, { dr: number; cr: number }>()
  for (const l of lines) {
    const k = n(l.entry_id)
    if (!byEntry.has(k)) byEntry.set(k, [])
    byEntry.get(k)!.push({
      account: s(l.account),
      acc_group: s(l.acc_group) || 'General',
      dr: round2(n(l.dr)),
      cr: round2(n(l.cr))
    })
    const t = rawSum.get(k) || { dr: 0, cr: 0 }
    t.dr += n(l.dr)
    t.cr += n(l.cr)
    rawSum.set(k, t)
  }
  // The serial a ledger shows is positional per company, so it is built once
  // per book rather than once per voucher.
  const codes = new Map<number, string>()
  for (const cid of Array.from(new Set(entries.map((e) => n(e.company_id))))) {
    if (!cid) continue
    try {
      for (const [k, v] of await voucherCodeMap(cid)) codes.set(k, v)
    } catch {
      // A book too large or too old to number is still worth showing.
    }
  }
  for (const e of entries) {
    const id = n(e.id)
    const ls = byEntry.get(id) || []
    const raw = rawSum.get(id) || { dr: 0, cr: 0 }
    const dr = round2(raw.dr)
    const cr = round2(raw.cr)
    out.set(id, {
      id,
      company_id: n(e.company_id),
      entry_date: s(e.entry_date).slice(0, 10),
      vch_type: s(e.vch_type),
      vch_no: e.vch_no == null ? null : s(e.vch_no),
      code: codes.get(id) || '',
      narration: e.narration == null ? null : s(e.narration),
      role: '',
      amount: dr,
      credit: cr,
      // The same paisa of slack postJournal allows when it writes one. A
      // voucher this app accepted must not be reported here as broken.
      balanced: Math.abs(raw.dr - raw.cr) <= 0.0100001,
      lines: ls
    })
  }
  return out
}

/**
 * THE RECEIPTS AND PAYMENTS PUT AGAINST THIS BILL, AND HOW MUCH OF EACH.
 *
 * An allocation can name the document two ways. A receipt entered through the
 * voucher screen resolves the reference to an order id or a sale's invoice
 * group and stores that — an identity, which is what should be matched on.
 * But most of what is actually in these books was written with the reference
 * as TEXT and nothing else: 57 allocations in the live book, every one of them
 * with a null order_id. Matching only on the id finds none of them, and the
 * panel would tell somebody looking at a bill they had settled that nothing had
 * ever been put against it.
 *
 * So both, with the text half confined to the document's own company — an
 * invoice number is unique within a book and emphatically not across them.
 */
//
// THE SAME TEXT ON TWO LEDGERS IS TWO DIFFERENT BILLS. A supplier's invoice
// number is that supplier's own — two suppliers can both have issued a bill
// "1" — so where the reference turns up on more than one ledger, only the
// allocations on the document's own party count. Where it is on one ledger
// only, nothing is ambiguous and it is taken as it always was.
async function settlementsFor(
  idWhere: string,
  idArgs: (string | number)[],
  ref: string,
  companyId: number,
  party = ''
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const c = getClient()
  try {
    const byId = await c.execute({
      sql: `SELECT ba.id, jl.entry_id AS entry_id, ba.amount, ba.account_id
              FROM journal_bill_allocs ba
              JOIN journal_lines jl ON jl.id = ba.line_id
             WHERE ${idWhere}`,
      args: idArgs
    })
    const rows = toPlain(byId)
    const seen = new Set(rows.map((r) => n(r.id)))
    if (ref && companyId) {
      const byText = toPlain(
        await c.execute({
          sql: `SELECT ba.id, jl.entry_id AS entry_id, ba.amount, ba.account_id, UPPER(TRIM(a.name)) AS acct
                  FROM journal_bill_allocs ba
                  JOIN journal_lines jl ON jl.id = ba.line_id
                  JOIN journal_entries je ON je.id = jl.entry_id
                  JOIN ledger_accounts a ON a.id = ba.account_id
                 WHERE TRIM(UPPER(ba.ref_name)) = ? AND je.company_id = ?`,
          args: [ref.trim().toUpperCase(), companyId]
        })
      ).filter((r) => !seen.has(n(r.id)))
      const accounts = new Set(byText.map((r) => n(r.account_id)))
      let keep = byText
      if (accounts.size > 1) {
        const names = new Set<string>()
        const p = party.trim().toUpperCase()
        if (p) {
          names.add(p)
          const redirected = await c
            .execute({ sql: 'SELECT use_name FROM ledger_map WHERE UPPER(TRIM(posts_as)) = ?', args: [p] })
            .catch(() => null)
          for (const r of redirected ? toPlain(redirected) : []) names.add(s(r.use_name).trim().toUpperCase())
        }
        keep = byText.filter((r) => names.has(s(r.acct)))
      }
      rows.push(...keep)
    }
    for (const r of rows) out.set(n(r.entry_id), round2((out.get(n(r.entry_id)) || 0) + n(r.amount)))
  } catch {
    // A book with no allocations table answers with the postings alone.
  }
  return out
}

export async function documentPostings(a: {
  entity: PostingEntity
  id: number
}): Promise<DocumentPostings> {
  const c = getClient()
  const id = n(a.id)
  const entity = a.entity
  if (!id) throw new Error('No document to look up')

  let ids: number[] = [id]
  let sources: Source[] = []
  let settled = new Map<number, number>()

  if (entity === 'order') {
    ids = await billRows('orders', 'bill_group', id)
    const marks = ids.map(() => '?').join(',')
    const res = await c.execute({
      sql: `SELECT id, vch_type FROM journal_entries WHERE order_id IN (${marks}) ORDER BY entry_date, id`,
      args: ids
    })
    sources = toPlain(res).map((r) => ({ id: n(r.id), role: roleOfType(s(r.vch_type), 'purchase') }))
    const doc = toPlain(
      await c.execute({
        sql: 'SELECT o.invoice_no, o.company_id, sp.name AS party FROM orders o LEFT JOIN suppliers sp ON sp.id = o.supplier_id WHERE o.id = ?',
        args: [id]
      })
    )[0]
    settled = await settlementsFor(
      `ba.order_id IN (${marks})`,
      ids,
      s(doc?.invoice_no),
      n(doc?.company_id),
      s(doc?.party)
    )
  } else if (entity === 'sale') {
    ids = await billRows('sales', 'invoice_group', id)
    const marks = ids.map(() => '?').join(',')
    const res = await c.execute({
      sql: `SELECT id, vch_type FROM journal_entries WHERE sale_id IN (${marks}) ORDER BY entry_date, id`,
      args: ids
    })
    sources = toPlain(res).map((r) => ({ id: n(r.id), role: roleOfType(s(r.vch_type), 'sale') }))
    // A receipt is allocated against the invoice GROUP, which is what the
    // invoice number actually is once a bill runs to several lines.
    const doc = toPlain(
      await c.execute({
        sql: 'SELECT sl.invoice_no, sl.invoice_group, sl.company_id, cu.name AS party FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id WHERE sl.id = ?',
        args: [id]
      })
    )[0]
    const grp = s(doc?.invoice_group).trim()
    settled = await settlementsFor(
      grp ? 'ba.sale_invoice_group = ?' : '1 = 0',
      grp ? [grp] : [],
      s(doc?.invoice_no),
      n(doc?.company_id),
      s(doc?.party)
    )
  } else if (entity === 'lc') {
    sources = [
      ...(await ownColumns('letters_of_credit', id, [
        ['journal_entry_id', 'LC opened'],
        ['charges_journal_entry_id', 'Bank charges'],
        ['interest_journal_entry_id', 'Interest'],
        ['fee_adjust_journal_entry_id', 'Interest adjusted'],
        ['preclose_journal_entry_id', 'Preclosure'],
        ['preclose_interest_journal_entry_id', 'Preclosure interest'],
        ['preclose_payout_journal_entry_id', 'Preclosure payout'],
        ['payment_in_journal_entry_id', 'Payment IN']
      ])),
      ...(await childRows(
        'lc_issuances',
        'lc_id',
        id,
        [['journal_entry_id', (r) => `Bill settled${s(r.bill_no) ? ` · ${s(r.bill_no)}` : ''}`]],
        ['bill_no', 'issue_date']
      )),
      ...(await childRows(
        'lc_repayments',
        'lc_id',
        id,
        [
          ['journal_entry_id', (r) => `Repayment${s(r.repay_date) ? ` · ${dmy(r.repay_date)}` : ''}`],
          ['fee_journal_entry_id', (r) => `Repayment charges${s(r.repay_date) ? ` · ${dmy(r.repay_date)}` : ''}`]
        ],
        ['repay_date']
      )),
      ...(await childRows(
        'lc_payment_ins',
        'lc_id',
        id,
        [['journal_entry_id', (r) => `Payment IN${s(r.pay_date) ? ` · ${dmy(r.pay_date)}` : ''}`]],
        ['pay_date']
      ))
    ]
  } else if (entity === 'bd') {
    sources = [
      ...(await ownColumns('bill_discountings', id, [
        ['journal_entry_id', 'Bill discounted'],
        ['upfront_interest_journal_entry_id', 'Upfront interest paid'],
        ['repay_journal_entry_id', 'Repaid'],
        ['margin_release_journal_entry_id', 'Margin released']
      ])),
      ...(await childRows(
        'bd_repayments',
        'bd_id',
        id,
        [
          ['journal_entry_id', (r) => `Repayment${s(r.repay_date) ? ` · ${dmy(r.repay_date)}` : ''}`],
          ['interest_entry_id', (r) => `Repayment interest${s(r.repay_date) ? ` · ${dmy(r.repay_date)}` : ''}`]
        ],
        ['repay_date']
      )),
      ...(await childRows(
        'bd_interest_payments',
        'bd_id',
        id,
        [
          [
            'journal_entry_id',
            (r) =>
              `Interest${s(r.from_date) && s(r.to_date) ? ` · ${dmy(r.from_date)} → ${dmy(r.to_date)}` : ''}`
          ]
        ],
        ['from_date', 'to_date']
      )),
      ...(await childRows(
        'bd_payment_ins',
        'bd_id',
        id,
        [['journal_entry_id', (r) => `Payment IN${s(r.pay_date) ? ` · ${dmy(r.pay_date)}` : ''}`]],
        ['pay_date']
      ))
    ]
  } else if (entity === 'trading') {
    // A TRADING DEAL IS TWO INVOICES, AND THAT IS THE WHOLE POINT OF IT.
    //
    // Bought from one party and sold straight to another without the oil ever
    // landing in stock. Its books are the purchase voucher and the sale
    // voucher, and what a reader wants from a deal is precisely those two side
    // by side — the margin is the difference between them, and until now
    // checking it meant opening each invoice on its own page.
    //
    // A deal reaches its invoices through trading_deal_orders /
    // trading_deal_sales, with the deal's own order_id and sale_id standing in
    // for one booked before those tables existed.
    const oIds = await dealSideIds('trading_deal_orders', 'order_id', 'order_id', id)
    const sIds = await dealSideIds('trading_deal_sales', 'sale_id', 'sale_id', id)
    ids = [...oIds, ...sIds]
    const parts: Source[] = []
    if (oIds.length) {
      const res = await c.execute({
        sql: `SELECT id, vch_type FROM journal_entries WHERE order_id IN (${oIds.map(() => '?').join(',')})`,
        args: oIds
      })
      for (const r of toPlain(res)) parts.push({ id: n(r.id), role: roleOfType(s(r.vch_type), 'purchase') })
    }
    if (sIds.length) {
      const res = await c.execute({
        sql: `SELECT id, vch_type FROM journal_entries WHERE sale_id IN (${sIds.map(() => '?').join(',')})`,
        args: sIds
      })
      for (const r of toPlain(res)) parts.push({ id: n(r.id), role: roleOfType(s(r.vch_type), 'sale') })
    }
    sources = parts
    // What has been paid out on the buy and taken in on the sell. Both sides
    // are allocated by the invoice number the voucher names, which is why the
    // references are gathered rather than the ids alone.
    const refs: Row[] = []
    if (oIds.length) {
      refs.push(
        ...toPlain(
          await c.execute({
            sql: `SELECT o.invoice_no, o.company_id, sp.name AS party FROM orders o LEFT JOIN suppliers sp ON sp.id = o.supplier_id WHERE o.id IN (${oIds.map(() => '?').join(',')})`,
            args: oIds
          })
        )
      )
    }
    if (sIds.length) {
      refs.push(
        ...toPlain(
          await c.execute({
            sql: `SELECT sl.invoice_no, sl.company_id, cu.name AS party FROM sales sl LEFT JOIN customers cu ON cu.id = sl.customer_id WHERE sl.id IN (${sIds.map(() => '?').join(',')})`,
            args: sIds
          })
        )
      )
    }
    const merged = new Map<number, number>()
    for (const d of refs) {
      const one = await settlementsFor('1 = 0', [], s(d.invoice_no), n(d.company_id), s(d.party))
      for (const [k, v2] of one) merged.set(k, round2((merged.get(k) || 0) + v2))
    }
    settled = merged
  } else {
    throw new Error(`Nothing is posted from a ${String(entity)}`)
  }

  // One voucher can be named by two things — an LC's own interest column and
  // the repayment that wrote it are the same entry — so the roles are merged
  // rather than the voucher being listed twice.
  const roleById = new Map<number, string[]>()
  for (const src of sources) {
    if (!roleById.has(src.id)) roleById.set(src.id, [])
    const list = roleById.get(src.id)!
    if (!list.includes(src.role)) list.push(src.role)
  }
  const loaded = await loadEntries([...roleById.keys(), ...settled.keys()])

  const posted: Posting[] = []
  for (const [jeId, roles] of roleById) {
    const p = loaded.get(jeId)
    // A column still holding an id whose voucher has been deleted. Nothing to
    // show, and nothing is wrong with the document — the voucher went with a
    // reversal.
    if (!p) continue
    posted.push({ ...p, role: roles.join(' · ') })
  }
  posted.sort((x, y) => (x.entry_date === y.entry_date ? x.id - y.id : x.entry_date < y.entry_date ? -1 : 1))

  const settledOut: Posting[] = []
  for (const [jeId, amount] of settled) {
    if (roleById.has(jeId)) continue
    const p = loaded.get(jeId)
    if (!p) continue
    settledOut.push({ ...p, role: roleOfType(p.vch_type, 'settle'), allocated: amount })
  }
  settledOut.sort((x, y) => (x.entry_date === y.entry_date ? x.id - y.id : x.entry_date < y.entry_date ? -1 : 1))

  return {
    entity,
    id,
    ids,
    posted,
    settled: settledOut,
    totals: {
      count: posted.length,
      dr: round2(posted.reduce((t, p) => t + p.amount, 0)),
      cr: round2(posted.reduce((t, p) => t + p.lines.reduce((u, l) => u + l.cr, 0), 0))
    }
  }
}

/**
 * The purchase or sale rows one trading deal is made of.
 *
 * Through its link table where there is one, and through the deal's own single
 * id where the deal predates it — an older deal carries one invoice on each
 * side rather than a list.
 */
async function dealSideIds(
  table: string,
  col: string,
  fallbackCol: string,
  dealId: number
): Promise<number[]> {
  const out: number[] = []
  const have = await columnsOf(table)
  if (have.has(col) && have.has('deal_id')) {
    const res = await getClient().execute({
      sql: `SELECT ${col} AS v FROM ${table} WHERE deal_id = ? ORDER BY id`,
      args: [dealId]
    })
    for (const r of toPlain(res)) if (n(r.v) > 0) out.push(n(r.v))
  }
  if (!out.length) {
    const own = await columnsOf('trading_deals')
    if (own.has(fallbackCol)) {
      const res = await getClient().execute({
        sql: `SELECT ${fallbackCol} AS v FROM trading_deals WHERE id = ?`,
        args: [dealId]
      })
      const v = n((res.rows[0] as unknown as Row)?.v)
      if (v > 0) out.push(v)
    }
  }
  return Array.from(new Set(out))
}

/** A voucher type said the way the document's own page says it. */
function roleOfType(t: string, ctx: 'purchase' | 'sale' | 'settle'): string {
  const u = t.toUpperCase()
  if (u.includes('PURCHASE')) return 'Purchase invoice'
  if (u.includes('SALE')) return 'Sales invoice'
  if (u.includes('DEBIT')) return 'Debit note'
  if (u.includes('CREDIT')) return 'Credit note'
  if (u.includes('RECEIPT')) return 'Receipt'
  if (u.includes('PAYMENT')) return 'Payment'
  if (u.includes('CONTRA')) return 'Contra'
  if (u.includes('OPENING')) return 'Opening'
  if (u.includes('JOURNAL')) {
    return ctx === 'settle' ? 'Adjustment' : ctx === 'purchase' ? 'Purchase journal' : 'Sales journal'
  }
  return t || 'Voucher'
}
