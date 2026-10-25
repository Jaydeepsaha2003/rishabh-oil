import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link2, Search, Unlink } from 'lucide-react'
import { errText, formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE BANK'S COMMISSION ON AN LC, AS CHARGED (lc.ts lcCommission). What it
// should be — open amount × the commission % taken at Open — against the bank
// voucher it actually came out by, linked here. The link puts the LC on that
// voucher in the ledgers; nothing is posted or changed.
export function LcCommissionLink({ lcId, onChanged }: { lcId: number; onChanged?: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<Row | null>(null)
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [cands, setCands] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  // The commission % typed here — for LCs opened before it was asked at Open.
  const [pct, setPct] = useState('')

  const load = useCallback(() => {
    window.api.lc
      .commission(lcId)
      .then((r) => {
        setInfo(r)
        setPct(r.commission_pct != null ? String(r.commission_pct) : r.bank_pct != null ? String(r.bank_pct) : '')
      })
      .catch((e) => toast.error(errText(e)))
  }, [lcId])
  const savePct = async (): Promise<void> => {
    const v = pct.trim() === '' ? null : Number(pct)
    setBusy(true)
    try {
      await window.api.lc.setCommissionPct(lcId, v)
      toast.success(v == null ? 'Commission % cleared' : `Commission set at ${v}%`)
      load()
      onChanged?.()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(load, [load])

  useEffect(() => {
    if (!picking) return
    let live = true
    setCands(null)
    const t = setTimeout(() => {
      window.api.lc
        .commissionCandidates(lcId, q)
        .then((r) => live && setCands(r))
        .catch((e) => toast.error(errText(e)))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [picking, q, lcId])

  const link = async (entryId: number | null): Promise<void> => {
    setBusy(true)
    try {
      await window.api.lc.linkCommission(lcId, entryId)
      toast.success(entryId ? 'Bank voucher linked to this LC' : 'Bank voucher unlinked')
      setPicking(false)
      load()
      onChanged?.()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!info) return <div className="px-1 py-2 text-[12px] text-[#5A6B62]">Reading…</div>
  const v = info.voucher as Row | null
  const expected = info.expected == null ? null : Number(info.expected)
  const diff = info.difference == null ? null : Number(info.difference)
  const vLabel = (x: Row): string => String(x.code || x.vch_no || `#${x.id}`)

  const pctChanged = (pct.trim() === '' ? null : Number(pct)) !== (info.commission_pct == null ? null : Number(info.commission_pct))
  const lcAmt = Number(info.amount || 0)
  const preview = Math.round(lcAmt * (Number(pct) || 0)) / 100
  const bankPct = info.bank_pct == null ? null : Number(info.bank_pct)
  const matched = diff != null && Math.abs(diff) < 1
  const cap = 'text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]'
  const tiles = [
    {
      k: 'Should be',
      v: expected == null ? null : formatINR(expected),
      empty: pctChanged ? 'Save the % above' : 'Set the % above',
      sub: info.commission_pct == null ? 'no commission % saved' : `${Number(info.commission_pct)}% of the open amount`
    },
    {
      k: 'Charged',
      v: v ? formatINR(Number(v.amount)) : null,
      empty: 'Not linked yet',
      sub: v ? `${vLabel(v)} · ${formatDate(String(v.entry_date))}` : 'link the bank voucher below'
    },
    {
      k: 'Difference',
      v: diff == null ? null : matched ? 'Matches' : `${diff > 0 ? '+' : '−'} ${formatINR(Math.abs(diff))}`,
      empty: 'Waiting',
      sub: diff == null ? 'needs both figures' : matched ? 'charged as expected' : diff > 0 ? 'the bank took more' : 'the bank took less',
      tone: diff == null ? '' : matched ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#FFF6E5] text-[#8A5300]'
    }
  ]
  return (
    <div className="grid gap-3 text-[12.5px]">
      <div className="overflow-hidden rounded-[8px] border border-[#DCE7DB] bg-white">
        {/* THE RATE and what it comes to — set here for an LC opened before
            the % was asked at Open; the bank's % (Edit limit) is offered. */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-4 py-3.5">
          <div>
            <div className={cap}>Commission rate</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <div className="relative">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={pct}
                  onChange={(e) => setPct(e.target.value)}
                  placeholder="0.25"
                  className="h-10 w-[104px] rounded-[6px] border border-[#C3D2C6] bg-white pl-3 pr-7 text-right text-[16px] font-extrabold tabular-nums text-[#0A1F17] outline-none focus:border-[#1B4E82] focus:ring-2 focus:ring-[#1B4E82]/15"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[13px] font-bold text-[#5A6B62]">%</span>
              </div>
              {bankPct != null && Number(pct) !== bankPct && (
                <button
                  type="button"
                  onClick={() => setPct(String(bankPct))}
                  className="rounded-full border border-[#C6DAF0] bg-[#F4F8FD] px-2.5 py-1 text-[11px] font-bold text-[#1B4E82] hover:bg-[#E6EFFA]"
                >
                  Use bank rate {bankPct}%
                </button>
              )}
            </div>
          </div>
          <div className="ml-auto min-w-0 text-right">
            <div className={cap}>Commission on this LC</div>
            <div className="mt-1 text-[22px] font-extrabold leading-tight tabular-nums text-[#0B3D2E]">{formatINR(preview)}</div>
            <div className="text-[11px] font-semibold tabular-nums text-[#5A6B62]">
              {Number(pct) || 0}% of {formatINR(lcAmt)}
            </div>
          </div>
        </div>
        {pctChanged && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[#F0DDB4] bg-[#FFF8EA] px-4 py-2">
            <span className="h-2 w-2 flex-none rounded-full bg-[#D99A1E]" />
            <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-[#8A5300]">
              {info.commission_pct == null && bankPct != null && Number(pct) === bankPct
                ? `The bank's ${bankPct}% is filled in — not saved on this LC yet`
                : 'Not saved on this LC yet'}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void savePct()}
              className="rounded-[5px] bg-[#0B3D2E] px-3.5 py-1.5 text-[11.5px] font-bold text-white hover:bg-[#0F5440] disabled:opacity-40"
            >
              Save %
            </button>
          </div>
        )}
        {/* What it should be, what was charged, and the gap. */}
        <div className="grid grid-cols-3 divide-x divide-[#E6EEE5] border-t border-[#E6EEE5] bg-[#FBFCFA]">
          {tiles.map((x) => (
            <div key={x.k} className={cn('min-w-0 px-3.5 py-3', x.tone)}>
              <div className={cap}>{x.k}</div>
              {x.v ? (
                <div className="mt-1 text-[15px] font-extrabold tabular-nums text-inherit [overflow-wrap:anywhere]">{x.v}</div>
              ) : (
                <div className="mt-1 text-[13px] font-bold text-[#9AAFA2]">{x.empty}</div>
              )}
              <div className="mt-0.5 text-[10.5px] font-semibold text-[#5A6B62] [overflow-wrap:anywhere]">{x.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {v ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-[#BFE3CB] bg-[#E9F5EE] px-3 py-2">
          <Link2 className="h-4 w-4 flex-none text-[#0B6B45]" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <b>{vLabel(v)}</b> {String(v.vch_type || '')} · {formatDate(String(v.entry_date))} · {String(v.bank || '')} {formatINR(Number(v.amount))}
            {v.narration ? <span className="text-[#5A6B62]"> — {String(v.narration)}</span> : null}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void link(null)}
            className="flex items-center gap-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2 py-1 text-[11px] font-bold text-[#8C2F26] hover:bg-rose-50"
          >
            <Unlink className="h-3.5 w-3.5" /> Unlink
          </button>
        </div>
      ) : !picking ? (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="flex items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-[#9FB6A6] bg-white px-3 py-2.5 text-[12.5px] font-bold text-[#0B3D2E] hover:bg-[#F1F8EC]"
        >
          <Link2 className="h-4 w-4" /> Link the bank voucher the commission was taken by
        </button>
      ) : (
        <div className="rounded-[6px] border border-[#DCE7DB] bg-white">
          <div className="flex items-center gap-2 border-b border-[#EAF0E9] px-3 py-2">
            <Search className="h-4 w-4 text-[#5A6B62]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by voucher no or narration — nearest to the expected amount first"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold outline-none"
            />
            <button type="button" onClick={() => setPicking(false)} className="text-[11px] font-bold text-[#5A6B62] hover:underline">
              Cancel
            </button>
          </div>
          <div className="max-h-64 overflow-auto">
            {cands == null ? (
              <div className="px-3 py-3 text-[12px] text-[#5A6B62]">Finding bank vouchers…</div>
            ) : cands.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-[#5A6B62]">No bank voucher in this company&apos;s books from the LC&apos;s opening on.</div>
            ) : (
              cands.map((x) => (
                <button
                  key={String(x.id)}
                  type="button"
                  disabled={busy}
                  onClick={() => void link(Number(x.id))}
                  className="flex w-full items-baseline gap-3 border-b border-[#F1F5F0] px-3 py-2 text-left last:border-b-0 hover:bg-[#F1F8EC]"
                >
                  <span className="w-[86px] flex-none text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">{formatDate(String(x.entry_date))}</span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <b>{vLabel(x)}</b> <span className="text-[11px] text-[#5A6B62]">{String(x.vch_type || '')} · {String(x.bank || '')}</span>
                    {x.narration ? <span className="block truncate text-[11px] text-[#5A6B62]">{String(x.narration)}</span> : null}
                  </span>
                  <span
                    className={cn(
                      'flex-none font-bold tabular-nums',
                      expected != null && Math.abs(Number(x.amount) - expected) < 1 ? 'text-[#0B6B45]' : 'text-[#0A1F17]'
                    )}
                  >
                    {formatINR(Number(x.amount))}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
