import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeftRight,
  BookOpenText,
  Check,
  ChevronRight,
  IndianRupee,
  Landmark,
  Plus,
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
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

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

type Screen = 'gateway' | 'voucher' | 'daybook' | 'ledger' | 'trial'
type VchType = 'CONTRA' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL'

const VCH_TYPES: { key: VchType; fkey: string; label: string }[] = [
  { key: 'CONTRA', fkey: 'F4', label: 'Contra' },
  { key: 'PAYMENT', fkey: 'F5', label: 'Payment' },
  { key: 'RECEIPT', fkey: 'F6', label: 'Receipt' },
  { key: 'JOURNAL', fkey: 'F7', label: 'Journal' }
]

interface VLine {
  side: 'dr' | 'cr'
  account: string
  group: string
  amount: string
}

// Tally-format payment/receipt entry: one money account, party lines with
// bill-wise adjustments (Agst Ref / Advance / On Account / New Ref).
interface AllocRow {
  method: 'agst_ref' | 'advance' | 'on_account' | 'new_ref'
  ref_name: string
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

const blankLines = (t: VchType): VLine[] =>
  t === 'RECEIPT'
    ? [
        { side: 'cr', account: '', group: '', amount: '' },
        { side: 'dr', account: '', group: '', amount: '' }
      ]
    : [
        { side: 'dr', account: '', group: '', amount: '' },
        { side: 'cr', account: '', group: '', amount: '' }
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

export function Accounts(): React.JSX.Element {
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
  // Tally-format payment/receipt entry state.
  const [payAccount, setPayAccount] = useState<{ account: string; group: string }>({ account: '', group: '' })
  const [payLines, setPayLines] = useState<PayLine[]>([blankPayLine()])
  const [rawAlter, setRawAlter] = useState(false)
  const [refsCache, setRefsCache] = useState<Record<string, Row[]>>({})

  // Day book.
  const monthStart = `${todayISO().slice(0, 7)}-01`
  const [dbFrom, setDbFrom] = useState(monthStart)
  const [dbTo, setDbTo] = useState(todayISO())
  const [dbType, setDbType] = useState('ALL')
  const [dayRows, setDayRows] = useState<Row[]>([])
  const [viewRow, setViewRow] = useState<Row | null>(null)

  // Ledger screen.
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [ledgerLines, setLedgerLines] = useState<Row[]>([])
  const [ledgerSearch, setLedgerSearch] = useState('')

  // Trial balance.
  const [tbFrom, setTbFrom] = useState('')
  const [tbTo, setTbTo] = useState(todayISO())
  const [tb, setTb] = useState<Row | null>(null)

  // New-ledger dialog (from the picker or the ledger list).
  const [newLedger, setNewLedger] = useState<{ name: string; group: string; forLine: number | null; target?: 'payLine' | 'payAccount'; index?: number } | null>(null)

  const loadAccounts = useCallback(async () => {
    setAccounts(await window.api.journal.accounts())
  }, [])
  useEffect(() => {
    loadAccounts()
    window.api.journal.groupNames().then(setGroupNames).catch(() => {})
  }, [loadAccounts])
  useLiveRefresh(loadAccounts)

  const loadDaybook = useCallback(async () => {
    if (screen !== 'daybook') return
    setDayRows(
      await window.api.vouchers.list({
        from: dbFrom || undefined,
        to: dbTo || undefined,
        vchType: dbType === 'ALL' ? undefined : dbType
      })
    )
  }, [screen, dbFrom, dbTo, dbType])
  useEffect(() => {
    loadDaybook()
  }, [loadDaybook])
  useLiveRefresh(loadDaybook)

  const loadLedger = useCallback(async () => {
    if (screen !== 'ledger' || !ledgerId) return
    setLedgerLines(await window.api.journal.statement(ledgerId))
  }, [screen, ledgerId])
  useEffect(() => {
    loadLedger()
  }, [loadLedger])
  useLiveRefresh(loadLedger)

  const loadTb = useCallback(async () => {
    if (screen !== 'trial') return
    setTb(await window.api.journal.trialBalance({ from: tbFrom || undefined, to: tbTo || undefined }))
  }, [screen, tbFrom, tbTo])
  useEffect(() => {
    loadTb()
  }, [loadTb])
  useLiveRefresh(loadTb)

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
    // Default the money side to the first bank ledger, like Tally remembers one.
    const bank = accounts.find((a) => String(a.name) === 'BANK A/C') || cashBankAccounts[0]
    setPayAccount(bank ? { account: String(bank.name), group: String(bank.acc_group) } : { account: '', group: '' })
    setScreen('voucher')
  }

  function setLine(i: number, patch: Partial<VLine>): void {
    setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  const structured = (vchType === 'PAYMENT' || vchType === 'RECEIPT') && !rawAlter
  const cashBankAccounts = accounts.filter((a) => CASH_BANK_GROUPS.includes(String(a.acc_group)))
  const payTotal = payLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)

  async function loadRefs(name: string): Promise<void> {
    if (!name || refsCache[name]) return
    try {
      const r = await window.api.journal.pendingRefs(name)
      setRefsCache((p) => ({ ...p, [name]: r }))
    } catch {
      /* refs are a convenience — entry still works without them */
    }
  }

  function setPayLine(i: number, patch: Partial<PayLine>): void {
    setPayLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  function setAlloc(i: number, j: number, patch: Partial<AllocRow>): void {
    setPayLines((p) =>
      p.map((l, x) => (x === i ? { ...l, allocs: l.allocs.map((a, y) => (y === j ? { ...a, ...patch } : a)) } : l))
    )
  }

  function allocRemaining(l: PayLine, skip = -1): number {
    const used = l.allocs.reduce((s, a, j) => (j === skip ? s : s + (Number(a.amount) || 0)), 0)
    return Math.round(((Number(l.amount) || 0) - used) * 100) / 100
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

  async function saveVoucher(): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      const structuredLines = (): Row[] => {
        const party = payLines.filter((l) => l.account && Number(l.amount) > 0)
        if (!party.length) throw new Error('Add at least one party line')
        if (!payAccount.account) throw new Error(`Pick the cash or bank account the money ${vchType === 'PAYMENT' ? 'goes out of' : 'comes into'}`)
        const total = party.reduce((s, l) => s + Number(l.amount), 0)
        return [
          ...party.map((l) => ({
            account: l.account,
            group: l.group || undefined,
            dr: vchType === 'PAYMENT' ? Number(l.amount) : 0,
            cr: vchType === 'RECEIPT' ? Number(l.amount) : 0,
            allocs: l.allocs
              .filter((a) => Number(a.amount) > 0)
              .map((a) => ({ method: a.method, ref_name: a.ref_name || null, amount: Number(a.amount) }))
          })),
          {
            account: payAccount.account,
            group: payAccount.group || undefined,
            dr: vchType === 'RECEIPT' ? total : 0,
            cr: vchType === 'PAYMENT' ? total : 0
          }
        ]
      }
      const payload = {
        date: vchDate,
        vchType,
        vchNo: vchNo || null,
        narration: narration || null,
        lines: structured
          ? structuredLines()
          : lines
              .filter((l) => l.account && Number(l.amount) > 0)
              .map((l) => ({
                account: l.account,
                group: l.group || undefined,
                dr: l.side === 'dr' ? Number(l.amount) : 0,
                cr: l.side === 'cr' ? Number(l.amount) : 0
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
        amount: String(Number(l.dr) > 0 ? l.dr : l.cr)
      }))
    )
    // Payment/receipt vouchers with exactly one money-side line reopen in the
    // Tally format, bill-wise details included; anything else falls back to
    // the plain Dr/Cr grid.
    if (t === 'PAYMENT' || t === 'RECEIPT') {
      const moneySide = t === 'PAYMENT' ? 'cr' : 'dr'
      const money = vLines.filter((l) => Number(moneySide === 'cr' ? l.cr : l.dr) > 0 && CASH_BANK_GROUPS.includes(String(l.acc_group)))
      const parties = vLines.filter((l) => Number(moneySide === 'cr' ? l.dr : l.cr) > 0)
      if (money.length === 1 && parties.length >= 1) {
        setPayAccount({ account: String(money[0].account), group: String(money[0].acc_group || '') })
        setPayLines(
          parties.map((l) => ({
            account: String(l.account),
            group: String(l.acc_group || ''),
            amount: String(Number(moneySide === 'cr' ? l.dr : l.cr)),
            allocs: ((l.allocs as Row[]) || []).map((a) => ({
              method: String(a.method) as AllocRow['method'],
              ref_name: String(a.ref_name || ''),
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
      if (newLedger.target === 'payAccount') setPayAccount({ account: name, group: newLedger.group })
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
      { key: 'D', label: 'Day Book', icon: BookOpenText, go: () => setScreen('daybook') },
      { key: 'L', label: 'Ledger Accounts', icon: Wallet, go: () => setScreen('ledger') },
      { key: 'T', label: 'Trial Balance', icon: Scale, go: () => setScreen('trial') }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      // Function keys work everywhere on this page; letters only outside inputs.
      if (e.key === 'F4' || e.key === 'F5' || e.key === 'F6' || e.key === 'F7') {
        e.preventDefault()
        const t = VCH_TYPES.find((v) => v.fkey === e.key)!.key
        if (screen === 'voucher') switchType(t)
        else openVoucher(t)
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
  }, [screen, gwIndex, viewRow, newLedger, editingId, lines, payLines, payAccount, rawAlter, vchDate, vchNo, narration, vchType, saving])

  // ------- derived -------
  const ledgerAccount = accounts.find((a) => Number(a.id) === ledgerId)
  const ledgerRunning = useMemo((): Row[] => {
    let bal = 0
    return ledgerLines.map((l): Row => {
      bal += (Number(l.dr) || 0) - (Number(l.cr) || 0)
      return { ...l, running: bal }
    })
  }, [ledgerLines])

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
      <FKey k="D" label="Day Book" active={screen === 'daybook'} onClick={() => setScreen('daybook')} />
      <FKey k="L" label="Ledgers" active={screen === 'ledger'} onClick={() => setScreen('ledger')} />
      <FKey k="T" label="Trial Balance" active={screen === 'trial'} onClick={() => setScreen('trial')} />
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
          Use the highlighted letter or the function keys — F4 Contra, F5 Payment, F6 Receipt, F7 Journal. Purchase
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
          <div className="grid gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Date (F2)</Label>
            <div ref={dateRef} className="w-36">
              <DatePicker value={vchDate} onChange={setVchDate} />
            </div>
          </div>
          <div className="grid gap-1">
            <Label className="text-[10px] uppercase tracking-wide">Voucher no (optional)</Label>
            <Input className="h-9 w-36 bg-white" value={vchNo} onChange={(e) => setVchNo(e.target.value)} />
          </div>
          <div className="ml-auto text-right text-[11px] text-muted-foreground">
            {vchType === 'CONTRA' && 'Cash ↔ bank only, both sides'}
            {vchType === 'PAYMENT' && 'Credit side must be cash / bank'}
            {vchType === 'RECEIPT' && 'Debit side must be cash / bank'}
            {vchType === 'JOURNAL' && 'Any ledgers, Dr = Cr'}
          </div>
        </div>

        {structured && (
          <div className="px-4 py-3">
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <div className="grid w-80 gap-1">
                <Label className="text-[10px] uppercase tracking-wide">
                  Account — {vchType === 'PAYMENT' ? 'paid out of' : 'received into'}
                </Label>
                <AccountPicker
                  value={payAccount.account}
                  accounts={cashBankAccounts}
                  onPick={(name, group) => setPayAccount({ account: name, group })}
                  onCreate={(q) => setNewLedger({ name: q, group: 'Bank Accounts', forLine: null, target: 'payAccount' })}
                />
              </div>
              <span className="pb-2 text-[11px] text-muted-foreground">cash and bank ledgers only</span>
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
                const allocated = l.allocs.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
                const lineAmt = Number(l.amount) || 0
                const matched = Math.abs(allocated - lineAmt) < 0.005
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
                      <div className="ml-3 mt-1.5 rounded border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-2">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-800">
                            Bill-wise details — method of adjustment
                          </span>
                          <span className={cn('text-[10px] font-semibold tabular-nums', matched ? 'text-emerald-700' : 'text-amber-700')}>
                            {l.allocs.length === 0
                              ? 'none — treated as plain balance'
                              : `${formatINR(allocated)} of ${formatINR(lineAmt)} allocated`}
                          </span>
                        </div>
                        {l.allocs.map((a, j) => (
                          <div key={j} className="mb-1 grid grid-cols-[120px_1fr_120px_24px] items-center gap-1.5">
                            <Select value={a.method} onValueChange={(v) => setAlloc(i, j, { method: v as AllocRow['method'], ref_name: '' })}>
                              <SelectTrigger className="h-7 bg-white text-[12px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {METHODS.map((m) => <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            {a.method === 'agst_ref' ? (
                              <Select
                                value={a.ref_name}
                                onValueChange={(v) => {
                                  const bill = refs.find((r) => String(r.ref) === v)
                                  const rest = allocRemaining(l, j)
                                  setAlloc(i, j, {
                                    ref_name: v,
                                    amount: a.amount || String(Math.min(Number(bill?.pending) || rest, rest))
                                  })
                                }}
                              >
                                <SelectTrigger className="h-7 bg-white text-[12px]">
                                  <SelectValue placeholder={refs.length ? 'Pick a pending bill' : 'No pending bills found'} />
                                </SelectTrigger>
                                <SelectContent className="max-h-64">
                                  {refs.map((r) => (
                                    <SelectItem key={String(r.ref)} value={String(r.ref)}>
                                      {String(r.ref)} — {formatINR(r.pending)} pending
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : a.method === 'on_account' ? (
                              <span className="px-1 text-[11px] italic text-muted-foreground">no reference — unallocated</span>
                            ) : (
                              <Input
                                className="h-7 bg-white text-[12px]"
                                placeholder={a.method === 'advance' ? 'Advance reference (e.g. ADV-1)' : 'New reference name'}
                                value={a.ref_name}
                                onChange={(e) => setAlloc(i, j, { ref_name: e.target.value })}
                              />
                            )}
                            <Input
                              type="number"
                              className="h-7 bg-white text-right text-[12px] tabular-nums"
                              value={a.amount}
                              onChange={(e) => setAlloc(i, j, { amount: e.target.value })}
                            />
                            <button
                              type="button"
                              className="cursor-pointer text-muted-foreground hover:text-red-600"
                              onClick={() => setPayLine(i, { allocs: l.allocs.filter((_, y) => y !== j) })}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px] text-amber-800 hover:bg-amber-100"
                          onClick={() =>
                            setPayLine(i, {
                              allocs: [
                                ...l.allocs,
                                {
                                  method: refs.length ? 'agst_ref' : 'on_account',
                                  ref_name: '',
                                  amount: String(Math.max(0, allocRemaining(l)))
                                }
                              ]
                            })
                          }
                        >
                          <Plus className="h-3 w-3" /> Add adjustment
                        </Button>
                      </div>
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
                  {payAccount.account ? ` — ${vchType === 'PAYMENT' ? 'Cr' : 'Dr'} ${payAccount.account}` : ''}
                </span>
                <span className="tabular-nums">{formatINR(payTotal)}</span>
              </div>
            </div>
          </div>
        )}

        {!structured && (
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
              <tr key={i} className="border-b border-dotted" style={{ borderColor: '#e5dfc8' }}>
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
                    accounts={accounts}
                    autoFocus={i === 0}
                    onPick={(name, group) => setLine(i, { account: name, group })}
                    onCreate={(q) => setNewLedger({ name: q, group: '', forLine: i })}
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
            ))}
            <tr>
              <td colSpan={5} className="px-4 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setLines((p) => [...p, { side: 'cr', account: '', group: '', amount: '' }])}
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
                  <span className="text-[12px] text-red-600">
                    Difference {formatINR(Math.abs(totals.diff))} {totals.diff > 0 ? '(Cr short)' : '(Dr short)'}
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
          <div className="grid flex-1 gap-1">
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

  const daybookScreen = (
    <div className="flex-1 p-3">
      <div className={cn('rounded-md border shadow-lg', T.paperEdge, T.paper)}>
        <div className={cn('flex flex-wrap items-center gap-3 rounded-t-md px-4 py-2', T.headBar)}>
          <span className="text-[13px] font-bold uppercase tracking-widest">Day Book</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="w-40"><DatePicker value={dbFrom} onChange={setDbFrom} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={dbTo} onChange={setDbTo} /></div>
            <Select value={dbType} onValueChange={setDbType}>
              <SelectTrigger className="h-9 w-36 bg-white text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All vouchers</SelectItem>
                {VCH_TYPES.map((v) => <SelectItem key={v.key} value={v.key}>{v.label}</SelectItem>)}
                <SelectItem value="PURCHASE OIL">Purchase</SelectItem>
                <SelectItem value="SALE">Sales</SelectItem>
              </SelectContent>
            </Select>
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
            <div className={cn('flex items-center justify-between rounded-t-md px-4 py-2', T.headBar)}>
              <span className="text-[13px] font-bold uppercase tracking-widest">{ledgerAccount.name}</span>
              <span className="text-[11px]">{ledgerAccount.acc_group}</span>
            </div>
            <div className="max-h-[calc(100vh-225px)] overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-[#f1ecd9]">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                    <th className="px-4 py-1.5">Date</th>
                    <th className="px-2 py-1.5">Particulars</th>
                    <th className="px-2 py-1.5">Vch</th>
                    <th className="px-2 py-1.5 text-right">Debit</th>
                    <th className="px-2 py-1.5 text-right">Credit</th>
                    <th className="px-2 py-1.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRunning.map((l) => (
                    <tr key={String(l.id)} className="border-b border-dotted" style={{ borderColor: '#e5dfc8' }}>
                      <td className="whitespace-nowrap px-4 py-1.5 tabular-nums">{formatDate(l.entry_date)}</td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{l.particulars || l.vch_type}</div>
                        {l.narration && <div className="text-[11px] text-muted-foreground">{l.narration}</div>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">{l.voucher_code}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.dr) ? formatINR(l.dr) : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.cr) ? formatINR(l.cr) : ''}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                        {formatINR(Math.abs(l.running))} {l.running >= 0 ? 'Dr' : 'Cr'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-bold" style={{ borderColor: '#1a2c56' }}>
                    <td className="px-4 py-2" colSpan={3}>Closing balance</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatINR(ledgerRunning.reduce((s, l) => s + (Number(l.dr) || 0), 0))}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatINR(ledgerRunning.reduce((s, l) => s + (Number(l.cr) || 0), 0))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                      {(() => {
                        const c = ledgerRunning.length ? ledgerRunning[ledgerRunning.length - 1].running : 0
                        return `${formatINR(Math.abs(c))} ${c >= 0 ? 'Dr' : 'Cr'}`
                      })()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
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
            <div className="w-40"><DatePicker value={tbFrom} onChange={setTbFrom} /></div>
            <span className="text-[11px]">to</span>
            <div className="w-40"><DatePicker value={tbTo} onChange={setTbTo} /></div>
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

  return (
    <>
      <PageHeader
        title="Accounting"
        subtitle="Tally-style vouchers, day book, ledgers and trial balance"
        hint="Keyboard first, like Tally: F4 Contra, F5 Payment, F6 Receipt, F7 Journal, F2 date, Ctrl+A accept, Esc back. Purchase and sale vouchers post automatically from their pages; here you record the money and adjustment entries and read the books."
      />
      <div className="px-4 pb-4">
        <div className={cn('flex min-h-[calc(100vh-170px)] rounded-xl', T.frame)}>
          <div className="flex min-w-0 flex-1 flex-col">
            {screen === 'gateway' && gateway}
            {screen === 'voucher' && voucherScreen}
            {screen === 'daybook' && daybookScreen}
            {screen === 'ledger' && ledgerScreen}
            {screen === 'trial' && trialScreen}
          </div>
          {rightBar}
        </div>
      </div>

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
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input
                value={newLedger?.name || ''}
                onChange={(e) => setNewLedger((p) => (p ? { ...p, name: e.target.value } : p))}
                className="uppercase"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Under group</Label>
              <Select
                value={newLedger?.group || ''}
                onValueChange={(v) => setNewLedger((p) => (p ? { ...p, group: v } : p))}
              >
                <SelectTrigger><SelectValue placeholder="Pick a Tally group" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {groupNames.map((g) => (
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
    </>
  )
}

