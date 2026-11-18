import type { ResultSet } from '@libsql/client'
import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { withDbTransaction } from './dbTransaction'

// ---------------------------------------------------------------------------
// FIXED DEPOSITS, and the LCs they secure.
//
// An LC asks for an FD as security; tracking afterwards whether that FD is
// still held, matured, or free again was the hard part. Here an FD is its own
// record (bank, number, amount, term, rate), and a LIEN marks part or all of
// it against one LC. Free = amount − liens still in force.
//
// A lien is in force until it is released by hand, or its LC is finished —
// repaid or preclosed (preclosed_date) or rejected. That is read live off the
// LC, never stored, so a lien cannot be left frozen by an LC closed elsewhere.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100
const iso = (v: unknown): string => String(v || '').slice(0, 10)
const daysBetween = (a: string, b: string): number => Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000)

let ready = false
// The table was made long ago and never used; its new columns and the lien
// table are added here, once per start, without touching a row.
async function ensureFd(): Promise<void> {
  if (ready) return
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS fixed_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL DEFAULT 1,
    fd_no TEXT NOT NULL,
    bank TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    start_date TEXT,
    maturity_date TEXT,
    interest_pct REAL NOT NULL DEFAULT 0,
    lien_status TEXT NOT NULL DEFAULT 'free',
    facility_id INTEGER,
    lc_id INTEGER,
    note TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const have = new Set(toPlain(await c.execute('PRAGMA table_info(fixed_deposits)')).map((r) => String(r.name)))
  for (const [col, type] of [
    ['bank_kind', 'TEXT'], // 'own' or 'lc' — which list the bank came from
    ['interest_payout', 'TEXT'], // 'cumulative' (default) or 'payout'
    ['maturity_amount', 'REAL'], // the bank's own figure, when keyed
    ['closed_date', 'TEXT'],
    ['closed_amount', 'REAL']
  ]) {
    if (!have.has(col)) await c.execute(`ALTER TABLE fixed_deposits ADD COLUMN ${col} ${type}`)
  }
  await c.execute(`CREATE TABLE IF NOT EXISTS fd_liens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fd_id INTEGER NOT NULL,
    lc_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    marked_date TEXT,
    released_date TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  await c.execute('CREATE INDEX IF NOT EXISTS idx_fd_liens_fd ON fd_liens(fd_id)')
  await c.execute('CREATE INDEX IF NOT EXISTS idx_fd_liens_lc ON fd_liens(lc_id)')
  ready = true
}

/** What the FD comes to at maturity: the bank's figure if keyed, else worked out (quarterly compounding, or the principal back when interest is paid out). */
function maturityValue(fd: Row): number {
  if (n(fd.maturity_amount) > 0) return round2(n(fd.maturity_amount))
  const p = n(fd.amount)
  const s = iso(fd.start_date)
  const m = iso(fd.maturity_date)
  if (!s || !m || m <= s || String(fd.interest_payout || 'cumulative') === 'payout') return round2(p)
  const quarters = daysBetween(s, m) / (365 / 4)
  return round2(p * Math.pow(1 + n(fd.interest_pct) / 400, quarters))
}

/** Interest run up to today (same basis), for an FD still held. */
function accruedToday(fd: Row): number {
  const s = iso(fd.start_date)
  const m = iso(fd.maturity_date)
  const today = todayISO()
  if (!s || today <= s) return 0
  const end = m && m < today ? m : today
  const p = n(fd.amount)
  if (String(fd.interest_payout || 'cumulative') === 'payout') return round2((p * n(fd.interest_pct) * daysBetween(s, end)) / 36500)
  return round2(p * Math.pow(1 + n(fd.interest_pct) / 400, daysBetween(s, end) / (365 / 4)) - p)
}

// A lien is in force until released by hand or its LC is finished.
function lienState(l: Row): { active: boolean; released_on: string | null; why: string } {
  if (l.released_date) return { active: false, released_on: iso(l.released_date), why: 'released' }
  if (String(l.lc_workflow || '') === 'rejected') return { active: false, released_on: null, why: 'LC rejected' }
  if (l.lc_closed) return { active: false, released_on: iso(l.lc_closed), why: 'LC closed' }
  return { active: true, released_on: null, why: '' }
}

const LIEN_SQL = `SELECT f.*, l.lc_no, l.bank AS lc_bank, l.amount AS lc_amount, l.expiry_date AS lc_maturity,
                         l.preclosed_date AS lc_closed, l.workflow_status AS lc_workflow
                    FROM fd_liens f LEFT JOIN letters_of_credit l ON l.id = f.lc_id`

/** Every FD of the company, with its liens and where it stands today. */
export async function listFds(): Promise<Row[]> {
  await ensureFd()
  const c = getClient()
  const cid = getActiveCompanyId()
  const fds = toPlain(await c.execute({ sql: 'SELECT * FROM fixed_deposits WHERE company_id = ? AND active = 1 ORDER BY COALESCE(maturity_date, start_date), id', args: [cid] }))
  const liens = toPlain(await c.execute({ sql: `${LIEN_SQL} WHERE f.fd_id IN (SELECT id FROM fixed_deposits WHERE company_id = ?) ORDER BY f.marked_date, f.id`, args: [cid] }))
  const today = todayISO()
  return fds.map((fd) => {
    const mine = liens
      .filter((l) => n(l.fd_id) === n(fd.id))
      .map((l) => ({ ...l, ...lienState(l), amount: n(l.amount) }))
    const held = round2(mine.filter((l) => l.active).reduce((t, l) => t + l.amount, 0))
    const m = iso(fd.maturity_date)
    const left = m ? daysBetween(today, m) : null
    const status = fd.closed_date ? 'closed' : left != null && left < 0 ? 'matured' : left != null && left <= 30 ? 'maturing' : 'active'
    return {
      ...fd,
      liens: mine,
      lien_amount: held,
      free_amount: round2(Math.max(0, n(fd.amount) - held)),
      lien_lcs: mine.filter((l) => l.active).length,
      days_left: left,
      status,
      maturity_value: maturityValue(fd),
      accrued: fd.closed_date ? 0 : accruedToday(fd)
    }
  })
}

/** Add or change an FD. The number is unique within the company. */
export async function saveFd(v: Row): Promise<{ id: number }> {
  await ensureFd()
  const c = getClient()
  const cid = getActiveCompanyId()
  const id = n(v.id)
  const fdNo = String(v.fd_no || '').trim()
  const bank = String(v.bank || '').trim()
  const amount = round2(n(v.amount))
  const start = iso(v.start_date)
  const maturity = iso(v.maturity_date)
  if (!fdNo) throw new Error('FD No is required')
  if (!bank) throw new Error('Pick the bank the FD is with')
  if (!(amount > 0)) throw new Error('Enter the FD amount')
  if (!start) throw new Error('Enter the date the FD was made')
  if (!maturity) throw new Error('Enter the maturity date')
  if (maturity <= start) throw new Error('Maturity must be after the start date')
  const dup = (await c.execute({ sql: 'SELECT id FROM fixed_deposits WHERE company_id = ? AND active = 1 AND UPPER(TRIM(fd_no)) = UPPER(?) AND id <> ?', args: [cid, fdNo, id] })).rows[0]
  if (dup) throw new Error(`FD ${fdNo} is already recorded`)
  if (id) {
    // Never below what is already held against LCs.
    const fd = (await listFds()).find((x) => n(x.id) === id)
    if (!fd) throw new Error('That FD no longer exists')
    if (amount < n(fd.lien_amount) - 0.004) throw new Error(`${fdNo} has Rs ${n(fd.lien_amount).toFixed(2)} under lien — the amount cannot go below that`)
  }
  const args = [
    fdNo,
    bank,
    v.bank_kind === 'lc' ? 'lc' : 'own',
    amount,
    start,
    maturity,
    round2(n(v.interest_pct)),
    v.interest_payout === 'payout' ? 'payout' : 'cumulative',
    n(v.maturity_amount) > 0 ? round2(n(v.maturity_amount)) : null,
    v.note ? String(v.note).trim() : null
  ]
  if (id) {
    await c.execute({
      sql: `UPDATE fixed_deposits SET fd_no = ?, bank = ?, bank_kind = ?, amount = ?, start_date = ?, maturity_date = ?, interest_pct = ?,
                   interest_payout = ?, maturity_amount = ?, note = ? WHERE id = ? AND company_id = ?`,
      args: [...args, id, cid]
    })
    return { id }
  }
  const res = await c.execute({
    sql: `INSERT INTO fixed_deposits (fd_no, bank, bank_kind, amount, start_date, maturity_date, interest_pct, interest_payout, maturity_amount, note, company_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [...args, cid]
  })
  return { id: Number(res.lastInsertRowid) }
}

