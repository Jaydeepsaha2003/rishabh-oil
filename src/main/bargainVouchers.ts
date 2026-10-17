import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { getCurrentUser } from './currentUser'
import { recordChanges, type FieldSpec } from './history'
import { ensureVoucherNumbers } from './voucherNumbers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// VOUCHERS LINKED TO A BARGAIN, BY HAND.
//
// A bargain's own invoices find it on their own — each purchase or sale names
// the bargain it draws on. Everything else that belongs to the deal does not:
// the advance paid against it, the receipt that came in before the goods, a
// journal settling a rate difference, a debit note for short delivery. Those
// are vouchers like any other, and nothing in them says which bargain they
// were for. This is where somebody says so.
//
// A link is a reference and nothing more. It moves no figure: the voucher
// stays exactly as it was posted, and the bargain's quantity and balance are
// untouched. Removing a link removes the reference, never the voucher.
//
// The table is made on first use, like voucher_numbers, so nothing runs at
// startup and no existing table is touched.

export type BargainKind = 'purchase' | 'sales'

// The bargain's own table — also the name its history is kept under.
const TABLE: Record<BargainKind, string> = { purchase: 'bargains', sales: 'sales_bargains' }

const LINK_FIELDS: FieldSpec[] = [{ key: 'voucher', label: 'Linked voucher', kind: 'text' }]

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function kindOf(v: unknown): BargainKind {
  if (v === 'purchase' || v === 'sales') return v
  throw new Error('Unknown bargain kind')
}

let tableReady = false
async function ensureTable(): Promise<void> {
  if (tableReady) return
  const c = getClient()
  // The snap_ columns keep what the voucher was when it was linked, so a
  // voucher deleted afterwards still reads as something rather than a bare id.
  await c.execute(`CREATE TABLE IF NOT EXISTS bargain_voucher_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bargain_kind TEXT NOT NULL,
      bargain_id INTEGER NOT NULL,
      entry_id INTEGER NOT NULL,
      note TEXT,
      snap_code TEXT,
      snap_type TEXT,
      snap_date TEXT,
      snap_amount REAL,
      created_by INTEGER,
      created_by_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (bargain_kind, bargain_id, entry_id))`)
  await c.execute(
    'CREATE INDEX IF NOT EXISTS idx_bargain_voucher_links_bargain ON bargain_voucher_links (bargain_kind, bargain_id)'
  )
  await c.execute('CREATE INDEX IF NOT EXISTS idx_bargain_voucher_links_entry ON bargain_voucher_links (entry_id)')
  tableReady = true
}

// The bargain, as much of it as a link needs: its number for the history, its
// company for the vouchers it may be linked to, and its party so the picker
// can put that party's vouchers first.
async function bargainHead(kind: BargainKind, id: number): Promise<Row> {
  const sql =
    kind === 'purchase'
      ? `SELECT b.id, b.bargain_no, b.bargain_date, b.company_id, s.name AS party
           FROM bargains b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ?`
      : `SELECT sb.id, sb.bargain_no, sb.manual_bargain_no, sb.bargain_date, sb.company_id,
                COALESCE(cu.name, sb.customer) AS party
           FROM sales_bargains sb LEFT JOIN customers cu ON cu.id = sb.customer_id WHERE sb.id = ?`
  const res = await getClient().execute({ sql, args: [id] })
  if (!res.rows.length) throw new Error('That bargain no longer exists — reload the register')
  const r = toPlain(res)[0]
  r.company_id = n(r.company_id) || 1
  return r
}

// What a voucher is, in the columns both the list and the picker show. Kept in
// one place so the two can never describe the same voucher differently.
const VOUCHER_COLS = `je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, je.company_id,
  (SELECT n.prefix || '/' || n.serial FROM voucher_numbers n WHERE n.entry_id = je.id) AS code,
  (SELECT SUM(jl.dr) FROM journal_lines jl WHERE jl.entry_id = je.id) AS amount,
  (SELECT GROUP_CONCAT(nm, ', ') FROM (SELECT a.name AS nm FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
    WHERE jl.entry_id = je.id AND jl.dr > 0 ORDER BY jl.dr DESC, jl.id)) AS dr_accounts,
  (SELECT GROUP_CONCAT(nm, ', ') FROM (SELECT a.name AS nm FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
    WHERE jl.entry_id = je.id AND jl.cr > 0 ORDER BY jl.cr DESC, jl.id)) AS cr_accounts`

// How a link reads in the bargain's history: "PAY/12 · PAYMENT · 12-07-2026".
function linkLabel(v: Row): string {
  const d = String(v.entry_date || '').slice(0, 10)
  const shown = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('-') : d
  return [v.code || (v.vch_no ? `#${v.vch_no}` : `voucher ${v.id}`), v.vch_type, shown].filter(Boolean).join(' · ')
}

/** Every voucher linked to one bargain, oldest first. A voucher deleted since
 * it was linked comes back with `missing` set and its snapshot filled in. */
export async function linkedVouchers(kindIn: unknown, bargainId: number): Promise<Row[]> {
  const kind = kindOf(kindIn)
  await ensureTable()
  await ensureVoucherNumbers()
  const res = await getClient().execute({
    sql: `SELECT l.id AS link_id, l.entry_id, l.note, l.created_at, l.created_by_name,
                 l.snap_code, l.snap_type, l.snap_date, l.snap_amount,
                 ${VOUCHER_COLS}
            FROM bargain_voucher_links l LEFT JOIN journal_entries je ON je.id = l.entry_id
           WHERE l.bargain_kind = ? AND l.bargain_id = ?
           ORDER BY COALESCE(je.entry_date, l.snap_date), l.id`,
    args: [kind, Number(bargainId)]
  })
  return toPlain(res).map((r) => {
    const missing = r.id == null
    return {
      ...r,
      missing,
      id: n(r.entry_id),
      code: missing ? r.snap_code : r.code,
      vch_type: missing ? r.snap_type : r.vch_type,
      entry_date: missing ? r.snap_date : r.entry_date,
      amount: missing ? n(r.snap_amount) : n(r.amount)
    }
  })
}

