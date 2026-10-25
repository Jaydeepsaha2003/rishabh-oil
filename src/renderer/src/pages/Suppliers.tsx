import { useEffect, useState } from 'react'
import { SubLedgersPanel } from '@/components/SubLedgersPanel'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { COMPANY_TYPES, BUSINESS_TYPES, isTradingParty } from '@/lib/constants'
import { useCompany } from '@/lib/companyContext'
import { TdsRecalcDialog } from '@/components/TdsRecalcDialog'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const baseFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  // Category comes from the Categories master, same list as everywhere else.
  { key: 'supplier_type', label: 'Category', type: 'creatable', options: [] },
  { key: 'company_type', label: 'Company type', type: 'select', options: COMPANY_TYPES },
  { key: 'business_type', label: 'Trading or Manufacturing', type: 'select', options: BUSINESS_TYPES, default: 'Manufacturing' },
  // Only meaningful for a Trading supplier that is, in real life, the same
  // party (PAN) as one of the Manufacturing suppliers already on file — the
  // TDS slab is then tracked across both rows together instead of each
  // quietly restarting the slab at zero.
  {
    // MAIN PARTY: this one is a sub-ledger of it (DIL EXIM – RAJKOT of DIL
    // EXIM). Its own ledger, GSTIN and GST rates; the main party's TDS, and the
    // TDS slab tracked across the whole family. Blank = a main party itself.
    key: 'linked_party_id',
    label: 'Main party — this is its sub-ledger',
    type: 'select',
    options: []
  },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  // Every rate that applies to this ledger — the first is the default, the rest
  // offered as quick picks on its entries; any rate can still be typed there.
  { key: 'gst_rates', label: 'GST rates that apply (e.g. 5, 18)', type: 'text' },
  // Withholding defaults, so a new party is set up the way every real one here
  // already is: 0.1% on turnover past a 50,00,000 slab for the financial year,
  // with the slab actually exempt. Left at 0/0/off, a party silently withheld
  // nothing until somebody remembered to fill all three in — and getting the
  // switch wrong is invisible until an invoice is a few thousand rupees out.
  // A sub-ledger's TDS is its main party's — locked here, copied on save.
  { key: 'tds_pct', label: 'TDS % (a sub-ledger takes its main party\'s)', type: 'number', default: 0.1, enabledWhen: (f) => !f.linked_party_id },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 5000000, enabledWhen: (f) => !f.linked_party_id },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: true, enabledWhen: (f) => !f.linked_party_id },
  { key: 'adds_interest', label: 'Adds interest on invoice', type: 'switch', default: false },
  { key: 'interest_pct', label: 'Interest %', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'interest_days', label: 'Interest days', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  { key: 'opening_purchase_amount', label: 'Purchase bill amount (as on)', type: 'number', default: 0 },
  { key: 'opening_purchase_date', label: 'As on date', type: 'date' },
  // Goods already lie at our site (consignment / MNC parties): there is no
  // tanker to send, so the purchase is booked in one step.
  { key: 'skip_tanker_stages', label: 'Direct purchase — no tanker movement', type: 'switch', default: false },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

// Tax defaults applied when a supplier type is chosen (all still editable).
// PACKAGING/CHEMICAL only set the TDS criteria; their GST is defined manually.
// tds_above_only = "No TDS below the slab" is turned on for every type.
const TYPE_DEFAULTS: Record<string, Record<string, number | boolean>> = {
  OIL: { gst_pct: 5, tds_pct: 0.1, tds_threshold: 5000000, tds_above_only: true },
  HUSK: { gst_pct: 0, tds_pct: 0.1, tds_threshold: 5000000, tds_above_only: true },
  PACKAGING: { tds_pct: 0.1, tds_threshold: 5000000, tds_above_only: true },
  CHEMICAL: { tds_pct: 0.1, tds_threshold: 5000000, tds_above_only: true }
}

// A funnel on every column, Excel-style, beside the search.
const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'Name', filterable: true },
  { key: 'supplier_type', label: 'Type', filterable: true },
  { key: 'business_type', label: 'Trading/Mfg', type: 'select', filterable: true },
  { key: 'state', label: 'State', filterable: true },
  { key: 'gst_pct', label: 'GST %', align: 'right', filterable: true },
  { key: 'tds_pct', label: 'TDS %', align: 'right', filterable: true },
  { key: 'credit_period_days', label: 'Credit days', align: 'right', filterable: true },
  { key: 'skip_tanker_stages', label: 'Direct purchase', type: 'switch', filterable: true },
  { key: 'active', label: 'Active', type: 'switch', filterable: true },
  { key: 'created_at', label: 'Created', type: 'date', filterable: true }
]

