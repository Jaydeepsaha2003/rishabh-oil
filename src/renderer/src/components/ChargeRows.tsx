import { useEffect, useMemo, useRef, useState } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { BookOpen, Check, ChevronDown, Clock, Plus, Trash2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type ChargeRow = { account: string; amount: string }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

// The ledgers are read once per company and shared by every row and form —
// only the company's own (in_company), and none hidden in Masters.
const ledgerCache = new Map<number, Promise<Row[]>>()
function loadLedgers(companyId?: number): Promise<Row[]> {
  const key = Number(companyId) || 0
  let hit = ledgerCache.get(key)
  if (!hit) {
    hit = window.api.journal
      .accounts(key || undefined)
      .then((a: Row[]) =>
        Array.isArray(a) ? a.filter((x) => !Number(x.is_hidden) && (x.in_company === undefined || Number(x.in_company) === 1)) : []
      )
      .catch(() => {
        ledgerCache.delete(key)
        return []
      })
    ledgerCache.set(key, hit)
  }
  return hit
}

// The charge ledgers picked lately, on this device — offered first next time.
const RECENT_KEY = 'charge-ledgers-recent'
function recentLedgers(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.map(String).slice(0, 6) : []
  } catch {
    return []
  }
}
function rememberLedger(name: string): void {
  try {
    const next = [name, ...recentLedgers().filter((x) => x.toUpperCase() !== name.toUpperCase())].slice(0, 6)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // a private window keeps no history; the picker still works
  }
}

// What a charge is usually booked to: expenses, duties and taxes. Read off the
// group's own name and, where the server sent it, the base group it rolls up to.
const CHARGE_GROUP = /EXPENSE|DUTIES|TAX|CHARGE|INTEREST/i
const isChargeLedger = (a: Row): boolean => CHARGE_GROUP.test(String(a.base || '')) || CHARGE_GROUP.test(String(a.acc_group || ''))

// Inside a dialog the list is drawn inside it, so its focus trap lets the
// search box be typed into (see popover.tsx).
const dialogOf = (el: HTMLElement | null): HTMLElement | null => (el?.closest('[role="dialog"]') as HTMLElement) || null

/**
 * THE LEDGER FOR ONE CHARGE — a box with a chevron that opens a searchable
 * list: ledgers used lately first, then expenses and charges, then the rest,
 * each with its group and closing balance. Typed, ↑ ↓, Enter; Esc closes.
 */
