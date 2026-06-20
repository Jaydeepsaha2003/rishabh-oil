import { getClient } from './db'

// Product catalogue from the client's DATABASE KRFL sheet, by category.
const PRODUCTS: { category: string; items: string[] }[] = [
  {
    category: 'raw',
    items: [
      'CPO',
      'RPO',
      'RPS',
      'SHEA',
      'MAHUWA',
      'RPL',
      'RPKO',
      'CORN OIL',
      'MUSTARD OIL',
      'SUNFLOWER OIL',
      'SOYABEAN OIL',
      'FATTY ACID',
      'OTHERS'
    ]
  },
  { category: 'intermediate', items: ['IVF', 'HO-DALDA', 'HO-PANGHAT', 'FATTY OIL', 'RECOVERED OIL'] },
  { category: 'finished', items: ['DALDA', 'GAGAN', 'PANGHAT', 'SWAD', 'ROYAL', 'LOOSE', 'OTHERS'] }
]

// Insert the initial product list once (only when the table is empty).
export async function seedProducts(): Promise<void> {
  const c = getClient()
  const res = await c.execute('SELECT COUNT(*) AS n FROM products')
  if (Number(res.rows[0].n) > 0) return
  for (const group of PRODUCTS) {
    for (const name of group.items) {
      await c.execute({
        sql: 'INSERT INTO products (code, name, category, active) VALUES (?, ?, ?, 1)',
        args: [name, name, group.category]
      })
    }
  }
  console.log('[seed] products seeded')
}

// Recipes from DATABASE KRFL Sheet3, as percentages that total 100.
// (LOOSE's RECOVERED OIL was 5 in the sheet — corrected to 5% so it totals 100.)
const RECIPES: { out: string; items: [string, number][] }[] = [
  { out: 'DALDA', items: [['RPS', 23], ['HO-DALDA', 2], ['IVF', 75]] },
  { out: 'GAGAN', items: [['RPS', 23], ['HO-DALDA', 2], ['IVF', 75]] },
  { out: 'PANGHAT', items: [['RPO', 85], ['HO-PANGHAT', 15]] },
  { out: 'SWAD', items: [['RPO', 15], ['HO-PANGHAT', 85]] },
  { out: 'ROYAL', items: [['RPS', 23], ['HO-DALDA', 2], ['IVF', 75]] },
  { out: 'LOOSE', items: [['RPS', 25], ['SHEA', 70], ['RECOVERED OIL', 5]] },
  { out: 'IVF', items: [['RPO', 50], ['RPS', 50]] },
  { out: 'HO-DALDA', items: [['RPS', 100]] },
  { out: 'HO-PANGHAT', items: [['RPS', 100]] },
  { out: 'FATTY OIL', items: [['FATTY ACID', 100]] }
]

async function findProductId(name: string): Promise<number | null> {
  const res = await getClient().execute({
    sql: 'SELECT id FROM products WHERE upper(name) = upper(?) LIMIT 1',
    args: [name]
  })
  return res.rows.length ? Number(res.rows[0].id) : null
}

async function ensureProductId(name: string, category: string): Promise<number> {
  const existing = await findProductId(name)
  if (existing) return existing
  const res = await getClient().execute({
    sql: 'INSERT INTO products (code, name, category, active) VALUES (?, ?, ?, 1)',
    args: [name, name, category]
  })
  return Number(res.lastInsertRowid)
}

// Insert the recipes once (only when no formulations exist yet).
export async function seedFormulations(): Promise<void> {
  const c = getClient()
  const res = await c.execute('SELECT COUNT(*) AS n FROM formulations')
  if (Number(res.rows[0].n) > 0) return
  // Make sure RECOVERED OIL exists for the LOOSE recipe.
  await ensureProductId('RECOVERED OIL', 'intermediate')
  for (const r of RECIPES) {
    const outId = await findProductId(r.out)
    if (!outId) continue
    const ins = await c.execute({
      sql: "INSERT INTO formulations (product_id, name, uom, active) VALUES (?, NULL, 'ton', 1)",
      args: [outId]
    })
    const fid = Number(ins.lastInsertRowid)
    for (const [name, pct] of r.items) {
      const pid = await ensureProductId(name, 'raw')
      await c.execute({
        sql: 'INSERT INTO formulation_items (formulation_id, product_id, qty) VALUES (?, ?, ?)',
        args: [fid, pid, pct]
      })
    }
  }
  console.log('[seed] formulations seeded')
}
