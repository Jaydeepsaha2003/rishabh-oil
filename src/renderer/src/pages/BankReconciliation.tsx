import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, FileSpreadsheet, RotateCcw, Sparkles, Trash2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { formatDate, formatINR } from '@/lib/format'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

const CATEGORIES = [
  { value: 'oil', label: 'Oil purchase payment' },
  { value: 'lc', label: 'LC (commission / repayment)' },
  { value: 'husk', label: 'Husk' },
  { value: 'packing', label: 'Packing material' },
  { value: 'chemical', label: 'Chemical' },
  { value: 'bill_discounting', label: 'Bill discounting' },
  { value: 'contra', label: 'Contra (bank/cash transfer)' },
  { value: 'misc', label: 'Misc (dummy / suspense)' }
]

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]))

// Categories with no structured record to link to yet — the reviewer can tag
// them for reporting, but they still park under Misc until those purchase
// types get proper tracking built.
const UNLINKABLE = new Set(['husk', 'packing', 'chemical', 'bill_discounting', 'contra'])

export function BankReconciliation(): React.JSX.Element {
  const [imports, setImports] = useState<Row[]>([])
  const [activeImportId, setActiveImportId] = useState<number | null>(null)
  const [lines, setLines] = useState<Row[]>([])
  // Empty = every status. Defaults to just Pending, same starting point as before.
  const [statusFilter, setStatusFilter] = useState<string[]>(['pending'])
  const [loading, setLoading] = useState(false)

  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadBank, setUploadBank] = useState('')
  const [uploadPath, setUploadPath] = useState('')
  const [uploading, setUploading] = useState(false)

  const [reviewLine, setReviewLine] = useState<Row | null>(null)
  const [suggestion, setSuggestion] = useState<Row | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [reviewCategory, setReviewCategory] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)

  const [subEntryLine, setSubEntryLine] = useState<Row | null>(null)
  const [subEntryConfirm, setSubEntryConfirm] = useState(false)
  const [subEntryNote, setSubEntryNote] = useState('')

  const loadImports = useCallback(async () => {
    const rows = await window.api.bankRecon.imports()
    setImports(rows)
    if (!activeImportId && rows.length) setActiveImportId(Number(rows[0].id))
  }, [activeImportId])

  const loadLines = useCallback(async () => {
    if (!activeImportId) {
      setLines([])
      return
    }
    setLoading(true)
    try {
      const filter: Row = { import_id: activeImportId }
      if (statusFilter.length) filter.status = statusFilter
      const rows = await window.api.bankRecon.list(filter)
      setLines(rows)
    } finally {
      setLoading(false)
    }
  }, [activeImportId, statusFilter])

  useEffect(() => {
    void loadImports()
  }, [loadImports])

  useEffect(() => {
    void loadLines()
  }, [loadLines])

  useLiveRefresh(loadImports)

  async function pickFile(): Promise<void> {
    const r = await window.api.files.pickDocument()
    if (r.path) setUploadPath(r.path)
  }

  async function doUpload(): Promise<void> {
    if (!uploadBank.trim()) return void toast.error('Bank is required')
    if (!uploadPath) return void toast.error('Pick a statement file first')
    setUploading(true)
    try {
      const r = await window.api.bankRecon.import({ bank: uploadBank.trim(), file_path: uploadPath })
      toast.success(`Imported ${r.count} transaction${r.count === 1 ? '' : 's'}`)
      setUploadOpen(false)
      setUploadBank('')
      setUploadPath('')
      setActiveImportId(r.id)
      await loadImports()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  async function removeImport(imp: Row): Promise<void> {
    if (!window.confirm(`Delete this import (${imp.file_name || imp.bank}) and all ${imp.line_count} of its lines?`)) return
    await window.api.bankRecon.deleteImport(Number(imp.id))
    if (activeImportId === Number(imp.id)) setActiveImportId(null)
    await loadImports()
  }

  async function openReview(line: Row): Promise<void> {
    setReviewLine(line)
    setReviewCategory(line.category || '')
    setSuggestion(null)
    setSuggestLoading(true)
    try {
      const s = await window.api.bankRecon.suggest(Number(line.id))
      setSuggestion(s)
      if (s && !line.category) setReviewCategory(s.category)
    } finally {
      setSuggestLoading(false)
    }
  }

  async function acceptSuggestion(): Promise<void> {
    if (!reviewLine || !suggestion) return
    setReviewSaving(true)
    try {
      await window.api.bankRecon.reconcile(Number(reviewLine.id), {
        category: suggestion.category,
        link_type: suggestion.link_type,
        link_ref_id: suggestion.link_ref_id
      })
      toast.success('Reconciled')
      setReviewLine(null)
      await Promise.all([loadLines(), loadImports()])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReviewSaving(false)
    }
  }

  async function saveManualCategory(): Promise<void> {
    if (!reviewLine || !reviewCategory) return void toast.error('Pick a category')
    setReviewSaving(true)
    try {
      if (reviewCategory === 'misc' || UNLINKABLE.has(reviewCategory)) {
        await window.api.bankRecon.markMisc(Number(reviewLine.id))
      } else {
        await window.api.bankRecon.reconcile(Number(reviewLine.id), { category: reviewCategory })
      }
      toast.success('Saved')
      setReviewLine(null)
      await Promise.all([loadLines(), loadImports()])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setReviewSaving(false)
    }
  }

  async function unreconcile(line: Row): Promise<void> {
    await window.api.bankRecon.unreconcile(Number(line.id))
    await Promise.all([loadLines(), loadImports()])
  }

  function openSubEntryToggle(line: Row): void {
    setSubEntryLine(line)
    setSubEntryNote(line.sub_entry_note || '')
    setSubEntryConfirm(true)
  }

  async function confirmSubEntry(): Promise<void> {
    if (!subEntryLine) return
    const enabling = !subEntryLine.sub_entry_enabled
    await window.api.bankRecon.setSubEntry(Number(subEntryLine.id), { enabled: enabling, note: subEntryNote })
    setSubEntryConfirm(false)
    setSubEntryLine(null)
    await loadLines()
  }

  const activeImport = imports.find((i) => Number(i.id) === activeImportId)

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <PageHeader
        title="Bank Reconciliation"
        subtitle="Import a bank statement and match its lines against what's already posted in the books"
        hint="Every line either links to an existing payment/LC posting already in the books (marked Reconciled — nothing new is posted) or parks under Misc when nothing recognizes it. The sub-entry toggle is just a manual party/purpose note, kept separate from the reconciliation itself."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={activeImportId ? String(activeImportId) : ''} onValueChange={(v) => setActiveImportId(Number(v))}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Select a statement import" /></SelectTrigger>
          <SelectContent>
            {imports.map((i) => (
              <SelectItem key={String(i.id)} value={String(i.id)}>
                {i.bank} — {i.file_name} ({i.line_count} lines, {i.pending_count} pending)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MultiSelectFilter
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'reconciled', label: 'Reconciled' },
            { value: 'misc', label: 'Misc' }
          ]}
          value={statusFilter}
          onApply={setStatusFilter}
          allLabel="All lines"
          className="w-40"
        />
        <Button size="sm" className="ml-auto gap-1.5" onClick={() => setUploadOpen(true)}>
          <Upload className="h-3.5 w-3.5" /> Import statement
        </Button>
        {activeImport && (
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive" onClick={() => void removeImport(activeImport)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete this import
          </Button>
        )}
      </div>

      <Card className="flex-1 overflow-auto p-0">
        {!activeImportId ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No statement imported yet — click "Import statement" to upload one.
          </div>
        ) : loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : lines.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No lines match this filter.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sub-entry</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={String(l.id)}>
                  <TableCell className="tabular-nums">{formatDate(l.txn_date)}</TableCell>
                  <TableCell className="max-w-xs truncate text-[12px]" title={l.narration}>{l.narration || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(l.debit) > 0 ? formatINR(l.debit) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{n(l.credit) > 0 ? formatINR(l.credit) : '—'}</TableCell>
                  <TableCell>{l.category ? CATEGORY_LABEL[l.category] || l.category : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    {l.status === 'reconciled' ? (
                      <Badge variant="success">Reconciled</Badge>
                    ) : l.status === 'misc' ? (
                      <Badge variant="muted">Misc</Badge>
                    ) : (
                      <Badge variant="outline">Pending</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant={l.sub_entry_enabled ? 'secondary' : 'ghost'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => openSubEntryToggle(l)}
                      title={l.sub_entry_note || ''}
                    >
                      {l.sub_entry_enabled ? 'On' : 'Off'}
                    </Button>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {l.status === 'pending' ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void openReview(l)}>
                          Review
                        </Button>
                      ) : (
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Undo reconciliation" onClick={() => void unreconcile(l)}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Import a statement */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Import a bank statement</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Bank *</Label>
              <Input value={uploadBank} onChange={(e) => setUploadBank(e.target.value)} placeholder="e.g. HDFC Bank" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Statement file (.xlsx / .csv) *</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void pickFile()}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Choose file
                </Button>
                {uploadPath ? (
                  <span className="truncate text-[11px] text-muted-foreground">{uploadPath.split(/[\\/]/).pop()}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">No file selected</span>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button disabled={uploading} onClick={() => void doUpload()}>{uploading ? 'Importing…' : 'Import'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review a single line */}
      <Dialog open={!!reviewLine} onOpenChange={(o) => !o && setReviewLine(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Review statement line</DialogTitle></DialogHeader>
          {reviewLine && (
            <div className="grid gap-3">
              <div className="rounded-md border bg-muted/30 p-3 text-[12px]">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{formatDate(reviewLine.txn_date)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-medium">{formatINR(n(reviewLine.debit) || n(reviewLine.credit))} {n(reviewLine.debit) > 0 ? '(Dr)' : '(Cr)'}</span></div>
                <div className="mt-1 text-muted-foreground">{reviewLine.narration}</div>
              </div>

              {suggestLoading ? (
                <p className="text-xs text-muted-foreground">Looking for a match…</p>
              ) : suggestion ? (
                <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-[12px]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  <div className="flex-1">
                    <div className="font-medium">Suggested match</div>
                    <div className="text-muted-foreground">{suggestion.label}</div>
                  </div>
                  <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" disabled={reviewSaving} onClick={() => void acceptSuggestion()}>
                    <Check className="h-3 w-3" /> Confirm
                  </Button>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[12px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Nothing already posted matches this line — pick a category below, or leave it as Misc.
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label>Or set the category manually</Label>
                <Select value={reviewCategory} onValueChange={setReviewCategory}>
                  <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {reviewCategory && UNLINKABLE.has(reviewCategory) && (
                  <p className="text-[11px] text-muted-foreground">
                    {CATEGORY_LABEL[reviewCategory]} isn't tracked as its own record yet — this will park under Misc, tagged for later.
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewLine(null)}>Cancel</Button>
            <Button disabled={reviewSaving || !reviewCategory} onClick={() => void saveManualCategory()}>
              {reviewSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sub-entry toggle confirmation — deliberately gated so an accidental
          click can't silently flip or wipe a recorded note. */}
      <Dialog open={subEntryConfirm} onOpenChange={setSubEntryConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{subEntryLine?.sub_entry_enabled ? 'Turn off sub-entry?' : 'Turn on sub-entry?'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              {subEntryLine?.sub_entry_enabled
                ? 'This will clear the manual note recorded against this line.'
                : 'This just records a manual party/purpose note against this line — it does not change its reconciliation.'}
            </p>
            {!subEntryLine?.sub_entry_enabled && (
              <div className="flex flex-col gap-1.5">
                <Label>Note</Label>
                <Input value={subEntryNote} onChange={(e) => setSubEntryNote(e.target.value)} placeholder="Who it was really for / what it was really for" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubEntryConfirm(false)}>Cancel</Button>
            <Button onClick={() => void confirmSubEntry()}>{subEntryLine?.sub_entry_enabled ? 'Turn off' : 'Turn on'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
