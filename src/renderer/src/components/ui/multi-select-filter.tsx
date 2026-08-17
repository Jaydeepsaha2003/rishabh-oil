import { useEffect, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// A filter dropdown that checks several boxes before committing — narrowing a
// register by 2-3 categories at once shouldn't re-filter (and re-render) on
// every single click. Checking stays purely local until Apply; closing
// without it (click-away, Escape) discards whatever was ticked and the panel
// reopens next time from the last APPLIED selection, never what was mid-pick.
//
// Deliberately separate from <Select>: that component is a single-value
// field backed by one database column (Supplier, Product, Customer, …) where
// "select more than one" has no meaning. This is only for dropdowns that
// narrow a list/table — Category, Stage, Status and the like.
export function MultiSelectFilter({
  options,
  value,
  onApply,
  allLabel,
  className
}: {
  options: { value: string; label: string }[]
  value: string[]
  onApply: (values: string[]) => void
  // Shown on the closed trigger when nothing (or everything) is picked —
  // an empty/full selection both mean "no filter", same as a plain Select's
  // "ALL ..." option.
  allLabel: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [staged, setStaged] = useState<Set<string>>(new Set(value))

  // Re-seed the working set from whatever's actually applied every time the
  // panel opens, so a discarded in-progress pick never leaks into the next.
  useEffect(() => {
    if (open) setStaged(new Set(value))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(v: string): void {
    setStaged((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }

  function apply(): void {
    onApply(Array.from(staged))
    setOpen(false)
  }

  const summary =
    value.length === 0 || value.length >= options.length
      ? allLabel
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label || value[0]
        : `${value.length} selected`

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
              const checked = staged.has(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm normal-case',
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
  )
}
