import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, ChevronRight, ExternalLink, Link2, Loader2, Search, TriangleAlert, Unlink } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { errText, formatDate, formatINR } from '@/lib/format'
import { isTaxByGroup, orderVoucherLines } from '@/lib/voucherOrder'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type BargainKind = 'purchase' | 'sales'

// VOUCHERS LINKED TO A BARGAIN.
//
// An advance paid against a purchase bargain, a receipt taken before a sales
// bargain was dispatched, a journal for a rate difference, a note for a short
// delivery — none of these name the bargain they belong to. This panel lets
// somebody say so: pick the voucher type, then the voucher.
//
// A link is a reference only. Nothing here posts, changes or removes a voucher,
// and the bargain's quantity and balance are untouched — see
// src/main/bargainVouchers.ts.

const api = (kind: BargainKind): typeof window.api.bargains | typeof window.api.salesBargains =>
  kind === 'purchase' ? window.api.bargains : window.api.salesBargains

// The types a desk links by hand come first, in the order it reaches for them;
// whatever else the books hold follows by how much of it there is.
const TYPE_ORDER = ['PAYMENT', 'RECEIPT', 'JOURNAL', 'CONTRA', 'DEBIT NOTE', 'CREDIT NOTE']

function typeLabel(t: string): string {
  return String(t || '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// Letters and digits only, so "ASHOK SOAP & OIL, TAMIL NADU" finds itself
// whether a ledger spells the ampersand, the comma or neither.
const norm = (s: unknown): string => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// The first voucher type to show: what a bargain of this kind is most often
// paid or settled with, if the books have any.
function defaultType(kind: BargainKind, types: Row[]): string {
  const have = new Set(types.map((t) => String(t.vch_type)))
  const want = kind === 'purchase' ? ['PAYMENT', 'JOURNAL'] : ['RECEIPT', 'JOURNAL']
  return want.find((t) => have.has(t)) || String(types[0]?.vch_type || '')
}

const SHOW = 200

export function BargainVouchersDialog({
  kind,
  bargain,
  onClose,
  onChanged
}: {
  kind: BargainKind
  // The register row: id and bargain_no are enough; the party is read back
  // from the server, which knows it for either kind.
  bargain: Row | null
  onClose: () => void
  // How many vouchers are linked now, after a link or an unlink.
  onChanged?: (bargainId: number, count: number) => void
}): React.JSX.Element {
  const id = Number(bargain?.id) || 0
  const [linked, setLinked] = useState<Row[] | null>(null)
  const [head, setHead] = useState<Row | null>(null)
  const [types, setTypes] = useState<Row[]>([])
  const [type, setType] = useState('')
  const [vouchers, setVouchers] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [onlyParty, setOnlyParty] = useState(true)
  const [picked, setPicked] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<number, Row[] | 'loading' | 'gone'>>({})
  const searchRef = useRef<HTMLInputElement>(null)

  const loadLinked = async (): Promise<Row[]> => {
    const rows = await api(kind).linkedVouchers(id).catch(() => [] as Row[])
    setLinked(rows)
    return rows
  }

  // A different bargain is a fresh panel.
  useEffect(() => {
    if (!id) return
    let live = true
    setLinked(null)
    setHead(null)
    setTypes([])
    setType('')
    setVouchers(null)
    setQ('')
    setPicked(null)
    setNote('')
    setError(null)
    setLines({})
    void api(kind)
      .linkedVouchers(id)
      .then((rows) => live && setLinked(rows))
      .catch(() => live && setLinked([]))
    void api(kind)
      .voucherChoices(id)
      .then((r) => {
        if (!live) return
        setHead((r.bargain as Row) || null)
        const ts = ((r.types as Row[]) || []).slice().sort((a, b) => {
          const ia = TYPE_ORDER.indexOf(String(a.vch_type))
          const ib = TYPE_ORDER.indexOf(String(b.vch_type))
          if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
          return Number(b.count) - Number(a.count)
        })
        setTypes(ts)
        setType(defaultType(kind, ts))
      })
      .catch((e) => live && setError(errText(e)))
    return () => {
      live = false
    }
  }, [id, kind])

  // The chosen type's vouchers. The party filter starts on when the party has
  // any of them, and off when it has none — an empty list would read as "no
  // vouchers of this type" rather than "none for this party".
  const party = String(head?.party || bargain?.supplier_name || bargain?.customer || '')
  const partyKeys = useMemo(() => {
    const full = norm(party)
    const lead = norm(party.split(',')[0])
    return [full, lead].filter((k) => k.length >= 3)
  }, [party])
  const forParty = (v: Row): boolean => {
    if (!partyKeys.length) return false
    const hay = norm(`${v.dr_accounts || ''} ${v.cr_accounts || ''} ${v.narration || ''}`)
    return partyKeys.some((k) => hay.includes(k))
  }
  useEffect(() => {
    if (!id || !type) return
    let live = true
    setVouchers(null)
    setPicked(null)
    void api(kind)
      .voucherChoices(id, type)
      .then((r) => {
        if (!live) return
        const vs = (r.vouchers as Row[]) || []
        setVouchers(vs)
        setOnlyParty(vs.some(forParty))
      })
      .catch((e) => {
        if (!live) return
        setVouchers([])
        setError(errText(e))
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, type, partyKeys.join('|')])

  const partyCount = useMemo(() => (vouchers || []).filter(forParty).length, [vouchers, partyKeys])
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    const digits = t.replace(/[^0-9.]/g, '')
    return (vouchers || []).filter((v) => {
      if (onlyParty && partyCount > 0 && !forParty(v)) return false
      if (!t) return true
      const hay = `${v.code || ''} ${v.vch_no || ''} ${v.narration || ''} ${v.dr_accounts || ''} ${v.cr_accounts || ''} ${formatDate(v.entry_date)}`.toLowerCase()
      if (hay.includes(t)) return true
      // An amount typed as 1,00,000 or 100000 finds the same voucher.
      return !!digits && digits.length >= 3 && String(Number(v.amount) || 0).includes(digits.replace(/\.0*$/, ''))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vouchers, q, onlyParty, partyCount, partyKeys])

  const pickedRow = picked != null ? (vouchers || []).find((v) => Number(v.id) === picked) || null : null

  async function link(): Promise<void> {
    if (!pickedRow || busy) return
    setBusy(true)
    setError(null)
    try {
      await api(kind).linkVoucher(id, Number(pickedRow.id), note)
      toast.success(`${pickedRow.code || 'Voucher'} linked to ${bargain?.bargain_no || 'the bargain'}`)
      setVouchers((vs) => (vs || []).map((v) => (Number(v.id) === Number(pickedRow.id) ? { ...v, linked: true } : v)))
      setPicked(null)
      setNote('')
      const rows = await loadLinked()
      onChanged?.(id, rows.length)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function unlink(l: Row): Promise<void> {
    if (busy) return
    const label = String(l.code || typeLabel(String(l.vch_type)) || 'this voucher')
    if (!confirm(`Unlink ${label} from ${bargain?.bargain_no || 'this bargain'}?\n\nOnly the link is removed — the voucher itself is not changed.`)) return
    setBusy(true)
    setError(null)
    try {
      await api(kind).unlinkVoucher(id, Number(l.link_id))
      toast.success(`${label} unlinked`)
      setVouchers((vs) => (vs || []).map((v) => (Number(v.id) === Number(l.id) ? { ...v, linked: false } : v)))
      setLines((m) => {
        const next = { ...m }
        delete next[Number(l.id)]
        return next
      })
      const rows = await loadLinked()
      onChanged?.(id, rows.length)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggleLines(entryId: number): Promise<void> {
    if (lines[entryId]) {
      setLines((m) => {
        const next = { ...m }
        delete next[entryId]
        return next
      })
      return
    }
    setLines((m) => ({ ...m, [entryId]: 'loading' }))
    const v = await window.api.vouchers.get(entryId).catch(() => null)
    setLines((m) => ({ ...m, [entryId]: v ? ((v.lines as Row[]) || []) : 'gone' }))
  }

  // The website opens the voucher itself, in Accounting, in a tab of its own
  // so this register stays where it is.
  const openInAccounts = (entryId: number): void => {
    const co = Number(head?.company_id) || 0
    window.open(`/accounts?co=${co}&s=voucher&id=${entryId}`, '_blank', 'noopener')
  }

  const linkedIds = new Set((linked || []).map((l) => Number(l.id)))
  const count = linked?.length ?? 0

  const accountsLine = (v: Row): React.JSX.Element => (
    <div className="mt-0.5 flex min-w-0 flex-col gap-px text-[11.5px] font-semibold leading-[1.4] text-[#33473E]">
      {v.dr_accounts && (
        <span className="truncate">
          <span className="mr-1 text-[10px] font-extrabold text-[#1F4E8C]">Dr</span>
          {String(v.dr_accounts)}
        </span>
      )}
      {v.cr_accounts && (
        <span className="truncate">
          <span className="mr-1 text-[10px] font-extrabold text-[#8C2F26]">Cr</span>
          {String(v.cr_accounts)}
        </span>
      )}
    </div>
  )

  return (
    <Dialog open={!!bargain} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          '!grid !max-h-[90vh] !w-[680px] !max-w-[95vw] !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !bg-[#F1F5EF] !p-0 [&>button]:!right-5 [&>button]:!top-5 [&>button]:!text-white [&>button]:!opacity-70 [&>button]:hover:!opacity-100',
          // A right-hand drawer on the website, like the register's other panels.
          __WEB__ &&
            '!bottom-0 !left-auto !right-0 !top-0 !h-screen !max-h-screen !translate-x-0 !translate-y-0 !rounded-none !border-0 max-sm:!max-w-full sm:!rounded-none'
        )}
      >
        <DialogHeader className="!block !space-y-0 !bg-[#0B3D2E] !px-[22px] !py-[18px] !text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
            {kind === 'purchase' ? 'Purchase bargain' : 'Sales bargain'} · linked vouchers
          </div>
          <DialogTitle className="!mt-1.5 !text-[19px] !font-extrabold !tracking-[-0.02em] !text-white">
            Link a voucher
          </DialogTitle>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="doc-ref break-all text-[12.5px] font-bold text-[#D9EFE2]">{String(bargain?.bargain_no || '')}</span>
            {party && <span className="text-[12px] font-semibold text-[#A9CDBB]">{party}</span>}
          </div>
          <p className="mt-2.5 text-[11.5px] font-semibold leading-[1.6] text-[#A9CDBB] [text-wrap:pretty]">
            Tie an advance, a receipt, a journal or a note to this bargain. A link is a reference only — the voucher and
            the bargain&apos;s balance stay exactly as they are.
          </p>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-[22px] py-4">
          <div className="flex flex-col gap-4">
            {/* ALREADY LINKED */}
            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div className="flex items-center gap-2.5 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2.5">
                <Link2 className="h-[17px] w-[17px] text-[#0B6B45]" />
                <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">Linked to this bargain</span>
                <span className="doc-ref ml-auto rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-bold text-[#5A6B62]">{count}</span>
              </div>
              {linked === null ? (
                <div className="flex items-center justify-center gap-2 px-4 py-5 text-[12px] font-semibold text-[#5A6B62]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : linked.length === 0 ? (
                <div className="px-4 py-5 text-center text-[12px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                  No vouchers are linked yet. Pick a type and a voucher below.
                </div>
              ) : (
                <div>
                  {linked.map((l) => {
                    const eid = Number(l.id)
                    const ls = lines[eid]
                    return (
                      <div key={String(l.link_id)} className={cn('border-b border-[#EFF3EE] last:border-b-0', l.missing && 'bg-[#FDF3F2]')}>
                        <div className="flex items-start gap-3 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => !l.missing && void toggleLines(eid)}
                            disabled={!!l.missing}
                            title={l.missing ? undefined : ls ? 'Hide its lines' : 'Show its lines'}
                            className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-[3px] text-[#5A6B62] hover:bg-[#EAF0E9] disabled:opacity-40"
                          >
                            {ls ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                              <span className="doc-ref text-[13px] font-extrabold text-[#0A1F17]">{String(l.code || `#${l.vch_no || eid}`)}</span>
                              <span className="rounded-[2px] bg-[#EAF0E9] px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[.05em] text-[#33473E]">
                                {typeLabel(String(l.vch_type || ''))}
                              </span>
                              <span className="doc-ref text-[11px] font-semibold text-[#5A6B62]">{formatDate(l.entry_date)}</span>
                              <span className="doc-ref ml-auto text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatINR(l.amount)}</span>
                            </div>
                            {l.missing ? (
                              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] font-bold text-[#8C2F26]">
                                <TriangleAlert className="h-3.5 w-3.5" /> This voucher has been deleted since it was linked.
                              </div>
                            ) : (
                              <>
                                {accountsLine(l)}
                                {String(l.narration || '').trim() && (
                                  <div className="mt-0.5 truncate text-[11px] font-semibold text-[#5A6B62]">{String(l.narration)}</div>
                                )}
                              </>
                            )}
                            {String(l.note || '').trim() && (
                              <div className="mt-1.5 rounded-[3px] border-l-[3px] border-l-[#12855A] bg-[#F3FBF6] px-2 py-1 text-[11.5px] font-semibold text-[#0B6B45]">
                                {String(l.note)}
                              </div>
                            )}
                            <div className="mt-1 text-[10.5px] font-semibold text-[#8A9A91]">
                              Linked{l.created_by_name ? ` by ${String(l.created_by_name)}` : ''}
                              {l.created_at ? ` · ${formatDate(String(l.created_at).slice(0, 10))}` : ''}
                            </div>
                          </div>
                          <div className="flex flex-none items-center gap-1">
                            {__WEB__ && !l.missing && (
                              <button
                                type="button"
                                onClick={() => openInAccounts(eid)}
                                title="Open this voucher in Accounting (new tab)"
                                className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#D6E2D6] bg-white text-[#33473E] hover:bg-[#F7FAF6]"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void unlink(l)}
                              disabled={busy}
                              title="Unlink — the voucher itself is not changed"
                              className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] text-[#B3261E] hover:bg-[#FBE7E5] disabled:opacity-50"
                            >
                              <Unlink className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        {ls && (
                          <div className="px-4 pb-3 pl-[52px]">
                            {ls === 'loading' ? (
                              <div className="flex items-center gap-2 text-[11.5px] font-semibold text-[#5A6B62]">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading its lines…
                              </div>
                            ) : ls === 'gone' ? (
                              <div className="text-[11.5px] font-semibold text-[#8C2F26]">Its lines could not be read.</div>
                            ) : (
                              <div className="overflow-hidden rounded-[4px] border border-[#DCE7DB]">
                                {orderVoucherLines(ls, (x) => ({
                                  account: String(x.account),
                                  dr: Number(x.dr) > 0,
                                  tax: isTaxByGroup(String(x.account), String(x.acc_group || '')),
                                  amount: Number(x.dr) || Number(x.cr) || 0
                                })).map((x, k) => (
                                  <div key={k} className="grid grid-cols-[34px_minmax(0,1fr)_110px_110px] items-center border-b border-[#EFF3EE] bg-white text-[11.5px] last:border-b-0">
                                    <span className={cn('py-1.5 text-center text-[10px] font-extrabold', Number(x.dr) > 0 ? 'text-[#1F4E8C]' : 'text-[#8C2F26]')}>
                                      {Number(x.dr) > 0 ? 'Dr' : 'Cr'}
                                    </span>
                                    <span className="truncate py-1.5 pr-2 font-semibold">{String(x.account)}</span>
                                    <span className="py-1.5 pr-3 text-right font-bold tabular-nums text-[#1F4E8C]">{Number(x.dr) > 0 ? formatINR(x.dr) : ''}</span>
                                    <span className="py-1.5 pr-3 text-right font-bold tabular-nums text-[#8C2F26]">{Number(x.cr) > 0 ? formatINR(x.cr) : ''}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 1 · THE TYPE */}
            <div className="rounded-[4px] border border-[#D6E2D6] bg-white p-4">
              <div className="mb-2 text-[12px] font-extrabold text-[#33473E]">
                <span className="mr-1.5 text-[#5A6B62]">1</span> Voucher type
              </div>
              {types.length === 0 ? (
                <div className="text-[12px] font-semibold text-[#5A6B62]">
                  {head ? 'These books have no vouchers yet.' : 'Loading…'}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {types.map((t) => {
                    const on = String(t.vch_type) === type
                    return (
                      <button
                        key={String(t.vch_type)}
                        type="button"
                        onClick={() => {
                          setType(String(t.vch_type))
                          setQ('')
                          searchRef.current?.focus()
                        }}
                        className={cn(
                          'flex h-9 items-center gap-2 rounded-[4px] border-[1.5px] px-3 text-[12.5px] transition-colors',
                          on ? 'border-[#12855A] bg-[#E9F5EE] font-extrabold text-[#0B6B45]' : 'border-[#C3D2C6] bg-white font-bold text-[#33473E] hover:bg-[#F7FAF6]'
                        )}
                      >
                        {typeLabel(String(t.vch_type))}
                        <span className={cn('rounded-[2px] px-1.5 py-px text-[10px] font-bold tabular-nums', on ? 'bg-white text-[#0B6B45]' : 'bg-[#EAF0E9] text-[#5A6B62]')}>
                          {Number(t.count) || 0}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 2 · THE VOUCHER */}
            {type && (
              <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                <div className="flex flex-col gap-2.5 border-b border-[#E4ECE3] p-4 pb-3">
                  <div className="text-[12px] font-extrabold text-[#33473E]">
                    <span className="mr-1.5 text-[#5A6B62]">2</span> {typeLabel(type)} voucher no
                  </div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5A6B62]" />
                    <Input
                      ref={searchRef}
                      autoFocus
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        if (pickedRow) void link()
                        else {
                          const first = shown.find((v) => !v.linked && !linkedIds.has(Number(v.id)))
                          if (first) setPicked(Number(first.id))
                        }
                      }}
                      placeholder="Voucher no, ledger, narration or amount"
                      className="!h-11 !rounded-[4px] !pl-9 !text-[13px]"
                    />
                  </div>
                  {partyCount > 0 && (
                    <label className="flex cursor-pointer items-center gap-2 text-[12px] font-bold text-[#33473E]">
                      <input
                        type="checkbox"
                        checked={onlyParty}
                        onChange={(e) => setOnlyParty(e.target.checked)}
                        className="h-4 w-4 accent-[#12855A]"
                      />
                      Only {party}&apos;s vouchers
                      <span className="font-semibold text-[#5A6B62]">
                        ({partyCount} of {(vouchers || []).length})
                      </span>
                    </label>
                  )}
                </div>
                {vouchers === null ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-6 text-[12px] font-semibold text-[#5A6B62]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading {typeLabel(type)} vouchers…
                  </div>
                ) : shown.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12px] font-semibold text-[#5A6B62] [text-wrap:pretty]">
                    {q.trim() ? `No ${typeLabel(type)} voucher matches “${q.trim()}”.` : `No ${typeLabel(type)} vouchers in these books.`}
                  </div>
                ) : (
                  <div className="max-h-[340px] overflow-y-auto">
                    {shown.slice(0, SHOW).map((v) => {
                      const vid = Number(v.id)
                      const already = !!v.linked || linkedIds.has(vid)
                      const on = picked === vid
                      return (
                        <button
                          key={vid}
                          type="button"
                          disabled={already}
                          onClick={() => setPicked(on ? null : vid)}
                          className={cn(
                            'flex w-full items-start gap-3 border-b border-l-[3px] border-b-[#EFF3EE] px-4 py-2.5 text-left transition-colors last:border-b-0',
                            on ? 'border-l-[#12855A] bg-[#E9F5EE]' : 'border-l-transparent hover:bg-[#F7FAF6]',
                            already && 'cursor-default opacity-60 hover:bg-transparent'
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border-[1.5px]',
                              on ? 'border-[#12855A] bg-[#12855A] text-white' : 'border-[#C3D2C6] bg-white'
                            )}
                          >
                            {(on || already) && <Check className={cn('h-3 w-3', already && !on && 'text-[#5A6B62]')} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-baseline gap-x-2.5">
                              <span className="doc-ref text-[13px] font-extrabold text-[#0A1F17]">{String(v.code || `#${v.vch_no || vid}`)}</span>
                              {v.vch_no && v.code && String(v.vch_no) !== String(v.code) && (
                                <span className="doc-ref text-[11px] font-semibold text-[#5A6B62]">{String(v.vch_no)}</span>
                              )}
                              <span className="doc-ref text-[11px] font-semibold text-[#5A6B62]">{formatDate(v.entry_date)}</span>
                              {already && (
                                <span className="rounded-[2px] bg-[#EAF0E9] px-1.5 py-px text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#33473E]">
                                  Linked
                                </span>
                              )}
                              <span className="doc-ref ml-auto text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatINR(v.amount)}</span>
                            </span>
                            {accountsLine(v)}
                            {String(v.narration || '').trim() && (
                              <span className="mt-0.5 block truncate text-[11px] font-semibold text-[#5A6B62]">{String(v.narration)}</span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                    {shown.length > SHOW && (
                      <div className="px-4 py-2.5 text-center text-[11.5px] font-semibold text-[#5A6B62]">
                        Showing the latest {SHOW} of {shown.length} — search to narrow.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-[4px] border border-[#F0D6D4] border-l-4 border-l-[#B3261E] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F26]">
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-[#D6E2D6] bg-white px-[22px] py-3.5">
          {pickedRow && (
            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold text-[#33473E]">
              <span className="font-extrabold text-[#0B6B45]">Linking</span>
              <span className="doc-ref font-extrabold">{String(pickedRow.code || `#${pickedRow.vch_no || pickedRow.id}`)}</span>
              <span className="text-[#5A6B62]">
                {typeLabel(String(pickedRow.vch_type))} · {formatDate(pickedRow.entry_date)} · {formatINR(pickedRow.amount)}
              </span>
            </div>
          )}
          {/* On a phone the note takes its own row; the two buttons share the next. */}
          <div className="flex flex-wrap items-center gap-2.5 sm:flex-nowrap">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pickedRow) {
                  e.preventDefault()
                  void link()
                }
              }}
              placeholder="Note (optional) — e.g. advance against this bargain"
              className="!h-12 !min-w-0 !basis-full !rounded-[4px] !text-[13px] sm:!basis-0 sm:!flex-1"
            />
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-12 flex-none rounded-[4px] border-[1.5px] border-[#C3D2C6] px-5 text-[13px] font-extrabold uppercase tracking-[.03em] text-[#33473E] transition-colors hover:bg-[#F7FAF6] disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void link()}
              disabled={!pickedRow || busy}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[4px] bg-[#0B6B45] px-6 sm:flex-none text-[13px] font-extrabold uppercase tracking-[.03em] text-white transition-colors hover:bg-[#095A3A] disabled:cursor-not-allowed disabled:bg-[#9DB8A9]"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Link voucher
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
