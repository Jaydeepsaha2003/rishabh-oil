import { useEffect, useMemo, useRef, useState } from 'react'
import { Filter } from 'lucide-react'
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

// An Excel-style column filter: the header keeps its label and grows a small
// funnel next to it, which opens a searchable checkbox list of the values
// actually in that column. The funnel fills in while a filter is active, so a
// narrowed column is obvious at a glance rather than silently hiding rows.
//
// Ticking applies straight away — there is no OK to press. The list of values
// a column offers is built from the rows that pass every OTHER filter, so this
// column's own options do not shift under the cursor while it is being ticked,
// which is what makes live filtering safe here.
//
// Search narrows the visible list; (Select All) then applies to WHAT IS
// SHOWN, exactly as Excel does — so searching "GJ12" and hitting Select All
// ticks only those, leaving anything already ticked outside the search alone.
export function ColumnFilter({
  label,
  options,
  value,
  onApply,
  align = 'start',
  onDark = false
}: {
  label: string
  // `count` is optional — a caller that already walks the rows to build this
  // list can pass how many each value matches; one that cannot simply omits
  // it and the chip is left off.
  options: { value: string; label: string; count?: number }[]
  // Empty = no filter (every value shows), same convention as MultiSelectFilter.
  value: string[]
  onApply: (values: string[]) => void
  align?: 'start' | 'center' | 'end'
  // Set on a dark table header — the funnel's own colours invert, or the
  // active (filled navy) state would vanish into a navy header.
  onDark?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [staged, setStaged] = useState<Set<string>>(new Set(value))
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    // Opening with no filter set means everything is on — show it that way
    // rather than as an empty list, which reads as "nothing selected".
    setStaged(new Set(value.length ? value : options.map((o) => o.value)))
    setQuery('')
    // Let the popover mount before focusing, or the caret lands nowhere.
    const t = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // A selection covering everything means "no filter" — stored as empty so the
  // funnel reads unfiltered and the row predicate can skip the check entirely.
  const active = value.length > 0 && value.length < options.length

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  const allShownTicked = shown.length > 0 && shown.every((o) => staged.has(o.value))

  // One place that both records the tick and pushes it out, so the table can
  // never be showing something different from what the boxes say. A selection
  // covering every value is stored as empty — that is the "no filter" form the
  // row predicate and the funnel icon both read.
  function commit(next: Set<string>): void {
    setStaged(next)
    onApply(next.size >= options.length ? [] : Array.from(next))
  }

  function toggle(v: string): void {
    const next = new Set(staged)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    commit(next)
  }

  // (Select All) acts on the searched subset, like Excel — and doubles as
  // "unselect these" once they're all already ticked.
  function toggleAllShown(): void {
    const next = new Set(staged)
    if (allShownTicked) for (const o of shown) next.delete(o.value)
    else for (const o of shown) next.add(o.value)
    commit(next)
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
              onDark
                ? active
                  ? 'bg-white text-[#1a2c56]'
                  : 'text-white/60 hover:bg-white/20 hover:text-white'
                : active
                  ? 'bg-[#1a2c56] text-white'
                  : 'text-muted-foreground/50 hover:bg-muted hover:text-foreground'
            )}
          >
            <Filter className={cn('h-3 w-3', active && 'fill-current')} />
          </button>
        </PopoverTrigger>
        <PopoverContent align={align} className={FILTER_PANEL_CLASS}>
          <FilterPanelHeader label={label} onClose={() => setOpen(false)} />
          <FilterPanelSearch inputRef={searchRef} value={query} onChange={setQuery} />
          <div className="max-h-60 overflow-y-auto">
            {options.length === 0 ? (
              <FilterPanelEmpty>No values.</FilterPanelEmpty>
            ) : (
              <>
                <FilterPanelSectionLabel>
                  {query.trim() ? 'Search results' : 'All values'}
                </FilterPanelSectionLabel>
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
                      checked={staged.has(o.value)}
                      label={o.label}
                      count={o.count}
                      onClick={() => toggle(o.value)}
                    />
                  ))
                )}
              </>
            )}
          </div>
          {/* One clearing action, not two: an empty selection is stored as
              "no filter" (the convention every caller's row predicate reads),
              so unticking everything and ticking everything land in the same
              place. To narrow to a few values, search and use Select all on
              the results, the way Excel does. */}
          <FilterPanelFooter
            onClear={() => commit(new Set(options.map((o) => o.value)))}
            clearDisabled={!active}
            onDone={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </span>
  )
}
