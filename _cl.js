const { createClient } = require('@libsql/client/web')
const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
;(async () => {
  const ids = (await c.execute("SELECT id FROM suppliers WHERE name LIKE 'ZZ%'")).rows.map((r) => Number(r.id))
  console.log('test suppliers:', ids)
  if (ids.length) {
    const inl = ids.join(',')
    for (const q of [
      `DELETE FROM supplier_ledger WHERE supplier_id IN (${inl})`,
      `DELETE FROM payment_allocations WHERE order_id IN (SELECT id FROM orders WHERE supplier_id IN (${inl}))`,
      `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE order_id IN (SELECT id FROM orders WHERE supplier_id IN (${inl})))`,
      `DELETE FROM journal_entries WHERE order_id IN (SELECT id FROM orders WHERE supplier_id IN (${inl}))`,
      `DELETE FROM purchase_tankers WHERE supplier_id IN (${inl})`,
      `DELETE FROM orders WHERE supplier_id IN (${inl})`,
      `DELETE FROM bargain_adjustments WHERE bargain_id IN (SELECT id FROM bargains WHERE supplier_id IN (${inl}))`,
      `DELETE FROM bargains WHERE supplier_id IN (${inl})`,
      `DELETE FROM suppliers WHERE id IN (${inl})`
    ]) { try { const r = await c.execute(q); console.log('  ok', q.slice(12, 44), r.rowsAffected) } catch (e) { console.log('  ERR', q.slice(12, 44), e.message) } }
  }
  for (const q of [
    "SELECT COUNT(*) AS q FROM suppliers WHERE name LIKE 'ZZ%'",
    "SELECT COUNT(*) AS q FROM orders WHERE invoice_no LIKE 'ZZ%'",
    "SELECT COUNT(*) AS q FROM bargains WHERE bargain_no LIKE '%ZZ%'",
    "SELECT COUNT(*) AS q FROM purchase_tankers WHERE tanker_no LIKE 'ZZ%' OR tanker_no LIKE 'MAP/ZZ%' OR tanker_no LIKE 'Legacy-%'",
    "SELECT COUNT(*) AS q FROM journal_entries je LEFT JOIN orders o ON o.id = je.order_id WHERE je.order_id IS NOT NULL AND o.id IS NULL"
  ]) console.log(q.slice(21, 70), '->', (await c.execute(q)).rows[0].q)
})()
