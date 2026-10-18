// A RENAME REDIRECT THAT HIJACKS A LIVE LEDGER — reviewed in Settings →
// Accounting checks.
//
// Renaming a ledger leaves a redirect behind: "postings addressed to the old
// name go to the new one". Renaming ANOTHER ledger onto that old name used to
// leave the redirect standing (renameLedger now drops it), so the name belonged
// to a live ledger and every posting addressed to it still went elsewhere.
//
// On 22-Sep LEGACY COMMODITIES PVT LTD, TRAD. was renamed OBEROI BULK CARRIER
// and another ledger renamed into LEGACY COMMODITIES PVT LTD, TRAD.; the bank
// books imported from Tally afterwards put ₹18.75 Cr of Legacy payments on the
// transporter.
//
// The check finds such redirects and, on the ledger they point at, every line
// booked from a Tally bank book whose Tally voucher names a DIFFERENT party —
// read back from the bank book itself (tallyBankParties), not guessed. Each is
// offered for the ledger of the party Tally names: the one of that exact name,
// or — where no ledger carries it — the one whose opening matches Tally's own
// for that party. Applying moves only the party line (and its bill-wise
// allocations) and removes the redirect; the voucher, its number, date and
// amounts stay. Every change is logged in accounting_repair_log.
import type { ResultSet } from '@libsql/client'
import { getClient, bumpRevision } from './db'
import { withDbTransaction } from './dbTransaction'
import { tallyBankParties } from './tallyBank'
import { tallyKey } from './tallyNotes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100
const clean = (v: unknown): string => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

export interface ShadowedRedirect {
  map_id: number
  posts_as: string
  use_name: string
  live_id: number
  target_id: number
  created_by: string
  created_at: string
}
export interface MispostedLine {
  line_id: number
  entry_id: number
  company_id: number
  company: string
  date: string
  vch_type: string
  vch_no: string
  amount: number
  side: 'dr' | 'cr'
  from_id: number
  from_name: string
  tally_party: string
  to_id: number | null
  to_name: string | null
  how: string
}

