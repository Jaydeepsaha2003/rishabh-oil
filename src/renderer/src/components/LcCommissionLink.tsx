import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Link2, Search, Unlink } from 'lucide-react'
import { errText, formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A BANK VOUCHER LINKED TO AN LC, AGAINST WHAT IT SHOULD HAVE BEEN.
//
// 'commission' — the bank's commission (lc.ts lcCommission): open amount × the
// commission % taken at Open, against the bank voucher it came out by.
// 'refund' — the interest the bank gives back on a preclosure (lc.ts
// lcRefund): the premature interest credited to us, against the bank receipt
// it came in by. Either way the link only sets the two side by side; nothing
// is posted or changed.
export function LcCommissionLink({
  lcId,
  kind = 'commission',
  onChanged
}: {
  lcId: number
  kind?: 'commission' | 'refund'
  onChanged?: () => void
}): React.JSX.Element {
  const refund = kind === 'refund'
  const [info, setInfo] = useState<Row | null>(null)
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [cands, setCands] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  // The commission % typed here — for LCs opened before it was asked at Open.
  const [pct, setPct] = useState('')

  const load = useCallback(() => {
    ;(refund ? window.api.lc.refund(lcId) : window.api.lc.commission(lcId))
      .then((r) => {
        setInfo(r)
        if (!refund) setPct(r.commission_pct != null ? String(r.commission_pct) : r.bank_pct != null ? String(r.bank_pct) : '')
      })
      .catch((e) => toast.error(errText(e)))
  }, [lcId, refund])
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
      ;(refund ? window.api.lc.refundCandidates(lcId, q) : window.api.lc.commissionCandidates(lcId, q))
        .then((r) => live && setCands(r))
        .catch((e) => toast.error(errText(e)))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [picking, q, lcId, refund])

  const link = async (entryId: number | null): Promise<void> => {
    setBusy(true)
    try {
      await (refund ? window.api.lc.linkRefund(lcId, entryId) : window.api.lc.linkCommission(lcId, entryId))
      toast.success(entryId ? `Bank ${refund ? 'receipt' : 'voucher'} linked to this LC` : 'Unlinked')
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
  const vLabel = (x: Row): string => String(x.code || x.vch_no || `#${x.id}`)

  const pctChanged = !refund && (pct.trim() === '' ? null : Number(pct)) !== (info.commission_pct == null ? null : Number(info.commission_pct))
  const lcAmt = Number(info.amount || 0)
  const preview = Math.round(lcAmt * (Number(pct) || 0)) / 100
  const bankPct = info.bank_pct == null ? null : Number(info.bank_pct)
  // What it should be: the saved figure, or — for the commission — what the %
  // typed above comes to, so the comparison reads before Save too.
  const expected = info.expected != null ? Number(info.expected) : !refund && pct.trim() !== '' ? preview : null
  const got = v ? Number(v.amount) : null
  const diff = got != null && expected != null ? Math.round((got - expected) * 100) / 100 : null
  const matched = diff != null && Math.abs(diff) < 1
  const cap = 'text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]'
  const tiles = [
    {
      k: refund ? 'Should come back' : 'Calculated',
      v: expected == null ? null : formatINR(expected),
      empty: refund ? 'Not credited to us' : 'Set the % above',
      sub: refund
        ? info.to_us === false
          ? 'the premature interest went to the party'
          : 'premature interest credited to us'
        : `${Number(pct) || 0}% of ${formatINR(lcAmt)}${pctChanged ? ' — not saved' : ''}`
    },
    {
      k: refund ? 'Received' : 'Charged by bank',
      v: got == null ? null : formatINR(got),
      empty: 'Not linked yet',
      sub: v ? `${vLabel(v)} · ${formatDate(String(v.entry_date))}` : `link the bank ${refund ? 'receipt' : 'voucher'} below`
    },
    {
      k: 'Difference',
      v: diff == null ? null : matched ? 'Matches' : formatINR(Math.abs(diff)),
      empty: 'Waiting',
      sub:
        diff == null
          ? 'needs both figures'
          : matched
            ? refund
              ? 'refunded as expected'
              : 'charged as expected'
            : refund
              ? diff > 0
                ? 'received more than expected'
                : 'short refunded'
              : diff > 0
                ? 'over charged'
                : 'less charged',
      tone: diff == null ? '' : matched ? 'bg-[#E9F5EE] text-[#0B6B45]' : (refund ? diff < 0 : diff > 0) ? 'bg-[#FDECEA] text-[#B3261E]' : 'bg-[#FFF6E5] text-[#8A5300]'
    }
  ]
  return (
    // minmax(0, 1fr): a long narration in the picker below must not stretch
    // the card past its panel (it hid the amounts off the right edge).
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 text-[12.5px]">
      <div className="overflow-hidden rounded-[8px] border border-[#DCE7DB] bg-white">
        {/* THE RATE and what it comes to — set here for an LC opened before
            the % was asked at Open; the bank's % (Edit limit) is offered. */}
        {!refund && (
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
                    className="rounded-[3px] border border-[#C6DAF0] bg-[#F4F8FD] px-2.5 py-1 text-[11px] font-bold text-[#1B4E82] hover:bg-[#E6EFFA]"
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
        )}
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
        {/* What it should be, what the bank did, and the gap. */}
        <div className={cn('grid grid-cols-3 divide-x divide-[#E6EEE5] bg-[#FBFCFA]', !refund && 'border-t border-[#E6EEE5]')}>
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
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-[6px] border border-[#BFE3CB] bg-[#E9F5EE] px-3 py-2">
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
        // NOTHING LINKED YET — said as something missing, not a quiet dashed
        // box: the comparison above cannot be made until it is done.
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-[6px] border border-[#E8B44C] border-l-4 border-l-[#D98E04] bg-[#FFF6E3] px-3 py-2.5">
          <AlertTriangle className="h-5 w-5 flex-none text-[#C27C00]" />
          <span className="min-w-[160px] flex-1">
            <span className="block text-[12.5px] font-extrabold text-[#6B4300]">
              {refund ? 'Refund receipt not linked' : 'Commission voucher not linked'}
            </span>
            <span className="block text-[11px] font-semibold leading-[1.45] text-[#8A5A00]">
              {refund
                ? 'Link the bank receipt it came in by to check it against what should come back.'
                : 'Link the bank voucher it was taken by to check it against the calculated figure.'}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="flex flex-none items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-3.5 py-2 text-[12px] font-extrabold text-[#C7F03F] shadow-[0_1px_2px_rgba(10,31,23,.25)] hover:bg-[#0F5440]"
          >
            <Link2 className="h-4 w-4" /> {refund ? 'Link receipt' : 'Link voucher'}
          </button>
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-[6px] border border-[#DCE7DB] bg-white">
          <div className="flex items-center gap-2 border-b border-[#EAF0E9] px-3 py-2">
            <Search className="h-4 w-4 flex-none text-[#5A6B62]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Voucher no or narration — nearest amount first"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold outline-none"
            />
            <button type="button" onClick={() => setPicking(false)} className="flex-none text-[11px] font-bold text-[#5A6B62] hover:underline">
              Cancel
            </button>
          </div>
          <div className="max-h-64 overflow-auto">
            {cands == null ? (
              <div className="px-3 py-3 text-[12px] text-[#5A6B62]">Finding bank {refund ? 'receipts' : 'vouchers'}…</div>
            ) : cands.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-[#5A6B62]">
                No bank {refund ? 'receipt' : 'voucher'} in this company&apos;s books from {refund ? 'the closure' : "the LC's opening"} on.
              </div>
            ) : (
              cands.map((x) => {
                const off = expected == null ? null : Math.round((Number(x.amount) - expected) * 100) / 100
                return (
                  <button
                    key={String(x.id)}
                    type="button"
                    disabled={busy}
                    onClick={() => void link(Number(x.id))}
                    className="grid w-full grid-cols-[78px_minmax(0,1fr)_auto] items-start gap-3 border-b border-[#F1F5F0] px-3 py-2 text-left last:border-b-0 hover:bg-[#F1F8EC]"
                  >
                    <span className="pt-px text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">{formatDate(String(x.entry_date))}</span>
                    <span className="min-w-0">
                      <span className="block truncate">
                        <b>{vLabel(x)}</b> <span className="text-[11px] text-[#5A6B62]">{String(x.bank || '')}</span>
                      </span>
                      {x.narration ? <span className="block truncate text-[11px] text-[#5A6B62]">{String(x.narration)}</span> : null}
                    </span>
                    {/* The figure always shows: the reason to pick one over another. */}
                    <span className="whitespace-nowrap text-right">
                      <span className={cn('block font-bold tabular-nums', off != null && Math.abs(off) < 1 ? 'text-[#0B6B45]' : 'text-[#0A1F17]')}>
                        {formatINR(Number(x.amount))}
                      </span>
                      {off != null && (
                        <span className="block text-[10px] font-semibold tabular-nums text-[#5A6B62]">
                          {Math.abs(off) < 1 ? 'matches' : `${off > 0 ? '+' : '−'}${formatINR(Math.abs(off))}`}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
