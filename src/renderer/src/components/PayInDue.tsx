import { formatDate, formatINR } from '@/lib/format'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * WHEN THE MONEY IS EXPECTED BACK, AND WHETHER IT IS LATE.
 *
 * A letter of credit and a discounted bill both fund something that is meant
 * to pay for itself, and the terms for that are agreed in DAYS — "60 days from
 * the LC". The facility carries that number; this turns it into a date and
 * says where today stands against it.
 *
 * Nothing at all when no term was agreed, and nothing once the money has come:
 * a due date on a settled bill is an answered question still being asked.
 */
export function payInDueDate(row: Row): string {
  const days = Number(row?.payment_in_days)
  if (!Number.isFinite(days) || days <= 0) return ''
  // Counted from the day the facility actually started — the opening for an
  // LC, the disbursement for a discounted bill — and never from today, which
  // would move the date every time the page was drawn.
  const from = String(
    row?.opened_date || row?.payment_received_date || row?.open_date || row?.created_at || ''
  ).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return ''
  const d = new Date(`${from}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p2 = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export function PayInDue({ row }: { row: Row }): React.JSX.Element | null {
  // The switch at the foot of the form is what opts a facility in. A term is
  // optional on top of it: "yes, it comes back, we have not agreed when" is a
  // real answer and deserves a chip of its own rather than silence.
  if (!Number(row?.payment_in_expected)) return null
  const due = payInDueDate(row)
  const got = Number(row?.payment_in_total) || 0
  const today = new Date()
  const p2 = (x: number): string => String(x).padStart(2, '0')
  const now = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`
  const left = Math.round(
    (new Date(`${due}T00:00:00`).getTime() - new Date(`${now}T00:00:00`).getTime()) / 86400000
  )
  // IT CAME. THE CHIP STOPS ASKING AND STARTS ANSWERING.
  //
  // It used to disappear the moment anything was received, which left the
  // busiest row on the register saying nothing at all about the leg everyone
  // was waiting on. Green, with the bank it landed in and the reference on
  // it, is the same chip having been answered — and the one state a reader
  // scanning the column is actually looking for.
  if (got > 0.004) {
    const where = String(row?.payment_in_account || '').trim()
    const ref = String(row?.payment_in_ref || '').trim()
    // ANSWERED, AND A CLICK AWAY FROM SAYING HOW.
    //
    // "Payment Received" is the fact a reader scanning the column needs; the
    // bank, the reference and the date are the fact a reader CHASING one
    // needs, and they used to be crammed into the chip itself — a bank name
    // long enough to matter was also long enough to break the row. They live
    // in a popover now, open on the same click either way.
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Click for the account, reference and date"
            className="inline-flex flex-none items-center gap-1 rounded-[2px] align-middle transition-opacity hover:opacity-80"
            style={{
              background: '#E9F5EE',
              color: '#0B6B45',
              border: '1px solid #BFE3CB',
              padding: '1px 5px',
              fontSize: 9.5,
              fontWeight: 800,
              letterSpacing: '.03em',
              textTransform: 'uppercase'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            Payment Received
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" onClick={(e) => e.stopPropagation()}>
          <div className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#0B6B45]">
            Payment received
          </div>
          <div className="mt-2 space-y-1.5 text-[12.5px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-bold tabular-nums text-[#0A1F17]">{formatINR(got)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Into</span>
              <span className="font-semibold text-[#0A1F17]">{where || 'Not stated'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Reference</span>
              <span className="truncate font-semibold text-[#0A1F17]">{ref || '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Date</span>
              <span className="font-semibold text-[#0A1F17]">
                {row?.payment_in_last_date ? formatDate(row.payment_in_last_date) : '—'}
              </span>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    )
  }
  if (!due) {
    return (
      <span
        title="Money is expected back on this, with no term agreed yet"
        className="inline-flex flex-none items-center rounded-[2px] align-middle"
        style={{
          background: '#EAF0FA',
          color: '#1B4E82',
          border: '1px solid #C6DAF0',
          padding: '1px 5px',
          fontSize: 9.5,
          fontWeight: 800,
          letterSpacing: '.03em',
          textTransform: 'uppercase'
        }}
      >
        Payment IN expected
      </span>
    )
  }
  const late = left < 0
  const soon = left >= 0 && left <= 7
  const tone = late
    ? { bg: '#FDECEA', fg: '#B3261E', bd: '#F0C9C4' }
    : soon
      ? { bg: '#FFF4E0', fg: '#8A5300', bd: '#F0E4CB' }
      : { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0' }
  return (
    <span
      title={`Payment expected back ${Number(row.payment_in_days)} days from the start — ${formatDate(due)}`}
      className="inline-flex flex-none items-center gap-1 rounded-[2px] align-middle"
      style={{
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.bd}`,
        padding: '1px 5px',
        fontSize: 9.5,
        fontWeight: 800,
        letterSpacing: '.03em',
        textTransform: 'uppercase'
      }}
    >
      {late
        ? `Payment IN ${Math.abs(left)}d overdue`
        : left === 0
          ? 'Payment IN due today'
          : `Payment IN in ${left}d`}
    </span>
  )
}
