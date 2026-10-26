import { getClient } from './db'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// WHAT THE DESK HAS ALREADY DECIDED ABOUT A TALLY FILE, kept so it is not
// asked again.
//
//   LINKS — "this Tally voucher IS that voucher here". A possible match the
//   user has looked at and said is the same entry is remembered by Tally's own
//   key (its voucher type and number) for its register or bank, and the next
//   check of any file pairs the two straight away, as Matched.
//
//   BATCHES — every booking from a Tally file is one batch: which vouchers it
//   made, from which file, by whom, when. A file that turns out to be wrong
//   is taken back as a batch — those vouchers and nothing else.
// ---------------------------------------------------------------------------

let ready = false
async function ensureTables(): Promise<void> {
  if (ready) return
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS tally_links (
    company_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    tally_key TEXT NOT NULL,
    entry_id INTEGER NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, scope, tally_key)
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS tally_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT,
    file_name TEXT,
    entry_ids TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    undone_at TEXT,
    undone_by TEXT
  )`)
  // CHECKED: lines the desk has looked at and says are fine as they stand —
  // out of "To look at", kept under Checked. Keyed like tally_links.
  await c.execute(`CREATE TABLE IF NOT EXISTS tally_checked (
    company_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    row_key TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (company_id, scope, row_key)
  )`)
  ready = true
}

export async function checkedFor(companyId: number, scope: string): Promise<Set<string>> {
  await ensureTables()
  const r = await getClient().execute({ sql: 'SELECT row_key FROM tally_checked WHERE company_id = ? AND scope = ?', args: [companyId, scope] })
  return new Set(r.rows.map((x) => String(x.row_key)))
}

/** Mark a line checked (on) or take the mark off. */
export async function setTallyChecked(v: { company_id: number; scope: string; row_key: string; on: boolean }): Promise<{ ok: true }> {
  await ensureTables()
  if (!Number(v.company_id) || !String(v.scope || '').trim() || !String(v.row_key || '').trim()) throw new Error('Nothing to mark')
  if (v.on)
    await getClient().execute({
      sql: 'INSERT OR REPLACE INTO tally_checked (company_id, scope, row_key, created_by) VALUES (?, ?, ?, ?)',
      args: [Number(v.company_id), v.scope, v.row_key, who()]
    })
  else await getClient().execute({ sql: 'DELETE FROM tally_checked WHERE company_id = ? AND scope = ? AND row_key = ?', args: [Number(v.company_id), v.scope, v.row_key] })
  return { ok: true }
}

const who = (): string => String(getCurrentUser().username || '').trim() || 'local'

/** Tally key → voucher here, for one register or bank. Only links whose voucher still exists. */
export async function linksFor(companyId: number, scope: string): Promise<Map<string, number>> {
  await ensureTables()
  const r = await getClient().execute({
    sql: `SELECT l.tally_key, l.entry_id FROM tally_links l JOIN journal_entries je ON je.id = l.entry_id
           WHERE l.company_id = ? AND l.scope = ?`,
    args: [companyId, scope]
  })
  return new Map(r.rows.map((x) => [String(x.tally_key), Number(x.entry_id)]))
}

export async function saveTallyLink(v: { company_id: number; scope: string; tally_key: string; entry_id: number; also?: boolean }): Promise<{ ok: true }> {
  await ensureTables()
  const c = getClient()
  const e = await c.execute({ sql: 'SELECT company_id FROM journal_entries WHERE id = ?', args: [Number(v.entry_id) || 0] })
  if (!e.rows.length) throw new Error('That voucher no longer exists — check the file again')
  if (Number(e.rows[0].company_id) !== Number(v.company_id)) throw new Error('That voucher belongs to another company')
  if (!String(v.scope || '').trim() || !String(v.tally_key || '').trim()) throw new Error('Nothing to link')
  // One voucher here answers for one Tally voucher in a register — unless the
  // caller says this line is ALSO it (Tally's payment into a parking ledger
  // and the refund back, both standing for one LC voucher here).
  if (!v.also) await c.execute({ sql: 'DELETE FROM tally_links WHERE company_id = ? AND scope = ? AND entry_id = ?', args: [v.company_id, v.scope, v.entry_id] })
  await c.execute({
    sql: `INSERT INTO tally_links (company_id, scope, tally_key, entry_id, created_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(company_id, scope, tally_key) DO UPDATE SET entry_id = excluded.entry_id, created_by = excluded.created_by, created_at = datetime('now')`,
    args: [v.company_id, v.scope, v.tally_key, v.entry_id, who()]
  })
  return { ok: true }
}

export async function removeTallyLink(v: { company_id: number; scope: string; tally_key: string }): Promise<{ ok: true }> {
  await ensureTables()
  await getClient().execute({ sql: 'DELETE FROM tally_links WHERE company_id = ? AND scope = ? AND tally_key = ?', args: [v.company_id, v.scope, v.tally_key] })
  return { ok: true }
}

/** Remember a booking from a Tally file as one batch. */
export async function recordTallyBatch(v: { company_id: number; kind: string; scope?: string; file_name?: string; entry_ids: number[] }): Promise<void> {
  if (!v.entry_ids.length) return
  await ensureTables()
  await getClient().execute({
    sql: 'INSERT INTO tally_import_batches (company_id, kind, scope, file_name, entry_ids, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [v.company_id, v.kind, v.scope || null, v.file_name || null, JSON.stringify(v.entry_ids), who()]
  })
}

/** The bookings made from Tally files — newest first, with how many of their vouchers are still here. */
export async function listTallyBatches(v: { company_id: number; kind?: string; scope?: string }): Promise<Row[]> {
  await ensureTables()
  const c = getClient()
  const where = ['company_id = ?']
  const args: (string | number)[] = [v.company_id]
  if (v.kind) {
    where.push('kind = ?')
    args.push(v.kind)
  }
  if (v.scope) {
    where.push('scope = ?')
    args.push(v.scope)
  }
  const rows = (await c.execute({ sql: `SELECT * FROM tally_import_batches WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 30`, args })).rows as unknown as Row[]
  const out: Row[] = []
  for (const r of rows) {
    let ids: number[] = []
    try {
      ids = (JSON.parse(String(r.entry_ids || '[]')) as unknown[]).map(Number).filter(Boolean)
    } catch {
      ids = []
    }
    const live = ids.length
      ? Number(
          (await c.execute({ sql: `SELECT COUNT(*) AS n FROM journal_entries WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids })).rows[0]?.n || 0
        )
      : 0
    const amt = ids.length
      ? Number(
          (await c.execute({ sql: `SELECT COALESCE(SUM(dr), 0) AS v FROM journal_lines WHERE entry_id IN (${ids.map(() => '?').join(',')})`, args: ids })).rows[0]?.v || 0
        )
      : 0
    out.push({
      id: Number(r.id),
      kind: String(r.kind),
      scope: r.scope ? String(r.scope) : null,
      file_name: String(r.file_name || ''),
      created_by: String(r.created_by || ''),
      created_at: String(r.created_at || ''),
      undone_at: r.undone_at ? String(r.undone_at) : null,
      undone_by: r.undone_by ? String(r.undone_by) : null,
      count: ids.length,
      live,
      amount: Math.round(amt * 100) / 100
    })
  }
  return out
}

