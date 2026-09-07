import * as React from 'react'
import * as SwitchPrimitives from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // Black on, white off.
      //
      // The border is the part that is easy to miss: a white track on a white
      // card is an invisible control, so OFF keeps a visible edge and ON takes
      // the track's own colour so the outline does not read as a second ring.
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#0A1F17] data-[state=checked]:bg-[#0A1F17] data-[state=unchecked]:border-[#C3D2C6] data-[state=unchecked]:bg-white',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        // The knob has to invert with the track, or OFF is a white thumb on
        // a white track — a control with nothing in it. White on black, grey
        // on white.
        'pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 data-[state=checked]:bg-white data-[state=unchecked]:bg-[#8FA79B]'
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
