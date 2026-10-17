import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Minus, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDrawerEscape } from '@/lib/escape'
import { activityStamp, formatDate, formatNum, todayISO, utcStampLocal } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The reasons a desk most often has, a click away. Anything else is typed.
const REASONS = ['Physical dip / count', 'Spillage / leakage', 'Found in line / tank', 'Entry correction', 'Sample / testing', 'Evaporation / handling loss']

// ADJUST A PRODUCT'S BOOK STOCK, from its own row in the register.
//
// A quantity added to or taken off what the books say, on a date, with the
// reason — and under it every adjustment already made to the product, so the
// figure being corrected can be seen beside the corrections already in it.
// A wrong entry is removed (kept on file, marked) and entered again.
export function StockAdjustDrawer({
  product,
  companyIds,
  openingFrom = '',
  onClose
}: {
  /** The register row being adjusted; null hides the drawer. */
  product: Row | null
  /** The companies the register is showing — the adjustment is booked to one of them. */
  companyIds: number[]
  /** The day the register starts (the opening count) — nothing earlier shows in it. */
  openingFrom?: string
  onClose: () => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  useDrawerEscape(!!product, ref, () => {
    if (!busy) onClose()
  })
  const [dir, setDir] = useState<'add' | 'remove'>('add')
  const [qty, setQty] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')
  const [companies, setCompanies] = useState<Row[]>([])
  const [companyId, setCompanyId] = useState<number>(0)
  const [history, setHistory] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const pid = n(product?.id)
  const uom = String(product?.uom || 'MT')

  const loadHistory = useCallback(async (): Promise<void> => {
    if (!pid) return
    setLoading(true)
    try {
      setHistory(await window.api.stock.adjustments(pid, companies.map((c) => n(c.id))))
    } catch {
      setHistory([])
    } finally {
      setLoading(false)
    }
  }, [pid, companies])

  // Fresh form for each product opened.
  useEffect(() => {
    if (!product) return
    setDir('add')
    setQty('')
    setDate(todayISO())
    setNote('')
    void (async () => {
      const [all, active] = await Promise.all([
        window.api.company.list().catch(() => [] as Row[]),
        window.api.company.getActive().catch(() => ({ id: 0 }))
      ])
      const shown = companyIds.length ? all.filter((c) => companyIds.includes(n(c.id))) : all.filter((c) => n(c.id) === n(active.id))
      const list = shown.length ? shown : all.filter((c) => n(c.id) === n(active.id))
      setCompanies(list)
      setCompanyId(list.some((c) => n(c.id) === n(active.id)) ? n(active.id) : n(list[0]?.id))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])
  useEffect(() => {
    if (product && companies.length) void loadHistory()
  }, [product, companies, loadHistory])

  if (!product) return null

  const q = Math.abs(n(qty))
  const signed = dir === 'add' ? q : -q
  const closing = n(product.stock)
  const after = Math.round((closing + signed) * 1000) / 1000
  const missing = [!(q > 0) && 'quantity', !note.trim() && 'reason', !companyId && 'company'].filter(Boolean) as string[]
  const live = history.filter((h) => !h.deleted_at)
  const net = live.reduce((t, h) => t + n(h.qty), 0)

  async function save(): Promise<void> {
    if (missing.length) return
    setBusy(true)
    try {
      await window.api.stock.adjust({ product_id: pid, qty: signed, date, note: note.trim(), company_id: companyId })
      toast.success(`${dir === 'add' ? 'Added' : 'Took off'} ${formatNum(q)} ${uom} — ${String(product?.name)}`)
      setQty('')
      setNote('')
      await loadHistory()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(h: Row): Promise<void> {
    if (!confirm(`Remove the adjustment of ${n(h.qty) > 0 ? '+' : '−'}${formatNum(Math.abs(n(h.qty)))} ${uom} dated ${formatDate(h.adj_date)}? It stays on file, marked removed.`)) return
    setBusy(true)
    try {
      await window.api.stock.deleteAdjustment(n(h.id))
      toast.success('Adjustment removed')
      await loadHistory()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const cap = 'text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Adjust ${String(product.name)}`}
      data-escape-layer="drawer"
      className="fixed inset-0 z-[80] flex justify-end"
      style={{ background: 'rgba(10,31,23,.42)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="flex h-full w-[min(100%,520px)] flex-col bg-[#F4F7F2]" style={{ boxShadow: '-18px 0 40px rgba(7,43,32,.28)' }}>
        {/* Header: what is being adjusted, and where it stands now. */}
        <div className="flex-none px-5 py-4 text-white" style={{ background: 'linear-gradient(180deg,#11503C,#0B3D2E)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Book stock · adjustment</div>
              <div className="mt-1 truncate text-[18px] font-extrabold tracking-[-0.02em]">{String(product.name)}</div>
              <div className="mt-1 text-[11.5px] font-semibold text-[#8FBFA8]">
                {String(product.category || '').replace(/\b\w/g, (ch) => ch.toUpperCase())} · now <b className="doc-ref text-white">{formatNum(closing)} {uom}</b>
                {!!live.length && (
                  <>
                    {' '}· {live.length} adjustment{live.length === 1 ? '' : 's'} on file ({net >= 0 ? '+' : '−'}
                    {formatNum(Math.abs(net))})
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => !busy && onClose()}
              title="Close (Esc)"
              className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[7px] bg-white/10 hover:bg-white/20"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* The new adjustment. */}
          <div className="rounded-[10px] border border-[#DCE7DB] bg-white p-4" style={{ boxShadow: '0 1px 2px rgba(10,31,23,.04)' }}>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['add', 'Add to stock', Plus, '#0B6B45', '#E9F5EE', '#BFE3CB'],
                  ['remove', 'Take off stock', Minus, '#B3261E', '#FDF3F2', '#F0D6D4']
                ] as const
              ).map(([k, label, Icon, fg, bg, bd]) => {
                const on = dir === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDir(k)}
                    className="flex h-11 items-center justify-center gap-2 rounded-[8px] border text-[12.5px] font-extrabold"
                    style={on ? { background: bg, borderColor: fg, color: fg } : { background: '#fff', borderColor: '#DCE7DB', color: '#5A6B62' }}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                )
              })}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className={cap}>Quantity ({uom}) *</div>
                <div className="mt-1.5 flex h-10 items-center rounded-[7px] border border-[#C3D2C6] bg-white pl-3 pr-2 focus-within:border-[#0B3D2E]">
                  <span className="doc-ref mr-1 text-[14px] font-bold" style={{ color: dir === 'add' ? '#0B6B45' : '#B3261E' }}>
                    {dir === 'add' ? '+' : '−'}
                  </span>
                  <input
                    autoFocus
                    type="number"
                    min={0}
                    step="any"
                    value={qty}
                    onChange={(e) => setQty(e.target.value.replace('-', ''))}
                    placeholder="0"
                    className="doc-ref min-w-0 flex-1 border-0 bg-transparent text-[14px] font-bold outline-none"
                  />
                  <span className="text-[11px] font-bold text-[#8CA396]">{uom}</span>
                </div>
              </div>
              <div>
                <div className={cap}>Date</div>
                <div className="mt-1.5">
                  <DatePicker value={date} onChange={(v) => setDate(v || todayISO())} min={openingFrom || undefined} max={todayISO()} className="!h-10 !rounded-[7px]" />
                </div>
              </div>
            </div>

            {companies.length > 1 && (
              <div className="mt-3">
                <div className={cap}>Book it to *</div>
                <div className="mt-1.5">
                  <Select value={String(companyId || '')} onValueChange={(v) => setCompanyId(n(v))}>
                    <SelectTrigger className="!h-10 !rounded-[7px]">
                      <SelectValue placeholder="Pick the company" />
                    </SelectTrigger>
                    <SelectContent>
                      {companies.map((c) => (
                        <SelectItem key={String(c.id)} value={String(c.id)}>
                          {String(c.name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="mt-3">
              <div className={cap}>Reason *</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setNote((p) => (p.trim() ? (p.includes(r) ? p : `${p.trim()} · ${r}`) : r))}
                    className="h-7 rounded-full border border-[#DCE7DB] bg-[#F7FAF6] px-2.5 text-[11px] font-bold text-[#33473E] hover:border-[#0B3D2E]"
                  >
                    {r}
                  </button>
                ))}
              </div>
              <textarea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What happened — e.g. dip on 01-10 showed 2.4 MT less than the books"
                className="mt-2 w-full resize-none rounded-[7px] border border-[#C3D2C6] bg-white px-3 py-2 text-[12.5px] font-semibold outline-none placeholder:font-medium placeholder:text-[#9FB3A6] focus:border-[#0B3D2E]"
              />
            </div>

            {/* What it does to the figure, before it is saved. */}
            <div className="mt-3 flex items-center justify-between rounded-[8px] border border-[#E5DFC8] px-3 py-2.5" style={{ background: 'linear-gradient(180deg,#FBF9F1,#F7F4E8)' }}>
              <div>
                <div className={cap}>Book stock now</div>
                <div className="doc-ref mt-0.5 text-[14px] font-bold text-[#0A1F17]">
                  {formatNum(closing)} {uom}
                </div>
              </div>
              <span className="doc-ref text-[15px] font-bold" style={{ color: dir === 'add' ? '#0B6B45' : '#B3261E' }}>
                {dir === 'add' ? '+' : '−'} {formatNum(q)}
              </span>
              <div className="text-right">
                <div className={cap}>After</div>
                <div className="doc-ref mt-0.5 text-[14px] font-bold" style={{ color: after < -1e-9 ? '#B3261E' : '#0A1F17' }}>
                  {formatNum(after)} {uom}
                </div>
              </div>
            </div>
            {date < String(todayISO()) && (
              <p className="mt-1.5 text-[10.5px] font-semibold text-[#8CA396]">
                Dated {formatDate(date)} — it counts from that day, so a register filtered to an earlier period will not show it.
              </p>
            )}

            <div className="mt-3 flex items-center gap-2">
              <span className={cn('min-w-0 flex-1 text-[11.5px] font-bold', missing.length ? 'text-[#8A5300]' : 'text-[#0B6B45]')}>
                {missing.length ? `Still needed: ${missing.join(', ')}` : 'Ready to save'}
              </span>
              <button
                type="button"
                disabled={busy || missing.length > 0}
                onClick={() => void save()}
                className="flex h-10 items-center gap-2 rounded-[8px] px-4 text-[12.5px] font-extrabold disabled:cursor-not-allowed"
                style={
                  missing.length
                    ? { background: '#DCE7DB', color: '#8CA396' }
                    : { background: 'linear-gradient(180deg,#145A43,#0B3D2E)', color: '#C7F03F' }
                }
              >
                <SlidersHorizontal className="h-4 w-4" />
                {busy ? 'Saving…' : 'Save adjustment'}
              </button>
            </div>
          </div>

          {/* Every adjustment already made to this product. */}
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={cap}>Adjustments on file</span>
              <span className="doc-ref rounded-[10px] bg-[#E1F3E8] px-2 py-px text-[10px] font-bold text-[#0B6B45]">{live.length}</span>
            </div>
            {loading && !history.length ? (
              <p className="text-[12px] font-semibold text-[#8CA396]">Loading…</p>
            ) : !history.length ? (
              <p className="rounded-[8px] border border-dashed border-[#C3D2C6] bg-white px-3 py-3 text-[12px] font-semibold text-[#5A6B62]">
                No adjustments yet — this product&apos;s book stock is exactly what moved.
              </p>
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-[#DCE7DB] bg-white">
                {history.map((h) => {
                  const gone = !!h.deleted_at
                  const plus = n(h.qty) > 0
                  return (
                    <div key={String(h.id)} className="flex items-start gap-3 border-b border-b-[#EFF3EE] px-3 py-2.5 last:border-b-0" style={{ opacity: gone ? 0.55 : 1 }}>
                      <span
                        className="doc-ref w-[92px] flex-none text-right text-[13px] font-bold"
                        style={{ color: gone ? '#8CA396' : plus ? '#0B6B45' : '#B3261E', textDecoration: gone ? 'line-through' : undefined }}
                      >
                        {plus ? '+' : '−'} {formatNum(Math.abs(n(h.qty)))}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold text-[#0A1F17] [overflow-wrap:anywhere]">{String(h.note || '—')}</div>
                        <div className="mt-0.5 text-[10.5px] font-semibold text-[#8CA396]">
                          {formatDate(h.adj_date)}
                          {h.created_by ? ` · by ${String(h.created_by)}` : ''}
                          {companies.length > 1 && h.company_name ? ` · ${String(h.company_name)}` : ''}
                          {' · entered '}
                          {activityStamp(utcStampLocal(h.created_at))}
                          {gone && (
                            <span className="font-bold text-[#B3261E]">
                              {' '}· removed{h.deleted_by ? ` by ${String(h.deleted_by)}` : ''} {activityStamp(utcStampLocal(h.deleted_at))}
                            </span>
                          )}
                        </div>
                      </div>
                      {!gone && (
                        <button
                          type="button"
                          title="Remove this adjustment (kept on file, marked)"
                          disabled={busy}
                          onClick={() => void remove(h)}
                          className="flex h-7 w-7 flex-none items-center justify-center rounded-[6px] text-[#B3261E] hover:bg-[#FDF0EE]"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
