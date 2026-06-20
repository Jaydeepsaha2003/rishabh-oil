import { useCallback, useEffect, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { formatNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CAT_LABEL: Record<string, string> = {
  raw: 'Raw',
  intermediate: 'Intermediate',
  finished: 'Finished'
}

function StockTable({ rows }: { rows: Row[] }): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Produced</TableHead>
            <TableHead className="text-right">Consumed</TableHead>
            <TableHead className="text-right">Sold</TableHead>
            <TableHead className="text-right">In stock</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                Nothing here yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id as number}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.received)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.produced)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.consumed)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatNum(r.sold)}</TableCell>
                <TableCell
                  className={cn(
                    'text-right font-semibold tabular-nums',
                    Number(r.stock) < -1e-9 ? 'text-red-600' : ''
                  )}
                >
                  {formatNum(r.stock)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function Stock(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])

  const load = useCallback(async () => {
    setRows(await window.api.stock.list())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useLiveRefresh(load)

  const byCat = (cat: string): Row[] => rows.filter((r) => r.category === cat)

  return (
    <>
      <PageHeader title="Stock" subtitle="Live balance per product" />
      <div className="p-8">
        <Tabs defaultValue="raw">
          <TabsList>
            <TabsTrigger value="raw">Raw ({byCat('raw').length})</TabsTrigger>
            <TabsTrigger value="intermediate">
              Intermediate ({byCat('intermediate').length})
            </TabsTrigger>
            <TabsTrigger value="finished">Finished ({byCat('finished').length})</TabsTrigger>
          </TabsList>
          <TabsContent value="raw" className="mt-6">
            <StockTable rows={byCat('raw')} />
          </TabsContent>
          <TabsContent value="intermediate" className="mt-6">
            <StockTable rows={byCat('intermediate')} />
          </TabsContent>
          <TabsContent value="finished" className="mt-6">
            <StockTable rows={byCat('finished')} />
          </TabsContent>
        </Tabs>
        <p className="mt-3 text-xs text-muted-foreground">
          Stock = raw received on orders + produced − consumed in production − sold.
        </p>
      </div>
    </>
  )
}
