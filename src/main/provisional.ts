import { getClient } from './db'
import { getActiveCompanyId } from './company'
import { resolveAccountName } from './ledgerMap'
import { partyAccountName } from './partyLedgers'
import { bdPendingPayout } from './billDiscounting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

// PROVISIONAL: WHAT AN OPEN LC OR BILL WILL PUT ON A SUPPLIER'S LEDGER.
//
// An LC at its Open stage, and a supplier-direct bill discounting still
// awaiting the NBFC's money, post nothing yet — the supplier's ledger first
// moves at payment (Dr supplier, settleLcBillsCombined / postBdOpening). With
// Provisional switched on, the ledger shows that coming debit now, as a line
// of its own, so the balance reads as it will once paid. Nothing is posted:
// these rows exist only in the statement, and the day the payment is booked
// the real voucher takes the provisional line's place.
//
// Suppliers only: no bill discounting or LC debits or credits a customer's
// ledger when the money arrives (a SID's receipt goes to the bank).
export async function provisionalEntries(accountId: number, companyId?: number): Promise<Row[]> {
  const c = getClient()
  const cid = companyId || getActiveCompanyId()
  const acc = (await c.execute({ sql: 'SELECT name FROM ledger_accounts WHERE id = ?', args: [accountId] })).rows[0] as unknown as Row | undefined
  if (!acc) return []
  const want = String(acc.name || '').trim().toUpperCase()
  // The ledger a supplier's payment line lands on, by the posting rule itself.
  const isThis = async (name: string): Promise<boolean> => {
    const asked = await partyAccountName(String(name || '').trim().toUpperCase(), 'Sundry Creditors', cid)
    return String((await resolveAccountName(asked, cid)) || asked).trim().toUpperCase() === want
  }
  const out: Row[] = []

  const lcs = await c.execute({
    sql: `SELECT lc.id, lc.lc_no, lc.amount, lc.bank, COALESCE(lc.opened_date, lc.open_date) AS d, s.name AS supplier
            FROM letters_of_credit lc JOIN suppliers s ON s.id = lc.party_id
           WHERE lc.company_id = ? AND lc.party_type = 'supplier' AND lc.stage = 'open'
             AND COALESCE(lc.workflow_status, 'in_progress') = 'in_progress'`,
    args: [cid]
  })
  for (const r of lcs.rows as unknown as Row[]) {
    if (!(n(r.amount) > 0) || !(await isThis(String(r.supplier)))) continue
    out.push({
      id: -(1_000_000 + n(r.id)),
      entry_id: null,
      entry_date: String(r.d || '').slice(0, 10),
      vch_type: 'PROVISIONAL',
      vch_no: '',
      particulars: `LC ${String(r.lc_no || '')} · ${String(r.bank || '').trim() || 'bank'}`,
      narration: `Provisional — LC ${String(r.lc_no || '')} is open; the bank's payment to the supplier will debit this ledger`,
      dr: n(r.amount),
      cr: 0,
      lc_id: n(r.id),
      lc_no: String(r.lc_no || ''),
      provisional: true
    })
  }

  const bds = await c.execute({
    sql: `SELECT id FROM bill_discountings
           WHERE company_id = ? AND finance_type = 'PID' AND disbursement_route = 'supplier'
             AND payment_received_date IS NULL AND COALESCE(status, 'open') <> 'repaid'`,
    args: [cid]
  })
  for (const b of bds.rows as unknown as Row[]) {
    const { bd, parts } = await bdPendingPayout(n(b.id))
    for (const [k, p] of parts.entries()) {
      if (!(p.amount > 0) || !(await isThis(p.name))) continue
      out.push({
        id: -(2_000_000 + n(b.id) * 10 + k),
        entry_id: null,
        entry_date: String(bd.created_at || '').slice(0, 10),
        vch_type: 'PROVISIONAL',
        vch_no: '',
        particulars: `BD ${String(bd.bd_no || '')} · ${String(bd.nbfc_name || 'NBFC')}`,
        narration: `Provisional — BD ${String(bd.bd_no || '')} awaits the NBFC's payment; paid straight to the supplier, it will debit this ledger`,
        dr: p.amount,
        cr: 0,
        bd_id: n(b.id),
        bd_no: String(bd.bd_no || ''),
        provisional: true
      })
    }
  }
  return out.sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)))
}
