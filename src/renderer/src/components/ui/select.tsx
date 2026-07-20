import * as React from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

// A searchable dropdown with the SAME API as the shadcn/Radix Select
// (<Select value onValueChange>, SelectTrigger, SelectValue, SelectContent,
// SelectItem) so no call sites need to change. SelectContent/SelectItem are
// declarative markers that <Select> reads to build the list.
//
// It deliberately does NOT use a portaled Radix Popover: portaling the panel
// outside the dialog put the search box outside the dialog's focus trap, which
// stole focus and made typing impossible in the packaged app. Rendering the
// panel inline (inside the same DOM subtree as the trigger) keeps the input
// within the dialog's focus scope, so typing always works.

type ItemDef = { value: string; label: React.ReactNode; text: string }

interface Ctx {
  value: string
  items: ItemDef[]
  disabled?: boolean
  open: boolean
  toggle: () => void
}
const SelectContext = React.createContext<Ctx>({
  value: '',
  items: [],
  open: false,
  toggle: () => {}
})

function textOf(node: React.ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ''
}

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
  const [query, setQuery] = React.useState('')
  const [highlight, setHighlight] = React.useState(0)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

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

  const toggle = React.useCallback(() => {
    if (!disabled) setOpen((o) => !o)
  }, [disabled])

  // Close when clicking anywhere outside this dropdown.
  React.useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Reset the query and focus the search box each time it opens.
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? items.filter((it) => `${it.text} ${it.value}`.toLowerCase().includes(q))
    : items

  function choose(v: string): void {
    onValueChange?.(v)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = filtered[highlight] || filtered[0]
      if (pick) choose(pick.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <SelectContext.Provider value={{ value: current, items, disabled, open, toggle }}>
      <div ref={wrapRef} className="relative">
        {trigger}
        {open && (
          <div
            className={cn(
              'absolute left-0 top-full z-50 mt-1 w-full min-w-[10rem] rounded-md border bg-popover text-popover-foreground shadow-md uppercase',
              contentClassName
            )}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setHighlight(0)
                }}
                onKeyDown={onKeyDown}
                placeholder="Search…"
                className="h-10 w-full bg-transparent py-2 text-sm normal-case outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-[min(16rem,50vh)] overflow-y-auto p-1">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No results.</div>
              ) : (
                filtered.map((it, i) => (
                  <button
                    key={it.value}
                    type="button"
                    onClick={() => choose(it.value)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm',
                      i === highlight ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                    )}
                  >
                    <Check className={cn('mr-2 h-4 w-4 shrink-0', current === it.value ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex-1">{it.label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </SelectContext.Provider>
  )
}

const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, children, ...props }, ref) => {
  const { disabled, toggle } = React.useContext(SelectContext)
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={toggle}
      className={cn(
        'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm uppercase shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 opacity-50" />
    </button>
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
