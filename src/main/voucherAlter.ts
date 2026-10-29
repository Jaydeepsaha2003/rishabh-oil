import { getClient } from './db'
import { withDbTransaction } from './dbTransaction'
import { deleteBdRepayment, repayBd, listBdParties } from './billDiscounting'
import { deleteBdPaymentIn, postBdPaymentIn, deleteLcPaymentIn, postLcPaymentIn } from './treasury'
import { voucherOwner } from './voucherOwnership'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const round2 = (v: number): number => Math.round(v * 100) / 100

async function rows(sql: string, args: unknown[] = []): Promise<Row[]> {
  const res = await getClient().execute({ sql, args: args as never[] })
  return res.rows.map((r) => {
    const o: Row = {}
    for (const col of res.columns) o[col] = (r as unknown as Row)[col]
    return o
  })
}

// ALTERING A VOUCHER THAT A DOCUMENT WROTE.
//
// Every voucher but a purchase or a sale may now be altered from Accounting.
// None of them is altered as bare journal lines, though: what the page reads
// as a bill's dues, an LC's outstanding or a party's balance is worked out
// from the DOCUMENT behind the voucher (the repayment row, the receipt row,
// the note), so a line changed on its own would leave the document telling a
// different story from the books. Each one is altered through its document:
//
//   note, freight bill, LC, BD disbursement — opened in the editor that already
//     exists for it, which re-posts the voucher and every balance with it;
//   BD repayment, BD / LC payment in — which had no editor at all — altered
//     here by reversing the old entry and recording the corrected one through
//     the very same functions the desk uses, in ONE transaction: a figure the
//     document refuses (more than is owed, a future date…) leaves everything
//     exactly as it was.
export type AlterInfo =
  | { mode: 'manual' }
  | { mode: 'locked'; kind: 'order' | 'sale'; reason: string }
  | { mode: 'note'; note_id: number }
  | { mode: 'freight'; bill_id: number; side: string }
  | { mode: 'lc'; lc_id: number; label: string; hint: string }
  | { mode: 'bd'; bd_id: number; label: string; hint: string }
  | { mode: 'waiver'; line_id: number }
  | {
      mode: 'form'
      form: 'bd_repayment' | 'bd_payment_in' | 'lc_payment_in'
      label: string
      row: Row
      // A repayment that was one bank debit across several bills.
      shared?: { bd_id: number; bd_no: string; amount: number }[]
    }

