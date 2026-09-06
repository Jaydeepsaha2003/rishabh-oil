import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  FILTER_PANEL_CLASS,
  FilterPanelEmpty,
  FilterPanelFooter,
  FilterPanelHeader,
  FilterPanelRow,
  FilterPanelSearch,
  FilterPanelSectionLabel
} from '@/components/ui/filter-panel'

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
  label,
  className
}: {
  options: { value: string; label: string; count?: number }[]
  value: string[]
  // Called on every tick now, not on a button. The name is kept so no caller
  // has to change.
  onApply: (values: string[]) => void
  // Shown on the closed trigger when nothing (or everything) is picked —
  // an empty/full selection both mean "no filter", same as a plain Select's
  // "ALL ..." option.
  allLabel: string
  // Names the panel's header ("Filter category"). Falls back to allLabel with
  // its leading "All" stripped, so the 20-odd existing callers get a sensible
  // heading without being touched.
  label?: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const picked = new Set(value)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  const allShownTicked = shown.length > 0 && shown.every((o) => picked.has(o.value))

  function toggle(v: string): void {
    const next = new Set(picked)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onApply(Array.from(next))
  }

  // Acts on the searched subset, like the column funnel — and doubles as
  // "untick these" once they are all already ticked.
  function toggleAllShown(): void {
    const next = new Set(picked)
    if (allShownTicked) for (const o of shown) next.delete(o.value)
    else for (const o of shown) next.add(o.value)
    onApply(Array.from(next))
  }

  const summary =
    value.length === 0 || value.length >= options.length
      ? allLabel
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label || value[0]
        : `${value.length} selected`

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
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
      <PopoverContent align="start" className={FILTER_PANEL_CLASS}>
        <FilterPanelHeader label={label || allLabel.replace(/^all\s+/i, '')} onClose={() => setOpen(false)} />
        <FilterPanelSearch value={query} onChange={setQuery} />
        <div className="max-h-60 overflow-y-auto">
          {options.length === 0 ? (
            <FilterPanelEmpty>No options.</FilterPanelEmpty>
          ) : (
            <>
              <FilterPanelSectionLabel>{query.trim() ? 'Search results' : 'All values'}</FilterPanelSectionLabel>
              <FilterPanelRow
                strong
                checked={allShownTicked}
                disabled={shown.length === 0}
                label="Select all"
                onClick={toggleAllShown}
              />
              {shown.length === 0 ? (
                <FilterPanelEmpty>Nothing matches &ldquo;{query.trim()}&rdquo;.</FilterPanelEmpty>
              ) : (
                shown.map((o) => (
                  <FilterPanelRow
                    key={o.value}
                    checked={picked.has(o.value)}
                    label={o.label}
                    count={o.count}
                    onClick={() => toggle(o.value)}
                  />
                ))
              )}
            </>
          )}
        </div>
        {/* Clearing means "no filter", which for this component is the empty
            selection its callers already read as "show everything". */}
        <FilterPanelFooter onClear={() => onApply([])} clearDisabled={value.length === 0} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
