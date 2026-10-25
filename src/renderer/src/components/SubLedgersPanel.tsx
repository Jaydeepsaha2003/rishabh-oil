import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { GitBranch, Plus, Save, Unlink } from 'lucide-react'
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
  const [subs, setSubs] = useState<Row[] | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [add, setAdd] = useState<Draft>(blank(mainType))
  const [busy, setBusy] = useState(false)

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
    return run(() => window.api.data.update(table, Number(r.id), { ...r, ...values(d), linked_party_id: mainId }), `${d.name.trim()} saved`)
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
      setAdd(blank(mainType))
    }, `${add.name.trim()} added under ${String(mainForm.name || 'this party')} as ${add.business_type || mainType}`)
  }

  const box = 'rounded-[6px] border border-[#DCE7DB] bg-white p-3'
  const cap = 'mb-1 block text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]'
  const field = (d: Draft, set: (p: Partial<Draft>) => void, k: Exclude<(typeof EDITABLE)[number], 'business_type'>, label: string, ph = ''): React.JSX.Element => (
    <label className="min-w-0">
      <span className={cap}>{label}</span>
      <input
        value={d[k]}
        disabled={readOnly || busy}
        inputMode={k === 'gst_pct' ? 'decimal' : undefined}
        placeholder={ph}
        onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)}
        className="w-full rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[14px] font-semibold outline-none focus:border-[#1B4E82]"
      />
    </label>
  )
  // Trading or Manufacturing, as two square chips — the choice this panel is for.
  const typePick = (d: Draft, set: (p: Partial<Draft>) => void): React.JSX.Element => (
    <div className="min-w-0">
      <span className={cap}>Type</span>
      <div className="flex gap-1">
        {BUSINESS_TYPES.map((t) => {
          const on = (d.business_type || mainType) === t.value
          return (
            <button
              key={t.value}
              type="button"
              disabled={readOnly || busy}
              onClick={() => set({ business_type: t.value })}
              className={cn(
                'h-10 flex-1 rounded-[3px] border px-2 text-[12px] font-extrabold',
                on
                  ? t.value === 'Trading'
                    ? 'border-[#1B4E82] bg-[#1B4E82] text-white'
                    : 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                  : 'border-[#C3D2C6] bg-white text-[#5A6B62] hover:border-[#9FB6A6]'
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
  const grid = (d: Draft, set: (p: Partial<Draft>) => void, ph: string): React.JSX.Element => (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_230px] gap-2">
        {field(d, set, 'name', 'Name', ph)}
        {typePick(d, set)}
      </div>
      <div className="mt-2 grid grid-cols-[1.3fr_1fr_80px_1fr] gap-2">
        {field(d, set, 'gstin', 'GSTIN')}
        {field(d, set, 'state', 'State')}
        {field(d, set, 'gst_pct', 'GST %')}
        {field(d, set, 'gst_rates', 'GST rates', '5, 18')}
      </div>
    </>
  )
  const typeTag = (t: string): React.JSX.Element => (
    <span
      className={cn(
        'rounded-[2px] border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[.06em]',
        t === 'Trading' ? 'border-[#C6DAF0] bg-[#EAF0FA] text-[#1B4E82]' : 'border-[#BFE3CB] bg-[#E9F5EE] text-[#0B6B45]'
      )}
    >
      {t || mainType}
    </span>
  )

  return (
    <div className="mt-2 rounded-[8px] border-2 border-[#BFE3CB] bg-[#F4FAF6] p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <GitBranch className="h-4 w-4 text-[#0B6B45]" />
        <span className="text-[12px] font-extrabold uppercase tracking-[.12em] text-[#0B3D2E]">Sub-ledgers</span>
        <span className="rounded-full bg-[#0B3D2E] px-2 py-0.5 text-[10.5px] font-bold text-white">{subs ? subs.length : '…'}</span>
        <span className="ml-auto text-[11px] font-semibold text-[#5A6B62]">Trading or Manufacturing — TDS is this party&apos;s for all of them</span>
      </div>
      {subs == null ? (
        <div className="py-2 text-[12px] text-[#5A6B62]">Reading…</div>
      ) : (
        <div className="grid gap-2.5">
          {subs.length === 0 && (
            <div className="text-[12px] text-[#5A6B62]">No sub-ledgers yet — add a branch, a factory or the Trading side of this party below.</div>
          )}
          {subs.map((r) => {
            const id = Number(r.id)
            const d = drafts[id] || draftOf(r)
            const changed = JSON.stringify(d) !== JSON.stringify(draftOf(r))
            return (
              <div key={id} className={box}>
                <div className="mb-2 flex items-center gap-2">
                  {typeTag(String(r.business_type || ''))}
                  <span className="min-w-0 truncate text-[12px] font-bold text-[#0A1F17]">{String(r.name)}</span>
                </div>
                {grid(d, (p) => setDrafts((x) => ({ ...x, [id]: { ...d, ...p } })), '')}
                {!readOnly && (
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void detach(r)}
                      className="flex items-center gap-1 rounded-[4px] border border-[#E5C9C6] bg-white px-2.5 py-1.5 text-[11.5px] font-bold text-[#8C2F26] hover:bg-rose-50"
                    >
                      <Unlink className="h-3.5 w-3.5" /> Detach
                    </button>
                    <button
                      type="button"
                      disabled={busy || !changed}
                      onClick={() => void saveSub(r)}
                      className="flex items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-3 py-1.5 text-[11.5px] font-bold text-white disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          {!readOnly && (
            <div className={`${box} border-dashed border-[#9FB6A6]`}>
              {grid(add, (p) => setAdd((x) => ({ ...x, ...p })), 'e.g. DIL EXIM – RAJKOT, or DIL EXIM COMMODITIES')}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void addSub()}
                  className="flex items-center gap-1 rounded-[4px] bg-[#C7F03F] px-3 py-1.5 text-[11.5px] font-extrabold text-[#0B3D2E] hover:bg-[#B9E62F]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add {add.business_type || mainType} sub-ledger
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
