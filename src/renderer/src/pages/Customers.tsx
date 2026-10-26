import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { GstRegsPanel } from '@/components/GstRegsPanel'
import { SubLedgersPanel } from '@/components/SubLedgersPanel'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'
import { COMPANY_TYPES, BUSINESS_TYPES } from '@/lib/constants'
import { useCompany } from '@/lib/companyContext'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A link to a party of the same Trading/Manufacturing type would be a branch
// ledger — refused; another GST No. goes under the party's More GST Nos.
function sideClash(all: Row[], key: string, next: Row): Row | undefined {
  if (key !== 'linked_party_id' && key !== 'business_type') return undefined
  const main = all.find((p) => String(p.id) === String(next.linked_party_id || ''))
  if (!main || String(main.business_type || '').toLowerCase() !== String(next.business_type || '').toLowerCase()) return undefined
  toast.error(`${main.name} is also ${main.business_type} — add this branch as a GST No. under ${main.name} → More GST Nos. instead`)
  return { linked_party_id: '' }
}

const baseFields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  // Filled in from the Categories master below — it is what lets the gate show
  // only the customers who deal in the goods at the barrier.
  { key: 'category', label: 'Category', type: 'creatable', options: [] },
  { key: 'company_type', label: 'Company type', type: 'select', options: COMPANY_TYPES },
  { key: 'business_type', label: 'Trading or Manufacturing', type: 'select', options: BUSINESS_TYPES, default: 'Manufacturing' },
  // Only meaningful for a Trading customer that is, in real life, the same
  // party (PAN) as one of the Manufacturing customers already on file — the
  // TDS slab is then tracked across both rows together instead of each
  // quietly restarting the slab at zero.
  {
    // LINKED PARTY: this is the other side — Trading or Manufacturing — of that
    // party. Its own ledger, GSTIN and GST rates; the main party's TDS, and the
    // TDS slab tracked across the whole family. Blank = a main party itself.
    // Another branch of the SAME side is not a ledger any more: it is a row
    // under the party's More GST Nos. (sideClash below refuses it).
    key: 'linked_party_id',
    label: 'Linked party — this is its other (Trading / Manufacturing) side',
    type: 'select',
    options: []
  },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'state', label: 'State', type: 'text' },
  { key: 'gst_pct', label: 'GST %', type: 'number', default: 0 },
  // Every rate that applies to this ledger — the first is the default, the rest
  // offered as quick picks on its entries; any rate can still be typed there.
  { key: 'gst_rates', label: 'GST rates that apply (e.g. 5, 18)', type: 'text' },
  // Withholding defaults, so a new party is set up the way every real one here
  // already is: 0.1% on turnover past a 50,00,000 slab for the financial year,
  // with the slab actually exempt. Left at 0/0/off, a party silently withheld
  // nothing until somebody remembered to fill all three in — and getting the
  // switch wrong is invisible until an invoice is a few thousand rupees out.
  // A sub-ledger's TDS is its main party's — locked here, copied on save.
  { key: 'tds_pct', label: 'TDS % (a sub-ledger takes its main party\'s)', type: 'number', default: 0.1, enabledWhen: (f) => !f.linked_party_id },
  { key: 'tds_threshold', label: 'TDS slab threshold (₹/FY)', type: 'number', default: 5000000, enabledWhen: (f) => !f.linked_party_id },
  { key: 'tds_above_only', label: 'No TDS below the slab', type: 'switch', default: true, enabledWhen: (f) => !f.linked_party_id },
  { key: 'adds_interest', label: 'Charges interest after credit period', type: 'switch', default: false },
  { key: 'interest_pct', label: 'Interest %', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'interest_days', label: 'Interest days', type: 'number', default: 0, enabledWhen: (f) => !!f.adds_interest },
  { key: 'credit_period_days', label: 'Credit period (days)', type: 'number', default: 0 },
  // Billed to this customer earlier in the year, before these books — where
  // the TDS slab they deduct picks up from. The open company's own figure.
  { key: 'opening_sale_amount', label: 'Sale bill amount (as on)', type: 'number', default: 0 },
  { key: 'opening_sale_date', label: 'As on date', type: 'date' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

// A funnel on every column, Excel-style, beside the search.
const baseColumns: ColumnDef[] = [
  { key: 'name', label: 'Name', filterable: true },
  { key: 'category', label: 'Category', type: 'select', filterable: true },
  { key: 'business_type', label: 'Trading/Mfg', type: 'select', filterable: true },
  { key: 'state', label: 'State', filterable: true },
  { key: 'gst_pct', label: 'GST %', align: 'right', filterable: true },
  { key: 'tds_pct', label: 'TDS %', align: 'right', filterable: true },
  { key: 'credit_period_days', label: 'Credit days', align: 'right', filterable: true },
  { key: 'active', label: 'Active', type: 'switch', filterable: true },
  { key: 'created_at', label: 'Created', type: 'date', filterable: true }
]

export function Customers(): React.JSX.Element {
  // A customer is a selling relationship.
  const { categories } = useCategories([], 'sales')
  // For linking a Trading customer to its real-world Manufacturing
  // counterpart, so the TDS slab is tracked across both rows together.
  const [allCustomers, setAllCustomers] = useState<Row[]>([])
  useEffect(() => {
    window.api.data.list('customers').then(setAllCustomers).catch(() => setAllCustomers([]))
  }, [])
  // Main parties only: a sub-ledger cannot have sub-ledgers of its own.
  const manufacturingOptions = allCustomers
    .filter((c) => !c.linked_party_id && c.active)
    .map((c) => ({ value: String(c.id), label: c.name }))
  // Sub-ledgers (same kind, a branch) and the trading counterpart (a Trading
  // party linked to a Manufacturing one) are told apart — lib/mainParty.ts.
  // ONE ROW PER PARTY: a party's linked ledgers — branch sub-ledgers and its
  // Trading/Manufacturing counterpart alike — are kept out of the list and
  // managed in its window; the row names every type the family deals in.
  const nameById = new Map(allCustomers.map((c) => [String(c.id), c.name]))
  const familyOf = new Map<string, Row[]>()
  for (const c of allCustomers) if (c.linked_party_id) familyOf.set(String(c.linked_party_id), [...(familyOf.get(String(c.linked_party_id)) || []), c])
  const hideRow = (r: Row): boolean => !!r.linked_party_id && nameById.has(String(r.linked_party_id))
  const searchText = (r: Row): string => (familyOf.get(String(r.id)) || []).map((x) => String(x.name || '')).join(' ')

  const { companies, companyId } = useCompany()
  const coName = String(companies.find((c) => Number(c.id) === Number(companyId))?.name || 'this company')
  const fields = baseFields.map((f) => {
    if (f.key === 'opening_sale_amount') return { ...f, label: `Sale bill amount (as on) — ${coName}` }
    if (f.key === 'opening_sale_date') return { ...f, label: `As on date — ${coName}` }
    if (f.key === 'category') return { ...f, options: categories.map((c) => ({ value: c, label: c })) }
    if (f.key === 'linked_party_id') return { ...f, options: manufacturingOptions }
    return f
  })
  const columns = baseColumns.map((c) =>
    c.key === 'business_type'
      ? {
          ...c,
          value: (row: Row) =>
            Array.from(new Set([row, ...(familyOf.get(String(row.id)) || [])].map((x) => String(x.business_type || '').trim()).filter(Boolean))).join(' · ')
        }
      : c
  )
  return (
    <>
      <PageHeader title="Customers" subtitle="GST, TDS, credit period and interest terms per customer" hint="Each customer's tax and credit terms auto-fill on sales. Credit period defaults to 0 days; interest applies only to days beyond it. Category tags what the customer trades in, which is how the gate narrows its party list. A Trading customer that is really the same party as one of your Manufacturing customers can be linked to it, so the TDS slab tracks both together instead of restarting at zero." />
      <div className="px-4 py-6">
        <EntityManager
          key={`customers-${companyId}`}
          table="customers"
          drawerWidth={860}
          extraKeys={['gst_regs']}
          renderDrawerExtra={({ editingId, form, reload, setField }) => (
            <>
              {/* One party, several GST Nos. — saved with the party. */}
              <GstRegsPanel value={form.gst_regs} onChange={(v) => setField('gst_regs', v)} readOnly={!canWrite(loadUser(), 'customers')} />
              {/* Its other (Trading / Manufacturing) side, a ledger of its own. */}
              {editingId != null && !form.linked_party_id ? (
                <SubLedgersPanel table="customers" mainId={editingId} mainForm={form} readOnly={!canWrite(loadUser(), 'customers')} onChanged={() => { reload(); void window.api.data.list('customers').then(setAllCustomers).catch(() => undefined) }} />
              ) : null}
            </>
          )}
          hideRow={hideRow}
          searchText={searchText}
          title="Customer"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'customers')}
          onFieldChange={(key, _value, next) => sideClash(allCustomers, key, next)}
        />
      </div>
    </>
  )
}
