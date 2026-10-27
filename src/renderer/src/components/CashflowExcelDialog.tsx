import { useMemo, useState } from 'react'
import { Columns3, Download, Plus, Rows3, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportRowsToExcel, NUM_MONEY, NUM_INT, type ExcelColumn } from '@/lib/excel'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Group = { name: string; heads: string[] }

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round2 = (v: number): number => Math.round(v * 100) / 100
const REF_WORD: Record<string, string> = { agst_ref: 'Agst Ref', new_ref: 'New Ref', advance: 'Advance', on_account: 'On Account' }
const OTHER = 'Other heads'
const NONE = 'No breakdown'
// Header colour per head group, cycled — dark band, light tint for its total.
const PALETTE: { head: string; tint: string }[] = [
  { head: 'FF0B6B45', tint: 'FFE6F4EC' },
  { head: 'FF1B4E82', tint: 'FFE6EEF8' },
  { head: 'FF8A5300', tint: 'FFFBF0DC' },
  { head: 'FF6B3FA0', tint: 'FFF0EAF8' },
  { head: 'FF0E5A78', tint: 'FFE4F3F8' },
  { head: 'FFB3261E', tint: 'FFFBE8E6' }
]

// The groups are the desk's own way of reading its breakdowns, kept on this
// device per company (a per-viewer convenience; nothing in the books).
const storeKey = (cid?: number): string => `cashflow-head-groups:${cid || 0}`
function loadGroups(cid?: number): Group[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(cid)) || '[]')
    return Array.isArray(v) ? v.filter((g) => g && typeof g.name === 'string' && Array.isArray(g.heads)) : []
  } catch {
    return []
  }
}
function saveGroups(cid: number | undefined, groups: Group[]): void {
  try {
    localStorage.setItem(storeKey(cid), JSON.stringify(groups))
  } catch {
    /* private window — the groups live for this download only */
  }
}

const headKey = (s: unknown): string => String(s ?? '').trim().toUpperCase()

