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

// Sample packaging SKUs from the client's list — inserted once, only when the
// packagings table is empty. Each is N units per case of a given unit size; the
// base stock quantity (KG/L) is derived from the unit size/UOM.
const PACKAGINGS: {
  name: string
  pouch_label: string
  unit_size: number
  unit_uom: 'KG' | 'GM' | 'L' | 'ML'
  pouches_per_box: number
}[] = [
  { name: 'DALDA JAR 4.2 KG × 4', pouch_label: 'Jar', unit_size: 4.2, unit_uom: 'KG', pouches_per_box: 4 },
  { name: 'DALDA JAR 15 KG × 1', pouch_label: 'Jar', unit_size: 15, unit_uom: 'KG', pouches_per_box: 1 },
  { name: 'DALDA PCH 1 KG × 15', pouch_label: 'Pch', unit_size: 1, unit_uom: 'KG', pouches_per_box: 15 },
  { name: 'GAGAN ND 420 G POUCH × 40', pouch_label: 'Pouch', unit_size: 420, unit_uom: 'GM', pouches_per_box: 40 },
  { name: 'BANSARI NEW PCH 750 G × 20', pouch_label: 'Pch', unit_size: 750, unit_uom: 'GM', pouches_per_box: 20 },
  { name: 'BANSARI PCH 200 ML × 90', pouch_label: 'Pch', unit_size: 200, unit_uom: 'ML', pouches_per_box: 90 },
  { name: 'PANGHAT TIN 15 L × 1', pouch_label: 'Tin', unit_size: 15, unit_uom: 'L', pouches_per_box: 1 },
  { name: 'SWAD BOTTLE 1 L × 12', pouch_label: 'Bottle', unit_size: 1, unit_uom: 'L', pouches_per_box: 12 }
]

// Add the sample packaging SKUs — idempotent per SKU name, so it tops up the
// samples without duplicating them or touching the user's own SKUs. Guarded by
// a settings flag so it only ever runs once (users can freely delete samples).
export async function seedPackagings(): Promise<void> {
  const c = getClient()
  const done = await c.execute("SELECT value FROM app_settings WHERE key = 'sample_packagings_seeded' LIMIT 1")
  if (done.rows.length && String(done.rows[0].value) === '1') return
  let added = 0
  for (const p of PACKAGINGS) {
    const exists = await c.execute({
      sql: 'SELECT 1 FROM packagings WHERE upper(name) = upper(?) LIMIT 1',
      args: [p.name]
    })
    if (exists.rows.length) continue
    const u = p.unit_uom
    const baseUom = u === 'ML' || u === 'L' ? 'L' : 'KG'
    const perPouch = u === 'GM' || u === 'ML' ? p.unit_size / 1000 : p.unit_size
    const basePerPouch = Math.round(perPouch * 1e6) / 1e6
    await c.execute({
      sql: `INSERT INTO packagings (name, box_label, pouch_label, pouches_per_box, unit_size, unit_uom, base_per_pouch, base_uom, active)
            VALUES (?, 'Case', ?, ?, ?, ?, ?, ?, 1)`,
      args: [p.name, p.pouch_label, p.pouches_per_box, p.unit_size, p.unit_uom, basePerPouch, baseUom]
    })
    added++
  }
  await c.execute("INSERT INTO app_settings (key, value) VALUES ('sample_packagings_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
  console.log(`[seed] sample packagings seeded (${added} added)`)
}

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