/** Close (encash) an FD — refused while any of it is under lien. Record only; no voucher. */
export async function closeFd(id: number, v: { date?: string; amount?: number | string; note?: string }): Promise<{ id: number }> {
  const fd = (await listFds()).find((x) => n(x.id) === n(id))
  if (!fd) throw new Error('That FD no longer exists')
  if (n(fd.lien_amount) > 0.004) throw new Error(`${fd.fd_no} still secures ${fd.lien_lcs} LC${fd.lien_lcs === 1 ? '' : 's'} — release the lien first`)
  const date = iso(v.date) || todayISO()
  await getClient().execute({
    sql: 'UPDATE fixed_deposits SET closed_date = ?, closed_amount = ?, note = COALESCE(?, note) WHERE id = ?',
    args: [date, n(v.amount) > 0 ? round2(n(v.amount)) : null, v.note ? String(v.note).trim() : null, n(id)]
  })
  return { id: n(id) }
}

export async function reopenFd(id: number): Promise<{ id: number }> {
  await ensureFd()
  await getClient().execute({ sql: 'UPDATE fixed_deposits SET closed_date = NULL, closed_amount = NULL WHERE id = ?', args: [n(id)] })
  return { id: n(id) }
}

/** Delete an FD recorded by mistake — refused while it secures an LC. */
export async function deleteFd(id: number): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const fd = (await listFds()).find((x) => n(x.id) === n(id))
    if (!fd) throw new Error('That FD no longer exists')
    if (n(fd.lien_amount) > 0.004) throw new Error(`${fd.fd_no} still secures an LC — release the lien first`)
    await getClient().execute({ sql: 'DELETE FROM fd_liens WHERE fd_id = ?', args: [n(id)] })
    await getClient().execute({ sql: 'DELETE FROM fixed_deposits WHERE id = ?', args: [n(id)] })
    return { id: n(id) }
  })
}

