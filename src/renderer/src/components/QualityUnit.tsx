// What a lab reading is measured in, picked on the reading itself.
// -----------------------------------------------------------------------------
// The readings desk used to print a fixed "%" beside every value and carry a
// footnote apologising for it — "melting point is in degrees, so read that one
// as the figure the lab gave". A note asking the reader to disregard what the
// screen says is not a unit; it is the absence of one.
//
// A tanker's readings are three different kinds of quantity and the mill named
// all three: some in %, some in a unit, some a bare figure. So the suffix slot
// becomes a button — it shows what this reading is in, and opens the list.
import React, { useState } from 'react'
import { Hash } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { QUALITY_UNITS } from '@/lib/qualityUnits'

export function QualityUnit({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const cur = String(value ?? '')
  const known = QUALITY_UNITS.some((u) => u.v === cur)

  const pick = (v: string): void => {
    onChange(v)
    setCustom('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={cur ? `Measured in ${cur} — click to change` : 'A figure with no unit — click to change'}
          aria-label="Unit for this reading"
          className={cn(
            'absolute right-1 top-1/2 flex h-7 min-w-[28px] max-w-[74px] -translate-y-1/2 cursor-pointer items-center justify-center rounded px-1.5 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
            __WEB__ && '!h-[30px] !rounded-[3px] !text-[12px] !font-bold !text-[#5A6B62] hover:!bg-[#EAF0E9] hover:!text-[#0A1F17]'
          )}
        >
          {/* A bare figure has nothing to print, so it gets the icon instead —
              which also keeps the button findable when there is no unit set. */}
          {cur ? <span className="truncate">{cur}</span> : <Hash className="h-3.5 w-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn('w-52 p-1', __WEB__ && '!w-[212px] !rounded-[4px] !border-[#D6E2D6] !p-[5px]')}
      >
        <p
          className={cn(
            'px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
            __WEB__ && '!px-[7px] !pb-[5px] !text-[9.5px] !font-extrabold !tracking-[0.1em] !text-[#7C9188]'
          )}
        >
          Measured in
        </p>
        {QUALITY_UNITS.map((u) => (
          <button
            key={u.v || 'none'}
            type="button"
            onClick={() => pick(u.v)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-[6px] text-left text-[12.5px] hover:bg-accent',
              __WEB__ && '!rounded-[3px] !px-[7px] hover:!bg-[#EAF0E9]',
              cur === u.v && (__WEB__ ? '!bg-[#EAF0E9] !text-[#0A1F17]' : 'bg-accent')
            )}
          >
            <span className={cn('w-[62px] shrink-0 font-bold', __WEB__ && '!text-[#0A1F17]')}>{u.label}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{u.hint}</span>
          </button>
        ))}
        {/* Anything the list does not carry. Kept out of the list itself so
            six options stay six options. */}
        <div className={cn('mt-1 flex items-center gap-1.5 border-t px-1 pt-1.5', __WEB__ && '!border-t-[#E4ECE3]')}>
          <Input
            value={custom || (known ? '' : cur)}
            placeholder="Other…"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                pick(custom.trim())
              }
            }}
            className={cn('h-8 text-[12.5px]', __WEB__ && '!h-[32px] !rounded-[3px]')}
          />
          <button
            type="button"
            disabled={!custom.trim()}
            onClick={() => pick(custom.trim())}
            className={cn(
              'h-8 shrink-0 cursor-pointer rounded-md px-2.5 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40',
              __WEB__ ? '!h-[32px] !rounded-[3px] !bg-[#0B3D2E]' : 'bg-primary'
            )}
          >
            Use
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
