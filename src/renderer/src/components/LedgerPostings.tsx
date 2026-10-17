import { useRef } from 'react'
import { useDrawerEscape } from '@/lib/escape'
// WHAT THIS DOCUMENT PUT IN THE LEDGERS.
// -----------------------------------------------------------------------------
// Every purchase, sale, letter of credit and discounted bill writes into the
// books, and until now the only way to see what it wrote was to leave the page,
// open the Day Book, and find the voucher — knowing already what date and what
// figure to look for. That is fine for one purchase, which posts one voucher.
// It is not workable for an LC, which posts its opening, its interest, its
// charges, every bill settled against it, every repayment and every receipt,
// scattered across months.
//
// So it is a panel from the right, opened from the ⋮ on the document itself,
// showing each voucher the way a voucher is read: its type and its number at
// the top, then particulars with debit and credit in two columns, then the
// total across both. The register stays behind the scrim, because this is
// something you check against the thing you were already looking at.
//
// Two lists, because they are two different facts. POSTED BY says what this
// document itself wrote. SETTLED AGAINST says which receipts and payments were
// put against it — those belong to the money, not to the invoice, and saying
// so is the difference between "this bill posted four vouchers" and "this bill
// posted one and has been paid three times".
//
// Read-only throughout. Nothing here writes.
import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownLeft, BookOpen, Loader2, X } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isTaxByGroup, orderVoucherLines } from '@/lib/voucherOrder'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const s = (v: unknown): string => (v == null ? '' : String(v))

export interface PostingTarget {
  entity: 'order' | 'sale' | 'lc' | 'bd' | 'trading'
  id: number
  /** What kind of document it is — the small line above the name. */
  kicker: string
  /** Its own number: the invoice no, the LC no, the BD no. */
  title: string
  /** Who and when, in one line. */
  subtitle?: string
}

