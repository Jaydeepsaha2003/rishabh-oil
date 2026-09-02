import { exportRowsToExcel } from './excel'
import { formatDate } from './format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// One bold "deal" row per deal, followed by every purchase and sale invoice
// line under it — collapsible in Excel via the +/- outline handles (group in
// the margin to just the deal summary, ungroup to see every invoice line).
export async function exportTradingDeals(deals: Row[], filename: string): Promise<void> {
  const rows: Row[] = []

  for (const d of deals) {
    const product = d.product_code || d.product_name || ''
    rows.push({
      _group: true,
      deal_date: formatDate(d.deal_date),
      product,
      side: 'DEAL',
      // Who it was bought from and who it went to. Several buyers are named
      // in full rather than counted, so the row is still readable on its own
      // once the invoice lines under it are collapsed away.
      party: `${d.supplier_name || '—'} → ${
        Array.isArray(d.customer_names) && d.customer_names.length
          ? d.customer_names.join(', ')
          : d.customer_name || '—'
      }`,
      invoice_no: '',
      qty: n(d.purchase_qty),
      rate: '',
      value: '',
      margin: n(d.margin),
      margin_pct: n(d.margin_pct)
    })

    const pLines: Row[] = Array.isArray(d.purchase_lines) ? d.purchase_lines : []
    for (const l of pLines) {
      rows.push({
        _group: false,
        deal_date: formatDate(d.deal_date),
        product,
        side: 'Purchase',
        party: d.supplier_name || '—',
        invoice_no: l.invoice_no || '',
        qty: n(l.qty),
        rate: n(l.rate),
        value: n(l.qty) * n(l.rate),
        margin: '',
        margin_pct: ''
      })
    }

    // Each sale line carries its own buyer, so a deal split between parties
    // exports one line per invoice naming the party it was raised on — the
    // file can be filtered or pivoted by buyer without going back to the app.
    const sLines: Row[] = Array.isArray(d.sale_lines) ? d.sale_lines : []
    for (const l of sLines) {
      rows.push({
        _group: false,
        deal_date: formatDate(d.deal_date),
        product,
        side: 'Sale',
        party: l.customer_name || d.customer_name || '—',
        invoice_no: l.invoice_no || '',
        qty: n(l.qty),
        rate: n(l.rate),
        value: n(l.qty) * n(l.rate),
        margin: '',
        margin_pct: ''
      })
    }
  }

  await exportRowsToExcel({
    filename,
    sheetName: 'Trading deals',
    title: 'Purchase & Sales Trading — deals with invoice detail',
    columns: [
      { header: 'Date', key: 'deal_date' },
      { header: 'Product', key: 'product' },
      { header: 'Side', key: 'side' },
      { header: 'Party', key: 'party', width: 28 },
      { header: 'Invoice no.', key: 'invoice_no' },
      { header: 'Qty', key: 'qty', align: 'right', numFmt: '#,##0.000' },
      { header: 'Rate (₹)', key: 'rate', align: 'right', numFmt: '#,##0.00' },
      { header: 'Value (₹)', key: 'value', align: 'right', numFmt: '#,##0.00' },
      { header: 'Margin (₹)', key: 'margin', align: 'right', numFmt: '#,##0.00' },
      { header: 'Margin %', key: 'margin_pct', align: 'right', numFmt: '0.00"%"' }
    ],
    rows,
    isGroup: (r) => !!r._group,
    outlineDetail: true
  })
}
