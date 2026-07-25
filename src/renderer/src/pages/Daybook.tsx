import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Colour a voucher type badge by its nature.
function vchTone(t: string): 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'muted' {
  const s = String(t || '').toUpperCase()
  if (s.includes('SALE')) return 'success'
  if (s.includes('RECEIPT')) return 'success'
  if (s.includes('CREDIT')) return 'success'
  if (s.includes('PAYMENT')) return 'warning'
  if (s.includes('DEBIT')) return 'destructive'
  return 'secondary'
}

export function Daybook(): React.JSX.Element {
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [vouchers, setVouchers] = useState<Row[]>([])
  const [material, setMaterial] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const f = from <= to ? from : to
    const t = from <= to ? to : from
    const res = await window.api.stock.daybook(f, t)
    setVouchers(res.vouchers)
    setMaterial(res.material)
    setLoading(false)
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  // Totals grouped by voucher type.
  const byType = useMemo(() => {
    const m = new Map<string, { count: number; amount: number }>()
    for (const v of vouchers) {
      const k = String(v.vch_type || 'OTHER')
      const g = m.get(k) || { count: 0, amount: 0 }
      g.count += 1
      g.amount += Number(v.amount) || 0
      m.set(k, g)
    }
    return Array.from(m.entries()).sort((a, b) => b[1].amount - a[1].amount)
  }, [vouchers])

  const setToday = (): void => { setFrom(todayISO()); setTo(todayISO()) }

  return (
    <>
      <PageHeader
        title="Daybook"
        hint="Every entry for the chosen day or date range — sales, purchases, receipts/payments, journal & Dr/Cr notes (from the double-entry ledger), plus material in/out at the gate. Pick a single day or a range."
      />
      <div className="w-full space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">From</Label>
            <DatePicker value={from} max={todayISO()} onChange={(v) => setFrom(v || todayISO())} className="w-40" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">To</Label>
            <DatePicker value={to} max={todayISO()} onChange={(v) => setTo(v || todayISO())} className="w-40" />
          </div>
          <Button variant="outline" size="sm" onClick={setToday}>Today</Button>
          <div className="ml-auto flex flex-wrap gap-2">
            {byType.map(([type, g]) => (
              <div key={type} className="rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
                <span className="font-medium">{type}</span>{' '}
                <span className="text-muted-foreground">×{g.count}</span>{' · '}
                <span className="tabular-nums">{formatINR(g.amount)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Financial vouchers */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">Vouchers</h3>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table className="min-w-[820px] text-[13px] [&_td]:py-2 [&_th]:h-9">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Date</TableHead>
                  <TableHead className="w-[130px]">Type</TableHead>
                  <TableHead className="w-[120px]">Vch no</TableHead>
                  <TableHead>Particulars (Dr → Cr)</TableHead>
                  <TableHead className="text-right w-[140px]">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : vouchers.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No entries in this period.</TableCell></TableRow>
                ) : (
                  vouchers.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(v.entry_date)}</TableCell>
                      <TableCell><Badge variant={vchTone(v.vch_type)} className="whitespace-nowrap">{v.vch_type}</Badge></TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{v.vch_no || '—'}</TableCell>
                      <TableCell>
                        <div className="text-sm"><span className="text-muted-foreground">Dr</span> {v.dr_accounts || '—'} <span className="text-muted-foreground">→ Cr</span> {v.cr_accounts || '—'}</div>
                        {v.narration && <div className="text-xs text-muted-foreground">{v.narration}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatINR(v.amount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        {/* Material in / out */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">Material in / out (gate)</h3>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table className="min-w-[720px] text-[13px] [&_td]:py-2 [&_th]:h-9">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Date</TableHead>
                  <TableHead className="w-[80px]">In / Out</TableHead>
                  <TableHead className="w-[110px]">Rec type</TableHead>
                  <TableHead className="w-[120px]">Gate no</TableHead>
                  <TableHead>Vehicle · party</TableHead>
                  <TableHead className="text-right w-[120px]">Qty</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                ) : material.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No material movement in this period.</TableCell></TableRow>
                ) : (
                  material.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(m.entry_date)}</TableCell>
                      <TableCell><Badge variant={m.direction === 'out' ? 'default' : 'muted'}>{m.direction === 'out' ? 'OUT' : 'IN'}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.rec_type || 'OIL'}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{m.gate_entry_no}</TableCell>
                      <TableCell>
                        <div>{m.tanker_no}</div>
                        <div className="text-xs text-muted-foreground">{m.party || '—'}{m.ref_doc ? ` · ${m.ref_doc}` : ''}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(m.qty) > 0 ? `${formatNum(m.qty)} ${m.uom}` : '—'}</TableCell>
                      <TableCell><Badge variant={m.status === 'completed' ? 'success' : 'warning'}>{m.status === 'completed' ? 'Done' : 'Pending'}</Badge></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </>
  )
}
