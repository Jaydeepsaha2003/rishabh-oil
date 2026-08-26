import { PageHeader } from '@/components/PageHeader'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A packaging SKU: N units per case, each unit a given size (e.g. DALDA JAR
// 4.2 KG × 4). Stock is drawn in the base unit (KG or L); base_per_pouch and
// base_uom are derived from the natural unit size.
const baseFields: FieldDef[] = [
  { key: 'name', label: 'SKU name', type: 'text', required: true, placeholder: 'e.g. DALDA JAR 4.2 KG × 4' },
  {
    key: 'pouch_label',
    label: 'Pack type',
    type: 'select',
    default: 'Jar',
    options: [
      { value: 'Jar', label: 'Jar' },
      { value: 'Pouch', label: 'Pouch' },
      { value: 'Pch', label: 'Pch' },
      { value: 'Tin', label: 'Tin' },
      { value: 'Bottle', label: 'Bottle' },
      { value: 'Box', label: 'Box' }
    ]
  },
  { key: 'unit_size', label: 'Unit size', type: 'number', required: true, default: 0, placeholder: 'e.g. 4.2 / 420 / 200' },
  {
    key: 'unit_uom',
    label: 'Unit UOM',
    type: 'select',
    default: 'KG',
    options: [
      { value: 'KG', label: 'KG' },
      { value: 'GM', label: 'GM' },
      { value: 'L', label: 'L' },
      { value: 'ML', label: 'ML' }
    ]
  },
  { key: 'pouches_per_box', label: 'Units per case (×)', type: 'number', required: true, default: 1 },
  { key: 'box_label', label: 'Case label', type: 'text', default: 'Case' },
  // Derived for stock conversion — auto-filled from unit size/UOM, editable.
  { key: 'base_per_pouch', label: 'Base qty / unit (auto)', type: 'number', default: 0 },
  { key: 'base_uom', label: 'Base unit (auto)', type: 'text', default: 'KG' },
  // Which finished product this SKU packs (DALDA 15 KG TIN → DALDA), so packed
  // pieces reconcile in tonnage against that product's stock. Options are
  // filled in from the product master below.
  { key: 'product_id', label: 'Product', type: 'select', options: [] },
  // Not one of the finished products? Type the short product name instead.
  // Only one of the two applies, so this is off once a product is linked.
  {
    key: 'product_label',
    label: 'Or type a short product name',
    type: 'text',
    placeholder: 'e.g. SWAD',
    enabledWhen: (f) => !f.product_id
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'SKU' },
  { key: 'product_id', label: 'Product' },
  { key: 'pouch_label', label: 'Type' },
  { key: 'unit_size', label: 'Unit size', align: 'right' },
  { key: 'unit_uom', label: 'UOM' },
  { key: 'pouches_per_box', label: 'Per case', align: 'right' },
  { key: 'base_uom', label: 'Base', align: 'right' },
  { key: 'active', label: 'Active', type: 'switch' }
]

// Convert the entered unit size to the base unit used for stock (KG or L).
function deriveBase(form: Row): Row {
  const u = String(form.unit_uom || 'KG').toUpperCase()
  const size = Number(form.unit_size) || 0
  const baseUom = u === 'ML' || u === 'L' ? 'L' : 'KG'
  const perPouch = u === 'GM' || u === 'ML' ? size / 1000 : size
  return { base_per_pouch: Math.round(perPouch * 1e6) / 1e6, base_uom: baseUom }
}

export function Packaging(): React.JSX.Element {
  // Link the customers who buy each SKU — the sales-bargain rate card narrows
  // to the bargain party's SKUs when links exist.
  const [linkRow, setLinkRow] = useState<Row | null>(null)
  const [customers, setCustomers] = useState<Row[]>([])
  const [products, setProducts] = useState<Row[]>([])
  const [sel, setSel] = useState<number[]>([])
  const [custSearch, setCustSearch] = useState('')
  const [savingLinks, setSavingLinks] = useState(false)

  useEffect(() => {
    window.api.data.list('customers').then(setCustomers).catch(() => {})
    window.api.data.list('products').then(setProducts).catch(() => {})
  }, [])

  // A packed SKU packs a finished good — offer those, plus intermediates,
  // which is the same pair Production treats as an output.
  const productOptions = products
    .filter((p) => p.category === 'finished' || p.category === 'intermediate')
    .map((p) => ({ value: String(p.id), label: String(p.name) }))
  const fields = baseFields.map((f) => (f.key === 'product_id' ? { ...f, options: productOptions } : f))
  // One Product column for both ways of naming it: the linked finished
  // product, or the short name typed when it isn't one of them.
  const columns = baseColumns.map((c) =>
    c.key === 'product_id'
      ? {
          ...c,
          value: (row: Row) =>
            productOptions.find((o) => o.value === String(row.product_id))?.label ||
            String(row.product_label || '')
        }
      : c
  )

  // Which SKUs already have parties behind them, so the list can say so without
  // opening each one. One query, refreshed after a save.
  const [linked, setLinked] = useState<Map<number, { parties: number; names: string }>>(new Map())
  const loadLinked = useCallback(async () => {
    try {
      const rows = await window.api.skuRates.partyCounts()
      setLinked(new Map(rows.map((r) => [Number(r.packaging_id), { parties: Number(r.parties), names: String(r.names || '') }])))
    } catch {
      setLinked(new Map())
    }
  }, [])
  useEffect(() => { void loadLinked() }, [loadLinked])

  async function openLinks(row: Row): Promise<void> {
    setLinkRow(row)
    setCustSearch('')
    try {
      setSel(await window.api.skuRates.parties(Number(row.id)))
    } catch {
      setSel([])
    }
  }

  async function saveLinks(): Promise<void> {
    if (!linkRow) return
    setSavingLinks(true)
    try {
      const res = await window.api.skuRates.setParties(Number(linkRow.id), sel)
      toast.success(
        res.count
          ? `${linkRow.name} linked to ${res.count} part${res.count === 1 ? 'y' : 'ies'}`
          : `${linkRow.name} now offered to every party`
      )
      setLinkRow(null)
      await loadLinked()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingLinks(false)
    }
  }

  const shownCustomers = custSearch.trim()
    ? customers.filter((c) => String(c.name || '').toLowerCase().includes(custSearch.trim().toLowerCase()))
    : customers

  return (
    <>
      <PageHeader
        title="Packed SKU"
        subtitle="Packed-sale SKUs — N units per case, each a given size (base qty computed for stock)"
        hint="Add each SKU like ‘DALDA JAR 4.2 KG × 4’: pick the pack type, enter the unit size in its own unit (KG/GM/L/ML) and units per case. The base quantity drawn from stock is computed automatically (grams/millilitres convert to KG/L). Packed sales pick a SKU and enter cases + loose units; Stock → Packed SKU totals the on-hand pieces of every SKU into tonnage."
      />
      <div className="p-5">
        <EntityManager
          table="packagings"
          title="Packed SKU"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'packaging')}
          onFieldChange={(key, value, form) => {
            if (key === 'unit_size' || key === 'unit_uom') return deriveBase(form)
            // The two ways of naming the product are exclusive — linking one
            // drops any short name typed earlier.
            if (key === 'product_id' && value) return { product_label: '' }
            return undefined
          }}
          rowAction={{
            // The tooltip names them, so the dot is a prompt rather than a
            // riddle — a SKU with no link is offered to every party, which is a
            // different thing from being linked to none.
            title: (row) => {
              const hit = linked.get(Number(row.id))
              return hit
                ? `Linked to ${hit.parties} part${hit.parties === 1 ? 'y' : 'ies'}: ${hit.names}`
                : 'Not linked to any party — offered to every party. Click to narrow it.'
            },
            icon: Users,
            marked: (row) => (linked.get(Number(row.id))?.parties || 0) > 0,
            onClick: (row) => void openLinks(row)
          }}
        />
      </div>

      <Dialog open={!!linkRow} onOpenChange={(o) => !o && setLinkRow(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Parties for {linkRow?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Tick the customers who trade in this SKU. A sales bargain's rate card then lists only that party's
              SKUs — leave everything unticked to offer the SKU to every party.
            </p>
            <Input
              className="h-8 text-[13px]"
              placeholder="Search customer…"
              value={custSearch}
              onChange={(e) => setCustSearch(e.target.value)}
            />
            <div className="max-h-64 overflow-auto rounded-lg border">
              {shownCustomers.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">No customers found.</p>
              ) : (
                shownCustomers.map((c) => {
                  const id = Number(c.id)
                  const on = sel.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      className="flex w-full cursor-pointer items-center justify-between border-b px-3 py-1.5 text-left text-[13px] last:border-0 hover:bg-muted/50"
                      onClick={() => setSel((p) => (on ? p.filter((x) => x !== id) : [...p, id]))}
                    >
                      <span className="truncate">{c.name}</span>
                      {on && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                    </button>
                  )
                })
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{sel.length} linked</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkRow(null)}>Cancel</Button>
            <Button disabled={savingLinks} onClick={() => void saveLinks()}>
              {savingLinks ? 'Saving…' : 'Save links'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