export async function voucherAlterInfo(entryId: number): Promise<AlterInfo> {
  const id = n(entryId)
  const owner = await voucherOwner(id)
  if (!owner) return { mode: 'manual' }
  if (owner.kind === 'order' || owner.kind === 'sale') {
    return {
      mode: 'locked',
      kind: owner.kind,
      reason: `Posted from a ${owner.kind === 'order' ? 'purchase' : 'sale'} — change it on that ${owner.kind === 'order' ? 'purchase' : 'invoice'} and this voucher follows.`
    }
  }
  if (owner.kind === 'note') return { mode: 'note', note_id: owner.id }
  if (owner.kind === 'freight') {
    const b = (await rows('SELECT id, side FROM transporter_bills WHERE id = ?', [owner.id]))[0]
    return { mode: 'freight', bill_id: owner.id, side: String(b?.side || 'purchase') }
  }
  if (owner.kind === 'transporter') return { mode: 'waiver', line_id: owner.id }

  if (owner.kind === 'bd') {
    // The interest journal of a repayment opens its payment's form.
    const viaInt = (await rows('SELECT journal_entry_id FROM bd_repayments WHERE interest_entry_id = ? LIMIT 1', [id]))[0]
    const payJe = n(viaInt?.journal_entry_id) || id
    const rep = await rows('SELECT * FROM bd_repayments WHERE journal_entry_id = ? ORDER BY id', [payJe])
    if (rep.length) {
      const bdNos = await rows(
        `SELECT id, bd_no FROM bill_discountings WHERE id IN (${rep.map(() => '?').join(',')})`,
        rep.map((r) => n(r.bd_id))
      )
      const noOf = (bdId: number): string => String(bdNos.find((b) => n(b.id) === bdId)?.bd_no || bdId)
      // The row the debit was entered against is the first written; the others
      // were "also settled" by the same debit.
      const primary = rep[0]
      return {
        mode: 'form',
        form: 'bd_repayment',
        label: `Repayment of BD ${noOf(n(primary.bd_id))}`,
        row: { ...primary, bd_no: noOf(n(primary.bd_id)) },
        shared: rep.slice(1).map((r) => ({ bd_id: n(r.bd_id), bd_no: noOf(n(r.bd_id)), amount: n(r.amount) }))
      }
    }
    const pin = (await rows('SELECT * FROM bd_payment_ins WHERE journal_entry_id = ?', [id]))[0]
    if (pin) {
      return { mode: 'form', form: 'bd_payment_in', label: `Payment in on ${owner.label}`, row: pin }
    }
    const intr = (await rows('SELECT id FROM bd_interest_payments WHERE journal_entry_id = ?', [id]))[0]
    return {
      mode: 'bd',
      bd_id: owner.id,
      label: owner.label,
      hint: intr
        ? 'Interest payments are serviced in order, so one is changed by removing it on the bill and paying it again.'
        : 'Opens the bill in Treasury — change it there and the disbursement voucher, the dues and the facility follow.'
    }
  }

  if (owner.kind === 'lc') {
    const pin = (await rows('SELECT * FROM lc_payment_ins WHERE journal_entry_id = ?', [id]))[0]
    if (pin) {
      return { mode: 'form', form: 'lc_payment_in', label: `Payment in on ${owner.label}`, row: pin }
    }
    const rep = (await rows('SELECT id FROM lc_repayments WHERE journal_entry_id = ? OR fee_journal_entry_id = ?', [id, id]))[0]
    return {
      mode: 'lc',
      lc_id: owner.id,
      label: owner.label,
      hint: rep
        ? 'Opens the LC in Treasury — edit the repayment there and its voucher, the charges and the LC outstanding follow.'
        : 'Opens the LC in Treasury — edit the LC there and this voucher, its bills and the facility follow.'
    }
  }
  return { mode: 'manual' }
}

