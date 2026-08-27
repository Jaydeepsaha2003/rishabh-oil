import { useRef, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatINR, formatNum } from '@/lib/format'
import { BASIS_LABEL, type SaleShortage } from '@/lib/saleShortage'
import { cn } from '@/lib/utils'

// The workings behind a shortage on a delivered sale.
//
// The register can only ever show one number in the space it has, and "short
// 0.400" is the wrong one on its own -- it does not say whether 0.400 is a
// normal delivery or a claim worth thirty-five thousand rupees. So the number
// stays where it is and the reasoning sits behind it: dispatched, received,
// what the tolerance allowed, what fell outside it, and what that is worth.
//
// Hover opens it, because reading it should cost nothing; clicking pins it
// open, because a figure being copied onto a transporter's debit note should
// not vanish when the mouse moves.

function Line({
  label,
  sub,
  value,
  tone
}: {
  label: string
  sub?: string
  value: string
  tone?: 'muted' | 'bad' | 'good'
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <div className="min-w-0">
        <div
          className={cn(
            'text-[11.5px]',
            tone === 'bad' ? 'font-semibold text-rose-800' : tone === 'good' ? 'font-semibold text-emerald-800' : 'text-slate-600'
          )}
        >
          {label}
        </div>
        {sub && <div className="text-[10px] leading-tight text-slate-400">{sub}</div>}
      </div>
      <div
        className={cn(
          'shrink-0 whitespace-nowrap text-right text-[12px] tabular-nums',
          tone === 'bad'
            ? 'font-bold text-rose-700'
            : tone === 'good'
              ? 'font-bold text-emerald-700'
              : 'font-medium text-slate-800'
        )}
      >
        {value}
      </div>
    </div>
  )
}

// How the shortage sits against its tolerance, at a glance. The bar is the
// whole shortage; the green part is what the agreement absorbs and the red is
// what it does not.
function ToleranceBar({ s }: { s: SaleShortage }): React.JSX.Element {
  const span = Math.max(s.shortage, s.allowedQty) || 1
  const allowed = Math.min(100, (Math.min(s.allowedQty, s.shortage) / span) * 100)
  const over = Math.min(100 - allowed, (s.excessQty / span) * 100)
  return (
    <div className="mt-1.5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="bg-emerald-500" style={{ width: `${allowed}%` }} />
        <div className="bg-rose-500" style={{ width: `${over}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] uppercase tracking-wide text-slate-400">
        <span>Within tolerance</span>
        <span className={s.within ? '' : 'font-semibold text-rose-600'}>Beyond it</span>
      </div>
    </div>
  )
}

export function ShortageWorkings({
  s,
  uom,
  children,
  className
}: {
  s: SaleShortage
  uom: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Set by a click: the panel then stays until it is clicked away, so a figure
  // can be read off it without holding the mouse still.
  const pinned = useRef(false)
  const q = (v: number): string => `${formatNum(v)} ${uom}`

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) pinned.current = false
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('cursor-help text-left underline decoration-dotted underline-offset-4', className)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => {
            if (!pinned.current) setOpen(false)
          }}
          onClick={(e) => {
            e.stopPropagation()
            pinned.current = !pinned.current
            setOpen(true)
          }}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[19rem] border-[#d9d2b8] bg-[#fffdf4] p-0"
        onMouseLeave={() => {
          if (!pinned.current) setOpen(false)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={cn(
            'flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest',
            s.within ? 'bg-emerald-100 text-emerald-900' : 'bg-rose-100 text-rose-900'
          )}
        >
          {s.within ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {s.within ? 'Shortage within tolerance' : 'Shortage beyond tolerance'}
        </div>
        <div className="px-3 py-2">
          <Line label="Dispatched from the mill" value={q(s.dispatched)} />
          <Line label="Received at the customer" value={q(s.received)} />
          <div className="my-1 border-t border-dashed border-[#d9d2b8]" />
          <Line label="Short on arrival" value={q(s.shortage)} />
          <Line
            label={`Allowed — ${formatNum(s.pct)}% of ${formatNum(s.dispatched)}`}
            sub={BASIS_LABEL[s.basis]}
            value={q(s.allowedQty)}
          />
          <ToleranceBar s={s} />
          <div className="my-1.5 border-t-2 border-[#d9d2b8]" />
          {s.within ? (
            <Line
              label="Deductible excess"
              sub="Nothing to recover — the loss is inside what was agreed."
              value="Nil"
              tone="good"
            />
          ) : (
            <>
              <Line label="Deductible excess" sub="short less what the tolerance allows" value={q(s.excessQty)} tone="bad" />
              <Line
                label="Worth"
                sub={`${formatNum(s.excessQty)} × ${formatINR(s.rate)}/${uom}`}
                value={formatINR(s.deductible)}
                tone="bad"
              />
            </>
          )}
          {s.freightRate > 0 && s.shortage > 0 && (
            <>
              <div className="my-1 border-t border-dashed border-[#d9d2b8]" />
              <Line
                label="Freight already forgone"
                sub={`paid on the ${formatNum(s.received)} that arrived, not the ${formatNum(s.dispatched)} sent`}
                value={formatINR(s.freightForgone)}
              />
            </>
          )}
        </div>
        <div className="rounded-b-md border-t border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10px] leading-snug text-slate-500">
          {s.within
            ? 'Recorded for the register only. Nothing is posted either way.'
            : 'A figure to raise with the transporter — it is shown here, not posted to any ledger.'}
          {' Click to pin this open.'}
        </div>
      </PopoverContent>
    </Popover>
  )
}
