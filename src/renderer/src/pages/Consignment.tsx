import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, ChevronRight, Clock, Layers, Package, Pencil, Plus, ShoppingCart, Trash2, Unlink } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { MobileBar } from '@/components/MobileBar'
import { SerialNo } from '@/components/SerialNo'
import { useIsMobile } from '@/lib/useIsMobile'
import { ConsignmentOpeningDialog } from '@/components/ConsignmentOpening'
import { ExcelButton } from '@/components/ExcelButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DatePicker } from '@/components/ui/date-picker'
import { InfoTip } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { errText, formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { lotTint } from '@/lib/lotTint'
import { computeMoney } from '@/lib/orderCalc'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'
import { FyPicker } from '@/components/FyPicker'
import { useEntryWindow } from '@/lib/useEntryWindow'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * THE TANKERS OF ONE PRODUCT, GATHERED BY THE CARGO THEY CAME OFF.
 *
 * A party's product can run to twenty-odd tankers, and they are not twenty-odd
 * unrelated arrivals — they are three or four parcels, each a lot at a
 * terminal, delivered a few vehicles at a time. Listed flat, the only way to
 * see what a parcel brought in is to read the lot chip down every line and add
 * the column up by eye, which is exactly the question the register is asked.
 *
 * So the lines gather under the parcel that owns them and each parcel folds.
 * A product carrying ONE parcel (or none labelled yet) is left alone: there is
 * nothing to tell apart, and a heading over a single group is furniture.
 *
 * SN is renumbered down the grouped page rather than carried from the flat
 * order, because it has always been a position on screen and not a stored
 * number — a column reading 1, 2, 3, 7, 8 would look like missing rows.
 */
interface LotGroup {
  key: string
  lot: string
  term: string
  rows: { row: Row; sn: number }[]
  qty: number
  weighed: number
  booked: number
  free: number
  // Taken off `free` by invoices not linked to any tanker (see below).
  untied: number
}

// Weights to three places on every row, so 161.79 and 164.915 line up.
const fmt3 = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })

// `balance` — the parcel's deposited less invoiced. Quantity invoiced without
// a tanker linked (deposited − invoiced < the unlinked tankers) is taken off
// the oldest lots' free first, so the lots add up to the total under them.
function groupByLot(lots: Row[], balance?: number): LotGroup[] {
  const map = new Map<string, LotGroup>()
  for (const row of lots) {
    const lot = String(row.lot_no || '').trim()
    const term = String(row.terminal_no || '').trim()
    const key = `${lot}|${term}`
    let g = map.get(key)
    if (!g) {
      g = { key, lot, term, rows: [], qty: 0, weighed: 0, booked: 0, free: 0, untied: 0 }
      map.set(key, g)
    }
    g.rows.push({ row, sn: 0 })
    g.qty += Number(row.qty) || 0
    g.weighed += Number(row.weighed_qty) || 0
    if (row.order_id != null) g.booked += Number(row.qty) || 0
    else g.free += Number(row.qty) || 0
  }
  const groups = Array.from(map.values())
  if (balance != null) {
    let left = groups.reduce((t, g) => t + g.free, 0) - Math.max(0, balance)
    for (const g of groups) {
      if (left <= 0.0005) break
      const take = Math.min(g.free, left)
      g.free -= take
      g.untied = take
      left -= take
    }
  }
  let sn = 0
  for (const g of groups) for (const r of g.rows) r.sn = ++sn
  return groups
}

// The website's dialog shell: forest header band, pale ground, one field
// height throughout, and a footer that is a bar rather than three buttons
// floating on the body. Written once because this page has two dialogs and
// they are the same shape.
const CS_DIALOG =
  '!gap-0 !overflow-hidden !rounded-[4px] !border-0 !bg-[#F1F5EF] !p-0 [&>button]:!hidden'
// Editing a lot opens against the right edge rather than over the middle of
// the register, so the row it came from stays where it was. Header and footer
// are pinned; only the fields scroll.
const CS_DRAWER =
  '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !w-[min(100vw,560px)] !max-w-none !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-none !border-0 !bg-[#F1F5EF] !p-0 sm:!rounded-none [&>button]:!hidden'
const CS_HEAD = '!block !space-y-0 !bg-[#0B3D2E] !px-5 !py-4 !text-left'
const CS_TITLE = '!mt-1 !text-[19px] !font-bold !tracking-[-0.02em] !text-white'
const CS_BODY =
  '!gap-3.5 !overflow-y-auto !px-5 !py-4 [&_label]:!text-[10.5px] [&_label]:!font-extrabold [&_label]:!uppercase [&_label]:!tracking-[.12em] [&_label]:!text-[#5A6B62] [&_input]:!h-11 [&_input]:!rounded-[4px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[13.5px] [&_input]:!font-bold [&_[data-slot=select-trigger]]:!h-11 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[13.5px] [&_[data-slot=select-trigger]]:!font-bold [&_[data-slot=date-picker]]:!h-11 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13.5px] [&_[data-slot=date-picker]]:!font-bold'
const CS_FOOT = '!flex-wrap !gap-2.5 !border-t !border-t-[#D6E2D6] !bg-white !px-5 !py-3.5'
const CS_BTN =
  '!h-12 !rounded-[4px] !border-[1.5px] !border-[#C3D2C6] !bg-white !px-5 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#33473E] hover:!bg-[#EAF0E9]'
const CS_GO =
  '!h-12 !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-6 !text-[13px] !font-extrabold !uppercase !tracking-[.03em] !text-[#C7F03F] hover:!bg-[#0F4A38]'

