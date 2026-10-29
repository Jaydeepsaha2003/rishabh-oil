import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger

// WHERE THE PANEL IS RENDERED, not just where it is drawn.
//
// It portals to the body, which is right almost everywhere and wrong inside a
// modal dialog: a dialog traps focus to its own subtree, so a panel outside it
// has focus pulled back the instant it takes it — the box opens and cannot be
// typed into. Handing it the dialog element puts it inside that subtree and
// the trap leaves it alone.
//
// This is not the textbook fix. Radix's own answer is a modal popover, whose
// focus scope pauses the dialog's — but only when both come from the SAME copy
// of @radix-ui/react-focus-scope, and this tree has two (react-dialog takes the
// hoisted 1.1.9, react-popover carries its own 1.1.0). Two copies are two
// module-level scope stacks that cannot see each other, so neither pauses the
// other and `modal` does nothing at all. Measured, not guessed.
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    container?: HTMLElement | null
  }
>(({ className, align = 'start', sideOffset = 4, container, ...props }, ref) => (
  <PopoverPrimitive.Portal container={container ?? undefined}>
    <PopoverPrimitive.Content
      data-escape-layer="popover"
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // Above any dialog it opens from (some sit at z-60, e.g. the sale TDS one).
        'z-[70] w-72 max-w-[95vw] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent }
