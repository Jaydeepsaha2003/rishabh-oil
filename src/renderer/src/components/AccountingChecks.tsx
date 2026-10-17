import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ChargeLedgerPicker } from '@/components/ChargeRows'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ACCOUNTING CHECKS — the findings of the accounting audit that are about the
// books themselves rather than the code.
//
// TDS left on old sales invoices can be cleared here too — sales stopped
// carrying it on 2026-09-30, and the invoices before that are listed with what
// their voucher posted, then cleared only when an administrator confirms.
//
// One of them can be repaired here: the duplicate component vouchers on
// grouped sales invoices. It is shown first as a list — each invoice, the
// voucher kept, the vouchers that would go — and nothing is removed until an
// administrator picks them and confirms. Every removed voucher is archived
// line by line on the server, and its voucher number stays taken.
//
// The rest are lists only. Whether a PID went to the supplier or to our bank,
// the day upfront interest was actually paid, what an LC's bank really
// charged — each is a fact on a document the app does not have, so the app
// shows where the question is and leaves the answer to the person holding it.

function Section({
  title,
  count,
  tone,
  children,
  note
}: {
  title: string
  count: number
  tone: 'ok' | 'warn' | 'bad'
  children: React.ReactNode
  note: string
}): React.JSX.Element {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b px-4 py-3">
        {tone === 'ok' ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className={cn('mt-0.5 h-5 w-5 shrink-0', tone === 'bad' ? 'text-red-600' : 'text-amber-600')} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-bold">
            {title}
            <span className={cn('rounded px-1.5 py-0.5 text-[11px] tabular-nums', tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : tone === 'bad' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
              {count}
            </span>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{note}</p>
        </div>
      </div>
      {count > 0 && <div className="overflow-x-auto">{children}</div>}
    </Card>
  )
}

const th = 'whitespace-nowrap px-3 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground'
const td = 'whitespace-nowrap px-3 py-2 text-[12.5px]'

export function AccountingChecks(): React.JSX.Element {
  const [dups, setDups] = useState<Row | null>(null)
  const [checks, setChecks] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  // BANK A/C, per company, and where each company's postings should go.
  const [generic, setGeneric] = useState<Row[]>([])
  const [bankLedgers, setBankLedgers] = useState<Row[]>([])
  const [moveTo, setMoveTo] = useState<Record<number, string>>({})
  const [moving, setMoving] = useState<number | null>(null)
  // TDS still on sales invoices from before sales stopped carrying it.
  const [saleTds, setSaleTds] = useState<Row | null>(null)
  const [clearing, setClearing] = useState(false)
  // LC repayments whose charges went through the payable.
  const [lcCharges, setLcCharges] = useState<Row | null>(null)
  const [fixingLc, setFixingLc] = useState(false)
  // Sale vouchers still carrying their delivery freight.
  const [outFreight, setOutFreight] = useState<Row | null>(null)
  const [fixingFreight, setFixingFreight] = useState(false)
  const [shared, setShared] = useState<Row | null>(null)
  const [splitting, setSplitting] = useState(false)
  // Purchase / sale vouchers filed in the other company's books.
  const [wrongCo, setWrongCo] = useState<Row | null>(null)
  const [splitTk, setSplitTk] = useState<Row | null>(null)
  const [paisa, setPaisa] = useState<Row | null>(null)
  const [paisaPick, setPaisaPick] = useState<Set<number>>(new Set())
  const [balancing, setBalancing] = useState(false)
  const [splitPick, setSplitPick] = useState<Set<number>>(new Set())
  const [repricing, setRepricing] = useState(false)
  // Purchases whose TDS was worked before their slab's figures were known.
  const [staleTds, setStaleTds] = useState<Row | null>(null)
  const [tdsPick, setTdsPick] = useState<Set<number>>(new Set())
  const [reworking, setReworking] = useState(false)
  const [movingCo, setMovingCo] = useState(false)
  // LC vouchers on the ledgers chosen for LCs (Tally's).
  const [lcl, setLcl] = useState<Row | null>(null)
  const [lclForm, setLclForm] = useState<{ interest: string; charges: string; payables: Record<string, string> }>({ interest: '', charges: '', payables: {} })
  const [lclPick, setLclPick] = useState<Set<number>>(new Set())
  const [lclSaving, setLclSaving] = useState(false)
  const [lclMoving, setLclMoving] = useState(false)
  // BD / LC payment-in vouchers — the bank receipt is booked from Tally.
  const [payIns, setPayIns] = useState<Row | null>(null)
  const [payInPick, setPayInPick] = useState<Set<string>>(new Set())
  const [removingPayIns, setRemovingPayIns] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, c, g, accts, st] = await Promise.all([
        window.api.repairs.duplicateSales(),
        window.api.repairs.checks(),
        window.api.repairs.genericBank().catch(() => [] as Row[]),
        window.api.journal.accounts().catch(() => [] as Row[]),
        // Its own catch: one failing check must not blank the whole screen.
        window.api.repairs.saleTds().catch(() => null)
      ])
      setDups(d)
      setSaleTds(st)
      setLcCharges(await window.api.repairs.lcCharges().catch(() => null))
      setOutFreight(await window.api.repairs.outwardFreight().catch(() => null))
      setShared(await window.api.repairs.sharedLedgers().catch(() => null))
      setWrongCo(await window.api.repairs.wrongCompany().catch(() => null))
      const pz = await window.api.repairs.paisa().catch(() => null)
      setPaisa(pz)
      setPaisaPick(new Set((((pz?.findings as Row[]) || []).filter((x) => !x.review)).map((x) => Number(x.entry_id))))
      const lv = await window.api.repairs.lcLedgers().catch(() => null)
      setLcl(lv)
      setLclPick(new Set(((lv?.findings as Row[]) || []).map((x) => Number(x.line_id))))
      if (lv) {
        const st = (lv.settings as Row) || {}
        // Not chosen yet: offer Tally's ledgers where the books have them.
        const names = new Set(accts.map((a: Row) => String(a.name).toUpperCase()))
        const guessPayable = (asked: string): string => {
          const bank = asked.replace(/^LC PAYABLE - /, '').replace(/BANK|LTD|\s+/g, '')
          const hit = accts.find((a: Row) => /^LC WITH /i.test(String(a.name)) && bank && String(a.name).toUpperCase().replace(/\s+/g, '').includes(bank))
          return hit ? String(hit.name) : ''
        }
        setLclForm({
          interest: String(st.interest || (names.has('INTEREST (LC)') ? 'INTEREST (LC)' : '')),
          charges: String(st.charges || (names.has('LC CHARGES') ? 'LC CHARGES' : '')),
          payables: Object.fromEntries(
            ((lv.payables as string[]) || []).map((k) => [k, String((st.payables as Row)?.[k] || guessPayable(k))])
          )
        })
      }
      const pin = await window.api.repairs.paymentIns().catch(() => null)
      setPayIns(pin)
      setPayInPick(new Set(((pin?.findings as Row[]) || []).map((x) => String(x.key))))
      const stl = await window.api.repairs.staleTds().catch(() => null)
      setStaleTds(stl)
      setTdsPick(new Set(((stl?.findings as Row[]) || []).map((x) => Number(x.id))))
      const stk = await window.api.repairs.splitTanker().catch(() => null)
      setSplitTk(stk)
      // Every fixable one starts ticked; the list is the review.
      setSplitPick(new Set((((stk?.findings as Row[]) || []).filter((x) => !x.review)).map((x) => Number(x.id))))
      setChecks(c)
      setGeneric(g)
      setBankLedgers(
        accts.filter((a) => ['Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand'].includes(String(a.acc_group || '')) && String(a.name) !== 'BANK A/C')
      )
      setMoveTo((m) => {
        const next = { ...m }
        for (const r of g) if (!next[Number(r.company_id)] && r.suggested) next[Number(r.company_id)] = String(r.suggested)
        return next
      })
      setError(null)
      // Everything removable starts ticked; the list is the review.
      setPicked(new Set(((d?.findings as Row[]) || []).flatMap((f) => (f.duplicates as Row[]).map((x) => Number(x.entry_id)))))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const findings: Row[] = useMemo(() => (dups?.findings as Row[]) || [], [dups])
  const pickedAmount = useMemo(
    () => findings.flatMap((f) => f.duplicates as Row[]).filter((d) => picked.has(Number(d.entry_id))).reduce((s, d) => s + Number(d.amount), 0),
    [findings, picked]
  )

  async function remove(): Promise<void> {
    const ids = [...picked]
    if (!ids.length) return
    const ok = window.confirm(
      `Remove ${ids.length} duplicate sales voucher${ids.length === 1 ? '' : 's'} totalling ${formatINR(pickedAmount)}?\n\n` +
        'Each one repeats a row of an invoice whose own voucher already carries the whole invoice. ' +
        'They are archived before removal and their voucher numbers stay taken. Take a database snapshot first if you want a copy you can restore.'
    )
    if (!ok) return
    setBusy(true)
    try {
      const r = await window.api.repairs.removeDuplicateSales(ids)
      toast.success(`Removed ${r.removed} duplicate voucher${r.removed === 1 ? '' : 's'} — ${formatINR(r.revenue)} of double-counted revenue`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const tdsFindings: Row[] = useMemo(() => (saleTds?.findings as Row[]) || [], [saleTds])
  const tdsClearable = useMemo(() => tdsFindings.filter((x) => !x.review), [tdsFindings])

  async function clearTds(): Promise<void> {
    const keys = tdsClearable.map((x) => `${x.company_id}:${x.invoice_key}`)
    if (!keys.length) return
    const posted = tdsClearable.filter((x) => x.entry_id).length
    const ok = window.confirm(
      `Clear TDS from ${keys.length} sales invoice${keys.length === 1 ? '' : 's'}?\n\n` +
        `${posted} voucher${posted === 1 ? '' : 's'} lose${posted === 1 ? 's its' : ' their'} TDS RECEIVABLE line (${formatINR(Number(saleTds?.voucher_tds) || 0)} in all), ` +
        'and the customer is debited the whole invoice instead. Nothing else in a voucher changes — its number, date and other lines stay as they are. ' +
        'The invoice lines’ TDS goes to 0. Everything is archived first. Take a database snapshot first if you want a copy you can restore.'
    )
    if (!ok) return
    setClearing(true)
    try {
      const r = await window.api.repairs.clearSaleTds(keys)
      toast.success(`TDS cleared from ${r.invoices} invoice${r.invoices === 1 ? '' : 's'} — ${formatINR(r.tds)} moved back onto the customers`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setClearing(false)
    }
  }

  const lcFindings: Row[] = useMemo(() => (lcCharges?.findings as Row[]) || [], [lcCharges])
  const lcFixable = useMemo(() => lcFindings.filter((x) => !x.review), [lcFindings])

  async function fixLc(): Promise<void> {
    const ids = lcFixable.map((x) => Number(x.repayment_id))
    if (!ids.length) return
    const ok = window.confirm(
      `Re-post ${ids.length} LC repayment${ids.length === 1 ? '' : 's'} as one voucher each?\n\n` +
        'Each repayment payment keeps its number and date; its LC PAYABLE line drops to the principal and the bank/commission charges move onto it, so the payment reads Dr LC PAYABLE + Dr BANK CHARGES / Cr BANK. ' +
        'The separate charges journal is archived and removed. No ledger balance changes. Take a database snapshot first if you want a copy you can restore.'
    )
    if (!ok) return
    setFixingLc(true)
    try {
      const r = await window.api.repairs.fixLcCharges(ids)
      toast.success(`${r.fixed} repayment${r.fixed === 1 ? '' : 's'} re-posted — ${formatINR(r.charges)} of charges now straight out of the bank`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setFixingLc(false)
    }
  }

  const frFindings: Row[] = useMemo(() => (outFreight?.findings as Row[]) || [], [outFreight])
  const frFixable = useMemo(() => frFindings.filter((x) => !x.review), [frFindings])

  async function fixFreight(): Promise<void> {
    const ids = frFixable.map((x) => Number(x.entry_id))
    if (!ids.length) return
    const total = frFixable.reduce((s, x) => s + Number(x.freight), 0)
    const ok = window.confirm(
      `Take the delivery freight off ${ids.length} sale voucher${ids.length === 1 ? '' : 's'} (${formatINR(total)})?\n\n` +
        'Only the Dr FREIGHT OUTWARD / Cr FREIGHT PAYABLE pair is removed from each voucher — its number, date, customer, sales and GST lines stay exactly as they are. ' +
        'The freight stays on Fr. Outward Working and is posted when the transporter’s bill is booked there. Every voucher is archived first. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setFixingFreight(true)
    try {
      const r = await window.api.repairs.fixOutwardFreight(ids)
      toast.success(`Freight taken off ${r.fixed} sale voucher${r.fixed === 1 ? '' : 's'} — ${formatINR(r.freight)} now waits for the transporter’s bill`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setFixingFreight(false)
    }
  }

  const wcFindings: Row[] = useMemo(() => (wrongCo?.findings as Row[]) || [], [wrongCo])
  async function moveWrongCo(): Promise<void> {
    const ids = wcFindings.map((x) => Number(x.entry_id))
    if (!ids.length) return
    const byCo = new Map<string, number>()
    for (const x of wcFindings) byCo.set(`${x.from_company} → ${x.to_company}`, (byCo.get(`${x.from_company} → ${x.to_company}`) || 0) + 1)
    const ok = window.confirm(
      `Move ${ids.length} voucher${ids.length === 1 ? '' : 's'} into the books they belong to?\n\n` +
        [...byCo].map(([k, n]) => `• ${n} from ${k}`).join('\n') +
        '\n\nOnly the company changes — each takes the next voucher number in its own company. Lines, amounts and dates stay exactly as they are, and the old state is logged. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setMovingCo(true)
    try {
      const r = await window.api.repairs.moveWrongCompany(ids)
      toast.success(`${r.moved} voucher${r.moved === 1 ? '' : 's'} moved — now ${r.codes.slice(0, 3).join(', ')}${r.codes.length > 3 ? '…' : ''}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setMovingCo(false)
    }
  }

  const pzFindings: Row[] = useMemo(() => (paisa?.findings as Row[]) || [], [paisa])
  async function balancePaisa(): Promise<void> {
    const ids = [...paisaPick]
    if (!ids.length) return
    const ok = window.confirm(
      `Balance ${ids.length} voucher${ids.length === 1 ? '' : 's'}?\n\nOnly each voucher's ROUND OFF A/C line moves, by the paisa it is out (one is added where there is none). The party, the sales or purchase account and the taxes stay exactly as they are. The old lines are logged. Take a database snapshot if you want a copy you can restore.`
    )
    if (!ok) return
    setBalancing(true)
    try {
      const r = await window.api.repairs.fixPaisa(ids)
      toast.success(`${Number(r.fixed) || 0} voucher${Number(r.fixed) === 1 ? '' : 's'} balanced`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBalancing(false)
    }
  }
  const stFindings: Row[] = useMemo(() => (splitTk?.findings as Row[]) || [], [splitTk])
  async function repriceSplit(): Promise<void> {
    const ids = [...splitPick]
    if (!ids.length) return
    const ok = window.confirm(
      `Re-price ${ids.length} purchase${ids.length === 1 ? '' : 's'} on their tanker's two bargains?\n\n` +
        stFindings
          .filter((x) => splitPick.has(Number(x.id)))
          .map((x) => `• ${x.invoice_no}: taxable ${formatINR(Number(x.taxable_before))} → ${formatINR(Number(x.taxable_after))}`)
          .join('\n') +
        '\n\nEach is saved exactly as opening it and pressing Save would: its payable and purchase voucher are re-posted and the change goes in its history. The old figures are logged. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setRepricing(true)
    try {
      const r = await window.api.repairs.fixSplitTanker(ids)
      toast.success(`${Number(r.changed) || 0} purchase${Number(r.changed) === 1 ? '' : 's'} re-priced`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRepricing(false)
    }
  }

  const lclRows: Row[] = useMemo(() => (lcl?.findings as Row[]) || [], [lcl])
  const lclSaved = (lcl?.settings as Row) || {}
  const lclDirty =
    String(lclForm.interest || '') !== String(lclSaved.interest || '') ||
    String(lclForm.charges || '') !== String(lclSaved.charges || '') ||
    Object.entries(lclForm.payables).some(([k, v]) => String(v || '') !== String((lclSaved.payables as Row)?.[k] || ''))
  async function saveLcl(): Promise<void> {
    setLclSaving(true)
    try {
      await window.api.repairs.saveLcLedgers(lclForm)
      toast.success('LC ledgers saved — every LC posting uses them from now on')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLclSaving(false)
    }
  }
  async function moveLcl(): Promise<void> {
    const ids = [...lclPick]
    if (!ids.length) return
    const vchs = new Set(lclRows.filter((x) => lclPick.has(Number(x.line_id))).map((x) => Number(x.entry_id))).size
    if (
      !window.confirm(
        `Move ${ids.length} line${ids.length === 1 ? '' : 's'} on ${vchs} LC voucher${vchs === 1 ? '' : 's'} to the ledgers chosen for LCs?\n\nOnly the ledger each line sits on changes — amounts, sides, dates and voucher numbers stay. Every move is logged. Take a database snapshot if you want a copy you can restore.`
      )
    )
      return
    setLclMoving(true)
    try {
      const r = await window.api.repairs.fixLcLedgers(ids)
      toast.success(`${r.moved} line${r.moved === 1 ? '' : 's'} moved on ${r.vouchers} LC voucher${r.vouchers === 1 ? '' : 's'}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLclMoving(false)
    }
  }

  const payInRows: Row[] = useMemo(() => (payIns?.findings as Row[]) || [], [payIns])
  async function removePayIns(): Promise<void> {
    const keys = [...payInPick]
    if (!keys.length) return
    const ok = window.confirm(
      `Remove ${keys.length} payment-in voucher${keys.length === 1 ? '' : 's'}?\n\n` +
        payInRows
          .filter((x) => payInPick.has(String(x.key)))
          .map((x) => `• ${x.code} — ${String(x.kind).toUpperCase()} ${x.facility}, ${formatDate(String(x.date))}, ${formatINR(Number(x.amount))} from ${x.party}`)
          .join('\n') +
        '\n\nEach voucher, its lines and allocations go; the payment in stays on its bill or LC as a record, and the voucher number stays taken. The bank keeps the receipt booked from Tally. The removed lines are logged. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setRemovingPayIns(true)
    try {
      const r = await window.api.repairs.fixPaymentIns(keys)
      toast.success(`${Number(r.removed) || 0} payment-in voucher${Number(r.removed) === 1 ? '' : 's'} removed`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemovingPayIns(false)
    }
  }

  const staleRows: Row[] = useMemo(() => (staleTds?.findings as Row[]) || [], [staleTds])
  async function reworkTds(): Promise<void> {
    const ids = [...tdsPick]
    if (!ids.length) return
    const ok = window.confirm(
      `Re-work the TDS on ${ids.length} purchase${ids.length === 1 ? '' : 's'}?\n\n` +
        staleRows
          .filter((x) => tdsPick.has(Number(x.id)))
          .map((x) => `• ${x.invoice_no} (${x.supplier}): TDS ${formatINR(Number(x.tds_before))} → ${formatINR(Number(x.tds_after))}`)
          .join('\n') +
        '\n\nOnly the TDS changes — taxable, GST, round off and rate stay as they are. The net and the supplier’s payable follow it, the purchase voucher is re-posted in place and the change goes in its history. The old figures are logged. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setReworking(true)
    try {
      const r = await window.api.repairs.fixStaleTds(ids)
      toast.success(`TDS re-worked on ${Number(r.changed) || 0} purchase${Number(r.changed) === 1 ? '' : 's'}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReworking(false)
    }
  }

  const slFindings: Row[] = useMemo(() => (shared?.findings as Row[]) || [], [shared])
  const slFixable = useMemo(() => slFindings.filter((x) => !x.review), [slFindings])
  async function splitShared(): Promise<void> {
    const keys = slFixable.map((x) => String(x.key))
    if (!keys.length) return
    const ok = window.confirm(
      `Split ${keys.length} shared ledger${keys.length === 1 ? '' : 's'}?\n\n` +
        slFixable.map((x) => `• ${x.party}: ${x.entries} ${x.moving === 'customer' ? 'sale' : 'purchase'} voucher${Number(x.entries) === 1 ? '' : 's'} from ${x.ledger} → ${x.target}`).join('\n') +
        '\n\nOnly which ledger those lines sit in changes — amounts, dates and voucher numbers stay exactly as they are, and every moved line is logged. Receipts, payments and journals on the shared ledger stay where they are. Take a database snapshot if you want a copy you can restore.'
    )
    if (!ok) return
    setSplitting(true)
    try {
      const r = await window.api.repairs.fixSharedLedgers(keys)
      toast.success(`Split ${r.fixed} — ${r.lines} line${r.lines === 1 ? '' : 's'} moved to ${r.ledgers.join(', ')}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSplitting(false)
    }
  }

  async function moveGeneric(r: Row): Promise<void> {
    const cid = Number(r.company_id)
    const to = moveTo[cid]
    if (!to) return void toast.error('Pick the bank to move them to')
    const ok = window.confirm(
      `Move ${r.lines} BANK A/C posting${Number(r.lines) === 1 ? '' : 's'} (${r.vouchers} voucher${Number(r.vouchers) === 1 ? '' : 's'}) of ${r.company_name || 'this company'} to ${to}?\n\n` +
        'Only the bank line of each voucher changes — amounts, dates and voucher numbers stay the same. The bills are told their bank, and BANK A/C in this company then points to it. Every moved line is logged.'
    )
    if (!ok) return
    setMoving(cid)
    try {
      const res = await window.api.repairs.moveGenericBank(cid, to)
      toast.success(`Moved ${res.lines} posting${res.lines === 1 ? '' : 's'} to ${res.account}`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setMoving(null)
    }
  }

  if (loading && !dups) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking the books…
      </div>
    )
  }
  if (error) return <div className="py-10 text-sm text-red-600">{error}</div>

  const unconfirmed: Row[] = checks?.bd_route_unconfirmed || []
  const upfront: Row[] = checks?.bd_upfront_unposted || []
  const lcRes: Row[] = checks?.lc_residuals || []
  const removable = findings.filter((f) => (f.duplicates as Row[]).length)
  const review = findings.filter((f) => f.review)

  return (
    <div className="flex max-w-[1100px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          What the accounting audit found in the books, across every company. TDS on sales, LC repayment charges, delivery freight on sale vouchers, BANK A/C postings and duplicate sales vouchers can be repaired from here; the rest need the bank's or the NBFC's own papers.
        </p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Check again
        </Button>
      </div>

      <Section
        title="TDS on sales invoices"
        count={tdsFindings.length}
        tone={tdsFindings.length ? 'warn' : 'ok'}
        note={
          tdsFindings.length
            ? 'Sales no longer carry TDS — the customer is debited the whole invoice and TDS is posted by hand when they deduct it. These invoices were saved before that and still hold it. Clearing takes the TDS RECEIVABLE line out of each voucher and adds it to the customer’s debit; nothing else in the voucher changes.'
            : 'No sales invoice carries TDS — every sale debits the customer the whole invoice.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Company</th>
              <th className={th}>Invoice</th>
              <th className={th}>Date</th>
              <th className={th}>Party</th>
              <th className={cn(th, 'text-right')}>TDS on voucher</th>
              <th className={cn(th, 'text-right')}>TDS on lines</th>
              <th className={th}>Voucher</th>
            </tr>
          </thead>
          <tbody>
            {tdsFindings.map((x) => (
              <tr key={`${x.company_id}-${x.invoice_key}`} className={cn('border-t', x.review && 'bg-amber-50/60')}>
                <td className={td}>{x.company_name || `Company ${x.company_id}`}</td>
                <td className={cn(td, 'font-semibold')}>
                  {x.invoice_no}
                  {x.review && <div className="whitespace-normal text-[11px] font-medium text-amber-800">Needs review — {x.review}</div>}
                </td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(x.sale_date)}</td>
                <td className={cn(td, 'max-w-[220px] truncate')} title={x.party}>
                  {x.party || '—'}
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>{Number(x.voucher_tds) ? formatINR(x.voucher_tds) : '—'}</td>
                <td className={cn(td, 'text-right tabular-nums text-muted-foreground')}>{Number(x.lines_tds) ? formatINR(x.lines_tds) : '—'}</td>
                <td className={cn(td, 'tabular-nums text-muted-foreground')}>{x.entry_id ? `#${x.entry_id}` : 'not posted'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {tdsClearable.length} invoice{tdsClearable.length === 1 ? '' : 's'} can be cleared
            {Number(saleTds?.needs_review) ? ` · ${saleTds?.needs_review} left for review (not touched)` : ''}
          </span>
          <Button className="ml-auto gap-1.5" disabled={!tdsClearable.length || clearing} onClick={() => void clearTds()}>
            {clearing && <Loader2 className="h-4 w-4 animate-spin" />}
            Clear TDS from {tdsClearable.length} invoice{tdsClearable.length === 1 ? '' : 's'} · {formatINR(Number(saleTds?.voucher_tds) || 0)}
          </Button>
        </div>
      </Section>

      <Section
        title="LC repayment charges posted through the payable"
        count={lcFindings.length}
        tone={lcFindings.length ? 'warn' : 'ok'}
        note={
          lcFindings.length
            ? 'These repayments put the bank’s charges through LC PAYABLE in a second voucher, so the payable shows the charges as owed on the LC and then repaid. Re-posting makes each one a single payment: Dr LC PAYABLE (the principal) + Dr BANK CHARGES / Cr BANK (the whole debit). Balances do not change.'
            : 'Every LC repayment posts as one payment — the principal off the payable and the charges straight to expense.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Company</th>
              <th className={th}>LC</th>
              <th className={th}>Repaid</th>
              <th className={cn(th, 'text-right')}>Debited</th>
              <th className={cn(th, 'text-right')}>Charges</th>
              <th className={cn(th, 'text-right')}>Principal</th>
              <th className={th}>Vouchers</th>
            </tr>
          </thead>
          <tbody>
            {lcFindings.map((x) => (
              <tr key={String(x.repayment_id)} className={cn('border-t', x.review && 'bg-amber-50/60')}>
                <td className={td}>{x.company_name || `Company ${x.company_id}`}</td>
                <td className={cn(td, 'font-semibold')}>
                  {x.lc_no}
                  {x.review && <div className="whitespace-normal text-[11px] font-medium text-amber-800">Needs review — {x.review}</div>}
                </td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(x.repay_date)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(x.total)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(x.charges)}</td>
                <td className={cn(td, 'text-right tabular-nums font-semibold')}>{formatINR(Number(x.total) - Number(x.charges))}</td>
                <td className={cn(td, 'tabular-nums text-muted-foreground')}>
                  #{x.payment_entry_id} + #{x.fee_entry_id}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {lcFixable.length} repayment{lcFixable.length === 1 ? '' : 's'} can be re-posted
            {lcFindings.length - lcFixable.length ? ` · ${lcFindings.length - lcFixable.length} left for review (not touched)` : ''}
          </span>
          <Button className="ml-auto gap-1.5" disabled={!lcFixable.length || fixingLc} onClick={() => void fixLc()}>
            {fixingLc && <Loader2 className="h-4 w-4 animate-spin" />}
            Re-post {lcFixable.length} repayment{lcFixable.length === 1 ? '' : 's'} as one voucher
          </Button>
        </div>
      </Section>

      <Section
        title="Delivery freight posted with the sale"
        count={frFindings.length}
        tone={frFindings.length ? 'warn' : 'ok'}
        note={
          frFindings.length
            ? 'These sale vouchers still carry Dr FREIGHT OUTWARD / Cr FREIGHT PAYABLE from before delivery freight waited for the transporter’s bill. Taking it off leaves the freight on Fr. Outward Working until the bill is booked, which then posts it — the same way every new invoice now works. Customer, sales and GST figures do not change.'
            : 'No sale voucher carries delivery freight — it waits on Fr. Outward Working until the transporter’s bill is booked.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Company</th>
              <th className={th}>Invoice</th>
              <th className={th}>Date</th>
              <th className={th}>Customer</th>
              <th className={th}>Transporter</th>
              <th className={cn(th, 'text-right')}>Freight</th>
            </tr>
          </thead>
          <tbody>
            {frFindings.map((x) => (
              <tr key={String(x.entry_id)} className={cn('border-t', x.review && 'bg-amber-50/60')}>
                <td className={td}>{x.company_name || `Company ${x.company_id}`}</td>
                <td className={cn(td, 'font-semibold')}>
                  {x.invoice_no}
                  {x.review && <div className="whitespace-normal text-[11px] font-medium text-amber-800">Needs review — {x.review}</div>}
                </td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(x.sale_date)}</td>
                <td className={td}>{x.customer}</td>
                <td className={td}>{x.transporter}</td>
                <td className={cn(td, 'text-right tabular-nums font-semibold')}>{formatINR(x.freight)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {frFixable.length} voucher{frFixable.length === 1 ? '' : 's'} can be cleared
            {frFindings.length - frFixable.length ? ` · ${frFindings.length - frFixable.length} left for review (not touched)` : ''}
          </span>
          <Button className="ml-auto gap-1.5" disabled={!frFixable.length || fixingFreight} onClick={() => void fixFreight()}>
            {fixingFreight && <Loader2 className="h-4 w-4 animate-spin" />}
            Take freight off {frFixable.length} sale voucher{frFixable.length === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Section
        title="Vouchers in the other company’s books"
        count={wcFindings.length}
        tone={wcFindings.length ? 'warn' : 'ok'}
        note={
          wcFindings.length
            ? 'A purchase used to post its voucher into whichever company was open, not the company the purchase belongs to. An inter-company purchase is raised from the seller’s books, so KR FOODS’ purchases from KR FINMARK were filed in KR FINMARK — leaving KR FOODS’ ledger for KR FINMARK empty. New purchases now post to their own company; move these to theirs.'
            : 'Every purchase and sale voucher is in the books of the company its document belongs to.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Voucher</th>
              <th className={th}>Date</th>
              <th className={th}>Bill / invoice</th>
              <th className={th}>Party</th>
              <th className={cn(th, 'text-right')}>Amount</th>
              <th className={th}>Now in</th>
              <th className={th}>Belongs to</th>
            </tr>
          </thead>
          <tbody>
            {wcFindings.map((x) => (
              <tr key={String(x.entry_id)} className="border-t">
                <td className={cn(td, 'font-semibold tabular-nums')}>
                  {String(x.code || x.vch_type)}
                  <div className="text-[11px] font-normal text-muted-foreground">{String(x.vch_type)}</div>
                </td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(String(x.date))}</td>
                <td className={td}>
                  {String(x.doc_no || x.vch_no)}
                  <div className="text-[11px] text-muted-foreground">{x.doc === 'sale' ? 'sale' : 'purchase'}</div>
                </td>
                <td className={td}>{String(x.party)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(Number(x.amount) || 0)}</td>
                <td className={cn(td, 'text-[12px] text-amber-700')}>{String(x.from_company)}</td>
                <td className={cn(td, 'text-[12px] font-semibold')}>{String(x.to_company)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {wcFindings.length} voucher{wcFindings.length === 1 ? '' : 's'} · {formatINR(Number(wrongCo?.amount) || 0)}
          </span>
          <Button className="ml-auto gap-1.5" disabled={!wcFindings.length || movingCo} onClick={() => void moveWrongCo()}>
            {movingCo && <Loader2 className="h-4 w-4 animate-spin" />}
            Move {wcFindings.length} voucher{wcFindings.length === 1 ? '' : 's'} to their own company
          </Button>
        </div>
      </Section>

      <Section
        title="Vouchers a paisa out of balance"
        count={pzFindings.length}
        tone={pzFindings.length ? 'warn' : 'ok'}
        note={
          pzFindings.length
            ? 'Dr and Cr on these vouchers differ — on a sale, by the paisa the CGST/SGST split rounded away. Balancing moves only the ROUND OFF A/C line by that paisa; new and re-saved sales already balance this way. Anything more than five paise is not rounding and is left for review.'
            : 'Every voucher’s Dr equals its Cr.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={cn(th, 'w-8')} />
              <th className={th}>Date</th>
              <th className={th}>Voucher</th>
              <th className={th}>Company</th>
              <th className={cn(th, 'text-right')}>Dr</th>
              <th className={cn(th, 'text-right')}>Cr</th>
              <th className={cn(th, 'text-right')}>Out by</th>
            </tr>
          </thead>
          <tbody>
            {pzFindings.map((x) => {
              const id = Number(x.entry_id)
              return (
                <tr key={id} className="border-t">
                  <td className={td}>
                    {!x.review && (
                      <input
                        type="checkbox"
                        checked={paisaPick.has(id)}
                        onChange={(e) =>
                          setPaisaPick((s) => {
                            const next = new Set(s)
                            if (e.target.checked) next.add(id)
                            else next.delete(id)
                            return next
                          })
                        }
                      />
                    )}
                  </td>
                  <td className={cn(td, 'tabular-nums')}>{formatDate(String(x.date))}</td>
                  <td className={td}>
                    <span className="font-semibold">{String(x.vch_no || '—')}</span>
                    <div className="text-[11px] text-muted-foreground">{String(x.type)}</div>
                  </td>
                  <td className={td}>{String(x.company)}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(Number(x.dr))}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(Number(x.cr))}</td>
                  <td className={cn(td, 'text-right tabular-nums font-semibold')}>
                    {formatINR(Math.abs(Number(x.diff)))}
                    {x.review && <div className="text-[11.5px] font-semibold text-amber-700">{String(x.review)}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {paisaPick.size} of {pzFindings.filter((x) => !x.review).length} ticked
          </span>
          <Button className="ml-auto gap-1.5" disabled={!paisaPick.size || balancing} onClick={() => void balancePaisa()}>
            {balancing && <Loader2 className="h-4 w-4 animate-spin" />}
            Balance {paisaPick.size} voucher{paisaPick.size === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Section
        title="Purchases billed at one rate on a split tanker"
        count={stFindings.length}
        tone={stFindings.length ? 'warn' : 'ok'}
        note={
          stFindings.length
            ? 'Each of these tankers is split across two bargains — part on its own, the rest on a second one at a different rate — but its purchase was saved before the split and still bills the whole tanker at the first rate. Re-pricing does exactly what opening the purchase and pressing Save does: each part at its own bargain’s rate, then GST, TDS and the round off on the invoice’s own terms.'
            : 'Every purchase on a split tanker is billed at each bargain’s own rate.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={cn(th, 'w-8')} />
              <th className={th}>Purchase</th>
              <th className={th}>Supplier</th>
              <th className={th}>Tanker split</th>
              <th className={cn(th, 'text-right')}>Taxable now → after</th>
              <th className={cn(th, 'text-right')}>Net now → after</th>
            </tr>
          </thead>
          <tbody>
            {stFindings.map((x) => {
              const id = Number(x.id)
              return (
                <tr key={id} className="border-t">
                  <td className={td}>
                    {!x.review && (
                      <input
                        type="checkbox"
                        checked={splitPick.has(id)}
                        onChange={(e) =>
                          setSplitPick((s) => {
                            const next = new Set(s)
                            if (e.target.checked) next.add(id)
                            else next.delete(id)
                            return next
                          })
                        }
                      />
                    )}
                  </td>
                  <td className={td}>
                    <span className="font-semibold">{String(x.invoice_no)}</span>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(String(x.order_date))} · {String(x.company)}
                    </div>
                  </td>
                  <td className={td}>{String(x.supplier)}</td>
                  <td className={cn(td, 'text-[12px] tabular-nums')}>
                    {((x.lines as Row[]) || []).map((l, i) => (
                      <div key={i}>
                        {Number(l.qty)} MT @ {formatINR(Number(l.rate))}
                      </div>
                    ))}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    <span className="text-muted-foreground">{formatINR(Number(x.taxable_before))}</span>
                    <div className="font-semibold">{formatINR(Number(x.taxable_after))}</div>
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    <span className="text-muted-foreground">{formatINR(Number(x.net_before))}</span>
                    <div className="font-semibold">{formatINR(Number(x.net_after))}</div>
                    {x.review && <div className="mt-1 text-[11.5px] font-semibold text-amber-700">{String(x.review)}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {splitPick.size} of {stFindings.filter((x) => !x.review).length} ticked
          </span>
          <Button className="ml-auto gap-1.5" disabled={!splitPick.size || repricing} onClick={() => void repriceSplit()}>
            {repricing && <Loader2 className="h-4 w-4 animate-spin" />}
            Re-price {splitPick.size} purchase{splitPick.size === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Card className="overflow-hidden p-0">
        <div className="flex items-start gap-3 border-b px-4 py-3">
          {lclRows.length || lclDirty || !lclSaved.interest ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[14px] font-bold">
              LC vouchers on Tally&rsquo;s ledgers
              <span className={cn('rounded px-1.5 py-0.5 text-[11px] tabular-nums', lclRows.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700')}>
                {lclRows.length}
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Tally keeps LCs on its own ledgers — INTEREST (LC), LC CHARGES, LC WITH HDFC BANK LTD — where the app posted to INTEREST A/C, BANK CHARGES A/C and LC PAYABLE. Pick the ledgers once (step 1); every LC posting uses them from then on. Then move the LC vouchers already posted (step 2) — including a supplier&rsquo;s payment an LC put on their customer ledger.
            </p>
          </div>
        </div>
        <div className="grid gap-3 border-b bg-[#FBFCFA] px-4 py-3">
          <div className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#0B6B45]">Step 1 · The ledgers LCs post to</div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-[11px] font-bold text-muted-foreground">LC interest</span>
              <div className="flex"><ChargeLedgerPicker value={lclForm.interest} onPick={(v) => setLclForm((f) => ({ ...f, interest: v }))} /></div>
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-bold text-muted-foreground">LC charges and commission</span>
              <div className="flex"><ChargeLedgerPicker value={lclForm.charges} onPick={(v) => setLclForm((f) => ({ ...f, charges: v }))} /></div>
            </label>
            {Object.keys(lclForm.payables).map((k) => (
              <label key={k} className="grid gap-1">
                <span className="text-[11px] font-bold text-muted-foreground">LC liability — instead of {k}</span>
                <div className="flex">
                  <ChargeLedgerPicker value={lclForm.payables[k] || ''} onPick={(v) => setLclForm((f) => ({ ...f, payables: { ...f.payables, [k]: v } }))} />
                </div>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[12px] text-muted-foreground">
              {lclDirty ? 'Not saved yet — the list below follows what is saved.' : lclSaved.interest || lclSaved.charges ? 'Saved — LC postings use these.' : 'Nothing chosen yet — LCs post to the app’s own ledgers.'}
            </span>
            <Button className="ml-auto gap-1.5" disabled={!lclDirty || lclSaving} onClick={() => void saveLcl()}>
              {lclSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save LC ledgers
            </Button>
          </div>
        </div>
        {lclRows.length > 0 && (
          <>
            <div className="px-4 pt-3 text-[11px] font-extrabold uppercase tracking-[.1em] text-[#0B6B45]">Step 2 · Lines to move</div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead className="bg-muted/40">
                  <tr>
                    <th className={cn(th, 'w-8')}>
                      <input
                        type="checkbox"
                        aria-label="Tick all"
                        checked={lclPick.size === lclRows.length}
                        onChange={(e) => setLclPick(e.target.checked ? new Set(lclRows.map((x) => Number(x.line_id))) : new Set())}
                      />
                    </th>
                    <th className={th}>Voucher</th>
                    <th className={th}>LC</th>
                    <th className={cn(th, 'text-right')}>Amount</th>
                    <th className={th}>From</th>
                    <th className={th}>To</th>
                  </tr>
                </thead>
                <tbody>
                  {lclRows.map((x) => {
                    const id = Number(x.line_id)
                    return (
                      <tr key={id} className="border-t">
                        <td className={td}>
                          <input
                            type="checkbox"
                            checked={lclPick.has(id)}
                            onChange={(e) =>
                              setLclPick((s0) => {
                                const next = new Set(s0)
                                if (e.target.checked) next.add(id)
                                else next.delete(id)
                                return next
                              })
                            }
                          />
                        </td>
                        <td className={td}>
                          <span className="font-semibold">{String(x.code || '—')}</span>
                          <div className="text-[11px] text-muted-foreground">
                            {formatDate(String(x.date))} · {String(x.company || '')}
                          </div>
                        </td>
                        <td className={td}>{String(x.lc_no)}</td>
                        <td className={cn(td, 'text-right tabular-nums')}>
                          {formatINR(Number(x.dr) || Number(x.cr))} {Number(x.dr) > 0 ? 'Dr' : 'Cr'}
                        </td>
                        <td className={td}>
                          <span className="text-muted-foreground">{String(x.from)}</span>
                          <div className={cn('text-[10.5px] font-bold', x.why === 'supplier on a customer ledger' ? 'text-red-700' : 'text-muted-foreground')}>{String(x.why)}</div>
                        </td>
                        <td className={cn(td, 'font-semibold')}>→ {String(x.to)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
              <span className="text-[12.5px] text-muted-foreground">
                {lclPick.size} of {lclRows.length} ticked
              </span>
              <Button className="ml-auto gap-1.5" disabled={!lclPick.size || lclMoving || lclDirty} onClick={() => void moveLcl()}>
                {lclMoving && <Loader2 className="h-4 w-4 animate-spin" />}
                Move {lclPick.size} line{lclPick.size === 1 ? '' : 's'} to Tally&rsquo;s ledgers
              </Button>
            </div>
          </>
        )}
      </Card>

      <Section
        title="Payment-in vouchers on discounted bills and LCs"
        count={payInRows.length}
        tone={payInRows.length ? 'warn' : 'ok'}
        note={
          payInRows.length
            ? 'A payment in on a discounted bill or an LC used to post its own bank receipt — but the bank’s receipt is already in the books, booked from Tally, so the money stood in the bank twice (it shows as "Not in Tally" on the Bank Book). Payment in is now kept on the bill or LC only. Removing these takes the extra receipts out; the payment-in records stay.'
            : 'No payment in on a discounted bill or LC posts a voucher of its own.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={cn(th, 'w-8')}>
                <input
                  type="checkbox"
                  aria-label="Tick all"
                  checked={payInRows.length > 0 && payInPick.size === payInRows.length}
                  onChange={(e) => setPayInPick(e.target.checked ? new Set(payInRows.map((x) => String(x.key))) : new Set())}
                />
              </th>
              <th className={th}>Voucher</th>
              <th className={th}>Bill / LC</th>
              <th className={th}>From</th>
              <th className={th}>Into</th>
              <th className={cn(th, 'text-right')}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {payInRows.map((x) => {
              const k = String(x.key)
              return (
                <tr key={k} className="border-t">
                  <td className={td}>
                    <input
                      type="checkbox"
                      checked={payInPick.has(k)}
                      onChange={(e) =>
                        setPayInPick((s) => {
                          const next = new Set(s)
                          if (e.target.checked) next.add(k)
                          else next.delete(k)
                          return next
                        })
                      }
                    />
                  </td>
                  <td className={td}>
                    <span className="font-semibold">{String(x.code || '—')}</span>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(String(x.date))} · {String(x.company)}
                    </div>
                  </td>
                  <td className={td}>
                    {String(x.kind).toUpperCase()} {String(x.facility)}
                  </td>
                  <td className={td}>{String(x.party)}</td>
                  <td className={td}>{String(x.bank)}</td>
                  <td className={cn(td, 'text-right tabular-nums font-semibold')}>{formatINR(Number(x.amount))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {payInPick.size} of {payInRows.length} ticked
          </span>
          <Button variant="destructive" className="ml-auto gap-1.5" disabled={!payInPick.size || removingPayIns} onClick={() => void removePayIns()}>
            {removingPayIns ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Remove {payInPick.size} voucher{payInPick.size === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Section
        title="Purchases whose TDS is older than their slab"
        count={staleRows.length}
        tone={staleRows.length ? 'warn' : 'ok'}
        note={
          staleRows.length
            ? 'A purchase’s TDS is worked when it is saved, from where the supplier stood in the year at that moment — the purchases before it and the “Purchase bill amount (as on)” on the supplier. These were saved before that figure was entered (or before an earlier bill was), so they still carry the TDS of a slab that had not been crossed. Re-working gives each the TDS its slab gives today — what Save would give — and changes nothing else.'
            : 'Every purchase carries the TDS its slab gives today.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={cn(th, 'w-8')}>
                <input
                  type="checkbox"
                  aria-label="Tick all"
                  checked={staleRows.length > 0 && tdsPick.size === staleRows.length}
                  onChange={(e) => setTdsPick(e.target.checked ? new Set(staleRows.map((x) => Number(x.id))) : new Set())}
                />
              </th>
              <th className={th}>Purchase</th>
              <th className={th}>Supplier</th>
              <th className={cn(th, 'text-right')}>Taxable</th>
              <th className={cn(th, 'text-right')}>Bought before it this year</th>
              <th className={cn(th, 'text-right')}>TDS now → after</th>
              <th className={cn(th, 'text-right')}>Net now → after</th>
            </tr>
          </thead>
          <tbody>
            {staleRows.map((x) => {
              const id = Number(x.id)
              return (
                <tr key={id} className="border-t">
                  <td className={td}>
                    <input
                      type="checkbox"
                      checked={tdsPick.has(id)}
                      onChange={(e) =>
                        setTdsPick((s) => {
                          const next = new Set(s)
                          if (e.target.checked) next.add(id)
                          else next.delete(id)
                          return next
                        })
                      }
                    />
                  </td>
                  <td className={td}>
                    <span className="font-semibold">{String(x.invoice_no)}</span>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(String(x.order_date))} · {String(x.company)}
                    </div>
                  </td>
                  <td className={td}>{String(x.supplier)}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(Number(x.taxable))}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    {formatINR(Number(x.prior))}
                    <div className="text-[11px] text-muted-foreground">slab {formatINR(Number(x.threshold))}</div>
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    <span className="text-muted-foreground">{formatINR(Number(x.tds_before))}</span>
                    <div className="font-semibold">{formatINR(Number(x.tds_after))}</div>
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>
                    <span className="text-muted-foreground">{formatINR(Number(x.net_before))}</span>
                    <div className="font-semibold">{formatINR(Number(x.net_after))}</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {tdsPick.size} of {staleRows.length} ticked
          </span>
          <Button className="ml-auto gap-1.5" disabled={!tdsPick.size || reworking} onClick={() => void reworkTds()}>
            {reworking && <Loader2 className="h-4 w-4 animate-spin" />}
            Re-work TDS on {tdsPick.size} purchase{tdsPick.size === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Section
        title="Customers and suppliers sharing a ledger"
        count={slFindings.length}
        tone={slFindings.length ? 'warn' : 'ok'}
        note={
          slFindings.length
            ? 'These customers’ sale invoices (or suppliers’ bills) sit in the OTHER side’s ledger, because the two names met — the same name, or a rename that carried one into the other. One ledger then nets what you are owed against what you owe. Splitting moves each party’s lines to its own ledger, where its new invoices already go.'
            : 'Every customer’s invoices are in a customer ledger and every supplier’s bills in a supplier ledger.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Shared ledger</th>
              <th className={th}>Party</th>
              <th className={cn(th, 'text-right')}>Vouchers</th>
              <th className={cn(th, 'text-right')}>Amount</th>
              <th className={th}>Moves to</th>
              <th className={cn(th, 'text-right')}>Stays on it</th>
            </tr>
          </thead>
          <tbody>
            {slFindings.map((x) => (
              <tr key={String(x.key)} className="border-t">
                <td className={cn(td, 'font-semibold')}>
                  {String(x.ledger)}
                  <div className="text-[11px] font-normal text-muted-foreground">{x.ledger_side === 'creditor' ? 'a supplier ledger' : 'a customer ledger'}</div>
                </td>
                <td className={td}>
                  {String(x.party)}
                  <div className="text-[11px] text-muted-foreground">{x.moving === 'customer' ? 'customer — sale invoices' : 'supplier — purchase bills'}</div>
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>{x.entries}</td>
                <td className={cn(td, 'text-right tabular-nums')}>
                  {formatINR(Math.abs(Number(x.net)))} {Number(x.net) >= 0 ? 'Dr' : 'Cr'}
                </td>
                <td className={td}>
                  {x.review ? (
                    <span className="text-[12px] font-semibold text-amber-700">{String(x.review)}</span>
                  ) : (
                    <>
                      <span className="font-semibold">{String(x.target)}</span>
                      <div className="text-[11px] text-muted-foreground">{x.target_exists ? 'existing ledger' : 'new ledger'}</div>
                    </>
                  )}
                </td>
                <td className={cn(td, 'text-right text-[12px] text-muted-foreground')}>
                  {Number(x.staying?.entries) ? (
                    <>
                      {x.staying.entries} other voucher{Number(x.staying.entries) === 1 ? '' : 's'}
                      <div className="tabular-nums">
                        {formatINR(Math.abs(Number(x.staying.net)))} {Number(x.staying.net) >= 0 ? 'Dr' : 'Cr'}
                      </div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {slFixable.length} ledger{slFixable.length === 1 ? '' : 's'} can be split
            {slFindings.length - slFixable.length ? ` · ${slFindings.length - slFixable.length} left for review (not touched)` : ''}
          </span>
          <Button className="ml-auto gap-1.5" disabled={!slFixable.length || splitting} onClick={() => void splitShared()}>
            {splitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Split {slFixable.length} ledger{slFixable.length === 1 ? '' : 's'}
          </Button>
        </div>
      </Section>

      <Section
        title="Postings on BANK A/C"
        count={generic.reduce((t, r) => t + Number(r.lines || 0), 0)}
        tone={generic.length ? 'warn' : 'ok'}
        note={
          generic.length
            ? 'BANK A/C is not a real account — bill discounting posted here before it asked which bank. Move each company’s postings to the bank they actually went through; only the bank line of each voucher changes.'
            : 'Nothing is posted to the generic BANK A/C — every bank posting names a real account.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Company</th>
              <th className={cn(th, 'text-right')}>Vouchers</th>
              <th className={cn(th, 'text-right')}>Money in</th>
              <th className={cn(th, 'text-right')}>Money out</th>
              <th className={th}>Move to</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {generic.map((r) => {
              const cid = Number(r.company_id)
              return (
                <tr key={cid} className="border-t">
                  <td className={cn(td, 'font-semibold')}>{r.company_name || `Company ${cid}`}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{r.vouchers}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(r.dr)}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(r.cr)}</td>
                  <td className={td}>
                    <select
                      value={moveTo[cid] || ''}
                      onChange={(e) => setMoveTo((m) => ({ ...m, [cid]: e.target.value }))}
                      className="h-8 min-w-[190px] rounded border px-2 text-[12.5px] font-semibold"
                    >
                      <option value="">Pick the bank…</option>
                      {bankLedgers.map((a) => (
                        <option key={String(a.id)} value={String(a.name)}>
                          {String(a.name)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={cn(td, 'text-right')}>
                    <Button size="sm" disabled={!moveTo[cid] || moving === cid} onClick={() => void moveGeneric(r)}>
                      {moving === cid ? 'Moving…' : `Move ${r.lines}`}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Section>

      <Section
        title="Duplicate sales vouchers"
        count={findings.length}
        tone={findings.length ? 'bad' : 'ok'}
        note={
          findings.length
            ? 'Invoices split across several rows that still carry an extra voucher per row, on top of the one voucher that already posts the whole invoice — so their revenue and the party’s balance are counted twice for those rows.'
            : 'Every grouped invoice posts its revenue once.'
        }
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th} />
              <th className={th}>Invoice</th>
              <th className={th}>Party</th>
              <th className={cn(th, 'text-right')}>Invoice taxable</th>
              <th className={cn(th, 'text-right')}>Posted revenue</th>
              <th className={th}>Kept</th>
              <th className={th}>Duplicates</th>
              <th className={cn(th, 'text-right')}>Removed</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => {
              const ds = f.duplicates as Row[]
              const all = ds.length > 0 && ds.every((d) => picked.has(Number(d.entry_id)))
              return (
                <tr key={`${f.company_id}-${f.invoice_key}`} className={cn('border-t', f.review && 'bg-amber-50/60')}>
                  <td className={td}>
                    {ds.length > 0 && (
                      <input
                        type="checkbox"
                        checked={all}
                        onChange={() =>
                          setPicked((s) => {
                            const x = new Set(s)
                            for (const d of ds) (all ? x.delete(Number(d.entry_id)) : x.add(Number(d.entry_id)))
                            return x
                          })
                        }
                        aria-label={`Remove duplicates on ${f.invoice_no}`}
                      />
                    )}
                  </td>
                  <td className={cn(td, 'font-semibold')}>
                    {f.invoice_no}
                    {f.review && <div className="whitespace-normal text-[11px] font-medium text-amber-800">Needs review — {f.review}</div>}
                  </td>
                  <td className={cn(td, 'max-w-[220px] truncate')} title={f.party}>
                    {f.party || '—'}
                  </td>
                  <td className={cn(td, 'text-right tabular-nums')}>{formatINR(f.invoice_taxable)}</td>
                  <td className={cn(td, 'text-right tabular-nums text-red-700')}>{formatINR(f.posted_revenue)}</td>
                  <td className={cn(td, 'tabular-nums')}>{f.canonical_entry_id ? `#${f.canonical_entry_id}` : '—'}</td>
                  <td className={cn(td, 'tabular-nums')}>{ds.map((d) => `#${d.entry_id}`).join(', ') || '—'}</td>
                  <td className={cn(td, 'text-right tabular-nums')}>{ds.length ? formatINR(f.removable_amount) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-4 py-3">
          <span className="text-[12.5px] text-muted-foreground">
            {removable.length} invoice{removable.length === 1 ? '' : 's'} can be repaired
            {review.length ? ` · ${review.length} left for review (not touched)` : ''}
          </span>
          <Button className="ml-auto gap-1.5" variant="destructive" disabled={!picked.size || busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Remove {picked.size} voucher{picked.size === 1 ? '' : 's'} · {formatINR(pickedAmount)}
          </Button>
        </div>
      </Section>

      <Section
        title="PID / SID disbursements with no route recorded"
        count={unconfirmed.length}
        tone={unconfirmed.length ? 'warn' : 'ok'}
        note="Bills entered before the route was asked for. They post as a receipt into the bank named on their voucher, as they always have. Where the NBFC actually paid the supplier directly, open the bill in Bill Discounting and set “Disbursement paid to” — its voucher is then re-posted as a journal that settles the supplier, with no bank line."
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>BD no</th>
              <th className={th}>Type</th>
              <th className={th}>NBFC</th>
              <th className={th}>Party</th>
              <th className={th}>Funded</th>
              <th className={cn(th, 'text-right')}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {unconfirmed.map((b) => (
              <tr key={b.id} className="border-t">
                <td className={cn(td, 'font-semibold')}>{b.bd_no}</td>
                <td className={td}>{b.finance_type}</td>
                <td className={td}>{b.nbfc_name || '—'}</td>
                <td className={cn(td, 'max-w-[220px] truncate')}>{b.party_name || '—'}</td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(b.payment_received_date)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(b.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Upfront interest not yet recorded"
        count={upfront.length}
        tone={upfront.length ? 'warn' : 'ok'}
        note="Bills opened with interest settled upfront, whose interest voucher has not been recorded. The figures are the full-tenor interest from the bill's own terms — not proof of a bank debit. Record it from the bill's detail (Upfront interest) with the date and bank the statement shows."
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>BD no</th>
              <th className={th}>NBFC</th>
              <th className={th}>Funded</th>
              <th className={cn(th, 'text-right')}>Interest</th>
              <th className={cn(th, 'text-right')}>TDS</th>
              <th className={cn(th, 'text-right')}>Net from bank</th>
            </tr>
          </thead>
          <tbody>
            {upfront.map((b) => (
              <tr key={b.id} className="border-t">
                <td className={cn(td, 'font-semibold')}>{b.bd_no}</td>
                <td className={td}>{b.nbfc_name || '—'}</td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(b.payment_received_date)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(b.interest)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(b.tds)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(b.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Repaid LCs whose payable does not clear"
        count={lcRes.length}
        tone={lcRes.length ? 'warn' : 'ok'}
        note="The LC payable on each LC's own vouchers, after its repayment. A credit left over means the bank was repaid less than the payable raised; a debit, more. Reconcile each against the bank's settlement advice before correcting it — the gap is not automatically interest or round-off."
      >
        <table className="w-full border-collapse">
          <thead className="bg-muted/40">
            <tr>
              <th className={th}>Company</th>
              <th className={th}>LC</th>
              <th className={th}>Repaid</th>
              <th className={cn(th, 'text-right')}>Face</th>
              <th className={th}>Vouchers</th>
              <th className={cn(th, 'text-right')}>Left on the payable</th>
            </tr>
          </thead>
          <tbody>
            {lcRes.map((l) => (
              <tr key={l.id} className="border-t">
                <td className={cn(td, 'tabular-nums')}>{l.company_id}</td>
                <td className={cn(td, 'font-semibold')}>{l.lc_no}</td>
                <td className={cn(td, 'tabular-nums')}>{formatDate(l.preclosed_date)}</td>
                <td className={cn(td, 'text-right tabular-nums')}>{formatINR(l.amount)}</td>
                <td className={cn(td, 'tabular-nums text-muted-foreground')}>{(l.entry_ids as number[]).map((x) => `#${x}`).join(', ')}</td>
                <td className={cn(td, 'text-right font-semibold tabular-nums', Number(l.residual) < 0 ? 'text-red-700' : 'text-amber-800')}>
                  {formatINR(Math.abs(Number(l.residual)))} {Number(l.residual) < 0 ? 'Dr' : 'Cr'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  )
}