function SummaryLine({ label, value, strong }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between py-1 text-sm', strong && 'font-semibold')}>
      <span className={cn(!strong && 'text-muted-foreground')}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function Consignment(): React.JSX.Element {
  // How far back this user may date a new entry. The save is refused either
  // way; greying the days out just stops the form offering one it will reject.
  const minDate = useEntryWindow('consignment')
  // The website gets a phone layout — the register is a wide table no phone can
  // read — with two tabs (gate arrivals, stock) over the same data; every
  // dialog it drives stays mounted below, so nothing here is out of reach.
  const isMobile = useIsMobile()
  const [mTab, setMTab] = useState<'gate' | 'stock'>('gate')
  const [deposits, setDeposits] = useState<Row[]>([])
  const [pending, setPending] = useState<Row[]>([])
  const [summary, setSummary] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [bargains, setBargains] = useState<Row[]>([])
  const [settings, setSettings] = useState<Row>({})
  const [companies, setCompanies] = useState<Row[]>([])
  const [activeCompany, setActiveCompany] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  // Always folded on arrival, never remembered — the register is what the page
  // is for, and a summary that stayed open from last week would push it down.
  const [kpiOpen, setKpiOpen] = useState(false)

  // Period for the register: opening balance before it, deposits/invoices
  // within it — same convention as Stock's own MNC/Consignment tab.
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const ranged = !!(from || to)
  // Alt+F2 broadcasts a period from anywhere.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (globalRangeAppliesTo(globalRange, 'consignment')) { setFrom(globalRange.from); setTo(globalRange.to) }
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  // intake (deposit) dialog
  const [depOpen, setDepOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [depForm, setDepForm] = useState<Row>({})
  // WHICH CARGO A SET OF TANKERS CAME OFF.
  //
  // Each arrival is validated on its own — each is weighed on its own — so the
  // thing they have in common is put back afterwards, over several rows at
  // once. `kin` is what the server thinks belongs with this one and why; the
  // desk decides, which is why nothing here is ticked without being read.
  const [assignFor, setAssignFor] = useState<Row | null>(null)
  const [assignKin, setAssignKin] = useState<Row[]>([])
  const [assignPicked, setAssignPicked] = useState<number[]>([])
  const [assignLot, setAssignLot] = useState('')
  const [assignTerm, setAssignTerm] = useState('')
  const [assignFrom, setAssignFrom] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)

  /**
   * LABELLING TWENTY-TWO TANKERS, WITHOUT TWENTY-TWO DIALOGS.
   *
   * The panel is the right tool for one cargo that arrived on six vehicles:
   * it goes and finds the other five and offers them. It is the wrong tool for
   * the ordinary morning's work, which is a register of arrivals each needing
   * its own lot and terminal typed once — twenty-two openings, twenty-two
   * saves and twenty-two closings to key what is four keystrokes a line.
   *
   * So the cell edits in place. Tab moves lot to terminal, Enter saves and
   * drops onto the NEXT unlabelled row on the same product, Escape leaves. The
   * panel is still one click away for the cargo that spans several tankers,
   * and both write through the same call.
   */
  const [inlineId, setInlineId] = useState(0)
  const [inlineLot, setInlineLot] = useState('')
  const [inlineTerm, setInlineTerm] = useState('')
  const [inlineBusy, setInlineBusy] = useState(false)
  // Set when Enter should land on the next row's lot box once the save and the
  // reload are done. A ref, because the reload replaces every row in between.
  const inlineNext = useRef(0)

  function startInline(d: Row): void {
    setInlineId(Number(d.id))
    setInlineLot(String(d.lot_no || ''))
    setInlineTerm(String(d.terminal_no || ''))
  }

  async function saveInline(row: Row, rows: Row[]): Promise<void> {
    const lot = inlineLot.trim()
    const term = inlineTerm.trim()
    // Nothing typed is not an error — it is somebody moving on. Clearing a
    // label that IS there is a real edit, so that still goes through.
    if (!lot && !term && !row.lot_no && !row.terminal_no) {
      setInlineId(0)
      return
    }
    setInlineBusy(true)
    try {
      await window.api.consignment.assignGroup([Number(row.id)], { lot_no: lot, terminal_no: term })
      // The next arrival on this product that has no label yet. Straight down
      // the column is how the paperwork is read, so it is how this moves.
      const here = rows.findIndex((x) => Number(x.id) === Number(row.id))
      const next = rows.slice(here + 1).find((x) => !x.lot_no && !x.terminal_no && Number(x.is_opening) !== 1)
      inlineNext.current = next ? Number(next.id) : 0
      setInlineId(0)
      await load()
      if (inlineNext.current) {
        const id = inlineNext.current
        inlineNext.current = 0
        setInlineId(id)
        setInlineLot('')
        setInlineTerm('')
      }
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setInlineBusy(false)
    }
  }
  const [depError, setDepError] = useState<string | null>(null)
  const [savingDep, setSavingDep] = useState(false)

  // booking dialog
  const [book, setBook] = useState<Row | null>(null)
  const [bookForm, setBookForm] = useState<Row>({})
  const [bookError, setBookError] = useState<string | null>(null)
  const [savingBook, setSavingBook] = useState(false)

  const load = useCallback(async (background = false) => {
    // Skipped on a live refresh: raising the spinner here is what made the
    // page blink every few seconds. The rows already on screen stay until the
    // new ones arrive. See useLiveRefresh.
    if (!background) setLoading(true)
    const [d, sm, pg, s, p, b, cfg, co, act] = await Promise.all([
      window.api.consignment.list(),
      window.api.consignment.summary(ranged ? { from, to } : undefined),
      window.api.consignment.pending(),
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.bargains.list(undefined, undefined, undefined, 'consignment'),
      window.api.settings.all(),
      window.api.company.list(),
      window.api.company.getActive()
    ])
    setDeposits(d)
    setSummary(sm)
    setPending(pg)
    setSuppliers(s.filter((x) => x.active))
    // Raw, plus anything flagged "Used for both" on the Products page — a
    // traded product is bought in the same way a raw one is.
    setProducts(p.filter((x) => x.active && (x.category === 'raw' || Number(x.use_both) === 1)))
    setBargains(b)
    setSettings(cfg)
    setCompanies(co.filter((x) => x.active))
    setActiveCompany(Number(act?.id) || 0)
    setLoading(false)
  }, [ranged, from, to])

  useEffect(() => {
    load()
  }, [load])
  useLiveRefresh(load)

  const defaultUom = settings.default_uom ?? 'MT'

  // Weighed quantity less the allowed shortage, to 3 decimals.
  function netOfShortage(weighed: unknown, pct: unknown): string {
    const w = Number(weighed) || 0
    const p = Number(pct) || 0
    if (w <= 0) return ''
    return String(Math.round(w * (1 - p / 100) * 1000) / 1000)
  }

  // WHAT THE PARTY ALREADY HELD ON DAY ONE.
  //
  // The form was only on the Stock page's MNC tab, which is where it was built
  // and is not where it is looked for: this page is what somebody opens to set
  // a consignment party up, and it offered one button — Log consignment stock —
  // so an opening of several lots at several terminals read as something the
  // software could not do. Same component, so there is one form and not two.
  const [openingOpen, setOpeningOpen] = useState(false)
  // Which party and product the opening editor opens on, when a row named
  // them. Empty from the page's own button, which is somebody starting fresh.
  const [openingSeed, setOpeningSeed] = useState<{ s?: unknown; p?: unknown }>({})

  /**
   * AN OPENING IS NOT A TANKER, SO IT DOES NOT ASSIGN LIKE ONE.
   *
   * Every other row on this register is one arrival off one lot, and its chip
   * opens the assigner that labels it: one lot, one terminal, that vehicle.
   * The opening row is the whole of what a party held on day one, and that is
   * routinely several parcels at several terminals — it is the one row where
   * the single-lot assigner is the wrong tool, and clicking its chip landed in
   * it anyway, with no way out and nothing on the panel to say so.
   *
   * So the opening row opens the parcel editor instead, on its own party and
   * product. Same dialog the page's Opening stock button opens; it just
   * arrives with the pair already chosen.
   */
  function openLotFor(d: Row): void {
    // A FREE OPENING IS SPLIT; A DRAWN ONE IS ONLY LABELLED.
    //
    // The opening dialog restates what the party held on day one, and it
    // cannot touch a parcel a purchase has already drawn — it skips those
    // rows on purpose (see saveOpeningStock). Sending a drawn slice there
    // opened a dialog that then ignored it, which is how an auto-assigned
    // opening came to look unfixable. Labelling it is a different act and
    // has always been allowed, so that is where a drawn row goes.
    if (Number(d.is_opening) === 1 && d.order_id == null) {
      setOpeningSeed({ s: d.supplier_id, p: d.product_id })
      setOpeningOpen(true)
      return
    }
    startInline(d)
  }

  function openAddDeposit(): void {
    setEditing(null)
    setDepForm({
      supplier_id: '',
      product_id: '',
      qty: '',
      uom: defaultUom,
      deposit_date: todayISO(),
      note: '',
      company_id: String(activeCompany || '')
    })
    setDepError(null)
    setDepOpen(true)
  }

  // Validate a gate arrival into consignment stock: the gateman already logged
  // the vehicle (and its weighment), the accountant confirms whose stock it is.
  function openValidate(g: Row): void {
    setEditing(null)
    setDepForm({
      gate_entry_id: g.id,
      gate_entry_no: g.gate_entry_no,
      tanker_no: g.tanker_no || '',
      // A Direct MNC arrival already named its party at the gate, so validation
      // is only about which oil it is.
      supplier_id: g.supplier_id ? String(g.supplier_id) : '',
      supplier_prefilled: !!g.supplier_id,
      supplier_name: g.supplier_name || '',
      product_id: g.oil_type_id ? String(g.oil_type_id) : '',
      // The gate figure is gross-of-shortage; the stock taken in is net of the
      // allowed shortage, which is how the yard has been noting it by hand.
      weighed_qty: Number(g.received_qty) > 0 ? g.received_qty : '',
      shortage_pct: settings.allowed_shortage_pct ?? '0.2',
      qty:
        Number(g.received_qty) > 0
          ? netOfShortage(g.received_qty, settings.allowed_shortage_pct ?? '0.2')
          : '',
      uom: g.uom || defaultUom,
      deposit_date: g.entry_date ?? todayISO(),
      lot_no: '',
      terminal_no: '',
      note: g.note || '',
      company_id: String(activeCompany || '')
    })
    setDepError(null)
    setDepOpen(true)
  }

  function openEditDeposit(row: Row): void {
    setEditing(row)
    setDepForm({
      supplier_id: String(row.supplier_id ?? ''),
      product_id: String(row.product_id ?? ''),
      qty: row.qty ?? '',
      weighed_qty: row.weighed_qty ?? '',
      shortage_pct: row.shortage_pct ?? '',
      uom: row.uom ?? defaultUom,
      // Without this the field opens blank on a lot that HAS a tanker number,
      // and saving then writes the blank back over it.
      tanker_no: row.tanker_no ?? '',
      deposit_date: row.deposit_date ?? todayISO(),
      lot_no: row.lot_no ?? '',
      terminal_no: row.terminal_no ?? '',
      note: row.note ?? '',
      company_id: String(row.company_id ?? activeCompany ?? '')
    })
    setDepError(null)
    setDepOpen(true)
  }

  async function openAssign(row: Row): Promise<void> {
    setAssignFor(row)
    setAssignKin([])
    setAssignPicked([])
    setAssignLot(String(row.lot_no || ''))
    setAssignTerm(String(row.terminal_no || ''))
    setAssignFrom('')
    try {
      const r = await window.api.consignment.kin(Number(row.id))
      setAssignKin(Array.isArray(r.kin) ? (r.kin as Row[]) : [])
      // Proposed, never applied: the box is filled in so the common case is
      // one click, and it is a text box so the uncommon case is one edit.
      if (!row.lot_no && r.suggested_lot) setAssignLot(String(r.suggested_lot))
      if (!row.terminal_no && r.suggested_terminal) setAssignTerm(String(r.suggested_terminal))
      setAssignFrom(String(r.suggested_from || ''))
    } catch {
      // The panel still works without suggestions — they are a courtesy.
    }
  }

  async function saveAssign(): Promise<void> {
    if (!assignFor) return
    if (!assignLot.trim() && !assignTerm.trim()) {
      toast.error('Give a lot number, a terminal number, or both')
      return
    }
    setAssignBusy(true)
    try {
      const ids = [Number(assignFor.id), ...assignPicked]
      const r = await window.api.consignment.assignGroup(ids, {
        lot_no: assignLot.trim(),
        terminal_no: assignTerm.trim()
      })
      toast.success(
        `${r.updated} tanker${r.updated === 1 ? '' : 's'} on ${[r.lot_no, r.terminal_no].filter(Boolean).join(' · ') || 'no lot'}`
      )
      setAssignFor(null)
      await load()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setAssignBusy(false)
    }
  }

  async function saveDeposit(): Promise<void> {
    if (!depForm.company_id) return setDepError('Choose which company this stock belongs to')
    if (!depForm.supplier_id) return setDepError('Supplier is required')
    if (!depForm.product_id) return setDepError('Product is required')
    if (!depForm.qty || Number(depForm.qty) <= 0) return setDepError('Quantity must be greater than 0')
    setSavingDep(true)
    setDepError(null)
    const payload: Row = {
      supplier_id: Number(depForm.supplier_id),
      product_id: Number(depForm.product_id),
      qty: Number(depForm.qty),
      uom: depForm.uom || defaultUom,
      deposit_date: depForm.deposit_date,
      company_id: Number(depForm.company_id),
      note:
        depForm.note ||
        (Number(depForm.shortage_pct) > 0 && Number(depForm.weighed_qty) > 0
          ? `AFTER ${depForm.shortage_pct}% SHORTAGE`
          : null),
      gate_entry_id: depForm.gate_entry_id ? Number(depForm.gate_entry_id) : null,
      tanker_no: depForm.tanker_no || null,
      // Sent whatever they hold, blank included: on this form a cleared box
      // means "this had no lot after all", which the server reads as NULL.
      lot_no: depForm.lot_no ?? '',
      terminal_no: depForm.terminal_no ?? '',
      // Recorded alongside the net so the register can show how it was reached.
      weighed_qty: depForm.weighed_qty !== '' && depForm.weighed_qty != null ? Number(depForm.weighed_qty) : null,
      shortage_pct: depForm.shortage_pct !== '' && depForm.shortage_pct != null ? Number(depForm.shortage_pct) : null
    }
    try {
      if (editing) {
        await window.api.consignment.update(editing.id as number, payload)
        toast.success('Consignment stock updated')
      } else {
        await window.api.consignment.create(payload)
        toast.success(
          depForm.gate_entry_id
            ? `Gate entry ${depForm.gate_entry_no} validated into consignment stock`
            : 'Consignment stock added'
        )
      }
      setDepOpen(false)
      await load()
    } catch (e) {
      setDepError((e as Error).message)
    } finally {
      setSavingDep(false)
    }
  }

  async function deleteDeposit(row: Row): Promise<void> {
    if (!window.confirm(`Delete this consignment stock entry for ${row.supplier_name}?`)) return
    try {
      await window.api.consignment.remove(row.id as number)
      toast.success('Deleted')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // Bargains available for the booking's supplier + product with balance left.
  const bookBargains = useMemo(() => {
    if (!book) return []
    return bargains.filter(
      (b) =>
        String(b.supplier_id) === String(book.supplier_id) &&
        String(b.oil_type_id) === String(book.product_id) &&
        Number(b.balance_qty) > 0.0001
    )
  }, [book, bargains])

  const chosenBargain = useMemo(
    () => bargains.find((b) => String(b.id) === String(bookForm.bargain_id)),
    [bargains, bookForm.bargain_id]
  )

  // Max invoiceable = min(consigned balance, chosen bargain balance).
  const maxBookQty = useMemo(() => {
    const consign = Number(book?.balance) || 0
    const barg = chosenBargain ? Number(chosenBargain.balance_qty) || 0 : consign
    return Math.min(consign, barg)
  }, [book, chosenBargain])

  async function openBooking(sumRow: Row, presetQty?: unknown): Promise<void> {
    const supplier = suppliers.find((x) => String(x.id) === String(sumRow.supplier_id))
    setBook(sumRow)
    setBookError(null)
    setBookForm({
      bargain_id: '',
      invoice_no: '',
      order_date: todayISO(),
      ordered_qty: presetQty ?? '',
      invoice_rate: '',
      gst_pct: supplier?.gst_pct ?? 0,
      gst_type: 'CGST_SGST',
      tds_pct: supplier?.tds_pct ?? 0,
      tds_above_only: !!supplier?.tds_above_only,
      tds_threshold: supplier?.tds_threshold ?? 0,
      adds_interest: !!supplier?.adds_interest,
      charge_interest: false,
      interest_pct: supplier?.interest_pct ?? 0,
      interest_days: supplier?.interest_days ?? 0,
      remarks: '',
      tds_prior: 0,
      company_id: String(activeCompany || '')
    })
  }

  // Shortcut from a single lot's edit dialog: book straight against that lot's
  // supplier + product, defaulting the quantity to what this lot holds.
  function openBookFromLot(row: Row): void {
    const sumRow = summary.find(
      (s) => String(s.supplier_id) === String(row.supplier_id) && String(s.product_id) === String(row.product_id)
    )
    if (!sumRow) {
      toast.error('No consignment balance found for this supplier and product')
      return
    }
    openBooking(sumRow, row.qty)
  }

  // When a bargain is chosen, default the invoice rate to its bargain rate.
  function chooseBookBargain(id: string): void {
    const b = bargains.find((x) => String(x.id) === id)
    setBookForm((p) => ({
      ...p,
      bargain_id: id,
      invoice_rate: p.invoice_rate || (b ? b.rate_per_uom : '')
    }))
  }

  // Prior-year taxable for the correct TDS slab in the preview.
  useEffect(() => {
    if (!book || !bookForm.order_date) return
    let active = true
    window.api.orders
      .fyTaxable(Number(book.supplier_id), String(bookForm.order_date), 0)
      .then((v) => active && setBookForm((p) => ({ ...p, tds_prior: v })))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [book, bookForm.order_date])

  const calc = useMemo(
    () =>
      computeMoney({
        orderedQty: Number(bookForm.ordered_qty) || 0,
        invoiceRate: Number(bookForm.invoice_rate) || 0,
        bargainRate: chosenBargain ? Number(chosenBargain.rate_per_uom) || 0 : 0,
        gstPct: Number(bookForm.gst_pct) || 0,
        tdsPct: bookForm.tds_above_only ? 0 : Number(bookForm.tds_pct) || 0,
        addsInterest: !!bookForm.charge_interest,
        interestPct: Number(bookForm.interest_pct) || 0,
        interestDays: Number(bookForm.interest_days) || 0,
        tdsThreshold: Number(bookForm.tds_threshold) || 0,
        tdsPctAbove: Number(bookForm.tds_pct) || 0,
        tdsPrior: Number(bookForm.tds_prior) || 0
      }),
    [bookForm, chosenBargain]
  )

  async function saveBooking(): Promise<void> {
    if (!book) return
    if (!bookForm.company_id) return setBookError('Choose which company to book this purchase into')
    if (!bookForm.bargain_id) return setBookError('Select the bargain to invoice against')
    if (!bookForm.invoice_no) return setBookError('Invoice number is required')
    const qty = Number(bookForm.ordered_qty) || 0
    if (qty <= 0) return setBookError('Enter the quantity to invoice')
    if (qty > maxBookQty + 1e-6) {
      return setBookError(`Quantity exceeds what is available (${formatNum(maxBookQty)} ${book.uom || 'MT'})`)
    }
    if (Number(bookForm.invoice_rate) <= 0) return setBookError('Invoice rate must be greater than zero')
    setSavingBook(true)
    setBookError(null)
    try {
      await window.api.orders.create({
        is_consignment: true,
        company_id: Number(bookForm.company_id),
        invoice_no: bookForm.invoice_no,
        order_date: bookForm.order_date,
        bargain_id: Number(bookForm.bargain_id),
        supplier_id: Number(book.supplier_id),
        oil_type_id: Number(book.product_id),
        bargain_type: chosenBargain?.bargain_type || 'EX',
        ordered_qty: qty,
        uom: book.uom || 'MT',
        bargain_rate: chosenBargain ? Number(chosenBargain.rate_per_uom) : 0,
        invoice_rate: Number(bookForm.invoice_rate),
        gst_pct: Number(bookForm.gst_pct) || 0,
        gst_type: bookForm.gst_type || 'CGST_SGST',
        tds_pct: Number(bookForm.tds_pct) || 0,
        charge_interest: !!bookForm.charge_interest,
        interest_pct: Number(bookForm.interest_pct) || 0,
        interest_days: Number(bookForm.interest_days) || 0,
        round_off: 0,
        remarks: bookForm.remarks || null,
        transporter_id: null,
        is_registered_transporter: false,
        allowed_shortage_pct: null,
        tanker_ids: [],
        financed_by_party: false,
        payment_date: bookForm.order_date
      })
      toast.success('Consignment purchase booked')
      setBook(null)
      await load()
    } catch (e) {
      setBookError((e as Error).message)
    } finally {
      setSavingBook(false)
    }
  }

  const totalBalance = summary.reduce((s, r) => s + (Number(r.balance) || 0), 0)

  // The stock register: one band per supplier, a line per product inside it,
  // and the individual tankers under each product. Numbers come from the roll-up
  // so they always agree with what the purchase side draws against.
  const stockBands = useMemo(() => {
    const bands = new Map<string, Row>()
    for (const r of summary) {
      const key = String(r.supplier_id)
      if (!bands.has(key)) {
        bands.set(key, {
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          uom: r.uom || 'MT',
          deposited: 0,
          invoiced: 0,
          balance: 0,
          products: [] as Row[]
        })
      }
      const band = bands.get(key) as Row
      band.deposited += Number(r.deposited) || 0
      band.invoiced += Number(r.invoiced) || 0
      band.balance += Number(r.balance) || 0
      band.products.push({
        ...r,
        lots: deposits
          .filter((d) => {
            if (String(d.supplier_id) !== String(r.supplier_id) || String(d.product_id) !== String(r.product_id)) return false
            if (!ranged) return true
            const dt = String(d.deposit_date || '').slice(0, 10)
            if (from && dt < from) return false
            if (to && dt > to) return false
            return true
          })
          .sort((a, b) => String(a.deposit_date || '').localeCompare(String(b.deposit_date || '')))
      })
    }
    return Array.from(bands.values()).sort((a, b) =>
      String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''))
    )
  }, [summary, deposits, ranged, from, to])
  const pendingLotCount = deposits.filter((d) => d.order_id == null).length

  // Computed from the pair itself, so a parcel's colour never moves when
  // another is added and is the same here as in the Stock deposits panel.
  const tintOf = lotTint

  // Products OPENED, by party and product. Every product starts collapsed
  // (the client's rule: the register opens as a list of products, and the
  // one wanted is expanded), so it is the opened ones that are remembered.
  const [openProducts, setOpenProducts] = useState<Set<string>>(() => new Set())
  // PARCELS START FOLDED, THE OPPOSITE OF A PRODUCT.
  //
  // A product folds shut on request because open is the useful default — you
  // came to see its tankers. A parcel group is different: there can be five or
  // six of them under one product, and every one of them starting open is the
  // same wall of rows the grouping was built to get away from. So this tracks
  // the OPENED set instead of the shut one, and a group not in it starts
  // folded — collapsed by default, expand the one you actually want.
  const [openLots, setOpenLots] = useState<Set<string>>(() => new Set())
  // Which invoice, or which party's product, is having its parcels handed
  // back. Held only so the button can say it is working.
  const [unlinking, setUnlinking] = useState(false)
  /**
   * PUT AN INVOICE BACK OFF THE PARCELS IT DREW.
   *
   * The invoice keeps its quantity, its value and its voucher; what comes
   * back is only the freedom to say which cargo fed it. A part-drawn parcel
   * is made whole again on the way — see unlinkConsignmentDraw.
   */
  async function unlinkOne(d: Row): Promise<void> {
    const inv = String(d.invoice_no || '').trim()
    if (
      !window.confirm(
        `Take ${inv ? `invoice ${inv}` : 'this invoice'} back off the parcels it drew?\n\n` +
          'The invoice itself is not changed \u2014 its quantity, value and voucher stay exactly as they are. ' +
          'The parcels go back to unbooked so they can be relabelled or drawn again.'
      )
    ) {
      return
    }
    setUnlinking(true)
    try {
      const out = await window.api.consignment.unlinkDraw(Number(d.order_id))
      toast.success(`${out.freed} parcel${out.freed === 1 ? '' : 's'} freed`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUnlinking(false)
    }
  }

  /** The same sweep, undone in one go for a party's product. */
  async function unlinkProduct(p: Row): Promise<void> {
    if (!(p.lots as Row[]).some((l) => l.order_id != null)) return
    if (
      !window.confirm(
        `Take every invoice back off the parcels it drew on ${String(p.product_code || p.product_name || 'this product')}?\n\n` +
          'This is how an auto-assignment is undone. No invoice is changed \u2014 its quantity, value and ' +
          'voucher stay exactly as they are, and only which parcel is recorded as having fed it goes. ' +
          'Parcels split by a part draw are made whole again.\n\n' +
          'It covers the whole product, not just what the date range above is showing.'
      )
    ) {
      return
    }
    setUnlinking(true)
    try {
      const out = await window.api.consignment.unlinkDrawsFor(Number(p.supplier_id), Number(p.product_id))
      toast.success(
        `${out.invoices} invoice${out.invoices === 1 ? '' : 's'} unlinked \u2014 ${out.freed} parcel${out.freed === 1 ? '' : 's'} freed`
      )
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUnlinking(false)
    }
  }

  // RENAMING A COMBINATION, NOT A ROW.
  //
  // A lot at a terminal is one cargo however many vehicles carried it, so its
  // number is corrected once for all of them. Row by row is six edits that can
  // disagree, and a pair half-renamed splits one group into two.
  const [renameFor, setRenameFor] = useState<Row | null>(null)
  const [renameLotNo, setRenameLotNo] = useState('')
  const [renameTermNo, setRenameTermNo] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

  function openRename(pr: Row, g: { lot: string; term: string; rows: unknown[] }): void {
    setRenameFor({
      supplier_id: pr.supplier_id,
      product_id: pr.product_id,
      product: pr.product_code || pr.product_name,
      from_lot: g.lot,
      from_terminal: g.term,
      count: g.rows.length
    })
    setRenameLotNo(g.lot)
    setRenameTermNo(g.term)
  }

  async function saveRename(): Promise<void> {
    if (!renameFor) return
    if (!renameLotNo.trim() && !renameTermNo.trim()) {
      toast.error('Give the combination a lot number, a terminal number, or both')
      return
    }
    setRenameSaving(true)
    try {
      const out = await window.api.consignment.renameLot({
        supplier_id: Number(renameFor.supplier_id),
        product_id: Number(renameFor.product_id),
        from_lot: String(renameFor.from_lot || ''),
        from_terminal: String(renameFor.from_terminal || ''),
        to_lot: renameLotNo,
        to_terminal: renameTermNo
      })
      toast.success(
        `${out.updated} tanker${out.updated === 1 ? '' : 's'} now on ` +
          `${[out.lot_no, out.terminal_no].filter(Boolean).join(' \u00b7 ')}`
      )
      setRenameFor(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRenameSaving(false)
    }
  }
  function toggleLot(key: string): void {
    setOpenLots((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleProduct(key: string): void {
    setOpenProducts((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const productKeys = stockBands.flatMap((band) => ((band.products as Row[]) || []).map((p) => `${band.supplier_id}:${p.product_id}`))
  const allProductsOpen = productKeys.length > 0 && productKeys.every((k) => openProducts.has(k))
  const toggleAllProducts = (): void => setOpenProducts(allProductsOpen ? new Set() : new Set(productKeys))

  // THE PHONE BODY. Two tabs — gate arrivals waiting to be validated, and the
  // stock already taken in, grouped party → product — reading the same arrays
  // the desktop does and firing the same handlers, so the validate drawer, the
  // book-purchase dialog and the rest all open here without a second copy.
  const mobileBody = ((): React.JSX.Element => {
    const co = companies.find((c) => String(c.id) === String(activeCompany))
    const bookedTotal = stockBands.reduce((t, b) => t + (Number(b.invoiced) || 0), 0)
    const kpis = [
      { k: 'Pending', v: String(pending.length), bg: 'rgba(226,168,74,.2)', kFg: '#F0C98A', vFg: '#F5E2B8' },
      { k: 'Booked MT', v: formatNum(bookedTotal), bg: 'rgba(255,255,255,.08)', kFg: '#8FBFA8', vFg: '#fff' },
      { k: 'In stock MT', v: formatNum(totalBalance), bg: 'rgba(199,240,63,.14)', kFg: '#8FBFA8', vFg: '#C7F03F' }
    ]
    const mtabs = [
      { key: 'gate' as const, label: 'Gate arrivals', count: pending.length },
      { key: 'stock' as const, label: 'Stock', count: stockBands.length }
    ]

    return (
      <div className="relative flex min-h-[100dvh] flex-col bg-[#F1F5EF]">
        <div className="flex-none bg-[#0B3D2E] px-4 pb-3 pt-2.5 text-white">
          <MobileBar onRefresh={() => load(true)} />
          <div className="flex items-center gap-2.5">
            <Package className="h-[22px] w-[22px] flex-none text-[#C7F03F]" />
            <div className="min-w-0">
              <div className="text-[17px] font-extrabold tracking-[-0.02em]">Consignment stock</div>
              <div className="truncate text-[10.5px] font-bold text-[#8FBFA8]">
                {(co?.name as string) || 'All companies'}
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2.5">
            {kpis.map((k) => (
              <div key={k.k} className="min-w-0 flex-1 rounded-[3px] px-2.5 py-2" style={{ background: k.bg }}>
                <div className="text-[8.5px] font-extrabold uppercase tracking-[.1em]" style={{ color: k.kFg }}>
                  {k.k}
                </div>
                <div className="doc-ref mt-0.5 text-[15px] font-bold tracking-[-0.03em]" style={{ color: k.vFg }}>
                  {k.v}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-none border-b border-b-[#D6E2D6] bg-white">
          {mtabs.map((t) => {
            const on = mTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setMTab(t.key)}
                className="flex h-12 flex-1 items-center justify-center gap-[7px] text-[12.5px] font-extrabold"
                style={{
                  borderBottom: `3px solid ${on ? '#0B3D2E' : 'transparent'}`,
                  background: on ? '#F7FAF6' : '#fff',
                  color: on ? '#0A1F17' : '#5A6B62'
                }}
              >
                {t.label}
                <span
                  className="doc-ref rounded-[2px] px-1.5 py-0.5 text-[10px] font-extrabold"
                  style={on ? { background: '#0B3D2E', color: '#C7F03F' } : { background: '#EAF0E9', color: '#5A6B62' }}
                >
                  {t.count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-[92px] pt-3">
          {mTab === 'gate' && (
            <>
              {pending.length === 0 ? (
                <div className="flex flex-none flex-col items-center gap-2.5 rounded-[4px] border border-[#BFE3CB] bg-white px-4 py-8" style={{ borderLeft: '3px solid #12855A' }}>
                  <Check className="h-8 w-8 text-[#12855A]" />
                  <span className="text-[13px] font-extrabold text-[#0B6B45]">No gate arrivals waiting</span>
                  <span className="text-center text-[11.5px] font-semibold leading-[1.5] text-[#33473E] [text-wrap:pretty]">
                    A tanker that passes the gate without a purchase behind it lands here to be validated into stock.
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex-none rounded-[4px] border border-[#E4D9BC] bg-[#FDF6E7] px-3 py-2.5" style={{ borderLeft: '4px solid #E2A84A' }}>
                    <div className="text-[11.5px] font-bold leading-[1.5] text-[#8A5300] [text-wrap:pretty]">
                      Tankers passed at the gate with no purchase behind them. Validate one to start its consignment
                      stock.
                    </div>
                  </div>
                  {pending.map((g, gi) => {
                    const weighed = g.status === 'completed' && Number(g.received_qty) > 0
                    return (
                      <div
                        key={String(g.id)}
                        className="flex-none rounded-[4px] border border-[#D6E2D6] bg-white p-3"
                        style={{ borderLeft: `4px solid ${weighed ? '#12855A' : '#E2A84A'}` }}
                      >
                        <div className="flex items-start justify-between gap-2.5">
                          <SerialNo n={gi + 1} className="mt-px" />
                          <div className="min-w-0 flex-1">
                            <div className="doc-ref text-[15px] font-bold tracking-[-0.02em]">
                              {String(g.tanker_no || '—')}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-[7px]">
                              <span className="doc-ref text-[11px] font-bold text-[#5A6B62]">{g.gate_entry_no}</span>
                              <span className="text-[11px] font-semibold text-[#5A6B62]">· {formatDate(g.entry_date)}</span>
                            </div>
                          </div>
                          <span
                            className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap rounded-[2px] border px-2 py-1 text-[10px] font-extrabold"
                            style={
                              weighed
                                ? { background: '#E9F5EE', color: '#0B6B45', borderColor: '#BFE3CB' }
                                : { background: '#FDF6E7', color: '#8A5300', borderColor: '#E4D9BC' }
                            }
                          >
                            {weighed ? <Check className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                            {weighed ? 'Weighed' : 'Awaiting weighment'}
                          </span>
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-[7px]">
                          <span className="text-[11.5px] font-bold text-[#33473E]">{String(g.supplier_name || '—')}</span>
                          {Number(g.is_direct_mnc) === 1 && (
                            <span className="rounded-[2px] bg-[#0B3D2E] px-1.5 py-[3px] text-[9.5px] font-extrabold text-[#C7F03F]">
                              MNC
                            </span>
                          )}
                          <span className="rounded-[2px] bg-[#EAF0E9] px-[7px] py-[3px] text-[10.5px] font-extrabold text-[#33473E]">
                            {String(g.rec_type || 'OIL')}
                          </span>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-2.5 border-t border-t-[#EAF0E9] pt-2.5">
                          <div>
                            <div className="text-[9px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]">Net qty</div>
                            <div className="doc-ref text-[15px] font-bold" style={{ color: weighed ? '#0A1F17' : '#C3D2C6' }}>
                              {weighed ? `${formatNum(g.received_qty)} ${g.uom || 'MT'}` : '—'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => openValidate(g)}
                            className="flex h-11 items-center gap-[7px] rounded-[3px] bg-[#0B3D2E] px-[18px] text-[13px] font-extrabold text-white"
                          >
                            <Check className="h-[18px] w-[18px] text-[#C7F03F]" />
                            Validate
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </>
              )}
            </>
          )}

          {mTab === 'stock' && (
            <>
              {stockBands.length === 0 ? (
                <div className="flex flex-none flex-col items-center gap-2 rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-10">
                  <Package className="h-7 w-7 text-[#C3D2C6]" />
                  <span className="text-center text-[12.5px] font-bold text-[#5A6B62] [text-wrap:pretty]">
                    No consignment stock yet. Validate a gate arrival, or log one below.
                  </span>
                </div>
              ) : (
                <>
                <div className="flex flex-none items-center justify-between px-0.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                    {productKeys.length} product{productKeys.length === 1 ? '' : 's'}
                  </span>
                  <button type="button" onClick={toggleAllProducts} className="text-[11.5px] font-extrabold text-[#0B6B45]">
                    {allProductsOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
                {stockBands.map((band) => (
                  <div key={String(band.supplier_id)} className="flex flex-none flex-col gap-2.5">
                    <div className="rounded-[4px] bg-[#0B3D2E] p-3 text-white">
                      <div className="text-[13px] font-extrabold">{String(band.supplier_name || '—')}</div>
                      <div className="mt-2.5 flex gap-2.5">
                        {[
                          { k: 'In', v: formatNum(band.deposited), fg: '#fff' },
                          { k: 'Booked', v: formatNum(band.invoiced), fg: '#8FBFA8' },
                          { k: 'In stock', v: `${formatNum(band.balance)} ${band.uom || 'MT'}`, fg: '#C7F03F' }
                        ].map((s) => (
                          <div key={s.k} className="min-w-0 flex-1">
                            <div className="text-[8.5px] font-extrabold uppercase tracking-[.1em] text-[#8FBFA8]">{s.k}</div>
                            <div className="doc-ref mt-0.5 text-[14px] font-bold tracking-[-0.02em]" style={{ color: s.fg }}>
                              {s.v}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {(band.products as Row[]).map((p) => {
                      const pkey = `${band.supplier_id}:${p.product_id}`
                      const open = openProducts.has(pkey)
                      const lots = (p.lots as Row[]) || []
                      const tankerN = lots.filter((d) => Number(d.is_opening) !== 1).length
                      // Stock carried in as an opening has no tanker behind it —
                      // say so, rather than "0 tankers" over a full balance.
                      const openN = lots.length - tankerN
                      const lotLabel =
                        [tankerN ? `${tankerN} ${tankerN === 1 ? 'tanker' : 'tankers'}` : '', openN ? 'opening stock' : '']
                          .filter(Boolean)
                          .join(' + ') || '0 tankers'
                      const canBook = Number(p.balance) > 0.0001
                      return (
                        <div key={pkey} className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                          <button
                            type="button"
                            onClick={() => toggleProduct(pkey)}
                            className="flex w-full items-center justify-between gap-2.5 px-3 py-[11px] text-left"
                            style={{ background: open ? '#F1F5EF' : '#F7FAF6' }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ChevronRight
                                className="h-[18px] w-[18px] flex-none text-[#5A6B62] transition-transform"
                                style={{ transform: open ? 'rotate(90deg)' : 'none' }}
                              />
                              <div className="min-w-0">
                                <div className="truncate text-[12.5px] font-extrabold">
                                  {String(p.product_code || p.product_name || '—')}
                                </div>
                                <div className="text-[10.5px] font-semibold text-[#5A6B62]">{lotLabel}</div>
                              </div>
                            </div>
                            <div className="flex-none text-right">
                              <div className="text-[8.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">In stock</div>
                              <div className="doc-ref text-[14px] font-bold text-[#0B6B45]">
                                {formatNum(p.balance)} {p.uom || 'MT'}
                              </div>
                            </div>
                          </button>

                          {open && (
                            <div>
                              {lots.map((d) => {
                                const opening = Number(d.is_opening) === 1
                                const booked = d.order_id != null
                                return (
                                  <button
                                    key={String(d.id)}
                                    type="button"
                                    onClick={() => openEditDeposit(d)}
                                    className="flex w-full flex-col border-t border-t-[#EAF0E9] px-3 py-2.5 text-left"
                                    style={{ background: opening ? '#F7FAF6' : '#fff', borderLeft: `3px solid ${opening ? '#C3D2C6' : booked ? '#12855A' : '#E2A84A'}` }}
                                  >
                                    <div className="flex items-start justify-between gap-2.5">
                                      <div className="min-w-0">
                                        {opening ? (
                                          <span className="rounded-[2px] bg-[#EAF0E9] px-[7px] py-[3px] text-[10px] font-extrabold tracking-[.06em] text-[#33473E]">
                                            OPENING
                                          </span>
                                        ) : (
                                          <div className="doc-ref truncate text-[12.5px] font-bold">
                                            {String(d.tanker_no || '—')}
                                          </div>
                                        )}
                                        <div className="mt-1 flex flex-wrap items-center gap-x-[7px] text-[10.5px] font-semibold text-[#5A6B62]">
                                          <span className="doc-ref">{formatDate(d.deposit_date)}</span>
                                          <span className="doc-ref">{d.gate_entry_no ? String(d.gate_entry_no) : 'no gate entry'}</span>
                                        </div>
                                      </div>
                                      <div className="flex-none text-right">
                                        <div className="doc-ref text-[14px] font-bold tracking-[-0.02em] text-[#0B6B45]">
                                          {formatNum(d.qty)} {d.uom || 'MT'}
                                        </div>
                                        <div className="text-[10px] font-bold text-[#5A6B62]">
                                          {Number(d.weighed_qty) > 0 ? `weighed ${formatNum(d.weighed_qty)}` : opening ? 'opening balance' : ''}
                                        </div>
                                      </div>
                                    </div>
                                    {booked && !!d.invoice_no && (
                                      <div className="doc-ref mt-1.5 text-[10.5px] font-bold text-[#0B6B45]">Booked · {String(d.invoice_no)}</div>
                                    )}
                                    {!!d.note && (
                                      <div className="mt-1.5 text-[10.5px] font-semibold text-[#5A6B62] [text-wrap:pretty]">{String(d.note)}</div>
                                    )}
                                  </button>
                                )
                              })}

                              <div className="flex items-center justify-between gap-2.5 border-t-2 border-t-[#C7F03F] bg-[#EFF5EC] px-3 py-[11px]">
                                <div>
                                  <div className="text-[9px] font-extrabold uppercase tracking-[.11em] text-[#33473E]">
                                    Total · {lotLabel}
                                  </div>
                                  <div className="text-[10.5px] font-bold text-[#5A6B62]">
                                    {Number(p.invoiced) > 0.0001 ? `${formatNum(p.invoiced)} MT booked` : 'nothing booked yet'}
                                  </div>
                                </div>
                                <div className="doc-ref text-[16px] font-bold tracking-[-0.02em]">
                                  {formatNum(p.balance)} {p.uom || 'MT'}
                                </div>
                              </div>

                              <div className="border-t border-t-[#EAF0E9] p-2.5">
                                <button
                                  type="button"
                                  disabled={!canBook}
                                  onClick={() => openBooking(p)}
                                  className="flex h-11 w-full items-center justify-center gap-[7px] rounded-[3px] border border-[#C3D2C6] text-[13px] font-extrabold disabled:opacity-45"
                                  style={{ color: '#33473E' }}
                                >
                                  <ShoppingCart className="h-[18px] w-[18px] text-[#0B6B45]" />
                                  Book purchase
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))}
                </>
              )}
            </>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 flex flex-none gap-2.5 border-t border-t-[#D6E2D6] bg-white px-3 pb-4 pt-2.5">
          <button
            type="button"
            onClick={openAddDeposit}
            className="flex h-[46px] flex-1 items-center justify-center gap-[7px] rounded-[3px] bg-[#C7F03F] text-[13px] font-extrabold text-[#0B3D2E]"
          >
            <Plus className="h-[19px] w-[19px]" />
            Log consignment stock
          </button>
        </div>
      </div>
    )
  })()

  return (
    <>
      {__WEB__ && isMobile && mobileBody}
      {!(__WEB__ && isMobile) && (<>
      <PageHeader
        title="Consignment stock"
        subtitle="Supplier goods lying at your place but not yet in your books — invoice them to make them yours"
        hint="Log stock a supplier deposits at your place. It shows here as supplier-owned (off-books). When you set a bargain and book a purchase invoice against it, the invoiced quantity becomes your owned stock and enters your books — no transporter, no tanker stages."
        actions={
          <div className="flex items-center gap-2">
            <ExcelButton
              filename={`consignment-${todayISO()}`}
              sheetName="Consignment"
              title="Consignment stock"
              columns={[
                { header: 'Date', key: 'deposit_date', value: (r) => formatDate(r.deposit_date) },
                { header: 'Supplier', key: 'supplier_name', value: (r) => r.supplier_name || '' },
                { header: 'Tanker', key: 'tanker_no', value: (r) => r.tanker_no || '' },
                { header: 'Gate no', key: 'gate_entry_no', value: (r) => r.gate_entry_no || '' },
                { header: 'Product', key: 'product', value: (r) => r.product_code || r.product_name || '' },
                { header: 'Quantity', key: 'qty', align: 'right', numFmt: '#,##0.000', value: (r) => Number(r.qty) || 0 },
                { header: 'UOM', key: 'uom', value: (r) => r.uom || '' },
                { header: 'Status', key: 'status', value: (r) => (r.order_id != null ? 'Booked' : 'In stock') },
                { header: 'Invoice no', key: 'invoice_no', value: (r) => r.invoice_no || '' },
                { header: 'Note', key: 'note', value: (r) => r.note || '' }
              ]}
              rows={deposits}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setOpeningSeed({})
                setOpeningOpen(true)
              }}
            >
              <Layers className="h-4 w-4" /> Opening stock
            </Button>
            <Button size="sm" onClick={openAddDeposit}>
              <Plus className="h-4 w-4" /> Log consignment stock
            </Button>
          </div>
        }
      />

      <div className={cn('space-y-6 px-4 py-5', __WEB__ && '!space-y-3 !px-3 !py-3')}>
        {/* What the page is holding, read off the same arrays everything below
            is drawn from — so a tile can never state something the register
            under it contradicts. */}
        {__WEB__ && !loading && (() => {
          const tiles = [
              {
                k: ranged ? 'Closing stock' : 'In stock',
                v: formatNum(totalBalance),
                unit: 'MT',
                sub: `${stockBands.length} part${stockBands.length === 1 ? 'y' : 'ies'} holding`,
                accent: '#0B6B45'
              },
              {
                k: 'Awaiting validation',
                v: String(pending.length),
                unit: '',
                sub: 'gate arrivals not yet placed',
                accent: '#C2700A'
              },
              {
                k: 'Pending booking',
                v: String(pendingLotCount),
                unit: '',
                sub: 'lots still off your books',
                accent: '#1B4E82'
              },
              {
                k: 'Booked',
                v: formatNum(stockBands.reduce((t, b) => t + (Number(b.invoiced) || 0), 0)),
                unit: 'MT',
                sub: 'invoiced into your books',
                accent: '#0B3D2E'
              }
          ]
          // Folded away by default, like Stock and Opening stock. The tiles are
          // a summary of the register directly underneath them, and four of
          // them cost a whole band of height before you reach the thing you
          // came for. Collapsed, the same four figures still read on one line.
          return (
            <div>
              <button
                type="button"
                onClick={() => setKpiOpen((o) => !o)}
                aria-expanded={kpiOpen}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 text-left transition-colors hover:bg-[#F7FAF6]',
                  kpiOpen ? 'h-[38px] rounded-b-none border-b-0' : 'h-[42px]'
                )}
              >
                <ChevronRight className={cn('h-4 w-4 shrink-0 text-[#5A6B62] transition-transform', kpiOpen && 'rotate-90')} />
                <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">
                  Summary
                </span>
                {!kpiOpen && (
                  <span className="no-scrollbar flex min-w-0 items-baseline gap-x-5 overflow-x-auto">
                    {tiles.map((k) => (
                      <span key={k.k} title={k.sub} className="flex items-baseline gap-1.5 whitespace-nowrap">
                        <span className="text-[10.5px] font-bold uppercase tracking-[.08em] text-[#8FA79B]">{k.k}</span>
                        <span className="doc-ref text-[12.5px] font-bold" style={{ color: k.accent }}>
                          {k.v}
                          {k.unit ? ` ${k.unit}` : ''}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
              </button>
              {kpiOpen && (
                <div className="grid gap-2.5 rounded-[4px] rounded-t-none border border-t-0 border-[#D6E2D6] bg-[#F7FAF6] p-2.5 sm:grid-cols-2 xl:grid-cols-4">
                  {tiles.map((k) => (
                    <div
                      key={k.k}
                      className="rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3"
                      style={{ borderTop: `3px solid ${k.accent}` }}
                    >
                      <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{k.k}</div>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-[22px] font-bold leading-none tracking-[-0.035em] tabular-nums">{k.v}</span>
                        {k.unit && <span className="text-[10.5px] font-extrabold text-[#5A6B62]">{k.unit}</span>}
                      </div>
                      <div className="mt-1 truncate text-[11px] font-semibold text-[#5A6B62]" title={k.sub}>{k.sub}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        {/* Step 1 of the flow: tankers passed at the gate, waiting for the
            accountant to say whose stock they are. */}
        {pending.length > 0 && (
          <section
            className={cn(
              'overflow-hidden rounded-xl border-2 border-amber-300 bg-amber-50/40',
              // The one queue on this page that is asking to be worked, so it
              // keeps a warm edge while everything below it is forest.
              __WEB__ && '!rounded-[4px] !border !border-[#E2A84A] !border-l-4 !border-l-[#E2A84A] !bg-white'
            )}
          >
            <div
              className={cn(
                'flex items-center justify-between border-b border-amber-200 bg-amber-100/70 px-5 py-3',
                __WEB__ && '!gap-3.5 !border-b-0 !bg-[#FDF6E7] !px-[15px] !py-3'
              )}
            >
              <div className={cn(__WEB__ && 'min-w-0')}>
                <h3 className={cn('font-medium text-amber-900', __WEB__ && '!flex !items-center !gap-2 !text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                  {__WEB__ && <Clock className="h-[18px] w-[18px] shrink-0 text-[#8A5300]" />}
                  Gate arrivals awaiting validation
                </h3>
                <p className={cn('text-xs text-amber-800', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#8A5300]')}>
                  Tankers passed at the gate that aren&apos;t linked to a purchase. Validate one to start maintaining its consignment stock.
                </p>
              </div>
              <Badge
                variant="warning"
                className={cn(__WEB__ && '!shrink-0 !rounded-[2px] !border-0 !bg-[#F5E2B8] !px-2.5 !py-[5px] !text-[11px] !font-extrabold !text-[#7A4A00]')}
              >
                {pending.length} pending
              </Badge>
            </div>
            <Table
              className={cn(
                'text-[12px] [&_td]:px-4 [&_td]:py-2 [&_th]:h-9 [&_th]:px-4',
                __WEB__ && '!text-[12.5px] [&_td]:!px-2.5 [&_td]:!py-2.5 [&_th]:!h-[30px] [&_th]:!px-2.5'
              )}
            >
              <TableHeader className={cn(__WEB__ && '!bg-[#EAF0E9]')}>
                <TableRow className={cn(__WEB__ && '!border-t !border-t-[#E4D9BC] !border-b-0 hover:!bg-[#EAF0E9] [&>th]:!bg-[#EAF0E9] [&>th]:!text-[9.5px] [&>th]:!font-extrabold [&>th]:!uppercase [&>th]:!tracking-[.11em] [&>th]:!text-[#33473E]')}>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Gate no</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Date</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Tanker</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Party</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Type</TableHead>
                  <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Net qty</TableHead>
                  <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Weighment</TableHead>
                  <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide text-amber-900', __WEB__ && '!text-[10.5px]')}>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((g, i) => {
                  const weighed = g.status === 'completed' && Number(g.received_qty) > 0
                  return (
                    <TableRow
                      key={g.id as number}
                      className={cn(
                        'border-b',
                        i % 2 === 1 && 'bg-amber-50/60',
                        __WEB__ && '!border-b-0 !border-t !border-t-[#EAF0E9] !bg-white hover:!bg-[#FFFDF7]'
                      )}
                    >
                      <TableCell className={cn('font-medium tabular-nums', __WEB__ && '!text-[12.5px] !font-bold !text-[#0A1F17]')}>{g.gate_entry_no}</TableCell>
                      <TableCell className={cn('whitespace-nowrap', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(g.entry_date)}</TableCell>
                      <TableCell className={cn('font-medium', __WEB__ && '!text-[12.5px] !font-bold !tabular-nums !text-[#0A1F17]')}>{g.tanker_no || <span className="italic text-muted-foreground">no number</span>}</TableCell>
                      <TableCell>
                        {g.supplier_name ? (
                          <span className="inline-flex items-center gap-1.5">
                            {g.supplier_name}
                            {Number(g.is_direct_mnc) === 1 && (
                              <Badge className={cn('bg-violet-600 font-normal hover:bg-violet-600', __WEB__ && '!rounded-[2px] !bg-[#0B3D2E] !px-1.5 !py-[3px] !text-[9.5px] !font-extrabold !tracking-[.05em] !text-[#C7F03F] hover:!bg-[#0B3D2E]')}>MNC</Badge>
                            )}
                          </span>
                        ) : (
                          <span className="italic text-muted-foreground">to be named</span>
                        )}
                      </TableCell>
                      <TableCell className={cn('text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#33473E]')}>{g.rec_type || 'OIL'}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-emerald-700">
                        {weighed ? `${formatNum(g.received_qty)} ${g.uom || 'MT'}` : '—'}
                      </TableCell>
                      <TableCell>
                        {weighed ? (
                          <Badge variant="success">Weighed</Badge>
                        ) : (
                          <Badge variant="warning">Awaiting weighment</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => openValidate(g)}>Validate</Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>
        )}

        {/* The stock register: what each supplier is holding at our place, the
            tankers it is made of, and what has already been invoiced. */}
        <section
          className={cn(
            'overflow-hidden rounded-xl border-2 border-violet-200 bg-card',
            // Violet was never a colour this app uses; the register wears the
            // same forest the other four do.
            __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white'
          )}
        >
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-2 border-b border-violet-200 bg-violet-50 px-5 py-3',
              __WEB__ && '!gap-3.5 !border-b-0 !bg-[#0B3D2E] !px-[15px] !py-3 !text-white'
            )}
          >
            <div className={cn(__WEB__ && 'min-w-0')}>
              <h3 className={cn('font-medium text-violet-900', __WEB__ && '!flex !items-center !gap-2 !text-[14px] !font-extrabold !text-white')}>
                {__WEB__ && <Package className="h-[19px] w-[19px] shrink-0 text-[#C7F03F]" />}
                Stock
              </h3>
              <p className={cn('text-xs text-violet-800/80', __WEB__ && '!mt-0.5 !text-[11.5px] !font-semibold !text-[#8FBFA8]')}>
                Supplier-owned stock lying at your place, tanker by tanker. Booking a purchase moves it into your books.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {__WEB__ && productKeys.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAllProducts}
                  className="inline-flex h-[28px] items-center gap-1.5 rounded-[2px] border border-white/20 px-2.5 text-[11.5px] font-extrabold text-white hover:bg-white/10"
                >
                  {allProductsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {allProductsOpen ? 'Collapse all' : 'Expand all'}
                </button>
              )}
              {!__WEB__ && pendingLotCount > 0 && (
                <Badge variant="warning">
                  {pendingLotCount} tanker{pendingLotCount > 1 ? 's' : ''} pending booking
                </Badge>
              )}
              <Badge
                className={cn(
                  'bg-violet-600 hover:bg-violet-600',
                  __WEB__ && '!rounded-[2px] !bg-[#C7F03F]/[.16] !px-2.5 !py-[5px] !text-[11.5px] !font-extrabold !tabular-nums !text-[#C7F03F] hover:!bg-[#C7F03F]/[.16]'
                )}
              >
                {formatNum(totalBalance)} MT {ranged ? 'closing' : 'in stock'}
              </Badge>
            </div>
          </div>
          <div
            className={cn(
              'flex flex-wrap items-center gap-2 border-b border-violet-100 bg-violet-50/40 px-5 py-2',
              __WEB__ &&
                '!gap-2 !border-b-[#E4ECE3] !bg-[#F7FAF6] !px-[15px] !py-2.5 [&_[data-slot=date-picker]]:!h-9 [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[12px] [&_[data-slot=date-picker]]:!font-bold [&_[data-slot=select-trigger]]:!h-9 [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[12px] [&_[data-slot=select-trigger]]:!font-extrabold'
            )}
          >
            {/* w-28 is 112px, and "FY 2026-27" plus the chevron does not fit
                in it — the label was being truncated to "FY 2026…". */}
            <FyPicker
              from={from}
              to={to}
              onRange={(f, t) => { setFrom(f); setTo(t) }}
              className={cn('h-9 w-28 text-xs', __WEB__ && '!w-[136px] !whitespace-nowrap !text-[12px]')}
            />
            <span className="text-[11px] font-semibold text-muted-foreground">From</span>
            <div className="w-40"><DatePicker value={from} onChange={(v) => setFrom(v || '')} max={to || undefined} /></div>
            <span className="text-[11px] font-semibold text-muted-foreground">To</span>
            <div className="w-40"><DatePicker value={to} onChange={(v) => setTo(v || '')} min={from || undefined} /></div>
            {ranged && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setFrom(''); setTo('') }}>
                Clear
              </Button>
            )}
          </div>

          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : stockBands.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted-foreground">
              No consignment stock yet. Validate a gate arrival above, or use{' '}
              <span className="font-medium">Log consignment stock</span> to enter one.
            </div>
          ) : (
            <div className="divide-y-2 divide-violet-100">
              {stockBands.map((band) => (
                <div key={String(band.supplier_id)}>
                  {/* Party band */}
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-x-6 gap-y-1 bg-violet-100/60 px-5 py-2',
                      __WEB__ && '!gap-x-4 !border-b !border-b-[#DCE7DB] !bg-[#EFF5EC] !px-[15px] !py-2.5'
                    )}
                  >
                    <div className={cn('text-sm font-semibold text-violet-900', __WEB__ && '!text-[13.5px] !font-extrabold !text-[#0A1F17]')}>
                      {band.supplier_name}
                    </div>
                    <div className={cn('ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]', __WEB__ && '!gap-x-4')}>
                      {/* Label above value reads as a caption; label BESIDE it
                          reads as a figure with a name, which is what these
                          three are. */}
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        In <span className={cn('font-semibold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-[#33473E]')}>{formatNum(band.deposited)}</span>
                      </span>
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        Booked <span className={cn('font-semibold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-[#33473E]')}>{formatNum(band.invoiced)}</span>
                      </span>
                      <span className={cn('text-violet-900/70', __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]')}>
                        In stock{' '}
                        <span className={cn('font-bold tabular-nums text-violet-900', __WEB__ && '!ml-1 !text-[14px] !font-bold !normal-case !tracking-[-0.02em] !text-[#0B6B45]')}>
                          {formatNum(band.balance)} {band.uom}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Products of that party, each with its tankers */}
                  {(band.products as Row[]).map((p) => {
                    const pkey = `${band.supplier_id}:${p.product_id}`
                    const shut = __WEB__ && !openProducts.has(pkey)
                    return (
                    <div key={pkey} className={cn('px-5 py-2.5', __WEB__ && '!p-0 [&+div]:!mt-2.5')}>
                      <div
                        className={cn(
                          'flex flex-wrap items-center gap-x-4 gap-y-1',
                          __WEB__ && '!gap-x-3.5 !border-b-0 !bg-[#1A5C46] !px-[15px] !py-2.5 !text-white'
                        )}
                      >
                        {/* The product's own tankers fold away under it. A party
                            can hold four or five products and every one of them
                            listing its lots made the register a page of scrolling
                            before the next party. */}
                        {__WEB__ && (
                          <button
                            type="button"
                            aria-expanded={!shut}
                            onClick={() => toggleProduct(pkey)}
                            title={shut ? 'Show this product’s tankers' : 'Hide this product’s tankers'}
                            className="flex items-center gap-2 rounded-[3px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B3D2E]"
                          >
                            <ChevronRight className={cn('h-4 w-4 shrink-0 text-[#C7F03F] transition-transform', !shut && 'rotate-90')} />
                            <span className="text-[13.5px] font-extrabold text-white">{p.product_code || p.product_name}</span>
                            <span className="text-[11px] font-semibold text-[#8FBFA8]">
                              · {(p.lots as Row[]).length} tanker{(p.lots as Row[]).length === 1 ? '' : 's'}
                            </span>
                          </button>
                        )}
                        {!__WEB__ && <div className="text-[13px] font-medium">{p.product_code || p.product_name}</div>}
                        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground', __WEB__ && '!ml-auto !gap-x-3.5')}>
                          <span className={cn(__WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]')}>
                            In <span className={cn('tabular-nums', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-white')}>{formatNum(p.deposited)}</span>
                          </span>
                          <span className={cn(__WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]')}>
                            Booked <span className={cn('tabular-nums', __WEB__ && '!ml-1 !text-[12.5px] !font-bold !normal-case !tracking-normal !text-white')}>{formatNum(p.invoiced)}</span>
                          </span>
                          <span
                            className={cn(
                              'font-semibold',
                              Number(p.balance) > 0.0001 ? 'text-emerald-700' : 'text-muted-foreground',
                              __WEB__ && '!text-[9.5px] !font-extrabold !uppercase !tracking-[.12em] !text-[#8FBFA8]'
                            )}
                          >
                            In stock{' '}
                            <span
                              className={cn(
                                'tabular-nums',
                                __WEB__ && '!ml-1 !text-[14px] !font-bold !normal-case !tracking-[-0.02em]',
                                __WEB__ && (Number(p.balance) > 0.0001 ? '!text-[#C7F03F]' : '!text-[#8FBFA8]')
                              )}
                            >
                              {formatNum(p.balance)} {p.uom}
                            </span>
                          </span>
                        </div>
                        {/* UNDOING A SWEEP TAKES A SWEEP.
                            The parcels under this product were matched to its
                            invoices in one go, and unpicking that one invoice
                            at a time is eleven confirmations to reach the same
                            place. Shown only where there is something linked
                            to undo. */}
                        {(p.lots as Row[]).some((l) => l.order_id != null) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={unlinking}
                            title="Hand every parcel under this product back off the invoices that drew them. The invoices are not changed."
                            className={cn(
                              'ml-auto h-7 text-xs',
                              __WEB__ &&
                                '!ml-0 !h-8 !gap-1.5 !rounded-[3px] !border-0 !bg-white/15 !px-3 !text-[11.5px] !font-extrabold !text-white hover:!bg-white/25'
                            )}
                            onClick={() => void unlinkProduct(p)}
                          >
                            <Unlink className="h-3.5 w-3.5" />
                            Unlink parcels
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            'ml-auto h-7 text-xs',
                            __WEB__ && '!ml-0 !h-8 !gap-1.5 !rounded-[3px] !border-0 !bg-[#C7F03F] !px-3.5 !text-[11.5px] !font-extrabold !text-[#12280B] hover:!bg-[#B8E32E] disabled:!bg-white/20 disabled:!text-[#8FBFA8] disabled:!opacity-100'
                          )}
                          disabled={Number(p.balance) <= 0.0001}
                          onClick={() => openBooking(p)}
                        >
                          {__WEB__ && <ShoppingCart className="h-4 w-4" />}
                          Book purchase
                        </Button>
                      </div>

                      {(p.lots as Row[]).length > 0 && !shut && (
                        <Table
                          className={cn(
                            'mt-2 text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-8 [&_th]:px-3',
                            __WEB__ && '!mt-0 !text-[13px] !table-fixed [&_td]:!px-2.5 [&_td]:!py-2.5 [&_th]:!h-[32px] [&_th]:!px-2.5'
                          )}
                          wrapperClassName={cn('rounded-lg border', __WEB__ && '!rounded-none !border-0')}
                        >
                          <TableHeader>
                            <TableRow className={cn('bg-muted/60', __WEB__ && '!border-b-[#DCE7DB] !bg-[#EAF0E9] hover:!bg-[#EAF0E9] [&>th]:!bg-[#EAF0E9] [&>th]:!text-[10.5px] [&>th]:!font-extrabold [&>th]:!tracking-[.11em] [&>th]:!text-[#0A1F17]')}>
                              {/* Position in the lot, not a stored number —
                                  deleting a line would otherwise leave a hole
                                  or renumber rows somebody has written down. */}
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[48px] !whitespace-nowrap !text-[10.5px]')}>SN</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Date</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[190px] !whitespace-nowrap !text-[10.5px]')}>Tanker</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Gate no</TableHead>
                              {/* WHICH CARGO IT CAME OFF. One column for both,
                                  because they are read together — L-2451 · T3
                                  is one answer, and two columns of mostly
                                  dashes would cost more width than the pair
                                  is worth. */}
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[132px] !whitespace-nowrap !text-[10.5px]')}>Lot · Terminal</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[104px] !whitespace-nowrap !text-[10.5px]')}>Weighed</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[86px] !whitespace-nowrap !text-[10.5px]')}>Short %</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[118px] !whitespace-nowrap !text-[10.5px]')}>Qty (net)</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[132px] !whitespace-nowrap !text-[10.5px]')}>Status</TableHead>
                              <TableHead className={cn('text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-auto !whitespace-nowrap !text-[10.5px]')}>Note</TableHead>
                              <TableHead className={cn('text-right text-[10px] font-semibold uppercase tracking-wide', __WEB__ && '!w-[86px] !whitespace-nowrap !text-[10.5px]')}>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {groupByLot(p.lots as Row[], Number(p.balance)).map((g, _gi, allGroups) => {
                              const grouped = allGroups.length > 1
                              const gkey = `${pkey}:${g.key}`
                              // A HEADING OVER ONE LINE IS THE LINE, TWICE.
                              //
                              // The same reasoning that leaves a single-parcel
                              // product ungrouped, one level down: a parcel
                              // carrying ONE tanker had a header saying its
                              // lot, its quantity and what was free, sitting
                              // directly above a row saying its lot, its
                              // quantity and its status. An opening split into
                              // parcels is the case that made it obvious —
                              // every parcel is one line, so the register
                              // doubled in height and said nothing more. The
                              // row already carries the chips, so it stands on
                              // its own; a group only earns a heading once it
                              // has something to gather.
                              const solo = g.rows.length === 1
                              const showHeader = grouped && !solo
                              const gshut = showHeader && !openLots.has(gkey)
                              // The parcel's own colour, so the header wears
                              // the same tint as the chips under it and the
                              // eye can follow one cargo down the page.
                              const gTint = tintOf(g.lot, g.term)
                              return (
                              <Fragment key={g.key}>
                              {showHeader && (
                                <TableRow
                                  className="group/lot !border-b-[#DCE7DB] !bg-[#F3F8F1] hover:!bg-[#EDF4EA]"
                                  style={{ borderLeft: `3px solid ${gTint ? gTint.fg : '#8FA79B'}` }}
                                >
                                  <TableCell colSpan={5} className="!py-2">
                                    {/* HUGGING ITS OWN LABEL, NOT THE COLUMN.
                                        The fold control took the whole
                                        five-column span, which threw the
                                        rename control to the far right of it
                                        — a pencil sitting four hundred pixels
                                        from the chips it renames, over a
                                        column it has nothing to do with. Both
                                        sit against the label now. */}
                                    <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      aria-expanded={!gshut}
                                      onClick={() => toggleLot(gkey)}
                                      title={gshut ? 'Show the tankers off this parcel' : 'Fold this parcel away'}
                                      className="flex min-w-0 items-center gap-2 rounded-[3px] py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B3D2E]"
                                    >
                                      {gshut ? (
                                        <ChevronRight className="h-4 w-4 shrink-0 text-[#5A6B62]" />
                                      ) : (
                                        <ChevronDown className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                                      )}
                                      {g.lot || g.term ? (
                                        (() => {
                                          const tint = tintOf(g.lot, g.term)
                                          const chip = (text: string, strong: boolean): React.JSX.Element => (
                                            <span
                                              className={cn('rounded-[2px] px-1.5 py-[1px] text-[11.5px] font-bold', __WEB__ && 'doc-ref')}
                                              style={tint ? { background: tint.bg, color: tint.fg, opacity: strong ? 1 : 0.82 } : undefined}
                                            >
                                              {text}
                                            </span>
                                          )
                                          return (
                                            <span className="flex items-center gap-1">
                                              {!!g.lot && chip(g.lot, true)}
                                              {!!g.term && chip(g.term, false)}
                                            </span>
                                          )
                                        })()
                                      ) : (
                                        <span className="text-[11px] font-extrabold uppercase tracking-[.1em] text-[#8FA79B]">
                                          No lot yet
                                        </span>
                                      )}
                                      <span className="text-[11px] font-bold text-[#5A6B62]">
                                        · {g.rows.length} tanker{g.rows.length === 1 ? '' : 's'}
                                      </span>
                                    </button>
                                    {/* THE NUMBER OF A CARGO, CORRECTED ONCE.
                                        Renames this lot and terminal on every
                                        tanker under it — which is what a
                                        correction to a lot number actually is.
                                        Row by row it is six edits that can
                                        disagree, and a pair half-renamed
                                        splits one group into two that are
                                        really one. */}
                                    <button
                                      type="button"
                                      title="Rename this lot and terminal on every tanker under it"
                                      onClick={() => openRename(p, g)}
                                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-[#8CA396] opacity-0 transition-opacity hover:bg-[#E3EDE1] hover:text-[#0B6B45] focus-visible:opacity-100 group-hover/lot:opacity-100"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    </div>
                                  </TableCell>
                                  {/* Set in the weights the rows beneath use,
                                      so a total reads as the same kind of
                                      figure as the lines it totals rather
                                      than as another table's. */}
                                  <TableCell className="!text-right !text-[12.5px] !font-semibold !tabular-nums !text-[#5A6B62]">
                                    {g.weighed > 0 ? fmt3(g.weighed) : '—'}
                                  </TableCell>
                                  <TableCell />
                                  <TableCell className="!text-right !text-[13.5px] !font-bold !tabular-nums !text-[#0A1F17]">
                                    {formatNum(g.qty)} {p.uom}
                                  </TableCell>
                                  <TableCell colSpan={3}>
                                    {/* A STATE, SO IT LOOKS LIKE ONE. Whether a
                                        parcel has anything left is the answer
                                        this row exists to give, and the rest
                                        of the app says that kind of thing in a
                                        chip. */}
                                    <span
                                      title={
                                        g.untied > 0.0005
                                          ? `${formatNum(g.untied)} ${p.uom} of this lot is taken by invoices not linked to any tanker (oldest lots first) — link them to tankers to see which`
                                          : undefined
                                      }
                                      className={cn(
                                        'inline-flex items-center rounded-[3px] border px-1.5 py-[1px] text-[11px] font-bold tabular-nums',
                                        g.free > 0.0001
                                          ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                          : 'border-[#DCE7DB] bg-[#F1F5EF] text-[#8FA79B]'
                                      )}
                                    >
                                      {g.free > 0.0001 ? `${formatNum(g.free)} ${p.uom} free` : 'All booked'}
                                    </span>
                                    {g.untied > 0.0005 && (
                                      <span className="ml-1.5 text-[10.5px] font-semibold text-[#8A5300]">
                                        {formatNum(g.untied)} {p.uom} on unlinked invoices
                                      </span>
                                    )}
                                  </TableCell>
                                </TableRow>
                              )}
                              {!gshut && g.rows.map(({ row: d, sn: lotIndex1 }) => {
                              const lotIndex = lotIndex1 - 1
                              const booked = d.order_id != null
                              return (
                                <TableRow
                                  key={d.id as number}
                                  className={cn(
                                    'border-b',
                                    !booked && 'bg-emerald-50/40',
                                    // A mark down the left edge says which lots
                                    // are still the supplier's without reading
                                    // the status column of every line.
                                    __WEB__ && '!border-b-[#F1F5EF] !bg-white hover:!bg-[#F7FAF6]'
                                  )}
                                  style={__WEB__ ? { borderLeft: `3px solid ${booked ? '#C3D2C6' : '#0B6B45'}` } : undefined}
                                >
                                  {/* Indented under the parcel that owns
                                      them. Without it a group header and its
                                      own tankers start at the same pixel and
                                      the grouping reads as a stripe rather
                                      than as a tree. */}
                                  <TableCell
                                    className={cn(
                                      'whitespace-nowrap tabular-nums',
                                      __WEB__ && '!text-[12.5px] !font-semibold !text-[#8FA79B]',
                                      showHeader && '!pl-7'
                                    )}
                                  >
                                    {lotIndex + 1}
                                  </TableCell>
                                  <TableCell className={cn('whitespace-nowrap', __WEB__ && '!text-[13px] !font-semibold !tabular-nums !text-[#33473E]')}>{formatDate(d.deposit_date)}</TableCell>
                                  <TableCell
                                    className={cn('font-medium', __WEB__ && '!max-w-0 !truncate !text-[13px] !font-bold !tabular-nums !text-[#0A1F17]')}
                                    title={String(d.tanker_no || '')}
                                  >
                                    {d.tanker_no || (Number(d.is_opening) === 1 ? (
                                      <Badge variant="secondary" className="font-normal">Opening</Badge>
                                    ) : (
                                      <span className="italic text-muted-foreground">no number</span>
                                    ))}
                                  </TableCell>
                                  <TableCell className={cn('tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !tabular-nums !text-[#5A6B62]')}>
                                    {d.gate_entry_no || '—'}
                                  </TableCell>
                                  <TableCell className={cn('whitespace-nowrap', __WEB__ && '!text-[12.5px] !font-semibold')}>
                                    {/* EDITED WHERE IT IS READ. Two bare boxes
                                        in the cell: Tab between them, Enter
                                        saves and drops onto the next unlabelled
                                        arrival, Escape leaves it alone. The
                                        panel is still there for one cargo that
                                        came on several tankers — the chevron
                                        opens it — and both write through the
                                        same call. */}
                                    {inlineId === Number(d.id) ? (
                                      <span data-inline-lot className="inline-flex items-center gap-1">
                                        <input
                                          autoFocus
                                          disabled={inlineBusy}
                                          value={inlineLot}
                                          placeholder="lot"
                                          onChange={(e) => setInlineLot(e.target.value.toUpperCase())}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') { e.preventDefault(); void saveInline(d, p.lots as Row[]) }
                                            if (e.key === 'Escape') { e.preventDefault(); setInlineId(0) }
                                          }}
                                          className="h-[22px] w-[58px] min-w-0 rounded-[3px] border border-[#0B6B45] bg-white px-1 text-[11.5px] font-bold uppercase text-[#0A1F17] outline-none placeholder:font-semibold placeholder:normal-case placeholder:text-[#A8B8AE]"
                                        />
                                        <input
                                          disabled={inlineBusy}
                                          value={inlineTerm}
                                          placeholder="terminal"
                                          onChange={(e) => setInlineTerm(e.target.value.toUpperCase())}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') { e.preventDefault(); void saveInline(d, p.lots as Row[]) }
                                            if (e.key === 'Escape') { e.preventDefault(); setInlineId(0) }
                                          }}
                                          onBlur={(e) => {
                                            // Clicking away from the pair is
                                            // leaving, not saving — but moving
                                            // BETWEEN the two boxes is neither.
                                            const to = e.relatedTarget as HTMLElement | null
                                            if (!to || !to.closest('[data-inline-lot]')) setInlineId(0)
                                          }}
                                          className="h-[22px] w-[62px] min-w-0 rounded-[3px] border border-[#C3D2C6] bg-white px-1 text-[11.5px] font-bold uppercase text-[#0A1F17] outline-none placeholder:font-semibold placeholder:normal-case placeholder:text-[#A8B8AE]"
                                        />
                                        <button
                                          type="button"
                                          title="Label several tankers off the same cargo"
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => { setInlineId(0); void openAssign(d) }}
                                          className="flex h-[22px] w-[18px] flex-none items-center justify-center rounded-[3px] text-[#8CA396] hover:bg-[#EAF0E9] hover:text-[#0B6B45]"
                                        >
                                          <ChevronRight className="h-3.5 w-3.5" />
                                        </button>
                                      </span>
                                    ) : d.lot_no || d.terminal_no ? (
                                      /* The label is the way back in: changing
                                         a lot, or adding the tankers that were
                                         missed the first time, is the same act
                                         as assigning it — and a chip you can
                                         only read leaves Edit deposit as the
                                         only route, one tanker at a time. */
                                      <button
                                        type="button"
                                        onClick={() => openLotFor(d)}
                                        title="Change this lot, or add other tankers to it"
                                        className="inline-flex items-center gap-1 rounded-[3px] px-0.5 hover:bg-[#EAF0E9]"
                                      >
                                        {(() => {
                                          // ONE COLOUR FOR THE PAIR, on both
                                          // chips. The lot and the terminal
                                          // together name the parcel, so
                                          // colouring them separately would
                                          // say there are two things here.
                                          const tint = tintOf(d.lot_no, d.terminal_no)
                                          const chip = (text: string, strong: boolean): React.JSX.Element => (
                                            <span
                                              className={cn('rounded-[2px] px-1.5 py-[1px] text-[11px] font-bold', __WEB__ && 'doc-ref')}
                                              style={
                                                tint
                                                  ? {
                                                      background: tint.bg,
                                                      color: tint.fg,
                                                      // The terminal is the
                                                      // quieter half of the
                                                      // name; same colour,
                                                      // less of it.
                                                      opacity: strong ? 1 : 0.82
                                                    }
                                                  : undefined
                                              }
                                            >
                                              {text}
                                            </span>
                                          )
                                          return (
                                            <>
                                              {!!d.lot_no && chip(String(d.lot_no), true)}
                                              {!!d.terminal_no && chip(String(d.terminal_no), false)}
                                            </>
                                          )
                                        })()}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => openLotFor(d)}
                                        title={
                                          Number(d.is_opening) === 1
                                            ? 'Split this opening into its lots and terminals — an opening can be several parcels'
                                            : 'Type the lot and terminal this tanker came off — Enter moves to the next'
                                        }
                                        className="rounded-[3px] border border-dashed border-[#C3D2C6] px-1.5 py-[1px] text-[11px] font-bold text-[#8CA396] hover:border-[#0B6B45] hover:text-[#0B6B45]"
                                      >
                                        {Number(d.is_opening) === 1 ? 'parcels' : 'assign'}
                                      </button>
                                    )}
                                  </TableCell>
                                  <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>
                                    {Number(d.weighed_qty) > 0 ? fmt3(Number(d.weighed_qty)) : '—'}
                                  </TableCell>
                                  <TableCell className={cn('text-right tabular-nums text-muted-foreground', __WEB__ && '!text-[12.5px] !font-semibold !text-[#5A6B62]')}>
                                    {Number(d.shortage_pct) > 0 ? `${d.shortage_pct}%` : '—'}
                                  </TableCell>
                                  <TableCell
                                    className={cn(
                                      'text-right font-semibold tabular-nums',
                                      booked ? 'text-muted-foreground' : 'text-emerald-700',
                                      __WEB__ && '!text-[13.5px] !font-bold',
                                      __WEB__ && (booked ? '!text-[#8FA79B]' : '!text-[#0B6B45]')
                                    )}
                                  >
                                    {formatNum(d.qty)} {d.uom}
                                  </TableCell>
                                  <TableCell className={cn(__WEB__ && '!max-w-0 !overflow-hidden')}>
                                    {/* Validation status: a lot is Completed once it has been
                                        validated with a quantity. Whether it has since been
                                        invoiced is shown alongside, not instead — under it
                                        rather than beside it, because the column is a fixed
                                        width and a ten-digit invoice number set next to the
                                        badge ran out of the cell and printed over the note. */}
                                    {Number(d.qty) > 0 ? (
                                      <span className="flex min-w-0 flex-col items-start gap-[3px]">
                                        <Badge variant="success">Completed</Badge>
                                        {booked && (
                                          <span
                                            className="block w-full truncate text-[10px] font-semibold tabular-nums text-[#8FA79B]"
                                            title={`Booked on ${String(d.invoice_no || 'a purchase invoice')}`}
                                          >
                                            {String(d.invoice_no || 'booked')}
                                          </span>
                                        )}
                                      </span>
                                    ) : (
                                      <Badge variant="warning">Pending</Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className={cn('max-w-[200px] truncate text-muted-foreground', __WEB__ && '!max-w-0 !text-[12.5px] !font-semibold !text-[#5A6B62]')} title={String(d.note || '')}>
                                    {d.note || '—'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <div className="flex justify-end gap-1">
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        disabled={booked}
                                        title={booked ? 'Booked on a purchase — edit that invoice instead' : 'Edit'}
                                        onClick={() => openEditDeposit(d)}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </Button>
                                      {/* THE WAY BACK OUT OF A WRONG ATTRIBUTION.
                                          Edit and Delete are both shut on a
                                          booked row and rightly so — but until
                                          now that left NOTHING to do with a
                                          parcel the wrong invoice had taken,
                                          short of deleting the invoice itself.
                                          This hands the parcels back and
                                          leaves the invoice alone. */}
                                      {booked && (
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-7 w-7 text-[#8A5300] hover:bg-[#FFF4E0]"
                                          disabled={unlinking}
                                          title={`Unlink ${String(d.invoice_no || 'this invoice')} from the parcels it drew — the invoice itself is not changed`}
                                          onClick={() => void unlinkOne(d)}
                                        >
                                          <Unlink className="h-3.5 w-3.5" />
                                        </Button>
                                      )}
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-destructive"
                                        disabled={booked}
                                        title={booked ? 'Booked on a purchase — delete that invoice first' : 'Delete'}
                                        onClick={() => deleteDeposit(d)}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                              </Fragment>
                              )
                            })}
                            {/* What the lots above come to. The band over them
                                already says it, but a table you have scrolled
                                to the bottom of should not make you scroll back
                                up to find its total. */}
                            {__WEB__ && (
                              <TableRow className="!border-b-[#C3D2C6] !border-t-2 !border-t-[#C7F03F] !bg-[#EFF5EC] hover:!bg-[#EFF5EC]">
                                <TableCell colSpan={5} className="!text-[10.5px] !font-extrabold !uppercase !tracking-[.11em] !text-[#0B3D2E]">
                                  {(p.lots as Row[]).length} tanker{(p.lots as Row[]).length === 1 ? '' : 's'}
                                </TableCell>
                                <TableCell className="!text-right !text-[12.5px] !font-bold !tabular-nums !text-[#33473E]">
                                  {fmt3((p.lots as Row[]).reduce((t, d) => t + (Number(d.weighed_qty) || 0), 0))}
                                </TableCell>
                                <TableCell />
                                <TableCell className="!text-right !text-[13.5px] !font-bold !tabular-nums !tracking-[-0.02em] !text-[#0A1F17]">
                                  {formatNum(p.deposited)} {p.uom}
                                </TableCell>
                                <TableCell colSpan={3}>
                                  {/* The same chip the parcels above wear, for
                                      the same statement one level up — a total
                                      that speaks a different language from the
                                      lines it totals reads as a stray. */}
                                  <span
                                    className={cn(
                                      'inline-flex items-center rounded-[3px] border px-1.5 py-[1px] text-[11px] font-bold tabular-nums',
                                      Number(p.balance) > 0.0001
                                        ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                                        : 'border-[#DCE7DB] bg-[#F1F5EF] text-[#8FA79B]'
                                    )}
                                  >
                                    {Number(p.balance) > 0.0001
                                      ? `${formatNum(p.balance)} ${p.uom} free`
                                      : 'All booked'}
                                  </span>
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </section>

      </div>
      </>)}

      {/* Deposit intake dialog */}

      {/* WHICH CARGO THESE TANKERS CAME OFF.
          A drawer rather than a dialog: the suggestion list is the point of
          the screen and it needs room to be read, tanker by tanker, with the
          reason each one is being offered. */}
      {!!assignFor && (
        <div
          className="fixed inset-0 z-[70] flex justify-end"
          style={{ background: 'rgba(10,31,23,.5)' }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !assignBusy) setAssignFor(null)
          }}
        >
          <div className="flex h-full w-[min(100%,620px)] flex-col bg-[#F1F5EF] shadow-[0_0_60px_rgba(10,31,23,.4)]">
            <div className="flex-none bg-[#0B3D2E] px-[22px] py-4">
              <div className="text-[11.5px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Assign lot &amp; terminal
              </div>
              <div className="mt-1.5 text-[15px] font-bold tracking-[-0.01em] text-white">
                {String(assignFor.tanker_no || 'this tanker')}
              </div>
              <p className="mt-1.5 text-[11.5px] font-medium leading-[1.5] text-[#B7D6C4]">
                {String(assignFor.supplier_name || '')} ·{' '}
                {String(assignFor.product_code || assignFor.product_name || '')} · arrived{' '}
                {formatDate(assignFor.deposit_date)}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-4">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="flex flex-col gap-1.5">
                  <Label>Lot no</Label>
                  <Input value={assignLot} onChange={(e) => setAssignLot(e.target.value)} placeholder="e.g. L-2451" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Terminal no</Label>
                  <Input value={assignTerm} onChange={(e) => setAssignTerm(e.target.value)} placeholder="e.g. T3" />
                </div>
              </div>
              {!!assignFrom && (
                <p className="mt-2 text-[11.5px] font-semibold text-[#1B4E82]">
                  Proposed from {assignFrom}, which is already on this lot — change it if this cargo is different.
                </p>
              )}

              <div className="mt-4 rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-b-[#EAF0E9] px-3.5 py-2.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-[.11em] text-[#8CA396]">
                    Others that may be the same cargo
                  </span>
                  <span className="min-w-0 flex-1" />
                  {assignKin.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setAssignPicked((prev) =>
                          prev.length === assignKin.length ? [] : assignKin.map((k) => Number(k.id))
                        )
                      }
                      className="rounded-[3px] border border-[#C3D2C6] bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
                    >
                      {assignPicked.length === assignKin.length ? 'Clear' : 'Take all'}
                    </button>
                  )}
                </div>
                {assignKin.length === 0 ? (
                  <div className="px-3.5 py-6 text-center text-[11.5px] font-semibold text-[#8CA396]">
                    Nothing else from this party and product arrived near this one.
                  </div>
                ) : (
                  assignKin.map((k) => {
                    const on = assignPicked.includes(Number(k.id))
                    return (
                      <button
                        key={String(k.id)}
                        type="button"
                        onClick={() =>
                          setAssignPicked((prev) =>
                            on ? prev.filter((x) => x !== Number(k.id)) : [...prev, Number(k.id)]
                          )
                        }
                        className={cn(
                          'flex w-full items-center gap-2.5 border-b border-b-[#F1F5EF] px-3.5 py-2.5 text-left last:border-b-0',
                          on ? 'bg-[#F1F5EF]' : 'hover:bg-[#F7FAF6]'
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] border-[1.5px]',
                            on ? 'border-[#0B3D2E] bg-[#0B3D2E]' : 'border-[#C3D2C6] bg-white'
                          )}
                        >
                          {on && <Check className="h-3 w-3 text-[#C7F03F]" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-bold text-[#0A1F17]">
                            {String(k.tanker_no || 'no number')}
                          </span>
                          {/* WHY it is being offered. A suggestion that cannot
                              say why is one nobody should act on. */}
                          <span className="mt-0.5 block text-[10.5px] font-semibold text-[#5A6B62]">
                            {String(k.why || '')}
                          </span>
                        </span>
                        <span className="flex-none text-right">
                          <span className="block text-[12px] font-bold tabular-nums text-[#33473E]">
                            {formatNum(k.qty)} {String(k.uom || 'MT')}
                          </span>
                          <span className="block text-[10.5px] font-semibold tabular-nums text-[#8CA396]">
                            {formatDate(k.deposit_date)}
                          </span>
                        </span>
                      </button>
                    )
                  })
                )}
              </div>

              <p className="mt-3 text-[11px] font-medium leading-[1.55] text-[#5A6B62]">
                Only this party and this product are ever offered — a lot is one parcel of one oil. A tanker already on
                a different lot is left out: moving one is a decision, not a suggestion. A tanker already booked onto a
                purchase can still be labelled, because which cargo it came off is a fact about the arrival, not about
                the invoice.
              </p>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#D6E2D6] bg-white px-[22px] py-4">
              <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-[#33473E]">
                {assignPicked.length + 1} tanker{assignPicked.length ? 's' : ''} will be labelled
                {assignLot.trim() ? ` ${assignLot.trim().toUpperCase()}` : ''}
                {assignTerm.trim() ? ` · ${assignTerm.trim().toUpperCase()}` : ''}
              </span>
              <Button variant="outline" onClick={() => setAssignFor(null)} disabled={assignBusy}>
                Cancel
              </Button>
              <Button
                className="bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]"
                onClick={() => void saveAssign()}
                disabled={assignBusy || (!assignLot.trim() && !assignTerm.trim())}
              >
                {assignBusy ? 'Saving…' : 'Assign'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={depOpen} onOpenChange={(o) => !o && setDepOpen(false)}>
        <DialogContent
          className={cn(
            __WEB__ && CS_DRAWER,
            // On a phone the drawer is the whole screen and its field pairs
            // (weighed / short / net) stack instead of running off the edge.
            __WEB__ && isMobile && '!w-screen !max-w-none !grid-cols-1 [&_.grid-cols-3]:!grid-cols-1 [&_.grid-cols-2]:!grid-cols-1'
          )}
        >
          <DialogHeader className={cn(__WEB__ && CS_HEAD)}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Consignment stock
              </div>
            )}
            <DialogTitle className={cn(__WEB__ && CS_TITLE)}>
              {editing
                ? 'Edit consignment stock'
                : depForm.gate_entry_id
                  ? 'Validate gate arrival'
                  : 'Log consignment stock'}
            </DialogTitle>
          </DialogHeader>
          <div className={cn('grid gap-4', __WEB__ && CS_BODY)}>
            {!!depForm.gate_entry_id && (
              <div
                className={cn(
                  'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900',
                  __WEB__ && '!rounded-[4px] !border-[#F0D9AE] !border-l-4 !border-l-[#C2700A] !bg-[#FFFBF2] !px-3.5 !py-3 !text-[12px] !font-semibold !leading-relaxed !text-[#8A5300]'
                )}
              >
                From gate entry <b>{depForm.gate_entry_no}</b>
                {depForm.tanker_no ? <> · tanker <b>{depForm.tanker_no}</b></> : null}
                {Number(depForm.qty) > 0 ? <> · weighed net <b>{formatNum(depForm.qty)} {depForm.uom}</b></> : <> · <b>not weighed yet</b> — enter the quantity manually</>}
                <div className="mt-0.5 opacity-80">
                  {depForm.supplier_prefilled
                    ? `Party already named at the gate${depForm.supplier_name ? ` — ${depForm.supplier_name}` : ''}. Just pick the oil and save.`
                    : 'Confirm whose stock this is; the quantity starts being maintained once saved.'}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>Company *</Label>
              <Select
                value={String(depForm.company_id || '')}
                onValueChange={(v) => setDepForm((p) => ({ ...p, company_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                <SelectContent>
                  {companies.map((cm) => (
                    <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {String(depForm.company_id || '') !== String(activeCompany) && !!depForm.company_id && (
                <span className="text-[11px] font-medium text-amber-700">
                  {editing
                    ? `This stock will move to ${companies.find((cm) => String(cm.id) === String(depForm.company_id))?.name}.`
                    : `This stock will be maintained under ${companies.find((cm) => String(cm.id) === String(depForm.company_id))?.name}, not the company you are viewing now.`}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5">
                Supplier *
                {depForm.supplier_prefilled && (
                  <Badge variant="secondary" className="font-normal">from the gate entry</Badge>
                )}
              </Label>
              <Select value={String(depForm.supplier_id || '')} onValueChange={(v) => setDepForm((p) => ({ ...p, supplier_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {/* The tanker number was carried in from the gate entry and
                saved with the lot, but there was nowhere to correct it — which
                is how a whole invoice reference ends up in a field meant for a
                vehicle number and stays there. */}
            <div className="flex flex-col gap-1.5">
              <Label>Tanker no</Label>
              <Input
                value={depForm.tanker_no ?? ''}
                placeholder="Vehicle number"
                onChange={(e) => setDepForm((p) => ({ ...p, tanker_no: e.target.value }))}
              />
            </div>
            {/* WHICH CARGO IT CAME OFF.
                Optional on purpose, and optional for good: the lot is on the
                terminal's paperwork and the yard often validates the tanker
                before that sheet reaches the desk. Both can be filled in
                later, on one tanker or on a dozen at once — see Assign on the
                register below. */}
            <div className="flex flex-col gap-1.5">
              <Label>Lot no</Label>
              <Input
                value={depForm.lot_no ?? ''}
                placeholder="optional — the lot at the port"
                onChange={(e) => setDepForm((p) => ({ ...p, lot_no: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Terminal no</Label>
              <Input
                value={depForm.terminal_no ?? ''}
                placeholder="optional — where it was discharged"
                onChange={(e) => setDepForm((p) => ({ ...p, terminal_no: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Product *</Label>
              <Select value={String(depForm.product_id || '')} onValueChange={(v) => setDepForm((p) => ({ ...p, product_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.code || p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1">
                  Weighed qty
                  <InfoTip text="The gate weighment, before the allowed shortage is deducted." />
                </Label>
                <Input
                  type="number"
                  value={depForm.weighed_qty ?? ''}
                  onChange={(e) =>
                    setDepForm((p) => ({
                      ...p,
                      weighed_qty: e.target.value,
                      qty: netOfShortage(e.target.value, p.shortage_pct)
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Shortage %</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.2"
                  value={depForm.shortage_pct ?? ''}
                  onChange={(e) =>
                    setDepForm((p) => ({
                      ...p,
                      shortage_pct: e.target.value,
                      qty: netOfShortage(p.weighed_qty, e.target.value)
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Net qty taken in *</Label>
                <Input
                  type="number"
                  className="font-semibold"
                  value={depForm.qty ?? ''}
                  onChange={(e) => setDepForm((p) => ({ ...p, qty: e.target.value }))}
                />
              </div>
            </div>
            {Number(depForm.weighed_qty) > 0 && Number(depForm.shortage_pct) > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {formatNum(depForm.weighed_qty)} {depForm.uom} weighed − {depForm.shortage_pct}% shortage (
                {formatNum(Number(depForm.weighed_qty) - Number(depForm.qty || 0))} {depForm.uom}) ={' '}
                <b>{formatNum(depForm.qty)} {depForm.uom}</b> taken into stock.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>Deposit date</Label>
              <DatePicker min={minDate} value={depForm.deposit_date || ''} onChange={(v) => setDepForm((p) => ({ ...p, deposit_date: v }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Note</Label>
              <Input value={depForm.note ?? ''} onChange={(e) => setDepForm((p) => ({ ...p, note: e.target.value }))} />
            </div>
            {depError && (
              <p className={cn('text-sm text-destructive', __WEB__ && '!rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-3 !py-2.5 !text-[12.5px] !font-bold !text-[#8C2F26]')}>
                {depError}
              </p>
            )}
          </div>
          <DialogFooter className={cn(__WEB__ && CS_FOOT)}>
            <Button variant="outline" onClick={() => setDepOpen(false)} disabled={savingDep} className={cn(__WEB__ && CS_BTN)}>
              Cancel
            </Button>
            {editing && (
              <Button
                variant="outline"
                onClick={() => { setDepOpen(false); openBookFromLot(editing) }}
                disabled={savingDep}
                className={cn(__WEB__ && cn(CS_BTN, '!text-[#0B6B45]'))}
              >
                Book this stock
              </Button>
            )}
            <Button onClick={saveDeposit} disabled={savingDep} className={cn(__WEB__ && cn(CS_GO, '!ml-auto'))}>
              {__WEB__ && !savingDep && <Check className="h-[18px] w-[18px]" />}
              {savingDep ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Booking dialog */}
      <Dialog open={!!book} onOpenChange={(o) => !o && setBook(null)}>
        <DialogContent
          className={cn(
            'max-h-[90vh] overflow-y-auto sm:max-w-lg',
            __WEB__ && cn(CS_DIALOG, '!grid-rows-[auto_minmax(0,1fr)_auto] !overflow-hidden')
          )}
        >
          <DialogHeader className={cn(__WEB__ && CS_HEAD)}>
            {__WEB__ && (
              <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
                Consignment stock
              </div>
            )}
            <DialogTitle className={cn('flex items-center gap-1.5', __WEB__ && CS_TITLE)}>
              Book consignment purchase
              <InfoTip text="No transporter, no gate entry and no tanker stages — the goods are already at your place. The invoiced quantity becomes your owned stock and posts to the supplier ledger and journal." />
            </DialogTitle>
          </DialogHeader>
          {book && (
            <div className={cn('grid gap-4', __WEB__ && CS_BODY)}>
              <div
                className={cn(
                  'rounded-md bg-muted px-3 py-2 text-sm',
                  __WEB__ && '!rounded-[4px] !border !border-[#D6E2D6] !bg-white !px-3.5 !py-3 !text-[13px] !font-semibold !text-[#33473E]'
                )}
              >
                {book.supplier_name} · {book.product_code || book.product_name} · available{' '}
                <b className={cn(__WEB__ && '!text-[#0B6B45]')}>{formatNum(book.balance)} {book.uom}</b>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Book into company *</Label>
                <Select
                  value={String(bookForm.company_id || '')}
                  onValueChange={(v) => setBookForm((p) => ({ ...p, company_id: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Select the company" /></SelectTrigger>
                  <SelectContent>
                    {companies.map((cm) => (
                      <SelectItem key={cm.id} value={String(cm.id)}>{cm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {String(bookForm.company_id || '') !== String(activeCompany) && !!bookForm.company_id && (
                  <span className="text-[11px] font-medium text-amber-700">
                    This purchase will be booked into{' '}
                    {companies.find((cm) => String(cm.id) === String(bookForm.company_id))?.name}.
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Bargain *</Label>
                <Select value={String(bookForm.bargain_id || '')} onValueChange={chooseBookBargain}>
                  <SelectTrigger><SelectValue placeholder="Select the bargain" /></SelectTrigger>
                  <SelectContent>
                    {bookBargains.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.bargain_no} · BAL {formatNum(b.balance_qty)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {bookBargains.length === 0 && (
                  <span className="text-[11px] text-amber-700">No open bargain for this supplier and product — create one in Bargains first.</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice number *</Label>
                  <Input value={bookForm.invoice_no || ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_no: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice date *</Label>
                  <DatePicker value={bookForm.order_date || ''} onChange={(v) => setBookForm((p) => ({ ...p, order_date: v }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity * (max {formatNum(maxBookQty)})</Label>
                  <Input type="number" value={bookForm.ordered_qty || ''} onChange={(e) => setBookForm((p) => ({ ...p, ordered_qty: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Invoice rate *</Label>
                  <Input type="number" value={bookForm.invoice_rate ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, invoice_rate: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>GST %</Label>
                  <Input type="number" value={bookForm.gst_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>GST type</Label>
                  <Select value={bookForm.gst_type || 'CGST_SGST'} onValueChange={(v) => setBookForm((p) => ({ ...p, gst_type: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                      <SelectItem value="IGST">IGST</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>TDS %</Label>
                  <Input type="number" value={bookForm.tds_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, tds_pct: e.target.value }))} />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Switch checked={!!bookForm.charge_interest} onCheckedChange={(v) => setBookForm((p) => ({ ...p, charge_interest: v }))} />
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">Supplier interest</span>
                    <InfoTip text="Interest = BG rate incl. GST × Int% × days ÷ 365; adjusted invoice rate = invoice rate + interest." />
                  </div>
                </div>
                <div className={cn('ml-auto flex items-center gap-2', !bookForm.charge_interest && 'opacity-50')}>
                  <Label className="text-xs">Int %</Label>
                  <Input type="number" className="h-8 w-20 text-right" disabled={!bookForm.charge_interest} value={bookForm.interest_pct ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, interest_pct: e.target.value }))} />
                  <Label className="text-xs">Days</Label>
                  <Input type="number" className="h-8 w-20 text-right" disabled={!bookForm.charge_interest} value={bookForm.interest_days ?? ''} onChange={(e) => setBookForm((p) => ({ ...p, interest_days: e.target.value }))} />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Remarks</Label>
                <textarea
                  rows={2}
                  className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Optional notes"
                  value={bookForm.remarks ?? ''}
                  onChange={(e) => setBookForm((p) => ({ ...p, remarks: e.target.value }))}
                />
              </div>

              <div className="rounded-lg border bg-muted/30 p-3">
                <SummaryLine label="Adjusted invoice rate" value={formatINR(calc.adjustedRate)} />
                <SummaryLine label="Taxable value" value={formatINR(calc.taxableValue)} />
                <SummaryLine label="GST" value={formatINR(calc.gstAmount)} />
                <SummaryLine label="TDS" value={`− ${formatINR(calc.tdsAmount)}`} />
                <SummaryLine label="Net purchase amount" value={formatINR(calc.netAmount)} strong />
              </div>

              {bookError && (
                <p className={cn('text-sm text-destructive', __WEB__ && '!rounded-[4px] !border !border-[#F0D6D4] !bg-[#FDF3F2] !px-3 !py-2.5 !text-[12.5px] !font-bold !text-[#8C2F26]')}>
                  {bookError}
                </p>
              )}
            </div>
          )}
          <DialogFooter className={cn(__WEB__ && CS_FOOT)}>
            <Button variant="outline" onClick={() => setBook(null)} disabled={savingBook} className={cn(__WEB__ && CS_BTN)}>
              Cancel
            </Button>
            <Button onClick={saveBooking} disabled={savingBook} className={cn(__WEB__ && cn(CS_GO, '!ml-auto'))}>
              {__WEB__ && !savingBook && <ShoppingCart className="h-[18px] w-[18px]" />}
              {savingBook ? 'Booking…' : 'Book purchase'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The opening, as parcels — see components/ConsignmentOpening.tsx. */}
      {/* RENAMING A COMBINATION. Two boxes, because a parcel is a lot AT a
          terminal and correcting one usually means checking the other. */}
      <Dialog open={!!renameFor} onOpenChange={(o) => !o && !renameSaving && setRenameFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename this parcel</DialogTitle>
          </DialogHeader>
          {renameFor && (
            <div className="grid gap-3">
              <p className="text-[12.5px] leading-[1.5] text-muted-foreground">
                {String(renameFor.count)} tanker{Number(renameFor.count) === 1 ? '' : 's'} on{' '}
                <b className="text-foreground">
                  {[String(renameFor.from_lot || ''), String(renameFor.from_terminal || '')]
                    .filter(Boolean)
                    .join(' · ') || 'no lot yet'}
                </b>{' '}
                under {String(renameFor.product || 'this product')}. Renaming it here moves all of them together,
                booked ones included — this writes a label and nothing else.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Lot no</Label>
                  <Input
                    value={renameLotNo}
                    onChange={(e) => setRenameLotNo(e.target.value)}
                    placeholder="L-2451"
                    className="uppercase"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Terminal no</Label>
                  <Input
                    value={renameTermNo}
                    onChange={(e) => setRenameTermNo(e.target.value)}
                    placeholder="KANDLA"
                    className="uppercase"
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={renameSaving} onClick={() => setRenameFor(null)}>
              Cancel
            </Button>
            <Button disabled={renameSaving} onClick={() => void saveRename()}>
              {renameSaving ? 'Renaming…' : 'Rename'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConsignmentOpeningDialog
        open={openingOpen}
        supplierId={openingSeed.s}
        productId={openingSeed.p}
        onClose={() => setOpeningOpen(false)}
        onSaved={() => void load()}
      />
    </>
  )
}
