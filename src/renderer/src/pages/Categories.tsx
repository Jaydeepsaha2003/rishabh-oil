import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Category', type: 'text', required: true, placeholder: 'OIL' },
  {
    key: 'applies_to',
    label: 'Used for',
    type: 'select',
    default: 'both',
    options: [
      { value: 'both', label: 'Purchase & Sales' },
      { value: 'purchase', label: 'Purchase only' },
      { value: 'sales', label: 'Sales only' }
    ]
  },
  { key: 'note', label: 'Note', type: 'text', placeholder: 'What belongs in this category' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Category' },
  { key: 'applies_to', label: 'Used for', type: 'select' },
  { key: 'note', label: 'Note' },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Categories(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="The material categories every screen draws on"
        hint="One list of what the mill deals in — OIL, HUSK, SCRAP and anything you add. Products are classified by it, gate entries pick their rec type from it, suppliers and customers are tagged with it, and the bargain registers filter by it. Mark each one Purchase, Sales or both, and it is offered only where it belongs — a buying category stays out of the sales screens. Add a category here and it appears everywhere; switch one off and it stops being offered without touching the records that already use it."
      />
      <div className="px-4 py-6">
        <EntityManager
          table="categories"
          title="Category"
          description="Add a category once and every screen picks it up."
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'products')}
        />
      </div>
    </>
  )
}
