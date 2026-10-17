// GST, BY HEAD AND BY RATE.
// -----------------------------------------------------------------------------
// Every rupee of tax used to land in one of two accounts: GST INPUT A/C and
// GST OUTPUT A/C. That is enough to post a voucher and not nearly enough to
// file a return. A GSTR-3B is stated head by head — CGST, SGST, IGST — and a
// GSTR-1 rate by rate, so a single figure has to be taken apart by hand every
// month out of a register that never kept the parts.
//
// So the ledger names carry both: INPUT CGST 2.5%, OUTPUT IGST 18%. The head
// comes from the transaction's own gst_type, which the documents have recorded
// all along; the rate comes from its gst_pct.
//
// AN INTRA-STATE SALE IS TWO LEDGERS, NOT ONE. 5% CGST+SGST is 2.5% of central
// tax and 2.5% of state tax, and they are separate liabilities to separate
// governments — the one figure this app used to post was never a real account,
// it was two accounts added together. So a CGST_SGST amount becomes two lines
// of half each, and an IGST amount stays one.
//
// The halves are struck so they add back exactly: the second takes whatever the
// first's rounding left, which is what keeps a voucher balanced when an odd
// paisa of tax cannot be halved evenly.
import type { JournalLine } from './journal'

export type GstType = 'IGST' | 'CGST_SGST'

const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * A rate as it reads in a ledger name: 5, 2.5, 18, 0.5 — never 2.50 or 18.0.
 *
 * One spelling per rate, because two spellings are two ledgers. "2.5%" and
 * "2.50%" are the same tax and would otherwise sit in different accounts,
 * each holding half a year.
 */
export function gstRateLabel(pct: number): string {
  const r = Math.round((Number(pct) || 0) * 1000) / 1000
  return String(r)
}

/** The ledger a GST amount belongs in. */
export function gstLedgerName(side: 'INPUT' | 'OUTPUT', head: 'CGST' | 'SGST' | 'IGST', pct: number): string {
  return `${side} ${head} ${gstRateLabel(pct)}%`
}

/** Anything this app posts GST to, for the readers that need to find them all. */
export const GST_LEDGER_LIKE = ['INPUT CGST %', 'INPUT SGST %', 'INPUT IGST %', 'OUTPUT CGST %', 'OUTPUT SGST %', 'OUTPUT IGST %']

/**
 * The one or two journal lines a GST amount becomes.
 *
 * `dr`/`cr` rather than a direction inferred from the side, because a note
 * reverses it: a credit note against a sale DEBITS output GST. The side names
 * the account; the caller names the direction.
 */
export function gstLines(a: {
  side: 'INPUT' | 'OUTPUT'
  pct: number
  type: GstType | string | null | undefined
  dr?: number
  cr?: number
  group?: string
}): JournalLine[] {
  const group = a.group || 'Duties & Taxes'
  const dr = Number(a.dr) || 0
  const cr = Number(a.cr) || 0
  const total = dr > 0.004 ? dr : cr
  if (!(total > 0.004)) return []
  const pct = Number(a.pct) || 0
  const put = (account: string, amount: number): JournalLine =>
    dr > 0.004 ? { account, group, dr: amount } : { account, group, cr: amount }

  if (String(a.type || '') === 'IGST') {
    return [put(gstLedgerName(a.side, 'IGST', pct), total)]
  }
  // EXACTLY HALF EACH, AND NOT A ROUNDED HALF.
  //
  // CGST and SGST are the same number by law, and a return is rejected when
  // they are not. Rounding one half to paise and giving the other the
  // remainder keeps the voucher exact but leaves the two heads a paisa apart
  // on every odd line — seventeen paise across a year of sales here, which is
  // seventeen paise somebody has to explain.
  //
  // Splitting the figure as it stands gives both: the halves are identical,
  // and they add back to precisely the tax that was posted. These books
  // already hold tax unrounded — a real purchase line is 42,121.386… — so a
  // half carrying a third decimal is the register's own habit, not a new one.
  const half = total / 2
  const each = pct / 2
  return [
    put(gstLedgerName(a.side, 'CGST', each), half),
    put(gstLedgerName(a.side, 'SGST', each), half)
  ].filter((l) => (Number(l.dr) || 0) + (Number(l.cr) || 0) > 0.004)
}

/**
 * WHICH TYPE A DOCUMENT WITHOUT ONE SHOULD USE.
 *
 * Notes and transporter bills carry a rate but no gst_type: a note is written
 * against something else and takes that thing's treatment, and a freight bill
 * is almost always from a carrier in the same state. So a named reference
 * decides it where there is one, and intra-state stands in where there is not
 * — which is the conservative answer, because it splits into two heads rather
 * than lumping a state tax into the central one.
 */
export const DEFAULT_GST_TYPE: GstType = 'CGST_SGST'

export function asGstType(v: unknown): GstType {
  return String(v || '') === 'IGST' ? 'IGST' : 'CGST_SGST'
}
