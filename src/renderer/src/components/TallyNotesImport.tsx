import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, CheckCircle2, ChevronRight, FileSpreadsheet, LayoutGrid, Link2, Plus, RefreshCw, Sparkles, Upload, X } from 'lucide-react'
import { formatDate, formatINR } from '@/lib/format'
import { orderVoucherLines, TAX_NAME } from '@/lib/voucherOrder'
import { TallySalesCheck, draftTime } from '@/components/TallySalesCheck'
import { TallyRegisterCheck } from '@/components/TallyRegisterCheck'
import { TallyBankCheck } from '@/components/TallyBankCheck'
import { TallyOverview } from '@/components/TallyOverview'
import { GroupCombo, LedgerCombo } from '@/components/TallyLedgerPickers'
import { ColumnFilter } from '@/components/ui/column-filter'
import { useColumnFilters } from '@/lib/useColumnFilters'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Kind = 'credit' | 'debit'

// TALLY FILE UPDATION — bring a Tally Credit / Debit Note register into these
// books in three steps: upload it, map every Tally ledger name to a ledger
// here (or create it), then create the notes the books do not have yet.
// Each kind has its own upload, so a Debit Note register can never be read
// as credit notes. The server re-reads the file when posting; nothing the
// screen shows is trusted as a figure.

const KINDS: { k: Kind; label: string; sub: string }[] = [
  { k: 'credit', label: 'Credit Notes', sub: 'Credit Note Register' },
  { k: 'debit', label: 'Debit Notes', sub: 'Debit Note Register' }
]

const STATUS: Record<string, { label: string; fg: string; bg: string; bd: string; tip: string }> = {
  new: { label: 'New', fg: '#0B6B45', bg: '#E9F5EE', bd: '#BFE3CB', tip: 'Not in these books — ready to create' },
  exists: { label: 'In books', fg: '#5A6B62', bg: '#EEF3EC', bd: '#DCE7DB', tip: 'A note with this number and amount is already here' },
  clash: { label: 'No. clash', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'This number is used here by a note of a different amount' },
  maybe: { label: 'Possible duplicate', fg: '#8A5300', bg: '#FFF4DD', bd: '#F1D9A6', tip: 'A note of the same date and amount is already here under another number' },
  unbalanced: { label: 'Does not add up', fg: '#B3261E', bg: '#FDF3F2', bd: '#F0D6D4', tip: 'The ledger columns do not add up to the gross total' }
}

interface Props {
  companyName: string
  /** The company Accounting is in — every Tally call is made against it. */
  companyId?: number
  accounts: Row[]
  groupNames: Row[]
  onChanged: () => void
  /** Open an invoice — on the Sales page when a sale is behind it, else its voucher; Back comes here. */
  onOpenVoucher?: (entryId: number, saleId?: number, orderId?: number) => void
}

// The tab in front, kept across a trip to a voucher and back (the screen
// unmounts while the voucher is open): a note import, or one of the checks.
type CheckTab = 'overview' | 'sales' | 'journal' | 'purchase' | 'bank'
// The desk opens on the overview the first time; after that, where it was.
let lastCheckTab: CheckTab | null = 'overview'
const CHECKS: { k: CheckTab; label: string }[] = [
  { k: 'sales', label: 'Sales Register' },
  { k: 'purchase', label: 'Purchase Register' },
  { k: 'journal', label: 'Journal Register' },
  { k: 'bank', label: 'Bank Book' }
]

interface KindState {
  fileName: string
  b64: string
  preview: Row | null
  picked: Set<string>
  busy: boolean
  result: { created: { vch_no: string; id: number }[]; skipped: { vch_no: string; reason: string }[] } | null
  // Kept as a draft on the server until Process: when it was last saved.
  savedAt: string
  allowMaybe: boolean
}

const empty = (): KindState => ({ fileName: '', b64: '', preview: null, picked: new Set(), busy: false, result: null, savedAt: '', allowMaybe: false })


