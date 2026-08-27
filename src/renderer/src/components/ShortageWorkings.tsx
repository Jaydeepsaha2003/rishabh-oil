import { useRef, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatINR, formatNum } from '@/lib/format'
import { BASIS_LABEL, type SaleShortage } from '@/lib/saleShortage'
import { cn } from '@/lib/utils'

// The workings behind a shortage on a delivered sale.
//
// It hangs off the FOR tag and nowhere else. A delivered load is weighed again
// at the customer's end, so FOR is exactly the thing this is about — and one
// place to look beats a figure repeated on the invoice row and again on every
// line, which is what it was, wrapping four words deep in a numeric column and
// making the register harder to read than it had been before.
//
// Hover opens it, because reading it should cost nothing. Clicking pins it,
// because a figure being copied onto a transporter's debit note should not
// vanish when the mouse moves.

export type ShortageLine = { product: string; uom: string; s: SaleShortage }

function Row({
  label,
  sub,
  value,
  tone,
  strong
}: {
  label: string
  sub?: string
  value: string
  tone?: 'bad' | 'good'
  strong?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <div className="min-w-0">
        <div
          className={cn(
            'text-[11.5px]',
            tone === 'bad'
              ? 'font-semibold text-rose-800'
              : tone === 'good'
                ? 'font-semibold text-emerald-800'
                : 'text-slate-600'
          )}
        >
          {label}
        </div>
        {sub && <div className="text-[10px] leading-tight text-slate-400">{sub}</div>}
      </div>
      <div
        className={cn(
          'shrink-0 whitespace-nowrap text-right tabular-nums',
          strong ? 'text-[13px]' : 'text-[12px]',
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

// How the shortage sits against its tolerance. The bar is the whole shortage;
// green is what the agreement absorbs, red is what it does not.
function ToleranceBar({ s }: { s: SaleShortage }): React.JSX.Element {
  const span = Math.max(s.shortage, s.allowedQty) || 1
  const allowed = Math.min(100, (Math.min(s.allowedQty, s.shortage) / span) * 100)
  const over = Math.min(100 - allowed, (s.excessQty / span) * 100)
  return (
    <div className="mt-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div className="bg-emerald-500" style={{ width: `${allowed}%` }} />
        <div className="bg-rose-500" style={{ width: `${over}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] uppercase tracking-wide text-slate-400">
        <span>Within tolerance</span>
        <span className={s.within ? '' : 'font-semibold text-rose-600'}>Beyond it</span>
      </div>
    </div>
  )
}

// One delivery line, in full.
function Detail({ line, showName }: { line: ShortageLine; showName: boolean }): React.JSX.Element {
  const { s, uom } = line
  const q = (v: number): string => `${formatNum(v)} ${uom}`
  return (
    <div className={cn(showName && 'border-t border-dashed border-[#d9d2b8] pt-1.5')}>
      {showName && (
        <div className="mb-0.5 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[11.5px] font-semibold text-[#1a2c56]">{line.product}</span>
          {!s.within && (
            <span className="shrink-0 text-[11px] font-bold tabular-nums text-rose-700">{formatINR(s.deductible)}</span>
          )}
        </div>
      )}
      <Row label="Dispatched from the mill" value={q(s.dispatched)} />
      <Row label="Received at the customer" value={q(s.received)} />
      <div className="my-1 border-t border-dashed border-[#d9d2b8]" />
      <Row label="Short on arrival" value={q(s.shortage)} />
      <Row
        label={`Allowed — ${formatNum(s.pct)}% of ${formatNum(s.dispatched)}`}
        sub={BASIS_LABEL[s.basis]}
        value={q(s.allowedQty)}
      />
      <ToleranceBar s={s} />
      <div className="my-1.5 border-t-2 border-[#d9d2b8]" />
      {s.within ? (
        <Row
          label="Deductible excess"
          sub="Nothing to recover — the loss is inside what was agreed."
          value="Nil"
          tone="good"
          strong
        />
      ) : (
        <>
          <Row label="Deductible excess" sub="short less what the tolerance allows" value={q(s.excessQty)} tone="bad" />
          <Row
            label="Worth of the excess"
            sub={`${formatNum(s.excessQty)} ${uom} × ${formatINR(s.rate)}/${uom}`}
            value={formatINR(s.deductible)}
            tone="bad"
            strong
          />
        </>
      )}
      {/* "Already forgone" read as though it were part of the deduction. It is
          not — it is a second, separate loss the transporter takes, and it has
          happened by itself without anyone claiming anything. */}
      {s.freightRate > 0 && s.shortage > 0 && (
        <Row
          label="Freight also forgone"
          sub={`on top of the above — freight is paid on the ${formatNum(s.received)} ${uom} that arrived, not the ${formatNum(s.dispatched)} sent`}
          value={formatINR(s.freightForgone)}
        />
      )}
    </div>
  )
}

export function ShortageWorkings({
  lines,
  children,
  className
}: {
  // Every unloaded line of the invoice that has something to say.
  lines: ShortageLine[]
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)

  const over = lines.filter((l) => !l.s.within)
  const due = over.reduce((t, l) => t + l.s.deductible, 0)
  const clean = over.length === 0

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
          className={cn('cursor-help', className)}
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
        className="max-h-[70vh] w-[20rem] overflow-y-auto border-[#d9d2b8] bg-[#fffdf4] p-0"
        onMouseLeave={() => {
          if (!pinned.current) setOpen(false)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={cn(
            'sticky top-0 flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest',
            clean ? 'bg-emerald-100 text-emerald-900' : 'bg-rose-100 text-rose-900'
          )}
        >
          {clean ? <AlertTriangle className="h-3 w-3 opacity-0" /> : <AlertTriangle className="h-3 w-3" />}
          {clean ? 'Delivered within tolerance' : `${formatINR(due)} deductible`}
          {clean && <Check className="ml-auto h-3 w-3" />}
        </div>
        <div className="px-3 py-2">
          {/* A single-line invoice is the common case and needs no heading; a
              multi-line one names each product, because "0.351 short" means
              nothing without knowing short OF WHAT. */}
          <div className="space-y-2">
            {lines.map((l, i) => (
              <Detail key={i} line={l} showName={lines.length > 1} />
            ))}
          </div>
          {lines.length > 1 && !clean && (
            <div className="mt-2 flex items-baseline justify-between gap-3 border-t-2 border-[#d9d2b8] pt-1.5">
              <span className="text-[11.5px] font-semibold text-rose-800">
                Deductible on {over.length} of {lines.length} lines
              </span>
              <span className="text-[13px] font-bold tabular-nums text-rose-700">{formatINR(due)}</span>
            </div>
          )}
        </div>
        <div className="border-t border-[#e5dfc8] bg-[#f7f4e8] px-3 py-1.5 text-[10px] leading-snug text-slate-500">
          {clean
            ? 'Recorded for the register only. Nothing is posted either way.'
            : 'A figure to raise with the transporter — shown here, not posted to any ledger.'}
          {' Click to pin.'}
        </div>
      </PopoverContent>
    </Popover>
  )
}
