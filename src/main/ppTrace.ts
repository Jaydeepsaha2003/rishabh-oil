import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'

// References belong to a dated opening lot, never to a table row or display order.
// The registry is append-only; deleting a breakdown cannot recycle its number.
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export const ppReference = (id: unknown): string => Number(id) > 0 ? `PP-${String(id).padStart(4, '0')}` : ''

export async function ensurePpTraceSchema(): Promise<void> {
  const c = getClient()
  await c.execute(`CREATE TABLE IF NOT EXISTS pp_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id BETWEEN 1 AND 9999),
    scope TEXT NOT NULL, opening_date TEXT NOT NULL, product_id INTEGER NOT NULL,
    stage_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
    UNIQUE(scope, opening_date, product_id, stage_id))`)
  await c.execute(`CREATE TABLE IF NOT EXISTS pp_opening_dates (scope TEXT PRIMARY KEY, opening_date TEXT NOT NULL)`)
  await c.execute(`CREATE TABLE IF NOT EXISTS pp_draw_sources (
    draw_id INTEGER PRIMARY KEY, lot_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL)`)
}

export async function syncPpLots(scope: string, refreshProduct?: number): Promise<Map<string, Row>> {
  return withDbTransaction(async () => {
    const c = getClient()
    const factory = scope.startsWith('f')
    const dateResult = await c.execute({
      sql: `SELECT MAX(as_of) AS d FROM stock_openings WHERE ${factory ? 'factory_id' : 'company_id'} = ?`,
      args: [Number(scope.slice(1))]
    })
    const pending = await c.execute({sql:'SELECT opening_date FROM pp_opening_dates WHERE scope=?', args:[scope]})
    const date = String(pending.rows[0]?.opening_date || dateResult.rows[0]?.d || '')
    const lines = await c.execute({
      sql: `SELECT l.*, p.name AS product_name, p.uom, s.name AS vessel,
                   f.name AS formulation_name
              FROM stock_opening_pp l JOIN products p ON p.id=l.product_id
              JOIN stock_pp_stages s ON s.id=l.stage_id
              LEFT JOIN formulations f ON f.id=l.formulation_id
             WHERE l.scope=? ORDER BY l.product_id, l.stage_id`, args: [scope]
    })
    const result = new Map<string, Row>()
    for (const line of lines.rows as unknown as Row[]) {
      const found = await c.execute({
        sql: 'SELECT id,snapshot_json FROM pp_lots WHERE scope=? AND opening_date=? AND product_id=? AND stage_id=?',
        args: [scope, date, Number(line.product_id), Number(line.stage_id)]
      })
      let id = Number(found.rows[0]?.id || 0)
      let snapshot: Row = id ? JSON.parse(String(found.rows[0].snapshot_json)) : {}
      if (!id || refreshProduct === Number(line.product_id)) {
        const sameRecipe = id && Number(snapshot.formulation_id || 0) === Number(line.formulation_id || 0)
        const items = sameRecipe ? snapshot.items : (await c.execute({
          sql: `SELECT i.*,p.name AS product_name FROM formulation_items i JOIN products p ON p.id=i.product_id
                WHERE i.formulation_id=? AND COALESCE(i.kind,'input')='input' ORDER BY i.id`,
          args: [Number(line.formulation_id || 0)]
        })).rows
        snapshot = { ...line, counted_qty:Number(line.qty), opening_date: date, items: items || [],
          formulation_name: sameRecipe ? snapshot.formulation_name : line.formulation_name,
          captured_at: new Date().toISOString() }
        if (!id) {
          const max = await c.execute('SELECT COALESCE(MAX(id),0) AS n FROM pp_lots')
          if (Number(max.rows[0].n) >= 9999) throw new Error('PP references have reached PP-9999. Extend the reference series before adding another opening lot.')
          const insert = await c.execute({
            sql: 'INSERT INTO pp_lots(scope,opening_date,product_id,stage_id,snapshot_json) VALUES(?,?,?,?,?)',
            args: [scope,date,Number(line.product_id),Number(line.stage_id),JSON.stringify(snapshot)]
          })
          id = Number(insert.lastInsertRowid)
        } else {
          await c.execute({sql:'UPDATE pp_lots SET snapshot_json=? WHERE id=?', args:[JSON.stringify(snapshot),id]})
        }
      }
      result.set(lotKey(Number(line.product_id), Number(line.stage_id)), { ...snapshot, lot_id:id, reference:ppReference(id) })
    }
    return result
  })
}

