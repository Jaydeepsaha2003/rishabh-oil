// THE MORNING'S POSITION, for the band at the top of the Dashboard.
// -----------------------------------------------------------------------------
// One call, so the band arrives in one piece:
//   dispatch   what went out yesterday, in MT
//   receipts   what came in yesterday, in MT
//   payIn      LCs and discounted bills still waiting on their Payment IN
//   trading    trading deals with money still owed, either way
//   movement   the tankers still on the road
//
// Every figure is read off the rule the page it came from already uses, rather
// than restated here — the dispatch and receipt dates are the stock register's,
// the Payment IN test is Treasury's, the dues are the Trading page's own list —
// so the Dashboard cannot say one thing while the page behind it says another.
import { getClient, todayISO } from './db'
import { allCompanyIds, getActiveCompanyId, withCompany } from './company'
import { listLCs } from './lc'
import { listBd } from './billDiscounting'
import { listTradingPayments } from './trading'
import { listPurchaseTankers } from './orders'
import { listBdOpenTradingInvoices, listLcOpenTradingInvoices } from './treasury'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r2 = (v: number): number => Math.round(v * 100) / 100
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const day10 = (v: unknown): string => String(v ?? '').slice(0, 10)
const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)

function shiftDay(iso: string, by: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + by)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000)
}

// The dashboard's MT rule: only lines kept in MT are added, so a PCS or KG
// line is never read as tonnes. Packed sales are already stored in MT.
const MT = (col: string, uom: string): string =>
  `SUM(CASE WHEN UPPER(COALESCE(${uom}, 'MT')) = 'MT' THEN ${col} ELSE 0 END)`

// A tanker's stages, in the order they happen, and the date each is stamped
// with — the same rail the Purchases page draws.
const STAGES: { key: string; label: string; dateKey: string }[] = [
  { key: 'supplier_factory', label: 'To be loaded', dateKey: 'created_at' },
  { key: 'loaded', label: 'Loaded', dateKey: 'loaded_date' },
  { key: 'transit', label: 'In transit', dateKey: 'transit_date' },
  { key: 'outside_factory', label: 'Outside factory', dateKey: 'outside_factory_date' },
  { key: 'inside_factory', label: 'Inside factory', dateKey: 'inside_factory_date' }
]

// When the money is expected back: the facility's start plus its agreed days —
// payInDueDate on the screens, restated for the server.
function payInDue(r: Row): string | null {
  const days = n(r.payment_in_days)
  if (!(days > 0)) return null
  const from = day10(r.opened_date || r.payment_received_date || r.open_date || r.created_at)
  return isDay(from) ? shiftDay(from, days) : null
}

// A trading facility is paid back by the resale it financed, so what is still
// to come is what those sale invoices still owe; anything else has no expected
// figure of its own, and its face value is the nearest honest one.
async function tradingDue(kind: 'LC' | 'BD', id: number): Promise<number> {
  try {
    const open = kind === 'LC' ? await listLcOpenTradingInvoices(id) : await listBdOpenTradingInvoices(id)
    return r2(open.reduce((a, x) => a + n(x.due), 0))
  } catch {
    return 0
  }
}

// ALL COMPANIES: each company's position, added together. Movement is one list
// of tankers, and a tanker not yet billed shows under every company (see
// below), so it is counted once.
export async function dailyPosition(opts: { all?: boolean } = {}): Promise<Row> {
  if (!opts.all) return positionOne()
  const parts = []
  for (const id of await allCompanyIds()) parts.push(await withCompany(id, positionOne))
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  const seen = new Set<string>()
  const movement: Row[] = []
  for (const p of parts) {
    for (const m of (p.movement as Row[]) || []) {
      const k = String(m.id)
      if (seen.has(k)) continue
      seen.add(k)
      movement.push(m)
    }
  }
  const byDue = (a: Row, b: Row): number => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
  return {
    asOf: parts[0]?.asOf,
    yesterday: parts[0]?.yesterday,
    dispatch: {
      mt: r3(parts.reduce((t, p) => t + n((p.dispatch as Row)?.mt), 0)),
      count: parts.reduce((t, p) => t + n((p.dispatch as Row)?.count), 0)
    },
    receipts: {
      mt: r3(parts.reduce((t, p) => t + n((p.receipts as Row)?.mt), 0)),
      count: parts.reduce((t, p) => t + n((p.receipts as Row)?.count), 0)
    },
    payIn: parts.flatMap((p) => (p.payIn as Row[]) || []).sort(byDue),
    trading: parts.flatMap((p) => (p.trading as Row[]) || []).sort(byDue),
    movement
  }
}

