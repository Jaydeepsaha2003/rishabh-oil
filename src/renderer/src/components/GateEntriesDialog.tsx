import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, Clock, DoorOpen, Scale, Truck, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatDate, formatNum } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

// What the gate actually saw, read from the document that caused it.
//
// A purchase invoice and a sales invoice each have a barrier event behind them —
// a vehicle in, a vehicle out — and the figures on it are the ones every later
// argument is about: what the weighbridge said, what was written on the
// challan, who drove it, when it left. Those figures live on Gate Entry, and
// until now answering "what came through the gate on this invoice" meant
// leaving the invoice, going to Gate Entry and finding the row by hand.
//
// Read-only on purpose. This explains a document; it is not another place to
// edit the gate register from, which would put two screens in charge of the
// same row.
export function GateEntriesDialog({
  open,
  onClose,
  heading,
  subheading,
  query
}: {
  open: boolean
  onClose: () => void
  heading: string
  subheading?: string
  query: { orderId?: number; saleIds?: number[]; invoiceGroup?: string }
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [hidden, setHidden] = useState(0)
  const [windowFrom, setWindowFrom] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keyed off the query rather than fetched once, so reopening on a different
  // invoice never shows the previous one's vehicles for a frame.
  const key = JSON.stringify(query)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.gate.forRecord(query)
      setRows(r.rows || [])
      setHidden(n(r.hidden))
      setWindowFrom(String(r.window_from || ''))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto p-0">
        <div className="flex items-center gap-3 rounded-t-lg bg-gradient-to-r from-[#1a2c56] to-[#24407e] px-6 py-4 text-white">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15">
            <DoorOpen className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[16px] font-bold text-white">Gate entries</DialogTitle>
            <p className="truncate text-[12.5px] font-medium text-white/90">
              {heading}
              {subheading ? ` · ${subheading}` : ''}
            </p>
          </div>
          {!loading && (
            <span className="ml-auto shrink-0 rounded-full bg-white/20 px-3 py-1 text-[11.5px] font-bold">
              {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
            </span>
          )}
        </div>

        <div className="space-y-3 p-5">
          {loading && <div className="py-10 text-center text-sm font-medium text-[#334155]">Reading the gate register…</div>}
          {!!error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-900">
              {error}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="rounded-lg border border-dashed px-4 py-10 text-center text-[13.5px] font-semibold text-[#0b1728]">
              No gate entry is recorded against this invoice.
              <div className="mt-1 text-[12px] font-normal text-[#475569]">
                {/* The two honest reasons, so an empty panel is not read as a
                    fault. A purchase is linked through its tankers; a sale
                    through the load that carried it out. */}
                Either the vehicle was never entered at the barrier, or the entry was recorded without being
                tied to this document.
              </div>
            </div>
          )}

          {rows.map((g) => {
            const inbound = String(g.direction || 'in') === 'in'
            const rejected = !!g.rejected_at
            const gross = n(g.gross_weight)
            const tare = n(g.tare_weight)
            const net = gross > 0 && tare > 0 ? r3(gross - tare) : null
            const uom = String(g.uom || 'MT')
            const dispatch = g.dispatch_na ? null : n(g.dispatch_qty)
            const received = n(g.received_qty)
            // The figure every dispute is about: what the challan said against
            // what the weighbridge said.
            const diff = dispatch != null && received > 0 ? r3(received - dispatch) : null
            return (
              <div
                key={String(g.id)}
                className={cn(
                  'overflow-hidden rounded-xl border shadow-sm',
                  rejected ? 'border-rose-300 bg-rose-50/40' : 'border-[#d9d2b8] bg-[#fffdf7]'
                )}
              >
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-2 border-b px-3 py-2',
                    rejected
                      ? 'border-rose-200 bg-rose-100/60'
                      : inbound
                        ? 'border-emerald-200 bg-emerald-50/80'
                        : 'border-sky-200 bg-sky-50/80'
                  )}
                >
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white',
                      inbound ? 'bg-emerald-700' : 'bg-sky-700'
                    )}
                  >
                    {inbound ? 'In' : 'Out'}
                  </span>
                  <span className="doc-ref text-[13.5px] font-bold text-[#0b1728]">
                    {String(g.gate_entry_no || '(no number)')}
                  </span>
                  <span className="flex items-center gap-1 text-[12px] font-medium text-[#334155]">
                    <Clock className="h-3 w-3" />
                    {formatDate(g.entry_date)}
                    {g.entry_time ? ` ${String(g.entry_time)}` : ''}
                    {g.out_date ? (
                      <>
                        {' → '}
                        {formatDate(g.out_date)}
                        {g.out_time ? ` ${String(g.out_time)}` : ''}
                      </>
                    ) : null}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {String(g.entry_kind || 'standard') !== 'standard' && (
                      <Badge variant="secondary" className="text-[10px] uppercase">{String(g.entry_kind)}</Badge>
                    )}
                    {!!g.no_weighment && <Badge variant="warning" className="text-[10px]">No weighment</Badge>}
                    {!!g.awaiting_gross_out && <Badge variant="warning" className="text-[10px]">Awaiting gross out</Badge>}
                    {rejected ? (
                      <Badge variant="destructive" className="text-[10px]">Rejected</Badge>
                    ) : (
                      <Badge
                        variant={String(g.status || '') === 'completed' ? 'success' : 'warning'}
                        className="text-[10px]"
                      >
                        {String(g.status || 'pending') === 'completed' ? 'Completed' : 'In the yard'}
                      </Badge>
                    )}
                  </span>
                </div>

                <div className="grid gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-3 lg:grid-cols-4">
                  <Fact icon={Truck} label="Vehicle" value={String(g.tanker_no || g.purchase_tanker_no || '—')} />
                  <Fact label="Product" value={String(g.oil_name || g.oil_code || '—')} />
                  <Fact label={inbound ? 'Supplier' : 'Customer'} value={String(g.party_name || g.gate_customer_name || g.sale_customer || '—')} />
                  <Fact
                    label={inbound ? 'Purchase invoice' : 'Sales invoice'}
                    value={String(
                      inbound
                        ? g.purchase_invoice_no || '—'
                        : g.sale_invoices || g.sale_invoice || '—'
                    )}
                    hint={!inbound && n(g.sale_count) > 1 ? `${n(g.sale_count)} invoices on this vehicle` : undefined}
                  />

                  <Fact
                    label="Challan qty"
                    value={dispatch == null ? 'N/A' : `${formatNum(dispatch)} ${uom}`}
                    hint={dispatch == null ? 'not stated at the gate' : undefined}
                  />
                  <Fact
                    label="Weighed qty"
                    value={received > 0 ? `${formatNum(received)} ${uom}` : '—'}
                  />
                  {diff != null && Math.abs(diff) > 0.0005 && (
                    <Fact
                      label={diff < 0 ? 'Short' : 'Excess'}
                      value={`${formatNum(Math.abs(diff))} ${uom}`}
                      tone={diff < 0 ? 'text-rose-700' : 'text-amber-700'}
                    />
                  )}
                  {net != null && (
                    <Fact
                      icon={Scale}
                      label="Weighbridge"
                      value={`${formatNum(net)} ${uom}`}
                      hint={`gross ${formatNum(gross)} − tare ${formatNum(tare)}`}
                    />
                  )}

                  {!!g.bargain_no && <Fact label="Bargain" value={String(g.bargain_no)} />}
                  {!!g.transporter_name && <Fact label="Transporter" value={String(g.transporter_name)} />}
                  {!!g.source_name && <Fact label="Source" value={String(g.source_name)} />}
                  {!!g.ref_no && <Fact label="Reference" value={String(g.ref_no)} />}
                  {!!g.person && <Fact icon={User} label="Person" value={String(g.person)} />}
                  {String(g.rec_type || 'OIL') !== 'OIL' && <Fact label="Records" value={String(g.rec_type)} />}
                  {!!g.is_direct_mnc && <Fact label="Direct / MNC" value="Yes" />}
                </div>

                {(!!g.note || rejected) && (
                  <div className="space-y-1 border-t border-dotted border-[#e5dfc8] px-3 py-2">
                    {rejected && (
                      <div className="flex items-start gap-1.5 text-[11.5px] text-rose-800">
                        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Rejected {g.rejected_at ? formatDate(String(g.rejected_at).slice(0, 10)) : ''}
                          {g.rejected_reason ? ` — ${String(g.rejected_reason)}` : ''}
                        </span>
                      </div>
                    )}
                    {!!g.note && <div className="text-[12px] font-medium text-[#334155]">{String(g.note)}</div>}
                  </div>
                )}
              </div>
            )
          })}

          {/* The Gate Entry day window applies here too — it is an access
              control, so a document opened from Purchase or Sales must not be a
              way around it. Said out loud, because a short list that looks
              complete is worse than a short list that explains itself. */}
          {hidden > 0 && (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {hidden} completed {hidden === 1 ? 'entry is' : 'entries are'} older than your Gate Entry window
                {windowFrom ? ` (from ${formatDate(windowFrom)})` : ''} and not shown. Anything still in the yard is
                always listed, however old.
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Fact({
  icon: Icon,
  label,
  value,
  hint,
  tone
}: {
  icon?: React.ComponentType<{ className?: string }>
  label: string
  value: string
  hint?: string
  tone?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      {/* A 10px uppercase label in slate-500 is the hardest thing on the
          screen to read, and this panel is nothing but labels and figures. All
          three lines are pushed dark deliberately: the label to slate-700, the
          figure to near-black, the working to slate-600. */}
      <div className="flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wide text-[#334155]">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className={cn('truncate text-[13.5px] font-bold', tone || 'text-[#0b1728]')} title={value}>
        {value}
      </div>
      {hint && <div className="truncate text-[11px] font-medium text-[#475569]">{hint}</div>}
    </div>
  )
}
