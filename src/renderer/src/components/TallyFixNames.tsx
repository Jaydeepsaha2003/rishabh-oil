import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, CheckCircle2, Link2, Plus, Sparkles, X } from 'lucide-react'
import { formatINR } from '@/lib/format'
import { GroupCombo, LedgerCombo } from '@/components/TallyLedgerPickers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// FIX EVERY NAME AT ONCE — the unmapped Tally names of the ticked vouchers,
// each with what to do already proposed:
//
//   MAP, when a ledger here is plainly the same name — the same letters once
//   case, spaces, "(Cr)" / "(Dr)", A/C and Pvt/Ltd spellings are set aside —
//   or the closest suggestion is a near-certain one;
//   CREATE, otherwise — under the group the name suggests, or one picked.
//
// Nothing is done until Apply, and only to the rows still ticked; each row
// says how it went. A mapping is remembered for every Tally file after, the
// same as one made by hand.

/** A name as both books would agree on it. */
export function plainName(s: unknown): string {
  return String(s ?? '')
    .toUpperCase()
    .replace(/\(\s*(CR|DR)\s*\)/g, ' ')
    .replace(/\bA\s*\/\s*C\b/g, ' ')
    .replace(/\bPRIVATE\b/g, 'PVT')
    .replace(/\bLIMITED\b/g, 'LTD')
    .replace(/[^A-Z0-9]/g, '')
}

interface Plan {
  key: string
  use: boolean
  action: 'map' | 'create'
  account: Row | null
  how: 'same name' | 'suggested' | ''
  name: string
  group: string
  state: '' | 'done' | 'error'
  note: string
}

