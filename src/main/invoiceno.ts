import { getClient } from './db'

// An invoice number is the name of one document. Two documents wearing the same
// name cannot be told apart afterwards: a payment allocated against "KRFL/401"
// has two candidates, a ledger reference points at either, and the gap report
// counts one number where two bills exist.
//
// Held here rather than in sales.ts and orders.ts separately because trading
// books through the very same createOrder/createSale, so guarding those four
// functions covers purchases, sales, trading purchases and trading sales at
// once — four flows, one rule, no fifth path to forget.
//
// Scoped per company. The two books number their documents independently, so
// KR FOODS and KR FINMARK may each hold an invoice of the same number and
// always could. Purchases and sales are separate namespaces too: a supplier's
// bill number has nothing to do with one of ours.
//
// Compared trimmed and case-insensitively, since "krfl/401 " and "KRFL/401" are
// the same number typed twice — a collision that slips through on whitespace is
// worse than no rule at all.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const key = (v: unknown): string => String(v ?? '').trim().toUpperCase()

// Ids to leave out of the search, over and above the row being saved.
//
// Trading needs this. updateTradingDeal reuses its rows positionally, one
// updateOrder at a time, so swapping two lines' invoice numbers would have the
// first update collide with the second row's number as it stood a moment
// earlier — a refusal for a rearrangement that ends up perfectly valid. The
// deal passes its own line ids and its lines are checked against each other
// instead (see assertNoRepeatsWithin).
function excluded(v: Row, id?: number): number[] {
  const extra = Array.isArray(v?.invoice_dup_exclude_ids)
    ? v.invoice_dup_exclude_ids.map((x: unknown) => Number(x)).filter((x: number) => x > 0)
    : []
  return id ? [...extra, id] : extra
}

function notIn(col: string, ids: number[]): string {
  return ids.length ? ` AND ${col} NOT IN (${ids.map(() => '?').join(',')})` : ''
}

// A PURCHASE invoice number, unique within the company — with one exception,
// for the same reason the sales rule has one.
//
// A purchase row is ONE PRODUCT. An inter-company transfer of three products
// therefore raises three purchase rows, and they are not three bills: they are
// one bill, with one number, which the other company books once. Read per row,
// the rule refused the second product of every transfer — correctly by its own
// logic and wrongly in fact.
//
// So the rows of one bill are stamped with a shared bill_group and rows of the
// same group are not rivals. Two things write it: an inter-company transfer
// (intercompany.ts) and a tanker invoice covering more than one product. NULL
// on every ordinary purchase, which leaves the rule exactly as it was for them.
//
// `id` is the order being updated, if any. A purchase keeping the number it
// already has is always allowed — see the note in assertSalesInvoiceNoFree.
export async function assertPurchaseInvoiceNoFree(v: Row, companyId: number, id?: number): Promise<void> {
  const want = key(v?.invoice_no)
  if (!want) return
  const c = getClient()

  if (id) {
    const own = await c.execute({ sql: 'SELECT invoice_no FROM orders WHERE id = ?', args: [id] })
    if (own.rows.length && key(own.rows[0].invoice_no) === want) return
  }

  // The bill this row belongs to. A row with no group is a bill of its own,
  // keyed by its id — and NULLIF so that a blank stamped instead of a null
  // cannot quietly make every ungrouped purchase one bill together.
  const group = String(v?.bill_group || '').trim()
  const mine = group ? group : id ? `row:${id}` : 'row:0'
  const skip = excluded(v, id)
  const res = await c.execute({
    sql: `SELECT o.id, o.invoice_no, o.order_date, s.name AS party
            FROM orders o LEFT JOIN suppliers s ON s.id = o.supplier_id
           WHERE o.company_id = ? AND UPPER(TRIM(COALESCE(o.invoice_no,''))) = ?
             AND COALESCE(NULLIF(TRIM(o.bill_group), ''), 'row:' || o.id) <> ?
                 ${notIn('o.id', skip)}
           ORDER BY o.id LIMIT 1`,
    args: [companyId, want, mine, ...skip]
  })
  if (!res.rows.length) return
  const hit = res.rows[0] as unknown as Row
  throw new Error(
    `Purchase invoice ${String(v.invoice_no).trim()} is already booked in this company` +
      `${hit.party ? ` — ${hit.party}` : ''}${hit.order_date ? `, ${String(hit.order_date).slice(0, 10)}` : ''}. ` +
      'Two purchases cannot share one invoice number.'
  )
}

