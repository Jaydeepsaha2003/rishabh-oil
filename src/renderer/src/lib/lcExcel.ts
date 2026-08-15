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

// One bold "LC" row per letter of credit, followed by every bill issued
// under it and every repayment logged against it — collapsible in Excel via
// the +/- outline handles (group down to just the LC summary, ungroup to see
// every bill and repayment).
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
      reference: STAGE_LABEL[String(l.stage || 'application')] || l.stage || '',
      date: formatDate(l.open_date),
      due: formatDate(l.expiry_date),
      days_left: daysLeftLabel(l.expiry_date),
      interest_days: n(l.usance_days) || '',
      margin_pct: n(l.margin_pct) ? `${n(l.margin_pct)}%` : '',
      amount: n(l.amount),
      available: n(l.available),
      status: ''
    })

    for (const b of bills) {
      rows.push({
        _group: false,
        lc_no: l.lc_no || 'Pending LC no',
        bank: l.bank || '',
        supplier: l.supplier_name || '—',
        type: 'Bill',
        reference: b.bill_no || '',
        date: formatDate(b.issue_date),
        due: formatDate(b.due_date),
        days_left: '',
        interest_days: '',
        margin_pct: '',
        amount: n(b.amount),
        available: '',
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
        reference: r.party_name || '',
        date: formatDate(r.repay_date),
        due: '',
        days_left: '',
        interest_days: '',
        margin_pct: '',
        amount: n(r.amount) + n(r.maturity_charges),
        available: '',
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
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Date', key: 'date' },
      { header: 'Due / maturity', key: 'due' },
      { header: 'Days left', key: 'days_left' },
      { header: 'Int. days', key: 'interest_days', align: 'right' },
      { header: 'Margin %', key: 'margin_pct', align: 'right' },
      { header: 'Amount (₹)', key: 'amount', align: 'right', numFmt: '#,##0.00' },
      { header: 'Available (₹)', key: 'available', align: 'right', numFmt: '#,##0.00' },
      { header: 'Status', key: 'status' }
    ],
    rows,
    isGroup: (r) => !!r._group,
    outlineDetail: true
  })
}
