import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { COMPANY_TYPES } from '@/lib/constants'

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  {
    key: 'supplier_type',
    label: 'Supplier type',
    type: 'select',
    options: [
      { value: 'OIL', label: 'OIL' },
      { value: 'HUSK', label: 'HUSK' },
      { value: 'PACKAGING', label: 'PACKAGING' },
      { value: 'CHEMICAL', label: 'CHEMICAL' }
    ]
  },
  { key: 'company_type', label: 'Company type', type: 'select', options: COMPANY_TYPES },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  { key: 'tds_pct', label: 'TDS %', type: 'number', default: 0 },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 0 },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: false },
  { key: 'adds_interest', label: 'Adds interest on invoice', type: 'switch', default: false },
  { key: 'interest_pct', label: 'Interest %', type: 'number', default: 0 },
  { key: 'interest_days', label: 'Interest days', type: 'number', default: 0 },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  { key: 'opening_purchase_amount', label: 'Purchase bill amount (as on)', type: 'number', default: 0 },
  { key: 'opening_purchase_date', label: 'As on date', type: 'date' },
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

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'supplier_type', label: 'Type' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'credit_period_days', label: 'Credit days', align: 'right' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Suppliers(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Suppliers" subtitle="GST, TDS slab, credit period and interest rule per supplier" hint="Slab TDS is cumulative per financial year: a base % up to the threshold, then a higher % above it. 'Below slab no TDS' charges TDS only above the threshold." />
      <div className="p-8">
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
