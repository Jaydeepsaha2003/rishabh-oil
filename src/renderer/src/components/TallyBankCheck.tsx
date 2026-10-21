import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarCheck, Check, ExternalLink, FilePlus2, FileText, Landmark, Link2, Plus, RefreshCw, RotateCcw, Search, Unlink, Upload, X } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { ExcelButton } from '@/components/ExcelButton'
import { TallyBookVouchers } from '@/components/TallyBookVouchers'
import { TallyBatches } from '@/components/TallyBatches'
import { draftTime } from '@/components/TallySalesCheck'
import { ColumnFilter } from '@/components/ui/column-filter'
import { useColumnFilters, type ColumnSpec } from '@/lib/useColumnFilters'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// BANK BOOK CHECK — a bank's book from Tally against the same bank here.
// First the bank (a ledger under Bank Accounts / Bank OD), then Tally's book
// of it. The balances come first — opening, money in, money out, closing,
// Tally beside these books — then every line: matched, a date to fix, a
// possible match (an entry the software posted itself under its own number),
// missing here, or here and not in Tally. What is missing is booked from the
// file as a RECEIPT, PAYMENT or CONTRA on this bank, in the same dialog as
// the registers; a date that differs is moved to Tally's.

const STATUS: Record<string, { label: string; fg: string; bg: string; bd: string; tip: string }> = {
  matched: { label: 'Matched', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', tip: 'Same day, amount and party in both' },
  mismatch: { label: 'Not matching', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'In both, but the date or amount differs' },
  possible: { label: 'Possible match', fg: '#7A4B00', bg: '#FFF6E0', bd: '#EBCB86', tip: 'Same amount within days, under another ledger or number' },
  missing_here: { label: 'Missing here', fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', tip: 'In Tally’s book, not in this bank here' },
  missing_tally: { label: 'Not in Tally', fg: '#1B4E82', bg: '#EAF0FA', bd: '#C6DAF0', tip: 'In this bank here, not in Tally’s book' },
  cancelled: { label: 'Cancelled in Tally', fg: '#5A6B62', bg: '#EEF3EC', bd: '#DCE7DB', tip: 'Cancelled in Tally, not here either' },
  cancelled_here: { label: 'Cancelled · here', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'Cancelled in Tally, still here' },
  statement_only: { label: 'Bank statement only', fg: '#6B3FA0', bg: '#F3EEFA', bd: '#DCCDF0', tip: 'On the bank’s own statement, in neither Tally nor these books' }
}
const FIELD: Record<string, string> = { date: 'Date', amount: 'Amount', party: 'Ledger' }

function chip(fg: string, bg: string, bd: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: fg, background: bg, border: `1px solid ${bd}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }
}

const kept: { filter: string; q: string; dir: string; focus: string; cols: Record<string, string[]> } = { filter: 'problems', q: '', dir: '', focus: '', cols: {} }

export function TallyBankCheck({
  focusBank,
  companyName,
  companyId,
  accounts = [],
  groupNames = [],
  onChanged = () => {},
  onOpenVoucher
}: {
  /** Open this bank's book — from a card on the overview. */
  focusBank?: { id: number; n: number } | null
  companyName: string
  companyId?: number
  accounts?: Row[]
  groupNames?: Row[]
  onChanged?: () => void
  onOpenVoucher?: (entryId: number) => void
}): React.JSX.Element {
  // This company's own bank accounts — ticked once under Manage; until then,
  // the bank ledgers this company has used. Never another company's banks, the
  // LC side's, or the generic BANK A/C.
  const [own, setOwn] = useState<{ chosen: boolean; banks: Row[] }>({ chosen: false, banks: [] })
  const [managing, setManaging] = useState(false)
  const loadOwn = async (): Promise<void> => {
    if (!companyId) return
    try {
      setOwn(await window.api.tallyNotes.companyBanks({ company_id: companyId }))
    } catch {
      /* the picker falls back to nothing chosen */
    }
  }
  useEffect(() => {
    void loadOwn()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, accounts.length])
  const banks = useMemo(
    () => (own.chosen ? own.banks.filter((b) => b.business) : own.banks.filter((b) => b.used && !b.generic)),
    [own]
  )
  const [bankId, setBankId] = useState<number | null>(null)
  const bank = own.banks.find((b) => Number(b.id) === bankId) || null
  const [picking, setPicking] = useState(false)
  const [newBank, setNewBank] = useState<string | null>(null)
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null)
  // The bank's own statement — optional, the third witness.
  const [stmt, setStmt] = useState<{ name: string; b64: string } | null>(null)
  const stmtRef = useRef<HTMLInputElement>(null)
  const [batchTick, setBatchTick] = useState(0)
  // Every book kept here, one per bank, so switching bank brings back its own.
  const [drafts, setDrafts] = useState<Row[]>([])
  // Every bank book uploaded in this company, by anybody — so each accountant
  // can pick the bank they are working, and open a colleague's book too.
  const [books, setBooks] = useState<Row[]>([])
  const loadBooks = async (): Promise<Row[]> => {
    if (!companyId) return []
    const bs = ((await window.api.tallyNotes.bankBooks({ company_id: companyId }).catch(() => [])) as Row[]) || []
    setBooks(bs)
    return bs
  }
  const [res, setRes] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState(kept.filter)
  const [q, setQ] = useState(kept.q)
  const [dir, setDir] = useState(kept.dir)
  const [focus, setFocus] = useState(kept.focus)
  const [savedAt, setSavedAt] = useState('')
  const [bookKeys, setBookKeys] = useState<string[] | null>(null)
  const [dateAsk, setDateAsk] = useState<string | null>(null)
  const [allAsk, setAllAsk] = useState(false)
  const [fixing, setFixing] = useState(false)
  useEffect(() => {
    kept.filter = filter
    kept.q = q
    kept.dir = dir
  }, [filter, q, dir])
  const fileRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0
  }, [filter, q, dir])
  const scrolledTo = useRef('')
  useEffect(() => {
    if (!res) {
      scrolledTo.current = ''
      return
    }
    if (!focus || scrolledTo.current === focus) return
    scrolledTo.current = focus
    setTimeout(() => tableRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center' }))
  }, [res, focus])
  const companyNow = useRef(companyId)
  companyNow.current = companyId

  async function run(f: { name: string; b64: string }, acct: number, fromDraft?: string, st?: { name: string; b64: string } | null): Promise<void> {
    const forCompany = companyId
    const statement = st === undefined ? stmt : st
    setBusy(true)
    try {
      const checked = await window.api.tallyNotes.bankCheck({
        company_id: forCompany,
        account_id: acct,
        data_base64: f.b64,
        file_name: f.name,
        statement_base64: statement?.b64 || undefined,
        statement_name: statement?.name || undefined
      })
      if (companyNow.current !== forCompany) return
      setRes(checked)
      setFile(f)
      setStmt(statement || null)
      if (fromDraft) setSavedAt(fromDraft)
      else {
        const s = await window.api.tallyNotes.saveDraft({
          company_id: forCompany,
          kind: `bank:${acct}`,
          file_name: f.name,
          data_base64: f.b64,
          period_from: checked.from,
          period_to: checked.to
        })
        if (companyNow.current === forCompany) setSavedAt(s.saved_at)
        // A book for less than the one kept: checked, but the full book stays
        // this bank's — unless that is what was meant.
        if (s.kept) {
          const kept = s.kept
          toast.message(
            `Checked ${f.name} (${formatDate(String(checked.from))}${checked.to !== checked.from ? ` to ${formatDate(String(checked.to))}` : ''}) — this bank's saved book, ${kept.file_name} (${formatDate(kept.from)} to ${formatDate(kept.to)}), is kept.`,
            {
              duration: 12000,
              action: {
                label: 'Replace saved book',
                onClick: () => {
                  void window.api.tallyNotes
                    .saveDraft({ company_id: forCompany, kind: `bank:${acct}`, file_name: f.name, data_base64: f.b64, period_from: checked.from, period_to: checked.to, replace: true })
                    .then((r) => {
                      setSavedAt(r.saved_at)
                      void loadDrafts()
                      void loadBooks()
                      toast.success(`${f.name} is now this bank's saved book`)
                    })
                    .catch((e) => toast.error((e as Error).message))
                }
              }
            }
          )
        }
        void loadDrafts()
        void loadBooks()
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function loadDrafts(): Promise<Row[]> {
    if (!companyId) return []
    const ds = ((await window.api.tallyNotes.drafts({ company_id: companyId }).catch(() => [])) as Row[]) || []
    setDrafts(ds)
    return ds
  }

  /** A bank's own kept book and statement, checked again — or, when this
   *  user has none for it, the latest book a colleague uploaded. */
  function openBank(acct: number, ds: Row[], bs: Row[] = books): boolean {
    const d = ds.find((x) => x.kind === `bank:${acct}`)
    if (!d) {
      const other = bs.find((x) => Number(x.account_id) === acct)
      if (!other) return false
      void window.api.tallyNotes
        .bankBook({ company_id: companyId, account_id: acct, username: String(other.username) })
        .then((b) => {
          if (!b) return
          toast.message(`${String(b.file_name || 'The book')} — uploaded by ${String(b.username)}`)
          void run({ name: String(b.file_name || ''), b64: String(b.data_base64) }, acct, String(b.saved_at || ''), null)
        })
        .catch((e) => toast.error((e as Error).message))
      return true
    }
    const s = ds.find((x) => x.kind === `bankstmt:${acct}`)
    void run(
      { name: String(d.file_name || ''), b64: String(d.data_base64) },
      acct,
      String(d.saved_at || ''),
      s ? { name: String(s.file_name || ''), b64: String(s.data_base64) } : null
    )
    return true
  }

  // WHICH BANK FIRST. Several banks with a book uploaded — by this
  // accountant or the others — and the tab asks which one to work on rather
  // than opening whichever was saved last; one bank, and it simply opens.
  useEffect(() => {
    let live = true
    setRes(null)
    setFile(null)
    setStmt(null)
    setSavedAt('')
    if (!companyId) return
    void Promise.all([loadDrafts(), loadBooks()]).then(([ds, bs]) => {
      if (!live || focusBank?.id) return
      const withBooks = [...new Set(bs.map((b) => Number(b.account_id)).filter(Boolean))]
      if (withBooks.length > 1) {
        setBankId(null)
        setPicking(true)
        return
      }
      const last = ds
        .filter((x) => /^bank:\d+$/.test(String(x.kind)))
        .sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)))[0]
      const acct = last ? Number(String(last.kind).slice(5)) : withBooks[0]
      if (!acct) return
      setBankId(acct)
      openBank(acct, ds, bs)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  useEffect(() => {
    if (!focusBank?.id || !companyId) return
    void loadDrafts().then((ds) => {
      setBankId(focusBank.id)
      setPicking(false)
      openBank(focusBank.id, ds)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBank?.n])

  function pickBank(id: number): void {
    setBankId(id)
    setPicking(false)
    setNewBank(null)
    // The bank's own book when it has one. Otherwise an empty page waiting for
    // ITS book — the one on screen belongs to the bank just left, and is kept
    // there untouched (re-checking it against this bank used to save it as
    // this bank's book too).
    if (openBank(id, drafts)) return
    setRes(null)
    setFile(null)
    setStmt(null)
    setSavedAt('')
  }

  function chooseStatement(f: File | undefined): void {
    if (!f) return
    if (!bankId || !file) return void toast.error('Upload the Tally book first, then the bank’s statement')
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const st = { name: f.name, b64: s.slice(s.indexOf(',') + 1) }
      void (async () => {
        await window.api.tallyNotes.saveDraft({ company_id: companyId, kind: `bankstmt:${bankId}`, file_name: st.name, data_base64: st.b64 }).catch(() => {})
        await run(file, bankId, savedAt || undefined, st)
        void loadDrafts()
      })()
    }
    r.readAsDataURL(f)
  }

  async function dropStatement(): Promise<void> {
    if (!bankId || !file) return
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind: `bankstmt:${bankId}` }).catch(() => {})
    await run(file, bankId, savedAt || undefined, null)
    void loadDrafts()
  }

  async function linkSame(r: Row, on: boolean): Promise<void> {
    if (!file || !bankId) return
    try {
      if (on) await window.api.tallyNotes.link({ company_id: companyId, scope: `bank:${bankId}`, tally_key: String(r.key), entry_id: Number(r.books.id) })
      else await window.api.tallyNotes.unlink({ company_id: companyId, scope: `bank:${bankId}`, tally_key: String(r.key) })
      toast.success(on ? `Remembered: Tally ${String(r.tally?.vch_type || '')} ${String(r.tally?.vch_no || '')} is ${String(r.books?.code || 'that entry')}` : 'Link removed')
      await run(file, bankId, savedAt || undefined)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // REVERSE — take our voucher back out of these books. For a line booked
  // wrongly (or twice): the voucher here is deleted through the ordinary
  // voucher delete, with its rights and its guards — one posted by a purchase,
  // sale, note, LC or discounted bill is refused and said so, to be reversed
  // from that document. The Tally line then reads Missing here again and can
  // be booked afresh.
  async function reverseHere(r: Row): Promise<void> {
    const b = r.books
    if (!b?.id || !file || !bankId) return
    const amt = formatINR(Math.abs(Number(b.amount) || 0))
    // ON A DOCUMENT'S VOUCHER THAT WAS BOOKED TWICE, the one to take back is
    // the COPY booked from Tally — this voucher is the one that stays.
    const copy = r.duplicate_of as Row | undefined
    if (copy?.id) {
      const chain = copy.chain as Row | undefined
      const extras = ((copy.extra as Row[]) || []).map((e) => String(e.code))
      if (extras.length) {
        if (
          !window.confirm(
            `Reverse ${[String(copy.code), ...extras, ...(chain ? [String(chain.code)] : [])].join(', ')} — booked from Tally, the same money as ${String(b.code || 'this voucher')}?

${String(b.code || 'This voucher')} stays, and stands for Tally's lines.`
          )
        )
          return
        try {
          await reverseCopy(copy, b)
          toast.success(`${[String(copy.code), ...extras, ...(chain ? [String(chain.code)] : [])].join(', ')} reversed`)
          onChanged?.()
          await run(file, bankId, savedAt || undefined)
        } catch (e) {
          toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        }
        return
      }
      if (
        !window.confirm(
          chain
            ? `Reverse ${String(copy.code)} and ${String(chain.code)} — Tally's payment into ${String(chain.via)} and the journal that moves it on, both booked from Tally?

${String(b.code || 'This voucher')} stays, and stands for both Tally entries.`
            : `Reverse ${String(copy.code)} — the copy of this ${amt} that was booked from Tally?

${String(b.code || 'This voucher')} stays, and matches the Tally line instead.`
        )
      )
        return
      try {
        await reverseCopy(copy, b)
        toast.success(`${String(copy.code)}${chain ? ` and ${String(chain.code)}` : ''} reversed — ${String(b.code || 'this voucher')} now stands for the Tally line`)
        onChanged?.()
        await run(file, bankId, savedAt || undefined)
      } catch (e) {
        toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
      return
    }
    if (!window.confirm(`Reverse ${String(b.code || 'this voucher')} (${amt}) — delete it from these books?

The Tally line goes back to Missing here and can be booked again.`)) return
    try {
      await window.api.vouchers.remove(Number(b.id))
      if (r.linked) await window.api.tallyNotes.unlink({ company_id: companyId, scope: `bank:${bankId}`, tally_key: String(r.key) }).catch(() => {})
      toast.success(`${String(b.code || 'Voucher')} reversed — the Tally line is back under Missing here`)
      onChanged?.()
      await run(file, bankId, savedAt || undefined)
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  // One copy back out — and, for Tally's two-step, the journal that cleared
  // its parking ledger too, with Tally's journal remembered as this voucher
  // so the journal check never offers it to book again.
  async function reverseCopy(copy: Row, own: Row): Promise<void> {
    await window.api.vouchers.remove(Number(copy.id))
    // Tally's payment into a parking ledger came with lines that came back —
    // they go too, and every one of Tally's bank lines is remembered as this
    // voucher so none is offered to book again.
    for (const e of (copy.extra as Row[]) || []) await window.api.vouchers.remove(Number(e.id))
    for (const k of (copy.links as string[]) || [])
      await window.api.tallyNotes.link({ company_id: companyId, scope: `bank:${bankId}`, tally_key: k, entry_id: Number(own.id), also: true }).catch(() => {})
    const chain = copy.chain as Row | undefined
    if (!chain?.id) return
    await window.api.vouchers.remove(Number(chain.id))
    if (chain.vch_no)
      await window.api.tallyNotes
        .link({ company_id: companyId, scope: 'journal', tally_key: `JOURNAL|${String(chain.vch_no)}`, entry_id: Number(own.id) })
        .catch(() => {})
  }

  // EVERY COPY AT ONCE — each document voucher flagged "booked twice" takes
  // its copy (booked from Tally) back; the document vouchers stay.
  async function reverseCopies(list: Row[]): Promise<void> {
    if (!file || !bankId || !list.length) return
    const pairs = list.map((r) => ({ copy: r.duplicate_of as Row, own: r.books as Row }))
    const chained = pairs.filter((x) => x.copy.chain).map((x) => String(x.copy.chain.code))
    const total = pairs.reduce((t, x) => t + Math.abs(Number(x.own?.amount) || 0), 0)
    if (
      !window.confirm(
        `Reverse ${pairs.length} copies booked from Tally — ${pairs.map((x) => String(x.copy.code)).join(', ')} (${formatINR(total)} in all)${chained.length ? `, with the journals that clear them (${chained.join(', ')})` : ''}?

${pairs.map((x) => String(x.own?.code || '')).join(', ')} stay, and match Tally's lines instead.`
      )
    )
      return
    setBusy(true)
    let done = 0
    for (const x of pairs) {
      try {
        await reverseCopy(x.copy, x.own)
        done++
      } catch (e) {
        toast.error(`${String(x.copy.code)}: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      }
    }
    if (done) {
      toast.success(`${done} ${done === 1 ? 'copy' : 'copies'} reversed`)
      onChanged?.()
    }
    setBusy(false)
    await run(file, bankId, savedAt || undefined)
  }

  async function createBank(name: string): Promise<void> {
    const nm = name.trim()
    if (!nm) return
    try {
      const r = await window.api.tallyNotes.createLedger({ company_id: companyId, tally_name: String(res?.bank || nm), name: nm, group: 'Bank Accounts' })
      toast.success(`Bank ledger ${r.name} created under Bank Accounts`)
      // A bank made here is one of this company's accounts.
      await window.api.tallyNotes.setCompanyBank({ company_id: companyId, account_id: r.id, on: true }).catch(() => {})
      await loadOwn()
      onChanged()
      setNewBank(null)
      setBankId(r.id)
      setPicking(false)
      if (file) void run(file, r.id, undefined, null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function clearCheck(): Promise<void> {
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind: `bank:${bankId}` }).catch(() => {})
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind: `bankstmt:${bankId}` }).catch(() => {})
    void loadDrafts()
    setRes(null)
    setFile(null)
    setStmt(null)
    setSavedAt('')
    toast.success('Bank book check cleared')
  }

  function choose(f: File | undefined): void {
    if (!f) return
    if (!bankId) return void toast.error('Pick the bank first')
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      void run({ name: f.name, b64: s.slice(s.indexOf(',') + 1) }, bankId)
    }
    r.readAsDataURL(f)
  }
  const hasStmt = !!res?.statement

  async function useTallyDate(list: Row[]): Promise<void> {
    if (!file || !bankId || !list.length) return
    setFixing(true)
    let done = 0
    const failed: string[] = []
    for (const r of list) {
      try {
        await window.api.tallyNotes.fixRegisterDate({ company_id: companyId, entry_id: Number(r.books.id), date: String(r.tally.date) })
        done++
      } catch (e) {
        failed.push(`${String(r.books?.code || r.tally?.vch_no)}: ${(e as Error).message}`)
      }
    }
    setDateAsk(null)
    setAllAsk(false)
    if (done) {
      toast.success(done === 1 ? `${String(list[0].books?.code || 'Entry')} moved to ${formatDate(String(list[0].tally.date))}` : `${done} entries moved to Tally's date`)
      onChanged()
    }
    for (const f of failed.slice(0, 4)) toast.error(f)
    await run(file, bankId, savedAt || undefined)
    setFixing(false)
  }

  function openHere(r: Row): void {
    if (!onOpenVoucher || !r.books?.id) return
    kept.focus = String(r.key)
    setFocus(kept.focus)
    onOpenVoucher(Number(r.books.id))
  }

  const rows: Row[] = useMemo(() => res?.rows || [], [res])
  // The ledgers of an "as per details" voucher, when the detailed book gave them.
  const detailNames = (r: Row): string[] => (Array.isArray(r.tally?.details) ? (r.tally.details as Row[]).map((d) => String(d.name)) : [])
  const side = (r: Row): Row => r.tally || r.books || r.stmt || {}
  const tabbed = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'problems' && (r.status === 'matched' || r.status === 'cancelled')) return false
      if (filter !== 'problems' && filter !== 'all' && r.status !== filter) return false
      if (dir && side(r).dir !== dir) return false
      if (!needle) return true
      return [r.tally?.party, ...detailNames(r), r.tally?.vch_no, ...((r.also as Row[]) || []).map((a) => a.vch_no), r.tally?.vch_type, r.books?.code, r.books?.party, String(side(r).amount)].some((x) => String(x || '').toLowerCase().includes(needle))
    })
  }, [rows, filter, q, dir])
  // A search that only finds lines on ANOTHER tab — a matched line is hidden
  // under "To look at", so searching for it there read as "missing".
  const elsewhere = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle || filter === 'all') return [] as Row[]
    return rows.filter(
      (r) =>
        !tabbed.includes(r) &&
        (!dir || side(r).dir === dir) &&
        [r.tally?.party, ...detailNames(r), r.tally?.vch_no, ...((r.also as Row[]) || []).map((a) => a.vch_no), r.tally?.vch_type, r.books?.code, r.books?.party, String(side(r).amount)].some((x) =>
          String(x || '').toLowerCase().includes(needle)
        )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tabbed, q, dir, filter])
  const amt = (d: 'in' | 'out'): ColumnSpec<Row> => ({
    get: (r) => (side(r).dir === d ? String(Math.round(Number(side(r).amount) * 100) / 100) : ''),
    label: (v) => (v === '' ? '(blank)' : formatINR(Number(v))),
    numeric: true
  })
  const colSpecs: Record<string, ColumnSpec<Row>> = {
    date: { get: (r) => String(side(r).date || '').slice(0, 10), label: (v) => (v ? formatDate(v) : '(blank)') },
    vch: { get: (r) => String(r.tally?.vch_type || r.books?.vch_type || '') },
    // A voucher split over several ledgers is found under each of them.
    party: {
      get: (r) => (detailNames(r).length ? detailNames(r).join(' · ') : String(r.tally?.party || r.books?.party || '')),
      many: (r) => (detailNames(r).length ? detailNames(r) : [String(r.tally?.party || r.books?.party || '')])
    },
    in: amt('in'),
    out: amt('out'),
    here: { get: (r) => String(r.books?.code || '') },
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
  // Narrowed by a search, a column filter (or In / Out) — then "Book
  // missing" offers only what is on screen, e.g. one party's entries.
  const narrowed = !!q.trim() || !!dir || cf.activeCount > 0
  const bookable = (narrowed ? shown : rows).filter((r) => r.bookable)
  const missingBookable = bookable.filter((r) => r.status === 'missing_here')
  const copies = (narrowed ? shown : rows).filter((r) => (r.duplicate_of as Row | undefined)?.id)
  const redatable = rows.filter((r) => r.redate === 'yes')
  const problems = (c.mismatch || 0) + (c.possible || 0) + (c.missing_here || 0) + (c.missing_tally || 0) + (c.cancelled_here || 0) + (c.statement_only || 0)
  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const GRID = hasStmt ? '104px 180px minmax(220px,1.5fr) 132px 132px 140px 190px 176px' : '104px 190px minmax(260px,1.6fr) 140px 140px 150px 176px'
  const bal = res?.balances || {}
  const balanceText = (v: number): string => `${formatINR(Math.abs(v))} ${v < 0 ? 'Cr' : 'Dr'}`

  return (
    <div className="flex min-h-0 flex-col gap-3.5">
      {/* 1 · the bank, 2 · its book */}
      <section className={`${card} shrink-0`}>
        <div className="grid gap-0 md:grid-cols-[minmax(300px,0.9fr)_1.6fr] md:divide-x md:divide-[#E4ECE3]">
          <div className="p-4">
            <div className="flex items-center gap-2 text-[10.5px] font-extrabold uppercase tracking-[.12em] text-[#0A1F17]">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] text-[#C7F03F]">1</span> The bank
            </div>
            {bank && !picking ? (
              <div className="mt-2.5 flex items-center gap-2.5 rounded-[5px] border border-[#BFE3CB] bg-[#F4FBF6] px-3 py-2.5">
                <Landmark className="h-5 w-5 shrink-0 text-[#0B6B45]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-extrabold text-[#0A1F17]">{String(bank.name)}</span>
                  <span className="block text-[10.5px] font-bold uppercase tracking-[.06em] text-[#5A6B62]">{String(bank.acc_group)}</span>
                </span>
                <button type="button" onClick={() => setPicking(true)} className="text-[11px] font-extrabold text-[#0B6B45] hover:underline">
                  Change
                </button>
              </div>
            ) : (
              <div className="mt-2.5 grid gap-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[11px] font-semibold text-[#5A6B62]">
                    {!bank && new Set(books.map((b) => Number(b.account_id))).size > 1 ? (
                      <span className="block text-[12.5px] font-extrabold text-[#0A1F17]">
                        Choose the bank you are working on — {new Set(books.map((b) => Number(b.account_id))).size} banks have a Tally book uploaded
                      </span>
                    ) : null}
                    {own.chosen ? 'Your business bank accounts' : 'Bank ledgers this company has used — tick your business accounts under Manage'}
                  </span>
                  <button type="button" onClick={() => setManaging((m) => !m)} className="text-[11px] font-extrabold text-[#0B6B45] hover:underline">
                    {managing ? 'Done' : 'Manage'}
                  </button>
                </div>
                {managing ? (
                  <div className="max-h-[260px] divide-y divide-[#EEF3ED] overflow-y-auto rounded-[5px] border border-[#D6E2D6]">
                    {own.banks
                      .filter((b) => !b.generic)
                      .map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() =>
                            void window.api.tallyNotes
                              .setCompanyBank({ company_id: companyId, account_id: b.id, on: !b.business })
                              .then(loadOwn)
                              .catch((e) => toast.error((e as Error).message))
                          }
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[#F7FAF6]"
                        >
                          <span
                            className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border"
                            style={b.business ? { background: '#0B3D2E', borderColor: '#0B3D2E', color: '#C7F03F' } : { background: '#fff', borderColor: '#B9CBBE', color: 'transparent' }}
                          >
                            <Check className="h-3 w-3" strokeWidth={3.5} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-bold text-[#0A1F17]">{String(b.name)}</span>
                            <span className="block text-[10.5px] font-semibold text-[#5A6B62]">
                              {b.used ? `${Number(b.lines)} entries in this company` : 'Not used by this company'}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    {[
                      // Banks with a Tally book uploaded come first, and always
                      // show — even one not ticked as a business account here.
                      ...own.banks.filter((b) => books.some((k) => Number(k.account_id) === Number(b.id))),
                      ...banks.filter((b) => !books.some((k) => Number(k.account_id) === Number(b.id)))
                    ].map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => pickBank(Number(b.id))}
                        className="flex items-center gap-2.5 rounded-[5px] border px-3 py-2 text-left transition-colors hover:border-[#8FBFA8] hover:bg-[#F4FBF6]"
                        style={{ borderColor: Number(b.id) === bankId ? '#0B6B45' : '#D6E2D6' }}
                      >
                        <Landmark className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-extrabold text-[#0A1F17]">{String(b.name)}</span>
                          <span className="block text-[10px] font-bold uppercase tracking-[.06em] text-[#5A6B62]">
                            {String(b.acc_group)}
                          </span>
                          {(() => {
                            // Whose book this bank has: yours first, else the latest colleague's.
                            const mine = books.find((x) => Number(x.account_id) === Number(b.id) && x.mine)
                            const theirs = books.filter((x) => Number(x.account_id) === Number(b.id) && !x.mine)
                            const shown = mine || theirs[0]
                            if (!shown) return null
                            return (
                              <span className="mt-0.5 block truncate text-[10.5px] font-semibold normal-case tracking-normal" style={{ color: mine ? '#0B6B45' : '#1B4E82' }}>
                                {mine ? 'Your book' : `${String(shown.username)}'s book`} · {String(shown.file_name || 'Tally book')} · {draftTime(String(shown.saved_at))}
                                {mine && theirs.length ? ` · also ${theirs.map((x) => String(x.username)).join(', ')}` : ''}
                              </span>
                            )
                          })()}
                        </span>
                        <span className="shrink-0 text-[11.5px] font-bold tabular-nums" style={{ color: Number(b.balance) < 0 ? '#B3261E' : '#0B6B45' }}>
                          {b.used ? balanceText(Number(b.balance) || 0) : 'Nil'}
                        </span>
                      </button>
                    ))}
                    {!banks.length && (
                      <span className="text-[11px] font-semibold text-[#8A5300]">
                        {own.chosen ? 'No business account ticked — use Manage.' : 'No bank ledger used by this company yet — tick one under Manage, or create it.'}
                      </span>
                    )}
                  </div>
                )}
                {newBank !== null ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={newBank}
                      onChange={(e) => setNewBank(e.target.value.toUpperCase())}
                      placeholder="HDFC BANK 50200003404370 (RAJ NAGAR)"
                      className="h-9 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] px-2.5 text-[12px] font-bold uppercase"
                    />
                    <button type="button" onClick={() => void createBank(newBank)} className="flex h-9 items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F]">
                      <Check className="h-3.5 w-3.5" /> Create
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setNewBank(String(res?.bank || '').toUpperCase())}
                    className="flex w-fit items-center gap-1 text-[11px] font-extrabold text-[#33473E] hover:text-[#0B6B45]"
                  >
                    <Plus className="h-3.5 w-3.5" /> New bank ledger
                  </button>
                )}
              </div>
            )}
          </div>
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
              disabled={busy || !bankId}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                choose(e.dataTransfer.files?.[0])
              }}
              className="flex min-h-[74px] min-w-[280px] flex-1 items-center gap-3 rounded-[6px] border-2 border-dashed border-[#BFD3C2] bg-[#FBFCFA] px-4 text-left hover:bg-[#F4FBF6] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] font-extrabold text-[#C7F03F]">2</span>
              <Upload className="h-6 w-6 shrink-0 text-[#0B6B45]" />
              <span className="min-w-0">
                <span className="block text-[13px] font-extrabold text-[#0A1F17]">
                  {busy
                    ? 'Checking…'
                    : !bankId
                      ? 'Pick the bank first, then its Tally book'
                      : file
                        ? file.name
                        : `Choose or drop ${bank ? `${String(bank.name)}'s` : 'the'} Tally bank book (.xlsx)`}
                </span>
                <span className="block text-[11.5px] font-semibold text-[#5A6B62]">
                  Tally → Display → Account Books → Cash/Bank Book → the bank → Export as Excel. Nothing is posted — this only compares.
                </span>
              </span>
            </button>
            {res && (
              <div className="grid gap-1 text-[12px] font-semibold text-[#33473E]">
                <span>
                  <b>{String(res.bank || '—')}</b> · {String(res.period || '')}
                </span>
                <span>Checked against {String(res.account?.name || '')}</span>
                <button type="button" onClick={() => file && bankId && void run(file, bankId, savedAt || undefined)} className="flex items-center gap-1 text-[11.5px] font-extrabold text-[#0B6B45]">
                  <RefreshCw className="h-3.5 w-3.5" /> Check again
                </button>
                {savedAt && (
                  <span className="flex flex-wrap items-center gap-2">
                    <span style={chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>Saved · {draftTime(savedAt)}</span>
                    <button type="button" onClick={() => void clearCheck()} className="text-[11px] font-extrabold text-[#B3261E] hover:underline">
                      Clear
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {res && (
          <div className="flex flex-wrap items-center gap-3 border-t border-[#E4ECE3] bg-[#FBFCFA] px-4 py-2.5">
            <input
              ref={stmtRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                chooseStatement(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#6B3FA0] text-[10px] font-extrabold text-[#6B3FA0]">3</span>
            <FileText className="h-4 w-4 text-[#6B3FA0]" />
            {res.statement ? (
              <>
                <span className="text-[12px] font-bold text-[#0A1F17]">
                  Bank&rsquo;s statement: {String(res.statement.name)} · {Number(res.statement.lines)} lines · {formatDate(String(res.statement.from))} to {formatDate(String(res.statement.to))}
                </span>
                <span className="text-[11px] font-semibold text-[#5A6B62]">Every line now says what the bank itself shows.</span>
                <button type="button" disabled={busy} onClick={() => stmtRef.current?.click()} className="ml-auto text-[11px] font-extrabold text-[#6B3FA0] hover:underline">
                  Replace
                </button>
                <button type="button" disabled={busy} onClick={() => void dropStatement()} className="flex items-center gap-0.5 text-[11px] font-extrabold text-[#B3261E] hover:underline">
                  <X className="h-3.5 w-3.5" /> Remove
                </button>
              </>
            ) : (
              <>
                <span className="text-[12px] font-bold text-[#0A1F17]">Add the bank&rsquo;s own statement (optional)</span>
                <span className="text-[11px] font-semibold text-[#5A6B62]">
                  The bank&rsquo;s .xlsx or .csv — it settles which side is right when Tally and these books disagree, and shows what neither has.
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => stmtRef.current?.click()}
                  className="ml-auto flex h-8 items-center gap-1.5 rounded-[4px] border border-[#DCCDF0] bg-white px-3 text-[11.5px] font-extrabold text-[#6B3FA0] hover:bg-[#F3EEFA]"
                >
                  <Upload className="h-3.5 w-3.5" /> Upload statement
                </button>
              </>
            )}
          </div>
        )}
        {res?.bank_mismatch && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[#F1D9A6] bg-[#FFF8E9] px-4 py-2.5 text-[12px] font-bold text-[#8A5300]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              This is Tally&rsquo;s book of <b>{String(res.bank)}</b>, but it is being checked against <b>{String(res.account?.name)}</b>. Pick the right bank — or create
              it, if these books do not have it yet.
            </span>
            <button type="button" onClick={() => setPicking(true)} className="h-7 rounded-[4px] border border-[#F1D9A6] bg-white px-2.5 text-[11px] font-extrabold">
              Pick another bank
            </button>
            <button
              type="button"
              onClick={() => {
                setPicking(true)
                setNewBank(String(res.bank || '').toUpperCase())
              }}
              className="h-7 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11px] font-extrabold text-[#C7F03F]"
            >
              Create {String(res.bank)}
            </button>
          </div>
        )}
        {res?.company_mismatch && (
          <div className="flex items-start gap-2 border-t border-[#F1D9A6] bg-[#FFF8E9] px-4 py-2.5 text-[12px] font-bold text-[#8A5300]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This book is from {String(res.file_company)}, but you are in {String(res.company)}. Switch company (F3) to check it against the right books.
          </div>
        )}
      </section>

      {res && (
        <>
          {/* Where the bank stands — Tally beside these books. */}
          <section className={`${card} shrink-0`}>
            <div className="grid grid-cols-2 divide-x divide-y divide-[#E4ECE3] md:grid-cols-4 md:divide-y-0">
              {[
                { k: 'Opening', t: Number(bal.tally?.opening) || 0, b: Number(bal.books?.opening) || 0, s: bal.bank?.opening, signed: true, icon: null },
                { k: 'Money in', t: Number(bal.tally?.in) || 0, b: Number(bal.books?.in) || 0, s: bal.bank?.in, signed: false, icon: <ArrowDownLeft className="h-3.5 w-3.5 text-[#0B6B45]" /> },
                { k: 'Money out', t: Number(bal.tally?.out) || 0, b: Number(bal.books?.out) || 0, s: bal.bank?.out, signed: false, icon: <ArrowUpRight className="h-3.5 w-3.5 text-[#B3261E]" /> },
                { k: 'Closing', t: Number(bal.tally?.closing) || 0, b: Number(bal.books?.closing) || 0, s: bal.bank?.closing, signed: true, icon: null }
              ].map((x) => {
                const gap = Math.round((x.t - x.b) * 100) / 100
                const ok = Math.abs(gap) <= 1
                return (
                  <div key={x.k} className="min-w-0 px-4 py-3">
                    <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                      {x.icon}
                      {x.k}
                    </div>
                    <div className="mt-1 grid gap-0.5 text-[12px] tabular-nums">
                      <span className="flex justify-between gap-2">
                        <span className="font-bold text-[#1B4E82]">Tally</span>
                        <span className="font-bold text-[#0A1F17]">{x.signed ? balanceText(x.t) : formatINR(x.t)}</span>
                      </span>
                      <span className="flex justify-between gap-2">
                        <span className="font-bold text-[#0B6B45]">Here</span>
                        <span className="font-bold text-[#0A1F17]">{x.signed ? balanceText(x.b) : formatINR(x.b)}</span>
                      </span>
                      {bal.bank && (
                        <span className="flex justify-between gap-2">
                          <span className="font-bold text-[#6B3FA0]">Bank</span>
                          <span className="font-bold text-[#0A1F17]">{x.s == null ? '—' : x.signed ? balanceText(Number(x.s)) : formatINR(Number(x.s))}</span>
                        </span>
                      )}
                      <span className="flex justify-between gap-2">
                        <span className="font-semibold text-[#5A6B62]">Tally − here</span>
                        <span className="font-extrabold" style={{ color: ok ? '#0B6B45' : '#B3261E' }}>
                          {ok ? 'Agrees' : formatINR(gap)}
                        </span>
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className={`grid grid-cols-4 border-t border-[#E4ECE3] ${hasStmt ? 'sm:grid-cols-8' : 'sm:grid-cols-7'}`}>
              {(['matched', 'mismatch', 'possible', 'missing_here', 'missing_tally', 'cancelled', 'cancelled_here', ...(hasStmt ? (['statement_only'] as const) : [])] as const).map((k) => {
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
          </section>

          <TallyBatches
            companyId={companyId}
            kind="bank"
            scope={bankId ? `bank:${bankId}` : undefined}
            refresh={batchTick}
            onUndone={async () => {
              if (file && bankId) await run(file, bankId, savedAt || undefined)
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
                  ...(hasStmt ? [{ k: 'statement_only', label: 'Bank only', n: Number(c.statement_only || 0) }] : []),
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
                      <span className="rounded-[3px] px-1.5 text-[10.5px] tabular-nums" style={on ? { background: 'rgba(255,255,255,.16)', color: '#C7F03F' } : { background: '#EEF3EC', color: '#5A6B62' }}>
                        {f.n}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="flex overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                {[
                  { k: '', label: 'In & out' },
                  { k: 'in', label: 'Money in' },
                  { k: 'out', label: 'Money out' }
                ].map((d, i) => (
                  <button
                    key={d.k || 'all'}
                    type="button"
                    onClick={() => setDir(d.k)}
                    className={`h-8 px-3 text-[11.5px] font-extrabold ${i ? 'border-l border-[#D6E2D6]' : ''}`}
                    style={dir === d.k ? { background: '#0B3D2E', color: '#fff' } : { color: '#33473E' }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="relative min-w-[200px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8CA396]" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search ledger, voucher no or amount"
                  className="h-8 w-full rounded-[4px] border border-[#D6E2D6] bg-white pl-8 pr-2.5 text-[12px] font-semibold"
                />
              </div>
              {missingBookable.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBookKeys(missingBookable.map((r) => String(r.key)))}
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-[#FFF8E9] px-3 text-[11.5px] font-extrabold text-[#8A5300] hover:bg-[#FFF1D6]"
                >
                  <FilePlus2 className="h-3.5 w-3.5" /> Book missing · {missingBookable.length}
                </button>
              )}
              {copies.length > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reverseCopies(copies)}
                  title="Take back every copy booked from Tally that a document's own voucher already carries"
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#F0D6D4] bg-[#FFF5F4] px-3 text-[11.5px] font-extrabold text-[#B3261E] hover:bg-[#FDECEA] disabled:opacity-60"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reverse copies · {copies.length}
                </button>
              )}
              {redatable.length > 0 && (
                <button
                  type="button"
                  disabled={fixing}
                  onClick={() => setAllAsk(true)}
                  className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#BFE3CB] bg-[#F4FBF6] px-3 text-[11.5px] font-extrabold text-[#0B6B45] hover:bg-[#E9F5EE] disabled:opacity-60"
                >
                  <CalendarCheck className="h-3.5 w-3.5" /> Use Tally&rsquo;s date · {redatable.length}
                </button>
              )}
              {cf.activeCount > 0 && (
                <button type="button" onClick={cf.clear} className="h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#B3261E] hover:bg-[#FDF3F2]">
                  Clear {cf.activeCount} column filter{cf.activeCount === 1 ? '' : 's'}
                </button>
              )}
              <span className="text-[11.5px] font-semibold text-[#5A6B62]">{shown.length} shown</span>
              <ExcelButton
                filename={`tally-bank-check-${String(res.from || '')}-${String(res.to || '')}`}
                sheetName="Bank check"
                title={`${String(res.bank)} — Tally against ${String(res.account?.name)}`}
                subtitle={`${String(res.file_company || '')} · ${String(res.period || '')}`}
                columns={[
                  { header: 'Date (Tally)', key: 'td', value: (r: Row) => (r.tally ? formatDate(r.tally.date) : '') },
                  { header: 'Voucher (Tally)', key: 'tv', value: (r: Row) => (r.tally ? [r.tally, ...((r.also as Row[]) || [])].map((t) => `${t.vch_type} ${t.vch_no}`).join(' + ') : '') },
                  { header: 'Ledger (Tally)', key: 'tp', value: (r: Row) => (detailNames(r).length ? detailNames(r).join(', ') : String(r.tally?.party || '')) },
                  { header: 'In', key: 'in', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (side(r).dir === 'in' ? Number(side(r).amount) : '') },
                  { header: 'Out', key: 'out', align: 'right', numFmt: '#,##0.00', value: (r: Row) => (side(r).dir === 'out' ? Number(side(r).amount) : '') },
                  { header: 'Here', key: 'here', value: (r: Row) => String(r.books?.code || '') },
                  { header: 'Date (here)', key: 'bd', value: (r: Row) => (r.books ? formatDate(r.books.date) : '') },
                  { header: 'Ledger (here)', key: 'bp', value: (r: Row) => String(r.books?.party || '') },
                  ...(hasStmt
                    ? [
                        { header: 'Bank statement date', key: 'sd', value: (r: Row) => (r.stmt ? formatDate(r.stmt.date) : '') },
                        { header: 'Bank narration', key: 'sn', value: (r: Row) => String(r.stmt?.narration || '') }
                      ]
                    : []),
                  { header: 'Status', key: 'status', value: (r: Row) => STATUS[String(r.status)]?.label || String(r.status) },
                  { header: 'Explanation', key: 'explain', value: (r: Row) => ((r.explain as string[]) || []).join(' ') },
                  { header: 'What to do', key: 'fix', value: (r: Row) => String(r.fix || '') }
                ]}
                rows={shown}
              />
            </div>
            {allAsk && (
              <div className="flex flex-wrap items-center gap-2 border-b border-[#BFE3CB] bg-[#F4FBF6] px-4 py-2.5">
                <CalendarCheck className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                <span className="min-w-0 flex-1 text-[12px] font-bold text-[#0A1F17]">
                  Move {redatable.length} {redatable.length === 1 ? 'entry' : 'entries'} to the date Tally has? Each voucher keeps its number; no amount changes.
                </span>
                <button type="button" onClick={() => setAllAsk(false)} className="h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-3 text-[11.5px] font-extrabold text-[#33473E]">
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
              <div style={{ minWidth: 1180 }}>
                <div
                  className="sticky top-0 z-10 grid items-end border-b-2 border-[#D6E2D6] bg-[#EEF4ED] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E] shadow-[0_2px_6px_rgba(10,31,23,.06)]"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span>
                    <ColumnFilter label="Date" {...cf.props('date')} />
                  </span>
                  <span>
                    <ColumnFilter label="Tally voucher" {...cf.props('vch')} />
                  </span>
                  <span>
                    <ColumnFilter label="Ledger" {...cf.props('party')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Money in" align="end" {...cf.props('in')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Money out" align="end" {...cf.props('out')} />
                  </span>
                  <span className="pl-4">
                    <ColumnFilter label="Here" {...cf.props('here')} />
                  </span>
                  {hasStmt && <span className="pl-2 text-[#6B3FA0]">Bank statement</span>}
                  <span className="pl-2">
                    <ColumnFilter label="Status" align="end" {...cf.props('status')} />
                  </span>
                </div>
                {elsewhere.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-[#F0E4CB] bg-[#FFF8E9] px-4 py-2 text-[12px] font-semibold text-[#8A5300]">
                    <span>
                      “{q.trim()}” also finds {elsewhere.length} line{elsewhere.length === 1 ? '' : 's'} on other tabs —{' '}
                      {[...new Set(elsewhere.map((r) => STATUS[String(r.status)]?.label || String(r.status)))].join(', ')}
                      {elsewhere.length <= 3
                        ? ` (${elsewhere.map((r) => `${r.tally ? `${r.tally.vch_type} ${r.tally.vch_no}` : ''}${r.books?.code ? ` ↔ ${r.books.code}` : ''}`).join('; ')})`
                        : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFilter('all')}
                      className="ml-auto rounded-[3px] border border-current px-2 py-0.5 text-[11px] font-extrabold"
                    >
                      Show all
                    </button>
                  </div>
                )}
                {shown.length === 0 && (
                  <div className="px-4 py-10 text-center text-[12.5px] font-semibold text-[#5A6B62]">
                    {cf.activeCount > 0 ? 'Nothing passes the column filters — clear them to see more.' : filter === 'problems' ? 'Nothing to look at — the bank agrees with Tally.' : 'Nothing to show for this filter.'}
                  </div>
                )}
                {shown.map((r, i) => {
                  const s = STATUS[String(r.status)] || STATUS.matched
                  const t = r.tally as Row | null
                  const b = r.books as Row | null
                  const lead = t || b || r.stmt || {}
                  const dd = ((r.diffs as Row[]) || []).find((d) => d.field === 'date')
                  const said = (r.explain as string[]) || []
                  const quiet = r.status === 'matched' || r.status === 'cancelled'
                  const money = (d: 'in' | 'out'): React.JSX.Element =>
                    lead.dir === d ? (
                      <span className="flex flex-col items-end">
                        <span className="text-[12.5px] font-bold tabular-nums" style={{ color: d === 'in' ? '#0B6B45' : '#0A1F17' }}>
                          {formatINR(Number(lead.amount) || 0)}
                        </span>
                        {t && b && Math.abs(Number(t.amount) - Number(b.amount)) > 1 && (
                          <span className="text-[11px] font-bold tabular-nums text-[#8C2F26]">
                            <span className="mr-1 text-[9.5px] font-extrabold uppercase text-[#B3261E]">Here</span>
                            {formatINR(Number(b.amount) || 0)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span />
                    )
                  return (
                    <div
                      key={`${String(r.key)}-${i}`}
                      data-key={String(r.key)}
                      className="grid border-b border-[#E4ECE3] px-4 py-2.5 transition-colors hover:bg-[#F7FBF6]"
                      style={{ gridTemplateColumns: GRID, boxShadow: `inset 3px 0 0 ${s.fg}`, rowGap: 8, background: focus && focus === String(r.key) ? '#F3FBE2' : undefined }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className={`text-[12.5px] tabular-nums text-[#0A1F17] ${dd ? 'font-extrabold' : 'font-semibold'}`}>{formatDate(String(lead.date || ''))}</span>
                        {dd && (
                          <span className="text-[11px] font-bold tabular-nums text-[#8C2F26]">
                            <span className="mr-1 text-[9.5px] font-extrabold uppercase text-[#B3261E]">Here</span>
                            {formatDate(String(dd.books))}
                          </span>
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col pr-2">
                        {t ? (
                          <>
                            <span className="truncate text-[12px] font-bold text-[#33473E]" title={String(t.vch_type)}>
                              {String(t.vch_type)}
                            </span>
                            <span className="text-[11px] font-extrabold tabular-nums text-[#0A1F17]">No. {String(t.vch_no)}</span>
                            {/* Tally lines that net into this one voucher here,
                                shown in its row so the counts are the ledger's. */}
                            {((r.also as Row[]) || []).map((a, k) => (
                              <span
                                key={k}
                                className="mt-1 truncate rounded-[3px] bg-[#EEF4FB] px-1.5 py-0.5 text-[10.5px] font-bold text-[#1B4E82]"
                                title={`Tally ${String(a.vch_type)} No. ${String(a.vch_no)} on ${formatDate(String(a.date))} — ${formatINR(Number(a.amount) || 0)} ${a.dir === 'in' ? 'in' : 'out'}, ${String(a.party || '')}. Netted into ${String(b?.code || 'this voucher')} here.`}
                              >
                                + {String(a.vch_type)} No. {String(a.vch_no)} · {formatDate(String(a.date))} · {formatINR(Number(a.amount) || 0)} {a.dir === 'in' ? 'in' : 'out'}
                              </span>
                            ))}
                          </>
                        ) : (
                          <span className="text-[9.5px] font-extrabold uppercase tracking-[.08em] text-[#8CA396]">{b ? 'Here only' : 'Bank only'}</span>
                        )}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5 pr-3">
                        {/* "(as per details)" — the voucher's own ledgers, from
                            Tally's detailed book, one a line. */}
                        {Array.isArray(t?.details) && t.details.length > 0 ? (
                          (t.details as Row[]).map((d, k) => (
                            <span key={k} className="flex min-w-0 items-baseline gap-2 text-[12px] font-bold text-[#0A1F17]" title={String(d.name)}>
                              <span className="min-w-0 truncate">{String(d.name)}</span>
                              <span className="flex-none text-[11px] font-semibold tabular-nums text-[#5A6B62]">
                                {formatINR(Number(d.amount) || 0)} {d.side === 'cr' ? 'Cr' : 'Dr'}
                              </span>
                            </span>
                          ))
                        ) : (
                          <span className="truncate text-[12.5px] font-bold text-[#0A1F17]" title={String(t?.party || b?.party || r.stmt?.narration || '')}>
                            {String(t?.party || b?.party || r.stmt?.narration || '—')}
                          </span>
                        )}
                        {t && b && !(Array.isArray(t.details) && t.details.length) && String(b.party).toUpperCase() !== String(t.party).toUpperCase() && (
                          <span className="truncate text-[11px] font-bold text-[#5A6B62]" title={String(b.party)}>
                            <span className="mr-1 text-[9.5px] font-extrabold uppercase text-[#0B6B45]">Here</span>
                            {String(b.party)}
                          </span>
                        )}
                      </span>
                      {money('in')}
                      {money('out')}
                      <span className="flex min-w-0 flex-col pl-4">
                        {b ? (
                          onOpenVoucher ? (
                            <button
                              type="button"
                              onClick={() => openHere(r)}
                              title={`Open ${String(b.code || 'the voucher')} — Esc brings you back`}
                              className="group flex min-w-0 items-center gap-1 text-left text-[12px] font-extrabold tabular-nums text-[#0B6B45] hover:underline"
                            >
                              <span className="truncate">{String(b.code || b.vch_type)}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
                            </button>
                          ) : (
                            <span className="text-[12px] font-extrabold text-[#0B6B45]">{String(b.code || b.vch_type)}</span>
                          )
                        ) : (
                          <span className="text-[11.5px] font-semibold text-[#A9B8AE]">—</span>
                        )}
                        {b?.vch_no && <span className="truncate text-[10.5px] font-bold text-[#8CA396]">{String(b.vch_no)}</span>}
                      </span>
                      {hasStmt && (
                        <span className="flex min-w-0 flex-col pl-2">
                          {r.stmt ? (
                            <>
                              <span className="text-[12px] font-bold tabular-nums text-[#6B3FA0]">{formatDate(String(r.stmt.date))}</span>
                              <span className="truncate text-[10.5px] font-semibold text-[#5A6B62]" title={String(r.stmt.narration || '')}>
                                {String(r.stmt.narration || '—')}
                              </span>
                            </>
                          ) : (
                            <span className="text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#A9B8AE]">{r.stmt_out ? 'Beyond the statement' : 'Not on statement'}</span>
                          )}
                        </span>
                      )}
                      <span className="flex flex-wrap content-start items-center gap-1 pl-2">
                        <span title={s.tip} style={chip(s.fg, s.bg, s.bd)}>
                          {s.label}
                        </span>
                        {((r.diffs as Row[]) || []).map((d) => (
                          <span key={d.field} style={chip('#B3261E', '#fff', '#F0D6D4')}>
                            {FIELD[d.field] || d.field}
                          </span>
                        ))}
                        {t?.multi && <span style={chip('#5A6B62', '#EEF3EC', '#DCE7DB')}>As per details</span>}
                        {/* The same payment in the books twice — booked from
                            Tally AND posted by its own document. */}
                        {(r.duplicate || r.duplicate_of) && (
                          <span
                            title={r.duplicate ? `Also in these books as ${String(r.duplicate.code)}` : `Also in these books as ${String(r.duplicate_of.code)}, booked from Tally`}
                            style={chip('#B3261E', '#FDF3F2', '#F0D6D4')}
                          >
                            Booked twice · {String((r.duplicate || r.duplicate_of).code)}
                          </span>
                        )}
                        {b?.id && (
                          <button
                            type="button"
                            onClick={() => void reverseHere(r)}
                            title={
                              r.duplicate_of
                                ? `Reverse ${String(r.duplicate_of.code)}, the copy booked from Tally — ${String(b.code || 'this voucher')} stays`
                                : `Reverse ${String(b.code || 'the voucher here')} — delete it from these books so the Tally line can be booked again`
                            }
                            className="flex h-[22px] items-center gap-1 rounded-[3px] border border-[#F0D6D4] bg-white px-1.5 text-[10px] font-extrabold uppercase tracking-[.04em] text-[#B3261E] opacity-70 hover:bg-[#FDF3F2] hover:opacity-100"
                          >
                            <RotateCcw className="h-3 w-3" /> {r.duplicate_of ? `Reverse copy ${String(r.duplicate_of.code)}` : 'Reverse'}
                          </button>
                        )}
                        {r.linked && (
                          <span className="flex items-center gap-1">
                            <span title="You said these are the same entry" style={chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>
                              Linked
                            </span>
                            <button type="button" title="Forget that these are the same" onClick={() => void linkSame(r, false)} className="text-[#8CA396] hover:text-[#B3261E]">
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        )}
                      </span>
                      {(said.length > 0 || !!r.fix) && (
                        <div className="min-w-0 rounded-r-[4px] border border-l-[3px] border-[#E4ECE3] bg-[#F8FAF7] px-3 py-2" style={{ gridColumn: '2 / -1', borderLeftColor: quiet ? '#DCE7DB' : s.fg }}>
                          {said.length > 0 && <p className="text-[11.5px] font-semibold leading-relaxed text-[#33473E]">{said.join(' ')}</p>}
                          {!!r.fix && (
                            <p className="mt-1 flex items-start gap-1.5 text-[11.5px] font-extrabold leading-relaxed" style={{ color: quiet ? '#5A6B62' : '#0B3D2E' }}>
                              <ArrowRight className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                              <span>
                                <span className="mr-1 text-[9.5px] uppercase tracking-[.1em] opacity-70">What to do</span>
                                {String(r.fix)}
                              </span>
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
                            {r.status === 'possible' && b && (
                              <button
                                type="button"
                                onClick={() => void linkSame(r, true)}
                                title="They are the same entry — remember it, so it shows as Matched in every check after"
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#C6DAF0] bg-white px-2.5 text-[11px] font-extrabold text-[#1B4E82] hover:bg-[#EAF0FA]"
                              >
                                <Link2 className="h-3.5 w-3.5" /> Same entry — remember
                              </button>
                            )}
                            {r.bookable && (
                              <button
                                type="button"
                                onClick={() => setBookKeys([String(r.key)])}
                                className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#F1D9A6] bg-white px-2.5 text-[11px] font-extrabold text-[#8A5300] hover:bg-[#FFF8E9]"
                              >
                                <FilePlus2 className="h-3.5 w-3.5" /> {r.status === 'possible' ? 'It is a different one — book it' : 'Book from Tally'}
                              </button>
                            )}
                            {r.redate === 'yes' && t && b && (
                              dateAsk === String(r.key) ? (
                                <>
                                  <span className="text-[11.5px] font-bold text-[#0A1F17]">
                                    Move {String(b.code || 'it')} from {formatDate(String(b.date))} to {formatDate(String(t.date))}? The voucher keeps its number; no amount changes.
                                  </span>
                                  <button type="button" onClick={() => setDateAsk(null)} className="h-7 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#33473E]">
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
                              )
                            )}
                            {r.redate === 'owned' && (
                              <span className="text-[11px] font-semibold text-[#5A6B62]">Posted by another document (an LC, a discounted bill, a payment) — its date is changed there.</span>
                            )}
                          </div>
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
        kind="bank"
        accountId={bankId || undefined}
        keys={bookKeys}
        pool={bookable.map((r) => String(r.key))}
        readAll={rows.filter((r) => r.bookable).map((r) => String(r.key))}
        companyId={companyId}
        b64={file?.b64 || ''}
        fileName={file?.name || ''}
        accounts={accounts}
        groupNames={groupNames}
        onClose={() => setBookKeys(null)}
        onChanged={onChanged}
        onBooked={async () => {
          setBatchTick((x) => x + 1)
          if (file && bankId) await run(file, bankId, savedAt || undefined)
        }}
      />
    </div>
  )
}
