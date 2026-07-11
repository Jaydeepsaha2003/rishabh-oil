import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { COMPANY_TYPES } from '@/lib/constants'

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'company_type', label: 'Company type', type: 'select', required: true, options: COMPANY_TYPES },
  { key: 'contact', label: 'Contact', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', required: true, default: 0 },
  { key: 'tds_pct', label: 'TDS %', type: 'number', required: true, default: 0 },
  { key: 'default_rate_per_ton', label: 'Default rate / ton', type: 'number', default: 0 },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'company_type', label: 'Type' },
  { key: 'gst_pct', label: 'GST %', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', align: 'right' },
  { key: 'default_rate_per_ton', label: 'Rate / ton', align: 'right' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Transporters(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Transporters" subtitle="Company type, GST and fixed TDS per transporter" hint="Transporters use a fixed TDS % (not slab-based). Freight is posted to the transporter ledger when a tanker reaches Empty, less any shortage penalty." />
      <div className="p-8">
        <EntityManager
          table="transporters"
          title="Transporter"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'transporters')}
        />
      </div>
    </>
  )
}
