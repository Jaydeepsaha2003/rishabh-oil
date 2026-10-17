import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, CheckCircle2, GitMerge, Loader2, Search } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDate, formatINR } from '@/lib/format'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// SETTINGS → MERGE PRODUCTS.
//
// For a product opened twice under two names — CPO and CPO-BUNGE. Pick the one
// to retire and the one to keep; the preview lists every register it touches
// and how many rows, and the purchase and sale ledgers that go with it. Nothing
// changes until the merge is confirmed, it runs as one transaction, and every
// row it moves is logged (see productMerge.ts). The retired product is made
// inactive, not deleted, so history still has its name.
export function ProductMerge(): React.JSX.Element {
  const [products, setProducts] = useState<Row[]>([])
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [plan, setPlan] = useState<Row | null>(null)
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('')
  const [history, setHistory] = useState<Row[]>([])

  const load = useCallback(async () => {
    const [p, h] = await Promise.all([
      window.api.data.list('products').catch(() => [] as Row[]),
      window.api.productMerge.list().catch(() => [] as Row[])
    ])
    setProducts(p.filter((x) => x.active !== 0 && x.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name))))
    setHistory(h)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // A changed pick makes the preview on screen out of date.
  useEffect(() => setPlan(null), [fromId, toId])

  const label = (id: string): string => String(products.find((p) => String(p.id) === id)?.name || '')

  async function preview(): Promise<void> {
    if (!fromId || !toId) return
    setBusy('preview')
    try {
      setPlan(await window.api.productMerge.preview(Number(fromId), Number(toId)))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function apply(): Promise<void> {
    if (!plan || plan.blockers?.length) return
    const moves = (plan.rows as Row[]).map((r) => `• ${r.label}: ${r.count}${n(r.combined) ? ` (${r.combined} added into ${plan.to.name}'s own)` : ''}`)
    const ledgers = (plan.ledgers as Row[]).map((l) => `• Ledger ${l.from_name} → ${l.to_name} (${l.lines} posting${l.lines === 1 ? '' : 's'})`)
    const ok = window.confirm(
      [
        `Merge ${plan.from.name} into ${plan.to.name}?`,
        '',
        ...moves,
        ...ledgers,
        '',
        `${plan.from.name} will then be made inactive. This changes historical records and cannot be undone from the screen.`
      ].join('\n')
    )
    if (!ok) return
    setBusy('apply')
    try {
      const r = await window.api.productMerge.apply(Number(fromId), Number(toId))
      toast.success(`${r.from} merged into ${r.to} — ${n(r.total)} record${n(r.total) === 1 ? '' : 's'} moved`)
      setPlan(null)
      setFromId('')
      setToId('')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const picker = (value: string, set: (v: string) => void, placeholder: string, other: string): React.JSX.Element => (
    <Select value={value} onValueChange={set}>
      <SelectTrigger className="h-10 w-full sm:w-[280px]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[360px]">
        {/* One list, A to Z, each with its category — this Select draws its
            items only, so group headings would not show. */}
        {products.map((p) => (
          <SelectItem key={String(p.id)} value={String(p.id)} disabled={String(p.id) === other}>
            {String(p.name)}
            <span className="ml-1.5 text-muted-foreground">· {String(p.category || 'other')}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <GitMerge className="h-5 w-5 text-[#0B6B45]" />
          <h3 className="text-[15px] font-bold">Merge two products into one</h3>
        </div>
        <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-[1.55] text-muted-foreground">
          For one product opened under two names. Everything recorded against the first — bargains, purchase invoices,
          tankers, consignment stock, day-close counts, production, sales — moves to the second, and so do its purchase and
          sale ledgers. The first is then made inactive. Preview first: nothing changes until you confirm.
        </p>

        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-end">
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-[.08em] text-muted-foreground">Merge this product</div>
            {picker(fromId, setFromId, 'e.g. CPO-BUNGE', toId)}
          </div>
          <ArrowRight className="mb-2.5 hidden h-5 w-5 text-muted-foreground sm:block" />
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-[.08em] text-muted-foreground">Into this product (kept)</div>
            {picker(toId, setToId, 'e.g. CPO', fromId)}
          </div>
          <Button onClick={() => void preview()} disabled={!fromId || !toId || !!busy} className="h-10 gap-1.5">
            {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Preview
          </Button>
        </div>
      </Card>

      {plan && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-bold">
              {plan.from.name} <ArrowRight className="inline h-4 w-4 align-[-2px]" /> {plan.to.name}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {n(plan.total)} record{n(plan.total) === 1 ? '' : 's'} to move
            </span>
          </div>

          {(plan.blockers as string[]).length > 0 && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-800">
              <div className="flex items-center gap-1.5 font-bold">
                <AlertTriangle className="h-4 w-4" /> This merge can’t run yet
              </div>
              <ul className="mt-1 list-disc pl-5">
                {(plan.blockers as string[]).map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {(plan.warnings as string[]).length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
              {(plan.warnings as string[]).map((w, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" /> {w}
                </div>
              ))}
            </div>
          )}

          <table className="mt-3 w-full max-w-[760px] text-[13px]">
            <thead>
              <tr className="border-b text-left text-[11px] font-bold uppercase tracking-[.06em] text-muted-foreground">
                <th className="py-1.5">Where</th>
                <th className="py-1.5 text-right">Records</th>
                <th className="py-1.5 pl-4">What happens</th>
              </tr>
            </thead>
            <tbody>
              {(plan.rows as Row[]).length === 0 && (
                <tr>
                  <td colSpan={3} className="py-3 text-muted-foreground">
                    Nothing is recorded against {plan.from.name}.
                  </td>
                </tr>
              )}
              {(plan.rows as Row[]).map((r) => (
                <tr key={`${r.table}.${r.col}`} className="border-b border-dotted">
                  <td className="py-1.5 font-medium">{String(r.label)}</td>
                  <td className="py-1.5 text-right tabular-nums">{n(r.count)}</td>
                  <td className="py-1.5 pl-4 text-[12px] text-muted-foreground">
                    {n(r.combined)
                      ? `${n(r.count) - n(r.combined)} moved · ${n(r.combined)} added into ${plan.to.name}'s entry for the same day`
                      : `moved to ${plan.to.name}`}
                  </td>
                </tr>
              ))}
              {(plan.ledgers as Row[]).map((l) => (
                <tr key={`l${l.from_id}`} className="border-b border-dotted">
                  <td className="py-1.5 font-medium">Ledger {String(l.from_name)}</td>
                  <td className="py-1.5 text-right tabular-nums">{n(l.lines)}</td>
                  <td className="py-1.5 pl-4 text-[12px] text-muted-foreground">
                    {l.action === 'move'
                      ? `postings (Dr ${formatINR(n(l.dr))}${n(l.cr) ? `, Cr ${formatINR(n(l.cr))}` : ''}) move to ${l.to_name}; the old name redirects there`
                      : `renamed to ${l.to_name}; the old name redirects there`}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 font-medium">Product {String(plan.from.name)}</td>
                <td className="py-1.5 text-right">—</td>
                <td className="py-1.5 pl-4 text-[12px] text-muted-foreground">made inactive (kept for history, gone from pickers)</td>
              </tr>
            </tbody>
          </table>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <Button
              variant="destructive"
              onClick={() => void apply()}
              disabled={!!busy || (plan.blockers as string[]).length > 0}
              className="gap-1.5"
            >
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
              Merge {label(fromId)} into {label(toId)}
            </Button>
            <span className="text-[11.5px] text-muted-foreground">One transaction — all of it happens, or none. Every moved row is logged.</span>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="text-[13px] font-bold">Past merges</div>
        {history.length === 0 ? (
          <div className="mt-1.5 text-[12.5px] text-muted-foreground">None yet.</div>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {history.map((h) => (
              <div key={String(h.id)} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <CheckCircle2 className="h-4 w-4 text-[#0B6B45]" />
                <span className="font-semibold">
                  {String(h.from_name)} → {String(h.to_name)}
                </span>
                <span className="text-muted-foreground">
                  {n(h.summary?.total)} records · {formatDate(String(h.created_at || '').slice(0, 10))}
                  {h.created_by ? ` · by ${String(h.created_by)}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
