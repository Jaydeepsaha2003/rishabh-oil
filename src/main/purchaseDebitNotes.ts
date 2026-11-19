import { getClient } from './db'
import { baseGroupOf } from './ledgerGroups'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

export const DN_KINDS = ['shortage', 'quality'] as const
export type DnKind = (typeof DN_KINDS)[number]

// A PURCHASE AND THE DEBIT NOTES RAISED ON IT — two kinds: the SHORTAGE (less
// received than billed) and the QUALITY claim (FFA, moisture and the like).
// Any DEBIT NOTE voucher debiting the supplier's ledger — made here or booked
// from Tally — can be linked to a purchase as one or the other. Like the sales
// shortage link (saleShortageNotes.ts), it only records which note it was; the
// vouchers are not touched.
let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS purchase_dn_links (
    company_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, order_id, entry_id, kind)
  )`)
  ready = true
}

async function orderOf(orderId: number): Promise<Row> {
  const r = await getClient().execute({ sql: 'SELECT id, company_id, invoice_no, supplier_id FROM orders WHERE id = ?', args: [n(orderId)] })
  const o = r.rows[0] as unknown as Row | undefined
  if (!o) throw new Error('That purchase is no longer there')
  return o
}

/** The supplier's ledger the purchase was credited to: the Sundry Creditors line of its voucher. */
async function supplierLedgerOf(orderId: number): Promise<number> {
  const lines = (
    await getClient().execute({
      sql: `SELECT jl.account_id, jl.cr, a.acc_group FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.order_id = ? AND jl.cr > 0 ORDER BY jl.cr DESC`,
      args: [n(orderId)]
    })
  ).rows as unknown as Row[]
  for (const l of lines) if ((await baseGroupOf(String(l.acc_group))) === 'Sundry Creditors') return n(l.account_id)
  return lines.length ? n(lines[0].account_id) : 0
}

const codeSql = "(SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id)"

/**
 * LINKED IN ACCOUNTING: a DEBIT NOTE whose supplier line is set Agst Ref a
 * purchase bill (by the bill itself, or by its number on the same supplier's
 * ledger the purchase was posted to), or a note raised against that invoice.
 * Read live — the note's own type (shortage / quality) decides which chip it
 * shows as, 'other' when it has none — so editing or deleting the note in
 * Accounting moves the Purchases page with it.
 */
async function accountingLinks(orderId?: number): Promise<Row[]> {
  const c = getClient()
  const one = orderId ? 'AND o.id = ?' : ''
  const args = orderId ? [n(orderId)] : []
  const viaAllocs = (
    await c.execute({
      sql: `SELECT o.company_id, o.id AS order_id, je.id AS entry_id, COALESCE(NULLIF(nt.dn_kind, ''), 'other') AS kind,
                   ROUND(SUM(ba.amount), 2) AS amount, je.entry_date, je.vch_no, ${codeSql} AS code
              FROM journal_bill_allocs ba
              JOIN journal_lines jl ON jl.id = ba.line_id
              JOIN journal_entries je ON je.id = jl.entry_id
              JOIN orders o ON o.company_id = je.company_id
                AND (ba.order_id = o.id
                     OR (ba.order_id IS NULL AND TRIM(UPPER(ba.ref_name)) = TRIM(UPPER(o.invoice_no))
                         AND EXISTS (SELECT 1 FROM journal_entries pj JOIN journal_lines pl ON pl.entry_id = pj.id
                                      WHERE pj.order_id = o.id AND pl.account_id = ba.account_id AND pl.cr > 0)))
              LEFT JOIN notes nt ON nt.journal_entry_id = je.id
             WHERE UPPER(je.vch_type) LIKE 'DEBIT NOTE%' AND ba.method = 'agst_ref' AND jl.dr > 0 ${one}
             GROUP BY o.id, je.id`,
      args
    })
  ).rows as unknown as Row[]
  const viaNote = (
    await c.execute({
      sql: `SELECT o.company_id, o.id AS order_id, je.id AS entry_id, COALESCE(NULLIF(nt.dn_kind, ''), 'other') AS kind,
                   ROUND(nt.total_amount, 2) AS amount, je.entry_date, je.vch_no, ${codeSql} AS code
              FROM notes nt
              JOIN journal_entries je ON je.id = nt.journal_entry_id
              JOIN orders o ON o.company_id = nt.company_id AND o.supplier_id = nt.party_id
                AND TRIM(UPPER(o.invoice_no)) = TRIM(UPPER(nt.against_ref))
             WHERE nt.note_type = 'debit' AND nt.party_type = 'supplier' AND COALESCE(nt.against_ref, '') <> '' ${one}`,
      args
    })
  ).rows as unknown as Row[]
  const seen = new Set<string>()
  const out: Row[] = []
  for (const r of [...viaAllocs, ...viaNote]) {
    const k = `${n(r.order_id)}|${n(r.entry_id)}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ ...r, amount: round2(n(r.amount)), from_accounting: true })
  }
  return out
}

/**
 * The debit notes that could be linked to this purchase: every DEBIT NOTE
 * voucher in its book debiting the supplier's ledger, the ones naming this
 * invoice first. Each carries the type it was raised as (notes.dn_kind), and
 * what it is already linked to.
 */