/** What the link picker offers for one bargain: the voucher types its
 * company's books hold (with how many of each), and — once a type is chosen —
 * that type's vouchers, newest first, each marked if it is already linked. */
export async function voucherChoices(kindIn: unknown, bargainId: number, vchType?: string): Promise<Row> {
  const kind = kindOf(kindIn)
  await ensureTable()
  await ensureVoucherNumbers()
  const head = await bargainHead(kind, Number(bargainId))
  const c = getClient()
  const types = toPlain(
    await c.execute({
      sql: `SELECT vch_type, COUNT(*) AS count FROM journal_entries
             WHERE company_id = ? AND vch_type IS NOT NULL AND TRIM(vch_type) <> ''
             GROUP BY vch_type ORDER BY COUNT(*) DESC, vch_type`,
      args: [head.company_id]
    })
  )
  let vouchers: Row[] = []
  const t = String(vchType || '').trim()
  if (t) {
    vouchers = toPlain(
      await c.execute({
        sql: `SELECT ${VOUCHER_COLS},
                     EXISTS (SELECT 1 FROM bargain_voucher_links l
                              WHERE l.entry_id = je.id AND l.bargain_kind = ? AND l.bargain_id = ?) AS linked
                FROM journal_entries je
               WHERE je.company_id = ? AND je.vch_type = ?
               ORDER BY je.entry_date DESC, je.id DESC
               LIMIT 3000`,
        args: [kind, head.id, head.company_id, t]
      })
    ).map((v) => ({ ...v, amount: n(v.amount), linked: !!n(v.linked) }))
  }
  return { bargain: head, types, vouchers }
}

/** Link one voucher to a bargain. It must be in the bargain's own books, and
 * a voucher is linked to a bargain once. */
export async function linkVoucher(kindIn: unknown, bargainId: number, entryId: number, note?: string): Promise<Row> {
  const kind = kindOf(kindIn)
  await ensureTable()
  await ensureVoucherNumbers()
  const head = await bargainHead(kind, Number(bargainId))
  const c = getClient()
  const vr = await c.execute({ sql: `SELECT ${VOUCHER_COLS} FROM journal_entries je WHERE je.id = ?`, args: [Number(entryId)] })
  if (!vr.rows.length) throw new Error('That voucher no longer exists — pick it again')
  const v = toPlain(vr)[0]
  if (n(v.company_id) !== head.company_id) {
    throw new Error(`${linkLabel(v)} is in another company's books — a bargain can only be linked to its own company's vouchers`)
  }
  const dup = await c.execute({
    sql: 'SELECT 1 FROM bargain_voucher_links WHERE bargain_kind = ? AND bargain_id = ? AND entry_id = ?',
    args: [kind, head.id, n(v.id)]
  })
  if (dup.rows.length) throw new Error(`${linkLabel(v)} is already linked to this bargain`)
  const u = getCurrentUser()
  const ins = await c.execute({
    sql: `INSERT INTO bargain_voucher_links
            (bargain_kind, bargain_id, entry_id, note, snap_code, snap_type, snap_date, snap_amount, created_by, created_by_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      kind,
      head.id,
      n(v.id),
      String(note || '').trim() || null,
      v.code ? String(v.code) : null,
      v.vch_type ? String(v.vch_type) : null,
      v.entry_date ? String(v.entry_date) : null,
      n(v.amount),
      u.id,
      u.username || null
    ]
  })
  await recordChanges(TABLE[kind], head.id, String(head.bargain_no || ''), { voucher: '' }, { voucher: linkLabel(v) }, LINK_FIELDS)
  return { id: Number(ins.lastInsertRowid) }
}

/** Remove one link. The voucher itself is left exactly as it was. */
export async function unlinkVoucher(kindIn: unknown, bargainId: number, linkId: number): Promise<Row> {
  const kind = kindOf(kindIn)
  await ensureTable()
  const c = getClient()
  const res = await c.execute({
    sql: `SELECT l.id, l.entry_id, l.snap_code, l.snap_type, l.snap_date,
                 (SELECT n.prefix || '/' || n.serial FROM voucher_numbers n WHERE n.entry_id = l.entry_id) AS code,
                 je.vch_type, je.vch_no, je.entry_date
            FROM bargain_voucher_links l LEFT JOIN journal_entries je ON je.id = l.entry_id
           WHERE l.id = ? AND l.bargain_kind = ? AND l.bargain_id = ?`,
    args: [Number(linkId), kind, Number(bargainId)]
  })
  if (!res.rows.length) return { id: Number(linkId) }
  const l = toPlain(res)[0]
  await c.execute({ sql: 'DELETE FROM bargain_voucher_links WHERE id = ?', args: [Number(linkId)] })
  const head = await bargainHead(kind, Number(bargainId)).catch(() => null)
  if (head) {
    const label = linkLabel({
      id: l.entry_id,
      code: l.code || l.snap_code,
      vch_no: l.vch_no,
      vch_type: l.vch_type || l.snap_type,
      entry_date: l.entry_date || l.snap_date
    })
    await recordChanges(TABLE[kind], head.id, String(head.bargain_no || ''), { voucher: label }, { voucher: '' }, LINK_FIELDS)
  }
  return { id: Number(linkId) }
}
