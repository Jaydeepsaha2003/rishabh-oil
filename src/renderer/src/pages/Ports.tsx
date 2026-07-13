import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Port name', type: 'text', required: true },
  { key: 'transit_days', label: 'Transit days', type: 'number', required: true, default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Port' },
  { key: 'transit_days', label: 'Transit days', align: 'right' },
  { key: 'active', label: 'Active', type: 'switch' }
]

export function Ports(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Ports"
        subtitle="Delivery ports / sources, each with its transit days"
        hint="Transit days are used to compute the expected delivery date when a tanker goes in transit from this port."
      />
      <div className="p-8">
        <EntityManager
          table="sources"
          title="Port"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'ports')}
        />
      </div>
    </>
  )
}
