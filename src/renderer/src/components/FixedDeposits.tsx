import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ChevronDown, Landmark, Link2, Loader2, Lock, Pencil, PiggyBank, Plus, RotateCcw, Search, Trash2, Unlock, Wallet, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DatePicker } from '@/components/ui/date-picker'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// FIXED DEPOSITS (fixedDeposits.ts): every FD the company holds, how much of it
// is held as security against LCs, and how much is free. A lien releases by
// hand or when its LC is repaid / preclosed / rejected — read live.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
const r2 = (v: number): number => Math.round(v * 100) / 100
const errText = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const lcOpen = (l: Row): boolean => !l.preclosed_date && String(l.workflow_status || '') !== 'rejected'

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]' },
  maturing: { label: 'Maturing soon', cls: 'border-[#E8C27A] bg-[#FFF4DC] text-[#7A4B00]' },
  matured: { label: 'Matured', cls: 'border-[#F0C9C4] bg-[#FDECEA] text-[#B3261E]' },
  closed: { label: 'Closed', cls: 'border-[#D6DDE3] bg-[#EEF2F5] text-[#3E4C57]' }
}
const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
const inp = 'h-9 w-full rounded-[4px] border border-[#C9DCCF] bg-white px-2.5 text-[13px] font-semibold outline-none focus:border-[#0B6B45] focus:ring-2 focus:ring-[#0B6B45]/15'

function DaysChip({ fd }: { fd: Row }): React.JSX.Element | null {
  if (fd.status === 'closed') return null
  const d = n(fd.days_left)
  if (fd.days_left == null) return null
  const cls = d < 0 ? 'bg-[#FDECEA] text-[#B3261E]' : d <= 30 ? 'bg-[#FFF4DC] text-[#7A4B00]' : 'bg-[#EEF3EE] text-[#33473E]'
  return <span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-extrabold tabular-nums', cls)}>{d < 0 ? `${-d}d past` : d === 0 ? 'today' : `${d}d left`}</span>
}

