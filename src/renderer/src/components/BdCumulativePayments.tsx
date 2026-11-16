import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// PAYMENTS MADE through Pay cumulative interest (listBdCumulativePayments):
// one card per bank voucher, each bill on it against what was due on its days
// when it was paid — short or in excess, said per bill and per voucher.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

function DiffChip({ diff, big }: { diff: number; big?: boolean }): React.JSX.Element {
  const size = big ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-0.5 text-[11px]'
  if (Math.abs(diff) < 0.5) return <span className={cn('whitespace-nowrap rounded-full border border-[#BFE3CB] bg-[#E9F5EE] font-extrabold text-[#0B6B45]', size)}>Exact</span>
  return diff < 0 ? (
    <span className={cn('whitespace-nowrap rounded-full border border-[#F0C9C4] bg-[#FDECEA] font-extrabold tabular-nums text-[#B3261E]', size)}>SHORTFALL {formatINR(-diff)}</span>
  ) : (
    <span className={cn('whitespace-nowrap rounded-full border border-[#E8C27A] bg-[#FFF4DC] font-extrabold tabular-nums text-[#7A4B00]', size)}>EXCESS {formatINR(diff)}</span>
  )
}

export function BdCumulativePayments({ nbfcId }: { nbfcId: number | null }): React.JSX.Element {
  const [list, setList] = useState<Row[] | null>(null)
  useEffect(() => {
    let live = true
    setList(null)
    window.api.billDiscounting
      .cumulativePayments(nbfcId)
      .then((r) => live && setList(r))
      .catch((e) => toast.error((e as Error).message))
    return () => {
      live = false
    }
  }, [nbfcId])

  if (list == null)
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
      </div>
    )
  if (!list.length)
    return (
      <div className="rounded-[6px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">
        No payment made through Pay cumulative interest{nbfcId ? ' with this NBFC' : ''} yet.
      </div>
    )

  const short = list.reduce((t, g) => t + Math.min(0, n(g.diff)), 0)
  const over = list.reduce((t, g) => t + Math.max(0, n(g.diff)), 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-4">
        {[
          { k: 'Vouchers', v: String(list.length), tone: 'text-[#0A1F17]' },
          { k: 'Paid out of the bank', v: formatINR(list.reduce((t, g) => t + n(g.net), 0)), tone: 'text-[#0B6B45]' },
          { k: 'Shortfall', v: formatINR(-short), tone: short < -0.5 ? 'text-[#B3261E]' : 'text-[#9AAFA2]' },
          { k: 'Excess', v: formatINR(over), tone: over > 0.5 ? 'text-[#7A4B00]' : 'text-[#9AAFA2]' }
        ].map((t, i) => (
          <div key={t.k} className={cn('min-w-0 px-4 py-3', i % 2 === 1 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0', i === 2 && 'lg:border-l')}>
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">{t.k}</div>
            <div className={cn('mt-0.5 truncate text-[19px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
          </div>
        ))}
      </div>

      {list.map((g) => (
        <div key={String(g.journal_entry_id)} className="overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#EEF3EE] bg-[#F7FAF6] px-4 py-2.5">
            <span className="rounded-[4px] bg-[#0B3D2E] px-2 py-0.5 text-[11.5px] font-extrabold text-[#C7F03F]">{String(g.vch_no || `#${g.journal_entry_id}`)}</span>
            <span className="rounded-full border border-[#D6E2D6] bg-white px-2 py-0.5 text-[11px] font-bold tabular-nums text-[#33473E]">{formatDate(String(g.paid_date))}</span>
            <span className="text-[12px] font-bold text-[#0A1F17]">{String(g.nbfc_name || '')}</span>
            <span className="text-[11px] font-semibold text-[#7A8C82]">{String(g.bank || '')}</span>
            <span className="ml-auto flex items-center gap-3">
              <span className="text-right">
                <span className="block text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">Out of the bank</span>
                <span className="text-[14px] font-extrabold tabular-nums text-[#0B6B45]">{formatINR(n(g.net))}</span>
              </span>
              <DiffChip diff={n(g.diff)} big />
            </span>
          </div>
          {g.narration && <div className="border-b border-[#F1F5F0] px-4 py-1.5 text-[11.5px] italic text-[#5A6B62]">{String(g.narration)}</div>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <thead className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                <tr>
                  <th className="px-4 py-1.5 text-left">Bill</th>
                  <th className="px-2 py-1.5 text-left">Period</th>
                  <th className="px-2 py-1.5 text-right">Due then</th>
                  <th className="px-2 py-1.5 text-right">Paid</th>
                  <th className="px-2 py-1.5 text-right">TDS</th>
                  <th className="px-2 py-1.5 text-right">Net</th>
                  <th className="px-4 py-1.5 text-right">Shortfall / excess</th>
                </tr>
              </thead>
              <tbody>
                {(g.bills as Row[]).map((b) => (
                  <tr key={String(b.id)} className="border-t border-[#F1F5F0]">
                    <td className="px-4 py-2">
                      <span className="rounded-[4px] bg-[#EEF3EE] px-1.5 py-0.5 text-[11.5px] font-extrabold text-[#0B3D2E]">{String(b.bd_no)}</span>
                      {b.balance && <span className="ml-1.5 rounded-[3px] border border-[#F0C9C5] bg-[#FDF0EE] px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase text-[#B3261E]">Balance</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-semibold tabular-nums text-[#0A1F17]">
                      {formatDate(String(b.from_date))} → {formatDate(String(b.to_date))}
                    </td>
                    <td
                      className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#33473E]"
                      title={n(b.before) > 0.004 ? `Worked out ${formatINR(n(b.due))}, less ${formatINR(n(b.before))} paid on these days before` : `Worked out ${formatINR(n(b.due))}`}
                    >
                      {formatINR(n(b.expected))}
                      {n(b.before) > 0.004 && <span className="block text-[10px] font-semibold text-[#8CA396]">of {formatINR(n(b.due))}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(n(b.gross))}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#5A6B62]">{formatINR(n(b.tds))}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#0B6B45]">{formatINR(n(b.net))}</td>
                    <td className="px-4 py-2 text-right">
                      <DiffChip diff={n(b.diff)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