function chip(fg: string, bg: string, bd: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: fg, background: bg, border: `1px solid ${bd}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap' }
}

export function TallyNotesImport({ companyName, companyId, accounts, groupNames, onChanged, onOpenVoucher }: Props): React.JSX.Element {
  const [kind, setKind] = useState<Kind>('credit')
  // The register checks sit beside the two note imports: each compares, and
  // books what is missing on request.
  const [checkTab, setCheckTabState] = useState<CheckTab | null>(lastCheckTab)
  const setCheckTab = (v: CheckTab | null): void => {
    lastCheckTab = v
    setCheckTabState(v)
  }
  const salesTab = checkTab !== null
  // A bank card on the overview opens that bank's book.
  const [bankFocus, setBankFocus] = useState<{ id: number; n: number } | null>(null)
  // A check is mounted the first time it is opened, then kept, so its file is
  // still there after a look at another tab.
  const [opened, setOpened] = useState<Set<CheckTab>>(() => new Set(lastCheckTab ? [lastCheckTab] : []))
  useEffect(() => {
    if (checkTab && checkTab !== 'overview') setOpened((s) => (s.has(checkTab) ? s : new Set([...s, checkTab])))
  }, [checkTab])
  const [state, setState] = useState<Record<Kind, KindState>>({ credit: empty(), debit: empty() })
  const [onlyUnmapped, setOnlyUnmapped] = useState(false)
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ key: string; name: string; group: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const st = state[kind]
  const pv = st.preview
  const set = (patch: Partial<KindState>, k: Kind = kind): void => setState((s) => ({ ...s, [k]: { ...s[k], ...patch } }))
  // The company on screen now — see read(), which drops an answer for another.
  const companyNow = useRef(companyId)
  companyNow.current = companyId

  const ledgers: Row[] = pv?.ledgers || []
  const mapOf = useMemo(() => new Map(ledgers.map((l) => [String(l.key), l])), [ledgers])
  const notes: Row[] = pv?.notes || []
  const counts = useMemo(() => {
    const c: Record<string, number> = { new: 0, exists: 0, clash: 0, maybe: 0, unbalanced: 0 }
    for (const x of notes) c[String(x.status)] = (c[String(x.status)] || 0) + 1
    return c
  }, [notes])
  const unmapped = ledgers.filter((l) => !l.account_id)
  // Names a ticked note still needs before it can post.
  const pickedNotes = notes.filter((x) => st.picked.has(String(x.vch_no)))
  const blocking = useMemo(() => {
    const need = new Set<string>()
    for (const x of pickedNotes) {
      if (!mapOf.get(String(x.party_key))?.account_id) need.add(String(x.party))
      for (const c of x.cols as Row[]) if (!mapOf.get(String(c.key))?.account_id) need.add(String(c.name))
    }
    return [...need]
  }, [pickedNotes, mapOf])

  async function read(
    k: Kind,
    fileName: string,
    b64: string,
    draft?: { picked: string[]; allowMaybe: boolean; savedAt: string }
  ): Promise<void> {
    const forCompany = companyId
    set({ busy: true, result: null }, k)
    try {
      const p = await window.api.tallyNotes.preview({ company_id: forCompany, kind: k, data_base64: b64, file_name: fileName })
      // Switched company while it was being read: this answer is the old one's.
      if (companyNow.current !== forCompany) return
      const canPick = new Set((p.notes as Row[]).filter((x) => x.status === 'new' || x.status === 'maybe').map((x) => String(x.vch_no)))
      // A draft brings back exactly what was ticked — less anything that has
      // since been created or can no longer be picked.
      const picked = draft
        ? new Set(draft.picked.filter((v) => canPick.has(v)))
        : new Set<string>((p.notes as Row[]).filter((x) => x.status === 'new').map((x) => String(x.vch_no)))
      set({ fileName, b64, preview: p, picked, busy: false, allowMaybe: draft?.allowMaybe ?? false, savedAt: draft?.savedAt ?? '' }, k)
      if (!draft) {
        const s = await window.api.tallyNotes.saveDraft({ company_id: forCompany, kind: k, file_name: fileName, data_base64: b64, picked: [...picked], allow_maybe: false })
        if (companyNow.current === forCompany) set({ savedAt: s.saved_at }, k)
      }
    } catch (e) {
      set({ busy: false }, k)
      toast.error((e as Error).message)
    }
  }

  // Bring back what was being worked on — in this company, by this user.
  useEffect(() => {
    let live = true
    setState({ credit: empty(), debit: empty() })
    // Nothing is read until Accounting has said which company this is.
    if (!companyId) return
    void window.api.tallyNotes
      .drafts({ company_id: companyId })
      .then((ds) => {
        if (!live) return
        for (const d of ds as Row[]) {
          if (d.kind !== 'credit' && d.kind !== 'debit') continue
          void read(d.kind as Kind, String(d.file_name || ''), String(d.data_base64), {
            picked: (d.picked as string[]) || [],
            allowMaybe: !!d.allow_maybe,
            savedAt: String(d.saved_at || '')
          })
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  // Every change to what is ticked is kept, a moment after it is made.
  const saveTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  function keep(k: Kind, picked: Set<string>, allowMaybe: boolean): void {
    clearTimeout(saveTimer.current[k])
    saveTimer.current[k] = setTimeout(() => {
      void window.api.tallyNotes
        .saveDraft({ company_id: companyId, kind: k, picked: [...picked], allow_maybe: allowMaybe })
        .then((s) => s.saved_at && set({ savedAt: s.saved_at }, k))
        .catch(() => {})
    }, 600)
  }
  function pick(next: Set<string>): void {
    set({ picked: next })
    if (st.savedAt) keep(kind, next, st.allowMaybe)
  }
  function setMaybe(v: boolean): void {
    set({ allowMaybe: v })
    if (st.savedAt) keep(kind, st.picked, v)
  }
  async function discard(): Promise<void> {
    await window.api.tallyNotes.clearDraft({ company_id: companyId, kind }).catch(() => {})
    set(empty())
    toast.success('Draft discarded')
  }

  function choose(f: File | undefined): void {
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      void read(kind, f.name, s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(f)
  }

  async function refresh(): Promise<void> {
    // Re-read the file, keeping what has been ticked.
    if (st.b64) await read(kind, st.fileName, st.b64, { picked: [...st.picked], allowMaybe: st.allowMaybe, savedAt: st.savedAt })
  }

  async function mapTo(l: Row, account: Row | null): Promise<void> {
    try {
      await window.api.tallyNotes.saveMap({ tally_name: l.tally_name, account_id: account ? Number(account.id) : null })
      // Updated in place so the list does not jump while mapping.
      set({
        preview: {
          ...pv,
          ledgers: ledgers.map((x) =>
            x.key === l.key ? { ...x, account_id: account ? Number(account.id) : null, account_name: account ? String(account.name) : null, how: account ? 'saved' : null } : x
          )
        }
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function createLedger(): Promise<void> {
    if (!creating) return
    const l = mapOf.get(creating.key)
    if (!l) return
    try {
      const r = await window.api.tallyNotes.createLedger({ company_id: companyId, tally_name: l.tally_name, name: creating.name, group: creating.group })
      toast.success(`Ledger ${r.name} created under ${creating.group} and mapped`)
      setCreating(null)
      onChanged()
      set({
        preview: { ...pv, ledgers: ledgers.map((x) => (x.key === l.key ? { ...x, account_id: r.id, account_name: r.name, how: 'saved' } : x)) }
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function post(): Promise<void> {
    if (!st.picked.size) return void toast.error('Tick the notes to create')
    if (blocking.length) return void toast.error(`Map these first: ${blocking.join(', ')}`)
    set({ busy: true })
    try {
      const r = await window.api.tallyNotes.post({ company_id: companyId, kind, data_base64: st.b64, file_name: st.fileName, vch_nos: [...st.picked], allow_maybe: st.allowMaybe })
      toast.success(`${r.created.length} ${kind} note${r.created.length === 1 ? '' : 's'} created${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`)
      onChanged()
      // Processed: the draft has done its job.
      await window.api.tallyNotes.clearDraft({ company_id: companyId, kind }).catch(() => {})
      const p = await window.api.tallyNotes.preview({ company_id: companyId, kind, data_base64: st.b64, file_name: st.fileName })
      set({ preview: p, picked: new Set((p.notes as Row[]).filter((x) => x.status === 'new').map((x) => String(x.vch_no))), result: r, busy: false, savedAt: '' })
    } catch (e) {
      set({ busy: false })
      toast.error((e as Error).message)
    }
  }

  const card = 'overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white'
  const head = 'flex items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-3 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0A1F17]'
  const num = (k: number): React.JSX.Element => (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0B3D2E] text-[10.5px] font-extrabold tracking-normal text-[#C7F03F]">{k}</span>
  )
  const shownLedgers = onlyUnmapped ? unmapped : ledgers
  const selectable = (x: Row): boolean => x.status === 'new' || x.status === 'maybe'
  // Every column of the notes table filters, Excel style.
  const cf = useColumnFilters(notes, {
    date: { get: (x) => String(x.date || '').slice(0, 10), label: (v) => (v ? formatDate(v) : '(blank)') },
    vch: { get: (x) => String(x.vch_no || '') },
    party: { get: (x) => String(x.party || '') },
    lines: { get: (x) => String(((x.cols as Row[]) || []).length + 1), numeric: true },
    gross: { get: (x) => String(Math.round((Number(x.gross) || 0) * 100) / 100), label: (v) => formatINR(Number(v)), numeric: true },
    status: { get: (x) => STATUS[String(x.status)]?.label || String(x.status) }
  })
  // A Debit Note register is not filtered by what was ticked on the Credit one.
  const clearCols = cf.clear
  useEffect(() => {
    clearCols()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])
  const shownNotes = cf.filtered
  const shownPickable = shownNotes.filter(selectable)
  const partySide = kind === 'credit' ? 'Cr' : 'Dr'
  const colSide = kind === 'credit' ? 'Dr' : 'Cr'

  return (
    <div className="sc flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto bg-[#F2F6F1] p-4">
      {/* Which register */}
      <div className="flex flex-none flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCheckTab('overview')}
          className="flex h-11 items-center gap-2 rounded-[5px] border px-4 text-[13px] font-extrabold"
          style={
            checkTab === 'overview'
              ? { background: '#0B3D2E', color: '#fff', borderColor: '#0B3D2E' }
              : { background: '#fff', color: '#33473E', borderColor: '#D6E2D6' }
          }
        >
          <LayoutGrid className="h-4 w-4" />
          Overview
        </button>
        {KINDS.map((t) => {
          const on = !salesTab && kind === t.k
          const s2 = state[t.k]
          return (
            <button
              key={t.k}
              type="button"
              onClick={() => {
                setCheckTab(null)
                setKind(t.k)
                setOpenNote(null)
                setCreating(null)
              }}
              className="flex h-11 items-center gap-2 rounded-[5px] border px-4 text-[13px] font-extrabold"
              style={{ background: on ? '#0B3D2E' : '#fff', color: on ? '#fff' : '#33473E', borderColor: on ? '#0B3D2E' : '#D6E2D6' }}
            >
              <FileSpreadsheet className="h-4 w-4" />
              {t.label}
              {s2.preview && (
                <span style={chip(on ? '#12280B' : '#0B6B45', on ? '#C7F03F' : '#E9F5EE', on ? '#C7F03F' : '#BFE3CB')}>
                  {(s2.preview.notes as Row[]).filter((x) => x.status === 'new').length} new
                </span>
              )}
            </button>
          )
        })}
        {CHECKS.map((ck) => {
          const on = checkTab === ck.k
          return (
            <button
              key={ck.k}
              type="button"
              onClick={() => setCheckTab(ck.k)}
              className="flex h-11 items-center gap-2 rounded-[5px] border px-4 text-[13px] font-extrabold"
              style={{ background: on ? '#0B3D2E' : '#fff', color: on ? '#fff' : '#33473E', borderColor: on ? '#0B3D2E' : '#D6E2D6' }}
            >
              <FileSpreadsheet className="h-4 w-4" />
              {ck.label}
              <span style={chip(on ? '#12280B' : '#1B4E82', on ? '#C7F03F' : '#EAF0FA', on ? '#C7F03F' : '#C6DAF0')}>Check</span>
            </button>
          )
        })}
        <span className="ml-auto text-[11.5px] font-semibold text-[#5A6B62]">
          {salesTab ? 'Compared with' : 'Posting into'} {companyName || 'this company'}
        </span>
      </div>

      {/* Kept mounted, so a checked file is still there after a look at the notes. */}
      {checkTab === 'overview' && (
        <TallyOverview
          companyId={companyId}
          companyName={companyName}
          onOpen={(tab, accountId) => {
            if (tab === 'credit' || tab === 'debit') {
              setCheckTab(null)
              setKind(tab)
              return
            }
            if (tab === 'bank' && accountId) setBankFocus({ id: accountId, n: Date.now() })
            setCheckTab(tab as CheckTab)
          }}
        />
      )}
      <div style={{ display: checkTab === 'sales' ? 'contents' : 'none' }}>
        <TallySalesCheck companyName={companyName} companyId={companyId} accounts={accounts} groupNames={groupNames} onChanged={onChanged} onOpenVoucher={onOpenVoucher} />
      </div>
      {(['purchase', 'journal'] as const).map(
        (k) =>
          opened.has(k) && (
            <div key={k} style={{ display: checkTab === k ? 'contents' : 'none' }}>
              <TallyRegisterCheck
                kind={k}
                companyName={companyName}
                companyId={companyId}
                accounts={accounts}
                groupNames={groupNames}
                onChanged={onChanged}
                onOpenVoucher={onOpenVoucher ? (id, orderId) => onOpenVoucher(id, undefined, orderId) : undefined}
              />
            </div>
          )
      )}
      {opened.has('bank') && (
        <div style={{ display: checkTab === 'bank' ? 'contents' : 'none' }}>
          <TallyBankCheck
            focusBank={bankFocus}
            companyName={companyName}
            companyId={companyId}
            accounts={accounts}
            groupNames={groupNames}
            onChanged={onChanged}
            onOpenVoucher={onOpenVoucher ? (id) => onOpenVoucher(id) : undefined}
          />
        </div>
      )}
      {!salesTab && (
      <>

      {/* 1 · upload */}
      <section className={`${card} shrink-0`}>
        <h3 className={head}>
          {num(1)} Upload the {KINDS.find((t) => t.k === kind)?.sub}
        </h3>
        <div className="flex flex-wrap items-center gap-4 p-4">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              choose(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={st.busy}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              choose(e.dataTransfer.files?.[0])
            }}
            className="flex min-h-[74px] min-w-[300px] flex-1 items-center gap-3 rounded-[6px] border-2 border-dashed border-[#BFD3C2] bg-[#FBFCFA] px-4 text-left hover:bg-[#F4FBF6]"
          >
            <Upload className="h-6 w-6 shrink-0 text-[#0B6B45]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-extrabold text-[#0A1F17]">
                {st.busy ? 'Reading…' : st.fileName ? st.fileName : `Choose or drop the Tally ${kind} note register (.xlsx)`}
              </span>
              <span className="block text-[11.5px] font-semibold text-[#5A6B62]">
                Tally → Display → Account Books → {kind === 'credit' ? 'Credit' : 'Debit'} Note Register → Columnar → Export as Excel
              </span>
            </span>
          </button>
          {pv && (
            <div className="grid gap-1 text-[12px] font-semibold text-[#33473E]">
              <span>
                <b>{String(pv.file_company || '—')}</b> · {String(pv.period || '')}
              </span>
              <span>
                {notes.length} notes · {ledgers.length} Tally names
              </span>
              <button type="button" onClick={() => void refresh()} className="flex items-center gap-1 text-[11.5px] font-extrabold text-[#0B6B45]">
                <RefreshCw className="h-3.5 w-3.5" /> Check again
              </button>
              {st.savedAt ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    title="Kept on the server until you press Process — leave, reload or come back later and it is all still here"
                    style={chip('#1B4E82', '#EAF0FA', '#C6DAF0')}
                  >
                    Draft saved · {draftTime(st.savedAt)}
                  </span>
                  <button type="button" onClick={() => void discard()} className="text-[11px] font-extrabold text-[#B3261E] hover:underline">
                    Discard draft
                  </button>
                </span>
              ) : (
                st.result && <span style={chip('#0B6B45', '#E9F5EE', '#BFE3CB')}>Processed</span>
              )}
            </div>
          )}
        </div>
        {pv?.company_mismatch && (
          <div className="flex items-start gap-2 border-t border-[#F1D9A6] bg-[#FFF8E9] px-4 py-2.5 text-[12px] font-bold text-[#8A5300]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This file is from {String(pv.file_company)}, but you are in {String(pv.company)}. Switch company (F3) if it belongs to the other books.
          </div>
        )}
      </section>

      {pv && (
        <>
          {/* 2 · map */}
          <section className={`${card} shrink-0`}>
            <h3 className={head}>
              {num(2)} Map Tally ledgers to these books
              <span
                className="ml-auto rounded-[3px] px-2 py-1 text-[11px] font-bold normal-case tracking-normal"
                style={unmapped.length ? { background: '#FFF4DD', color: '#8A5300' } : { background: '#E9F5EE', color: '#0B6B45' }}
              >
                {unmapped.length ? `${unmapped.length} to map` : 'All mapped'}
              </span>
              <label className="flex items-center gap-1.5 text-[11px] font-bold normal-case tracking-normal text-[#33473E]">
                <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} /> Only unmapped
              </label>
            </h3>
            <div className="divide-y divide-[#EEF3ED]">
              {shownLedgers.length === 0 && <div className="px-4 py-4 text-[12.5px] font-semibold text-[#5A6B62]">Every name in this file is mapped.</div>}
              {shownLedgers.map((l) => {
                const mapped = !!l.account_id
                const isCreating = creating?.key === l.key
                return (
                  <div key={String(l.key)} className="grid items-center gap-3 px-4 py-2.5" style={{ gridTemplateColumns: 'minmax(220px,1.1fr) minmax(320px,1.6fr)' }}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-extrabold text-[#0A1F17]">{String(l.tally_name)}</span>
                        <span style={l.role === 'party' ? chip('#1B4E82', '#EAF0FA', '#C6DAF0') : chip('#5A6B62', '#EEF3EC', '#DCE7DB')}>
                          {l.role === 'party' ? 'Party' : 'Ledger'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] font-semibold text-[#5A6B62]">
                        in {l.used_in} note{l.used_in === 1 ? '' : 's'} · {formatINR(Number(l.amount) || 0)}
                      </div>
                    </div>
                    {mapped && !isCreating ? (
                      <div className="flex min-w-0 items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-[#12855A]" />
                        <span className="truncate text-[12.5px] font-bold text-[#0A1F17]">{String(l.account_name)}</span>
                        <span style={l.how === 'auto' ? chip('#0B6B45', '#E9F5EE', '#BFE3CB') : chip('#1B4E82', '#EAF0FA', '#C6DAF0')}>
                          {l.how === 'auto' ? 'Auto' : 'Mapped'}
                        </span>
                        <button type="button" onClick={() => void mapTo(l, null)} className="ml-auto text-[11px] font-extrabold text-[#5A6B62] hover:text-[#B3261E]">
                          Change
                        </button>
                      </div>
                    ) : isCreating ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={creating?.name ?? ''}
                          onChange={(e) => setCreating((c) => (c ? { ...c, name: e.target.value } : c))}
                          className="h-9 min-w-[200px] flex-1 rounded-[4px] border border-[#C3D2C6] px-2.5 text-[12.5px] font-bold uppercase"
                        />
                        <GroupCombo
                          groups={groupNames}
                          value={creating?.group ?? ''}
                          onPick={(g) => setCreating((c) => (c ? { ...c, group: g } : c))}
                          onCreated={() => onChanged()}
                        />
                        <button type="button" onClick={() => void createLedger()} className="flex h-9 items-center gap-1 rounded-[4px] bg-[#0B3D2E] px-3 text-[11.5px] font-extrabold text-[#C7F03F]">
                          <Check className="h-3.5 w-3.5" /> Create
                        </button>
                        <button type="button" onClick={() => setCreating(null)} className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-[#C3D2C6] text-[#5A6B62]">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="grid gap-1.5">
                        <div className="flex items-center gap-2">
                          <LedgerCombo
                            accounts={accounts}
                            onPick={(a) => void mapTo(l, a)}
                            onCreate={(q) =>
                              setCreating({
                                key: String(l.key),
                                name: (q.trim() || String(l.tally_name)).toUpperCase(),
                                group: String(l.suggested_group || '')
                              })
                            }
                          />
                          <button
                            type="button"
                            onClick={() => setCreating({ key: String(l.key), name: String(l.tally_name).toUpperCase(), group: String(l.suggested_group || '') })}
                            className="flex h-9 shrink-0 items-center gap-1 rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[11.5px] font-extrabold text-[#33473E] hover:bg-[#F4FBF6]"
                          >
                            <Plus className="h-3.5 w-3.5" /> New ledger
                          </button>
                        </div>
                        {(l.suggest as Row[]).length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5 text-[#8A5300]" />
                            {(l.suggest as Row[]).map((s) => (
                              <button
                                key={String(s.id)}
                                type="button"
                                title={`${String(s.group)} · ${Math.round(Number(s.score) * 100)}% alike — click to map`}
                                onClick={() => void mapTo(l, s)}
                                className="flex items-center gap-1 rounded-[3px] border border-[#F1D9A6] bg-[#FFF8E9] px-2 py-0.5 text-[11px] font-bold text-[#8A5300] hover:bg-[#FFF1D6]"
                              >
                                <Link2 className="h-3 w-3" /> {String(s.name)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* 3 · notes */}
          <section className={`${card} shrink-0`}>
            <h3 className={head}>
              {num(3)} Notes in the file
              <span className="ml-auto flex flex-wrap gap-1.5 normal-case tracking-normal">
                {Object.entries(counts)
                  .filter(([, c]) => c > 0)
                  .map(([k, c]) => (
                    <span key={k} title={STATUS[k].tip} style={chip(STATUS[k].fg, STATUS[k].bg, STATUS[k].bd)}>
                      {c} {STATUS[k].label}
                    </span>
                  ))}
              </span>
            </h3>
            <div className="overflow-x-auto">
              <div style={{ minWidth: 820 }}>
                <div
                  className="grid items-center border-b border-[#E4ECE3] bg-[#FBFCFA] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]"
                  style={{ gridTemplateColumns: '28px 96px 96px minmax(200px,1fr) 70px 130px 130px' }}
                >
                  {/* Ticks or unticks what the filters show; a note filtered
                      out keeps whatever it had. */}
                  <input
                    type="checkbox"
                    title={cf.activeCount ? 'Tick or untick the notes shown' : 'Tick or untick every note'}
                    checked={shownPickable.length > 0 && shownPickable.every((x) => st.picked.has(String(x.vch_no)))}
                    onChange={(e) => {
                      const next = new Set(st.picked)
                      for (const x of shownPickable) {
                        if (e.target.checked) next.add(String(x.vch_no))
                        else next.delete(String(x.vch_no))
                      }
                      pick(next)
                    }}
                  />
                  <span>
                    <ColumnFilter label="Date" {...cf.props('date')} />
                  </span>
                  <span>
                    <ColumnFilter label="Vch no" {...cf.props('vch')} />
                  </span>
                  <span>
                    <ColumnFilter label="Party" {...cf.props('party')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Lines" align="end" {...cf.props('lines')} />
                  </span>
                  <span className="flex justify-end">
                    <ColumnFilter label="Gross" align="end" {...cf.props('gross')} />
                  </span>
                  <span className="pl-3">
                    <ColumnFilter label="Status" align="end" {...cf.props('status')} />
                  </span>
                </div>
                {cf.activeCount > 0 && (
                  <div className="flex items-center gap-2 border-b border-[#E4ECE3] bg-[#FFF8E9] px-4 py-1.5 text-[11.5px] font-bold text-[#8A5300]">
                    {shownNotes.length} of {notes.length} notes shown
                    <button type="button" onClick={cf.clear} className="ml-auto text-[11px] font-extrabold text-[#B3261E] hover:underline">
                      Clear {cf.activeCount} column filter{cf.activeCount === 1 ? '' : 's'}
                    </button>
                  </div>
                )}
                {shownNotes.map((x) => {
                  const id = String(x.vch_no)
                  const s = STATUS[String(x.status)]
                  const can = selectable(x)
                  const on = st.picked.has(id)
                  const open = openNote === id
                  const pm = mapOf.get(String(x.party_key))
                  return (
                    <div key={id} className="border-b border-[#EFF3EE]">
                      <div
                        className="grid cursor-pointer items-center px-4 py-2 hover:bg-[#F7FAF6]"
                        style={{ gridTemplateColumns: '28px 96px 96px minmax(200px,1fr) 70px 130px 130px', background: on ? '#F3FBE2' : undefined }}
                        onClick={() => setOpenNote(open ? null : id)}
                      >
                        <span onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            disabled={!can}
                            checked={on}
                            onChange={(e) => {
                              const p = new Set(st.picked)
                              if (e.target.checked) p.add(id)
                              else p.delete(id)
                              pick(p)
                            }}
                          />
                        </span>
                        <span className="text-[12px] font-semibold tabular-nums text-[#33473E]">{formatDate(String(x.date))}</span>
                        <span className="flex items-center gap-1 text-[12px] font-bold tabular-nums">
                          <ChevronRight className="h-3.5 w-3.5 text-[#8CA396]" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
                          {id}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-extrabold text-[#0A1F17]">{String(x.party)}</span>
                          <span className="block truncate text-[11px] font-semibold" style={{ color: pm?.account_id ? '#0B6B45' : '#8A5300' }}>
                            {pm?.account_id ? `→ ${String(pm.account_name)}` : 'party not mapped yet'}
                          </span>
                        </span>
                        <span className="text-right text-[12px] font-semibold tabular-nums text-[#5A6B62]">{(x.cols as Row[]).length + 1}</span>
                        <span className="text-right text-[13px] font-bold tabular-nums text-[#0A1F17]">{formatINR(Number(x.gross) || 0)}</span>
                        <span className="pl-3">
                          <span title={x.match ? `${s.tip} — ${String(x.match.vch_no || '')} on ${formatDate(String(x.match.date))}, ${formatINR(Number(x.match.total) || 0)}` : s.tip} style={chip(s.fg, s.bg, s.bd)}>
                            {s.label}
                          </span>
                        </span>
                      </div>
                      {open && (
                        <div className="mx-4 mb-2.5 overflow-hidden rounded-[5px] border border-[#E4ECE3] bg-[#FBFCFA]">
                          {orderVoucherLines([
                            { side: partySide, name: String(x.party), mapped: pm, amt: Number(x.gross) },
                            ...(x.cols as Row[]).map((c) => ({
                              side: Number(c.amount) >= 0 ? colSide : partySide,
                              name: String(c.name),
                              mapped: mapOf.get(String(c.key)),
                              amt: Math.abs(Number(c.amount))
                            })),
                            ...(Math.abs(Number(x.round_off)) > 0.004
                              ? [{ side: Number(x.round_off) > 0 ? colSide : partySide, name: 'Round off', mapped: { account_id: 1, account_name: 'ROUND OFF A/C' }, amt: Math.abs(Number(x.round_off)) }]
                              : [])
                          ], (ln) => ({ account: ln.name, dr: ln.side === 'Dr', tax: TAX_NAME.test(ln.name), amount: ln.amt })).map((ln, i) => (
                            <div key={i} className="flex items-center gap-2.5 border-b border-[#EFF3EE] px-3 py-1.5 last:border-b-0">
                              <span className="w-6 text-[11px] font-extrabold" style={{ color: ln.side === 'Dr' ? '#1B4E82' : '#B3261E' }}>
                                {ln.side}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#0A1F17]">
                                {ln.mapped?.account_id ? String(ln.mapped.account_name) : <span className="text-[#8A5300]">{ln.name} · not mapped</span>}
                                {ln.mapped?.account_id && ln.name.toUpperCase() !== String(ln.mapped.account_name).toUpperCase() && (
                                  <span className="ml-1.5 text-[10.5px] font-semibold text-[#8CA396]">Tally: {ln.name}</span>
                                )}
                              </span>
                              <span className="text-[12px] font-bold tabular-nums">{formatINR(ln.amt)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-[#D6E2D6] bg-white px-4 py-3">
              {counts.maybe > 0 && (
                <label className="flex items-center gap-1.5 text-[12px] font-bold text-[#8A5300]">
                  <input type="checkbox" checked={st.allowMaybe} onChange={(e) => setMaybe(e.target.checked)} />
                  Create possible duplicates anyway
                </label>
              )}
              <span className="min-w-0 flex-1 text-[12px] font-semibold" style={{ color: blocking.length ? '#B3261E' : '#5A6B62' }}>
                {blocking.length
                  ? `Map before creating: ${blocking.slice(0, 4).join(', ')}${blocking.length > 4 ? ` +${blocking.length - 4} more` : ''}`
                  : st.picked.size
                    ? `${st.picked.size} note${st.picked.size === 1 ? '' : 's'} ticked · ${formatINR(pickedNotes.reduce((t, x) => t + (Number(x.gross) || 0), 0))} · posted as ${kind === 'credit' ? 'Credit' : 'Debit'} Note vouchers under their Tally numbers`
                    : 'Tick the notes to create'}
              </span>
              <button
                type="button"
                disabled={st.busy || !st.picked.size || blocking.length > 0}
                onClick={() => void post()}
                className="flex h-11 items-center gap-2 rounded-[4px] bg-[#0B3D2E] px-6 text-[12.5px] font-extrabold uppercase tracking-[.03em] text-[#C7F03F] disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                {st.busy ? 'Processing…' : `Process ${st.picked.size || ''} note${st.picked.size === 1 ? '' : 's'}`}
              </button>
            </div>
            {st.result && (
              <div className="border-t border-[#E4ECE3] bg-[#FBFCFA] px-4 py-3 text-[12px] font-semibold text-[#33473E]">
                <div className="font-extrabold text-[#0B6B45]">
                  {st.result.created.length} created{st.result.created.length ? `: ${st.result.created.map((c) => c.vch_no).join(', ')}` : ''}
                </div>
                {st.result.skipped.map((s) => (
                  <div key={s.vch_no} className="mt-1 text-[#8A5300]">
                    {s.vch_no} skipped — {s.reason}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      </>
      )}
    </div>
  )
}
