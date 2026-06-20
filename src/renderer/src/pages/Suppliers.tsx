import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'company_type', label: 'Company type', type: 'text', placeholder: 'Pvt Ltd / Partnership' },
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
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'credit_period_days', label: 'Credit days', align: 'right' },
  { key: 'adds_interest', label: 'Interest?', type: 'switch' }
]

export function Suppliers(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Suppliers" subtitle="GST, TDS slab, credit period and interest rule per supplier" />
      <div className="p-8">
        <EntityManager
          table="suppliers"
          title="Supplier"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'suppliers')}
        />
      </div>
    </>
  )
}
