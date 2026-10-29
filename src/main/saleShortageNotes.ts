import { getClient } from './db'
import { baseGroupOf } from './ledgerGroups'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

// A SALE'S TANKER SHORTAGE, AND THE CREDIT NOTE THAT SETTLED IT.
//
// A delivered (FOR) sale weighed in short at the customer's end, beyond the
// tolerance, is a deduction the customer is owed — the FOR tag works it out
// (saleShortage.ts). The credit note for it is raised in Tally or here, and
// until now nothing on the invoice said whether it had been: the shortage read
// as owing for ever. A credit note — any CREDIT NOTE voucher crediting the
// customer's ledger, a note made here or one booked from Tally — can now be
// linked to the invoice's shortage. The link is a record of which note it was;
// the vouchers themselves are not touched.
let ready = false
async function ensure(): Promise<void> {
  if (ready) return
  await getClient().execute(`CREATE TABLE IF NOT EXISTS sale_shortage_notes (
    company_id INTEGER NOT NULL,
    invoice_key TEXT NOT NULL,
    entry_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, invoice_key, entry_id)
  )`)
  ready = true
}

async function invoiceOf(saleId: number): Promise<Row> {
  const c = getClient()
  const r = await c.execute({
    sql: 'SELECT id, company_id, invoice_group, invoice_no, sale_date, customer_id FROM sales WHERE id = ?',
    args: [n(saleId)]
  })
  const s = r.rows[0] as unknown as Row | undefined
  if (!s) throw new Error('That invoice is no longer there')
  return { ...s, key: String(s.invoice_group || s.invoice_no || `sale-${s.id}`) }
}

/** The customer's ledger the invoice was debited to: the Sundry Debtors line of its sale voucher. */
async function customerLedgerOf(inv: Row): Promise<number> {
  const c = getClient()
  const ids = inv.invoice_group
    ? (await c.execute({ sql: 'SELECT id FROM sales WHERE invoice_group = ?', args: [String(inv.invoice_group)] })).rows.map((r) => n((r as unknown as Row).id))
    : [n(inv.id)]
  const lines = (
    await c.execute({
      sql: `SELECT jl.account_id, jl.dr, a.acc_group FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
              JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.sale_id IN (${ids.map(() => '?').join(',')}) AND jl.dr > 0 ORDER BY jl.dr DESC`,
      args: ids
    })
  ).rows as unknown as Row[]
  for (const l of lines) if ((await baseGroupOf(String(l.acc_group))) === 'Sundry Debtors') return n(l.account_id)
  return lines.length ? n(lines[0].account_id) : 0
}

const codeSql = "(SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id)"

/**
 * The credit notes that could settle this invoice's shortage: every CREDIT NOTE
 * voucher in the invoice's book crediting the customer's ledger, newest first,
 * the ones naming this invoice (Agst Ref or narration) marked. Each says what
 * it is already linked to.
 */
