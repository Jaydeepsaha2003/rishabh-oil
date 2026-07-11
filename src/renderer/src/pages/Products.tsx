import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'CPO' },
  { key: 'code', label: 'Code', type: 'text' },
  {
    key: 'category',
    label: 'Category',
    type: 'select',
    default: 'raw',
    options: [
      { value: 'raw', label: 'Raw oil' },
      { value: 'intermediate', label: 'Intermediate' },
      { value: 'finished', label: 'Finished product' }
    ]
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'code', label: 'Code' },
  { key: 'category', label: 'Category', type: 'select' },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Products(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Products" subtitle="Raw oils, intermediates and finished products" hint="The master catalog. Raw oils are bought via bargains; intermediates and finished goods are built from formulations and tracked in stock." />
      <div className="p-8">
        <EntityManager
          table="products"
          title="Product"
          description="Everything you buy, make or sell."
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'products')}
        />
      </div>
    </>
  )
}
