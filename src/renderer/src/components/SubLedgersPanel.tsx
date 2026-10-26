import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeftRight, ChevronDown, Factory, GitBranch, Pencil, Plus, Save, Unlink, X } from 'lucide-react'
import { errText } from '@/lib/format'
import { BUSINESS_TYPES } from '@/lib/constants'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// What a new sub-ledger takes from its main party, besides TDS (which the
// server copies itself — repos.ts applyMainParty).
const INHERIT: Record<'suppliers' | 'customers', string[]> = {
  suppliers: ['supplier_type', 'company_type', 'credit_period_days', 'adds_interest', 'interest_pct', 'interest_days', 'skip_tanker_stages'],
  customers: ['category', 'company_type', 'credit_period_days', 'adds_interest', 'interest_pct', 'interest_days']
}
const EDITABLE = ['name', 'business_type', 'gstin', 'state', 'gst_pct', 'gst_rates'] as const
type Draft = Record<(typeof EDITABLE)[number], string>
const blank = (type: string): Draft => ({ name: '', business_type: type, gstin: '', state: '', gst_pct: '', gst_rates: '' })
const draftOf = (r: Row): Draft => ({
  name: String(r.name ?? ''),
  business_type: String(r.business_type ?? ''),
  gstin: String(r.gstin ?? ''),
  state: String(r.state ?? ''),
  gst_pct: r.gst_pct == null ? '' : String(r.gst_pct),
  gst_rates: String(r.gst_rates ?? '')
})

