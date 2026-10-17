import { getClient } from './db'
import { companyOf, listTallyDrafts, previewTallyNotes, reconcileTallySales } from './tallyNotes'
import { checkTallyRegister } from './tallyRegisters'
import { checkTallyBank } from './tallyBank'
import { listTallyBatches } from './tallyLinks'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// TALLY AT A GLANCE — every file the desk is working on, checked again now,
// one card each: when it was last uploaded, how many lines agree, how many
// are missing on either side, and the money between the two books. A card is
// the way into its tab. The checks are the same ones each tab runs; nothing
// here is worked out differently.
// ---------------------------------------------------------------------------

const round2 = (x: number): number => Math.round((Number(x) || 0) * 100) / 100

export async function tallyHealth(v: { company_id?: number }): Promise<Row> {
  const cid = await companyOf(v)
  const drafts = await listTallyDrafts({ company_id: cid })
  const stmts = new Map(drafts.filter((d) => String(d.kind).startsWith('bankstmt:')).map((d) => [String(d.kind).slice('bankstmt:'.length), d]))
  const cards: Row[] = []
  const order = (k: string): number => (k === 'credit' ? 0 : k === 'debit' ? 1 : k === 'sales' ? 2 : k === 'purchase' ? 3 : k === 'journal' ? 4 : 5)
  for (const d of [...drafts].sort((a, b) => order(String(a.kind)) - order(String(b.kind)))) {
    const kind = String(d.kind)
    if (kind.startsWith('bankstmt:')) continue
    const base = { kind, file_name: String(d.file_name || ''), saved_at: String(d.saved_at || '') }
    try {
      if (kind === 'credit' || kind === 'debit') {
        const p = await previewTallyNotes({ kind, data_base64: String(d.data_base64), company_id: cid })
        const notes = (p.notes as Row[]) || []
        const by = (s: string): number => notes.filter((x) => x.status === s).length
        cards.push({
          ...base,
          title: kind === 'credit' ? 'Credit Notes' : 'Debit Notes',
          tab: kind,
          total: notes.length,
          agree: by('exists'),
          to_book: by('new'),
          to_look: by('clash') + by('maybe') + by('unbalanced'),
          not_in_tally: 0,
          difference: null
        })
      } else if (kind === 'sales') {
        const r = await reconcileTallySales({ data_base64: String(d.data_base64), company_id: cid })
        const c = r.counts || {}
        cards.push({
          ...base,
          title: 'Sales Register',
          tab: 'sales',
          period: r.period,
          total: (r.rows as Row[]).length,
          agree: Number(c.matched || 0),
          to_book: Number(c.missing_here || 0),
          to_look: Number(c.mismatch || 0) + Number(c.cancelled_here || 0),
          not_in_tally: Number(c.missing_tally || 0),
          difference: round2(Number(r.totals?.tally || 0) - Number(r.totals?.books || 0))
        })
      } else if (kind === 'purchase' || kind === 'journal') {
        const r = await checkTallyRegister({ kind, data_base64: String(d.data_base64), company_id: cid })
        const c = r.counts || {}
        cards.push({
          ...base,
          title: kind === 'purchase' ? 'Purchase Register' : 'Journal Register',
          tab: kind,
          period: r.period,
          total: (r.rows as Row[]).length,
          agree: Number(c.matched || 0),
          to_book: Number(c.missing_here || 0),
          to_look: Number(c.mismatch || 0) + Number(c.possible || 0) + Number(c.cancelled_here || 0),
          not_in_tally: Number(c.missing_tally || 0),
          difference: round2(Number(r.totals?.tally || 0) - Number(r.totals?.books || 0))
        })
      } else if (/^bank:\d+$/.test(kind)) {
        const acct = Number(kind.slice(5))
        const st = stmts.get(String(acct))
        const r = await checkTallyBank({
          account_id: acct,
          data_base64: String(d.data_base64),
          company_id: cid,
          statement_base64: st ? String(st.data_base64) : undefined,
          statement_name: st ? String(st.file_name || '') : undefined
        })
        const c = r.counts || {}
        cards.push({
          ...base,
          title: String(r.account?.name || 'Bank'),
          tab: 'bank',
          account_id: acct,
          period: r.period,
          total: (r.rows as Row[]).length,
          agree: Number(c.matched || 0),
          to_book: Number(c.missing_here || 0),
          to_look: Number(c.mismatch || 0) + Number(c.possible || 0) + Number(c.cancelled_here || 0) + Number(c.statement_only || 0),
          not_in_tally: Number(c.missing_tally || 0),
          // For a bank, the gap that matters is the closing balance.
          difference: round2(Number(r.balances?.tally?.closing || 0) - Number(r.balances?.books?.closing || 0)),
          closing: { tally: r.balances?.tally?.closing, books: r.balances?.books?.closing, bank: r.balances?.bank?.closing ?? null },
          statement: !!r.statement
        })
      }
    } catch (e) {
      cards.push({ ...base, title: kind, tab: kind.startsWith('bank:') ? 'bank' : kind, account_id: kind.startsWith('bank:') ? Number(kind.slice(5)) : undefined, error: (e as Error).message })
    }
  }
  const name = String(((await getClient().execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [cid] })).rows[0] as unknown as Row | undefined)?.name || '')
  return { company: name, cards, batches: (await listTallyBatches({ company_id: cid })).slice(0, 10) }
}
