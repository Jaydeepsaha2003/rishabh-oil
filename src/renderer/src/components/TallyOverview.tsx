import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, FileSpreadsheet, Landmark, RefreshCw } from 'lucide-react'
import { formatINR } from '@/lib/format'
import { draftTime } from '@/components/TallySalesCheck'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// TALLY AT A GLANCE — one card per file being worked on (each note register,
// each register check, each bank), checked again when this opens: how far the
// two books agree, what is still to book or to look at, and the money between
// them. A card opens its tab. Recent bookings from Tally sit underneath.

export function TallyOverview({
  companyId,
  companyName,
  onOpen
}: {
  companyId?: number
  companyName: string
  /** Open a card's tab; a bank card also says which bank. */
  onOpen: (tab: string, accountId?: number) => void
}): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!companyId) return
    setBusy(true)
    try {
      setData(await window.api.tallyNotes.health({ company_id: companyId }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [companyId])
  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  const cards: Row[] = (data?.cards as Row[]) || []
  const batches: Row[] = (data?.batches as Row[]) || []
  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const allAgree = cards.length > 0 && cards.every((c) => !c.error && !c.to_book && !c.to_look && !c.not_in_tally)

  return (
    <div className="flex min-h-0 flex-col gap-3.5">
      <section className={`${card} flex flex-wrap items-center gap-3 px-4 py-3`}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-extrabold text-[#0A1F17]">Tally against {companyName || 'these books'} — at a glance</div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">
            Every file uploaded here is checked again now. A card opens its tab; upload a file on a tab and it joins this page.
          </div>
        </div>
        {allAgree && <span className="rounded-[3px] bg-[#E9F5EE] px-2 py-1 text-[11px] font-extrabold text-[#0B6B45]">Everything agrees</span>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#D6E2D6] bg-white px-3 text-[11.5px] font-extrabold text-[#0B6B45] disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> {busy ? 'Checking every file…' : 'Check again'}
        </button>
      </section>

      {!data && busy && <div className={`${card} px-4 py-8 text-center text-[12.5px] font-semibold text-[#5A6B62]`}>Checking every file against the books…</div>}
      {data && cards.length === 0 && (
        <div className={`${card} px-4 py-8 text-center text-[12.5px] font-semibold text-[#5A6B62]`}>
          No Tally file uploaded yet. Open a tab above — Sales, Purchase, Journal or a bank — and upload its file.
        </div>
      )}

      <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((c, i) => {
          const isBank = c.tab === 'bank'
          if (c.error) {
            return (
              <button key={i} type="button" onClick={() => onOpen(String(c.tab), c.account_id)} className={`${card} p-4 text-left`}>
                <div className="flex items-center gap-2 text-[13px] font-extrabold text-[#0A1F17]">
                  <AlertTriangle className="h-4 w-4 text-[#B3261E]" /> {String(c.title)}
                </div>
                <div className="mt-1.5 text-[11.5px] font-semibold text-[#B3261E]">{String(c.error)}</div>
              </button>
            )
          }
          const total = Math.max(1, Number(c.total) || 0)
          const seg = [
            { k: 'Agree', v: Number(c.agree) || 0, fg: '#0B6B45' },
            { k: 'To look at', v: Number(c.to_look) || 0, fg: '#B3261E' },
            { k: 'To book', v: Number(c.to_book) || 0, fg: '#C2700A' },
            { k: 'Not in Tally', v: Number(c.not_in_tally) || 0, fg: '#1B4E82' }
          ]
          const pct = Math.round(((Number(c.agree) || 0) / total) * 100)
          const diff = c.difference == null ? null : Number(c.difference)
          return (
            <button
              key={i}
              type="button"
              onClick={() => onOpen(String(c.tab), c.account_id)}
              className={`${card} group flex flex-col gap-2.5 p-4 text-left transition-shadow hover:shadow-[0_4px_14px_rgba(10,31,23,.08)]`}
            >
              <div className="flex items-start gap-2">
                {isBank ? <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-[#0B6B45]" /> : <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-[#0B6B45]" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-extrabold text-[#0A1F17]">{String(c.title)}</span>
                  <span className="block truncate text-[10.5px] font-semibold text-[#5A6B62]">
                    {String(c.file_name || '')}
                    {c.period ? ` · ${String(c.period)}` : ''} · saved {draftTime(String(c.saved_at))}
                  </span>
                </span>
                <span className="text-[18px] font-bold tabular-nums" style={{ color: pct >= 95 ? '#0B6B45' : pct >= 60 ? '#8A5300' : '#B3261E' }}>
                  {pct}%
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-[#EEF3EC]">
                {seg.map((s) => (s.v ? <span key={s.k} style={{ width: `${(s.v / total) * 100}%`, background: s.fg }} /> : null))}
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {seg.map((s) => (
                  <span key={s.k} className="min-w-0">
                    <span className="block truncate text-[9.5px] font-extrabold uppercase tracking-[.06em]" style={{ color: s.fg }}>
                      {s.k}
                    </span>
                    <span className="block text-[14px] font-bold tabular-nums" style={{ color: s.v ? '#0A1F17' : '#A9B8AE' }}>
                      {s.v}
                    </span>
                  </span>
                ))}
              </div>
              {isBank && c.closing ? (
                <div className="grid grid-cols-3 gap-1.5 rounded-[4px] bg-[#F7FAF6] px-2.5 py-2 text-[11px] tabular-nums">
                  {[
                    { k: 'Tally closing', v: c.closing.tally },
                    { k: 'Here', v: c.closing.books },
                    { k: 'Bank', v: c.closing.bank }
                  ].map((x) => (
                    <span key={x.k} className="min-w-0">
                      <span className="block text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#5A6B62]">{x.k}</span>
                      <span className="block truncate font-bold text-[#0A1F17]">
                        {x.v == null ? '—' : `${formatINR(Math.abs(Number(x.v)))} ${Number(x.v) < 0 ? 'Cr' : 'Dr'}`}
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2 border-t border-[#EEF3ED] pt-2">
                <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                  {diff == null ? 'Notes to bring in' : isBank ? 'Closing, Tally − here' : 'Total, Tally − here'}
                </span>
                <span className="text-[12.5px] font-extrabold tabular-nums" style={{ color: diff == null || Math.abs(diff) <= 1 ? '#0B6B45' : '#B3261E' }}>
                  {diff == null ? `${Number(c.to_book) || 0} new` : Math.abs(diff) <= 1 ? 'Agrees' : formatINR(diff)}
                </span>
                <ArrowRight className="h-4 w-4 text-[#8CA396] transition-transform group-hover:translate-x-0.5" />
              </div>
            </button>
          )
        })}
      </div>

      {batches.length > 0 && (
        <section className={card}>
          <div className="border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#0A1F17]">
            Recent bookings from Tally
          </div>
          <div className="divide-y divide-[#EEF3ED]">
            {batches.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[12px]">
                <span className="w-[92px] font-bold tabular-nums text-[#33473E]">{draftTime(String(b.created_at))}</span>
                <span className="w-[86px] text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">{String(b.kind)}</span>
                <span className="min-w-0 flex-1 truncate font-bold text-[#0A1F17]">{String(b.file_name || 'Tally file')}</span>
                <span className="font-semibold tabular-nums text-[#33473E]">
                  {b.live} of {b.count} · {formatINR(Number(b.amount) || 0)}
                </span>
                <span className="text-[11px] font-semibold text-[#5A6B62]">by {String(b.created_by || '—')}</span>
                {b.undone_at && <span className="text-[10px] font-extrabold uppercase text-[#5A6B62]">Taken back</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
