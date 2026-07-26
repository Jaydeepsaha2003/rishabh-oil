import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, BookOpen, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DatePicker } from '@/components/ui/date-picker'
import { PageHeader } from '@/components/PageHeader'
import { ExcelButton } from '@/components/ExcelButton'
import { formatDate, formatINR, todayISO } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLiveRefresh } from '@/lib/useLiveRefresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const VCH_TYPES = ['JOURNAL', 'DEBIT NOTE', 'CREDIT NOTE', 'PAYMENT', 'RECEIPT', 'CONTRA', 'OPENING BALANCE']

// Which source page a voucher line drills through to (its originating document).
function lineTarget(l: Row): 'orders' | 'sales' | 'payments' | null {
  if (l.order_id != null) return 'orders'
  if (l.sale_id != null) return 'sales'
  if (l.payment_id != null) return 'payments'
  return null
}

interface Props {
  onOpenRecord?: (page: 'orders' | 'sales' | 'payments', id: number) => void
}

// Tally-style ledger over the double-entry journal. Purchases post
// automatically as: Dr {OIL} PUR A/C + Dr GST INPUT — Cr TDS PAYABLE + Cr Supplier.
export function Ledgers({ onOpenRecord }: Props): React.JSX.Element {
  const [accounts, setAccounts] = useState<Row[]>([])
  // Remember the open ledger so returning from a drill-through (or re-opening
  // the page) restores the last statement the user was viewing.
  const [accountId, setAccountId] = useState(() => localStorage.getItem('ledgerAccountId') || '')
  const [statement, setStatement] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Row>({})
  const [saving, setSaving] = useState(false)
  const [newAcc, setNewAcc] = useState('')

  const load = useCallback(async () => {
    setAccounts(await window.api.journal.accounts())
  }, [])
  useEffect(() => { load() }, [load])
  useLiveRefresh(load)

  const loadStatement = useCallback(async () => {
    if (!accountId) {
      setStatement([])
      return
    }
    setStatement(await window.api.journal.statement(Number(accountId)))
  }, [accountId])
  useEffect(() => { loadStatement() }, [loadStatement])
  useLiveRefresh(loadStatement)

  // Persist the open ledger (or clear it when back on the blank main page).
  useEffect(() => {
    if (accountId) localStorage.setItem('ledgerAccountId', accountId)
    else localStorage.removeItem('ledgerAccountId')
  }, [accountId])

  const totals = useMemo(() => {
    const dr = statement.reduce((s, l) => s + (Number(l.dr) || 0), 0)
    const cr = statement.reduce((s, l) => s + (Number(l.cr) || 0), 0)
    return { dr, cr, bal: dr - cr }
  }, [statement])

  const selected = accounts.find((a) => String(a.id) === accountId)
  const balText = (bal: number): string => `${formatINR(Math.abs(bal))} ${bal >= 0 ? 'Dr' : 'Cr'}`
  // Debit balance = green, credit balance = red.
  const balClass = (bal: number): string => (bal >= 0 ? 'text-emerald-600' : 'text-red-600')

  function openAdd(): void {
    setForm({
      entry_date: todayISO(),
      vch_type: 'JOURNAL',
      vch_no: '',
      dr_account: '',
      cr_account: '',
      amount: '',
      narration: ''
    })
    setOpen(true)
  }

  async function save(): Promise<void> {
    if (!form.dr_account || !form.cr_account) {
      toast.error('Pick the Dr and Cr accounts')
      return
    }
    if (!form.amount || Number(form.amount) <= 0) {
      toast.error('Enter an amount')
      return
    }
    setSaving(true)
    try {
      await window.api.journal.addEntry({ ...form, amount: Number(form.amount) })
      toast.success('Voucher posted')
      setOpen(false)
      await Promise.all([load(), loadStatement()])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function addAccount(): Promise<void> {
    const name = newAcc.trim()
    if (!name) return
    try {
      await window.api.journal.createAccount(name)
      setNewAcc('')
      toast.success(`Account "${name.toUpperCase()}" created`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function delEntry(row: Row): Promise<void> {
    if (!window.confirm('Delete this manual voucher (both sides)?')) return
    try {
      await window.api.journal.deleteEntry(Number(row.entry_id))
      toast.success('Voucher deleted')
      await Promise.all([load(), loadStatement()])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <>
      <PageHeader
        title="Ledgers"
        subtitle="Tally account ledgers — search any account and view its statement"
        hint="Every purchase posts Dr {OIL} PUR A/C + Dr GST INPUT against Cr TDS PAYABLE + Cr Supplier; payments/receipts post against the money-source account; sales post Dr Customer / Cr {FG} SALE A/C. Accounts are created automatically. Manual vouchers (Journal, Dr/Cr Note, Opening Balance) can be posted and deleted; auto entries follow their source document."
      />
      <div className="w-full p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="w-96">
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Search & select ledger (SHEA PUR A/C, GST INPUT A/C, supplier…)" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    <span className="mr-1.5 tabular-nums text-muted-foreground">{a.id}.</span>{a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4" /> Voucher entry
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Input
              className="h-9 w-56"
              placeholder="New account name…"
              value={newAcc}
              onChange={(e) => setNewAcc(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addAccount()}
            />
            <Button size="sm" variant="outline" onClick={addAccount}>Add A/C</Button>
          </div>
        </div>

        {!accountId ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 p-10 text-center">
            <BookOpen className="mb-3 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">
              {accounts.length === 0 ? 'No accounts yet' : 'Select a ledger to view its statement'}
            </p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {accounts.length === 0
                ? 'Accounts are created automatically when you book a purchase, payment or sale.'
                : 'Use the search box above to pick any account — supplier, customer, GST, purchase/sale or a manual account — and open its ledger.'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setAccountId('')}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </button>
                <div>
                  <div className="text-sm font-semibold">{selected?.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Ledger No. {selected?.id} · {selected?.acc_group} · {statement.length} vouchers
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ExcelButton
                  filename={`ledger-${(selected?.name || 'account').replace(/[^a-z0-9]+/gi, '-')}-${todayISO()}`}
                  sheetName="Ledger"
                  title={`${selected?.name || 'Ledger'} — statement`}
                  columns={[
                    { header: 'Date', key: 'entry_date', value: (r) => formatDate(r.entry_date) },
                    { header: 'Dr/Cr', key: 'drcr', align: 'center', value: (r) => (Number(r.dr) > 0 ? 'Dr' : 'Cr') },
                    { header: 'Particulars', key: 'particulars', value: (r) => r.particulars || r.narration || '' },
                    { header: 'Vch Type', key: 'vch_type', value: (r) => r.vch_type || '' },
                    { header: 'Voucher', key: 'voucher_code', value: (r) => r.voucher_code || '' },
                    { header: 'Ref No', key: 'vch_no', value: (r) => r.vch_no || '' },
                    { header: 'Debit', key: 'dr', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.dr) || 0 },
                    { header: 'Credit', key: 'cr', align: 'right', numFmt: '#,##0.00', value: (r) => Number(r.cr) || 0 }
                  ]}
                  rows={statement}
                />
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Closing balance</div>
                  <div className={cn('text-base font-bold tabular-nums', balClass(totals.bal))}>{balText(totals.bal)}</div>
                </div>
              </div>
            </div>
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 w-[52px]">S.No</TableHead>
                  <TableHead className="h-8">Date</TableHead>
                  <TableHead className="h-8">Particulars</TableHead>
                  <TableHead className="h-8">Vch Type</TableHead>
                  <TableHead className="h-8">Voucher</TableHead>
                  <TableHead className="h-8">Ref No.</TableHead>
                  <TableHead className="h-8 text-right">Debit</TableHead>
                  <TableHead className="h-8 text-right">Credit</TableHead>
                  <TableHead className="h-8 w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      No vouchers on this account yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  statement.map((l, i) => {
                    const isDr = Number(l.dr) > 0
                    const manual = l.order_id == null && l.sale_id == null && l.payment_id == null
                    const target = lineTarget(l)
                    const recordId = Number(l.order_id ?? l.sale_id ?? l.payment_id) || 0
                    const clickable = !!target && !!onOpenRecord && recordId > 0
                    return (
                      <TableRow
                        key={l.id as number}
                        className={cn(clickable && 'cursor-pointer hover:bg-muted/50')}
                        onClick={clickable ? () => onOpenRecord?.(target!, recordId) : undefined}
                        title={clickable ? 'Open the source document' : undefined}
                      >
                        <TableCell className="py-1.5 tabular-nums text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="whitespace-nowrap py-1.5">{formatDate(l.entry_date)}</TableCell>
                        <TableCell className="py-1.5">
                          <span className="mr-1.5 font-semibold text-muted-foreground">{isDr ? 'Dr' : 'Cr'}</span>
                          {l.particulars || l.narration || '—'}
                        </TableCell>
                        <TableCell className="py-1.5">{l.vch_type}</TableCell>
                        <TableCell className="whitespace-nowrap py-1.5 font-medium tabular-nums">{l.voucher_code || '—'}</TableCell>
                        <TableCell className="py-1.5 text-muted-foreground">{l.vch_no || '—'}</TableCell>
                        <TableCell className="py-1.5 text-right tabular-nums">{isDr ? formatINR(l.dr) : ''}</TableCell>
                        <TableCell className="py-1.5 text-right tabular-nums">{!isDr ? formatINR(l.cr) : ''}</TableCell>
                        <TableCell className="py-1.5 text-right">
                          {manual && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive"
                              onClick={(e) => { e.stopPropagation(); delEntry(l) }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
            {statement.length > 0 && (
              <div className="flex items-center justify-end gap-6 border-t bg-muted/30 px-4 py-2 text-xs">
                <span className="text-muted-foreground">
                  Total Dr <span className="font-semibold tabular-nums text-foreground">{formatINR(totals.dr)}</span>
                </span>
                <span className="text-muted-foreground">
                  Total Cr <span className="font-semibold tabular-nums text-foreground">{formatINR(totals.cr)}</span>
                </span>
                <span className="font-semibold">Closing <span className={cn('tabular-nums', balClass(totals.bal))}>{balText(totals.bal)}</span></span>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Voucher entry</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label>Date</Label>
                <DatePicker value={form.entry_date} onChange={(v) => setForm((p) => ({ ...p, entry_date: v }))} />
              </div>
              <div className="grid gap-1.5">
                <Label>Vch type</Label>
                <Select value={form.vch_type} onValueChange={(v) => setForm((p) => ({ ...p, vch_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VCH_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Vch no</Label>
                <Input value={form.vch_no ?? ''} onChange={(e) => setForm((p) => ({ ...p, vch_no: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Dr account *</Label>
                <Select value={form.dr_account ?? ''} onValueChange={(v) => setForm((p) => ({ ...p, dr_account: v }))}>
                  <SelectTrigger><SelectValue placeholder="Debit account" /></SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => <SelectItem key={a.id} value={String(a.name)}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Cr account *</Label>
                <Select value={form.cr_account ?? ''} onValueChange={(v) => setForm((p) => ({ ...p, cr_account: v }))}>
                  <SelectTrigger><SelectValue placeholder="Credit account" /></SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => <SelectItem key={a.id} value={String(a.name)}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Amount *</Label>
                <Input type="number" value={form.amount ?? ''} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label>Narration</Label>
                <Input value={form.narration ?? ''} onChange={(e) => setForm((p) => ({ ...p, narration: e.target.value }))} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Need a new account? Create it with "Add A/C" above, then pick it here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Posting…' : 'Post voucher'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
