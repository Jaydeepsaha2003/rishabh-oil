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
  // How this product is counted. MT for anything weighed — which is
  // everything the mill refines and packs — and PCS for an item that comes in
  // countable units, like a carton. A PCS product is not offered as a
  // production output: a recipe yields tonnes, and a carton is not made on the
  // refining line.
  {
    key: 'uom',
    label: 'Measuring unit',
    type: 'select',
    default: 'MT',
    options: [
      { value: 'MT', label: 'MT — weighed' },
      { value: 'PCS', label: 'PCS — counted' }
    ]
  },
  { key: 'active', label: 'Active', type: 'switch', default: true },
  // Separate from Active on purpose. Inactive takes a product out of the
  // dropdowns entirely, which is far too blunt for packaging you still buy
  // every week but never hold a tonnage of. This says only "do not carry a
  // stock balance for it", and it can be switched back at any time.
  { key: 'show_in_stock', label: 'Show in stock', type: 'switch', default: true },
  // The product-level twin of the Category master's "Used for". There, a
  // category is Purchase, Sales or Both; here there is only the Both case,
  // because that is the only one a product needs to say for itself.
  //
  // Which side a product may be picked on is decided by its SUB-CATEGORY, not
  // by its category: a purchase bargain offers Raw, a sale invoice offers
  // Finished. Correct for a mill, wrong for anything traded — RPS is filed
  // Finished because the mill refines it, and is also bought in, so it could
  // not go on a purchase bargain at all. On, and the product is offered under
  // Purchase and under Sales both, whatever its sub-category.
  //
  // Stock is untouched by it — that is still the sub-category's job, and the
  // Category master's.
  { key: 'use_both', label: 'Used for both', type: 'switch', default: false }
]

// Two products may share a name if they are different goods: RPL is a raw oil
// AND the finished oil refined from it, and the mill buys one and makes the
// other. Only a repeat of the same name in the same sub-category is a real
// duplicate — the rest are the list telling the truth about a name used twice
// on purpose, and flagging them invites someone to merge what the mill buys
// into what it makes.
const PRODUCT_DUPE_KEY = ['name', 'category']

// Funnels on the columns whose values REPEAT — the ones a catalogue of forty
// products is actually narrowed by: which category, which sub-category, what
// it is counted in, whether it is live, whether it carries a stock balance.
//
// Name, Code and Created are left plain on purpose. Each is near enough
// unique per row, so a funnel there would list the whole catalogue back and
// be a slower way of doing what the search box above already does in a few
// keystrokes.
const columns: ColumnDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'code', label: 'Code' },
  { key: 'material_type', label: 'Category', type: 'select', filterable: true },
  { key: 'category', label: 'Sub-category', type: 'select', filterable: true },
  { key: 'uom', label: 'Unit', type: 'select', filterable: true },
  { key: 'active', label: 'Active', type: 'switch', filterable: true },
  { key: 'show_in_stock', label: 'Show in stock', type: 'switch', toggle: true, filterable: true },
  // Flippable from the list like Show in stock, so turning it on for the three
  // or four products the mill actually trades does not mean opening each one.
  { key: 'use_both', label: 'Used for both', type: 'switch', toggle: true, filterable: true },
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
      <PageHeader title="Products" subtitle="Raw oils, intermediates and finished products" hint="The master catalog. Raw oils are bought via bargains; intermediates and finished goods are built from formulations and tracked in stock. The measuring unit says how a product is counted — MT for anything weighed, PCS for a countable item like a carton; only MT products can be a production output. Used for both offers a product on the purchase AND the sales side whatever its sub-category says — for something the mill trades rather than refines; it does not change where the product sits in stock." />
      <div className="px-4 py-6">
        <EntityManager
          table="products"
          title="Product"
          description="Everything you buy, make or sell."
          fields={fields}
          columns={columns}
          dupeKey={PRODUCT_DUPE_KEY}
          readOnly={!canWrite(loadUser(), 'products')}
        />
      </div>
    </>
  )
}
