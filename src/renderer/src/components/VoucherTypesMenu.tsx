import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, FolderPlus, Layers, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The number series each basic type posts in (voucherNumbers.ts).
const SERIES: Record<string, string> = {
  CONTRA: 'CON',
  PAYMENT: 'PAY',
  RECEIPT: 'RCP',
  JOURNAL: 'JV',
  SALE: 'SAL',
  PURCHASE: 'PUR',
  'DEBIT NOTE': 'DN',
  'CREDIT NOTE': 'CN'
}

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
  const trig = useRef<HTMLButtonElement>(null)
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
    <Popover
      open={open}
      onOpenChange={(o) => {
        // The tab row scrolls sideways; bring the button into view first so
        // the panel opens under it, inside the window.
        if (o) trig.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trig}
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
      <PopoverContent align="end" collisionPadding={12} sticky="always" className="w-[440px] overflow-hidden rounded-[12px] border-[#D6E2D6] p-0 shadow-[0_24px_48px_-18px_rgba(7,43,32,.45)]">
        {/* HEAD — what these are, in one line. */}
        <div className="flex items-start gap-3 bg-[linear-gradient(160deg,#145A43,#0B3D2E)] px-4 py-3.5 text-white">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-white/10">
            <Layers className="h-[18px] w-[18px] text-[#C7F03F]" />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-extrabold tracking-[-0.01em]">Your voucher types</div>
            <div className="mt-0.5 text-[11.5px] font-semibold leading-[1.45] text-[#A9CDBB]">
              Your own names under the basic types — each keeps its basic type&apos;s number series.
            </div>
          </div>
          <span className="ml-auto flex-none rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-[#C7F03F]">{subtypes.length}</span>
        </div>

        {/* THE LIST, by basic type. */}
        <div className="max-h-[300px] overflow-y-auto bg-white p-2">
          {!subtypes.length && (
            <div className="flex flex-col items-center px-6 py-6 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F1F8EC]">
                <FolderPlus className="h-5 w-5 text-[#0B6B45]" />
              </span>
              <div className="mt-2.5 text-[13px] font-extrabold text-[#0A1F17]">No voucher types yet</div>
              <div className="mt-1 text-[11.5px] font-semibold leading-[1.5] text-[#5A6B62]">
                Make one below — e.g. <b className="text-[#0B3D2E]">PURCHASE OTHERS</b> under Purchase. It is numbered <b className="text-[#0B3D2E]">PUR/***</b> like any purchase.
              </div>
            </div>
          )}
          {bases.map((b) => {
            const mine = subtypes.filter((s) => s.base_type === b.key)
            if (!mine.length) return null
            return (
              <div key={b.key} className="mb-1.5 last:mb-0">
                <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
                  <span className="text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">{b.label}</span>
                  <span className="rounded-[3px] bg-[#EAF0E9] px-1.5 py-px font-mono text-[9.5px] font-bold text-[#33473E]">{SERIES[b.key] || ''}/***</span>
                  <span className="h-px flex-1 bg-[#EAF0E9]" />
                </div>
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
        </div>
        {canManage && (
          <div className="border-t border-[#E4ECE3] bg-[#F7FAF6] px-4 py-3.5">
            <div className="mb-2 text-[9.5px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">New voucher type</div>
            {/* The basic type it comes under — chips, so the choice and its
                number series read at a glance. */}
            <div className="mb-2.5 flex flex-wrap gap-1">
              {bases.map((b) => {
                const sel = base === b.key
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setBase(b.key)}
                    className={cn(
                      'h-7 rounded-[5px] border px-2.5 text-[11.5px] font-bold transition-colors',
                      sel ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#D6E2D6] bg-white text-[#33473E] hover:border-[#9FB6A6]'
                    )}
                  >
                    {b.label}
                  </button>
                )
              })}
            </div>
            <div className="flex items-stretch gap-2">
              <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#C3D2C6] bg-white pl-2.5 pr-1.5 focus-within:border-[#0B3D2E] focus-within:ring-2 focus-within:ring-[#0B3D2E]/10">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void add()}
                  placeholder={`e.g. ${(bases.find((b) => b.key === base)?.label || 'Purchase').toUpperCase()} OTHERS`}
                  className="min-w-0 flex-1 bg-transparent text-[13px] font-bold uppercase text-[#0A1F17] outline-none placeholder:font-semibold placeholder:normal-case placeholder:text-[#9FB3A6]"
                />
                <span className="flex-none rounded-[4px] bg-[#F1F8EC] px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-[#0B6B45]" title="The number series it takes">
                  {SERIES[base] || ''}/***
                </span>
              </div>
              <button
                type="button"
                onClick={() => void add()}
                disabled={!name.trim()}
                className="flex h-10 flex-none items-center gap-1.5 rounded-[6px] bg-[#C7F03F] px-3.5 text-[12.5px] font-extrabold text-[#0B3D2E] shadow-[0_6px_14px_-8px_rgba(122,160,20,.9)] hover:bg-[#B9E62F] disabled:opacity-40"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
            <div className="mt-2 text-[11px] font-semibold text-[#8CA396]">
              Comes under <b className="text-[#33473E]">{bases.find((b) => b.key === base)?.label}</b> — same rules, same register, numbered {SERIES[base] || ''}/***.
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
