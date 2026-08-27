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
// overdue) as a real number — paired with the column's "D" custom format so
// Excel shows e.g. "45D" / "0D" / "-4D" while staying sortable and filterable,
// unlike a hardcoded "45d left" string. Same treatment the LC register uses.
function daysLeftValue(date: unknown): number | '' {
  const s = String(date || '').slice(0, 10)
  if (!s) return ''
  return Math.round((new Date(`${s}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime()) / 86400000)
}

function daysBetween(a: unknown, b: unknown): number | '' {
  const from = String(a || '').slice(0, 10)
  const to = String(b || '').slice(0, 10)
  if (!from || !to) return ''
  return Math.max(0, Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000))
}

// The three stages a bill goes through, spelled out rather than exported as the
// internal word.
const STAGE_LABEL: Record<string, string> = {
  awaiting: 'Awaiting payment',
  live: 'Open',
  repaid: 'Repaid'
}

const PURPOSE_LABEL: Record<string, string> = {
  trading: 'Trading',
  manufacturing: 'Manufacturing'
}

const TYPE_LABEL: Record<string, string> = {
  PID: 'PID — Purchase invoice',
  SID: 'SID — Sales invoice'
}

// One flat row per discounted bill, in the same shape as the LC register: the
// facility and party first, then every stage date, then the margin / interest /
// TDS breakdown each in its own column, then what has actually been repaid.
//
// Figures are written as numbers with a currency format, never as formatted
// text, so the sheet can be totalled and sorted. Percentages and day counts
// that are genuinely absent are left blank rather than written as 0, so a
// column of zeros never gets mistaken for real terms.
export async function exportBdRegister(
  bds: Row[],
  filename: string,
  repayments: Row[] = [],
  // Every party on every bill, so a bill raised against several can be broken
  // out beneath itself.
  parties: Row[] = []
): Promise<void> {
  // Whatever filter the screen had applied is already reflected in `bds`, so the
  // repayments sheet is narrowed to the same bills rather than dumping the lot.
  const bdNos = new Set(bds.map((b) => String(b.bd_no || 'No BD no')))
  const rows: Row[] = bds.map((b) => {
    // Recomputed here rather than trusted from the row, so the sheet balances
    // even for a row that arrived without the derived fields attached.
    const amount = n(b.amount)
    // Mirrors bdCalc: margin on the invoice being discounted, what is left is
    // sanctioned, and the open amount is what was drawn against it.
    const marginBase = n(b.invoice_amount) > 0 ? n(b.invoice_amount) : amount
    const marginAmount = round2((marginBase * n(b.margin_pct)) / 100)
    const sanctionedAmount = round2(marginBase - marginAmount)
    const drawn = n(b.invoice_amount) > 0 ? amount : sanctionedAmount
    const undrawnAmount = round2(sanctionedAmount - drawn)
    const intDays = daysBetween(b.payment_received_date, b.maturity_date)
    const daysYear = n(b.days_year) || 360
    const interestAmount = round2((drawn * n(b.interest_pct) * n(intDays)) / (100 * daysYear))
    const tdsAmount = round2((interestAmount * n(b.tds_pct)) / 100)
    const receiptAmount = b.interest_upfront ? drawn : round2(drawn - interestAmount)
    const repaidTotal = round2(n(b.repaid_total))
    const stage = String(b.stage || (String(b.status) === 'repaid' ? 'repaid' : b.payment_received_date ? 'live' : 'awaiting'))
    return {
      // Marks this as a bill row rather than one of the party rows beneath it —
      // the sheet's totals count these only, so a split is never double-counted.
      _bill: true,
      bd_no: b.bd_no || 'No BD no',
      finance_type: TYPE_LABEL[String(b.finance_type || '')] || b.finance_type || '',
      nbfc: b.nbfc_name || '',
      // Several parties are named in full here; each also gets its own row below
      // with its sanctioned amount.
      party: n(b.party_count) > 1 ? String(b.party_names || b.party_name || '') : b.party_name || '—',
      party_count: n(b.party_count) > 1 ? n(b.party_count) : '',
      purpose: PURPOSE_LABEL[String(b.purpose || '')] || b.purpose || '',
      stage: STAGE_LABEL[stage] || stage,
      // Blank, not a date, while the NBFC's money is still awaited — the whole
      // point of the middle stage is that this date is not yet a fact.
      payment_received_date: b.payment_received_date ? formatDate(b.payment_received_date) : '',
      maturity_date: formatDate(b.maturity_date),
      repaid_date: b.repaid_date ? formatDate(b.repaid_date) : '',
      days_left: stage === 'repaid' ? '' : daysLeftValue(b.maturity_date),
      interest_days: intDays === '' || intDays === 0 ? '' : intDays,
      days_year: daysYear,
      invoice_amount: n(b.invoice_amount) || '',
      open_amount: amount,
      margin_pct: n(b.margin_pct) || '',
      margin_amount: marginAmount || '',
      sanctioned_amount: sanctionedAmount,
      undrawn_amount: undrawnAmount || '',
      interest_pct: n(b.interest_pct) || '',
      interest_upfront: b.interest_upfront ? 'Yes' : 'No',
      interest_amount: interestAmount || '',
      tds_pct: n(b.tds_pct) || '',
      tds_amount: tdsAmount || '',
      net_interest: round2(interestAmount - tdsAmount) || '',
      receipt_amount: receiptAmount,
      repaid_amount: repaidTotal || '',
      repay_parts: n(b.repay_parts) || '',
      outstanding_amount: round2(Math.max(0, amount - repaidTotal)),
      note: b.note || ''
    }
  })

  // A bill raised against several parties gets one row per party underneath it,
  // carrying that party's sanctioned amount. Excel puts them on an
  // outline level, so the +/- handle in the margin collapses them and the sheet
  // reads as one row per bill again.
  //
  // Interleaved rather than put on a separate sheet: the split belongs directly
  // under the bill it divides, and a reader scanning the register should not
  // have to cross-reference another tab to see who the money is for.
  const partiesByBill = new Map<string, Row[]>()
  for (const pr of parties) {
    const k = String(pr.bd_no || '')
    partiesByBill.set(k, [...(partiesByBill.get(k) || []), pr])
  }
  const withParties: Row[] = []
  for (const r of rows) {
    withParties.push(r)
    const own = partiesByBill.get(String(r.bd_no)) || []
    if (own.length < 2) continue
    for (const pr of own) {
      withParties.push({
        _bill: false,
        bd_no: '',
        finance_type: '',
        nbfc: '',
        party: `   ${pr.name || 'Unknown party'}`,
        purpose: '',
        stage: '',
        // The party's slice of the facility — the one figure that is its own,
        // and it sits under Sanctioned amt because that is what was divided.
        sanctioned_amount: n(pr.amount) || '',
        note: ''
      })
    }
  }

  // A bill can now be repaid in instalments, and the register carries only the
  // total — so the parts get their own sheet, with a running balance, rather
  // than being lost in a single figure. Only when there are any.
  const partRows: Row[] = repayments
    .filter((r) => bdNos.has(String(r.bd_no || '')))
    .map((r) => ({
      bd_no: r.bd_no || 'No BD no',
      nbfc: r.nbfc_name || '',
      party: r.party_name || '—',
      repay_date: formatDate(r.repay_date),
      amount: n(r.amount),
      settled_via: String(r.settle_via) === 'party' ? `Against ${r.party_name || 'the party'}` : 'Our bank',
      ref: r.ref || (String(r.settle_via) === 'party' ? 'On Account' : ''),
      bill_amount: n(r.bill_amount),
      note: r.note || ''
    }))

  await exportRowsToExcel({
    filename,
    sheetName: 'BD register',
    title: 'Bill Discounting — register with terms and repayments',
    columns: [
      { header: 'BD no', key: 'bd_no', width: 14 },
      { header: 'Type', key: 'finance_type', width: 22 },
      { header: 'NBFC', key: 'nbfc', width: 26 },
      { header: 'Party', key: 'party', width: 34 },
      { header: 'Parties', key: 'party_count', align: 'right', width: 9 },
      { header: 'Purpose', key: 'purpose' },
      { header: 'Stage', key: 'stage', width: 17 },
      { header: 'Payment received date', key: 'payment_received_date', width: 18, headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Maturity date', key: 'maturity_date', width: 17, headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Repaid date', key: 'repaid_date', width: 15, headerFill: 'FFDBEEF4', headerTextColor: 'FF1F2937' },
      { header: 'Days left', key: 'days_left', align: 'right', numFmt: '0"D"' },
      { header: 'Int. days', key: 'interest_days', align: 'right' },
      { header: 'Days in year', key: 'days_year', align: 'right', width: 12 },
      { header: 'Invoice amount (₹)', key: 'invoice_amount', align: 'right', numFmt: '#,##0.00', width: 17 },
      { header: 'Open amount (₹)', key: 'open_amount', align: 'right', numFmt: '#,##0.00', width: 17, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'Margin %', key: 'margin_pct', align: 'right' },
      { header: 'Margin amount (₹)', key: 'margin_amount', align: 'right', numFmt: '#,##0.00', width: 16 },
      { header: 'Sanctioned amt (₹)', key: 'sanctioned_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Balance available (₹)', key: 'undrawn_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
      { header: 'Interest % (ROI)', key: 'interest_pct', align: 'right', width: 14 },
      { header: 'Interest upfront?', key: 'interest_upfront', width: 14, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'Interest amount (₹)', key: 'interest_amount', align: 'right', numFmt: '#,##0.00', width: 17, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'TDS %', key: 'tds_pct', align: 'right' },
      { header: 'TDS amount (₹)', key: 'tds_amount', align: 'right', numFmt: '#,##0.00', width: 15 },
      { header: 'Net interest (₹)', key: 'net_interest', align: 'right', numFmt: '#,##0.00', width: 15 },
      { header: 'Net payout (₹)', key: 'receipt_amount', align: 'right', numFmt: '#,##0.00', width: 17, headerFill: 'FFF2DCDB', headerTextColor: 'FF1F2937' },
      { header: 'Repaid (₹)', key: 'repaid_amount', align: 'right', numFmt: '#,##0.00', width: 15, headerFill: 'FFE4EFE0', headerTextColor: 'FF1F2937' },
      { header: 'Repaid in parts', key: 'repay_parts', align: 'right', width: 13, headerFill: 'FFE4EFE0', headerTextColor: 'FF1F2937' },
      { header: 'Outstanding (₹)', key: 'outstanding_amount', align: 'right', numFmt: '#,##0.00', width: 17, headerFill: 'FFE4EFE0', headerTextColor: 'FF1F2937' },
      { header: 'Note', key: 'note', width: 24 }
    ],
    rows: withParties,
    // Only the bill rows are tinted and totalled; the party rows sit under them
    // on the collapsible level.
    isGroup: (r) => !!r._bill,
    outlineDetail: true,
    extraSheets: partRows.length
      ? [
          {
            sheetName: 'Repayments',
            title: 'Bill Discounting — repayments, instalment by instalment',
            subtitle: `${partRows.length} repayment${partRows.length === 1 ? '' : 's'} across ${new Set(partRows.map((r) => r.bd_no)).size} bill(s)`,
            columns: [
              { header: 'BD no', key: 'bd_no', width: 14 },
              { header: 'NBFC', key: 'nbfc', width: 26 },
              { header: 'Party', key: 'party', width: 26 },
              { header: 'Repaid on', key: 'repay_date', width: 15 },
              { header: 'Amount (₹)', key: 'amount', align: 'right', numFmt: '#,##0.00', width: 16 },
              { header: 'Settled through', key: 'settled_via', width: 26 },
              { header: 'Against bill ref.', key: 'ref', width: 20 },
              { header: 'Bill open amount (₹)', key: 'bill_amount', align: 'right', numFmt: '#,##0.00', width: 18 },
              { header: 'Note', key: 'note', width: 24 }
            ],
            rows: partRows
          }
        ]
      : undefined
  })
}