export async function shortageNoteCandidates(saleId: number): Promise<Row> {
  await ensure()
  const c = getClient()
  const inv = await invoiceOf(saleId)
  const acc = await customerLedgerOf(inv)
  const linked = (
    await c.execute({ sql: 'SELECT entry_id, amount FROM sale_shortage_notes WHERE company_id = ? AND invoice_key = ?', args: [n(inv.company_id), inv.key] })
  ).rows as unknown as Row[]
  if (!acc) return { invoice_no: inv.invoice_no, notes: [], linked }
  const rows = (
    await c.execute({
      sql: `SELECT je.id AS entry_id, je.entry_date, je.vch_no, je.narration, ${codeSql} AS code,
                   (SELECT SUM(jl.cr) FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = ?) AS amount,
                   (SELECT GROUP_CONCAT(ba.ref_name, ', ') FROM journal_bill_allocs ba JOIN journal_lines jl2 ON jl2.id = ba.line_id
                     WHERE jl2.entry_id = je.id AND ba.ref_name IS NOT NULL) AS refs,
                   (SELECT GROUP_CONCAT(t.invoice_key, ', ') FROM sale_shortage_notes t WHERE t.entry_id = je.id AND t.company_id = je.company_id) AS linked_to
              FROM journal_entries je
             WHERE je.company_id = ? AND UPPER(je.vch_type) LIKE 'CREDIT NOTE%'
               AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = ? AND jl.cr > 0)
             ORDER BY je.entry_date DESC, je.id DESC`,
      args: [acc, n(inv.company_id), acc]
    })
  ).rows as unknown as Row[]
  const no = String(inv.invoice_no || '').toUpperCase()
  const linkedIds = new Set(linked.map((l) => n(l.entry_id)))
  const notes = rows
    .map((r) => ({
      ...r,
      amount: round2(n(r.amount)),
      names_invoice: !!no && (String(r.refs || '').toUpperCase().includes(no) || String(r.narration || '').toUpperCase().includes(no))
    }))
    // A note set Agst Ref ANOTHER invoice settles that one, not this — left out.
    // Kept: notes naming this invoice, notes with no bill reference, and any
    // already linked here.
    .filter((r: Row) => r.names_invoice || !String(r.refs || '').trim() || linkedIds.has(n(r.entry_id)))
  notes.sort((a, b) => Number(b.names_invoice) - Number(a.names_invoice))
  // The sale account the invoice credited — where a shortage credit note goes
  // back to, as the ones booked in Tally do (RPO SALE A/C and the like).
  const ids = inv.invoice_group
    ? (await c.execute({ sql: 'SELECT id FROM sales WHERE invoice_group = ?', args: [String(inv.invoice_group)] })).rows.map((r) => n((r as unknown as Row).id))
    : [n(inv.id)]
  const sa = (
    await c.execute({
      sql: `SELECT a.name FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN ledger_accounts a ON a.id = jl.account_id
             WHERE je.sale_id IN (${ids.map(() => '?').join(',')}) AND jl.cr > 0 AND a.acc_group = 'Sales Accounts' ORDER BY jl.cr DESC LIMIT 1`,
      args: ids
    })
  ).rows[0] as unknown as Row | undefined
  // THE TRANSPORTER'S SIDE OF THE SAME SHORTAGE — the 'shortage_penalty' line
  // the unload wrote (sales.ts postSaleShortageDebit), with where it stands:
  // a debit note raised, netted into a booked bill, written off, or open.
  const transporter_lines = (
    await c.execute({
      sql: `SELECT tl.id, tl.amount, tl.note, tl.entry_date, tl.note_id, tl.bill_id, tl.waived_at, tl.company_id,
                   t.name AS transporter, COALESCE(t.gst_registration, 'registered') AS gst_registration,
                   (SELECT nt.note_no FROM notes nt WHERE nt.id = tl.note_id) AS note_no
              FROM transporter_ledger tl LEFT JOIN transporters t ON t.id = tl.transporter_id
             WHERE tl.entry_type = 'shortage_penalty' AND tl.sale_id IN (${ids.map(() => '?').join(',')})
             ORDER BY tl.id`,
      args: ids
    })
  ).rows as unknown as Row[]
  return { invoice_no: inv.invoice_no, invoice_key: inv.key, notes, linked, sale_account: sa ? String(sa.name) : '', transporter_lines }
}

/** Link these credit notes to the invoice's shortage (replacing the ones linked before). */
export async function setShortageNotes(saleId: number, entryIds: number[]): Promise<{ linked: number }> {
  await ensure()
  const c = getClient()
  const inv = await invoiceOf(saleId)
  const cand = await shortageNoteCandidates(saleId)
  const allowed = new Map((cand.notes as Row[]).map((x) => [n(x.entry_id), n(x.amount)]))
  const ids = [...new Set(entryIds.map(n).filter((x) => x > 0))]
  for (const id of ids) if (!allowed.has(id)) throw new Error('That is not a credit note to this customer in this book')
  await c.execute({ sql: 'DELETE FROM sale_shortage_notes WHERE company_id = ? AND invoice_key = ?', args: [n(inv.company_id), inv.key] })
  for (const id of ids) {
    await c.execute({
      sql: 'INSERT INTO sale_shortage_notes (company_id, invoice_key, entry_id, amount) VALUES (?, ?, ?, ?)',
      args: [n(inv.company_id), inv.key, id, allowed.get(id) || 0]
    })
  }
  return { linked: ids.length }
}

/** Every linked note, for the Sales list: company|invoice_key → notes. */
export async function shortageNoteMap(): Promise<Row[]> {
  await ensure()
  const res = await getClient().execute(`
    SELECT t.company_id, t.invoice_key, t.entry_id, t.amount, je.entry_date, je.vch_no, ${codeSql} AS code
      FROM sale_shortage_notes t JOIN journal_entries je ON je.id = t.entry_id
     ORDER BY je.entry_date`)
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}