/** The register. `lcs` feeds the LC picker; `onCount` tells the tab how many FDs are held. */
export function FixedDeposits({ lcs, onCount }: { lcs: Row[]; onCount?: (k: number) => void }): React.JSX.Element {
  const [list, setList] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [st, setSt] = useState<'all' | 'active' | 'maturing' | 'matured' | 'closed'>('all')
  const [bank, setBank] = useState('all')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [form, setForm] = useState<Row | null>(null)
  const [lien, setLien] = useState<Row | null>(null)
  const [closing, setClosing] = useState<Row | null>(null)

  const load = useCallback(() => {
    window.api.fd
      .list()
      .then((r) => {
        setList(r)
        onCount?.(r.filter((x) => x.status !== 'closed').length)
      })
      .catch((e) => toast.error(errText(e)))
  }, [onCount])
  useEffect(load, [load])

  const all = list || []
  const banks = useMemo(() => [...new Set(all.map((f) => String(f.bank)))].sort(), [all])
  const shown = all.filter((f) => {
    if (st !== 'all' && f.status !== st) return false
    if (bank !== 'all' && String(f.bank) !== bank) return false
    const t = q.trim().toUpperCase()
    if (!t) return true
    return [f.fd_no, f.bank, f.note, ...(f.liens as Row[]).map((l) => l.lc_no)].some((x) => String(x || '').toUpperCase().includes(t))
  })
  const held = all.filter((f) => f.status !== 'closed')
  const sum = (l: Row[], k: string): number => r2(l.reduce((t, f) => t + n(f[k]), 0))
  const soon = held.filter((f) => f.status === 'maturing')
  const due = held.filter((f) => f.status === 'matured')
  const counts: Record<string, number> = { all: all.length, active: 0, maturing: 0, matured: 0, closed: 0 }
  all.forEach((f) => (counts[f.status] = (counts[f.status] || 0) + 1))

  async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn()
      toast.success(ok)
      load()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const toggle = (id: number): void =>
    setOpen((p) => {
      const x = new Set(p)
      if (x.has(id)) x.delete(id)
      else x.add(id)
      return x
    })

  return (
    <div className="space-y-3">
      {/* WHERE THE MONEY IN FDs STANDS. */}
      <div className="grid grid-cols-2 overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white lg:grid-cols-5">
        {[
          { k: 'Held in FDs', v: formatINR(sum(held, 'amount')), sub: `${held.length} FD${held.length === 1 ? '' : 's'} · ${formatINR(sum(held, 'accrued'))} interest so far`, tone: 'text-[#0A1F17]', Icon: PiggyBank },
          { k: 'Under lien', v: formatINR(sum(held, 'lien_amount')), sub: `securing ${held.reduce((t, f) => t + n(f.lien_lcs), 0)} LC${held.reduce((t, f) => t + n(f.lien_lcs), 0) === 1 ? '' : 's'}`, tone: 'text-[#1B4E82]', Icon: Lock },
          { k: 'Free', v: formatINR(sum(held, 'free_amount')), sub: 'can be put against an LC', tone: 'text-[#0B6B45]', Icon: Unlock },
          { k: 'Maturing in 30 days', v: formatINR(sum(soon, 'amount')), sub: `${soon.length} FD${soon.length === 1 ? '' : 's'}`, tone: soon.length ? 'text-[#7A4B00]' : 'text-[#9AAFA2]', Icon: Landmark },
          { k: 'Matured, not closed', v: formatINR(sum(due, 'amount')), sub: `${due.length} to renew or encash`, tone: due.length ? 'text-[#B3261E]' : 'text-[#9AAFA2]', Icon: Wallet }
        ].map((t, i) => (
          <div key={t.k} className={cn('min-w-0 px-4 py-3', i > 0 && 'border-l border-[#EEF3EE]', i >= 2 && 'border-t border-[#EEF3EE] lg:border-t-0')}>
            <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#7A8C82]">
              <t.Icon className="h-3.5 w-3.5" /> {t.k}
            </div>
            <div className={cn('mt-0.5 truncate text-[19px] font-bold tabular-nums tracking-[-0.02em]', t.tone)}>{t.v}</div>
            <div className="truncate text-[11px] font-semibold text-[#7A8C82]">{t.sub}</div>
          </div>
        ))}
      </div>

      {/* TOOLBAR */}
      <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[#DCE6DC] bg-[#F7FAF6] px-3 py-2.5">
        <span className="flex h-9 rounded-[4px] border border-[#C9DCCF] bg-white p-0.5">
          {(['all', 'active', 'maturing', 'matured', 'closed'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSt(k)}
              className={cn('flex items-center gap-1.5 rounded-[3px] px-3 text-[12px] font-extrabold', st === k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}
            >
              {k === 'all' ? 'All' : STATUS[k].label}
              <span className={cn('rounded-[2px] px-1 text-[10.5px] tabular-nums', st === k ? 'bg-white/20' : 'bg-[#EEF3EE] text-[#5A6B62]')}>{counts[k] || 0}</span>
            </button>
          ))}
        </span>
        <Select value={bank} onValueChange={setBank}>
          <SelectTrigger className="h-9 w-[220px] bg-white text-[12.5px] font-bold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="all">All banks</SelectItem>
            {banks.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-[4px] border border-[#C9DCCF] bg-white px-2.5">
          <Search className="h-4 w-4 text-[#5A6B62]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="FD no, bank, LC no…" className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold outline-none" />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear">
              <X className="h-3.5 w-3.5 text-[#8CA396]" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setForm({ start_date: todayISO(), interest_payout: 'cumulative', bank_kind: 'own' })}
          className="flex h-9 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-4 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38]"
        >
          <Plus className="h-4 w-4" /> New FD
        </button>
      </div>

      {/* REGISTER */}
      {list == null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
        </div>
      ) : !shown.length ? (
        <div className="rounded-[8px] border border-dashed border-[#C9DCCF] bg-white py-12 text-center">
          <PiggyBank className="mx-auto h-8 w-8 text-[#A8B8AE]" />
          <div className="mt-2 text-[13px] font-bold text-[#33473E]">{all.length ? 'No FD in this view.' : 'No FD recorded yet.'}</div>
          {!all.length && <div className="text-[12px] font-semibold text-[#7A8C82]">Record the FDs you hold — then put them against an LC when it asks for security.</div>}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[8px] border border-[#DCE6DC] bg-white">
          <table className="w-full min-w-[1180px] text-[12.5px]">
            <thead className="bg-[#0B3D2E] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#DCEFE4]">
              <tr>
                <th className="w-8 px-3 py-2.5" />
                <th className="px-2 py-2.5 text-left">FD no</th>
                <th className="px-2 py-2.5 text-left">Bank</th>
                <th className="px-2 py-2.5 text-left">Term</th>
                <th className="px-2 py-2.5 text-right">Rate</th>
                <th className="px-2 py-2.5 text-right">Amount</th>
                <th className="px-2 py-2.5 text-left">Held against LCs</th>
                <th className="px-2 py-2.5 text-right text-[#C7F03F]">Free</th>
                <th className="px-2 py-2.5 text-right">At maturity</th>
                <th className="px-2 py-2.5 text-left">Status</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const id = n(f.id)
                const isOpen = open.has(id)
                const pct = n(f.amount) > 0 ? Math.min(100, (n(f.lien_amount) / n(f.amount)) * 100) : 0
                const live = (f.liens as Row[]).filter((l) => l.active)
                const canLien = f.status !== 'closed' && f.status !== 'matured' && n(f.free_amount) > 0.004
                return (
                  <Fragment key={id}>
                    <tr onClick={() => toggle(id)} className={cn('cursor-pointer border-t border-[#EEF3EE] align-middle', isOpen ? 'bg-[#F3F8F2]' : 'hover:bg-[#FAFCF9]', f.status === 'closed' && 'text-[#8CA396]')}>
                      <td className="px-3 py-2.5">
                        <ChevronDown className={cn('h-4 w-4 text-[#8CA396] transition-transform', isOpen && 'rotate-180')} />
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="rounded-[4px] bg-[#0B3D2E] px-1.5 py-0.5 text-[11.5px] font-extrabold text-[#C7F03F]">{String(f.fd_no)}</span>
                      </td>
                      <td className="max-w-[220px] px-2 py-2.5">
                        <div className="truncate font-bold text-[#0A1F17]">{String(f.bank)}</div>
                        <div className="text-[10px] font-extrabold uppercase tracking-[.08em] text-[#8CA396]">{f.bank_kind === 'lc' ? 'LC bank' : 'Own bank'}</div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <div className="font-semibold tabular-nums text-[#33473E]">
                          {formatDate(String(f.start_date))} → {formatDate(String(f.maturity_date))}
                        </div>
                        <div className="mt-0.5">
                          <DaysChip fd={f} />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{n(f.interest_pct)}%</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(n(f.amount))}</td>
                      <td className="min-w-[200px] px-2 py-2.5">
                        {/* How much of it is frozen — a bar, and the LCs it secures. */}
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-[90px] flex-none overflow-hidden rounded-full bg-[#E4F0E6]">
                            <div className="h-full rounded-full bg-[#1B4E82]" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="whitespace-nowrap font-semibold tabular-nums text-[#1B4E82]">{n(f.lien_amount) > 0.004 ? formatINR(n(f.lien_amount)) : '—'}</span>
                        </div>
                        {live.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {live.map((l) => (
                              <span key={String(l.id)} className="rounded-[3px] border border-[#C6DAF0] bg-[#F4F8FD] px-1.5 py-[1px] text-[10px] font-bold text-[#1B4E82]">
                                {String(l.lc_no || `LC #${l.lc_id}`)}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right font-extrabold tabular-nums text-[#0B6B45]">{f.status === 'closed' ? '—' : formatINR(n(f.free_amount))}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#33473E]">
                        {f.status === 'closed' ? (n(f.closed_amount) > 0 ? formatINR(n(f.closed_amount)) : '—') : formatINR(n(f.maturity_value))}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={cn('whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold', STATUS[f.status].cls)}>{STATUS[f.status].label}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={!canLien}
                            onClick={() => setLien({ fd_id: id, amount: String(n(f.free_amount)), date: todayISO() })}
                            title={canLien ? 'Put this FD against an LC' : f.status === 'matured' ? 'Matured — cannot secure an LC' : 'Nothing free on it'}
                            className="flex h-8 items-center gap-1 rounded-[4px] border border-[#A9C4E6] bg-white px-2 text-[11px] font-extrabold text-[#1B4E82] hover:bg-[#EAF1FB] disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5" /> Lien
                          </button>
                          <button type="button" title="Edit" aria-label="Edit" onClick={() => setForm({ ...f, amount: String(f.amount), interest_pct: String(f.interest_pct), maturity_amount: f.maturity_amount ? String(f.maturity_amount) : '' })} className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#C9DCCF] bg-white text-[#33473E] hover:bg-[#F0F8F3]">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {f.status === 'closed' ? (
                            <button type="button" title="Reopen" aria-label="Reopen" onClick={() => void act(() => window.api.fd.reopen(id), `${f.fd_no} reopened`)} className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#C9DCCF] bg-white text-[#33473E] hover:bg-[#F0F8F3]">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              title="Close / encash"
                              aria-label="Close"
                              onClick={() => setClosing({ id, fd_no: f.fd_no, date: todayISO(), amount: String(n(f.maturity_value)) })}
                              className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#C9DCCF] bg-white text-[#33473E] hover:bg-[#F0F8F3]"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            title="Delete"
                            aria-label="Delete"
                            onClick={() => window.confirm(`Delete ${f.fd_no}? Its lien history goes with it.`) && void act(() => window.api.fd.remove(id), `${f.fd_no} deleted`)}
                            className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#F0C9C4] bg-white text-[#B3261E] hover:bg-[#FDECEA]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-[#F3F8F2]">
                        <td />
                        <td colSpan={10} className="px-2 pb-3 pt-0">
                          <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
                            <div className="rounded-[6px] border border-[#DCE6DC] bg-white px-4 py-3 text-[12px]">
                              <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#7A8C82]">The deposit</div>
                              {[
                                ['Interest', `${n(f.interest_pct)}% · ${f.interest_payout === 'payout' ? 'paid out' : 'cumulative (quarterly)'}`],
                                ['Interest so far', formatINR(n(f.accrued))],
                                ['At maturity', `${formatINR(n(f.maturity_value))}${n(f.maturity_amount) > 0 ? ' (bank figure)' : ''}`],
                                ...(f.closed_date ? [['Closed', `${formatDate(String(f.closed_date))}${n(f.closed_amount) > 0 ? ` · ${formatINR(n(f.closed_amount))} received` : ''}`]] : []),
                                ...(f.note ? [['Note', String(f.note)]] : [])
                              ].map(([k, v]) => (
                                <div key={k} className="flex justify-between gap-3 border-t border-[#F1F5F0] py-1 first:border-t-0">
                                  <span className="text-[#5A6B62]">{k}</span>
                                  <span className="text-right font-bold tabular-nums text-[#0A1F17]">{v}</span>
                                </div>
                              ))}
                            </div>
                            <div className="overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white">
                              <div className="flex items-center gap-2 border-b border-[#EEF3EE] px-4 py-2">
                                <Lock className="h-3.5 w-3.5 text-[#1B4E82]" />
                                <span className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#1B4E82]">Liens</span>
                                <span className="ml-auto text-[11px] font-semibold text-[#7A8C82]">a lien releases when its LC is repaid, preclosed or rejected</span>
                              </div>
                              {!(f.liens as Row[]).length ? (
                                <div className="px-4 py-4 text-[12px] font-semibold text-[#7A8C82]">Not put against any LC yet.</div>
                              ) : (
                                <table className="w-full text-[12px]">
                                  <thead className="text-[9px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
                                    <tr>
                                      <th className="px-4 py-1.5 text-left">LC</th>
                                      <th className="px-2 py-1.5 text-left">Marked</th>
                                      <th className="px-2 py-1.5 text-right">Amount</th>
                                      <th className="px-2 py-1.5 text-left">State</th>
                                      <th className="px-4 py-1.5" />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(f.liens as Row[]).map((l) => (
                                      <tr key={String(l.id)} className="border-t border-[#F1F5F0]">
                                        <td className="px-4 py-1.5">
                                          <div className="font-extrabold text-[#0A1F17]">{String(l.lc_no || `LC #${l.lc_id}`)}</div>
                                          <div className="text-[10.5px] text-[#7A8C82]">
                                            {String(l.lc_bank || '')}
                                            {l.lc_maturity ? ` · matures ${formatDate(String(l.lc_maturity))}` : ''}
                                          </div>
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{l.marked_date ? formatDate(String(l.marked_date)) : '—'}</td>
                                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums">{formatINR(n(l.amount))}</td>
                                        <td className="px-2 py-1.5">
                                          {l.active ? (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-[#C6DAF0] bg-[#F4F8FD] px-2 py-0.5 text-[10.5px] font-extrabold text-[#1B4E82]">
                                              <Lock className="h-3 w-3" /> In force
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5A6B62]">
                                              <Unlock className="h-3 w-3" /> Released{l.released_on ? ` ${formatDate(String(l.released_on))}` : ''}
                                              {l.why && l.why !== 'released' ? ` · ${l.why}` : ''}
                                            </span>
                                          )}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-1.5 text-right">
                                          {l.active && (
                                            <button
                                              type="button"
                                              onClick={() => window.confirm(`Release ${formatINR(n(l.amount))} of ${f.fd_no} from ${l.lc_no}?`) && void act(() => window.api.fd.releaseLien(n(l.id)), 'Lien released')}
                                              className="mr-1 rounded-[4px] border border-[#C9DCCF] bg-white px-2 py-0.5 text-[11px] font-bold text-[#33473E] hover:bg-[#F0F8F3]"
                                            >
                                              Release
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            title="Remove — marked by mistake"
                                            aria-label="Remove lien"
                                            onClick={() => window.confirm(`Remove this lien (${l.lc_no}) altogether?`) && void act(() => window.api.fd.deleteLien(n(l.id)), 'Lien removed')}
                                            className="rounded-[4px] border border-[#F0C9C4] bg-white px-1.5 py-0.5 text-[#B3261E] hover:bg-[#FDECEA]"
                                          >
                                            <Trash2 className="inline h-3 w-3" />
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
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
                <td colSpan={5} className="px-3 py-2.5 text-[10.5px] uppercase tracking-[.1em] text-[#33473E]">
                  Total · {shown.length} FD{shown.length === 1 ? '' : 's'}
                </td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{formatINR(sum(shown, 'amount'))}</td>
                <td className="whitespace-nowrap px-2 py-2.5 tabular-nums text-[#1B4E82]">{formatINR(sum(shown.filter((f) => f.status !== 'closed'), 'lien_amount'))}</td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-[#0B6B45]">{formatINR(sum(shown.filter((f) => f.status !== 'closed'), 'free_amount'))}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {form && <FdForm init={form} lcs={lcs} onClose={() => setForm(null)} onSaved={() => { setForm(null); load() }} />}
      {lien && <LienDialog init={lien} fds={all} lcs={lcs} onClose={() => setLien(null)} onSaved={() => { setLien(null); load() }} />}
      {closing && (
        <Dialog open onOpenChange={(o) => !o && setClosing(null)}>
          <DialogContent className="max-w-[420px] p-0">
            <div className="bg-[#0B3D2E] px-5 py-3.5 text-white">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">Fixed deposit</div>
              <DialogTitle className="text-[16px] font-extrabold text-white">Close {String(closing.fd_no)}</DialogTitle>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div>
                <span className={lbl}>Closed on</span>
                <DatePicker value={String(closing.date)} onChange={(v) => v && setClosing((p) => ({ ...p, date: v }))} />
              </div>
              <div>
                <span className={lbl}>Amount received</span>
                <input inputMode="decimal" value={String(closing.amount)} onChange={(e) => setClosing((p) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, '') }))} className={cn(inp, 'text-right tabular-nums')} />
              </div>
              <div className="text-[11px] font-semibold text-[#7A8C82]">A record only — the bank receipt is booked as usual.</div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-5 py-3">
              <button type="button" onClick={() => setClosing(null)} className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const c = closing
                  setClosing(null)
                  void act(() => window.api.fd.close(n(c.id), { date: c.date, amount: n(c.amount) }), `${c.fd_no} closed`)
                }}
                className="h-9 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38]"
              >
                Close FD
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/** Add or edit an FD. Banks are offered from the LCs' banks and the company's own bank ledgers. */
function FdForm({ init, lcs, onClose, onSaved }: { init: Row; lcs: Row[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [f, setF] = useState<Row>(init)
  const [own, setOwn] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    window.api.journal
      .accountNames()
      .then((a) => setOwn(a.filter((x) => ['Bank Accounts', 'Bank OD A/c'].includes(String(x.acc_group || ''))).map((x) => String(x.name))))
      .catch(() => setOwn([]))
  }, [])
  const lcBanks = useMemo(() => [...new Set(lcs.map((l) => String(l.bank || '').trim()).filter(Boolean))].sort(), [lcs])
  const set = (p: Row): void => setF((x) => ({ ...x, ...p }))
  // Tenure in days, both ways: typing days moves the maturity date.
  const days = f.start_date && f.maturity_date ? Math.round((new Date(`${f.maturity_date}T00:00:00`).getTime() - new Date(`${f.start_date}T00:00:00`).getTime()) / 86400000) : ''
  const setDays = (d: string): void => {
    if (!f.start_date || !(Number(d) > 0)) return
    const x = new Date(`${f.start_date}T00:00:00`)
    x.setDate(x.getDate() + Number(d))
    set({ maturity_date: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` })
  }
  const choices = f.bank_kind === 'lc' ? lcBanks : own
  async function save(): Promise<void> {
    setBusy(true)
    try {
      await window.api.fd.save(f)
      toast.success(f.id ? `${f.fd_no} saved` : `${f.fd_no} recorded`)
      onSaved()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-[640px] flex-col gap-0 overflow-hidden p-0 [&>button]:!text-white">
        <div className="flex-none bg-[#0B3D2E] px-5 py-3.5 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <PiggyBank className="h-3.5 w-3.5" /> Fixed deposit
          </div>
          <DialogTitle className="text-[16px] font-extrabold text-white">{f.id ? `Edit ${String(init.fd_no)}` : 'New FD'}</DialogTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <span className={lbl}>Bank</span>
            <div className="mb-2 flex h-9 w-fit rounded-[4px] border border-[#C9DCCF] p-0.5">
              {(
                [
                  ['own', 'Own bank'],
                  ['lc', 'LC bank']
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" onClick={() => set({ bank_kind: k, bank: '' })} className={cn('rounded-[3px] px-3 text-[12px] font-extrabold', f.bank_kind === k ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]')}>
                  {label}
                </button>
              ))}
            </div>
            <Select searchable value={String(f.bank || '')} onValueChange={(v) => set({ bank: v })}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={f.bank_kind === 'lc' ? 'Choose the LC bank' : 'Choose your bank'} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {[...new Set([...choices, ...(f.bank ? [String(f.bank)] : [])])].map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className={lbl}>FD No *</span>
              <input value={String(f.fd_no || '')} onChange={(e) => set({ fd_no: e.target.value })} placeholder="e.g. 50300123456789" className={inp} />
            </div>
            <div>
              <span className={lbl}>Amount *</span>
              <input inputMode="decimal" value={String(f.amount ?? '')} onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0.00" className={cn(inp, 'text-right tabular-nums')} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <span className={lbl}>Start date *</span>
              <DatePicker value={String(f.start_date || '')} onChange={(v) => v && set({ start_date: v })} />
            </div>
            <div>
              <span className={lbl}>Days</span>
              <input inputMode="numeric" value={String(days)} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} placeholder="365" className={cn(inp, 'text-right tabular-nums')} />
            </div>
            <div>
              <span className={lbl}>Maturity date *</span>
              <DatePicker value={String(f.maturity_date || '')} min={String(f.start_date || '') || undefined} onChange={(v) => v && set({ maturity_date: v })} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <span className={lbl}>Interest %</span>
              <input inputMode="decimal" value={String(f.interest_pct ?? '')} onChange={(e) => set({ interest_pct: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="7.00" className={cn(inp, 'text-right tabular-nums')} />
            </div>
            <div>
              <span className={lbl}>Interest</span>
              <Select value={String(f.interest_payout || 'cumulative')} onValueChange={(v) => set({ interest_payout: v })}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cumulative">Cumulative (quarterly)</SelectItem>
                  <SelectItem value="payout">Paid out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className={lbl}>Maturity value (bank)</span>
              <input inputMode="decimal" value={String(f.maturity_amount ?? '')} onChange={(e) => set({ maturity_amount: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="worked out if blank" className={cn(inp, 'text-right tabular-nums')} />
            </div>
          </div>
          <div>
            <span className={lbl}>Note</span>
            <input value={String(f.note || '')} onChange={(e) => set({ note: e.target.value })} placeholder="Receipt no., nominee, anything worth keeping" className={inp} />
          </div>
        </div>
        <div className="flex flex-none justify-end gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E]">
            Cancel
          </button>
          <button type="button" data-ctrl-a disabled={busy} onClick={() => void save()} className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save FD
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Put an FD (or part of it) against an LC. Opened from an FD (FD fixed) or from an LC (LC fixed). */
export function LienDialog({ init, fds, lcs, onClose, onSaved }: { init: Row; fds: Row[]; lcs: Row[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [v, setV] = useState<Row>(init)
  const [busy, setBusy] = useState(false)
  const fd = fds.find((x) => n(x.id) === n(v.fd_id))
  const usable = fds.filter((x) => x.status !== 'closed' && x.status !== 'matured' && n(x.free_amount) > 0.004)
  const open = lcs.filter(lcOpen)
  async function save(): Promise<void> {
    setBusy(true)
    try {
      await window.api.fd.addLien({ fd_id: n(v.fd_id), lc_id: n(v.lc_id), amount: n(v.amount), date: v.date, note: v.note })
      toast.success('FD put against the LC')
      onSaved()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-[560px] gap-0 overflow-hidden p-0 [&>button]:!text-white">
        <div className="bg-[#0B3D2E] px-5 py-3.5 text-white">
          <div className="flex items-center gap-1.5 text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">
            <Lock className="h-3.5 w-3.5" /> Lien
          </div>
          <DialogTitle className="text-[16px] font-extrabold text-white">Put an FD against an LC</DialogTitle>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div>
            <span className={lbl}>FD</span>
            <Select
              searchable
              value={v.fd_id ? String(v.fd_id) : ''}
              onValueChange={(x) => {
                const f = fds.find((y) => n(y.id) === Number(x))
                setV((p) => ({ ...p, fd_id: Number(x), amount: f ? String(n(f.free_amount)) : p.amount }))
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Choose an FD not yet matured" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {usable.map((x) => (
                  <SelectItem key={String(x.id)} value={String(x.id)}>
                    {String(x.fd_no)} · {String(x.bank)} · {formatINR(n(x.free_amount))} free · matures {formatDate(String(x.maturity_date))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <span className={lbl}>LC</span>
            <Select searchable value={v.lc_id ? String(v.lc_id) : ''} onValueChange={(x) => setV((p) => ({ ...p, lc_id: Number(x) }))}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Choose an open LC" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {open.map((l) => (
                  <SelectItem key={String(l.id)} value={String(l.id)}>
                    {String(l.lc_no || `LC #${l.id}`)} · {String(l.bank || '')} · {formatINR(n(l.amount))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={lbl}>Amount held</span>
              <input inputMode="decimal" value={String(v.amount ?? '')} onChange={(e) => setV((p) => ({ ...p, amount: e.target.value.replace(/[^0-9.]/g, '') }))} className={cn(inp, 'text-right tabular-nums')} />
              {fd && <span className="mt-1 block text-[10.5px] font-semibold text-[#7A8C82]">{formatINR(n(fd.free_amount))} of {formatINR(n(fd.amount))} free</span>}
            </div>
            <div>
              <span className={lbl}>Marked on</span>
              <DatePicker value={String(v.date || '')} onChange={(x) => x && setV((p) => ({ ...p, date: x }))} />
            </div>
          </div>
          <div className="rounded-[5px] border border-[#C6DAF0] bg-[#F4F8FD] px-3 py-2 text-[11.5px] font-semibold text-[#1B4E82]">
            The amount is frozen on the FD until the LC is repaid, preclosed or rejected — then it frees itself. Release it here any time the bank frees it earlier.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#E4ECE3] bg-[#FBFCFA] px-5 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E]">
            Cancel
          </button>
          <button
            type="button"
            data-ctrl-a
            disabled={busy || !v.fd_id || !v.lc_id || !(n(v.amount) > 0)}
            onClick={() => void save()}
            className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Lock className="h-3.5 w-3.5" /> Mark lien
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** On an LC: the FDs securing it, and a way to put one against it. */
export function LcFdSecurity({ lc, lcs }: { lc: Row; lcs: Row[] }): React.JSX.Element {
  const [liens, setLiens] = useState<Row[] | null>(null)
  const [fds, setFds] = useState<Row[]>([])
  const [adding, setAdding] = useState(false)
  const load = useCallback(() => {
    window.api.fd.lcLiens(n(lc.id)).then(setLiens).catch(() => setLiens([]))
    window.api.fd.list().then(setFds).catch(() => setFds([]))
  }, [lc.id])
  useEffect(load, [load])
  const live = (liens || []).filter((l) => l.active)
  const held = r2(live.reduce((t, l) => t + n(l.amount), 0))
  return (
    <div className="overflow-hidden rounded-[6px] border border-[#DCE6DC] bg-white">
      <div className="flex items-center gap-2 border-b border-[#EEF3EE] bg-[#F7FAF6] px-4 py-2.5">
        <PiggyBank className="h-4 w-4 text-[#0B3D2E]" />
        <span className="text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">FD security</span>
        {held > 0.004 && <span className="rounded-full bg-[#F4F8FD] px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-[#1B4E82]">{formatINR(held)} held</span>}
        {lcOpen(lc) && (
          <button type="button" onClick={() => setAdding(true)} className="ml-auto flex h-7 items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38]">
            <Plus className="h-3.5 w-3.5" /> Assign FD
          </button>
        )}
      </div>
      {liens == null ? (
        <div className="px-4 py-3 text-[12px] text-[#7A8C82]">Reading…</div>
      ) : !liens.length ? (
        <div className="px-4 py-3 text-[12px] font-semibold text-[#7A8C82]">
          No FD put against this LC yet{lc.fd_no ? ` — the LC names FD ${String(lc.fd_no)}` : ''}.
        </div>
      ) : (
        liens.map((l) => (
          <div key={String(l.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#F1F5F0] px-4 py-2 text-[12px] first:border-t-0">
            <span className="rounded-[4px] bg-[#0B3D2E] px-1.5 py-0.5 text-[11px] font-extrabold text-[#C7F03F]">{String(l.fd_no)}</span>
            <span className="font-semibold text-[#33473E]">{String(l.fd_bank || '')}</span>
            <span className="text-[11px] text-[#7A8C82]">matures {formatDate(String(l.fd_maturity))}</span>
            <span className="ml-auto font-extrabold tabular-nums">{formatINR(n(l.amount))}</span>
            {l.active ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#C6DAF0] bg-[#F4F8FD] px-2 py-0.5 text-[10.5px] font-extrabold text-[#1B4E82]">
                <Lock className="h-3 w-3" /> In force
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5A6B62]">
                <Unlock className="h-3 w-3" /> Released{l.released_on ? ` ${formatDate(String(l.released_on))}` : ''}
              </span>
            )}
          </div>
        ))
      )}
      {adding && (
        <LienDialog
          init={{ lc_id: n(lc.id), date: todayISO() }}
          fds={fds}
          lcs={lcs}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            load()
          }}
        />
      )}
    </div>
  )
}
