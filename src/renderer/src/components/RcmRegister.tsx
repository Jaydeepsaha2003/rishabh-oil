import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, Search, X } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
import { exportRowsToExcel, NUM_MONEY } from '@/lib/excel'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r2 = (v: number): number => Math.round(v * 100) / 100
const fyStart = (): string => {
  const d = new Date()
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1] || ''} ${ym.slice(0, 4)}`

// THE RCM REGISTER.
//
// Freight from an unregistered transporter carries no GST on the bill; the tax
// is ours to pay under reverse charge and then ours to claim back. Every such
// bill, month by month: the freight it was on, the RCM struck (CGST + SGST),
// and the voucher that booked it — the figures GSTR-3B asks for in 3.1(d)
// (tax payable on inward supplies under reverse charge) and 4(A)(3) (the
// credit on it). A bill booked before RCM was posted shows "not posted" and
// can be posted from here.
export function RcmRegister({
  companyId,
  companyName,
  canPost,
  onOpen,
  period
}: {
  companyId?: number
  companyName: string
  canPost: boolean
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
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [posting, setPosting] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      setRows(await window.api.transporterFreight.rcmRegister({ companyId, from, to }))
    } catch (e) {
      toast.error((e as Error).message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [companyId, from, to])
  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter((r) => [r.transporter_name, r.bill_no, r.vch_no].some((f) => String(f || '').toLowerCase().includes(s)))
  }, [rows, q])

  // Month by month, for the return.
  const months = useMemo(() => {
    const m = new Map<string, { freight: number; rcm: number; bills: number; pending: number }>()
    for (const r of shown) {
      const k = String(r.bill_date || '').slice(0, 7)
      const x = m.get(k) ?? { freight: 0, rcm: 0, bills: 0, pending: 0 }
      x.freight = r2(x.freight + n(r.taxable))
      x.rcm = r2(x.rcm + n(r.rcm_amount))
      x.bills++
      if (n(r.rcm_amount) <= 0.004) x.pending++
      m.set(k, x)
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [shown])
  const tot = months.reduce(
    (t, [, x]) => ({ freight: r2(t.freight + x.freight), rcm: r2(t.rcm + x.rcm), bills: t.bills + x.bills, pending: t.pending + x.pending }),
    { freight: 0, rcm: 0, bills: 0, pending: 0 }
  )

  async function post(r: Row): Promise<void> {
    if (!window.confirm(`Post RCM 5% (${formatINR(r2(n(r.taxable) * 0.05))}) on ${r.transporter_name}'s bill ${r.bill_no || ''}? The bill's JV is re-booked with the RCM lines added.`)) return
    setPosting(n(r.id))
    try {
      await window.api.transporterFreight.postRcm(n(r.id), undefined, companyId)
      toast.success(`RCM posted on ${r.bill_no || 'the bill'}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPosting(null)
    }
  }

  async function download(): Promise<void> {
    await exportRowsToExcel({
      filename: `rcm-register-${from}-to-${to}`,
      sheetName: 'RCM',
      title: `RCM register — ${companyName}`,
      subtitle: `${formatDate(from)} to ${formatDate(to)} · freight from unregistered transporters · ${shown.length} bills`,
      columns: [
        { header: 'Month', key: 'month', value: (r) => monthLabel(String(r.bill_date || '').slice(0, 7)) },
        { header: 'Bill date', key: 'date', value: (r) => formatDate(r.bill_date) },
        { header: 'Bill no', key: 'bill', value: (r) => r.bill_no || '' },
        { header: 'Transporter', key: 'tr', value: (r) => r.transporter_name },
        { header: 'Side', key: 'side', value: (r) => (r.side === 'sales' ? 'Outward' : 'Inward') },
        { header: 'Freight (taxable)', key: 'taxable', align: 'right', numFmt: NUM_MONEY, value: (r) => n(r.taxable) },
        { header: 'RCM %', key: 'pct', align: 'right', value: (r) => (n(r.rcm_amount) > 0 ? n(r.rcm_pct) : '') },
        { header: 'CGST', key: 'cgst', align: 'right', numFmt: NUM_MONEY, value: (r) => r2(n(r.rcm_amount) / 2) },
        { header: 'SGST', key: 'sgst', align: 'right', numFmt: NUM_MONEY, value: (r) => r2(n(r.rcm_amount) - r2(n(r.rcm_amount) / 2)) },
        { header: 'RCM total', key: 'rcm', align: 'right', numFmt: NUM_MONEY, value: (r) => n(r.rcm_amount) },
        { header: 'Voucher', key: 'vch', value: (r) => `${r.vch_type || ''} ${r.vch_no || ''}`.trim() },
        { header: 'Status', key: 'st', value: (r) => (n(r.rcm_amount) > 0.004 ? 'Posted' : 'Not posted') }
      ],
      rows: shown
    })
  }

  const th = 'h-9 px-2.5 text-left text-[10px] font-extrabold uppercase tracking-[.1em] text-[#C7F03F] whitespace-nowrap'
  const td = 'px-2.5 py-2 align-middle'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#F1F5EF] p-3">
      <div className="flex flex-wrap items-center gap-2.5 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
        <div className="mr-2 min-w-0">
          <div className="text-[15px] font-extrabold text-[#0A1F17]">RCM Register</div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">
            GST under reverse charge on freight from unregistered transporters — for GSTR-3B 3.1(d) and 4(A)(3)
          </div>
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
            placeholder="Transporter, bill no, voucher…"
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
          disabled={!shown.length}
          className="h-10 rounded-[4px] bg-[#0B3D2E] px-3.5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-40"
        >
          Excel
        </button>
      </div>

      {/* The period's figures. */}
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Freight under RCM</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums">{formatINR(tot.freight)}</div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">
            {tot.bills} bill{tot.bills === 1 ? '' : 's'}
          </div>
        </div>
        <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">RCM payable · 3.1(d)</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[#B3261E]">{formatINR(tot.rcm)}</div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">
            CGST {formatINR(r2(tot.rcm / 2))} · SGST {formatINR(r2(tot.rcm - r2(tot.rcm / 2)))}
          </div>
        </div>
        <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Input credit · 4(A)(3)</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[#0B6B45]">{formatINR(tot.rcm)}</div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">claimable once the RCM is paid</div>
        </div>
        <div className={cn('rounded-[6px] border px-4 py-3', tot.pending ? 'border-[#F0D6A0] bg-[#FFF8E9]' : 'border-[#D6E2D6] bg-white')}>
          <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Not posted</div>
          <div className={cn('mt-1 flex items-center gap-1.5 text-[18px] font-bold tabular-nums', tot.pending ? 'text-[#8A5300]' : 'text-[#0A1F17]')}>
            {tot.pending ? <AlertTriangle className="h-4 w-4" /> : null}
            {tot.pending}
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-[#8CA396]">{tot.pending ? 'bills booked without RCM' : 'every bill carries its RCM'}</div>
        </div>
      </div>

      {/* Month by month — the lines for the return. */}
      {months.length > 0 && (
        <div className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
              <thead className="bg-[#0B3D2E]">
                <tr>
                  <th className={th}>Month</th>
                  <th className={cn(th, 'text-right')}>Bills</th>
                  <th className={cn(th, 'text-right')}>Freight</th>
                  <th className={cn(th, 'text-right')}>CGST</th>
                  <th className={cn(th, 'text-right')}>SGST</th>
                  <th className={cn(th, 'text-right')}>RCM total</th>
                </tr>
              </thead>
              <tbody>
                {months.map(([ym, x]) => (
                  <tr key={ym} className="border-t border-[#EAF0E9]">
                    <td className={cn(td, 'font-extrabold')}>
                      {monthLabel(ym)}
                      {x.pending > 0 && (
                        <span className="ml-2 rounded-[2px] bg-[#FFF4DD] px-1.5 py-0.5 text-[10px] font-extrabold text-[#8A5300]">{x.pending} not posted</span>
                      )}
                    </td>
                    <td className={cn(td, 'text-right tabular-nums')}>{x.bills}</td>
                    <td className={cn(td, 'text-right tabular-nums')}>{formatINR(x.freight)}</td>
                    <td className={cn(td, 'text-right tabular-nums')}>{formatINR(r2(x.rcm / 2))}</td>
                    <td className={cn(td, 'text-right tabular-nums')}>{formatINR(r2(x.rcm - r2(x.rcm / 2)))}</td>
                    <td className={cn(td, 'text-right font-bold tabular-nums text-[#B3261E]')}>{formatINR(x.rcm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bill by bill. */}
      <div className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-[12.5px]">
            <thead className="bg-[#0B3D2E]">
              <tr>
                <th className={th}>Bill date</th>
                <th className={th}>Bill no</th>
                <th className={th}>Transporter</th>
                <th className={th}>Side</th>
                <th className={cn(th, 'text-right')}>Freight</th>
                <th className={cn(th, 'text-right')}>RCM</th>
                <th className={th}>Voucher</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {loading && !rows.length ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    Reading the bills…
                  </td>
                </tr>
              ) : !shown.length ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    No freight bill from an unregistered transporter in this period. Book one under Fr. Inward / Outward Working.
                  </td>
                </tr>
              ) : (
                shown.map((r, i) => {
                  const posted = n(r.rcm_amount) > 0.004
                  return (
                    <tr key={n(r.id)} className={cn('border-t border-[#EAF0E9]', i % 2 ? 'bg-[#FBFDFA]' : 'bg-white')}>
                      <td className={cn(td, 'whitespace-nowrap font-bold tabular-nums')}>{formatDate(r.bill_date)}</td>
                      <td className={cn(td, 'whitespace-nowrap font-extrabold')}>{r.bill_no || '—'}</td>
                      <td className={cn(td, 'max-w-[280px] font-semibold [overflow-wrap:anywhere]')}>
                        {r.transporter_name}
                        {String(r.gst_registration || '') !== 'unregistered' && (
                          <span className="ml-1.5 rounded-[2px] bg-[#EAF0FA] px-1 text-[9.5px] font-extrabold text-[#1B4E82]" title="Marked registered since this bill was booked">
                            NOW REGD
                          </span>
                        )}
                      </td>
                      <td className={cn(td, 'text-[11.5px] font-bold text-[#5A6B62]')}>{r.side === 'sales' ? 'Outward' : 'Inward'}</td>
                      <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>{formatINR(r.taxable)}</td>
                      <td className={cn(td, 'whitespace-nowrap text-right')}>
                        {posted ? (
                          <>
                            <div className="font-bold tabular-nums text-[#B3261E]">{formatINR(r.rcm_amount)}</div>
                            <div className="text-[10.5px] font-semibold text-[#8CA396]">{n(r.rcm_pct)}% · CGST + SGST</div>
                          </>
                        ) : (
                          <span className="rounded-[2px] bg-[#FFF4DD] px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#8A5300]">Not posted</span>
                        )}
                      </td>
                      <td className={td}>
                        {r.journal_entry_id ? (
                          <button
                            type="button"
                            onClick={() => onOpen({ entry_id: r.journal_entry_id, vch_type: r.vch_type, vch_no: r.vch_no })}
                            className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-bold text-[#1B4E82] hover:underline"
                          >
                            {r.vch_type} {r.vch_no}
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        ) : (
                          <span className="text-[#C3D2C6]">—</span>
                        )}
                      </td>
                      <td className={cn(td, 'text-right')}>
                        {!posted && canPost && String(r.gst_registration || '') === 'unregistered' && (
                          <button
                            type="button"
                            disabled={posting != null}
                            onClick={() => void post(r)}
                            className="h-8 whitespace-nowrap rounded-[4px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-40"
                          >
                            {posting === n(r.id) ? 'Posting…' : 'Post RCM'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
