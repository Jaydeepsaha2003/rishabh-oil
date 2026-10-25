import { useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'

// A dropdown you can type into — the browser's <select> with a search box, for
// long lists like the bank ledgers. Inside a dialog the list is drawn inside it
// so the dialog's focus trap does not swallow the search box (see
// TallyLedgerPickers.tsx).
const dialogOf = (el: HTMLElement | null): HTMLElement | null => (el?.closest('[role="dialog"]') as HTMLElement) || null

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = 'Pick…',
  disabled,
  className,
  title
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          disabled={disabled}
          title={title}
          className={cn(
            'flex h-9 min-w-0 items-center gap-2 rounded-[3px] border border-[#C3D2C6] bg-white px-2 text-left text-[13px] font-semibold normal-case tracking-normal text-[#0A1F17] disabled:opacity-60',
            className
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-[#8CA396]')}>{value || placeholder}</span>
          <ChevronDown className="h-4 w-4 flex-none text-[#5A6B62]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" container={dialogOf(trigger.current)} className="w-[--radix-popover-trigger-width] min-w-[260px] p-0">
        <Command>
          <CommandInput placeholder="Type to search…" />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>Nothing matches</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o}
                value={o}
                onSelect={() => {
                  setOpen(false)
                  onChange(o)
                }}
                className="gap-2"
              >
                <Check className={cn('h-3.5 w-3.5 flex-none', o === value ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate text-[13px] font-semibold">{o}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
