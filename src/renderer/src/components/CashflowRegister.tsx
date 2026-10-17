import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronRight, ExternalLink, Search, X } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
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

type Kind = 'all' | 'money' | 'payment' | 'receipt' | 'contra' | 'purchase' | 'sales' | 'journal' | 'notes'
const KINDS: { k: Kind; label: string }[] = [
  { k: 'all', label: 'All' },
  { k: 'money', label: 'Money moved' },
  { k: 'payment', label: 'Payments' },
  { k: 'receipt', label: 'Receipts' },
  { k: 'contra', label: 'Contra' },
  { k: 'purchase', label: 'Purchases' },
  { k: 'sales', label: 'Sales' },
  { k: 'journal', label: 'Journals' },
  { k: 'notes', label: 'Dr / Cr notes' }
]
const kindIs = (v: Row, k: Kind): boolean => {
  const t = String(v.type || '').toUpperCase()
  if (k === 'all') return true
  if (k === 'money') return n(v.money_in) > 0 || n(v.money_out) > 0
  if (k === 'payment') return t.startsWith('PAYMENT')
  if (k === 'receipt') return t.startsWith('RECEIPT')
  if (k === 'contra') return t.startsWith('CONTRA')
  if (k === 'purchase') return t.startsWith('PURCHASE')
  if (k === 'sales') return t.startsWith('SALE')
  if (k === 'journal') return t.startsWith('JOURNAL')
  return t.includes('NOTE')
}

const REF_WORD: Record<string, string> = { agst_ref: 'Agst Ref', new_ref: 'New Ref', advance: 'Advance', on_account: 'On Account' }

