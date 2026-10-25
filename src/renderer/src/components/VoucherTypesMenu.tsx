import { useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// THE "MORE" VOUCHER TYPES — the desk's own, under the basic ones (PURCHASE
// OTHERS under Purchase). Pick one to start a voucher of it; add, rename or
// remove them here. A voucher of one keeps its basic type's number series
// (voucherSubtypes.ts), so PURCHASE OTHERS is numbered PUR/*** like any purchase.
export function VoucherTypesMenu({
  bases,
  subtypes,
  current,
  onPick,
  onChanged,
  canManage
}: {
  bases: { key: string; label: string }[]
  subtypes: Row[]
  current?: string
  onPick: (base: string, name: string) => void
  onChanged: () => void
  canManage: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(bases.find((b) => b.key === 'PURCHASE')?.key || bases[0]?.key || 'PAYMENT')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try {
      await fn()
      toast.success(ok)
      onChanged()
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    }
  }
  const add = async (): Promise<void> => {
    const nm = name.trim().toUpperCase()
    if (await run(() => window.api.vouchers.subtypeCreate({ base_type: base, name: nm }), `${nm} added under ${bases.find((b) => b.key === base)?.label || base}`)) setName('')
  }
  const on = !!current

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] px-3.5 text-[12px] font-extrabold transition-colors"
          style={{
            background: on ? 'linear-gradient(180deg,#DDF97A,#B9E534)' : 'rgba(255,255,255,.05)',
            border: `1px solid ${on ? '#D5F46A' : 'rgba(255,255,255,.1)'}`,
            color: on ? '#0B3D2E' : '#DCEFE4'
          }}
          title="Your own voucher types — under the basic ones, in their number series"
        >
          {current || 'More'}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-0">
        <div className="max-h-[360px] overflow-y-auto p-2">
          {bases.map((b) => {
            const mine = subtypes.filter((s) => s.base_type === b.key)
            if (!mine.length) return null
            return (
              <div key={b.key} className="mb-1.5">
                <div className="px-2 py-1 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{b.label}</div>
                {mine.map((s) => (
                  <div key={s.id} className="group flex items-center gap-1 rounded-[4px] hover:bg-[#F1F8EC]">
                    {editing?.id === s.id ? (
                      <>
                        <input
                          autoFocus
                          value={editing?.name ?? ''}
                          onChange={(e) => setEditing({ id: s.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              void run(() => window.api.vouchers.subtypeRename({ id: s.id, name: editing?.name ?? '' }), 'Renamed').then((ok) => ok && setEditing(null))
                          }}
                          className="h-8 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] px-2 text-[12.5px] font-bold uppercase outline-none"
                        />
                        <button type="button" title="Save" onClick={() => void run(() => window.api.vouchers.subtypeRename({ id: s.id, name: editing?.name ?? '' }), 'Renamed').then((ok) => ok && setEditing(null))} className="p-1 text-[#0B6B45]">
                          <Check className="h-4 w-4" />
                        </button>
                        <button type="button" title="Cancel" onClick={() => setEditing(null)} className="p-1 text-[#8CA396]">
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false)
                            onPick(b.key, s.name)
                          }}
                          className={cn('flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[12.5px] font-bold text-[#0A1F17]', current === s.name && 'text-[#0B6B45]')}
                        >
                          {current === s.name ? <Check className="h-3.5 w-3.5 flex-none" /> : <span className="w-3.5" />}
                          <span className="truncate">{s.name}</span>
                          <span className="ml-auto flex-none text-[10.5px] font-semibold text-[#8CA396]">{Number(s.used) || 0} vouchers</span>
                        </button>
                        {canManage && (
                          <span className="flex flex-none opacity-0 group-hover:opacity-100">
                            <button type="button" title="Rename" onClick={() => setEditing({ id: s.id, name: s.name })} className="p-1 text-[#5A6B62] hover:text-[#1B4E82]">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              title={Number(s.used) ? 'Vouchers carry it — move them first' : 'Remove'}
                              onClick={() => {
                                if (window.confirm(`Remove the voucher type ${s.name}?`)) void run(() => window.api.vouchers.subtypeDelete(s.id), `${s.name} removed`)
                              }}
                              className="p-1 text-[#5A6B62] hover:text-[#B3261E]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
          {!subtypes.length && <div className="px-2 py-3 text-[12px] text-[#5A6B62]">No voucher types of your own yet — add one below.</div>}
        </div>
        {canManage && (
          <div className="border-t border-[#E4ECE3] bg-[#F7FAF6] p-2.5">
            <div className="mb-1.5 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">New voucher type</div>
            <div className="flex gap-1.5">
              <select
                value={base}
                onChange={(e) => setBase(e.target.value)}
                className="h-9 w-[120px] flex-none rounded-[4px] border border-[#C3D2C6] bg-white px-1.5 text-[12px] font-bold"
                title="The basic type it comes under — its number series"
              >
                {bases.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
                placeholder="e.g. PURCHASE OTHERS"
                className="h-9 min-w-0 flex-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2 text-[12.5px] font-bold uppercase outline-none focus:border-[#1B4E82]"
              />
              <button type="button" onClick={() => void add()} className="flex h-9 flex-none items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-2.5 text-[12px] font-extrabold text-[#C7F03F]">
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