async function ensureLog(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS accounting_repair_log (
      repair_key TEXT PRIMARY KEY, entry_id INTEGER NOT NULL, before_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`)
}

async function scan(): Promise<{ redirects: ShadowedRedirect[]; lines: MispostedLine[]; candidates: Row[] }> {
  const c = getClient()
  // Rename redirects whose old name is again a live ledger's name.
  const redirects: ShadowedRedirect[] = toPlain(
    await c.execute(`SELECT lm.id AS map_id, lm.posts_as, lm.use_name, lm.created_by, lm.created_at,
                            live.id AS live_id, tgt.id AS target_id
                       FROM ledger_map lm
                       JOIN ledger_accounts live ON TRIM(UPPER(live.name)) = TRIM(UPPER(lm.posts_as))
                       JOIN ledger_accounts tgt ON TRIM(UPPER(tgt.name)) = TRIM(UPPER(lm.use_name))
                      WHERE lm.note LIKE 'renamed from %' AND live.id <> tgt.id`)
  ).map((r) => ({
    map_id: n(r.map_id),
    posts_as: String(r.posts_as),
    use_name: String(r.use_name),
    live_id: n(r.live_id),
    target_id: n(r.target_id),
    created_by: String(r.created_by || ''),
    created_at: String(r.created_at || '')
  }))
  if (!redirects.length) return { redirects, lines: [], candidates: [] }

  const tally = await tallyBankParties()
  const accts = toPlain(await c.execute('SELECT id, name FROM ledger_accounts'))
  const byClean = new Map(accts.map((a) => [clean(a.name), n(a.id)]))
  const nameOf = new Map(accts.map((a) => [n(a.id), String(a.name)]))
  const companies = new Map(toPlain(await c.execute('SELECT id, name FROM companies')).map((r) => [n(r.id), String(r.name)]))

  const lines: MispostedLine[] = []
  for (const rd of redirects) {
    const targetKey = tallyKey(rd.use_name)
    const rows = toPlain(
      await c.execute({
        sql: `SELECT jl.id AS line_id, jl.dr, jl.cr, je.id AS entry_id, je.company_id, je.entry_date, je.vch_type, je.vch_no, je.narration
                FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
               WHERE jl.account_id = ? AND je.narration LIKE 'Imported from Tally — %'
               ORDER BY je.entry_date, je.id`,
        args: [rd.target_id]
      })
    )
    for (const r of rows) {
      const narr = String(r.narration || '')
      // The head is the narration less the " (file.xlsx)" the booking adds.
      const head = narr.replace(/\s\([^()]*\)$/, '')
      const t = tally.get(head) || tally.get(narr)
      if (!t) continue
      const amount = round2(n(r.dr) || n(r.cr))
      const leg = t.legs.length === 1 ? t.legs[0] : t.legs.find((g) => Math.abs(round2(g.amount) - amount) < 0.02)
      if (!leg || !leg.name) continue
      // Tally named this ledger itself (or its old name) — it is where it belongs.
      if (tallyKey(leg.name) === targetKey) continue
      const cid = n(r.company_id)
      let toId: number | null = null
      let how = ''
      const exact = byClean.get(clean(leg.name))
      if (exact && exact !== rd.target_id) {
        toId = exact
        how = 'the ledger of that exact name'
      } else {
        // No ledger of that name: the one whose opening is Tally's opening for it.
        const tb = toPlain(
          await c.execute({
            sql: 'SELECT dr, cr FROM tally_ledgers WHERE company_id = ? AND TRIM(UPPER(name)) = ?',
            args: [cid, clean(leg.name)]
          })
        )[0]
        if (tb) {
          const want = round2(n(tb.cr) - n(tb.dr))
          if (Math.abs(want) > 0.5) {
            const hits = toPlain(
              await c.execute({
                sql: 'SELECT account_id FROM ledger_openings WHERE company_id = ? AND ABS((cr - dr) - ?) < 1 AND account_id <> ?',
                args: [cid, want, rd.target_id]
              })
            )
            if (hits.length === 1) {
              toId = n(hits[0].account_id)
              how = `its opening matches Tally's (${want.toFixed(2)})`
            }
          }
        }
      }
      lines.push({
        line_id: n(r.line_id),
        entry_id: n(r.entry_id),
        company_id: cid,
        company: companies.get(cid) || `Company ${cid}`,
        date: String(r.entry_date || '').slice(0, 10),
        vch_type: String(r.vch_type || ''),
        vch_no: String(r.vch_no || ''),
        amount,
        side: n(r.dr) > 0 ? 'dr' : 'cr',
        from_id: rd.target_id,
        from_name: rd.use_name,
        tally_party: leg.name,
        to_id: toId,
        to_name: toId ? nameOf.get(toId) || null : null,
        how: how || 'no ledger found for this Tally name — pick one'
      })
    }
  }
  // Ledgers offered as a destination: those whose name shares the Tally
  // party's first word (LEGACY …), plus every suggested one.
  const firsts = new Set(lines.map((l) => clean(l.tally_party).split(' ')[0]).filter(Boolean))
  const candidates = accts
    .filter((a) => firsts.has(clean(a.name).split(' ')[0]) || lines.some((l) => l.to_id === n(a.id)))
    .filter((a) => !redirects.some((rd) => rd.target_id === n(a.id)))
    .map((a) => ({ id: n(a.id), name: String(a.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { redirects, lines, candidates }
}

/** Read only: the hijacking redirects and the lines they misdirected. */
export async function previewShadowedRedirects(): Promise<{ redirects: ShadowedRedirect[]; lines: MispostedLine[]; candidates: Row[]; amount: number }> {
  const s = await scan()
  return { ...s, amount: round2(s.lines.reduce((t, l) => t + l.amount, 0)) }
}

/**
 * Move the picked lines to the ledger chosen for each, and remove every
 * hijacking redirect. Refuses anything a fresh scan no longer shows.
 */
export async function fixShadowedRedirects(moves: { line_id: number; to_id: number }[]): Promise<{ moved: number; amount: number; redirects: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const s = await scan()
    if (!s.redirects.length) throw new Error('No hijacking redirect is left — check again')
    const by = new Map(s.lines.map((l) => [l.line_id, l]))
    const valid = new Set(toPlain(await c.execute('SELECT id FROM ledger_accounts')).map((r) => n(r.id)))
    let moved = 0
    let amount = 0
    for (const m of moves || []) {
      const f = by.get(n(m.line_id))
      if (!f) throw new Error('A line has changed since the list was shown — check again')
      const to = n(m.to_id)
      if (!valid.has(to) || to === f.from_id) throw new Error(`Pick the ledger for ${f.vch_type} ${f.vch_no}`)
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`shadowed-redirect:line:${f.line_id}`, f.entry_id, JSON.stringify({ line_id: f.line_id, account_id: f.from_id, to_id: to, tally_party: f.tally_party })]
      })
      await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ? AND account_id = ?', args: [to, f.line_id, f.from_id] })
      await c.execute({ sql: 'UPDATE journal_bill_allocs SET account_id = ? WHERE line_id = ?', args: [to, f.line_id] }).catch(() => undefined)
      moved++
      amount = round2(amount + f.amount)
    }
    for (const rd of s.redirects) {
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`shadowed-redirect:map:${rd.map_id}`, 0, JSON.stringify(rd)]
      })
      await c.execute({ sql: 'DELETE FROM ledger_map WHERE id = ?', args: [rd.map_id] })
    }
    await bumpRevision()
    return { moved, amount, redirects: s.redirects.length }
  })
}

