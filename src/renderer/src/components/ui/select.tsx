import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'

// Drop-in replacement for the shadcn/Radix Select, but every dropdown is now
// searchable. The SAME API is kept — <Select value onValueChange>, SelectTrigger,
// SelectValue, SelectContent, SelectItem — so no call sites need to change.
// SelectContent/SelectItem are declarative: <Select> reads them to build the list.

type ItemDef = { value: string; label: React.ReactNode; text: string }

interface Ctx {
  value: string
  items: ItemDef[]
  disabled?: boolean
}
const SelectContext = React.createContext<Ctx>({ value: '', items: [] })

function textOf(node: React.ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ''
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectItems(node: React.ReactNode, out: ItemDef[]): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = child as React.ReactElement<any>
    if (el.type === SelectItem) {
      out.push({
        value: String(el.props.value),
        label: el.props.children,
        text: textOf(el.props.children)
      })
    } else if (el.props && el.props.children) {
      collectItems(el.props.children, out)
    }
  })
}

interface SelectProps {
  value?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  children?: React.ReactNode
}

function Select({ value, onValueChange, disabled, children }: SelectProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  let trigger: React.ReactNode = null
  let contentChildren: React.ReactNode = null
  let contentClassName: string | undefined

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = child as React.ReactElement<any>
    if (el.type === SelectContent) {
      contentChildren = el.props.children
      contentClassName = el.props.className
    } else {
      trigger = child
    }
  })

  const items: ItemDef[] = []
  collectItems(contentChildren, items)
  const current = String(value ?? '')

  return (
    <SelectContext.Provider value={{ value: current, items, disabled }}>
      <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
        {trigger}
        <PopoverContent
          align="start"
          className={cn('w-[var(--radix-popover-trigger-width)] min-w-[10rem] p-0 uppercase', contentClassName)}
        >
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              {items.map((it) => (
                <CommandItem
                  key={it.value}
                  value={`${it.text} ${it.value}`}
                  onSelect={() => {
                    onValueChange?.(it.value)
                    setOpen(false)
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', current === it.value ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1">{it.label}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </SelectContext.Provider>
  )
}

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, children, ...props }, ref) => {
  const { disabled } = React.useContext(SelectContext)
  return (
    <PopoverTrigger asChild>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={cn(
          'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm uppercase shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
          className
        )}
        {...props}
      >
        {children}
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>
    </PopoverTrigger>
  )
})
SelectTrigger.displayName = 'SelectTrigger'

function SelectValue({ placeholder }: { placeholder?: string }): React.JSX.Element {
  const { value, items } = React.useContext(SelectContext)
  const current = items.find((i) => i.value === value)
  if (current) return <span>{current.label}</span>
  return <span className="text-muted-foreground">{placeholder}</span>
}

// Declarative markers — parsed by <Select>, never rendered directly.
function SelectContent(_props: {
  children?: React.ReactNode
  className?: string
}): React.JSX.Element | null {
  return null
}

function SelectItem(_props: {
  value: string
  children?: React.ReactNode
  className?: string
}): React.JSX.Element | null {
  return null
}

// Kept for API compatibility (unused).
const SelectGroup = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem }
