import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, ChevronRight, Link2, Search, Loader2, Plus, Repeat, Trash2, TrendingDown, TrendingUp, User, Zap } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TagDraftPicker } from '@/components/Tags'
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
  tds_pct: string // purchase steps; '' = the supplier master's
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
  tds_pct: '',
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

export function TradingChains({
  openNewKey = 0,
  onFormChange,
  range = null
}: {
  openNewKey?: number
  onFormChange?: (open: boolean) => void
  // The page's period (Alt+F2), as on Deals.
  range?: { from: string; to: string } | null
}): React.JSX.Element {
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
  // The register: its search, and which chains are opened out.
  const [search, setSearch] = useState('')
  const [openIds, setOpenIds] = useState<Set<number>>(new Set())

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
    setForm({ chain_date: d, product_id: '', qty: '', note: '', tags: [], steps: [blankStep(d, '')] })
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
        tags: form.tags || [],
        legs: steps.map((st) => ({
          seller_kind: st.from ? kindOf(st.from) : 'company',
          seller_id: idOf(st.from),
          buyer_kind: st.to ? kindOf(st.to) : 'company',
          buyer_id: idOf(st.to),
          leg_date: st.leg_date || form.chain_date,
          qty: n(st.qty),
          rate: n(st.rate),
          gst_pct: n(st.gst_pct),
          tds_pct: st.tds_pct,
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
    // A company cannot buy from itself, so the seller is left out of Buys.
    const toOptions = (from: string): React.JSX.Element => (
      <>
        {companies.filter((c) => from !== `c:${n(c.id)}`).map((c) => (
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
    if (!((form.tags as string[]) || []).length) missing.push('Tag')
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
                <div className="flex flex-wrap items-center gap-2 md:col-span-3">
                  <Label className="mr-1">
                    Tags <Req />
                  </Label>
                  <TagDraftPicker value={(form.tags as string[]) || []} onChange={(next) => setForm((f) => (f ? { ...f, tags: next } : f))} label="Tag this chain" />
                  <span className="text-[11px] font-semibold text-[#5A6B62]">Put on every invoice the chain books, in each company</span>
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
                        <Select
                          searchable
                          value={st.from}
                          onValueChange={(v) =>
                            setStep(i, {
                              from: v,
                              link: '',
                              ...(v === st.to ? { to: '' } : {}),
                              // A supplier's TDS % comes from its master, as on a purchase.
                              tds_pct: kindOf(v) === 'party' ? s(suppliers.find((x) => n(x.id) === idOf(v))?.tds_pct ?? '') : ''
                            })
                          }
                        >
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
                          <SelectContent className="max-h-64">{toOptions(st.from)}</SelectContent>
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
                      <div className={cn('grid gap-3.5 sm:grid-cols-2', kind === 'purchase' ? 'lg:grid-cols-[1.4fr_1fr_0.8fr_1fr_0.6fr_0.6fr]' : 'lg:grid-cols-[1.4fr_1fr_0.8fr_1fr_0.6fr]')}>
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
                        {kind === 'purchase' && (
                          <div className="flex flex-col gap-1.5">
                            <Label>TDS %</Label>
                            <Input
                              inputMode="decimal"
                              className="text-right tabular-nums"
                              value={st.tds_pct}
                              title="From the supplier's master — the usual slab and threshold apply when it is booked"
                              onChange={(e) => setStep(i, { tds_pct: e.target.value.replace(/[^0-9.]/g, '') })}
                            />
                          </div>
                        )}
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
                        {st.mode === 'link'
                          ? 'Existing invoice'
                          : `${formatNum(n(st.qty))} MT @ ${formatINR(n(st.rate))} + ${n(st.gst_pct)}% GST${kind === 'purchase' && n(st.tds_pct) > 0 ? ` · TDS ${n(st.tds_pct)}%` : ''}`}
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

  // ── THE LIST — a register, like Deals ───────────────────────────────────
  const stepKind = (l: Row): 'sale' | 'purchase' | 'transfer' =>
    l.seller_kind === 'company' && l.buyer_kind === 'company' ? 'transfer' : l.seller_kind === 'company' ? 'sale' : 'purchase'
  const KIND = {
    sale: { label: 'Sale', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB' },
    purchase: { label: 'Purchase', fg: '#8C2F26', bg: '#FDF3F2', bd: '#F0D6D4' },
    transfer: { label: 'Transfer', fg: '#1B4E82', bg: '#EEF4FC', bd: '#C6DAF0' }
  } as const
  const legValue = (l: Row): number => Math.round(n(l.qty) * n(l.rate) * (1 + n(l.gst_pct) / 100) * 100) / 100
  const chainValue = (ch: Row): number => (ch.legs as Row[]).reduce((t, l) => t + legValue(l), 0)
  const q = search.trim().toUpperCase()
  const shown = chains.filter((ch) => {
    const d = s(ch.chain_date).slice(0, 10)
    if (range && (d < range.from || d > range.to)) return false
    if (!q) return true
    const hay = [
      s(ch.product_code || ch.product_name),
      s(ch.note),
      ...((ch.tags as string[]) || []),
      ...(ch.legs as Row[]).flatMap((l) => [s(l.seller_name), s(l.buyer_name), s(l.invoice_no)])
    ]
      .join(' ')
      .toUpperCase()
    return hay.includes(q)
  })
  const allLegs = shown.flatMap((ch) => ch.legs as Row[])
  const created = allLegs.filter((l) => !n(l.linked)).length
  const tiles = [
    {
      k: 'Chains',
      v: String(shown.length),
      sub: `${new Set(shown.map((ch) => s(ch.product_code || ch.product_name))).size} product${new Set(shown.map((ch) => s(ch.product_code || ch.product_name))).size === 1 ? '' : 's'}`,
      accent: '#0B3D2E',
      Icon: Link2,
      bg: '#EAF0E9',
      fg: '#0B3D2E'
    },
    {
      k: 'Quantity passed on',
      v: `${formatNum(Math.round(shown.reduce((t, ch) => t + n(ch.qty), 0) * 1000) / 1000)} MT`,
      sub: 'across the chains',
      accent: '#1B4E82',
      Icon: Repeat,
      bg: '#EEF4FC',
      fg: '#1B4E82'
    },
    {
      k: 'Steps',
      v: String(allLegs.length),
      sub: `${created} created · ${allLegs.length - created} picked`,
      accent: '#C2700A',
      Icon: ArrowRight,
      bg: '#FFF4E0',
      fg: '#8A5300'
    },
    {
      k: 'Value booked',
      v: formatINR(shown.reduce((t, ch) => t + chainValue(ch), 0)),
      sub: 'every step, with GST',
      accent: '#12855A',
      Icon: TrendingUp,
      bg: '#E9F5EE',
      fg: '#0B6B45'
    }
  ]
  const toggle = (id: number): void =>
    setOpenIds((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const HEAD = 'px-3 py-2.5 text-[10px] font-extrabold uppercase tracking-[.12em] text-[#A9CDBB]'
  return (
    <div className="space-y-3.5">
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="flex items-center gap-3 rounded-[4px] border border-[#D6E2D6] bg-white px-3.5 py-3" style={{ borderTop: `3px solid ${t.accent}` }}>
            <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[3px]" style={{ background: t.bg, color: t.fg }}>
              <t.Icon className="h-[21px] w-[21px]" />
            </div>
            <div className="min-w-0">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{t.k}</div>
              <div className="mt-0.5 truncate text-[19px] font-bold leading-tight tracking-[-0.035em] tabular-nums text-[#0A1F17]" title={t.v}>
                {t.v}
              </div>
              <div className="mt-0.5 text-[11.5px] font-bold text-[#5A6B62]">{t.sub}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[240px] flex-1 sm:max-w-[420px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8CA396]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party, invoice no, tag or note" className="h-10 pl-9 text-[13px]" />
        </div>
        <span className="text-[12px] font-semibold text-[#5A6B62]">
          {shown.length} of {chains.length} chain{chains.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={openNew}
          className="ml-auto flex h-10 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-4 text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] hover:bg-[#0F4A38]"
        >
          <Plus className="h-4 w-4" /> New chain
        </button>
      </div>

      <div className="overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[12.5px]">
            <thead className="bg-[#0B3D2E]">
              <tr>
                <th className={cn(HEAD, 'w-8')} />
                <th className={cn(HEAD, 'text-left')}>Date</th>
                <th className={cn(HEAD, 'text-left')}>Chain</th>
                <th className={cn(HEAD, 'text-left')}>Product</th>
                <th className={cn(HEAD, 'text-right')}>Qty</th>
                <th className={cn(HEAD, 'text-right')}>Steps</th>
                <th className={cn(HEAD, 'text-right')}>Value</th>
                <th className={cn(HEAD, 'text-left')}>Where it ends</th>
                <th className={cn(HEAD, 'w-10')} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-[#8CA396]" />
                  </td>
                </tr>
              ) : shown.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-[12.5px] font-semibold text-[#5A6B62]">
                    {chains.length ? 'No chain matches the search or the period.' : 'No chains yet — New chain to book one.'}
                  </td>
                </tr>
              ) : (
                shown.map((ch) => {
                  const legs = ch.legs as Row[]
                  const open = openIds.has(n(ch.id))
                  const missing = legs.some((l) => l.missing)
                  return (
                    <React.Fragment key={ch.id}>
                      <tr
                        onClick={() => toggle(n(ch.id))}
                        className={cn('cursor-pointer border-t border-[#EFF3EE] align-middle hover:bg-[#F7FAF6]', open && 'bg-[#F3FBE2] hover:bg-[#F3FBE2]')}
                      >
                        <td className="pl-3">
                          <ChevronRight className={cn('h-4 w-4 text-[#8CA396] transition-transform', open && 'rotate-90')} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 font-extrabold tabular-nums text-[#0A1F17]">{formatDate(s(ch.chain_date))}</td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1">
                            {legs.map((l, k) => (
                              <React.Fragment key={l.id}>
                                {k === 0 && <Party name={s(l.seller_name)} company={l.seller_kind === 'company'} />}
                                <ArrowRight className="h-3.5 w-3.5 flex-none" style={{ color: KIND[stepKind(l)].fg }} />
                                <Party name={s(l.buyer_name)} company={l.buyer_kind === 'company'} />
                              </React.Fragment>
                            ))}
                          </div>
                          {(s(ch.note) || ((ch.tags as string[]) || []).length > 0 || missing) && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {((ch.tags as string[]) || []).map((t) => (
                                <span key={t} className="rounded-[3px] border border-[#B9D3F0] bg-[#EAF2FC] px-1.5 py-0.5 text-[10px] font-extrabold text-[#1B4E82]">
                                  {t}
                                </span>
                              ))}
                              {missing && (
                                <span className="rounded-[3px] border border-[#F0C9C4] bg-[#FDECEA] px-1.5 py-0.5 text-[10px] font-extrabold text-[#B3261E]">
                                  An invoice is no longer in the books
                                </span>
                              )}
                              {s(ch.note) && <span className="text-[11px] font-semibold text-[#5A6B62]">{s(ch.note)}</span>}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className="rounded-[3px] bg-[#EAF0E9] px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-[.06em] text-[#33473E]">
                            {s(ch.product_code || ch.product_name)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-bold tabular-nums">{n(ch.qty) > 0 ? `${formatNum(n(ch.qty))} MT` : '—'}</td>
                        <td className="px-3 py-3 text-right font-bold tabular-nums">{legs.length}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-right font-bold tabular-nums text-[#0A1F17]">{formatINR(chainValue(ch))}</td>
                        <td className="px-3 py-3">
                          <NetStrip net={(ch.net as Row[]).map((x) => [s(x.company), n(x.qty)])} />
                        </td>
                        <td className="pr-3 text-right">
                          <button
                            type="button"
                            title="Delete this chain"
                            onClick={(e) => {
                              e.stopPropagation()
                              void remove(ch)
                            }}
                            className="rounded-[3px] p-1.5 text-[#8C2F26] hover:bg-[#FDECEA]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-t border-[#E4ECE3] bg-[#FBFCFA]">
                          <td />
                          <td colSpan={8} className="px-3 pb-4 pt-2">
                            <div className="overflow-hidden rounded-[4px] border border-[#E4ECE3] bg-white">
                              <table className="w-full text-[12px]">
                                <thead className="bg-[#F7FAF6] text-[9.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]">
                                  <tr>
                                    <th className="px-3 py-2 text-left">Step</th>
                                    <th className="px-3 py-2 text-left">Sells → Buys</th>
                                    <th className="px-3 py-2 text-left">Invoice no</th>
                                    <th className="px-3 py-2 text-left">Date</th>
                                    <th className="px-3 py-2 text-right">Qty</th>
                                    <th className="px-3 py-2 text-right">Rate</th>
                                    <th className="px-3 py-2 text-right">GST</th>
                                    <th className="px-3 py-2 text-right">Value</th>
                                    <th className="px-3 py-2 text-left">Booked</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {legs.map((l) => {
                                    const kd = KIND[stepKind(l)]
                                    return (
                                      <tr key={l.id} className="border-t border-[#EFF3EE]">
                                        <td className="whitespace-nowrap px-3 py-2">
                                          <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-extrabold text-white" style={{ background: kd.fg }}>
                                            {n(l.step)}
                                          </span>
                                          <span className="rounded-[3px] border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.05em]" style={{ color: kd.fg, background: kd.bg, borderColor: kd.bd }}>
                                            {kd.label}
                                          </span>
                                        </td>
                                        <td className="px-3 py-2 font-bold text-[#0A1F17]">
                                          {s(l.seller_name).trim()} <span className="text-[#8CA396]">→</span> {s(l.buyer_name).trim()}
                                        </td>
                                        <td className={cn('doc-ref whitespace-nowrap px-3 py-2 font-bold', l.missing && 'text-[#B3261E] line-through')}>{s(l.invoice_no) || '—'}</td>
                                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDate(s(l.leg_date))}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatNum(n(l.qty))} MT</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatINR(n(l.rate))}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                          {n(l.gst_pct)}%{n(l.tds_pct) > 0 ? <span className="block text-[10px] text-[#5A6B62]">TDS {n(l.tds_pct)}%</span> : null}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums">{formatINR(legValue(l))}</td>
                                        <td className="whitespace-nowrap px-3 py-2">
                                          {l.missing ? (
                                            <span className="text-[11px] font-extrabold text-[#B3261E]">Deleted from its page</span>
                                          ) : n(l.linked) ? (
                                            <span className="inline-flex items-center gap-1 text-[11px] font-extrabold text-[#1B4E82]">
                                              <Link2 className="h-3.5 w-3.5" /> Picked existing
                                            </span>
                                          ) : (
                                            <span className="text-[11px] font-extrabold text-[#0B6B45]">Created by the chain</span>
                                          )}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
