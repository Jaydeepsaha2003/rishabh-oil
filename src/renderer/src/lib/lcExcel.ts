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

function daysLeftLabel(date: unknown): string {
  const s = String(date || '').slice(0, 10)
  if (!s) return ''
  const d = Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
  return d < 0 ? `${-d}d overdue` : d === 0 ? 'Due today' : `${d}d left`
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

// One flat row per LC — every stage date, the FD/margin/interest/charges
// breakdown, and both amounts each in their own column, nothing tucked behind
// a generic "Date"/"Amount" pair. Only the bills and repayments underneath an
// LC are collapsible, via the +/- outline handles (group down to just the LC
// row, ungroup to see each invoice).
export async function exportLcRegister(lcs: Row[], filename: string): Promise<void> {
  const details = await Promise.all(
    lcs.map((l) =>
      Promise.all([window.api.lc.issuances(Number(l.id)), window.api.lc.repayments(Number(l.id))])
    )
  )

  const rows: Row[] = []
  lcs.forEach((l, i) => {
    const [bills, reps] = details[i]
    const marginAmount = round2((n(l.amount) * n(l.margin_pct)) / 100)
    const interestAmount = round2((n(l.amount) * n(l.interest_pct) * n(l.usance_days)) / (100 * 365))
    // A single invoice needs no +/- grouping to read — its own row folds
    // straight into the LC's row instead of sitting as a separate child.
    // Grouping is only worth it once there's more than one to collapse.
    const soleBill = bills.length === 1 ? bills[0] : null
    rows.push({
      _group: true,
      lc_no: l.lc_no || 'Pending LC no',
      bank: l.bank || '',
      supplier: l.supplier_name || '—',
      fd_no: l.fd_no || '',
      purpose: PURPOSE_LABEL[String(l.purpose || '')] || l.purpose || '',
      type: 'LC',
      stage: STAGE_LABEL[String(l.stage || 'application')] || l.stage || '',
      application_date: formatDate(l.open_date),
      open_date: formatDate(l.opened_date),
      payment_received_date: formatDate(l.payment_received_date),
      maturity_date: formatDate(l.expiry_date),
      days_left: daysLeftLabel(l.expiry_date),
      interest_days: n(l.usance_days) || '',
      margin_pct: n(l.margin_pct) || '',
      margin_amount: marginAmount,
      interest_pct: n(l.interest_pct) || '',
      interest_amount: interestAmount,
      interest_upfront: l.interest_upfront ? 'Yes' : 'No',
      charges: n(l.charges),
      open_amount: n(l.amount),
      receipt_amount: n(l.lc_net_available),
      utilized: n(l.utilized),
      repaid: n(l.repaid),
      outstanding: n(l.outstanding),
      available: n(l.available),
      linked_invoices: l.linked_invoice_nos || '',
      detail_date: soleBill ? formatDate(soleBill.issue_date) : '',
      detail_due: soleBill ? formatDate(soleBill.due_date) : '',
      detail_amount: soleBill ? n(soleBill.amount) : '',
      status: l.preclosed_date
        ? `Preclosed ${formatDate(l.preclosed_date)}`
        : soleBill
          ? (String(soleBill.status || 'outstanding') === 'settled' ? 'Settled' : 'Outstanding')
          : ''
    })

    for (const b of soleBill ? [] : bills) {
      rows.push({
        _group: false,
        lc_no: l.lc_no || 'Pending LC no',
        bank: l.bank || '',
        supplier: l.supplier_name || '—',
        fd_no: '',
        purpose: '',
        type: 'Bill',
        stage: b.bill_no || '',
        application_date: '',
        open_date: '',
        payment_received_date: '',
        maturity_date: '',
        days_left: '',
        interest_days: '',
        margin_pct: '',
        margin_amount: '',
        interest_pct: '',
        interest_amount: '',
        interest_upfront: '',
        charges: '',
        open_amount: '',
        receipt_amount: '',
        utilized: '',
        repaid: '',
        outstanding: '',
        available: '',
        linked_invoices: '',
        detail_date: formatDate(b.issue_date),
        detail_due: formatDate(b.due_date),
        detail_amount: n(b.amount),
        status: String(b.status || 'outstanding') === 'settled' ? 'Settled' : 'Outstanding'
      })
    }

    for (const r of reps) {
      rows.push({
        _group: false,
        lc_no: l.lc_no || 'Pending LC no',
        bank: l.bank || '',
        supplier: l.supplier_name || '—',
        fd_no: '',
        purpose: '',
        type: 'Repayment',
        stage: r.party_name || '',
        application_date: '',
        open_date: '',
        payment_received_date: '',
        maturity_date: '',
        days_left: '',
        interest_days: '',
        margin_pct: '',
        margin_amount: '',
        interest_pct: '',
        interest_amount: '',
        interest_upfront: '',
        charges: '',
        open_amount: '',
        receipt_amount: '',
        utilized: '',
        repaid: '',
        outstanding: '',
        available: '',
        linked_invoices: '',
        detail_date: formatDate(r.repay_date),
        detail_due: '',
        detail_amount: n(r.amount) + n(r.maturity_charges),
        status: r.posted ? 'Posted' : 'Draft'
      })
    }
  })

  await exportRowsToExcel({
    filename,
    sheetName: 'LC register',
    title: 'Letters of Credit — register with bills and repayments',
    columns: [
      { header: 'LC no', key: 'lc_no' },
      { header: 'Bank', key: 'bank' },
      { header: 'Supplier', key: 'supplier', width: 24 },
      { header: 'FD No', key: 'fd_no', width: 14 },
      { header: 'Purpose', key: 'purpose' },
      { header: 'Type', key: 'type' },
      { header: 'Stage / Ref.', key: 'stage', width: 20 },
      { header: 'Application date', key: 'application_date' },
      { header: 'Open date', key: 'open_date' },
      { header: 'Payment received date', key: 'payment_received_date', width: 18 },
      { header: 'Maturity date', key: 'maturity_date', fill: 'FFC6EFCE' },
      { header: 'Days left', key: 'days_left' },
      { header: 'Int. days', key: 'interest_days', align: 'right' },
      { header: 'Margin %', key: 'margin_pct', align: 'right' },
      { header: 'Margin amount (₹)', key: 'margin_amount', align: 'right', numFmt: '#,##0.00', width: 16 },
      { header: 'Interest % (ROI)', key: 'interest_pct', align: 'right', width: 14 },
      { header: 'Interest amount (₹)', key: 'interest_amount', align: 'right', numFmt: '#,##0.00', width: 16 },
      { header: 'Interest upfront?', key: 'interest_upfront', width: 14 },
      { header: 'LC charges (₹)', key: 'charges', align: 'right', numFmt: '#,##0.00', width: 14 },
      { header: 'LC Open Amount (₹)', key: 'open_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'LC Receipt Amount (₹)', key: 'receipt_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Utilised (₹)', key: 'utilized', align: 'right', numFmt: '#,##0.00', width: 14 },
      { header: 'Repaid (₹)', key: 'repaid', align: 'right', numFmt: '#,##0.00', width: 14 },
      { header: 'Outstanding (₹)', key: 'outstanding', align: 'right', numFmt: '#,##0.00', width: 14 },
      { header: 'Available (₹)', key: 'available', align: 'right', numFmt: '#,##0.00' },
      { header: 'Linked invoices', key: 'linked_invoices', width: 24 },
      { header: 'Invoice date', key: 'detail_date' },
      { header: 'Invoice due', key: 'detail_due' },
      { header: 'Invoice amount (₹)', key: 'detail_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Status', key: 'status', width: 16, fillFor: (r) => (r.status === 'Settled' ? 'FFC6EFCE' : undefined) }
    ],
    rows,
    isGroup: (r) => !!r._group,
    outlineDetail: true
  })
}
