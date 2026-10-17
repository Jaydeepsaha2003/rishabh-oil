// THE DAY'S PRODUCTION PLAN, AND WHAT WAS ACTUALLY MADE.
// -----------------------------------------------------------------------------
// The plant decides in the morning what it will run — so many MT of this, so
// many of that — and the question worth a card on the Dashboard is how the day
// went against it. The plan is set from the Dashboard itself (the desk's
// choice: it lives nowhere else), one row per product per day, and the actual
// is simply the production register for the same day, so nothing has to be
// typed twice.
//
// Scoped like production: to the plant, not the company — both companies run
// the same tanks, and a plan written under one is the plan for the floor. Its
// own table, created on first use, so no existing row is touched by it.
import { getClient } from './db'
import { getActiveCompanyId, companiesOfFactory, factoryOfCompanies } from './company'
import { assertAllowed } from './access-gate'
import { getCurrentUser } from './currentUser'
import { withDbTransaction } from './dbTransaction'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const r3 = (v: number): number => Math.round(v * 1000) / 1000

let tableReady = false
async function ensureTable(): Promise<void> {
  if (tableReady) return
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS production_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    factory_id INTEGER,
    company_id INTEGER,
    plan_date TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    planned_qty REAL NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  await c.execute('CREATE INDEX IF NOT EXISTS idx_production_plans_day ON production_plans (factory_id, plan_date)')
  tableReady = true
}

// The plant this user is looking at, and the companies on it — the same
// answer listProduction uses, so the plan and the register it is measured
// against cannot be scoped differently.
async function scope(): Promise<{ fid: number; cids: number[] }> {
  const fid = await factoryOfCompanies([getActiveCompanyId()])
  const cids = await companiesOfFactory()
  return { fid: n(fid), cids: cids.length ? cids : [getActiveCompanyId()] }
}

function checkDate(d: unknown): string {
  const day = String(d || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Pick a date for the plan')
  return day
}

export async function getProductionPlan(date: string): Promise<Row> {
  await ensureTable()
  const day = checkDate(date)
  const { fid, cids } = await scope()
  const ph = cids.map(() => '?').join(', ')
  const c = getClient()

  const planWhere = fid ? 'pp.factory_id = ?' : `pp.factory_id IS NULL AND pp.company_id IN (${ph})`
  const planArgs = fid ? [fid] : cids
  const plan = await c.execute({
    sql: `SELECT pp.product_id, pp.planned_qty, pp.note, pr.name AS product_name, pr.category AS product_category
            FROM production_plans pp
            LEFT JOIN products pr ON pr.id = pp.product_id
           WHERE ${planWhere} AND pp.plan_date = ?
           ORDER BY pr.name`,
    args: [...planArgs, day]
  })

  // What the register holds for the day, per product, in MT. Recirculation is
  // left out for the reason Produced leaves it out: nothing new was made.
  const prodWhere = fid
    ? `(p.factory_id = ? OR (p.factory_id IS NULL AND p.company_id IN (${ph})))`
    : `p.company_id IN (${ph})`
  const prodArgs = fid ? [fid, ...cids] : cids
  const made = await c.execute({
    sql: `SELECT p.product_id, pr.name AS product_name, pr.category AS product_category,
                 ROUND(SUM(CASE WHEN UPPER(COALESCE(p.uom, 'MT')) = 'MT' THEN p.qty ELSE 0 END), 3) AS actual_qty,
                 COUNT(*) AS runs
            FROM production p
            LEFT JOIN products pr ON pr.id = p.product_id
           WHERE ${prodWhere}
             AND substr(p.prod_date, 1, 10) = ?
             AND COALESCE(p.kind, 'batch') <> 'recirculation'
           GROUP BY p.product_id`,
    args: [...prodArgs, day]
  })

  const actual = new Map<number, Row>()
  for (const r of made.rows as unknown as Row[]) actual.set(n(r.product_id), r)
  const rows: Row[] = []
  for (const r of plan.rows as unknown as Row[]) {
    const a = actual.get(n(r.product_id))
    actual.delete(n(r.product_id))
    rows.push({
      product_id: n(r.product_id),
      product_name: r.product_name ?? null,
      product_category: r.product_category ?? null,
      planned_qty: r3(n(r.planned_qty)),
      actual_qty: r3(n(a?.actual_qty)),
      runs: n(a?.runs),
      note: r.note ?? null
    })
  }
  // Made without being planned — still shown, so the day's total is the whole
  // day and not only the planned part of it.
  for (const a of [...actual.values()].sort((x, y) => String(x.product_name || '').localeCompare(String(y.product_name || '')))) {
    rows.push({
      product_id: n(a.product_id),
      product_name: a.product_name ?? null,
      product_category: a.product_category ?? null,
      planned_qty: 0,
      actual_qty: r3(n(a.actual_qty)),
      runs: n(a.runs),
      note: null
    })
  }

  // Whether this user may change it — asked of the same gate the save goes
  // through, so the button and the refusal cannot disagree.
  let canEdit = true
  try {
    await assertAllowed('productionPlan:save', { date: day })
  } catch {
    canEdit = false
  }
  return { date: day, rows, canEdit }
}

// The whole day's plan at once: what is sent IS the plan, so a product taken
// off the list is taken off the plan.
export async function saveProductionPlan(date: string, rowsIn: Row[]): Promise<{ count: number }> {
  await ensureTable()
  const day = checkDate(date)
  const list = Array.isArray(rowsIn) ? rowsIn : []
  const seen = new Set<number>()
  const rows: { product_id: number; planned_qty: number; note: string | null }[] = []
  for (const r of list) {
    const pid = n(r?.product_id)
    const qty = r3(n(r?.planned_qty))
    if (!pid) continue
    if (!(qty > 0)) throw new Error('Every product on the plan needs a quantity above 0 MT')
    if (seen.has(pid)) throw new Error('A product can appear on the day’s plan only once — add its quantities together')
    seen.add(pid)
    const note = String(r?.note ?? '').trim()
    rows.push({ product_id: pid, planned_qty: qty, note: note || null })
  }
  const { fid, cids } = await scope()
  const cid = getActiveCompanyId()
  const who = getCurrentUser().username || null
  return withDbTransaction(async () => {
    const c = getClient()
    if (fid) {
      await c.execute({ sql: 'DELETE FROM production_plans WHERE factory_id = ? AND plan_date = ?', args: [fid, day] })
    } else {
      const ph = cids.map(() => '?').join(', ')
      await c.execute({
        sql: `DELETE FROM production_plans WHERE factory_id IS NULL AND company_id IN (${ph}) AND plan_date = ?`,
        args: [...cids, day]
      })
    }
    for (const r of rows) {
      await c.execute({
        sql: `INSERT INTO production_plans (factory_id, company_id, plan_date, product_id, planned_qty, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [fid || null, cid, day, r.product_id, r.planned_qty, r.note, who]
      })
    }
    return { count: rows.length }
  })
}
