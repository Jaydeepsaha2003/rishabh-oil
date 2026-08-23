import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Filter } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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
  options: { value: string; label: string }[]
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
        <PopoverContent align={align} className="w-60 p-0">
          <div className="border-b p-1.5">
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="h-7 text-[11px] font-normal normal-case tracking-normal"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">No values.</div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleAllShown}
                  disabled={shown.length === 0}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] font-medium normal-case tracking-normal disabled:opacity-40',
                    'hover:bg-accent/60'
                  )}
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                      allShownTicked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                    )}
                  >
                    {allShownTicked && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    (Select All{query.trim() ? ' — search results' : ''})
                  </span>
                </button>
                {shown.length === 0 ? (
                  <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    Nothing matches &ldquo;{query.trim()}&rdquo;.
                  </div>
                ) : (
                  shown.map((o) => {
                    const checked = staged.has(o.value)
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => toggle(o.value)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] font-normal normal-case tracking-normal',
                          checked ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                          )}
                        >
                          {checked && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={o.label}>{o.label}</span>
                      </button>
                    )
                  })
                )}
              </>
            )}
          </div>
          <div className="flex items-center justify-between gap-1 border-t p-1.5">
            {/* One action, not two: an empty selection is stored as "no
                filter" (that is the convention every caller's row predicate
                reads), so unticking everything and ticking everything land in
                the same place. Offering both would show two buttons with one
                effect. To narrow to a few values, search and use (Select All)
                on the results, the way Excel does. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px] font-normal normal-case tracking-normal"
              title="Show every value in this column again"
              disabled={!active}
              onClick={() => commit(new Set(options.map((o) => o.value)))}
            >
              Clear filter
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] font-normal normal-case tracking-normal"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
