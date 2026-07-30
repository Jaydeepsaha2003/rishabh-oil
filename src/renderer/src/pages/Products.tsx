import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'CPO' },
  { key: 'code', label: 'Code', type: 'text' },
  {
    key: 'material_type',
    label: 'Category',
    // Creatable: the seed list below plus every category already in use, and the
    // user can type a new one and add it.
    type: 'creatable',
    default: 'OIL',
    options: [
      { value: 'OIL', label: 'OIL' },
      { value: 'HUSK', label: 'HUSK' },
      { value: 'FATTY', label: 'FATTY' },
      { value: 'SCRAP', label: 'SCRAP' },
      { value: 'SPENT EARTH', label: 'SPENT EARTH' },
      { value: 'PACKAGING', label: 'PACKAGING' },
      { value: 'CHEMICAL', label: 'CHEMICAL' },
      { value: 'MISC', label: 'MISC' }
    ]
  },
  {
    key: 'category',
    label: 'Sub-category',
    type: 'creatable',
    default: 'raw',
    options: [
      { value: 'raw', label: 'Raw' },
      { value: 'intermediate', label: 'Intermediate' },
      { value: 'finished', label: 'Finished' },
      { value: 'by-product', label: 'By-product' },
      { value: 'waste', label: 'Waste' }
    ]
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'code', label: 'Code' },
  { key: 'material_type', label: 'Category', type: 'select' },
  { key: 'category', label: 'Sub-category', type: 'select' },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Products(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Products" subtitle="Raw oils, intermediates and finished products" hint="The master catalog. Raw oils are bought via bargains; intermediates and finished goods are built from formulations and tracked in stock." />
      <div className="px-4 py-6">
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
