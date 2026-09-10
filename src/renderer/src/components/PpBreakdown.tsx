// What a PP figure is made of.
// -----------------------------------------------------------------------------
// The opening sheet takes PP — the oil already in process on the morning the
// books start — as one number. The plant has never counted it as one number:
// it counts the vessels and adds them up.
//
//     BLEACHER          6.000
//     Deo Feed Tms      2.500
//     Deo Scr          32.000
//     OO Tms            3.000
//     Filter Press      3.000
//     PLF               3.000
//     Post Bleacher     3.500
//     ----------------------
//     Total            53.000  MT PP
//
// This is that sheet. Three things about it are deliberate:
//
//   THE STAGE LIST BELONGS TO THE SITE. A refinery has one set of vessels, so a
//   stage added while counting one oil is offered against every other oil on
//   the sheet. Adding one therefore writes to the database immediately — it is
//   not part of this product's draft.
//
//   WITH FFA / WITHOUT FFA IS PER LINE, not per vessel. The same tank can hold
//   oil that still carries its free fatty acid on one product and stripped oil
//   on another, and the classification is the counter's statement about what
//   was in it that morning. Left unset it stays unset: "counted, not yet
//   classified" is a real answer and the total says so rather than quietly
//   picking a side.
//
//   THE CROSS SAVES FIRST. Crossing a stage off keeps it wherever a quantity
//   stands against it and drops it everywhere it is blank — so if the figure
//   typed on THIS row has not been saved yet, the cross would be judging a
//   blank that is not really blank. It saves the breakdown, then removes.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type PpFfa = 'with' | 'without' | null
export type PpLine = { stage_id: number; name: string; qty: number; ffa: PpFfa; active?: boolean }
type Draft = Record<number, { qty: string; ffa: PpFfa }>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The plant writes 2:50 for two and a half tonnes — a colon where the rest of
// the app writes a point. Accepted as typed rather than rejected, because the
// figure is being copied off a sheet that spells it that way.
export function parsePpQty(v: string): string {
  return String(v ?? '')
    .replace(/[^0-9.:]/g, '')
    .replace(/:/g, '.')
    .replace(/(\..*)\./g, '$1')
}

// The rows to show for one product: every stage the site currently offers,
// plus any retired stage this product still carries a quantity against — the
// latter is what "kept where it is used" looks like on screen.
export function ppRowsFor(stages: Row[], lines: PpLine[]): { id: number; name: string; retired: boolean }[] {
  const used = new Map<number, PpLine>()
  for (const l of lines) used.set(n(l.stage_id), l)
  const out: { id: number; name: string; retired: boolean }[] = []
  const seen = new Set<number>()
  for (const s of stages) {
    const id = n(s.id)
    const active = s.active !== false
    if (!active && !used.has(id)) continue
    seen.add(id)
    out.push({ id, name: String(s.name), retired: !active })
  }
  // A line whose stage is not in the list at all — a stage deleted outright
  // while this tab was open. Shown rather than silently dropped, so the
  // quantity is never lost without the reader seeing it.
  for (const [id, l] of used) {
    if (!seen.has(id)) out.push({ id, name: String(l.name || `Stage ${id}`), retired: true })
  }
  return out
}

export function ppTotal(draft: Draft): { total: number; withFfa: number; without: number; unset: number } {
  let total = 0
  let withFfa = 0
  let without = 0
  let unset = 0
  for (const k of Object.keys(draft)) {
    const d = draft[Number(k)]
    const q = n(d?.qty)
    if (!q) continue
    total += q
    if (d.ffa === 'with') withFfa += q
    else if (d.ffa === 'without') without += q
    else unset += q
  }
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  return { total: r3(total), withFfa: r3(withFfa), without: r3(without), unset: r3(unset) }
}

