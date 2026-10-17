// TALLY'S PARKING-ACCOUNT CHAIN, BOOKED TWICE.
//
// Tally books an LC/BD payment in steps through a parking ledger:
//   Payment No. 255   HDFC → RTGS NEFT PARKING ACCOUNT        2,82,984
//   Journal No. 871   PARKING → INTEREST (LC)                 2,76,288
//   Receipt No. 477   PARKING → HDFC (the bank's refund)          6,696
// The parking ledger nets to nil; the bank paid 2,76,288 for 2,76,288 of
// interest. The LC here posts the same money in ONE voucher of its own (PAY/18:
// INTEREST Dr / HDFC Cr 2,76,288). With the chain also booked from Tally, the
// interest and the bank are in the books twice.
//
// This finds such chains straight from the books — no Tally file to upload —
// and, on review, takes the Tally copies out. The app's voucher stays and is
// remembered as Tally's payment, refund and journal, so the bank and journal
// checks never offer them to book again.
import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { ensureVoucherNumbers } from './voucherNumbers'
import { saveTallyLink } from './tallyLinks'

type Row = Record<string, unknown>
function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}
const n = (v: unknown): number => Number(v) || 0
const round2 = (v: number): number => Math.round(v * 100) / 100
const FROM_TALLY = 'Imported from Tally%'
const PARKING = /PARKING|SUSPENSE|CLEARING|TRANSFER|IN\s*TRANSIT/i

type Line = { account_id: number; name: string; dr: number; cr: number }
type Entry = { id: number; date: string; type: string; vch_no: string; narration: string; company_id: number; code: string; lines: Line[] }

