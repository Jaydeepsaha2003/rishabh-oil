import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Percent, Plus } from 'lucide-react'
import { PrincipalSplit } from '@/components/BdDetail'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// PAY CUMULATIVE INTEREST (billDiscounting.ts payBdCumulativeInterest): one
// NBFC, a month or a date range, every open bill's interest to the period's
// end — ticked bills paid with ONE bank voucher, linked to each bill.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
// 12,34,567.89 — Indian grouping in a box that is not being typed in.
const inIN = (v: unknown): string => n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r2 = (v: number): number => Math.round(v * 100) / 100

const monthEnd = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function BdCumulativeInterest({ open, onClose, nbfcs, onDone }: { open: boolean; onClose: () => void; nbfcs: Row[]; onDone?: () => void }): React.JSX.Element {
  const today = todayISO()
  const [nbfc, setNbfc] = useState('')
  const [mode, setMode] = useState<'month' | 'range'>('month')
  const [month, setMonth] = useState(today.slice(0, 7))
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(today)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [banks, setBanks] = useState<Row[]>([])
  // The ledger the TDS goes to — blank keeps TDS ON INTEREST PAYABLE A/C.
  const [tdsLedgers, setTdsLedgers] = useState<Row[]>([])
  const [tdsLedger, setTdsLedger] = useState('')
  const [bank, setBank] = useState('')
  const [paidOn, setPaidOn] = useState(today)
  const [busy, setBusy] = useState(false)
  // The split calculator open on one bill's stretch (the same one as on a bill).
  const [splitRow, setSplitRow] = useState<Row | null>(null)
  // Interest typed over the worked-out figure, per bill (more or less).
  const [edits, setEdits] = useState<Record<number, string>>({})
  // The box being typed in shows plain digits; every other one shows commas.
  const [typingId, setTypingId] = useState<number | null>(null)

  // The period's last day is what each bill is paid up to — never past today.
  const upto = useMemo(() => {
    const end = mode === 'month' ? monthEnd(month) : to
    return end > today ? today : end
  }, [mode, month, to, today])
  const start = mode === 'month' ? `${month}-01` : from

  useEffect(() => {
    if (!open) return
    void window.api.journal
      .accountNames()
      .then((a) => {
        setBanks(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(String(x.acc_group || ''))))
        setTdsLedgers(a.filter((x) => /TDS/i.test(String(x.name || '')) && !/RECE|RECOV|RECIA|RECEV/i.test(String(x.name || ''))))
      })
      .catch(() => setBanks([]))
  }, [open])

  useEffect(() => {
    setRows(null)
    if (!open || !nbfc || !/^\d{4}-\d{2}-\d{2}$/.test(upto)) return
    let live = true
    void window.api.billDiscounting
      .cumulativeInterest({ nbfc_id: Number(nbfc), from_date: start, to_date: upto })
      .then((r) => {
        if (!live) return
        setRows(r)
        setEdits({})
        setPicked(new Set(r.filter((x) => !x.blocked).map((x) => n(x.bd_id))))
      })
      .catch((e) => toast.error((e as Error).message))
    return () => {
      live = false
    }
  }, [open, nbfc, upto, start])

  // A bill's figures as they will be paid: the typed interest when there is
  // one, TDS at the bill's own % on it, the net what leaves the bank.
  const fig = (r: Row): { gross: number; tds: number; net: number; edited: boolean } => {
    const e = edits[n(r.bd_id)]
    if (e == null || e.trim() === '' || Math.abs(n(e) - n(r.gross)) < 0.005) return { gross: n(r.gross), tds: n(r.tds), net: n(r.net), edited: false }
    const g = r2(n(e))
    const t = r2((g * n(r.tds_pct)) / 100)
    return { gross: g, tds: t, net: r2(g - t), edited: true }
  }
  const payable = (rows || []).filter((r) => !r.blocked)
  const sel = payable.filter((r) => picked.has(n(r.bd_id)))
  const tot = {
    gross: r2(sel.reduce((t, r) => t + fig(r).gross, 0)),
    tds: r2(sel.reduce((t, r) => t + fig(r).tds, 0)),
    net: r2(sel.reduce((t, r) => t + fig(r).net, 0))
  }

  // A LUMP SUM over the ticked bills: spread in proportion to what each one
  // worked out to, the last bill taking the paisa left so they add up exactly.
  const [lump, setLump] = useState<string | null>(null)
  const spread = (total: number): void => {
    const base = sel.reduce((t, r) => t + n(r.gross), 0)
    if (!(base > 0) || !sel.length) return
    let left = r2(total)
    const next: Record<number, string> = {}
    sel.forEach((r, i) => {
      const share = i === sel.length - 1 ? left : r2((total * n(r.gross)) / base)
      left = r2(left - share)
      next[n(r.bd_id)] = String(share)
    })
    setEdits((p) => ({ ...p, ...next }))
  }

  async function pay(): Promise<void> {
    if (!sel.length) return
    setBusy(true)
    try {
      const res = await window.api.billDiscounting.payCumulativeInterest({
        nbfc_id: Number(nbfc),
        from_date: start,
        to_date: upto,
        paid_date: paidOn,
        bank_account: bank || null,
        bd_ids: sel.map((r) => n(r.bd_id)),
        tds_ledger: tdsLedger || null,
        amounts: Object.fromEntries(sel.filter((r) => fig(r).edited).map((r) => [String(n(r.bd_id)), fig(r).gross]))
      })
      toast.success(`Interest on ${res.bills} bill${res.bills === 1 ? '' : 's'} paid to ${formatDate(upto)} — one voucher, ${formatINR(res.net)} out of the bank`)
      onDone?.()
      onClose()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[1240px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1240px,96vw)] [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 py-3.5 pr-12 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <Percent className="h-3.5 w-3.5" /> Bill discounting
          </div>
          <DialogTitle className="text-[16px] font-extrabold text-white">Pay cumulative interest</DialogTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
          <div className="grid gap-3 md:grid-cols-[1.3fr_auto_1.4fr]">
            <div>
              <span className={lbl}>NBFC</span>
              <Select searchable value={nbfc} onValueChange={setNbfc}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose the NBFC" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {nbfcs.map((x) => (
                    <SelectItem key={String(x.id)} value={String(x.id)}>
                      {String(x.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className={lbl}>Period</span>
              <div className="flex h-9 rounded-[4px] border border-[#C9DCCF] p-0.5">
                {(['month', 'range'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn('rounded-[3px] px-3 text-[12px] font-extrabold', mode === m ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
                  >
                    {m === 'month' ? 'By month' : 'Date range'}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'month' ? (
              <div>
                <span className={lbl}>Month</span>
                <input
                  type="month"
                  value={month}
                  max={today.slice(0, 7)}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                  className="h-9 w-full rounded-[4px] border border-[#C9DCCF] bg-white px-2.5 text-[13px] font-semibold"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className={lbl}>From</span>
                  <DatePicker value={from} onChange={(v) => v && setFrom(v)} />
                </div>
                <div>
                  <span className={lbl}>To</span>
                  <DatePicker value={to} onChange={(v) => v && setTo(v)} />
                </div>
              </div>
            )}
          </div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">
            Interest for exactly <b className="text-[#0A1F17]">{formatDate(start)} → {formatDate(upto)}</b> on each bill (from the day it was funded, if later)
            {upto === today && (mode === 'month' ? monthEnd(month) : to) > today ? ' — to today, the period has not ended yet' : ''}. Earlier days still unpaid show as overdue and can be paid with a range that covers them.
          </div>

          {/* What this payment comes to, before the bill-by-bill detail. */}
          {nbfc && rows && payable.length > 0 && (
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { k: 'Bills ticked', v: `${sel.length} of ${payable.length}`, sub: `${rows.length - payable.length} already paid up`, accent: '#0B3D2E' },
                { k: 'Interest', v: formatINR(tot.gross), sub: `up to ${formatDate(upto)}`, accent: '#1B4E82' },
                { k: 'TDS withheld', v: formatINR(tot.tds), sub: 'to TDS on interest payable', accent: '#C2700A' },
                { k: 'Net out of the bank', v: formatINR(tot.net), sub: 'one voucher', accent: '#12855A' }
              ].map((t) => (
                <div key={t.k} className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-2.5" style={{ borderTop: `3px solid ${t.accent}` }}>
                  <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{t.k}</div>
                  <div className="mt-0.5 truncate text-[18px] font-bold tabular-nums tracking-[-0.02em] text-[#0A1F17]">{t.v}</div>
                  <div className="text-[11px] font-semibold text-[#5A6B62]">{t.sub}</div>
                </div>
              ))}
            </div>
          )}
          {!nbfc ? (
            <div className="rounded-[4px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">Choose the NBFC to see its bills.</div>
          ) : rows == null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-[4px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">No open, funded bill with this NBFC.</div>
          ) : (
            <div className="overflow-x-auto rounded-[4px] border border-[#D6E2D6]">
              <table className="w-full min-w-[820px] text-[12.5px]">
                <thead className="bg-[#0B3D2E] text-[10px] font-extrabold uppercase tracking-[.08em] text-[#DCEFE4]">
                  <tr>
                    <th className="w-9 px-3 py-2.5 text-left">
                      <input
                        type="checkbox"
                        aria-label="Tick every bill"
                        checked={payable.length > 0 && sel.length === payable.length}
                        onChange={(e) => setPicked(e.target.checked ? new Set(payable.map((r) => n(r.bd_id))) : new Set())}
                      />
                    </th>
                    <th className="px-2 py-2.5 text-left">Bill</th>
                    <th className="px-2 py-2.5 text-right">Principal</th>
                    <th className="px-2 py-2.5 text-left">Interest from → to</th>
                    <th className="px-2 py-2.5 text-right">Days</th>
                    <th className="px-2 py-2.5 text-right">Rate</th>
                    <th className="px-2 py-2.5 text-right">Interest</th>
                    <th className="px-2 py-2.5 text-right">TDS</th>
                    <th className="px-3 py-2.5 text-right text-[#C7F03F]">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const id = n(r.bd_id)
                    const on = picked.has(id)
                    return (
                      <tr key={id} className={cn('border-t border-[#EFF3EE]', r.blocked ? 'bg-[#FAFBF9] text-[#8CA396]' : on ? 'bg-white' : 'bg-[#FBFCFA] text-[#5A6B62]')}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            disabled={!!r.blocked}
                            checked={on && !r.blocked}
                            aria-label={`Pay ${String(r.bd_no)}`}
                            onChange={(e) =>
                              setPicked((p) => {
                                const next = new Set(p)
                                if (e.target.checked) next.add(id)
                                else next.delete(id)
                                return next
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="font-extrabold text-[#0A1F17]">{String(r.bd_no)}</div>
                          <div className="max-w-[220px] truncate text-[11px] font-semibold text-[#5A6B62]">{String(r.party || '')}</div>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(n(r.principal))}</td>
                        <td className="px-2 py-2">
                          {r.blocked ? (
                            <span className="text-[11.5px] font-semibold">{String(r.blocked)}</span>
                          ) : (
                            <>
                              <span className="tabular-nums font-semibold text-[#0A1F17]">
                                {formatDate(String(r.from_date))} → {formatDate(String(r.to_date))}
                              </span>
                              {/* Days before this period still unpaid: overdue, said, not paid here. */}
                              {r.unpaid_before && (
                                <span
                                  className="mt-0.5 flex items-center gap-1 text-[10.5px] font-bold text-[#B3261E]"
                                  title="These earlier days are still unpaid — pay them with a range that covers them"
                                >
                                  <span className="h-1.5 w-1.5 rounded-full bg-[#B3261E]" /> overdue {formatDate(String(r.unpaid_before.from))} → {formatDate(String(r.unpaid_before.to))}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {r.blocked ? (
                            '—'
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              {n(r.days)}
                              <button
                                type="button"
                                title="Split this stretch — by amount or by dates — and see each part's interest"
                                aria-label={`Split ${String(r.bd_no)}`}
                                onClick={() => setSplitRow(r)}
                                className="flex h-[20px] w-[20px] items-center justify-center rounded-[3px] border border-[#C9DCCF] bg-white text-[#0B6B45] hover:border-[#0B6B45] hover:bg-[#E9F5EE]"
                              >
                                <Plus className="h-3 w-3" />
                              </button>
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{n(r.interest_pct)}%</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right">
                          {r.blocked ? (
                            '—'
                          ) : (
                            <>
                              {/* Type over it to pay more or less than worked out. */}
                              <input
                                inputMode="decimal"
                                aria-label={`Interest paid on ${String(r.bd_no)}`}
                                disabled={!on}
                                value={typingId === id ? (edits[id] ?? String(n(r.gross))) : inIN(edits[id] ?? n(r.gross))}
                                onFocus={(e) => {
                                  setTypingId(id)
                                  const el = e.currentTarget
                                  setTimeout(() => el.select(), 0)
                                }}
                                onBlur={() => setTypingId(null)}
                                onChange={(e) => setEdits((p) => ({ ...p, [id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                                className={cn(
                                  'h-8 w-[118px] rounded-[4px] border px-2 text-right text-[12.5px] font-bold tabular-nums disabled:opacity-60',
                                  fig(r).edited ? 'border-[#C2700A] bg-[#FFF8EC] text-[#8A5300]' : 'border-[#C9DCCF] bg-white text-[#0A1F17]'
                                )}
                              />
                              {fig(r).edited && (
                                <button
                                  type="button"
                                  onClick={() => setEdits((p) => {
                                    const next = { ...p }
                                    delete next[id]
                                    return next
                                  })}
                                  title="Back to the worked-out figure"
                                  className="mt-0.5 block w-full text-right text-[10px] font-bold text-[#8A5300] hover:underline"
                                >
                                  {fig(r).gross > n(r.gross) ? '+' : '−'}
                                  {formatINR(Math.abs(r2(fig(r).gross - n(r.gross))))} vs {formatINR(n(r.gross))} · reset
                                </button>
                              )}
                            </>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{r.blocked ? '—' : formatINR(fig(r).tds)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums text-[#0B6B45]">{r.blocked ? '—' : formatINR(fig(r).net)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-[1.5px] border-[#C9DCCF] bg-[#F0F8F3] font-extrabold">
                    <td colSpan={6} className="px-3 py-2.5 text-[11px] uppercase tracking-[.1em] text-[#33473E]">
                      {sel.length} of {payable.length} bill{payable.length === 1 ? '' : 's'} ticked
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {/* Type a lump sum for all the ticked bills. */}
                      <input
                        inputMode="decimal"
                        aria-label="Lump sum of interest for the ticked bills"
                        title="Type a lump sum — it is spread over the ticked bills in proportion to their interest"
                        disabled={!sel.length}
                        value={lump ?? inIN(tot.gross)}
                        onFocus={() => setLump(String(tot.gross))}
                        onChange={(e) => setLump(e.target.value.replace(/[^0-9.]/g, ''))}
                        onBlur={() => {
                          if (lump != null && n(lump) > 0 && Math.abs(n(lump) - tot.gross) >= 0.005) spread(n(lump))
                          setLump(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                        }}
                        className="h-8 w-[130px] rounded-[4px] border border-[#0B3D2E] bg-white px-2 text-right text-[12.5px] font-extrabold tabular-nums text-[#0A1F17] disabled:opacity-60"
                      />
                      <span className="mt-0.5 block text-[10px] font-bold normal-case text-[#5A6B62]">lump sum · spread</span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{formatINR(tot.tds)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-[#0B6B45]">{formatINR(tot.net)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

        </div>
        <div className="flex flex-none flex-wrap items-end gap-2.5 border-t border-[#E4ECE3] bg-[#FBFCFA] px-3 py-3 sm:gap-3 sm:px-5">
          <div className="min-w-[200px] flex-1 basis-[220px]">
            <span className={lbl}>Paid from bank</span>
            <Select searchable value={bank} onValueChange={setBank}>
              <SelectTrigger>
                <SelectValue placeholder="The bill's own bank (first ticked bill)" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {banks.map((b) => (
                  <SelectItem key={String(b.name)} value={String(b.name)}>
                    {String(b.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[200px] flex-1 basis-[220px]">
            <span className={lbl}>TDS ledger</span>
            <Select searchable value={tdsLedger} onValueChange={setTdsLedger}>
              <SelectTrigger>
                <SelectValue placeholder="TDS on interest payable (usual)" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {tdsLedgers.map((b) => (
                  <SelectItem key={String(b.name)} value={String(b.name)}>
                    {String(b.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full sm:w-[170px]">
            <span className={lbl}>Payment date</span>
            <DatePicker value={paidOn} max={today} onChange={(v) => v && setPaidOn(v)} />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-ctrl-a
            disabled={busy || !sel.length}
            title={`One bank voucher: Dr Interest ${formatINR(tot.gross)} · Cr TDS ${formatINR(tot.tds)} · Cr bank ${formatINR(tot.net)} — linked to every ticked bill`}
            onClick={() => void pay()}
            className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Pay {sel.length ? `${formatINR(tot.net)} · ${sel.length} bill${sel.length === 1 ? '' : 's'}` : ''}
          </button>
        </div>
      </DialogContent>
      {splitRow && (
        <PrincipalSplit
          leg={!(Array.isArray(splitRow.parts) && splitRow.parts.length > 1)}
          x={{
            from_date: splitRow.from_date,
            to_date: splitRow.to_date,
            days: splitRow.days,
            principal: n(splitRow.parts?.[0]?.principal) || n(splitRow.principal),
            gross: fig(splitRow).gross,
            parts: splitRow.parts
          }}
          onClose={() => setSplitRow(null)}
        />
      )}
    </Dialog>
  )
}
