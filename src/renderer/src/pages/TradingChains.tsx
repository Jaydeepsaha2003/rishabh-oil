import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRight, Building2, Link2, Loader2, Plus, Trash2, User, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useFormPageEscape } from '@/lib/escape'
import { formatDate, formatINR, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'
import { useEntryWindow } from '@/lib/useEntryWindow'

// CHAIN TRADING — one parcel through several hands, some of them ours
// (src/main/tradingChains.ts). Each step creates its invoice in the books of
// whichever of our companies stands on it, or links one already booked.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const n = (v: unknown): number => Number(v) || 0
const s = (v: unknown): string => (v == null ? '' : String(v))

type Step = {
  from: string // 'c:1' company, 'p:9' supplier
  to: string // 'c:2' company, 'p:37' customer
  mode: 'create' | 'link'
  qty: string
  rate: string
  gst_pct: string
  invoice_no: string
  leg_date: string
  link: string // sale_group or order_id
}

const blankStep = (date: string, qty: string, from = ''): Step => ({
  from,
  to: '',
  mode: 'create',
  qty,
  rate: '',
  gst_pct: '5',
  invoice_no: '',
  leg_date: date,
  link: ''
})

const kindOf = (v: string): 'company' | 'party' => (v.startsWith('c:') ? 'company' : 'party')
const idOf = (v: string): number => Number(v.slice(2)) || 0

export function TradingChains({ openNewKey = 0 }: { openNewKey?: number }): React.JSX.Element {
  const minDate = useEntryWindow('trading')
  const [chains, setChains] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Row[]>([])
  const [form, setForm] = useState<Row | null>(null)
  const [saving, setSaving] = useState(false)
  // Linkable invoices per step, keyed by the step's from|to|product.
  const [links, setLinks] = useState<Record<string, Row[]>>({})

  const load = (): void => {
    void window.api.trading
      .chains()
      .then(setChains)
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    void Promise.all([window.api.company.list(), window.api.data.list('products'), window.api.data.list('suppliers'), window.api.data.list('customers')]).then(
      ([c, p, sp, cu]) => {
        setCompanies(c as Row[])
        setProducts(p as Row[])
        // Our own companies are picked as companies, not as their party records.
        setSuppliers((sp as Row[]).filter((x) => !n(x.company_link_id)))
        setCustomers((cu as Row[]).filter((x) => !n(x.company_link_id)))
      }
    )
  }, [])
  useLiveRefresh(load)

  const openNew = (): void => {
    const d = todayISO()
    setLinks({})
    setForm({ chain_date: d, product_id: '', qty: '', note: '', steps: [blankStep(d, '')] })
  }
  useEffect(() => {
    if (openNewKey) openNew()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNewKey])
  useFormPageEscape(!!form, !!form && (form.steps as Step[]).some((x) => x.from || x.to), () => setForm(null), saving)

  const nameOf = (v: string, side: 'from' | 'to'): string => {
    if (!v) return ''
    const id = idOf(v)
    if (kindOf(v) === 'company') return s(companies.find((c) => n(c.id) === id)?.name)
    return s((side === 'from' ? suppliers : customers).find((x) => n(x.id) === id)?.name).trim()
  }
  // A step after a party buyer starts with that party selling — the same name
  // in the supplier list.
  const carryFrom = (to: string): string => {
    if (!to) return ''
    if (kindOf(to) === 'company') return to
    const nm = nameOf(to, 'to').toUpperCase()
    const sp = suppliers.find((x) => s(x.name).trim().toUpperCase() === nm)
    return sp ? `p:${n(sp.id)}` : ''
  }

  const steps: Step[] = (form?.steps as Step[]) || []
  const setStep = (i: number, patch: Partial<Step>): void =>
    setForm((f) => (f ? { ...f, steps: (f.steps as Step[]).map((x, j) => (j === i ? { ...x, ...patch } : x)) } : f))
  const linkKey = (st: Step): string => `${st.from}|${st.to}|${s(form?.product_id)}`

  // Load what a step in Link mode can pick from.
  useEffect(() => {
    if (!form) return
    for (const st of steps) {
      if (st.mode !== 'link' || !st.from || !st.to) continue
      if (kindOf(st.from) === 'party' && kindOf(st.to) === 'party') continue
      const key = linkKey(st)
      if (links[key]) continue
      setLinks((m) => ({ ...m, [key]: [] }))
      void window.api.trading
        .chainLinkable({ product_id: n(form.product_id), seller_kind: kindOf(st.from), seller_id: idOf(st.from), buyer_kind: kindOf(st.to), buyer_id: idOf(st.to) })
        .then((rows) => setLinks((m) => ({ ...m, [key]: rows })))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  // Where each of our companies ends up on the chain being typed.
  const qtyOf = (st: Step): number => {
    if (st.mode === 'link') return n(links[linkKey(st)]?.find((r) => s(r.sale_group || r.order_id) === st.link)?.qty)
    return n(st.qty)
  }
  const netPreview = useMemo(() => {
    const m = new Map<number, number>()
    for (const st of steps) {
      const q = qtyOf(st)
      if (st.from && kindOf(st.from) === 'company') m.set(idOf(st.from), (m.get(idOf(st.from)) || 0) - q)
      if (st.to && kindOf(st.to) === 'company') m.set(idOf(st.to), (m.get(idOf(st.to)) || 0) + q)
    }
    return [...m.entries()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, links])

  async function save(): Promise<void> {
    if (!form) return
    setSaving(true)
    try {
      await window.api.trading.chainCreate({
        chain_date: form.chain_date,
        product_id: n(form.product_id),
        qty: n(form.qty),
        note: form.note,
        legs: steps.map((st) => ({
          seller_kind: st.from ? kindOf(st.from) : 'company',
          seller_id: idOf(st.from),
          buyer_kind: st.to ? kindOf(st.to) : 'company',
          buyer_id: idOf(st.to),
          leg_date: st.leg_date || form.chain_date,
          qty: n(st.qty),
          rate: n(st.rate),
          gst_pct: n(st.gst_pct),
          invoice_no: st.invoice_no,
          ...(st.mode === 'link' ? (kindOf(st.from) === 'company' ? { existing_sale_group: st.link } : { existing_order_id: n(st.link) }) : {})
        }))
      })
      toast.success('Chain saved — each step is booked in its company')
      setForm(null)
      load()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  async function remove(ch: Row): Promise<void> {
    const made = (ch.legs as Row[]).filter((l) => !n(l.linked)).length
    if (!confirm(`Delete this chain? The ${made} invoice${made === 1 ? '' : 's'} it created (and their vouchers) are removed; linked invoices stay as they are.`)) return
    try {
      await window.api.trading.chainDelete(n(ch.id))
      toast.success('Chain deleted')
      load()
    } catch (e) {
      toast.error((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const Party = ({ name, company }: { name: string; company: boolean }): React.JSX.Element => (
    <span
      className={cn(
        'inline-flex max-w-[220px] items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px] font-extrabold',
        company ? 'border-[#0B6B45] bg-[#E9F5EE] text-[#0B3D2E]' : 'border-[#DCE7DB] bg-white text-[#33473E]'
      )}
      title={name}
    >
      {company ? <Building2 className="h-3.5 w-3.5 flex-none" /> : <User className="h-3.5 w-3.5 flex-none text-[#8CA396]" />}
      <span className="truncate">{name}</span>
    </span>
  )
  const NetStrip = ({ net }: { net: [string, number][] }): React.JSX.Element => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">Net</span>
      {net.map(([nm, q]) => (
        <span
          key={nm}
          className={cn(
            'rounded-[3px] px-2 py-0.5 text-[11px] font-extrabold tabular-nums',
            Math.abs(q) < 0.0005 ? 'bg-[#EAF0E9] text-[#33473E]' : q > 0 ? 'bg-[#E9F5EE] text-[#0B6B45]' : 'bg-[#FDECEA] text-[#8C2F26]'
          )}
        >
          {nm} {q > 0.0005 ? '+' : ''}
          {formatNum(Math.round(q * 1000) / 1000)}
        </span>
      ))}
    </div>
  )

  // ── THE FORM ────────────────────────────────────────────────────────────
  if (form) {
    const fromOptions = (
      <>
        {companies.map((c) => (
          <SelectItem key={`c${c.id}`} value={`c:${n(c.id)}`}>
            {s(c.name)} · our company
          </SelectItem>
        ))}
        {suppliers.map((x) => (
          <SelectItem key={`p${x.id}`} value={`p:${n(x.id)}`}>
            {s(x.name).trim()}
          </SelectItem>
        ))}
      </>
    )
    const toOptions = (
      <>
        {companies.map((c) => (
          <SelectItem key={`c${c.id}`} value={`c:${n(c.id)}`}>
            {s(c.name)} · our company
          </SelectItem>
        ))}
        {customers.map((x) => (
          <SelectItem key={`p${x.id}`} value={`p:${n(x.id)}`}>
            {s(x.name).trim()}
          </SelectItem>
        ))}
      </>
    )
    const lbl = 'mb-1 block text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]'
    return (
      <div className="rounded-[6px] border border-[#DCE7DB] bg-white">
        <div className="flex items-center gap-3 border-b border-[#E4ECE3] bg-[#0B3D2E] px-5 py-3 text-white">
          <div className="flex-1">
            <div className="text-[9.5px] font-extrabold uppercase tracking-[.14em] text-[#C7F03F]">New chain</div>
            <div className="text-[15px] font-extrabold">One parcel through several hands</div>
          </div>
          <button type="button" onClick={() => setForm(null)} className="rounded-[4px] p-1 hover:bg-white/10" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <span className={lbl}>Date</span>
              <DatePicker min={minDate} value={s(form.chain_date)} onChange={(v) => setForm((f) => (f ? { ...f, chain_date: v } : f))} />
            </div>
            <div>
              <span className={lbl}>Product</span>
              <Select searchable value={s(form.product_id)} onValueChange={(v) => setForm((f) => (f ? { ...f, product_id: v } : f))}>
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {products.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {s(p.code || p.name)}
                      {p.code && p.name && p.code !== p.name ? ` · ${s(p.name)}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <span className={lbl}>Quantity (MT)</span>
              <Input
                inputMode="decimal"
                value={s(form.qty)}
                onChange={(e) => {
                  const q = e.target.value.replace(/[^0-9.]/g, '')
                  // Steps still on the old quantity follow the chain's.
                  setForm((f) => (f ? { ...f, qty: q, steps: (f.steps as Step[]).map((x) => (x.qty === s(f.qty) ? { ...x, qty: q } : x)) } : f))
                }}
              />
            </div>
            <div>
              <span className={lbl}>Note</span>
              <Input value={s(form.note)} onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))} placeholder="Optional" />
            </div>
          </div>

          <div className="space-y-2.5">
            {steps.map((st, i) => {
              const opts = links[linkKey(st)] || []
              const canLink = !!st.from && !!st.to && !(kindOf(st.from) === 'party' && kindOf(st.to) === 'party')
              const doc =
                !st.from || !st.to
                  ? ''
                  : kindOf(st.from) === 'company' && kindOf(st.to) === 'company'
                    ? `Transfer: sale in ${nameOf(st.from, 'from')}, purchase in ${nameOf(st.to, 'to')}`
                    : kindOf(st.from) === 'company'
                      ? `Sale in ${nameOf(st.from, 'from')}'s books`
                      : kindOf(st.to) === 'company'
                        ? `Purchase in ${nameOf(st.to, 'to')}'s books`
                        : 'One side must be one of our companies'
              return (
                <div key={i} className="rounded-[6px] border border-[#E4ECE3] bg-[#FBFCFA] p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0B3D2E] text-[11px] font-extrabold text-white">{i + 1}</span>
                    <span className="text-[11.5px] font-bold text-[#5A6B62]">{doc}</span>
                    <div className="ml-auto flex rounded-[4px] border border-[#C9DCCF] bg-white p-0.5">
                      {(['create', 'link'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          disabled={m === 'link' && !canLink}
                          onClick={() => setStep(i, { mode: m, link: '' })}
                          className={cn(
                            'rounded-[3px] px-2.5 py-1 text-[11px] font-extrabold disabled:opacity-40',
                            st.mode === m ? 'bg-[#0B3D2E] text-white' : 'text-[#33473E] hover:bg-[#F0F8F3]'
                          )}
                        >
                          {m === 'create' ? 'Create invoice' : 'Pick existing'}
                        </button>
                      ))}
                    </div>
                    {steps.length > 1 && (
                      <button
                        type="button"
                        title="Remove this step"
                        onClick={() => setForm((f) => (f ? { ...f, steps: (f.steps as Step[]).filter((_, j) => j !== i) } : f))}
                        className="rounded-[3px] p-1 text-[#8C2F26] hover:bg-[#FDECEA]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="grid items-end gap-2 md:grid-cols-[1fr_auto_1fr]">
                    <div>
                      <span className={lbl}>Sells</span>
                      <Select searchable value={st.from} onValueChange={(v) => setStep(i, { from: v, link: '' })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Company or supplier" />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">{fromOptions}</SelectContent>
                      </Select>
                    </div>
                    <ArrowRight className="mb-2.5 hidden h-4 w-4 text-[#8CA396] md:block" />
                    <div>
                      <span className={lbl}>Buys</span>
                      <Select searchable value={st.to} onValueChange={(v) => setStep(i, { to: v, link: '' })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Company or customer" />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">{toOptions}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  {st.mode === 'link' ? (
                    <div className="mt-2">
                      <span className={lbl}>Invoice already booked</span>
                      <Select searchable value={st.link} onValueChange={(v) => setStep(i, { link: v })}>
                        <SelectTrigger>
                          <SelectValue placeholder={opts.length ? 'Pick the invoice' : 'No invoices of this product between them'} />
                        </SelectTrigger>
                        <SelectContent className="max-h-64">
                          {opts.map((r) => (
                            <SelectItem key={s(r.sale_group || r.order_id)} value={s(r.sale_group || r.order_id)}>
                              {s(r.invoice_no) || '—'} · {formatDate(s(r.date))} · {formatNum(n(r.qty))} MT @ {formatINR(n(r.rate))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                      <div>
                        <span className={lbl}>Invoice no</span>
                        <Input value={st.invoice_no} onChange={(e) => setStep(i, { invoice_no: e.target.value })} />
                      </div>
                      <div>
                        <span className={lbl}>Date</span>
                        <DatePicker min={minDate} value={st.leg_date} onChange={(v) => setStep(i, { leg_date: v })} />
                      </div>
                      <div>
                        <span className={lbl}>Qty (MT)</span>
                        <Input inputMode="decimal" value={st.qty} onChange={(e) => setStep(i, { qty: e.target.value.replace(/[^0-9.]/g, '') })} />
                      </div>
                      <div>
                        <span className={lbl}>Rate / MT</span>
                        <Input inputMode="decimal" value={st.rate} onChange={(e) => setStep(i, { rate: e.target.value.replace(/[^0-9.]/g, '') })} />
                      </div>
                      <div>
                        <span className={lbl}>GST %</span>
                        <Input inputMode="decimal" value={st.gst_pct} onChange={(e) => setStep(i, { gst_pct: e.target.value.replace(/[^0-9.]/g, '') })} />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <button
              type="button"
              onClick={() =>
                setForm((f) => {
                  if (!f) return f
                  const last = (f.steps as Step[])[(f.steps as Step[]).length - 1]
                  return { ...f, steps: [...(f.steps as Step[]), blankStep(last?.leg_date || s(f.chain_date), s(f.qty), carryFrom(last?.to || ''))] }
                })
              }
              className="flex items-center gap-1.5 rounded-[5px] border border-dashed border-[#9CB8A6] px-3 py-2 text-[12px] font-extrabold text-[#0B6B45] hover:bg-[#F0F8F3]"
            >
              <Plus className="h-3.5 w-3.5" /> Add step
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-[#E4ECE3] bg-[#FBFCFA] px-5 py-3">
          <div className="mr-auto">
            {netPreview.length > 0 && <NetStrip net={netPreview.map(([cid, q]) => [s(companies.find((c) => n(c.id) === cid)?.name), q])} />}
            <div className="mt-1 text-[11px] font-semibold text-[#5A6B62]">Created invoices are trading only — no stock moves. Linked invoices are left as they are.</div>
          </div>
          <button
            type="button"
            onClick={() => setForm(null)}
            className="h-9 rounded-[5px] border border-[#C9DCCF] bg-white px-4 text-[12px] font-extrabold text-[#33473E] hover:bg-[#F0F8F3]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-5 text-[12px] font-extrabold text-white hover:bg-[#0B6B45] disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save chain
          </button>
        </div>
      </div>
    )
  }

  // ── THE LIST ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="text-[12px] font-semibold text-[#5A6B62]">
          A parcel passed through several hands — each step booked in the company that stands on it.
        </div>
        <button
          type="button"
          onClick={openNew}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-[5px] bg-[#0B3D2E] px-4 text-[12px] font-extrabold text-white hover:bg-[#0B6B45]"
        >
          <Plus className="h-4 w-4" /> New chain
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[#8CA396]" />
        </div>
      ) : chains.length === 0 ? (
        <div className="rounded-[6px] border border-dashed border-[#C9DCCF] bg-white py-12 text-center text-[12.5px] font-semibold text-[#5A6B62]">
          No chains yet — New chain to book one.
        </div>
      ) : (
        chains.map((ch) => (
          <div key={ch.id} className="rounded-[6px] border border-[#DCE7DB] bg-white">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#EFF3EE] px-4 py-2.5">
              <span className="text-[13px] font-extrabold text-[#0A1F17]">{formatDate(s(ch.chain_date))}</span>
              <span className="rounded-[3px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#33473E]">
                {s(ch.product_code || ch.product_name)}
              </span>
              {n(ch.qty) > 0 && <span className="text-[12px] font-bold tabular-nums text-[#33473E]">{formatNum(n(ch.qty))} MT</span>}
              {s(ch.note) && <span className="text-[11.5px] font-semibold text-[#5A6B62]">{s(ch.note)}</span>}
              <div className="ml-auto flex items-center gap-3">
                <NetStrip net={(ch.net as Row[]).map((x) => [s(x.company), n(x.qty)])} />
                <button type="button" title="Delete this chain" onClick={() => void remove(ch)} className="rounded-[3px] p-1 text-[#8C2F26] hover:bg-[#FDECEA]">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-stretch gap-2 px-4 py-3">
              {(ch.legs as Row[]).map((l, k) => (
                <div key={l.id} className="flex items-center gap-2">
                  {k === 0 && <Party name={s(l.seller_name)} company={l.seller_kind === 'company'} />}
                  <div className="flex flex-col items-center px-1" title={l.missing ? 'This invoice is no longer in the books' : undefined}>
                    <span className="flex items-center gap-1 text-[10px] font-extrabold text-[#0B6B45]">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#0B3D2E] text-[9px] text-white">{n(l.step)}</span>
                      {n(l.linked) ? <Link2 className="h-3 w-3" /> : null}
                      <span className={cn('doc-ref', l.missing && 'text-[#B3261E] line-through')}>{s(l.invoice_no) || '—'}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 text-[#8CA396]" />
                    <span className="text-[10px] font-bold tabular-nums text-[#5A6B62]">
                      {formatNum(n(l.qty))} @ {formatINR(n(l.rate))}
                    </span>
                  </div>
                  <Party name={s(l.buyer_name)} company={l.buyer_kind === 'company'} />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
