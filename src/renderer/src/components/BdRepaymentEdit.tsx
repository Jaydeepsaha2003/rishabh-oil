import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil, Plus, X } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { escToClose } from '@/lib/escape'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, todayISO } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

/** A repayment's charges as ledger rows — its own rows, then the old fixed commission and bank fields. */
function chargeRowsOf(rows: Row[]): { account: string; amount: string }[] {
  const out: { account: string; amount: string }[] = []
  for (const r of rows) {
    let list: Row[] = []
    try {
      list = Array.isArray(r.charges) ? r.charges : JSON.parse(String(r.charges || '[]'))
    } catch {
      list = []
    }
    for (const c of list) if (String(c?.account || '').trim() && n(c?.amount) > 0) out.push({ account: String(c.account), amount: String(round2(n(c.amount))) })
    if (n(r.comm_charges) > 0.004) out.push({ account: 'COMM. CHARGES A/C', amount: String(round2(n(r.comm_charges))) })
    if (n(r.bank_charges) > 0.004) out.push({ account: 'BANK CHARGES A/C', amount: String(round2(n(r.bank_charges))) })
  }
  return out
}

// EDIT ONE BILL-DISCOUNTING REPAYMENT — its date, the bank, the charges, and
// what the debit put against each bill it settled. The server takes the old
// repayment off and posts the corrected one through the ordinary repayment,
// keeping the voucher's number (billDiscounting.ts editBdRepayment).
export function BdRepaymentEdit({
  repayment,
  onClose,
  onSaved
}: {
  repayment: Row | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [date, setDate] = useState('')
  const [bank, setBank] = useState('')
  // CHARGES ON LEDGERS OF THE USER'S CHOOSING — one row each, as on the
  // Repay form. An old repayment's commission and bank charges open as rows
  // on their own ledgers, so nothing it carried is lost.
  const [charges, setCharges] = useState<{ account: string; amount: string; from?: number }[]>([])
  const [ledgerNames, setLedgerNames] = useState<string[]>([])
  // Interest paid in the same debit — gross.
  const [intr, setIntr] = useState('')
  const [note, setNote] = useState('')
  const [noteWas, setNoteWas] = useState('')
  // `from` marks a line brought in by combining another repayment (its
  // voucher id), so unticking it takes exactly those lines away again.
  const [shares, setShares] = useState<{ bd_id: number; bd_no: string; amount: string; from?: number }[]>([])
  const [banks, setBanks] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  // Every bill and every repayment with the NBFC — for adding a bill to this
  // debit, and for combining other repayments into it.
  const [bills, setBills] = useState<Row[]>([])
  const [allReps, setAllReps] = useState<Row[]>([])
  const [merge, setMerge] = useState<Record<number, number>>({})
  const [showAllReps, setShowAllReps] = useState(false)
  const [addBill, setAddBill] = useState('')

  useEffect(() => {
    const r = repayment
    if (!r) return
    setDate(String(r.repay_date || todayISO()).slice(0, 10))
    setBank(String(r.bank_account || ''))
    const group: Row[] = Array.isArray(r.debit_group) && r.debit_group.length ? r.debit_group : [{ bd_id: r.bd_id, bd_no: r.bd_no || 'This bill', amount: r.amount }]
    setShares(group.map((g) => ({ bd_id: n(g.bd_id), bd_no: String(g.bd_no || ''), amount: String(round2(n(g.amount))) })))
    // The charges ride on the row of the bill the debit was entered on, which
    // may be another bill in the group than the one opened.
    const it = round2(group.reduce((t, g) => t + n(g.interest), 0) || n(r.interest))
    setCharges(chargeRowsOf(group.some((g) => g.comm_charges != null || g.bank_charges != null || g.charges) ? group : [r]))
    setIntr(it ? String(it) : '')
    setNote(String(r.note || ''))
    setNoteWas(String(r.note || ''))
    setMerge({})
    setShowAllReps(false)
    setAddBill('')
    void window.api.billDiscounting.list().then((b: Row[]) => setBills(Array.isArray(b) ? b : [])).catch(() => setBills([]))
    void window.api.billDiscounting.allRepayments().then((x: Row[]) => setAllReps(Array.isArray(x) ? x : [])).catch(() => setAllReps([]))
    void window.api.journal
      .accounts()
      .then((accts: Row[]) => {
        setBanks(accts.filter((a) => ['Bank Accounts', 'Bank OD A/c'].includes(String(a.acc_group || ''))).map((a) => String(a.name)))
        setLedgerNames(accts.filter((a) => !a.is_hidden).map((a) => String(a.name)))
      })
      .catch(() => setBanks([]))
  }, [repayment])

  const total = useMemo(
    () => round2(shares.reduce((t, s) => t + n(s.amount), 0) + charges.reduce((t, c) => t + n(c.amount), 0) + n(intr)),
    [shares, charges, intr]
  )
  const party = String(repayment?.settle_via || '') === 'party'

  const myBill = bills.find((b) => Number(b.id) === Number(repayment?.bd_id))
  const nbfc = Number(myBill?.nbfc_id || 0)
  const myJe = Number(repayment?.journal_entry_id || 0)
  // OTHER DEBITS WITH THE SAME NBFC, nearest in date first — each one bank
  // line today, any of which may really have been part of this one.
  const candidates = useMemo(() => {
    const groups = new Map<number, Row[]>()
    for (const x of allReps) {
      if (!nbfc || Number(x.nbfc_id) !== nbfc || String(x.settle_via) === 'party') continue
      const je = Number(x.journal_entry_id || 0) || -Number(x.id)
      if (je === myJe) continue
      groups.set(je, [...(groups.get(je) || []), x])
    }
    const at = new Date(date || todayISO()).getTime()
    return [...groups.entries()]
      .map(([je, rows]) => ({
        je,
        rows,
        date: String(rows[0].repay_date || '').slice(0, 10),
        total: round2(
          rows.reduce((t, r) => t + n(r.amount) + n(r.interest) + chargeRowsOf([r]).reduce((u, c) => u + n(c.amount), 0), 0)
        ),
        gap: Math.abs(new Date(String(rows[0].repay_date || '')).getTime() - at)
      }))
      .sort((a, b) => a.gap - b.gap)
  }, [allReps, nbfc, myJe, date])
  const shownCands = showAllReps ? candidates : candidates.slice(0, 6)
  function toggleMerge(c: { je: number; rows: Row[] }): void {
    if (merge[c.je]) {
      setMerge((m) => {
        const next = { ...m }
        delete next[c.je]
        return next
      })
      setShares((p) => p.filter((x) => x.from !== c.je))
      setCharges((p) => p.filter((x) => x.from !== c.je))
      return
    }
    setMerge((m) => ({ ...m, [c.je]: Number(c.rows[0].id) }))
    setShares((p) => [
      ...p,
      ...c.rows.map((r) => ({ bd_id: Number(r.bd_id), bd_no: String(r.bd_no || ''), amount: String(round2(n(r.amount))), from: c.je }))
    ])
    // Their charges come with them, as rows of their own.
    setCharges((p) => [...p, ...chargeRowsOf(c.rows).map((x) => ({ ...x, from: c.je }))])
  }
  // Bills this debit could also go against: same NBFC, funded, still owing.
  const addable = bills.filter(
    (b) =>
      !!nbfc &&
      Number(b.nbfc_id) === nbfc &&
      !!b.payment_received_date &&
      String(b.status) !== 'repaid' &&
      !shares.some((x) => x.bd_id === Number(b.id))
  )

  async function save(): Promise<void> {
    if (!repayment) return
    if (!date) return void toast.error('Pick the repayment date')
    if (date > todayISO()) return void toast.error('The repayment date cannot be in the future')
    if (shares.some((s) => n(s.amount) < 0) || charges.some((c) => n(c.amount) < 0) || n(intr) < 0) return void toast.error('Amounts cannot be negative')
    const bad = charges.find((c) => (c.account.trim() || n(c.amount)) && !(c.account.trim() && n(c.amount) > 0))
    if (bad) return void toast.error(bad.account.trim() ? `Enter the amount charged to ${bad.account}` : 'Pick the ledger for each charge')
    if (!shares.some((s) => n(s.amount) > 0)) return void toast.error('Enter what the debit put against the bill')
    setSaving(true)
    try {
      await window.api.billDiscounting.editRepayment(Number(repayment.id), {
        repay_date: date,
        bank_account: bank || null,
        // Every charge goes as a ledger row now — the old commission and bank
        // figures included — so the two fixed fields are cleared.
        comm_charges: 0,
        bank_charges: 0,
        charges: charges
          .filter((c) => c.account.trim() && round2(n(c.amount)) > 0)
          .map((c) => ({ account: c.account.trim(), amount: round2(n(c.amount)) })),
        interest: intr.trim() === '' ? 0 : n(intr),
        // Sent only when changed: a bill that shared the debit carries its own
        // "Part of one … debit" line, which is not the debit's note.
        note: note !== noteWas ? note.trim() || null : undefined,
        shares: shares.map((s) => ({ bd_id: s.bd_id, amount: round2(n(s.amount)) })),
        merge_ids: Object.values(merge)
      })
      toast.success('Repayment updated — the voucher keeps its number')
      onSaved()
      onClose()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'text-[10.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
  const inp = 'h-9 w-full rounded-[6px] border border-[#C3D2C6] bg-white px-2.5 text-[13px] font-semibold tabular-nums focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15'
  return (
    <Dialog open={!!repayment} onOpenChange={(o) => !o && !saving && onClose()}>
      {/* Above the bill's drawer (z-90), which it is opened from. */}
      <DialogContent
        overlayClassName="z-[110]"
        onEscapeKeyDown={(e) => (saving ? e.preventDefault() : escToClose()(e))}
        className="z-[120] max-h-[92vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit repayment
          </DialogTitle>
        </DialogHeader>
        {party ? (
          <p className="text-[13px] font-semibold text-[#8A5300]">
            This repayment was settled against a party, not from the bank. Remove it and enter it again to change it.
          </p>
        ) : (
          <div className="grid gap-3.5">
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className={lbl}>Date</span>
                <DatePicker value={date} max={todayISO()} onChange={setDate} popoverClassName="z-[130]" className="!rounded-[6px] !border-[#C3D2C6] font-semibold" />
              </label>
              <label className="grid gap-1">
                <span className={lbl}>From bank</span>
                <Select value={bank || '__bill'} onValueChange={(v) => setBank(v === '__bill' ? '' : v)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__bill">The bill&rsquo;s bank</SelectItem>
                    {/* The bank it was paid from, even when that name is not
                        a bank ledger today (an older spelling). */}
                    {bank && !banks.includes(bank) && <SelectItem value={bank}>{bank}</SelectItem>}
                    {banks.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <div className="overflow-hidden rounded-[6px] border border-[#DCE7DB]">
              <div className="flex items-center justify-between border-b border-[#E4ECE3] bg-[#F7FAF6] px-3 py-2">
                <span className={lbl}>{shares.length > 1 ? 'One debit — what it put against each bill' : 'Off the bill'}</span>
              </div>
              {shares.map((s, i) => (
                <div key={`${s.bd_id}-${s.from || 0}-${i}`} className="flex items-center gap-3 border-b border-[#EFF3EE] px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold text-[#0A1F17]">
                    {s.bd_no || `Bill ${s.bd_id}`}
                    {s.from ? <span className="ml-1.5 text-[10.5px] font-bold text-[#1B4E82]">combined</span> : null}
                  </span>
                  <input
                    inputMode="decimal"
                    value={s.amount}
                    onChange={(e) => setShares((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    className={`${inp} !w-[170px] text-right`}
                  />
                  {s.bd_id !== Number(repayment?.bd_id) && !s.from ? (
                    <button type="button" title="Take this bill off the debit" onClick={() => setShares((p) => p.filter((_, j) => j !== i))} className="text-[#8CA396] hover:text-[#B3261E]">
                      <X className="h-4 w-4" />
                    </button>
                  ) : (
                    <span className="w-4" />
                  )}
                </div>
              ))}
              {/* PART OF THIS DEBIT WAS REALLY ANOTHER BILL'S. */}
              {addable.length > 0 && (
                <div className="flex items-center gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-3 py-2">
                  <Plus className="h-3.5 w-3.5 flex-none text-[#0B6B45]" />
                  <Select
                    value={addBill}
                    onValueChange={(v) => {
                      const b = bills.find((x) => String(x.id) === v)
                      if (b) setShares((p) => [...p, { bd_id: Number(b.id), bd_no: String(b.bd_no || ''), amount: '' }])
                      setAddBill('')
                    }}
                  >
                    <SelectTrigger className="h-8 flex-1 text-[12.5px]">
                      <SelectValue placeholder="Adjust part of it against another bill…" />
                    </SelectTrigger>
                    <SelectContent>
                      {addable.map((b) => (
                        <SelectItem key={String(b.id)} value={String(b.id)}>
                          {String(b.bd_no)} · {formatINR(n(b.outstanding_amount ?? b.amount))} outstanding
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* OTHER PAYMENTS THAT WERE REALLY THIS ONE DEBIT. */}
            {candidates.length > 0 && (
              <div className="overflow-hidden rounded-[6px] border border-[#DCE7DB]">
                <div className="flex items-center justify-between gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-3 py-2">
                  <span className={lbl}>Combine other repayments into this debit</span>
                  {candidates.length > 6 && (
                    <button type="button" onClick={() => setShowAllReps((v) => !v)} className="text-[11px] font-extrabold text-[#0B6B45]">
                      {showAllReps ? 'Nearest only' : `All ${candidates.length}`}
                    </button>
                  )}
                </div>
                <div className="max-h-[190px] overflow-y-auto">
                  {shownCands.map((c) => (
                    <label key={c.je} className="flex cursor-pointer items-center gap-2.5 border-b border-[#EFF3EE] px-3 py-2 last:border-b-0 hover:bg-[#FBFCFA]">
                      <input type="checkbox" checked={!!merge[c.je]} onChange={() => toggleMerge(c)} className="h-4 w-4 accent-[#0B3D2E]" />
                      <span className="w-[86px] flex-none text-[12px] font-bold tabular-nums text-[#33473E]">{formatDate(c.date)}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#0A1F17]">
                        {c.rows.map((r) => `${String(r.bd_no)} ${formatINR(n(r.amount))}`).join(' · ')}
                      </span>
                      <span className="flex-none text-[12px] font-extrabold tabular-nums text-[#0A1F17]">{formatINR(c.total)}</span>
                    </label>
                  ))}
                </div>
                <p className="border-t border-[#E4ECE3] px-3 py-1.5 text-[10.5px] font-semibold text-[#5A6B62]">
                  A ticked payment&rsquo;s own voucher is removed and its bills join this one debit.
                </p>
              </div>
            )}

            <label className="grid gap-1">
              <span className={lbl}>Interest</span>
              <input inputMode="decimal" value={intr} onChange={(e) => setIntr(e.target.value)} placeholder="0" className={`${inp} text-right`} />
            </label>

            <div className="grid gap-1.5">
              <span className={lbl}>Charges in this debit</span>
              <datalist id="bd-edit-charge-ledgers">
                {ledgerNames.map((nm) => (
                  <option key={nm} value={nm} />
                ))}
              </datalist>
              {charges.map((ch, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    list="bd-edit-charge-ledgers"
                    placeholder="Ledger — type to search"
                    value={ch.account}
                    onChange={(e) => setCharges((p) => p.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))}
                    className={`${inp.replace('tabular-nums', '')} min-w-0 flex-1`}
                  />
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    value={ch.amount}
                    onChange={(e) => setCharges((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    className={`${inp} w-[140px] text-right`}
                  />
                  <button
                    type="button"
                    title="Remove this charge"
                    onClick={() => setCharges((p) => p.filter((_, j) => j !== i))}
                    className="flex h-9 w-9 flex-none items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCharges((p) => [...p, { account: '', amount: '' }])}
                className="flex h-8 items-center gap-1.5 self-start rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#0B3D2E] hover:bg-[#F4FBF6]"
              >
                <Plus className="h-4 w-4" /> Add a ledger
              </button>
            </div>

            <label className="grid gap-1">
              <span className={lbl}>Note</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} className={inp.replace('tabular-nums', '')} />
            </label>

            <div className="flex items-baseline justify-between rounded-[6px] bg-[#0B3D2E] px-3.5 py-2.5 text-white">
              <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">Leaves the bank</span>
              <span className="text-[16px] font-extrabold tabular-nums">{formatINR(total)}</span>
            </div>
            <p className="text-[11.5px] font-semibold leading-relaxed text-[#5A6B62]">
              Saved as one voucher under its present number. Each bill&rsquo;s balance, closure and margin release are worked out again from the new figures.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {!party && (
            <Button className="bg-[#0B3D2E] hover:bg-[#0A3327]" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
