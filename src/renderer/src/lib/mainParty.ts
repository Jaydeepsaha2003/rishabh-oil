// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * A linked party of the SAME type as its main is a branch (DIL EXIM – RAJKOT):
 * the gate shows the main party for it. One of a different type — the Trading
 * side of a Manufacturing party, or the other way round — is its counterpart,
 * same PAN and TDS slab, and keeps its own name (gate.ts does the same in SQL).
 */
const typeOf = (p: Row | undefined): string => String(p?.business_type ?? '').trim().toLowerCase()
function branchMain(p: Row, byId: Map<number, Row>): Row | null {
  const m = p.linked_party_id ? byId.get(Number(p.linked_party_id)) : undefined
  return m && typeOf(m) === typeOf(p) ? m : null
}

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
    return String((branchMain(p, byId) || p).name || '')
  }
}

/** Main parties only — branch sub-ledgers left out (the gate's pickers). */
export function mainPartiesOnly(list: Row[]): Row[] {
  const byId = new Map(list.map((p) => [Number(p.id), p]))
  return list.filter((p) => !branchMain(p, byId))
}
