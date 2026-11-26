import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, Loader2, Pencil, Trash2, Wallet } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
    return <span className="whitespace-nowrap text-[12px] font-semibold text-[#7A8C82]">Settled</span>
  return diff < 0 ? (
    <span className={cn('whitespace-nowrap rounded-full border border-[#F0C9C4] bg-[#FDECEA] font-extrabold tabular-nums text-[#B3261E]', size)}>SHORTFALL {formatINR(-diff)}</span>
  ) : (
    <span className={cn('whitespace-nowrap rounded-full border border-[#E8C27A] bg-[#FFF4DC] font-extrabold tabular-nums text-[#7A4B00]', size)}>EXCESS {formatINR(diff)}</span>
  )
}

// "Oct 2026 payout" — the month(s) the interest covers, from the bills' periods.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const payoutOf = (g: Row): string => {
  const froms = (g.bills as Row[]).map((b) => String(b.from_date || '').slice(0, 7)).filter(Boolean).sort()
  const tos = (g.bills as Row[]).map((b) => String(b.to_date || '').slice(0, 7)).filter(Boolean).sort()
  if (!froms.length || !tos.length) return ''
  const a = froms[0]
  const z = tos[tos.length - 1]
  const name = (ym: string): string => MON[Number(ym.slice(5, 7)) - 1] || ym
  if (a === z) return `${name(a)} ${a.slice(0, 4)}`
  return a.slice(0, 4) === z.slice(0, 4) ? `${name(a)}–${name(z)} ${z.slice(0, 4)}` : `${name(a)} ${a.slice(0, 4)}–${name(z)} ${z.slice(0, 4)}`
}
const periodsOf = (g: Row): string[] => [...new Set((g.bills as Row[]).map((b) => `${formatDate(String(b.from_date))} → ${formatDate(String(b.to_date))}`))]

