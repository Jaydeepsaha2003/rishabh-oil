import * as React from 'react'
import { format, isValid, parse } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import type { Matcher } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface Props {
  value?: string // ISO yyyy-mm-dd
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  min?: string // ISO — dates before this are disabled
  max?: string // ISO — dates after this are disabled
  className?: string
}

function toDate(iso?: string): Date | undefined {
  if (!iso) return undefined
  const d = parse(String(iso).slice(0, 10), 'yyyy-MM-dd', new Date())
  return isValid(d) ? d : undefined
}

// Date picker that displays DD-MM-YYYY but stores an ISO (yyyy-mm-dd) string,
// so it's a drop-in replacement for <input type="date">.
export function DatePicker({
  value,
  onChange,
  placeholder = 'DD-MM-YYYY',
  disabled,
  min,
  max,
  className
}: Props): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const selected = toDate(value)

  // Build one matcher per defined bound — a combined {before, after} object with
  // an undefined side is treated as a (broken) interval and silently matches nothing.
  const matchers: Matcher[] = []
  const minDate = toDate(min)
  const maxDate = toDate(max)
  if (minDate) matchers.push({ before: minDate })
  if (maxDate) matchers.push({ after: maxDate })

  return (
    // modal — otherwise the calendar is mouse-dead inside modal dialogs
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-9 w-full justify-start text-left font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0 opacity-70" />
          {selected ? format(selected, 'dd-MM-yyyy') : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => {
            if (d) onChange(format(d, 'yyyy-MM-dd'))
            setOpen(false)
          }}
          disabled={matchers.length ? matchers : undefined}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}
