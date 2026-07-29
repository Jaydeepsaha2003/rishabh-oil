import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// Page size used everywhere unless a page asks for something else.
export const PAGE_SIZE = 10

// Slice a list into pages. The page resets to 1 whenever the list changes
// length (a filter was applied, rows were added) and is clamped so deleting the
// last row of the last page cannot leave the view empty.
export function usePaged<T>(rows: T[], size = PAGE_SIZE): {
  page: number
  setPage: (p: number) => void
  pageCount: number
  pageRows: T[]
  from: number
  to: number
  total: number
} {
  const [page, setPage] = useState(1)
  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  useEffect(() => {
    setPage(1)
  }, [total])
  const current = Math.min(page, pageCount)
  const pageRows = useMemo(() => rows.slice((current - 1) * size, current * size), [rows, current, size])
  return {
    page: current,
    setPage,
    pageCount,
    pageRows,
    from: total === 0 ? 0 : (current - 1) * size + 1,
    to: Math.min(current * size, total),
    total
  }
}

// Page numbers with ellipses: 1 … 4 5 [6] 7 8 … 20.
function pageList(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(pageCount - 1, page + 1)
  if (from > 2) out.push('…')
  for (let i = from; i <= to; i++) out.push(i)
  if (to < pageCount - 1) out.push('…')
  out.push(pageCount)
  return out
}

// The footer under a list: what is being shown, and the page numbers to move
// between. Hidden entirely when everything fits on one page.
export function Pagination({
  page,
  pageCount,
  setPage,
  from,
  to,
  total,
  label = 'entries',
  className
}: {
  page: number
  pageCount: number
  setPage: (p: number) => void
  from: number
  to: number
  total: number
  label?: string
  className?: string
}): React.JSX.Element | null {
  if (pageCount <= 1) return null
  const btn =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-xs font-medium transition disabled:opacity-40'
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 px-1 py-2', className)}>
      <span className="text-[11px] text-muted-foreground">
        Showing <b className="tabular-nums">{from}</b>–<b className="tabular-nums">{to}</b> of{' '}
        <b className="tabular-nums">{total}</b> {label}
      </span>
      <div className="flex items-center gap-1">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage(page - 1)} title="Previous">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pageList(page, pageCount).map((p, i) =>
          p === '…' ? (
            <span key={`gap${i}`} className="px-1 text-xs text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => setPage(p)}
              className={cn(
                btn,
                p === page
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {p}
            </button>
          )
        )}
        <button
          type="button"
          className={btn}
          disabled={page >= pageCount}
          onClick={() => setPage(page + 1)}
          title="Next"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
