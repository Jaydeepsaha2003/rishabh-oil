import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'

const baseFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'CPO' },
  { key: 'code', label: 'Code', type: 'text' },
  // Category is filled in below from the Categories master.
  { key: 'material_type', label: 'Category', type: 'creatable', default: 'OIL', options: [] },
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
  const { categories } = useCategories()
  // One list, maintained on the Categories page — typing a new one here still
  // works and simply adds it to this product.
  const fields = baseFields.map((f) =>
    f.key === 'material_type' ? { ...f, options: categories.map((c) => ({ value: c, label: c })) } : f
  )
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