/** The document's own number, dimmed when it has none yet. */
function Head({
  target,
  onClose
}: {
  target: PostingTarget
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none bg-[#0B3D2E] px-5 py-4 text-white">
      <div className="flex items-start justify-between gap-3.5">
        <div className="min-w-0">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
            Ledger posting
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <span
              className={cn(
                'doc-ref text-[18px] font-bold tracking-[-0.02em]',
                !target.title && 'italic opacity-70'
              )}
            >
              {target.title || 'No number'}
            </span>
            <span className="rounded-[2px] bg-white/[.14] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[.06em]">
              {target.kicker}
            </span>
          </div>
          {!!target.subtitle && (
            <div className="mt-2 min-w-0 text-[12px] font-bold text-[#DCEFE4] [overflow-wrap:anywhere]">
              {target.subtitle}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="-mr-1.5 -mt-1.5 flex h-9 w-9 flex-none items-center justify-center rounded-[3px] text-[#8FBFA8] transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  )
}

/** One voucher, drawn the way a voucher is read. */
function Voucher({ p }: { p: Row }): React.JSX.Element {
  // Debits first, then credits, each biggest first — however it was entered.
  const lines: Row[] = orderVoucherLines(Array.isArray(p.lines) ? (p.lines as Row[]) : [], (l) => ({
    account: s(l.account),
    dr: n(l.dr) > 0,
    tax: isTaxByGroup(s(l.account), s(l.acc_group)),
    amount: n(l.dr) > 0 ? n(l.dr) : n(l.cr)
  }))
  // THE TOTAL IS THE BOOKS' TOTAL, not the sum of the rounded lines above it.
  // A purchase line is held at full precision and shown to the paisa; add four
  // of those rounded figures and you can land a paisa away from what the
  // voucher actually is. The lines are what was posted, rounded for reading;
  // this is what it comes to.
  const dr = n(p.amount)
  const cr = n(p.credit)
  const settle = n(p.allocated) > 0
  return (
    <div
      className={cn(
        'flex-none overflow-hidden rounded-[4px] border bg-white',
        settle ? 'border-[#C6DAF0]' : 'border-[#D6E2D6]'
      )}
    >
      {/* ------------------------------------------------------------ head */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b px-3.5 py-[11px]',
          settle ? 'border-b-[#C6DAF0] bg-[#F4F8FD]' : 'border-b-[#E4ECE3] bg-[#F7FAF6]'
        )}
      >
        {/* THE VOUCHER NUMBER, which is the thing being looked for.
            It is the running serial the ledgers themselves print — PUR/51,
            JV/31 — so a figure found here can be taken straight to the Day
            Book and matched. */}
        <span
          className={cn(
            'doc-ref flex-none rounded-[2px] px-2 py-[3px] text-[11.5px] font-extrabold tracking-[.02em]',
            settle ? 'bg-[#E4EEF9] text-[#1B4E82]' : 'bg-[#EAF0E9] text-[#0B3D2E]'
          )}
        >
          {s(p.code) || s(p.vch_type) || 'Voucher'}
        </span>
        <span
          className={cn(
            'flex-none text-[10px] font-extrabold uppercase tracking-[.1em]',
            settle ? 'text-[#1B4E82]' : 'text-[#33473E]'
          )}
        >
          {s(p.vch_type)}
        </span>
        <span className="text-[11.5px] font-bold text-[#5A6B62]">{s(p.role)}</span>
        <span className="ml-auto flex-none text-[11.5px] font-bold tabular-nums text-[#33473E]">
          {formatDate(p.entry_date)}
        </span>
      </div>

      {/* ----------------------------------------------------- particulars */}
      {/* THE MONEY COLUMNS TAKE WHAT THEY NEED, PARTICULARS TAKES THE REST.
          A fixed width held 53,27,024.00 and clipped 1,98,00,000.00, and there
          is no one width that is right for both — these books run from a few
          thousand rupees to nine figures. `w-px` with nowrap under auto layout
          is shrink-to-fit: each money column ends up exactly as wide as its
          widest figure, and `w-full` on Particulars soaks up the rest. */}
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-b-[#EEF3ED]">
            <th className="w-full px-3.5 py-1.5 text-left text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
              Particulars
            </th>
            <th className="w-px whitespace-nowrap px-3 py-1.5 text-right text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
              Debit
            </th>
            <th className="w-px whitespace-nowrap px-3.5 py-1.5 text-right text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
              Credit
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${s(l.account)}-${i}`} className="border-b border-b-[#F2F6F1] last:border-b-0">
              <td className="px-3.5 py-2 align-top">
                {/* Dr and Cr said in words as well as by column, because a
                    ledger read on a phone has the two columns close enough
                    together to be taken for one. */}
                <span
                  className={cn(
                    'mr-1.5 text-[10px] font-extrabold uppercase tracking-[.08em]',
                    n(l.dr) > 0 ? 'text-[#0B6B45]' : 'text-[#1B4E82]'
                  )}
                >
                  {n(l.dr) > 0 ? 'Dr' : 'Cr'}
                </span>
                <span className="text-[12.5px] font-bold text-[#0A1F17] [overflow-wrap:anywhere]">
                  {s(l.account)}
                </span>
                <div className="mt-[1px] text-[10.5px] font-semibold text-[#8CA396] [overflow-wrap:anywhere]">
                  {s(l.acc_group)}
                </div>
              </td>
              <td className="w-px whitespace-nowrap px-3 py-2 text-right align-top font-bold tabular-nums text-[#0A1F17]">
                {n(l.dr) > 0 ? formatINR(l.dr) : <span className="text-[#C3D2C6]">—</span>}
              </td>
              <td className="w-px whitespace-nowrap px-3.5 py-2 text-right align-top font-bold tabular-nums text-[#0A1F17]">
                {n(l.cr) > 0 ? formatINR(l.cr) : <span className="text-[#C3D2C6]">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-t-[#D6E2D6] bg-[#F7FAF6]">
            <td className="px-3.5 py-2 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#33473E]">
              Total
            </td>
            <td className="w-px whitespace-nowrap px-3 py-2 text-right text-[12.5px] font-bold tabular-nums text-[#0A1F17]">
              {formatINR(dr)}
            </td>
            <td className="w-px whitespace-nowrap px-3.5 py-2 text-right text-[12.5px] font-bold tabular-nums text-[#0A1F17]">
              {formatINR(cr)}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* ------------------------------------------------------------ foot */}
      {(!!s(p.narration) || !!s(p.vch_no) || settle || p.balanced === false) && (
        <div className="flex flex-col gap-1.5 border-t border-t-[#EEF3ED] px-3.5 py-2.5">
          {settle && (
            <div className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#1B4E82]">
              <ArrowDownLeft className="h-[15px] w-[15px] flex-none" />
              {formatINR(p.allocated)} of it was put against this bill
            </div>
          )}
          {p.balanced === false && (
            <div className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#B3261E]">
              <AlertTriangle className="h-[15px] w-[15px] flex-none" />
              This voucher does not balance — {formatINR(Math.abs(dr - cr))} apart
            </div>
          )}
          {!!s(p.vch_no) && (
            <div className="text-[11px] font-semibold text-[#5A6B62]">
              Voucher no {s(p.vch_no)}
            </div>
          )}
          {!!s(p.narration) && (
            <div className="text-[11.5px] leading-[1.5] text-[#5A6B62] [overflow-wrap:anywhere]">
              {s(p.narration)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHead({ children, note }: { children: React.ReactNode; note?: string }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-0.5">
      <span className="text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#33473E]">
        {children}
      </span>
      {!!note && <span className="text-[11px] font-semibold text-[#5A6B62]">{note}</span>}
    </div>
  )
}

export function LedgerPostings({
  target,
  onClose
}: {
  target: PostingTarget | null
  onClose: () => void
}): React.JSX.Element | null {
  const [data, setData] = useState<Row | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const drawerRef = useRef<HTMLDivElement>(null)
  useDrawerEscape(!!target, drawerRef, onClose)

  const entity = target?.entity
  const id = target?.id
  useEffect(() => {
    if (!entity || !id) {
      setData(null)
      setErr('')
      return
    }
    // `live` rather than an abort: the panel can be reopened on another
    // document before the first answer lands, and the wrong document's
    // vouchers under the right document's heading is the one mistake a panel
    // like this must not make.
    let live = true
    setBusy(true)
    setErr('')
    setData(null)
    window.api.vouchers
      .forDocument(entity, id)
      .then((r) => {
        if (live) setData(r as Row)
      })
      .catch((e: unknown) => {
        if (live) setErr(String((e as Error)?.message || e))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [entity, id])

  if (!target) return null
  const posted: Row[] = Array.isArray(data?.posted) ? (data as Row).posted : []
  const settled: Row[] = Array.isArray(data?.settled) ? (data as Row).settled : []
  const totals = (data?.totals || {}) as Row
  const unbalanced = posted.filter((p) => p.balanced === false).length

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      {/* The register stays readable behind it. Not drawn on a phone, where
          the panel is the whole screen and there is no "behind" to look at. */}
      <div
        onClick={onClose}
        className="hidden flex-1 sm:block"
        style={{ background: 'rgba(10,31,23,.44)' }}
        aria-hidden
      />
      <div
        className="flex w-full min-w-0 flex-col bg-[#F1F5EF] sm:w-[min(100%,660px)]"
        style={{ boxShadow: '-16px 0 40px rgba(10,31,23,.24)' }}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
      >
        <Head target={target} onClose={onClose} />

        {/* WHAT IT ADDS UP TO, before the vouchers themselves. Somebody
            checking a document against the books wants the count and the
            total first; the detail is what they read if it disagrees. */}
        {!busy && !err && posted.length > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-b border-b-[#D6E2D6] bg-white px-5 py-3">
            <div>
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                Vouchers
              </div>
              <div className="text-[15px] font-bold tabular-nums text-[#0A1F17]">
                {n(totals.count) || posted.length}
              </div>
            </div>
            <div>
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                Total debit
              </div>
              <div className="text-[15px] font-bold tabular-nums text-[#0A1F17]">
                {formatINR(totals.dr)}
              </div>
            </div>
            <div>
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]">
                Total credit
              </div>
              <div className="text-[15px] font-bold tabular-nums text-[#0A1F17]">
                {formatINR(totals.cr)}
              </div>
            </div>
            {unbalanced > 0 && (
              <div className="flex items-center gap-1.5 rounded-[3px] border border-[#F0C9C4] bg-[#FDECEA] px-2.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[.05em] text-[#B3261E]">
                <AlertTriangle className="h-[15px] w-[15px]" />
                {unbalanced} does not balance
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------ body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {busy && (
            <div className="flex items-center gap-2 px-0.5 py-6 text-[12.5px] font-semibold text-[#5A6B62]">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the books…
            </div>
          )}

          {!busy && !!err && (
            <div className="flex items-start gap-2 rounded-[4px] border border-[#F0C9C4] bg-[#FDECEA] px-3.5 py-3 text-[12.5px] font-semibold text-[#8C2F26]">
              <AlertTriangle className="mt-px h-4 w-4 flex-none" />
              <span className="[overflow-wrap:anywhere]">{err}</span>
            </div>
          )}

          {!busy && !err && posted.length === 0 && settled.length === 0 && (
            <div className="rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-6 text-center">
              <BookOpen className="mx-auto h-6 w-6 text-[#8CA396]" />
              <div className="mt-2.5 text-[13px] font-bold text-[#0A1F17]">
                Nothing has been posted from this {label(target.entity)} yet
              </div>
              {/* Said plainly, because on a facility this is usually the right
                  answer rather than a fault: a bill the NBFC has not funded and
                  an LC still at application stage have nothing to post. */}
              <div className="mx-auto mt-1.5 max-w-[42ch] text-[11.5px] leading-[1.6] text-[#5A6B62]">
                {emptyWhy(target.entity)}
              </div>
            </div>
          )}

          {!busy && !err && posted.length > 0 && (
            <>
              <SectionHead note={posted.length === 1 ? 'one voucher' : `${posted.length} vouchers`}>
                Posted by this {label(target.entity)}
              </SectionHead>
              {posted.map((p) => (
                <Voucher key={`p${p.id}`} p={p} />
              ))}
            </>
          )}

          {!busy && !err && settled.length > 0 && (
            <>
              <div className="mt-2" />
              <SectionHead note="money put against it, posted elsewhere">
                Settled against it
              </SectionHead>
              {settled.map((p) => (
                <Voucher key={`s${p.id}`} p={p} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function label(e: PostingTarget['entity']): string {
  return e === 'order'
    ? 'purchase'
    : e === 'sale'
      ? 'invoice'
      : e === 'lc'
        ? 'LC'
        : e === 'trading'
          ? 'deal'
          : 'bill'
}

function emptyWhy(e: PostingTarget['entity']): string {
  if (e === 'lc') {
    return 'An LC posts when it is issued against a bill, when interest or charges are taken, and when it is repaid — not when the application is raised.'
  }
  if (e === 'bd') {
    return 'A discounted bill posts on the day the money is received. One still awaiting payment has nothing in the books yet.'
  }
  if (e === 'trading') {
    return 'A deal posts through its two invoices — the purchase and the sale. One with neither raised yet has nothing in the books.'
  }
  return 'That usually means the voucher was reversed, or the document was entered before the books begin.'
}
