// Each person's Dashboard layout — which KPIs and cards they have hidden.
//
// Kept in app_settings under the signed-in user's own key, so it follows them
// from one device to the next and one person's choice never changes another's
// board. It is a view preference and nothing else: no figure on any page is
// read from it.
import { getSetting, setSetting } from './repos'
import { getCurrentUser } from './currentUser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function keyFor(): string {
  const u = getCurrentUser()
  if (u.id) return `dash_layout_u${u.id}`
  if (u.username) return `dash_layout_n_${u.username.toLowerCase()}`
  return 'dash_layout_default'
}

export async function getDashLayout(): Promise<Row> {
  const raw = await getSetting(keyFor())
  if (!raw) return { hidden: [] }
  try {
    const v = JSON.parse(raw)
    return { hidden: Array.isArray(v?.hidden) ? v.hidden.map(String) : [] }
  } catch {
    return { hidden: [] }
  }
}

export async function saveDashLayout(hiddenIn: unknown): Promise<{ ok: true; hidden: string[] }> {
  // Only item keys of the board's own shape, and not an unbounded list — this
  // is a row of switches, not a place to store anything else.
  const hidden = (Array.isArray(hiddenIn) ? hiddenIn : [])
    .map((k) => String(k))
    .filter((k) => /^[a-z]+\.[A-Za-z]{1,32}$/.test(k))
  const unique = [...new Set(hidden)].slice(0, 100)
  await setSetting(keyFor(), JSON.stringify({ hidden: unique }))
  return { ok: true, hidden: unique }
}
