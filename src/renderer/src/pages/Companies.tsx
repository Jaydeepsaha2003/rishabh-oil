import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'

// The books are kept per company, so this list decides how many sets of books
// the mill runs. It also lives as a tab under Settings — same table, same
// component; this is just the sidebar door to it.
const fields: FieldDef[] = [
  { key: 'name', label: 'Company name', type: 'text', required: true },
  {
    key: 'company_type',
    label: 'Company type',
    type: 'select',
    default: 'manufacturing',
    options: [
      { value: 'manufacturing', label: 'Manufacturing' },
      { value: 'trading', label: 'Trading' }
    ]
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Company' },
  {
    key: 'company_type',
    label: 'Type',
    value: (r) => (String(r.company_type) === 'trading' ? 'Trading' : 'Manufacturing')
  },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Companies(): React.JSX.Element {
  // Admin-only, exactly as the Settings tab is — a non-admin reaching this
  // page by its URL sees the list read-only rather than a way in.
  const isAdmin = loadUser()?.role === 'admin'
  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="The sets of books this mill keeps"
        hint="Each company keeps its own bargains, purchases, sales, stock and account books. Switch the working company from the sidebar. Masters and Gate Entry are shared across all of them."
      />
      <div className="px-4 py-6">
        <EntityManager
          table="companies"
          title="Company"
          fields={fields}
          columns={columns}
          readOnly={!isAdmin}
        />
      </div>
    </>
  )
}
