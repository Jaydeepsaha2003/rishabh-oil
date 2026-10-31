import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Plus, Tag as TagIcon, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { errText } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * THE MILL'S OWN WORD FOR SOMETHING THE SOFTWARE HAS NO FIELD FOR.
 *
 * "Disputed", "Rate to be revised", "Check with Banerjee" — the reasons one
 * bill is not like the others are endless and none of them are worth a column.
 * They are worth a label the desk invents on the spot, puts on anything, and
 * filters by afterwards.
 *
 * One component for every screen that has something worth labelling, so a tag
 * looks and behaves identically on a purchase, a sale, a letter of credit, a
 * discounted bill, a trading deal and a voucher — and so the next thing worth
 * tagging costs a line rather than a copy of this file.
 */
export type TagEntity = 'order' | 'sale' | 'lc' | 'bd' | 'trading' | 'voucher'

// TWENTY TINTS, THEN ROUND AGAIN — the same principle the lot colours use.
// A tag with no colour of its own takes one from its name, so it is the same
// colour on every screen without anybody having to choose.
const TAG_TINTS: { bg: string; fg: string; bd: string }[] = [
  { bg: '#EAF0FA', fg: '#1B4E82', bd: '#C6DAF0' },
  { bg: '#E9F5EE', fg: '#0B6B45', bd: '#BFE3CB' },
  { bg: '#FFF4E0', fg: '#8A5300', bd: '#F0E4CB' },
  { bg: '#FDF3F2', fg: '#B3261E', bd: '#F0D6D4' },
  { bg: '#F3EFFC', fg: '#4B3FA8', bd: '#DCD2F5' },
  { bg: '#E8F6F7', fg: '#116A72', bd: '#C3E6E9' },
  { bg: '#FBEFF6', fg: '#8E2A66', bd: '#EFD3E3' },
  { bg: '#F1F4E6', fg: '#4F6113', bd: '#DCE4C2' },
  { bg: '#EFF1F5', fg: '#39424E', bd: '#D6DAE2' },
  { bg: '#FDF0E6', fg: '#9A4A12', bd: '#F2D9C4' }
]