// ---------------------------------------------------------------------------
// LEGACY: THE TRADING BILLS ON THE RAJKOT LEDGER.
//
// The same afternoon's renames pointed LEGACY COMMODITIES PVT LTD (the
// supplier master the trading purchases are made under) at the ledger
// LEGACY COMMODITIES PVT LTD, TRAD.. — the one carrying Tally's opening for
// LEGACY COMMODITIES PRIVATE LTD (Rajkot), a different party. So every Legacy
// bill and LC settlement since went to Rajkot, while Tally books them on
// Legacy Commodities Pvt Ltd, Trad. (GT/1061 is there), leaving one ledger
// ₹10 Cr overpaid and the other ₹10.9 Cr owed.
//
// Only offered when the evidence holds: both ledgers exist, and the two-dot
// one's opening IS Tally's Rajkot opening. Applying moves every line on it that
// did not come from a Tally bank book naming Rajkot onto TRAD., points the
// supplier's redirect at TRAD. so re-posts follow, and renames the two-dot
// ledger to the Rajkot name so it reads as what it is. Logged.
// ---------------------------------------------------------------------------
const LEGACY_TRAD = 'LEGACY COMMODITIES PVT LTD, TRAD.'
const LEGACY_MIX = 'LEGACY COMMODITIES PVT LTD, TRAD..'
const LEGACY_RAJKOT = 'LEGACY COMMODITIES PRIVATE LTD (RAJKOT)'

async function scanLegacy(): Promise<{ ok: boolean; reason: string; trad_id: number; mix_id: number; lines: Row[]; redirects: Row[]; opening: number }> {
  const c = getClient()
  const none = (reason: string): { ok: boolean; reason: string; trad_id: number; mix_id: number; lines: Row[]; redirects: Row[]; opening: number } => ({
    ok: false, reason, trad_id: 0, mix_id: 0, lines: [], redirects: [], opening: 0
  })
  const ids = new Map(
    toPlain(await c.execute({ sql: 'SELECT id, name FROM ledger_accounts WHERE name IN (?, ?)', args: [LEGACY_TRAD, LEGACY_MIX] })).map((r) => [String(r.name), n(r.id)])
  )
  const tradId = ids.get(LEGACY_TRAD) || 0
  const mixId = ids.get(LEGACY_MIX) || 0
  if (!tradId || !mixId) return none('')
  if ((await scan()).redirects.length) return none('Fix the payments above first — this step builds on them.')
  // Evidence: the two-dot ledger's opening is Tally's Rajkot opening.
  const op = toPlain(await c.execute({ sql: 'SELECT company_id, cr - dr AS bal FROM ledger_openings WHERE account_id = ?', args: [mixId] }))
  const tb = toPlain(await c.execute("SELECT company_id, cr - dr AS bal FROM tally_ledgers WHERE UPPER(name) LIKE 'LEGACY COMMODITIES PRIVATE LTD%RAJKOT%'"))
  const match = op.find((o) => tb.some((t) => n(t.company_id) === n(o.company_id) && Math.abs(n(t.bal) - n(o.bal)) < 1 && Math.abs(n(o.bal)) > 1))
  if (!match) return none('')
  const lines = toPlain(
    await c.execute({
      sql: `SELECT jl.id AS line_id, jl.dr, jl.cr, je.id AS entry_id, je.company_id, je.entry_date, je.vch_type, je.vch_no, je.narration
              FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
             WHERE jl.account_id = ? AND COALESCE(je.narration, '') NOT LIKE 'Imported from Tally — %'
             ORDER BY je.entry_date, je.id`,
      args: [mixId]
    })
  ).map((r) => ({
    line_id: n(r.line_id),
    entry_id: n(r.entry_id),
    company_id: n(r.company_id),
    date: String(r.entry_date || '').slice(0, 10),
    vch_type: String(r.vch_type || ''),
    vch_no: String(r.vch_no || ''),
    dr: round2(n(r.dr)),
    cr: round2(n(r.cr)),
    narration: String(r.narration || '').slice(0, 140)
  }))
  const redirects = toPlain(await c.execute({ sql: 'SELECT id, company_id, posts_as, use_name FROM ledger_map WHERE TRIM(UPPER(use_name)) = ?', args: [LEGACY_MIX] }))
  if (!lines.length && !redirects.length) return none('')
  return { ok: true, reason: '', trad_id: tradId, mix_id: mixId, lines, redirects, opening: round2(n(match.bal)) }
}

