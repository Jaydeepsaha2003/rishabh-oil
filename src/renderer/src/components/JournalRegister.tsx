import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Search, X } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
import { SearchSelect } from '@/components/SearchSelect'
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

// THE JOURNAL REGISTER — Tally's JV register. Every journal voucher in the
// period, one line each: the ledgers debited, the ledgers credited, the
// amount and the narration. Read from the same opened-up vouchers as the
// Cashflow Register (vouchers:cashflow), asked for JOURNAL only.
export function JournalRegister({
  companyId,
  companyName,
  onOpen,
  period
}: {
  companyId?: number
  companyName: string
  onOpen: (v: Row) => void
  /** The module's period (Alt+F2 / the header). Followed whenever it changes. */
  period?: { from: string; to: string }
}): React.JSX.Element {
  const [from, setFrom] = useState(() => period?.from || fyStart())
  const [to, setTo] = useState(() => period?.to || todayISO())
  useEffect(() => {
    if (!period || (!period.from && !period.to)) return
    setFrom(period.from || fyStart())
    setTo(period.to || todayISO())
  }, [period?.from, period?.to]) // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [ledger, setLedger] = useState('')
  const [shown, setShown] = useState(300)

  // Only the newest request sets the rows (the period arrives twice on opening).
  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!companyId) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const r = await window.api.vouchers.cashflow({ from, to, companyId, vchType: 'JOURNAL' })
      if (mine === seq.current) setData(((r.vouchers as Row[]) || []).slice().reverse())
    } catch (e) {
      if (mine === seq.current) {
        toast.error((e as Error).message)
        setData([])
      }
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [companyId, from, to])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setShown(300), [q, ledger, from, to])

  const entries = useMemo(
    () =>
      (data || []).map((v): Row => {
        const ls = (v.lines as Row[]) || []
        return {
          ...v,
          drs: ls.filter((l) => l.side === 'dr'),
          crs: ls.filter((l) => l.side === 'cr'),
          from_tally: /^Imported from Tally/i.test(String(v.narration || ''))
        }
      }),
    [data]
  )
  const ledgerNames = useMemo(() => {
    const s = new Set<string>()
    for (const v of data || []) for (const l of (v.lines as Row[]) || []) s.add(String(l.account))
    return [...s].sort()
  }, [data])

  // Text, or an amount typed with or without commas (1,23,050 · 123050).
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    const num = s.replace(/[,\s₹]/g, '')
    const isNum = /^\d+(\.\d+)?$/.test(num)
    return entries.filter((e) => {
      if (ledger && !(e.lines as Row[]).some((l) => String(l.account) === ledger)) return false
      if (!s) return true
      if (isNum && (e.lines as Row[]).some((l) => Math.abs(n(l.amount) - Number(num)) < 1 || String(Math.round(n(l.amount) * 100) / 100).startsWith(num)))
        return true
      return [e.code, e.vch_no, e.narration, ...(e.lines as Row[]).map((l) => l.account)].join(' ').toLowerCase().includes(s)
    })
  }, [entries, ledger, q])
  const total = rows.reduce((t, e) => t + n(e.dr), 0)
  const fromTally = rows.filter((e) => e.from_tally).length

  async function download(): Promise<void> {
    await exportRowsToExcel({
      filename: `journal-register-${from}-to-${to}`,
      sheetName: 'Journals',
      title: `Journal register — ${companyName}${ledger ? ` · ${ledger}` : ''}`,
      subtitle: `${formatDate(from)} to ${formatDate(to)} · ${rows.length} journals`,
      columns: [
        { header: 'Date', key: 'date', value: (r) => formatDate(r.date) },
        { header: 'Voucher', key: 'code', value: (r) => r.code || r.vch_no },
        { header: 'Debit', key: 'drs', value: (r) => (r.drs as Row[]).map((l) => `${l.account} ${n(l.amount).toFixed(2)}`).join('; ') },
        { header: 'Credit', key: 'crs', value: (r) => (r.crs as Row[]).map((l) => `${l.account} ${n(l.amount).toFixed(2)}`).join('; ') },
        { header: 'Amount', key: 'dr', align: 'right', numFmt: NUM_MONEY, total: 'sum', value: (r) => n(r.dr) },
        { header: 'From Tally', key: 'tally', value: (r) => (r.from_tally ? 'Yes' : '') },
        { header: 'Narration', key: 'narration', width: 50, value: (r) => r.narration }
      ],
      rows
    })
  }

  const th = 'h-9 px-2.5 text-left text-[10px] font-extrabold uppercase tracking-[.1em] text-[#C7F03F] whitespace-nowrap'
  const td = 'px-2.5 py-2 align-top'
  const legs = (ls: Row[], tone: string): React.JSX.Element => (
    <div className="grid gap-0.5">
      {ls.map((l, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{l.account}</span>
          {ls.length > 1 && <span className={cn('flex-none text-[11px] font-bold tabular-nums', tone)}>{formatINR(n(l.amount))}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#F1F5EF] p-3">
      <div className="flex flex-wrap items-center gap-2.5 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
        <div className="mr-2 min-w-0 text-[15px] font-extrabold text-[#0A1F17]">Journal Register</div>
        <div className="w-[260px] max-w-full">
          <SearchSelect
            value={ledger}
            options={[{ value: '', label: 'All ledgers' }, ...ledgerNames.map((x) => ({ value: x, label: x }))]}
            onChange={setLedger}
            placeholder="All ledgers"
            title="Only the journals with a line on this ledger"
          />
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
            placeholder="Amount (1,23,050 or 123050), voucher, ledger, narration…"
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

      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {[
          { k: 'Journals', v: String(rows.length), sub: ledger ? `on ${ledger}` : `${formatDate(from)} to ${formatDate(to)}`, tone: 'text-[#0A1F17]' },
          { k: 'Amount', v: formatINR(total), sub: 'Dr = Cr, on what is shown', tone: 'text-[#1B4E82]' },
          { k: 'From Tally', v: String(fromTally), sub: `${rows.length - fromTally} entered here`, tone: 'text-[#8A5300]' }
        ].map((c) => (
          <div key={c.k} className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
            <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{c.k}</div>
            <div className={cn('mt-1 truncate text-[18px] font-bold tabular-nums', c.tone)}>{c.v}</div>
            <div className="mt-0.5 truncate text-[11px] font-semibold text-[#8CA396]">{c.sub}</div>
          </div>
        ))}
      </div>

      <div className="relative overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
        {loading && !!data && (
          <div className="absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-full bg-[#C7F03F] px-2.5 py-0.5 text-[10.5px] font-extrabold text-[#0B3D2E] shadow">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#0B3D2E]" /> Refreshing…
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-[12.5px]">
            <thead className="bg-[#0B3D2E]">
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                <th className={th}>Debit</th>
                <th className={th}>Credit</th>
                <th className={cn(th, 'text-right')}>Amount</th>
                <th className={th}>Narration</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk${i}`} className="border-t border-[#EAF0E9]">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="h-3.5 animate-pulse rounded bg-[#EEF3EC]" style={{ width: `${88 - i * 9}%` }} />
                    </td>
                  </tr>
                ))
              ) : !rows.length ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    No journal in this period matches.
                  </td>
                </tr>
              ) : (
                rows.slice(0, shown).map((e, i) => (
                  <tr
                    key={n(e.id)}
                    onClick={() => onOpen(e)}
                    className={cn('cursor-pointer border-t border-[#EAF0E9] hover:bg-[#F4F9EF]', i % 2 ? 'bg-[#FBFDFA]' : 'bg-white')}
                  >
                    <td className={cn(td, 'whitespace-nowrap font-bold tabular-nums')}>{formatDate(e.date)}</td>
                    <td className={td}>
                      <div className="whitespace-nowrap font-extrabold text-[#0A1F17]">{e.code || e.vch_no || '—'}</div>
                      {e.from_tally && <span className="rounded-[2px] bg-[#FFF4DD] px-1 text-[9.5px] font-bold uppercase text-[#8A5300]">Tally</span>}
                    </td>
                    <td className={cn(td, 'min-w-[220px] max-w-[300px] text-[#0B6B45]')}>{legs(e.drs as Row[], 'text-[#0B6B45]')}</td>
                    <td className={cn(td, 'min-w-[220px] max-w-[300px] text-[#B3261E]')}>{legs(e.crs as Row[], 'text-[#B3261E]')}</td>
                    <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums')}>{formatINR(n(e.dr))}</td>
                    <td className={cn(td, 'max-w-[320px] text-[11.5px] text-[#5A6B62]')}>
                      <div className="line-clamp-2" title={e.narration}>
                        {e.narration || <span className="text-[#C3D2C6]">—</span>}
                      </div>
                    </td>
                    <td className={td}>
                      <ExternalLink className="h-3.5 w-3.5 text-[#8CA396]" />
                    </td>
                  </tr>
                ))
              )}
              {!!rows.length && (
                <tr className="border-t-2 border-[#D6E2D6] bg-[#F7FAF6] font-extrabold">
                  <td className={td} colSpan={4}>
                    Total · {rows.length} journals
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(total)}</td>
                  <td colSpan={2} />
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
