import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { COMPANY_TYPES } from '@/lib/constants'

const baseFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  // Filled in from the Categories master below — it is what lets the gate show
  // only the customers who deal in the goods at the barrier.
  { key: 'category', label: 'Category', type: 'creatable', options: [] },
  { key: 'company_type', label: 'Company type', type: 'select', options: COMPANY_TYPES },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  { key: 'tds_pct', label: 'TDS %', type: 'number', default: 0 },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 0 },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: false },
  { key: 'adds_interest', label: 'Charges interest after credit period', type: 'switch', default: false },
  { key: 'interest_pct', label: 'Interest %', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'interest_days', label: 'Interest days', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'category', label: 'Category', type: 'select' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'credit_period_days', label: 'Credit days', align: 'right' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Customers(): React.JSX.Element {
  // A customer is a selling relationship.
  const { categories } = useCategories([], 'sales')
  const fields = baseFields.map((f) =>
    f.key === 'category' ? { ...f, options: categories.map((c) => ({ value: c, label: c })) } : f
  )
  return (
    <>
      <PageHeader title="Customers" subtitle="GST, TDS, credit period and interest terms per customer" hint="Each customer's tax and credit terms auto-fill on sales. Credit period defaults to 0 days; interest applies only to days beyond it. Category tags what the customer trades in, which is how the gate narrows its party list." />
      <div className="px-4 py-6">
        <EntityManager
          table="customers"
          title="Customer"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'customers')}
        />
      </div>
    </>
  )
}
