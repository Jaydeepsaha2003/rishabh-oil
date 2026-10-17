import { useEffect, useState } from 'react'
import { CalendarRange, ChevronDown, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePicker } from '@/components/ui/date-picker'
import { fyOptions } from '@/lib/fy'
import { formatDate, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// THE PERIOD A PAGE IS SHOWING, AS ONE CONTROL.
//
// The chip states the range in words a reader checks at a glance — "This FY",
// "October", or the two dates — and opens a panel with the usual periods a
// click away and the two dates for anything else. Alt+F2 sets the same range
// from anywhere (the page adopts the broadcast); the chip says so, and its
// "Alt F2" key opens that dialog for every page at once.

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function presets(): { label: string; from: string; to: string }[] {
  const today = todayISO()
  const t = new Date(`${today}T00:00:00`)
  const week = new Date(t)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const mStart = `${today.slice(0, 8)}01`
  const lastEnd = new Date(t.getFullYear(), t.getMonth(), 0)
  const lastStart = new Date(lastEnd.getFullYear(), lastEnd.getMonth(), 1)
  const monthName = (d: Date): string => d.toLocaleString('en-IN', { month: 'long' })
  const fy = fyOptions(2)
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: iso(new Date(t.getTime() - 86400000)), to: iso(new Date(t.getTime() - 86400000)) },
    { label: 'This week', from: iso(week), to: today },
    { label: monthName(t), from: mStart, to: today },
    { label: monthName(lastStart), from: iso(lastStart), to: iso(lastEnd) },
    ...fy.map((f, i) => ({ label: i === 0 ? `This FY · ${f.label.replace(/^FY /, '')}` : f.label, from: f.from, to: f.to })),
    { label: 'All dates', from: '', to: '' }
  ]
}

export function PeriodChip({
  from,
  to,
  onChange,
  className
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState(from)
  const [t, setT] = useState(to)
  useEffect(() => {
    if (open) {
      setF(from)
      setT(to)
    }
  }, [open, from, to])
  const list = presets()
  const named = list.find((p) => p.from === from && p.to === to)
  const label = named ? named.label : from || to ? `${from ? formatDate(from) : '…'} → ${to ? formatDate(to) : '…'}` : 'All dates'
  const narrowed = !!(from || to)
  const bad = !!f && !!t && f > t
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Change the period (Alt F2 sets it for every page)"
          className={cn(
            'flex h-9 items-center gap-2 whitespace-nowrap rounded-[7px] border bg-white pl-2.5 pr-1.5 text-[12px] font-extrabold transition-colors',
            narrowed ? 'border-[#12855A] text-[#0B3D2E]' : 'border-input text-[#33473E]',
            'hover:bg-[#F4F9EF]',
            className
          )}
        >
          <CalendarRange className="h-4 w-4 flex-none text-[#0B6B45]" />
          <span className="flex flex-col items-start leading-none">
            <span className="text-[8.5px] font-extrabold uppercase tracking-[.14em] text-[#8CA396]">Period</span>
            <span className="doc-ref mt-[3px] text-[12px] font-bold">{label}</span>
          </span>
          {named && narrowed && (
            <span className="doc-ref hidden text-[10.5px] font-semibold text-[#8CA396] xl:inline">
              {formatDate(from)} → {formatDate(to)}
            </span>
          )}
          <span
            className="doc-ref rounded-[4px] bg-[#EEF3EC] px-1.5 py-[3px] text-[9.5px] font-bold text-[#5A6B62]"
            onClick={(e) => {
              // The key, clickable: the app-wide dialog, for every page at once.
              e.preventDefault()
              e.stopPropagation()
              window.dispatchEvent(new Event('open-period'))
            }}
            title="Set this period for every page (Alt F2)"
          >
            Alt F2
          </span>
          <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="!w-[340px] !rounded-[10px] !border-[#DCE7DB] !p-0 !shadow-[0_18px_40px_-12px_rgba(10,31,23,.35)]">
        <div className="flex items-center gap-2 border-b border-[#EAF0E9] bg-[linear-gradient(180deg,#FBFDFA,#F4F7F2)] px-3.5 py-2.5">
          <CalendarRange className="h-4 w-4 text-[#0B6B45]" />
          <span className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#0B3D2E]">Period</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setOpen(false)} className="flex h-6 w-6 items-center justify-center rounded-[5px] hover:bg-[#EEF3EC]" title="Close">
            <X className="h-3.5 w-3.5 text-[#5A6B62]" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5 p-3">
          {list.map((p) => {
            const on = p.from === from && p.to === to
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  onChange(p.from, p.to)
                  setOpen(false)
                }}
                className={cn(
                  'flex h-9 items-center justify-between gap-2 rounded-[6px] border px-2.5 text-left text-[11.5px] font-extrabold transition-colors',
                  on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#DCE7DB] bg-white text-[#33473E] hover:border-[#12855A]'
                )}
              >
                <span className="truncate">{p.label}</span>
              </button>
            )
          })}
        </div>
        <div className="border-t border-[#EAF0E9] px-3 pb-3 pt-2.5">
          <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Custom</div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <DatePicker value={f} onChange={(v) => setF(v || '')} max={t || undefined} className="!h-9 !text-[12px]" />
            </div>
            <span className="text-[11px] text-[#8CA396]">→</span>
            <div className="min-w-0 flex-1">
              <DatePicker value={t} onChange={(v) => setT(v || '')} min={f || undefined} className="!h-9 !text-[12px]" />
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 text-[10.5px] font-semibold', bad ? 'text-[#B3261E]' : 'text-[#8CA396]')}>
              {bad ? 'From is after To' : 'Alt F2 sets a period for every page'}
            </span>
            <button
              type="button"
              disabled={bad}
              onClick={() => {
                onChange(f, t)
                setOpen(false)
              }}
              className="h-8 rounded-[6px] bg-[linear-gradient(180deg,#145A43,#0B3D2E)] px-3.5 text-[11.5px] font-extrabold text-[#C7F03F] disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
