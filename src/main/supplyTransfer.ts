// BOUGHT FROM OUR OWN COMPANY FOR AN OUTSIDE SALE.
// ---------------------------------------------------------------------------
// KR FINMARK sells to an outside customer (Surya) oil that came out of KR
// FOODS' tanks. The transfer behind it is an ordinary inter-company sale in
// KR FOODS' books — which raises KR FINMARK's purchase with it (intercompany.ts)
// and books its TDS (saleTds.ts) — raised here from the outside sale, and the
// two are tied together (sale_supply_links) and tagged on every side, so it is
// always known which purchase fed which sale. Optional per sale; asked for from
// the sale's menu.
import { getClient } from './db'
import { withCompany } from './company'
import { withDbTransaction } from './dbTransaction'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

async function ensure(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS sale_supply_links (
    sale_company_id INTEGER NOT NULL,
    sale_key TEXT NOT NULL,
    supply_company_id INTEGER NOT NULL,
    supply_group TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sale_company_id, sale_key)
  )`)
}

async function invoiceLines(saleId: number): Promise<{ key: string; lines: Row[] }> {
  const c = getClient()
  const seed = (await c.execute({ sql: 'SELECT id, invoice_group, invoice_no FROM sales WHERE id = ?', args: [n(saleId)] })).rows[0] as unknown as Row | undefined
  if (!seed) throw new Error('That invoice is no longer there')
  const key = s(seed.invoice_group || seed.invoice_no || `sale-${seed.id}`)
  const lines = (
    await c.execute({
      sql: `SELECT s.*, pr.name AS product_name, cu.company_link_id AS cu_link, cu.name AS customer_master
              FROM sales s LEFT JOIN products pr ON pr.id = s.product_id LEFT JOIN customers cu ON cu.id = s.customer_id
             WHERE ${seed.invoice_group ? 's.invoice_group = ?' : 's.id = ?'} ORDER BY s.id`,
      args: [seed.invoice_group ? s(seed.invoice_group) : n(seed.id)]
    })
  ).rows as unknown as Row[]
  return { key, lines }
}

/** The transfer behind this sale, if it has one, and what the window needs to raise one. */
export async function supplyTransferInfo(saleId: number): Promise<Row> {
  await ensure()
  const c = getClient()
  const { key, lines } = await invoiceLines(saleId)
  const first = lines[0]
  const link = (
    await c.execute({ sql: 'SELECT * FROM sale_supply_links WHERE sale_company_id = ? AND sale_key = ?', args: [n(first.company_id), key] })
  ).rows[0] as unknown as Row | undefined
  let supply: Row | null = null
  if (link) {
    const r = (
      await c.execute({
        sql: `SELECT invoice_no, sale_date, ROUND(SUM(qty), 3) AS qty, ROUND(SUM(amount), 2) AS amount
                FROM sales WHERE invoice_group = ? GROUP BY invoice_no, sale_date`,
        args: [s(link.supply_group)]
      })
    ).rows[0] as unknown as Row | undefined
    const co = (await c.execute({ sql: 'SELECT name FROM companies WHERE id = ?', args: [n(link.supply_company_id)] })).rows[0]
    supply = r ? { ...r, company_id: n(link.supply_company_id), company: s(co?.name), group: s(link.supply_group) } : null
  }
  const companies = (
    await c.execute({ sql: 'SELECT id, name FROM companies WHERE COALESCE(active, 1) = 1 AND id <> ? ORDER BY id', args: [n(first.company_id)] })
  ).rows.map((r) => ({ id: n((r as unknown as Row).id), name: s((r as unknown as Row).name) }))
  return {
    sale_id: n(first.id),
    sale_key: key,
    company_id: n(first.company_id),
    invoice_no: s(first.invoice_no),
    sale_date: s(first.sale_date).slice(0, 10),
    customer: s(first.customer_master || first.customer),
    eligible: !n(first.cu_link) && !first.return_supplier_id && !n(first.is_trading),
    lines: lines.map((l) => ({ id: n(l.id), product_id: n(l.product_id), product_name: s(l.product_name), qty: n(l.qty), uom: s(l.uom || 'MT'), rate: n(l.rate), gst_pct: n(l.gst_pct) })),
    companies,
    supply
  }
}

/** Raise the transfer (from_company → this sale's company) behind an outside sale. */
export async function raiseSupplyTransfer(v: {
  sale_id: number
  from_company_id: number
  invoice_no: string
  date?: string
  lines: { id: number; qty: number; rate: number }[]
  tags: string[]
}): Promise<{ group: string }> {
  await ensure()
  return withDbTransaction(async () => {
    const c = getClient()
    const info = await supplyTransferInfo(n(v.sale_id))
    if (!info.eligible) throw new Error('Only a sale to an outside customer can have a transfer behind it')
    if (info.supply) throw new Error(`${info.invoice_no} already has its transfer (${s(info.supply.invoice_no)})`)
    const from = n(v.from_company_id)
    if (!from || from === n(info.company_id)) throw new Error('Pick the company it was bought from')
    const invoiceNo = s(v.invoice_no).trim()
    if (!invoiceNo) throw new Error("Give the transfer its invoice number (the supplying company's)")
    const tags = Array.from(new Set((v.tags || []).map((t) => s(t).replace(/\s+/g, ' ').trim()).filter(Boolean)))
    if (!tags.length) throw new Error('Tag the transfer — it is compulsory')
    const date = s(v.date || info.sale_date).slice(0, 10)
    // The buying company as a customer in the supplier's book.
    const { ensureCompanyParties } = await import('./intercompany')
    let cust = (await c.execute({ sql: 'SELECT id, name FROM customers WHERE company_link_id = ? LIMIT 1', args: [n(info.company_id)] })).rows[0] as unknown as Row
    if (!cust) {
      await ensureCompanyParties()
      cust = (await c.execute({ sql: 'SELECT id, name FROM customers WHERE company_link_id = ? LIMIT 1', args: [n(info.company_id)] })).rows[0] as unknown as Row
    }
    if (!cust) throw new Error('No customer record stands for the buying company')
    // Same state → CGST + SGST, else IGST.
    const st = (await c.execute({ sql: 'SELECT id, state FROM companies WHERE id IN (?, ?)', args: [from, n(info.company_id)] })).rows as unknown as Row[]
    const states = st.map((r) => s(r.state).trim().toUpperCase())
    const gstType = states.length === 2 && states[0] && states[0] !== states[1] ? 'IGST' : 'CGST_SGST'
    const byId = new Map((info.lines as Row[]).map((l) => [n(l.id), l]))
    const items = (v.lines || [])
      .map((x) => ({ l: byId.get(n(x.id)), qty: n(x.qty), rate: n(x.rate) }))
      .filter((x) => x.l && x.qty > 0)
      .map((x) => ({
        product_id: n(x.l!.product_id),
        // Bulk oil out of the supplier's tank.
        sale_type: 'LOOSE',
        qty: x.qty,
        rate: x.rate,
        gst_pct: n(x.l!.gst_pct),
        gst_type: gstType
      }))
    if (!items.length) throw new Error('Give at least one line a quantity')
    if (items.some((i) => !(i.rate > 0))) throw new Error('Give every line its transfer rate')
    const { createSaleInvoice } = await import('./sales')
    const res = await withCompany(from, () =>
      createSaleInvoice({
        sale_date: date,
        invoice_no: invoiceNo,
        customer: s(cust.name),
        customer_id: n(cust.id),
        freight_term: 'FREIGHT_ON_GOODS',
        purchase_invoice_no: invoiceNo,
        force_no_stock: true,
        note: `Supplied for ${info.invoice_no} to ${info.customer}`,
        items
      })
    )
    await c.execute({
      sql: 'INSERT INTO sale_supply_links (sale_company_id, sale_key, supply_company_id, supply_group) VALUES (?, ?, ?, ?)',
      args: [n(info.company_id), s(info.sale_key), from, res.group]
    })
    // The tags: on the transfer and its paired purchase, and on the outside sale.
    const { tagTransfer } = await import('./onwardSale')
    await tagTransfer(tags, from, res.group, res.ids, n(info.company_id))
    const { createTag, ensureTagTables } = await import('./tags')
    await ensureTagTables()
    for (const name of tags) {
      const t = await createTag({ name, companyId: n(info.company_id) })
      await c.execute({ sql: 'INSERT OR IGNORE INTO tag_links (tag_id, entity, ref) VALUES (?, ?, ?)', args: [n(t.id), 'sale', s(info.sale_key)] })
    }
    // Its TDS, as every inter-company sale books it.
    await (await import('./saleTds')).autoIntercompanyTds(res.ids[0])
    return { group: res.group }
  })
}

/** Remove the transfer behind a sale: the supplier's sale (and with it the buyer's purchase and TDS). */
export async function removeSupplyTransfer(saleId: number): Promise<{ ok: true }> {
  await ensure()
  return withDbTransaction(async () => {
    const c = getClient()
    const info = await supplyTransferInfo(n(saleId))
    if (!info.supply) return { ok: true as const }
    const { deleteSaleInvoice } = await import('./sales')
    await withCompany(n(info.supply.company_id), () => deleteSaleInvoice(s(info.supply!.group)))
    await c.execute({ sql: 'DELETE FROM sale_supply_links WHERE sale_company_id = ? AND sale_key = ?', args: [n(info.company_id), s(info.sale_key)] })
    return { ok: true as const }
  })
}

/** Every link, both ways, for the Sales chips: the outside sale ↔ its transfer. */
export async function supplyLinks(): Promise<Row[]> {
  await ensure()
  const res = await getClient().execute(`
    SELECT l.sale_company_id, l.sale_key, l.supply_company_id, l.supply_group,
           (SELECT invoice_no FROM sales WHERE invoice_group = l.supply_group LIMIT 1) AS supply_invoice_no,
           (SELECT id FROM sales WHERE invoice_group = l.supply_group ORDER BY id LIMIT 1) AS supply_sale_id,
           (SELECT invoice_no FROM sales WHERE company_id = l.sale_company_id AND COALESCE(invoice_group, invoice_no, 'sale-' || id) = l.sale_key LIMIT 1) AS sale_invoice_no,
           (SELECT id FROM sales WHERE company_id = l.sale_company_id AND COALESCE(invoice_group, invoice_no, 'sale-' || id) = l.sale_key ORDER BY id LIMIT 1) AS sale_id
      FROM sale_supply_links l`)
  return res.rows.map((r) => ({ ...(r as unknown as Row) }))
}
