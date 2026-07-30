import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fyOptions } from '@/lib/fy'

// A compact FY quick-filter that drives an existing from/to date-range pair.
// It shows which FY the current range IS when it matches one exactly.
export function FyPicker({
  from,
  to,
  onRange,
  className
}: {
  from: string
  to: string
  onRange: (from: string, to: string) => void
  className?: string
}): React.JSX.Element {
  const options = fyOptions()
  const current = options.find((o) => o.from === from && o.to === to)?.label || ''
  return (
    <Select
      value={current || 'CUSTOM'}
      onValueChange={(v) => {
        const hit = options.find((o) => o.label === v)
        if (hit) onRange(hit.from, hit.to)
      }}
    >
      <SelectTrigger className={className || 'h-9 w-32 text-xs'}>
        <SelectValue placeholder="FY" />
      </SelectTrigger>
      <SelectContent>
        {!current && <SelectItem value="CUSTOM">Custom range</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.label} value={o.label}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
