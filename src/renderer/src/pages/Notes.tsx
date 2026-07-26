import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { DatePicker } from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

type NoteType = 'debit' | 'credit'

// Debit note → supplier (purchase return / reduce payable).
// Credit note → customer (sales return / reduce receivable).
export function Notes(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | NoteType>('all')
  const [expanded, setExpanded] = useState<Record<number, Row[]>>({})

  const [formPage, setFormPage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Row>({})

  const load = useCallback(async () => {
    setLoading(true)
    const [nts, sup, cus, prd] = await Promise.all([
      window.api.notes.list(),
      window.api.data.list('suppliers'),
      window.api.data.list('customers'),
      window.api.data.list('products')
    ])
    setRows(nts)
    setSuppliers(sup.filter((x) => x.active))
    setCustomers(cus.filter((x) => x.active))
    setProducts(prd.filter((x) => x.active))
    setExpanded({})
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  async function toggleExpand(id: number): Promise<void> {
    if (expanded[id]) {
      setExpanded((p) => {
        const next = { ...p }
        delete next[id]
        return next
      })
      return
    }
    const items = await window.api.notes.items(id)
    setExpanded((p) => ({ ...p, [id]: items }))
  }

  const visible = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.note_type === filter)),
    [rows, filter]
  )

  function openAdd(type: NoteType): void {
    setForm({
      note_type: type,
      note_date: todayISO(),
      party_id: '',
      against_account: type === 'debit' ? 'PURCHASE RETURN A/C' : 'SALES RETURN A/C',
      base_amount: '',
      gst_pct: '',
      narration: '',
      items: []
    })
    setError(null)
    setFormPage(true)
  }

  const type: NoteType = form.note_type === 'credit' ? 'credit' : 'debit'
  const parties = type === 'debit' ? suppliers : customers
  // Products relevant to the note kind (raw for purchase returns, finished for
  // sales returns) with a fallback to everything.
  const noteProducts = useMemo(() => {
    const cats = type === 'debit' ? ['raw', 'intermediate'] : ['finished']
    const filtered = products.filter((p) => cats.includes(String(p.category)))
    return filtered.length ? filtered : products
  }, [products, type])
  const items: Row[] = Array.isArray(form.items) ? form.items : []
  const itemsTotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0)
  const hasItems = items.length > 0
  const base = hasItems ? Math.round(itemsTotal * 100) / 100 : Number(form.base_amount) || 0
  const gst = Math.round(base * ((Number(form.gst_pct) || 0) / 100) * 100) / 100
  const total = Math.round((base + gst) * 100) / 100

  function setItem(i: number, patch: Row): void {
    setForm((p) => {
      const arr = [...(Array.isArray(p.items) ? p.items : [])]
      arr[i] = { ...arr[i], ...patch }
      return { ...p, items: arr }
    })
  }
  function addItem(): void {
    setForm((p) => ({ ...p, items: [...(Array.isArray(p.items) ? p.items : []), { product_id: '', qty: '', rate: '' }] }))
  }
  function removeItem(i: number): void {
    setForm((p) => ({ ...p, items: (Array.isArray(p.items) ? p.items : []).filter((_: Row, idx: number) => idx !== i) }))
  }

  async function save(): Promise<void> {
    if (!form.party_id) { setError(`Select the ${type === 'debit' ? 'supplier' : 'customer'}`); return }
    if (base <= 0) { setError('Enter a base amount greater than zero'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.notes.create({
        note_type: type,
        note_date: form.note_date,
        party_id: Number(form.party_id),
        against_account: form.against_account,
        base_amount: base,
        gst_pct: Number(form.gst_pct) || 0,
        narration: form.narration || null,
        items: items
          .filter((it) => (Number(it.qty) || 0) > 0 && (Number(it.rate) || 0) >= 0)
          .map((it) => ({ product_id: it.product_id ? Number(it.product_id) : null, qty: Number(it.qty) || 0, rate: Number(it.rate) || 0 }))
      })
      toast.success(`${type === 'debit' ? 'Debit' : 'Credit'} note ${res.note_no} posted`)
      setFormPage(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function del(row: Row): Promise<void> {
    if (!window.confirm(`Delete ${row.note_no}? This reverses its ledger and party postings.`)) return
    try {
      await window.api.notes.remove(Number(row.id))
      toast.success(`${row.note_no} deleted`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const totals = useMemo(() => {
    const dn = visible.filter((r) => r.note_type === 'debit').reduce((s, r) => s + (Number(r.total_amount) || 0), 0)
    const cn = visible.filter((r) => r.note_type === 'credit').reduce((s, r) => s + (Number(r.total_amount) || 0), 0)
    return { dn, cn }
  }, [visible])

  return (
    <>
      {!formPage && (
      <>
      <PageHeader
        title="Debit / Credit Notes"
        subtitle="Tally-style adjustment notes that post to the ledger and the party balance"
        hint="A Debit Note is raised against a supplier (purchase return / rate reduction — lowers what you owe). A Credit Note is raised against a customer (sales return / allowance — lowers what they owe). Each posts a double-entry voucher (visible on the Ledgers page) and adjusts the party's outstanding. GST, when entered, reverses Input (debit note) or Output (credit note) tax."
        actions={
          <div className="flex items-center gap-2">
            <ExcelButton
              filename={`debit-credit-notes-${todayISO()}`}
              sheetName="Notes"
              title="Debit / Credit notes"
              columns={[
                { header: 'No', key: 'note_no', value: (r) => r.note_no || '' },
                { header: 'Type', key: 'note_type', value: (r) => (r.note_type === 'debit' ? 'Debit note' : 'Credit note') },
                { header: 'Date', key: 'note_date', value: (r) => formatDate(r.note_date) },
                { header: 'Party', key: 'party_name', value: (r) => r.party_name || '' },
                { header: 'Against', key: 'against_account', value: (r) => r.against_account || '' },
                { header: 'Base', key: 'base_amount', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.base_amount) || 0 },
                { header: 'GST %', key: 'gst_pct', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.gst_pct) || 0 },
                { header: 'GST', key: 'gst_amount', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.gst_amount) || 0 },
                { header: 'Total', key: 'total_amount', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.total_amount) || 0 },
                { header: 'Narration', key: 'narration', value: (r) => r.narration || '' }
              ]}
              rows={visible}
            />
            <Button size="sm" variant="outline" onClick={() => openAdd('debit')}>
              <Plus className="h-4 w-4" /> Debit note
            </Button>
            <Button size="sm" onClick={() => openAdd('credit')}>
              <Plus className="h-4 w-4" /> Credit note
            </Button>
          </div>
        }
      />
      <div className="w-full space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Notes</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{visible.length}</div>
          </div>
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Debit notes (supplier)</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-amber-700">{formatINR(totals.dn)}</div>
          </div>
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Credit notes (customer)</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-emerald-700">{formatINR(totals.cn)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'debit', 'credit'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium capitalize',
                filter === f ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/40'
              )}
            >
              {f === 'all' ? 'All' : f === 'debit' ? 'Debit notes' : 'Credit notes'}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <Table className="min-w-[900px] text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">No</TableHead>
                <TableHead className="w-[110px]">Type</TableHead>
                <TableHead className="w-[110px]">Date</TableHead>
                <TableHead>Party</TableHead>
                <TableHead>Against</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">GST</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : visible.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No notes yet. Raise a debit or credit note above.</TableCell></TableRow>
              ) : (
                visible.map((r) => {
                  const hasItems = Number(r.item_count) > 0
                  const isOpen = !!expanded[r.id as number]
                  return (
                  <Fragment key={r.id as number}>
                  <TableRow className={cn(hasItems && 'cursor-pointer')} onClick={hasItems ? () => toggleExpand(Number(r.id)) : undefined}>
                    <TableCell className="font-medium tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        {hasItems ? (isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />) : <span className="w-3.5" />}
                        {r.note_no}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.note_type === 'debit' ? 'warning' : 'success'}>
                        {r.note_type === 'debit' ? 'Debit' : 'Credit'}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(r.note_date)}</TableCell>
                    <TableCell className="font-medium">{r.party_name || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.against_account}{hasItems ? ` · ${r.item_count} item${Number(r.item_count) === 1 ? '' : 's'}` : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(r.base_amount)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {Number(r.gst_amount) > 0 ? `${formatINR(r.gst_amount)} (${formatNum(r.gst_pct)}%)` : '—'}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatINR(r.total_amount)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => del(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={9} className="p-0">
                        <div className="px-6 py-3">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-left text-muted-foreground">
                                <th className="py-1.5 pr-3 font-semibold w-8">#</th>
                                <th className="py-1.5 pr-3 font-semibold">Product</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Qty</th>
                                <th className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                                <th className="py-1.5 text-right font-semibold">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(expanded[r.id as number] || []).map((it, ii) => (
                                <tr key={it.id as number} className="border-b last:border-0">
                                  <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{ii + 1}</td>
                                  <td className="py-1.5 pr-3 font-medium">{it.product_name || it.description || '—'}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatNum(it.qty)}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatINR(it.rate)}</td>
                                  <td className="py-1.5 text-right tabular-nums">{formatINR(it.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      </>
      )}

      {formPage && (
      <div className="w-full p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b pb-3">
          <button className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => setFormPage(false)}>
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="h-4 border-l" />
          <h2 className="text-base font-semibold">{type === 'debit' ? 'New debit note (supplier)' : 'New credit note (customer)'}</h2>
          <p className="text-sm text-muted-foreground">
            {type === 'debit'
              ? 'Purchase return / rate reduction — lowers what you owe the supplier.'
              : 'Sales return / allowance — lowers what the customer owes.'}
          </p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          {/* Left: details + items */}
          <div className="space-y-6">
            <section className="rounded-xl border bg-card p-5">
              <h3 className="mb-4 font-medium">Note details</h3>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label>Date</Label>
                  <DatePicker value={form.note_date} onChange={(v) => setForm((p) => ({ ...p, note_date: v || '' }))} />
                </div>
                <div className="grid gap-1.5">
                  <Label>{type === 'debit' ? 'Supplier *' : 'Customer *'}</Label>
                  <Select value={String(form.party_id || '')} onValueChange={(v) => setForm((p) => ({ ...p, party_id: v }))}>
                    <SelectTrigger><SelectValue placeholder={`Select ${type === 'debit' ? 'supplier' : 'customer'}`} /></SelectTrigger>
                    <SelectContent>
                      {parties.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>GST %</Label>
                  <Input type="number" value={form.gst_pct ?? ''} placeholder="0" onChange={(e) => setForm((p) => ({ ...p, gst_pct: e.target.value }))} />
                </div>
                <div className="grid gap-1.5 md:col-span-2">
                  <Label>Against account</Label>
                  <Input
                    value={form.against_account ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, against_account: e.target.value }))}
                    placeholder={type === 'debit' ? 'PURCHASE RETURN A/C' : 'SALES RETURN A/C'}
                  />
                </div>
                <div className="grid gap-1.5 md:col-span-3">
                  <Label>Narration</Label>
                  <Input value={form.narration ?? ''} onChange={(e) => setForm((p) => ({ ...p, narration: e.target.value }))} placeholder="Reason for the note" />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">The against ledger is where the note posts (e.g. return, rate difference, discount). Created automatically if new.</p>
            </section>

            <section className="rounded-xl border bg-card p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium">Items <span className="text-sm font-normal text-muted-foreground">(optional)</span></h3>
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4" /> Add item
                </Button>
              </div>
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">Add product lines to build the amount automatically, or just enter a base amount on the right.</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem_8rem_2.25rem] items-center gap-3 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span>Product</span>
                    <span className="text-right">Qty</span>
                    <span className="text-right">Rate</span>
                    <span className="text-right">Amount</span>
                    <span />
                  </div>
                  {items.map((it, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem_7rem_8rem_2.25rem] items-center gap-3">
                      <Select value={String(it.product_id || '')} onValueChange={(v) => setItem(i, { product_id: v })}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Product" /></SelectTrigger>
                        <SelectContent>
                          {noteProducts.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input className="h-9 text-right" type="number" placeholder="Qty" value={it.qty ?? ''} onChange={(e) => setItem(i, { qty: e.target.value })} />
                      <Input className="h-9 text-right" type="number" placeholder="Rate" value={it.rate ?? ''} onChange={(e) => setItem(i, { rate: e.target.value })} />
                      <div className="text-right tabular-nums text-muted-foreground">{formatINR((Number(it.qty) || 0) * (Number(it.rate) || 0))}</div>
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(i)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Right: amount summary + actions */}
          <div className="space-y-4">
            <section className="rounded-xl border bg-card p-5">
              <h3 className="mb-4 font-medium">Amount</h3>
              <div className="grid gap-1.5">
                <Label>Base amount {hasItems ? '(from items)' : '*'}</Label>
                <Input
                  type="number"
                  autoFocus={!hasItems}
                  disabled={hasItems}
                  value={hasItems ? base : (form.base_amount ?? '')}
                  onChange={(e) => setForm((p) => ({ ...p, base_amount: e.target.value }))}
                />
              </div>
              <div className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">
                <div className="flex justify-between py-0.5"><span className="text-muted-foreground">Base</span><span className="tabular-nums">{formatINR(base)}</span></div>
                <div className="flex justify-between py-0.5"><span className="text-muted-foreground">GST ({formatNum(Number(form.gst_pct) || 0)}%)</span><span className="tabular-nums">{formatINR(gst)}</span></div>
                <div className="mt-1 flex justify-between border-t pt-1 text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatINR(total)}</span></div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {type === 'debit'
                  ? 'Reduces the supplier payable by the total; reverses Input GST.'
                  : 'Reduces the customer receivable by the total; reverses Output GST.'}
              </p>
            </section>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 border-t pt-4">
              <Button variant="outline" onClick={() => setFormPage(false)} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? 'Posting…' : 'Post note'}</Button>
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  )
}
