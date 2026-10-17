import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CalendarDays, Check, CheckCircle2, FileSpreadsheet, FolderTree, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { formatINR, formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

type Tab = 'matched' | 'tally' | 'ours'

/**
 * BRINGING TALLY'S LEDGER LIST ALONGSIDE THIS BOOK'S.
 *
 * Two systems hold the same chart of accounts and neither can see the other,
 * so the question "is this ledger in both, and do they agree on what it opened
 * at" had no way of being asked. It was answered by scrolling two screens.
 *
 * Upload the trial balance Tally exports and the three answers are separated:
 * the ledgers both sides have, the ones only Tally has, and the ones only this
 * book has. The first list can have its opening balances written across in one
 * go; the second can be matched by hand where the names differ, which is most
 * of the time — "Yes Bank 034827000000105" here is "YES BANK …" there.
 *
 * Nothing is written until it is asked for. An upload changes no balance: it
 * puts the two lists next to each other, and every figure that moves after
 * that is one somebody ticked.
 */
export function TallyLedgers({
  companyName,
  onClose,
  onChanged
}: {
  companyName?: string
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('matched')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  /**
   * THE GROUP EACH UNMATCHED LEDGER WILL BE BORN UNDER.
   *
   * Seeded from the suggestion the server reads off the name and the side of
   * the balance, and overridden per row or for everything ticked at once.
   * Eight hundred ledgers is not a list anybody classifies from nothing, and
   * it is not a list anybody wants dumped into one bucket either.
   */
  const [groupOf, setGroupOf] = useState<Record<number, string>>({})
  const [groups, setGroups] = useState<Row[]>([])
  /**
   * WHETHER THE BOOK'S OWN START DATE MOVES WITH THE FIGURES.
   *
   * An opening balance is an opening balance ON a date, and the file carries
   * it: Tally prints the period above the table and the Opening column is as
   * at the first of the two. Writing those figures into a book that begins on
   * a different day is how a trial balance quietly stops agreeing with itself
   * — so the date is offered alongside them, ticked by default only where the
   * book has not been given one.
   */
  const [setStart, setSetStart] = useState(false)
  const file = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await window.api.tally.map()
      setData(d)
      setSetStart(!!d.opening_date && !d.books_from)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    window.api.journal
      .groupNames()
      .then((g) => setGroups(g || []))
      .catch(() => setGroups([]))
  }, [])

  async function upload(f: File): Promise<void> {
    setBusy(true)
    try {
      // Read here and post the bytes: the desktop's file dialog does not exist
      // on the website, and a path that only one of the two can open is not a
      // way to upload anything.
      const b64 = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result || '').split(',')[1] || '')
        r.onerror = () => rej(new Error('Could not read that file'))
        r.readAsDataURL(f)
      })
      const out = await window.api.tally.import({ file_name: f.name, data_base64: b64 })
      toast.success(`${out.imported} ledgers read from ${out.file_name}`)
      setPicked({})
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }

  async function link(id: number, accountId: number | null): Promise<void> {
    try {
      await window.api.tally.link({ id, account_id: accountId })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function applyOpenings(ids: number[]): Promise<void> {
    if (!ids.length) {
      toast.error('Tick the ledgers whose opening balances should be written')
      return
    }
    setBusy(true)
    try {
      const out = await window.api.tally.applyOpenings({ ids, set_books_from: setStart })
      toast.success(`${out.saved} opening balance${out.saved === 1 ? '' : 's'} written`)
      setPicked({})
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const groupFor = (r: Row): string => groupOf[n(r.id)] || String(r.suggested_group || 'Suspense A/C')

  async function createThem(ids: number[], withOpenings: boolean): Promise<void> {
    if (!ids.length) {
      toast.error('Tick the ledgers to create')
      return
    }
    const rows = ((data?.only_tally as Row[]) || []).filter((r) => ids.includes(n(r.id)))
    setBusy(true)
    try {
      const out = await window.api.tally.create({
        rows: rows.map((r) => ({ id: n(r.id), group: groupFor(r) })),
        with_openings: withOpenings,
        set_books_from: withOpenings && setStart
      })
      toast.success(
        `${out.created} ledger${out.created === 1 ? '' : 's'} created${
          out.openings ? `, ${out.openings} with their opening balance` : ''
        }`
      )
      setPicked({})
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function regroup(accountIds: number[], group: string): Promise<void> {
    if (!accountIds.length) {
      toast.error('Tick the ledgers to move')
      return
    }
    setBusy(true)
    try {
      const out = await window.api.tally.regroup({ account_ids: accountIds, group })
      toast.success(`${out.moved} ledger${out.moved === 1 ? '' : 's'} moved to ${group}`)
      setPicked({})
      await load()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * THE ONES STILL WAITING TO BE TOLD WHAT THEY ARE.
   *
   * Eight hundred ledgers arrive classified by a guess, and the guess is
   * honest about the ones it could not make: they land in Suspense. This is
   * the list to work through afterwards, and it has to be findable without
   * scrolling past the seven hundred that are already right.
   */
  const UNSORTED = new Set(['SUSPENSE A/C', 'SUSPENSE', 'GENERAL', ''])
  const unsorted = useMemo(
    () => ((data?.matched as Row[]) || []).filter((m) => UNSORTED.has(String(m.acc_group || '').toUpperCase())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]
  )
  const [onlyUnsorted, setOnlyUnsorted] = useState(false)

  async function clearAll(): Promise<void> {
    setBusy(true)
    try {
      const out = await window.api.tally.clear()
      toast.success(out.cleared ? `${out.cleared} uploaded ledgers cleared` : 'Nothing to clear')
      setPicked({})
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const counts = (data?.counts as Row) || {}
  const ours = (data?.only_ours as Row[]) || []
  const allOurs = useMemo(() => {
    const seen = new Map<number, Row>()
    for (const m of (data?.matched as Row[]) || []) {
      seen.set(n(m.account_id), { id: n(m.account_id), name: String(m.our_name), acc_group: String(m.acc_group || '') })
    }
    for (const a of ours) seen.set(n(a.id), a)
    return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }, [data, ours])

  const rows = useMemo(() => {
    const key = q.trim().toLowerCase()
    const list: Row[] =
      tab === 'matched'
        ? onlyUnsorted
          ? unsorted
          : (data?.matched as Row[]) || []
        : tab === 'tally'
          ? (data?.only_tally as Row[]) || []
          : ours
    if (!key) return list
    return list.filter((r) =>
      `${String(r.name || '')} ${String(r.our_name || '')}`.toLowerCase().includes(key)
    )
  }, [data, tab, q, ours, onlyUnsorted, unsorted])

  const TABS: { k: Tab; label: string; count: number; hint: string }[] = [
    { k: 'matched', label: 'In both', count: n(counts.matched), hint: 'the same ledger on both sides' },
    { k: 'tally', label: 'Only in Tally', count: n(counts.only_tally), hint: 'not in this book yet — match them' },
    { k: 'ours', label: 'Only here', count: n(counts.only_ours), hint: 'this book has them, the file does not' }
  ]

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative flex h-full max-h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-[6px] bg-white shadow-2xl">
        <div className="flex flex-none items-start gap-3 bg-[#0B3D2E] px-6 py-4 text-white">
          <FileSpreadsheet className="mt-[3px] h-[20px] w-[20px] shrink-0 text-[#8FBFA8]" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
              Masters · Tally ledgers
            </div>
            <div className="truncate text-[18px] font-extrabold">{companyName || 'This company'}</div>
            <div className="mt-[2px] text-[12px] font-bold text-[#BFE3CB]">
              {data?.file_name
                ? `${String(data.file_name)} · ${n(counts.tally)} ledgers read`
                : 'No Tally file uploaded yet'}
              {!!data?.opening_date && (
                <>
                  {' · '}
                  opening as at {formatDate(String(data.opening_date))}
                  {!!data?.period_to && ` (to ${formatDate(String(data.period_to))})`}
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* THE UPLOAD, AND WHAT IT FOUND. */}
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F7FAF6] px-6 py-3">
          <input
            ref={file}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
            }}
          />
          <Button
            onClick={() => file.current?.click()}
            disabled={busy}
            className="!h-[38px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[12.5px] !font-extrabold !text-white hover:!bg-[#0B6D4A]"
          >
            <Upload className="h-[17px] w-[17px]" />
            {busy ? 'Working…' : data?.file_name ? 'Upload a newer file' : 'Upload the Tally trial balance'}
          </Button>
          <span className="text-[11.5px] font-semibold text-[#5A6B62]">
            The .xlsx Tally exports — one ledger a row, with its opening debit and credit.
          </span>
          {!!data?.file_name && (
            <button
              type="button"
              onClick={() => void clearAll()}
              disabled={busy}
              className="ml-auto flex items-center gap-1.5 rounded-[4px] px-2.5 py-1.5 text-[12px] font-bold text-[#8CA396] hover:bg-black/5 hover:text-[#B3261E]"
            >
              <Trash2 className="h-[15px] w-[15px]" /> Clear the upload
            </button>
          )}
        </div>

        {n(counts.tally) > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-2 border-b border-b-[#E4ECE3] px-6 py-2.5">
            {TABS.map((t) => (
              <button
                key={t.k}
                type="button"
                title={t.hint}
                onClick={() => setTab(t.k)}
                className={cn(
                  'flex items-center gap-2 rounded-[4px] border px-3.5 py-2 text-[12.5px] font-extrabold transition-colors',
                  tab === t.k
                    ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white'
                    : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'rounded-[3px] px-1.5 py-[1px] text-[11px] font-extrabold tabular-nums',
                    tab === t.k ? 'bg-white/15 text-[#C7F03F]' : 'bg-[#EAF0E9] text-[#33473E]'
                  )}
                >
                  {t.count}
                </span>
              </button>
            ))}
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8CA396]" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a ledger"
                className="h-[36px] w-[240px] rounded-[4px] border border-[#C3D2C6] bg-white pl-9 pr-3 text-[13px] font-semibold text-[#0A1F17] outline-none focus:border-[#0B3D2E]"
              />
            </div>
          </div>
        )}

        {!!data?.opening_date && (tab === 'matched' || tab === 'tally') && (
          <label className="flex flex-none cursor-pointer flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-white px-6 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-[#0B6B45]"
              checked={setStart}
              onChange={(e) => setSetStart(e.target.checked)}
            />
            <CalendarDays className="h-[16px] w-[16px] shrink-0 text-[#5A6B62]" />
            <span className="min-w-0 flex-1 text-[12px] font-semibold text-[#33473E] [text-wrap:pretty]">
              These figures are an opening as at{' '}
              <b className="text-[#0A1F17]">{formatDate(String(data.opening_date))}</b>. This book{' '}
              {data?.books_from ? (
                <>
                  begins on <b className="text-[#0A1F17]">{formatDate(String(data.books_from))}</b>
                  {String(data.books_from) === String(data.opening_date)
                    ? ' — the same day.'
                    : ' — a different day. Tick to move it to the file’s.'}
                </>
              ) : (
                <>has no start date set. Tick to set it from the file.</>
              )}
            </span>
          </label>
        )}

        {tab === 'matched' && n(counts.matched) > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F4F8FD] px-6 py-2.5">
            <FolderTree className="h-[17px] w-[17px] shrink-0 text-[#1B4E82]" />
            <span className="min-w-0 flex-1 text-[12px] font-bold text-[#1B4E82] [text-wrap:pretty]">
              {unsorted.length
                ? `${unsorted.length} of these are still in Suspense — tick them and say which head they belong under.`
                : 'Every matched ledger sits under a head. Tick any to move them somewhere else.'}
            </span>
            {unsorted.length > 0 && (
              <button
                type="button"
                onClick={() => setOnlyUnsorted((v) => !v)}
                className={cn(
                  'h-[34px] rounded-[4px] border px-3 text-[12px] font-bold',
                  onlyUnsorted
                    ? 'border-[#1B4E82] bg-[#1B4E82] text-white'
                    : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#F7FAF6]'
                )}
              >
                {onlyUnsorted ? 'Showing unsorted' : `Show the ${unsorted.length} unsorted`}
              </button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              className="!h-[34px] !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
              onClick={() => setPicked(Object.fromEntries(rows.map((r) => [n(r.id), true])))}
            >
              Tick all {rows.length}
            </Button>
            <GroupPick
              groups={groups}
              label="Move ticked to…"
              onPick={(g) =>
                void regroup(
                  ((data?.matched as Row[]) || [])
                    .filter((m) => picked[n(m.id)])
                    .map((m) => n(m.account_id)),
                  g
                )
              }
            />
          </div>
        )}

        {tab === 'matched' && n(counts.matched) > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-3 border-b border-b-[#E4ECE3] bg-[#FDF6EC] px-6 py-2.5">
            <AlertTriangle className="h-[17px] w-[17px] shrink-0 text-[#8A6A3B]" />
            <span className="min-w-0 flex-1 text-[12px] font-bold text-[#8A6A3B] [text-wrap:pretty]">
              {n(counts.out_of_step)
                ? `${n(counts.out_of_step)} of these open at a different figure here than in Tally. Writing an opening replaces this book's.`
                : 'Every matched ledger already opens at the figure Tally holds.'}
            </span>
            <Button
              variant="outline"
              disabled={busy}
              className="!h-[34px] !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
              onClick={() =>
                setPicked(
                  Object.fromEntries(
                    ((data?.matched as Row[]) || []).filter((m) => !m.in_step).map((m) => [n(m.id), true])
                  )
                )
              }
            >
              Tick the {n(counts.out_of_step)} that differ
            </Button>
            <Button
              disabled={busy || !Object.values(picked).some(Boolean)}
              className="!h-[34px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[12px] !font-extrabold !text-white hover:!bg-[#0B6D4A]"
              onClick={() =>
                void applyOpenings(
                  Object.entries(picked)
                    .filter(([, v]) => v)
                    .map(([k]) => Number(k))
                )
              }
            >
              <Check className="h-[16px] w-[16px]" />
              {Object.values(picked).filter(Boolean).length
                ? `Write ${Object.values(picked).filter(Boolean).length} opening balance${
                    Object.values(picked).filter(Boolean).length === 1 ? '' : 's'
                  }`
                : 'Write opening balances'}
            </Button>
          </div>
        )}

        {tab === 'tally' && n(counts.only_tally) > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-b-[#E4ECE3] bg-[#F4F8FD] px-6 py-2.5">
            <FolderTree className="h-[17px] w-[17px] shrink-0 text-[#1B4E82]" />
            <span className="min-w-0 flex-1 text-[12px] font-bold text-[#1B4E82] [text-wrap:pretty]">
              Create these as they are named. Each arrives under the group beside it — read off the name, or off
              which side its balance sits — and every one can be moved afterwards.
            </span>
            <Button
              variant="outline"
              disabled={busy}
              className="!h-[34px] !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
              onClick={() => setPicked(Object.fromEntries(rows.map((r) => [n(r.id), true])))}
            >
              Tick all {rows.length}
            </Button>
            <GroupPick
              groups={groups}
              label="Set group for ticked"
              onPick={(g) =>
                setGroupOf((prev) => {
                  const next = { ...prev }
                  for (const [k, v] of Object.entries(picked)) if (v) next[Number(k)] = g
                  return next
                })
              }
            />
            <Button
              variant="outline"
              disabled={busy || !Object.values(picked).some(Boolean)}
              className="!h-[34px] !rounded-[4px] !border-[#C3D2C6] !px-3 !text-[12px] !font-bold"
              onClick={() =>
                void createThem(
                  Object.entries(picked)
                    .filter(([, v]) => v)
                    .map(([k]) => Number(k)),
                  false
                )
              }
            >
              Create only
            </Button>
            <Button
              disabled={busy || !Object.values(picked).some(Boolean)}
              className="!h-[34px] !gap-2 !rounded-[4px] !bg-[#0B3D2E] !px-4 !text-[12px] !font-extrabold !text-white hover:!bg-[#0B6D4A]"
              onClick={() =>
                void createThem(
                  Object.entries(picked)
                    .filter(([, v]) => v)
                    .map(([k]) => Number(k)),
                  true
                )
              }
            >
              <Plus className="h-[16px] w-[16px]" />
              Create {Object.values(picked).filter(Boolean).length} with openings
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {n(counts.tally) === 0 ? (
            <div className="px-6 py-16 text-center">
              <FileSpreadsheet className="mx-auto mb-3 h-9 w-9 text-[#C3D2C6]" />
              <div className="text-[14px] font-extrabold text-[#0A1F17]">Nothing uploaded yet</div>
              <p className="mx-auto mt-2 max-w-[520px] text-[12.5px] font-semibold leading-[1.6] text-[#5A6B62] [text-wrap:pretty]">
                Export a trial balance from Tally as .xlsx and upload it above. Nothing in this book changes on
                upload — you get the two ledger lists side by side, and decide what to carry across.
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13px] font-semibold text-[#5A6B62]">
              {q ? 'No ledger matches that.' : 'Nothing in this list.'}
            </div>
          ) : (
            <ul>
              {rows.map((r) => {
                const id = n(r.id)
                if (tab === 'ours') {
                  return (
                    <li
                      key={`o${id}`}
                      className="flex items-center gap-3 border-b border-b-[#EFF3EE] px-6 py-3 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-bold text-[#0A1F17]">{String(r.name)}</span>
                        <span className="block truncate text-[11px] font-semibold uppercase tracking-wide text-[#5A6B62]">
                          {String(r.acc_group || '')}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[12.5px] font-bold tabular-nums text-[#33473E]">
                        {n(r.open_dr) > 0.004
                          ? `${formatINR(r.open_dr)} Dr`
                          : n(r.open_cr) > 0.004
                            ? `${formatINR(r.open_cr)} Cr`
                            : '—'}
                        <span className="block text-[10px] font-semibold uppercase tracking-wide text-[#8CA396]">
                          opening here
                        </span>
                      </span>
                    </li>
                  )
                }
                const matched = tab === 'matched'
                return (
                  <li
                    key={`t${id}`}
                    className={cn(
                      'flex items-center gap-3 border-b border-b-[#EFF3EE] px-6 py-3 last:border-b-0',
                      picked[id] && 'bg-[#EAF0E9]'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[#0B6B45]"
                      checked={!!picked[id]}
                      onChange={(e) => setPicked((prev) => ({ ...prev, [id]: e.target.checked }))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-bold text-[#0A1F17]">{String(r.name)}</span>
                        {matched && r.by_hand && (
                          <span className="rounded-[2px] border border-[#C6DAF0] bg-[#EAF0FA] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-wide text-[#1B4E82]">
                            matched by hand
                          </span>
                        )}
                        {matched && (r.in_step ? (
                          <CheckCircle2 className="h-[15px] w-[15px] shrink-0 text-[#12855A]" />
                        ) : (
                          <span className="rounded-[2px] border border-[#F0D9AE] bg-[#FFFBF2] px-1.5 py-[1px] text-[9.5px] font-extrabold uppercase tracking-wide text-[#8A5300]">
                            differs
                          </span>
                        ))}
                      </span>
                      {matched ? (
                        <span className="mt-[2px] block truncate text-[11.5px] font-semibold text-[#5A6B62]">
                          → {String(r.our_name)} · {String(r.acc_group || '')} · opens here at{' '}
                          {n(r.open_dr) > 0.004
                            ? `${formatINR(r.open_dr)} Dr`
                            : n(r.open_cr) > 0.004
                              ? `${formatINR(r.open_cr)} Cr`
                              : 'nothing'}
                        </span>
                      ) : (
                        <span className="mt-[2px] flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold text-[#8A6A3B]">
                          not in {companyName || 'this book'} — will be created under
                          <GroupPick
                            groups={groups}
                            label={groupFor(r)}
                            compact
                            onPick={(g) => setGroupOf((prev) => ({ ...prev, [id]: g }))}
                          />
                        </span>
                      )}
                    </span>

                    <span className="shrink-0 text-right text-[12.5px] font-extrabold tabular-nums text-[#0A1F17]">
                      {n(r.dr) > 0.004
                        ? `${formatINR(r.dr)} Dr`
                        : n(r.cr) > 0.004
                          ? `${formatINR(r.cr)} Cr`
                          : '—'}
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-[#8CA396]">
                        in Tally
                      </span>
                    </span>

                    {/* MATCHING BY HAND, where the two systems spell it
                        differently — which is most of the time. */}
                    {matched && (
                      <GroupPick
                        groups={groups}
                        label={String(r.acc_group || 'Group')}
                        compact
                        onPick={(g) => void regroup([n(r.account_id)], g)}
                      />
                    )}
                    <LedgerPick
                      options={allOurs}
                      value={matched ? n(r.account_id) : 0}
                      onPick={(accId) => void link(id, accId)}
                      label={matched ? 'Change' : 'Match to…'}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/** A small ledger picker, so a Tally name can be pointed at one of ours. */
function LedgerPick({
  options,
  value,
  onPick,
  label
}: {
  options: Row[]
  value: number
  onPick: (id: number | null) => void
  label: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-[32px] shrink-0 items-center rounded-[4px] border border-[#C3D2C6] bg-white px-3 text-[12px] font-bold text-[#33473E] hover:bg-[#F7FAF6]"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-0">
        <Command>
          <CommandInput placeholder="Type a ledger name…" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No ledger of that name in this book.</CommandEmpty>
            {!!value && (
              <CommandItem
                value="__unlink__"
                onSelect={() => {
                  onPick(null)
                  setOpen(false)
                }}
              >
                <X className="h-3.5 w-3.5 text-[#B3261E]" />
                <span className="text-[#B3261E]">Unmatch this one</span>
              </CommandItem>
            )}
            {options.map((a) => (
              <CommandItem
                key={String(a.id)}
                value={String(a.name)}
                onSelect={() => {
                  onPick(n(a.id))
                  setOpen(false)
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-semibold text-[#0A1F17]">{String(a.name)}</span>
                  <span className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {String(a.acc_group || '')}
                  </span>
                </span>
                {n(a.id) === value && <Check className="h-3.5 w-3.5 text-[#0B6B45]" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Which head a ledger sits under. The same control before birth and after. */
function GroupPick({
  groups,
  label,
  onPick,
  compact
}: {
  groups: Row[]
  label: string
  onPick: (group: string) => void
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Choose the group it belongs under"
          className={cn(
            'flex shrink-0 items-center rounded-[4px] border bg-white font-bold',
            compact
              ? 'h-[24px] border-[#D6E2D6] px-2 text-[11px] text-[#1B4E82] hover:bg-[#F7FAF6]'
              : 'h-[34px] border-[#C3D2C6] px-3 text-[12px] text-[#33473E] hover:bg-[#F7FAF6]'
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <Command>
          <CommandInput placeholder="Type a group name…" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No group of that name.</CommandEmpty>
            {groups.map((g) => (
              <CommandItem
                key={String(g.name)}
                value={String(g.name)}
                onSelect={() => {
                  onPick(String(g.name))
                  setOpen(false)
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-semibold text-[#0A1F17]">{String(g.name)}</span>
                  {!!g.path && (
                    <span className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {String(g.path)}
                    </span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
