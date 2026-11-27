import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

type Row = Record<string, unknown>
const n = (v: unknown): number => Number(v) || 0

/**
 * BANK BOOK VERIFICATION — admin only. Every payment / receipt through a bank:
 * open it to set its Agst Ref (bill-wise), then mark it done. The mark records
 * who checked it and when; nothing in the books changes.
 */
export function BankVerify({
  companyId,
  period,
  onOpen
}: {
  companyId?: number
  period?: { from: string; to: string }
  onOpen: (entryId: number) => void
}): React.JSX.Element {
  const [state, setState] = useState<'pending' | 'done' | 'all'>('pending')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const load = useCallback(async () => {
    try {
      setRows(await window.api.bankVerify.list({ companyId, from: period?.from, to: period?.to, state }))
    } catch (e) {
      toast.error((e as Error).message)
      setRows([])
    }
  }, [companyId, period?.from, period?.to, state])
  useEffect(() => {
    setRows(null)
    void load()
  }, [load])
  // Back from a voucher (Agst Ref set): read again.
  useEffect(() => {
    const f = (): void => void load()
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  }, [load])
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return rows || []
    return (rows || []).filter((r) =>
      [r.code, r.vch_no, r.bank, r.narration, ...((r.parties as Row[]) || []).map((p) => p.name)].map((x) => String(x || '')).join(' ').toLowerCase().includes(t)
    )
  }, [rows, q])
  async function mark(r: Row, done: boolean): Promise<void> {
    setBusy(n(r.id))
    try {
      await window.api.bankVerify.set(n(r.id), done)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[#DCE7DB] bg-white px-4 py-3">
        <div className="mr-2">
          <div className="text-[15px] font-extrabold text-[#0A1F17]">Bank book verification</div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">Admin only · open each bank payment / receipt, set its Agst Ref, then mark it done.</div>
        </div>
        <div className="flex overflow-hidden rounded-[7px] border border-[#C3D2C6]">
          {(['pending', 'done', 'all'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setState(k)}
              className={cn('px-3 py-1.5 text-[11.5px] font-extrabold', state === k ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-white text-[#33473E]')}
            >
              {k === 'pending' ? 'To verify' : k === 'done' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Voucher, bank, party, narration"
          className="h-8 min-w-[240px] flex-1 rounded-[7px] border border-[#C3D2C6] px-3 text-[12.5px] font-semibold"
        />
        <span className="text-[11.5px] font-semibold text-[#5A6B62]">{rows ? `${shown.length} voucher${shown.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {rows == null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-[#DCE7DB] bg-white">
          <table className="w-full min-w-[1000px] text-[12.5px]">
            <thead className="bg-[#0B3D2E] text-[10px] font-extrabold uppercase tracking-[.1em] text-[#DCEFE4]">
              <tr>
                <th className="px-3 py-2.5 text-left">Date</th>
                <th className="px-3 py-2.5 text-left">Voucher</th>
                <th className="px-3 py-2.5 text-left">Bank</th>
                <th className="px-3 py-2.5 text-left">Party · Agst Ref</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={String(r.id)} className={cn('border-t border-[#EFF3EE] align-top', !!r.done && 'bg-[#F6FBF7]')}>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold tabular-nums">{formatDate(String(r.entry_date))}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <button type="button" onClick={() => onOpen(n(r.id))} className="flex items-center gap-1 font-extrabold text-[#1B4E82] hover:underline" title="Open the voucher — set its Agst Ref (bill-wise) there">
                      {String(r.code || r.vch_no || `#${String(r.id)}`)} <ExternalLink className="h-3 w-3" />
                    </button>
                    <div className="text-[10.5px] font-bold uppercase text-[#5A6B62]">{String(r.vch_type)}</div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2 text-[11.5px] font-semibold text-[#33473E]">{String(r.bank || '')}</td>
                  <td className="px-3 py-2">
                    {((r.parties as Row[]) || []).map((p, i) => {
                      const refs = (p.refs as Row[]) || []
                      return (
                        <div key={i} className="mb-1 last:mb-0">
                          <span className="font-bold text-[#0A1F17]">{String(p.name)}</span>{' '}
                          <span className="text-[11px] font-semibold text-[#5A6B62]">{formatINR(n(p.amount))} {String(p.side)}</span>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {!p.billwise ? null : refs.length ? (
                              refs.map((x, j) => (
                                <span key={j} className="rounded-[3px] border border-[#BFE3CB] bg-[#E9F5EE] px-1.5 text-[10.5px] font-bold text-[#0B6B45]">
                                  Agst {String(x.ref)} · {formatINR(n(x.amount))}
                                </span>
                              ))
                            ) : (
                              <span className="rounded-[3px] border border-[#F1D9A6] bg-[#FFF4DD] px-1.5 text-[10.5px] font-bold text-[#8A5300]">On Account — no Agst Ref</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {!!String(r.narration || '').trim() && <div className="mt-1 max-w-[520px] truncate text-[10.5px] text-[#7A8C82]" title={String(r.narration)}>{String(r.narration)}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-extrabold tabular-nums">{formatINR(n(r.amount))}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {r.done ? (
                      <button
                        type="button"
                        disabled={busy === n(r.id)}
                        onClick={() => void mark(r, false)}
                        title={`Checked by ${String(r.verified_by || '—')} on ${String(r.verified_at || '').slice(0, 16)} — click to take the mark back`}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#BFE3CB] bg-[#E9F5EE] px-2.5 py-1 text-[11px] font-extrabold text-[#0B6B45]"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Done · {String(r.verified_by || '')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === n(r.id)}
                        onClick={() => void mark(r, true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#C3D2C6] bg-white px-2.5 py-1 text-[11px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]"
                      >
                        {busy === n(r.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-3.5 w-3.5" />} Mark done
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center font-semibold text-[#5A6B62]">
                    {state === 'pending' ? 'Nothing left to verify in this period.' : 'No bank voucher here.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
