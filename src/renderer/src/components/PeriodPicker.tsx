import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate } from '@/lib/format'
import { periodOptions } from '@/lib/periods'
import { cn } from '@/lib/utils'

// A calendar-period quick-filter: click opens Today / This week / This month
// / This quarter / This financial year, plus a custom from-to range — for
// narrowing a KPI or register to a specific window instead of "everything".
export function PeriodPicker({
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
  const [customFrom, setCustomFrom] = useState(from)
  const [customTo, setCustomTo] = useState(to)
  const options = periodOptions()
  const active = options.find((o) => o.from === from && o.to === to)
  const label = !from && !to ? 'All time' : active ? active.label : `${formatDate(from)} – ${formatDate(to)}`

  function choose(f: string, t: string): void {
    onChange(f, t)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setCustomFrom(from)
          setCustomTo(to)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn('h-9 justify-between gap-2 text-xs font-medium', className)}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => choose('', '')}
            className={cn(
              'flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
              !from && !to && 'bg-muted font-medium'
            )}
          >
            All time
            {!from && !to && <Check className="h-3.5 w-3.5" />}
          </button>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => choose(o.from, o.to)}
              className={cn(
                'flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
                from === o.from && to === o.to && 'bg-muted font-medium'
              )}
            >
              {o.label}
              {from === o.from && to === o.to && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
        <div className="mt-2 border-t pt-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Custom range
          </div>
          <div className="flex flex-col gap-1.5">
            <DatePicker value={customFrom} onChange={setCustomFrom} max={customTo || undefined} placeholder="From" />
            <DatePicker value={customTo} onChange={setCustomTo} min={customFrom || undefined} placeholder="To" />
            <Button
              type="button"
              size="sm"
              className="mt-1"
              disabled={!customFrom || !customTo}
              onClick={() => choose(customFrom, customTo)}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
