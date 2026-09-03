import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { COMPANY_TYPES, BUSINESS_TYPES, isTradingParty } from '@/lib/constants'

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
    key: 'linked_party_id',
    label: 'Same party as (Manufacturing) — for TDS slab',
    type: 'select',
    options: [],
    enabledWhen: (f) => isTradingParty(f)
  },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  // Withholding defaults, so a new party is set up the way every real one here
  // already is: 0.1% on turnover past a 50,00,000 slab for the financial year,
  // with the slab actually exempt. Left at 0/0/off, a party silently withheld
  // nothing until somebody remembered to fill all three in — and getting the
  // switch wrong is invisible until an invoice is a few thousand rupees out.
  { key: 'tds_pct', label: 'TDS %', type: 'number', default: 0.1 },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 5000000 },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: true },
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

const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'supplier_type', label: 'Type' },
  { key: 'business_type', label: 'Trading/Mfg' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'credit_period_days', label: 'Credit days', align: 'right' },
  { key: 'skip_tanker_stages', label: 'Direct purchase', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Suppliers(): React.JSX.Element {
  // A supplier is a buying relationship.
  const { categories } = useCategories([], 'purchase')
  // For linking a Trading supplier to its real-world Manufacturing
  // counterpart, so the TDS slab is tracked across both rows together.
  const [allSuppliers, setAllSuppliers] = useState<Row[]>([])
  useEffect(() => {
    window.api.data.list('suppliers').then(setAllSuppliers).catch(() => setAllSuppliers([]))
  }, [])
  const manufacturingOptions = allSuppliers
    .filter((s) => !isTradingParty(s) && s.active)
    .map((s) => ({ value: String(s.id), label: s.name }))
  const nameById = new Map(allSuppliers.map((s) => [String(s.id), s.name]))

  const fields = baseFields.map((f) => {
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
              ? `${row.business_type} · same as ${nameById.get(String(row.linked_party_id))}`
              : String(row.business_type || '')
        }
      : c
  )
  return (
    <>
      <PageHeader title="Suppliers" subtitle="GST, TDS slab, credit period, interest rule and purchase flow per supplier" hint="Slab TDS is cumulative per financial year: a base % up to the threshold, then a higher % above it. 'Below slab no TDS' charges TDS only above the threshold. 'Direct purchase' suppliers keep their goods at our site, so no tanker is sent to them — the purchase is booked in one step against the bargain. A Trading supplier that is really the same party as one of your Manufacturing suppliers can be linked to it, so the TDS slab tracks both together instead of restarting at zero." />
      <div className="px-4 py-6">
        <EntityManager
          table="suppliers"
          title="Supplier"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'suppliers')}
          onFieldChange={(key, value) =>
            key === 'supplier_type' ? TYPE_DEFAULTS[String(value)] : undefined
          }
        />
      </div>
    </>
  )
}
