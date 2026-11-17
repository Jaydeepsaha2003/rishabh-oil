import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate, formatINR } from '@/lib/format'

// INTEREST TO COME BACK on a bill repaid before maturity (billDiscounting.ts
// earlyRefund): a dot beside the interest, the working on hover.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0

export function BdRefundDot({ refund }: { refund: Row }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines: Row[] = Array.isArray(refund.lines) ? refund.lines : []
  // Back in full once bank receipts mapped to it (Interest refunds) cover it.
  const back = refund.due != null && !(n(refund.due) > 0.5)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Interest to come back: ${formatINR(n(refund.net))}`}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className="relative ml-1.5 inline-flex h-4 w-4 flex-none items-center justify-center align-middle"
        >
          {back ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-[#12855A]" />
          ) : (
            <>
              <span className="absolute h-3 w-3 animate-ping rounded-full bg-[#2E9E62] opacity-30" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-[#12855A] ring-2 ring-white" />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="bg-[#0B3D2E] px-3.5 py-2.5 text-white">
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">{back ? 'Interest refund — received' : 'Interest to come back'}</div>
          <div className="mt-0.5 text-[18px] font-extrabold tabular-nums">{formatINR(back ? n(refund.net) : n(refund.due ?? refund.net))}</div>
          <div className="text-[11px] font-semibold text-white/70">
            Repaid before maturity on {formatDate(String(refund.maturity))} — the days not used were charged upfront
          </div>
        </div>
        <table className="w-full text-[11.5px]">
          <thead className="bg-[#F5F8F4] text-[9px] font-extrabold uppercase tracking-[.1em] text-[#7A8C82]">
            <tr>
              <th className="px-3 py-1.5 text-left">Repaid</th>
              <th className="px-2 py-1.5 text-right">Amount</th>
              <th className="px-2 py-1.5 text-right">Days left</th>
              <th className="px-3 py-1.5 text-right">Interest</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-[#F1F5F0]">
                <td className="whitespace-nowrap px-3 py-1.5 font-semibold tabular-nums text-[#0A1F17]">{formatDate(String(l.date))}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatINR(n(l.amount))}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{n(l.days)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(n(l.gross))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-0.5 border-t border-[#DCE6DC] bg-[#FAFCF9] px-3 py-2 text-[11.5px]">
          <div className="flex justify-between text-[12px]">
            <span className="font-extrabold text-[#0B6B45]">To come back from the NBFC</span>
            <span className="font-extrabold tabular-nums text-[#0B6B45]">{formatINR(n(refund.net))}</span>
          </div>
          {n(refund.received) > 0.004 && (
            <>
              <div className="flex justify-between">
                <span className="text-[#5A6B62]">Received (mapped bank receipts)</span>
                <span className="font-bold tabular-nums">− {formatINR(n(refund.received))}</span>
              </div>
              <div className="flex justify-between text-[12px]">
                <span className={back ? 'font-extrabold text-[#0B6B45]' : 'font-extrabold text-[#B3261E]'}>Still due</span>
                <span className={back ? 'font-extrabold tabular-nums text-[#0B6B45]' : 'font-extrabold tabular-nums text-[#B3261E]'}>{back ? 'nil' : formatINR(n(refund.due))}</span>
              </div>
            </>
          )}
          <div className="pt-0.5 text-[10.5px] text-[#8CA396]">
            amount × {n(refund.rate)}% × days left ÷ {n(refund.days_year)} — of {formatINR(n(refund.interest))} taken upfront
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
