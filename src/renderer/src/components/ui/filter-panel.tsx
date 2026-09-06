import * as React from 'react'
import { Check, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// The one filter panel the whole app uses.
//
// There were two: the Excel-style funnel in table headers (ColumnFilter) and
// the standalone dropdown in filter bars (MultiSelectFilter). They did the
// same job — tick values, narrow a list — and looked nothing alike: different
// checkbox, different footer, different padding. Anything that has to stay
// identical across two files eventually stops being identical, so the chrome
// lives here and both import it.
//
// Only the CHROME is shared. Each component keeps its own selection rules:
// ColumnFilter stages a set and treats "everything ticked" as no filter, while
// MultiSelectFilter applies each tick as it happens. Those differences are
// deliberate and pre-date this file — folding them together would change what
// clicking a row does on every screen that uses them.

export const FILTER_PANEL_CLASS = 'w-[262px] overflow-hidden rounded-[4px] border-[#C3D2C6] p-0'

export function FilterPanelHeader({
  label,
  onClose
}: {
  label: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b-2 border-b-[#C7F03F] px-4 py-3">
      <span className="min-w-0 truncate text-[11px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">
        Filter {label}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close filter"
        className="shrink-0 text-[#8AA096] transition-colors hover:text-[#0A1F17]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export function FilterPanelSearch({
  inputRef,
  value,
  onChange,
  placeholder = 'Search values'
}: {
  inputRef?: React.Ref<HTMLInputElement>
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <div className="border-b border-[#EAF0E9] px-3.5 py-3">
      <div className="flex h-10 items-center gap-2 rounded-[4px] border border-[#C3D2C6] bg-white px-3">
        <Search className="h-4 w-4 shrink-0 text-[#8AA096]" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium normal-case tracking-normal text-[#0A1F17] outline-none placeholder:text-[#8AA096]"
        />
      </div>
    </div>
  )
}

export function FilterPanelSectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-4 pb-1 pt-2.5 text-[12px] font-medium normal-case tracking-normal text-[#7C9188]">{children}</div>
}

export function FilterPanelRow({
  checked,
  label,
  count,
  strong,
  disabled,
  onClick
}: {
  checked: boolean
  label: string
  // Omitted rather than zero when a caller has no per-value count to show —
  // an unexplained 0 beside a value reads as "no rows", which is never why
  // a value is on this list.
  count?: number
  strong?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-3 border-t border-[#F1F5EF] px-4 py-2 text-left normal-case tracking-normal transition-colors hover:bg-[#F7FAF6] disabled:cursor-not-allowed disabled:opacity-40',
        strong ? 'text-[13.5px] font-bold text-[#0A1F17]' : 'text-[13px] font-medium text-[#0A1F17]'
      )}
    >
      <span
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border transition-colors',
          checked ? 'border-[#0B3D2E] bg-[#0B3D2E] text-[#C7F03F]' : 'border-[#C3D2C6] bg-white'
        )}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {count !== undefined && (
        <span className="shrink-0 rounded-[2px] bg-[#EAF0E9] px-2 py-0.5 text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">
          {count}
        </span>
      )}
    </button>
  )
}

export function FilterPanelEmpty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-4 py-6 text-center text-[12.5px] font-medium normal-case tracking-normal text-[#7C9188]">{children}</div>
}

export function FilterPanelFooter({
  onClear,
  clearDisabled,
  onDone
}: {
  onClear: () => void
  clearDisabled?: boolean
  onDone: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[#EAF0E9] px-4 py-3">
      <button
        type="button"
        onClick={onClear}
        disabled={clearDisabled}
        title="Show every value again"
        className="text-[12px] font-extrabold uppercase tracking-[.06em] text-[#C0392B] transition-colors hover:text-[#96261A] disabled:cursor-not-allowed disabled:text-[#C3D2C6]"
      >
        Clear filter
      </button>
      <button
        type="button"
        onClick={onDone}
        className="h-9 rounded-[4px] border border-[#C3D2C6] px-4 text-[12.5px] font-extrabold text-[#0A1F17] transition-colors hover:bg-[#F7FAF6]"
      >
        Done
      </button>
    </div>
  )
}
