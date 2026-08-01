import { useCallback, useEffect, useState } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The material categories master (OIL, HUSK, SCRAP…), read by every screen that
// used to carry its own hard-coded list. `extra` folds in values already stored
// on records, so a category retired from the master never hides existing data.
export type CategoryScope = 'purchase' | 'sales'

export function useCategories(
  extra: unknown[] = [],
  // Narrow to one side of the trade. A category marked 'both' always counts.
  scope?: CategoryScope
): {
  categories: string[]
  rows: Row[]
  forScope: (s?: CategoryScope) => string[]
  reload: () => Promise<void>
} {
  const [rows, setRows] = useState<Row[]>([])

  const reload = useCallback(async () => {
    try {
      setRows(await window.api.data.list('categories'))
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const forScope = (want?: CategoryScope): string[] => {
    const seen = new Set<string>()
    for (const r of rows) {
      if (Number(r.active) === 0) continue
      const side = String(r.applies_to || 'both').toLowerCase()
      if (want && side !== 'both' && side !== want) continue
      const v = String(r.name || '').trim().toUpperCase()
      if (v) seen.add(v)
    }
    // Values already stored on records are always offered, whatever the master
    // now says — an old entry must never become unreadable or unselectable.
    for (const e of extra) {
      const v = String(e ?? '').trim().toUpperCase()
      if (v) seen.add(v)
    }
    return Array.from(seen).sort()
  }
  return { categories: forScope(scope), rows, forScope, reload }
}
