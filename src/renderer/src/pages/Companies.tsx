import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The books are kept per company, so this list decides how many sets of books
// the mill runs. It also lives as a tab under Settings — same table, same
// component; this is just the sidebar door to it.
// Everything except the factory, which is looked up at render time — its
// options are rows in another table, not a fixed list.
const baseFields: FieldDef[] = [
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
  {
    key: 'colour',
    label: 'Name colour',
    type: 'color',
    placeholder: '#0B3D2E'
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'Company' },
  {
    key: 'company_type',
    label: 'Type',
    value: (r) => (String(r.company_type) === 'trading' ? 'Trading' : 'Manufacturing')
  },
  {
    key: 'colour',
    label: 'Colour',
    value: (r) => String(r.colour || '')
  },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Companies(): React.JSX.Element {
  // Admin-only, exactly as the Settings tab is — a non-admin reaching this
  // page by its URL sees the list read-only rather than a way in.
  const isAdmin = loadUser()?.role === 'admin'
  // Which plant this company's goods physically pass through. Stock and
  // production are read per factory, so two companies sharing a site share one
  // tank — which is the point: one buys, another manufactures, one stock.
  const [factories, setFactories] = useState<Row[]>([])
  useEffect(() => {
    void window.api.factory.list().then(setFactories).catch(() => setFactories([]))
  }, [])
  const columns = useMemo<ColumnDef[]>(
    () => [
      baseColumns[0],
      {
        key: 'factory_id',
        label: 'Factory',
        // Resolved here rather than joined in SQL: this page reads through the
        // generic table reader, which does SELECT * and knows nothing of joins.
        value: (r) =>
          String(factories.find((f) => Number(f.id) === Number(r.factory_id))?.name || '—')
      },
      ...baseColumns.slice(1)
    ],
    [factories]
  )
  const fields = useMemo<FieldDef[]>(
    () => [
      ...baseFields,
      {
        key: 'factory_id',
        label: 'Factory',
        type: 'select',
        options: factories.map((f) => ({ value: String(f.id), label: String(f.name) }))
      }
    ],
    [factories]
  )
  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="The sets of books this mill keeps"
        hint="Each company keeps its own bargains, purchases, sales and account books. STOCK and PRODUCTION are read per factory, not per company — companies sharing a factory share one physical stock. Switch the working company from the sidebar. Masters and Gate Entry are shared across all of them."
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