function tintOf(t: Row): { bg: string; fg: string; bd: string } {
  const set = String(t?.colour || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(set)) return { bg: `${set}1F`, fg: set, bd: `${set}55` }
  // FNV-1a over the name: stable per tag, identical everywhere, and never
  // shifts because another tag was created.
  const s = String(t?.name || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return TAG_TINTS[(h >>> 0) % TAG_TINTS.length]
}

export function TagChip({
  tag,
  onRemove,
  small
}: {
  tag: Row
  onRemove?: () => void
  small?: boolean
}): React.JSX.Element {
  const t = tintOf(tag)
  return (
    <span
      className="inline-flex max-w-[168px] items-center gap-1 rounded-[3px] align-middle"
      style={{
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        padding: small ? '1px 5px' : '2px 6px',
        fontSize: small ? 9.5 : 10.5,
        fontWeight: 800,
        letterSpacing: '.02em'
      }}
      title={String(tag.name)}
    >
      <span className="truncate">{String(tag.name)}</span>
      {!!onRemove && (
        <button
          type="button"
          className="flex-none opacity-60 hover:opacity-100"
          title={`Take ${String(tag.name)} off`}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onRemove()
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  )
}

/**
 * The chips on a row, plus the way to change them.
 *
 * `refs` on a register are fetched in one call by the page (useTagMap below);
 * this component is handed what it should already show, so scrolling a
 * register does not open a request per row.
 */
export function TagPicker({
  entity,
  refId,
  tags,
  onChanged,
  readOnly,
  label = 'Tag',
  compact,
  onDark
}: {
  entity: TagEntity
  refId: string | number
  tags: Row[]
  onChanged?: (next: Row[]) => void
  readOnly?: boolean
  label?: string
  compact?: boolean
  /** On a forest header, where the quiet grey glyph disappears entirely. */
  onDark?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<Row[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  // INSIDE A DIALOG, THE BOX COULD NOT BE TYPED INTO.
  //
  // A modal dialog traps focus to its own subtree: anything focused outside it
  // is pulled straight back. The panel portals to the body, so its input took
  // focus on open and lost it in the same frame — the panel appeared, the
  // caret sat on the trigger, and every keystroke went nowhere. Clicking the
  // box did not help either; the trap fires on focusin however it happens.
  // It affected the Day Book's voucher dialog too, from the day tags shipped.
  //
  // So the panel is rendered INSIDE the dialog when there is one, which puts
  // it in the subtree the trap allows. A picker on a register finds nothing
  // and portals to the body exactly as it always has.
  //
  // Read off the TRIGGER, and matched on role alone — this build of Radix does
  // not set aria-modal, and the trigger is never inside its own panel, which
  // carries role="dialog" as well.
  const trigger = useRef<HTMLButtonElement>(null)
  const [inDialog, setInDialog] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setInDialog((trigger.current?.closest('[role="dialog"]') as HTMLElement) || null)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const rows = await window.api.tags.list()
      if (mounted.current) setAll(rows || [])
    } catch {
      if (mounted.current) setAll([])
    }
  }, [])
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const on = useMemo(() => new Set(tags.map((t) => Number(t.id))), [tags])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((t) => !needle || String(t.name).toLowerCase().includes(needle))
  }, [all, q])
  // Typing a name nothing matches is how a tag gets made — no separate screen,
  // no "manage tags" step before the first one can be used.
  const exact = all.some((t) => String(t.name).trim().toLowerCase() === q.trim().toLowerCase())

  const commit = async (next: Row[]): Promise<void> => {
    setBusy(true)
    try {
      await window.api.tags.set(entity, refId, next.map((t) => Number(t.id)))
      onChanged?.(next)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const toggle = async (t: Row): Promise<void> => {
    const next = on.has(Number(t.id))
      ? tags.filter((x) => Number(x.id) !== Number(t.id))
      : [...tags, t]
    await commit(next)
  }

  const make = async (): Promise<void> => {
    const name = q.trim()
    if (!name) return
    setBusy(true)
    try {
      const made = await window.api.tags.create(name)
      setQ('')
      await load()
      await window.api.tags.set(entity, refId, [...tags.map((t) => Number(t.id)), Number(made.id)])
      onChanged?.([...tags, made])
    } catch (e) {
      toast.error(errText(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {tags.map((t) => (
        <TagChip
          key={String(t.id)}
          tag={t}
          small={compact}
          // A CLICK THAT REMOVES SOMETHING SAYS SO FIRST.
          //
          // The X sits right on the chip, the same distance from a stray
          // click as picking the row it is tagged to — and unlike ticking it
          // back on from the panel, this one has no undo of its own. One
          // question first, naming what is coming off.
          onRemove={
            readOnly
              ? undefined
              : () => {
                  if (!window.confirm(`Remove the "${String(t.name)}" tag?`)) return
                  void commit(tags.filter((x) => Number(x.id) !== Number(t.id)))
                }
          }
        />
      ))}
      {!readOnly && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type="button"
              title={tags.length ? 'Add another tag' : 'Tag this'}
              onClick={(e) => e.stopPropagation()}
              // A GLYPH, NOT AN EMPTY BOX.
              //
              // It was a dashed rectangle with a 10px icon in it, repeated
              // under every row — sixty-three little empty input boxes down one
              // register, each drawing more attention than the invoice number
              // above it. An affordance nobody is looking for should be quiet
              // until it is: no border, a faint glyph at a size that still
              // reads as a tag, and a tinted round pad the moment the pointer
              // is on the row.
              className={cn(
                'group/tag inline-flex flex-none items-center justify-center rounded-full transition-colors',
                // Quiet against its own ground, whichever ground that is. The
                // grey is invisible on a forest header, and the pale hover pad
                // would be a bright spot on it.
                onDark
                  ? 'text-[#8FBFA8] hover:bg-white/15 hover:text-white'
                  : 'text-muted-foreground/45 hover:bg-[#EAF0E9] hover:text-[#0B3D2E]',
                compact ? 'h-[19px] w-[19px]' : 'h-[22px] gap-1 px-2 text-[10.5px] font-bold'
              )}
            >
              {tags.length ? (
                <Plus className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
              ) : (
                <TagIcon className={compact ? 'h-[13px] w-[13px]' : 'h-3.5 w-3.5'} />
              )}
              {!tags.length && !compact && label}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            container={inDialog}
            className="w-64 p-0"
            onClick={(e) => e.stopPropagation()}
            // ENTER MAKES THE TAG, WHEREVER THE FOCUS IS.
            //
            // Bound on the panel rather than only on the box: typing a name
            // and pressing Enter is the whole gesture, and it should not
            // depend on focus still sitting in the input after a re-render.
            // The stopPropagation stays — a register underneath this listens
            // for keys of its own.
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && q.trim() && !exact && !busy) {
                e.preventDefault()
                void make()
              }
            }}
          >
            <div className="border-b px-2.5 py-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find or type a new tag"
                className="w-full border-0 bg-transparent text-[12.5px] font-medium outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {shown.map((t) => (
                <button
                  key={String(t.id)}
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(t)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50"
                >
                  <span className="flex h-3.5 w-3.5 flex-none items-center justify-center">
                    {on.has(Number(t.id)) && <Check className="h-3 w-3 text-[#0B3D2E]" />}
                  </span>
                  <TagChip tag={t} />
                  <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                    {Number(t.used) || 0}
                  </span>
                </button>
              ))}
              {!shown.length && !q.trim() && (
                <div className="px-2.5 py-3 text-center text-[11.5px] text-muted-foreground">
                  No tags yet — type one above.
                </div>
              )}
            </div>
            {!!q.trim() && !exact && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void make()}
                className="flex w-full items-center gap-1.5 border-t px-2.5 py-2 text-left text-[12px] font-semibold text-[#0B3D2E] hover:bg-muted/40"
              >
                <Plus className="h-3.5 w-3.5" /> Create “{q.trim()}” and put it on this
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </span>
  )
}

