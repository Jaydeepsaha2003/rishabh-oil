// WHAT A PARTY ALREADY HELD WITH US ON DAY ONE.
// -----------------------------------------------------------------------------
// An opening is PARCELS, not a number. What a party holds with us on the first
// day is L-2451 at KANDLA and L-2779 at MUNDRA, and a withdrawal draws on one
// of them and not the other. Every deposit after the opening has named its lot
// and terminal since lots were added; the opening itself used to be a single
// figure, so the day the books start was the one day the parcels could not be
// told apart — and a purchase booked against it had nothing to pick.
//
// This lived inside the Stock page's MNC tab, which is where it was built and
// is not where it is looked for: somebody setting up a consignment party opens
// the Consignment page, finds "Log consignment stock" and nothing else, and
// concludes the software cannot do it. So it is a component, and both pages
// open the same one — not two copies of a form that validates money.
//
// It loads its own masters, its own lots and its own history. That is a few
// more calls than passing them in, and they happen once when a dialog opens;
// what it buys is a component either page can drop in without first arranging
// to be the Stock page.
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DatePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDate, formatNum, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A BOX YOU CAN SEE IS A BOX YOU KNOW YOU CAN TYPE IN.
//
// These were borderless and transparent, on the reasoning that the grid draws
// its own rules and a second box would double every line. It does not read
// that way: what you get is a table of pale grey text where the placeholders
// look like values somebody has already entered and greyed out, and the one
// cell with a visible edge is the one that happens to have focus. A form that
// has to be probed to find out whether it is a form is not a form.
//
// So each cell is an ordinary field in the app's own dress — white ground,
// the same border and the same 13px bold as every other input on these
// screens — and a parcel a purchase has drawn wears the disabled grey, which
// now says locked rather than merely faint.
const PLAIN_LOT_INPUT =
  'h-9 w-full min-w-0 rounded-[4px] border border-[#C3D2C6] bg-white px-2.5 text-[13px] font-bold text-[#0A1F17] outline-none transition-colors placeholder:font-medium placeholder:text-[#6F8579] focus:border-[#0B3D2E] disabled:cursor-not-allowed disabled:border-[#E4ECE3] disabled:bg-[#F4F7F3] disabled:text-[#8CA396]'

export interface OpeningParcel {
  lot_no: string
  terminal_no: string
  qty: string
  /** A purchase has already taken this parcel: it counts, and it cannot be edited. */
  drawn?: boolean
}

