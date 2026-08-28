import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// A filter dropdown that narrows a register by several categories at once.
//
// It used to stage the ticks and wait for an Apply button. That was defensive
// about re-rendering, and it cost more than it saved: every other picker in the
// app filters the moment you tick, so this one alone made you tick and then
// hunt for a button — and closing it any other way silently threw the picks
// away. Ticking IS the instruction now, and the list behind updates as you go,
// which is also the only way to see what a filter actually does.
//
// Deliberately separate from <Select>: that component is a single-value field
// backed by one database column (Supplier, Product, Customer, …) where "select
// more than one" has no meaning. This is only for dropdowns that narrow a
// list/table — Category, Stage, Status and the like.
export function MultiSelectFilter({
  options,
  value,
  onApply,
  allLabel,
  className
}: {
  options: { value: string; label: string }[]
  value: string[]
  // Called on every tick now, not on a button. The name is kept so no caller
  // has to change.
  onApply: (values: string[]) => void
  // Shown on the closed trigger when nothing (or everything) is picked —
  // an empty/full selection both mean "no filter", same as a plain Select's
  // "ALL ..." option.
  allLabel: string
  className?: string
}): React.JSX.Element {
  const picked = new Set(value)

  function toggle(v: string): void {
    const next = new Set(picked)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onApply(Array.from(next))
  }

  const summary =
    value.length === 0 || value.length >= options.length
      ? allLabel
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label || value[0]
        : `${value.length} selected`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-transparent px-3 text-sm uppercase shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring',
            className
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="max-h-64 overflow-y-auto p-1">
          {options.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">No options.</div>
          ) : (
            options.map((o) => {
              const checked = picked.has(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm normal-case',
                    checked ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                  )}
                >
                  {/* Same box the pickers use — visible before it is ticked, or
                      nothing says the list takes more than one answer. */}
                  <span
                    className={cn(
                      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-slate-400 bg-white'
                    )}
                  >
                    {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center gap-1 border-t p-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onApply(options.map((o) => o.value))}
          >
            All
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onApply([])}
          >
            None
          </Button>
          <span className="ml-auto pr-1 text-[10px] text-muted-foreground">filters as you tick</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