export function ChargeLedgerPicker({ value, onPick, companyId }: { value: string; onPick: (name: string) => void; companyId?: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState<Row[]>([])
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let live = true
    void loadLedgers(companyId).then((a) => live && setAll(a))
    return () => {
      live = false
    }
  }, [companyId])
  const known = !value || all.some((a) => String(a.name).toUpperCase() === value.trim().toUpperCase())
  const groups = useMemo(() => {
    const byName = new Map(all.map((a) => [String(a.name).toUpperCase(), a]))
    const recent = recentLedgers()
      .map((nm) => byName.get(nm.toUpperCase()))
      .filter(Boolean) as Row[]
    const seen = new Set(recent.map((a) => String(a.name)))
    const charges = all.filter((a) => !seen.has(String(a.name)) && isChargeLedger(a))
    const rest = all.filter((a) => !seen.has(String(a.name)) && !isChargeLedger(a))
    const byNameSort = (x: Row, y: Row): number => String(x.name).localeCompare(String(y.name))
    return [
      { key: 'recent', title: 'Used lately', rows: recent },
      { key: 'charges', title: 'Expenses & charges', rows: charges.sort(byNameSort) },
      { key: 'rest', title: 'All other ledgers', rows: rest.sort(byNameSort) }
    ].filter((g) => g.rows.length)
  }, [all])
  const bal = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`)
  const pick = (name: string): void => {
    rememberLedger(name)
    onPick(name)
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className={cn(
            'flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[4px] border bg-white px-3 text-left transition-colors hover:border-[#0B6B45] focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15',
            known ? 'border-[#D6E2D6]' : 'border-[#B3261E]'
          )}
          title={known ? value || 'Pick a ledger' : `There is no ledger called ${value}`}
        >
          <BookOpen className="h-4 w-4 flex-none text-[#5A6B62]" />
          <span className={cn('min-w-0 flex-1 truncate text-[13px] font-bold', value ? 'text-[#0A1F17]' : 'font-semibold text-[#8CA396]')}>
            {value || 'Pick a ledger…'}
          </span>
          <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" container={dialogOf(trigger.current)} className="w-[min(480px,calc(100vw-32px))] p-0">
        <Command>
          <CommandInput placeholder="Search ledger or group…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[340px]">
            <CommandEmpty>
              <span className="block px-3 py-2 text-[12.5px] text-muted-foreground">
                No ledger called “{query}”. Create it in Accounting → Masters first.
              </span>
            </CommandEmpty>
            {groups.map((g) => (
              <CommandPrimitive.Group
                key={g.key}
                heading={g.title}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-extrabold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.1em] [&_[cmdk-group-heading]]:text-[#8CA396]"
              >
                {g.rows.map((a) => {
                  const b = n(a.balance)
                  const on = String(a.name).toUpperCase() === value.trim().toUpperCase()
                  return (
                    <CommandItem
                      key={`${g.key}-${String(a.id)}`}
                      value={`${String(a.name)} ${String(a.acc_group || '')}`}
                      className="items-start gap-2 py-1.5"
                      onSelect={() => pick(String(a.name))}
                    >
                      <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center">
                        {on ? <Check className="h-3.5 w-3.5 text-[#0B6B45]" /> : g.key === 'recent' ? <Clock className="h-3.5 w-3.5 text-[#8CA396]" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[13px] font-semibold text-[#0A1F17]">{String(a.name)}</span>
                        <span className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{String(a.acc_group || '')}</span>
                      </span>
                      <span className="flex-none pl-2 text-[11.5px] font-bold tabular-nums" style={{ color: Math.abs(b) < 0.005 ? '#8CA396' : b > 0 ? '#1B4E82' : '#B3261E' }}>
                        {bal(b)}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandPrimitive.Group>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * WHAT A BANK TOOK IN THE SAME DEBIT, ON LEDGERS THE USER PICKS.
 *
 * A repayment's debit is often more than the principal — commission, bank
 * charges, GST on them, stamp duty — and two fixed boxes could never say which
 * ledger each belonged on. One row per charge: a ledger (picked from the list,
 * it must already exist) and an amount, as many rows as the debit carried.
 * The same control on LC closures, LC repayments and part repayments.
 */
export function ChargeRows({
  value,
  onChange,
  inputClassName = '',
  companyId
}: {
  value: ChargeRow[]
  onChange: (next: ChargeRow[]) => void
  inputClassName?: string
  /** The company whose ledgers are offered — the open one when left out. */
  companyId?: number
}): React.JSX.Element {
  const set = (i: number, patch: Partial<ChargeRow>): void => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const box = `h-10 rounded-[4px] border border-[#D6E2D6] bg-white px-3 text-[13px] font-bold outline-none focus:border-[#0B6B45] ${inputClassName}`
  return (
    <div className="grid gap-2">
      {value.map((ch, i) => (
        <div key={i} className="flex items-center gap-2">
          <ChargeLedgerPicker value={ch.account} companyId={companyId} onPick={(name) => set(i, { account: name })} />
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={ch.amount}
            onChange={(e) => set(i, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
            className={`${box} w-[140px] text-right tabular-nums`}
          />
          <button
            type="button"
            title="Remove this charge"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="flex h-10 w-9 flex-none items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, { account: '', amount: '' }])}
        className="flex h-8 items-center gap-1.5 self-start rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#0B3D2E] hover:bg-[#F4FBF6]"
      >
        <Plus className="h-4 w-4" /> Add a ledger
      </button>
    </div>
  )
}

/** The rows' total. */
export function chargeRowsTotal(rows: ChargeRow[] | undefined): number {
  return round2((rows || []).reduce((t, x) => t + n(x.amount), 0))
}

/** The first row that has a ledger without an amount, or an amount without a ledger — and what to say about it. */
export function chargeRowsProblem(rows: ChargeRow[] | undefined): string | null {
  const bad = (rows || []).find((c) => (c.account.trim() || n(c.amount)) && !(c.account.trim() && n(c.amount) > 0))
  if (!bad) return null
  return bad.account.trim() ? `Enter the amount charged to ${bad.account}` : 'Pick the ledger for each charge'
}

/** The rows as the server takes them. */
export function chargeRowsPayload(rows: ChargeRow[] | undefined): { account: string; amount: number }[] {
  return (rows || []).filter((c) => c.account.trim() && round2(n(c.amount)) > 0).map((c) => ({ account: c.account.trim(), amount: round2(n(c.amount)) }))
}

/** A saved repayment's charges as rows — its own rows, then the old fixed commission and bank fields. */
export function chargeRowsFrom(rep: Row | null | undefined): ChargeRow[] {
  if (!rep) return []
  const out: ChargeRow[] = []
  let list: Row[] = []
  try {
    list = Array.isArray(rep.charges) ? rep.charges : JSON.parse(String(rep.charges || '[]'))
  } catch {
    list = []
  }
  for (const c of list) if (String(c?.account || '').trim() && n(c?.amount) > 0) out.push({ account: String(c.account), amount: String(round2(n(c.amount))) })
  if (n(rep.comm_charges) > 0.004) out.push({ account: 'COMM. CHARGES A/C', amount: String(round2(n(rep.comm_charges))) })
  if (n(rep.bank_charges) > 0.004) out.push({ account: 'BANK CHARGES A/C', amount: String(round2(n(rep.bank_charges))) })
  return out
}