export function Suppliers(): React.JSX.Element {
  // A supplier is a buying relationship.
  const { categories } = useCategories([], 'purchase')
  // For linking a Trading supplier to its real-world Manufacturing
  // counterpart, so the TDS slab is tracked across both rows together.
  const [allSuppliers, setAllSuppliers] = useState<Row[]>([])
  // Purchase entries booked with each supplier, every company together.
  const [purchaseCounts, setPurchaseCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    window.api.data.list('suppliers').then(setAllSuppliers).catch(() => setAllSuppliers([]))
    window.api.suppliers.purchaseCounts().then(setPurchaseCounts).catch(() => setPurchaseCounts({}))
  }, [])
  // Main parties only: a sub-ledger cannot have sub-ledgers of its own.
  const manufacturingOptions = allSuppliers
    .filter((s) => !s.linked_party_id && s.active)
    .map((s) => ({ value: String(s.id), label: s.name }))
  const subCount = new Map<string, number>()
  for (const s of allSuppliers) if (s.linked_party_id) subCount.set(String(s.linked_party_id), (subCount.get(String(s.linked_party_id)) || 0) + 1)
  const nameById = new Map(allSuppliers.map((s) => [String(s.id), s.name]))

  // The purchase bill amount is the open company's own (partyOpenings.ts):
  // the label says which, and the editor reloads when the company changes.
  const { companies, companyId } = useCompany()
  const coName = String(companies.find((c) => Number(c.id) === Number(companyId))?.name || 'this company')
  // Asked after this company's purchase bill amount (or its date) changes.
  const [recalc, setRecalc] = useState<{ supplierId: number; supplierName: string; companyId: number; companyName: string } | null>(null)
  const onSaved = (id: number, saved: Row, before: Row | null): void => {
    const amt = (r: Row | null): number => Number(r?.opening_purchase_amount) || 0
    const day = (r: Row | null): string => String(r?.opening_purchase_date || '').slice(0, 10)
    if (amt(saved) === amt(before) && day(saved) === day(before)) return
    if (!before && !amt(saved)) return
    setRecalc({ supplierId: id, supplierName: String(saved.name || before?.name || ''), companyId: Number(companyId), companyName: coName })
  }
  const fields = baseFields.map((f) => {
    if (f.key === 'opening_purchase_amount') return { ...f, label: `Purchase bill amount (as on) — ${coName}` }
    if (f.key === 'opening_purchase_date') return { ...f, label: `As on date — ${coName}` }
    if (f.key === 'supplier_type') return { ...f, options: categories.map((c) => ({ value: c, label: c })) }
    if (f.key === 'linked_party_id') return { ...f, options: manufacturingOptions }
    return f
  })
  const columns = baseColumns.map((c) =>
    c.key === 'business_type'
      ? {
          ...c,
          value: (row: Row) =>
            row.linked_party_id && nameById.get(String(row.linked_party_id))
              ? `${row.business_type} · sub-ledger of ${nameById.get(String(row.linked_party_id))}`
              : subCount.get(String(row.id))
                ? `${row.business_type} · main party · ${subCount.get(String(row.id))} sub-ledger${subCount.get(String(row.id)) === 1 ? '' : 's'}`
                : String(row.business_type || ''),
          badge: (row: Row) => purchaseCounts[String(row.id)] ?? 0,
          badgeTitle: 'Purchase entries booked with this supplier (all companies)'
        }
      : c
  )
  return (
    <>
      <PageHeader title="Suppliers" subtitle="GST, TDS slab, credit period, interest rule and purchase flow per supplier" hint="Slab TDS is cumulative per financial year: a base % up to the threshold, then a higher % above it. 'Below slab no TDS' charges TDS only above the threshold. 'Direct purchase' suppliers keep their goods at our site, so no tanker is sent to them — the purchase is booked in one step against the bargain. A Trading supplier that is really the same party as one of your Manufacturing suppliers can be linked to it, so the TDS slab tracks both together instead of restarting at zero." />
      <div className="px-4 py-6">
        <EntityManager
          key={`suppliers-${companyId}`}
          table="suppliers"
          drawerWidth={860}
          renderDrawerExtra={({ editingId, form, reload }) =>
            // A main party's window lists and manages its sub-ledgers.
            editingId != null && !form.linked_party_id ? (
              <SubLedgersPanel table="suppliers" mainId={editingId} mainForm={form} readOnly={!canWrite(loadUser(), 'suppliers')} onChanged={() => { reload(); void window.api.data.list('suppliers').then(setAllSuppliers).catch(() => undefined) }} />
            ) : null
          }
          title="Supplier"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'suppliers')}
          importable
          onSaved={onSaved}
          onFieldChange={(key, value) =>
            key === 'supplier_type' ? TYPE_DEFAULTS[String(value)] : undefined
          }
        />
      </div>
      <TdsRecalcDialog ask={recalc} onClose={() => setRecalc(null)} />
    </>
  )
}