// The corrected figures for a voucher altered through a form (see above).
export async function alterOwnedVoucher(entryId: number, v: Row): Promise<{ id: number }> {
  return withDbTransaction(async () => {
    const info = await voucherAlterInfo(entryId)
    if (info.mode !== 'form') throw new Error('This voucher is altered on its own document, not here')

    if (info.form === 'bd_repayment') {
      const r = info.row
      const bdId = n(r.bd_id)
      const bd = (await rows('SELECT * FROM bill_discountings WHERE id = ?', [bdId]))[0]
      if (!bd) throw new Error('That bill no longer exists')
      const hadRelease = !!n(bd.margin_release_journal_entry_id)
      const settleVia = String(r.settle_via || 'bank') === 'party' ? 'party' : 'bank'
      // The party a party-settled repayment went against is not stored on the
      // row — it is the credit line of the voucher. Found again so the
      // re-posting settles the same ledger.
      let partyId: number | null = null
      if (settleVia === 'party') {
        const cr = (await rows(
          `SELECT a.name FROM journal_lines jl JOIN ledger_accounts a ON a.id = jl.account_id
            WHERE jl.entry_id = ? AND jl.cr > 0 ORDER BY jl.cr DESC LIMIT 1`,
          [n(r.journal_entry_id) || n(entryId)]
        ))[0]
        const parties = await listBdParties(bdId)
        const hit = parties.find((p) => String(p.name || '').trim().toUpperCase() === String(cr?.name || '').trim().toUpperCase())
        partyId = hit ? n(hit.party_id) : null
      }
      const shared = info.shared || []
      const comm = round2(n(v.comm_charges ?? r.comm_charges))
      const bank = round2(n(v.bank_charges ?? r.bank_charges))
      const charges: { account?: string; amount?: number }[] = JSON.parse(String(r.charges || '[]'))
      const extra = round2(charges.reduce((t, x) => t + n(x.amount), 0))
      // Interest paid in the same debit stays with it (bd_repayments.interest).
      const interest = round2(n(v.interest ?? r.interest))
      // One debit over several bills: this bill's share and the others' stay
      // as they were (each was what that bill owed at the time); the date,
      // bank, charges and reference can change.
      const principal = shared.length ? n(r.amount) : round2(n(v.amount ?? r.amount))
      const typed = shared.length ? round2(principal + shared.reduce((t, s) => t + s.amount, 0) + comm + bank + extra + interest) : principal
      await deleteBdRepayment(n(r.id))
      await repayBd(bdId, {
        repay_date: String(v.repay_date || r.repay_date).slice(0, 10),
        settle_via: settleVia,
        ref: v.ref !== undefined ? (v.ref ? String(v.ref) : null) : r.ref ?? null,
        release_margin: hadRelease,
        comm_charges: comm,
        bank_charges: bank,
        charges,
        interest: interest || null,
        amount: typed,
        note: v.note !== undefined ? (v.note ? String(v.note) : null) : r.note ?? null,
        party_id: partyId,
        bank_account: settleVia === 'bank' ? String(v.bank_account || r.bank_account || '') || null : null,
        also: shared.map((s) => ({ bd_id: s.bd_id, amount: s.amount })),
        tds_ledger: v.tds_ledger !== undefined ? (v.tds_ledger ? String(v.tds_ledger) : null) : r.tds_ledger ? String(r.tds_ledger) : null,
        tds_amount: v.tds_amount !== undefined ? n(v.tds_amount) : n(r.tds_amount) || null
      })
      const now = (await rows('SELECT journal_entry_id FROM bd_repayments WHERE bd_id = ? ORDER BY id DESC LIMIT 1', [bdId]))[0]
      return { id: n(now?.journal_entry_id) }
    }

    // A receipt settles the same invoices it settled before — read back off
    // its own allocations — unless the new figure is spread afresh.
    const keysOf = async (): Promise<string[]> =>
      (
        await rows(
          `SELECT DISTINCT ba.ref_name FROM journal_bill_allocs ba JOIN journal_lines jl ON jl.id = ba.line_id
            WHERE jl.entry_id = ? AND ba.ref_name IS NOT NULL AND TRIM(ba.ref_name) <> ''`,
          [n(entryId)]
        )
      ).map((x) => String(x.ref_name))

    if (info.form === 'bd_payment_in') {
      const r = info.row
      const keys = await keysOf()
      await deleteBdPaymentIn(n(r.id))
      const res = await postBdPaymentIn(
        n(r.bd_id),
        round2(n(v.amount ?? r.amount)),
        String(v.date || r.pay_date).slice(0, 10),
        keys.length ? keys : undefined,
        v.method !== undefined ? String(v.method || '') : String(r.method || ''),
        v.account !== undefined ? String(v.account || '') : String(r.account || ''),
        v.ref !== undefined ? String(v.ref || '') : String(r.ref_no || '')
      )
      return { id: n(res.id) }
    }

    if (info.form === 'lc_payment_in') {
      const r = info.row
      const keys = await keysOf()
      await deleteLcPaymentIn(n(r.id))
      const res = await postLcPaymentIn(
        n(r.lc_id),
        round2(n(v.amount ?? r.amount)),
        String(v.date || r.pay_date).slice(0, 10),
        keys.length ? keys : undefined
      )
      return { id: n(res.id) }
    }
    throw new Error('This voucher cannot be altered here')
  })
}
