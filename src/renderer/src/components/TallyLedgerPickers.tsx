import { useRef, useState } from 'react'

// INSIDE A DIALOG, THE LIST IS DRAWN INSIDE IT. Both pickers are used in the
// Book-from-Tally and Fix-every-name dialogs. Portaled to the body, the
// dialog's focus trap pulled focus straight back out of the list — the search
// box could not be typed into and a group could not be picked. Handing the
// panel the dialog element puts it inside the trap (see popover.tsx).
const dialogOf = (el: HTMLElement | null): HTMLElement | null => (el?.closest('[role="dialog"]') as HTMLElement) || null
import { BookOpen, Check, ChevronDown, FolderPlus, FolderTree, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The two pickers Tally File Updation maps names with — shared by the note
// imports and the Sales Register check, so both look and behave the same.

// The ledger picker, drawn as every other one on the website is: a box with a
// chevron that opens a searchable list — the name on the top line, its group
// and closing balance under it — and "Create ledger" when nothing matches.
export function LedgerCombo({
  accounts,
  onPick,
  onCreate
}: {
  accounts: Row[]
  onPick: (a: Row) => void
  onCreate: (query: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const bal = (v: number): string => (Math.abs(v) < 0.005 ? 'Nil' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`)
  // A ledger hidden in Masters is not offered.
  accounts = accounts.filter((a) => !Number(a.is_hidden))
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-[9px] rounded-[6px] border border-[#E3C58C] bg-white px-[11px] text-left shadow-[inset_0_1px_2px_rgba(10,31,23,.04)] transition-colors hover:border-[#C2700A] focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15"
        >
          <BookOpen className="h-4 w-4 flex-none text-[#5A6B62]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[#8CA396]">Select ledger…</span>
          <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" container={dialogOf(trigger.current)} className="w-[460px] p-0">
        <Command>
          <CommandInput placeholder="Type a ledger name…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>
              <button
                type="button"
                className="mx-auto flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-emerald-700 hover:bg-emerald-50"
                onClick={() => {
                  setOpen(false)
                  onCreate(query)
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Create ledger “{query.toUpperCase()}”
              </button>
            </CommandEmpty>
            {accounts.map((a) => {
              const b = Number(a.balance) || 0
              return (
                <CommandItem
                  key={String(a.id)}
                  value={String(a.name)}
                  className="items-start gap-2 py-1.5"
                  onSelect={() => {
                    setOpen(false)
                    setQuery('')
                    onPick(a)
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-semibold text-[#0A1F17]">{String(a.name)}</span>
                    <span className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{String(a.acc_group || '')}</span>
                  </span>
                  <span className="flex flex-none flex-col items-end gap-0.5 pl-2">
                    <span className="text-[12px] font-bold tabular-nums" style={{ color: Math.abs(b) < 0.005 ? '#8CA396' : b > 0 ? '#1B4E82' : '#B3261E' }}>
                      {bal(b)}
                    </span>
                    <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">closing</span>
                  </span>
                </CommandItem>
              )
            })}
            {query.trim() && (
              <CommandItem
                value={`__create__${query}`}
                onSelect={() => {
                  setOpen(false)
                  onCreate(query)
                }}
              >
                <Plus className="h-3.5 w-3.5 text-emerald-700" />
                <span className="text-emerald-700">Create ledger “{query.toUpperCase()}”</span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// The group a new ledger goes under — the same searchable list, in place of
// the browser's own select. With onCreated given, a group that is not in the
// chart yet can be made from here: type its name, pick where it sits, and it
// is created under that group (taking its side of the books) and picked.
export function GroupCombo({
  groups,
  value,
  onPick,
  onCreated,
  className
}: {
  groups: Row[]
  value: string
  onPick: (g: string) => void
  onCreated?: (g: string) => void | Promise<void>
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Making a group: its name, then the list turns into "where it sits".
  const [making, setMaking] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const typed = query.trim()
  const exists = !!typed && groups.some((g) => String(g.name).trim().toUpperCase() === typed.toUpperCase())
  async function create(under: string): Promise<void> {
    const name = String(making || '').trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await window.api.journal.createGroup({ name, under })
      toast.success(`${name} created under ${under}`)
      await onCreated?.(name)
      onPick(name)
      setOpen(false)
      setMaking(null)
      setQuery('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setSaving(false)
    }
  }
  const row = (g: Row, onSelect: () => void): React.JSX.Element => {
    const depth = Math.max(0, Number(g.depth) || 0)
    const primary = depth === 0
    return (
      <CommandItem
        key={String(g.name)}
        value={`${String(g.name)} ${String(g.path || '')}`}
        className={cn('items-center gap-2 py-1.5', primary && 'mt-0.5 bg-[#F7FAF6]')}
        onSelect={onSelect}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
          {!primary && <span className="flex-none text-[#9DBBA6]">└</span>}
          <span className={cn('truncate text-[13px]', primary ? 'font-extrabold uppercase tracking-[.03em] text-[#0B3D2E]' : 'font-semibold text-[#0A1F17]')}>
            {String(g.name)}
          </span>
        </span>
        {!making && String(g.name) === value && <Check className="h-4 w-4 flex-none text-[#12855A]" />}
      </CommandItem>
    )
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setQuery('')
          setMaking(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className={cn('flex h-9 w-[260px] cursor-pointer items-center gap-2 rounded-[6px] border border-[#C3D2C6] bg-white px-2.5 text-left hover:border-[#8FA79A] focus:border-[#0B3D2E] focus:outline-none focus:ring-2 focus:ring-[#0B3D2E]/15', className)}
        >
          <FolderTree className="h-4 w-4 flex-none text-[#5A6B62]" />
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${value ? 'font-bold text-[#0A1F17]' : 'font-semibold text-[#8CA396]'}`}>{value || 'Group…'}</span>
          <ChevronDown className="h-4 w-4 flex-none text-[#8CA396]" />
        </button>
      </PopoverTrigger>
      {/* THE CHART OF ACCOUNTS AS MASTERS SHOWS IT: every head, primary
          ones bold, each sub-group indented under its parent, in the tree's
          own order — wide and tall enough to read whole, and anchored to the
          box's right edge so it opens into the dialog rather than off it. */}
      <PopoverContent
        align="end"
        collisionPadding={12}
        container={dialogOf(trigger.current)}
        className="w-[min(92vw,440px)] p-0"
      >
        {making ? (
          <Command key="under">
            <div className="flex items-center gap-2 border-b border-[#E4ECE3] bg-[#F3FBE2] px-3 py-2">
              <FolderPlus className="h-4 w-4 flex-none text-[#0B6B45]" />
              <span className="min-w-0 flex-1 text-[12px] font-bold text-[#0A1F17]">
                New group <span className="text-[#0B6B45]">{making}</span> — pick the group it sits under
              </span>
              <button type="button" onClick={() => setMaking(null)} className="text-[11px] font-extrabold text-[#5A6B62] hover:text-[#0A1F17]">
                Back
              </button>
            </div>
            <CommandInput placeholder="Find the group it goes under…" />
            <CommandList className="max-h-[min(56vh,440px)]">
              <CommandEmpty>No group by that name.</CommandEmpty>
              {groups.map((g) => row(g, () => void create(String(g.name))))}
            </CommandList>
            {saving && <div className="border-t border-[#E4ECE3] px-3 py-2 text-[11.5px] font-bold text-[#5A6B62]">Creating…</div>}
          </Command>
        ) : (
          <Command key="pick">
            <CommandInput placeholder="Type a group name…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[min(62vh,480px)]">
              <CommandEmpty>{onCreated ? 'No group by that name — create it below.' : 'No group by that name.'}</CommandEmpty>
              {groups.map((g) =>
                row(g, () => {
                  onPick(String(g.name))
                  setOpen(false)
                  setQuery('')
                })
              )}
            </CommandList>
            {onCreated && (
              <button
                type="button"
                onClick={() => setMaking(typed && !exists ? typed : '')}
                disabled={!typed || exists}
                className="flex w-full items-center gap-1.5 border-t border-[#E4ECE3] px-3 py-2.5 text-left text-[12.5px] font-extrabold text-[#0B6B45] hover:bg-[#F3FBE2] disabled:cursor-not-allowed disabled:text-[#8CA396] disabled:hover:bg-transparent"
                title={!typed ? 'Type the new group’s name above first' : exists ? 'A group by that name already exists' : undefined}
              >
                <Plus className="h-3.5 w-3.5" />
                {!typed ? 'New group — type its name above' : exists ? `${typed} is already a group` : `Create group “${typed}”…`}
              </button>
            )}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
