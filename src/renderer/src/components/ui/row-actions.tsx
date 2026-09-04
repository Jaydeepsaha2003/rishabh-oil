import { useState } from 'react'
import { MoreVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface RowAction {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
  // Renders in destructive red, for a delete and the like.
  danger?: boolean
  // Shown greyed with the reason on hover instead of being hidden, so a row
  // never silently loses an action the user is looking for.
  disabled?: boolean
  disabledReason?: string
}

// The overflow menu behind a row's ⋮ — for the actions that don't need to be
// one click away (edit, delete, replace). The row's PRIMARY action stays
// outside as a real button; only the secondary ones live in here, so the
// column stays narrow without hiding what the user reaches for most.
export function RowActions({ actions, label = 'More actions' }: { actions: RowAction[]; label?: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const shown = actions.filter(Boolean)
  if (!shown.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            open && 'bg-accent text-foreground'
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      {/* Sized to its content rather than a fixed width — a label like
          "Undo — back to Outside factory" would otherwise be cut off. */}
      <PopoverContent align="end" className="w-auto min-w-[11rem] p-1.5">
        {shown.map((a) => {
          const Icon = a.icon
          return (
            <button
              key={a.label}
              type="button"
              disabled={a.disabled}
              title={a.disabled ? a.disabledReason : undefined}
              onClick={() => {
                setOpen(false)
                a.onClick()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-4 py-2 text-left text-sm transition-colors',
                a.disabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : a.danger
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'hover:bg-muted'
              )}
            >
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              <span className="whitespace-nowrap">{a.label}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
