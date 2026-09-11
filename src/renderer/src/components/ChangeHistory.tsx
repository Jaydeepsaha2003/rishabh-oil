import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// WHAT CHANGED ON THIS RECORD, in the record's own panel.
//
// A trail kept in a table nobody opens answers nothing. The question — "who
// moved this rate, and what was it before?" — is asked while looking at the
// record, so the answer belongs there: one line per field that moved, the pair
// of values, and the name against it.
export function ChangeHistory({
  entity,
  id,
  className
}: {
  entity: 'orders' | 'bargains'
  id: number | null | undefined
  className?: string
}): React.JSX.Element | null {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!id) {
      setRows([])
      return
    }
    let live = true
    setLoading(true)
    void window.api.history
      .list(entity, Number(id))
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [entity, id])

  // Nothing to show on a record being created — it has no history yet, and an
  // empty card on a new form is a question nobody asked.
  if (!id) return null

  // A stamp is stored in UTC; the date is what anyone reads off it.
  const when = (v: unknown): string => {
    const s = String(v || '')
    return s ? `${formatDate(s.slice(0, 10))} ${s.slice(11, 16)}` : '—'
  }

  return (
    <div className={cn('overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white', className)}>
      <div className="flex items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-3">
        <History className="h-[17px] w-[17px] text-[#33473E]" />
        <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">History</span>
        <span className="doc-ref ml-auto rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-bold text-[#5A6B62]">
          {loading ? '…' : rows.length}
        </span>
      </div>
      {!loading && rows.length === 0 ? (
        <div className="px-4 py-5 text-center text-[12px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
          Nothing has been changed since this was entered.
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto">
          {rows.map((r) => (
            <div key={String(r.id)} className="border-b border-b-[#EFF3EE] px-4 py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
                {r.field ? (
                  <>
                    <span className="font-bold text-[#33473E]">{String(r.label || r.field)}</span>
                    <span className="doc-ref font-semibold text-[#8C2F26] line-through">{String(r.old_value ?? '—')}</span>
                    <span className="text-[#5A6B62]">→</span>
                    <span className="doc-ref font-bold text-[#0B6B45]">{String(r.new_value ?? '—')}</span>
                  </>
                ) : (
                  <span className="font-bold uppercase tracking-[.06em] text-[#33473E]">{String(r.action || 'changed')}</span>
                )}
                <span className="ml-auto whitespace-nowrap text-[11px] font-semibold text-[#5A6B62]">
                  {String(r.changed_by_name || 'system')} · {when(r.changed_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
