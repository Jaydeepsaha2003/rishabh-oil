import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, CalendarCheck, ExternalLink, FilePlus2, Layers, Link2, RefreshCw, Search, Undo2, Unlink, Upload } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { TallyBookVouchers } from '@/components/TallyBookVouchers'
import { TallyBatches } from '@/components/TallyBatches'
import { draftTime } from '@/components/TallySalesCheck'
import { ColumnFilter } from '@/components/ui/column-filter'
import { useColumnFilters, type ColumnSpec } from '@/lib/useColumnFilters'
import { orderVoucherLines, TAX_NAME } from '@/lib/voucherOrder'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
export type RegisterKind = 'journal' | 'purchase'

// JOURNAL / PURCHASE REGISTER CHECK — Tally's register laid against these
// books, voucher by voucher, the way the Sales Register check is: which agree,
// which differ (in which figure, by how much), which only one side has, which
// Tally cancelled — and, new here, which LOOK LIKE a voucher already in these
// books under another number or type (a POSSIBLE MATCH), so nothing the
// software posted itself is booked a second time. What is missing is booked
// from the file in the same dialog as the sales: tick, map once, Ctrl+A.

const STATUS: Record<string, { label: string; fg: string; bg: string; bd: string; tip: string }> = {
  matched: { label: 'Matched', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', tip: 'Tally and these books agree' },
  mismatch: { label: 'Not matching', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'In both, but something differs' },
  possible: { label: 'Possible match', fg: '#7A4B00', bg: '#FFF6E0', bd: '#EBCB86', tip: 'Looks like a voucher already here under another number or type' },
  missing_here: { label: 'Missing here', fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', tip: 'In Tally, not in these books' },
  missing_tally: { label: 'Not in Tally', fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', tip: 'In these books for the period, not in Tally' },
  cancelled: { label: 'Cancelled in Tally', fg: '#5A6B62', bg: '#EEF3EC', bd: '#DCE7DB', tip: 'Tally shows it cancelled, and it is not here either' },
  cancelled_here: { label: 'Cancelled · here', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'Tally cancelled it, but these books still carry it' }
}
const FIELD: Record<string, string> = {
  date: 'Date',
  party: 'Supplier',
  type: 'Register',
  taxable: 'Taxable',
  gst: 'GST',
  tds: 'TDS',
  gross: 'Total',
  lines: 'Lines',
  duplicate: 'Entered twice here',
  copy: 'Booked twice'
}
const COPY: Record<RegisterKind, { name: string; upload: string; how: string; what: string; whats: string }> = {
  journal: {
    name: 'Journal Register',
    upload: 'Choose or drop the Tally Journal Register (.xlsx)',
    how: 'Tally → Display → Account Books → Journal Register → Columnar → Export as Excel. Nothing is posted — this only compares.',
    what: 'journal',
    whats: 'journals'
  },
  purchase: {
    name: 'Purchase Register',
    upload: 'Choose or drop the Tally Purchase Registers (.xlsx)',
    how: 'Tally → Display → Account Books → Purchase Register → each purchase type → Columnar → Export as Excel. One workbook with a sheet per type is read whole. Nothing is posted — this only compares.',
    what: 'purchase',
    whats: 'purchases'
  }
}

function chip(fg: string, bg: string, bd: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: fg, background: bg, border: `1px solid ${bd}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }
}

// WHERE THE DESK WAS, kept across a trip to a voucher and back, per register.
const kept: Record<RegisterKind, { filter: string; q: string; focus: string; reg: string; cols: Record<string, string[]> }> = {
  journal: { filter: 'problems', q: '', focus: '', reg: '', cols: {} },
  purchase: { filter: 'problems', q: '', focus: '', reg: '', cols: {} }
}

type VLine = { name: string; dr: number; cr: number }
const ordered = (ls: VLine[]): VLine[] =>
  orderVoucherLines(ls || [], (l) => ({ account: l.name, dr: Number(l.dr) > 0, tax: TAX_NAME.test(l.name), amount: Number(l.dr) || Number(l.cr) }))

/** A voucher written out the way it is read — Dr first, then Cr, each biggest first. */
function MiniVoucher({ title, sub, lines, tone }: { title: string; sub?: string; lines: VLine[]; tone: 'tally' | 'books' }): React.JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded-[5px] border border-[#E4ECE3] bg-white">
      <div className="flex items-center gap-2 border-b border-[#EEF3ED] px-3 py-1.5" style={{ background: tone === 'tally' ? '#F4F7FC' : '#F6FAF5' }}>
        <span className="text-[9.5px] font-extrabold uppercase tracking-[.12em]" style={{ color: tone === 'tally' ? '#1B4E82' : '#0B6B45' }}>
          {title}
        </span>
        {sub && <span className="min-w-0 truncate text-[10.5px] font-bold text-[#5A6B62]">{sub}</span>}
      </div>
      {ordered(lines).map((l, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-[#F2F6F1] px-3 py-1 last:border-b-0">
          <span className="w-5 text-[10.5px] font-extrabold" style={{ color: Number(l.dr) > 0 ? '#1B4E82' : '#B3261E' }}>
            {Number(l.dr) > 0 ? 'Dr' : 'Cr'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-[#0A1F17]" title={l.name}>
            {l.name}
          </span>
          <span className="text-[11.5px] font-bold tabular-nums text-[#0A1F17]">{formatINR(Number(l.dr) || Number(l.cr) || 0)}</span>
        </div>
      ))}
    </div>
  )
}

export function TallyRegisterCheck({
  kind,
  companyName,
  companyId,
  accounts = [],
  groupNames = [],
  onChanged = () => {},
  onOpenVoucher
}: {
  kind: RegisterKind
  companyName: string
  /** The company Accounting is in — the check and its draft are this one's. */
  companyId?: number
  accounts?: Row[]
  groupNames?: Row[]
  onChanged?: () => void
  /** Open a voucher here; Esc / Back comes here. */
  /** orderId: the purchase behind the voucher — opened on the Purchases page rather than as a voucher. */
  onOpenVoucher?: (entryId: number, orderId?: number) => void
}): React.JSX.Element {
  const copy = COPY[kind]
  const keep = kept[kind]
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null)
  const [res, setRes] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<string>(keep.filter)
  const [q, setQ] = useState(keep.q)
  const [reg, setReg] = useState(keep.reg)
  const [focus, setFocus] = useState(keep.focus)
  const [savedAt, setSavedAt] = useState('')
  const [bookKeys, setBookKeys] = useState<string[] | null>(null)
  // "Use Tally's date": the line being confirmed, the bulk confirm, and a run.
  const [dateAsk, setDateAsk] = useState<string | null>(null)
  const [allAsk, setAllAsk] = useState(false)
  const [fixing, setFixing] = useState(false)
  // Bumped after a booking, so the list of bookings reads again.
  const [batchTick, setBatchTick] = useState(0)
  useEffect(() => {
    keep.filter = filter
    keep.q = q
    keep.reg = reg
  }, [filter, q, reg, keep])
  const fileRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0
  }, [filter, q, reg])
  const scrolledTo = useRef('')
  useEffect(() => {
    if (!res) {
      scrolledTo.current = ''
      return
    }
    if (!focus || scrolledTo.current === focus) return
    scrolledTo.current = focus
    setTimeout(() => {
      const el = tableRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`)
      el?.scrollIntoView({ block: 'center' })
    })
  }, [res, focus])

  const companyNow = useRef(companyId)
  companyNow.current = companyId

  // HOW MANY RUPEES APART STILL READS AS THE SAME. A supplier's printed bill
  // and quantity × rate here can part by a few rupees of rounding; the desk
  // picks how much to let go. Remembered on this computer.
  const TOL_KEY = `rishabhoil.tallyTol.${kind}`
  const [tol, setTol] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(TOL_KEY)) || 1
    } catch {
      return 1
    }
  })
  const tolRef = useRef(tol)
  tolRef.current = tol

  async function run(f: { name: string; b64: string }, fromDraft?: string): Promise<void> {
    const forCompany = companyId
    setBusy(true)
    try {
      const checked = await window.api.tallyNotes.registerCheck({ kind, company_id: forCompany, data_base64: f.b64, file_name: f.name, tolerance: tolRef.current })
      if (companyNow.current !== forCompany) return
      setRes(checked)
      setFile(f)
      if (fromDraft) setSavedAt(fromDraft)
      else {
        const s = await window.api.tallyNotes.saveDraft({ company_id: forCompany, kind, file_name: f.name, data_base64: f.b64 })
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
    if (!companyId) return
    void window.api.tallyNotes
      .drafts({ company_id: companyId })
      .then((ds) => {
        const d = (ds as Row[]).find((x) => x.kind === kind)
        if (live && d) void run({ name: String(d.file_name || ''), b64: String(d.data_base64) }, String(d.saved_at || ''))
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, kind])

  async function clearCheck(): Promise<void> {
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind }).catch(() => {})
    setRes(null)
    setFile(null)
    setSavedAt('')
    setReg('')
    toast.success(`${copy.name} check cleared`)
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

  // Move the voucher here to the date Tally has — Tally is where the bill was
  // entered. The server says what moved (a whole bill, or one voucher) and
  // refuses what another document owns.
  async function useTallyDate(list: Row[]): Promise<void> {
    if (!file || !list.length) return
    setFixing(true)
    let done = 0
    const failed: string[] = []
    const seen = new Set<number>()
    for (const r of list) {
      const id = Number(r.books?.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      try {
        await window.api.tallyNotes.fixRegisterDate({ company_id: companyId, entry_id: id, date: String(r.tally.date) })
        done++
      } catch (e) {
        failed.push(`${String(r.tally?.ref_no || r.tally?.vch_no || r.books?.code)}: ${(e as Error).message}`)
      }
    }
    setDateAsk(null)
    setAllAsk(false)
    if (done) {
      toast.success(
        done === 1 && list.length === 1
          ? `${String(list[0].books?.code || 'Voucher')} moved to ${formatDate(String(list[0].tally.date))}`
          : `${done} ${done === 1 ? copy.what : copy.whats} moved to Tally's date`
      )
      onChanged()
    }
    for (const f of failed.slice(0, 4)) toast.error(f)
    if (failed.length > 4) toast.error(`${failed.length - 4} more could not be moved`)
    await run(file, savedAt || undefined)
    setFixing(false)
  }

  // BOOKED TWICE — a journal booked from Tally that a document's own voucher
  // (a discounted bill's opening, say) already carries. The copy is deleted
  // through the ordinary voucher delete; the document's voucher stays and
  // stands for Tally's journals on the next check.
  async function reverseCopies(list: Row[]): Promise<void> {
    if (!file || !list.length) return
    const ids = [...new Set(list.map((r) => Number(r.books?.id)).filter(Boolean))]
    const codes = list.map((r) => String(r.books?.code || '')).filter(Boolean)
    const total = list.reduce((t, r) => t + (Number(r.books?.total) || 0), 0)
    if (
      !window.confirm(
        `Reverse ${ids.length === 1 ? codes[0] : `${ids.length} copies (${codes.join(', ')})`} — ${formatINR(total)} booked from Tally a second time?

The document vouchers (${[...new Set(list.map((r) => String(r.copy_of?.code || '')))].join(', ')}) stay, and match Tally's journals instead.`
      )
    )
      return
    setFixing(true)
    let done = 0
    for (const id of ids) {
      try {
        await window.api.vouchers.remove(id)
        done++
      } catch (e) {
        toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    }
    if (done) {
      toast.success(done === 1 ? `${codes[0]} reversed` : `${done} copies reversed`)
      onChanged()
    }
    await run(file, savedAt || undefined)
    setFixing(false)
  }

  // "Same entry — remember": a possible match the desk has looked at is the
  // same voucher; from now on it pairs straight away, in every file.
  async function linkSame(r: Row, on: boolean): Promise<void> {
    if (!file) return
    try {
      if (on) await window.api.tallyNotes.link({ company_id: companyId, scope: kind, tally_key: String(r.key), entry_id: Number(r.books.id) })
      else await window.api.tallyNotes.unlink({ company_id: companyId, scope: kind, tally_key: String(r.key) })
      toast.success(on ? `Remembered: ${String(r.tally?.vch_no || '')} is ${String(r.books?.code || 'that voucher')}` : 'Link removed')
      await run(file, savedAt || undefined)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function openHere(r: Row): void {
    if (!onOpenVoucher || !r.books?.id) return
    keep.focus = String(r.key)
    setFocus(keep.focus)
    // A purchase opens where it is kept — the Purchases page — the way a
    // ledger's bill-wise line does; only a voucher with no purchase behind it
    // (booked from Tally, keyed by hand) opens as the voucher.
    const orderId = kind === 'purchase' ? Number(r.books.order_id) || 0 : 0
    onOpenVoucher(Number(r.books.id), orderId || undefined)
  }

  const rows: Row[] = useMemo(() => res?.rows || [], [res])
  const side = (r: Row): Row => r.tally || r.books || {}
  const amountOf = (x: Row | null | undefined): number => (x ? Number(kind === 'journal' ? x.total : x.gross) || 0 : 0)
  // THE REGISTER PICKED IS WHAT EVERY FIGURE DESCRIBES. Pick PURCHASE OIL and
  // the totals, the status cards, the tab counts and the bulk buttons all
  // count PURCHASE OIL — not the whole workbook while the list shows two rows.
  const inReg = useCallback(
    (r: Row): boolean =>
      !reg ||
      (r.reg_type != null
        ? String(r.reg_type) === reg
        : String(r.tally?.type || '') === reg || (!!r.books && !r.tally && String(r.books.type || '').toUpperCase().includes(reg.toUpperCase()))),
    [reg]
  )
  const regRows: Row[] = useMemo(() => rows.filter(inReg), [rows, inReg])
  const tabbed = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return regRows.filter((r) => {
      if (filter === 'problems' && (r.status === 'matched' || r.status === 'cancelled')) return false
      if (filter !== 'problems' && filter !== 'all' && r.status !== filter) return false
      if (!needle) return true
      const hay = [r.tally?.vch_no, r.tally?.ref_no, r.tally?.party, r.books?.code, r.books?.vch_no, r.books?.party, ...((r.tally?.lines || r.books?.lines || []) as Row[]).map((l) => l.name)]
      return hay.some((x) => String(x || '').toLowerCase().includes(needle))
    })
  }, [regRows, filter, q])

  const money = (f: string): ColumnSpec<Row> => ({
    get: (r) => {
      const v = side(r)[f]
      return v == null || v === '' ? '' : String(Math.round(Number(v) * 100) / 100)
    },
    label: (v) => (v === '' ? '(blank)' : formatINR(Number(v))),
    numeric: true
  })
  const statusSpec: ColumnSpec<Row> = {
    get: (r) => {
      const s = STATUS[String(r.status)]?.label || String(r.status)
      const what = ((r.diffs as Row[]) || []).map((d) => FIELD[d.field] || d.field)
      return what.length ? `${s} · ${what.join(', ')}` : s
    }
  }
  const colSpecs: Record<string, ColumnSpec<Row>> =
    kind === 'purchase'
      ? {
          bill: { get: (r) => String(r.tally?.ref_no || r.tally?.vch_no || r.books?.vch_no || '') },
          date: { get: (r) => String(side(r).date || '').slice(0, 10), label: (v) => (v ? formatDate(v) : '(blank)') },
          party: { get: (r) => String(side(r).party || '') },
          register: { get: (r) => String(r.tally?.type || r.books?.type || '') },
          taxable: money('taxable'),
          gst: money('gst'),
          tds: money('tds'),
          gross: money('gross'),
          status: statusSpec
        }
      : {
          no: { get: (r) => String(r.tally?.vch_no || r.books?.code || '') },
          date: { get: (r) => String(side(r).date || '').slice(0, 10), label: (v) => (v ? formatDate(v) : '(blank)') },
          // Each ledger its own tick: pick DCM and every journal touching it
          // stays, whatever else is on it.
          ledger: {
            get: (r) => [...new Set(((side(r).lines as Row[]) || []).map((l) => String(l.name)))].join(' · '),
            many: (r) => [...new Set(((side(r).lines as Row[]) || []).map((l) => String(l.name)))]
          },
          total: money('total'),
          status: statusSpec
        }
  const cf = useColumnFilters(tabbed, colSpecs, keep.cols)
  useEffect(() => {
    keep.cols = cf.selected
  }, [cf.selected, keep])
  const shown = cf.filtered

  const c: Row = reg
    ? regRows.reduce((m: Row, r) => ({ ...m, [String(r.status)]: (Number(m[String(r.status)]) || 0) + 1 }), {})
    : res?.counts || {}
  const totals = reg
    ? {
        tally: Math.round(regRows.filter((r) => r.tally && !r.tally.cancelled).reduce((s, r) => s + amountOf(r.tally), 0) * 100) / 100,
        books: Math.round(regRows.filter((r) => r.books && r.status !== 'cancelled_here').reduce((s, r) => s + amountOf(r.books), 0) * 100) / 100
      }
    : { tally: Number(res?.totals?.tally) || 0, books: Number(res?.totals?.books) || 0 }
  // Narrowed by a search, a column filter (or In / Out) — then "Book
  // missing" offers only what is on screen, e.g. one party's entries.
  const narrowed = !!q.trim() || cf.activeCount > 0
  const bookable = (narrowed ? shown : regRows).filter((r) => r.bookable)
  const missingBookable = bookable.filter((r) => r.status === 'missing_here')
  const copies = (narrowed ? shown : regRows).filter((r) => r.copy_of && r.books?.id)
  const redatable = regRows.filter((r) => r.redate === 'yes')
  const problems = (c.mismatch || 0) + (c.possible || 0) + (c.missing_here || 0) + (c.missing_tally || 0) + (c.cancelled_here || 0)
  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const diffOf = (r: Row, f: string): Row | undefined => ((r.diffs as Row[]) || []).find((d) => d.field === f)
  const GRID =
    kind === 'purchase'
      ? 'minmax(150px,1fr) 104px minmax(220px,1.7fr) 150px 128px 112px 100px 136px 172px'
      : '104px 104px minmax(400px,2.6fr) 150px 172px'
  const minW = kind === 'purchase' ? 1340 : 1080

  // One figure: Tally's, and — only where they differ — what these books have.
  const cell = (r: Row, f: string, how: 'money' | 'date'): React.JSX.Element => {
    const t = r.tally
    const b = r.books
    const fmt = (v: unknown): string => (v == null || v === '' ? '—' : how === 'money' ? formatINR(Number(v) || 0) : formatDate(String(v)))
    const d = diffOf(r, f)
    const right = how === 'money'
    const align = right ? 'items-end text-right' : 'items-start'
    if (!t || !b) {
      return (
        <span className={`flex min-w-0 flex-col ${align}`}>
          <span className="whitespace-nowrap text-[12.5px] font-semibold tabular-nums text-[#33473E]">{fmt(t ? t[f] : b?.[f])}</span>
          <span className="text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8CA396]">{t ? 'Tally only' : 'Here only'}</span>
        </span>
      )
    }
    const shift = r.status === 'possible' && Math.abs((Number(t[f]) || 0) - (Number(b[f]) || 0)) > 1 && how === 'money'
    return (
      <span className={`flex min-w-0 flex-col ${align}`}>
        <span className={`whitespace-nowrap text-[12.5px] tabular-nums text-[#0A1F17] ${d ? 'font-extrabold' : 'font-semibold'}`}>{fmt(t[f])}</span>
        {(d || shift || (r.status === 'possible' && how === 'date' && t.date !== b.date)) && (
          <>
            <span className="whitespace-nowrap text-[11px] font-bold tabular-nums text-[#8C2F26]" title="What these books have">
              <span className="mr-1 text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]">Here</span>
              {fmt(b[f])}
            </span>
            {d && typeof d.diff === 'number' && how === 'money' && Math.abs(d.diff) >= 0.005 && (
              <span className="mt-0.5 whitespace-nowrap rounded-[3px] bg-[#FDF3F2] px-1.5 text-[10.5px] font-extrabold tabular-nums text-[#B3261E]">Δ {formatINR(d.diff)}</span>
            )}
          </>
        )}
      </span>
    )
  }

  const sheets: Row[] = (res?.sheets as Row[]) || []
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
              <span className="block text-[13px] font-extrabold text-[#0A1F17]">{busy ? 'Checking…' : file ? file.name : copy.upload}</span>
              <span className="block text-[11.5px] font-semibold text-[#5A6B62]">{copy.how}</span>
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
              <span className="flex flex-wrap items-center gap-1.5" title="Figures this many rupees apart or closer read as the same — rounding between the supplier's bill and quantity × rate here">
                <span className="text-[11px] font-bold text-[#5A6B62]">Rounding allowed</span>
                {[1, 10, 50].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setTol(v)
                      tolRef.current = v
                      try {
                        localStorage.setItem(TOL_KEY, String(v))
                      } catch {
                        /* a private window keeps it for this visit only */
                      }
                      if (file) void run(file, savedAt || undefined)
                    }}
                    className="h-6 rounded-[3px] border px-2 text-[11px] font-extrabold"
                    style={tol === v ? { background: '#0B3D2E', color: '#fff', borderColor: '#0B3D2E' } : { background: '#fff', color: '#33473E', borderColor: '#D6E2D6' }}
                  >
                    ₹{v}
                  </button>
                ))}
              </span>
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
          {/* Where the two books stand — the money first, then each kind of line; a count is a filter. */}
          <section className={`${card} shrink-0`}>
            <div className="grid grid-cols-1 divide-y divide-[#E4ECE3] md:grid-cols-[1.15fr_2.3fr] md:divide-x md:divide-y-0">
              <div className="grid grid-cols-3 gap-3 px-4 py-3">
                {[
                  { k: reg ? `Tally · ${reg}` : 'Tally', v: totals.tally, tone: '#0A1F17' },
                  { k: 'Here', v: totals.books, tone: '#0A1F17' },
                  {
                    k: 'Difference',
                    v: Math.round((totals.tally - totals.books) * 100) / 100,
                    tone: Math.abs(totals.tally - totals.books) > 1 ? '#B3261E' : '#0B6B45'
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
              <div className="grid grid-cols-4 sm:grid-cols-7">
                {(['matched', 'mismatch', 'possible', 'missing_here', 'missing_tally', 'cancelled', 'cancelled_here'] as const).map((k) => {
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
            {/* The registers the workbook held — each one a filter; one read
                elsewhere (a sales register) says so and why. */}
            {kind === 'purchase' && sheets.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-[#E4ECE3] bg-[#FBFCFA] px-4 py-2.5">
                <Layers className="mr-1 h-3.5 w-3.5 text-[#5A6B62]" />
                <button
                  type="button"
                  onClick={() => setReg('')}
                  className="h-7 rounded-[4px] border px-2.5 text-[11px] font-extrabold"
                  style={!reg ? { background: '#0B3D2E', color: '#fff', borderColor: '#0B3D2E' } : { background: '#fff', color: '#33473E', borderColor: '#D6E2D6' }}
                >
                  Every register
                </button>
                {sheets.map((s) =>
                  s.skipped ? (
                    <span key={String(s.title)} title={String(s.skipped)} className="flex h-7 items-center gap-1 rounded-[4px] border border-dashed border-[#D6E2D6] px-2.5 text-[11px] font-bold text-[#8CA396] line-through decoration-[#C3D2C6]">
                      {String(s.type || s.title)}
                    </span>
                  ) : (
                    <button
                      key={String(s.title)}
                      type="button"
                      onClick={() => setReg(reg === s.type ? '' : String(s.type))}
                      title={s.route ? `${String(s.type)} is entered on its own page, not booked from here` : `${Number(s.count)} vouchers in Tally`}
                      className="flex h-7 items-center gap-1.5 rounded-[4px] border px-2.5 text-[11px] font-extrabold"
                      style={reg === s.type ? { background: '#0B3D2E', color: '#fff', borderColor: '#0B3D2E' } : { background: '#fff', color: '#33473E', borderColor: '#D6E2D6' }}
                    >
                      {String(s.type)}
                      <span className="tabular-nums opacity-70">{Number(s.count)}</span>
                      {Number(s.missing) > 0 && (
                        <span style={chip('#8A5300', '#FFF4DD', '#F1D9A6')}>{Number(s.missing)} missing</span>
                      )}
                      {s.route && <span style={chip('#5A6B62', '#EEF3EC', '#DCE7DB')}>{s.route === 'purchases' ? 'Purchases page' : 'Freight billing'}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </section>

          <TallyBatches
            companyId={companyId}
            kind={kind}
            scope={kind}
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
                  { k: 'possible', label: 'Possible', n: Number(c.possible || 0) },
                  { k: 'missing_here', label: 'Missing here', n: Number(c.missing_here || 0) },
                  { k: 'missing_tally', label: 'Not in Tally', n: Number(c.missing_tally || 0) },
                  { k: 'all', label: 'All', n: regRows.length }
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
                  placeholder={kind === 'purchase' ? 'Search bill no, supplier or ledger' : 'Search voucher no or ledger'}
                  className="h-8 w-full rounded-[4px] border border-[#D6E2D6] bg-white pl-8 pr-2.5 text-[12px] font-semibold"
                />
              </div>
              {missingBookable.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBookKeys(missingBookable.map((r) => String(r.key)))}
                  title={`Post every ${copy.what} Tally has and these books do not`}
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-[#FFF8E9] px-3 text-[11.5px] font-extrabold text-[#8A5300] hover:bg-[#FFF1D6]"
                >
                  <FilePlus2 className="h-3.5 w-3.5" /> Book missing · {missingBookable.length}
                </button>
              )}
              {copies.length > 1 && (
                <button
                  type="button"
                  disabled={fixing}
                  onClick={() => void reverseCopies(copies)}
                  title="Take back every copy booked from Tally that a document's own voucher already carries"
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F0D6D4] bg-[#FFF5F4] px-3 text-[11.5px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA] disabled:opacity-60"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Reverse copies · {copies.length}
                </button>
              )}
              {redatable.length > 0 && (
                <button
                  type="button"
                  disabled={fixing}
                  onClick={() => setAllAsk(true)}
                  title={`Move every ${copy.what} whose date differs to the date Tally has`}
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
                filename={`tally-${kind}-check-${String(res.from || '')}-${String(res.to || '')}`}
                sheetName={`${copy.what} check`}
                title={`${copy.name} — Tally against the books`}
                subtitle={`${String(res.file_company || '')} · ${String(res.period || '')}`}
                columns={[
                  { header: kind === 'purchase' ? 'Bill no' : 'Voucher no', key: 'no', value: (r: Row) => String(kind === 'purchase' ? r.tally?.ref_no || r.tally?.vch_no || r.books?.vch_no || '' : r.tally?.vch_no || '') },
                  { header: 'Here', key: 'code', value: (r: Row) => String(r.books?.code || '') },
                  ...(kind === 'purchase' ? [{ header: 'Register', key: 'reg', value: (r: Row) => String(r.tally?.type || r.books?.type || '') }] : []),
                  { header: 'Status', key: 'status', value: (r: Row) => STATUS[String(r.status)]?.label || String(r.status) },
                  { header: 'What differs', key: 'diffs', value: (r: Row) => ((r.diffs as Row[]) || []).map((d) => FIELD[d.field] || d.field).join(', ') },
                  { header: 'Explanation', key: 'explain', value: (r: Row) => ((r.explain as string[]) || []).join(' ') },
                  { header: 'What to do', key: 'fix', value: (r: Row) => String(r.fix || '') },
                  { header: 'Date (Tally)', key: 'td', value: (r: Row) => (r.tally ? formatDate(r.tally.date) : '') },
                  { header: 'Date (here)', key: 'bd', value: (r: Row) => (r.books ? formatDate(r.books.date) : '') },
                  { header: kind === 'purchase' ? 'Supplier (Tally)' : 'Particulars (Tally)', key: 'tp', value: (r: Row) => String(r.tally?.party || '') },
                  { header: kind === 'purchase' ? 'Supplier (here)' : 'Lead ledger (here)', key: 'bp', value: (r: Row) => String(r.books?.party || '') },
                  ...(kind === 'purchase'
                    ? [
                        { header: 'Taxable (Tally)', key: 'tt', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.taxable) : '') },
                        { header: 'Taxable (here)', key: 'bt', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.taxable) : '') },
                        { header: 'GST (Tally)', key: 'tg', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.gst) : '') },
                        { header: 'GST (here)', key: 'bg', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.gst) : '') },
                        { header: 'TDS (Tally)', key: 'tx', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.tally ? Number(r.tally.tds) : '') },
                        { header: 'TDS (here)', key: 'bx', align: 'right' as const, numFmt: '#,##0.00', value: (r: Row) => (r.books ? Number(r.books.tds) : '') }
                      ]
                    : []),
                  { header: 'Total (Tally)', key: 'ta', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.tally ? amountOf(r.tally) : '') },
                  { header: 'Total (here)', key: 'ba', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (r.books ? amountOf(r.books) : '') }
                ]}
                rows={shown}
              />
            </div>
            {allAsk && (
              <div className="flex flex-wrap items-center gap-2 border-b border-[#BFE3CB] bg-[#F4FBF6] px-4 py-2.5">
                <CalendarCheck className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                <span className="min-w-0 flex-1 text-[12px] font-bold text-[#0A1F17]">
                  Move {redatable.length} {redatable.length === 1 ? copy.what : copy.whats} to the date Tally has?{' '}
                  {kind === 'purchase'
                    ? 'A purchase moves as a whole bill — every row, its supplier payable and its voucher; tanker and stock dates stay.'
                    : 'Each voucher takes the new date.'}{' '}
                  Vouchers keep their numbers and no amount changes.
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
                  {fixing ? 'Moving…' : `Move ${redatable.length}`}
                </button>
              </div>
            )}
            <div ref={tableRef} className="max-h-[calc(100vh-175px)] min-h-[360px] overflow-auto">
              <div style={{ minWidth: minW }}>
                <div
                  className="sticky top-0 z-10 grid items-end border-b-2 border-[#D6E2D6] bg-[#EEF4ED] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E] shadow-[0_2px_6px_rgba(10,31,23,.06)]"
                  style={{ gridTemplateColumns: GRID }}
                >
                  {kind === 'purchase' ? (
                    <>
                      <span>
                        <ColumnFilter label="Bill" {...cf.props('bill')} />
                      </span>
                      <span>
                        <ColumnFilter label="Date" {...cf.props('date')} />
                      </span>
                      <span>
                        <ColumnFilter label="Supplier" {...cf.props('party')} />
                      </span>
                      <span>
                        <ColumnFilter label="Register" {...cf.props('register')} />
                      </span>
                      <span className="flex justify-end">
                        <ColumnFilter label="Taxable" align="end" {...cf.props('taxable')} />
                      </span>
                      <span className="flex justify-end">
                        <ColumnFilter label="GST" align="end" {...cf.props('gst')} />
                      </span>
                      <span className="flex justify-end">
                        <ColumnFilter label="TDS" align="end" {...cf.props('tds')} />
                      </span>
                      <span className="flex justify-end">
                        <ColumnFilter label="Total" align="end" {...cf.props('gross')} />
                      </span>
                    </>
                  ) : (
                    <>
                      <span>
                        <ColumnFilter label="No." {...cf.props('no')} />
                      </span>
                      <span>
                        <ColumnFilter label="Date" {...cf.props('date')} />
                      </span>
                      <span>
                        <ColumnFilter label="Entries · Dr then Cr" {...cf.props('ledger')} />
                      </span>
                      <span className="flex justify-end">
                        <ColumnFilter label="Amount" align="end" {...cf.props('total')} />
                      </span>
                    </>
                  )}
                  <span className="pl-4">
                    <ColumnFilter label="Status" align="end" {...cf.props('status')} />
                  </span>
                </div>
                {shown.length === 0 && (
                  <div className="px-4 py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">
                    {cf.activeCount > 0
                      ? `No ${copy.what} passes the column filters — clear them to see more.`
                      : q.trim()
                        ? `No ${copy.what} matches that search.`
                        : filter === 'problems'
                          ? `Nothing to look at — every ${copy.what} agrees with Tally.`
                          : 'Nothing to show for this filter.'}
                  </div>
                )}
                {shown.map((r, i) => {
                  const s = STATUS[String(r.status)] || STATUS.matched
                  const t = r.tally as Row | null
                  const b = r.books as Row | null
                  const pd = diffOf(r, 'party')
                  const dup = diffOf(r, 'duplicate')
                  const said = (r.explain as string[]) || []
                  const quiet = r.status === 'matched' || r.status === 'cancelled'
                  const twoSides = !!t && !!b && (r.status === 'possible' || (r.status === 'mismatch' && (kind === 'journal' || !!diffOf(r, 'lines'))))
                  const lead = t || b || {}
                  const vlines = ordered(((lead.lines as Row[]) || []) as VLine[])
                  return (
                    <div
                      key={`${String(r.key)}-${i}`}
                      data-key={String(r.key)}
                      className="grid border-b border-[#E4ECE3] px-4 py-2.5 transition-colors hover:bg-[#F7FBF6]"
                      style={{
                        gridTemplateColumns: GRID,
                        boxShadow: `inset 3px 0 0 ${s.fg}`,
                        rowGap: 8,
                        background: focus && focus === String(r.key) ? '#F3FBE2' : undefined
                      }}
                    >
                      {/* The voucher: Tally's number, and the one here when there is one. */}
                      <span className="flex min-w-0 flex-col pt-px">
                        <span className="truncate text-[12.5px] font-extrabold tabular-nums text-[#0A1F17]" title={String(kind === 'purchase' ? t?.ref_no || t?.vch_no || b?.vch_no || '' : t?.vch_no || '')}>
                          {kind === 'purchase' ? String(t?.ref_no || t?.vch_no || b?.vch_no || '—') : t ? String(t.vch_no) : '—'}
                        </span>
                        {kind === 'purchase' && t && <span className="text-[10px] font-bold text-[#8CA396]">No. {String(t.vch_no)}</span>}
                        {b && (
                          onOpenVoucher ? (
                            <button
                              type="button"
                              onClick={() => openHere(r)}
                              title={
                                kind === 'purchase' && Number(b.order_id) > 0
                                  ? `Open this purchase on the Purchases page — Back brings you here`
                                  : `Open ${String(b.code || 'the voucher')} here — Esc brings you back`
                              }
                              className="group flex min-w-0 items-center gap-1 text-left text-[11px] font-extrabold tabular-nums text-[#0B6B45] hover:underline"
                            >
                              <span className="truncate">{String(b.code || b.type)}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
                            </button>
                          ) : (
                            <span className="truncate text-[11px] font-bold text-[#0B6B45]">{String(b.code || b.type)}</span>
                          )
                        )}
                        {dup && <span className="text-[10.5px] font-bold text-[#B3261E]">{Number(dup.books)} vouchers here</span>}
                      </span>
                      {cell(r, 'date', 'date')}
                      {kind === 'purchase' ? (
                        <>
                          <span className="flex min-w-0 flex-col gap-0.5 pr-3">
                            <span className="truncate text-[12.5px] font-bold text-[#0A1F17]" title={String(lead.party || '')}>
                              {String(lead.party || '—')}
                            </span>
                            {(pd || (r.status === 'possible' && t && b && String(t.party).toUpperCase() !== String(b.party).toUpperCase())) && (
                              <span className="truncate text-[11px] font-bold text-[#8C2F26]" title={String(b?.party || '')}>
                                <span className="mr-1 text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#B3261E]">Here</span>
                                {String(b?.party || '')}
                              </span>
                            )}
                          </span>
                          <span className="flex min-w-0 flex-col gap-0.5 pr-2">
                            <span className="truncate text-[11.5px] font-bold text-[#33473E]" title={String(t?.type || b?.type || '')}>
                              {String(t?.type || b?.type || '—')}
                            </span>
                            {diffOf(r, 'type') && (
                              <span className="truncate text-[10.5px] font-bold text-[#8C2F26]">
                                <span className="mr-1 text-[9.5px] font-extrabold uppercase text-[#B3261E]">Here</span>
                                {String(b?.type || '')}
                              </span>
                            )}
                          </span>
                          {cell(r, 'taxable', 'money')}
                          {cell(r, 'gst', 'money')}
                          {cell(r, 'tds', 'money')}
                          {cell(r, 'gross', 'money')}
                        </>
                      ) : (
                        <>
                          <span className="grid min-w-0 content-start gap-[3px] pr-4">
                            {vlines.slice(0, 4).map((l, j) => (
                              <span key={j} className="flex min-w-0 items-baseline gap-2">
                                <span className="w-5 shrink-0 text-[10px] font-extrabold" style={{ color: Number(l.dr) > 0 ? '#1B4E82' : '#B3261E' }}>
                                  {Number(l.dr) > 0 ? 'Dr' : 'Cr'}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#0A1F17]" title={l.name}>
                                  {l.name}
                                </span>
                                <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-[#33473E]">{formatINR(Number(l.dr) || Number(l.cr) || 0)}</span>
                              </span>
                            ))}
                            {vlines.length > 4 && <span className="pl-7 text-[10.5px] font-bold text-[#8CA396]">+{vlines.length - 4} more lines</span>}
                            {!t && <span className="pl-7 text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8CA396]">Here only</span>}
                          </span>
                          {cell(r, 'total', 'money')}
                        </>
                      )}
                      <span className="flex flex-wrap content-start items-center gap-1 pl-4">
                        <span title={s.tip} style={chip(s.fg, s.bg, s.bd)}>
                          {s.label}
                        </span>
                        {((r.diffs as Row[]) || [])
                          .filter((d) => d.field !== 'party' && d.field !== 'duplicate')
                          .map((d) => (
                            <span key={d.field} style={chip('#B3261E', '#fff', '#F0D6D4')}>
                              {FIELD[d.field] || d.field}
                            </span>
                          ))}
                        {r.linked && (
                          <span className="flex items-center gap-1">
                            <span title="You said these are the same voucher" style={chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>
                              Linked
                            </span>
                            <button type="button" title="Forget that these are the same" onClick={() => void linkSame(r, false)} className="text-[#8CA396] hover:text-[#B3261E]">
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        )}
                        {r.part_of && (
                          <span title={`Tally splits ${String(r.part_of.code)} into ${String(r.part_of.parts)} journals`} style={chip('#0B6B45', '#EAF6EF', '#BFE3CB')}>
                            Part of {String(r.part_of.code)}
                          </span>
                        )}
                        {r.route && r.status === 'missing_here' && (
                          <span style={chip('#5A6B62', '#EEF3EC', '#DCE7DB')}>{r.route === 'purchases' ? 'Purchases page' : 'Freight billing'}</span>
                        )}
                      </span>
                      {/* What this line means, in words — and what to do about it. */}
                      {(said.length > 0 || !!r.fix || twoSides) && (
                        <div
                          className="min-w-0 rounded-r-[4px] border border-l-[3px] border-[#E4ECE3] bg-[#F8FAF7] px-3 py-2"
                          style={{ gridColumn: '2 / -1', borderLeftColor: quiet ? '#DCE7DB' : s.fg }}
                        >
                          {said.length > 0 && <p className="text-[11.5px] font-semibold leading-relaxed text-[#33473E]">{said.join(' ')}</p>}
                          {twoSides && t && b && (
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                              <MiniVoucher title="Tally" sub={`${kind === 'purchase' ? String(t.ref_no || t.vch_no) : `No. ${String(t.vch_no)}`} · ${formatDate(String(t.date))}`} lines={t.lines as VLine[]} tone="tally" />
                              <MiniVoucher title="Here" sub={`${String(b.code || b.type)}${b.vch_no ? ` · ${String(b.vch_no)}` : ''} · ${formatDate(String(b.date))}`} lines={b.lines as VLine[]} tone="books" />
                            </div>
                          )}
                          {!!r.fix && (
                            <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] font-extrabold leading-relaxed" style={{ color: quiet ? '#5A6B62' : '#0B3D2E' }}>
                              <ArrowRight className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                              <span>
                                <span className="mr-1 text-[9.5px] uppercase tracking-[.1em] opacity-70">What to do</span>
                                {String(r.fix)}
                              </span>
                            </p>
                          )}
                          {r.copy_of && b && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={fixing}
                                onClick={() => void reverseCopies([r])}
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#F0D6D4] bg-white px-2.5 text-[11px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA] disabled:opacity-60"
                              >
                                <Undo2 className="h-3.5 w-3.5" /> Reverse copy {String(b.code || '')}
                              </button>
                            </div>
                          )}
                          {r.status === 'possible' && b && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void linkSame(r, true)}
                                title="They are the same voucher — remember it, so it shows as Matched in every check after"
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#C6DAF0] bg-white px-2.5 text-[11px] font-extrabold text-[#1B4E82] hover:bg-[#EAF0FA]"
                              >
                                <Link2 className="h-3.5 w-3.5" /> Same entry — remember
                              </button>
                            </div>
                          )}
                          {r.bookable && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => setBookKeys([String(r.key)])}
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-white px-2.5 text-[11px] font-extrabold text-[#8A5300] hover:bg-[#FFF8E9]"
                              >
                                <FilePlus2 className="h-3.5 w-3.5" /> {r.status === 'possible' ? 'It is a different one — book it' : 'Book from Tally'}
                              </button>
                            </div>
                          )}
                          {r.redate === 'yes' && t && b && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {dateAsk === String(r.key) ? (
                                <>
                                  <span className="text-[11.5px] font-bold text-[#0A1F17]">
                                    Move {String(b.code || 'it')} from {formatDate(String(b.date))} to {formatDate(String(t.date))}?{' '}
                                    {kind === 'purchase' && Number(b.order_id) > 0
                                      ? 'The whole bill moves — its rows, supplier payable and voucher; tanker and stock dates stay.'
                                      : 'The voucher keeps its number; no amount changes.'}
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
                                    {fixing ? 'Moving…' : 'Move it'}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={fixing}
                                  onClick={() => setDateAsk(String(r.key))}
                                  className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#BFE3CB] bg-white px-2.5 text-[11px] font-extrabold text-[#0B6B45] hover:bg-[#F4FBF6] disabled:opacity-60"
                                >
                                  <CalendarCheck className="h-3.5 w-3.5" /> Use Tally&rsquo;s date · {formatDate(String(t.date))}
                                </button>
                              )}
                            </div>
                          )}
                          {r.redate === 'owned' && (
                            <p className="mt-1.5 text-[11px] font-semibold text-[#5A6B62]">
                              This voucher was posted by another document (a freight bill, an LC, a discounted bill) — its date is changed there.
                            </p>
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
        kind={kind}
        keys={bookKeys}
        pool={bookable.map((r) => String(r.key))}
        readAll={regRows.filter((r) => r.bookable).map((r) => String(r.key))}
        companyId={companyId}
        b64={file?.b64 || ''}
        fileName={file?.name || ''}
        accounts={accounts}
        groupNames={groupNames}
        onClose={() => setBookKeys(null)}
        onChanged={onChanged}
        onBooked={async () => {
          setBatchTick((x) => x + 1)
          if (file) await run(file, savedAt || undefined)
        }}
      />
    </div>
  )
}
