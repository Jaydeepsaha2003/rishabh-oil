import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ClipboardList, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { todayISO, formatDate } from '@/lib/format'
import { useCategories } from '@/lib/useCategories'
import { loadUser } from '@/lib/session'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The three rounds the gate is walked. Times rather than "morning/evening",
// because a supervisor handing over at shift change needs to know whether the
// four o'clock count has been done, not whether somebody felt it was afternoon.
const SLOTS = [
  { v: '08:00', label: '8 AM' },
  { v: '16:00', label: '4 PM' },
  { v: '20:00', label: '8 PM' }
] as const

// Not an id, so it can never collide with a party's. Picking it widens the
// list instead of selecting anything.
const SHOW_ALL = '__all__'

const KINDS = [
  { v: 'purchase', label: 'Purchase — coming to us' },
  { v: 'sales', label: 'Sales — going out' }
] as const

// Which round it is now, so the form opens on the count actually being taken
// rather than making someone pick it three times a day.
function slotNow(): string {
  const h = new Date().getHours()
  if (h < 12) return '08:00'
  if (h < 18) return '16:00'
  return '20:00'
}

export function OutsideTankerLog({
  products,
  suppliers,
  customers
}: {
  products: Row[]
  suppliers: Row[]
  customers: Row[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState(todayISO())
  const [saving, setSaving] = useState(false)
  const blank = useMemo(
    () => ({ slot: slotNow(), kind: 'purchase', category: '', party_id: '', tankers: '', note: '' }),
    []
  )
  const [form, setForm] = useState<Row>(blank)
  // What each party has actually traded, for the ones carrying no tag on their
  // master. The same source Gate Entry's party filter reads, so the two lists
  // cannot disagree about who deals in HUSK.
  const [partyCats, setPartyCats] = useState<Row[]>([])
  // The escape hatch for a party that is neither tagged nor has any history.
  const [showAll, setShowAll] = useState(false)

  // The material categories master — OIL, HUSK, PACKAGING — narrowed to the
  // side of the trade being counted, so Purchase offers what is bought and
  // Sales what is sold. A category marked 'both' appears under either.
  //
  // Deliberately NO `extra` argument. useCategories folds the values passed
  // there in unconditionally, AFTER the scope filter and without checking
  // `active` — pass the products' material types and every category leaks back
  // into both lists, which is what put FATTY and SCRAP under Purchase and
  // resurrected the retired DEAD LOSS. Nothing here needs the fallback: this
  // picker only ever writes a NEW line, and the register below reads the
  // stored text rather than this list, so an old value stays readable whatever
  // the master now says.
  const { forScope } = useCategories()
  const cats = forScope(form.kind === 'sales' ? 'sales' : 'purchase')

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows(await window.api.outsideTanker.list(date))
    } catch {
      setRows([])
    }
  }, [date])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    window.api.gate
      .partyCategories()
      .then(setPartyCats)
      .catch(() => setPartyCats([]))
  }, [open])

  // Purchase tankers belong to a supplier, sales tankers to a customer. One
  // field, two lists, switched by the kind above it — a single "party" list of
  // both would offer a customer for an inbound load.
  //
  // Narrowed again by the material: HUSK means HUSK parties. The tag on the
  // master answers it where there is one; a party with no tag falls back to
  // what it has actually traded, which is the rule Gate Entry already applies.
  const side = form.kind === 'sales' ? 'customer' : 'supplier'
  const allParties = form.kind === 'sales' ? customers : suppliers
  const cat = String(form.category || '').trim().toUpperCase()
  const parties = useMemo(() => {
    if (!cat || showAll) return allParties
    const traded = new Set(
      partyCats
        .filter((r) => String(r.side) === side && String(r.cat).toUpperCase() === cat)
        .map((r) => Number(r.id))
    )
    return allParties.filter((x) => {
      const tag = String((side === 'supplier' ? x.supplier_type : x.category) || '')
        .trim()
        .toUpperCase()
      return tag ? tag === cat : traded.has(Number(x.id))
    })
  }, [allParties, partyCats, side, cat, showAll])
  const narrowed = parties.length < allParties.length

  async function add(): Promise<void> {
    setSaving(true)
    try {
      await window.api.outsideTanker.save({
        log_date: date,
        slot: form.slot,
        kind: form.kind,
        category: form.category || null,
        party_id: Number(form.party_id) || null,
        tankers: Number(form.tankers) || 0,
        note: form.note,
        created_by: loadUser()?.username || ''
      })
      // Round, side and material all stay — a supervisor logging the four
      // o'clock walk enters five parties under one material in a row.
      setForm({ ...blank, slot: form.slot, kind: form.kind, category: form.category })
      await load()
      toast.success('Logged')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: number): Promise<void> {
    if (!window.confirm('Remove this line from the diary?')) return
    try {
      await window.api.outsideTanker.remove(id)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // A round is one of three things, not two: uncounted, counted and empty, or
  // counted with lorries in it. The NIL row is what separates the first two.
  const bySlot = SLOTS.map((s) => {
    const all = rows.filter((r) => String(r.slot) === s.v)
    const real = all.filter((r) => String(r.kind) !== 'nil')
    return {
      ...s,
      rows: real,
      nil: all.find((r) => String(r.kind) === 'nil') || null,
      total: real.reduce((t, r) => t + (Number(r.tankers) || 0), 0)
    }
  })

  async function recordNil(slot: string): Promise<void> {
    try {
      await window.api.outsideTanker.nil(date, slot)
      await load()
      toast.success('Recorded — nothing outside for that round')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(
          '!h-[38px] !gap-[7px] !rounded-[4px] !border !border-[#C3D2C6] !bg-white !px-[13px] !text-[12.5px] !font-bold !text-[#0A1F17] hover:!bg-[#F7FAF6]'
        )}
        title="The gate diary — how many tankers are standing outside, counted at 8 AM, 4 PM and 8 PM"
      >
        <ClipboardList className="h-4 w-4 text-[#0B6B45]" />
        Outside tankers
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] overflow-y-auto sm:!max-w-[1180px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[16px] font-extrabold">
              <ClipboardList className="h-[19px] w-[19px] text-[#0B6B45]" />
              Outside tankers
            </DialogTitle>
            <p className="text-[12px] font-semibold leading-[1.55] text-[#5A6B62]">
              What is standing outside the gate, counted three times a day. A headcount, not a document —
              no tanker numbers and no weights, so nothing here touches stock or a purchase. Gate Entry
              still records the ones that actually come in.
            </p>
          </DialogHeader>

          {/* One rule for every control on the strip: 40px tall, square
              corners, the same border. They arrived as three different shapes
              — a 36px pill Select, a 36px input and a 40px date button — which
              is what made the row read as assembled rather than designed. */}
          <div
            className={cn(
              'flex flex-wrap items-end gap-3 rounded-[4px] border border-[#D6E2D6] bg-[#F7FAF6] p-3',
              '[&_input]:!h-10 [&_input]:!rounded-[3px] [&_input]:!border-[#C3D2C6] [&_input]:!bg-white [&_input]:!text-[13px] [&_input]:!font-bold',
              '[&_[data-slot=select-trigger]]:!h-10 [&_[data-slot=select-trigger]]:!rounded-[3px] [&_[data-slot=select-trigger]]:!border-[#C3D2C6] [&_[data-slot=select-trigger]]:!bg-white [&_[data-slot=select-trigger]]:!text-[13px] [&_[data-slot=select-trigger]]:!font-bold',
              '[&_[data-slot=date-picker]]:!h-10 [&_[data-slot=date-picker]]:!rounded-[3px] [&_[data-slot=date-picker]]:!border-[#C3D2C6] [&_[data-slot=date-picker]]:!bg-white [&_[data-slot=date-picker]]:!text-[13px] [&_[data-slot=date-picker]]:!font-bold'
            )}
          >
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Date</Label>
              <div className="w-[160px]">
                <DatePicker value={date} onChange={(v) => setDate(v || todayISO())} max={todayISO()} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Round</Label>
              <Select value={form.slot} onValueChange={(v) => setForm((p) => ({ ...p, slot: v }))}>
                <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SLOTS.map((s) => <SelectItem key={s.v} value={s.v}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Category</Label>
              <Select
                value={form.kind}
                // The material list is per side, so a material chosen
                // under Purchase cannot survive a switch to Sales — and the
                // party was picked to match it.
                onValueChange={(v) => {
                  setShowAll(false)
                  setForm((p) => ({ ...p, kind: v, category: '', party_id: '' }))
                }}
              >
                <SelectTrigger className="w-[210px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k.v} value={k.v}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Material</Label>
              <Select
                value={String(form.category)}
                // Changing the material re-scopes the party list, so a party
                // that no longer belongs is dropped rather than left stale.
                onValueChange={(v) => {
                  setShowAll(false)
                  setForm((p) => ({ ...p, category: v, party_id: '' }))
                }}
              >
                <SelectTrigger className="w-[180px]"><SelectValue placeholder="Any material" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {cats.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Party</Label>
              <Select
                value={String(form.party_id)}
                // The escape from the material filter lives in the list itself
                // rather than as a line of text under the field. A note there
                // pushed this control out of line with the other five and put
                // Add on a row of its own, for something read once.
                onValueChange={(v) =>
                  v === SHOW_ALL ? setShowAll(true) : setForm((p) => ({ ...p, party_id: v }))
                }
              >
                <SelectTrigger className="w-[220px]"><SelectValue placeholder="Any party" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {parties.map((pa) => (
                    <SelectItem key={String(pa.id)} value={String(pa.id)}>{String(pa.name)}</SelectItem>
                  ))}
                  {narrowed && (
                    <SelectItem value={SHOW_ALL}>
                      {parties.length === 0 ? `No party is tagged ${cat} — show every party` : 'Show every party…'}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] font-extrabold uppercase tracking-[.13em] text-[#5A6B62]">Tankers</Label>
              <Input
                type="number"
                min={0}
                value={form.tankers}
                onChange={(e) => setForm((p) => ({ ...p, tankers: e.target.value }))}
                className="w-[92px] !text-right"
                placeholder="0"
              />
            </div>
            <Button
              onClick={() => void add()}
              disabled={saving}
              className="!h-10 !gap-1.5 !rounded-[3px] !bg-[#C7F03F] !px-[18px] !text-[13px] !font-extrabold !text-[#0B3D2E] hover:!bg-[#B9E52C]"
            >
              <Plus className="h-4 w-4" /> {saving ? 'Adding…' : 'Add'}
            </Button>
          </div>

          {bySlot.map((s) => (
            <div key={s.v} className="mt-3 overflow-hidden rounded-[4px] border border-[#D6E2D6]">
              <div className="flex items-center justify-between bg-[#0B3D2E] px-3.5 py-2">
                <span className="text-[12px] font-extrabold uppercase tracking-[.09em] text-white">
                  {s.label} round
                </span>
                <span className="text-[12px] font-bold text-[#C7F03F]">
                  {s.total} tanker{s.total === 1 ? '' : 's'}
                </span>
              </div>
              {s.rows.length === 0 ? (
                s.nil ? (
                  // Counted, and clear. Says so plainly, and can be taken back
                  // if a lorry turns up that was missed.
                  <div className="flex flex-wrap items-center justify-center gap-2 bg-[#F7FBF4] px-3.5 py-3.5 text-center">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[#0B6B45]" />
                    <span className="text-[12.5px] font-bold text-[#0B6B45]">Counted — nothing was outside.</span>
                    <button
                      type="button"
                      className="text-[11.5px] font-bold text-[#5A6B62] underline-offset-2 hover:underline"
                      onClick={() => void remove(Number(s.nil?.id))}
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-center gap-2.5 px-3.5 py-3.5 text-center">
                    <span className="text-[12px] font-semibold text-[#8FA79B]">Not counted yet.</span>
                    {/* The walk happening and finding nothing is a real answer,
                        and until it could be given, an empty round and a
                        forgotten one looked exactly the same. */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="!h-8 !gap-1.5 !rounded-[3px] !border-[#C3D2C6] !text-[12px] !font-bold !text-[#0B6B45] hover:!bg-[#EFF5EC]"
                      onClick={() => void recordNil(s.v)}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Nothing outside — record NIL
                    </Button>
                  </div>
                )
              ) : (
                <Table className="text-[12px] [&_td]:px-3 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-3">
                  <TableHeader>
                    <TableRow className="!bg-[#EFF5EC] hover:!bg-[#EFF5EC] [&_th]:!text-[10px] [&_th]:!font-extrabold [&_th]:!uppercase [&_th]:!tracking-[.09em] [&_th]:!text-[#33473E]">
                      <TableHead className="w-[60px]">SL no</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Material</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead className="text-right">Tankers</TableHead>
                      <TableHead className="w-[50px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.rows.map((r, i) => (
                      <TableRow key={String(r.id)}>
                        <TableCell className="font-semibold text-[#5A6B62]">{i + 1}</TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              'rounded-[2px] px-[7px] py-[2px] text-[9.5px] font-extrabold uppercase tracking-[.09em]',
                              String(r.kind) === 'sales'
                                ? 'bg-[#FDF3F2] text-[#8C2F26]'
                                : 'bg-[#F1FAF4] text-[#0B6B45]'
                            )}
                          >
                            {String(r.kind) === 'sales' ? 'Sales' : 'Purchase'}
                          </span>
                        </TableCell>
                        <TableCell className="font-bold text-[#0A1F17]">{String(r.category_label || '—')}</TableCell>
                        <TableCell className="text-[#33473E]">{String(r.party_name || '—')}</TableCell>
                        <TableCell className="text-right text-[13px] font-bold tabular-nums text-[#0A1F17]">
                          {Number(r.tankers) || 0}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            onClick={() => void remove(Number(r.id))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ))}

          <p className="mt-1 text-[11.5px] font-semibold text-[#8FA79B]">
            Showing {formatDate(date)}. Change the date above to read another day&apos;s diary.
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
}
