import { useCallback, useEffect, useMemo, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const TYPE_LABEL: Record<string, string> = {
  payable: 'Payable',
  payment: 'Payment',
  advance: 'Advance',
  freight: 'Freight',
  shortage_penalty: 'Shortage penalty'
}

function balances(entries: Row[], nameKey: string): { name: string; balance: number }[] {
  const map = new Map<string, number>()
  for (const e of entries) {
    const name = (e[nameKey] as string) ?? '—'
    map.set(name, (map.get(name) ?? 0) + (Number(e.amount) || 0))
  }
  return Array.from(map.entries()).map(([name, balance]) => ({ name, balance }))
}

function LedgerTable({ entries, nameKey }: { entries: Row[]; nameKey: string }): React.JSX.Element {
  const summary = useMemo(() => balances(entries, nameKey), [entries, nameKey])
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        ) : (
          summary.map((s) => (
            <Card key={s.name} className="p-4">
              <div className="text-sm text-muted-foreground">{s.name}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{formatINR(s.balance)}</div>
              <div className="text-xs text-muted-foreground">
                {s.balance < 0 ? 'advance / credit' : 'outstanding'}
              </div>
            </Card>
          ))
        )}
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>{nameKey === 'supplier_name' ? 'Supplier' : 'Transporter'}</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No entries yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((e) => (
                <TableRow key={e.id as number}>
                  <TableCell>{formatDate(e.entry_date)}</TableCell>
                  <TableCell>{e[nameKey] ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{e.invoice_no ?? e.note ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={Number(e.amount) < 0 ? 'success' : 'muted'}>
                      {TYPE_LABEL[e.entry_type] ?? e.entry_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(e.amount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function Ledgers(): React.JSX.Element {
  const [supplierEntries, setSupplierEntries] = useState<Row[]>([])
  const [transporterEntries, setTransporterEntries] = useState<Row[]>([])

  const load = useCallback(async () => {
    const [sl, tl] = await Promise.all([
      window.api.ledger.suppliers(),
      window.api.ledger.transporters()
    ])
    setSupplierEntries(sl)
    setTransporterEntries(tl)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  return (
    <>
      <PageHeader
        title="Ledgers"
        subtitle="Outstanding to suppliers and transporters — record payments in the Payments tab"
      />
      <div className="p-8">
        <Tabs defaultValue="suppliers">
          <TabsList>
            <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
            <TabsTrigger value="transporters">Transporters</TabsTrigger>
          </TabsList>
          <TabsContent value="suppliers" className="mt-6">
            <LedgerTable entries={supplierEntries} nameKey="supplier_name" />
          </TabsContent>
          <TabsContent value="transporters" className="mt-6">
            <LedgerTable entries={transporterEntries} nameKey="transporter_name" />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
