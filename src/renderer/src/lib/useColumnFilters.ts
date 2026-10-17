import { useMemo, useState } from 'react'

// Excel-style filters for a table drawn without the shared <Table> (a CSS
// grid, say): one ColumnFilter per column, each offering the values actually
// in that column. A column's own list is built from the rows that pass every
// OTHER column's filter, so ticking in one never makes its own options jump.

export interface ColumnSpec<T> {
  /** The value a row holds in this column — what a tick matches on. */
  get: (row: T) => string
  /** How that value reads in the list; the value itself when omitted. */
  label?: (value: string) => string
  /** Sort the list by number (amounts, quantities) rather than as text. */
  numeric?: boolean
  /** A column holding several values at once — a journal's ledgers. Each is
   * its own tick, and a row passes when ANY of its values is ticked. */
  many?: (row: T) => string[]
}

export function useColumnFilters<T>(
  rows: T[],
  cols: Record<string, ColumnSpec<T>>,
  initial?: Record<string, string[]>
): {
  /** The rows every column filter lets through. */
  filtered: T[]
  /** Spread onto a ColumnFilter: its options, value and onApply. */
  props: (key: string) => {
    options: { value: string; label: string; count: number }[]
    value: string[]
    onApply: (values: string[]) => void
  }
  /** What is ticked, per column — for keeping it across a remount. */
  selected: Record<string, string[]>
  /** How many columns are narrowed. */
  activeCount: number
  clear: () => void
} {
  const [selected, setSelected] = useState<Record<string, string[]>>(initial || {})
  const passes = (r: T, skip?: string): boolean =>
    Object.entries(selected).every(([k, v]) => {
      if (k === skip || !v.length || !cols[k]) return true
      const spec = cols[k]
      return spec.many ? spec.many(r).some((x) => v.includes(x)) : v.includes(spec.get(r))
    })

  const filtered = useMemo(
    () => rows.filter((r) => passes(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selected]
  )

  function props(key: string): {
    options: { value: string; label: string; count: number }[]
    value: string[]
    onApply: (values: string[]) => void
  } {
    const spec = cols[key]
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (!passes(r, key)) continue
      for (const v of spec.many ? [...new Set(spec.many(r))] : [spec.get(r)]) counts.set(v, (counts.get(v) || 0) + 1)
    }
    // A value ticked earlier that no longer occurs stays listed, so it can
    // still be unticked.
    for (const v of selected[key] || []) if (!counts.has(v)) counts.set(v, 0)
    // LARGEST FIRST, the way the desk works a reconciliation down: an amount
    // column by the figure, biggest at the top; a date column newest first;
    // anything else — a ledger, a party, a status — by how many lines carry
    // it, the name breaking a tie.
    const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)
    const options = [...counts.entries()]
      .map(([value, count]) => ({ value, label: spec.label ? spec.label(value) : value || '(blank)', count }))
      .sort((a, b) => {
        if (spec.numeric) return (Number(b.value) || 0) - (Number(a.value) || 0)
        if (isDate(a.value) && isDate(b.value)) return b.value.localeCompare(a.value)
        return b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true })
      })
    return {
      options,
      value: selected[key] || [],
      onApply: (values) => setSelected((s) => ({ ...s, [key]: values.length >= options.length ? [] : values }))
    }
  }

  const activeCount = Object.values(selected).filter((v) => v.length > 0).length
  return { filtered, props, selected, activeCount, clear: () => setSelected({}) }
}