export function PpBreakdown({
  product,
  open,
  onOpenChange,
  onSaved
}: {
  // The product being counted: { id, name, uom?, pp_lines }
  product: Row | null
  open: boolean
  onOpenChange: (v: boolean) => void
  // Handed the new total and lines so the sheet can update that one row
  // without reloading — the sheet holds a draft of forty other rows and a
  // reload would throw them away.
  onSaved: (productId: number, total: number, lines: PpLine[]) => void
}): React.JSX.Element {
  const [stages, setStages] = useState<Row[]>([])
  const [draft, setDraft] = useState<Draft>({})
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  const lines: PpLine[] = useMemo(
    () => (Array.isArray(product?.pp_lines) ? (product?.pp_lines as PpLine[]) : []),
    [product]
  )
  const pid = n(product?.id)
  const uom = String(product?.uom || 'MT')

  const loadStages = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setStages(await window.api.stockOpening.ppStages())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Opened fresh each time: the stage list may have grown since this tab last
  // looked, and the draft must start from what is actually saved.
  useEffect(() => {
    if (!open) return
    const next: Draft = {}
    for (const l of lines) next[n(l.stage_id)] = { qty: String(l.qty ?? ''), ffa: l.ffa ?? null }
    setDraft(next)
    setAdding('')
    void loadStages()
  }, [open, lines, loadStages])

  const shown = useMemo(() => ppRowsFor(stages, lines), [stages, lines])
  const sums = ppTotal(draft)

  const payload = (): Row[] =>
    shown.map((s) => ({ stage_id: s.id, qty: draft[s.id]?.qty ?? '', ffa: draft[s.id]?.ffa ?? null }))

  function setQty(id: number, v: string): void {
    setDraft((p) => ({ ...p, [id]: { qty: parsePpQty(v), ffa: p[id]?.ffa ?? null } }))
  }
  function setFfa(id: number, v: PpFfa): void {
    setDraft((p) => ({ ...p, [id]: { qty: p[id]?.qty ?? '', ffa: p[id]?.ffa === v ? null : v } }))
  }

  async function addStage(): Promise<void> {
    const name = adding.trim()
    if (!name) return
    setBusy(true)
    try {
      const st = await window.api.stockOpening.addPpStage(name)
      setAdding('')
      await loadStages()
      toast.success(
        st.revived
          ? `${st.name} is back on the list — it was crossed off but still in use`
          : `${st.name} added, and offered against every product on the sheet`
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeStage(id: number, name: string): Promise<void> {
    setBusy(true)
    try {
      // Saved first, so the cross judges this row on what is actually typed
      // rather than on a blank that only looks blank.
      const saved = await window.api.stockOpening.savePp(pid, payload())
      const res = await window.api.stockOpening.removePpStage(id)
      onSaved(pid, saved.total, linesFromDraft(shown, draft).filter((l) => l.stage_id !== id || res.kept > 0))
      await loadStages()
      setDraft((p) => {
        const next = { ...p }
        if (!res.kept) delete next[id]
        return next
      })
      toast.success(
        res.kept > 0
          ? `${name} kept on ${res.kept} product${res.kept === 1 ? '' : 's'} that has a quantity against it, and dropped everywhere it was blank`
          : `${name} removed — nothing had a quantity against it`
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.api.stockOpening.savePp(pid, payload())
      onSaved(pid, res.total, linesFromDraft(shown, draft))
      toast.success(
        res.lines
          ? `PP for ${String(product?.name || '')} is ${formatNum(res.total)} ${uom} across ${res.lines} stage${res.lines === 1 ? '' : 's'}`
          : `Breakdown cleared — PP for ${String(product?.name || '')} is back to a single figure`
      )
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ffaBtn = (on: boolean, tone: 'with' | 'without'): string =>
    cn(
      'h-7 shrink-0 rounded-[3px] border px-2 text-[10.5px] font-bold transition-colors',
      on
        ? tone === 'with'
          ? 'border-amber-300 bg-amber-100 text-amber-900'
          : 'border-emerald-300 bg-emerald-100 text-emerald-900'
        : 'border-input bg-white text-muted-foreground hover:bg-muted'
    )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>PP breakdown — {String(product?.name || '')}</DialogTitle>
        </DialogHeader>

        <p className="text-[11.5px] leading-[1.5] text-muted-foreground">
          What the in-process figure is made of, vessel by vessel. The stage list belongs to the site, so
          anything added here is offered against every product on the sheet. PP for this product becomes the
          total below.
        </p>

        <div className="rounded-[4px] border">
          <div className="grid grid-cols-[1fr_92px_128px_28px] items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[.08em] text-muted-foreground">
            <span>Stage</span>
            <span className="text-right">Qty {uom}</span>
            <span className="text-center">FFA</span>
            <span />
          </div>
          {loading && shown.length === 0 && (
            <p className="px-2.5 py-4 text-center text-[11.5px] text-muted-foreground">Reading the stage list…</p>
          )}
          {!loading && shown.length === 0 && (
            <p className="px-2.5 py-4 text-center text-[11.5px] text-muted-foreground">
              No stages yet. Add the first one below — BLEACHER, Deo Scr, Filter Press, whatever this refinery
              calls its vessels.
            </p>
          )}
          {shown.map((s) => {
            const d = draft[s.id] || { qty: '', ffa: null }
            return (
              <div
                key={s.id}
                className="grid grid-cols-[1fr_92px_128px_28px] items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0"
              >
                <span className="min-w-0 truncate text-[12px] font-semibold">
                  {s.name}
                  {s.retired && (
                    <span
                      className="ml-1.5 rounded-[2px] bg-muted px-1 py-px text-[9px] font-extrabold uppercase tracking-[.06em] text-muted-foreground"
                      title="Crossed off the site's list, kept here because this product has a quantity against it"
                    >
                      off list
                    </span>
                  )}
                </span>
                <input
                  inputMode="decimal"
                  placeholder="0"
                  className="doc-ref h-8 w-full rounded-md border bg-white px-2 text-right text-[12.5px] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
                  value={d.qty}
                  onChange={(e) => setQty(s.id, e.target.value)}
                />
                <div className="flex items-center justify-center gap-1">
                  <button type="button" className={ffaBtn(d.ffa === 'with', 'with')} onClick={() => setFfa(s.id, 'with')}>
                    With FFA
                  </button>
                  <button
                    type="button"
                    className={ffaBtn(d.ffa === 'without', 'without')}
                    onClick={() => setFfa(s.id, 'without')}
                  >
                    W/O FFA
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  title={`Cross ${s.name} off the site's list — kept wherever a quantity stands against it`}
                  className="flex h-6 w-6 items-center justify-center rounded-[3px] text-muted-foreground hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40"
                  onClick={() => void removeStage(s.id, s.name)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <input
            placeholder="Add a stage — e.g. Post Bleacher"
            className="h-9 min-w-0 flex-1 rounded-md border bg-white px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/50 focus:border-[#1a2c56] focus:ring-1 focus:ring-[#1a2c56]/20"
            value={adding}
            maxLength={60}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void addStage()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={busy || !adding.trim()} onClick={() => void addStage()}>
            <Plus className="h-4 w-4" /> Add stage
          </Button>
        </div>

        <div className="rounded-[4px] border bg-muted/30 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] font-extrabold uppercase tracking-[.08em] text-muted-foreground">
              Total PP
            </span>
            <span className="doc-ref text-[18px] font-bold tabular-nums">
              {formatNum(sums.total)} <span className="text-[11px] font-semibold text-muted-foreground">{uom}</span>
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-semibold text-muted-foreground">
            <span>
              With FFA <span className="doc-ref tabular-nums">{formatNum(sums.withFfa)}</span>
            </span>
            <span>
              W/O FFA <span className="doc-ref tabular-nums">{formatNum(sums.without)}</span>
            </span>
            {sums.unset > 0 && (
              <span className="text-amber-700">
                not stated <span className="doc-ref tabular-nums">{formatNum(sums.unset)}</span>
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy || !pid}>
            {busy ? 'Saving…' : 'Save breakdown'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The lines as the sheet should now see them — used to patch the one row that
// changed rather than reloading forty.
function linesFromDraft(
  shown: { id: number; name: string }[],
  draft: Draft
): PpLine[] {
  return shown
    .map((s) => ({
      stage_id: s.id,
      name: s.name,
      qty: Math.round(n(draft[s.id]?.qty) * 1000) / 1000,
      ffa: draft[s.id]?.ffa ?? null
    }))
    .filter((l) => Math.abs(l.qty) > 0.0005)
}