async function positionOne(): Promise<Row> {
  const today = todayISO()
  const yesterday = shiftDay(today, -1)
  const cid = getActiveCompanyId()
  const c = getClient()

  // ---------------------------------------------------------- dispatch --
  // The stock register's own "sold" rule: a dispatch that has left, that
  // moves stock, dated by its invoice (dispatch) date.
  const dispRes = await c.execute({
    sql: `SELECT ROUND(${MT('s.qty', 's.uom')}, 3) AS mt,
                 COUNT(DISTINCT COALESCE(NULLIF(s.invoice_group, ''), 'id:' || s.id)) AS cnt
            FROM sales s
           WHERE s.company_id = ?
             AND s.status = 'done'
             AND COALESCE(s.affects_stock, 1) = 1
             AND substr(s.sale_date, 1, 10) = ?`,
    args: [cid, yesterday]
  })
  const disp = (dispRes.rows[0] as unknown as Row) || {}

  // ---------------------------------------------------------- receipts --
  // The register's receipt rule: a received purchase, on its received date
  // (a consignment one on its order date).
  const recRes = await c.execute({
    sql: `SELECT ROUND(${MT('o.received_qty', 'o.uom')}, 3) AS mt, COUNT(*) AS cnt
            FROM orders o
           WHERE o.company_id = ?
             AND o.status = 'received'
             AND COALESCE(o.affects_stock, 1) = 1
             AND substr(CASE WHEN COALESCE(o.is_consignment, 0) = 1 THEN o.order_date
                             ELSE COALESCE(o.received_date, o.order_date) END, 1, 10) = ?`,
    args: [cid, yesterday]
  })
  const rec = (recRes.rows[0] as unknown as Row) || {}

  // ------------------------------------------------------------ Payment IN --
  // A Payment IN is expected on the facility and some of it has not come back
  // yet. An LC is only waiting once the bank has paid out on it.
  //
  // WHAT IS STILL TO COME, not the face of the bill. What comes back on a bill
  // is what was DRAWN on it — B6's Payment IN was its ₹89.5 L draw, not its
  // ₹94.37 L invoice; T2 came back at ₹30 L on a ₹47.71 L invoice — so the
  // tile added the invoice values and overstated the total on every bill. And
  // a bill with part of its money back dropped out altogether, though the rest
  // was still owed. Now: drawn less what has come back. A trading facility is
  // paid back by the resale invoices it financed, so for one of those it is
  // what those invoices still owe.
  const payIn: Row[] = []
  const [lcs, bds] = await Promise.all([listLCs().catch(() => [] as Row[]), listBd().catch(() => [] as Row[])])
  const stillToCome = async (kind: 'LC' | 'BD', r: Row, drawn: number): Promise<number> => {
    const back = n(r.payment_in_total)
    if (String(r.purpose || '') === 'trading') {
      const due = await tradingDue(kind, n(r.id))
      if (due > 0.5) return r2(due)
      // No resale invoice left open: what was drawn, less what came back.
    }
    return r2(Math.max(0, drawn - back))
  }
  for (const l of lcs) {
    if (l.preclosed_date) continue
    if (String(l.stage || '') !== 'payment_received') continue
    if (!n(l.payment_in_expected)) continue
    const amount = await stillToCome('LC', l, n(l.amount))
    if (!(amount > 0.5)) continue
    payIn.push({
      kind: 'LC',
      id: n(l.id),
      ref_no: l.lc_no ?? null,
      party: l.receivable_party_name || l.supplier_name || null,
      amount,
      received: r2(n(l.payment_in_total)),
      due_date: payInDue(l)
    })
  }
  for (const b of bds) {
    if (!n(b.payment_in_expected)) continue
    const amount = await stillToCome('BD', b, n(b.amount))
    if (!(amount > 0.5)) continue
    payIn.push({
      kind: 'BD',
      id: n(b.id),
      ref_no: b.bd_no ?? null,
      party: b.receivable_party_name || b.party_names || b.party_name || null,
      amount,
      received: r2(n(b.payment_in_total)),
      due_date: payInDue(b)
    })
  }
  // Soonest due first; one with no agreed term goes last.
  payIn.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))

  // --------------------------------------------------------------- trading --
  // The Trading page's own dues list, gathered deal by deal: what the buyers
  // still owe on the sale side, what is still owed to the supplier on the
  // purchase side.
  const trading: Row[] = []
  try {
    const pays = await listTradingPayments()
    const byDeal = new Map<number, Row>()
    for (const p of pays) {
      if (!(n(p.pending) > 0.5)) continue
      const id = n(p.deal_id)
      const d =
        byDeal.get(id) ||
        { id, deal_date: p.deal_date ?? null, product: p.product_name ?? null, receivable: 0, payable: 0, buyers: new Set<string>(), supplier: new Set<string>(), invoices: 0, due_date: null as string | null }
      if (p.side === 'sale') {
        d.receivable = r2(d.receivable + n(p.pending))
        if (p.party_name) d.buyers.add(String(p.party_name).trim())
      } else {
        d.payable = r2(d.payable + n(p.pending))
        if (p.party_name) d.supplier.add(String(p.party_name).trim())
      }
      d.invoices += 1
      const due = day10(p.due_date)
      if (isDay(due) && (!d.due_date || due < d.due_date)) d.due_date = due
      byDeal.set(id, d)
    }
    for (const d of byDeal.values()) {
      trading.push({ ...d, buyers: [...d.buyers].join(', '), supplier: [...d.supplier].join(', ') })
    }
    trading.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))
  } catch {
    // A trading book that cannot be read leaves the card empty rather than the band.
  }

  // -------------------------------------------------------------- movement --
  // Every tanker not yet emptied. One not yet billed belongs to no company's
  // books, so it shows under every company — the Purchases page's rule.
  const movement: Row[] = []
  try {
    const all = await listPurchaseTankers(true)
    for (const t of all) {
      const status = String(t.status || '')
      const stage = STAGES.findIndex((x) => x.key === status)
      if (stage < 0) continue
      if (t.order_id && n(t.company_id) !== cid) continue
      const since = day10(t[STAGES[stage].dateKey] || t.loaded_date || t.created_at)
      movement.push({
        id: n(t.id),
        tanker_no: t.tanker_no ?? null,
        product_name: t.oil_name ?? t.product_name ?? null,
        supplier_name: t.supplier_name ?? null,
        bargain_no: t.bargain_no ?? null,
        qty_mt: String(t.uom || 'MT').toUpperCase() === 'MT' ? r3(n(t.loaded_qty)) : 0,
        status,
        stage_label: STAGES[stage].label,
        stage_order: stage,
        since: isDay(since) ? since : null,
        days: isDay(since) ? Math.max(0, daysBetween(since, today)) : 0
      })
    }
    // Nearest the gate first, and within a stage the longest-waiting first.
    movement.sort((a, b) => b.stage_order - a.stage_order || String(a.since || '').localeCompare(String(b.since || '')))
  } catch {
    // As above: an unreadable tanker list empties its own card only.
  }

  return {
    asOf: today,
    yesterday,
    dispatch: { mt: r3(n(disp.mt)), count: n(disp.cnt) },
    receipts: { mt: r3(n(rec.mt)), count: n(rec.cnt) },
    payIn,
    trading,
    movement
  }
}