export function BdCumulativePayments({
  nbfcId,
  toolbar,
  onPayBalance,
  onChanged
}: {
  nbfcId: number | null
  toolbar?: React.ReactNode
  // Open Pay interest on these days for this NBFC — a short bill then offers just its balance.
  onPayBalance?: (v: { nbfc_id: number; from: string; to: string }) => void
  // A payment deleted, edited or converted here — the page behind re-reads its bills.
  onChanged?: () => void
}): React.JSX.Element {
  const [raw, setRaw] = useState<Row[] | null>(null)
  // Which payments: all, one month, or a date range (by the day paid).
  const [per, setPer] = useState<'all' | 'month' | 'range'>('all')
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [pFrom, setPFrom] = useState('')
  const [pTo, setPTo] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [rev, setRev] = useState(0)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [editing, setEditing] = useState<Row | null>(null)
  const [converting, setConverting] = useState(false)
  // OLD PAYMENTS, BOOKED AS ONE VOUCHER → via the NBFC (journal + payment), all at once.
  async function convertAll(gs: Row[]): Promise<void> {
    const ids = gs.filter((g) => !g.via_nbfc).map((g) => n(g.journal_entry_id))
    if (!ids.length) return
    if (
      !window.confirm(
        `Book ${ids.length} interest payment${ids.length === 1 ? '' : 's'} through the NBFC?

Each becomes a JOURNAL (Dr interest / Cr NBFC, Cr TDS) and its PAYMENT (Dr NBFC / Cr bank). Amounts, dates, bank, TDS ledger and PAY numbers stay the same. Each can be switched back with Edit.`
      )
    )
      return
    setConverting(true)
    try {
      const r = await window.api.billDiscounting.convertInterestPayments(ids, true)
      if (r.converted) toast.success(`${r.converted} payment${r.converted === 1 ? '' : 's'} now booked via the NBFC`)
      if (r.failed.length) toast.error(`${r.failed.length} not converted — ${r.failed.slice(0, 3).join(' · ')}`, { duration: 12000 })
      setRev((v) => v + 1)
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setConverting(false)
    }
  }
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
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setDeleting(null)
    }
  }
  useEffect(() => {
    let live = true
    setRaw(null)
    window.api.billDiscounting
      .cumulativePayments(nbfcId)
      .then((r) => {
        if (!live) return
        setRaw(r)
        // The newest opens by itself; the rest wait for a click.
        // Every voucher starts closed; a click opens it.
        setOpen(new Set())
      })
      .catch((e) => toast.error((e as Error).message))
    return () => {
      live = false
    }
  }, [nbfcId, rev])

  const inPeriod = (g: Row): boolean => {
    const d = String(g.paid_date || '').slice(0, 10)
    if (per === 'month') return d.slice(0, 7) === month
    if (per === 'range') return (!pFrom || d >= pFrom) && (!pTo || d <= pTo)
    return true
  }
  // THE TOOLBAR — the NBFC on the left, the period in the right corner; shown in every state.
  const bar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-[#DCE6DC] bg-[#F7FAF6] px-3 py-2.5">
      {toolbar}
      {raw != null && raw.length > 0 && (
        <span className="text-[11.5px] font-semibold text-[#7A8C82]">
          {raw.filter(inPeriod).length} of {raw.length} voucher{raw.length === 1 ? '' : 's'}
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Paid in</span>
        <span className="flex h-9 rounded-[4px] border border-[#C9DCCF] bg-white p-0.5">
          {(
            [
              ['all', 'All'],
              ['month', 'Month'],
              ['range', 'Date range']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setPer(k)}
              className={cn('rounded-[3px] px-3 text-[12px] font-extrabold', per === k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
            >
              {label}
            </button>
          ))}
        </span>
        {per === 'month' && (
          <input
            type="month"
                  // The whole box opens the picker, not only its calendar icon.
                  onClick={(e) => {
                    try {
                      e.currentTarget.showPicker?.()
                    } catch {
                      /* a browser without showPicker keeps the icon */
                    }
                  }}
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="Month"
            className="cursor-pointer h-9 rounded-[4px] border border-[#C9DCCF] bg-white px-2.5 text-[13px] font-semibold"
          />
        )}
        {per === 'range' && (
          <>
            <div className="w-[150px]">
              <DatePicker value={pFrom} max={pTo || undefined} onChange={(x) => setPFrom(String(x || ''))} placeholder="From" />
            </div>
            <span className="text-[11px] font-bold text-[#5A6B62]">to</span>
            <div className="w-[150px]">
              <DatePicker value={pTo} min={pFrom || undefined} onChange={(x) => setPTo(String(x || ''))} placeholder="To" />
            </div>
          </>
        )}
      </span>
    </div>
  )

  if (raw == null)
    return (
      <div className="space-y-3">
        {bar}
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
        </div>
      </div>
    )
  if (!raw.length)
    return (
      <div className="space-y-3">
        {bar}
        <div className="rounded-[6px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">
          No payment made through Pay cumulative interest{nbfcId ? ' with this NBFC' : ''} yet.
        </div>
      </div>
    )

  const list = raw.filter(inPeriod)
  // Only what is still open: each bill's days counted once, on their latest payment.
  const bills = list.flatMap((g) => g.bills as Row[])
  // Per payment, with interest paid alongside a repayment already set against it.
  const short = list.reduce((t, g) => t + n(g.short), 0)
  const over = list.reduce((t, g) => t + n(g.over), 0)
  const toggle = (id: number): void =>
    setOpen((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="space-y-3">
      {bar}
      {list.length === 0 ? (
        <div className="rounded-[6px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">No payment in this period.</div>
      ) : (
      <>
      {list.some((g) => !g.via_nbfc) && (
        <div className="flex flex-wrap items-center gap-3 rounded-[8px] border border-[#C6DAF0] bg-[#F4F8FD] px-4 py-2.5">
          <span className="text-[12.5px] font-bold text-[#1B4E82]">
            {list.filter((g) => !g.via_nbfc).length} of {list.length} payment{list.length === 1 ? '' : 's'} shown {list.filter((g) => !g.via_nbfc).length === 1 ? 'is' : 'are'} booked as one voucher
          </span>
          <button
            type="button"
            disabled={converting}
            onClick={() => void convertAll(list)}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-[6px] bg-[#1B4E82] px-4 text-[12px] font-extrabold text-white hover:bg-[#163F69] disabled:opacity-50"
          >
            {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Convert to via NBFC
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white sm:grid-cols-3">
        {[
          {
            k: 'Paid out of the bank',
            v: formatINR(list.reduce((t, g) => t + n(g.net) + n(g.rep_net), 0)),
            sub: `interest ${formatINR(list.reduce((t, g) => t + n(g.gross) + n(g.rep_gross), 0))}${list.some((g) => n(g.rep_net) > 0) ? ` · incl. ${formatINR(list.reduce((t, g) => t + n(g.rep_net), 0))} paid with repayments` : ''}`,
            tone: 'text-[#0B6B45]'
          },
          { k: 'Shortfall still open', v: formatINR(Math.abs(short)), sub: '', tone: short < -0.5 ? 'text-[#B3261E]' : 'text-[#9AAFA2]' },
          { k: 'Excess', v: formatINR(over), sub: '', tone: over > 0.5 ? 'text-[#7A4B00]' : 'text-[#9AAFA2]' }
        ].map((t, i) => (
          <div key={t.k} className={cn('min-w-0 px-4 py-3', i > 0 && 'border-t border-[#EEF3EE] sm:border-l sm:border-t-0')}>
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">{t.k}</div>
            <div className={cn('mt-0.5 truncate text-[19px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
            {t.sub && <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>}
          </div>
        ))}
      </div>

      {/* ONE TABLE, a row per voucher — click a row to open its bills. */}
      <div className="overflow-x-auto rounded-[8px] border border-[#DCE6DC] bg-white">
        <table className="w-full min-w-[1080px] text-[12.5px]">
          <thead className="bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#DCEFE4]">
            <tr>
              <th className="w-8 px-3 py-2.5" />
              <th className="px-2 py-2.5 text-left">Paid on</th>
              <th className="px-2 py-2.5 text-left">Voucher</th>
              <th className="px-2 py-2.5 text-left">Bills</th>
              <th className="px-2 py-2.5 text-left">Payout</th>
              <th className="px-2 py-2.5 text-left">Period</th>
              <th className="px-2 py-2.5 text-left">NBFC · bank</th>
              <th className="px-2 py-2.5 text-right">Interest</th>
              <th className="px-2 py-2.5 text-right">TDS</th>
              <th className="px-2 py-2.5 text-right text-[#C7F03F]">Out of the bank</th>
              <th className="px-2 py-2.5 text-right">Status</th>
              <th className="w-12 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {list.map((g) => {
              const id = n(g.journal_entry_id)
              const isOpen = open.has(id)
              return (
                <Fragment key={id}>
                  <tr
                    onClick={() => toggle(id)}
                    aria-expanded={isOpen}
                    className={cn('cursor-pointer border-t border-[#EEF3EE] align-middle', isOpen ? 'bg-[#F3F8F2]' : 'hover:bg-[#FAFCF9]')}
                  >
                    <td className="px-3 py-2.5">
                      <ChevronDown className={cn('h-4 w-4 text-[#8CA396] transition-transform', isOpen && 'rotate-180')} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-extrabold tabular-nums text-[#0A1F17]">{formatDate(String(g.paid_date))}</td>
                    <td className="whitespace-nowrap px-2 py-2.5">
                      <div className="font-bold text-[#33473E]">{String(g.pay_code || g.vch_no || `#${id}`)}</div>
                      {g.rep_only ? (
                        <div className="mt-0.5 inline-flex items-center rounded-[3px] bg-[#EAF0FA] px-1.5 py-[1px] text-[10px] font-extrabold text-[#1B4E82]" title="Interest paid in the same bank debit as the bill's repayment">
                          with {String(((g.bills as Row[])[0] || {}).bd_no || '')}&rsquo;s repayment{g.journal_code ? ` · ${String(g.journal_code)}` : ''}
                        </div>
                      ) : g.via_nbfc && (
                        <div className="mt-0.5 inline-flex items-center rounded-[3px] bg-[#EAF0FA] px-1.5 py-[1px] text-[10px] font-extrabold text-[#1B4E82]" title="Booked through the NBFC: a journal (Dr interest / Cr NBFC, Cr TDS) and this payment (Dr NBFC / Cr bank)">
                          via NBFC · {String(g.journal_code || 'journal')}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {(g.bills as Row[]).map((b) => (
                          <span key={String(b.id)} className={cn('rounded-[4px] px-1.5 py-0.5 text-[11px] font-extrabold', b.balance ? 'border border-[#F0C9C5] bg-[#FDF0EE] text-[#B3261E]' : 'bg-[#0B3D2E] text-[#C7F03F]')}>
                            {String(b.bd_no)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[12px] font-extrabold text-[#0A1F17]">{payoutOf(g) || '—'}</td>
                    <td className="px-2 py-2.5">
                      {periodsOf(g).map((p) => (
                        <div key={p} className="whitespace-nowrap text-[11.5px] font-semibold tabular-nums text-[#33473E]">
                          {p}
                        </div>
                      ))}
                    </td>
                    <td className="max-w-[260px] px-2 py-2.5">
                      <div className="truncate text-[12px] font-bold text-[#0A1F17]">{String(g.nbfc_name || '')}</div>
                      <div className="truncate text-[10.5px] font-semibold text-[#7A8C82]">{String(g.bank || '')}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#33473E]">{formatINR(n(g.gross))}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#5A6B62]">{formatINR(n(g.tds))}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">
                      <span className="block font-extrabold text-[#0B6B45]">{formatINR(n(g.net))}</span>
                      {n(g.rep_net) > 0 && (
                        <span className="block text-[10.5px] font-bold text-[#5A6B62]" title="With the interest paid in the repayment, on the line below">
                          with the line below {formatINR(n(g.net) + n(g.rep_net))}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <span className="inline-flex flex-col items-end gap-0.5">
                        <DiffChip diff={n(g.diff)} />
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      {(() => {
                        const shortBill = (g.bills as Row[]).find((b) => n(b.diff) < -0.5)
                        if (!shortBill || !onPayBalance || n(g.short) > -0.5) return null
                        return (
                          <button
                            type="button"
                            title="Pay what is still short on these days"
                            aria-label="Pay balance"
                            onClick={(e) => {
                              e.stopPropagation()
                              onPayBalance({ nbfc_id: n(g.nbfc_id), from: String(shortBill.from_date), to: String(shortBill.to_date) })
                            }}
                            className="mr-1 inline-flex h-8 items-center gap-1 rounded-[5px] border border-[#F0C9C4] bg-white px-2 text-[11px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA]"
                          >
                            <Wallet className="h-3.5 w-3.5" /> Pay balance
                          </button>
                        )
                      })()}
                      {g.rep_only ? (
                        <span className="text-[10.5px] font-semibold text-[#7A8C82]">edit it on the bill&rsquo;s repayment</span>
                      ) : (
                      <>
                      <button
                        type="button"
                        title="Edit this payment — amounts, date, bank, TDS ledger, note"
                        aria-label="Edit this payment"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing(g)
                        }}
                        className="mr-1 inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[#C9DCCF] bg-white text-[#0B3D2E] hover:bg-[#F0F8F3]"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={deleting === id}
                        title="Delete this payment — its bank voucher and every bill's payment on it"
                        aria-label="Delete this payment"
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(g)
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[#F0C9C4] bg-white text-[#B3261E] hover:bg-[#FDECEA] disabled:opacity-50"
                      >
                        {deleting === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                      </>
                      )}
                    </td>
                  </tr>
                  {/* INTEREST PAID WITH A REPAYMENT on these days — a payment of its
                      own (its own bank debit), so a line of its own, hung off the
                      payment it is counted with. */}
                  {((g.reps as Row[]) || []).map((r) => (
                    <tr key={`rep${String(r.id)}`} className="border-t border-dashed border-[#D5E2EE] bg-[#F6F9FD] align-middle">
                      <td className="px-3 py-2 text-right text-[#9FB6CF]">&#8627;</td>
                      <td className="whitespace-nowrap px-2 py-2 font-bold tabular-nums text-[#0A1F17]">{formatDate(String(r.repay_date))}</td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <div className="font-bold text-[#33473E]">{String(r.pay_code || '—')}</div>
                        <div className="mt-0.5 inline-flex items-center rounded-[3px] bg-[#EAF0FA] px-1.5 py-[1px] text-[10px] font-extrabold text-[#1B4E82]">
                          with {String(r.bd_no)}&rsquo;s repayment
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <span className="rounded-[4px] border border-[#C6DAF0] bg-white px-1.5 py-0.5 text-[11px] font-extrabold text-[#1B4E82]">{String(r.bd_no)}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-[12px] font-extrabold text-[#0A1F17]">{payoutOf(g) || '—'}</td>
                      <td className="px-2 py-2 text-[11.5px] font-semibold text-[#5A6B62]">counted with {String(g.pay_code || g.vch_no || 'the payment above')}</td>
                      <td className="max-w-[260px] px-2 py-2">
                        <div className="truncate text-[12px] font-bold text-[#0A1F17]">{String(g.nbfc_name || '')}</div>
                        <div className="truncate text-[10.5px] font-semibold text-[#7A8C82]">in the repayment&rsquo;s bank debit</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#33473E]">{formatINR(n(r.gross))}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#5A6B62]">{formatINR(n(r.tds))}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-extrabold tabular-nums text-[#0B6B45]">{formatINR(n(r.net))}</td>
                      <td className="px-2 py-2 text-right text-[10.5px] font-semibold text-[#7A8C82]">status on the line above</td>
                      <td />
                    </tr>
                  ))}
                  {isOpen && (
                    <tr className="bg-[#F3F8F2]">
                      <td />
                      <td colSpan={11} className="px-2 pb-3 pt-0">
                        <div className="overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white">

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
                                  <span className="inline-flex flex-col items-end gap-1">
                                    <DiffChip diff={n(b.diff)} />
                                    {n(b.diff) < -0.5 && onPayBalance && (
                                      <button
                                        type="button"
                                        onClick={() => onPayBalance({ nbfc_id: n(g.nbfc_id), from: String(b.from_date), to: String(b.to_date) })}
                                        className="inline-flex items-center gap-1 rounded-[4px] border border-[#F0C9C4] bg-white px-2 py-0.5 text-[10.5px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA]"
                                      >
                                        <Wallet className="h-3 w-3" /> Pay balance
                                      </button>
                                    )}
                                  </span>
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
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-[1.5px] border-[#C9DCCF] bg-[#F5F8F4] font-extrabold">
              <td colSpan={7} className="px-3 py-2.5 text-[10.5px] uppercase tracking-[.1em] text-[#33473E]">
                Total · {list.length} voucher{list.length === 1 ? '' : 's'}
                {list.some((g) => ((g.reps as Row[]) || []).length) ? ` + ${list.reduce((t, g) => t + ((g.reps as Row[]) || []).length, 0)} with repayments` : ''}
              </td>
              <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{formatINR(list.reduce((t, g) => t + n(g.gross) + n(g.rep_gross), 0))}</td>
              <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#5A6B62]">
                {formatINR(list.reduce((t, g) => t + n(g.tds) + ((g.reps as Row[]) || []).reduce((s, r) => s + n(r.tds), 0), 0))}
              </td>
              <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#0B6B45]">{formatINR(list.reduce((t, g) => t + n(g.net) + n(g.rep_net), 0))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      </>
      )}
      {editing && (
        <EditCumulativePayment
          g={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setRev((v) => v + 1)
      onChanged?.()
          }}
        />
      )}
    </div>
  )
}

/** Edit one voucher: what each bill was paid, the date, bank, TDS ledger and note. Re-posted in place. */
function EditCumulativePayment({ g, onClose, onSaved }: { g: Row; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const bills = g.bills as Row[]
  const narr = String(g.narration || '')
  const [date, setDate] = useState(String(g.paid_date || ''))
  const [viaNbfc, setViaNbfc] = useState(!!g.via_nbfc)
  const [bank, setBank] = useState(String(g.bank || ''))
  const [tdsLedger, setTdsLedger] = useState('')
  const [note, setNote] = useState(narr.includes(' · ') ? narr.slice(narr.lastIndexOf(' · ') + 3) : '')
  const [amt, setAmt] = useState<Record<number, string>>(() => Object.fromEntries(bills.map((b) => [n(b.id), String(n(b.gross))])))
  const [banks, setBanks] = useState<string[]>([])
  const [tdsLedgers, setTdsLedgers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    window.api.journal
      .accountNames()
      .then((a) => {
        setBanks(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(String(x.acc_group || ''))).map((x) => String(x.name)))
        setTdsLedgers(a.filter((x) => /TDS/i.test(String(x.name || '')) && !/RECE|RECOV|RECIA|RECEV/i.test(String(x.name || ''))).map((x) => String(x.name)))
      })
      .catch(() => undefined)
  }, [])
  // Each bill's TDS % as it was paid (TDS ÷ interest).
  const pct = (b: Row): number => (n(b.gross) > 0 ? (n(b.tds) / n(b.gross)) * 100 : 0)
  const fig = (b: Row): { gross: number; tds: number; net: number } => {
    const gross = Math.round(n(amt[n(b.id)]) * 100) / 100
    const tds = Math.round(((gross * pct(b)) / 100) * 100) / 100
    return { gross, tds, net: Math.round((gross - tds) * 100) / 100 }
  }
  const tot = bills.reduce((t, b) => ({ gross: t.gross + fig(b).gross, tds: t.tds + fig(b).tds, net: t.net + fig(b).net }), { gross: 0, tds: 0, net: 0 })
  async function save(): Promise<void> {
    setBusy(true)
    try {
      await window.api.billDiscounting.editCumulativePayment({
        entry_id: n(g.journal_entry_id),
        paid_date: date,
        via_nbfc: viaNbfc,
        bank_account: bank || null,
        tds_ledger: tdsLedger || null,
        note,
        amounts: Object.fromEntries(bills.map((b) => [String(n(b.id)), fig(b).gross]))
      })
      toast.success(`Payment updated — ${formatINR(tot.net)} out of the bank`)
      onSaved()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[860px] flex-col gap-0 overflow-hidden p-0 [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 py-3.5 text-white">
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">Cumulative interest</div>
          <DialogTitle className="text-[16px] font-extrabold text-white">
            Edit payment {String(g.vch_no || '')} · {formatDate(String(g.paid_date))}
          </DialogTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="overflow-x-auto rounded-[6px] border border-[#DCE6DC]">
            <table className="w-full min-w-[620px] text-[12.5px]">
              <thead className="bg-[#F5F8F4] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                <tr>
                  <th className="px-3 py-2 text-left">Bill</th>
                  <th className="px-2 py-2 text-left">Period</th>
                  <th className="px-2 py-2 text-right">Worked out</th>
                  <th className="px-2 py-2 text-right">Interest paid</th>
                  <th className="px-2 py-2 text-right">TDS</th>
                  <th className="px-3 py-2 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={String(b.id)} className="border-t border-[#EFF3EE]">
                    <td className="px-3 py-2">
                      <span className="rounded-[4px] bg-[#0B3D2E] px-1.5 py-0.5 text-[11.5px] font-extrabold text-[#C7F03F]">{String(b.bd_no)}</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-[#33473E]">
                      {formatDate(String(b.from_date))} → {formatDate(String(b.to_date))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#5A6B62]">{formatINR(n(b.due))}</td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        inputMode="decimal"
                        value={amt[n(b.id)] ?? ''}
                        onChange={(e) => setAmt((p) => ({ ...p, [n(b.id)]: e.target.value.replace(/[^0-9.]/g, '') }))}
                        aria-label={`Interest paid on ${String(b.bd_no)}`}
                        className="h-8 w-[130px] rounded-[5px] border border-[#0B3D2E] bg-white px-2 text-right text-[12.5px] font-extrabold tabular-nums outline-none focus:ring-2 focus:ring-[#0B6B45]/20"
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#5A6B62]">{formatINR(fig(b).tds)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-[#0B6B45]">{formatINR(fig(b).net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[#DCE6DC] bg-[#F5F8F4] font-extrabold">
                  <td colSpan={3} className="px-3 py-2 text-[10.5px] uppercase tracking-[.1em] text-[#33473E]">
                    Total
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(tot.gross)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(tot.tds)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#0B6B45]">{formatINR(tot.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <span className={lbl}>Payment date</span>
              <DatePicker value={date} onChange={(v) => v && setDate(v)} />
            </div>
            <div>
              <span className={lbl}>Paid from bank</span>
              <Select searchable value={bank} onValueChange={setBank}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Keep the bank" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {[...new Set([...(bank ? [bank] : []), ...banks])].map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className={lbl}>TDS ledger</span>
              <Select searchable value={tdsLedger} onValueChange={setTdsLedger}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Keep the TDS ledger" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {tdsLedgers.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <span className={lbl}>Post as</span>
            <span className="flex h-10 w-fit rounded-[7px] border border-[#C9DCCF] bg-white p-0.5">
              {(
                [
                  [false, 'One payment voucher'],
                  [true, 'Via NBFC — journal + payment']
                ] as const
              ).map(([k, label]) => (
                <button
                  key={String(k)}
                  type="button"
                  onClick={() => setViaNbfc(k)}
                  className={cn('whitespace-nowrap rounded-[5px] px-3 text-[12px] font-semibold', viaNbfc === k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div>
            <span className={lbl}>
              Note <span className="text-[#B3261E]">*</span> <span className="normal-case tracking-normal text-[#8CA396]">— goes into the narration</span>
            </span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-[#C9DCCF] bg-white px-2.5 text-[13px] font-semibold outline-none focus:border-[#0B6B45]"
            />
          </div>
        </div>
        <div className="flex flex-none justify-end gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E]">
            Cancel
          </button>
          <button
            type="button"
            data-ctrl-a
            disabled={busy || !note.trim()}
            onClick={() => void save()}
            className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save · {formatINR(tot.net)} out of the bank
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