/**
 * Take a booking back: every voucher it made that is still here and still
 * reads as booked from Tally. One that a receipt or payment has since been set
 * against (Agst Ref to its number) is kept, and said so — removing it would
 * leave that settlement pointing at nothing.
 */
export async function undoTallyBatch(v: { id: number; company_id: number }): Promise<{ removed: number; kept: { id: number; reason: string }[] }> {
  await ensureTables()
  const c = getClient()
  const b = (await c.execute({ sql: 'SELECT * FROM tally_import_batches WHERE id = ? AND company_id = ?', args: [Number(v.id) || 0, v.company_id] })).rows[0] as unknown as Row | undefined
  if (!b) throw new Error('That booking is not in this company')
  if (b.undone_at) throw new Error('That booking has already been taken back')
  let ids: number[] = []
  try {
    ids = (JSON.parse(String(b.entry_ids || '[]')) as unknown[]).map(Number).filter(Boolean)
  } catch {
    ids = []
  }
  const { deleteManualEntry } = await import('./journal')
  let removed = 0
  const kept: { id: number; reason: string }[] = []
  for (const id of ids) {
    const e = (await c.execute({ sql: 'SELECT id, vch_no, narration FROM journal_entries WHERE id = ?', args: [id] })).rows[0] as unknown as Row | undefined
    if (!e) continue
    if (!/^imported from tally/i.test(String(e.narration || ''))) {
      kept.push({ id, reason: 'it no longer reads as booked from Tally — it has been altered here' })
      continue
    }
    const vno = String(e.vch_no || '').trim()
    if (vno) {
      const settled = await c.execute({
        sql: `SELECT 1 FROM journal_bill_allocs a JOIN journal_lines l ON l.id = a.line_id
               WHERE a.method = 'agst_ref' AND UPPER(TRIM(a.ref_name)) = UPPER(?) AND l.entry_id <> ?
                 AND l.account_id IN (SELECT account_id FROM journal_lines WHERE entry_id = ?) LIMIT 1`,
        args: [vno, id, id]
      })
      if (settled.rows.length) {
        kept.push({ id, reason: `a receipt or payment has been set against ${vno}` })
        continue
      }
    }
    try {
      await deleteManualEntry(id)
      removed++
    } catch (err) {
      kept.push({ id, reason: (err as Error).message })
    }
  }
  if (!kept.length) {
    await c.execute({ sql: "UPDATE tally_import_batches SET undone_at = datetime('now'), undone_by = ? WHERE id = ?", args: [who(), Number(b.id)] })
  }
  return { removed, kept }
}