export function TallyFixNames({
  ledgers,
  accounts,
  groupNames,
  companyId,
  onMapped,
  onChanged,
  onClose
}: {
  /** The unmapped names: tally_name, key, used_in, amount, suggest[], suggested_group. */
  ledgers: Row[]
  accounts: Row[]
  groupNames: Row[]
  companyId?: number
  onMapped: (key: string, account: { id: number; name: string }) => void
  onChanged: () => void
  onClose: () => void
}): React.JSX.Element {
  const byPlain = useMemo(() => {
    const m = new Map<string, Row>()
    for (const a of accounts) {
      const k = plainName(a.name)
      if (k && !m.has(k)) m.set(k, a)
    }
    return m
  }, [accounts])
  const [plans, setPlans] = useState<Plan[]>(() =>
    ledgers.map((l) => {
      const same = byPlain.get(plainName(l.tally_name))
      const top = ((l.suggest as Row[]) || [])[0]
      const sure = !same && top && Number(top.score) >= 0.75 ? top : null
      const account = same || sure || null
      return {
        key: String(l.key),
        use: true,
        action: account ? 'map' : 'create',
        account,
        how: same ? 'same name' : sure ? 'suggested' : '',
        name: String(l.tally_name).toUpperCase().replace(/\s+/g, ' ').trim(),
        group: String(l.suggested_group || ''),
        state: '',
        note: ''
      }
    })
  )
  const [busy, setBusy] = useState(false)
  const set = (key: string, patch: Partial<Plan>): void => setPlans((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  const byKey = new Map(ledgers.map((l) => [String(l.key), l]))
  const todo = plans.filter((p) => p.use && p.state !== 'done')
  const missing = todo.filter((p) => (p.action === 'map' ? !p.account : !p.name.trim() || !p.group))
  const maps = todo.filter((p) => p.action === 'map').length

  async function apply(): Promise<void> {
    if (missing.length) return void toast.error(`${missing.length} ticked ${missing.length === 1 ? 'row needs' : 'rows need'} a ledger or a group first`)
    setBusy(true)
    let ok = 0
    for (const p of todo) {
      const l = byKey.get(p.key)
      if (!l) continue
      try {
        if (p.action === 'map' && p.account) {
          await window.api.tallyNotes.saveMap({ tally_name: l.tally_name, account_id: Number(p.account.id) })
          onMapped(p.key, { id: Number(p.account.id), name: String(p.account.name) })
        } else {
          const r = await window.api.tallyNotes.createLedger({ company_id: companyId, tally_name: l.tally_name, name: p.name.trim(), group: p.group })
          onMapped(p.key, { id: r.id, name: r.name })
        }
        set(p.key, { state: 'done', note: '' })
        ok++
      } catch (e) {
        set(p.key, { state: 'error', note: (e as Error).message })
      }
    }
    setBusy(false)
    if (ok) {
      toast.success(`${ok} ${ok === 1 ? 'name' : 'names'} sorted`)
      onChanged()
    }
    if (ok === todo.length) onClose()
  }

  return (
    <div className="border-b border-[#E4ECE3] bg-[#FBFCF8]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#EEF3ED] px-4 py-2.5">
        <Sparkles className="h-4 w-4 text-[#8A5300]" />
        <span className="text-[12px] font-extrabold text-[#0A1F17]">Fix every name at once</span>
        <span className="text-[11px] font-semibold text-[#5A6B62]">
          {maps} to map to a ledger already here · {todo.length - maps} to create — check each, untick any to leave for later
        </span>
        <button type="button" onClick={onClose} className="ml-auto flex h-7 w-7 items-center justify-center rounded-[4px] text-[#5A6B62] hover:bg-[#EEF3EC]" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[46vh] divide-y divide-[#EEF3ED] overflow-y-auto">
        {plans.map((p) => {
          const l = byKey.get(p.key)
          if (!l) return null
          return (
            <div key={p.key} className="grid items-center gap-2.5 px-4 py-2 md:grid-cols-[22px_minmax(180px,1fr)_168px_minmax(300px,1.6fr)]" style={{ opacity: p.use ? 1 : 0.5 }}>
              <button
                type="button"
                role="checkbox"
                aria-checked={p.use}
                disabled={busy || p.state === 'done'}
                onClick={() => set(p.key, { use: !p.use })}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border"
                style={p.use ? { background: '#0B3D2E', borderColor: '#0B3D2E', color: '#C7F03F' } : { background: '#fff', borderColor: '#B9CBBE', color: 'transparent' }}
              >
                <Check className="h-3 w-3" strokeWidth={3.5} />
              </button>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-extrabold text-[#0A1F17]" title={String(l.tally_name)}>
                  {String(l.tally_name)}
                </div>
                <div className="text-[10.5px] font-semibold text-[#5A6B62]">
                  {Number(l.used_in)} voucher{Number(l.used_in) === 1 ? '' : 's'} · {formatINR(Number(l.amount) || 0)}
                </div>
              </div>
              <div className="flex overflow-hidden rounded-[4px] border border-[#D6E2D6] bg-white">
                {(['map', 'create'] as const).map((a, i) => (
                  <button
                    key={a}
                    type="button"
                    disabled={busy || p.state === 'done'}
                    onClick={() => set(p.key, { action: a })}
                    className={`flex h-8 flex-1 items-center justify-center gap-1 text-[11px] font-extrabold ${i ? 'border-l border-[#D6E2D6]' : ''}`}
                    style={p.action === a ? { background: '#0B3D2E', color: '#fff' } : { color: '#33473E' }}
                  >
                    {a === 'map' ? <Link2 className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                    {a === 'map' ? 'Map' : 'Create'}
                  </button>
                ))}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {p.state === 'done' ? (
                  <span className="flex items-center gap-1.5 text-[12px] font-bold text-[#0B6B45]">
                    <CheckCircle2 className="h-4 w-4" /> Done
                  </span>
                ) : p.action === 'map' ? (
                  <>
                    {p.account && (
                      <span className="flex min-w-0 max-w-[260px] items-center gap-1.5 rounded-[4px] border border-[#BFE3CB] bg-[#F4FBF6] px-2 py-1">
                        <span className="truncate text-[12px] font-bold text-[#0A1F17]">{String(p.account.name)}</span>
                        {p.how && (
                          <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.06em] text-[#0B6B45]">{p.how}</span>
                        )}
                      </span>
                    )}
                    <div className="min-w-[180px] flex-1">
                      <LedgerCombo
                        accounts={accounts}
                        onPick={(a) => set(p.key, { account: a, how: '' })}
                        onCreate={(q) => set(p.key, { action: 'create', name: (q.trim() || p.name).toUpperCase() })}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      value={p.name}
                      onChange={(e) => set(p.key, { name: e.target.value.toUpperCase() })}
                      className="h-9 min-w-[160px] flex-1 rounded-[4px] border border-[#C3D2C6] px-2.5 text-[12px] font-bold uppercase"
                    />
                    <GroupCombo groups={groupNames} value={p.group} onPick={(g) => set(p.key, { group: g })} onCreated={() => onChanged()} />
                  </>
                )}
                {p.state === 'error' && <span className="w-full text-[11px] font-bold text-[#B3261E]">{p.note}</span>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[#EEF3ED] px-4 py-2.5">
        <span className="min-w-0 flex-1 text-[11.5px] font-semibold" style={{ color: missing.length ? '#B3261E' : '#5A6B62' }}>
          {missing.length
            ? `${missing.length} ticked ${missing.length === 1 ? 'row needs' : 'rows need'} ${missing.some((p) => p.action === 'map') ? 'a ledger' : 'a group'} before Apply`
            : `${todo.length} ${todo.length === 1 ? 'name' : 'names'} ready — mappings are remembered for every Tally file after`}
        </span>
        {todo.some((p) => p.action === 'create' && !p.group) && (
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold text-[#33473E]">Group for all without one</span>
            <GroupCombo
              groups={groupNames}
              value=""
              onCreated={() => onChanged()}
              onPick={(g) => setPlans((ps) => ps.map((p) => (p.use && p.state !== 'done' && p.action === 'create' && !p.group ? { ...p, group: g } : p)))}
            />
          </span>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setPlans((ps) => ps.map((p) => (p.state === 'done' ? p : { ...p, use: p.action === 'map' && !!p.account })))}
          className="h-8 rounded-[4px] border border-[#D6E2D6] bg-white px-2.5 text-[11px] font-extrabold text-[#33473E]"
          title="Tick only the names that map to a ledger already here"
        >
          Only the maps
        </button>
        <button
          type="button"
          disabled={busy || !todo.length}
          onClick={() => void apply()}
          className="flex h-8 items-center gap-1.5 rounded-[4px] bg-[#0B3D2E] px-3.5 text-[11.5px] font-extrabold text-[#C7F03F] disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" /> {busy ? 'Working…' : `Apply to ${todo.length}`}
        </button>
      </div>
    </div>
  )
}