export function ConsignmentOpeningDialog({
  open,
  supplierId,
  productId,
  onClose,
  onSaved
}: {
  open: boolean
  /** Pre-pick a party + product, when opened from a row that names them. */
  supplierId?: unknown
  productId?: unknown
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element | null {
  const [suppliers, setSuppliers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [lots, setLots] = useState<Row[]>([])
  const [bands, setBands] = useState<Row[]>([])
  const [form, setForm] = useState<Row>({})
  const [parcels, setParcels] = useState<OpeningParcel[]>([])
  const [log, setLog] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const total = parcels.reduce((t, l) => t + (Number(l.qty) || 0), 0)

  // Every unbooked opening lot for a party + product. Normally one, but entries
  // made before opening stock became an update-in-place can leave several.
  const openingLotsFor = useCallback(
    (sid: unknown, pid: unknown): Row[] =>
      lots
        .filter(
          (l) =>
            Number(l.is_opening) === 1 &&
            l.order_id == null &&
            String(l.supplier_id) === String(sid || '') &&
            String(l.product_id) === String(pid || '')
        )
        // Newest first: the last figure entered is the one that counts.
        .sort((a, b) => Number(b.id) - Number(a.id)),
    [lots]
  )
  const existingOpenings = openingLotsFor(form.supplier_id, form.product_id)
  const existing = existingOpenings[0]
  const existingTotal = existingOpenings.reduce((s, l) => s + (Number(l.qty) || 0), 0)
  // WHICH OF THEM WILL ACTUALLY MERGE.
  //
  // Several opening rows used to mean something had gone wrong, and the form
  // said so — but that was before an opening could be parcels, and two parcels
  // are now the ordinary case rather than a mess to warn about. What still
  // merges is two rows naming the SAME lot at the SAME terminal (two blanks
  // included, which is what the old duplicates look like), so that is what is
  // counted.
  const mergeable = (() => {
    const seen = new Set<string>()
    let dupes = 0
    for (const l of existingOpenings) {
      const k = `${String(l.lot_no || '').trim().toUpperCase()}@@${String(l.terminal_no || '').trim().toUpperCase()}`
      if (seen.has(k)) dupes++
      else seen.add(k)
    }
    return dupes
  })()

  // The masters and the register the dialog reasons against, fetched when it
  // opens rather than kept warm behind it.
  useEffect(() => {
    if (!open) return
    let live = true
    void Promise.all([
      window.api.data.list('suppliers'),
      window.api.data.list('products'),
      window.api.consignment.list('stock'),
      window.api.consignment.summary()
    ])
      .then(([sup, prd, ls, sm]) => {
        if (!live) return
        // Active only, as the pickers have always offered: a retired party
        // is not somebody an opening is being struck for.
        setSuppliers(sup.filter((x) => x.active))
        setProducts(prd.filter((x) => x.active))
        setLots(ls)
        setBands(sm)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [open])

  // THE FORM IS SEEDED ONCE PER OPENING, not on every render: typing a party
  // must not be undone by the effect that put the first one there.
  useEffect(() => {
    if (!open) return
    setError(null)
    setForm({
      supplier_id: supplierId ? String(supplierId) : '',
      product_id: productId ? String(productId) : '',
      uom: 'MT',
      deposit_date: todayISO(),
      note: ''
    })
    // One row to start with, so the form is never empty; replaced the moment
    // the parcels come back.
    setParcels([{ lot_no: '', terminal_no: '', qty: '' }])
  }, [open, supplierId, productId])

  // THE PARCELS ON FILE FOR WHOEVER IS CHOSEN.
  //
  // Re-read whenever the pair changes, not only when the dialog opens: the
  // party and the product are pickers inside this form, and an opening entered
  // against the wrong one is exactly the mistake somebody comes here to fix.
  const sid = form.supplier_id
  const pid = form.product_id
  useEffect(() => {
    if (!open || !sid || !pid) return
    let live = true
    const found = openingLotsFor(sid, pid)[0]
    void window.api.consignment
      .openingLots(Number(sid), Number(pid))
      .then((ls) => {
        if (!live) return
        setParcels(
          ls.length
            ? ls.map((l) => ({
                lot_no: String(l.lot_no || ''),
                terminal_no: String(l.terminal_no || ''),
                qty: String(l.qty ?? ''),
                drawn: l.order_id != null
              }))
            : [{ lot_no: '', terminal_no: '', qty: String(found?.qty ?? '') }]
        )
        setForm((p) => ({
          ...p,
          uom: String(found?.uom || p.uom || 'MT'),
          deposit_date: String(found?.deposit_date || p.deposit_date || todayISO()).slice(0, 10),
          note: found?.note ?? p.note ?? ''
        }))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // openingLotsFor changes with `lots`, which arrives once per opening.
  }, [open, sid, pid, openingLotsFor])

  // The restatement trail for the pair in the dialog — every set, restate and
  // delete of this opening, so a mistake can be put back.
  useEffect(() => {
    if (!open || !sid || !pid) {
      setLog([])
      return
    }
    let live = true
    window.api.consignment
      .openingLog(Number(sid), Number(pid))
      .then((r) => {
        if (live) setLog(r)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [open, sid, pid])

  // The band's live numbers for the pair in the dialog — shown before changing.
  const band = bands.find(
    (r) => String(r.supplier_id) === String(form.supplier_id) && String(r.product_id) === String(form.product_id)
  )
  const drawn = band ? (Number(band.deposited) || 0) - (Number(band.balance) || 0) : 0
  const floor = band ? Math.max(0, drawn - ((Number(band.deposited) || 0) - existingTotal)) : 0

  async function save(): Promise<void> {
    if (!form.supplier_id) return setError('Choose the MNC / party')
    if (!form.product_id) return setError('Choose the product')
    const lines = parcels
      .filter((l) => (Number(l.qty) || 0) > 0)
      .map((l) => ({ lot_no: l.lot_no.trim(), terminal_no: l.terminal_no.trim(), qty: Number(l.qty) }))
    if (!lines.length) return setError('Enter at least one parcel with a quantity')
    // Two parcels that name the same lot at the same terminal are one parcel,
    // and the server merges them — but a form that lets the same pair be typed
    // twice is a form that invites a typo, so it is refused here where it can
    // still be pointed at.
    const seen = new Set<string>()
    for (const l of lines) {
      const k = `${l.lot_no.toUpperCase()}@@${l.terminal_no.toUpperCase()}`
      if (seen.has(k)) {
        return setError(
          `${l.lot_no || 'The unlabelled parcel'}${l.terminal_no ? ` at ${l.terminal_no}` : ''} is entered twice — put it on one row`
        )
      }
      seen.add(k)
    }
    setSaving(true)
    setError(null)
    try {
      // One validated main-process step: logs the old figure, matches each
      // parcel by lot + terminal so a drawn one keeps its row, refuses figures
      // below what is already drawn, and refuses future dates.
      await window.api.consignment.saveOpening({
        supplier_id: Number(form.supplier_id),
        product_id: Number(form.product_id),
        lines,
        uom: form.uom || 'MT',
        deposit_date: form.deposit_date,
        note: form.note ? String(form.note).trim() : 'Opening stock'
      })
      toast.success(
        `Opening stock set to ${formatNum(total)} ${form.uom || 'MT'}` +
          (lines.length > 1 ? ` across ${lines.length} parcels` : '')
      )
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? 'Update opening stock' : 'Add opening stock'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>MNC / party *</Label>
              <Select
                value={String(form.supplier_id || '')}
                onValueChange={(v) => setForm((p) => ({ ...p, supplier_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select the party" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((x) => (
                    <SelectItem key={x.id} value={String(x.id)}>
                      {x.name}
                      {x.skip_tanker_stages ? ' · direct' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Product *</Label>
              <Select
                value={String(form.product_id || '')}
                onValueChange={(v) => setForm((p) => ({ ...p, product_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select the product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((x) => (
                    <SelectItem key={x.id} value={String(x.id)}>
                      {x.code || x.name}
                      {x.category ? ` · ${x.category}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!!form.supplier_id && !!form.product_id && (
              <div className="sm:col-span-2">
                <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-2.5 sm:grid-cols-4">
                  {[
                    {
                      l: 'Current opening',
                      v: existing ? `${formatNum(existingTotal)} ${existing.uom}` : '—',
                      tone: 'text-violet-900'
                    },
                    { l: 'Deposited (all lots)', v: band ? formatNum(band.deposited) : '—', tone: 'text-emerald-700' },
                    { l: 'Already drawn', v: band ? formatNum(drawn) : '—', tone: 'text-rose-700' },
                    { l: 'Minimum allowed', v: `${formatNum(floor)} ${form.uom || 'MT'}`, tone: 'text-amber-700' }
                  ].map((x) => (
                    <div key={x.l}>
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{x.l}</div>
                      <div className={cn('text-[13px] font-semibold tabular-nums', x.tone)}>{x.v}</div>
                    </div>
                  ))}
                </div>
                {mergeable > 0 && (
                  <p className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                    {mergeable + 1} opening entries name the same lot and terminal — saving merges them into one
                    parcel.
                  </p>
                )}
                {!existing && log.length > 0 && (
                  <p className="mt-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800">
                    The opening here was removed — its last figure was{' '}
                    <b>
                      {formatNum(log[0].old_qty ?? log[0].new_qty)} {log[0].uom || 'MT'}
                    </b>
                    . Use Restore below to bring it back.
                  </p>
                )}
              </div>
            )}
            {/* THE PARCELS. One row per lot at a terminal — which is what a
                withdrawal will be picked by, so it has to be stated here or the
                choice does not exist later. A single unlabelled row is still
                perfectly valid: that is what every opening already on file
                looks like. */}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <div className="flex items-center justify-between">
                <Label>Opening parcels *</Label>
                <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">
                  {formatNum(total)} {form.uom || 'MT'} over {parcels.length}{' '}
                  {parcels.length === 1 ? 'parcel' : 'parcels'}
                </span>
              </div>
              <div className="overflow-hidden rounded-lg border">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] gap-2 bg-[#F7FAF6] px-2.5 py-2 text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62] sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_116px_36px]">
                  <span>Lot no</span>
                  <span>Terminal</span>
                  {/* On a phone the quantity drops to its own line, so its
                      heading would sit over the wrong column. */}
                  <span className="hidden text-right sm:block">Quantity</span>
                  <span />
                </div>
                {parcels.map((l, i) => (
                  <div
                    key={i}
                    /* THREE FIELDS ON A LINE IS TWO TOO MANY ON A PHONE.
                       At 375px a fixed quantity column leaves the lot and the
                       terminal about sixty pixels each, which clips KANDLA to
                       KANDI — boxes you can see but not read. So the quantity
                       takes the second line there, full width, and the three
                       go back on one line from sm up. */
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] items-center gap-x-2 gap-y-1.5 border-t border-t-[#EFF3EE] px-2.5 py-2 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_116px_36px]"
                  >
                    <input
                      className={cn(PLAIN_LOT_INPUT, 'col-start-1 row-start-1')}
                      value={l.lot_no}
                      disabled={!!l.drawn}
                      placeholder="e.g. L-2451"
                      onChange={(e) =>
                        setParcels((p) =>
                          p.map((x, j) => (j === i ? { ...x, lot_no: e.target.value.toUpperCase() } : x))
                        )
                      }
                    />
                    <input
                      className={cn(PLAIN_LOT_INPUT, 'col-start-2 row-start-1')}
                      value={l.terminal_no}
                      disabled={!!l.drawn}
                      placeholder="e.g. KANDLA"
                      onChange={(e) =>
                        setParcels((p) =>
                          p.map((x, j) => (j === i ? { ...x, terminal_no: e.target.value.toUpperCase() } : x))
                        )
                      }
                    />
                    <input
                      type="number"
                      className={cn(
                        PLAIN_LOT_INPUT,
                        'col-span-2 col-start-1 row-start-2 text-right tabular-nums sm:col-span-1 sm:col-start-3 sm:row-start-1'
                      )}
                      value={l.qty}
                      disabled={!!l.drawn}
                      placeholder="0.000"
                      onChange={(e) =>
                        setParcels((p) => p.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
                      }
                    />
                    <div className="col-start-3 row-start-2 flex items-center justify-center sm:col-start-4 sm:row-start-1">
                      {l.drawn ? (
                        <span
                          className="text-center text-[9px] font-bold uppercase leading-tight text-amber-700"
                          title="A purchase has already drawn this parcel — it cannot be changed from here"
                        >
                          Drawn
                        </span>
                      ) : (
                        <button
                          type="button"
                          title="Remove this parcel"
                          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-red-600"
                          onClick={() => setParcels((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 border-t px-3 py-2 text-[11.5px] font-semibold text-indigo-700 hover:bg-muted/30"
                  onClick={() => setParcels((p) => [...p, { lot_no: '', terminal_no: '', qty: '' }])}
                >
                  <Plus className="h-3.5 w-3.5" /> Add another parcel
                </button>
              </div>
              <span className="text-[10.5px] leading-snug text-muted-foreground">
                Lot and terminal are optional — leave them blank for an opening nobody split into parcels. Where they
                are given, a purchase can be booked against one parcel and not the rest.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>UOM</Label>
              <Select value={String(form.uom || 'MT')} onValueChange={(v) => setForm((p) => ({ ...p, uom: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MT">MT</SelectItem>
                  <SelectItem value="KG">KG</SelectItem>
                  <SelectItem value="L">L</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>As on date</Label>
              <DatePicker
                value={String(form.deposit_date || '')}
                onChange={(v) => setForm((p) => ({ ...p, deposit_date: v }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Note</Label>
              <Input
                value={form.note ?? ''}
                placeholder="Opening stock"
                onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              />
            </div>
          </div>
          {!!form.supplier_id && !!form.product_id && log.length > 0 && (
            <div className="rounded-lg border">
              <div className="border-b bg-muted/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Restatement history — every change is kept
              </div>
              <div className="max-h-36 overflow-auto">
                {log.map((h) => (
                  <div
                    key={String(h.id)}
                    className="flex items-center gap-2 border-b border-dotted px-3 py-1.5 text-[12px] last:border-0"
                  >
                    <span className="w-32 shrink-0 tabular-nums text-muted-foreground">
                      {formatDate(String(h.changed_at).slice(0, 10))}
                    </span>
                    <span
                      className={cn(
                        'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase',
                        h.action === 'delete'
                          ? 'bg-red-100 text-red-700'
                          : h.action === 'create'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-sky-100 text-sky-700'
                      )}
                    >
                      {h.action === 'delete' ? 'Removed' : h.action === 'create' ? 'Created' : 'Restated'}
                    </span>
                    <span className="min-w-0 flex-1 truncate tabular-nums">
                      {h.old_qty != null ? `${formatNum(h.old_qty)} → ` : ''}
                      {h.new_qty != null ? `${formatNum(h.new_qty)} ${h.uom || 'MT'}` : 'removed'}
                    </span>
                    {(h.old_qty != null || h.new_qty != null) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-1.5 text-[11px] text-indigo-700"
                        title="Fill this figure into the form — Save applies it with full validation"
                        onClick={() => {
                          const back = h.action === 'delete' || h.new_qty == null ? h.old_qty : (h.old_qty ?? h.new_qty)
                          // Restored onto the PARCELS, which is what is saved.
                          // Writing it to a qty field the form no longer has is
                          // what made Restore look like it did nothing.
                          setParcels([{ lot_no: '', terminal_no: '', qty: String(back ?? '') }])
                          setForm((prev) => ({
                            ...prev,
                            uom: String(h.uom || prev.uom || 'MT'),
                            deposit_date: String(h.deposit_date || prev.deposit_date || todayISO()).slice(0, 10)
                          }))
                        }}
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : existing ? 'Update opening stock' : 'Add opening stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
