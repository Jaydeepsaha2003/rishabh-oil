import { useCallback, useEffect, useState } from 'react'
import { Droplets, Factory, FileText, MapPin, RefreshCw, Tag, Truck, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import type { Page } from '@/components/Sidebar'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { STAGES, STATUS_LABEL } from '@/lib/orderCalc'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'

type Status = { ok: boolean; message: string }

const STATS = [
  { table: 'products', label: 'Products', icon: Droplets, color: 'bg-amber-100 text-amber-700' },
  { table: 'suppliers', label: 'Suppliers', icon: Users, color: 'bg-blue-100 text-blue-700' },
  { table: 'transporters', label: 'Transporters', icon: Truck, color: 'bg-violet-100 text-violet-700' },
  { table: 'sources', label: 'Ports', icon: MapPin, color: 'bg-emerald-100 text-emerald-700' }
] as const

interface Props {
  onNavigate: (page: Page) => void
}

export function Dashboard({ onNavigate }: Props): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [checking, setChecking] = useState(true)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [bargainCount, setBargainCount] = useState<number | null>(null)
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({})
  const [orderTotal, setOrderTotal] = useState(0)

  const refresh = useCallback(async () => {
    setChecking(true)
    const res = await window.api.dbPing()
    setStatus(res)
    setChecking(false)
    if (res.ok) {
      const entries = await Promise.all(
        STATS.map(async (t) => [t.table, (await window.api.data.list(t.table)).length] as const)
      )
      setCounts(Object.fromEntries(entries))
      setBargainCount((await window.api.bargains.list()).length)
      const orders = await window.api.orders.list()
      setOrderTotal(orders.length)
      const sc: Record<string, number> = {}
      for (const s of STAGES) sc[s] = 0
      for (const o of orders) sc[o.status] = (sc[o.status] ?? 0) + 1
      setStageCounts(sc)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useLiveRefresh(refresh)

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your system"
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <div className="space-y-6 p-8">
        <Card className="flex items-center justify-between p-5">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'inline-block h-2.5 w-2.5 rounded-full',
                checking ? 'bg-muted-foreground' : status?.ok ? 'bg-emerald-500' : 'bg-red-500'
              )}
            />
            <div>
              <div className="text-sm font-medium">Database (Turso)</div>
              <div className="text-xs text-muted-foreground">
                {checking ? 'Checking…' : status?.ok ? 'Connected and ready' : status?.message}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{bargainCount ?? '—'}</div>
            <div className="text-xs text-muted-foreground">Bargains</div>
          </div>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((t) => {
            const Icon = t.icon
            return (
              <Card key={t.table} className="p-5">
                <div className={cn('mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg', t.color)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="text-2xl font-semibold tabular-nums">{counts[t.table] ?? '—'}</div>
                <div className="text-sm text-muted-foreground">{t.label}</div>
              </Card>
            )
          })}
        </div>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium">Tankers by stage</div>
            <div className="text-xs text-muted-foreground">{orderTotal} total</div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Tankers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STAGES.map((s) => (
                <TableRow key={s}>
                  <TableCell>{STATUS_LABEL[s]}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {stageCounts[s] ?? 0}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-5">
          <div className="mb-3 text-sm font-medium">Quick actions</div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onNavigate('bargains')}>
              <FileText className="h-4 w-4" />
              New bargain
            </Button>
            <Button variant="outline" onClick={() => onNavigate('production')}>
              <Factory className="h-4 w-4" />
              Production
            </Button>
            <Button variant="outline" onClick={() => onNavigate('sales')}>
              <Tag className="h-4 w-4" />
              Sales
            </Button>
            <Button variant="outline" onClick={() => onNavigate('settings')}>
              Manage settings
            </Button>
          </div>
        </Card>
      </div>
    </>
  )
}
