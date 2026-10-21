import { useCallback, useState } from 'react'
import { ColumnFilter } from '@/components/ui/column-filter'

// EXCEL-STYLE FILTERS ON EVERY COLUMN OF A TABLE, WITHOUT A HOOK PER TABLE.
//
// The Accounting screens draw their tables inside render-time blocks that run
// only when that screen is showing, so a hook per table is not possible. One
// hook holds every table's selections, keyed by a table id; `colFilter` is a
// plain function that can be called anywhere in render — it filters the rows
// and hands back the funnel for each header.
//
// The selections live in a module-level store as well as in state, so opening
// an invoice from a register and pressing Esc back finds the same columns
// still narrowed (the register remounts on the way back).
//
// Totals stay honest by construction: callers sum `rows` from the result, the
// rows actually on screen, never the list before the funnels.

type Sel = Record<string, string[]>
export type ColFilterStore = {
  state: Record<string, Sel>
  set: (table: string, key: string, values: string[]) => void
  clear: (table: string) => void
}

const memo: Record<string, Sel> = {}

export function useColFilterStore(): ColFilterStore {
  const [state, setState] = useState<Record<string, Sel>>(() => ({ ...memo }))
  const set = useCallback((table: string, key: string, values: string[]) => {
    setState((prev) => {
      const next = { ...prev, [table]: { ...(prev[table] || {}), [key]: values } }
      memo[table] = next[table]
      return next
    })
  }, [])
  const clear = useCallback((table: string) => {
    setState((prev) => {
      const next = { ...prev, [table]: {} }
      memo[table] = {}
      return next
    })
  }, [])
  return { state, set, clear }
}

export type ColDef<T> = {
  key: string
  /** The value(s) this row shows in the column, as text. Several for a cell that lists several (parties). */
  get: (r: T) => unknown
  /** Order of the options: text A→Z (default), numbers / dates low→high, or as the rows run. */
  sort?: 'text' | 'num' | 'none'
}

const BLANK = '(blank)'
function valuesOf<T>(c: ColDef<T>, r: T): string[] {
  const raw = c.get(r)
  const list = Array.isArray(raw) ? raw : [raw]
  const out = list.map((v) => (v == null ? '' : String(v).trim())).map((v) => v || BLANK)
  return out.length ? out : [BLANK]
}

export type ColFilterResult<T> = {
  /** The rows that pass every column's funnel — what the table and its totals show. */
  rows: T[]
  /** The header label with its funnel. */
  head: (key: string, label: string, opts?: { align?: 'start' | 'center' | 'end'; onDark?: boolean; bare?: boolean }) => React.ReactNode
  /** How many columns are narrowed right now. */
  active: number
  clear: () => void
}

// SORTING, KEPT WITH THE FILTERS: the table's '__sort' entry is
// [column key, 'asc' | 'desc'] — so it survives the same remounts they do.
const SORT = '__sort'
const numOf = (s: string): number => {
  const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s)
  if (m) return Number(`${m[3]}${m[2]}${m[1]}`)
  const x = Number(s.replace(/[₹,\s]|Cr$|Dr$/gi, ''))
  return Number.isFinite(x) ? x : Number.NaN
}

export function colFilter<T>(store: ColFilterStore, table: string, rows: T[], cols: ColDef<T>[]): ColFilterResult<T> {
  const sel = store.state[table] || {}
  const live = cols.filter((c) => (sel[c.key] || []).length)
  const sets = new Map(live.map((c) => [c.key, new Set(sel[c.key])]))
  const passes = (r: T, except?: string): boolean =>
    live.every((c) => c.key === except || valuesOf(c, r).some((v) => sets.get(c.key)!.has(v)))
  const filtered = live.length ? rows.filter((r) => passes(r)) : rows
  const byKey = new Map(cols.map((c) => [c.key, c]))
  // The column sorted on, if any: blanks always last, the rest by number
  // (dates and amounts) for a 'num' column, else as text, numbers in order.
  const [sortKey, sortDir] = (sel[SORT] || []) as [string?, string?]
  const sortCol = sortKey ? byKey.get(sortKey) : undefined
  const shown = sortCol
    ? filtered
        .map((r, i) => ({ r, i, v: valuesOf(sortCol, r)[0] }))
        .sort((a, b) => {
          const ab = a.v === BLANK
          const bb = b.v === BLANK
          if (ab || bb) return ab === bb ? a.i - b.i : ab ? 1 : -1
          let d = 0
          if (sortCol.sort === 'num') {
            const x = numOf(a.v)
            const y = numOf(b.v)
            d = Number.isNaN(x) || Number.isNaN(y) ? a.v.localeCompare(b.v, undefined, { numeric: true }) : x - y
          } else d = a.v.localeCompare(b.v, undefined, { numeric: true, sensitivity: 'base' })
          return (sortDir === 'desc' ? -d : d) || a.i - b.i
        })
        .map((x) => x.r)
    : filtered

  const head: ColFilterResult<T>['head'] = (key, label, opts) => {
    const c = byKey.get(key)
    if (!c) return label
    // Options come from the rows passing every OTHER funnel, so this list does
    // not shrink under the cursor while it is being ticked.
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (live.length && !passes(r, key)) continue
      for (const v of new Set(valuesOf(c, r))) counts.set(v, (counts.get(v) || 0) + 1)
    }
    const num = (s: string): number => {
      const x = numOf(s)
      return Number.isNaN(x) ? Number.POSITIVE_INFINITY : x
    }
    const entries = [...counts.entries()]
    if (c.sort !== 'none') entries.sort((a, b) => {
      if (a[0] === BLANK) return 1
      if (b[0] === BLANK) return -1
      return c.sort === 'num' ? num(a[0]) - num(b[0]) || a[0].localeCompare(b[0]) : a[0].localeCompare(b[0], undefined, { numeric: true })
    })
    return (
      <ColumnFilter
        label={label}
        options={entries.map(([value, count]) => ({ value, label: value, count }))}
        value={sel[key] || []}
        onApply={(v) => store.set(table, key, v)}
        sortDir={sortKey === key ? (sortDir === 'desc' ? 'desc' : 'asc') : null}
        onSort={(d) => store.set(table, SORT, d ? [key, d] : [])}
        align={opts?.align}
        onDark={opts?.onDark}
        bare={opts?.bare}
      />
    )
  }
  // Clear lets go of the filters; the sort stays, as a choice of view.
  return {
    rows: shown,
    head,
    active: live.length,
    clear: () => {
      const keep = sel[SORT]
      store.clear(table)
      if (keep?.length) store.set(table, SORT, keep)
    }
  }
}
