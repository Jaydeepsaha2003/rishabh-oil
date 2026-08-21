import { exportRowsToExcel } from './excel'
import { formatDate } from './format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Signed day count (positive = due in future, 0 = due today, negative =
// overdue) as a real number — paired with the column's "D" custom format
// below so Excel shows e.g. "45D" / "0D" / "-4D" while staying sortable and
// filterable, unlike a hardcoded "45d left" string.
function daysLeftValue(date: unknown): number | '' {
  const s = String(date || '').slice(0, 10)
  if (!s) return ''
  return Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

const STAGE_LABEL: Record<string, string> = {
  application: 'Application',
  open: 'Open',
  payment_received: 'Payment received'
}

const PURPOSE_LABEL: Record<string, string> = {
  trading: 'Trading',
  manufacturing: 'Manufacturing'
}

// One flat row per LC, per the client's suggested format — every stage date
// and the FD/margin/interest/charges breakdown each in their own column.
export async function exportLcRegister(lcs: Row[], filename: string): Promise<void> {
  const rows: Row[] = lcs.map((l) => {
    const marginAmount = round2((n(l.amount) * n(l.margin_pct)) / 100)
    const interestAmount = round2((n(l.amount) * n(l.interest_pct) * n(l.usance_days)) / (100 * 365))
    return {
      lc_no: l.lc_no || 'Pending LC no',
      bank: l.bank_name || l.bank || '',
      supplier: l.supplier_name || '—',
      fd_no: l.fd_no || '',
      purpose: PURPOSE_LABEL[String(l.purpose || '')] || l.purpose || '',
      stage: STAGE_LABEL[String(l.stage || 'application')] || l.stage || '',
      application_date: formatDate(l.open_date),
      open_date: formatDate(l.opened_date),
      payment_received_date: formatDate(l.payment_received_date),
      maturity_date: formatDate(l.expiry_date),
      days_left: daysLeftValue(l.expiry_date),
      interest_days: n(l.usance_days) || '',
      margin_pct: n(l.margin_pct) || '',
      margin_amount: marginAmount,
      interest_pct: n(l.interest_pct) || '',
      interest_upfront: l.interest_upfront ? 'Yes' : 'No',
      interest_amount: interestAmount,
      charges: n(l.charges),
      open_amount: n(l.amount),
      receipt_amount: n(l.lc_net_available),
      linked_invoices: l.linked_invoice_nos || ''
    }
  })

  await exportRowsToExcel({
    filename,
    sheetName: 'LC register',
    title: 'Letters of Credit — register with bills and repayments',
    columns: [
      { header: 'LC no', key: 'lc_no' },
      { header: 'Discounting Bank', key: 'bank', width: 18 },
      { header: 'Supplier', key: 'supplier', width: 24 },
      { header: 'FD No', key: 'fd_no', width: 14 },
      { header: 'Purpose', key: 'purpose' },
      { header: 'Stage / Ref.', key: 'stage', width: 20 },
      { header: 'Application date', key: 'application_date', headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Open date', key: 'open_date', headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Payment received date', key: 'payment_received_date', width: 18, headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Maturity date', key: 'maturity_date', width: 17, headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Days left', key: 'days_left', align: 'right', numFmt: '0"D"' },
      { header: 'Int. days', key: 'interest_days', align: 'right' },
      { header: 'Margin %', key: 'margin_pct', align: 'right' },
      { header: 'Margin amount (₹)', key: 'margin_amount', align: 'right', numFmt: '#,##0.00', width: 16 },
      { header: 'Interest % (ROI)', key: 'interest_pct', align: 'right', width: 14 },
      { header: 'Interest upfront?', key: 'interest_upfront', width: 14, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'LC Open Amount (₹)', key: 'open_amount', align: 'right', numFmt: '#,##0.00', width: 18, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'Interest amount (₹)', key: 'interest_amount', align: 'right', numFmt: '#,##0.00', width: 16, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'LC charges (₹)', key: 'charges', align: 'right', numFmt: '#,##0.00', width: 14, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'LC Receipt Amount (₹)', key: 'receipt_amount', align: 'right', numFmt: '#,##0.00', width: 18, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'Linked invoices', key: 'linked_invoices', width: 24 }
    ],
    rows
  })
}