/**
 * TAGS FOR SOMETHING NOT MADE YET.
 *
 * A book transfer is raised only when its tanker is marked Empty, so there is
 * nothing to hang a tag on while the dialog is open. The names are held here
 * and sent with the request; the server puts them on the sale and the buyer's
 * purchase as it raises them (onwardSale.ts → tagTransfer), making any tag a
 * book does not have yet.
 */
export function TagDraftPicker({
  value,
  onChange,
  label = 'Tag'
}: {
  value: string[]
  onChange: (next: string[]) => void
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<Row[]>([])
  const [q, setQ] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const [inDialog, setInDialog] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setInDialog((trigger.current?.closest('[role="dialog"]') as HTMLElement) || null)
  }, [])
  useEffect(() => {
    if (!open) return
    window.api.tags
      .list()
      .then((rows) => setAll(rows || []))
      .catch(() => setAll([]))
  }, [open])
  const key = (s: string): string => s.trim().toUpperCase()
  const on = new Set(value.map(key))
  const needle = q.trim().toLowerCase()
  const shown = all.filter((t) => !needle || String(t.name).toLowerCase().includes(needle))
  const exact = all.some((t) => key(String(t.name)) === key(q)) || on.has(key(q))
  const toggle = (name: string): void => onChange(on.has(key(name)) ? value.filter((x) => key(x) !== key(name)) : [...value, name])
  const add = (): void => {
    const name = q.replace(/\s+/g, ' ').trim()
    if (!name) return
    if (!on.has(key(name))) onChange([...value, name])
    setQ('')
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {value.map((name) => (
        <TagChip key={name} tag={{ name }} onRemove={() => onChange(value.filter((x) => x !== name))} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            className="inline-flex h-[24px] items-center gap-1 rounded-full px-2 text-[11px] font-bold text-[#0B3D2E] hover:bg-[#EAF0E9]"
          >
            {value.length ? <Plus className="h-3.5 w-3.5" /> : <TagIcon className="h-3.5 w-3.5" />}
            {value.length ? 'Add' : label}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          container={inDialog}
          className="w-64 p-0"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && q.trim()) {
              e.preventDefault()
              const hit = shown.find((t) => key(String(t.name)) === key(q))
              if (hit) toggle(String(hit.name))
              else add()
              setQ('')
            }
          }}
        >
          <div className="border-b px-2.5 py-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find or type a new tag"
              className="w-full border-0 bg-transparent text-[12.5px] font-medium outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {shown.map((t) => (
              <button
                key={String(t.id)}
                type="button"
                onClick={() => toggle(String(t.name))}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50"
              >
                <span className="flex h-3.5 w-3.5 flex-none items-center justify-center">
                  {on.has(key(String(t.name))) && <Check className="h-3 w-3 text-[#0B3D2E]" />}
                </span>
                <TagChip tag={t} />
              </button>
            ))}
            {!shown.length && !q.trim() && <div className="px-2.5 py-3 text-center text-[11.5px] text-muted-foreground">No tags yet — type one above.</div>}
          </div>
          {!!q.trim() && !exact && (
            <button
              type="button"
              onClick={add}
              className="flex w-full items-center gap-1.5 border-t px-2.5 py-2 text-left text-[12px] font-semibold text-[#0B3D2E] hover:bg-muted/40"
            >
              <Plus className="h-3.5 w-3.5" /> Use new tag “{q.trim()}”
            </button>
          )}
        </PopoverContent>
      </Popover>
    </span>
  )
}

