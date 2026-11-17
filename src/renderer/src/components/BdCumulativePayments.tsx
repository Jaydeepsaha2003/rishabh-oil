import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, Loader2, Trash2 } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// PAYMENTS MADE through Pay cumulative interest (listBdCumulativePayments):
// one card per bank voucher, opened for its bills. Each bill reads twice —
// AT THE TIME (this payment against what was still due then) and NOW
// (everything paid on those days against what they work out to). A shortfall
// a later payment made good reads as Adjusted; only what is still open counts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

function DiffChip({ diff, big }: { diff: number; big?: boolean }): React.JSX.Element {
  const size = big ? 'px-2.5 py-1 text-[11.5px]' : 'px-2 py-0.5 text-[10.5px]'
  if (Math.abs(diff) < 0.5)
    return (
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[#BFE3CB] bg-[#E9F5EE] font-extrabold text-[#0B6B45]', size)}>
        <CheckCircle2 className="h-3 w-3" /> SETTLED
      </span>
    )
  return diff < 0 ? (
    <span className={cn('whitespace-nowrap rounded-full border border-[#F0C9C4] bg-[#FDECEA] font-extrabold tabular-nums text-[#B3261E]', size)}>SHORTFALL {formatINR(-diff)}</span>
  ) : (
    <span className={cn('whitespace-nowrap rounded-full border border-[#E8C27A] bg-[#FFF4DC] font-extrabold tabular-nums text-[#7A4B00]', size)}>EXCESS {formatINR(diff)}</span>
  )
}

const periodsOf = (g: Row): string[] => [...new Set((g.bills as Row[]).map((b) => `${formatDate(String(b.from_date))} → ${formatDate(String(b.to_date))}`))]

export function BdCumulativePayments({ nbfcId }: { nbfcId: number | null }): React.JSX.Element {
  const [list, setList] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [rev, setRev] = useState(0)
  const [deleting, setDeleting] = useState<number | null>(null)
  // DELETE A VOUCHER: one bank debit, so it goes as one — every bill's payment on it with it.
  async function remove(g: Row): Promise<void> {
    const bills = g.bills as Row[]
    if (
      !window.confirm(
        `Delete the ${formatINR(n(g.net))} interest payment of ${formatDate(String(g.paid_date))}?

It is one voucher for ${bills.map((b) => b.bd_no).join(', ')} — the payment on every one of those bills is deleted with it, and the bank voucher is removed.`
      )
    )
      return
    setDeleting(n(g.journal_entry_id))
    try {
      await window.api.billDiscounting.deleteInterest(n(bills[0].id))
      toast.success('Interest payment deleted — its voucher is removed')
      setRev((v) => v + 1)
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setDeleting(null)
    }
  }
  useEffect(() => {
    let live = true
    setList(null)
    window.api.billDiscounting
      .cumulativePayments(nbfcId)
      .then((r) => {
        if (!live) return
        setList(r)
        // The newest opens by itself; the rest wait for a click.
        setOpen(new Set(r.length ? [n(r[0].journal_entry_id)] : []))
      })
      .catch((e) => toast.error((e as Error).message))
    return () => {
      live = false
    }
  }, [nbfcId, rev])

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

  // Only what is still open: each bill's days counted once, on their latest payment.
  const bills = list.flatMap((g) => g.bills as Row[])
  const short = bills.reduce((t, b) => t + Math.min(0, n(b.diff)), 0)
  const over = bills.reduce((t, b) => t + Math.max(0, n(b.diff)), 0)
  const toggle = (id: number): void =>
    setOpen((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-4">
        {[
          { k: 'Vouchers', v: String(list.length), sub: `${bills.length} bill payment${bills.length === 1 ? '' : 's'}`, tone: 'text-[#0A1F17]' },
          { k: 'Paid out of the bank', v: formatINR(list.reduce((t, g) => t + n(g.net), 0)), sub: `interest ${formatINR(list.reduce((t, g) => t + n(g.gross), 0))}`, tone: 'text-[#0B6B45]' },
          { k: 'Shortfall still open', v: formatINR(-short), sub: 'less paid than worked out', tone: short < -0.5 ? 'text-[#B3261E]' : 'text-[#9AAFA2]' },
          { k: 'Excess', v: formatINR(over), sub: 'more paid than worked out', tone: over > 0.5 ? 'text-[#7A4B00]' : 'text-[#9AAFA2]' }
        ].map((t, i) => (
          <div key={t.k} className={cn('min-w-0 px-4 py-3', i % 2 === 1 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0', i === 2 && 'lg:border-l')}>
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">{t.k}</div>
            <div className={cn('mt-0.5 truncate text-[19px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
            <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>
          </div>
        ))}
      </div>

      {list.map((g) => {
        const id = n(g.journal_entry_id)
        const isOpen = open.has(id)
        const adjusted = (g.bills as Row[]).some((b) => !b.latest)
        return (
          <div key={id} className={cn('overflow-hidden rounded-[8px] border bg-white transition-shadow', isOpen ? 'border-[#B9CFBE] shadow-[0_2px_10px_rgba(10,31,23,.07)]' : 'border-[#DCE6DC] hover:border-[#C3D2C6]')}>
            {/* The voucher in one line — click to open its bills. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(id)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  toggle(id)
                }
              }}
              aria-expanded={isOpen}
              className={cn('flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left', isOpen ? 'bg-[#F3F8F2]' : 'hover:bg-[#FAFCF9]')}
            >
              <ChevronDown className={cn('h-4 w-4 flex-none text-[#8CA396] transition-transform', isOpen && 'rotate-180')} />
              <span className="flex min-w-[96px] flex-col">
                <span className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7A8C82]">Paid on</span>
                <span className="text-[13px] font-extrabold tabular-nums text-[#0A1F17]">{formatDate(String(g.paid_date))}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {(g.bills as Row[]).map((b) => (
                  <span key={String(b.id)} className={cn('rounded-[4px] px-1.5 py-0.5 text-[11px] font-extrabold', b.balance ? 'border border-[#F0C9C5] bg-[#FDF0EE] text-[#B3261E]' : 'bg-[#0B3D2E] text-[#C7F03F]')}>
                    {String(b.bd_no)}
                  </span>
                ))}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {periodsOf(g).map((p) => (
                  <span key={p} className="whitespace-nowrap rounded-full border border-[#D6E2D6] bg-white px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-[#33473E]">
                    {p}
                  </span>
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[#7A8C82]">
                {String(g.nbfc_name || '')} · {String(g.bank || '')}
              </span>
              <span className="text-right">
                <span className="block text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">Out of the bank</span>
                <span className="text-[14.5px] font-extrabold tabular-nums text-[#0B6B45]">{formatINR(n(g.net))}</span>
              </span>
              <span className="flex min-w-[150px] flex-col items-end gap-0.5">
                <DiffChip diff={n(g.diff)} big />
                {adjusted && <span className="text-[10px] font-bold text-[#0B6B45]">a later payment adjusted it</span>}
              </span>
              <button
                type="button"
                disabled={deleting === id}
                title="Delete this payment — its bank voucher and every bill's payment on it"
                aria-label="Delete this payment"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(g)
                }}
                className="flex h-8 w-8 flex-none items-center justify-center rounded-[5px] border border-[#F0C9C4] bg-white text-[#B3261E] hover:bg-[#FDECEA] disabled:opacity-50"
              >
                {deleting === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </div>

            {isOpen && (
              <div className="border-t border-[#E4ECE3]">
                {g.narration && (
                  <div className="flex gap-2 border-b border-[#F1F5F0] bg-[#FBFCFA] px-4 py-2 text-[11.5px] text-[#5A6B62]">
                    <span className="flex-none text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7A8C82]">Narration</span>
                    <span className="min-w-0 italic">{String(g.narration)}</span>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-[12.5px]">
                    <thead className="bg-[#F7FAF6] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                      <tr>
                        <th className="px-4 py-2 text-left">Bill</th>
                        <th className="px-2 py-2 text-left">Period</th>
                        <th className="px-2 py-2 text-right">Worked out</th>
                        <th className="px-2 py-2 text-right">Due then</th>
                        <th className="px-2 py-2 text-right">Paid</th>
                        <th className="px-2 py-2 text-right">TDS · Net</th>
                        <th className="px-2 py-2 text-right">At the time</th>
                        <th className="px-4 py-2 text-right">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(g.bills as Row[]).map((b) => (
                        <tr key={String(b.id)} className="border-t border-[#F1F5F0] align-top">
                          <td className="px-4 py-2.5">
                            <span className="rounded-[4px] bg-[#EEF3EE] px-1.5 py-0.5 text-[11.5px] font-extrabold text-[#0B3D2E]">{String(b.bd_no)}</span>
                            {b.balance && <span className="ml-1.5 rounded-[3px] border border-[#F0C9C5] bg-[#FDF0EE] px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase text-[#B3261E]">Balance</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 font-semibold tabular-nums text-[#0A1F17]">
                            {formatDate(String(b.from_date))} → {formatDate(String(b.to_date))}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#5A6B62]">{formatINR(n(b.due))}</td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#33473E]">
                            {formatINR(n(b.expected))}
                            {n(b.before) > 0.004 && <span className="block text-[10px] font-semibold text-[#8CA396]">after {formatINR(n(b.before))} paid before</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right font-extrabold tabular-nums text-[#0A1F17]">{formatINR(n(b.gross))}</td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">
                            <span className="text-[#5A6B62]">{formatINR(n(b.tds))}</span>
                            <span className="block font-bold text-[#0B6B45]">{formatINR(n(b.net))}</span>
                          </td>
                          <td className="px-2 py-2.5 text-right">
                            <span className={cn(!b.latest && Math.abs(n(b.paid_diff)) >= 0.5 && 'opacity-60 [&>span]:line-through')}>
                              <DiffChip diff={n(b.paid_diff)} />
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {b.latest ? (
                              <DiffChip diff={n(b.diff)} />
                            ) : (
                              <span className="inline-flex flex-col items-end">
                                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[#BFE3CB] bg-[#E9F5EE] px-2 py-0.5 text-[10.5px] font-extrabold text-[#0B6B45]">
                                  <CheckCircle2 className="h-3 w-3" /> ADJUSTED
                                </span>
                                <span className="mt-0.5 text-[10px] font-semibold text-[#5A6B62]">by {String(b.adjusted_by)}</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-[#DCE6DC] bg-[#F7FAF6] font-extrabold">
                        <td colSpan={4} className="px-4 py-2 text-[10.5px] uppercase tracking-[.1em] text-[#5A6B62]">
                          {(g.bills as Row[]).length} bill{(g.bills as Row[]).length === 1 ? '' : 's'} on this voucher
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(n(g.gross))}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                          <span className="text-[#5A6B62]">{formatINR(n(g.tds))}</span>
                          <span className="block text-[#0B6B45]">{formatINR(n(g.net))}</span>
                        </td>
                        <td />
                        <td className="px-4 py-2 text-right">
                          <DiffChip diff={n(g.diff)} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
