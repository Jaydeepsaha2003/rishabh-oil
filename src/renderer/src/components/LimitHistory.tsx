import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDownRight, ArrowLeft, ArrowUpRight, Landmark, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { formatINR, formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (x: number): number => Math.round((Number(x) || 0) * 100) / 100
const todayISO = (): string => new Date().toISOString().slice(0, 10)

export interface LimitTarget {
  /** 'nbfc' for a discounting line, 'bank' for an LC line. */
  kind: 'nbfc' | 'bank'
  id: number
  name: string
  /** What the facility is sanctioned at right now, for the header. */
  current?: number
}

/**
 * WHEN THE LINE MOVED, AND BY HOW MUCH.
 *
 * A sanctioned limit used to be a single number that got typed over. This is
 * the other half of it: every move the facility has made, newest first, each
 * with its date, its direction and whatever was written down at the time — so
 * "when did they raise us to 3.5" has an answer that is not somebody's memory.
 *
 * The form at the top is the ordinary way to record an enhancement: the new
 * sanctioned figure, the date it took effect, and a line about it. It writes
 * the facility's own limit as well, so there is no second place to go and
 * update afterwards.
 *
 * On an NBFC the principal repayments appear here too, marked as what they are.
 * They move the limit exactly as a sanction does, and a timeline that showed
 * only the sanctions would be worse than no timeline at all — it would look
 * complete while leaving out half the movement.
 */
export function LimitHistory({
  target,
  onClose,
  onChanged,
  /**
   * RENDER IN PLACE INSTEAD OF OVER THE TOP.
   *
   * Both the screens this opens from are already dialogs, and a second
   * overlay on a dialog puts the table you clicked behind a scrim and half
   * behind the panel — so the row whose history you are reading is the one
   * thing you can no longer see. Inline, it takes the dialog's own body and
   * gives it back on the way out: one layer, full width, context kept.
   */
  inline = false
}: {
  target: LimitTarget
  onClose: () => void
  onChanged?: () => void
  inline?: boolean
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  // The sanctioned figure this drawer is changing, kept here rather than read
  // from the prop: after recording a move, the screen behind has not reloaded
  // yet, and a header still showing the old limit would make the next entry's
  // preview lie about its own delta.
  const [current, setCurrent] = useState<number | null>(
    target.current == null ? null : n(target.current)
  )
  const [busy, setBusy] = useState(false)
  /**
   * TWO THINGS MOVE A LINE, AND THEY ARE NOT THE SAME THING.
   *
   * A sanction is the NBFC saying what the facility is; a principal repayment
   * is them cutting it. Both belong on this screen because both are the line
   * moving — and neither belongs in the Repay dialog, where it sat beside two
   * things that actually pay a bill off and read as a third of the same kind.
   */
  const [mode, setMode] = useState<'sanction' | 'principal'>('sanction')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      setRows(await window.api.facility.limitHistory(target.kind, target.id))
    } catch {
      setRows([])
    }
  }, [target.kind, target.id])

  useEffect(() => {
    void load()
  }, [load])

  async function save(): Promise<void> {
    const amt = n(amount)
    if (!String(amount).trim()) {
      toast.error('Enter the new sanctioned limit')
      return
    }
    setBusy(true)
    try {
      const out = await window.api.facility.addLimitRevision({
        kind: target.kind,
        ref_id: target.id,
        amount: amt,
        effective_date: date,
        note: note.trim() || null
      })
      toast.success(
        out.delta > 0
          ? `Raised by ${formatINR(out.delta)} — now ${formatINR(out.to)}`
          : `Reduced by ${formatINR(Math.abs(out.delta))} — now ${formatINR(out.to)}`
      )
      setCurrent(out.to)
      setAmount('')
      setNote('')
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function repayPrincipal(): Promise<void> {
    const amt = n(amount)
    if (amt <= 0) {
      toast.error('Enter the principal being repaid')
      return
    }
    setBusy(true)
    try {
      const out = await window.api.billDiscounting.addLimitReduction({
        nbfc_id: target.id,
        amount: amt,
        reduce_date: date,
        note: note.trim() || null
      })
      toast.success(`Limit reduced to ${formatINR(out.limit_now)}`)
      setCurrent(out.limit_now)
      setAmount('')
      setNote('')
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removePrincipal(id: number): Promise<void> {
    try {
      await window.api.billDiscounting.deleteLimitReduction(id)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove(id: number): Promise<void> {
    try {
      await window.api.facility.deleteLimitRevision(id)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const sanctions = rows.filter((r) => r.kind === 'sanction')

  const body = (
      <div
        className={cn(
          'relative flex flex-col bg-white',
          inline ? 'overflow-hidden rounded-[4px] border border-[#D6E2D6]' : 'h-full w-full shadow-2xl sm:w-[min(100%,620px)]'
        )}
      >
        <div className="flex items-start gap-3 bg-[#0B3D2E] px-[22px] py-4 text-white">
          {inline ? (
            <button
              type="button"
              onClick={onClose}
              title="Back to the limits"
              className="mt-[1px] flex h-7 w-7 shrink-0 items-center justify-center rounded text-white/80 hover:bg-white/10 hover:text-white"
            >
              <ArrowLeft className="h-[18px] w-[18px]" />
            </button>
          ) : (
            <Landmark className="mt-[3px] h-[20px] w-[20px] shrink-0 text-[#8FBFA8]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              Sanctioned limit · history
            </div>
            <div className="truncate text-[17px] font-extrabold">{target.name}</div>
            {current != null && (
              <div className="mt-[2px] text-[12.5px] font-bold text-[#BFE3CB]">
                {formatINR(current)} sanctioned now
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title={inline ? 'Back to the limits' : 'Close'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className={cn(inline ? '' : 'min-h-0 flex-1 overflow-y-auto')}>
          {/* ADDING THE NEXT ONE. The commonest thing to do on this screen is
              record an enhancement that came through this morning, so it is
              the first thing on it rather than a button that opens a form. */}
          <section className="border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-[22px] py-4">
            {target.kind === 'nbfc' ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {(
                  [
                    { k: 'sanction', t: 'Record a new limit', s: 'the NBFC has resanctioned the line' },
                    { k: 'principal', t: 'Record a principal repayment', s: 'the line itself steps down' }
                  ] as const
                ).map((o) => (
                  <button
                    key={o.k}
                    type="button"
                    title={o.s}
                    onClick={() => setMode(o.k)}
                    className={cn(
                      'rounded-[4px] border px-3.5 py-2 text-[12px] font-extrabold transition-colors',
                      mode === o.k
                        ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                        : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-white/70'
                    )}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]">
                Record a new limit
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="!text-[10px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]">
                  {mode === 'principal' ? 'Principal repaid *' : 'New sanctioned limit *'}
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  value={amount}
                  placeholder="0.00"
                  onChange={(e) => setAmount(e.target.value)}
                  className="!h-[42px] !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13.5px] !font-bold !tabular-nums !text-[#0A1F17]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="!text-[10px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]">
                  Effective from *
                </Label>
                <DatePicker value={date} max={todayISO()} onChange={(v) => setDate(v)} />
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              <Label className="!text-[10px] !font-extrabold !uppercase !tracking-[.12em] !text-[#5A6B62]">
                Note
              </Label>
              <Input
                value={note}
                placeholder={
                  mode === 'principal' ? 'What the NBFC called it' : 'Sanction letter reference, or why it moved'
                }
                onChange={(e) => setNote(e.target.value)}
                className="!h-[42px] !rounded-[4px] !border-[#C3D2C6] !bg-white !text-[13px] !font-semibold"
              />
            </div>
            {!!String(amount).trim() && current != null && (
              <div
                className={cn(
                  'mt-3 rounded-[4px] border px-3.5 py-2.5 text-[12.5px] font-bold [text-wrap:pretty]',
                  mode === 'principal'
                    ? n(amount) > n(current)
                      ? 'border-[#F0D6D4] bg-[#FDF3F2] text-[#8C2F26]'
                      : 'border-[#F0DDC4] bg-[#FDF6EC] text-[#8A6A3B]'
                    : n(amount) >= n(current)
                      ? 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
                      : 'border-[#F0DDC4] bg-[#FDF6EC] text-[#8A6A3B]'
                )}
              >
                {mode === 'principal' ? (
                  n(amount) > n(current) ? (
                    `Only ${formatINR(n(current))} of this facility is left to reduce.`
                  ) : (
                    <>
                      {formatINR(n(current))} → {formatINR(round2(n(current) - n(amount)))}. This does not touch what
                      any bill owes — it is the limit that comes down, and it does not come back.
                    </>
                  )
                ) : (
                  <>
                    {formatINR(n(current))} → {formatINR(n(amount))} ·{' '}
                    {n(amount) >= n(current) ? 'up' : 'down'}{' '}
                    {formatINR(Math.abs(n(amount) - n(current)))}
                  </>
                )}
              </div>
            )}
            <Button
              onClick={() => void (mode === 'principal' ? repayPrincipal() : save())}
              disabled={busy}
              className="mt-3 !h-[42px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-5 !font-extrabold !text-white hover:!bg-[#0B6B45]"
            >
              <Plus className="h-[17px] w-[17px]" />
              {busy
                ? 'Saving…'
                : mode === 'principal'
                  ? n(amount) > 0
                    ? `Reduce the limit by ${formatINR(n(amount))}`
                    : 'Reduce the limit'
                  : 'Record it'}
            </Button>
          </section>

          <section className="px-[22px] py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]">
                Every move
              </span>
              <span className="text-[11px] font-semibold text-[#5A6B62]">
                {rows.length === 0
                  ? 'nothing recorded yet'
                  : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="rounded-[4px] border border-[#D6E2D6] bg-[#F7FAF6] px-4 py-6 text-center text-[12px] font-semibold text-[#5A6B62]">
                No change has been recorded against this facility yet. The next one you save — here,
                on the master, or on the limit screen — will show up.
              </div>
            ) : (
              <ol className="overflow-hidden rounded-[4px] border border-[#D6E2D6]">
                {rows.map((r) => {
                  const up = n(r.delta) > 0
                  const principal = r.kind === 'principal'
                  return (
                    <li
                      key={`${r.kind}-${r.id}`}
                      className="flex items-start gap-3 border-b border-b-[#EFF3EE] bg-white px-4 py-3 last:border-b-0"
                    >
                      <span
                        className={cn(
                          'mt-[2px] flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                          up ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#FDF6EC] text-[#8A6A3B]'
                        )}
                      >
                        {up ? (
                          <ArrowUpRight className="h-4 w-4" />
                        ) : (
                          <ArrowDownRight className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span
                            className={cn(
                              'text-[14px] font-extrabold tabular-nums',
                              up ? 'text-[#0B6B45]' : 'text-[#8A6A3B]'
                            )}
                          >
                            {up ? '+' : '−'}
                            {formatINR(Math.abs(n(r.delta)))}
                          </span>
                          {!principal && r.old_amount != null && (
                            <span className="text-[11.5px] font-semibold tabular-nums text-[#5A6B62]">
                              {formatINR(n(r.old_amount))} → {formatINR(n(r.new_amount))}
                            </span>
                          )}
                          {principal && (
                            <span className="rounded-[2px] border border-[#E0C9A8] bg-[#FDF6EC] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-wide text-[#8A6A3B]">
                              principal repaid
                            </span>
                          )}
                        </span>
                        <span className="mt-[3px] block text-[11.5px] font-semibold text-[#5A6B62]">
                          {formatDate(String(r.effective_date || ''))}
                          {r.note ? ` · ${String(r.note)}` : ''}
                        </span>
                      </span>
                      {/* Both kinds are undone here now: this is where they are
                          made. A sanction row is only the record of a move, so
                          striking it leaves the limit where it stands; a
                          principal repayment IS the move, so undoing it gives
                          the facility back. */}
                      <button
                        type="button"
                        title={
                          principal
                            ? 'Undo this principal repayment — the limit goes back up by it'
                            : 'Remove this entry from the history (the limit itself is not changed)'
                        }
                        onClick={() => void (principal ? removePrincipal(n(r.id)) : remove(n(r.id)))}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  )
                })}
              </ol>
            )}
            {sanctions.length > 0 && (
              <p className="mt-3 text-[11px] font-semibold leading-[1.5] text-[#5A6B62]">
                Removing an entry deletes the record of the move, not the limit it set — the facility
                stays at whatever it is sanctioned at now.
              </p>
            )}
          </section>
        </div>
      </div>
  )
  if (inline) return body
  return (
    <div className="fixed inset-0 z-[90] flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      {body}
    </div>
  )
}
