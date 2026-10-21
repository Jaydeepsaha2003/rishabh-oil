import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Check, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { DatePicker } from '@/components/ui/date-picker'
import { useGlobalDateRange, useSetGlobalDateRange } from '@/lib/globalDateRange'
import { formatDate, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// Human label for each page key, just for this dialog's own "Apply to this
// page only" button — keeps the wording readable without importing the whole
// Sidebar module just for its ITEMS map.
const PAGE_LABEL: Record<string, string> = {
  bargains: 'Purchase Bargain',
  orders: 'Purchases',
  consignment: 'Consignment',
  gateEntry: 'Gate Entry',
  trading: 'Trading',
  accounts: 'Accounting',
  stock: 'Stock',
  sales: 'Sales',
  salesBargains: 'Sales Bargain',
  production: 'Production'
}
// Only pages with their own date-range filter can sensibly take a page-only
// apply — showing the button elsewhere would just do nothing when clicked.
const RANGE_AWARE_PAGES = new Set(Object.keys(PAGE_LABEL))

// ---- dates, as YYYY-MM-DD strings in local time ---------------------------
const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const at = (s: string): Date => new Date(`${s}T00:00:00`)
const addDays = (s: string, n: number): string => {
  const d = at(s)
  d.setDate(d.getDate() + n)
  return iso(d)
}
const monthStart = (y: number, m: number): string => iso(new Date(y, m, 1))
const monthEnd = (y: number, m: number): string => iso(new Date(y, m + 1, 0))
const fyOf = (s: string): number => {
  const d = at(s)
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
}
const fyLabel = (y: number): string => `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`
const daysIn = (f: string, t: string): number => Math.round((at(t).getTime() - at(f).getTime()) / 86400000) + 1

// The quick choices, worked out from today. A financial quarter runs
// Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar, as the books do.
function presets(today: string): { key: string; label: string; from: string; to: string }[] {
  const d = at(today)
  const y = d.getFullYear()
  const m = d.getMonth()
  const back = (d.getDay() + 6) % 7
  const qStartMonth = Math.floor(((m + 9) % 12) / 3) * 3 // months since April, floored to a quarter
  const qs = new Date(fyOf(today), 3 + qStartMonth, 1)
  const qe = new Date(qs.getFullYear(), qs.getMonth() + 3, 0)
  const lqs = new Date(qs.getFullYear(), qs.getMonth() - 3, 1)
  const lqe = new Date(qs.getFullYear(), qs.getMonth(), 0)
  const fy = fyOf(today)
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { key: 'week', label: 'This week', from: addDays(today, -back), to: today },
    { key: 'l7', label: 'Last 7 days', from: addDays(today, -6), to: today },
    { key: 'month', label: 'This month', from: monthStart(y, m), to: today },
    { key: 'lmonth', label: 'Last month', from: monthStart(y, m - 1), to: monthEnd(y, m - 1) },
    { key: 'qtr', label: 'This quarter', from: iso(qs), to: iso(qe) < today ? iso(qe) : today },
    { key: 'lqtr', label: 'Last quarter', from: iso(lqs), to: iso(lqe) },
    { key: 'fy', label: 'This FY', from: `${fy}-04-01`, to: `${fy + 1}-03-31` },
    { key: 'lfy', label: 'Last FY', from: `${fy - 1}-04-01`, to: `${fy}-03-31` }
  ]
}

