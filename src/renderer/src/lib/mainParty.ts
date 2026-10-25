// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * The MAIN party's name for a party id (DIL EXIM for DIL EXIM – RAJKOT), from
 * a suppliers or customers list. The gate shows only main parties; purchases,
 * sales and accounts keep the sub-ledger. undefined when the id is unknown.
 */
export function mainNameOf(list: Row[]): (id: unknown) => string | undefined {
  const byId = new Map(list.map((p) => [Number(p.id), p]))
  return (id) => {
    const p = byId.get(Number(id))
    if (!p) return undefined
    const m = isSubLedger(p) ? byId.get(Number(p.linked_party_id)) : null
    return String((m || p).name || '')
  }
}

/**
 * A SUB-LEDGER is a linked party of the same kind as its main (a branch). A
 * TRADING party linked to a Manufacturing one is its trading counterpart —
 * same PAN, TDS slab shared — and stands on its own everywhere else.
 */
export const isTradingLink = (p: Row): boolean => !!p.linked_party_id && String(p.business_type ?? '').trim().toLowerCase() === 'trading'
export const isSubLedger = (p: Row): boolean => !!p.linked_party_id && !isTradingLink(p)

/** Main parties only — sub-ledgers left out (the gate's pickers). */
export const mainPartiesOnly = (list: Row[]): Row[] => list.filter((p) => !isSubLedger(p))
