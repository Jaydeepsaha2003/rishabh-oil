import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Calculator } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errText, formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// RECALCULATE TDS? Asked when a supplier's "Purchase bill amount (as on)" is
// changed for a company: every bill of that supplier there was slabbed on the
// old figure. The bills whose TDS now comes out different are listed, old and
// new; Recalculate changes the TDS (and the net by the same amount) on the
// ones ticked, edits each voucher's TDS and supplier lines in place, and
// archives each bill first — the reviewed repair of Accounting checks, for
// this one supplier and company.
export function TdsRecalcDialog({
  ask,
  onClose
}: {
  ask: { supplierId: number; supplierName: string; companyId: number; companyName: string } | null
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRows(null)
    if (!ask) return
    let live = true
    window.api.suppliers
      .tdsRecalc(ask.supplierId, ask.companyId)
      .then((r) => {
        if (!live) return
        if (!r.findings.length) {
          toast.success(`TDS on ${ask.supplierName}'s ${ask.companyName} bills already fits — nothing to recalculate`)
          onClose()
          return
        }
        setRows(r.findings)
        setPicked(new Set(r.findings.map((f) => Number(f.id))))
      })
      .catch((e) => {
        toast.error(errText(e))
        onClose()
      })
    return () => {
      live = false
    }
  }, [ask]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (): Promise<void> => {
    if (!ask || !picked.size) return
    setBusy(true)
    try {
      const r = await window.api.suppliers.tdsRecalcFix(ask.supplierId, ask.companyId, [...picked])
      toast.success(`TDS recalculated on ${r.changed} bill${r.changed === 1 ? '' : 's'}`)
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const list = rows || []
  const sum = (f: string): number => list.filter((r) => picked.has(Number(r.id))).reduce((t, r) => t + (Number(r[f]) || 0), 0)
  return (
    <Dialog open={!!ask && !!rows} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-[#C2700A]" />
            Recalculate TDS on {ask?.supplierName}&apos;s {ask?.companyName} bills?
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          The purchase bill amount changed, so the TDS slab now starts elsewhere. These bills come out different. Only the TDS
          and the net change; each voucher&apos;s TDS and supplier lines are corrected in place.
        </p>
        <div className="max-h-[50vh] overflow-auto rounded-md border">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-[#F4F7F3] text-[10.5px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 py-1.5 text-left">Bill</th>
                <th className="px-2 py-1.5 text-left">Date</th>
                <th className="px-2 py-1.5 text-right">Taxable</th>
                <th className="px-2 py-1.5 text-right">Before it this year</th>
                <th className="px-2 py-1.5 text-right">TDS now</th>
                <th className="px-2 py-1.5 text-right">TDS recalculated</th>
                <th className="px-2 py-1.5 text-right">Net recalculated</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const id = Number(r.id)
                const on = picked.has(id)
                return (
                  <tr key={id} className="border-t">
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const next = new Set(picked)
                          if (on) next.delete(id)
                          else next.add(id)
                          setPicked(next)
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-semibold">{String(r.invoice_no)}</td>
                    <td className="px-2 py-1.5">{formatDate(String(r.order_date))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(Number(r.taxable))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatINR(Number(r.prior))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(Number(r.tds_before))}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-[#9A5A06]">{formatINR(Number(r.tds_after))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatINR(Number(r.net_after))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-muted-foreground">
          {picked.size} of {list.length} ticked · TDS {formatINR(sum('tds_before'))} → {formatINR(sum('tds_after'))}
        </p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !picked.size}>
            {busy ? 'Recalculating…' : `Recalculate ${picked.size} bill${picked.size === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
