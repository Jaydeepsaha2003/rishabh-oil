import { useEffect, useState } from 'react'
import { Check, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// An Excel-style column filter: the header keeps its label and grows a small
// funnel next to it, which opens a checkbox list of the values actually in
// that column. The funnel fills in while a filter is active, so a narrowed
// column is obvious at a glance rather than silently hiding rows.
//
// Same staged-then-Apply behaviour as MultiSelectFilter (ticking stays local
// until Apply; closing without it discards the pick) — this is just the
// in-header presentation of it, for a column that has no room for a full
// dropdown field in the filter bar above.
export function ColumnFilter({
  label,
  options,
  value,
  onApply,
  align = 'start'
}: {
  label: string
  options: { value: string; label: string }[]
  // Empty = no filter (every value shows), same convention as MultiSelectFilter.
  value: string[]
  onApply: (values: string[]) => void
  align?: 'start' | 'center' | 'end'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [staged, setStaged] = useState<Set<string>>(new Set(value))

  useEffect(() => {
    if (open) setStaged(new Set(value))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // A selection covering everything means "no filter" — stored as empty so the
  // funnel reads unfiltered and the row predicate can skip the check entirely.
  const active = value.length > 0 && value.length < options.length

  function toggle(v: string): void {
    setStaged((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }

  function apply(): void {
    onApply(staged.size >= options.length ? [] : Array.from(staged))
    setOpen(false)
  }

  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={active ? `Filtered — ${value.length} of ${options.length} shown` : `Filter by ${label}`}
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
              active
                ? 'bg-[#1a2c56] text-white'
                : 'text-muted-foreground/50 hover:bg-muted hover:text-foreground'
            )}
          >
            <Filter className={cn('h-3 w-3', active && 'fill-current')} />
          </button>
        </PopoverTrigger>
        <PopoverContent align={align} className="w-52 p-0">
          <div className="max-h-64 overflow-y-auto p-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">No values.</div>
            ) : (
              options.map((o) => {
                const checked = staged.has(o.value)
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm font-normal normal-case tracking-normal',
                      checked ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-1 border-t p-1.5">
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setStaged(new Set(options.map((o) => o.value)))}
              >
                All
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => setStaged(new Set())}>
                None
              </Button>
            </div>
            <Button type="button" size="sm" className="h-6 px-2 text-[11px]" onClick={apply}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
