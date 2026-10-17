import type { ResultSet } from '@libsql/client'
import { getClient } from './db'
import { allCompanyIds, getActiveCompanyId } from './company'
import { stockLevels } from './stock'
import { listBargains } from './bargains'
import { listSalesBargains } from './sales'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

function toPlain(res: ResultSet): Row[] {
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Everything the dashboard shows, in one round trip. All figures are for the
// ACTIVE company. Months are ISO prefixes (YYYY-MM); the series cover the six
// months ending today.
// A TONNAGE, and only a tonnage.
//
// These headline figures are printed with "MT" beside them, so a plain
// SUM(qty) over a register that also holds cartons (PCS), kilos and litres
// adds three different things and calls the answer tonnes -- 162 cartons
// landing in a month's sales as 162 MT. Only rows already counted in MT are
// summed; anything else is left out of a figure that claims to be MT rather
// than folded into it wrongly. Same rule the Stock register's combined totals
// follow.
const MT_ONLY = (col: string, uom = 'uom'): string =>
  `SUM(CASE WHEN UPPER(COALESCE(${uom}, 'MT')) = 'MT' THEN ${col} ELSE 0 END)`

// WHAT IS STILL OPEN ON THE BARGAINS — read off the registers themselves.
//
// This counted every bargain not marked 'settled' and added up its CONTRACTED
// quantity, so a bargain drawn to nothing still counted in full: 49 bargains
// and 3,491.98 MT on a Purchase Bargain register that had 875.24 MT open. A
// bargain is open while something is left on it, and what is open is that
// balance — the registers' own balance_qty (quantity with its adjustments,
// less every draw, plus returns on the sales side). Both kinds of bargain are
// general, across every company, exactly as the registers read them. The MT
// figure sums MT bargains only (see MT_ONLY); the count is every open one.
//
// Split by how each register is looked at — purchase bargains by category
// (it opens on OIL), sales bargains by Loose / Packed (it opens on Loose) — so
// each part matches a view someone can open, and the total is their sum.
function openOf(rows: Row[], partOf: (r: Row) => string): { cnt: number; qty: number; parts: { key: string; cnt: number; qty: number }[] } {
  const isMt = (r: Row): boolean => String(r.uom || 'MT').trim().toUpperCase() === 'MT'
  const open = rows.filter((r) => n(r.balance_qty) > 0.0005)
  const parts = new Map<string, { key: string; cnt: number; qty: number }>()
  let mt = 0
  for (const r of open) {
    const k = partOf(r)
    const p = parts.get(k) || { key: k, cnt: 0, qty: 0 }
    p.cnt += 1
    if (isMt(r)) {
      p.qty += n(r.balance_qty)
      mt += n(r.balance_qty)
    }
    parts.set(k, p)
  }
  const r3 = (x: number): number => Math.round(x * 1000) / 1000
  return {
    cnt: open.length,
    qty: r3(mt),
    parts: [...parts.values()].map((p) => ({ ...p, qty: r3(p.qty) })).sort((a, b) => b.qty - a.qty || b.cnt - a.cnt)
  }
}

export async function dashboardStats(opts: { all?: boolean } = {}): Promise<Row> {
  const c = getClient()
  const cid = getActiveCompanyId()
  // ALL COMPANIES: the same queries over every company's rows at once, so a
  // supplier's purchases, a ledger's balance or a month's sales across both
  // books is ONE figure — added up before it is ranked, not two top-fives
  // stitched together.
  const all = !!opts.all
  const ids = all ? await allCompanyIds() : [cid]

  const q = async (sql: string, args: (string | number)[] = []): Promise<Row[]> => {
    if (!all) return toPlain(await c.execute({ sql, args: [cid, ...args] }))
    // Each query's company filter becomes the list; the only arguments these
    // queries take are that company (the duties query names it three times),
    // so they go with it.
    const list = ids.join(',')
    return toPlain(await c.execute({ sql: sql.replace(/(\b[a-z]+\.)?company_id = \?/g, (_m, a) => `${a || ''}company_id IN (${list})`), args: [] }))
  }

  const [
    purchaseMonths,
    saleMonths,
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains,
    saleBargains,
    tankers,
    consignment,
    levels
  ] = await Promise.all([
    q(`SELECT substr(order_date, 1, 7) AS m, SUM(taxable_value + gst_amount + round_off) AS v, ${MT_ONLY('ordered_qty')} AS qty, COUNT(*) AS cnt
       FROM orders WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT substr(sale_date, 1, 7) AS m, SUM(amount + gst_amount + round_off) AS v, ${MT_ONLY('qty')} AS qty, COUNT(DISTINCT COALESCE(invoice_group, 'L' || id)) AS cnt
       FROM sales WHERE company_id = ? GROUP BY m ORDER BY m DESC LIMIT 6`),
    q(`SELECT order_date AS d, SUM(taxable_value + gst_amount + round_off) AS v
       FROM orders WHERE company_id = ? AND order_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT sale_date AS d, SUM(amount + gst_amount + round_off) AS v
       FROM sales WHERE company_id = ? AND sale_date >= date('now', '-29 days') GROUP BY d`),
    q(`SELECT s.name, SUM(o.taxable_value + o.gst_amount + o.round_off) AS v, ${MT_ONLY('o.ordered_qty', 'o.uom')} AS qty
       FROM orders o JOIN suppliers s ON s.id = o.supplier_id
       WHERE o.company_id = ? GROUP BY o.supplier_id ORDER BY v DESC LIMIT 5`),
    // The MASTER's name first, then the free text, and only then CASH.
    //
    // This read the free-text column alone. A sale booked from the Trading page
    // sets customer_id and leaves that text NULL, so every trading invoice fell
    // into one "CASH" bucket -- which then led the chart at Rs 26.54 Cr, a
    // customer that does not exist, while the real ones were understated. The
    // supplier query beside it has always joined its master; this now matches.
    q(`SELECT COALESCE(NULLIF(TRIM(cu.name), ''), NULLIF(TRIM(s.customer), ''), 'CASH') AS name,
              SUM(s.amount + s.gst_amount + s.round_off) AS v, ${MT_ONLY('s.qty', 's.uom')} AS qty
       FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
       WHERE s.company_id = ? GROUP BY name ORDER BY v DESC LIMIT 5`),
    q(`SELECT a.name, SUM(jl.cr) - SUM(jl.dr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group IN (WITH RECURSIVE t(id, name) AS (SELECT id, name FROM ledger_groups WHERE name = 'Sundry Creditors'
                       UNION ALL SELECT g.id, g.name FROM ledger_groups g JOIN t ON g.parent_id = t.id) SELECT name FROM t)
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    q(`SELECT a.name, SUM(jl.dr) - SUM(jl.cr) AS bal
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN ledger_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ? AND a.acc_group IN (WITH RECURSIVE t(id, name) AS (SELECT id, name FROM ledger_groups WHERE name = 'Sundry Debtors'
                       UNION ALL SELECT g.id, g.name FROM ledger_groups g JOIN t ON g.parent_id = t.id) SELECT name FROM t)
       GROUP BY a.id HAVING ABS(bal) > 0.005 ORDER BY bal DESC LIMIT 6`),
    // THE BOARD WANTS THE TOTAL, NOT THE HEADS.
    //
    // GST is kept head by head and rate by rate now (see gstLedgers.ts), which
    // is what a return is filed from and emphatically not what a tile on a
    // dashboard should carry — six figures where one belongs. So the tiles are
    // handed one input and one output figure, summed here, and the names they
    // ask for are unchanged. The old single ledgers are still in the sum: a
    // book that has not run the split yet reads exactly as it did.
    q(
      `SELECT 'TDS PAYABLE A/C' AS name, SUM(jl.dr) - SUM(jl.cr) AS bal
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
         JOIN ledger_accounts a ON a.id = jl.account_id
        WHERE je.company_id = ? AND a.name = 'TDS PAYABLE A/C'
       UNION ALL
       SELECT 'GST INPUT A/C', SUM(jl.dr) - SUM(jl.cr)
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
         JOIN ledger_accounts a ON a.id = jl.account_id
        WHERE je.company_id = ?
          AND (a.name = 'GST INPUT A/C' OR a.name LIKE 'INPUT CGST %'
               OR a.name LIKE 'INPUT SGST %' OR a.name LIKE 'INPUT IGST %')
       UNION ALL
       SELECT 'GST OUTPUT A/C', SUM(jl.dr) - SUM(jl.cr)
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
         JOIN ledger_accounts a ON a.id = jl.account_id
        WHERE je.company_id = ?
          AND (a.name = 'GST OUTPUT A/C' OR a.name LIKE 'OUTPUT CGST %'
               OR a.name LIKE 'OUTPUT SGST %' OR a.name LIKE 'OUTPUT IGST %')`,
      [cid, cid]
    ),
    listBargains()
      .then((rows) => openOf(rows, (r) => String(r.supplier_type || 'OTHER').toUpperCase()))
      .catch(() => ({ cnt: 0, qty: 0, parts: [] })),
    listSalesBargains()
      .then((rows) => openOf(rows, (r) => (String(r.sale_type || 'LOOSE').toUpperCase() === 'PACKED' ? 'PACKED' : 'LOOSE')))
      .catch(() => ({ cnt: 0, qty: 0, parts: [] })),
    q(`SELECT pt.status, COUNT(*) AS cnt FROM purchase_tankers pt
       WHERE pt.company_id = ? AND pt.status NOT IN ('received', 'empty') GROUP BY pt.status`).catch(() => [] as Row[]),
    q(`SELECT COALESCE(SUM(qty), 0) AS bal FROM consignment_stock WHERE company_id = ?`).catch(() => [] as Row[]),
    // STOCK IS PHYSICAL, SO IT IS READ FACTORY BY FACTORY. Every company at a
    // site draws on the same floor; reading it once per company counted one
    // shortfall twice, under each company's name. Each factory in view is read
    // once, over all of its companies; a company with no factory stands alone.
    (async () => {
      const cos = toPlain(
        await c.execute('SELECT co.id, co.name, co.factory_id, f.name AS factory FROM companies co LEFT JOIN factories f ON f.id = co.factory_id')
      )
      const groups = new Map<string, { label: string; ids: number[] }>()
      for (const id of ids) {
        const co = cos.find((r) => n(r.id) === n(id))
        const fid = n(co?.factory_id)
        const key = fid ? `f${fid}` : `c${id}`
        if (groups.has(key)) continue
        groups.set(key, {
          label: fid ? String(co?.factory || co?.name || `Factory ${fid}`) : String(co?.name || id),
          ids: fid ? cos.filter((r) => n(r.factory_id) === fid).map((r) => n(r.id)) : [n(id)]
        })
      }
      return Promise.all([...groups.values()].map(async (g) => ({ label: g.label, rows: await stockLevels(undefined, g.ids) })))
    })()
  ])

  // Stock: per-category totals and the products sitting negative.
  const stockCats: Record<string, { qty: number; products: number }> = {}
  const negatives: Row[] = []
  for (const { label, rows } of levels) {
    for (const r of rows) {
      const cat = String(r.category || 'other')
      if (!stockCats[cat]) stockCats[cat] = { qty: 0, products: 0 }
      if (Math.abs(n(r.stock)) > 1e-9) {
        stockCats[cat].qty += n(r.stock)
        stockCats[cat].products++
      }
      // Named with its factory — the place it is short at.
      if (n(r.stock) < -1e-9) negatives.push({ name: `${r.name} · ${label}`, factory: label, category: r.category, stock: n(r.stock) })
    }
  }

  return {
    purchaseMonths: purchaseMonths.reverse(),
    saleMonths: saleMonths.reverse(),
    purchaseDays,
    saleDays,
    topSuppliers,
    topCustomers,
    payables,
    receivables,
    duties,
    purBargains,
    saleBargains,
    tankers,
    consignmentBalance: n(consignment[0]?.bal),
    stockCats,
    negatives: negatives.sort((a, b) => a.stock - b.stock)
  }
}
