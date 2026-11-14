import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, Link2, Loader2, Plus, Repeat, Trash2, TrendingDown, TrendingUp, User, Zap } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

// The trading deal form's section frame (Trading.tsx SECTION_WEB / SECTION_HEAD).
const SECTION_WEB =
  'overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white [&_label]:!text-[10px] [&_label]:!font-extrabold [&_label]:uppercase [&_label]:!tracking-[.12em] [&_label]:!text-[#5A6B62] [&_input]:!h-[46px] [&_input]:!rounded-[4px] [&_input]:!text-[13.5px] [&_[data-slot=select-trigger]]:!h-[46px] [&_[data-slot=select-trigger]]:!rounded-[4px] [&_[data-slot=select-trigger]]:!text-[13.5px] [&_[data-slot=date-picker]]:!h-[46px] [&_[data-slot=date-picker]]:!rounded-[4px] [&_[data-slot=date-picker]]:!text-[14px]'
const SECTION_HEAD = 'border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-4 py-3 text-[11.5px] font-extrabold tracking-[.14em] text-[#0A1F17]'
const Req = (): React.JSX.Element => <span className="text-[#B3261E]">*</span>

const kindOf = (v: string): 'company' | 'party' => (v.startsWith('c:') ? 'company' : 'party')
const idOf = (v: string): number => Number(v.slice(2)) || 0

