import { useMemo, useState } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export type SortDir = 'asc' | 'desc'

/**
 * ONE WAY TO SORT A COLUMN, FOR EVERY TABLE IN THE APP.
 *
 * Written once because the comparisons are the part that goes wrong, and a
 * table that sorts differently from the one next to it is worse than one that
 * does not sort at all:
 *
 *  - FIGURES SORT AS FIGURES. "9" after "10" is what string order gives, and
 *    a register of quantities sorted that way is unreadable.
 *  - DATES SORT AS DATES, whether they arrive as 2026-09-14 or 14-09-2026.
 *    Sorting dd-mm-yyyy as text puts every 1st of the month together.
 *  - TEXT SORTS NATURALLY: "Tank 2" before "Tank 10", case ignored, so a list
 *    reads the way a person would file it.
 *  - BLANKS GO LAST EITHER WAY. A blank is not a small value, it is an absent
 *    one, and burying the rows that still need filling in at the top of a
 *    descending sort is precisely backwards.
 */

const DMY = /^(\d{2})[-/](\d{2})[-/](\d{4})$/
const YMD = /^(\d{4})-(\d{2})-(\d{2})/

/** A date as a comparable number, or null when it is not a date at all. */
function asDate(v: string): number | null {
  const dmy = DMY.exec(v)
  if (dmy) return Number(`${dmy[3]}${dmy[2]}${dmy[1]}`)
  const ymd = YMD.exec(v)
  if (ymd) return Number(`${ymd[1]}${ymd[2]}${ymd[3]}`)
  return null
}

/** A figure as a number, or null. Tolerates ₹, commas and a trailing unit. */
function asNumber(v: string): number | null {
  const cleaned = v.replace(/[₹,\s]/g, '').replace(/\s*(MT|KG|PCS|Dr|Cr)$/i, '')
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Compare two cell values under the rules above. Blank-last is applied by the caller. */
export function compareCells(a: unknown, b: unknown): number {
  const sa = a == null ? '' : String(a).trim()
  const sb = b == null ? '' : String(b).trim()
  if (!sa && !sb) return 0
  // Blank last, in BOTH directions — see the note above. Returned as a fixed
  // sign so the caller's direction flip cannot move them.
  if (!sa) return 1
  if (!sb) return -1

  const na = asNumber(sa)
  const nb = asNumber(sb)
  if (na != null && nb != null) return na - nb

  const da = asDate(sa)
  const db = asDate(sb)
  if (da != null && db != null) return da - db

  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Sort state for one table.
 *
 * `read` says what a column's value IS for sorting, which is not always what
 * the cell SHOWS — a column rendering "Yes"/"No" or a chip still has a plain
 * value underneath, and that is what should be compared.
 */
export function useTableSort<T extends Row>(
  rows: T[],
  read: (row: T, key: string) => unknown
): {
  sorted: T[]
  key: string
  dir: SortDir
  toggle: (key: string) => void
  /** Sort straight to one column and direction — a figure card clicked. */
  sortBy: (key: string, dir: SortDir) => void
  ariaSort: (key: string) => 'ascending' | 'descending' | 'none'
} {
  const [key, setKey] = useState('')
  const [dir, setDir] = useState<SortDir>('asc')

  const sorted = useMemo(() => {
    if (!key) return rows
    // A copy: the caller's array is somebody else's state, and sorting in
    // place would reorder it under them.
    const out = [...rows]
    const sign = dir === 'asc' ? 1 : -1
    out.sort((x, y) => {
      const c = compareCells(read(x, key), read(y, key))
      // Blanks were given a fixed sign; everything else follows the direction.
      const bothPresent = String(read(x, key) ?? '').trim() && String(read(y, key) ?? '').trim()
      return bothPresent ? c * sign : c
    })
    return out
  }, [rows, key, dir, read])

  return {
    sorted,
    key,
    dir,
    // First click sorts up, second turns it round, third lets the table go
    // back to the order it was given in — which for most registers is date
    // order and is a thing people want back.
    toggle: (k: string): void => {
      if (k !== key) {
        setKey(k)
        setDir('asc')
        return
      }
      if (dir === 'asc') {
        setDir('desc')
        return
      }
      setKey('')
      setDir('asc')
    },
    sortBy: (k: string, d: SortDir): void => {
      setKey(k)
      setDir(d)
    },
    ariaSort: (k: string): 'ascending' | 'descending' | 'none' =>
      k !== key ? 'none' : dir === 'asc' ? 'ascending' : 'descending'
  }
}