/**
 * Mark part (or all) of an FD as security for an LC. Only an FD still held and
 * not yet matured, and never more than is free on it.
 */
export async function addFdLien(v: { fd_id: number; lc_id: number; amount: number | string; date?: string; note?: string }): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const fd = (await listFds()).find((x) => n(x.id) === n(v.fd_id))
    if (!fd) throw new Error('That FD no longer exists')
    const date = iso(v.date) || todayISO()
    if (fd.closed_date) throw new Error(`${fd.fd_no} is closed`)
    if (iso(fd.maturity_date) && iso(fd.maturity_date) <= date) throw new Error(`${fd.fd_no} has matured (${iso(fd.maturity_date)}) — only an FD not yet matured can secure an LC`)
    const amount = round2(n(v.amount))
    if (!(amount > 0)) throw new Error('Enter the amount held against the LC')
    if (amount > n(fd.free_amount) + 0.004) throw new Error(`Only Rs ${n(fd.free_amount).toFixed(2)} of ${fd.fd_no} is free`)
    const lc = (await getClient().execute({ sql: 'SELECT id, company_id, lc_no, preclosed_date, workflow_status FROM letters_of_credit WHERE id = ?', args: [n(v.lc_id)] })).rows[0] as unknown as Row | undefined
    if (!lc) throw new Error('That LC no longer exists')
    if (n(lc.company_id) !== n(fd.company_id)) throw new Error('The LC is in another company')
    if (lc.preclosed_date || String(lc.workflow_status || '') === 'rejected') throw new Error(`${lc.lc_no || 'That LC'} is already closed`)
    const res = await getClient().execute({
      sql: 'INSERT INTO fd_liens (fd_id, lc_id, amount, marked_date, note) VALUES (?, ?, ?, ?, ?)',
      args: [n(fd.id), n(lc.id), amount, date, v.note ? String(v.note).trim() : null]
    })
    return { id: Number(res.lastInsertRowid) }
  })
}

/** Release a lien by hand (the bank freed the FD before the LC closed). */
export async function releaseFdLien(id: number, date?: string): Promise<{ id: number }> {
  await ensureFd()
  await getClient().execute({ sql: 'UPDATE fd_liens SET released_date = ? WHERE id = ?', args: [iso(date) || todayISO(), n(id)] })
  return { id: n(id) }
}

/** Remove a lien marked by mistake. */
export async function deleteFdLien(id: number): Promise<{ id: number }> {
  await ensureFd()
  await getClient().execute({ sql: 'DELETE FROM fd_liens WHERE id = ?', args: [n(id)] })
  return { id: n(id) }
}

/** The FDs securing one LC — for the LC's own panel. */
export async function lcFdLiens(lcId: number): Promise<Row[]> {
  await ensureFd()
  const rows = toPlain(
    await getClient().execute({
      sql: `${LIEN_SQL.replace('FROM fd_liens f', 'FROM fd_liens f JOIN fixed_deposits d ON d.id = f.fd_id').replace('SELECT f.*', 'SELECT f.*, d.fd_no, d.bank AS fd_bank, d.amount AS fd_amount, d.maturity_date AS fd_maturity, d.interest_pct AS fd_rate')}
             WHERE f.lc_id = ? ORDER BY f.marked_date, f.id`,
      args: [n(lcId)]
    })
  )
  return rows.map((l) => ({ ...l, ...lienState(l), amount: n(l.amount) }))
}
