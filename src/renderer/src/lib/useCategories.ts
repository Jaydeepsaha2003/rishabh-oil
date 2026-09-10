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
  scope?: CategoryScope,
  // Categories that must be offered whatever side the master files them
  // under, because a PRODUCT inside them is flagged "Used for both". Without
  // this the product-level flag cannot work through a cascade: a HUSK product
  // flagged both is unreachable under Sales while HUSK itself is
  // purchase-only, since the category dropdown never offers HUSK there.
  alwaysOffer: unknown[] = []
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

  const always = new Set(
    alwaysOffer.map((x) => String(x ?? '').trim().toUpperCase()).filter(Boolean)
  )
  const forScope = (want?: CategoryScope): string[] => {
    const seen = new Set<string>()
    for (const r of rows) {
      if (Number(r.active) === 0) continue
      const side = String(r.applies_to || 'both').toLowerCase()
      const v = String(r.name || '').trim().toUpperCase()
      // The side gate is skipped for a category holding a both-flagged
      // product. `active` still applies: a retired category stays retired.
      if (want && side !== 'both' && side !== want && !always.has(v)) continue
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
