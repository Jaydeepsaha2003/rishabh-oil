import { useEffect, useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type ChargeRow = { account: string; amount: string }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * WHAT A BANK TOOK IN THE SAME DEBIT, ON LEDGERS THE USER PICKS.
 *
 * A repayment's debit is often more than the principal — commission, bank
 * charges, GST on them, stamp duty — and two fixed boxes could never say which
 * ledger each belonged on. One row per charge: a ledger (type to search, it
 * must already exist) and an amount, as many rows as the debit carried. The
 * same control on LC closures, LC repayments and part repayments.
 */
export function ChargeRows({
  value,
  onChange,
  inputClassName = ''
}: {
  value: ChargeRow[]
  onChange: (next: ChargeRow[]) => void
  inputClassName?: string
}): React.JSX.Element {
  const listId = useId()
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void window.api.journal
      .accounts()
      .then((a: Row[]) => live && setNames(a.filter((x) => !x.is_hidden).map((x) => String(x.name))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const set = (i: number, patch: Partial<ChargeRow>): void => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const box = `h-10 rounded-[4px] border border-[#D6E2D6] bg-white px-3 text-[13px] font-bold outline-none focus:border-[#0B6B45] ${inputClassName}`
  return (
    <div className="grid gap-2">
      <datalist id={listId}>
        {names.map((nm) => (
          <option key={nm} value={nm} />
        ))}
      </datalist>
      {value.map((ch, i) => (
        <div key={i} className="flex items-center gap-2">
          <input list={listId} placeholder="Ledger — type to search" value={ch.account} onChange={(e) => set(i, { account: e.target.value })} className={`${box} min-w-0 flex-1`} />
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
