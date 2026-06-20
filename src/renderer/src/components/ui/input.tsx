import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, onChange, ...props }, ref) => {
    // Business text fields are auto-uppercased as you type (skips number, date,
    // password, etc.). Credential screens use a raw <input>, so they're exempt.
    const autoUpper = type === undefined || type === 'text'
    const handleChange =
      autoUpper && onChange
        ? (e: React.ChangeEvent<HTMLInputElement>) => {
            const upper = e.target.value.toUpperCase()
            if (upper !== e.target.value) e.target.value = upper
            onChange(e)
          }
        : onChange
    return (
      <input
        type={type}
        onChange={handleChange}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