export async function purchaseDnCandidates(orderId: number): Promise<Row> {
  await ensure()
  const c = getClient()
  const o = await orderOf(orderId)
  const acc = await supplierLedgerOf(orderId)
  const linked = (await c.execute({ sql: 'SELECT entry_id, kind, amount FROM purchase_dn_links WHERE company_id = ? AND order_id = ?', args: [n(o.company_id), n(o.id)] })).rows as unknown as Row[]
  const auto = await accountingLinks(n(o.id))
  const autoOf = new Map(auto.map((a) => [n(a.entry_id), a]))
  if (!acc) return { invoice_no: o.invoice_no, notes: [], linked }
  const rows = (
    await c.execute({
      sql: `SELECT je.id AS entry_id, je.entry_date, je.vch_no, je.narration, ${codeSql} AS code,
                   (SELECT SUM(jl.dr) FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = ?) AS amount,
                   (SELECT GROUP_CONCAT(ba.ref_name, ', ') FROM journal_bill_allocs ba JOIN journal_lines jl2 ON jl2.id = ba.line_id
                     WHERE jl2.entry_id = je.id AND ba.ref_name IS NOT NULL) AS refs,
                   (SELECT nt.dn_kind FROM notes nt WHERE nt.journal_entry_id = je.id LIMIT 1) AS dn_kind,
                   (SELECT GROUP_CONCAT(o2.invoice_no || ' (' || t.kind || ')', ', ') FROM purchase_dn_links t JOIN orders o2 ON o2.id = t.order_id
                     WHERE t.entry_id = je.id AND t.company_id = je.company_id AND t.order_id <> ?) AS linked_elsewhere
              FROM journal_entries je
             WHERE je.company_id = ? AND UPPER(je.vch_type) LIKE 'DEBIT NOTE%'
               AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = ? AND jl.dr > 0)
             ORDER BY je.entry_date DESC, je.id DESC`,
      args: [acc, n(o.id), n(o.company_id), acc]
    })
  ).rows as unknown as Row[]
  const no = String(o.invoice_no || '').toUpperCase()
  const linkedIds = new Set(linked.map((l) => n(l.entry_id)))
  const notes = rows
    .map((r) => ({
      ...r,
      amount: round2(n(r.amount)),
      names_invoice: !!no && (String(r.refs || '').toUpperCase().includes(no) || String(r.narration || '').toUpperCase().includes(no)),
      // Linked in Accounting (Agst Ref this bill) — shown ticked, under its own type.
      auto_kind: autoOf.get(n(r.entry_id))?.kind || null
    }))
    // A note set Agst Ref ANOTHER bill settles that one — left out unless already linked here.
    .filter((r: Row) => r.names_invoice || r.auto_kind || !String(r.refs || '').trim() || linkedIds.has(n(r.entry_id)))
  notes.sort((a, b) => Number(b.names_invoice) - Number(a.names_invoice))
  return { invoice_no: o.invoice_no, notes, linked }
}

/** Link debit notes to the purchase, each as shortage or quality (replacing what was linked before). */
export async function setPurchaseDnLinks(orderId: number, links: { entry_id: number; kind: string }[]): Promise<{ linked: number }> {
  await ensure()
  const c = getClient()
  const o = await orderOf(orderId)
  const cand = await purchaseDnCandidates(orderId)
  const allowed = new Map((cand.notes as Row[]).map((x) => [n(x.entry_id), n(x.amount)]))
  const clean = (links || [])
    .map((l) => ({ entry_id: n(l.entry_id), kind: String(l.kind || '').toLowerCase() }))
    .filter((l) => l.entry_id > 0 && (DN_KINDS as readonly string[]).includes(l.kind))
  for (const l of clean) if (!allowed.has(l.entry_id)) throw new Error('That is not a debit note to this supplier in this book')
  await c.execute({ sql: 'DELETE FROM purchase_dn_links WHERE company_id = ? AND order_id = ?', args: [n(o.company_id), n(o.id)] })
  for (const l of clean) {
    await c.execute({
      sql: 'INSERT OR IGNORE INTO purchase_dn_links (company_id, order_id, entry_id, kind, amount) VALUES (?, ?, ?, ?, ?)',
      args: [n(o.company_id), n(o.id), l.entry_id, l.kind, allowed.get(l.entry_id) || 0]
    })
  }
  return { linked: clean.length }
}

/** Every link, for the Purchases list: order_id → its shortage and quality notes. */
export async function purchaseDnMap(): Promise<Row[]> {
  await ensure()
  const res = await getClient().execute(`
    SELECT t.company_id, t.order_id, t.entry_id, t.kind, t.amount, je.entry_date, je.vch_no, ${codeSql} AS code
      FROM purchase_dn_links t JOIN journal_entries je ON je.id = t.entry_id
     ORDER BY je.entry_date`)
  const hand = res.rows.map((r) => ({ ...(r as unknown as Row) }))
  const handKeys = new Set(hand.map((r) => `${n(r.order_id)}|${n(r.entry_id)}`))
  return [...hand, ...(await accountingLinks()).filter((r) => !handKeys.has(`${n(r.order_id)}|${n(r.entry_id)}`))]
}
