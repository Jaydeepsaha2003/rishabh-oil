import * as React from 'react'
import { createPortal } from 'react-dom'
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

type ItemDef = { value: string; label: React.ReactNode; text: string; disabled?: boolean; title?: string }

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
        text: textOf(el.props.children),
        disabled: !!el.props.disabled,
        title: el.props.title
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
  // Show the search box. Defaults to auto: only when the list is long enough to
  // warrant it (short lists like a status/type picker don't need a search box).
  searchable?: boolean
  // Off by default — almost every use of this component is a data-entry field
  // (pick one supplier/product/customer/etc. to save into a record), where a
  // persistent checkbox square wrongly implies multi-select. Only the handful
  // of genuine list-narrowing FILTER dropdowns opt in — everything else falls
  // back to a plain checkmark that only shows on the selected row.
  showCheckbox?: boolean
  // Multi-select: the values currently ticked. Supplying this turns the list
  // into checkboxes that reflect membership, and the panel STAYS OPEN as each
  // one is picked — closing after every tick would make choosing three
  // invoices three separate trips through the dropdown.
  selected?: string[]
}

function Select({ value, onValueChange, disabled, children, searchable, showCheckbox = false, selected }: SelectProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [highlight, setHighlight] = React.useState(0)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Inside a dialog, the panel is PORTALED into the dialog content element:
  // it stays within the Radix focus trap (portaling to <body> broke typing in
  // the packaged app) but escapes the dialog's scrollable body, which clipped
  // inline panels. It flips upward when there's more room above the trigger.
  const [portal, setPortal] = React.useState<{ target: HTMLElement; style: React.CSSProperties; listMaxH: number } | null>(null)
  // A field on a plain page (not a dialog) has no focus trap to protect, so
  // the panel stays inline — but it still needs to know whether it fits below
  // the trigger. A grid of fields near the bottom of the screen (the last row
  // of a Gate In / Gate Out form, say) would otherwise always drop the list
  // downward regardless of room, running it off the window or straight over
  // the button underneath it — the exact "one field covering another" this
  // guards against.
  const [inlineFlip, setInlineFlip] = React.useState<{ openUp: boolean; maxH: number } | null>(null)

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
  const showSearch = searchable ?? items.length > 8

  const toggle = React.useCallback(() => {
    if (!disabled) setOpen((o) => !o)
  }, [disabled])

  // Compute where the panel fits — against the dialog when inside one,
  // against the viewport otherwise — and keep it current for as long as the
  // field stays open, not just at the instant it opened. A grid reflows on
  // resize and the page scrolls under an open dropdown; without recomputing,
  // a panel that fit when opened could end up hanging off the window or
  // sitting on top of the next field the moment either changes.
  React.useLayoutEffect(() => {
    if (!open) {
      setPortal(null)
      setInlineFlip(null)
      return
    }
    const recompute = (): void => {
      const wrap = wrapRef.current
      if (!wrap) return
      const dialog = wrap.closest('[role="dialog"]') as HTMLElement | null
      const t = wrap.getBoundingClientRect()
      if (dialog) {
        const c = dialog.getBoundingClientRect()
        const spaceBelow = c.bottom - t.bottom
        const spaceAbove = t.top - c.top
        const openUp = spaceBelow < 240 && spaceAbove > spaceBelow
        const listMaxH = Math.max(120, Math.min(320, (openUp ? spaceAbove : spaceBelow) - 12))
        setInlineFlip(null)
        setPortal({
          target: dialog,
          listMaxH,
          style: {
            position: 'absolute',
            left: t.left - c.left + dialog.scrollLeft,
            // The panel is at LEAST as wide as the trigger, but free to grow to
            // its longest entry — pinned to the trigger's width, a 208px picker
            // wrapped "VANIK FINANCE PRIVATE LIMITED" onto two lines. Capped to
            // the room actually left to the right of the trigger.
            minWidth: t.width,
            maxWidth: Math.max(t.width, c.width - (t.left - c.left) - 8),
            ...(openUp
              ? { top: t.top - c.top + dialog.scrollTop - 4, transform: 'translateY(-100%)' }
              : { top: t.bottom - c.top + dialog.scrollTop + 4 })
          }
        })
        return
      }
      // A plain page has no dialog boundary to portal against, so the panel
      // stays inline (positioned relative to its own trigger via CSS) — it
      // only needs to know whether to drop down or flip up, and how tall it
      // can be either way, measured against the actual window.
      setPortal(null)
      const spaceBelow = window.innerHeight - t.bottom
      const spaceAbove = t.top
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow
      const maxH = Math.max(120, Math.min(320, (openUp ? spaceAbove : spaceBelow) - 12))
      setInlineFlip({ openUp, maxH })
    }
    recompute()
    // Capture-phase so a scroll on any inner container (not just the window)
    // still triggers a recompute.
    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
    }
  }, [open])

  // Close when clicking anywhere outside this dropdown (trigger OR panel —
  // the panel may live in a portal outside the trigger's subtree).
  React.useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const n = e.target as Node
      if (wrapRef.current?.contains(n)) return
      if (panelRef.current?.contains(n)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Reset the query and focus the search box each time it opens.
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    if (!showSearch) return
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open, showSearch])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? items.filter((it) => `${it.text} ${it.value}`.toLowerCase().includes(q))
    : items

  // In multi-select the tick is a toggle, so the panel stays put; a single
  // select closes as it always did.
  const multi = Array.isArray(selected)
  function choose(v: string): void {
    onValueChange?.(v)
    if (!multi) setOpen(false)
  }
  const isOn = (v: string): boolean => (multi ? (selected as string[]).includes(v) : current === v)

  // The arrows step OVER a disabled option and Enter never lands on one, so the
  // keyboard cannot reach what the mouse cannot click.
  function nextEnabled(from: number, step: 1 | -1): number {
    for (let i = from; i >= 0 && i < filtered.length; i += step) {
      if (!filtered[i]?.disabled) return i
    }
    return from
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => nextEnabled(Math.min(h + 1, filtered.length - 1), 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => nextEnabled(Math.max(h - 1, 0), -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const at = filtered[highlight]
      const pick = at && !at.disabled ? at : filtered[nextEnabled(0, 1)]
      if (pick && !pick.disabled) choose(pick.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  const panelEl = open ? (
    <div
      ref={panelRef}
      style={portal?.style}
      className={cn(
        'overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md uppercase',
        portal
          ? 'z-[70]'
          : inlineFlip?.openUp
            ? 'absolute left-0 bottom-full z-50 mb-1 w-max min-w-full max-w-[min(26rem,90vw)]'
            : 'absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-[min(26rem,90vw)]'
      )}
    >
      {showSearch && (
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
      )}
      {/* The caller's className (e.g. a max-h-* cap) belongs on the scrollable
          list itself, not the outer panel — putting it on the outer box left
          it with no overflow control of its own, so a tall list could spill
          out past the box instead of scrolling inside it. */}
      <div
        className={cn('max-h-[min(16rem,50vh)] overflow-y-auto p-1', contentClassName)}
        style={
          portal
            ? { maxHeight: Math.max(96, portal.listMaxH - (showSearch ? 45 : 0)) }
            : inlineFlip
              ? { maxHeight: Math.max(96, inlineFlip.maxH - (showSearch ? 45 : 0)) }
              : undefined
        }
      >
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No results.</div>
        ) : (
          filtered.map((it, i) => (
            <button
              key={it.value}
              type="button"
              disabled={it.disabled}
              title={it.title}
              onClick={() => !it.disabled && choose(it.value)}
              onMouseEnter={() => !it.disabled && setHighlight(i)}
              className={cn(
                'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm',
                it.disabled
                  ? 'cursor-not-allowed opacity-45'
                  : i === highlight
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60'
              )}
            >
              {showCheckbox || multi ? (
                // A real checkbox has to LOOK like one before it is ticked, or
                // nobody knows the list takes more than one answer. At 16px
                // with a hairline border at 40% it was there and unreadable —
                // 18px, a 2px border and a white ground make it a box on the
                // row, and the tick is drawn heavy enough to read at this size.
                <span
                  className={cn(
                    'mr-2.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors',
                    isOn(it.value)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-slate-400 bg-white'
                  )}
                >
                  {isOn(it.value) && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
              ) : (
                <Check className={cn('mr-2 h-4 w-4 shrink-0', isOn(it.value) ? 'opacity-100' : 'opacity-0')} />
              )}
              <span className="min-w-0 flex-1 truncate" title={it.text || undefined}>{it.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  ) : null

  return (
    <SelectContext.Provider value={{ value: current, items, disabled, open, toggle }}>
      <div ref={wrapRef} className="relative">
        {trigger}
        {portal ? createPortal(panelEl, portal.target) : panelEl}
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
        'flex h-9 w-full min-w-0 items-center justify-between gap-1 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm uppercase shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate',
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
    </button>
  )
})
SelectTrigger.displayName = 'SelectTrigger'

// Children override what the closed field shows for the selected item — used
// where the list entry is a long descriptive line but the field must stay
// short (e.g. a bargain number instead of its whole summary).
function SelectValue({
  placeholder,
  children
}: {
  placeholder?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { value, items } = React.useContext(SelectContext)
  const current = items.find((i) => i.value === value)
  if (children != null && value) return <>{children}</>
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
  // Listed but not choosable — used where an option exists in a master yet has
  // nothing behind it to pick, so the reason is on screen rather than the
  // option silently disappearing.
  disabled?: boolean
  title?: string
}): React.JSX.Element | null {
  return null
}

// Kept for API compatibility (unused).
const SelectGroup = ({ children }: { children?: React.ReactNode }): React.JSX.Element => <>{children}</>

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem }
