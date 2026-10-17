import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Broker name', type: 'text', required: true },
  { key: 'contact_person', label: 'Contact person', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  // BOTH, AND NEITHER REQUIRED.
  //
  // A broker is engaged at a percentage of the value or at so many rupees a
  // tonne — both are ordinary in this trade, and a master that only knew the
  // first made the second something somebody had to convert by hand against a
  // value not yet agreed. Fill in whichever was shaken hands on; fill in both
  // where the deal is partly each way.
  { key: 'brokerage_pct', label: 'Brokerage %', type: 'number', default: 0 },
  { key: 'brokerage_rate', label: 'Brokerage ₹ / MT', type: 'number', default: 0 },
  { key: 'address', label: 'Address', type: 'text' },
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Broker' },
  { key: 'contact_person', label: 'Contact' },
  { key: 'phone', label: 'Phone' },
  { key: 'brokerage_pct', label: 'Brokerage %', align: 'right' },
  { key: 'brokerage_rate', label: '₹ / MT', align: 'right' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Brokers(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Brokers"
        subtitle="Brokers with their contact details and brokerage"
        hint="Master list of brokers. Record the brokerage as a percentage of the value, as rupees a tonne, or both where the deal is partly each way — whichever was agreed. These are the broker's defaults and can be referenced across deals."
      />
      <div className="px-4 py-6">
        <EntityManager
          table="brokers"
          title="Broker"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'brokers')}
        />
      </div>
    </>
  )
}