export const lotKey = (productId: number, stageId: number): string => `${productId}:${stageId}`

/** Keep exact draw-time names and recipe even when the opening is later edited/reset. */
export async function recordPpDrawSource(drawId: number, lot: Row): Promise<void> {
  const batch = await getClient().execute({sql:`SELECT p.formulation_id,p.formulation_version_id,COALESCE(v.name,f.name) AS batch_formulation_name,COALESCE(p.custom_items_json,v.items_json) AS batch_items_json FROM pp_draws d JOIN production p ON p.id=d.production_id LEFT JOIN formulations f ON f.id=p.formulation_id LEFT JOIN formulation_versions v ON v.id=p.formulation_version_id WHERE d.id=?`,args:[drawId]})
  lot = { ...lot, ...batch.rows[0], batch_items:batch.rows[0]?.batch_items_json ? JSON.parse(String(batch.rows[0].batch_items_json)) : [] }
  await getClient().execute({sql:'INSERT INTO pp_draw_sources(draw_id,lot_id,snapshot_json) VALUES(?,?,?)',
    args:[drawId, Number(lot.lot_id), JSON.stringify(lot)]})
}

export async function ppFinishedDetails(companyIds: number[], from: string, to: string): Promise<Map<number, Row[]>> {
  const c = getClient()
  const ph = companyIds.map(() => '?').join(',')
  const lines = await c.execute({
    sql: `SELECT i.product_id,i.qty,p.id AS production_id,p.prod_date,p.product_id AS pp_product_id,
                 COALESCE(fv.name,f.name) AS formulation_name,p.formulation_id,p.formulation_version_id,
                 pr.name AS pp_product_name
          FROM production_items i JOIN production p ON p.id=i.production_id
          JOIN products pr ON pr.id=p.product_id LEFT JOIN formulations f ON f.id=p.formulation_id
          LEFT JOIN formulation_versions fv ON fv.id=p.formulation_version_id
          WHERE i.kind='pp_equiv' AND COALESCE(p.kind,'batch')<>'recirculation'
            AND p.company_id IN (${ph}) AND (?='' OR p.prod_date>=?) AND (?='' OR p.prod_date<=?)`,
    args:[...companyIds,from,from,to,to]
  })
  const draws = await c.execute({
    sql:`SELECT d.*,s.snapshot_json,st.name AS vessel FROM pp_draws d
         JOIN production p ON p.id=d.production_id LEFT JOIN pp_draw_sources s ON s.draw_id=d.id
         LEFT JOIN stock_pp_stages st ON st.id=d.stage_id
         WHERE p.company_id IN (${ph}) AND d.ffa='with' AND d.product_id=p.product_id
           AND (?='' OR p.prod_date>=?) AND (?='' OR p.prod_date<=?) ORDER BY d.id`,
    args:[...companyIds,from,from,to,to]
  })
  // A DRAW MADE BEFORE REFERENCES WERE SAVED STILL CAME OUT OF A LOT.
  // It names its product, its vessel and its batch date; the lot registry is
  // keyed by product, vessel and opening date. So the lot is the one for that
  // vessel on the latest opening on or before the batch — unique by the
  // registry's own constraint — and it is marked as matched, not recorded.
  const scopesOf = new Map<number, string[]>()
  const co = await c.execute({ sql: `SELECT id, factory_id FROM companies WHERE id IN (${ph})`, args: [...companyIds] }).catch(() => null)
  for (const r of (co?.rows || []) as unknown as Row[]) {
    scopesOf.set(Number(r.id), [...(Number(r.factory_id) ? [`f${Number(r.factory_id)}`] : []), `c${Number(r.id)}`])
  }
  const companyOf = new Map<number, number>()
  const pc = await c.execute({ sql: `SELECT id, company_id FROM production WHERE company_id IN (${ph})`, args: [...companyIds] }).catch(() => null)
  for (const r of (pc?.rows || []) as unknown as Row[]) companyOf.set(Number(r.id), Number(r.company_id))
  const lotCache = new Map<string, Row | null>()
  const matchLot = async (draw: Row, prodDate: string): Promise<Row | null> => {
    const scopes = scopesOf.get(companyOf.get(Number(draw.production_id)) || 0) || []
    const key = `${scopes.join(',')}|${draw.product_id}|${draw.stage_id}|${prodDate}`
    if (lotCache.has(key)) return lotCache.get(key) || null
    let hit: Row | null = null
    for (const scope of scopes) {
      const r = await c.execute({
        sql: `SELECT id, snapshot_json FROM pp_lots WHERE scope = ? AND product_id = ? AND stage_id = ? AND opening_date <= ?
              ORDER BY opening_date DESC LIMIT 1`,
        args: [scope, Number(draw.product_id), Number(draw.stage_id), prodDate]
      }).catch(() => null)
      const row = r?.rows[0] as unknown as Row | undefined
      if (row) { hit = { ...JSON.parse(String(row.snapshot_json)), lot_id: Number(row.id), reference: ppReference(row.id), reference_matched: true }; break }
    }
    lotCache.set(key, hit)
    return hit
  }
  const out = new Map<number, Row[]>()
  for (const line of lines.rows as unknown as Row[]) {
    const sources = (draws.rows as unknown as Row[]).filter(d => Number(d.production_id) === Number(line.production_id))
    const total = sources.reduce((sum,d) => sum + Number(d.qty),0)
    const details = out.get(Number(line.product_id)) || []
    // Equivalent ingredients are allocated in proportion to recorded with-FFA vessel draws.
    // Retain full precision here; only the final display/total rounds to three decimals.
    if (!sources.length || total <= 0) details.push({ ...line, kind:'PP finished', reference:'',
      product_name:line.pp_product_name, basis:'Legacy PP source not recorded', qty:Number(line.qty) })
    else for (const draw of sources) {
      const snap = draw.snapshot_json
        ? JSON.parse(String(draw.snapshot_json))
        : (await matchLot(draw, String(line.prod_date || '').slice(0, 10))) || {}
      details.push({ ...snap, kind:'PP finished', qty:Number(line.qty)*Number(draw.qty)/total,
        product_name:snap.product_name || line.pp_product_name, vessel:snap.vessel || draw.vessel,
        reference:snap.reference || '', production_id:Number(line.production_id), prod_date:line.prod_date,
        formulation_name:snap.batch_formulation_name || line.formulation_name || 'Custom formulation', formulation_id:line.formulation_id,
        formulation_version_id:line.formulation_version_id, drawn_qty:Number(draw.qty),
        basis:`${draw.snapshot_json ? 'Recorded vessel draw' : 'Legacy draw; opening reference not recorded'}; ${Number(draw.qty)} / ${total} of batch PP; offsets Consumed` })
    }
    out.set(Number(line.product_id), details)
  }
  return out
}

// Round the running sum, so the quantities a reviewer can see also reconcile.
export function roundAdjustmentDetails(details: Row[]): Row[] {
  let exact = 0
  let displayed = 0
  return details.map(detail => {
    exact += Number(detail.qty) || 0
    const next = Math.round(exact * 1000) / 1000
    const qty = Math.round((next - displayed) * 1000) / 1000
    displayed = next
    return { ...detail, unrounded_qty:detail.qty, qty }
  })
}