// THE CASHFLOW REGISTER'S EXCEL, laid out for analysis. Heads as COLUMNS: one
// row per ledger line, a column per breakdown head, grouped under the desk's
// own head groups with a total each. Heads as ROWS: one row per part, under a
// subtotal per group that folds open. Either way a "By head" sheet sums it.
export function CashflowExcelDialog({
  open,
  onClose,
  vouchers,
  companyId,
  companyName,
  from,
  to
}: {
  open: boolean
  onClose: () => void
  vouchers: Row[]
  companyId?: number
  companyName: string
  from: string
  to: string
}): React.JSX.Element {
  const [layout, setLayout] = useState<'columns' | 'rows'>('columns')
  const [groups, setGroupsRaw] = useState<Group[]>(() => loadGroups(companyId))
  const [withAll, setWithAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const setGroups = (g: Group[]): void => {
    setGroupsRaw(g)
    saveGroups(companyId, g)
  }

  // Every head the breakdowns use, by name (case and spaces ignored).
  const heads = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of vouchers) for (const l of (v.lines as Row[]) || []) for (const p of (l.splits as Row[]) || []) {
      const k = headKey(p.name)
      if (k && !m.has(k)) m.set(k, String(p.name).trim())
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => ({ key, label }))
  }, [vouchers])
  const groupOf = (k: string): string => groups.find((g) => g.heads.includes(k))?.name.trim() || OTHER
  const toggleHead = (gi: number, k: string): void =>
    setGroups(
      groups.map((g, i) =>
        i === gi ? { ...g, heads: g.heads.includes(k) ? g.heads.filter((h) => h !== k) : [...g.heads, k] } : { ...g, heads: g.heads.filter((h) => h !== k) }
      )
    )

  async function download(): Promise<void> {
    setBusy(true)
    try {
      const label = new Map(heads.map((h) => [h.key, h.label]))
      // Groups in the order set, each with its heads; ungrouped heads last.
      const order: { name: string; heads: string[]; color: (typeof PALETTE)[number] }[] = []
      groups.forEach((g) => {
        const hs = g.heads.filter((k) => label.has(k))
        if (g.name.trim() && hs.length) order.push({ name: g.name.trim(), heads: hs, color: PALETTE[order.length % PALETTE.length] })
      })
      const rest = heads.map((h) => h.key).filter((k) => groupOf(k) === OTHER)
      if (rest.length) order.push({ name: OTHER, heads: rest, color: PALETTE[order.length % PALETTE.length] })

      // One record per ledger line that has a breakdown (or every line).
      const lines: Row[] = []
      for (const v of vouchers)
        for (const l of (v.lines as Row[]) || []) {
          const parts = ((l.splits as Row[]) || []).filter((p) => headKey(p.name))
          if (!parts.length && !withAll) continue
          lines.push({ v, l, parts })
        }
      const base = (v: Row, l: Row): Row => ({
        date: formatDate(v.date),
        voucher: v.code,
        type: v.type,
        invoice: v.invoice_no,
        refs: ((v.refs as string[]) || []).join(', '),
        party: v.party,
        ledger: l.account,
        lgroup: l.group,
        side: l.side === 'dr' ? 'Dr' : 'Cr',
        dr: l.side === 'dr' ? n(l.amount) : 0,
        cr: l.side === 'cr' ? n(l.amount) : 0,
        line_refs: ((l.refs as Row[]) || []).map((r) => `${REF_WORD[r.method] || r.method}${r.ref ? ' ' + r.ref : ''} ${r.amount}`).join('; '),
        issues: ((v.issues as string[]) || []).join('; '),
        narration: v.narration
      })
      const sub = `${formatDate(from)} to ${formatDate(to)} · ${vouchers.length} vouchers · ${lines.length} lines`
      const money = (header: string, key: string, extra: Partial<ExcelColumn> = {}): ExcelColumn => ({ header, key, align: 'right', numFmt: NUM_MONEY, total: 'sum', ...extra })

      // BY HEAD — group subtotal, then each head: entries and amount.
      const summary: Row[] = []
      for (const g of [...order, ...(withAll ? [{ name: NONE, heads: [] as string[], color: PALETTE[0] }] : [])]) {
        const detail =
          g.name === NONE
            ? [{ head: '(lines with no breakdown)', count: lines.filter((x) => !x.parts.length).length, amount: round2(lines.filter((x) => !x.parts.length).reduce((t, x) => t + n(x.l.amount), 0)) }]
            : g.heads.map((k) => {
                const ps = lines.flatMap((x) => (x.parts as Row[]).filter((p) => headKey(p.name) === k))
                return { head: label.get(k), count: ps.length, amount: round2(ps.reduce((t, p) => t + n(p.amount), 0)) }
              })
        if (!detail.some((d) => d.count)) continue
        summary.push({ _g: true, head: g.name, count: detail.reduce((t, d) => t + d.count, 0), amount: round2(detail.reduce((t, d) => t + d.amount, 0)) })
        detail.filter((d) => d.count).forEach((d) => summary.push({ ...d }))
      }
      const summarySheet = {
        sheetName: 'By head',
        title: `Breakdown by head — ${companyName}`,
        subtitle: sub,
        columns: [
          { header: 'Head', key: 'head', width: 28 },
          { header: 'Entries', key: 'count', align: 'right' as const, numFmt: NUM_INT, total: 'sum' as const },
          money('Amount', 'amount')
        ],
        rows: summary,
        isGroup: (r: Row) => !!r._g,
        outlineDetail: true,
        totalLabel: 'TOTAL'
      }

      if (layout === 'columns') {
        const rows = lines.map(({ v, l, parts }) => {
          const r = base(v, l)
          let split = 0
          for (const g of order) {
            let gt = 0
            for (const k of g.heads) {
              const a = round2((parts as Row[]).filter((p) => headKey(p.name) === k).reduce((t, p) => t + n(p.amount), 0))
              r[`h:${k}`] = a || ''
              gt += a
            }
            split += gt
          }
          r.split = round2(split) || ''
          // What the line carries that no head accounts for.
          r.unsplit = (parts as Row[]).length ? round2(n(l.amount) - split) || '' : ''
          r.remarks = (parts as Row[]).filter((p) => p.note).map((p) => `${p.name}: ${p.note}`).join('; ')
          return r
        })
        const cols: ExcelColumn[] = [
          { header: 'Date', key: 'date' },
          { header: 'Voucher', key: 'voucher' },
          { header: 'Ledger', key: 'ledger' },
          { header: 'Invoice no', key: 'invoice' },
          { header: 'Ref no', key: 'refs' },
          { header: 'Party', key: 'party' },
          { header: 'Type', key: 'type' },
          { header: 'Ledger group', key: 'lgroup' },
          money('Dr', 'dr'),
          money('Cr', 'cr')
        ]
        // A column per head, coloured by its group; wide enough that the
        // header reads in full beside the filter arrow.
        for (const g of order) {
          g.heads.forEach((k, i) => {
            const header = `${g.name} › ${label.get(k)}`
            cols.push(money(header, `h:${k}`, { headerFill: g.color.head, divider: i === 0, width: header.length + 6 }))
          })
        }
        cols.push(
          money('Split total', 'split', { divider: true, fill: 'FFFDF3D7', width: 16 }),
          money('Not split', 'unsplit', { width: 14 }),
          { header: 'Remarks', key: 'remarks', width: 30 },
          { header: 'Bill references', key: 'line_refs' },
          { header: 'Narration', key: 'narration', width: 40 }
        )
        await exportRowsToExcel({
          filename: `cashflow-register-${from}-to-${to}`,
          sheetName: 'Heads as columns',
          title: `Cashflow register — ${companyName}`,
          subtitle: sub,
          columns: cols,
          rows,
          freezeCols: 7,
          extraSheets: [summarySheet]
        })
      } else {
        // HEADS AS ROWS — each entry once, its parts beneath it (in the order
        // of the head groups), folding open. The entry's row carries the line
        // and what its parts add up to; the parts carry only the head.
        const rank = new Map<string, number>()
        order.forEach((g, gi) => g.heads.forEach((k, hi) => rank.set(k, gi * 1000 + hi)))
        const rows: Row[] = []
        for (const { v, l, parts } of lines) {
          const ps = [...(parts as Row[])].sort((a, b) => (rank.get(headKey(a.name)) ?? 1e9) - (rank.get(headKey(b.name)) ?? 1e9))
          rows.push({ _g: true, ...base(v, l), line_amount: n(l.amount), part_amount: round2(ps.reduce((t, p) => t + n(p.amount), 0)) || '' })
          for (const p of ps) rows.push({ head: label.get(headKey(p.name)), part_amount: n(p.amount), remarks: p.note || '' })
        }
        await exportRowsToExcel({
          filename: `cashflow-register-${from}-to-${to}`,
          sheetName: 'Heads as rows',
          title: `Cashflow register — ${companyName}`,
          subtitle: sub,
          columns: [
            { header: 'Date', key: 'date' },
            { header: 'Voucher', key: 'voucher' },
            { header: 'Ledger', key: 'ledger' },
            { header: 'Invoice no', key: 'invoice' },
            { header: 'Party', key: 'party' },
            { header: 'Type', key: 'type' },
            { header: 'Dr / Cr', key: 'side', align: 'center' },
            money('Line amount', 'line_amount', { width: 16 }),
            { header: 'Head', key: 'head', width: 24, divider: true },
            money('Part amount', 'part_amount', { width: 16 }),
            { header: 'Remarks', key: 'remarks', width: 30 },
            { header: 'Ref no', key: 'refs' },
            { header: 'Narration', key: 'narration', width: 40 }
          ],
          rows,
          isGroup: (r) => !!r._g,
          outlineDetail: true,
          freezeCols: 2,
          extraSheets: [summarySheet]
        })
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const cap = 'text-[10px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]'
  const ungrouped = heads.filter((h) => groupOf(h.key) === OTHER)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Download the Cashflow Register</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 text-[12.5px]">
          {/* HOW THE HEADS LIE */}
          <div>
            <div className={cap}>Layout</div>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(
                [
                  { k: 'columns', icon: Columns3, t: 'Heads as columns', s: 'One row per entry — a column for each head, a total per group' },
                  { k: 'rows', icon: Rows3, t: 'Heads as rows', s: 'One row per part — under a subtotal for each group, folding open' }
                ] as const
              ).map((o) => {
                const on = layout === o.k
                return (
                  <button
                    key={o.k}
                    type="button"
                    onClick={() => setLayout(o.k)}
                    className={cn('flex items-start gap-2.5 rounded-[6px] border px-3 py-2.5 text-left', on ? 'border-[#0B3D2E] bg-[#F1F8EC] ring-1 ring-[#0B3D2E]' : 'border-[#D6E2D6] bg-white hover:bg-[#F7FAF6]')}
                  >
                    <o.icon className={cn('mt-0.5 h-5 w-5 flex-none', on ? 'text-[#0B3D2E]' : 'text-[#8CA396]')} />
                    <span>
                      <span className="block text-[13px] font-extrabold text-[#0A1F17]">{o.t}</span>
                      <span className="block text-[11.5px] font-semibold text-[#5A6B62]">{o.s}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* THE HEAD GROUPS */}
          <div>
            <div className="flex items-center gap-2">
              <span className={cap}>Head groups</span>
              <span className="text-[11px] font-semibold text-[#8CA396]">{heads.length} heads in these entries · groups are remembered on this device</span>
              <button
                type="button"
                onClick={() => setGroups([...groups, { name: `Group ${groups.length + 1}`, heads: [] }])}
                className="ml-auto flex items-center gap-1 rounded-[4px] bg-[#C7F03F] px-2.5 py-1 text-[11.5px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F]"
              >
                <Plus className="h-3.5 w-3.5" /> Add group
              </button>
            </div>
            <div className="mt-2 grid gap-2">
              {groups.length === 0 && (
                <div className="rounded-[6px] border border-dashed border-[#C3D2C6] bg-white px-3 py-2.5 text-[12px] text-[#5A6B62]">
                  No groups yet — every head goes under &ldquo;{OTHER}&rdquo;. Add a group (Freight, Bank charges, Statutory…) and tick the heads that belong to it.
                </div>
              )}
              {groups.map((g, gi) => (
                <div key={gi} className="rounded-[6px] border border-[#D6E2D6] bg-white p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 flex-none rounded-[2px]" style={{ background: `#${PALETTE[gi % PALETTE.length].head.slice(2)}` }} />
                    <input
                      value={g.name}
                      onChange={(e) => setGroups(groups.map((x, i) => (i === gi ? { ...x, name: e.target.value } : x)))}
                      className="h-8 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] px-2 text-[13px] font-bold outline-none focus:border-[#1B4E82]"
                    />
                    <span className="text-[11px] font-semibold text-[#5A6B62]">
                      {(() => {
                        const c = g.heads.filter((k) => heads.some((h) => h.key === k)).length
                        return `${c} head${c === 1 ? '' : 's'}`
                      })()}
                    </span>
                    <button type="button" title="Remove this group" onClick={() => setGroups(groups.filter((_, i) => i !== gi))} className="text-[#8CA396] hover:text-[#B3261E]">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {heads.map((h) => {
                      const on = g.heads.includes(h.key)
                      const elsewhere = !on && groupOf(h.key) !== OTHER
                      return (
                        <button
                          key={h.key}
                          type="button"
                          onClick={() => toggleHead(gi, h.key)}
                          title={elsewhere ? `In ${groupOf(h.key)} — clicking moves it here` : undefined}
                          className={cn(
                            'rounded-[3px] border px-2 py-0.5 text-[11.5px] font-bold',
                            on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : elsewhere ? 'border-[#E4ECE3] bg-[#F7FAF6] text-[#A8B8AE]' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F1F8EC]'
                          )}
                        >
                          {h.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              {groups.length > 0 && ungrouped.length > 0 && (
                <div className="text-[11.5px] font-semibold text-[#5A6B62]">
                  Under &ldquo;{OTHER}&rdquo;: {ungrouped.map((h) => h.label).join(', ')}
                </div>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12px] font-semibold text-[#33473E]">
            <input type="checkbox" checked={withAll} onChange={(e) => setWithAll(e.target.checked)} />
            Also the lines with no breakdown (as &ldquo;{NONE}&rdquo;)
          </label>

          <div className="flex justify-end gap-2 border-t border-[#E4ECE3] pt-3">
            <button type="button" onClick={onClose} className="h-9 rounded-[4px] border border-[#C3D2C6] bg-white px-3.5 text-[12px] font-bold text-[#33473E]">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !vouchers.length}
              onClick={() => void download()}
              className="flex h-9 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-3.5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-40"
            >
              <Download className="h-4 w-4" /> {busy ? 'Building…' : 'Download Excel'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
