import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { FyPicker } from '@/components/FyPicker'
import { useGlobalDateRange, useSetGlobalDateRange } from '@/lib/globalDateRange'

// Human label for each page key, just for this dialog's own "Apply to this
// page only" button — keeps the wording readable without importing the whole
// Sidebar module just for its ITEMS map.
const PAGE_LABEL: Record<string, string> = {
  bargains: 'Purchase Bargain',
  orders: 'Purchases',
  consignment: 'Consignment',
  gateEntry: 'Gate Entry',
  trading: 'Trading',
  accounts: 'Accounts',
  stock: 'Stock',
  sales: 'Sales',
  salesBargains: 'Sales Bargain'
}
// Only pages with their own date-range filter can sensibly take a page-only
// apply — showing the button elsewhere would just do nothing when clicked.
const RANGE_AWARE_PAGES = new Set(Object.keys(PAGE_LABEL))

// Alt+F2 — Tally's period-change shortcut. Pick a range here and either every
// page's own date filter switches to it at once, or (if you only need it for
// what's open right now) just this one page does.
export function GlobalDateRangeDialog({
  open,
  onOpenChange,
  currentPage
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPage?: string
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
  const canApplyToPage = !!currentPage && RANGE_AWARE_PAGES.has(currentPage)
  const pageLabel = currentPage ? PAGE_LABEL[currentPage] || currentPage : ''

  function apply(scope: 'all' | 'page'): void {
    if (invalidRange) return
    setGlobalRange(from, to, scope, scope === 'page' ? currentPage : undefined)
    onOpenChange(false)
  }

  function clear(): void {
    setFrom('')
    setTo('')
    setGlobalRange('', '', 'all')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change period (Alt+F2)</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-[12px] text-muted-foreground">
            Apply everywhere to switch every screen that filters by date — registers, ledgers, trial balance, stock
            reports and more.
            {canApplyToPage && ` Apply to just this page for a one-off look at ${pageLabel} without disturbing anywhere else.`}
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Financial year</Label>
              <FyPicker from={from} to={to} onRange={(f, t) => { setFrom(f); setTo(t) }} className="h-9 w-full text-xs" />
            </div>
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
        <DialogFooter className="flex-wrap justify-end gap-2 space-x-0 sm:justify-between">
          <Button variant="outline" onClick={clear}>Clear period</Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            {canApplyToPage && (
              <Button variant="outline" onClick={() => apply('page')} disabled={invalidRange}>
                Apply to this page only
              </Button>
            )}
            <Button onClick={() => apply('all')} disabled={invalidRange}>Apply everywhere</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
