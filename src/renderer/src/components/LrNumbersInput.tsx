import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// SEVERAL LORRY RECEIPTS ON ONE TANKER. A lorry billed on two invoices often
// travels on two LRs, one per invoice. They are kept on the tanker as one
// comma-separated value ("LR 101, LR 102"), so every place that shows or
// exports the LR number shows them all with no change.
const splitLr = (v: string): string[] =>
  String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
const joinLr = (xs: string[]): string =>
  xs
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ')

export function LrNumbersInput({
  value,
  onChange,
  className,
  placeholder = 'Lorry receipt number'
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}): React.JSX.Element {
  const [rows, setRows] = useState<string[]>(() => {
    const xs = splitLr(value)
    return xs.length ? xs : ['']
  })
  // A value set from outside (the dialog reopened on another tanker) replaces
  // the rows; one this component just emitted does not.
  useEffect(() => {
    if (joinLr(rows) === joinLr(splitLr(value))) return
    const xs = splitLr(value)
    setRows(xs.length ? xs : [''])
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: string[]): void => {
    setRows(next)
    onChange(joinLr(next))
  }
  return (
    <div className={cn('grid gap-1.5', className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={r}
            aria-label={`LR no. ${i + 1}`}
            placeholder={i === 0 ? placeholder : 'Another LR number'}
            // A comma would split one number into two when it is read back.
            onChange={(e) => set(rows.map((x, j) => (j === i ? e.target.value.replace(/,/g, '') : x)))}
          />
          {rows.length > 1 && (
            <button
              type="button"
              title="Remove this LR"
              onClick={() => set(rows.filter((_, j) => j !== i))}
              className="flex h-9 w-8 flex-none items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="!h-8 w-fit !px-3 !text-[12px] !font-bold"
        onClick={() => setRows((p) => [...p, ''])}
      >
        <Plus className="h-4 w-4" /> Add another LR
      </Button>
    </div>
  )
}
