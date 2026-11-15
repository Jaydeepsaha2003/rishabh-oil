import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { escToClose } from '@/lib/escape'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /**
     * A dialog that only shows something — a history, a breakdown — has no
     * draft to lose, so Escape and a click outside close it like any other
     * read-only overlay. Left off, the dialog keeps the draft-safe policy.
     */
    readOnly?: boolean
    /** For a dialog opened over something already layered high (a drawer). */
    overlayClassName?: string
  }
>(({ className, children, readOnly, overlayClassName, onInput, onKeyDown, ...props }, ref) => {
  // Typed into since it opened? Then Esc asks twice (escToClose) before it
  // discards; untouched, one Esc closes it like its ✕. The content mounts
  // afresh on every open, so this starts clean each time.
  const typed = React.useRef(false)
  return (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Content
      ref={ref}
      // Click-outside never closes a form (a stray click must not discard it);
      // a read-only dialog closes on either.
      onInteractOutside={readOnly ? undefined : (e) => e.preventDefault()}
      // ESC EVERYWHERE: every dialog closes on Esc like its ✕. A dialog that
      // must stay (saving, a must-read notice) passes its own onEscapeKeyDown.
      onEscapeKeyDown={readOnly ? undefined : (e) => escToClose(typed.current)(e)}
      onInput={(e) => {
        typed.current = true
        onInput?.(e)
      }}
      // ← → MOVE BETWEEN THE FOOTER'S BUTTONS (Keep editing ⇄ Discard), and
      // from the dialog itself or its ✕ onto them. Boxes and open lists keep
      // their own arrows.
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
        const t = e.target as HTMLElement
        if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[cmdk-root],[role="listbox"],[role="menu"],[role="radiogroup"],[role="tablist"]')) return
        const btns = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-dialog-footer] button')).filter(
          (b) => !b.hasAttribute('disabled') && b.offsetParent !== null
        )
        if (!btns.length) return
        const at = btns.indexOf(t)
        const fromOutside = at < 0 && (t === e.currentTarget || !!t.closest('[data-dialog-close]'))
        if (at < 0 && !fromOutside) return
        e.preventDefault()
        const fwd = e.key === 'ArrowRight'
        const next = at < 0 ? (fwd ? 0 : btns.length - 1) : (at + (fwd ? 1 : -1) + btns.length) % btns.length
        btns[next].focus()
      }}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg',
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close data-dialog-close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
  )
}
DialogHeader.displayName = 'DialogHeader'

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-dialog-footer
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  )
}
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
}
