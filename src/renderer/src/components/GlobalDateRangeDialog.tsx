import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { FyPicker } from '@/components/FyPicker'
import { useGlobalDateRange, useSetGlobalDateRange } from '@/lib/globalDateRange'

// Alt+F2 — Tally's period-change shortcut. Pick a range here and every page's
// own date filter (registers, ledgers, trial balance, stock reports, …)
// switches to it at once.
export function GlobalDateRangeDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const current = useGlobalDateRange()
  const setGlobalRange = useSetGlobalDateRange()
  const [from, setFrom] = useState(current.from)
  const [to, setTo] = useState(current.to)

  useEffect(() => {
    if (open) {
      setFrom(current.from)
      setTo(current.to)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const invalidRange = !!from && !!to && from > to

  function apply(): void {
    if (invalidRange) return
    setGlobalRange(from, to)
    onOpenChange(false)
  }

  function clear(): void {
    setFrom('')
    setTo('')
    setGlobalRange('', '')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change period (Alt+F2)</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-[12px] text-muted-foreground">
            This period applies across every screen that filters by date — registers, ledgers, trial balance, stock
            reports and more.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Financial year</Label>
            <FyPicker from={from} to={to} onRange={(f, t) => { setFrom(f); setTo(t) }} className="h-9 w-full text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>From</Label>
              <DatePicker value={from} onChange={(v) => setFrom(v || '')} max={to || undefined} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>To</Label>
              <DatePicker value={to} onChange={(v) => setTo(v || '')} min={from || undefined} />
            </div>
          </div>
          {invalidRange && (
            <p className="text-[12px] font-medium text-rose-600">The From date must be on or before the To date.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={clear}>Clear period</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={apply} disabled={invalidRange}>Apply everywhere</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
