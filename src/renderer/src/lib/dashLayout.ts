// WHICH PIECES OF THE DASHBOARD EACH PERSON WANTS TO SEE.
// -----------------------------------------------------------------------------
// The board carries everything — stock, movement, treasury, trading, taxes —
// and nobody reads all of it. The gate desk wants the tankers and yesterday's
// receipts; accounts want the dues and the duties. Each person hides what is
// not theirs, and the choice is kept per user on the server, so it follows
// them from the office desktop to their phone.
//
// Stored as the HIDDEN keys, not the shown ones: a card added to the board
// later is then visible to everybody until they choose to hide it, instead of
// silently missing from every layout saved before it existed.
import { useCallback, useEffect, useRef, useState } from 'react'

export type DashGroup = 'position' | 'month'
export type DashItem = {
  key: string
  label: string
  group: DashGroup
  kind: 'kpi' | 'card'
  hint: string
  // Drawn only by the desktop app's board, which has a card the website's
  // does not.
  appOnly?: boolean
}

export const DASH_GROUPS: { key: DashGroup; label: string; hint: string }[] = [
  { key: 'position', label: "Today's position", hint: 'Stock, yesterday’s movement, tankers, money still to come, the plan' },
  { key: 'month', label: 'This month', hint: 'Purchases and sales, parties, books, stock and treasury' }
]

export const DASH_ITEMS: DashItem[] = [
  { key: 'pos.stock', label: 'Stock inventory', group: 'position', kind: 'kpi', hint: 'Book stock in MT, by category' },
  { key: 'pos.dispatch', label: 'Yesterday dispatch', group: 'position', kind: 'kpi', hint: 'MT that went out yesterday' },
  { key: 'pos.receipts', label: 'Yesterday receipts', group: 'position', kind: 'kpi', hint: 'MT received yesterday' },
  { key: 'pos.payin', label: 'Payment IN pending', group: 'position', kind: 'kpi', hint: 'LCs and BDs awaiting their Payment IN' },
  { key: 'pos.trade', label: 'Trading payments pending', group: 'position', kind: 'kpi', hint: 'Owed by buyers, owed to suppliers' },
  { key: 'pos.movement', label: 'Oil movement position', group: 'position', kind: 'card', hint: 'Every tanker still on the road, by stage' },
  { key: 'pos.plan', label: 'Production plan vs actual', group: 'position', kind: 'card', hint: 'The day’s plan against what was made' },
  { key: 'pos.payinList', label: 'Payment IN pending — list', group: 'position', kind: 'card', hint: 'Each LC and BD, with its due date' },
  { key: 'pos.tradeList', label: 'Trading payments — list', group: 'position', kind: 'card', hint: 'Each deal, both sides' },

  { key: 'm.buy', label: 'Purchases this month', group: 'month', kind: 'kpi', hint: '₹, MT and invoices' },
  { key: 'm.sell', label: 'Sales this month', group: 'month', kind: 'kpi', hint: '₹, MT and invoices' },
  { key: 'm.pay', label: 'Payable to suppliers', group: 'month', kind: 'kpi', hint: 'From the books' },
  { key: 'm.rec', label: 'Receivable from customers', group: 'month', kind: 'kpi', hint: 'From the books' },
  { key: 'm.chart', label: 'Purchases vs sales chart', group: 'month', kind: 'card', hint: 'Last 6 months' },
  { key: 'm.sparkBuy', label: 'Purchases · 30 days', group: 'month', kind: 'card', hint: 'Day by day' },
  { key: 'm.sparkSell', label: 'Sales · 30 days', group: 'month', kind: 'card', hint: 'Day by day' },
  { key: 'm.topSup', label: 'Top suppliers', group: 'month', kind: 'card', hint: 'By value' },
  { key: 'm.topCus', label: 'Top customers', group: 'month', kind: 'card', hint: 'By value' },
  { key: 'm.duties', label: 'Duties & taxes', group: 'month', kind: 'card', hint: 'TDS and GST from the books' },
  { key: 'm.stock', label: 'Book stock by category', group: 'month', kind: 'card', hint: 'Raw, intermediate, finished, consignment' },
  { key: 'm.exposure', label: 'Open exposure', group: 'month', kind: 'card', hint: 'Open bargains and tankers on the move' },
  { key: 'm.attention', label: 'Attention', group: 'month', kind: 'card', hint: 'Products below nil' },
  { key: 'm.treasury', label: 'Treasury watch', group: 'month', kind: 'card', hint: 'LCs expiring, bills maturing' },
  { key: 'm.balances', label: 'Largest balances', group: 'month', kind: 'card', hint: 'Biggest payables and receivables', appOnly: true }
]

// The items this build actually draws.
export function dashItemsHere(): DashItem[] {
  return DASH_ITEMS.filter((i) => !(__WEB__ && i.appOnly))
}

const CACHE = 'dash.hidden.v1'
const KNOWN = new Set(DASH_ITEMS.map((i) => i.key))

function readCache(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE) || '[]')
    return Array.isArray(v) ? v.filter((k) => KNOWN.has(String(k))) : []
  } catch {
    return []
  }
}
function writeCache(hidden: string[]): void {
  try {
    localStorage.setItem(CACHE, JSON.stringify(hidden))
  } catch {
    // Private window or blocked storage: the server copy still holds it.
  }
}

export type DashLayout = {
  isOn: (key: string) => boolean
  hidden: Set<string>
  toggle: (key: string) => void
  setMany: (keys: string[], on: boolean) => void
  showAll: () => void
  saving: boolean
  failed: boolean
}

export function useDashLayout(): DashLayout {
  // The last layout this browser saw paints first, so a hidden card does not
  // flash up and vanish while the server copy is on its way.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readCache()))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touched = useRef(false)

  useEffect(() => {
    let live = true
    void window.api.dashboard
      .layout()
      .then((r) => {
        // A change made before the server answered wins over what it sent.
        if (!live || touched.current) return
        const keys = (Array.isArray(r?.hidden) ? r.hidden : []).map(String).filter((k: string) => KNOWN.has(k))
        setHidden(new Set(keys))
        writeCache(keys)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const commit = useCallback((next: Set<string>) => {
    touched.current = true
    setHidden(next)
    const keys = [...next]
    writeCache(keys)
    // Saved a moment after the last switch, so flicking through ten of them
    // is one write and not ten.
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setSaving(true)
      window.api.dashboard
        .saveLayout(keys)
        .then(() => setFailed(false))
        .catch(() => setFailed(true))
        .finally(() => setSaving(false))
    }, 450)
  }, [])

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(hidden)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      commit(next)
    },
    [hidden, commit]
  )
  const setMany = useCallback(
    (keys: string[], on: boolean) => {
      const next = new Set(hidden)
      for (const k of keys) {
        if (on) next.delete(k)
        else next.add(k)
      }
      commit(next)
    },
    [hidden, commit]
  )
  const showAll = useCallback(() => commit(new Set()), [commit])
  const isOn = useCallback((key: string) => !hidden.has(key), [hidden])

  return { isOn, hidden, toggle, setMany, showAll, saving, failed }
}
