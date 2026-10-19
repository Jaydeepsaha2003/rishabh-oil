import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// WHAT KIND OF CHARGE A BILL'S ADJ. IS.
//
// The Adj. on a discounted bill is what the NBFC takes off (or adds to) its
// payout, and what it IS decides the ledger it posts to — processing fees and
// stamp duty are not "BD charges". So beside the figure sits the type: a short
// list of the usual ones (billDiscounting.ts BD_ADJ_PRESETS), plus any the desk
// adds here, shared by every user. The stored value is the LEDGER; a bill saved
// before the choice existed has none and reads as BD charges.
//
// SEVERAL KINDS AT ONCE. One Adj. can be processing fees AND stamp duty. Tick
// more than one and each gets its share of the Adj., which posts to its own
// ledger (open_adj_split); the shares must add up to the whole Adj.

export type ChargeType = { label: string; ledger: string; preset: boolean }
export type AdjPart = { ledger: string; amount: number | string }

export const ADJ_DEFAULT_LEDGER = 'BD CHARGES A/C'

/** The name to show for a bill's charge type. */
export function adjLabel(ledger: unknown, types: ChargeType[] = []): string {
  const led = String(ledger || '').trim().toUpperCase() || ADJ_DEFAULT_LEDGER
  const hit = types.find((t) => t.ledger === led)
  if (hit) return hit.label
  if (led === ADJ_DEFAULT_LEDGER) return 'BD charges'
  const bare = led.replace(/\s*A\/C$/, '').toLowerCase()
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/** The ledger a bill's Adj. posts to. */
export const adjLedger = (ledger: unknown): string => String(ledger || '').trim().toUpperCase() || ADJ_DEFAULT_LEDGER

/**
 * A bill's Adj. split, read from the form or the stored row. [] for one kind.
 *
 * SIGNED like the Adj.: minus is taken off the payout, plus is extra received.
 * Given the Adj., a split saved unsigned (every part a share of a deduction)
 * reads with the Adj.'s sign, as it always meant.
 */
export function adjParts(split: unknown, adj?: number): { ledger: string; amount: number }[] {
  let raw: unknown = split
  if (typeof raw === 'string') {
    try {
      raw = raw.trim() ? JSON.parse(raw) : []
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  const list = (raw as AdjPart[])
    .map((p) => ({ ledger: String(p?.ledger || '').trim().toUpperCase(), amount: Number(p?.amount) || 0 }))
    .filter((p) => p.ledger)
  const legacy = (Number(adj) || 0) < 0 && !list.some((p) => p.amount < 0)
  return legacy ? list.map((p) => ({ ...p, amount: -Math.abs(p.amount) })) : list
}

const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatINR(Math.abs(v))}`

/** How the Adj.'s kind reads in a summary: "Processing fees + Stamp duty". */
export function adjKindsLabel(ledger: unknown, split: unknown, types: ChargeType[] = []): string {
  const parts = adjParts(split)
  return parts.length > 1 ? parts.map((p) => adjLabel(p.ledger, types)).join(' + ') : adjLabel(ledger, types)
}

/** Where the Adj. posts, in words: "PROCESSING FEES A/C" or "−₹6,363.83 to …, +₹100 to …". */
export function adjPostsTo(ledger: unknown, split: unknown, adj?: number): string {
  const parts = adjParts(split, adj)
  return parts.length > 1 ? parts.map((p) => `${signed(p.amount)} to ${p.ledger}`).join(', ') : adjLedger(ledger)
}

/** The split is consistent with the Adj. (always true for one kind). */
export function adjSplitOk(adj: number, split: unknown): boolean {
  const parts = adjParts(split, adj)
  if (parts.length < 2) return true
  const sum = parts.reduce((t, p) => t + p.amount, 0)
  return Math.abs(Math.round(sum * 100) / 100 - Math.round(adj * 100) / 100) <= 0.01
}

export function AdjChargePicker({
  value,
  onChange,
  types,
  onTypesChange,
  className,
  adj = 0,
  split,
  onSplitChange,
  onAdjChange
}: {
  value: string
  onChange: (ledger: string) => void
  types: ChargeType[]
  onTypesChange: (types: ChargeType[]) => void
  className?: string
  /** The Adj. figure the parts divide. */
  adj?: number
  /** The parts when more than one kind is ticked. */
  split?: AdjPart[] | null
  onSplitChange?: (split: AdjPart[] | null) => void
  /**
   * When given, the Adj. FOLLOWS its parts: typing a part's amount makes the
   * Adj. their total (same sign), so an extra ₹100 on one kind is ₹100 more
   * Adj. rather than "₹100 too much".
   */
  onAdjChange?: (adj: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  // Inside the bill's dialog, the panel has to render inside it too, or the
  // dialog takes focus back and the new name cannot be typed (see popover.tsx).
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const multi = !!onSplitChange
  // Signed throughout: minus taken off the payout, plus extra received.
  const whole = Math.round((Number(adj) || 0) * 100) / 100
  const rawParts: AdjPart[] = Array.isArray(split) && split.length > 1 ? split : []
  // An unsigned (older) split reads with the Adj.'s sign; what is being typed
  // is kept as typed.
  const legacy = whole < 0 && rawParts.length > 0 && !rawParts.some((p) => (Number(p.amount) || 0) < 0 || String(p.amount).trim().startsWith('-'))
  const parts: AdjPart[] = legacy ? rawParts.map((p) => ({ ...p, amount: -Math.abs(Number(p.amount) || 0) })) : rawParts
  // What is ticked: the split's kinds, or the one kind.
  const ticked: string[] = parts.length ? parts.map((p) => String(p.ledger).toUpperCase()) : [adjLedger(value)]
  const sum = parts.reduce((t, p) => t + (Number(p.amount) || 0), 0)
  const left = Math.round((whole - sum) * 100) / 100

  // Ticking a second kind starts a split: the first keeps the whole Adj. and
  // the new one starts at nothing, so the figures still add up until changed.
  function toggleKind(ledger: string): void {
    if (!multi) {
      onChange(ledger)
      setOpen(false)
      return
    }
    const on = ticked.includes(ledger)
    if (on) {
      if (ticked.length === 1) return
      const rest = (parts.length ? parts : ticked.map((l) => ({ ledger: l, amount: 0 }))).filter((p) => String(p.ledger).toUpperCase() !== ledger)
      if (rest.length === 1) {
        onChange(String(rest[0].ledger))
        onSplitChange?.(null)
      } else {
        onChange(String(rest[0].ledger))
        onSplitChange?.(rest)
      }
      return
    }
    const base: AdjPart[] = parts.length ? parts : [{ ledger: ticked[0], amount: whole }]
    onChange(String(base[0].ledger))
    onSplitChange?.([...base, { ledger, amount: 0 }])
  }

  // A part is typed as a plain figure, and its LESS / MORE switch says which
  // way it moves the payout: less = taken off (−), more = extra received (+).
  // The Adj. is then the net of the parts.
  const signOf = (p: AdjPart): 1 | -1 => ((Number(p.amount) || 0) > 0 || String(p.amount).trim().startsWith('+') ? 1 : -1)
  function setMagnitude(ledger: string, typed: string, sign: 1 | -1): void {
    const v = typed.replace(/^[+-]/, '')
    setPart(ledger, v === '' ? (sign > 0 ? '+' : '-') : sign > 0 ? `+${v}` : `-${v}`)
  }
  function setPart(ledger: string, amount: string): void {
    const next = parts.map((p) => (String(p.ledger).toUpperCase() === ledger ? { ...p, amount } : p))
    onSplitChange?.(next)
    if (onAdjChange) onAdjChange(Math.round(next.reduce((t, p) => t + (Number(p.amount) || 0), 0) * 100) / 100)
  }

  async function add(): Promise<void> {
    const name = adding.trim()
    if (!name) return
    setBusy(true)
    try {
      const t = await window.api.billDiscounting.addChargeType(name)
      const list = types.some((x) => x.ledger === t.ledger) ? types : [...types, t]
      onTypesChange(list)
      if (multi && (parts.length || adjLedger(value) !== t.ledger)) toggleKind(t.ledger)
      else onChange(t.ledger)
      setAdding('')
      if (!multi) setOpen(false)
      toast.success(`${t.label} added — posts to ${t.ledger}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const label = parts.length
    ? `${adjLabel(parts[0].ledger, types)} + ${parts.length - 1}`
    : adjLabel(adjLedger(value), types)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setContainer((trigger.current?.closest('[role="dialog"]') as HTMLElement | null) ?? null)
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          title={parts.length ? `Split across ${parts.length} kinds of charge — click to change` : `Posts to ${adjLedger(value)} — click to choose the kind of charge`}
          className={cn(
            'ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] bg-[#EAF0FA] py-[3px] pl-[7px] pr-[5px] text-[10.5px] font-bold text-[#1B4E82] hover:bg-[#DCE7F6]',
            parts.length && !adjSplitOk(whole, parts) && '!bg-[#FFF4DD] !text-[#8A5300]',
            className
          )}
        >
          {label}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        container={container}
        align="end"
        className="!w-[340px] !rounded-[6px] !border-[#C3D2C6] !p-1 !shadow-[0_14px_32px_rgba(7,43,32,.2)]"
      >
        <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5">
          <span className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Kind of charge</span>
          {multi && <span className="ml-auto text-[10px] font-semibold text-[#8CA396]">tick more than one to split</span>}
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {types.map((t) => {
            const on = ticked.includes(t.ledger)
            const part = parts.find((p) => String(p.ledger).toUpperCase() === t.ledger)
            return (
              <div key={t.ledger} className={cn('flex items-center gap-2 rounded-[4px] px-2.5 py-1.5 hover:bg-[#F4F9EF]', on && 'bg-[#F3FBE2]')}>
                <button type="button" onClick={() => toggleKind(t.ledger)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                  {multi ? (
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[3px] border',
                        on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white'
                      )}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                  ) : (
                    <Check className={cn('mt-0.5 h-3.5 w-3.5 flex-none text-[#0B3D2E]', !on && 'invisible')} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[12px] text-[#0A1F17]', on ? 'font-extrabold' : 'font-semibold')}>{t.label}</span>
                    <span className="block truncate text-[10px] font-semibold text-[#8CA396]">→ {t.ledger}</span>
                  </span>
                  {!t.preset && <span className="mt-0.5 flex-none rounded-[2px] bg-[#EEF3EC] px-1 text-[9px] font-bold text-[#5A6B62]">ADDED</span>}
                </button>
                {part && (
                  <span className="flex flex-none flex-col items-end">
                    <span className="flex items-center gap-1">
                      {/* Less (taken off the payout) or More (sent extra). */}
                      <span className="flex overflow-hidden rounded-[4px] border border-[#C3D2C6] text-[10px] font-extrabold">
                        {([-1, 1] as const).map((sg) => (
                          <button
                            key={sg}
                            type="button"
                            onClick={() => setMagnitude(t.ledger, String(Math.abs(Number(part.amount) || 0) || ''), sg)}
                            title={sg < 0 ? 'Taken off the payout — a charge (Dr)' : 'Sent over and above — extra received (Cr)'}
                            className={cn(
                              'h-7 px-1.5',
                              signOf(part) === sg ? (sg < 0 ? 'bg-[#8C2F26] text-white' : 'bg-[#0B6B45] text-white') : 'bg-white text-[#5A6B62]'
                            )}
                          >
                            {sg < 0 ? 'Less' : 'More'}
                          </button>
                        ))}
                      </span>
                      <input
                        data-raw=""
                        type="number"
                        step="any"
                        min={0}
                        value={String(Math.abs(Number(part.amount) || 0) || '')}
                        onChange={(e) => setMagnitude(t.ledger, e.target.value, signOf(part))}
                        placeholder="0"
                        title={`How much of the Adj. is ${t.label}`}
                        className={cn(
                          'doc-ref h-7 w-[92px] rounded-[4px] border border-[#C3D2C6] bg-white px-2 text-right text-[12px] font-bold outline-none focus:border-[#0B3D2E]',
                          signOf(part) < 0 ? 'text-[#8C2F26]' : 'text-[#0B6B45]'
                        )}
                      />
                    </span>
                  </span>
                )}
              </div>
            )
          })}
        </div>
        {parts.length > 1 && (
          <div
            className="mx-1 mt-1 flex flex-wrap items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[11px] font-bold"
            style={Math.abs(left) <= 0.01 ? { background: '#E9F5EE', color: '#0B6B45' } : { background: '#FFF4DD', color: '#8A5300' }}
          >
            <span className="doc-ref">
              net {signed(Math.round(sum * 100) / 100)} · Adj. {signed(whole)}
            </span>
            <span>{Math.abs(left) <= 0.01 ? '· adds up' : `· ${signed(left)} still to assign`}</span>
            {Math.abs(left) > 0.01 && (
              <button
                type="button"
                className="ml-auto rounded-[3px] border border-current px-1.5 py-px text-[10px]"
                title="Put what is left on the last kind ticked"
                onClick={() => {
                  const last = parts[parts.length - 1]
                  const others = parts.slice(0, -1).reduce((t, p) => t + (Number(p.amount) || 0), 0)
                  setPart(String(last.ledger).toUpperCase(), String(Math.round((whole - others) * 100) / 100))
                }}
              >
                Balance the last
              </button>
            )}
          </div>
        )}
        <div className="mt-1 border-t border-t-[#EAF0E9] p-1.5 pt-2">
          <div className="mb-1 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">Add a new kind</div>
          <div className="flex gap-1.5">
            <input
              data-raw=""
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void add()
                }
              }}
              placeholder="e.g. Platform fee"
              className="h-8 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] px-2 text-[12px] font-semibold outline-none focus:border-[#0B3D2E]"
            />
            <button
              type="button"
              disabled={busy || !adding.trim()}
              onClick={() => void add()}
              className="flex h-8 flex-none items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[11.5px] font-extrabold text-white disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
          {!!adding.trim() && (
            <div className="mt-1 truncate text-[10px] font-semibold text-[#8CA396]">
              → {/\bA\/C$/i.test(adding.trim()) ? adding.trim().toUpperCase() : `${adding.trim().toUpperCase()} A/C`}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
