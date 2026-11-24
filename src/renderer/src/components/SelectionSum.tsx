import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { formatINR, formatNum } from '@/lib/format'

/**
 * SELECT CELLS, SEE THE TOTAL — the way Excel's status bar does.
 *
 * Any cell marked `data-sum="<number>" data-sum-col="<column key>"` (and
 * optionally `data-sum-label`, `data-sum-kind="qty" | "money"`) can be picked:
 * drag down a column, Ctrl-click cells one by one, or Shift-click to take a
 * run. A bar at the foot of the screen shows how many, the sum, the average,
 * the smallest and the largest. Esc or a plain click elsewhere clears it.
 * A plain single click on a cell still does what it did (opens the row).
 */
export function SelectionSum(): React.JSX.Element | null {
  const [sel, setSel] = useState<HTMLElement[]>([])
  const live = useRef<HTMLElement[]>([])
  const drag = useRef<{ anchor: HTMLElement; col: string; moved: boolean } | null>(null)
  const eatClick = useRef(false)

  useEffect(() => {
    const cellOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? (t.closest('[data-sum-col]') as HTMLElement | null) : null)
    const colCells = (col: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-sum-col="${CSS.escape(col)}"]`))
    const apply = (next: HTMLElement[]): void => {
      for (const el of live.current) if (!next.includes(el)) el.removeAttribute('data-sum-on')
      for (const el of next) el.setAttribute('data-sum-on', '')
      live.current = next
      setSel(next)
    }
    const range = (a: HTMLElement, b: HTMLElement, col: string): HTMLElement[] => {
      const all = colCells(col)
      const i = all.indexOf(a)
      const j = all.indexOf(b)
      if (i < 0 || j < 0) return [b]
      return all.slice(Math.min(i, j), Math.max(i, j) + 1)
    }
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      if (e.target instanceof Element && e.target.closest('[data-sum-bar]')) return
      const cell = cellOf(e.target)
      if (!cell) {
        if (live.current.length) apply([])
        return
      }
      const col = String(cell.dataset.sumCol)
      const same = live.current.length > 0 && live.current[0].dataset.sumCol === col
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        eatClick.current = true
        const base = same ? live.current : []
        apply(base.includes(cell) ? base.filter((x) => x !== cell) : [...base, cell])
        drag.current = { anchor: cell, col, moved: false }
        return
      }
      if (e.shiftKey && same) {
        e.preventDefault()
        eatClick.current = true
        apply(range(live.current[0], cell, col))
        return
      }
      drag.current = { anchor: cell, col, moved: false }
    }
    const onOver = (e: MouseEvent): void => {
      const d = drag.current
      if (!d || !(e.buttons & 1)) return
      const cell = cellOf(e.target)
      if (!cell || cell.dataset.sumCol !== d.col) return
      if (!d.moved && cell === d.anchor) return
      d.moved = true
      document.body.style.userSelect = 'none'
      window.getSelection()?.removeAllRanges()
      apply(range(d.anchor, cell, d.col))
    }
    const onUp = (): void => {
      const d = drag.current
      drag.current = null
      document.body.style.userSelect = ''
      if (d?.moved) eatClick.current = true
      else if (d && !eatClick.current && live.current.length) apply([])
    }
    // The click that ends a drag (or a Ctrl/Shift pick) must not open the row.
    const onClick = (e: MouseEvent): void => {
      if (!eatClick.current) return
      eatClick.current = false
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && live.current.length) {
        e.preventDefault()
        e.stopPropagation()
        apply([])
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  // Cells that left the page (a filter, a new screen) leave the selection.
  useEffect(() => {
    if (!sel.length) return
    const t = window.setInterval(() => {
      const kept = live.current.filter((el) => el.isConnected)
      if (kept.length !== live.current.length) {
        live.current = kept
        setSel(kept)
      }
    }, 600)
    return () => window.clearInterval(t)
  }, [sel.length])

  if (!sel.length) return <style>{CSS_RULE}</style>
  const vals = sel.map((el) => Number(el.dataset.sum) || 0)
  const sum = vals.reduce((t, v) => t + v, 0)
  const qty = sel[0].dataset.sumKind === 'qty'
  const fmt = (v: number): string => (qty ? formatNum(Math.round(v * 1000) / 1000) : formatINR(Math.round(v * 100) / 100))
  const label = sel[0].dataset.sumLabel || ''
  return (
    <>
      <style>{CSS_RULE}</style>
      <div
        data-sum-bar=""
        className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-4 rounded-[6px] border border-[#12553F] bg-[#0B3D2E] px-4 py-2 text-[12px] font-semibold text-[#DCEFE4] shadow-[0_10px_30px_rgba(10,31,23,.35)]"
      >
        {label && <span className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#C7F03F]">{label}</span>}
        <span>
          {sel.length} selected
        </span>
        <span>
          Sum <b className="text-[14px] tabular-nums text-white">{fmt(sum)}</b>
        </span>
        {sel.length > 1 && (
          <>
            <span>
              Avg <b className="tabular-nums text-white">{fmt(sum / sel.length)}</b>
            </span>
            <span>
              Min <b className="tabular-nums text-white">{fmt(Math.min(...vals))}</b>
            </span>
            <span>
              Max <b className="tabular-nums text-white">{fmt(Math.max(...vals))}</b>
            </span>
          </>
        )}
        <button
          type="button"
          title="Clear the selection (Esc)"
          onClick={() => {
            for (const el of sel) el.removeAttribute('data-sum-on')
            live.current = []
            setSel([])
          }}
          className="rounded p-0.5 text-[#DCEFE4] hover:bg-white/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}

const CSS_RULE = `[data-sum-col]{cursor:cell}[data-sum-on]{background:#DCEBFF !important;box-shadow:inset 0 0 0 1.5px #1B4E82;border-radius:2px}`
