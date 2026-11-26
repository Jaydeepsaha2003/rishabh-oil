import { useEffect, useState } from 'react'
import { Truck } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'

type Row = Record<string, unknown>
const n = (v: unknown): number => Number(v) || 0

/**
 * THE TRANSPORTER'S FREIGHT ON THIS INVOICE — which freight bill took it
 * (bill no., date, transporter, amount; click opens that bill's voucher, and
 * from there the bill itself), or what is still waiting for a bill.
 * Shown on the purchase and the sale invoice form.
 */
export function FreightBillsStrip({
  kind,
  ids,
  onOpenVoucher
}: {
  kind: 'order' | 'sale'
  ids: number[]
  onOpenVoucher?: (entryId: number, companyId?: number) => void
}): React.JSX.Element | null {
  const [rows, setRows] = useState<Row[] | null>(null)
  const key = ids.filter(Boolean).join(',')
  useEffect(() => {
    setRows(null)
    if (!key) return
    let live = true
    void window.api.transporterFreight
      .billsOf(kind, key.split(',').map(Number))
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]))
    return () => {
      live = false
    }
  }, [kind, key])
  if (!rows || !rows.length) return null
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
      <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Transporter freight</span>
      <div className="flex flex-wrap gap-2">
        {rows.map((b, i) =>
          b.bill_id ? (
            <button
              key={i}
              type="button"
              disabled={!onOpenVoucher || !n(b.journal_entry_id)}
              onClick={() => onOpenVoucher?.(n(b.journal_entry_id), n(b.company_id) || undefined)}
              title="Open this freight bill's voucher — and from there the bill itself"
              className="flex items-center gap-2 rounded-[6px] border border-[#C6DAF0] bg-[#F4F8FD] px-3 py-1.5 text-left text-[12px] font-semibold text-[#1B4E82] hover:bg-[#EAF0FA] disabled:cursor-default"
            >
              <Truck className="h-4 w-4 flex-none" />
              <span>
                <b>Freight bill {String(b.bill_no || '—')}</b>
                {b.bill_date ? ` · ${formatDate(String(b.bill_date).slice(0, 10))}` : ''} · {String(b.transporter_name || '')}
                {b.code ? ` · ${String(b.code)}` : ''}
              </span>
              <span className="font-bold tabular-nums">{formatINR(n(b.amount))}</span>
            </button>
          ) : (
            <span
              key={i}
              className="flex items-center gap-2 rounded-[6px] border border-[#F1D9A6] bg-[#FFF8E9] px-3 py-1.5 text-[12px] font-semibold text-[#8A5300]"
              title="Freight on this invoice that no transporter bill has taken yet — book it on Accounting → Fr. inward / outward working"
            >
              <Truck className="h-4 w-4 flex-none" />
              Not billed yet · {String(b.transporter_name || '')} <span className="font-bold tabular-nums">{formatINR(n(b.amount))}</span>
            </span>
          )
        )}
      </div>
    </div>
  )
}
