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
export async function ensure(): Promise<void> {
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
  // A link to a voucher since deleted is left out (and cleared on the next save).
  const linked = (
    await c.execute({
      sql: `SELECT t.entry_id, t.amount FROM sale_shortage_notes t
             WHERE t.company_id = ? AND t.invoice_key = ? AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = t.entry_id)`,
      args: [n(inv.company_id), inv.key]
    })
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
  // A voucher deleted since it was linked is simply dropped — it must not block
  // linking the notes that do exist (it made a new credit note fail to link).
  const exists = async (id: number): Promise<boolean> =>
    (await c.execute({ sql: 'SELECT 1 FROM journal_entries WHERE id = ?', args: [id] })).rows.length > 0
  const ids: number[] = []
  for (const id of [...new Set(entryIds.map(n).filter((x) => x > 0))]) {
    if (allowed.has(id)) ids.push(id)
    else if (await exists(id)) throw new Error('That is not a credit note to this customer in this book')
  }
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

/**
 * ONE-TIME CLEAN-UP (asked for on 2026-11-21). A shortage link left pointing at
 * a deleted voucher made "Create & link" post the credit note, fail the link,
 * and post another on every retry (KRFIN/105 got CN/48–54, KRFIN/137 CN/45–46).
 *   1. Links to deleted vouchers are cleared (their amounts are kept to re-link by).
 *   2. Copies are removed: app-made notes (a notes row) with the same company,
 *      date, narration "Shortage on …", party and amount — the first is kept,
 *      each copy archived in accounting_repair_log, then deleted as the note
 *      register deletes (voucher, party-ledger row, note).
 *   3. An invoice left with no link is linked when exactly one credit note
 *      Agst Ref it fits: the one at the old link's amount, else the one app-made
 *      "Shortage on <invoice>" note. Anything else (e.g. two notes of the same
 *      amount) is left for a person and logged.
 */
export async function repairShortageNoteDupes(): Promise<{ cleared: number; removed: string[]; linked: string[]; left: string[] }> {
  await ensure()
  const c = getClient()
  const out = { cleared: 0, removed: [] as string[], linked: [] as string[], left: [] as string[] }
  const code = async (id: number): Promise<string> =>
    String((await c.execute({ sql: "SELECT prefix || '/' || serial AS k FROM voucher_numbers WHERE entry_id = ?", args: [id] })).rows[0]?.k || `#${id}`)

  // 1. Dead links.
  const stale = (
    await c.execute(`SELECT company_id, invoice_key, entry_id, amount FROM sale_shortage_notes t
                      WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = t.entry_id)`)
  ).rows as unknown as Row[]
  const oldAmt = new Map<string, number[]>()
  for (const s of stale) {
    const k = `${n(s.company_id)}|${String(s.invoice_key)}`
    oldAmt.set(k, [...(oldAmt.get(k) || []), n(s.amount)])
  }
  await c.execute('DELETE FROM sale_shortage_notes WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = sale_shortage_notes.entry_id)')
  out.cleared = stale.length

  // 2. Copies of an app-made shortage credit note.
  await c.execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  const made = (
    await c.execute(`SELECT nt.id AS note_id, nt.company_id, nt.party_id, je.id AS entry_id, je.entry_date, je.narration,
                            (SELECT ROUND(SUM(jl.cr), 2) FROM journal_lines jl WHERE jl.entry_id = je.id) AS amount
                       FROM notes nt JOIN journal_entries je ON je.id = nt.journal_entry_id
                      WHERE nt.note_type = 'credit' AND UPPER(je.vch_type) LIKE 'CREDIT NOTE%' AND je.narration LIKE 'Shortage on %'
                      ORDER BY je.id`)
  ).rows as unknown as Row[]
  const seen = new Map<string, Row>()
  const { deleteNote } = await import('./notes')
  for (const r of made) {
    const k = [n(r.company_id), n(r.party_id), String(r.entry_date), String(r.narration), round2(n(r.amount))].join('|')
    if (!seen.has(k)) {
      seen.set(k, r)
      continue
    }
    const eid = n(r.entry_id)
    if ((await c.execute({ sql: 'SELECT 1 FROM sale_shortage_notes WHERE entry_id = ?', args: [eid] })).rows.length) continue
    const k2 = await code(eid)
    const before = {
      entry: (await c.execute({ sql: 'SELECT * FROM journal_entries WHERE id = ?', args: [eid] })).rows[0],
      lines: (await c.execute({ sql: 'SELECT * FROM journal_lines WHERE entry_id = ?', args: [eid] })).rows,
      allocs: (await c.execute({ sql: 'SELECT ba.* FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id WHERE jl.entry_id = ?', args: [eid] })).rows,
      note: (await c.execute({ sql: 'SELECT * FROM notes WHERE id = ?', args: [n(r.note_id)] })).rows[0],
      code: k2,
      copy_of: await code(n(seen.get(k)!.entry_id))
    }
    await c.execute({
      sql: 'INSERT OR REPLACE INTO accounting_repair_log(repair_key, entry_id, before_json) VALUES (?, ?, ?)',
      args: [`shortage_cn_copy_v1:${eid}`, eid, JSON.stringify(before)]
    })
    await deleteNote(n(r.note_id), n(r.company_id))
    out.removed.push(`${k2} (copy of ${before.copy_of})`)
  }

  // 3. Re-link the invoices that lost their link, and those with a surviving shortage note unlinked.
  const keys = new Set<string>(oldAmt.keys())
  for (const r of seen.values()) {
    const m = String(r.narration).match(/^Shortage on (\S+)/)
    if (!m) continue
    const s = (await c.execute({ sql: 'SELECT id, invoice_group, invoice_no FROM sales WHERE company_id = ? AND invoice_no = ? ORDER BY id LIMIT 1', args: [n(r.company_id), m[1]] })).rows[0] as unknown as Row | undefined
    if (s) keys.add(`${n(r.company_id)}|${String(s.invoice_group || s.invoice_no || `sale-${s.id}`)}`)
  }
  for (const k of keys) {
    const co = n(k.split('|')[0])
    const key = k.slice(k.indexOf('|') + 1)
    if ((await c.execute({ sql: 'SELECT 1 FROM sale_shortage_notes WHERE company_id = ? AND invoice_key = ?', args: [co, key] })).rows.length) continue
    const sale = (
      await c.execute({ sql: "SELECT id, invoice_no FROM sales WHERE company_id = ? AND COALESCE(invoice_group, invoice_no, 'sale-' || id) = ? ORDER BY id LIMIT 1", args: [co, key] })
    ).rows[0] as unknown as Row | undefined
    if (!sale) continue
    const no = String(sale.invoice_no || '')
    const cand = ((await shortageNoteCandidates(n(sale.id))).notes as Row[]).filter((x) => x.names_invoice && !String(x.linked_to || '').trim())
    const olds = oldAmt.get(k) || []
    let pick = cand.filter((x) => olds.some((a) => Math.abs(n(x.amount) - a) < 0.01))
    if (pick.length !== 1) pick = cand.filter((x) => String(x.narration || '').startsWith(`Shortage on ${no} `))
    if (pick.length !== 1) {
      if (cand.length || olds.length) out.left.push(`${no}: ${cand.length ? cand.map((x) => `${x.code || x.vch_no} ${x.amount}`).join(', ') : 'no credit note against it'}`)
      continue
    }
    await setShortageNotes(n(sale.id), [n(pick[0].entry_id)])
    out.linked.push(`${no} -> ${pick[0].code || pick[0].vch_no}`)
  }
  return out
}
