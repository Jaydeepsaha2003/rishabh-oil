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
  // Where this company stands in the list Accounting offers (Select Company):
  // 1 first, then 2… Blank puts it after the numbered ones, A–Z.
  { key: 'priority', label: 'Priority (1 = listed first)', type: 'number', placeholder: 'Blank = after the numbered ones' },
  // A COMPANY IS A PARTY TOO.
  //
  // When one of our companies sells to another it is invoiced like anybody
  // else, so it carries what any other party carries: a GSTIN and a state, a
  // rate of tax, and the TDS terms — including the SLAB, which is the part
  // that decides whether TDS is withheld at all. A rate with no threshold
  // beside it withholds from the first rupee, which is not how the law reads
  // or how the customer master is set up.
  //
  // Asked once here, and copied onto the customer and supplier rows that stand
  // for this company, so every slab, ledger and voucher downstream keeps
  // working on the party it already knows.
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  { key: 'tds_pct', label: 'TDS %', type: 'number', default: 0.1 },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 5000000 },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: true },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  // WHAT THE SLAB HAS ALREADY SEEN.
  //
  // TDS is withheld on turnover past a threshold for the FINANCIAL YEAR. A
  // company whose books start mid-year has already billed the other one before
  // this software saw any of it, and without that figure the slab restarts at
  // zero — nothing is withheld until the threshold is crossed a second time.
  // Same pair, same words, as the supplier master.
  { key: 'opening_purchase_amount', label: 'Purchase bill amount (as on)', type: 'number', default: 0 },
  { key: 'opening_purchase_date', label: 'As on date', type: 'date' },
  // A TRADING COMPANY'S TANKERS ARE SOLD ON AS THEY ARE EMPTIED: marking one
  // Empty asks for the buying company and its purchase invoice number and
  // raises the inter-company sale. Off, the tanker empties like any other and
  // the sale is made by hand from Sales.
  {
    key: 'onward_sale_at_empty',
    label: 'Sell tankers on at Empty (inter-company sale)',
    type: 'switch',
    default: true,
    enabledWhen: (f) => String(f.company_type || '') === 'trading'
  },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'Company' },
  {
    key: 'priority',
    label: 'Priority',
    align: 'right',
    value: (r) => (Number(r.priority) > 0 ? String(r.priority) : '—')
  },
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
  { key: 'gst_pct', label: 'GST %', type: 'number', align: 'right' },
  { key: 'tds_pct', label: 'TDS %', type: 'number', align: 'right' },
  { key: 'tds_threshold', label: 'TDS slab', type: 'number', align: 'right' },
  // A real switch, flipped from the list — only on a Trading company, the one
  // kind it acts on.
  {
    key: 'onward_sale_at_empty',
    label: 'Sold on at Empty',
    type: 'switch',
    onOff: true,
    toggle: true,
    showWhen: (r) => String(r.company_type) === 'trading',
    value: (r) => (Number(r.onward_sale_at_empty ?? 1) === 0 ? '' : '1')
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
