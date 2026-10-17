import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, CalendarCheck, ExternalLink, FilePlus2, Link2, RefreshCw, Search, Upload } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { TallyBookVouchers } from '@/components/TallyBookVouchers'
import { TallyBatches } from '@/components/TallyBatches'
import { ColumnFilter } from '@/components/ui/column-filter'
import { useColumnFilters, type ColumnSpec } from '@/lib/useColumnFilters'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// SALES REGISTER CHECK — Tally's Sales Register laid against these books,
// invoice by invoice. Read only: it says which invoices agree, which differ
// (and in which figure, by how much), which one side has and the other does
// not, and which Tally cancelled. A party that differs only in its name can
// be linked once ("Same party"), and is then taken as agreeing here and in
// every Tally import after.

/** A draft's save time, from the server's UTC stamp, in local time. */
export function draftTime(s: string): string {
  if (!s) return ''
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  if (Number.isNaN(d.getTime())) return s
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STATUS: Record<string, { label: string; fg: string; bg: string; bd: string; tip: string }> = {
  matched: { label: 'Matched', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', tip: 'Tally and these books agree on every figure' },
  mismatch: { label: 'Not matching', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'In both, but at least one figure differs' },
  missing_here: { label: 'Missing here', fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', tip: 'In Tally, not in these books' },
  missing_tally: { label: 'Not in Tally', fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', tip: 'In these books for the period, not in Tally' },
  cancelled: { label: 'Cancelled in Tally', fg: '#5A6B62', bg: '#EEF3EC', bd: '#DCE7DB', tip: 'Tally shows it cancelled, and it is not here either' },
  cancelled_here: { label: 'Cancelled in Tally · here', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'Tally cancelled it, but these books still carry it' }
}
const FIELD: Record<string, string> = {
  date: 'Date',
  party: 'Party',
  qty: 'Qty',
  taxable: 'Taxable',
  gst: 'GST',
  round_off: 'Round off',
  gross: 'Gross',
  duplicate: 'Entered twice here'
}

function chip(fg: string, bg: string, bd: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: fg, background: bg, border: `1px solid ${bd}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }
}

// WHERE THE DESK WAS, kept across a trip to a voucher and back. Opening a
// voucher leaves this screen (it unmounts); Esc on the voucher brings it back,
// and it should come back on the same filter and search, at the invoice that
// was opened — not at the top of an unfiltered list.
const kept: { filter: string; q: string; focus: string; cols: Record<string, string[]> } = { filter: 'problems', q: '', focus: '', cols: {} }

export function TallySalesCheck({
  companyName,
  companyId,
  accounts = [],
  groupNames = [],
  onChanged = () => {},
  onOpenVoucher
}: {
  companyName: string
  /** The company Accounting is in — the check and its draft are this one's. */
  companyId?: number
  accounts?: Row[]
  groupNames?: Row[]
  onChanged?: () => void
  /** Open an invoice — on the Sales page when a sale is behind it, else its voucher; Back comes here. */
  onOpenVoucher?: (entryId: number, saleId?: number) => void
}): React.JSX.Element {
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null)
  const [res, setRes] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<string>(kept.filter)
  const [q, setQ] = useState(kept.q)
  const [focus, setFocus] = useState(kept.focus)
  useEffect(() => {
    kept.filter = filter
    kept.q = q
  }, [filter, q])
  const fileRef = useRef<HTMLInputElement>(null)
  // The table scrolls in its own box; a new filter or search starts at the top.
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0
  }, [filter, q])
  const scrolledTo = useRef('')
  useEffect(() => {
    // The check is read again as the company settles after a remount, and the
    // table is drawn afresh each time — so a scroll done for an earlier read
    // does not count.
    if (!res) {
      scrolledTo.current = ''
      return
    }
    if (!focus || scrolledTo.current === focus) return
    scrolledTo.current = focus
    setTimeout(() => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-vch="${CSS.escape(focus)}"]`)
      el?.scrollIntoView({ block: 'center' })
    })
  }, [res, focus])
  function openVoucher(r: Row): void {
    if (!onOpenVoucher || !r.books?.id) return
    kept.focus = String(r.vch_no)
    setFocus(kept.focus)
    onOpenVoucher(Number(r.books.id), Number(r.books.sale_id) || undefined)
  }

  // The file being checked is kept on the server, so the check is still here
  // after leaving the screen or a reload, until it is cleared.
  const [savedAt, setSavedAt] = useState('')
  // "Use Tally's date": the line being confirmed, and whether one is running.
  const [dateAsk, setDateAsk] = useState<string | null>(null)
  const [allAsk, setAllAsk] = useState(false)
  const [fixing, setFixing] = useState(false)
  // "Book from Tally": the missing-here invoices open in the booking dialog.
  const [bookVch, setBookVch] = useState<string[] | null>(null)
  const [batchTick, setBatchTick] = useState(0)

  // The company on screen now. An answer that comes back for a company the
  // desk has since switched away from is dropped, never shown under the new one.
  const companyNow = useRef(companyId)
  companyNow.current = companyId

  async function run(f: { name: string; b64: string }, fromDraft?: string): Promise<void> {
    const forCompany = companyId
    setBusy(true)
    try {
      const checked = await window.api.tallyNotes.salesCheck({ company_id: forCompany, data_base64: f.b64, file_name: f.name })
      if (companyNow.current !== forCompany) return
      setRes(checked)
      setFile(f)
      if (fromDraft) setSavedAt(fromDraft)
      else {
        const s = await window.api.tallyNotes.saveDraft({ company_id: forCompany, kind: 'sales', file_name: f.name, data_base64: f.b64 })
        if (companyNow.current === forCompany) setSavedAt(s.saved_at)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let live = true
    setRes(null)
    setFile(null)
    setSavedAt('')
    // Nothing is read until Accounting has said which company this is.
    if (!companyId) return
    void window.api.tallyNotes
      .drafts({ company_id: companyId })
      .then((ds) => {
        const d = (ds as Row[]).find((x) => x.kind === 'sales')
        if (live && d) void run({ name: String(d.file_name || ''), b64: String(d.data_base64) }, String(d.saved_at || ''))
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function clearCheck(): Promise<void> {
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind: 'sales' }).catch(() => {})
    setRes(null)
    setFile(null)
    setSavedAt('')
    toast.success('Sales check cleared')
  }

  function choose(f: File | undefined): void {
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      void run({ name: f.name, b64: s.slice(s.indexOf(',') + 1) })
    }
    r.readAsDataURL(f)
  }

  async function sameParty(row: Row): Promise<void> {
    if (!row.books?.party_id || !file) return
    try {
      await window.api.tallyNotes.linkParty({ tally_name: row.tally.party, account_id: Number(row.books.party_id) })
      toast.success(`${row.tally.party} linked to ${row.books.party}`)
      await run(file)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Re-date the sale here to Tally's date — every line of the invoice and its
  // voucher (kept under the same number). Tally is taken as right: it is where
  // the invoice was raised, on the day it was raised.
  async function useTallyDate(list: Row[]): Promise<void> {
    if (!file || !list.length) return
    setFixing(true)
    let done = 0
    const failed: string[] = []
    for (const r of list) {
      try {
        await window.api.sales.fixDate(Number(r.books.sale_id), String(r.tally.date))
        done++
      } catch (e) {
        failed.push(`${String(r.vch_no)}: ${(e as Error).message}`)
      }
    }
    setDateAsk(null)
    setAllAsk(false)
    if (done) {
      toast.success(
        done === 1 && list.length === 1
          ? `${String(list[0].vch_no)} re-dated to ${formatDate(String(list[0].tally.date))}`
          : `${done} ${done === 1 ? 'invoice' : 'invoices'} re-dated to Tally's date`
      )
    }
    for (const f of failed.slice(0, 4)) toast.error(f)
    if (failed.length > 4) toast.error(`${failed.length - 4} more could not be re-dated`)
    await run(file, savedAt || undefined)
    setFixing(false)
  }

  const rows: Row[] = res?.rows || []
  const tabbed = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'problems' && (r.status === 'matched' || r.status === 'cancelled')) return false
      if (filter !== 'problems' && filter !== 'all' && r.status !== filter) return false
      if (!needle) return true
      return [r.vch_no, r.tally?.party, r.books?.party].some((x) => String(x || '').toLowerCase().includes(needle))
    })
  }, [rows, filter, q])

  // EVERY COLUMN FILTERS, Excel style. A figure is Tally's where Tally has the
  // invoice and the books' otherwise — the same figure the column prints on top.
  const side = (r: Row): Row => r.tally || r.books || {}
  const money = (f: string): ColumnSpec<Row> => ({
    get: (r) => {
      const v = side(r)[f]
      return v == null || v === '' ? '' : String(Math.round(Number(v) * 100) / 100)
    },
    label: (v) => (v === '' ? '(blank)' : formatINR(Number(v))),
    numeric: true
  })
  const colSpecs: Record<string, ColumnSpec<Row>> = {
    invoice: { get: (r) => String(r.vch_no || '') },
    date: { get: (r) => String(side(r).date || '').slice(0, 10), label: (v) => (v ? formatDate(v) : '(blank)') },
    party: { get: (r) => String(side(r).party || '') },
    qty: {
      get: (r) => {
        const v = r.tally ? r.tally.qty : r.books?.qty
        return v == null || v === '' ? '' : String(v)
      },
      numeric: true
    },
    taxable: money('taxable'),
    gst: money('gst'),
    gross: money('gross'),
    // The status, and what differs on a line that does not match — so "every
    // date difference" is one tick.
    status: {
      get: (r) => {
        const s = STATUS[String(r.status)]?.label || String(r.status)
        const what = ((r.diffs as Row[]) || []).map((d) => FIELD[d.field] || d.field)
        return what.length ? `${s} · ${what.join(', ')}` : s
      }
    }
  }
  const cf = useColumnFilters(tabbed, colSpecs, kept.cols)
  useEffect(() => {
    kept.cols = cf.selected
  }, [cf.selected])
  const shown = cf.filtered

  const c = res?.counts || {}
  // Lines whose date differs, and which came from a sale here.
  const canRedate = (r: Row): boolean =>
    !!r.tally?.date && !!r.books?.sale_id && (r.diffs as Row[]).some((d) => d.field === 'date')
  const redatable = rows.filter(canRedate)
  // In Tally, not here, not cancelled — what can be booked from the file.
  const canBook = (r: Row): boolean => r.status === 'missing_here' && !!r.tally && !r.tally.cancelled
  // Narrowed by a search, a column filter (or In / Out) — then "Book
  // missing" offers only what is on screen, e.g. one party's entries.
  const narrowed = !!q.trim() || cf.activeCount > 0
  const bookable = (narrowed ? shown : rows).filter(canBook)
  const problems = (c.mismatch || 0) + (c.missing_here || 0) + (c.missing_tally || 0) + (c.cancelled_here || 0)
  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const diffOf = (r: Row, f: string): Row | undefined => (r.diffs as Row[]).find((d) => d.field === f)
  // Invoice · Date · Party · Qty · Taxable · GST · Gross · Status
  const GRID = '128px 112px minmax(240px,1.6fr) 84px 150px 132px 150px 176px'

  // One cell: Tally's figure, and — only where they differ — what these books
  // have under it, with the gap on its own line so nothing is cut off.
  const cell = (r: Row, f: string, kind: 'money' | 'date' | 'text' | 'qty'): React.JSX.Element => {
    const t = r.tally
    const b = r.books
    const fmt = (v: unknown): string =>
      v == null || v === '' ? '—' : kind === 'money' ? formatINR(Number(v) || 0) : kind === 'date' ? formatDate(String(v)) : String(v)
    const d = diffOf(r, f)
    const tv = t ? (f === 'qty' ? t.qty : t[f]) : null
    const bv = b ? (f === 'qty' ? (t?.gross_weight ? b.boxes : b.qty) : b[f]) : null
    const right = kind === 'money' || kind === 'qty'
    const align = right ? 'items-end text-right' : 'items-start'
    if (!t || !b) {
      return (
        <span className={`flex min-w-0 flex-col ${align}`}>
          <span className="whitespace-nowrap text-[12.5px] font-semibold tabular-nums text-[#33473E]">{fmt(t ? tv : bv)}</span>
          <span className="text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8CA396]">{t ? 'Tally only' : 'Here only'}</span>
        </span>
      )
    }
    return (
      <span className={`flex min-w-0 flex-col ${align}`}>
        <span className={`whitespace-nowrap text-[12.5px] tabular-nums text-[#0A1F17] ${d ? 'font-extrabold' : 'font-semibold'}`}>{fmt(tv)}</span>
        {d && (
          <>
            <span className="whitespace-nowrap text-[11px] font-bold tabular-nums text-[#8C2F26]" title="What these books have">
              <span className="mr-1 text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]">Here</span>
              {fmt(bv)}
              {d.unit ? ` ${d.unit}` : ''}
            </span>
            {typeof d.diff === 'number' && kind === 'money' && Math.abs(d.diff) >= 0.005 && (
              <span className="mt-0.5 whitespace-nowrap rounded-[3px] bg-[#FDF3F2] px-1.5 text-[10.5px] font-extrabold tabular-nums text-[#B3261E]">
                Δ {formatINR(d.diff)}
              </span>
            )}
          </>
        )}
      </span>
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-3.5">
      <section className={`${card} shrink-0`}>
        <div className="flex flex-wrap items-center gap-4 p-4">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              choose(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              choose(e.dataTransfer.files?.[0])
            }}
            className="flex min-h-[74px] min-w-[300px] flex-1 items-center gap-3 rounded-[6px] border-2 border-dashed border-[#BFD3C2] bg-[#FBFCFA] px-4 text-left hover:bg-[#F4FBF6]"
          >
            <Upload className="h-6 w-6 shrink-0 text-[#0B6B45]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-extrabold text-[#0A1F17]">
                {busy ? 'Checking…' : file ? file.name : 'Choose or drop the Tally Sales Register (.xlsx)'}
              </span>
              <span className="block text-[11.5px] font-semibold text-[#5A6B62]">
                Tally → Display → Account Books → Sales Register → Columnar → Export as Excel. Nothing is posted — this only compares.
              </span>
            </span>
          </button>
          {res && (
            <div className="grid gap-1 text-[12px] font-semibold text-[#33473E]">
              <span>
                <b>{String(res.file_company || '—')}</b> · {String(res.period || '')}
              </span>
              <span>Checked against {companyName || 'this company'}</span>
              <button type="button" onClick={() => file && void run(file, savedAt || undefined)} className="flex items-center gap-1 text-[11.5px] font-extrabold text-[#0B6B45]">
                <RefreshCw className="h-3.5 w-3.5" /> Check again
              </button>
              {savedAt && (
                <span className="flex flex-wrap items-center gap-2">
                  <span title="Kept on the server until you clear it" style={chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>
                    Saved · {draftTime(savedAt)}
                  </span>
                  <button type="button" onClick={() => void clearCheck()} className="text-[11px] font-extrabold text-[#B3261E] hover:underline">
                    Clear
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
        {res?.company_mismatch && (
          <div className="flex items-start gap-2 border-t border-[#F1D9A6] bg-[#FFF8E9] px-4 py-2.5 text-[12px] font-bold text-[#8A5300]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This file is from {String(res.file_company)}, but you are in {String(res.company)}. Switch company (F3) to check it against the right books.
          </div>
        )}
      </section>

      {res && (
        <>
          {/* Where the two books stand — the money first, then the count of
              each kind of line; a count is also a filter. */}
          <section className={`${card} shrink-0`}>
            <div className="grid grid-cols-1 divide-y divide-[#E4ECE3] md:grid-cols-[1.25fr_2fr] md:divide-x md:divide-y-0">
              <div className="grid grid-cols-3 gap-3 px-4 py-3">
                {[
                  { k: 'Tally', v: Number(res.totals?.tally) || 0, tone: '#0A1F17' },
                  { k: 'Here', v: Number(res.totals?.books) || 0, tone: '#0A1F17' },
                  {
                    k: 'Difference',
                    v: Math.round(((Number(res.totals?.tally) || 0) - (Number(res.totals?.books) || 0)) * 100) / 100,
                    tone: Math.abs((Number(res.totals?.tally) || 0) - (Number(res.totals?.books) || 0)) > 1 ? '#B3261E' : '#0B6B45'
                  }
                ].map((x) => (
                  <div key={x.k} className="min-w-0">
                    <div className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">{x.k}</div>
                    <div className="mt-0.5 truncate text-[15px] font-bold tabular-nums" style={{ color: x.tone }} title={formatINR(x.v)}>
                      {formatINR(x.v)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6">
                {(['matched', 'mismatch', 'missing_here', 'missing_tally', 'cancelled', 'cancelled_here'] as const).map((k) => {
                  const s = STATUS[k]
                  const on = filter === k
                  const v = Number(c[k] || 0)
                  return (
                    <button
                      key={k}
                      type="button"
                      title={`${s.tip} — click to show only these`}
                      onClick={() => setFilter(on ? 'problems' : k)}
                      className="relative min-w-0 px-3 py-3 text-left transition-colors hover:bg-[#F7FAF6]"
                      style={{ background: on ? s.bg : undefined }}
                    >
                      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: on || (v > 0 && k !== 'matched' && k !== 'cancelled') ? s.fg : 'transparent' }} />
                      <div className="truncate text-[9.5px] font-extrabold uppercase tracking-[.08em]" style={{ color: s.fg }}>
                        {s.label}
                      </div>
                      <div className="mt-0.5 text-[18px] font-bold tabular-nums" style={{ color: v ? '#0A1F17' : '#A9B8AE' }}>
                        {v}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>

          <TallyBatches
            companyId={companyId}
            kind="sales"
            refresh={batchTick}
            onUndone={async () => {
              if (file) await run(file, savedAt || undefined)
            }}
          />

          <section className={`${card} flex min-h-0 shrink-0 flex-col`}>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
              <div className="flex overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                {[
                  { k: 'problems', label: 'To look at', n: problems },
                  { k: 'mismatch', label: 'Not matching', n: Number(c.mismatch || 0) },
                  { k: 'missing_here', label: 'Missing here', n: Number(c.missing_here || 0) },
                  { k: 'missing_tally', label: 'Not in Tally', n: Number(c.missing_tally || 0) },
                  { k: 'all', label: 'All', n: rows.length }
                ].map((f, i) => {
                  const on = filter === f.k
                  return (
                    <button
                      key={f.k}
                      type="button"
                      onClick={() => setFilter(f.k)}
                      className={`flex h-8 items-center gap-1.5 px-3 text-[11.5px] font-extrabold ${i ? 'border-l border-[#D6E2D6]' : ''}`}
                      style={on ? { background: '#0B3D2E', color: '#fff' } : { color: '#33473E' }}
                    >
                      {f.label}
                      <span
                        className="rounded-[3px] px-1.5 text-[10.5px] tabular-nums"
                        style={on ? { background: 'rgba(255,255,255,.16)', color: '#C7F03F' } : { background: '#EEF3EC', color: '#5A6B62' }}
                      >
                        {f.n}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8CA396]" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search invoice no or party"
                  className="h-8 w-full rounded-[4px] border border-[#D6E2D6] bg-white pl-8 pr-2.5 text-[12px] font-semibold"
                />
              </div>
              {bookable.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBookVch(bookable.map((r) => String(r.vch_no)))}
                  title="Post every invoice Tally has and these books do not, as SALE vouchers"
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-[#FFF8E9] px-3 text-[11.5px] font-extrabold text-[#8A5300] hover:bg-[#FFF1D6]"
                >
                  <FilePlus2 className="h-3.5 w-3.5" /> Book missing · {bookable.length}
                </button>
              )}
              {redatable.length > 0 && (
                <button
                  type="button"
                  disabled={fixing}
                  onClick={() => setAllAsk(true)}
                  title="Move every invoice whose date differs to the date Tally has"
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#BFE3CB] bg-[#F4FBF6] px-3 text-[11.5px] font-extrabold text-[#0B6B45] hover:bg-[#E9F5EE] disabled:opacity-60"
                >
                  <CalendarCheck className="h-3.5 w-3.5" /> Use Tally&rsquo;s date · {redatable.length}
                </button>
              )}
              {cf.activeCount > 0 && (
                <button
                  type="button"
                  onClick={cf.clear}
                  title="Clear every column filter"
                  className="h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#B3261E] hover:bg-[#FDF3F2]"
                >
                  Clear {cf.activeCount} column filter{cf.activeCount === 1 ? '' : 's'}
                </button>
              )}
              <span className="text-[11.5px] font-semibold text-[#5A6B62]">{shown.length} shown</span>
              <ExcelButton
                filename={`tally-sales-check-${String(res.from || '')}-${String(res.to || '')}`}
                sheetName="Sales check"
                title="Sales Register — Tally against the books"
                subtitle={`${String(res.file_company || '')} · ${String(res.period || '')}`}
                columns={[
                  { header: 'Invoice', key: 'vch_no', value: (r: Row) => String(r.vch_no) },
                  { header: 'Status', key: 'status', value: (r: Row) => STATUS[String(r.status)]?.label || String(r.status) },
                  { header: 'What differs', key: 'diffs', value: (r: Row) => (r.diffs as Row[]).map((d) => FIELD[d.field] || d.field).join(', ') },
                  { header: 'Explanation', key: 'explain', value: (r: Row) => ((r.explain as string[]) || []).join(' ') },
                  { header: 'What to do', key: 'fix', value: (r: Row) => String(r.fix || '') },
                  { header: 'Date (Tally)', key: 'td', value: (r: Row) => (r.tally ? formatDate(r.tally.date) : '') },
                  { header: 'Date (here)', key: 'bd', value: (r: Row) => (r.books ? formatDate(r.books.date) : '') },
                  { header: 'Party (Tally)', key: 'tp', value: (r: Row) => String(r.tally?.party || '') },
                  { header: 'Party (here)', key: 'bp', value: (r: Row) => String(r.books?.party || '') },
                  { header: 'Taxable (Tally)', key: 'tt', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.taxable) : '') },
                  { header: 'Taxable (here)', key: 'bt', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.taxable) : '') },
                  { header: 'GST (Tally)', key: 'tg', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.gst) : '') },
                  { header: 'GST (here)', key: 'bg', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.gst) : '') },
                  { header: 'Gross (Tally)', key: 'tgr', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.gross) : '') },
                  { header: 'Gross (here)', key: 'bgr', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.gross) : '') }
                ]}
                rows={shown}
              />
            </div>
            {allAsk && (
              <div className="flex flex-wrap items-center gap-2 border-b border-[#BFE3CB] bg-[#F4FBF6] px-4 py-2.5">
                <CalendarCheck className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                <span className="min-w-0 flex-1 text-[12px] font-bold text-[#0A1F17]">
                  Move {redatable.length} {redatable.length === 1 ? 'invoice' : 'invoices'} to the date Tally has? Each one&rsquo;s lines, receivable and
                  voucher take the new date; the voucher keeps its number and no amount changes.
                </span>
                <button
                  type="button"
                  onClick={() => setAllAsk(false)}
                  className="h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-3 text-[11.5px] font-extrabold text-[#33473E]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={fixing}
                  onClick={() => void useTallyDate(redatable)}
                  className="h-8 rounded-[4px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F] disabled:opacity-60"
                >
                  {fixing ? 'Re-dating…' : `Re-date ${redatable.length}`}
                </button>
              </div>
            )}
            {/* The table scrolls inside its own box, so its header stays pinned
                while the lines move under it — whatever the page around it does. */}
            <div ref={tableRef} className="max-h-[calc(100vh-175px)] min-h-[360px] overflow-auto">
              <div style={{ minWidth: 1180 }}>
                <div
                  className="sticky top-0 z-10 grid items-end border-b-2 border-[#D6E2D6] bg-[#EEF4ED] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E] shadow-[0_2px_6px_rgba(10,31,23,.06)]"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span>
                    <ColumnFilter label="Invoice" {...cf.props('invoice')} />
                  </span>
                  <span>
                    <ColumnFilter label="Date" {...cf.props('date')} />
                  </span>
                  <span>
                    <ColumnFilter label="Party" {...cf.props('party')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Qty" align="end" {...cf.props('qty')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Taxable" align="end" {...cf.props('taxable')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="GST" align="end" {...cf.props('gst')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Gross" align="end" {...cf.props('gross')} />
                  </span>
                  <span className="pl-4">
                    <ColumnFilter label="Status" align="end" {...cf.props('status')} />
                  </span>
                </div>
                {shown.length === 0 && (
                  <div className="px-4 py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">
                    {cf.activeCount > 0
                      ? 'No invoice passes the column filters — clear them to see more.'
                      : q.trim()
                      ? 'No invoice here matches that search.'
                      : filter === 'problems'
                        ? 'Nothing to look at — every invoice agrees with Tally.'
                        : 'Nothing to show for this filter.'}
                  </div>
                )}
                {shown.map((r, i) => {
                  const s = STATUS[String(r.status)]
                  const pd = diffOf(r, 'party')
                  const dup = diffOf(r, 'duplicate')
                  const said = (r.explain as string[]) || []
                  const quiet = r.status === 'matched' || r.status === 'cancelled'
                  return (
                    <div
                      key={`${String(r.vch_no)}-${i}`}
                      data-vch={String(r.vch_no)}
                      className="grid border-b border-[#E4ECE3] px-4 py-2.5 transition-colors hover:bg-[#F7FBF6]"
                      style={{
                        gridTemplateColumns: GRID,
                        boxShadow: `inset 3px 0 0 ${s.fg}`,
                        rowGap: 8,
                        // The invoice last opened, so the eye lands back on it.
                        background: focus && focus === String(r.vch_no) ? '#F3FBE2' : undefined
                      }}
                    >
                      <span className="flex min-w-0 flex-col pt-px">
                        {onOpenVoucher && r.books?.id ? (
                          <button
                            type="button"
                            onClick={() => openVoucher(r)}
                            title={
                              r.books?.sale_id
                                ? `Open ${String(r.vch_no)} on the Sales page — Back brings you here`
                                : `Open voucher ${String(r.vch_no)} — Esc brings you back here`
                            }
                            className="group flex min-w-0 items-center gap-1 text-left text-[12.5px] font-extrabold tabular-nums text-[#0B6B45] hover:underline"
                          >
                            <span className="truncate">{String(r.vch_no)}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
                          </button>
                        ) : (
                          <span className="truncate text-[12.5px] font-extrabold tabular-nums text-[#0A1F17]" title={String(r.vch_no)}>
                            {String(r.vch_no)}
                          </span>
                        )}
                        {dup && <span className="text-[10.5px] font-bold text-[#B3261E]">{Number(dup.books)} vouchers here</span>}
                      </span>
                      {cell(r, 'date', 'date')}
                      <span className="flex min-w-0 flex-col gap-0.5 pr-3">
                        <span className="truncate text-[12.5px] font-bold text-[#0A1F17]" title={String((r.tally || r.books).party || '')}>
                          {String((r.tally || r.books).party || '—')}
                        </span>
                        {pd && (
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[11px] font-bold text-[#8C2F26]" title={String(pd.books)}>
                              <span className="mr-1 text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]">Here</span>
                              {String(pd.books)}
                            </span>
                            {r.books?.party_is_creditor ? (
                              <span
                                title="This sale was posted to a supplier's ledger. Fix it from Settings → Accounting checks → Customers and suppliers sharing a ledger — do not link it."
                                style={chip('#B3261E', '#FDF3F2', '#F0D6D4')}
                              >
                                Supplier ledger
                              </span>
                            ) : (
                              <button
                                type="button"
                                title="These are the same party — remember it, for this check and every Tally import after"
                                onClick={() => void sameParty(r)}
                                className="flex shrink-0 items-center gap-0.5 rounded-[3px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 text-[10px] font-extrabold text-[#1B4E82]"
                              >
                                <Link2 className="h-3 w-3" /> Same party
                              </button>
                            )}
                          </span>
                        )}
                      </span>
                      {cell(r, 'qty', 'qty')}
                      {cell(r, 'taxable', 'money')}
                      {cell(r, 'gst', 'money')}
                      {cell(r, 'gross', 'money')}
                      <span className="flex flex-wrap content-start items-center gap-1 pl-4">
                        <span title={s.tip} style={chip(s.fg, s.bg, s.bd)}>
                          {s.label}
                        </span>
                        {(r.diffs as Row[])
                          .filter((d) => d.field !== 'party' && d.field !== 'duplicate')
                          .map((d) => (
                            <span key={d.field} style={chip('#B3261E', '#fff', '#F0D6D4')}>
                              {FIELD[d.field] || d.field}
                            </span>
                          ))}
                      </span>
                      {/* What this line means, in words — and what to do about it. */}
                      {(said.length > 0 || !!r.fix) && (
                        <div
                          className="min-w-0 rounded-r-[4px] border border-l-[3px] border-[#E4ECE3] bg-[#F8FAF7] px-3 py-2"
                          style={{ gridColumn: '2 / -1', borderLeftColor: quiet ? '#DCE7DB' : s.fg }}
                        >
                          {said.length > 0 && (
                            <p className="text-[11.5px] font-semibold leading-relaxed text-[#33473E]">{said.join(' ')}</p>
                          )}
                          {!!r.fix && (
                            <p
                              className="mt-1 flex items-start gap-1.5 text-[11.5px] font-extrabold leading-relaxed"
                              style={{ color: quiet ? '#5A6B62' : '#0B3D2E' }}
                            >
                              <ArrowRight className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                              <span>
                                <span className="mr-1 text-[9.5px] uppercase tracking-[.1em] opacity-70">What to do</span>
                                {String(r.fix)}
                              </span>
                            </p>
                          )}
                          {canBook(r) && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setBookVch([String(r.vch_no)])}
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-white px-2.5 text-[11px] font-extrabold text-[#8A5300] hover:bg-[#FFF8E9]"
                              >
                                <FilePlus2 className="h-3.5 w-3.5" /> Book from Tally
                              </button>
                            </div>
                          )}
                          {canRedate(r) && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {dateAsk === `${String(r.vch_no)}-${i}` ? (
                                <>
                                  <span className="text-[11.5px] font-bold text-[#0A1F17]">
                                    Move {String(r.vch_no)} from {formatDate(String(r.books.date))} to {formatDate(String(r.tally.date))}? The voucher
                                    keeps its number; no amount changes.
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setDateAsk(null)}
                                    className="h-7 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#33473E]"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={fixing}
                                    onClick={() => void useTallyDate([r])}
                                    className="h-7 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F] disabled:opacity-60"
                                  >
                                    {fixing ? 'Re-dating…' : 'Re-date'}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={fixing}
                                  onClick={() => setDateAsk(`${String(r.vch_no)}-${i}`)}
                                  className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#BFE3CB] bg-white px-2.5 text-[11px] font-extrabold text-[#0B6B45] hover:bg-[#F4FBF6] disabled:opacity-60"
                                >
                                  <CalendarCheck className="h-3.5 w-3.5" /> Use Tally&rsquo;s date · {formatDate(String(r.tally.date))}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </>
      )}
      <TallyBookVouchers
        kind="sales"
        keys={bookVch}
        pool={bookable.map((r) => String(r.vch_no))}
        readAll={rows.filter(canBook).map((r) => String(r.vch_no))}
        companyId={companyId}
        b64={file?.b64 || ''}
        fileName={file?.name || ''}
        accounts={accounts}
        groupNames={groupNames}
        onClose={() => setBookVch(null)}
        onChanged={onChanged}
        onBooked={async () => {
          setBatchTick((x) => x + 1)
          if (file) await run(file, savedAt || undefined)
        }}
      />
    </div>
  )
}
