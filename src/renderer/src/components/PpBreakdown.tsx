// What a PP figure is made of.
// -----------------------------------------------------------------------------
// The opening sheet takes PP — the oil already in process on the morning the
// books start — as one number. The plant has never counted it as one number:
// it counts the vessels and adds them up.
//
//     BLEACHER          6.000
//     Deo Feed Tms      2.500
//     Deo Scr          32.000
//     Post Bleacher     3.500
//     ----------------------
//     Total            53.000  MT PP
//
// Redesigned to the Stock handoff, and one thing changed with it. The first
// version listed EVERY stage the site knows against every product, so a
// thirty-product sheet meant thirty dialogs of mostly-blank rows, and a cross
// had to reach across products to decide whether a stage could go. Now a
// product's breakdown holds only the vessels that product is actually sitting
// in: you add the ones it is in, and the cross takes a line off THIS product
// and touches nothing else. Which gives the rule that was asked for by
// construction — a stage keeps its quantity wherever one stands against it,
// because nothing but this product's own list is ever edited here.
//
// The names still belong to the site: whatever anybody has typed is offered as
// a suggestion, so the same vessel is not spelled three ways.
//
// EDITED AS A DRAFT, saved in one go. The dialog was writing on every keypress
// before, which meant Cancel could not put anything back.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layers, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type PpFfa = 'with' | 'without' | null
export type PpLine = { stage_id?: number; stage?: string; name?: string; qty: number; ffa: PpFfa }
type Draft = { stage: string; stage_id: number; qty: string; ffa: boolean }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

// The plant writes 2:50 for two and a half tonnes — a colon where the rest of
// the app writes a point. Accepted as typed rather than rejected, because the
// figure is being copied off a sheet that spells it that way.
export function parsePpQty(v: string): string {
  return String(v ?? '')
    .replace(/[^0-9.:]/g, '')
    .replace(/:/g, '.')
    .replace(/(\..*)\./g, '$1')
}

export function ppTotals(draft: Draft[]): { total: number; withFfa: number; without: number } {
  let total = 0
  let withFfa = 0
  for (const l of draft) {
    const q = n(l.qty)
    if (!q) continue
    total += q
    if (l.ffa) withFfa += q
  }
  return { total: r3(total), withFfa: r3(withFfa), without: r3(total - withFfa) }
}

const draftFrom = (lines: PpLine[]): Draft[] =>
  lines.map((l) => ({
    stage: String(l.stage ?? l.name ?? ''),
    stage_id: n(l.stage_id),
    qty: l.qty == null || l.qty === 0 ? '' : String(l.qty),
    // A line stored before the toggle became two-state reads as W/O FFA — the
    // side it would have been counted on anyway.
    ffa: l.ffa === 'with'
  }))