// A SALES invoice number, unique within the company — but one invoice may of
// course cover several products, and each of those lines is its own sales row
// sharing an invoice_group. So the rule is one number per INVOICE, not per row:
// 47 numbers in the live books legitimately span more than one line, and a
// naive per-row rule would have refused the second line of every one of them.
//
// A row with no group counts as an invoice of its own (trading sales are
// written line by line and carry none), keyed by its id.
//
// `allowExistingNumber` is for updateSaleInvoice, which edits by deleting every
// line and building them again. By the time the lines are re-created the
// originals are gone, so a number this invoice has held all along would read as
// somebody else's — the caller says so, having looked before deleting.
export async function assertSalesInvoiceNoFree(
  v: Row,
  companyId: number,
  id?: number,
  allowExistingNumber?: boolean
): Promise<void> {
  const want = key(v?.invoice_no)
  if (!want || allowExistingNumber) return
  const c = getClient()

  if (id) {
    const own = await c.execute({ sql: 'SELECT invoice_no FROM sales WHERE id = ?', args: [id] })
    if (own.rows.length && key(own.rows[0].invoice_no) === want) return
  }

  // The invoice this row belongs to. Rows of the same invoice are not rivals.
  const group = String(v?.invoice_group || '').trim()
  const mine = group ? group : id ? `row:${id}` : 'row:0'
  const skip = excluded(v, id)
  const res = await c.execute({
    sql: `SELECT s.id, s.invoice_no, s.sale_date, cu.name AS party
            FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
           WHERE s.company_id = ? AND UPPER(TRIM(COALESCE(s.invoice_no,''))) = ?
             AND COALESCE(s.invoice_group, 'row:' || s.id) <> ?
                 ${notIn('s.id', skip)}
           ORDER BY s.id LIMIT 1`,
    args: [companyId, want, mine, ...skip]
  })
  if (!res.rows.length) return
  const hit = res.rows[0] as unknown as Row
  throw new Error(
    `Invoice ${String(v.invoice_no).trim()} is already used in this company` +
      `${hit.party ? ` — ${hit.party}` : ''}${hit.sale_date ? `, ${String(hit.sale_date).slice(0, 10)}` : ''}. ` +
      'Give this one a number of its own.'
  )
}

// Two lines of the SAME trading deal (or the same set being saved) holding one
// invoice number. Caught here because the per-row guards deliberately ignore
// the deal's own rows so a rearrangement can go through — which would otherwise
// leave the one case they cannot see: a genuine repeat inside the deal.
export function assertNoRepeatsWithin(numbers: unknown[], what: string): void {
  const seen = new Map<string, number>()
  for (let i = 0; i < numbers.length; i++) {
    const k = key(numbers[i])
    if (!k) continue
    const first = seen.get(k)
    if (first !== undefined) {
      throw new Error(
        `${what} ${String(numbers[i]).trim()} is on two lines of this deal (lines ${first + 1} and ${i + 1}). ` +
          'Each line is its own invoice, so each needs its own number.'
      )
    }
    seen.set(k, i)
  }
}

/**
 * A PLACEHOLDER NUMBER FOR A BILL THAT DOES NOT HAVE ONE YET.
 *
 * Some suppliers never print an invoice number on the paper they hand over,
 * and the desk still needs one to file the purchase under — the field is
 * required, and typing something meaningless by hand just moves the same
 * problem into the books. Seven digits reads like a real invoice number
 * rather than a code, and it is checked against every OTHER purchase already
 * booked for this company before it is handed back, so it can never collide
 * with one that already exists.
 */
export async function randomPurchaseInvoiceNo(companyId: number): Promise<string> {
  const c = getClient()
  for (let tries = 0; tries < 40; tries++) {
    const candidate = String(1000000 + Math.floor(Math.random() * 9000000))
    const hit = await c.execute({
      sql: 'SELECT id FROM orders WHERE company_id = ? AND UPPER(TRIM(invoice_no)) = ? LIMIT 1',
      args: [companyId, candidate]
    })
    if (!hit.rows.length) return candidate
  }
  // Astronomically unlikely with nine million numbers to draw from — but a
  // loop that could theoretically return nothing must still return something.
  throw new Error('Could not find a free invoice number — try again')
}

/** The same placeholder, for a sale with nothing of its own to file under. */
export async function randomSalesInvoiceNo(companyId: number): Promise<string> {
  const c = getClient()
  for (let tries = 0; tries < 40; tries++) {
    const candidate = String(1000000 + Math.floor(Math.random() * 9000000))
    const hit = await c.execute({
      sql: 'SELECT id FROM sales WHERE company_id = ? AND UPPER(TRIM(invoice_no)) = ? LIMIT 1',
      args: [companyId, candidate]
    })
    if (!hit.rows.length) return candidate
  }
  throw new Error('Could not find a free invoice number — try again')
}
