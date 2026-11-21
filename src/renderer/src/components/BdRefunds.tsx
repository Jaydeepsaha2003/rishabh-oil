import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Ban, CheckCircle2, ChevronDown, Link2, Loader2, Plus, Search, Undo2, Unlink, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { HelpTip } from '@/components/ui/tooltip'

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
  // What the NBFC actually paid in — spread over the ticked bills, oldest maturity first.
  const [recv, setRecv] = useState('')
  // Received less: close the short bills fully (the rest is let go).
  const [closeShort, setCloseShort] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  // The bank the refund came into: its receipts are listed (same amount first),
  // and a new receipt is booked into it.
  const [banks, setBanks] = useState<Row[]>([])
  const [incomes, setIncomes] = useState<Row[]>([])
  const [bankId, setBankId] = useState('all')
  // Book the receipt from here (Journal NBFC → interest income, Receipt bank ← NBFC).
  const [making, setMaking] = useState(false)
  const [mkDate, setMkDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [mkIncome, setMkIncome] = useState('')
  const [mkNote, setMkNote] = useState('')
  // An existing receipt (Bank Dr / NBFC Cr) mapped: also book stage 1,
  // NBFC Dr / interest income Cr — on unless the desk says otherwise.
  const [withIncome, setWithIncome] = useState(true)
  useEffect(() => {
    void window.api.journal
      .accountNames()
      .then((a) => {
        setBanks(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(String(x.acc_group || '')) && !x.is_hidden))
        const inc = a.filter((x) => /INCOME/i.test(String(x.acc_group || '')) && !x.is_hidden)
        setIncomes(inc)
        // Last one used here, else INTEREST INCOME, else any interest income that is not FD interest.
        let last = ''
        try {
          last = localStorage.getItem('bdRefundIncomeLedger') || ''
        } catch {
          /* no storage */
        }
        const pick =
          inc.find((x) => String(x.name) === last) ||
          inc.find((x) => /^INTEREST INCOME/i.test(String(x.name))) ||
          inc.find((x) => /INTEREST/i.test(String(x.name)) && !/FD/i.test(String(x.name))) ||
          inc[0]
        setMkIncome((cur) => cur || String(pick?.name || ''))
      })
      .catch(() => setBanks([]))
  }, [])
  const bankName = bankId === 'all' ? '' : String(banks.find((b) => String(b.id) === bankId)?.name || '')
  const [got, setGot] = useState<Row[] | null>(null)
  const [rev, setRev] = useState(0)
  // Bills whose legs (each early repayment and its interest) are open.
  const [legs, setLegs] = useState<Set<number>>(new Set())
  const flip = (id: number): void =>
    setLegs((p) => {
      const x = new Set(p)
      if (x.has(id)) x.delete(id)
      else x.add(id)
      return x
    })

  // Every bill with interest to come back, by NBFC.
  const all = useMemo(() => bills.filter((b) => b.early_refund), [bills])
  const nbfcs = useMemo(() => [...new Set(all.map((b) => String(b.nbfc_name || '—')))].sort(), [all])
  const shown = all.filter((b) => nbfc === 'all' || String(b.nbfc_name || '—') === nbfc)
  const groups = nbfcs.filter((x) => nbfc === 'all' || x === nbfc).map((x) => ({ name: x, bills: shown.filter((b) => String(b.nbfc_name || '—') === x) }))
  const sum = (l: Row[], k: string): number => r2(l.reduce((t, b) => t + n(b.early_refund[k]), 0))

  const ticked = all.filter((b) => picked[n(b.id)] != null)
  const mapped = r2(ticked.reduce((t, b) => t + n(picked[n(b.id)]), 0))
  const dueTicked = r2(ticked.reduce((t, b) => t + n(b.early_refund.due), 0))
  // Bills mapped less than their due — what Close fully would let go.
  const shortBills = ticked.filter((b) => n(picked[n(b.id)]) < n(b.early_refund.due) - 0.5)
  const shortBy = r2(shortBills.reduce((t, b) => t + n(b.early_refund.due) - n(picked[n(b.id)]), 0))
  // Spread an amount over the ticked bills, oldest maturity first, each up to its due.
  const spread = (amt: number): void => {
    let left = r2(amt)
    const order = [...ticked].sort((a, b) => String(a.early_refund.maturity).localeCompare(String(b.early_refund.maturity)))
    const next: Record<number, string> = {}
    for (const b of order) {
      const take = r2(Math.max(0, Math.min(n(b.early_refund.due), left)))
      next[n(b.id)] = String(take)
      left = r2(left - take)
    }
    setPicked(next)
  }
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
        .refundCandidates({ q, since, from: dFrom || undefined, to: dTo || undefined, expected: mapped, ledgerId: bankId === 'all' ? undefined : Number(bankId) })
        .then((r) => live && setCands(r))
        .catch((e) => toast.error(errText(e)))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // The amount too — the list follows what is typed in Interest received.
  }, [tab, q, dFrom, dTo, since, ticked.length > 0, rev, bankId, Math.round(mapped)])

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
        parts: ticked.map((b) => ({ bd_id: n(b.id), amount: n(picked[n(b.id)]) })),
        close_ids: closeShort ? shortBills.map((b) => n(b.id)) : [],
        note: closeNote,
        income_ledger: withIncome ? mkIncome || 'INTEREST INCOME' : null
      })
      toast.success(
        `${formatINR(res.amount)} of ${String(receipt.code || receipt.vch_no)} mapped over ${res.bills} bill${res.bills === 1 ? '' : 's'}` +
          (res.journal?.journal_id ? (res.journal.adopted ? ' · income journal already in the books, tied to it' : ' · interest income journal booked') : withIncome ? ' · no income journal (the receipt does not credit the NBFC)' : '')
      )
      setPicked({})
      setReceipt(null)
      setRecv('')
      setCloseShort(false)
      setCloseNote('')
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // Book the receipt from here, then map it.
  async function makeReceipt(): Promise<void> {
    if (!ticked.length || !bankName || !mkIncome) return
    setBusy(true)
    try {
      const res = await window.api.billDiscounting.createRefundReceipt({
        date: mkDate,
        bank: bankName,
        income_ledger: mkIncome,
        note: [mkNote.trim(), closeShort ? closeNote.trim() : ''].filter(Boolean).join(' · '),
        parts: ticked.map((b) => ({ bd_id: n(b.id), amount: n(picked[n(b.id)]) })),
        close_ids: closeShort ? shortBills.map((b) => n(b.id)) : []
      })
      try {
        localStorage.setItem('bdRefundIncomeLedger', mkIncome)
      } catch {
        /* no storage */
      }
      toast.success(`Journal and receipt booked for ${formatINR(res.amount)}, mapped over ${res.bills} bill${res.bills === 1 ? '' : 's'}`)
      setPicked({})
      setReceipt(null)
      setMaking(false)
      setRecv('')
      setMkNote('')
      setCloseShort(false)
      setCloseNote('')
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // Close without a receipt — the NBFC will not pay the rest.
  async function closeBill(b: Row): Promise<void> {
    const note = window.prompt(`Close ${String(b.bd_no)} fully? ${formatINR(n(b.early_refund.due))} still due will be let go.\n\nNote (optional):`, '')
    if (note == null) return
    try {
      await window.api.billDiscounting.closeRefunds({ bd_ids: [n(b.id)], note })
      toast.success(`${String(b.bd_no)} closed`)
      tick(b, false)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  async function reopenBill(b: Row): Promise<void> {
    try {
      await window.api.billDiscounting.reopenRefund(n(b.id))
      toast.success(`${String(b.bd_no)} reopened — ${formatINR(n(b.early_refund.written_off))} is due again`)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  async function unlink(g: Row): Promise<void> {
    const inc = g.income as Row | null
    const goes = [inc?.made ? `the income journal ${String(inc.code || '')}` : '', g.receipt_made ? `the receipt ${String(g.code)} (booked here)` : ''].filter(Boolean)
    if (
      !window.confirm(
        `Unlink ${String(g.code)} (${formatINR(n(g.amount))}) from ${(g.bills as Row[]).map((b) => b.bd_no).join(', ')}?\n\n` +
          (goes.length ? `Deleted with it — booked by this window: ${goes.join(' and ')}.\n` : 'The receipt stays in the books.\n') +
          'Those bills show their interest as due again.'
      )
    )
      return
    try {
      const r = await window.api.billDiscounting.unlinkRefund(n(g.journal_entry_id))
      toast.success(r.dropped ? `Receipt unlinked · ${r.dropped} voucher${r.dropped === 1 ? '' : 's'} deleted` : 'Receipt unlinked')
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  async function bookIncome(g: Row): Promise<void> {
    try {
      const r = await window.api.billDiscounting.bookRefundIncome(n(g.journal_entry_id), mkIncome || 'INTEREST INCOME')
      if (!r.journal_id) toast.info(`${String(g.code)} does not credit the NBFC's ledger — no income journal is booked for it`)
      else toast.success(r.adopted ? 'An income journal already in the books was tied to it' : `Interest income journal booked — ${formatINR(r.amount)}`)
      setRev((v) => v + 1)
      onDone()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const cap = 'text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]'
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex h-[98dvh] max-h-[98dvh] w-[98vw] max-w-[98vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[98vw] [&>button]:!text-white">
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
                    {g.income ? (
                      <span
                        className="rounded-[4px] border border-[#BFE3CB] bg-[#E9F5EE] px-2 py-0.5 text-[11px] font-extrabold text-[#0B6B45]"
                        title={(g.income as Row).made ? 'Interest income journal booked by this window' : 'Interest income journal found in the books'}
                      >
                        Income · {String((g.income as Row).code || 'journal')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void bookIncome(g)}
                        title={`Book stage 1 — NBFC Dr / ${mkIncome || 'INTEREST INCOME'} Cr for ${formatINR(n(g.amount))} (an existing one in the books is used instead)`}
                        className="flex h-7 items-center gap-1 rounded-[5px] border border-[#E3B66B] bg-[#FFF8EA] px-2 text-[11px] font-extrabold text-[#8A5300] hover:bg-[#FFF1D6]"
                      >
                        <Plus className="h-3.5 w-3.5" /> Book income journal
                      </button>
                    )}
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
            <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
              {/* LEFT — what is owed back, by NBFC and bill. */}
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
              <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[#DCE6DC] bg-[#F7FAF6] px-3 py-2.5">
                <span className={cap}>NBFC</span>
                <Select value={nbfc} onValueChange={setNbfc}>
                  <SelectTrigger className="h-9 w-[280px] bg-white text-[12.5px] font-bold">
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
                <HelpTip
                  className="ml-1"
                  text="Interest the NBFC took upfront to maturity, on bills repaid early: each repayment frees the interest on the days left. Tick the bills one bank receipt covers, pick the receipt (already in the books), set each bill's share and map it. Open a bill's legs with the arrow on its repayments."
                />
              </div>

                {/* THE POSITION in one strip: still due, and how much is back. */}
                {(() => {
                  const gross = sum(shown, 'gross')
                  const got = sum(shown, 'received')
                  const pct = gross > 0 ? Math.min(100, (got / gross) * 100) : 0
                  return (
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[8px] border border-[#DCE6DC] bg-white px-5 py-3.5">
                      <div>
                        <div className={cap}>Still due</div>
                        <div className={cn('text-[24px] font-extrabold tabular-nums tracking-[-0.02em]', 'text-[#0B6B45]')}>{formatINR(sum(shown, 'due'))}</div>
                      </div>
                      <div className="min-w-[220px] flex-1">
                        <div className="flex justify-between text-[11px] font-bold tabular-nums">
                          <span className="text-[#0B6B45]">{formatINR(got)} back</span>
                          <span className="text-[#5A6B62]">{Math.round(pct)}% of {formatINR(gross)}</span>
                        </div>
                        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-[#E4F0E6]">
                          <div className="h-full rounded-full bg-gradient-to-r from-[#12855A] to-[#7CC242]" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      {[
                        ['Bills', String(shown.filter((b) => n(b.early_refund.due) > 0.5).length)],
                        ['To come back', formatINR(gross)],
                        ['Received', formatINR(got)]
                      ].map(([k, v]) => (
                        <div key={k} className="border-l border-[#EEF3EE] pl-5">
                          <div className={cap}>{k}</div>
                          <div className="text-[15px] font-bold tabular-nums text-[#0A1F17]">{v}</div>
                        </div>
                      ))}
                    </div>
                  )
                })()}

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
                                {/* How much of this NBFC's refund is back. */}
                                <span className="ml-3 inline-flex items-center gap-1.5 align-middle">
                                  <span className="inline-block h-1.5 w-[110px] overflow-hidden rounded-full bg-[#DDEBDF]">
                                    <span className="block h-full rounded-full bg-[#12855A]" style={{ width: `${sum(g.bills, 'gross') > 0 ? Math.min(100, (sum(g.bills, 'received') / sum(g.bills, 'gross')) * 100) : 0}%` }} />
                                  </span>
                                  <span className="text-[10.5px] font-bold tabular-nums text-[#5A6B62]">
                                    {sum(g.bills, 'gross') > 0 ? Math.round((sum(g.bills, 'received') / sum(g.bills, 'gross')) * 100) : 0}% back
                                  </span>
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums text-[#33473E]">{formatINR(sum(g.bills, 'gross'))}</td>
                              <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums text-[#0B6B45]">{sum(g.bills, 'received') > 0.004 ? formatINR(sum(g.bills, 'received')) : '—'}</td>
                              <td className={cn('whitespace-nowrap px-2 py-2 text-right font-extrabold tabular-nums', 'text-[#0B6B45]')}>{formatINR(sum(g.bills, 'due'))}</td>
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
                                <Fragment key={String(b.id)}>
                                <tr
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
                                    {/* Summed up; the arrow opens each leg underneath. */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        flip(n(b.id))
                                      }}
                                      aria-expanded={legs.has(n(b.id))}
                                      title="Show each repayment and its interest"
                                      className="inline-flex items-center whitespace-nowrap text-[12px] font-semibold tabular-nums text-[#33473E]"
                                    >
                                      {formatINR(repaid)}
                                      <span className={cn('ml-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10.5px] font-bold', legs.has(n(b.id)) ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#D6E2D6] bg-white text-[#5A6B62] hover:border-[#8FBFA8]')}>
                                        {lines.length === 1 ? `${formatDate(String(lines[0].date))} · ${days[0]}d` : `${lines.length} parts · ${Math.min(...days)}–${Math.max(...days)}d`}
                                        <ChevronDown className={cn('h-3 w-3 transition-transform', legs.has(n(b.id)) && 'rotate-180')} />
                                      </span>
                                    </button>
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatINR(n(er.gross))}</td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-[#0B6B45]">{n(er.received) > 0.004 ? formatINR(n(er.received)) : '—'}</td>
                                  <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums">
                                    {er.closed ? (
                                      <span
                                        className="inline-flex items-center gap-1 rounded-full border border-[#E3D3B0] bg-[#FFF8EA] px-2 py-0.5 text-[11px] font-extrabold text-[#8A5300]"
                                        title={`Closed fully${er.closed_at ? ` on ${formatDate(String(er.closed_at))}` : ''}${er.closed_note ? ` — ${String(er.closed_note)}` : ''}`}
                                      >
                                        <Ban className="h-3 w-3" /> closed · {formatINR(n(er.written_off))} short
                                      </span>
                                    ) : done ? (
                                      <span className="inline-flex items-center gap-1 text-[#0B6B45]">
                                        <CheckCircle2 className="h-3.5 w-3.5" /> received
                                      </span>
                                    ) : (
                                      <span className="text-[#0B6B45]">{formatINR(n(er.due))}</span>
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
                                    ) : er.closed ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          void reopenBill(b)
                                        }}
                                        className="text-[11.5px] font-bold text-[#1B4E82] hover:underline"
                                      >
                                        Reopen
                                      </button>
                                    ) : !done ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          void closeBill(b)
                                        }}
                                        title="The NBFC will not pay the rest — close this bill's refund fully"
                                        className="inline-flex items-center gap-1 text-[11.5px] font-bold text-[#8A5300] hover:underline"
                                      >
                                        <Ban className="h-3 w-3" /> Close fully
                                      </button>
                                    ) : (
                                      <span className="text-[#C3D2C6]">—</span>
                                    )}
                                  </td>
                                </tr>
                                {legs.has(n(b.id)) && (
                                  <tr className="bg-[#F7FAF6]">
                                    <td />
                                    <td colSpan={7} className="px-2 pb-2.5 pt-0.5">
                                      <div className="overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white">
                                        <table className="w-full text-[11.5px]">
                                          <thead className="bg-[#FAFCF9] text-[9px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                                            <tr>
                                              <th className="px-3 py-1.5 text-left">Leg</th>
                                              <th className="px-2 py-1.5 text-left">Repaid on</th>
                                              <th className="px-2 py-1.5 text-right">Amount</th>
                                              <th className="px-2 py-1.5 text-right">Days left</th>
                                              <th className="px-2 py-1.5 text-left">Working</th>
                                              <th className="px-3 py-1.5 text-right">Interest</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {lines.map((l, i) => (
                                              <tr key={i} className="border-t border-[#F1F5F0]">
                                                <td className="px-3 py-1.5">
                                                  <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[#E9F5EE] px-1.5 text-[10.5px] font-extrabold text-[#0B6B45]">{i + 1}</span>
                                                </td>
                                                <td className="whitespace-nowrap px-2 py-1.5 font-semibold tabular-nums text-[#0A1F17]">{formatDate(String(l.date))}</td>
                                                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(n(l.amount))}</td>
                                                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.days)}</td>
                                                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-[#7A8C82]">
                                                  {formatINR(n(l.amount))} × {n(er.rate)}% × {n(l.days)} ÷ {n(er.days_year)}
                                                </td>
                                                <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(n(l.gross))}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                          <tfoot>
                                            <tr className="border-t border-[#DCE6DC] bg-[#FAFCF9] font-extrabold">
                                              <td colSpan={2} className="px-3 py-1.5 text-[10px] uppercase tracking-[.08em] text-[#5A6B62]">
                                                {lines.length} leg{lines.length === 1 ? '' : 's'}
                                              </td>
                                              <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(repaid)}</td>
                                              <td colSpan={2} />
                                              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{formatINR(n(er.gross))}</td>
                                            </tr>
                                          </tfoot>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                                </Fragment>
                              )
                            })}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              </div>

              {/* RIGHT — map one bank receipt over the ticked bills, step by step. */}
              <aside className="flex min-h-0 flex-none flex-col border-t border-[#DCE6DC] bg-[#F7FAF6] xl:w-[clamp(400px,28vw,520px)] xl:border-l xl:border-t-0">
                <div className="flex-none border-b border-[#DCE6DC] bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-[#0B3D2E]" />
                    <span className="text-[12px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">Map a receipt</span>
                  </div>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                  {/* 1 — the bills */}
                  <div className="rounded-[8px] border border-[#DCE6DC] bg-white">
                    <div className="flex items-center gap-2 border-b border-[#EEF3EE] px-3 py-2">
                      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-extrabold', ticked.length ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EEF3EE] text-[#7A8C82]')}>1</span>
                      <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">Bills</span>
                      {ticked.length > 0 && (
                        <button type="button" onClick={() => { setPicked({}); setReceipt(null) }} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-[#5A6B62] hover:underline">
                          <Undo2 className="h-3 w-3" /> Clear
                        </button>
                      )}
                    </div>
                    {!ticked.length ? (
                      <div className="px-3 py-4 text-center text-[12px] font-semibold text-[#9AAFA2]">Tick bills on the left</div>
                    ) : (
                      <div className="max-h-[max(180px,22dvh)] overflow-y-auto">
                        {ticked.map((b) => (
                          <div key={String(b.id)} className="flex items-center gap-2 border-t border-[#F1F5F0] px-3 py-1.5 text-[12px] first:border-t-0">
                            <span className="rounded-[4px] bg-[#0B3D2E] px-1.5 py-0.5 text-[11px] font-extrabold text-[#C7F03F]">{String(b.bd_no)}</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[#7A8C82]">{String(b.nbfc_name || '')}</span>
                            <span className="font-extrabold tabular-nums">{formatINR(n(picked[n(b.id)]))}</span>
                            <button type="button" onClick={() => tick(b, false)} aria-label={`Untick ${String(b.bd_no)}`} className="text-[#8CA396] hover:text-[#B3261E]">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        <div className="flex justify-between border-t border-[#DCE6DC] bg-[#FAFCF9] px-3 py-1.5 text-[12px] font-extrabold">
                          <span>{ticked.length} bill{ticked.length === 1 ? '' : 's'}</span>
                          <span className="tabular-nums">{formatINR(mapped)}</span>
                        </div>
                      </div>
                    )}
                    {/* WHAT CAME IN — typed once, spread over the bills (oldest first). */}
                    {ticked.length > 0 && (
                        <label className="block border-t border-[#DCE6DC] px-3 py-2.5">
                          <span className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Interest received</span>
                          <span className="mt-1 flex h-10 items-center rounded-[6px] border-[1.5px] border-[#0B3D2E] bg-white px-2.5 focus-within:ring-2 focus-within:ring-[#0B6B45]/20">
                            <span className="mr-1 text-[13px] font-bold text-[#5A6B62]">₹</span>
                            <input
                              inputMode="decimal"
                              value={recv}
                              placeholder={String(dueTicked)}
                              onChange={(e) => {
                                const v = e.target.value.replace(/[^0-9.]/g, '')
                                setRecv(v)
                                if (v !== '') spread(n(v))
                              }}
                              className="min-w-0 flex-1 bg-transparent text-right text-[15px] font-extrabold tabular-nums outline-none"
                            />
                          </span>
                          <span className="mt-1 flex gap-2 text-[10.5px] font-bold">
                            <button type="button" onClick={() => { setRecv(String(dueTicked)); spread(dueTicked) }} className="text-[#1B4E82] hover:underline">
                              Full due {formatINR(dueTicked)}
                            </button>
                            {receipt && (
                              <button type="button" onClick={() => { setRecv(String(free)); spread(free) }} className="text-[#1B4E82] hover:underline">
                                Receipt free {formatINR(free)}
                              </button>
                            )}
                          </span>
                        </label>
                    )}
                  </div>

                  {/* 2 — the receipt */}
                  <div className={cn('rounded-[8px] border bg-white', ticked.length ? 'border-[#DCE6DC]' : 'border-[#EEF3EE] opacity-60')}>
                    <div className="flex items-center gap-2 border-b border-[#EEF3EE] px-3 py-2">
                      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-extrabold', receipt ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EEF3EE] text-[#7A8C82]')}>2</span>
                      <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">Bank receipt</span>
                    </div>
                    {ticked.length > 0 && (
                      <div className="space-y-2 px-3 py-2.5">
                        <div className="flex gap-2">
                          <Select value={bankId} onValueChange={(v) => { setBankId(v); setReceipt(null) }}>
                            <SelectTrigger className="h-9 min-w-0 flex-1 bg-white text-[12px] font-bold">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-64">
                              <SelectItem value="all">All banks</SelectItem>
                              {banks.map((b) => (
                                <SelectItem key={String(b.id)} value={String(b.id)}>
                                  {String(b.name)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            onClick={() => {
                              setMaking((m) => !m)
                              setReceipt(null)
                            }}
                            title="Not in the books yet — book the journal and the receipt from here"
                            className={cn('flex h-9 flex-none items-center gap-1 rounded-[5px] border px-2.5 text-[11.5px] font-extrabold', making ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#C3D2C6] bg-white text-[#0B3D2E] hover:bg-[#F0F8F3]')}
                          >
                            {making ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />} {making ? 'Pick existing' : 'New receipt'}
                          </button>
                        </div>
                        {making ? (
                          <div className="space-y-2 rounded-[6px] border border-[#C6DAF0] bg-[#F4F8FD] p-2.5">
                            <div className="text-[11px] font-bold text-[#1B4E82]">Books two entries, then maps the receipt:</div>
                            <div className="rounded-[5px] bg-white px-2.5 py-1.5 text-[11px] leading-[1.6] text-[#33473E]">
                              <div>
                                <b>1 · Journal</b> — {String(ticked[0]?.nbfc_name || 'NBFC')} Dr / {mkIncome || 'interest income'} Cr
                              </div>
                              <div>
                                <b>2 · Receipt</b> — {bankName || 'bank'} Dr / {String(ticked[0]?.nbfc_name || 'NBFC')} Cr
                              </div>
                              <div className="mt-0.5 font-extrabold text-[#0A1F17]">{formatINR(mapped)}</div>
                            </div>
                            {!bankName && <div className="text-[11px] font-bold text-[#B3261E]">Pick the bank above</div>}
                            <div className="grid grid-cols-2 gap-2">
                              <DatePicker value={mkDate} onChange={(x) => setMkDate(String(x || ''))} />
                              <Select value={mkIncome} onValueChange={setMkIncome}>
                                <SelectTrigger className="h-9 bg-white text-[11.5px] font-bold">
                                  <SelectValue placeholder="Income ledger" />
                                </SelectTrigger>
                                <SelectContent className="max-h-64">
                                  {incomes.map((x) => (
                                    <SelectItem key={String(x.id)} value={String(x.name)}>
                                      {String(x.name)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <input
                              value={mkNote}
                              onChange={(e) => setMkNote(e.target.value)}
                              placeholder="Narration note (optional)"
                              className="h-8 w-full rounded-[5px] border border-[#C3D2C6] bg-white px-2 text-[12px] outline-none"
                            />
                          </div>
                        ) : (
                        <>
                        <label className="flex h-9 items-center gap-2 rounded-[5px] border border-[#C3D2C6] bg-white px-2.5">
                          <Search className="h-4 w-4 text-[#5A6B62]" />
                          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Amount, voucher no, narration…" className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold outline-none" />
                          {q && (
                            <button type="button" onClick={() => setQ('')} aria-label="Clear">
                              <X className="h-3.5 w-3.5 text-[#8CA396]" />
                            </button>
                          )}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <DatePicker value={dFrom} onChange={(x) => setDFrom(String(x || ''))} placeholder="From" />
                          <DatePicker value={dTo} onChange={(x) => setDTo(String(x || ''))} placeholder="To" />
                        </div>
                        <div className="max-h-[max(300px,calc(98dvh-640px))] space-y-1.5 overflow-y-auto pr-0.5">
                          {cands == null ? (
                            <div className="flex justify-center py-6">
                              <Loader2 className="h-4 w-4 animate-spin text-[#8CA396]" />
                            </div>
                          ) : !cands.length ? (
                            <div className="py-5 text-center text-[12px] font-semibold text-[#9AAFA2]">Nothing found</div>
                          ) : (() => {
                            // EXACT first: a receipt of this very amount (or with exactly this much unmapped).
                            const isExact = (c: Row): boolean => Math.abs(n(c.amount) - mapped) < 1 || Math.abs(r2(n(c.amount) - n(c.used)) - mapped) < 1
                            const exact = cands.filter(isExact)
                            const others = cands.filter((c) => !isExact(c))
                            // Exact found: only those. None: the nearest amounts.
                            const list = exact.length ? exact : others.slice(0, 150)
                            return (
                              <>
                                <div className={cn('flex items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-[11px] font-bold', exact.length ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#FFF8EA] text-[#8A5300]')}>
                                  {exact.length ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
                                  {exact.length
                                    ? `${exact.length} exact match${exact.length === 1 ? '' : 'es'} for ${formatINR(mapped)}`
                                    : `No receipt of exactly ${formatINR(mapped)}`}
                                </div>
                                {list.map((c, i) => {
                              const sel = n(receipt?.id) === n(c.id)
                              const left = r2(n(c.amount) - n(c.used))
                              const close = isExact(c)
                              return (
                                <Fragment key={String(c.id)}>
                                {/* NEAREST — after the exact ones, closest amount first. */}
                                {!exact.length && i === 0 && (
                                  <div className="px-1 pt-1.5 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">Nearest amounts</div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setReceipt(sel ? null : c)}
                                  className={cn(
                                    'block w-full rounded-[6px] border px-3 py-2 text-left transition-colors',
                                    sel ? 'border-[#0B3D2E] bg-[#EEF8E4] shadow-[inset_4px_0_0_#9ACD2A]' : 'border-[#E4ECE3] bg-white hover:border-[#8FBFA8] hover:bg-[#F7FBF5]'
                                  )}
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-extrabold text-[#0A1F17]">{String(c.code || c.vch_no || `#${c.id}`)}</span>
                                    <span className="text-[11px] font-semibold tabular-nums text-[#5A6B62]">{formatDate(String(c.entry_date))}</span>
                                    {close && <span className="rounded-full bg-[#E9F5EE] px-1.5 text-[10px] font-extrabold text-[#0B6B45]">matches</span>}
                                    <span className="ml-auto text-[13px] font-extrabold tabular-nums text-[#0A1F17]">{formatINR(n(c.amount))}</span>
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-[#7A8C82]">
                                    <span className="min-w-0 flex-1 truncate">{String(c.bank || c.debited || '')}</span>
                                    {n(c.used) > 0.004 && <span className="flex-none font-bold text-[#8A5300]">{formatINR(left)} unmapped</span>}
                                  </div>
                                </button>
                                </Fragment>
                              )
                            })}
                              </>
                            )
                          })()}
                        </div>
                        </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 3 — the match */}
                  <div className={cn('rounded-[8px] border bg-white', receipt ? 'border-[#DCE6DC]' : 'border-[#EEF3EE] opacity-60')}>
                    <div className="flex items-center gap-2 border-b border-[#EEF3EE] px-3 py-2">
                      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-extrabold', receipt && Math.abs(free - mapped) <= 0.5 ? 'bg-[#0B3D2E] text-[#C7F03F]' : 'bg-[#EEF3EE] text-[#7A8C82]')}>3</span>
                      <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">Match</span>
                    </div>
                    {receipt && (
                      <div className="space-y-1 px-3 py-2.5 text-[12px]">
                        {/* STAGE 1 with the receipt: NBFC Dr / interest income Cr. */}
                        <div className={cn('mb-2 rounded-[6px] border p-2', withIncome ? 'border-[#C6DAF0] bg-[#F4F8FD]' : 'border-[#EEF3EE] bg-[#FAFCF9]')}>
                          <label className="flex cursor-pointer items-start gap-2">
                            <input type="checkbox" checked={withIncome} onChange={(e) => setWithIncome(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1B4E82]" />
                            <span className="text-[11.5px] font-bold text-[#1B4E82]">
                              Also book the interest income journal — {String(ticked[0]?.nbfc_name || 'NBFC')} Dr / {mkIncome || 'INTEREST INCOME'} Cr
                              <span className="block text-[10.5px] font-semibold text-[#5A6B62]">One already in the books for this amount is used instead of a second.</span>
                            </span>
                          </label>
                          {withIncome && incomes.length > 0 && (
                            <Select value={mkIncome} onValueChange={setMkIncome}>
                              <SelectTrigger className="mt-1.5 h-8 bg-white text-[11.5px] font-bold">
                                <SelectValue placeholder="Income ledger" />
                              </SelectTrigger>
                              <SelectContent className="max-h-64">
                                {incomes.map((x) => (
                                  <SelectItem key={String(x.id)} value={String(x.name)}>
                                    {String(x.name)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#5A6B62]">Receipt {String(receipt.code || receipt.vch_no)} free</span>
                          <span className="font-bold tabular-nums">{formatINR(free)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#5A6B62]">Mapped over {ticked.length} bill{ticked.length === 1 ? '' : 's'}</span>
                          <span className="font-bold tabular-nums">{formatINR(mapped)}</span>
                        </div>
                        <div className="flex justify-between border-t border-[#EEF3EE] pt-1.5">
                          <span className="font-extrabold">Difference</span>
                          {Math.abs(free - mapped) <= 0.5 ? (
                            <span className="inline-flex items-center gap-1 font-extrabold text-[#0B6B45]">
                              <CheckCircle2 className="h-3.5 w-3.5" /> matches
                            </span>
                          ) : (
                            <span className={cn('font-extrabold tabular-nums', mapped > free ? 'text-[#B3261E]' : 'text-[#8A5300]')}>
                              {mapped > free ? `${formatINR(mapped - free)} over` : `${formatINR(free - mapped)} left`}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                        {/* RECEIVED LESS — close those bills fully, or leave the rest due. */}
                        {shortBills.length > 0 && (
                          <div className={cn('rounded-[8px] border p-2.5', closeShort ? 'border-[#E3B66B] bg-[#FFF8EA]' : 'border-[#EEF3EE] bg-[#FAFCF9]')}>
                            <label className="flex cursor-pointer items-start gap-2">
                              <input type="checkbox" checked={closeShort} onChange={(e) => setCloseShort(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#8A5300]" />
                              <span>
                                <span className="block text-[12px] font-extrabold text-[#0A1F17]">Close fully — let {formatINR(shortBy)} go</span>
                                <span className="block text-[11px] text-[#5A6B62]">
                                  {shortBills.map((b) => String(b.bd_no)).join(', ')} got less than due. Ticked: nothing more is due on them. Unticked: the rest stays due.
                                </span>
                              </span>
                            </label>
                            {closeShort && (
                              <input
                                value={closeNote}
                                onChange={(e) => setCloseNote(e.target.value)}
                                placeholder="Note — why the rest is let go (optional)"
                                className="mt-2 h-8 w-full rounded-[5px] border border-[#E3D3B0] bg-white px-2 text-[12px] outline-none"
                              />
                            )}
                          </div>
                        )}
                </div>
                <div className="flex flex-none gap-2 border-t border-[#DCE6DC] bg-white px-4 py-3">
                  <button type="button" onClick={onClose} className="h-10 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]">
                    Close
                  </button>
                  <button
                    type="button"
                    data-ctrl-a
                    disabled={busy || !ticked.length || !(mapped > 0) || (making ? !bankName || !mkIncome || !ticked.every((b) => b.nbfc_id === ticked[0].nbfc_id) : !receipt)}
                    onClick={() => void (making ? makeReceipt() : link())}
                    className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-4 text-[12.5px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {making ? <Plus className="h-4 w-4" /> : <Link2 className="h-4 w-4" />} {making ? 'Book & map' : 'Map'} {ticked.length ? `${formatINR(mapped)} · ${ticked.length} bill${ticked.length === 1 ? '' : 's'}${closeShort && shortBills.length ? ` · close ${shortBills.length}` : ''}` : 'receipt'}
                  </button>
                </div>
              </aside>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
