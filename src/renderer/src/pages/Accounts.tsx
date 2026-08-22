import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeftRight,
  BookOpenText,
  Check,
  ChevronRight,
  IndianRupee,
  Landmark,
  PackageSearch,
  Plus,
  Receipt,
  Scale,
  ScrollText,
  Trash2,
  Wallet,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DbStatus } from '@/components/DbStatus'
import { UpdateBadge } from '@/components/UpdateBadge'
import { FyPicker } from '@/components/FyPicker'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useGlobalDateRange, globalRangeAppliesTo } from '@/lib/globalDateRange'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// ---------------------------------------------------------------------------
// Tally's palette: navy frame, cream paper, amber selection, red key letters.
// ---------------------------------------------------------------------------
const T = {
  frame: 'bg-[#1a2c56]',
  paper: 'bg-[#fffdf4]',
  paperEdge: 'border-[#d9d2b8]',
  headBar: 'bg-[#dce6f5] text-[#1a2c56]',
  select: 'bg-amber-200/80',
  key: 'text-red-600'
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

type Screen = 'gateway' | 'voucher' | 'daybook' | 'ledger' | 'trial' | 'purchreg' | 'salesreg' | 'trading'
type VchType = 'CONTRA' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'DEBIT NOTE' | 'CREDIT NOTE'

const VCH_TYPES: { key: VchType; fkey: string; label: string }[] = [
  { key: 'CONTRA', fkey: 'F4', label: 'Contra' },
  { key: 'PAYMENT', fkey: 'F5', label: 'Payment' },
  { key: 'RECEIPT', fkey: 'F6', label: 'Receipt' },
  { key: 'JOURNAL', fkey: 'F7', label: 'Journal' },
  { key: 'DEBIT NOTE', fkey: 'Alt F5', label: 'Debit Note' },
  { key: 'CREDIT NOTE', fkey: 'Alt F6', label: 'Credit Note' }
]

interface VLine {
  side: 'dr' | 'cr'
  account: string
  group: string
  amount: string
  allocs: AllocRow[]
}

// Tally-format payment/receipt entry: one money account, party lines with
// bill-wise adjustments (Agst Ref / Advance / On Account / New Ref).
interface AllocRow {
  method: 'agst_ref' | 'advance' | 'on_account' | 'new_ref'
  ref_name: string
  order_id?: number | null
  sale_invoice_group?: string | null
  amount: string
}
interface PayLine {
  account: string
  group: string
  amount: string
  allocs: AllocRow[]
}
const CASH_BANK_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']
const BILLWISE_GROUPS = ['Sundry Creditors', 'Sundry Debtors']
const METHODS: { key: AllocRow['method']; label: string }[] = [
  { key: 'agst_ref', label: 'Agst Ref' },
  { key: 'advance', label: 'Advance' },
  { key: 'on_account', label: 'On Account' },
  { key: 'new_ref', label: 'New Ref' }
]
const blankPayLine = (): PayLine => ({ account: '', group: '', amount: '', allocs: [] })

function monthLabelLong(m: string): string {
  const [y, mo] = m.split('-')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[Number(mo) - 1] || mo} ${y}`
}

const blankLines = (t: VchType): VLine[] =>
  t === 'RECEIPT' || t === 'CREDIT NOTE'
    ? [
        { side: 'cr', account: '', group: '', amount: '', allocs: [] },
        { side: 'dr', account: '', group: '', amount: '', allocs: [] }
      ]
    : [
        { side: 'dr', account: '', group: '', amount: '', allocs: [] },
        { side: 'cr', account: '', group: '', amount: '', allocs: [] }
      ]

// A Tally-style function-key button for the right-hand bar.
function FKey({ k, label, active, onClick }: { k: string; label: string; active?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors',
        active ? 'bg-amber-200 text-[#1a2c56]' : 'bg-white/10 text-white hover:bg-white/20'
      )}
    >
      <span className={cn('w-9 shrink-0 font-bold', active ? T.key : 'text-amber-300')}>{k}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

// The bill-wise details editor (method of adjustment), Tally style. Used under
// party lines in payments/receipts AND in the journal / note grid.
function AllocPanel({
  lineAmount,
  allocs,
  refs,
  onChange
}: {
  lineAmount: number
  allocs: AllocRow[]
  refs: Row[]
  onChange: (allocs: AllocRow[]) => void
}): React.JSX.Element {
  const allocated = allocs.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
  const matched = Math.abs(allocated - lineAmount) < 0.005
  const remaining = (skip = -1): number =>
    Math.round((lineAmount - allocs.reduce((sum, a, j) => (j === skip ? sum : sum + (Number(a.amount) || 0)), 0)) * 100) / 100
  const set = (j: number, patch: Partial<AllocRow>): void =>
    onChange(allocs.map((a, y) => (y === j ? { ...a, ...patch } : a)))
  // A hand-typed New Ref / Advance that happens to spell an already-tracked
  // bill exactly gets its amount silently merged into that bill's pending
  // total on the backend (same ref_name, different row) — inflating it rather
  // than settling it. Catch the collision here, before it can happen.
  const knownRefs = new Set(refs.map((r) => String(r.ref).trim().toUpperCase()))
  const collidesWithKnownBill = (name: string): boolean => {
    const key = name.trim().toUpperCase()
    return key.length > 0 && knownRefs.has(key)
  }
  // Two different bills can legitimately show the same ref text (a duplicate
  // or blank invoice number on the same party) — key the picker on the exact
  // bill identity, not the text, so they never collide.
  const billKey = (ref: unknown, orderId: unknown, saleGroup: unknown): string =>
    `${ref ?? ''}::${orderId ?? ''}::${saleGroup ?? ''}`
  return (
    <div className="ml-3 mt-1.5 rounded border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-800">
          Bill-wise details — method of adjustment
        </span>
        <span className={cn('text-[10px] font-semibold tabular-nums', matched ? 'text-emerald-700' : 'text-amber-700')}>
          {allocs.length === 0 ? 'none — treated as plain balance' : `${formatINR(allocated)} of ${formatINR(lineAmount)} allocated`}
        </span>
      </div>
      {allocs.map((a, j) => {
        const collides = (a.method === 'new_ref' || a.method === 'advance') && collidesWithKnownBill(a.ref_name)
        return (
        <Fragment key={j}>
        <div className="mb-1 grid grid-cols-[120px_1fr_120px_24px] items-center gap-1.5">
          <Select value={a.method} onValueChange={(v) => set(j, { method: v as AllocRow['method'], ref_name: '', order_id: null, sale_invoice_group: null })}>
            <SelectTrigger className="h-7 bg-white text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {a.method === 'agst_ref' ? (
            <Select
              value={billKey(a.ref_name, a.order_id, a.sale_invoice_group)}
              onValueChange={(v) => {
                const bill = refs.find((r) => billKey(r.ref, r.order_id, r.sale_invoice_group) === v)
                const rest = remaining(j)
                set(j, {
                  ref_name: bill ? String(bill.ref) : '',
                  order_id: bill?.order_id ?? null,
                  sale_invoice_group: bill?.sale_invoice_group ?? null,
                  amount: a.amount || String(Math.min(Number(bill?.pending) || rest, rest))
                })
              }}
            >
              <SelectTrigger className="h-7 bg-white text-[12px]">
                <SelectValue placeholder={refs.length ? 'Pick a pending bill' : 'No pending bills found'} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {refs.map((r) => (
                  <SelectItem key={billKey(r.ref, r.order_id, r.sale_invoice_group)} value={billKey(r.ref, r.order_id, r.sale_invoice_group)}>
                    {String(r.ref)} — {formatINR(r.pending)} pending
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : a.method === 'on_account' ? (
            <span className="px-1 text-[11px] italic text-muted-foreground">no reference — unallocated</span>
          ) : (
            <Input
              className={cn('h-7 bg-white text-[12px]', collides && 'border-red-500 focus-visible:ring-red-500')}
              placeholder={a.method === 'advance' ? 'Advance reference (e.g. ADV-1)' : 'New reference name'}
              value={a.ref_name}
              onChange={(e) => set(j, { ref_name: e.target.value })}
            />
          )}
          <Input
            type="number"
            className="h-7 bg-white text-right text-[12px] tabular-nums"
            value={a.amount}
            onChange={(e) => set(j, { amount: e.target.value })}
          />
          <button
            type="button"
            className="cursor-pointer text-muted-foreground hover:text-red-600"
            onClick={() => onChange(allocs.filter((_, y) => y !== j))}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {collides && (
          <p className="mb-1 -mt-0.5 pl-1 text-[10px] font-medium text-red-600">
            "{a.ref_name}" is already a real bill on this account — use Agst Ref to settle it, or the amount will
            double up against that bill instead of a new one.
          </p>
        )}
        </Fragment>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-amber-800 hover:bg-amber-100"
        onClick={() =>
          onChange([
            ...allocs,
            { method: refs.length ? 'agst_ref' : 'on_account', ref_name: '', amount: String(Math.max(0, remaining())) }
          ])
        }
      >
        <Plus className="h-3 w-3" /> Add adjustment
      </Button>
    </div>
  )
}

// Searchable ledger picker (cmdk) with inline "create new ledger".
function AccountPicker({
  value,
  accounts,
  onPick,
  onCreate,
  autoFocus
}: {
  value: string
  accounts: Row[]
  onPick: (name: string, group: string) => void
  onCreate: (query: string) => void
  autoFocus?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          className={cn(
            'h-8 w-full cursor-pointer truncate rounded border bg-white px-2 text-left text-[13px]',
            'focus:outline-none focus:ring-2 focus:ring-amber-400',
            !value && 'text-muted-foreground'
          )}
        >
          {value || 'Select ledger…'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0">
        <Command>
          <CommandInput placeholder="Type a ledger name…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64">
            <CommandEmpty>
              <button
                type="button"
                className="mx-auto flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-emerald-700 hover:bg-emerald-50"
                onClick={() => {
                  setOpen(false)
                  onCreate(query)
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Create ledger “{query.toUpperCase()}”
              </button>
            </CommandEmpty>
              {accounts.map((a) => (
                <CommandItem
                  key={String(a.id)}
                  value={String(a.name)}
                  onSelect={() => {
                    onPick(String(a.name), String(a.acc_group || ''))
                    setOpen(false)
                  }}
                >
                  <span className="truncate">{a.name}</span>
                  <span className="ml-auto pl-3 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {a.acc_group}
                  </span>
                </CommandItem>
              ))}
              {query.trim() && (
                <CommandItem value={`__create__${query}`} onSelect={() => { setOpen(false); onCreate(query) }}>
                  <Plus className="h-3.5 w-3.5 text-emerald-700" />
                  <span className="text-emerald-700">Create ledger “{query.toUpperCase()}”</span>
                </CommandItem>
              )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function Accounts({ onExit }: { onExit?: () => void }): React.JSX.Element {
  // Tally opens on Select Company — every report and voucher below is pinned
  // to this choice (F3 changes it), never silently the app-wide company.
  const [companies, setCompanies] = useState<Row[]>([])
  const [company, setCompany] = useState<Row | null>(null)
  const [coIndex, setCoIndex] = useState(0)
  useEffect(() => {
    Promise.all([window.api.company.list(), window.api.company.getActive()])
      .then(([cs, active]) => {
        setCompanies(cs)
        const i = cs.findIndex((x) => Number(x.id) === Number(active.id))
        setCoIndex(i >= 0 ? i : 0)
      })
      .catch(() => {})
  }, [])
  const cid = company ? Number(company.id) : 0

  const [screen, setScreen] = useState<Screen>('gateway')
  const [gwIndex, setGwIndex] = useState(0)
  const [accounts, setAccounts] = useState<Row[]>([])
  const [groupNames, setGroupNames] = useState<{ name: string; nature: string }[]>([])

  // Voucher entry / alteration state.
  const [vchType, setVchType] = useState<VchType>('PAYMENT')
  const [vchDate, setVchDate] = useState(todayISO())
  const [vchNo, setVchNo] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<VLine[]>(blankLines('PAYMENT'))
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const dateRef = useRef<HTMLDivElement | null>(null)
  // Tally-format payment/receipt entry state. The money side is a list too —
  // a Payment/Receipt can split across more than one cash/bank account, the
  // same way the party side already allows more than one party.
  const [payAccounts, setPayAccounts] = useState<PayLine[]>([blankPayLine()])
  // Tally-style GST computation for debit/credit notes: taxable + GST% ->
  // GST leg + round off so the party total lands on a whole rupee.
  const [gstCalc, setGstCalc] = useState({ taxable: '', pct: '5', igst: false })
  // Rate-difference helper (Journal only): a later price revision on an
  // already-invoiced purchase/sale, settled through RATE DIFFERENCE A/C
  // rather than reopening the original document.
  const [rateDiff, setRateDiff] = useState({ party: '', group: '', amount: '', direction: 'owes_more' as 'owes_more' | 'owes_less' })
  // Tally invoice-mode for Debit/Credit notes: party -> original invoice ->
  // item lines (qty x rate) -> GST + round off, posted through the notes engine.
  const [noteMode, setNoteMode] = useState(true)
  const [noteParty, setNoteParty] = useState('')
  const [noteInvoice, setNoteInvoice] = useState('')
  const [noteGst, setNoteGst] = useState('5')
  const [noteItems, setNoteItems] = useState<{ product_id: string; qty: string; rate: string }[]>([
    { product_id: '', qty: '', rate: '' }
  ])
  const [noteParties, setNoteParties] = useState<Row[]>([])
  const [noteProducts, setNoteProducts] = useState<Row[]>([])
  const [payLines, setPayLines] = useState<PayLine[]>([blankPayLine()])
  const [rawAlter, setRawAlter] = useState(false)
  const [refsCache, setRefsCache] = useState<Record<string, Row[]>>({})

  // Day book.
  const monthStart = `${todayISO().slice(0, 7)}-01`
  const [dbFrom, setDbFrom] = useState(monthStart)
  const [dbTo, setDbTo] = useState(todayISO())
  // Empty = every voucher type.
  const [dbType, setDbType] = useState<string[]>([])
  const [dayRows, setDayRows] = useState<Row[]>([])
  const [viewRow, setViewRow] = useState<Row | null>(null)

  // Ledger screen.
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [ledgerLines, setLedgerLines] = useState<Row[]>([])
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [lgFrom, setLgFrom] = useState('')
  const [lgTo, setLgTo] = useState('')
  const [lgMonthly, setLgMonthly] = useState(false)
  const [lgDetailed, setLgDetailed] = useState(false)

  // Trial balance.
  const [tbFrom, setTbFrom] = useState('')
  const [tbTo, setTbTo] = useState(todayISO())
  const [tb, setTb] = useState<Row | null>(null)

  // New-ledger dialog (from the picker or the ledger list).
  const [newLedger, setNewLedger] = useState<{ name: string; group: string; forLine: number | null; target?: 'payLine' | 'payAccount'; index?: number } | null>(null)

  // Purchase / sales registers — the plain "what did we buy and sell, and how
  // was it funded" view. Deliberately document-level, not ledger-level.
  const [purchases, setPurchases] = useState<Row[]>([])
  const [saleRows, setSaleRows] = useState<Row[]>([])
  const [lcList, setLcList] = useState<Row[]>([])
  const [regFrom, setRegFrom] = useState('')
  const [regTo, setRegTo] = useState('')
  const [regSearch, setRegSearch] = useState('')
  // 'all' | 'lc' (funded by an LC) | 'nolc' (not tagged to any LC)
  // Empty = both — checking neither/both funding types is the same as "all".
  const [regFunding, setRegFunding] = useState<string[]>([])
  // Tag-a-purchase-to-an-LC dialog.
  const [tagForm, setTagForm] = useState<Row | null>(null)
  // Trading Account report — per-oil-code purchase vs sale roll-up.
  const [tradingRows, setTradingRows] = useState<Row[]>([])
  const [tradingFrom, setTradingFrom] = useState('')
  const [tradingTo, setTradingTo] = useState('')

  // Alt+F2 broadcasts a period from anywhere — every date-filtered tab here
  // (Day Book, Ledger, Trial Balance, registers, Trading Account) adopts it.
  const globalRange = useGlobalDateRange()
  useEffect(() => {
    if (!globalRangeAppliesTo(globalRange, 'accounts')) return
    setDbFrom(globalRange.from); setDbTo(globalRange.to)
    setLgFrom(globalRange.from); setLgTo(globalRange.to)
    setTbFrom(globalRange.from); setTbTo(globalRange.to)
    setRegFrom(globalRange.from); setRegTo(globalRange.to)
    setTradingFrom(globalRange.from); setTradingTo(globalRange.to)
  }, [globalRange.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadRegisters = useCallback(async () => {
    const [o, s, l] = await Promise.all([
      window.api.orders.list(),
      window.api.sales.list(),
      window.api.lc.list()
    ])
    setPurchases(o)
    setSaleRows(s)
    setLcList(l)
  }, [])

  const loadAccounts = useCallback(async () => {
    if (!cid) return
    setAccounts(await window.api.journal.accounts(cid))
  }, [cid])
  useEffect(() => {
    loadAccounts()
    window.api.journal.groupNames().then(setGroupNames).catch(() => {})
  }, [loadAccounts])
  useLiveRefresh(loadAccounts)

  const loadDaybook = useCallback(async () => {
    if (screen !== 'daybook' || !cid) return
    setDayRows(
      await window.api.vouchers.list({
        from: dbFrom || undefined,
        to: dbTo || undefined,
        vchType: dbType.length ? dbType : undefined,
        companyId: cid
      })
    )
  }, [screen, dbFrom, dbTo, dbType, cid])
  useEffect(() => {
    loadDaybook()
  }, [loadDaybook])
  useLiveRefresh(loadDaybook)

  useEffect(() => {
    if (screen === 'purchreg' || screen === 'salesreg') void loadRegisters()
  }, [screen, loadRegisters])
  useLiveRefresh(() => {
    if (screen === 'purchreg' || screen === 'salesreg') void loadRegisters()
  })

  const loadLedger = useCallback(async () => {
    if (screen !== 'ledger' || !ledgerId || !cid) return
    setLedgerLines(await window.api.journal.statement(ledgerId, cid))
  }, [screen, ledgerId, cid])
  useEffect(() => {
    loadLedger()
  }, [loadLedger])
  useLiveRefresh(loadLedger)

  const loadTb = useCallback(async () => {
    if (screen !== 'trial' || !cid) return
    setTb(await window.api.journal.trialBalance({ from: tbFrom || undefined, to: tbTo || undefined, companyId: cid }))
  }, [screen, tbFrom, tbTo, cid])
  useEffect(() => {
    loadTb()
  }, [loadTb])
  useLiveRefresh(loadTb)

  const loadTrading = useCallback(async () => {
    if (screen !== 'trading' || !cid) return
    setTradingRows(await window.api.journal.tradingAccount(tradingFrom || undefined, tradingTo || undefined, cid))
  }, [screen, tradingFrom, tradingTo, cid])
  useEffect(() => {
    loadTrading()
  }, [loadTrading])
  useLiveRefresh(loadTrading)

  // ------- voucher helpers -------
  const totals = useMemo(() => {
    const dr = lines.reduce((s, l) => s + (l.side === 'dr' ? Number(l.amount) || 0 : 0), 0)
    const cr = lines.reduce((s, l) => s + (l.side === 'cr' ? Number(l.amount) || 0 : 0), 0)
    return { dr, cr, diff: Math.round((dr - cr) * 100) / 100 }
  }, [lines])

  function switchType(t: VchType): void {
    setVchType(t)
    if (editingId == null) {
      setLines(blankLines(t))
      setPayLines([blankPayLine()])
      setRawAlter(false)
    }
  }

  function openVoucher(t: VchType): void {
    setEditingId(null)
    setVchType(t)
    setVchDate(todayISO())
    setVchNo('')
    setNarration('')
    setLines(blankLines(t))
    setPayLines([blankPayLine()])
    setRawAlter(false)
    setNoteMode(true)
    setNoteParty('')
    setNoteInvoice('')
    setNoteItems([{ product_id: '', qty: '', rate: '' }])
    // Default the money side to the first bank ledger, like Tally remembers one.
    const bank = accounts.find((a) => String(a.name) === 'BANK A/C') || cashBankAccounts[0]
    setPayAccounts([bank ? { account: String(bank.name), group: String(bank.acc_group), amount: '', allocs: [] } : blankPayLine()])
    setScreen('voucher')
  }

  function setLine(i: number, patch: Partial<VLine>): void {
    setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  const structured = (vchType === 'PAYMENT' || vchType === 'RECEIPT') && !rawAlter
  const isNoteType = vchType === 'DEBIT NOTE' || vchType === 'CREDIT NOTE'
  // New notes open in Tally's invoice mode; altering an old grid voucher keeps the grid.
  const noteInvoiceMode = isNoteType && noteMode && editingId == null

  useEffect(() => {
    if (!isNoteType) return
    window.api.data
      .list(vchType === 'DEBIT NOTE' ? 'suppliers' : 'customers')
      .then(setNoteParties)
      .catch(() => setNoteParties([]))
    if (!noteProducts.length) {
      window.api.data.list('products').then(setNoteProducts).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vchType, isNoteType])

  const notePartyName = String(noteParties.find((x) => String(x.id) === noteParty)?.name || '')
  const noteRefs = refsCache[notePartyName.toUpperCase()] || []
  const noteTotals = (() => {
    const base = noteItems.reduce((sum, it) => sum + Math.round((Number(it.qty) || 0) * (Number(it.rate) || 0) * 100) / 100, 0)
    const gst = Math.round(base * (Number(noteGst) || 0)) / 100
    const raw = Math.round((base + gst) * 100) / 100
    const total = Math.round(raw)
    return { base: Math.round(base * 100) / 100, gst, ro: Math.round((total - raw) * 100) / 100, total }
  })()
  const cashBankAccounts = accounts.filter((a) => CASH_BANK_GROUPS.includes(String(a.acc_group)))
  const payTotal = payLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const payAccountTotal = payAccounts.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  async function loadRefs(name: string): Promise<void> {
    if (!name || refsCache[name]) return
    try {
      const r = await window.api.journal.pendingRefs(name, cid)
      setRefsCache((p) => ({ ...p, [name]: r }))
    } catch {
      /* refs are a convenience — entry still works without them */
    }
  }

  function setPayLine(i: number, patch: Partial<PayLine>): void {
    setPayLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  function setPayAccountLine(i: number, patch: Partial<PayLine>): void {
    setPayAccounts((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  // Fill a blank money-side amount with whatever the party side still needs —
  // the same "Tally suggestion" convenience the party lines already get.
  function suggestPayAccountAmount(i: number): void {
    if (payAccounts[i].amount) return
    const restOfMoney = payAccounts.reduce((s, x, j) => (j === i ? s : s + (Number(x.amount) || 0)), 0)
    const rest = Math.round((payTotal - restOfMoney) * 100) / 100
    if (rest > 0.004) setPayAccountLine(i, { amount: String(rest) })
  }

  // Fill the amount that would balance the voucher — Tally's suggestion.
  function suggestAmount(i: number): void {
    const l = lines[i]
    if (l.amount) return
    const rest = Math.abs(
      lines.reduce((s, x, j) => (j === i ? s : s + (x.side === 'dr' ? 1 : -1) * (Number(x.amount) || 0)), 0)
    )
    if (rest > 0.004) setLine(i, { amount: String(Math.round(rest * 100) / 100) })
  }

  // Build the note's legs from taxable + GST%, Tally style: the goods ledger
  // carries the taxable, GST INPUT/OUTPUT its tax, ROUND OFF the paise so the
  // party line is a whole rupee. Accounts stay pickable afterwards.
  function applyGstCalc(): void {
    const taxable = Number(gstCalc.taxable) || 0
    if (taxable <= 0) return void toast.error('Type the taxable amount first')
    const pct = Number(gstCalc.pct) || 0
    const gst = Math.round(taxable * pct) / 100
    const raw = taxable + gst
    const total = Math.round(raw)
    const ro = Math.round((total - raw) * 100) / 100
    const isDn = vchType === 'DEBIT NOTE'
    const partySide: 'dr' | 'cr' = isDn ? 'dr' : 'cr'
    const goodsSide: 'dr' | 'cr' = isDn ? 'cr' : 'dr'
    const gstAccount = isDn ? 'GST INPUT A/C' : 'GST OUTPUT A/C'
    // Keep any party/goods ledgers already picked on the first two lines.
    const party = lines.find((l) => l.side === partySide)
    const goods = lines.find((l) => l.side === goodsSide)
    const next: VLine[] = [
      { side: partySide, account: party?.account || '', group: party?.group || '', amount: String(total), allocs: party?.allocs || [] },
      { side: goodsSide, account: goods?.account || '', group: goods?.group || '', amount: String(taxable), allocs: [] }
    ]
    if (gst > 0) next.push({ side: goodsSide, account: gstAccount, group: 'Duties & Taxes', amount: String(gst), allocs: [] })
    if (Math.abs(ro) >= 0.005) {
      // +ro rounds the party UP -> the extra sits on ROUND OFF's other side.
      next.push({
        side: ro > 0 ? goodsSide : partySide,
        account: 'ROUND OFF A/C',
        group: 'Indirect Expenses',
        amount: String(Math.abs(ro)),
        allocs: []
      })
    }
    setLines(next)
    toast.success(`Taxable ${formatINR(taxable)} + GST ${formatINR(gst)}${Math.abs(ro) >= 0.005 ? ` + round off ${formatINR(ro)}` : ''} = ${formatINR(total)}`)
  }

  // A price revision on an already-invoiced purchase/sale, settled through
  // RATE DIFFERENCE A/C instead of reopening the original document. "Owes
  // more" always means the PARTY's own balance grows — which side that is
  // depends on whether they're a customer (Dr) or a supplier (Cr).
  function applyRateDiff(): void {
    if (!rateDiff.party) return void toast.error('Pick the party')
    const amt = Number(rateDiff.amount) || 0
    if (amt <= 0) return void toast.error('Enter the rate-difference amount')
    const isDebtor = rateDiff.group === 'Sundry Debtors'
    const partySide: 'dr' | 'cr' =
      rateDiff.direction === 'owes_more' ? (isDebtor ? 'dr' : 'cr') : (isDebtor ? 'cr' : 'dr')
    const otherSide: 'dr' | 'cr' = partySide === 'dr' ? 'cr' : 'dr'
    setLines([
      { side: partySide, account: rateDiff.party, group: rateDiff.group, amount: String(amt), allocs: [] },
      { side: otherSide, account: 'RATE DIFFERENCE A/C', group: 'Indirect Expenses', amount: String(amt), allocs: [] }
    ])
    toast.success(`${formatINR(amt)} rate difference posted ${rateDiff.direction === 'owes_more' ? 'against' : 'in favour of'} ${rateDiff.party}`)
  }

  // Close a sub-rupee Dr/Cr gap with the ROUND OFF ledger — Tally's Alt+R habit.
  function addRoundOffLine(): void {
    const diff = Math.round((totals.dr - totals.cr) * 100) / 100
    if (Math.abs(diff) < 0.005 || Math.abs(diff) >= 1) return
    setLines((p) => [
      ...p,
      { side: diff > 0 ? 'cr' : 'dr', account: 'ROUND OFF A/C', group: 'Indirect Expenses', amount: String(Math.abs(diff)), allocs: [] }
    ])
  }

  async function saveVoucher(): Promise<void> {
    if (saving) return
    if (noteInvoiceMode) {
      if (!noteParty) return void toast.error(`Select the ${vchType === 'DEBIT NOTE' ? 'supplier' : 'customer'}`)
      const items = noteItems.filter((it) => it.product_id && Number(it.qty) > 0 && Number(it.rate) > 0)
      if (!items.length) return void toast.error('Add at least one item line (product, qty and rate)')
      setSaving(true)
      try {
        const res = await window.api.notes.create({
          note_type: vchType === 'DEBIT NOTE' ? 'debit' : 'credit',
          company_id: cid || undefined,
          party_id: Number(noteParty),
          note_date: vchDate,
          gst_pct: Number(noteGst) || 0,
          narration: narration || null,
          against_invoice: noteInvoice || null,
          items: items.map((it) => ({ product_id: Number(it.product_id), qty: Number(it.qty), rate: Number(it.rate) }))
        })
        toast.success(`${vchType} ${res.note_no} accepted — ${formatINR(noteTotals.total)}${noteInvoice ? ` against ${noteInvoice}` : ' on account'}`)
        setNoteInvoice('')
        setNoteItems([{ product_id: '', qty: '', rate: '' }])
        setNarration('')
        setRefsCache({})
        loadAccounts()
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setSaving(false)
      }
      return
    }
    setSaving(true)
    try {
      const structuredLines = (): Row[] => {
        const party = payLines.filter((l) => l.account && Number(l.amount) > 0)
        if (!party.length) throw new Error('Add at least one party line')
        const money = payAccounts.filter((l) => l.account)
        if (!money.length) throw new Error(`Pick the cash or bank account the money ${vchType === 'PAYMENT' ? 'goes out of' : 'comes into'}`)
        const total = party.reduce((s, l) => s + Number(l.amount), 0)
        // One account: it always carries the whole total, same as before this
        // could split — no need to type an amount that could only ever be one
        // value. More than one: each carries what was actually typed, and
        // together they must add up to the party side.
        const moneyAmounts =
          money.length === 1
            ? [total]
            : money.map((l) => Number(l.amount) || 0)
        if (money.length > 1) {
          const moneySum = moneyAmounts.reduce((s, x) => s + x, 0)
          if (Math.abs(moneySum - total) > 0.005) {
            throw new Error(`The split across accounts (${moneySum.toFixed(2)}) does not add up to the total (${total.toFixed(2)})`)
          }
        }
        return [
          ...party.map((l) => ({
            account: l.account,
            group: l.group || undefined,
            dr: vchType === 'PAYMENT' ? Number(l.amount) : 0,
            cr: vchType === 'RECEIPT' ? Number(l.amount) : 0,
            allocs: l.allocs
              .filter((a) => Number(a.amount) > 0)
              .map((a) => ({ method: a.method, ref_name: a.ref_name || null, order_id: a.order_id || null, sale_invoice_group: a.sale_invoice_group || null, amount: Number(a.amount) }))
          })),
          ...money.map((l, i) => ({
            account: l.account,
            group: l.group || undefined,
            dr: vchType === 'RECEIPT' ? moneyAmounts[i] : 0,
            cr: vchType === 'PAYMENT' ? moneyAmounts[i] : 0
          }))
        ]
      }
      const payload = {
        date: vchDate,
        vchType,
        vchNo: vchNo || null,
        narration: narration || null,
        companyId: cid || undefined,
        lines: structured
          ? structuredLines()
          : lines
              .filter((l) => l.account && Number(l.amount) > 0)
              .map((l) => ({
                account: l.account,
                group: l.group || undefined,
                dr: l.side === 'dr' ? Number(l.amount) : 0,
                cr: l.side === 'cr' ? Number(l.amount) : 0,
                allocs: l.allocs
                  .filter((a) => Number(a.amount) > 0)
                  .map((a) => ({ method: a.method, ref_name: a.ref_name || null, amount: Number(a.amount) }))
              }))
      }
      if (editingId != null) {
        await window.api.vouchers.update(editingId, payload)
        toast.success('Voucher altered')
        setEditingId(null)
        setScreen('daybook')
      } else {
        await window.api.vouchers.create(payload)
        toast.success(`${vchType} voucher accepted`)
        // Tally stays in the entry screen, ready for the next voucher.
        setVchNo('')
        setNarration('')
        setLines(blankLines(vchType))
        setPayLines([blankPayLine()])
        setRefsCache({})
      }
      loadAccounts()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function openForAlter(row: Row): Promise<void> {
    const v = await window.api.vouchers.get(Number(row.id))
    if (!v) return
    if (!v.manual) {
      setViewRow(v)
      return
    }
    setEditingId(Number(v.id))
    const t = (String(v.vch_type) as VchType) || 'JOURNAL'
    setVchType(t)
    setVchDate(String(v.entry_date))
    setVchNo(String(v.vch_no || ''))
    setNarration(String(v.narration || ''))
    const vLines = v.lines as Row[]
    setLines(
      vLines.map((l) => ({
        side: Number(l.dr) > 0 ? 'dr' : 'cr',
        account: String(l.account),
        group: String(l.acc_group || ''),
        amount: String(Number(l.dr) > 0 ? l.dr : l.cr),
        allocs: ((l.allocs as Row[]) || []).map((a) => ({
          method: String(a.method) as AllocRow['method'],
          ref_name: String(a.ref_name || ''),
          order_id: a.order_id != null ? Number(a.order_id) : null,
          sale_invoice_group: a.sale_invoice_group || null,
          amount: String(a.amount)
        }))
      }))
    )
    for (const l of vLines) if (BILLWISE_GROUPS.includes(String(l.acc_group))) void loadRefs(String(l.account))
    setNoteMode(false)
    // Payment/receipt vouchers whose money side is all cash/bank reopen in the
    // Tally format (one line or a split across several), bill-wise details
    // included; anything else falls back to the plain Dr/Cr grid.
    if (t === 'PAYMENT' || t === 'RECEIPT') {
      const moneySide = t === 'PAYMENT' ? 'cr' : 'dr'
      const money = vLines.filter((l) => Number(moneySide === 'cr' ? l.cr : l.dr) > 0 && CASH_BANK_GROUPS.includes(String(l.acc_group)))
      const parties = vLines.filter((l) => Number(moneySide === 'cr' ? l.dr : l.cr) > 0)
      if (money.length >= 1 && parties.length >= 1) {
        setPayAccounts(
          money.map((l) => ({
            account: String(l.account),
            group: String(l.acc_group || ''),
            amount: String(Number(moneySide === 'cr' ? l.cr : l.dr)),
            allocs: []
          }))
        )
        setPayLines(
          parties.map((l) => ({
            account: String(l.account),
            group: String(l.acc_group || ''),
            amount: String(Number(moneySide === 'cr' ? l.dr : l.cr)),
            allocs: ((l.allocs as Row[]) || []).map((a) => ({
              method: String(a.method) as AllocRow['method'],
              ref_name: String(a.ref_name || ''),
              order_id: a.order_id != null ? Number(a.order_id) : null,
              sale_invoice_group: a.sale_invoice_group || null,
              amount: String(a.amount)
            }))
          }))
        )
        for (const l of parties) void loadRefs(String(l.account))
        setRawAlter(false)
      } else {
        setRawAlter(true)
      }
    } else {
      setRawAlter(false)
    }
    setScreen('voucher')
  }

  async function deleteVoucher(): Promise<void> {
    if (editingId == null) return
    if (!confirm('Delete this voucher?')) return
    try {
      await window.api.vouchers.remove(editingId)
      toast.success('Voucher deleted')
      setEditingId(null)
      setScreen('daybook')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function createLedger(): Promise<void> {
    if (!newLedger) return
    const name = newLedger.name.trim().toUpperCase()
    if (!name) return void toast.error('Type the ledger name')
    if (!newLedger.group) return void toast.error('Pick the group')
    try {
      // The ledger materialises through the voucher line's group on first use;
      // creating it here just registers it immediately for picking.
      await window.api.journal.createAccount(name, newLedger.group)
      await loadAccounts()
      if (newLedger.target === 'payAccount' && newLedger.index != null)
        setPayAccountLine(newLedger.index, { account: name, group: newLedger.group })
      else if (newLedger.target === 'payLine' && newLedger.index != null)
        setPayLine(newLedger.index, { account: name, group: newLedger.group })
      else if (newLedger.forLine != null) setLine(newLedger.forLine, { account: name, group: newLedger.group })
      toast.success(`Ledger ${name} created under ${newLedger.group}`)
      setNewLedger(null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ------- keyboard: Tally function keys -------
  const GATEWAY_ITEMS = useMemo(
    () => [
      { key: 'V', label: 'Accounting Vouchers', icon: ScrollText, go: () => openVoucher('PAYMENT') },
      { key: 'P', label: 'Purchase Register', icon: PackageSearch, go: () => setScreen('purchreg') },
      { key: 'S', label: 'Sales Register', icon: Receipt, go: () => setScreen('salesreg') },
      { key: 'D', label: 'Day Book', icon: BookOpenText, go: () => setScreen('daybook') },
      { key: 'L', label: 'Ledger Accounts', icon: Wallet, go: () => setScreen('ledger') },
      { key: 'T', label: 'Trial Balance', icon: Scale, go: () => setScreen('trial') },
      { key: 'U', label: 'Trading Account', icon: ArrowLeftRight, go: () => setScreen('trading') }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      // Select Company gate: arrows + Enter, Esc leaves the module.
      if (!company) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCoIndex((i) => (companies.length ? (i + 1) % companies.length : 0))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCoIndex((i) => (companies.length ? (i - 1 + companies.length) % companies.length : 0))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (companies[coIndex]) setCompany(companies[coIndex])
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onExit?.()
        }
        return
      }
      if (e.key === 'F3') {
        e.preventDefault()
        setScreen('gateway')
        setCompany(null)
        return
      }
      // Function keys work everywhere on this page; letters only outside inputs.
      if (e.key === 'F4' || e.key === 'F5' || e.key === 'F6' || e.key === 'F7') {
        e.preventDefault()
        const wanted = e.altKey && e.key === 'F5' ? 'DEBIT NOTE' : e.altKey && e.key === 'F6' ? 'CREDIT NOTE' : null
        const t = wanted || VCH_TYPES.find((v) => v.fkey === e.key)!.key
        if (screen === 'voucher') switchType(t as VchType)
        else openVoucher(t as VchType)
        return
      }
      if (e.key === 'F1' && e.altKey && screen === 'ledger') {
        e.preventDefault()
        setLgDetailed((d) => !d)
        return
      }
      if (e.key === 'F2' && screen === 'voucher') {
        e.preventDefault()
        dateRef.current?.querySelector('button')?.click()
        return
      }
      if (e.key === 'Escape') {
        if (viewRow) return setViewRow(null)
        if (newLedger) return setNewLedger(null)
        if (screen !== 'gateway') {
          e.preventDefault()
          setEditingId(null)
          setScreen('gateway')
        } else {
          // Esc from the Gateway leaves the accounting workspace, like
          // quitting Tally back to the rest of the software.
          e.preventDefault()
          onExit?.()
        }
        return
      }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && screen === 'voucher') {
        e.preventDefault()
        void saveVoucher()
        return
      }
      if (e.altKey && (e.key === 'd' || e.key === 'D') && screen === 'voucher' && editingId != null) {
        e.preventDefault()
        void deleteVoucher()
        return
      }
      if (screen === 'gateway' && !typing) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setGwIndex((i) => (i + 1) % GATEWAY_ITEMS.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setGwIndex((i) => (i - 1 + GATEWAY_ITEMS.length) % GATEWAY_ITEMS.length)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          GATEWAY_ITEMS[gwIndex].go()
        } else {
          const hit = GATEWAY_ITEMS.findIndex((g) => g.key.toLowerCase() === e.key.toLowerCase())
          if (hit >= 0) {
            e.preventDefault()
            GATEWAY_ITEMS[hit].go()
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, gwIndex, viewRow, newLedger, editingId, lines, payLines, payAccounts, rawAlter, vchDate, vchNo, narration, vchType, saving, onExit, company, companies, coIndex])

  // ------- derived -------
  const ledgerAccount = accounts.find((a) => Number(a.id) === ledgerId)
  // The statement for the chosen period: opening = everything before `from`,
  // rows within [from, to] with a running balance seeded from the opening.
  const stmt = useMemo(() => {
    let opening = 0
    const rows: Row[] = []
    for (const l of ledgerLines) {
      const d = String(l.entry_date)
      const net = (Number(l.dr) || 0) - (Number(l.cr) || 0)
      if (lgFrom && d < lgFrom) {
        opening += net
        continue
      }
      if (lgTo && d > lgTo) continue
      rows.push(l)
    }
    let run = opening
    const out = rows.map((l): Row => {
      run += (Number(l.dr) || 0) - (Number(l.cr) || 0)
      return { ...l, running: run }
    })
    return {
      opening,
      rows: out,
      closing: run,
      totDr: out.reduce((sum, l) => sum + (Number(l.dr) || 0), 0),
      totCr: out.reduce((sum, l) => sum + (Number(l.cr) || 0), 0)
    }
  }, [ledgerLines, lgFrom, lgTo])

  // Tally's month-wise ledger summary: Dr/Cr per month and the cumulative
  // closing, drillable into that month's vouchers.
  const monthly = useMemo(() => {
    const by = new Map<string, { dr: number; cr: number }>()
    for (const l of ledgerLines) {
      const m = String(l.entry_date).slice(0, 7)
      const cur = by.get(m) || { dr: 0, cr: 0 }
      cur.dr += Number(l.dr) || 0
      cur.cr += Number(l.cr) || 0
      by.set(m, cur)
    }
    let run = 0
    return Array.from(by.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, v]) => {
        run += v.dr - v.cr
        return { month: m, dr: v.dr, cr: v.cr, closing: run }
      })
  }, [ledgerLines])

  function drillMonth(m: string): void {
    const [y, mo] = m.split('-').map(Number)
    const last = new Date(y, mo, 0).getDate()
    setLgFrom(`${m}-01`)
    setLgTo(`${m}-${String(last).padStart(2, '0')}`)
    setLgMonthly(false)
  }

  // Tally's columnar register: in DETAILED mode every ledger involved in the
  // period's vouchers becomes its own column, biggest money first.
  const legCols = useMemo(() => {
    if (!lgDetailed) return [] as string[]
    const tot = new Map<string, number>()
    for (const r of stmt.rows) {
      for (const g of (r.legs as Row[]) || []) {
        const k = String(g.name)
        tot.set(k, (tot.get(k) || 0) + Math.abs((Number(g.dr) || 0) - (Number(g.cr) || 0)))
      }
    }
    return Array.from(tot.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }, [stmt.rows, lgDetailed])

  // One ledger's net share of one voucher (its legs summed), for a columnar cell.
  const legShare = (row: Row, col: string): number => {
    let v = 0
    for (const g of (row.legs as Row[]) || []) {
      if (String(g.name) === col) v += (Number(g.dr) || 0) - (Number(g.cr) || 0)
    }
    return Math.round(v * 100) / 100
  }

  const filteredAccounts = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase()
    return q ? accounts.filter((a) => String(a.name).toLowerCase().includes(q)) : accounts
  }, [accounts, ledgerSearch])

  const tbGroups = useMemo(() => {
    if (!tb) return []
    const by = new Map<string, Row[]>()
    for (const r of tb.rows as Row[]) {
      const g = String(r.acc_group || 'General')
      if (!by.has(g)) by.set(g, [])
      by.get(g)!.push(r)
    }
    return Array.from(by.entries())
  }, [tb])

  // ------- screens -------
  const rightBar = (
    <div className="flex w-44 shrink-0 flex-col gap-1 p-2">
      <div className="mb-1 rounded bg-white/10 px-2.5 py-1.5 text-center text-[10px] font-bold uppercase tracking-widest text-amber-300">
        {screen === 'voucher' ? (editingId != null ? 'Alter voucher' : 'Voucher entry') : 'Gateway'}
      </div>
      {VCH_TYPES.map((v) => (
        <FKey
          key={v.key}
          k={v.fkey}
          label={v.label}
          active={screen === 'voucher' && vchType === v.key}
          onClick={() => (screen === 'voucher' ? switchType(v.key) : openVoucher(v.key))}
        />
      ))}
      <div className="my-1 border-t border-white/20" />
      <FKey k="P" label="Purchases" active={screen === 'purchreg'} onClick={() => setScreen('purchreg')} />
      <FKey k="S" label="Sales" active={screen === 'salesreg'} onClick={() => setScreen('salesreg')} />
      <FKey k="D" label="Day Book" active={screen === 'daybook'} onClick={() => setScreen('daybook')} />
      <FKey k="L" label="Ledgers" active={screen === 'ledger'} onClick={() => setScreen('ledger')} />
      <FKey k="T" label="Trial Balance" active={screen === 'trial'} onClick={() => setScreen('trial')} />
      <FKey k="U" label="Trading Account" active={screen === 'trading'} onClick={() => setScreen('trading')} />
      {screen === 'ledger' && (
        <>
          <div className="my-1 border-t border-white/20" />
          <FKey k="Alt F1" label={lgDetailed ? 'Condensed' : 'Columnar'} onClick={() => setLgDetailed((d) => !d)} />
          <FKey k="M" label={lgMonthly ? 'Vouchers' : 'Monthly'} active={lgMonthly} onClick={() => setLgMonthly((m) => !m)} />
        </>
      )}
      <div className="mt-auto space-y-1">
        {screen === 'voucher' && (
          <FKey k="Ctrl A" label={saving ? 'Saving…' : 'Accept'} onClick={() => void saveVoucher()} />
        )}
        {screen === 'voucher' && editingId != null && <FKey k="Alt D" label="Delete" onClick={() => void deleteVoucher()} />}
        {screen !== 'gateway' && <FKey k="Esc" label="Back" onClick={() => { setEditingId(null); setScreen('gateway') }} />}
      </div>
    </div>
  )

  const gateway = (
    <div className="flex flex-1 items-start justify-center pt-10">
      <div className={cn('w-[360px] rounded-md border shadow-lg', T.paperEdge, T.paper)}>
      <div className={cn('rounded-t-md px-4 py-2 text-center text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
        Gateway of Accounts
      </div>
      <div className="px-2 py-3">
        <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Transactions</div>
        {GATEWAY_ITEMS.map((g, i) => (
          <button
            key={g.key}
            type="button"
            onClick={g.go}
            onMouseEnter={() => setGwIndex(i)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-3 rounded px-3 py-2 text-left text-[14px] transition-colors',
              i === gwIndex ? T.select : 'hover:bg-amber-100/60'
            )}
          >
            <g.icon className="h-4 w-4 text-[#1a2c56]" />
            <span>
              <span className={cn('font-bold', T.key)}>{g.label.charAt(0)}</span>
              {g.label.slice(1)}
            </span>
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </button>
        ))}
        <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Use the highlighted letter or the function keys — F4 Contra, F5 Payment, F6 Receipt, F7 Journal, Alt+F5 Debit Note, Alt+F6 Credit Note. Purchase
          and sale vouchers post automatically from their own pages and appear in the Day Book.
        </p>
      </div>
      </div>
    </div>
  )

  const voucherScreen = (
    <div className="flex-1 p-3">
      <div className={cn('mx-auto w-full max-w-6xl rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex items-center justify-between rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">
            {editingId != null ? `Alter ${vchType} voucher` : `${vchType} voucher`}
          </span>
          <span className="text-[11px] font-medium">No: {vchNo || 'Auto'}</span>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-b border-dashed px-4 py-2.5" style={{ borderColor: '#d9d2b8' }}>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Date (F2)</Label>
            <div ref={dateRef} className="w-36">
              <DatePicker value={vchDate} onChange={setVchDate} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Voucher no (optional)</Label>
            <Input className="h-9 w-36 bg-white" value={vchNo} onChange={(e) => setVchNo(e.target.value)} />
          </div>
          {isNoteType && editingId == null && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 bg-white text-xs"
              title="Tally's Ctrl+H — switch between item invoice and plain voucher entry"
              onClick={() => setNoteMode((m) => !m)}
            >
              {noteMode ? 'As voucher' : 'Item invoice'}
            </Button>
          )}
          <div className="ml-auto text-right text-[11px] text-muted-foreground">
            {vchType === 'CONTRA' && 'Cash ↔ bank only, both sides'}
            {vchType === 'PAYMENT' && 'Credit side must be cash / bank'}
            {vchType === 'RECEIPT' && 'Debit side must be cash / bank'}
            {vchType === 'JOURNAL' && 'Any ledgers, Dr = Cr'}
            {vchType === 'DEBIT NOTE' && 'Purchase return — Dr the supplier, Cr the purchase/GST ledgers'}
            {vchType === 'CREDIT NOTE' && 'Sales return — Cr the customer, Dr the sales/GST ledgers'}
          </div>
        </div>

        {structured && (
          <div className="px-4 py-3">
            <div className="mb-3">
              <Label className="text-[10px] uppercase tracking-wide">
                Account{payAccounts.length > 1 ? 's' : ''} — {vchType === 'PAYMENT' ? 'paid out of' : 'received into'}
              </Label>
              <div className="mt-1 rounded border" style={{ borderColor: '#d9d2b8' }}>
                {payAccounts.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 border-b border-dotted px-2 py-1.5 last:border-0" style={{ borderColor: '#e5dfc8' }}>
                    <div className="w-80">
                      <AccountPicker
                        value={l.account}
                        accounts={cashBankAccounts}
                        autoFocus={i === 0}
                        onPick={(name, group) => setPayAccountLine(i, { account: name, group })}
                        onCreate={(q) => setNewLedger({ name: q, group: 'Bank Accounts', forLine: null, target: 'payAccount', index: i })}
                      />
                    </div>
                    {/* With a single account the amount is always the full total —
                        the input only appears once the money is actually split
                        across more than one, so the common case stays simple. */}
                    {payAccounts.length > 1 && (
                      <>
                        <Input
                          type="number"
                          className="h-8 w-32 bg-white text-right tabular-nums"
                          value={l.amount}
                          onFocus={() => suggestPayAccountAmount(i)}
                          onChange={(e) => setPayAccountLine(i, { amount: e.target.value })}
                        />
                        <button
                          type="button"
                          className="cursor-pointer text-muted-foreground hover:text-red-600"
                          onClick={() => setPayAccounts((p) => p.filter((_, j) => j !== i))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                <div className="px-2 py-1">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPayAccounts((p) => [...p, blankPayLine()])}>
                    <Plus className="h-3.5 w-3.5" /> Split across another account
                  </Button>
                </div>
              </div>
              <span className="text-[11px] text-muted-foreground">
                cash and bank ledgers only{payAccounts.length > 1 ? ` · total ${formatINR(payAccountTotal)}` : ''}
              </span>
            </div>

            <div className="rounded border" style={{ borderColor: '#d9d2b8' }}>
              <div
                className="grid grid-cols-[1fr_150px_32px] items-center gap-2 border-b bg-[#f1ecd9] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
                style={{ borderColor: '#d9d2b8' }}
              >
                <span>Particulars ({vchType === 'PAYMENT' ? 'Dr — who is paid' : 'Cr — who pays us'})</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {payLines.map((l, i) => {
                const refs = refsCache[l.account] || []
                const billwise = BILLWISE_GROUPS.includes(l.group) || l.allocs.length > 0
                const lineAmt = Number(l.amount) || 0
                return (
                  <div key={i} className="border-b border-dotted px-3 py-2 last:border-0" style={{ borderColor: '#e5dfc8' }}>
                    <div className="grid grid-cols-[1fr_150px_32px] items-center gap-2">
                      <AccountPicker
                        value={l.account}
                        accounts={accounts}
                        autoFocus={i === 0}
                        onPick={(name, group) => {
                          setPayLine(i, { account: name, group, allocs: [] })
                          void loadRefs(name)
                        }}
                        onCreate={(q) =>
                          setNewLedger({
                            name: q,
                            group: vchType === 'PAYMENT' ? 'Sundry Creditors' : 'Sundry Debtors',
                            forLine: null,
                            target: 'payLine',
                            index: i
                          })
                        }
                      />
                      <Input
                        type="number"
                        className="h-8 bg-white text-right tabular-nums"
                        value={l.amount}
                        onChange={(e) => setPayLine(i, { amount: e.target.value })}
                      />
                      <span className="text-right">
                        {payLines.length > 1 && (
                          <button
                            type="button"
                            className="cursor-pointer text-muted-foreground hover:text-red-600"
                            onClick={() => setPayLines((p) => p.filter((_, j) => j !== i))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>

                    {billwise && (
                      <AllocPanel
                        lineAmount={lineAmt}
                        allocs={l.allocs}
                        refs={refs}
                        onChange={(al) => setPayLine(i, { allocs: al })}
                      />
                    )}
                  </div>
                )
              })}
              <div className="px-3 py-1.5">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPayLines((p) => [...p, blankPayLine()])}>
                  <Plus className="h-3.5 w-3.5" /> Add party
                </Button>
              </div>
              <div className="flex items-center justify-between border-t-2 px-3 py-2 font-semibold" style={{ borderColor: '#1a2c56' }}>
                <span className="text-[12px]">
                  {vchType === 'PAYMENT' ? 'Total paid' : 'Total received'}
                  {payAccounts.length === 1 && payAccounts[0].account
                    ? ` — ${vchType === 'PAYMENT' ? 'Cr' : 'Dr'} ${payAccounts[0].account}`
                    : payAccounts.length > 1
                      ? ` — split across ${payAccounts.length} accounts`
                      : ''}
                </span>
                <span className="tabular-nums">{formatINR(payTotal)}</span>
              </div>
            </div>
          </div>
        )}

        {noteInvoiceMode && (
          <div className="px-4 py-3">
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">
                  {vchType === 'DEBIT NOTE' ? 'Supplier (goods going back)' : 'Customer (goods coming back)'}
                </Label>
                <Select
                  value={noteParty}
                  onValueChange={(v) => {
                    setNoteParty(v)
                    setNoteInvoice('')
                    const nm = String(noteParties.find((x) => String(x.id) === v)?.name || '')
                    if (nm) void loadRefs(nm.toUpperCase())
                  }}
                >
                  <SelectTrigger className="bg-white"><SelectValue placeholder="Select party" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {noteParties.map((x) => (
                      <SelectItem key={String(x.id)} value={String(x.id)}>{x.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wide">Original invoice (Agst Ref)</Label>
                <Select value={noteInvoice || 'ON_ACCOUNT'} onValueChange={(v) => setNoteInvoice(v === 'ON_ACCOUNT' ? '' : v)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder={noteParty ? 'On account' : 'Pick the party first'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="ON_ACCOUNT">On account (no invoice)</SelectItem>
                    {noteRefs.map((r) => (
                      <SelectItem key={String(r.ref)} value={String(r.ref)}>
                        {String(r.ref)} — {formatINR(r.pending)} pending
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded border" style={{ borderColor: '#d9d2b8' }}>
              <div
                className="grid grid-cols-[1fr_110px_130px_130px_32px] items-center gap-2 border-b bg-[#f1ecd9] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
                style={{ borderColor: '#d9d2b8' }}
              >
                <span>Item</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Rate</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {noteItems.map((it, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_110px_130px_130px_32px] items-center gap-2 border-b border-dotted px-3 py-1.5 last:border-0"
                  style={{ borderColor: '#e5dfc8' }}
                >
                  <Select
                    value={it.product_id}
                    onValueChange={(v) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, product_id: v } : x)))}
                  >
                    <SelectTrigger className="h-8 bg-white text-[13px]"><SelectValue placeholder="Product" /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      {noteProducts.map((x) => (
                        <SelectItem key={String(x.id)} value={String(x.id)}>{x.code || x.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    className="h-8 bg-white text-right tabular-nums"
                    placeholder="MT"
                    value={it.qty}
                    onChange={(e) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                  />
                  <Input
                    type="number"
                    className="h-8 bg-white text-right tabular-nums"
                    placeholder="₹ / MT"
                    value={it.rate}
                    onChange={(e) => setNoteItems((p) => p.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                  />
                  <span className="text-right text-[13px] font-medium tabular-nums">
                    {formatINR(Math.round((Number(it.qty) || 0) * (Number(it.rate) || 0) * 100) / 100)}
                  </span>
                  <span className="text-right">
                    {noteItems.length > 1 && (
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground hover:text-red-600"
                        onClick={() => setNoteItems((p) => p.filter((_, j) => j !== i))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
              ))}
              <div className="px-3 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setNoteItems((p) => [...p, { product_id: '', qty: '', rate: '' }])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add item
                </Button>
              </div>
            </div>

            <div className="mt-3 ml-auto w-72 space-y-1 text-[13px]">
              <div className="flex justify-between"><span className="text-muted-foreground">Taxable value</span><span className="tabular-nums">{formatINR(noteTotals.base)}</span></div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  GST
                  <Input
                    type="number"
                    className="h-6 w-14 bg-white px-1 text-right text-[12px] tabular-nums"
                    value={noteGst}
                    onChange={(e) => setNoteGst(e.target.value)}
                  />
                  %
                </span>
                <span className="tabular-nums">{formatINR(noteTotals.gst)}</span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">Round off</span><span className="tabular-nums">{formatINR(noteTotals.ro)}</span></div>
              <div className="flex justify-between border-t-2 pt-1 font-bold" style={{ borderColor: '#1a2c56' }}>
                <span>{vchType === 'DEBIT NOTE' ? 'Dr supplier' : 'Cr customer'}</span>
                <span className="tabular-nums">{formatINR(noteTotals.total)}</span>
              </div>
              <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
                Posts {vchType === 'DEBIT NOTE' ? 'PURCHASE RETURN + GST INPUT reversal' : 'SALES RETURN + GST OUTPUT reversal'} with
                the round off, numbered automatically, settled bill-wise against the chosen invoice.
              </p>
            </div>
          </div>
        )}

        {!structured && !noteInvoiceMode && (vchType === 'DEBIT NOTE' || vchType === 'CREDIT NOTE') && (
          <div className="mx-4 mt-3 flex flex-wrap items-end gap-3 rounded border border-dashed border-sky-300 bg-sky-50/60 px-3 py-2">
            <span className="pb-1.5 text-[10px] font-bold uppercase tracking-widest text-sky-800">GST helper</span>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Taxable value</Label>
              <Input
                type="number"
                className="h-8 w-36 bg-white text-right tabular-nums"
                value={gstCalc.taxable}
                onChange={(e) => setGstCalc((g) => ({ ...g, taxable: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">GST %</Label>
              <Input
                type="number"
                className="h-8 w-20 bg-white text-right tabular-nums"
                value={gstCalc.pct}
                onChange={(e) => setGstCalc((g) => ({ ...g, pct: e.target.value }))}
              />
            </div>
            <Button size="sm" variant="outline" className="h-8 bg-white text-xs" onClick={applyGstCalc}>
              Build the legs
            </Button>
            <span className="pb-1.5 text-[11px] text-sky-800">
              {(() => {
                const t = Number(gstCalc.taxable) || 0
                const g = Math.round(t * (Number(gstCalc.pct) || 0)) / 100
                const total = Math.round(t + g)
                const ro = Math.round((total - t - g) * 100) / 100
                return t > 0
                  ? `GST ${formatINR(g)} · round off ${formatINR(ro)} · party ${formatINR(total)} — ${vchType === 'DEBIT NOTE' ? 'GST INPUT reversed, supplier debited' : 'GST OUTPUT reversed, customer credited'}`
                  : 'Types the taxable and GST legs, with the round off, so the party total is a whole rupee.'
              })()}
            </span>
          </div>
        )}

        {!structured && !noteInvoiceMode && vchType === 'JOURNAL' && (
          <div className="mx-4 mt-3 flex flex-wrap items-end gap-3 rounded border border-dashed border-sky-300 bg-sky-50/60 px-3 py-2">
            <span className="pb-1.5 text-[10px] font-bold uppercase tracking-widest text-sky-800">Rate difference helper</span>
            <div className="flex w-56 flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Party</Label>
              <AccountPicker
                value={rateDiff.party}
                accounts={accounts.filter((a) => a.acc_group === 'Sundry Debtors' || a.acc_group === 'Sundry Creditors')}
                onPick={(name, group) => {
                  setRateDiff((p) => ({ ...p, party: name, group }))
                  void loadRefs(name)
                }}
                onCreate={(q) => setNewLedger({ name: q, group: '', forLine: null })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Direction</Label>
              <Select value={rateDiff.direction} onValueChange={(v) => setRateDiff((p) => ({ ...p, direction: v as 'owes_more' | 'owes_less' }))}>
                <SelectTrigger className="h-8 w-40 bg-white text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="owes_more">Rate went up</SelectItem>
                  <SelectItem value="owes_less">Rate went down</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px] uppercase tracking-wide">Amount (₹)</Label>
              <Input
                type="number"
                className="h-8 w-32 bg-white text-right tabular-nums"
                value={rateDiff.amount}
                onChange={(e) => setRateDiff((p) => ({ ...p, amount: e.target.value }))}
              />
            </div>
            <Button size="sm" variant="outline" className="h-8 bg-white text-xs" onClick={applyRateDiff}>
              Build the legs
            </Button>
            <span className="pb-1.5 text-[11px] text-sky-800">
              {rateDiff.party
                ? `${rateDiff.direction === 'owes_more' ? 'Party owes more' : 'Party owes less'} against RATE DIFFERENCE A/C — settle bill-wise below if it's against a specific invoice.`
                : "For a price revision on a bill already invoiced — settles through RATE DIFFERENCE A/C without reopening it."}
            </span>
          </div>
        )}

        {!structured && !noteInvoiceMode && (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-[10px] uppercase tracking-widest text-muted-foreground" style={{ borderColor: '#d9d2b8' }}>
              <th className="w-16 px-4 py-1.5">Dr/Cr</th>
              <th className="px-2 py-1.5">Particulars</th>
              <th className="w-36 px-2 py-1.5 text-right">Debit</th>
              <th className="w-36 px-2 py-1.5 text-right">Credit</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <Fragment key={i}>
              <tr className="border-b border-dotted" style={{ borderColor: '#e5dfc8' }}>
                <td className="px-4 py-1.5">
                  <button
                    type="button"
                    title="Toggle Dr / Cr"
                    onClick={() => setLine(i, { side: l.side === 'dr' ? 'cr' : 'dr' })}
                    className={cn(
                      'w-10 cursor-pointer rounded px-1.5 py-0.5 text-center text-[12px] font-bold',
                      l.side === 'dr' ? 'bg-sky-100 text-sky-800' : 'bg-rose-100 text-rose-700'
                    )}
                  >
                    {l.side === 'dr' ? 'Dr' : 'Cr'}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <AccountPicker
                    value={l.account}
                    // Contra only ever moves money between cash and bank — offering
                    // every ledger here just let a wrong pick through to a
                    // confusing rejection at save time instead of not being
                    // choosable in the first place.
                    accounts={vchType === 'CONTRA' ? cashBankAccounts : accounts}
                    autoFocus={i === 0}
                    onPick={(name, group) => {
                      setLine(i, { account: name, group, allocs: [] })
                      void loadRefs(name)
                    }}
                    onCreate={(q) => setNewLedger({ name: q, group: vchType === 'CONTRA' ? 'Bank Accounts' : '', forLine: i })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  {l.side === 'dr' && (
                    <Input
                      type="number"
                      className="h-8 bg-white text-right tabular-nums"
                      value={l.amount}
                      onFocus={() => suggestAmount(i)}
                      onChange={(e) => setLine(i, { amount: e.target.value })}
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {l.side === 'cr' && (
                    <Input
                      type="number"
                      className="h-8 bg-white text-right tabular-nums"
                      value={l.amount}
                      onFocus={() => suggestAmount(i)}
                      onChange={(e) => setLine(i, { amount: e.target.value })}
                    />
                  )}
                </td>
                <td className="pr-3 text-right">
                  {lines.length > 2 && (
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground hover:text-red-600"
                      onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
              {(BILLWISE_GROUPS.includes(l.group) || l.allocs.length > 0) && (
                <tr>
                  <td />
                  <td colSpan={3} className="px-2 pb-2">
                    <AllocPanel
                      lineAmount={Number(l.amount) || 0}
                      allocs={l.allocs}
                      refs={refsCache[l.account] || []}
                      onChange={(al) => setLine(i, { allocs: al })}
                    />
                  </td>
                  <td />
                </tr>
              )}
              </Fragment>
            ))}
            <tr>
              <td colSpan={5} className="px-4 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setLines((p) => [...p, { side: 'cr', account: '', group: '', amount: '', allocs: [] }])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold" style={{ borderColor: '#1a2c56' }}>
              <td className="px-4 py-2" colSpan={2}>
                {Math.abs(totals.diff) < 0.005 ? (
                  <span className="flex items-center gap-1 text-[12px] text-emerald-700">
                    <Check className="h-3.5 w-3.5" /> Balanced
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-[12px] text-red-600">
                    Difference {formatINR(Math.abs(totals.diff))} {totals.diff > 0 ? '(Cr short)' : '(Dr short)'}
                    {Math.abs(totals.diff) < 1 && (
                      <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={addRoundOffLine}>
                        Close with round off
                      </Button>
                    )}
                  </span>
                )}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{formatINR(totals.dr)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatINR(totals.cr)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        )}

        <div className="flex items-end gap-3 px-4 pb-4 pt-1">
          <div className="flex flex-1 flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Narration</Label>
            <Input className="h-9 bg-white" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being…" />
          </div>
          <Button className="bg-[#1a2c56] hover:bg-[#24407e]" disabled={saving} onClick={() => void saveVoucher()}>
            {saving ? 'Saving…' : editingId != null ? 'Save changes (Ctrl+A)' : 'Accept (Ctrl+A)'}
          </Button>
          {editingId != null && (
            <Button variant="outline" className="text-red-600" onClick={() => void deleteVoucher()}>
              <Trash2 className="h-4 w-4" /> Delete (Alt+D)
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  // Shared filter bar for both registers: period, free text, funding state.
  // fundingLabels omitted = no funding filter for that register (the sales
  // register has none, since bill discounting no longer links to an invoice).
  function registerFilters(fundingLabels?: [string, string]): React.JSX.Element {
    return (
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-56 bg-white text-[12px]"
          placeholder="Search invoice, party, product…"
          value={regSearch}
          onChange={(e) => setRegSearch(e.target.value)}
        />
        <FyPicker from={regFrom} to={regTo} onRange={(f, t) => { setRegFrom(f); setRegTo(t) }} className="h-8 w-28 bg-white text-xs" />
        <DatePicker value={regFrom} onChange={(v) => setRegFrom(v || '')} max={regTo || undefined} className="h-8 w-[8.5rem] bg-white text-[11px]" />
        <span className="text-[11px] text-muted-foreground">to</span>
        <DatePicker value={regTo} onChange={(v) => setRegTo(v || '')} min={regFrom || undefined} className="h-8 w-[8.5rem] bg-white text-[11px]" />
        {fundingLabels && (
          <MultiSelectFilter
            options={[
              { value: 'lc', label: fundingLabels[0] },
              { value: 'nolc', label: fundingLabels[1] }
            ]}
            value={regFunding}
            onApply={setRegFunding}
            allLabel="All"
            className="h-8 w-40 bg-white text-[11px]"
          />
        )}
        {(regFrom || regTo || regSearch || regFunding.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => { setRegFrom(''); setRegTo(''); setRegSearch(''); setRegFunding([]) }}
          >
            Clear
          </Button>
        )}
      </div>
    )
  }

  // Period + text + funding filter, applied to whichever register is showing.
  function inPeriod(dateVal: unknown): boolean {
    const d = String(dateVal || '').slice(0, 10)
    if (regFrom && d < regFrom) return false
    if (regTo && d > regTo) return false
    return true
  }

  const purchaseRows = useMemo(() => {
    const q = regSearch.trim().toLowerCase()
    return purchases.filter((o) => {
      if (!inPeriod(o.order_date)) return false
      if (regFunding.length && !regFunding.includes(o.lc_nos ? 'lc' : 'nolc')) return false
      if (!q) return true
      return [o.invoice_no, o.supplier_name, o.oil_code, o.oil_name, o.lc_nos]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchases, regFrom, regTo, regSearch, regFunding])

  const salesRegRows = useMemo(() => {
    const q = regSearch.trim().toLowerCase()
    return saleRows.filter((s) => {
      if (!inPeriod(s.sale_date)) return false
      if (!q) return true
      return [s.invoice_no, s.customer, s.product_name, s.gate_vehicle_no]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleRows, regFrom, regTo, regSearch])

  // Tag a purchase to an LC — issues a bill under that LC against the invoice,
  // which is what makes the purchase show as LC-funded and eats the limit.
  async function saveTag(): Promise<void> {
    if (!tagForm) return
    if (!tagForm.lc_id) return void toast.error('Pick the LC this purchase is funded by')
    if (!(Number(tagForm.amount) > 0)) return void toast.error('Enter the amount drawn under the LC')
    try {
      await window.api.lc.issue({
        lc_id: Number(tagForm.lc_id),
        order_id: Number(tagForm.order_id),
        amount: Number(tagForm.amount),
        issue_date: tagForm.issue_date,
        due_date: tagForm.due_date || '',
        bill_no: tagForm.bill_no || ''
      })
      toast.success(`${tagForm.invoice_no} tagged to the LC`)
      setTagForm(null)
      void loadRegisters()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const purchaseTotals = purchaseRows.reduce(
    (a, o) => ({
      net: a.net + n(o.net_amount),
      lc: a.lc + n(o.lc_amount),
      paid: a.paid + n(o.paid_amount)
    }),
    { net: 0, lc: 0, paid: 0 }
  )

  const purchaseRegisterScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Purchase Register</span>
          {registerFilters(['Funded by LC', 'No LC tagged'])}
        </div>
        <div className="max-h-[calc(100vh-230px)] overflow-auto">
          <table className="w-full min-w-[1050px] text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#f1ecd9] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Invoice</th>
                <th className="px-3 py-2 font-semibold">Supplier</th>
                <th className="px-3 py-2 font-semibold">Material</th>
                <th className="px-3 py-2 text-right font-semibold">Qty</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-3 py-2 font-semibold">LC / funding</th>
                <th className="px-3 py-2 text-right font-semibold">Paid</th>
                <th className="px-3 py-2 text-right font-semibold">Balance</th>
                <th className="px-3 py-2 text-right font-semibold">Tag</th>
              </tr>
            </thead>
            <tbody>
              {purchaseRows.length === 0 ? (
                <tr><td colSpan={10} className="py-12 text-center text-muted-foreground">No purchases for this filter.</td></tr>
              ) : (
                purchaseRows.map((o) => {
                  const bal = n(o.net_amount) - n(o.paid_amount)
                  const overdue = o.lc_next_due && String(o.lc_next_due) < todayISO()
                  return (
                    <tr key={String(o.id)} className="border-b border-dotted border-[#e5dfc8] hover:bg-amber-100/60">
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{formatDate(o.order_date)}</td>
                      <td className="px-3 py-1.5 font-medium">{o.invoice_no || '—'}</td>
                      <td className="max-w-[180px] truncate px-3 py-1.5" title={String(o.supplier_name || '')}>{o.supplier_name || '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{o.oil_code || o.oil_name || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n(o.received_qty) || n(o.ordered_qty)} {o.uom || 'MT'}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatINR(o.net_amount)}</td>
                      <td className="px-3 py-1.5">
                        {o.lc_nos ? (
                          <span className="inline-flex flex-wrap items-center gap-1">
                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">LC</span>
                            <span className="font-medium">{o.lc_nos}</span>
                            {n(o.lc_bills_open) > 0 ? (
                              <span
                                className={cn(
                                  'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                                  overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
                                )}
                              >
                                {overdue ? 'overdue' : 'open'}
                                {o.lc_next_due ? ` · ${formatDate(o.lc_next_due)}` : ''}
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">settled</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">own funds</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{n(o.paid_amount) ? formatINR(o.paid_amount) : '—'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-medium tabular-nums', bal > 0.005 ? 'text-rose-700' : 'text-muted-foreground')}>
                        {formatINR(bal)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          onClick={() =>
                            setTagForm({
                              order_id: o.id,
                              invoice_no: o.invoice_no,
                              supplier_name: o.supplier_name,
                              amount: String(Math.round(n(o.net_amount) - n(o.lc_amount))),
                              bill_no: o.invoice_no,
                              issue_date: todayISO()
                            })
                          }
                        >
                          {o.lc_nos ? '+ LC' : 'Tag LC'}
                        </Button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {purchaseRows.length > 0 && (
              <tfoot className="sticky bottom-0">
                <tr className="border-t-2 border-amber-500 bg-amber-100 font-semibold">
                  <td className="px-3 py-2 text-[11px] uppercase tracking-wide text-amber-900" colSpan={5}>
                    {purchaseRows.length} purchase{purchaseRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.net)}</td>
                  <td className="px-3 py-2 text-right text-[11px] tabular-nums text-amber-900">{formatINR(purchaseTotals.lc)} on LC</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.paid)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(purchaseTotals.net - purchaseTotals.paid)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )

  const salesTotals = salesRegRows.reduce(
    (a, s) => ({
      net: a.net + n(s.amount) + n(s.gst_amount) + n(s.round_off),
      recd: a.recd + n(s.received_amount)
    }),
    { net: 0, recd: 0 }
  )

  const salesRegisterScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Sales Register</span>
          {registerFilters()}
        </div>
        <div className="max-h-[calc(100vh-230px)] overflow-auto">
          <table className="w-full min-w-[1000px] text-[12px]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#f1ecd9] text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Invoice</th>
                <th className="px-3 py-2 font-semibold">Vehicle</th>
                <th className="px-3 py-2 font-semibold">Customer</th>
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 text-right font-semibold">Qty</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-3 py-2 text-right font-semibold">Received</th>
                <th className="px-3 py-2 text-right font-semibold">Balance</th>
              </tr>
            </thead>
            <tbody>
              {salesRegRows.length === 0 ? (
                <tr><td colSpan={9} className="py-12 text-center text-muted-foreground">No sales for this filter.</td></tr>
              ) : (
                salesRegRows.map((s) => {
                  const net = n(s.amount) + n(s.gst_amount) + n(s.round_off)
                  const bal = net - n(s.received_amount)
                  return (
                    <tr key={String(s.id)} className="border-b border-dotted border-[#e5dfc8] hover:bg-amber-100/60">
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{formatDate(s.sale_date)}</td>
                      <td className="px-3 py-1.5 font-medium">{s.invoice_no || '—'}</td>
                      <td className="px-3 py-1.5">
                        {s.gate_vehicle_no ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="font-medium">{s.gate_vehicle_no}</span>
                            <span className="text-[10px] text-muted-foreground">{s.gate_entry_no}</span>
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">not gated out</span>
                        )}
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-1.5" title={String(s.customer || '')}>{s.customer || '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{s.product_name || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{n(s.qty)} {s.uom || 'MT'}</td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums">{formatINR(net)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{n(s.received_amount) ? formatINR(s.received_amount) : '—'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-medium tabular-nums', bal > 0.005 ? 'text-rose-700' : 'text-muted-foreground')}>
                        {formatINR(bal)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {salesRegRows.length > 0 && (
              <tfoot className="sticky bottom-0">
                <tr className="border-t-2 border-amber-500 bg-amber-100 font-semibold">
                  <td className="px-3 py-2 text-[11px] uppercase tracking-wide text-amber-900" colSpan={6}>
                    {salesRegRows.length} sale{salesRegRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.net)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.recd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-900">{formatINR(salesTotals.net - salesTotals.recd)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )

  const daybookScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Day Book</span>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={dbFrom} to={dbTo} onRange={(f, t) => { setDbFrom(f); setDbTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={dbFrom} onChange={setDbFrom} max={dbTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={dbTo} onChange={setDbTo} min={dbFrom || undefined} /></div>
            <MultiSelectFilter
              options={[
                ...VCH_TYPES.map((v) => ({ value: v.key, label: v.label })),
                { value: 'PURCHASE OIL', label: 'Purchase (auto)' },
                { value: 'SALE', label: 'Sales (auto)' }
              ]}
              value={dbType}
              onApply={setDbType}
              allLabel="All vouchers"
              className="h-9 w-36 bg-white text-xs"
            />
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#f1ecd9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">Date</th>
                <th className="px-2 py-1.5">Particulars</th>
                <th className="px-2 py-1.5">Vch type</th>
                <th className="px-2 py-1.5">Vch no</th>
                <th className="px-2 py-1.5 text-right">Amount</th>
                <th className="w-20 py-1.5 pl-2 pr-5 text-center">Entry</th>
              </tr>
            </thead>
            <tbody>
              {dayRows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No vouchers in this period.</td></tr>
              ) : (
                dayRows.map((r) => (
                  <tr
                    key={String(r.id)}
                    className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                    style={{ borderColor: '#e5dfc8' }}
                    onClick={() => void openForAlter(r)}
                  >
                    <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">{formatDate(r.entry_date)}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{r.dr_account || '—'}</div>
                      <div className="text-[11px] text-muted-foreground">to {r.cr_account || '—'}</div>
                    </td>
                    <td className="px-2 py-1.5">{r.vch_type}</td>
                    <td className="px-2 py-1.5">{r.vch_no || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(r.amount)}</td>
                    <td className="py-1.5 pl-2 pr-5 text-center">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', r.manual ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600')}>
                        {r.manual ? 'Manual' : 'Auto'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  const ledgerScreen = (
    <div className="flex flex-1 gap-3 p-3">
      <div className={cn('flex w-80 shrink-0 flex-col rounded-md border shadow-lg xl:w-96', T.paperEdge, T.paper)}>
        <div className={cn('rounded-t-md px-4 py-2 text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
          Ledgers
        </div>
        <div className="p-2">
          <Input
            className="h-8 bg-white text-[13px]"
            placeholder="Search ledger…"
            value={ledgerSearch}
            onChange={(e) => setLedgerSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {filteredAccounts.map((a) => (
            <button
              key={String(a.id)}
              type="button"
              onClick={() => setLedgerId(Number(a.id))}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12.5px]',
                ledgerId === Number(a.id) ? T.select : 'hover:bg-amber-100/60'
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{a.name}</span>
                <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{a.acc_group}</span>
              </span>
              <span className={cn('shrink-0 tabular-nums text-[12px] font-semibold', Number(a.balance) >= 0 ? 'text-sky-800' : 'text-rose-700')}>
                {formatINR(Math.abs(Number(a.balance) || 0))} {Number(a.balance) >= 0 ? 'Dr' : 'Cr'}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={cn('min-w-0 flex-1 rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        {!ledgerAccount ? (
          <div className="flex h-full items-center justify-center p-10 text-muted-foreground">
            <span className="flex items-center gap-2 text-sm"><Landmark className="h-4 w-4" /> Pick a ledger to see its vouchers.</span>
          </div>
        ) : (
          <>
            <div className={cn('flex flex-wrap items-center gap-2 rounded-t-md px-4 py-2', T.headBar)}>
              <span className="min-w-0 truncate text-[13px] font-bold uppercase tracking-widest">{ledgerAccount.name}</span>
              <span className="text-[11px]">{ledgerAccount.acc_group}</span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <FyPicker from={lgFrom} to={lgTo} onRange={(f, t) => { setLgFrom(f); setLgTo(t) }} className="h-8 w-28 bg-white text-xs" />
                <div className="w-40"><DatePicker value={lgFrom} onChange={setLgFrom} max={lgTo || undefined} /></div>
                <span className="text-[11px]">to</span>
                <div className="w-40"><DatePicker value={lgTo} onChange={setLgTo} min={lgFrom || undefined} /></div>
                {(lgFrom || lgTo) && (
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => { setLgFrom(''); setLgTo('') }}>
                    All
                  </Button>
                )}
                <Button
                  variant={lgMonthly ? 'default' : 'outline'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', lgMonthly && 'bg-[#1a2c56] hover:bg-[#24407e]')}
                  onClick={() => setLgMonthly((m) => !m)}
                >
                  Monthly
                </Button>
                <Button
                  variant={lgDetailed ? 'default' : 'outline'}
                  size="sm"
                  className={cn('h-8 px-2 text-xs', lgDetailed && 'bg-[#1a2c56] hover:bg-[#24407e]')}
                  title="Columnar register — a column per ledger involved (Alt+F1)"
                  onClick={() => setLgDetailed((d) => !d)}
                >
                  Columnar
                </Button>
              </div>
            </div>
            {lgMonthly ? (
              <div className="max-h-[calc(100vh-225px)] overflow-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-[#f1ecd9]">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className="px-4 py-1.5">Month</th>
                      <th className="px-2 py-1.5 text-right">Debit</th>
                      <th className="px-2 py-1.5 text-right">Credit</th>
                      <th className="px-2 py-1.5 text-right">Closing balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m) => (
                      <tr
                        key={m.month}
                        className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                        style={{ borderColor: '#e5dfc8' }}
                        title="Open this month's vouchers"
                        onClick={() => drillMonth(m.month)}
                      >
                        <td className="px-4 py-1.5 font-medium">{monthLabelLong(m.month)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.dr ? formatINR(m.dr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{m.cr ? formatINR(m.cr) : ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                          {formatINR(Math.abs(m.closing))} {m.closing >= 0 ? 'Dr' : 'Cr'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 font-bold" style={{ borderColor: '#1a2c56' }}>
                      <td className="px-4 py-2">Grand total</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(monthly.reduce((sum, m) => sum + m.dr, 0))}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(monthly.reduce((sum, m) => sum + m.cr, 0))}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {(() => {
                          const c = monthly.length ? monthly[monthly.length - 1].closing : 0
                          return `${formatINR(Math.abs(c))} ${c >= 0 ? 'Dr' : 'Cr'}`
                        })()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="max-h-[calc(100vh-225px)] overflow-auto [scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-3 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-[#efe9d2] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#1a2c56]/50 hover:[&::-webkit-scrollbar-thumb]:bg-[#1a2c56]/70">
                <table className={cn('w-full text-[13px]', lgDetailed && legCols.length > 0 && 'min-w-max')}>
                  <thead className="sticky top-0 z-20 bg-[#f1ecd9]">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th className={cn('px-4 py-1.5', lgDetailed && 'sticky left-0 z-30 w-[104px] min-w-[104px] bg-[#f1ecd9]')}>Date</th>
                      <th className={cn('px-2 py-1.5', lgDetailed && 'sticky left-[104px] z-30 w-[190px] min-w-[190px] bg-[#f1ecd9] shadow-[4px_0_6px_-4px_rgba(26,44,86,0.35)]')}>Particulars</th>
                      <th className="px-2 py-1.5">Vch</th>
                      <th className="px-2 py-1.5 text-right">Debit</th>
                      <th className="px-2 py-1.5 text-right">Credit</th>
                      <th className="px-2 py-1.5 text-right">Balance</th>
                      {lgDetailed &&
                        legCols.map((c) => (
                          <th key={c} className="max-w-[150px] truncate border-l px-2 py-1.5 text-right" style={{ borderColor: '#e5dfc8' }} title={c}>
                            {c}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(lgFrom || Math.abs(stmt.opening) > 0.004) && (
                      <tr className="border-b bg-amber-50/60 font-medium" style={{ borderColor: '#e5dfc8' }}>
                        <td className={cn('px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground', lgDetailed && 'sticky left-0 z-10 bg-[#fbf3dc]')}>
                          {lgFrom ? formatDate(lgFrom) : ''}
                        </td>
                        <td className={cn('px-2 py-1.5 italic', lgDetailed && 'sticky left-[104px] z-10 bg-[#fbf3dc]')} colSpan={lgDetailed ? 1 : 4}>Opening balance</td>
                        {lgDetailed && <td colSpan={3} />}
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                          {formatINR(Math.abs(stmt.opening))} {stmt.opening >= 0 ? 'Dr' : 'Cr'}
                        </td>
                        {lgDetailed && legCols.length > 0 && <td colSpan={legCols.length} />}
                      </tr>
                    )}
                    {stmt.rows.map((l) => (
                      <tr key={String(l.id)} className="border-b border-dotted align-top" style={{ borderColor: '#e5dfc8' }}>
                        <td className={cn('whitespace-nowrap px-4 py-1.5 tabular-nums', lgDetailed && 'sticky left-0 z-10 bg-[#fffdf4]')}>{formatDate(l.entry_date)}</td>
                        <td className={cn('px-2 py-1.5', lgDetailed && 'sticky left-[104px] z-10 max-w-[190px] bg-[#fffdf4] shadow-[4px_0_6px_-4px_rgba(26,44,86,0.25)]')}>
                          <div className="truncate font-medium" title={String(l.particulars || l.vch_type)}>{l.particulars || l.vch_type}</div>
                          {l.narration && <div className="truncate text-[11px] italic text-muted-foreground">{l.narration}</div>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">
                          <div>{l.voucher_code}</div>
                          {lgDetailed && <div>{l.vch_type}{l.vch_no ? ` · ${l.vch_no}` : ''}</div>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.dr) ? formatINR(l.dr) : ''}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.cr) ? formatINR(l.cr) : ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                          {formatINR(Math.abs(l.running))} {l.running >= 0 ? 'Dr' : 'Cr'}
                        </td>
                        {lgDetailed &&
                          legCols.map((c) => {
                            const v = legShare(l, c)
                            return (
                              <td key={c} className="whitespace-nowrap border-l px-2 py-1.5 text-right tabular-nums" style={{ borderColor: '#f0ead2' }}>
                                {Math.abs(v) > 0.004 ? (
                                  <>
                                    {formatINR(Math.abs(v))} <span className="text-[10px] text-muted-foreground">{v > 0 ? 'Dr' : 'Cr'}</span>
                                  </>
                                ) : (
                                  ''
                                )}
                              </td>
                            )
                          })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 bg-[#fffdf4] font-bold" style={{ borderColor: '#1a2c56' }}>
                      <td className={cn('px-4 py-2', lgDetailed && 'sticky left-0 z-10 bg-[#fffdf4]')} colSpan={lgDetailed ? 2 : 3}>
                        Closing balance{lgFrom || lgTo ? ' (period)' : ''}
                      </td>
                      {lgDetailed && <td />}
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(stmt.totDr)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatINR(stmt.totCr)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                        {formatINR(Math.abs(stmt.closing))} {stmt.closing >= 0 ? 'Dr' : 'Cr'}
                      </td>
                      {lgDetailed &&
                        legCols.map((c) => {
                          const v = Math.round(stmt.rows.reduce((sum, r) => sum + legShare(r, c), 0) * 100) / 100
                          return (
                            <td key={c} className="whitespace-nowrap border-l px-2 py-2 text-right tabular-nums" style={{ borderColor: '#e5dfc8' }}>
                              {Math.abs(v) > 0.004 ? `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}` : ''}
                            </td>
                          )
                        })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )

  const trialScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Trial Balance</span>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={tbFrom} to={tbTo} onRange={(f, t) => { setTbFrom(f); setTbTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={tbFrom} onChange={setTbFrom} max={tbTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={tbTo} onChange={setTbTo} min={tbFrom || undefined} /></div>
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#f1ecd9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">Particulars</th>
                <th className="px-2 py-1.5 text-right">Debit</th>
                <th className="px-2 py-1.5 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {tbGroups.map(([group, rows]) => (
                <Fragment key={group}>
                  <tr className="bg-amber-50/70">
                    <td className="px-4 py-1 text-[11px] font-bold uppercase tracking-wide text-[#1a2c56]" colSpan={3}>{group}</td>
                  </tr>
                  {rows.map((r) => (
                    <tr
                      key={String(r.id)}
                      className="cursor-pointer border-b border-dotted hover:bg-amber-100/70"
                      style={{ borderColor: '#e5dfc8' }}
                      onClick={() => { setLedgerId(Number(r.id)); setScreen('ledger') }}
                    >
                      <td className="px-6 py-1.5">{r.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.closing_dr > 0.004 ? formatINR(r.closing_dr) : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.closing_cr > 0.004 ? formatINR(r.closing_cr) : ''}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-bold" style={{ borderColor: '#1a2c56' }}>
                <td className="px-4 py-2">
                  Grand total
                  {tb && Math.abs(Number(tb.totals.closing_dr) - Number(tb.totals.closing_cr)) < 0.02 && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Books balanced</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatINR(tb?.totals.closing_dr || 0)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatINR(tb?.totals.closing_cr || 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )

  const tradingTotals = tradingRows.reduce(
    (a, r) => ({
      pq: a.pq + n(r.purchase_qty), pv: a.pv + n(r.purchase_value),
      sq: a.sq + n(r.sale_qty), sv: a.sv + n(r.sale_value), gross: a.gross + n(r.gross)
    }),
    { pq: 0, pv: 0, sq: 0, sv: 0, gross: 0 }
  )

  const tradingScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Trading Account</span>
          <div className="ml-auto flex items-center gap-2">
            <FyPicker from={tradingFrom} to={tradingTo} onRange={(f, t) => { setTradingFrom(f); setTradingTo(t) }} className="h-9 w-28 bg-white text-xs" />
            <div className="w-40"><DatePicker value={tradingFrom} onChange={setTradingFrom} max={tradingTo || undefined} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={tradingTo} onChange={setTradingTo} min={tradingFrom || undefined} /></div>
          </div>
        </div>
        <div className="max-h-[calc(100vh-225px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-[#f1ecd9]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-1.5">Oil</th>
                <th className="px-2 py-1.5 text-right">Purchase Qty</th>
                <th className="px-2 py-1.5 text-right">Purchase Value</th>
                <th className="px-2 py-1.5 text-right">Sale Qty</th>
                <th className="px-2 py-1.5 text-right">Sale Value</th>
                <th className="px-2 py-1.5 text-right">Gross</th>
              </tr>
            </thead>
            <tbody>
              {tradingRows.length === 0 ? (
                <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">No purchase/sale activity for this range.</td></tr>
              ) : (
                tradingRows.map((r) => (
                  <tr key={String(r.code)} className="border-b border-dotted hover:bg-amber-100/70" style={{ borderColor: '#e5dfc8' }}>
                    <td className="px-4 py-1.5 font-medium">{r.name || r.code}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(r.purchase_qty) ? n(r.purchase_qty) : ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(r.purchase_value) ? formatINR(r.purchase_value) : ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(r.sale_qty) ? n(r.sale_qty) : ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(r.sale_value) ? formatINR(r.sale_value) : ''}</td>
                    <td className={cn('px-2 py-1.5 text-right font-medium tabular-nums', n(r.gross) < -0.005 ? 'text-rose-700' : 'text-emerald-700')}>
                      {formatINR(r.gross)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {tradingRows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 font-bold" style={{ borderColor: '#1a2c56' }}>
                  <td className="px-4 py-2">Grand total</td>
                  <td className="px-2 py-2 text-right tabular-nums">{tradingTotals.pq}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatINR(tradingTotals.pv)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{tradingTotals.sq}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatINR(tradingTotals.sv)}</td>
                  <td className={cn('px-2 py-2 text-right tabular-nums', tradingTotals.gross < -0.005 ? 'text-rose-700' : 'text-emerald-700')}>
                    {formatINR(tradingTotals.gross)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )

  return (
    <div className={cn('fixed inset-0 z-50 flex flex-col overflow-auto', T.frame)}>
      <div className="flex shrink-0 items-center gap-3 px-4 pb-1 pt-2">
        <span className="text-[13px] font-bold uppercase tracking-widest text-amber-300">Rishabh Oil — Accounting</span>
        {company && (
          <button
            type="button"
            title="Change company (F3)"
            onClick={() => { setScreen('gateway'); setCompany(null) }}
            className="cursor-pointer rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/20"
          >
            {company.name} <span className="ml-1 text-amber-300">F3</span>
          </button>
        )}
        <span className="text-[11px] text-white/60">F4 Contra · F5 Payment · F6 Receipt · F7 Journal · Ctrl+A accept · Esc back / exit</span>
        <span className="ml-auto flex items-center gap-2"><UpdateBadge /><DbStatus /></span>
      </div>
      <div className="flex-1 px-2 pb-2">
        {!company ? (
          <div className="flex h-full items-start justify-center pt-16">
            <div className={cn('w-[380px] rounded-md border shadow-lg', T.paperEdge, T.paper)}>
              <div className={cn('rounded-t-md px-4 py-2 text-center text-[13px] font-bold uppercase tracking-widest', T.headBar)}>
                Select Company
              </div>
              <div className="px-2 py-3">
                {companies.map((cm, i) => (
                  <button
                    key={String(cm.id)}
                    type="button"
                    onClick={() => setCompany(cm)}
                    onMouseEnter={() => setCoIndex(i)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded px-3 py-2.5 text-left text-[14px] transition-colors',
                      i === coIndex ? T.select : 'hover:bg-amber-100/60'
                    )}
                  >
                    <span className={cn('font-bold', T.key)}>{i + 1}</span>
                    <span className="font-medium">{cm.name}</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
                <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">
                  Every ledger, day book and trial balance you open is for this company's books only — press F3
                  anywhere to switch. Esc leaves accounting.
                </p>
              </div>
            </div>
          </div>
        ) : (
        <div className="flex min-h-full">
          <div className="flex min-w-0 flex-1 flex-col">
            {screen === 'gateway' && gateway}
            {screen === 'voucher' && voucherScreen}
            {screen === 'purchreg' && purchaseRegisterScreen}
            {screen === 'salesreg' && salesRegisterScreen}
            {screen === 'daybook' && daybookScreen}
            {screen === 'ledger' && ledgerScreen}
            {screen === 'trial' && trialScreen}
            {screen === 'trading' && tradingScreen}
          </div>
          {rightBar}
        </div>
        )}
      </div>

      {/* Tag a purchase to an LC / bill discounting facility */}
      <Dialog open={!!tagForm} onOpenChange={(o) => !o && setTagForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Tag {tagForm?.invoice_no} to an LC</DialogTitle></DialogHeader>
          {tagForm && (
            <div className="grid gap-3">
              <p className="text-xs text-muted-foreground">
                {tagForm.supplier_name} · this draws a bill under the chosen LC against this purchase, eating into its limit.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>LC *</Label>
                <Select value={tagForm.lc_id ? String(tagForm.lc_id) : ''} onValueChange={(v) => setTagForm({ ...tagForm, lc_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select the LC funding this purchase" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {lcList.filter((l) => String(l.status) !== 'closed').map((l) => (
                      <SelectItem key={String(l.id)} value={String(l.id)}>
                        {l.lc_no} · {l.bank} · {formatINR(l.available)} free
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label>Amount (₹) *</Label><Input type="number" value={tagForm.amount ?? ''} onChange={(e) => setTagForm({ ...tagForm, amount: e.target.value })} /></div>
                <div className="flex flex-col gap-1.5"><Label>Bill no</Label><Input value={tagForm.bill_no ?? ''} onChange={(e) => setTagForm({ ...tagForm, bill_no: e.target.value })} /></div>
                <div className="flex flex-col gap-1.5"><Label>Issue date</Label><DatePicker value={String(tagForm.issue_date || '')} onChange={(v) => setTagForm({ ...tagForm, issue_date: v })} /></div>
                <div className="flex flex-col gap-1.5">
                  <Label>Due date</Label>
                  <DatePicker value={String(tagForm.due_date || '')} onChange={(v) => setTagForm({ ...tagForm, due_date: v })} />
                  <span className="text-[10px] text-muted-foreground">blank = issue date + the LC's usance</span>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagForm(null)}>Cancel</Button>
            <Button onClick={() => void saveTag()}>Tag purchase</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Read-only view of an auto-posted voucher */}
      <Dialog open={!!viewRow} onOpenChange={(o) => !o && setViewRow(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IndianRupee className="h-4 w-4" /> {viewRow?.vch_type} — {viewRow?.vch_no || 'no number'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">
              Posted automatically from its source document ({formatDate(viewRow?.entry_date)}). To change it, edit the
              purchase, sale or payment it came from — the voucher follows.
            </p>
            <table className="w-full text-[13px]">
              <tbody>
                {((viewRow?.lines as Row[]) || []).map((l) => (
                  <tr key={String(l.id)} className="border-b border-dotted">
                    <td className="py-1 pr-2 font-medium">{Number(l.dr) > 0 ? 'Dr' : 'Cr'}</td>
                    <td className="py-1">{l.account}</td>
                    <td className="py-1 text-right tabular-nums">{formatINR(Number(l.dr) > 0 ? l.dr : l.cr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {viewRow?.narration && <p className="text-xs text-muted-foreground">{viewRow.narration}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewRow(null)}>Close (Esc)</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create ledger */}
      <Dialog open={!!newLedger} onOpenChange={(o) => !o && setNewLedger(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Create ledger</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5">
              <Label>Name</Label>
              <Input
                value={newLedger?.name || ''}
                onChange={(e) => setNewLedger((p) => (p ? { ...p, name: e.target.value } : p))}
                className="uppercase"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Under group</Label>
              <Select
                value={newLedger?.group || ''}
                onValueChange={(v) => setNewLedger((p) => (p ? { ...p, group: v } : p))}
              >
                <SelectTrigger><SelectValue placeholder="Pick a Tally group" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {(
                    // Creating the money-side ledger for a Payment/Receipt, or
                    // either side of a Contra, must land in a cash/bank group —
                    // anything else would fail the same check a moment later.
                    newLedger?.target === 'payAccount' || (newLedger?.forLine != null && vchType === 'CONTRA')
                      ? groupNames.filter((g) => CASH_BANK_GROUPS.includes(g.name))
                      : groupNames
                  ).map((g) => (
                    <SelectItem key={g.name} value={g.name}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewLedger(null)}>Cancel</Button>
            <Button className="bg-[#1a2c56] hover:bg-[#24407e]" onClick={() => void createLedger()}>
              <ArrowLeftRight className="h-4 w-4" /> Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

