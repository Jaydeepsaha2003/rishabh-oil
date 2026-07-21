import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

// A pack nests Box → Pouch → base unit. base per box = pouches_per_box × base_per_pouch.
const fields: FieldDef[] = [
  { key: 'name', label: 'Packaging name', type: 'text', required: true, placeholder: 'e.g. 12 × 1L Box' },
  { key: 'box_label', label: 'Box label', type: 'text', default: 'Box', placeholder: 'Box / Carton / Case' },
  { key: 'pouch_label', label: 'Pouch label', type: 'text', default: 'Pouch', placeholder: 'Pouch / Tin / Bottle' },
  { key: 'pouches_per_box', label: 'Pouches per box', type: 'number', required: true, default: 12 },
  { key: 'base_per_pouch', label: 'Base qty per pouch', type: 'number', required: true, default: 1 },
  { key: 'base_uom', label: 'Base unit', type: 'text', default: 'L', placeholder: 'L / KG' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Packaging' },
  { key: 'box_label', label: 'Box' },
  { key: 'pouch_label', label: 'Pouch' },
  { key: 'pouches_per_box', label: 'Pouches/box', align: 'right' },
  { key: 'base_per_pouch', label: 'Base/pouch', align: 'right' },
  { key: 'base_uom', label: 'Base unit' },
  { key: 'active', label: 'Active', type: 'switch' }
]

export function Packaging(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Packaging"
        subtitle="Pack definitions for packed sales — Box → Pouch → base unit"
        hint="Define each pack once (e.g. 1 Box = 12 Pouch, 1 Pouch = 1 L → 12 L per box). Packed sales pick a packaging and enter boxes/pouches; the base quantity drawn from stock is computed automatically."
      />
      <div className="p-8">
        <EntityManager
          table="packagings"
          title="Packaging"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'packaging')}
        />
      </div>
    </>
  )
}
