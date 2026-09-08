import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'

// A factory is a physical site — the plant the oil actually passes through.
// Companies are attached to one from the Companies page, and stock and
// production are then read across every company at that site, because the
// tank does not know which company paid for what is standing in it.
//
// Kept separate from Companies on purpose: a company is a set of books and a
// factory is a place, and the whole point of this table is that the two are
// not the same thing.
const fields: FieldDef[] = [
  { key: 'name', label: 'Factory name', type: 'text', required: true, placeholder: 'Ghaziabad' },
  { key: 'location', label: 'Location', type: 'text', placeholder: 'City or address' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Factory' },
  { key: 'location', label: 'Location', value: (r) => String(r.location || '—') },
  { key: 'active', label: 'Active', type: 'switch' },
  { key: 'created_at', label: 'Created', type: 'date' }
]

export function Factories(): React.JSX.Element {
  // Admin-only to change, same as Companies — which site a company runs out of
  // moves its stock, so it is not a masters-list edit like a broker's name.
  const isAdmin = loadUser()?.role === 'admin'
  return (
    <>
      <PageHeader
        title="Factories"
        subtitle="The plants this mill runs"
        hint="Stock and production are read per factory, not per company: companies sharing a site share one physical stock. Assign a company to its factory from the Companies page. Purchases, sales, ledgers and valuation stay with the company that booked them."
      />
      <div className="px-4 py-6">
        <EntityManager
          table="factories"
          title="Factory"
          fields={fields}
          columns={columns}
          readOnly={!isAdmin}
        />
      </div>
    </>
  )
}
