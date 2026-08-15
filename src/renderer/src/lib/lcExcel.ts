import { exportRowsToExcel } from './excel'
import { formatDate } from './format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

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

// One flat row per LC — every stage date and both amounts in their own
// column, nothing tucked behind a generic "Date"/"Amount" pair. Only the
// bills and repayments underneath an LC are collapsible, via the +/- outline
// handles (group down to just the LC row, ungroup to see each invoice).
export async function exportLcRegister(lcs: Row[], filename: string): Promise<void> {
  const details = await Promise.all(
    lcs.map((l) =>
      Promise.all([window.api.lc.issuances(Number(l.id)), window.api.lc.repayments(Number(l.id))])
    )
  )

  const rows: Row[] = []
  lcs.forEach((l, i) => {
    const [bills, reps] = details[i]
    rows.push({
      _group: true,
      lc_no: l.lc_no || 'Pending LC no',
      bank: l.bank || '',
      supplier: l.supplier_name || '—',
      type: 'LC',
      stage: STAGE_LABEL[String(l.stage || 'application')] || l.stage || '',
      application_date: formatDate(l.open_date),
      open_date: formatDate(l.opened_date),
      payment_received_date: formatDate(l.payment_received_date),
      maturity_date: formatDate(l.expiry_date),
      days_left: daysLeftLabel(l.expiry_date),
      interest_days: n(l.usance_days) || '',
      margin_pct: n(l.margin_pct) ? `${n(l.margin_pct)}%` : '',
      open_amount: n(l.amount),
      receipt_amount: n(l.lc_net_available),
      available: n(l.available),
      detail_date: '',
      detail_due: '',
      detail_amount: '',
      status: ''
    })

    for (const b of bills) {
      rows.push({
        _group: false,
        lc_no: l.lc_no || 'Pending LC no',
        bank: l.bank || '',
        supplier: l.supplier_name || '—',
        type: 'Bill',
        stage: b.bill_no || '',
        application_date: '',
        open_date: '',
        payment_received_date: '',
        maturity_date: '',
        days_left: '',
        interest_days: '',
        margin_pct: '',
        open_amount: '',
        receipt_amount: '',
        available: '',
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
        type: 'Repayment',
        stage: r.party_name || '',
        application_date: '',
        open_date: '',
        payment_received_date: '',
        maturity_date: '',
        days_left: '',
        interest_days: '',
        margin_pct: '',
        open_amount: '',
        receipt_amount: '',
        available: '',
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
      { header: 'Type', key: 'type' },
      { header: 'Stage / Ref.', key: 'stage', width: 20 },
      { header: 'Application date', key: 'application_date' },
      { header: 'Open date', key: 'open_date' },
      { header: 'Payment received date', key: 'payment_received_date', width: 18 },
      { header: 'Maturity date', key: 'maturity_date', fill: 'FFC6EFCE' },
      { header: 'Days left', key: 'days_left' },
      { header: 'Int. days', key: 'interest_days', align: 'right' },
      { header: 'Margin %', key: 'margin_pct', align: 'right' },
      { header: 'LC Open Amount (₹)', key: 'open_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'LC Receipt Amount (₹)', key: 'receipt_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Available (₹)', key: 'available', align: 'right', numFmt: '#,##0.00' },
      { header: 'Invoice date', key: 'detail_date' },
      { header: 'Invoice due', key: 'detail_due' },
      { header: 'Invoice amount (₹)', key: 'detail_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Status', key: 'status' }
    ],
    rows,
    isGroup: (r) => !!r._group,
    outlineDetail: true
  })
}
