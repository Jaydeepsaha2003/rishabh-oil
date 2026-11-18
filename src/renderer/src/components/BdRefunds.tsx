import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Link2, Loader2, Search, Undo2, Unlink, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// INTEREST REFUNDS (billDiscounting.ts earlyRefund / linkBdRefund): what each
// NBFC owes back on bills repaid before maturity, and the bank receipt it came
// by — one receipt mapped over several bills. The receipt is already in the
// books; this only links it, so nothing is booked twice.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
const r2 = (v: number): number => Math.round(v * 100) / 100
const errText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function BdRefunds({ bills, onClose, onDone }: { bills: Row[]; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<'due' | 'got'>('due')
  const [nbfc, setNbfc] = useState('all')
  const [picked, setPicked] = useState<Record<number, string>>({})
  const [q, setQ] = useState('')
  const [dFrom, setDFrom] = useState('')
  const [dTo, setDTo] = useState('')
  const [cands, setCands] = useState<Row[] | null>(null)
  const [receipt, setReceipt] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [got, setGot] = useState<Row[] | null>(null)
  const [rev, setRev] = useState(0)

  // Every bill with interest to come back, by NBFC.
  const all = useMemo(() => bills.filter((b) => b.early_refund), [bills])
  const nbfcs = useMemo(() => [...new Set(all.map((b) => String(b.nbfc_name || '—')))].sort(), [all])
  const shown = all.filter((b) => nbfc === 'all' || String(b.nbfc_name || '—') === nbfc)
  const groups = nbfcs.filter((x) => nbfc === 'all' || x === nbfc).map((x) => ({ name: x, bills: shown.filter((b) => String(b.nbfc_name || '—') === x) }))
  const sum = (l: Row[], k: string): number => r2(l.reduce((t, b) => t + n(b.early_refund[k]), 0))

  const ticked = all.filter((b) => picked[n(b.id)] != null)
  const mapped = r2(ticked.reduce((t, b) => t + n(picked[n(b.id)]), 0))
  const free = receipt ? r2(n(receipt.amount) - n(receipt.used)) : 0
  const since = useMemo(() => {
    const ds = ticked.flatMap((b) => (b.early_refund.lines as Row[]).map((l) => String(l.date))).sort()
    return ds[0] || ''
  }, [ticked])

  // Bank receipts to choose from — nearest the ticked total first.
  useEffect(() => {
    if (tab !== 'due' || !ticked.length) return
    let live = true
    setCands(null)
    const t = setTimeout(() => {
      window.api.billDiscounting
        .refundCandidates({ q, since, from: dFrom || undefined, to: dTo || undefined, expected: mapped })
        .then((r) => live && setCands(r))
        .catch((e) => toast.error(errText(e)))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, dFrom, dTo, since, ticked.length > 0, rev])

  useEffect(() => {
    if (tab !== 'got') return
    setGot(null)
    window.api.billDiscounting
      .refunds()
      .then(setGot)
      .catch((e) => toast.error(errText(e)))
  }, [tab, rev])

  const tick = (b: Row, on: boolean): void =>
    setPicked((p) => {
      const next = { ...p }
      if (on) next[n(b.id)] = String(n(b.early_refund.due))
      else delete next[n(b.id)]
      return next
    })

  async function link(): Promise<void> {
    if (!receipt || !ticked.length) return
    setBusy(true)
    try {
      const res = await window.api.billDiscounting.linkRefund({
        journal_entry_id: n(receipt.id),
        parts: ticked.map((b) => ({ bd_id: n(b.id), amount: n(picked[n(b.id)]) }))
      })
      toast.success(`${formatINR(res.amount)} of ${String(receipt.code || receipt.vch_no)} mapped over ${res.bills} bill${res.bills === 1 ? '' : 's'}`)
      setPicked({})
      setReceipt(null)
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function unlink(g: Row): Promise<void> {
    if (!window.confirm(`Unlink ${String(g.code)} (${formatINR(n(g.amount))}) from ${(g.bills as Row[]).map((b) => b.bd_no).join(', ')}?\n\nThe receipt stays in the books; those bills show their interest as due again.`)) return
    try {
      await window.api.billDiscounting.unlinkRefund(n(g.journal_entry_id))
      toast.success('Receipt unlinked')
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const cap = 'text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]'
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[1440px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1440px,96vw)] [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 pb-0 pt-3.5 pr-12 text-white">
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">Bill discounting</div>
          <DialogTitle className="text-[16px] font-extrabold text-white">Interest refunds</DialogTitle>
          <div className="mt-2.5 flex gap-1">
            {(
              [
                ['due', 'Due by NBFC'],
                ['got', 'Refunds received']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={cn('rounded-t-[5px] px-3.5 py-1.5 text-[12px] font-extrabold', tab === k ? 'bg-white text-[#0B3D2E]' : 'text-[#C7F03F]/80 hover:bg-white/10 hover:text-[#C7F03F]')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'got' ? (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
            {got == null ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
              </div>
            ) : !got.length ? (
              <div className="rounded-[6px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">No refund receipt mapped yet.</div>
            ) : (
              got.map((g) => (
                <div key={String(g.journal_entry_id)} className="overflow-hidden rounded-[8px] border border-[#DCE6DC] bg-white">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-[#F7FAF6] px-4 py-3">
                    <span className="flex flex-col">
                      <span className={cap}>Received on</span>
                      <span className="text-[13px] font-extrabold tabular-nums text-[#0A1F17]">{formatDate(String(g.date))}</span>
                    </span>
                    <span className="rounded-[4px] bg-[#0B3D2E] px-2 py-0.5 text-[11.5px] font-extrabold text-[#C7F03F]">{String(g.code)}</span>
                    <span className="text-[12px] font-bold text-[#0A1F17]">{(g.nbfcs as string[]).join(', ')}</span>
                    <span className="flex flex-wrap gap-1">
                      {(g.bills as Row[]).map((b) => (
                        <span key={String(b.bd_id)} className="rounded-[4px] border border-[#D6E2D6] bg-white px-1.5 py-0.5 text-[11px] font-extrabold text-[#0B3D2E]">
                          {String(b.bd_no)} <span className="font-semibold tabular-nums text-[#5A6B62]">{formatINR(n(b.amount))}</span>
                        </span>
                      ))}
                    </span>
                    <span className="ml-auto text-right">
                      <span className={cn(cap, 'block')}>Mapped</span>
                      <span className="text-[14.5px] font-extrabold tabular-nums text-[#0B6B45]">{formatINR(n(g.amount))}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void unlink(g)}
                      title="Unlink this receipt from its bills — the receipt stays in the books"
                      className="flex h-8 items-center gap-1 rounded-[5px] border border-[#F0C9C4] bg-white px-2.5 text-[11.5px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA]"
                    >
                      <Unlink className="h-3.5 w-3.5" /> Unlink
                    </button>
                  </div>
                  {g.narration && <div className="border-t border-[#F1F5F0] px-4 py-1.5 text-[11.5px] italic text-[#5A6B62]">{String(g.narration)}</div>}
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cap}>NBFC</span>
                <Select value={nbfc} onValueChange={setNbfc}>
                  <SelectTrigger className="h-9 w-[300px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="all">All NBFCs</SelectItem>
                    {nbfcs.map((x) => (
                      <SelectItem key={x} value={x}>
                        {x}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11.5px] font-semibold text-[#5A6B62]">Interest taken upfront on bills repaid before maturity — tick the bills one bank receipt covers.</span>
              </div>

              <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-4">
                {[
                  { k: 'Bills', v: String(shown.filter((b) => n(b.early_refund.due) > 0.5).length), sub: `${shown.length} repaid early`, tone: 'text-[#0A1F17]' },
                  { k: 'To come back', v: formatINR(sum(shown, 'gross')), sub: 'interest on the days not used', tone: 'text-[#0A1F17]' },
                  { k: 'Received', v: formatINR(sum(shown, 'received')), sub: 'mapped to bank receipts', tone: 'text-[#0B6B45]' },
                  { k: 'Still due', v: formatINR(sum(shown, 'due')), sub: 'from the NBFC', tone: sum(shown, 'due') > 0.5 ? 'text-[#B3261E]' : 'text-[#9AAFA2]' }
                ].map((t, i) => (
                  <div key={t.k} className={cn('min-w-0 px-4 py-3', i % 2 === 1 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0', i === 2 && 'lg:border-l')}>
                    <div className={cap}>{t.k}</div>
                    <div className={cn('mt-0.5 truncate text-[19px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
                    <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>
                  </div>
                ))}
              </div>

              {!groups.length && <div className="rounded-[6px] border border-dashed border-[#C9DCCF] py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">No bill repaid before maturity with interest to come back.</div>}
              {groups.length > 0 && (
                <div className="overflow-x-auto rounded-[8px] border border-[#DCE6DC] bg-white">
                  <table className="w-full min-w-[960px] text-[12.5px]">
                    <thead className="bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#DCEFE4]">
                      <tr>
                        <th className="w-10 px-4 py-2.5" />
                        <th className="px-2 py-2.5 text-left">Bill</th>
                        <th className="px-2 py-2.5 text-left">Maturity</th>
                        <th className="px-2 py-2.5 text-left">Repaid early</th>
                        <th className="px-2 py-2.5 text-right">To come back</th>
                        <th className="px-2 py-2.5 text-right">Received</th>
                        <th className="px-2 py-2.5 text-right">Still due</th>
                        <th className="px-4 py-2.5 text-right text-[#C7F03F]">Map from receipt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => {
                        const open = g.bills.filter((b) => n(b.early_refund.due) > 0.5)
                        const allOn = open.length > 0 && open.every((b) => picked[n(b.id)] != null)
                        return (
                          <Fragment key={g.name}>
                            {/* THE NBFC — tick all its bills at once; its totals. */}
                            <tr className="border-t-[1.5px] border-[#C9DCCF] bg-[#F3F8F2]">
                              <td className="px-4 py-2">
                                <input
                                  type="checkbox"
                                  disabled={!open.length}
                                  checked={allOn}
                                  aria-label={`Tick every bill of ${g.name}`}
                                  onChange={(e) => open.forEach((b) => tick(b, e.target.checked))}
                                />
                              </td>
                              <td colSpan={3} className="px-2 py-2">
                                <span className="text-[12.5px] font-extrabold text-[#0A1F17]">{g.name}</span>
                                <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#5A6B62]">
                                  {g.bills.length} bill{g.bills.length === 1 ? '' : 's'}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums text-[#33473E]">{formatINR(sum(g.bills, 'gross'))}</td>
                              <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums text-[#0B6B45]">{sum(g.bills, 'received') > 0.004 ? formatINR(sum(g.bills, 'received')) : '—'}</td>
                              <td className={cn('whitespace-nowrap px-2 py-2 text-right font-extrabold tabular-nums', sum(g.bills, 'due') > 0.5 ? 'text-[#B3261E]' : 'text-[#0B6B45]')}>{formatINR(sum(g.bills, 'due'))}</td>
                              <td />
                            </tr>
                            {g.bills.map((b) => {
                              const er = b.early_refund as Row
                              const done = !(n(er.due) > 0.5)
                              const on = picked[n(b.id)] != null
                              const lines = er.lines as Row[]
                              const days = lines.map((l) => n(l.days))
                              const repaid = lines.reduce((t, l) => t + n(l.amount), 0)
                              return (
                                <tr
                                  key={String(b.id)}
                                  onClick={(e) => {
                                    if (done || (e.target as HTMLElement).closest('input')) return
                                    tick(b, !on)
                                  }}
                                  className={cn('border-t border-[#F1F5F0]', done ? 'text-[#9AAAA0]' : 'cursor-pointer hover:bg-[#FAFCF9]', on && '!bg-[#EEF8E4]')}
                                >
                                  <td className="px-4 py-2">
                                    <input type="checkbox" disabled={done} checked={on} aria-label={`Map ${String(b.bd_no)}`} onChange={(e) => tick(b, e.target.checked)} />
                                  </td>
                                  <td className="px-2 py-2">
                                    <span className={cn('rounded-[4px] px-1.5 py-0.5 text-[11.5px] font-extrabold', done ? 'bg-[#EEF2EE] text-[#8CA396]' : 'bg-[#0B3D2E] text-[#C7F03F]')}>{String(b.bd_no)}</span>
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-[#33473E]">{formatDate(String(er.maturity))}</td>
                                  <td className="px-2 py-2">
                                    {/* Summed up; every repayment is in the tooltip. */}
                                    <span
                                      className="whitespace-nowrap text-[12px] font-semibold tabular-nums text-[#33473E]"
                                      title={lines.map((l) => `${formatDate(String(l.date))}: ${formatINR(n(l.amount))} · ${n(l.days)} days left · ${formatINR(n(l.gross))}`).join('\n')}
                                    >
                                      {formatINR(repaid)}
                                      <span className="ml-1.5 rounded-full border border-[#D6E2D6] bg-white px-1.5 py-[1px] text-[10.5px] font-bold text-[#5A6B62]">
                                        {lines.length === 1 ? `${formatDate(String(lines[0].date))} · ${days[0]}d` : `${lines.length} parts · ${Math.min(...days)}–${Math.max(...days)}d`}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(n(er.gross))}</td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#0B6B45]">{n(er.received) > 0.004 ? formatINR(n(er.received)) : '—'}</td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums">
                                    {done ? (
                                      <span className="inline-flex items-center gap-1 text-[#0B6B45]">
                                        <CheckCircle2 className="h-3.5 w-3.5" /> received
                                      </span>
                                    ) : (
                                      <span className="text-[#B3261E]">{formatINR(n(er.due))}</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-1.5 text-right">
                                    {on ? (
                                      <input
                                        inputMode="decimal"
                                        value={picked[n(b.id)]}
                                        onChange={(e) => setPicked((p) => ({ ...p, [n(b.id)]: e.target.value.replace(/[^0-9.]/g, '') }))}
                                        aria-label={`Amount for ${String(b.bd_no)}`}
                                        className="h-8 w-[130px] rounded-[5px] border border-[#0B3D2E] bg-white px-2 text-right text-[12.5px] font-extrabold tabular-nums outline-none focus:ring-2 focus:ring-[#0B6B45]/20"
                                      />
                                    ) : (
                                      <span className="text-[#C3D2C6]">—</span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* THE BANK RECEIPT the ticked bills came back by. */}
              {ticked.length > 0 && (
                <div className="overflow-hidden rounded-[8px] border-[1.5px] border-[#0B3D2E] bg-white">
                  <div className="flex flex-wrap items-center gap-2.5 bg-[#F3F8F2] px-4 py-2.5">
                    <Link2 className="h-4 w-4 text-[#0B3D2E]" />
                    <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">Pick the bank receipt</span>
                    <label className="ml-auto flex h-9 min-w-[240px] items-center gap-2 rounded-[5px] border border-[#C3D2C6] bg-white px-2.5">
                      <Search className="h-4 w-4 text-[#5A6B62]" />
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Amount, voucher no, narration…" className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold outline-none" />
                      {q && (
                        <button type="button" onClick={() => setQ('')} aria-label="Clear">
                          <X className="h-3.5 w-3.5 text-[#8CA396]" />
                        </button>
                      )}
                    </label>
                    <div className="w-[140px]">
                      <DatePicker value={dFrom} onChange={(x) => setDFrom(String(x || ''))} placeholder="From" />
                    </div>
                    <div className="w-[140px]">
                      <DatePicker value={dTo} onChange={(x) => setDTo(String(x || ''))} placeholder="To" />
                    </div>
                  </div>
                  <div className="max-h-[260px] overflow-y-auto">
                    {cands == null ? (
                      <div className="flex justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin text-[#8CA396]" />
                      </div>
                    ) : !cands.length ? (
                      <div className="px-4 py-5 text-[12px] font-semibold text-[#5A6B62]">Nothing found — try the amount, or wider dates.</div>
                    ) : (
                      <table className="w-full text-[12.5px]">
                        <tbody>
                          {cands.map((c) => {
                            const sel = n(receipt?.id) === n(c.id)
                            const left = r2(n(c.amount) - n(c.used))
                            return (
                              <tr
                                key={String(c.id)}
                                onClick={() => setReceipt(sel ? null : c)}
                                className={cn('cursor-pointer border-t border-[#F1F5F0] hover:bg-[#F3F9F1]', sel && '!bg-[#E4F5C8] shadow-[inset_4px_0_0_#9ACD2A]')}
                              >
                                <td className="whitespace-nowrap px-4 py-2 font-semibold tabular-nums">{formatDate(String(c.entry_date))}</td>
                                <td className="whitespace-nowrap px-2 py-2 font-extrabold">{String(c.code || c.vch_no || `#${c.id}`)}</td>
                                <td className="px-2 py-2 text-[12px] text-[#33473E]">{String(c.bank || '')}</td>
                                <td className="max-w-[280px] px-2 py-2 text-[11.5px] text-[#5A6B62]">
                                  <span className="line-clamp-1">{String(c.debited || c.narration || '')}</span>
                                </td>
                                <td className="whitespace-nowrap px-2 py-2 text-right font-extrabold tabular-nums">{formatINR(n(c.amount))}</td>
                                <td className="whitespace-nowrap px-4 py-2 text-right text-[11px] font-bold tabular-nums text-[#8A5300]">{n(c.used) > 0.004 ? `${formatINR(left)} unmapped` : ''}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-none flex-wrap items-center gap-3 border-t border-[#E4ECE3] bg-[#FBFCFA] px-3 py-3 sm:px-5">
              <span className="text-[12px] font-semibold text-[#5A6B62]">
                {ticked.length ? (
                  <>
                    <b className="text-[#0A1F17]">{ticked.length}</b> bill{ticked.length === 1 ? '' : 's'} · <b className="tabular-nums text-[#0A1F17]">{formatINR(mapped)}</b>
                    {receipt && (
                      <>
                        {' '}
                        from <b className="text-[#0A1F17]">{String(receipt.code || receipt.vch_no)}</b> ({formatINR(free)} free)
                        {Math.abs(free - mapped) > 0.5 && (
                          <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[11px] font-extrabold', mapped > free ? 'bg-[#FDECEA] text-[#B3261E]' : 'bg-[#FFF4DC] text-[#7A4B00]')}>
                            {mapped > free ? `${formatINR(mapped - free)} more than the receipt` : `${formatINR(free - mapped)} of the receipt left unmapped`}
                          </span>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  'Tick the bills one bank receipt covers.'
                )}
              </span>
              {ticked.length > 0 && (
                <button type="button" onClick={() => { setPicked({}); setReceipt(null) }} className="inline-flex items-center gap-1 text-[11.5px] font-bold text-[#5A6B62] hover:underline">
                  <Undo2 className="h-3.5 w-3.5" /> Clear
                </button>
              )}
              <span className="flex-1" />
              <button type="button" onClick={onClose} className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]">
                Close
              </button>
              <button
                type="button"
                data-ctrl-a
                disabled={busy || !receipt || !ticked.length || !(mapped > 0)}
                onClick={() => void link()}
                className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <Link2 className="h-3.5 w-3.5" /> Map receipt to {ticked.length || ''} bill{ticked.length === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