export function PpBreakdown({
  product,
  open,
  onOpenChange,
  onSaved
}: {
  product: Row | null
  open: boolean
  onOpenChange: (v: boolean) => void
  // Handed the new total and lines so the sheet can update that one row
  // without reloading — it holds an unsaved draft of every other row.
  onSaved: (productId: number, total: number, lines: PpLine[]) => void
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<Draft[]>([])
  const [known, setKnown] = useState<string[]>([])
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)

  const lines: PpLine[] = useMemo(
    () => (Array.isArray(product?.pp_lines) ? (product?.pp_lines as PpLine[]) : []),
    [product]
  )
  const pid = n(product?.id)
  const uom = String(product?.uom || 'MT')

  const loadKnown = useCallback(async (): Promise<void> => {
    try {
      const st = await window.api.stockOpening.ppStages()
      setKnown(st.filter((x) => x.active !== false).map((x) => String(x.name)))
    } catch {
      // The suggestions are a convenience. A dialog that will not open because
      // the dictionary could not be read is worse than one with no dictionary.
      setKnown([])
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setDraft(draftFrom(lines))
    setAdding('')
    void loadKnown()
  }, [open, lines, loadKnown])

  const sums = ppTotals(draft)
  const before = r3(lines.reduce((a, l) => a + n(l.qty), 0))
  const shifted = Math.abs(sums.total - before) > 0.0005
  const wanted = adding.trim()
  const dupe = !!wanted && draft.some((l) => l.stage.toLowerCase() === wanted.toLowerCase())

  // Suggestions the site already knows and this product is not already in.
  const suggestions = known.filter(
    (k) => !draft.some((l) => l.stage.toLowerCase() === k.toLowerCase())
  )

  function addStage(): void {
    if (!wanted || dupe) return
    setDraft((d) => [...d, { stage: wanted, stage_id: 0, qty: '', ffa: false }])
    setAdding('')
  }

  async function save(): Promise<void> {
    setBusy(true)
    try {
      const res = await window.api.stockOpening.savePp(
        pid,
        draft
          .filter((l) => l.stage.trim())
          .map((l) => ({
            stage: l.stage.trim(),
            stage_id: l.stage_id || undefined,
            qty: l.qty,
            ffa: l.ffa ? 'with' : 'without'
          }))
      )
      onSaved(
        pid,
        res.total,
        draft
          .filter((l) => l.stage.trim() && Math.abs(n(l.qty)) > 0.0005)
          .map((l) => ({ stage: l.stage.trim(), name: l.stage.trim(), qty: r3(n(l.qty)), ffa: l.ffa ? 'with' : 'without' }))
      )
      toast.success(
        res.lines
          ? `PP for ${String(product?.name || '')} is ${formatNum(res.total)} ${uom} across ${res.lines} vessel${res.lines === 1 ? '' : 's'}`
          : `Breakdown cleared — PP for ${String(product?.name || '')} is back to a figure typed on the sheet`
      )
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const req = dupe
    ? `${wanted} is already on this breakdown.`
    : draft.length === 0
      ? 'Saving with no stages puts PP back to blank.'
      : `${draft.length} stage${draft.length === 1 ? '' : 's'} adding up to ${formatNum(sums.total)} ${uom}.`
  const reqFg = dupe ? '#B3261E' : draft.length === 0 ? '#8A5300' : '#0B6B45'

  const GRID = 'minmax(140px,1fr) 108px 148px 34px'

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-5"
      style={{ background: 'rgba(10,31,23,.5)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div
        className="flex max-h-full w-[min(100%,600px)] flex-col overflow-hidden rounded-lg bg-white"
        style={{ boxShadow: '0 24px 60px rgba(10,31,23,.34)' }}
      >
        <div className="flex flex-none items-start justify-between gap-3.5 px-[22px] pt-5">
          <div className="min-w-0">
            <div className="text-[18px] font-extrabold tracking-[-0.02em] text-[#0A1F17]">
              PP breakdown — {String(product?.name || '')}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] hover:bg-[#F1F5EF]"
          >
            <X className="h-[21px] w-[21px] text-[#5A6B62]" />
          </button>
        </div>

        <div className="flex-none px-[22px] pt-2.5 text-[12.5px] font-medium leading-[1.6] text-[#5A6B62]">
          What the in-process figure is made of, vessel by vessel. The stage names belong to the site, so anything
          added here is offered against every product on the sheet. PP for this product becomes the total below.
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4">
          <div className="overflow-hidden rounded-md border border-[#E4ECE3]">
            <div
              className="grid h-[34px] items-center border-b border-b-[#E4ECE3] bg-[#F7FAF6] text-[9.5px] font-extrabold uppercase tracking-[.11em] text-[#5A6B62]"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="px-3.5">Stage</span>
              <span className="px-2 text-right">Qty {uom}</span>
              <span className="px-2 text-center">FFA</span>
              <span />
            </div>

            {draft.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-[26px]">
                <Layers className="h-[26px] w-[26px] text-[#C3D2C6]" />
                <span className="text-[12.5px] font-bold text-[#5A6B62]">No stages yet</span>
                <span className="max-w-[340px] text-center text-[12px] font-medium leading-[1.5] text-[#5A6B62]">
                  Add the vessels this product is sitting in. With no stages, PP stays a figure typed straight onto
                  the sheet.
                </span>
              </div>
            ) : (
              draft.map((l, i) => (
                <div
                  key={`${l.stage}-${i}`}
                  className="grid min-h-[45px] items-center border-b border-b-[#EFF3EE] last:border-b-0"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className="truncate px-3.5 text-[13px] font-bold text-[#0A1F17]" title={l.stage}>
                    {l.stage}
                  </span>
                  <div className="px-2">
                    <input
                      inputMode="decimal"
                      placeholder="0"
                      aria-label={`${l.stage} quantity`}
                      className="doc-ref h-[34px] w-full rounded-[4px] border border-[#DCE7DB] bg-white px-[9px] text-right text-[13px] font-semibold tabular-nums text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6] focus:border-[#5B4BA8]"
                      value={l.qty}
                      onChange={(e) => {
                        const v = parsePpQty(e.target.value)
                        setDraft((d) => d.map((x, k) => (k === i ? { ...x, qty: v } : x)))
                      }}
                    />
                  </div>
                  {/* Two states, one of them always on. "Not stated" was a
                      third state nobody chose on purpose — every line is
                      either carrying its free fatty acid or it is not, and the
                      counter knows which. */}
                  <div className="flex justify-center gap-[5px] px-2">
                    {(
                      [
                        { on: l.ffa, label: 'With FFA', bg: '#FFF9E0', bd: '#E8D9A0', fg: '#8A5300', v: true },
                        { on: !l.ffa, label: 'W/O FFA', bg: '#E9F5EE', bd: '#BFE3CB', fg: '#0B6B45', v: false }
                      ] as const
                    ).map((b) => (
                      <button
                        key={b.label}
                        type="button"
                        onClick={() => setDraft((d) => d.map((x, k) => (k === i ? { ...x, ffa: b.v } : x)))}
                        className="flex h-8 min-w-[64px] items-center justify-center rounded-[4px] border text-[11px] font-extrabold transition-colors"
                        style={
                          b.on
                            ? { background: b.bg, borderColor: b.bd, color: b.fg }
                            : { background: '#fff', borderColor: '#DCE7DB', color: '#5A6B62' }
                        }
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-center pr-2">
                    <button
                      type="button"
                      title={`Take ${l.stage} off this product's breakdown`}
                      onClick={() => setDraft((d) => d.filter((_, k) => k !== i))}
                      className="flex h-7 w-7 items-center justify-center rounded-[3px] text-[#8CA396] hover:bg-[#FDF3F2] hover:text-[#B3261E]"
                    >
                      <X className="h-[19px] w-[19px]" />
                    </button>
                  </div>
                </div>
              ))
            )}

            <div className="flex items-center gap-2.5 bg-white px-3.5 py-3">
              <input
                list="pp-stage-names"
                placeholder="Add a vessel — e.g. Post Bleacher"
                aria-label="Add a stage"
                maxLength={60}
                className="h-[42px] min-w-0 flex-1 rounded-md border border-[#DCE7DB] bg-white px-3 text-[13px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#C3D2C6] focus:border-[#5B4BA8]"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addStage()
                  }
                }}
              />
              {/* Whatever the site has been calling its vessels, so the same
                  tank is not spelled three ways across thirty products. */}
              <datalist id="pp-stage-names">
                {suggestions.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={addStage}
                disabled={!wanted || dupe}
                className="flex h-[42px] flex-none items-center gap-[7px] rounded-md border bg-white px-[15px] text-[12.5px] font-extrabold disabled:cursor-not-allowed"
                style={{
                  borderColor: wanted && !dupe ? '#5B4BA8' : '#DCE7DB',
                  color: wanted && !dupe ? '#3D3179' : '#8CA396'
                }}
              >
                <Plus className="h-[18px] w-[18px]" />
                Add stage
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3.5 rounded-md border border-[#E4ECE3] bg-[#F7FAF6] p-[15px]">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[.13em] text-[#3D3179]">Total PP</div>
              <div className="mt-1.5 text-[12px] font-semibold text-[#5A6B62]">
                With FFA <span className="doc-ref tabular-nums">{formatNum(sums.withFfa)}</span>
                &nbsp;&nbsp; W/O FFA <span className="doc-ref tabular-nums">{formatNum(sums.without)}</span>
              </div>
            </div>
            <div className="ml-auto flex flex-none items-baseline gap-1.5">
              <span className="doc-ref text-[26px] font-bold tracking-[-0.03em] text-[#0A1F17] tabular-nums">
                {formatNum(sums.total)}
              </span>
              <span className="text-[11.5px] font-bold text-[#5A6B62]">{uom}</span>
            </div>
          </div>

          {/* What saving will actually move. The figure on the sheet is the
              opening this product contributes, so a breakdown that changes it
              changes the register — worth saying before the button is pressed
              rather than after. */}
          {shifted && (
            <div className="mt-3 flex items-start gap-[9px] rounded-[4px] border border-[#D6CEF5] border-l-4 border-l-[#5B4BA8] bg-[#EDE9FB] px-[13px] py-[11px]">
              <Layers className="mt-px h-[17px] w-[17px] flex-none text-[#5B4BA8]" />
              <span className="text-[12px] font-semibold leading-[1.5] text-[#3D3179]">
                {draft.length === 0
                  ? 'Removing the last stage clears PP back to blank — a figure nobody has stated, which is not the same as nil.'
                  : `PP for ${String(product?.name || '')} moves from ${formatNum(before)} to ${formatNum(sums.total)} ${uom}, so the opening this product contributes changes with it.`}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-none flex-wrap items-center gap-3 border-t border-t-[#E4ECE3] bg-white px-[22px] py-4">
          <span className="min-w-0 flex-1 text-[12px] font-semibold" style={{ color: reqFg }}>
            {req}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-[42px] flex-none rounded-[4px] border border-[#C3D2C6] bg-white px-[18px] text-[12.5px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            // A duplicate sitting UNSENT in the add box blocks the Add button
            // and nothing else. The breakdown itself is valid, and refusing to
            // save it because of text nobody has added yet is the dialog
            // arguing with the reader about something it has not accepted.
            disabled={busy || !pid}
            className={cn(
              'h-[42px] flex-none rounded-[4px] px-[18px] text-[12.5px] font-extrabold',
              busy ? 'bg-[#C3D2C6] text-[#F1F5EF]' : 'bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0A3327]'
            )}
          >
            {busy ? 'Saving…' : 'Save breakdown'}
          </button>
        </div>
      </div>
    </div>
  )
}
