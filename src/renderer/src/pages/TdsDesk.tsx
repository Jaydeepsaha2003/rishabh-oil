import { useCallback, useEffect, useMemo, useState } from 'react'
import { Percent, Search } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { SaleTdsDialog } from '@/components/SaleTdsDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE CUSTOMER-TDS DESK. What a user granted the 'tds' scope on Sales gets in
// place of the Sales page: the invoices whose customer deducts TDS and that
// have TDS due and no TDS journal yet, one row each — date, number, customer,
// taxable and the TDS due under the customer's slab — and a Book TDS button that opens
// the same dialog the Sales page uses. A booked invoice drops off the list.
// The rows come from the server already narrowed (listSalesForTdsDesk), and
// booking is the only write the gate lets through for this user.
export function TdsDesk(): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [book, setBook] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await window.api.sales.list())
    } catch {
      setRows([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLiveRefresh(load)

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (rows || []).filter((r) => !t || [r.invoice_no, r.customer, r.company_name].some((x) => String(x || '').toLowerCase().includes(t)))
  }, [rows, q])

  return (
    <>
      <PageHeader
        title="Customer TDS"
        subtitle="Invoices whose customer deducts TDS, with no TDS booked yet"
        hint="Book the TDS each customer deducted on its invoice. Booking posts a Journal — Dr the TDS ledger, Cr the customer — against the invoice, and the invoice leaves this list."
      />
      <div className="px-4 py-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search invoice or customer" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="text-[12.5px] font-semibold text-muted-foreground">
            {rows == null ? 'Loading…' : `${shown.length} invoice${shown.length === 1 ? '' : 's'} missing TDS`}
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="bg-[#0B3D2E] text-[10.5px] uppercase tracking-[.08em] text-[#B9D3C6]">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-right">Taxable</th>
                <th className="px-3 py-2 text-right">TDS due</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.company_id}|${r.invoice_key}`} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDate(String(r.sale_date))}</td>
                  <td className="px-3 py-2 font-semibold">
                    {String(r.invoice_no || '—')}
                    {r.company_name ? <div className="text-[11px] font-normal text-muted-foreground">{String(r.company_name)}</div> : null}
                  </td>
                  <td className="px-3 py-2">{String(r.customer || '—')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatINR(Number(r.taxable) || 0)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums" title={`${Number(r.tds_pct) || 0}% under the customer's slab`}>
                    {formatINR(Number(r.tds) || 0)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" className="h-8 gap-1" onClick={() => setBook(Number(r.id))}>
                      <Percent className="h-3.5 w-3.5" /> Book TDS
                    </Button>
                  </td>
                </tr>
              ))}
              {rows != null && shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                    {rows.length ? 'No invoice matches the search.' : 'Every invoice has its TDS booked.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <SaleTdsDialog saleId={book} onClose={() => setBook(null)} onDone={() => void load()} />
    </>
  )
}