// EVERY LEDGER UNDER ONE PARTY, MANAGED FROM ITS WINDOW (DIL EXIM → DIL EXIM –
// RAJKOT, DIL EXIM COMMODITIES): each one's name, type, GSTIN, state and GST
// rates, edited in place; a new one added here, Trading or Manufacturing; one
// detached to stand on its own. The party list shows the family as one row.
//
// A Trading ledger under a Manufacturing party is its trading counterpart and
// keeps its own name at the gate; one of the same type is a branch, shown at
// the gate as the main party (lib/mainParty.ts). TDS is the main party's.
export function SubLedgersPanel({
  table,
  mainId,
  mainForm,
  readOnly,
  onChanged
}: {
  table: 'suppliers' | 'customers'
  mainId: number
  mainForm: Row
  readOnly?: boolean
  onChanged?: () => void
}): React.JSX.Element {
  const mainType = String(mainForm.business_type || 'Manufacturing')
  // What can be added here: only the party's other side — its Trading ledger
  // under a Manufacturing party (or the other way round). Branches of the same
  // type are GST rows on the party now (GstRegsPanel), not ledgers.
  const other = mainType === 'Trading' ? 'Manufacturing' : 'Trading'
  const [subs, setSubs] = useState<Row[] | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [add, setAdd] = useState<Draft>(blank(other))
  const [busy, setBusy] = useState(false)
  // Which sub-ledger is open for editing, and whether the add form is showing.
  const [openId, setOpenId] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const all = (await window.api.data.list(table)) as Row[]
    const mine = all
      .filter((r) => Number(r.linked_party_id) === mainId)
      .sort((a, b) => String(a.business_type).localeCompare(String(b.business_type)) || String(a.name).localeCompare(String(b.name)))
    setSubs(mine)
    setDrafts(Object.fromEntries(mine.map((r) => [Number(r.id), draftOf(r)])))
  }, [table, mainId])
  useEffect(() => {
    void load().catch((e) => toast.error(errText(e)))
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const values = (d: Draft): Row => ({
    name: d.name.trim(),
    business_type: d.business_type || mainType,
    gstin: d.gstin.trim() || null,
    state: d.state.trim() || null,
    gst_pct: d.gst_pct === '' ? 0 : Number(d.gst_pct),
    gst_rates: d.gst_rates.trim() || null
  })
  const saveSub = (r: Row): Promise<void> => {
    const d = drafts[Number(r.id)]
    if (!d.name.trim()) return Promise.resolve(void toast.error('A sub-ledger needs a name'))
    return run(async () => {
      await window.api.data.update(table, Number(r.id), { ...r, ...values(d), linked_party_id: mainId })
      setOpenId(null)
    }, `${d.name.trim()} saved`)
  }
  const detach = (r: Row): Promise<void> => {
    if (!window.confirm(`Detach ${String(r.name)} from this party? It stays as a party of its own, with its ledger and history, and sets its own TDS again.`)) return Promise.resolve()
    return run(() => window.api.data.update(table, Number(r.id), { ...r, linked_party_id: null }), `${String(r.name)} is a party of its own now`)
  }
  const addSub = (): Promise<void> => {
    if (!add.name.trim()) return Promise.resolve(void toast.error('Give the sub-ledger a name — e.g. the main name and the branch'))
    const inherited = Object.fromEntries(INHERIT[table].map((k) => [k, mainForm[k]]))
    return run(async () => {
      await window.api.data.create(table, { ...inherited, ...values(add), linked_party_id: mainId, active: true })
      setAdd(blank(other))
      setAdding(false)
    }, `${add.name.trim()} added under ${String(mainForm.name || 'this party')} as ${add.business_type || mainType}`)
  }

  // Colours by type — blue for Trading, green for Manufacturing — used on
  // the stripe, the tag and the type switch alike.
  const TONE = (t: string): { bar: string; tagBg: string; tagFg: string; tagBd: string; on: string } =>
    String(t) === 'Trading'
      ? { bar: '#1B4E82', tagBg: '#EAF0FA', tagFg: '#1B4E82', tagBd: '#C6DAF0', on: 'border-[#1B4E82] bg-[#1B4E82] text-white' }
      : { bar: '#0B6B45', tagBg: '#E9F5EE', tagFg: '#0B6B45', tagBd: '#BFE3CB', on: 'border-[#0B3D2E] bg-[#0B3D2E] text-white' }
  const cap = 'mb-1 block text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]'
  const input =
    'h-10 w-full rounded-[6px] border border-[#C3D2C6] bg-white px-3 text-[13.5px] font-semibold text-[#0A1F17] outline-none transition-colors placeholder:font-medium placeholder:text-[#A8B8AE] focus:border-[#0B3D2E] focus:ring-2 focus:ring-[#0B3D2E]/10 disabled:bg-[#F4F7F3]'
  const field = (d: Draft, set: (p: Partial<Draft>) => void, k: Exclude<(typeof EDITABLE)[number], 'business_type'>, label: string, ph = ''): React.JSX.Element => (
    <label className="min-w-0">
      <span className={cap}>{label}</span>
      <input
        value={d[k]}
        disabled={readOnly || busy}
        inputMode={k === 'gst_pct' ? 'decimal' : undefined}
        placeholder={ph}
        onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)}
        className={cn(input, k === 'name' && 'uppercase placeholder:normal-case', k === 'gstin' && 'font-mono uppercase')}
      />
    </label>
  )
  // Trading or Manufacturing — one switch of two, each with its icon.
  const typePick = (d: Draft, set: (p: Partial<Draft>) => void): React.JSX.Element => (
    <div className="min-w-0">
      <span className={cap}>Type</span>
      <div className="grid h-10 grid-cols-2 gap-1 rounded-[7px] border border-[#D6E2D6] bg-[#F4F7F3] p-1">
        {BUSINESS_TYPES.map((t) => {
          const on = (d.business_type || mainType) === t.value
          const Icon = t.value === 'Trading' ? ArrowLeftRight : Factory
          return (
            <button
              key={t.value}
              type="button"
              disabled={readOnly || busy}
              onClick={() => set({ business_type: t.value })}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-[5px] border text-[12px] font-extrabold transition-colors',
                on ? TONE(t.value).on : 'border-transparent text-[#5A6B62] hover:bg-white'
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
  const form = (d: Draft, set: (p: Partial<Draft>) => void, ph: string, fixedType?: boolean): React.JSX.Element => (
    <div className="grid gap-2.5">
      <div className={cn('grid grid-cols-1 gap-2.5', !fixedType && 'sm:grid-cols-[minmax(0,1fr)_250px]')}>
        {field(d, set, 'name', 'Name', ph)}
        {!fixedType && typePick(d, set)}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[1.4fr_1fr_90px_1fr]">
        {field(d, set, 'gstin', 'GSTIN', '22AAAAA0000A1Z5')}
        {field(d, set, 'state', 'State', 'e.g. Gujarat')}
        {field(d, set, 'gst_pct', 'GST %', '5')}
        {field(d, set, 'gst_rates', 'GST rates', '5, 18')}
      </div>
    </div>
  )
  const tag = (t: string): React.JSX.Element => {
    const c = TONE(t || mainType)
    const Icon = (t || mainType) === 'Trading' ? ArrowLeftRight : Factory
    return (
      <span
        className="inline-flex flex-none items-center gap-1 rounded-[3px] border px-1.5 py-[2px] text-[9.5px] font-extrabold uppercase tracking-[.06em]"
        style={{ background: c.tagBg, color: c.tagFg, borderColor: c.tagBd }}
      >
        <Icon className="h-3 w-3" /> {t || mainType}
      </span>
    )
  }
  const counts = BUSINESS_TYPES.map((t) => ({ t: t.value, n: (subs || []).filter((r) => (String(r.business_type) || mainType) === t.value).length })).filter((x) => x.n)

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-[#CFE0D2] bg-white shadow-[0_1px_2px_rgba(10,31,23,.04),0_10px_24px_-18px_rgba(10,31,23,.35)]">
      {/* HEAD — what this is, how many of each. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#DCE7DB] bg-[linear-gradient(160deg,#F4FAF6,#EAF4EC)] px-4 py-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-[#0B3D2E]">
          <GitBranch className="h-[17px] w-[17px] text-[#C7F03F]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-extrabold text-[#0A1F17]">{other} side</span>
            <span className="rounded-full bg-[#0B3D2E] px-2 py-px text-[10.5px] font-extrabold tabular-nums text-white">{subs ? subs.length : '…'}</span>
          </div>
          <div className="text-[11.5px] font-semibold text-[#5A6B62]">
            The {other} ledger of {String(mainForm.name || 'this party')} — kept apart, TDS shared. Other states or branches go under More GST Nos. above.
          </div>
        </div>
        <span className="ml-auto flex flex-wrap gap-2">
          {counts.map((x) => (
            <span key={x.t} className="flex items-center gap-1">
              {tag(x.t)}
              <span className="text-[11px] font-extrabold tabular-nums text-[#33473E]">{x.n}</span>
            </span>
          ))}
        </span>
      </div>

      <div className="grid gap-2 p-3">
        {subs == null ? (
          <div className="px-1 py-3 text-[12px] text-[#5A6B62]">Reading…</div>
        ) : subs.length === 0 && !adding ? (
          <div className="flex flex-col items-center rounded-[8px] border border-dashed border-[#C3D2C6] bg-[#FBFCFA] px-6 py-5 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F1F8EC]">
              <GitBranch className="h-5 w-5 text-[#0B6B45]" />
            </span>
            <div className="mt-2 text-[13px] font-extrabold text-[#0A1F17]">No {other} side</div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-[#5A6B62]">Add it if this party also deals with you as a {other.toLowerCase()} party.</div>
          </div>
        ) : null}

        {/* EACH SUB-LEDGER — a line that reads at a glance, opening to edit. */}
        {(subs || []).map((r) => {
          const id = Number(r.id)
          const d = drafts[id] || draftOf(r)
          const changed = JSON.stringify(d) !== JSON.stringify(draftOf(r))
          const open = openId === id
          const c = TONE(String(r.business_type) || mainType)
          return (
            <div
              key={id}
              className={cn('overflow-hidden rounded-[8px] border bg-white transition-shadow', open ? 'border-[#9FB6A6] shadow-[0_8px_20px_-14px_rgba(10,31,23,.45)]' : 'border-[#DCE7DB]')}
              style={{ borderLeft: `4px solid ${c.bar}` }}
            >
              <button type="button" onClick={() => setOpenId(open ? null : id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[#FAFCF9]">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-[13px] font-extrabold uppercase text-[#0A1F17]">{String(r.name)}</span>
                    {tag(String(r.business_type || ''))}
                    {(String(r.business_type) || mainType) === mainType && (
                      <span
                        className="rounded-[3px] border border-[#F0D6A6] bg-[#FFF6E3] px-1.5 py-[2px] text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#8A5A00]"
                        title="A branch kept as its own ledger the old way — fold it into this party (its GST No. becomes a row above) under Settings → Accounting checks"
                      >
                        Old branch · fold in
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] font-semibold text-[#5A6B62]">
                    <span className={cn(!r.gstin && 'text-[#A8B8AE]')}>{r.gstin ? <span className="font-mono">{String(r.gstin)}</span> : 'No GSTIN'}</span>
                    {r.state ? <span>{String(r.state)}</span> : null}
                    <span>GST {r.gst_rates ? String(r.gst_rates) : `${Number(r.gst_pct) || 0}%`}</span>
                  </span>
                </span>
                {changed && <span className="flex-none rounded-[3px] bg-[#FFF6E3] px-1.5 py-0.5 text-[10px] font-extrabold text-[#8A5A00]">UNSAVED</span>}
                {!readOnly && !open && <Pencil className="h-4 w-4 flex-none text-[#8CA396]" />}
                <ChevronDown className={cn('h-4 w-4 flex-none text-[#8CA396] transition-transform', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="border-t border-[#EAF0E9] bg-[#FBFCFA] px-3.5 pb-3 pt-3">
                  {form(d, (p) => setDrafts((x) => ({ ...x, [id]: { ...d, ...p } })), '')}
                  {!readOnly && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void detach(r)}
                        className="flex h-9 items-center gap-1.5 rounded-[6px] border border-[#E5C9C6] bg-white px-3 text-[12px] font-bold text-[#8C2F26] hover:bg-rose-50"
                      >
                        <Unlink className="h-3.5 w-3.5" /> Detach
                      </button>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => {
                          setDrafts((x) => ({ ...x, [id]: draftOf(r) }))
                          setOpenId(null)
                        }}
                        className="h-9 rounded-[6px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#33473E] hover:bg-[#F4F7F3]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy || !changed}
                        onClick={() => void saveSub(r)}
                        className="flex h-9 items-center gap-1.5 rounded-[6px] bg-[#0B3D2E] px-3.5 text-[12px] font-extrabold text-[#C7F03F] hover:bg-[#0F4A38] disabled:opacity-40"
                      >
                        <Save className="h-3.5 w-3.5" /> Save
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* ADD — a button until it is wanted, then the form. */}
        {!readOnly &&
          (adding ? (
            <div className="overflow-hidden rounded-[8px] border-2 border-dashed border-[#9FC9AE] bg-[#F7FBF8]">
              <div className="flex items-center gap-2 px-3.5 pt-3">
                <Plus className="h-4 w-4 text-[#0B6B45]" />
                <span className="text-[12px] font-extrabold uppercase tracking-[.1em] text-[#0B3D2E]">New {other} side</span>
                <span className="flex-1" />
                <button
                  type="button"
                  title="Cancel"
                  onClick={() => {
                    setAdding(false)
                    setAdd(blank(other))
                  }}
                  className="text-[#8CA396] hover:text-[#33473E]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-3.5 pt-2.5">
                {form(add, (p) => setAdd((x) => ({ ...x, ...p, business_type: other })), `The ${other} name of this party — e.g. DIL EXIM COMMODITIES`, true)}
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <span className="mr-auto basis-full text-[11px] font-semibold text-[#5A6B62] sm:basis-auto">Takes this party&apos;s TDS, credit days and interest terms.</span>
                  <button
                    type="button"
                    disabled={busy || !add.name.trim()}
                    onClick={() => void addSub()}
                    className="flex h-9 items-center gap-1.5 rounded-[6px] bg-[#C7F03F] px-3.5 text-[12px] font-extrabold text-[#0B3D2E] shadow-[0_6px_14px_-8px_rgba(122,160,20,.9)] hover:bg-[#B9E62F] disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" /> Add the {other} side
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-11 items-center justify-center gap-2 rounded-[8px] border-2 border-dashed border-[#C3D2C6] bg-[#FBFCFA] text-[12.5px] font-extrabold text-[#0B3D2E] transition-colors hover:border-[#0B6B45] hover:bg-[#F1F8EC]"
            >
              <Plus className="h-4 w-4" /> Add the {other} side
            </button>
          ))}
      </div>
    </div>
  )
}
