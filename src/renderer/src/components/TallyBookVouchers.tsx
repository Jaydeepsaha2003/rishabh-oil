import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, CheckCircle2, ChevronRight, Info, Link2, Plus, Sparkles, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { escToClose } from '@/lib/escape'
import { formatDate, formatINR } from '@/lib/format'
import { GroupCombo, LedgerCombo } from '@/components/TallyLedgerPickers'
import { TallyFixNames } from '@/components/TallyFixNames'
import { orderVoucherLines, TAX_NAME } from '@/lib/voucherOrder'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
export type BookKind = 'sales' | 'journal' | 'purchase' | 'bank'

// BOOK FROM TALLY — the "Missing here" lines of a register check (Sales,
// Journal, Purchase) made into vouchers here, exactly as Tally has them.
// Every name the vouchers use must first point at a ledger: one already
// mapped or matched is shown done; the rest are mapped from the list, or made
// as a new ledger, and the choice is remembered for every Tally file after.
// The server reads the file again when booking; nothing shown here is taken
// as a figure.
//
// MANY AT ONCE. Every voucher that could be booked is listed with a tick: the
// ones it was opened for come ticked, and any other can be added. The ledgers
// shown are the ones the TICKED vouchers use, so a name is mapped once for all
// of them; a voucher that still has a name unmapped says which, and one that
// can never be booked here (before the books begin, outside the working
// window, not balancing, an oil purchase or a freight bill) says why and
// cannot be ticked. A POSSIBLE MATCH — Tally's voucher looks like one already
// here — comes unticked and, ticked, is booked only as "Book anyway". Book, or
// Ctrl+A as everywhere else, posts the ticked ones, and only when every one is
// ready.

interface Line {
  side: 'Dr' | 'Cr'
  name: string
  // null for a line that needs no mapping: the round off, or the bank itself.
  key: string | null
  fixed?: string
  amt: number
}
interface Item {
  key: string
  title: string
  sub: string
  date: string
  party: string
  amount: number
  lines: Line[]
  blocked: string | null
  possible: Row | null
}

const ROUND_OFF: Row = { account_id: -1, account_name: 'ROUND OFF A/C' }

const COPY: Record<BookKind, { what: string; whats: string; title: string; info: string }> = {
  sales: {
    what: 'sale',
    whats: 'sales',
    title: 'missing sales',
    info: 'These post to the books only — the party, the income and the GST. No sale lines, stock or dispatch are made, which is right for service, storage and charge invoices. Goods that left the yard should be entered on the Sales page instead.'
  },
  journal: {
    what: 'journal',
    whats: 'journals',
    title: 'missing journals',
    info: 'These post as JOURNAL vouchers under Tally’s number and date, line for line and on the same sides as Tally has them.'
  },
  bank: {
    what: 'entry',
    whats: 'entries',
    title: 'missing bank entries',
    info: 'Each posts as two lines — this bank and the ledger Tally names — as a RECEIPT (money in), a PAYMENT (money out), or a CONTRA when the other side is a bank or cash. A voucher Tally shows "as per details" has several ledgers and is entered by hand.'
  },
  purchase: {
    what: 'purchase',
    whats: 'purchases',
    title: 'missing purchases',
    info: 'These post to the books only — the supplier, the goods or expense, the GST and the TDS, exactly as Tally has them — in the purchase series under the supplier’s invoice number. No stock moves. Oil purchases and freight bills have pages of their own and are not booked here.'
  }
}

