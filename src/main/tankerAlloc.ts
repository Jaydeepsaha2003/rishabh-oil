// ONE TANKER, SEVERAL INVOICES.
//
// A tanker carries its invoice on `purchase_tankers.order_id` — one invoice,
// the whole tanker. Suppliers also split one lorry over two (or more) bills:
// 30 MT loaded, billed 18 on one invoice and 12 on another, each with its own
// number. The tanker stays ONE record — it is one lorry, weighed once at the
// gate, emptied once — and `tanker_invoices` says which invoice took how much
// of it.
//
// The rule every reader follows:
//   * a tanker with rows in tanker_invoices is shared out exactly as they say,
//     and its order_id is the first (primary) of those invoices;
//   * a tanker with NO rows is the whole tanker on its order_id, which is every
//     tanker booked before this existed. Nothing old moves.
//
// ALLOC is that rule as a table expression: (tanker_id, order_id, qty), one row
// per invoice a tanker is on.
import { getClient } from './db'

export async function ensureTankerInvoices(): Promise<void> {
  await getClient().execute(`CREATE TABLE IF NOT EXISTS tanker_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tanker_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      qty REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tanker_id, order_id)
    )`)
  await getClient().execute('CREATE INDEX IF NOT EXISTS idx_tanker_invoices_order ON tanker_invoices(order_id)')
  // How much of the invoice's share sits on the tanker's EXCESS bargain (see
  // lib/tankerShare.ts). NULL on rows saved before it: those split in proportion.
  const cols = await getClient().execute('PRAGMA table_info(tanker_invoices)')
  if (!cols.rows.some((r) => String(r.name) === 'extra_part')) {
    await getClient().execute('ALTER TABLE tanker_invoices ADD COLUMN extra_part REAL')
  }
}

export const ALLOC = `(SELECT ti.tanker_id AS tanker_id, ti.order_id AS order_id, ti.qty AS qty, ti.extra_part AS extra_part FROM tanker_invoices ti
  UNION ALL
  SELECT pt0.id AS tanker_id, pt0.order_id AS order_id, pt0.loaded_qty AS qty,
         CASE WHEN pt0.extra_bargain_id IS NOT NULL THEN COALESCE(pt0.extra_qty, 0) ELSE 0 END AS extra_part
    FROM purchase_tankers pt0
   WHERE pt0.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tanker_invoices ti0 WHERE ti0.tanker_id = pt0.id))`