function daysApart(a: string, b: string): number {
  return Math.abs((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86400000)
}

async function entries(tally: boolean): Promise<Entry[]> {
  const c = getClient()
  const heads = toPlain(
    await c.execute({
      sql: `SELECT je.id, je.entry_date, je.vch_type, je.vch_no, je.narration, je.company_id,
                   (SELECT nn.prefix || '/' || nn.serial FROM voucher_numbers nn WHERE nn.entry_id = je.id) AS code
              FROM journal_entries je
             WHERE ${tally ? 'je.narration LIKE ?' : "(je.narration IS NULL OR je.narration NOT LIKE ?)"}`,
      args: [FROM_TALLY]
    })
  )
  if (!heads.length) return []
  const byId = new Map<number, Entry>()
  for (const h of heads) {
    byId.set(n(h.id), {
      id: n(h.id),
      date: String(h.entry_date || '').slice(0, 10),
      type: String(h.vch_type || ''),
      vch_no: String(h.vch_no || ''),
      narration: String(h.narration || ''),
      company_id: n(h.company_id),
      code: String(h.code || h.vch_no || ''),
      lines: []
    })
  }
  const lines = toPlain(
    await c.execute({
      sql: `SELECT jl.entry_id, jl.account_id, a.name, jl.dr, jl.cr FROM journal_lines jl
              JOIN ledger_accounts a ON a.id = jl.account_id
              JOIN journal_entries je ON je.id = jl.entry_id
             WHERE ${tally ? 'je.narration LIKE ?' : "(je.narration IS NULL OR je.narration NOT LIKE ?)"}`,
      args: [FROM_TALLY]
    })
  )
  for (const l of lines) {
    byId.get(n(l.entry_id))?.lines.push({ account_id: n(l.account_id), name: String(l.name || ''), dr: n(l.dr), cr: n(l.cr) })
  }
  return [...byId.values()]
}

/** "Imported from Tally — HDFC… Book — Payment(Loan/bank/Lc Charge No. 255 (5385.xlsx)" → the bank and Tally's key. */
function bookOf(e: Entry): { bank: string; key: string } | null {
  const m = e.narration.match(/^Imported from Tally\W+(.+?) Book\W+(.+?) No\. (\S+?) \(/)
  if (!m) return null
  return { bank: m[1].trim().toUpperCase(), key: `${m[2].trim().toUpperCase()}|${m[3].trim()}` }
}

type Step = { e: Entry; amount: number; bankId: number; key: string }
type Finding = Row & { key: string; fixable: boolean }

export async function previewParkingCopies(): Promise<{ findings: Finding[] }> {
  await ensureVoucherNumbers()
  const tally = await entries(true)
  const own = await entries(false)

  // Tally's bank lines into or out of a ledger that is not the bank: the
  // payment INTO parking, and the refunds coming back OUT of it.
  const outs: (Step & { via: number; viaName: string })[] = []
  const backs: (Step & { via: number })[] = []
  for (const e of tally) {
    const b = bookOf(e)
    if (!b || e.lines.length !== 2) continue
    const bank = e.lines.find((l) => l.name.toUpperCase() === b.bank)
    const other = e.lines.find((l) => l !== bank)
    if (!bank || !other) continue
    // Only a holding ledger the money passes THROUGH — a lender's or a
    // party's ledger in the middle is a different deal (an NBFC paying a
    // supplier is not this payment's interest).
    if (!PARKING.test(other.name)) continue
    if (bank.cr > 0 && other.dr > 0) outs.push({ e, amount: round2(bank.cr), bankId: bank.account_id, key: b.key, via: other.account_id, viaName: other.name })
    else if (bank.dr > 0 && other.cr > 0) backs.push({ e, amount: round2(bank.dr), bankId: bank.account_id, key: b.key, via: other.account_id })
  }
  // Tally's journals that clear a parking ledger on to what it was for.
  const journals = tally.filter((e) => /JOURNAL/i.test(e.type) && !bookOf(e))

  const taken = new Set<number>()
  const usedOwn = new Set<number>()
  const findings: Finding[] = []
  for (const o of outs.sort((a, b) => a.e.date.localeCompare(b.e.date))) {
    if (taken.has(o.e.id)) continue
    const clears = journals.filter((j) => {
      if (taken.has(j.id) || j.company_id !== o.e.company_id || daysApart(j.date, o.e.date) > 5) return false
      const cr = j.lines.filter((l) => l.cr > 0)
      return cr.length === 1 && cr[0].account_id === o.via && j.lines.some((l) => l.dr > 0)
    })
    for (const j of clears) {
      const x = round2(j.lines.reduce((t, l) => t + l.dr, 0))
      if (x > o.amount + 1) continue
      // The refunds that bring the rest back: none, one or two of them.
      const pool = backs.filter(
        (r) => !taken.has(r.e.id) && r.via === o.via && r.bankId === o.bankId && r.e.date >= o.e.date && daysApart(r.e.date, o.e.date) <= 30
      )
      const tries: (typeof pool)[] = [[]]
      for (const a of pool) tries.push([a])
      for (let i = 0; i < pool.length; i++) for (let k = i + 1; k < pool.length; k++) tries.push([pool[i], pool[k]])
      const refunds = tries.find((t) => Math.abs(o.amount - t.reduce((s, r) => s + r.amount, 0) - x) <= 1)
      if (!refunds) continue
      // The app's own voucher for the same money: the same bank, the same
      // net amount, within a few days.
      const cands = own
        .filter((d) => !usedOwn.has(d.id) && d.company_id === o.e.company_id && daysApart(d.date, j.date) <= 5)
        .map((d) => ({ d, paid: round2(d.lines.filter((l) => l.account_id === o.bankId).reduce((t, l) => t + l.cr - l.dr, 0)) }))
        .filter((c) => c.paid > 0 && Math.abs(c.paid - x) <= Math.max(1, x * 0.03))
        .sort((a, b) => Math.abs(a.paid - x) - Math.abs(b.paid - x) || daysApart(a.d.date, j.date) - daysApart(b.d.date, j.date))
      const d = cands[0]
      if (!d) continue
      const diff = round2(d.paid - x)
      // An LC's upfront interest voucher can be set to the bank's own debit
      // in the same step, so a few rupees apart is still one click.
      const lc = toPlain(
        await getClient().execute({ sql: 'SELECT id, lc_no FROM letters_of_credit WHERE interest_journal_entry_id = ?', args: [d.d.id] })
      )[0]
      const matchLc = Math.abs(diff) > 1 && lc ? n(lc.id) : 0
      const fixable = Math.abs(diff) <= 1 || matchLc > 0
      taken.add(o.e.id)
      taken.add(j.id)
      for (const r of refunds) taken.add(r.e.id)
      usedOwn.add(d.d.id)
      const bankName = o.e.lines.find((l) => l.account_id === o.bankId)?.name || ''
      findings.push({
        key: [d.d.id, o.e.id, j.id, ...refunds.map((r) => r.e.id)].join(':'),
        fixable,
        own: { id: d.d.id, code: d.d.code, date: d.d.date, amount: d.paid, narration: d.d.narration },
        bank: bankName,
        via: o.viaName,
        payment: { id: o.e.id, vch_no: o.e.vch_no, date: o.e.date, amount: o.amount },
        refunds: refunds.map((r) => ({ id: r.e.id, vch_no: r.e.vch_no, date: r.e.date, amount: r.amount })),
        journal: {
          id: j.id,
          vch_no: j.vch_no,
          date: j.date,
          amount: x,
          to: j.lines.filter((l) => l.dr > 0).map((l) => l.name).join(', ')
        },
        diff,
        match_lc: matchLc,
        match_to: x,
        note: matchLc
          ? `${d.d.code} pays ${d.paid}, the bank and Tally ${x}. ${d.d.code} is set to the bank's ${x} (LC ${String(lc.lc_no)}: its charges stay, the interest is the rest) and Tally's copies removed.`
          : fixable
            ? `Tally paid ${x} net through ${o.viaName}; ${d.d.code} already pays it. Removing Tally's copies leaves ${d.d.code}.`
            : `${d.d.code} pays ${d.paid}, Tally ${x} — ${Math.abs(diff)} apart. Correct ${d.d.code} to ${x} first (Edit on the LC/BD), then Check again.`
      })
      break
    }
  }
  return { findings: findings.sort((a, b) => String((a.journal as Row).date).localeCompare(String((b.journal as Row).date))) }
}

export async function removeParkingCopies(keys: string[]): Promise<{ removed: number; chains: number }> {
  const want = new Set((keys || []).map(String))
  if (!want.size) throw new Error('Pick at least one')
  return withDbTransaction(async () => {
    const c = getClient()
    const { findings } = await previewParkingCopies()
    let removed = 0
    let chains = 0
    for (const f of findings) {
      if (!want.has(f.key) || !f.fixable) continue
      const ownId = n((f.own as Row).id)
      if (n(f.match_lc)) {
        const { postLcUpfrontInterest } = await import('./treasury')
        await c.execute({ sql: 'UPDATE letters_of_credit SET upfront_debited = ? WHERE id = ?', args: [round2(n(f.match_to)), n(f.match_lc)] })
        await postLcUpfrontInterest(n(f.match_lc), String((f.own as Row).date))
        console.log(`[repairs] LC ${n(f.match_lc)} upfront set to the bank's ${n(f.match_to)} (was ${n((f.own as Row).amount)}) — ${String((f.own as Row).code)} keeps its id`)
      }
      const head = toPlain(await c.execute({ sql: 'SELECT company_id FROM journal_entries WHERE id = ?', args: [ownId] }))[0]
      const cid = n(head?.company_id)
      const bankSteps = [f.payment as Row, ...((f.refunds as Row[]) || [])]
      const all = [...bankSteps, f.journal as Row]
      for (const s of all) {
        const id = n(s.id)
        const lines = toPlain(
          await c.execute({ sql: 'SELECT a.name, jl.dr, jl.cr FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?', args: [id] })
        )
        const e = toPlain(await c.execute({ sql: 'SELECT narration FROM journal_entries WHERE id = ?', args: [id] }))[0]
        console.log(`[repairs] Tally copy ${String(s.vch_no)} (${String(s.date)}) of ${String((f.own as Row).code)} removed — ${String(e?.narration || '')} — lines ${JSON.stringify(lines)}`)
        // Remembered as the app's voucher, so the bank and journal checks
        // read Tally's lines as booked.
        const b = bookOf({ narration: String(e?.narration || '') } as Entry)
        const bankId = toPlain(
          await c.execute({
            sql: `SELECT jl.account_id FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? AND UPPER(a.name) = ?`,
            args: [id, b?.bank || '']
          })
        )[0]
        await c.execute({ sql: 'DELETE FROM journal_bill_allocs WHERE line_id IN (SELECT id FROM journal_lines WHERE entry_id = ?)', args: [id] })
        await c.execute({ sql: 'DELETE FROM journal_lines WHERE entry_id = ?', args: [id] })
        await c.execute({ sql: 'DELETE FROM journal_entries WHERE id = ?', args: [id] })
        removed++
        if (b && bankId) {
          await saveTallyLink({ company_id: cid, scope: `bank:${n(bankId.account_id)}`, tally_key: b.key, entry_id: ownId, also: true })
        } else if (s === f.journal) {
          await saveTallyLink({ company_id: cid, scope: 'journal', tally_key: `JOURNAL|${String(s.vch_no)}`, entry_id: ownId, also: true })
        }
      }
      chains++
    }
    if (!chains) throw new Error('Nothing to remove — check again')
    return { removed, chains }
  })
}