// THE CASHFLOW REGISTER. Every voucher of the period on one page, each opened
// up to its lines: the invoice it came from, the bills it was set against, the
// party, every ledger with its Dr or Cr, the bill references and the breakdown
// under each line, and what about it is not right. The point is one page where
// a wrong entry can be found without opening vouchers one by one.
export function CashflowRegister({
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
  const [data, setData] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [wrongOnly, setWrongOnly] = useState(false)
  // THE REGISTER IS THE BREAKDOWNS. Only vouchers with a figure broken down
  // under one of their lines are listed; "Show all vouchers" opens it up to
  // every voucher of the period.
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [shown, setShown] = useState(200)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const r = await window.api.vouchers.cashflow({ from, to, companyId })
      setData((r.vouchers as Row[]) || [])
    } catch (e) {
      toast.error((e as Error).message)
      setData([])
    } finally {
      setLoading(false)
    }
  }, [companyId, from, to])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setShown(200), [q, kind, wrongOnly, from, to, showAll])

  const hasBreakdown = (v: Row): boolean => (v.lines as Row[]).some((l) => (l.splits as Row[]).length > 0)
  const all = useMemo(() => (data || []).filter((v) => showAll || hasBreakdown(v)), [data, showAll]) // eslint-disable-line react-hooks/exhaustive-deps
  const withBreakdown = useMemo(() => (data || []).filter(hasBreakdown).length, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all.filter((v) => {
      if (!kindIs(v, kind)) return false
      if (wrongOnly && !(v.issues as string[]).length) return false
      if (!s) return true
      const hay = [
        v.code,
        v.vch_no,
        v.type,
        v.invoice_no,
        v.party,
        v.narration,
        ...(v.refs as string[]),
        ...(v.lines as Row[]).flatMap((l) => [l.account, ...(l.splits as Row[]).map((x) => x.name)]),
        String(v.dr)
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(s)
    })
  }, [all, q, kind, wrongOnly])
  const sum = (k: string): number => rows.reduce((t, v) => t + n(v[k]), 0)
  const wrongCount = useMemo(() => all.filter((v) => kindIs(v, kind) && (v.issues as string[]).length).length, [all, kind])

  const toggle = (id: number): void =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function download(): Promise<void> {
    // One row per ledger line, so the file can be filtered by ledger as well
    // as by voucher; the breakdown and references ride on their line.
    const flat: Row[] = []
    for (const v of rows) {
      for (const l of v.lines as Row[]) {
        flat.push({
          date: formatDate(v.date),
          voucher: v.code,
          type: v.type,
          invoice: v.invoice_no,
          refs: (v.refs as string[]).join(', '),
          party: v.party,
          ledger: l.account,
          group: l.group,
          dr: l.side === 'dr' ? l.amount : '',
          cr: l.side === 'cr' ? l.amount : '',
          line_refs: (l.refs as Row[]).map((r) => `${REF_WORD[r.method] || r.method}${r.ref ? ' ' + r.ref : ''} ${r.amount}`).join('; '),
          breakdown: (l.splits as Row[]).map((x) => `${x.name} ${x.amount}${x.note ? ' (' + x.note + ')' : ''}`).join('; '),
          issues: (v.issues as string[]).join('; '),
          narration: v.narration
        })
      }
    }
    await exportRowsToExcel({
      filename: `cashflow-register-${from}-to-${to}`,
      sheetName: 'Cashflow register',
      title: `Cashflow register — ${companyName}`,
      subtitle: `${formatDate(from)} to ${formatDate(to)} · ${rows.length} vouchers`,
      columns: [
        { header: 'Date', key: 'date', value: (r) => r.date },
        { header: 'Voucher', key: 'voucher', value: (r) => r.voucher },
        { header: 'Type', key: 'type', value: (r) => r.type },
        { header: 'Invoice no', key: 'invoice', value: (r) => r.invoice },
        { header: 'Ref no', key: 'refs', value: (r) => r.refs },
        { header: 'Party', key: 'party', value: (r) => r.party },
        { header: 'Ledger', key: 'ledger', value: (r) => r.ledger },
        { header: 'Group', key: 'group', value: (r) => r.group },
        { header: 'Dr', key: 'dr', align: 'right', numFmt: NUM_MONEY, value: (r) => r.dr },
        { header: 'Cr', key: 'cr', align: 'right', numFmt: NUM_MONEY, value: (r) => r.cr },
        { header: 'Bill references', key: 'line_refs', value: (r) => r.line_refs },
        { header: 'Breakdown', key: 'breakdown', value: (r) => r.breakdown },
        { header: 'Not right', key: 'issues', value: (r) => r.issues },
        { header: 'Narration', key: 'narration', value: (r) => r.narration }
      ],
      rows: flat
    })
  }

  const card = (k: string, v: string, sub: string, tone: string, on: boolean, go: () => void): React.JSX.Element => (
    <button
      type="button"
      onClick={go}
      className={cn('min-w-0 rounded-[6px] border bg-white px-4 py-3 text-left transition-colors hover:bg-[#F7FAF6]', on ? 'border-[#0B3D2E] ring-1 ring-[#0B3D2E]' : 'border-[#D6E2D6]')}
    >
      <div className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">{k}</div>
      <div className={cn('mt-1 truncate text-[18px] font-bold tabular-nums', tone)}>{v}</div>
      <div className="mt-0.5 truncate text-[11px] font-semibold text-[#8CA396]">{sub}</div>
    </button>
  )
  const th = 'h-9 px-2.5 text-left text-[10px] font-extrabold uppercase tracking-[.1em] text-[#C7F03F] whitespace-nowrap'
  const td = 'px-2.5 py-2 align-top'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#F1F5EF] p-3">
      {/* What it is, the period, and the way in. */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-3">
        <div className="mr-2 min-w-0">
          <div className="text-[15px] font-extrabold text-[#0A1F17]">Cashflow Register</div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">
            Every voucher opened up — invoice, refs, party, ledgers, Dr / Cr and the breakdown
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
        <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
          <Search className="h-4 w-4 flex-none text-[#5A6B62]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Voucher, invoice, ref, party, ledger, amount…"
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
        {card(showAll ? 'Vouchers' : 'With a breakdown', String(rows.length), showAll ? `of ${(data || []).length} in the period` : `of ${(data || []).length} vouchers in the period`, 'text-[#0A1F17]', kind === 'all' && !wrongOnly, () => {
          setKind('all')
          setWrongOnly(false)
        })}
        {card('Money in', formatINR(sum('money_in')), 'into bank and cash', 'text-[#0B6B45]', kind === 'receipt', () => {
          setKind('receipt')
          setWrongOnly(false)
        })}
        {card('Money out', formatINR(sum('money_out')), 'out of bank and cash', 'text-[#B3261E]', kind === 'payment', () => {
          setKind('payment')
          setWrongOnly(false)
        })}
        {card(
          'Net flow',
          formatINR(sum('money_in') - sum('money_out')),
          'in less out, on what is shown',
          sum('money_in') - sum('money_out') >= 0 ? 'text-[#0B6B45]' : 'text-[#B3261E]',
          kind === 'money',
          () => {
            setKind('money')
            setWrongOnly(false)
          }
        )}
        {card('Not right', String(wrongCount), wrongCount ? 'click to see only these' : 'nothing found', wrongCount ? 'text-[#B3261E]' : 'text-[#0B6B45]', wrongOnly, () =>
          setWrongOnly((w) => !w)
        )}
      </div>

      {/* Which vouchers. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => {
          const on = kind === k.k
          const count = all.filter((v) => kindIs(v, k.k)).length
          return (
            <button
              key={k.k}
              type="button"
              onClick={() => setKind(k.k)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
                on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
              )}
            >
              {k.label}
              <span className={cn('rounded-[3px] px-1.5 text-[10.5px] tabular-nums', on ? 'bg-white/15' : 'bg-[#EAF0E9]')}>{count}</span>
            </button>
          )
        })}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          title={showAll ? 'Back to only the vouchers with a breakdown' : 'List every voucher of the period, with or without a breakdown'}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
            showAll ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
          )}
        >
          {showAll ? `Showing all vouchers · back to ${withBreakdown} with a breakdown` : 'Show all vouchers'}
        </button>
        <button
          type="button"
          onClick={() => setWrongOnly((w) => !w)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-bold',
            wrongOnly ? 'border-[#B3261E] bg-[#B3261E] text-white' : 'border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E]'
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Not right only · {wrongCount}
        </button>
        <button
          type="button"
          onClick={() => setOpen(open.size ? new Set() : new Set(rows.slice(0, shown).map((v) => n(v.id))))}
          className="h-8 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
        >
          {open.size ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] border-collapse text-[12.5px]">
            <thead className="bg-[#0B3D2E]">
              <tr>
                <th className={cn(th, 'w-6')} />
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                <th className={th}>Invoice no</th>
                <th className={th}>Ref no</th>
                <th className={th}>Party</th>
                <th className={th}>Ledgers · Dr → Cr</th>
                <th className={th}>Breakdown</th>
                <th className={cn(th, 'text-right')}>Amount</th>
                <th className={cn(th, 'text-right')}>In / Out</th>
                <th className={th}>Check</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    Reading the books…
                  </td>
                </tr>
              ) : !rows.length ? (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-[13px] font-semibold text-[#8CA396]">
                    {wrongOnly
                      ? 'Nothing is not right here.'
                      : !showAll && !withBreakdown
                        ? 'No voucher in this period has a breakdown yet — write one under a line with "What this line is made of" on the voucher, or press Show all vouchers.'
                        : 'No voucher in this period matches.'}
                  </td>
                </tr>
              ) : (
                rows.slice(0, shown).map((v, i) => {
                  const id = n(v.id)
                  const isOpen = open.has(id)
                  const issues = v.issues as string[]
                  const ls = v.lines as Row[]
                  const drs = ls.filter((l) => l.side === 'dr')
                  const crs = ls.filter((l) => l.side === 'cr')
                  return (
                    <Fragment key={id}>
                      <tr
                        onClick={() => toggle(id)}
                        className={cn(
                          'cursor-pointer border-t border-[#EAF0E9] hover:bg-[#F7FBF1]',
                          isOpen ? 'bg-[#F4FBF6]' : i % 2 ? 'bg-[#FBFDFA]' : 'bg-white',
                          issues.length && 'shadow-[inset_3px_0_0_#B3261E]'
                        )}
                      >
                        <td className={td}>
                          <ChevronRight className={cn('mt-0.5 h-3.5 w-3.5 text-[#8CA396] transition-transform', isOpen && 'rotate-90')} />
                        </td>
                        <td className={cn(td, 'whitespace-nowrap font-bold tabular-nums')}>{formatDate(v.date)}</td>
                        <td className={td}>
                          <div className="whitespace-nowrap font-extrabold text-[#0A1F17]">{v.code || v.vch_no || '—'}</div>
                          <div className="text-[10.5px] font-bold uppercase tracking-[.04em] text-[#5A6B62]">{v.type}</div>
                        </td>
                        <td className={cn(td, 'font-semibold')}>{v.invoice_no || <span className="text-[#C3D2C6]">—</span>}</td>
                        <td className={cn(td, 'max-w-[160px]')}>
                          {(v.refs as string[]).length ? (
                            <span className="text-[11.5px] font-semibold text-[#1B4E82] [overflow-wrap:anywhere]">{(v.refs as string[]).join(', ')}</span>
                          ) : (
                            <span className="text-[#C3D2C6]">—</span>
                          )}
                        </td>
                        <td className={cn(td, 'max-w-[200px]')}>
                          {v.party ? (
                            <>
                              <div className="truncate font-semibold" title={v.party}>
                                {v.party}
                              </div>
                              <div className="text-[10.5px] font-semibold text-[#8CA396]">{v.party_kind}</div>
                            </>
                          ) : (
                            <span className="text-[#C3D2C6]">—</span>
                          )}
                        </td>
                        <td className={cn(td, 'max-w-[300px] text-[11.5px]')}>
                          <div className="truncate" title={drs.map((l) => l.account).join(', ')}>
                            <b className="text-[#0B6B45]">Dr</b> {drs.map((l) => l.account).join(', ') || '—'}
                          </div>
                          <div className="truncate" title={crs.map((l) => l.account).join(', ')}>
                            <b className="text-[#B3261E]">Cr</b> {crs.map((l) => l.account).join(', ') || '—'}
                          </div>
                        </td>
                        <td className={cn(td, 'min-w-[220px] max-w-[320px] text-[11.5px]')}>
                          {ls.filter((l) => (l.splits as Row[]).length).length ? (
                            ls
                              .filter((l) => (l.splits as Row[]).length)
                              .map((l) => (
                                <div key={n(l.id)} className="mb-1 rounded-[3px] border border-[#C6DAF0] bg-[#F7FAFE] px-2 py-1 last:mb-0">
                                  <div className="truncate font-extrabold text-[#1B4E82]" title={l.account}>
                                    {l.account} · {formatINR(l.amount)}
                                  </div>
                                  {(l.splits as Row[]).map((x, k) => (
                                    <div key={k} className="flex justify-between gap-2">
                                      <span className="min-w-0 truncate" title={x.note ? `${x.name} · ${x.note}` : x.name}>
                                        {x.name}
                                      </span>
                                      <span className="flex-none tabular-nums">{formatINR(x.amount)}</span>
                                    </div>
                                  ))}
                                </div>
                              ))
                          ) : (
                            <span className="text-[#C3D2C6]">—</span>
                          )}
                        </td>
                        <td className={cn(td, 'whitespace-nowrap text-right font-bold tabular-nums')}>{formatINR(v.dr)}</td>
                        <td className={cn(td, 'whitespace-nowrap text-right tabular-nums')}>
                          {n(v.money_in) > 0 && (
                            <div className="flex items-center justify-end gap-1 font-bold text-[#0B6B45]">
                              <ArrowDownLeft className="h-3 w-3" />
                              {formatINR(v.money_in)}
                            </div>
                          )}
                          {n(v.money_out) > 0 && (
                            <div className="flex items-center justify-end gap-1 font-bold text-[#B3261E]">
                              <ArrowUpRight className="h-3 w-3" />
                              {formatINR(v.money_out)}
                            </div>
                          )}
                          {!(n(v.money_in) > 0) && !(n(v.money_out) > 0) && <span className="text-[#C3D2C6]">—</span>}
                        </td>
                        <td className={td}>
                          {issues.length ? (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-[3px] bg-[#FDF3F2] px-1.5 py-0.5 text-[10.5px] font-extrabold text-[#B3261E]">
                              <AlertTriangle className="h-3 w-3" /> {issues.length}
                            </span>
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-[#12855A]" />
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-[#EAF0E9] bg-[#F7FAF6]">
                          <td />
                          <td colSpan={10} className="px-2.5 pb-3 pt-1">
                            {issues.length > 0 && (
                              <div className="mb-2 rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3 py-2">
                                {issues.map((x, k) => (
                                  <div key={k} className="flex items-start gap-1.5 text-[12px] font-semibold text-[#8C2F26]">
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" /> {x}
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_120px_minmax(0,1.6fr)] gap-2 border-b border-[#EAF0E9] bg-[#EAF0E9] px-3 py-1.5 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#33473E]">
                                <span>Ledger</span>
                                <span>Group</span>
                                <span className="text-right">Dr</span>
                                <span className="text-right">Cr</span>
                                <span>Bill references · breakdown</span>
                              </div>
                              {[...drs, ...crs].map((l) => (
                                <div
                                  key={n(l.id)}
                                  className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_120px_minmax(0,1.6fr)] gap-2 border-b border-[#F1F5EF] px-3 py-1.5 last:border-0"
                                >
                                  <span className="min-w-0 font-semibold text-[#0A1F17] [overflow-wrap:anywhere]">{l.account}</span>
                                  <span className="min-w-0 truncate text-[11.5px] text-[#5A6B62]" title={l.group}>
                                    {l.group}
                                  </span>
                                  <span className="text-right font-bold tabular-nums text-[#0B6B45]">{l.side === 'dr' ? formatINR(l.amount) : ''}</span>
                                  <span className="text-right font-bold tabular-nums text-[#B3261E]">{l.side === 'cr' ? formatINR(l.amount) : ''}</span>
                                  <span className="min-w-0 text-[11.5px]">
                                    {(l.refs as Row[]).map((r, k) => (
                                      <div key={`r${k}`} className="text-[#1B4E82]">
                                        <b>{REF_WORD[r.method] || r.method}</b> {r.ref} · {formatINR(r.amount)}
                                      </div>
                                    ))}
                                    {(l.splits as Row[]).length > 0 && (
                                      <div className="mt-0.5 rounded-[3px] border border-[#C6DAF0] bg-[#F7FAFE] px-2 py-1">
                                        <div className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#1B4E82]">Breakdown</div>
                                        {(l.splits as Row[]).map((x, k) => (
                                          <div key={`s${k}`} className="flex justify-between gap-2">
                                            <span className="min-w-0 [overflow-wrap:anywhere]">
                                              {x.name}
                                              {x.note ? <span className="text-[#8CA396]"> · {x.note}</span> : null}
                                            </span>
                                            <span className="flex-none tabular-nums">{formatINR(x.amount)}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {!(l.refs as Row[]).length && !(l.splits as Row[]).length && <span className="text-[#C3D2C6]">—</span>}
                                  </span>
                                </div>
                              ))}
                              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_120px_minmax(0,1.6fr)] gap-2 bg-[#FBFDFA] px-3 py-1.5 font-extrabold">
                                <span>Total</span>
                                <span />
                                <span className="text-right tabular-nums">{formatINR(v.dr)}</span>
                                <span className="text-right tabular-nums">{formatINR(v.cr)}</span>
                                <span />
                              </div>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {v.narration && <span className="min-w-0 flex-1 text-[11.5px] italic text-[#5A6B62]">{v.narration}</span>}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onOpen(v)
                                }}
                                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#0B3D2E] hover:bg-[#EAF0E9]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" /> Open {v.invoice_no ? 'the document' : 'the voucher'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {rows.length > shown && (
          <div className="border-t border-[#EAF0E9] px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={() => setShown((s) => s + 200)}
              className="h-8 rounded-[4px] border border-[#C3D2C6] bg-white px-4 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
            >
              Show 200 more · {rows.length - shown} left
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
