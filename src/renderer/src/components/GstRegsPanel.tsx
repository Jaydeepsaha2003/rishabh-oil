import { Plus, ReceiptText, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
export type GstReg = { gstin: string; state: string; gst_rates: string; gst_type: 'CGST_SGST' | 'IGST'; own?: boolean }

/** A party's extra GST registrations (suppliers/customers.gst_regs). Bad JSON reads as none. */
export function parseGstRegs(v: unknown): GstReg[] {
  try {
    const a = JSON.parse(String(v || '[]'))
    return Array.isArray(a)
      ? a.map((r: Row) => ({
          gstin: String(r.gstin || ''),
          state: String(r.state || ''),
          gst_rates: String(r.gst_rates || ''),
          gst_type: r.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST'
        }))
      : []
  } catch {
    return []
  }
}

/**
 * Every GST No. a party bills under, for a bill's GST No. picker: the party's
 * own (GSTIN / State / GST rates on the form, marked own) first, then its extra
 * rows. A bill with no GST No. chosen is under the party's own.
 */
export function partyGstOptions(p: Row | undefined): GstReg[] {
  if (!p) return []
  const own: GstReg[] = String(p.gstin || '').trim()
    ? [{ gstin: String(p.gstin).trim().toUpperCase(), state: String(p.state || ''), gst_rates: String(p.gst_rates || p.gst_pct || ''), gst_type: 'CGST_SGST', own: true }]
    : []
  return [...own, ...parseGstRegs(p.gst_regs).filter((r) => r.gstin.trim())]
}

// ONE PARTY, SEVERAL GST NOs. — DEEP CHAND ARYA INDUSTRIES with a Delhi and an
// Uttar Pradesh registration is one party with two rows here, not a ledger per
// state. Each row: the GST No., its state, the rates it bills at and whether
// its bills are CGST + SGST or IGST — what a purchase or sale picks up when
// that GST No. is chosen on it. Saved with the party (Save).
export function GstRegsPanel({ value, onChange, readOnly }: { value: unknown; onChange: (json: string) => void; readOnly?: boolean }): React.JSX.Element {
  const regs = parseGstRegs(value)
  const set = (next: GstReg[]): void => onChange(JSON.stringify(next))
  const patch = (i: number, p: Partial<GstReg>): void => set(regs.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const cap = 'mb-1 block text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]'
  const input =
    'h-10 w-full rounded-[6px] border border-[#C3D2C6] bg-white px-3 text-[13.5px] font-semibold text-[#0A1F17] outline-none placeholder:font-medium placeholder:text-[#A8B8AE] focus:border-[#0B3D2E] focus:ring-2 focus:ring-[#0B3D2E]/10 disabled:bg-[#F4F7F3]'

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-[#CFE0D2] bg-white shadow-[0_1px_2px_rgba(10,31,23,.04),0_10px_24px_-18px_rgba(10,31,23,.35)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#DCE7DB] bg-[linear-gradient(160deg,#F4F8FD,#EAF0FA)] px-4 py-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-[#1B4E82]">
          <ReceiptText className="h-[17px] w-[17px] text-white" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-extrabold text-[#0A1F17]">More GST Nos.</span>
            <span className="rounded-full bg-[#1B4E82] px-2 py-px text-[10.5px] font-extrabold tabular-nums text-white">{regs.length}</span>
          </div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">Other states or branches this same party bills from — one party, one ledger. Picked on each bill.</div>
        </div>
      </div>
      <div className="grid gap-2 p-3">
        {regs.map((r, i) => (
          <div key={i} className="grid grid-cols-2 items-end gap-2.5 rounded-[8px] border border-[#DCE7DB] bg-[#FBFCFA] p-3 sm:grid-cols-[1.4fr_1fr_1fr_190px_auto]">
            <label className="min-w-0">
              <span className={cap}>GST No.</span>
              <input value={r.gstin} disabled={readOnly} placeholder="09AAAAA0000A1Z5" onChange={(e) => patch(i, { gstin: e.target.value.toUpperCase() })} className={cn(input, 'font-mono uppercase')} />
            </label>
            <label className="min-w-0">
              <span className={cap}>State</span>
              <input value={r.state} disabled={readOnly} placeholder="e.g. Uttar Pradesh" onChange={(e) => patch(i, { state: e.target.value })} className={input} />
            </label>
            <label className="min-w-0">
              <span className={cap}>GST rates</span>
              <input value={r.gst_rates} disabled={readOnly} placeholder="5, 18" onChange={(e) => patch(i, { gst_rates: e.target.value })} className={input} />
            </label>
            <div className="min-w-0">
              <span className={cap}>Tax</span>
              <div className="grid h-10 grid-cols-2 gap-1 rounded-[7px] border border-[#D6E2D6] bg-[#F4F7F3] p-1">
                {(
                  [
                    ['CGST_SGST', 'CGST+SGST'],
                    ['IGST', 'IGST']
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    disabled={readOnly}
                    onClick={() => patch(i, { gst_type: k })}
                    className={cn(
                      'rounded-[5px] text-[11.5px] font-extrabold transition-colors',
                      r.gst_type === k ? 'bg-[#1B4E82] text-white' : 'text-[#5A6B62] hover:bg-white'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {!readOnly && (
              <button
                type="button"
                title="Remove this GST No."
                onClick={() => set(regs.filter((_, k) => k !== i))}
                className="flex h-10 w-10 items-center justify-center rounded-[6px] border border-[#E5C9C6] bg-white text-[#8C2F26] hover:bg-rose-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={() => set([...regs, { gstin: '', state: '', gst_rates: '', gst_type: 'CGST_SGST' }])}
            className="flex h-11 items-center justify-center gap-2 rounded-[8px] border-2 border-dashed border-[#C6DAF0] bg-[#FAFCFF] text-[12.5px] font-extrabold text-[#1B4E82] transition-colors hover:border-[#1B4E82] hover:bg-[#F4F8FD]"
          >
            <Plus className="h-4 w-4" /> Add a GST No.
          </button>
        )}
        {regs.length > 0 && !readOnly && <div className="px-1 text-[11px] font-semibold text-[#8CA396]">Saved with the party — press Save below.</div>}
      </div>
    </div>
  )
}