export function TradingChains({ openNewKey = 0, onFormChange }: { openNewKey?: number; onFormChange?: (open: boolean) => void }): React.JSX.Element {
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
  // The page's own header steps aside while the form is open, as for a deal.
  useEffect(() => onFormChange?.(!!form), [form, onFormChange])
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

  // ── THE FORM — the same frame as New trading deal ───────────────────────
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
    const prod = products.find((x) => String(x.id) === s(form.product_id))
    const prodLabel = prod ? s(prod.code || prod.name) : ''
    // What a step books, and its colour: a sale goes out (green), a purchase
    // comes in (rose), a transfer is both (blue).
    const kindOfStep = (st: Step): 'sale' | 'purchase' | 'transfer' | 'none' =>
      !st.from || !st.to
        ? 'none'
        : kindOf(st.from) === 'company' && kindOf(st.to) === 'company'
          ? 'transfer'
          : kindOf(st.from) === 'company'
            ? 'sale'
            : kindOf(st.to) === 'company'
              ? 'purchase'
              : 'none'
    const TONE = {
      sale: { head: '!bg-[#F4FBF6]', chip: 'bg-[#0B6B45]', fg: 'text-[#0B6B45]', Icon: TrendingUp },
      purchase: { head: '!bg-[#FDF3F2]', chip: 'bg-[#8C2F26]', fg: 'text-[#8C2F26]', Icon: TrendingDown },
      transfer: { head: '!bg-[#EEF4FC]', chip: 'bg-[#1B4E82]', fg: 'text-[#1B4E82]', Icon: Repeat },
      none: { head: '', chip: 'bg-[#0B3D2E]', fg: 'text-[#0A1F17]', Icon: Link2 }
    } as const
    const stepValue = (st: Step): number => {
      if (st.mode === 'link') return n(links[linkKey(st)]?.find((r) => s(r.sale_group || r.order_id) === st.link)?.amount)
      const taxable = n(st.qty) * n(st.rate)
      return Math.round(taxable * (1 + n(st.gst_pct) / 100) * 100) / 100
    }
    // What is still to fill in, one chip each — as on a trading deal.
    const missing: string[] = []
    if (!form.product_id) missing.push('Product')
    steps.forEach((st, i) => {
      const k = `Step ${i + 1}`
      if (!st.from) missing.push(`${k}: seller`)
      if (!st.to) missing.push(`${k}: buyer`)
      if (st.from && st.to && kindOfStep(st) === 'none') missing.push(`${k}: one side must be ours`)
      if (st.mode === 'link') {
        if (!st.link) missing.push(`${k}: invoice`)
      } else {
        if (!st.invoice_no.trim()) missing.push(`${k}: invoice no`)
        if (!(n(st.qty) > 0)) missing.push(`${k}: qty`)
        if (!(n(st.rate) > 0)) missing.push(`${k}: rate`)
      }
    })
    const creates = steps.filter((st) => st.mode === 'create').length
    return (
      <div className="py-0">
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-[4px] bg-[#0B3D2E] px-5 py-3 text-white shadow-[0_8px_20px_-12px_rgba(10,31,23,0.55)]">
          <button
            type="button"
            onClick={() => setForm(null)}
            className="inline-flex h-10 items-center gap-2 rounded-[4px] border-[1.5px] border-[#C7F03F]/70 px-3.5 text-[13px] font-extrabold uppercase tracking-[.04em] text-[#C7F03F] hover:bg-[#C7F03F] hover:text-[#12280B]"
          >
            <ArrowLeft className="h-[19px] w-[19px]" /> Back
          </button>
          <div className="h-6 border-l border-l-white/20" />
          <h2 className="text-[14px] font-extrabold uppercase tracking-[.12em]">New chain</h2>
          <span className="ml-auto flex items-center gap-2 text-[12px] font-bold text-[#8FBFA8]">
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[3px] bg-[#C7F03F]/15">
              <Zap className="h-4 w-4 text-[#C7F03F]" />
            </span>
            One parcel through several hands — each step booked in its company, no stock
          </span>
        </div>

        <div className="grid gap-3.5 pt-3.5 xl:grid-cols-[1fr_360px]">
          <div className="space-y-3.5">
            {/* 1 · CHAIN DETAILS */}
            <section className={SECTION_WEB}>
              <h3 className={cn(SECTION_HEAD, 'flex items-center gap-2.5 uppercase')}>
                <span className="rounded-[2px] bg-[#0B3D2E] px-2 py-1 text-[10.5px] font-extrabold tracking-normal text-[#C7F03F]">1</span>
                <Link2 className="h-[18px] w-[18px] text-[#0B3D2E]" />
                Chain details
                <span
                  className={cn(
                    'ml-auto rounded-[3px] border px-2.5 py-1.5 text-[12px] font-bold normal-case tabular-nums tracking-normal',
                    prodLabel ? 'border-[#D6E2D6] bg-white text-[#0A1F17]' : 'border-[#DCE7DB] bg-[#F7FAF6] text-[#7C9188]'
                  )}
                >
                  {prodLabel ? `${prodLabel} · ${formatDate(s(form.chain_date))}` : 'No product chosen yet'}
                </span>
              </h3>
              <div className="grid gap-3.5 p-4 md:grid-cols-[1.4fr_1fr_160px]">
                <div className="flex flex-col gap-1.5">
                  <Label>
                    Product <Req />
                  </Label>
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
                <div className="flex flex-col gap-1.5">
                  <Label>Chain date</Label>
                  <DatePicker min={minDate} value={s(form.chain_date)} onChange={(v) => setForm((f) => (f ? { ...f, chain_date: v } : f))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Quantity (MT)</Label>
                  <Input
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={s(form.qty)}
                    onChange={(e) => {
                      const q = e.target.value.replace(/[^0-9.]/g, '')
                      // Steps still on the old quantity follow the chain's.
                      setForm((f) => (f ? { ...f, qty: q, steps: (f.steps as Step[]).map((x) => (x.qty === s(f.qty) ? { ...x, qty: q } : x)) } : f))
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-3">
                  <Label>
                    Note <span className="ml-1 rounded-[2px] bg-[#EAF0E9] px-1.5 py-0.5 text-[9px] tracking-[.08em]">Optional</span>
                  </Label>
                  <Input value={s(form.note)} onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))} placeholder="Anything worth recording against this chain" />
                </div>
              </div>
            </section>

            {/* 2… · ONE SECTION PER STEP */}
            {steps.map((st, i) => {
              const kind = kindOfStep(st)
              const t = TONE[kind]
              const opts = links[linkKey(st)] || []
              const canLink = kind !== 'none'
              const doc =
                kind === 'transfer'
                  ? `Transfer · sale in ${nameOf(st.from, 'from')}, purchase in ${nameOf(st.to, 'to')}`
                  : kind === 'sale'
                    ? `Sale (out) · ${nameOf(st.from, 'from')}'s books`
                    : kind === 'purchase'
                      ? `Purchase (in) · ${nameOf(st.to, 'to')}'s books`
                      : st.from && st.to
                        ? 'One side must be one of our companies'
                        : 'Pick who sells and who buys'
              return (
                <section key={i} className={SECTION_WEB}>
                  <h3 className={cn(SECTION_HEAD, t.head, 'flex flex-wrap items-center gap-2.5 uppercase')}>
                    <span className={cn('rounded-[2px] px-2 py-1 text-[10.5px] font-extrabold tracking-normal text-white', t.chip)}>{i + 2}</span>
                    <t.Icon className={cn('h-[18px] w-[18px]', t.fg)} />
                    <span className={t.fg}>Step {i + 1}</span>
                    <span className="text-[11.5px] font-bold normal-case tracking-normal text-[#5A6B62]">{doc}</span>
                    <div className="ml-auto flex items-center gap-2 normal-case tracking-normal">
                      <div className="flex rounded-[4px] border border-[#C9DCCF] bg-white p-0.5">
                        {(['create', 'link'] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            disabled={m === 'link' && !canLink}
                            onClick={() => setStep(i, { mode: m, link: '' })}
                            className={cn(
                              'rounded-[3px] px-3 py-1.5 text-[11.5px] font-extrabold disabled:opacity-40',
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
                          className="rounded-[3px] p-1.5 text-[#8C2F26] hover:bg-[#FDECEA]"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </h3>
                  <div className="space-y-3.5 p-4">
                    <div className="grid items-end gap-3.5 md:grid-cols-[1fr_auto_1fr]">
                      <div className="flex flex-col gap-1.5">
                        <Label>
                          Sells <Req />
                        </Label>
                        <Select searchable value={st.from} onValueChange={(v) => setStep(i, { from: v, link: '' })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select company or supplier" />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">{fromOptions}</SelectContent>
                        </Select>
                      </div>
                      <ArrowRight className="mb-3.5 hidden h-5 w-5 text-[#8CA396] md:block" />
                      <div className="flex flex-col gap-1.5">
                        <Label>
                          Buys <Req />
                        </Label>
                        <Select searchable value={st.to} onValueChange={(v) => setStep(i, { to: v, link: '' })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select company or customer" />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">{toOptions}</SelectContent>
                        </Select>
                      </div>
                    </div>
                    {st.mode === 'link' ? (
                      <div className="flex flex-col gap-1.5">
                        <Label>
                          Invoice already booked <Req />
                        </Label>
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
                      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_0.8fr_1fr_0.6fr]">
                        <div className="flex flex-col gap-1.5">
                          <Label>
                            Invoice no <Req />
                          </Label>
                          <Input value={st.invoice_no} placeholder="Invoice no." onChange={(e) => setStep(i, { invoice_no: e.target.value })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>Date</Label>
                          <DatePicker min={minDate} value={st.leg_date} onChange={(v) => setStep(i, { leg_date: v })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>
                            Qty <Req />
                          </Label>
                          <Input inputMode="decimal" className="text-right tabular-nums" value={st.qty} onChange={(e) => setStep(i, { qty: e.target.value.replace(/[^0-9.]/g, '') })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>
                            Rate (₹) <Req />
                          </Label>
                          <Input inputMode="decimal" className="text-right tabular-nums" value={st.rate} onChange={(e) => setStep(i, { rate: e.target.value.replace(/[^0-9.]/g, '') })} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label>GST %</Label>
                          <Input inputMode="decimal" className="text-right tabular-nums" value={st.gst_pct} onChange={(e) => setStep(i, { gst_pct: e.target.value.replace(/[^0-9.]/g, '') })} />
                        </div>
                      </div>
                    )}
                  </div>
                </section>
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
              className="flex h-10 items-center gap-2 rounded-[4px] border-[1.5px] border-[#0B3D2E] bg-white px-4 text-[12.5px] font-extrabold uppercase tracking-[.04em] text-[#0B3D2E] hover:bg-[#F0F8F3]"
            >
              <Plus className="h-4 w-4" /> Add step
            </button>

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-4 py-3.5 shadow-[0_-6px_18px_-8px_rgba(10,31,23,0.28)]">
              {saving ? (
                <span className="mr-auto text-[12px] text-muted-foreground">Posting {creates} invoice{creates === 1 ? '' : 's'} — please wait, do not close this window.</span>
              ) : missing.length ? (
                <span className="mr-auto flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[.08em] text-[#8A5300]">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[#C2700A]" />
                    Still needed
                  </span>
                  {missing.slice(0, 6).map((m) => (
                    <span key={m} className="rounded-[3px] border border-[#F0D9AE] bg-[#FFFBF2] px-2 py-1 text-[11.5px] font-bold text-[#8A5300]">
                      {m}
                    </span>
                  ))}
                  {missing.length > 6 && <span className="text-[11.5px] font-bold text-[#8A5300]">+{missing.length - 6} more</span>}
                </span>
              ) : (
                <span className="mr-auto flex items-center gap-2 rounded-[3px] border border-[#BFE3CB] bg-[#F4FBF6] px-2.5 py-1.5 text-[12px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[#12855A]" />
                  Ready to book
                </span>
              )}
              <button
                type="button"
                disabled={saving}
                onClick={() => setForm(null)}
                className="h-12 rounded-[4px] border-[1.5px] border-[#C3D2C6] bg-white px-6 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#33473E] hover:bg-[#F7FAF6]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="flex h-12 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-7 text-[13.5px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-80"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {saving ? 'Booking chain…' : `Book chain · ${steps.length} step${steps.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>

          {/* THE RAIL: where each company ends up, and what each step is worth. */}
          <aside className="h-fit space-y-3 xl:sticky xl:top-20">
            <div className="rounded-[4px] border border-l-4 border-[#BFE3CB] border-l-[#12855A] bg-[#F4FBF6] px-4 py-3.5">
              <div className="flex items-center gap-2">
                <Building2 className="h-[19px] w-[19px] text-[#12855A]" />
                <span className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#0B6B45]">Where each company ends up</span>
              </div>
              {netPreview.length ? (
                <div className="mt-2 space-y-1.5">
                  {netPreview.map(([cid, q]) => (
                    <div key={cid} className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12.5px] font-bold text-[#0A1F17]">{s(companies.find((c) => n(c.id) === cid)?.name)}</span>
                      <span className={cn('text-[18px] font-bold tabular-nums', Math.abs(q) < 0.0005 ? 'text-[#33473E]' : q > 0 ? 'text-[#0B6B45]' : 'text-[#B3261E]')}>
                        {q > 0.0005 ? '+' : ''}
                        {formatNum(Math.round(q * 1000) / 1000)} MT
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1.5 text-[11.5px] font-bold text-[#0B6B45]">Pick who sells and who buys on each step</div>
              )}
            </div>
            <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
              <div className="border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[.14em] text-[#0A1F17]">Steps</div>
              {steps.map((st, i) => {
                const kind = kindOfStep(st)
                return (
                  <div key={i} className="flex items-center gap-2.5 border-b border-[#EFF3EE] px-4 py-2.5 last:border-b-0">
                    <span className={cn('flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-extrabold text-white', TONE[kind].chip)}>{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-bold text-[#0A1F17]">
                        {nameOf(st.from, 'from') || '—'} → {nameOf(st.to, 'to') || '—'}
                      </div>
                      <div className="text-[10.5px] font-semibold text-[#5A6B62]">
                        {st.mode === 'link' ? 'Existing invoice' : `${formatNum(n(st.qty))} MT @ ${formatINR(n(st.rate))} + ${n(st.gst_pct)}% GST`}
                      </div>
                    </div>
                    <span className="text-[12.5px] font-bold tabular-nums text-[#0A1F17]">{formatINR(stepValue(st))}</span>
                  </div>
                )
              })}
              <div className="bg-[#F7FAF6] px-4 py-2.5 text-[11px] font-semibold leading-snug text-[#5A6B62]">
                Created invoices are trading only — no stock moves. Picked invoices are left as they are.
              </div>
            </div>
          </aside>
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