// Alt+F2 — Tally's period-change shortcut. Pick a range here and either every
// page's own date filter switches to it at once, or (if you only need it for
// what's open right now) just this one page does.
export function GlobalDateRangeDialog({
  open,
  onOpenChange,
  currentPage
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPage?: string
}): React.JSX.Element {
  const current = useGlobalDateRange()
  const setGlobalRange = useSetGlobalDateRange()
  const [from, setFrom] = useState(current.from)
  const [to, setTo] = useState(current.to)
  const today = todayISO()
  const quick = useMemo(() => presets(today), [today])

  useEffect(() => {
    if (open) {
      setFrom(current.from)
      setTo(current.to)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const invalidRange = !!from && !!to && from > to
  const canApplyToPage = !!currentPage && RANGE_AWARE_PAGES.has(currentPage)
  const pageLabel = currentPage ? PAGE_LABEL[currentPage] || currentPage : ''
  const onPreset = quick.find((p) => p.from === from && p.to === to)?.key
  // Five financial years back, for an older year in one tap.
  const fyList = useMemo(() => {
    const fy = fyOf(today)
    return Array.from({ length: 5 }, (_, i) => fy - i)
  }, [today])

  function apply(scope: 'all' | 'page'): void {
    if (invalidRange) return
    setGlobalRange(from, to, scope, scope === 'page' ? currentPage : undefined)
    onOpenChange(false)
  }

  function clear(): void {
    setFrom('')
    setTo('')
    setGlobalRange('', '', 'all')
    onOpenChange(false)
  }

  const summary =
    from && to && !invalidRange
      ? `${formatDate(from)} → ${formatDate(to)} · ${daysIn(from, to)} day${daysIn(from, to) === 1 ? '' : 's'}`
      : from
        ? `From ${formatDate(from)} onwards`
        : to
          ? `Up to ${formatDate(to)}`
          : 'All dates — no period set'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!max-w-[640px] !gap-0 !overflow-hidden !rounded-[12px] !border-0 !p-0 [&>button]:hidden"
        onKeyDown={(e) => {
          // Enter applies everywhere, as Tally's period box does.
          if (e.key === 'Enter' && !(e.target as HTMLElement).closest('button')) {
            e.preventDefault()
            apply('all')
          }
        }}
      >
        {/* Header: what this is, and the period it will set. */}
        <div className="flex items-start gap-3 px-5 pb-4 pt-4 text-white" style={{ background: 'linear-gradient(160deg,#145A43 0%,#0B3D2E 55%,#072B20 100%)' }}>
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-[9px] bg-white/10">
            <CalendarRange className="h-5 w-5 text-[#C7F03F]" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="!text-[16px] !font-extrabold !tracking-[-0.01em] !text-white">Change period</DialogTitle>
            <div className="mt-0.5 text-[11.5px] font-semibold text-[#A9CDBB]">
              Every register, ledger, day book and trial balance answers for these dates · <span className="font-extrabold text-[#C7F03F]">Alt+F2</span>
            </div>
            <div
              className={cn(
                'mt-2.5 inline-flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[12.5px] font-bold tabular-nums',
                invalidRange ? 'bg-[#B3261E]/30 text-[#FFD9D5]' : 'bg-white/10 text-white'
              )}
            >
              {invalidRange ? 'The From date must be on or before the To date' : summary}
            </div>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close" className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] text-white/70 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-[#F6F9F5] px-5 py-4">
          {/* Quick choices. */}
          <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Quick pick</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            {quick.map((p) => {
              const on = onPreset === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    setFrom(p.from)
                    setTo(p.to)
                  }}
                  title={`${formatDate(p.from)} → ${formatDate(p.to)}`}
                  className={cn(
                    'flex h-9 items-center justify-center gap-1 truncate rounded-[7px] border px-2 text-[11.5px] font-extrabold transition-colors',
                    on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#DCE7DB] bg-white text-[#33473E] hover:border-[#9DBFAA] hover:bg-[#EEF5EC]'
                  )}
                >
                  {on && <Check className="h-3.5 w-3.5 flex-none text-[#C7F03F]" />}
                  <span className="truncate">{p.label}</span>
                </button>
              )
            })}
          </div>

          {/* Any financial year. */}
          <div className="mt-4 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Financial year</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {fyList.map((y) => {
              const f = `${y}-04-01`
              const t = `${y + 1}-03-31`
              const on = from === f && to === t
              return (
                <button
                  key={y}
                  type="button"
                  onClick={() => {
                    setFrom(f)
                    setTo(t)
                  }}
                  className={cn(
                    'h-8 rounded-full border px-3 text-[11.5px] font-extrabold tabular-nums transition-colors',
                    on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#DCE7DB] bg-white text-[#33473E] hover:bg-[#EEF5EC]'
                  )}
                >
                  {fyLabel(y)}
                </button>
              )
            })}
          </div>

          {/* Or exactly. */}
          <div className="mt-4 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Custom dates</div>
          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="rounded-[8px] border border-[#DCE7DB] bg-white p-1.5">
              <div className="px-1 text-[9px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">From</div>
              <DatePicker value={from} onChange={(v) => setFrom(v || '')} max={to || undefined} />
            </div>
            <span className="text-[12px] font-bold text-[#8CA396]">→</span>
            <div className="rounded-[8px] border border-[#DCE7DB] bg-white p-1.5">
              <div className="px-1 text-[9px] font-extrabold uppercase tracking-[.12em] text-[#8CA396]">To</div>
              <DatePicker value={to} onChange={(v) => setTo(v || '')} min={from || undefined} />
            </div>
          </div>
        </div>

        {/* Actions. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[#E3ECE2] bg-white px-5 py-3">
          <button type="button" onClick={clear} className="h-9 rounded-[7px] px-3 text-[12px] font-extrabold text-[#8C2F26] hover:bg-[#FDF3F2]">
            Clear period
          </button>
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-9 rounded-[7px] border border-[#C3D2C6] bg-white px-3.5 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F4F7F3]"
            >
              Cancel
            </button>
            {canApplyToPage && (
              <button
                type="button"
                disabled={invalidRange}
                onClick={() => apply('page')}
                className="h-9 rounded-[7px] border border-[#0B3D2E] bg-white px-3.5 text-[12px] font-extrabold text-[#0B3D2E] hover:bg-[#EEF5EC] disabled:opacity-40"
              >
                {pageLabel} only
              </button>
            )}
            <button
              type="button"
              disabled={invalidRange}
              onClick={() => apply('all')}
              className="h-9 rounded-[7px] px-4 text-[12px] font-extrabold text-[#0B3D2E] shadow-[inset_0_1px_0_rgba(255,255,255,.6),0_6px_16px_-6px_rgba(199,240,63,.7)] disabled:opacity-40"
              style={{ background: 'linear-gradient(180deg,#DDF97A,#B9E534)' }}
            >
              Apply everywhere ↵
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