export async function previewLegacySplit(): Promise<Row> {
  const s = await scanLegacy()
  return { ...s, trad: LEGACY_TRAD, mix: LEGACY_MIX, rajkot: LEGACY_RAJKOT, dr: round2(s.lines.reduce((t, l) => t + l.dr, 0)), cr: round2(s.lines.reduce((t, l) => t + l.cr, 0)) }
}

export async function fixLegacySplit(): Promise<{ moved: number; redirects: number }> {
  return withDbTransaction(async () => {
    const c = getClient()
    await ensureLog()
    const s = await scanLegacy()
    if (!s.ok) throw new Error(s.reason || 'Nothing to move — check again')
    for (const l of s.lines) {
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`legacy-split:line:${l.line_id}`, l.entry_id, JSON.stringify({ line_id: l.line_id, account_id: s.mix_id, to_id: s.trad_id })]
      })
      await c.execute({ sql: 'UPDATE journal_lines SET account_id = ? WHERE id = ? AND account_id = ?', args: [s.trad_id, l.line_id, s.mix_id] })
      await c.execute({ sql: 'UPDATE journal_bill_allocs SET account_id = ? WHERE line_id = ?', args: [s.trad_id, l.line_id] }).catch(() => undefined)
    }
    const taken = toPlain(await c.execute({ sql: 'SELECT id FROM ledger_accounts WHERE name = ?', args: [LEGACY_RAJKOT] }))
    for (const r of s.redirects) {
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`legacy-split:map:${n(r.id)}`, 0, JSON.stringify(r)]
      })
      // A Rajkot name stays on the Rajkot ledger (under its new name); the
      // supplier's postings follow to TRAD. — never a name pointed at itself.
      const rajkot = /RAJKOT/.test(clean(r.posts_as))
      const to = rajkot && !taken.length ? LEGACY_RAJKOT : rajkot ? LEGACY_MIX : LEGACY_TRAD
      if (clean(r.posts_as) === to) await c.execute({ sql: 'DELETE FROM ledger_map WHERE id = ?', args: [n(r.id)] })
      else await c.execute({ sql: 'UPDATE ledger_map SET use_name = ? WHERE id = ?', args: [to, n(r.id)] })
    }
    // The two-dot ledger is Rajkot's: name it so. Nothing posts to the old
    // name any more, so no redirect is left for it.
    if (!taken.length) {
      await c.execute({
        sql: 'INSERT OR REPLACE INTO accounting_repair_log (repair_key, entry_id, before_json) VALUES (?, ?, ?)',
        args: [`legacy-split:rename:${s.mix_id}`, 0, JSON.stringify({ account_id: s.mix_id, name: LEGACY_MIX })]
      })
      await c.execute({ sql: 'UPDATE ledger_accounts SET name = ? WHERE id = ?', args: [LEGACY_RAJKOT, s.mix_id] })
    }
    await bumpRevision()
    return { moved: s.lines.length, redirects: s.redirects.length }
  })
}