function chip(fg: string, bg: string, bd: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: fg, background: bg, border: `1px solid ${bd}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }
}

/** The sales preview and the register preview, as one list. */
function itemsOf(kind: BookKind, pv: Row | null): Item[] {
  if (!pv) return []
  if (kind === 'sales') {
    return ((pv.sales as Row[]) || []).map((x) => ({
      key: String(x.vch_no),
      title: String(x.vch_no),
      sub: '',
      date: String(x.date),
      party: String(x.party),
      amount: Number(x.gross) || 0,
      lines: [
        { side: 'Dr' as const, name: String(x.party), key: String(x.party_key), amt: Number(x.gross) || 0 },
        ...((x.cols as Row[]) || []).map((c) => ({
          side: (Number(c.amount) >= 0 ? 'Cr' : 'Dr') as 'Dr' | 'Cr',
          name: String(c.name),
          key: String(c.key),
          amt: Math.abs(Number(c.amount) || 0)
        })),
        ...(Math.abs(Number(x.round_off)) > 0.004
          ? [{ side: (Number(x.round_off) > 0 ? 'Cr' : 'Dr') as 'Dr' | 'Cr', name: 'Round off', key: null, amt: Math.abs(Number(x.round_off)) }]
          : [])
      ],
      blocked: x.blocked ? String(x.blocked) : null,
      possible: null
    }))
  }
  return ((pv.vouchers as Row[]) || []).map((x) => {
    const lines: Line[] = ((x.lines as Row[]) || []).map((l) => ({
      side: Number(l.dr) > 0 ? 'Dr' : 'Cr',
      name: String(l.name),
      key: l.key == null ? null : String(l.key),
      fixed: l.fixed ? String(l.fixed) : undefined,
      amt: Number(l.dr) || Number(l.cr) || 0
    }))
    if (Math.abs(Number(x.round_off)) > 0.004) lines.push({ side: Number(x.round_off) > 0 ? 'Dr' : 'Cr', name: 'Round off', key: null, amt: Math.abs(Number(x.round_off)) })
    const firstDr = lines.find((l) => l.side === 'Dr')
    return {
      key: String(x.key),
      title: kind === 'purchase' ? String(x.ref_no || x.vch_no) : String(x.vch_no),
      sub: kind === 'purchase' ? `${String(x.type)} · No. ${String(x.vch_no)}` : kind === 'bank' ? String(x.type) : '',
      date: String(x.date),
      party: String(x.party || firstDr?.name || ''),
      amount: Number(x.amount) || 0,
      lines,
      blocked: x.blocked ? String(x.blocked) : null,
      possible: x.possible || null
    }
  })
}

export function TallyBookVouchers({
  kind,
  accountId,
  keys,
  pool,
  readAll,
  companyId,
  b64,
  fileName,
  accounts,
  groupNames,
  onClose,
  onBooked,
  onChanged
}: {
  kind: BookKind
  /** The bank a bank book is booked into. */
  accountId?: number
  /** The vouchers it opens with ticked; null keeps it shut. */
  keys: string[] | null
  /** Every voucher that could be booked from the file — offered to tick as well. */
  pool?: string[]
  /** What to read in the background: every bookable voucher, whatever the
   *  filters show — so narrowing the list does not send it reading again. */
  readAll?: string[]
  companyId?: number
  b64: string
  fileName: string
  accounts: Row[]
  groupNames: Row[]
  onClose: () => void
  onBooked: (created: { id: number }[]) => void | Promise<void>
  onChanged: () => void
}): React.JSX.Element {
  const copy = COPY[kind]
  const [pv, setPv] = useState<Row | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState<{ key: string; name: string; group: string } | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] } | null>(null)
  const [pick, setPick] = useState<Set<string>>(new Set())
  // "Fix every name at once" open over the ledger list.
  const [fixAll, setFixAll] = useState(false)

  // Opened afresh: tick what it was opened for. The preview itself is NOT
  // thrown away — it was read in the background before the click (below), and
  // keeping it is what makes the window open at once.
  useEffect(() => {
    if (!keys) return
    setFixAll(false)
    setPick(new Set(keys))
    setResult(null)
    setCreating(null)
    setOpenKey(keys.length === 1 ? keys[0] : null)
  }, [keys])

  // Everything that could be booked, read from the file — again whenever the
  // list changes (a booking takes the booked ones out of it).
  //
  // READ BEFORE IT IS ASKED FOR. What the window shows is the same whichever
  // row was clicked — every voucher the file could book — so it is read as
  // soon as the check has the list, while the desk is still looking at the
  // rows, and the click only opens it. Keyed on the SET of vouchers (sorted),
  // so opening on one of them does not count as a different question.
  const ask = useMemo(() => [...new Set([...(keys || []), ...(readAll || pool || [])])].sort(), [keys, pool, readAll])
  // What the window lists: what it was opened for and what the filters show.
  const showSet = useMemo(() => new Set([...(keys || []), ...(pool || [])]), [keys, pool])
  const askKey = ask.join('|')
  const isOpen = !!keys
  const readFor = useRef('')
  useEffect(() => {
    if (!ask.length || !b64) return
    const want = `${kind}|${accountId || ''}|${companyId || ''}|${b64.length}|${askKey}`
    if (readFor.current === want) return
    readFor.current = want
    let live = true
    setLoading(true)
    const call =
      kind === 'sales'
        ? window.api.tallyNotes.salesPreview({ company_id: companyId, data_base64: b64, vch_nos: ask })
        : kind === 'bank'
          ? window.api.tallyNotes.bankPreview({ company_id: companyId, account_id: accountId, data_base64: b64, keys: ask })
          : window.api.tallyNotes.registerPreview({ kind, company_id: companyId, data_base64: b64, keys: ask })
    call
      .then((p) => live && setPv(p))
      .catch((e) => {
        readFor.current = ''
        // A background read that fails says nothing until somebody opens it.
        if (isOpenRef.current) toast.error((e as Error).message)
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
      if (readFor.current === want) readFor.current = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, b64, companyId, kind, accountId])
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen

  const allLedgers: Row[] = useMemo(() => pv?.ledgers || [], [pv])
  const items = useMemo(() => itemsOf(kind, pv).filter((x) => !readAll || showSet.has(x.key)), [kind, pv, readAll, showSet])
  const mapOf = useMemo(() => new Map(allLedgers.map((l) => [String(l.key), l])), [allLedgers])
  const mappedOf = (ln: Line): Row | undefined => (ln.key == null ? (ln.fixed ? { account_id: -1, account_name: ln.fixed } : ROUND_OFF) : mapOf.get(ln.key))
  // The names one voucher still needs mapped.
  const unmappedOf = (x: Item): Row[] =>
    [...new Set(x.lines.filter((l) => l.key != null).map((l) => String(l.key)))].map((k) => mapOf.get(k)).filter((l): l is Row => !!l && !l.account_id)
  const picked = items.filter((x) => pick.has(x.key) && !x.blocked)
  const pickable = items.filter((x) => !x.blocked)
  const notReady = picked.filter((x) => unmappedOf(x).length > 0)
  const anyway = picked.filter((x) => !!x.possible)
  // The ledgers the ticked vouchers use, counted over those alone.
  const ledgers: Row[] = useMemo(() => {
    const use = new Map<string, { used_in: number; amount: number }>()
    for (const x of items) {
      if (!pick.has(x.key) || x.blocked) continue
      for (const l of x.lines) {
        if (l.key == null) continue
        const g = use.get(l.key) || { used_in: 0, amount: 0 }
        g.used_in += 1
        g.amount = Math.round((g.amount + l.amt) * 100) / 100
        use.set(l.key, g)
      }
    }
    return allLedgers.filter((l) => use.has(String(l.key))).map((l) => ({ ...l, ...use.get(String(l.key)) }))
  }, [allLedgers, items, pick])
  const unmapped = ledgers.filter((l) => !l.account_id)
  const total = picked.reduce((t, x) => t + x.amount, 0)
  const leftOut = pv ? (keys || []).filter((k) => !items.some((x) => x.key === k)).length : 0
  const canBook = !busy && !loading && picked.length > 0 && unmapped.length === 0

  const toggle = (id: string): void =>
    setPick((s) => {
      const nx = new Set(s)
      if (nx.has(id)) nx.delete(id)
      else nx.add(id)
      return nx
    })

  const setLedger = (key: string, patch: Row): void =>
    setPv((p) => (p ? { ...p, ledgers: (p.ledgers as Row[]).map((x) => (x.key === key ? { ...x, ...patch } : x)) } : p))

  async function mapTo(l: Row, account: Row | null): Promise<void> {
    try {
      await window.api.tallyNotes.saveMap({ tally_name: l.tally_name, account_id: account ? Number(account.id) : null })
      setLedger(String(l.key), { account_id: account ? Number(account.id) : null, account_name: account ? String(account.name) : null, how: account ? 'saved' : null })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function createLedger(): Promise<void> {
    if (!creating) return
    const l = mapOf.get(creating.key)
    if (!l) return
    if (!creating.group) return void toast.error('Pick the group the new ledger goes under')
    try {
      const r = await window.api.tallyNotes.createLedger({ company_id: companyId, tally_name: l.tally_name, name: creating.name, group: creating.group })
      toast.success(`Ledger ${r.name} created under ${creating.group} and mapped`)
      setCreating(null)
      onChanged()
      setLedger(String(l.key), { account_id: r.id, account_name: r.name, how: 'saved' })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function book(): Promise<void> {
    if (!picked.length || unmapped.length) return
    setBusy(true)
    try {
      const r =
        kind === 'sales'
          ? await window.api.tallyNotes.postSales({ company_id: companyId, data_base64: b64, file_name: fileName, vch_nos: picked.map((x) => x.key) })
          : kind === 'bank'
            ? await window.api.tallyNotes.postBank({
                company_id: companyId,
                account_id: accountId,
                data_base64: b64,
                file_name: fileName,
                keys: picked.map((x) => x.key),
                force_keys: anyway.map((x) => x.key)
              })
            : await window.api.tallyNotes.postRegister({
              kind,
              company_id: companyId,
              data_base64: b64,
              file_name: fileName,
              keys: picked.map((x) => x.key),
              force_keys: anyway.map((x) => x.key)
            })
      setResult(r)
      if (r.created.length) {
        toast.success(`${r.created.length} ${r.created.length === 1 ? copy.what : copy.whats} booked from Tally${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`)
        onChanged()
        await onBooked(r.created as { id: number }[])
      } else toast.error('Nothing was booked — see why below')
      // The booked ones drop out of the list as it is read again; the ticks on
      // the ones that were skipped stay, to be fixed and booked.
      if (!r.skipped.length) onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Ctrl+A books, like accepting a voucher anywhere else in the software.
  const bookRef = useRef(book)
  bookRef.current = book
  const keyState = useRef({ canBook, busy, loading, picked: picked.length, unmapped })
  keyState.current = { canBook, busy, loading, picked: picked.length, unmapped }
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || (e.key !== 'a' && e.key !== 'A')) return
      e.preventDefault()
      e.stopPropagation()
      const k = keyState.current
      if (k.canBook) void bookRef.current()
      else if (!k.busy && !k.loading)
        toast.error(k.picked ? `Map or create first: ${k.unmapped.map((l) => String(l.tally_name)).join(', ')}` : `Tick the ${copy.whats} to book`)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, copy.whats])

  const lbl = 'text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#0A1F17]'
  return (
    <Dialog open={!!keys} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        // Esc closes it, as Close does — the mappings are saved as they are
        // made, so nothing typed is lost — but not mid-booking.
        onEscapeKeyDown={(e) => (busy ? e.preventDefault() : escToClose()(e))}
        className="max-h-[90vh] overflow-y-auto overflow-x-hidden border-[#D6E2D6] bg-[#F2F6F1] p-0 !w-[calc(100vw-24px)] !max-w-[1480px]">
        <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">Book from Tally</div>
          <DialogTitle className="mt-1 text-[18px] font-bold text-white">
            {!pv
              ? `The ${copy.title}`
              : picked.length === 1
                ? `${copy.what[0].toUpperCase()}${copy.what.slice(1)} ${picked[0].title}`
                : `${picked.length} of ${pickable.length} ${copy.title} ticked`}
          </DialogTitle>
          <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
            Posted under Tally&rsquo;s own {kind === 'purchase' ? 'bill numbers' : 'numbers'} and dates. Tick the {copy.whats}, map every name they use, then Book
            (Ctrl+A).
          </p>
        </DialogHeader>

        <div className="grid gap-3.5 p-4">
          {loading && !pv && <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-6 text-[12.5px] font-semibold text-[#5A6B62]">Reading the file…</div>}
          {pv && leftOut > 0 && (
            <div className="flex items-start gap-2 rounded-[6px] border border-[#F1D9A6] bg-[#FFF8E9] px-3.5 py-2.5 text-[12px] font-bold text-[#8A5300]">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {leftOut} of the {copy.whats} asked for {leftOut === 1 ? 'is' : 'are'} already in the books or cancelled in Tally, and {leftOut === 1 ? 'is' : 'are'} left out.
            </div>
          )}
          {pv && items.length === 0 && (
            <div className="rounded-[6px] border border-[#D6E2D6] bg-white px-4 py-6 text-[12.5px] font-semibold text-[#5A6B62]">Nothing left to book — check the file again.</div>
          )}

          {pv && items.length > 0 && (
            <>
              {/* 1 · ledgers */}
              <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                  <span className={lbl}>1 · Ledgers</span>
                  <span className="text-[11px] font-semibold text-[#5A6B62]">
                    used by the {picked.length} ticked · a name mapped once is mapped for every {copy.what}
                  </span>
                  {picked.length > 0 && (
                    <span
                      className="ml-auto rounded-[3px] px-2 py-0.5 text-[11px] font-bold"
                      style={unmapped.length ? { background: '#FFF4DD', color: '#8A5300' } : { background: '#E9F5EE', color: '#0B6B45' }}
                    >
                      {unmapped.length ? `${unmapped.length} to map or create` : 'All mapped'}
                    </span>
                  )}
                  {unmapped.length > 1 && !fixAll && (
                    <button
                      type="button"
                      onClick={() => setFixAll(true)}
                      className="flex h-7 items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F]"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> Fix all {unmapped.length}
                    </button>
                  )}
                </div>
                {fixAll && unmapped.length > 0 && (
                  <TallyFixNames
                    ledgers={unmapped}
                    accounts={accounts}
                    groupNames={groupNames}
                    companyId={companyId}
                    onMapped={(key, a) => setLedger(key, { account_id: a.id, account_name: a.name, how: 'saved' })}
                    onChanged={onChanged}
                    onClose={() => setFixAll(false)}
                  />
                )}
                {picked.length === 0 && (
                  <div className="px-4 py-4 text-[12px] font-semibold text-[#5A6B62]">Tick a {copy.what} below to see the ledgers it needs.</div>
                )}
                <div className="divide-y divide-[#EEF3ED]">
                  {ledgers.map((l) => {
                    const mapped = !!l.account_id
                    const isCreating = creating?.key === l.key
                    return (
                      <div key={String(l.key)} className="grid items-center gap-3 px-4 py-2.5 md:grid-cols-[minmax(200px,1fr)_minmax(440px,1.6fr)]">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-extrabold text-[#0A1F17]">{String(l.tally_name)}</span>
                            <span style={l.role === 'party' ? chip('#1B4E82', '#EAF0FA', '#C6DAF0') : chip('#5A6B62', '#EEF3EC', '#DCE7DB')}>
                              {l.role === 'party' ? 'Party' : 'Ledger'}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">
                            in {l.used_in} ticked {l.used_in === 1 ? copy.what : copy.whats} · {formatINR(Number(l.amount) || 0)}
                          </div>
                        </div>
                        {mapped && !isCreating ? (
                          <div className="flex min-w-0 items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#12855A]" />
                            <span className="truncate text-[12.5px] font-bold text-[#0A1F17]">{String(l.account_name)}</span>
                            <span style={l.how === 'auto' ? chip('#0B6B45', '#E9F5EE', '#BFE3CB') : chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>
                              {l.how === 'auto' ? 'Auto' : 'Mapped'}
                            </span>
                            <button type="button" onClick={() => void mapTo(l, null)} className="ml-auto text-[11px] font-extrabold text-[#5A6B62] hover:text-[#B3261E]">
                              Change
                            </button>
                          </div>
                        ) : isCreating ? (
                          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,250px)_auto_auto]">
                            <input
                              autoFocus
                              value={creating?.name ?? ''}
                              onChange={(e) => setCreating((c) => (c ? { ...c, name: e.target.value } : c))}
                              className="col-span-3 h-9 min-w-0 rounded-[4px] border border-[#C3D2C6] px-2.5 text-[12.5px] font-bold uppercase focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15 lg:col-span-1"
                            />
                            <GroupCombo
                              className="w-full"
                              groups={groupNames}
                              value={creating?.group ?? ''}
                              onPick={(g) => setCreating((c) => (c ? { ...c, group: g } : c))}
                              // A group made here joins the chart straight away.
                              onCreated={() => onChanged?.()}
                            />
                            <button
                              type="button"
                              onClick={() => void createLedger()}
                              disabled={!creating?.name?.trim() || !creating?.group}
                              className="flex h-9 items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F] disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              <Check className="h-3.5 w-3.5" /> Create
                            </button>
                            <button
                              type="button"
                              onClick={() => setCreating(null)}
                              className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-[#C3D2C6] text-[#5A6B62]"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="grid gap-1.5">
                            <div className="flex items-center gap-2">
                              <LedgerCombo
                                accounts={accounts}
                                onPick={(a) => void mapTo(l, a)}
                                onCreate={(q) =>
                                  setCreating({ key: String(l.key), name: (q.trim() || String(l.tally_name)).toUpperCase(), group: String(l.suggested_group || '') })
                                }
                              />
                              <button
                                type="button"
                                onClick={() => setCreating({ key: String(l.key), name: String(l.tally_name).toUpperCase(), group: String(l.suggested_group || '') })}
                                className="flex h-9 shrink-0 items-center gap-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[11.5px] font-extrabold text-[#33473E] hover:bg-[#F4FBF6]"
                              >
                                <Plus className="h-3.5 w-3.5" /> New ledger
                              </button>
                            </div>
                            {((l.suggest as Row[]) || []).length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Sparkles className="h-3.5 w-3.5 text-[#8A5300]" />
                                {(l.suggest as Row[]).map((s) => (
                                  <button
                                    key={String(s.id)}
                                    type="button"
                                    title={`${String(s.group)} · ${Math.round(Number(s.score) * 100)}% alike — click to map`}
                                    onClick={() => void mapTo(l, s)}
                                    className="flex items-center gap-1 rounded-[3px] border border-[#F1D9A6] bg-[#FFF8E9] px-2 py-0.5 text-[11px] font-bold text-[#8A5300] hover:bg-[#FFF1D6]"
                                  >
                                    <Link2 className="h-3 w-3" /> {String(s.name)}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>

              {/* 2 · vouchers */}
              <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-wrap items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                  <span className={lbl}>2 · {copy.whats[0].toUpperCase() + copy.whats.slice(1)} to book</span>
                  <span className="text-[12px] font-bold tabular-nums text-[#33473E]">
                    {picked.length} of {pickable.length} ticked · {formatINR(total)}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    {[
                      { k: 'all', label: 'Tick all', go: () => setPick(new Set(pickable.filter((x) => !x.possible).map((x) => x.key))) },
                      { k: 'ready', label: 'Ready only', go: () => setPick(new Set(pickable.filter((x) => !x.possible && unmappedOf(x).length === 0).map((x) => x.key))) },
                      { k: 'none', label: 'None', go: () => setPick(new Set()) }
                    ].map((b) => (
                      <button
                        key={b.k}
                        type="button"
                        disabled={busy}
                        onClick={b.go}
                        title={b.k === 'none' ? undefined : 'Possible matches are left for you to tick one by one'}
                        className="h-7 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#33473E] hover:bg-[#F4FBF6]"
                      >
                        {b.label}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="divide-y divide-[#EEF3ED]">
                  {items.map((x) => {
                    const id = x.key
                    const open = openKey === id
                    const blocked = x.blocked
                    const on = !blocked && pick.has(id)
                    const missing = unmappedOf(x)
                    const lines = orderVoucherLines(x.lines, (ln) => ({ account: ln.name, dr: ln.side === 'Dr', tax: TAX_NAME.test(ln.name), amount: ln.amt }))
                    const ready = !blocked && missing.length === 0
                    return (
                      <div key={id} style={on ? { background: x.possible ? '#FFFCF2' : '#FBFDF8' } : undefined}>
                        <div className="grid w-full items-center gap-2 px-4 py-2.5 text-left" style={{ gridTemplateColumns: '22px 18px minmax(96px,150px) 92px minmax(160px,1fr) 130px 112px' }}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            aria-label={`Book ${x.title}`}
                            disabled={!!blocked || busy}
                            onClick={() => toggle(id)}
                            title={blocked ? `Cannot be booked here — ${blocked}` : on ? 'Leave this one out' : x.possible ? 'Book it anyway — it is a different voucher' : 'Book this one too'}
                            className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border disabled:cursor-not-allowed disabled:opacity-40"
                            style={on ? { background: '#0B3D2E', borderColor: '#0B3D2E', color: '#C7F03F' } : { background: '#fff', borderColor: '#B9CBBE', color: 'transparent' }}
                          >
                            <Check className="h-3 w-3" strokeWidth={3.5} />
                          </button>
                          <button type="button" onClick={() => setOpenKey(open ? null : id)} aria-label={open ? 'Hide the posting' : 'Show the posting'} className="flex items-center">
                            <ChevronRight className="h-3.5 w-3.5 text-[#8CA396]" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                          </button>
                          <button type="button" onClick={() => setOpenKey(open ? null : id)} className="flex min-w-0 flex-col text-left">
                            <span className="truncate text-[12.5px] font-extrabold tabular-nums text-[#0A1F17]">{x.title}</span>
                            {x.sub && <span className="truncate text-[10px] font-bold text-[#8CA396]">{x.sub}</span>}
                          </button>
                          <span className="text-[12px] font-semibold tabular-nums text-[#33473E]">{formatDate(x.date)}</span>
                          <span className="truncate text-[12.5px] font-bold text-[#0A1F17]" title={x.party}>
                            {x.party}
                          </span>
                          <span className="text-right text-[12.5px] font-bold tabular-nums text-[#0A1F17]">{formatINR(x.amount)}</span>
                          <span className="text-right">
                            <span
                              style={
                                blocked
                                  ? chip('#B3261E', '#FDF3F2', '#F0D6D4')
                                  : x.possible
                                    ? chip('#8A5300', '#FFF4DD', '#F1D9A6')
                                    : ready
                                      ? chip('#0B6B45', '#E9F5EE', '#BFE3CB')
                                      : chip('#8A5300', '#FFF4DD', '#F1D9A6')
                              }
                            >
                              {blocked ? 'Not here' : x.possible ? (on ? 'Book anyway' : 'Possible match') : ready ? 'Ready' : `Map ${missing.length}`}
                            </span>
                          </span>
                        </div>
                        {(blocked || x.possible || (on && missing.length > 0)) && (
                          <div
                            className="-mt-1 flex items-start gap-1.5 px-4 pb-2 pl-[62px] text-[11px] font-bold"
                            style={{ color: blocked ? '#B3261E' : '#8A5300' }}
                          >
                            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                            <span>
                              {blocked
                                ? `Not booked here — ${blocked}.`
                                : x.possible
                                  ? `Looks like ${String(x.possible.code || x.possible.type)}${x.possible.vch_no ? ` (${String(x.possible.vch_no)})` : ''} already here — ${formatDate(String(x.possible.date))}, ${formatINR(Number(x.possible.amount) || 0)}. ${on ? 'Ticked: it will be booked as a separate voucher.' : 'Tick it only if it is a different one.'}`
                                  : ''}
                              {!blocked && on && missing.length > 0 && `${x.possible ? ' ' : ''}Not mapped yet: ${missing.map((l) => String(l.tally_name)).join(', ')}`}
                            </span>
                          </div>
                        )}
                        {open && (
                          <div className="mx-4 mb-3 overflow-hidden rounded-[5px] border border-[#E4ECE3] bg-[#FBFCFA]">
                            {lines.map((ln, i) => {
                              const m = mappedOf(ln)
                              return (
                                <div key={i} className="flex items-center gap-2.5 border-b border-[#EFF3EE] px-3 py-1.5 last:border-b-0">
                                  <span className="w-6 text-[11px] font-extrabold" style={{ color: ln.side === 'Dr' ? '#1B4E82' : '#B3261E' }}>
                                    {ln.side}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#0A1F17]">
                                    {m?.account_id ? String(m.account_name) : <span className="text-[#8A5300]">{ln.name} · not mapped</span>}
                                    {m?.account_id && ln.name.toUpperCase() !== String(m.account_name).toUpperCase() && (
                                      <span className="ml-1.5 text-[10.5px] font-semibold text-[#8CA396]">Tally: {ln.name}</span>
                                    )}
                                  </span>
                                  <span className="text-[12px] font-bold tabular-nums">{formatINR(ln.amt)}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>

              <div className="flex items-start gap-2 rounded-[6px] border border-[#C6DAF0] bg-[#EAF0FA] px-3.5 py-2.5 text-[11.5px] font-semibold text-[#1B4E82]">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {copy.info}
              </div>
            </>
          )}

          {result && result.skipped.length > 0 && (
            <div className="rounded-[6px] border border-[#F1D9A6] bg-[#FFF8E9] px-3.5 py-2.5 text-[12px] font-semibold text-[#8A5300]">
              {result.created.length > 0 && <div className="font-extrabold text-[#0B6B45]">{result.created.length} booked: {result.created.map((c) => c.vch_no).join(', ')}</div>}
              {result.skipped.map((s, i) => (
                <div key={`${s.vch_no}-${i}`} className="mt-1">
                  {s.vch_no} skipped — {s.reason}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-[#D6E2D6] bg-white px-5 py-3">
          <span className="min-w-0 flex-1 text-[12px] font-semibold" style={{ color: unmapped.length ? '#B3261E' : '#5A6B62' }}>
            {!pv
              ? ''
              : !picked.length
                ? `Tick the ${copy.whats} to book.`
                : unmapped.length
                  ? `${notReady.length} of the ${picked.length} ticked still need${notReady.length === 1 ? 's' : ''} a ledger — map or create: ${unmapped
                      .slice(0, 3)
                      .map((l) => String(l.tally_name))
                      .join(', ')}${unmapped.length > 3 ? ` +${unmapped.length - 3} more` : ''}`
                  : `${picked.length} voucher${picked.length === 1 ? '' : 's'} · ${formatINR(total)} · every name mapped${anyway.length ? ` · ${anyway.length} booked anyway` : ''}`}
          </span>
          {notReady.length > 0 && notReady.length < picked.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setPick((s) => {
                  const nx = new Set(s)
                  for (const x of notReady) nx.delete(x.key)
                  return nx
                })
              }
              className="h-10 rounded-[4px] border border-[#F1D9A6] bg-[#FFF8E9] px-3 text-[12px] font-extrabold text-[#8A5300]"
            >
              Leave out the {notReady.length} not ready
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-10 rounded-[4px] border border-[#D6E2D6] bg-white px-4 text-[12px] font-extrabold text-[#33473E]"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!canBook}
            onClick={() => void book()}
            title="Ctrl+A"
            className="flex h-10 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            {busy ? 'Booking…' : `Book ${picked.length || ''} ${picked.length === 1 ? copy.what : copy.whats}`}
            <span className="rounded-[2px] bg-white/10 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal">Ctrl+A</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
