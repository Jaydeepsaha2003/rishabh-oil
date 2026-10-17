import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Search, X } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { exportRowsToExcel, NUM_MONEY } from '@/lib/excel'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const fyStart = (): string => {
  const d = new Date()
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}
type Kind = 'all' | 'payment' | 'receipt' | 'contra'
const typeKind = (t: string): Kind | null => {
  const u = String(t || '').toUpperCase()
  if (u.startsWith('PAYMENT')) return 'payment'
  if (u.startsWith('RECEIPT')) return 'receipt'
  if (u.startsWith('CONTRA')) return 'contra'
  return null
}
const REF_WORD: Record<string, string> = { agst_ref: 'Agst Ref', new_ref: 'New Ref', advance: 'Advance', on_account: 'On Account' }

// THE PAYMENT / RECEIPT REGISTER — Tally's two registers, and Contra, as one.
//
// Every payment, receipt and contra in the period, one line each: who it was
// paid to or received from, through which bank or cash, against which bills,
// and how much went out or came in. Picked down to one bank it reads as that
// bank's book — opening, each entry, and the balance after it — the same
// figures the Tally bank book uploaded under Tally Updation is checked
// against. An entry booked from that upload says so.
export function PayReceiptRegister({
  companyId,
  companyName,
  onOpen
}: {
  companyId?: number
  companyName: string
  onOpen: (v: Row) => void
}): React.JSX.Element {
  const [from, setFrom] = useState(fyStart)
  const [to, setTo] = useState(todayISO)
  const [data, setData] = useState<Row | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [bank, setBank] = useState('__all')
  const [shown, setShown] = useState(300)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      setData(await window.api.vouchers.cashflow({ from, to, companyId }))
    } catch (e) {
      toast.error((e as Error).message)
      setData({ vouchers: [], openings: {} })
    } finally {
      setLoading(false)
    }
  }, [companyId, from, to])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setShown(300), [q, kind, bank, from, to])

  // One line per voucher, read from the money side: the bank or cash it went
  // through, and everything else as the other side.
  const entries = useMemo(() => {
    const out: Row[] = []
    for (const v of ((data?.vouchers as Row[]) || []).slice().reverse()) {
      const k = typeKind(v.type)
      if (!k) continue
      const ls = v.lines as Row[]
      const money = ls.filter((l) => l.kind === 'money')
      const others = ls.filter((l) => l.kind !== 'money')
      // A contra moves money between two of ours: both sides are money lines.
      const banks = [...new Set(money.map((l) => String(l.account)))]
      const party = v.party || (k === 'contra' ? '' : others.map((l) => l.account).join(', '))
      const refs = others.flatMap((l) => (l.refs as Row[]).map((r) => `${REF_WORD[r.method] || r.method}${r.ref ? ' ' + r.ref : ''}`))
      out.push({
        ...v,
        kind: k,
        banks,
        party_or_ledger: party,
        against: [...new Set(refs)],
        // Into / out of the bank picked, or of bank and cash taken together.
        in_amt: bank === '__all' ? n(v.money_in) : money.filter((l) => l.account === bank && l.side === 'dr').reduce((t, l) => t + n(l.amount), 0),
        out_amt: bank === '__all' ? n(v.money_out) : money.filter((l) => l.account === bank && l.side === 'cr').reduce((t, l) => t + n(l.amount), 0),
        from_tally: /^Imported from Tally/i.test(String(v.narration || ''))
      })
    }
    return out
  }, [data, bank])
  const bankNames = useMemo(() => {
    const s = new Set<string>()
    for (const v of (data?.vouchers as Row[]) || []) for (const l of v.lines as Row[]) if (l.kind === 'money') s.add(String(l.account))
    return [...s].sort()
  }, [data])

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return entries.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false
      if (bank !== '__all' && !(e.banks as string[]).includes(bank)) return false
      if (!s) return true
      return [e.code, e.vch_no, e.type, e.party_or_ledger, e.narration, ...(e.against as string[]), ...(e.banks as string[]), String(e.dr)]
        .join(' ')
        .toLowerCase()
        .includes(s)
    })
  }, [entries, kind, bank, q])

  // The bank's own balance, entry by entry — only when one bank is picked and
  // nothing else narrows the list, or the balance would skip entries.
  const opening = bank !== '__all' ? n((data?.openings as Row)?.[bank]) : 0
  const running = bank !== '__all' && kind === 'all' && !q.trim()
  const balances = useMemo(() => {
    if (!running) return [] as number[]
    let b = opening
    return rows.map((e) => (b = Math.round((b + n(e.in_amt) - n(e.out_amt)) * 100) / 100))
  }, [rows, running, opening])
  const totIn = rows.reduce((t, e) => t + n(e.in_amt), 0)
  const totOut = rows.reduce((t, e) => t + n(e.out_amt), 0)

  async function download(): Promise<void> {
    await exportRowsToExcel({
      filename: `payment-receipt-register-${from}-to-${to}`,
      sheetName: 'Payments & receipts',
      title: `Payment / Receipt register — ${companyName}${bank !== '__all' ? ` · ${bank}` : ''}`,
      subtitle: `${formatDate(from)} to ${formatDate(to)} · ${rows.length} entries${running ? ` · opening ${formatINR(opening)}` : ''}`,
      columns: [
        { header: 'Date', key: 'date', value: (r) => formatDate(r.date) },
        { header: 'Voucher', key: 'code', value: (r) => r.code || r.vch_no },
        { header: 'Type', key: 'type', value: (r) => r.type },
        { header: 'Party / ledger', key: 'party', value: (r) => r.party_or_ledger },
        { header: 'Bank / cash', key: 'banks', value: (r) => (r.banks as string[]).join(', ') },
        { header: 'Against', key: 'against', value: (r) => (r.against as string[]).join(', ') },
        { header: 'Receipt', key: 'in', align: 'right', numFmt: NUM_MONEY, value: (r) => (n(r.in_amt) ? n(r.in_amt) : '') },
        { header: 'Payment', key: 'out', align: 'right', numFmt: NUM_MONEY, value: (r) => (n(r.out_amt) ? n(r.out_amt) : '') },
        ...(running ? [{ header: 'Balance', key: 'bal', align: 'right' as const, numFmt: NUM_MONEY, value: (r: Row) => balances[rows.indexOf(r)] }] : []),
        { header: 'From Tally', key: 'tally', value: (r) => (r.from_tally ? 'Yes' : '') },
        { header: 'Narration', key: 'narration', value: (r) => r.narration }
      ],
      rows
    })
  }

  const chip = (k: Kind, label: string): React.JSX.Element => {
    const on = kind === k
    const count = entries.filter((e) => (k === 'all' || e.kind === k) && (bank === '__all' || (e.banks as string[]).includes(bank))).length
    return (
      <button
        key={k}
        type="button"
        onClick={() => setKind(k)}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
          on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
        )}
      >
        {label}
        <span className={cn('rounded-[3px] px-1.5 text-[10.5px] tabular-nums', on ? 'bg-white/15' : 'bg-[#EAF0E9]')}>{count}</span>
      </button>
    )
  }
  const th = 'h-9 px-2.5 text-left text-[10px] font-extrabold uppercase tracking-[.1em] text-[#C7F03F] whitespace-nowrap'
  const td = 'px-2.5 py-2 align-top'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#F1F5EF] p-3">
      <div className="flex flex-wrap items-center gap-2.5 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
        <div className="mr-2 min-w-0">
          <div className="text-[15px] font-extrabold text-[#0A1F17]">Payment / Receipt Register</div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">Every payment, receipt and contra — who, which bank, against which bills</div>
        </div>
        <div className="w-[260px]">
          <Select value={bank} onValueChange={setBank}>
            <SelectTrigger className="h-10">
              <SelectValue placeholder="All banks & cash" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All banks &amp; cash</SelectItem>
              {bankNames.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-[150px]">
            <DatePicker value={from} max={to} onChange={(v) => setFrom(v || fyStart())} />
          </div>
          <span className="text-[12px] font-bold text-[#5A6B62]">to</span>
          <div className="w-[150px]">
            <DatePicker value={to} min={from} max={todayISO()} onChange={(v) => setTo(v || todayISO())} />
          </div>
        </div>
        <label className="flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
          <Search className="h-4 w-4 flex-none text-[#5A6B62]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Voucher, party, bill, amount…"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none placeholder:font-medium placeholder:text-[#9FB3A6]"
          />
          {!!q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear search">
              <X className="h-4 w-4 text-[#5A6B62]" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => void download()}
          disabled={!rows.length}
          className="h-10 rounded-[4px] bg-[#0B3D2E] px-3.5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-40"
        >
          Excel
        </button>
      </div>

      {/* The figures — each a way in. */}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {bank !== '__all' && (
          <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
            <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Opening</div>
            <div className="mt-1 text-[18px] font-bold tabular-nums">{formatINR(opening)}</div>
            <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">as on {formatDate(from)}</div>
          </div>
        )}
        <button type="button" onClick={() => setKind('receipt')} className={cn('rounded-[6px] border bg-white px-4 py-3 text-left hover:bg-[#F7FAF6]', kind === 'receipt' ? 'border-[#0B3D2E] ring-1 ring-[#0B3D2E]' : 'border-[#D6E2D6]')}>
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Received</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[#0B6B45]">{formatINR(totIn)}</div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">into {bank === '__all' ? 'bank and cash' : 'this bank'}</div>
        </button>
        <button type="button" onClick={() => setKind('payment')} className={cn('rounded-[6px] border bg-white px-4 py-3 text-left hover:bg-[#F7FAF6]', kind === 'payment' ? 'border-[#0B3D2E] ring-1 ring-[#0B3D2E]' : 'border-[#D6E2D6]')}>
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Paid</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[#B3261E]">{formatINR(totOut)}</div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">out of {bank === '__all' ? 'bank and cash' : 'this bank'}</div>
        </button>
        <button type="button" onClick={() => setKind('all')} className={cn('rounded-[6px] border bg-white px-4 py-3 text-left hover:bg-[#F7FAF6]', kind === 'all' ? 'border-[#0B3D2E] ring-1 ring-[#0B3D2E]' : 'border-[#D6E2D6]')}>
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{bank !== '__all' ? 'Closing' : 'Net'}</div>
          <div className={cn('mt-1 text-[18px] font-bold tabular-nums', (bank !== '__all' ? opening : 0) + totIn - totOut >= 0 ? 'text-[#0B6B45]' : 'text-[#B3261E]')}>
            {formatINR((bank !== '__all' ? opening : 0) + totIn - totOut)}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">{bank !== '__all' ? `as on ${formatDate(to)}` : 'received less paid'}</div>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {chip('all', 'All')}
        {chip('payment', 'Payments')}
        {chip('receipt', 'Receipts')}
        {chip('contra', 'Contra')}
        {bank !== '__all' && !running && (
          <span className="text-[11.5px] font-semibold text-[#8A5300]">The running balance shows on All, with the search cleared.</span>
        )}
      </div>

      <div className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-[12.5px]">
            <thead className="bg-[#0B3D2E]">
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                <th className={th}>Party / ledger</th>
                <th className={th}>Bank / cash</th>
                <th className={th}>Against</th>
                <th className={cn(th, 'text-right')}>Receipt</th>
                <th className={cn(th, 'text-right')}>Payment</th>
                {running && <th className={cn(th, 'text-right')}>Balance</th>}
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {running && (
                <tr className="border-t border-[#EAF0E9] bg-[#FBFDFA]">
                  <td className={cn(td, 'font-bold')} colSpan={7}>
                    Opening balance · {formatDate(from)}
                  </td>
                  <td className={cn(td, 'text-right font-bold tabular-nums')}>{formatINR(opening)}</td>
                  <td />
                </tr>
              )}
              {loading && !data ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    Reading the books…
                  </td>
                </tr>
              ) : !rows.length ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    No payment or receipt in this period matches.
                  </td>
                </tr>
              ) : (
                rows.slice(0, shown).map((e, i) => (
                  <tr key={n(e.id)} className={cn('border-t border-[#EAF0E9]', i % 2 ? 'bg-[#FBFDFA]' : 'bg-white')}>
                    <td className={cn(td, 'whitespace-nowrap font-bold tabular-nums')}>{formatDate(e.date)}</td>
                    <td className={td}>
                      <div className="whitespace-nowrap font-extrabold text-[#0A1F17]">{e.code || e.vch_no || '—'}</div>
                      <div className="flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[.04em] text-[#5A6B62]">
                        {e.type}
                        {e.from_tally && <span className="rounded-[2px] bg-[#FFF4DD] px-1 text-[9.5px] text-[#8A5300]">Tally</span>}
                      </div>
                    </td>
                    <td className={cn(td, 'max-w-[260px]')}>
                      <div className="font-semibold [overflow-wrap:anywhere]">{e.party_or_ledger || '—'}</div>
                      {e.narration && (
                        <div className="truncate text-[11px] italic text-[#8CA396]" title={e.narration}>
                          {e.narration}
                        </div>
                      )}
                    </td>
                    <td className={cn(td, 'max-w-[220px] text-[11.5px] font-semibold text-[#33473E]')}>{(e.banks as string[]).join(' → ') || '—'}</td>
                    <td className={cn(td, 'max-w-[200px] text-[11.5px] text-[#1B4E82]')}>
                      {(e.against as string[]).length ? (e.against as string[]).join(', ') : <span className="text-[#C3D2C6]">—</span>}
                    </td>
                    <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums text-[#0B6B45]')}>
                      {n(e.in_amt) > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <ArrowDownLeft className="h-3 w-3" />
                          {formatINR(e.in_amt)}
                        </span>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums text-[#B3261E]')}>
                      {n(e.out_amt) > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <ArrowUpRight className="h-3 w-3" />
                          {formatINR(e.out_amt)}
                        </span>
                      ) : (
                        ''
                      )}
                    </td>
                    {running && <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums')}>{formatINR(balances[i])}</td>}
                    <td className={td}>
                      <button
                        type="button"
                        title="Open it"
                        onClick={() => onOpen(e)}
                        className="rounded-[3px] p-1 text-[#5A6B62] hover:bg-[#EAF0E9] hover:text-[#0B3D2E]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
              {!!rows.length && (
                <tr className="border-t-2 border-[#D6E2D6] bg-[#F7FAF6] font-extrabold">
                  <td className={td} colSpan={5}>
                    Total · {rows.length} entries
                  </td>
                  <td className={cn(td, 'text-right tabular-nums text-[#0B6B45]')}>{formatINR(totIn)}</td>
                  <td className={cn(td, 'text-right tabular-nums text-[#B3261E]')}>{formatINR(totOut)}</td>
                  {running && <td className={cn(td, 'text-right tabular-nums')}>{formatINR(opening + totIn - totOut)}</td>}
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > shown && (
          <div className="border-t border-[#EAF0E9] px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={() => setShown((s) => s + 300)}
              className="h-8 rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
            >
              Show 300 more · {rows.length - shown} left
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