/**
 * One fetch for a whole register.
 *
 * Hands back the tags keyed by ref and a setter, so a page draws its rows'
 * chips without a request each and a change on one row does not reload the
 * rest.
 */
// THE RECO TAG — a cheque to reconcile with the bank later. Put on (or taken
// off) a voucher, its other tags kept; the tag is made the first time.
export async function setVoucherReco(entryId: number, on: boolean, companyId?: number): Promise<void> {
  const isReco = (t: Row): boolean => String(t.name || '').trim().toUpperCase() === 'RECO'
  const have = ((await window.api.tags.forRefs('voucher', [entryId], companyId))?.[String(entryId)] || []) as Row[]
  if (have.some(isReco) === on) return
  const keep = have.filter((t) => !isReco(t)).map((t) => Number(t.id))
  if (!on) return void (await window.api.tags.set('voucher', entryId, keep))
  const list = (await window.api.tags.list(companyId)) as Row[]
  const id = Number(list.find(isReco)?.id) || Number((await window.api.tags.create('RECO', undefined, companyId)).id)
  await window.api.tags.set('voucher', entryId, [...keep, id])
}

export function useTagMap(
  entity: TagEntity,
  refs: (string | number)[],
  companyId?: number
): {
  tagsOf: (ref: string | number) => Row[]
  setFor: (ref: string | number, next: Row[]) => void
  reload: () => void
} {
  const [map, setMap] = useState<Record<string, Row[]>>({})
  // The refs as ONE string: a fresh array every render would re-fetch forever.
  const key = refs.map(String).sort().join(',')
  const reload = useCallback(() => {
    const list = key ? key.split(',') : []
    if (!list.length) {
      setMap({})
      return
    }
    window.api.tags
      .forRefs(entity, list, companyId)
      .then((m) => setMap(m || {}))
      .catch(() => setMap({}))
  }, [entity, key, companyId])
  useEffect(() => reload(), [reload])
  return {
    tagsOf: (ref) => map[String(ref)] || [],
    setFor: (ref, next) => setMap((p) => ({ ...p, [String(ref)]: next })),
    reload
  }
}
