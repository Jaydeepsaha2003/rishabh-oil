import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'
import { useCategories } from '@/lib/useCategories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A friendlier label for the units every mill actually reaches for. Anything
// in the shared `uoms` master without an entry here still shows — just under
// its own name, the same as a UOM typed fresh on a bargain line.
const UOM_LABELS: Record<string, string> = {
  MT: 'MT — weighed',
  PCS: 'PCS — counted',
  KG: 'KG — kilograms',
  GM: 'GM — grams',
  QTL: 'QTL — quintal',
  LTR: 'LTR — litres',
  ML: 'ML — millilitres',
  NOS: 'NOS — numbers',
  BOX: 'BOX — boxes',
  BAG: 'BAG — bags',
  ROLL: 'ROLL — rolls',
  MTR: 'MTR — metres',
  SET: 'SET — sets',
  DOZEN: 'DOZEN — dozens',
  PACKET: 'PACKET — packets',
  DRUM: 'DRUM — drums',
  BALE: 'BALE — bales'
}

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
  // How this product is counted. MT for anything weighed on the tonnage
  // scale — which is everything the mill refines and packs — and PCS for an
  // item that comes in countable units, like a carton. A PCS product is not
  // offered as a production output: a recipe yields tonnes, and a carton is
  // not made on the refining line.
  //
  // Only MT and PCS carry that special handling elsewhere (stock totals,
  // production outputs). Every other unit below is a label only, for a
  // product — packaging film, spares, stationery — that is never carried on
  // the tonnage stock register or made on the line, so widening this list
  // does not touch that logic. Options are seeded from UOM_LABELS below and
  // topped up with the shared `uoms` master at render time (see Products()),
  // the same list Bargains/Sales/Gate Entry's own UOM picker reads — so a
  // unit typed in on a bargain line shows up here too, and vice versa.
  {
    key: 'uom',
    label: 'Measuring unit',
    type: 'searchable',
    default: 'MT',
    options: []
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
  // The same `uoms` master Bargains/Sales/Gate Entry's own UOM picker reads
  // (see UomSelect) — kept in step so a unit added on either side shows up on
  // the other, rather than this page carrying a second, separate list.
  const [uoms, setUoms] = useState<Row[]>([])
  useEffect(() => {
    window.api.data
      .list('uoms')
      .then((list: Row[]) => setUoms(list.filter((u) => u.active)))
      .catch(() => {})
  }, [])
  const uomOptions = (() => {
    const seen = new Map<string, string>()
    for (const [value, label] of Object.entries(UOM_LABELS)) seen.set(value, label)
    for (const u of uoms) {
      const v = String(u.name || '').trim().toUpperCase()
      if (v && !seen.has(v)) seen.set(v, v)
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }))
  })()
  // One list, maintained on the Categories page — typing a new one here still
  // works and simply adds it to this product.
  const fields = baseFields.map((f) => {
    if (f.key === 'material_type') return { ...f, options: categories.map((c) => ({ value: c, label: c })) }
    if (f.key === 'uom') return { ...f, options: uomOptions }
    return f
  })
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
