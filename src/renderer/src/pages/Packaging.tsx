import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// A packaging SKU: N units per case, each unit a given size (e.g. DALDA JAR
// 4.2 KG × 4). Stock is drawn in the base unit (KG or L); base_per_pouch and
// base_uom are derived from the natural unit size.
const fields: FieldDef[] = [
  { key: 'name', label: 'SKU name', type: 'text', required: true, placeholder: 'e.g. DALDA JAR 4.2 KG × 4' },
  {
    key: 'pouch_label',
    label: 'Pack type',
    type: 'select',
    default: 'Jar',
    options: [
      { value: 'Jar', label: 'Jar' },
      { value: 'Pouch', label: 'Pouch' },
      { value: 'Pch', label: 'Pch' },
      { value: 'Tin', label: 'Tin' },
      { value: 'Bottle', label: 'Bottle' },
      { value: 'Box', label: 'Box' }
    ]
  },
  { key: 'unit_size', label: 'Unit size', type: 'number', required: true, default: 0, placeholder: 'e.g. 4.2 / 420 / 200' },
  {
    key: 'unit_uom',
    label: 'Unit UOM',
    type: 'select',
    default: 'KG',
    options: [
      { value: 'KG', label: 'KG' },
      { value: 'GM', label: 'GM' },
      { value: 'L', label: 'L' },
      { value: 'ML', label: 'ML' }
    ]
  },
  { key: 'pouches_per_box', label: 'Units per case (×)', type: 'number', required: true, default: 1 },
  { key: 'box_label', label: 'Case label', type: 'text', default: 'Case' },
  // Derived for stock conversion — auto-filled from unit size/UOM, editable.
  { key: 'base_per_pouch', label: 'Base qty / unit (auto)', type: 'number', default: 0 },
  { key: 'base_uom', label: 'Base unit (auto)', type: 'text', default: 'KG' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'SKU' },
  { key: 'pouch_label', label: 'Type' },
  { key: 'unit_size', label: 'Unit size', align: 'right' },
  { key: 'unit_uom', label: 'UOM' },
  { key: 'pouches_per_box', label: 'Per case', align: 'right' },
  { key: 'base_uom', label: 'Base', align: 'right' },
  { key: 'active', label: 'Active', type: 'switch' }
]

// Convert the entered unit size to the base unit used for stock (KG or L).
function deriveBase(form: Row): Row {
  const u = String(form.unit_uom || 'KG').toUpperCase()
  const size = Number(form.unit_size) || 0
  const baseUom = u === 'ML' || u === 'L' ? 'L' : 'KG'
  const perPouch = u === 'GM' || u === 'ML' ? size / 1000 : size
  return { base_per_pouch: Math.round(perPouch * 1e6) / 1e6, base_uom: baseUom }
}

export function Packaging(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Packed SKU"
        subtitle="Packed-sale SKUs — N units per case, each a given size (base qty computed for stock)"
        hint="Add each SKU like ‘DALDA JAR 4.2 KG × 4’: pick the pack type, enter the unit size in its own unit (KG/GM/L/ML) and units per case. The base quantity drawn from stock is computed automatically (grams/millilitres convert to KG/L). Packed sales pick a SKU and enter cases + loose units."
      />
      <div className="p-5">
        <EntityManager
          table="packagings"
          title="Packed SKU"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'packaging')}
          onFieldChange={(key, _value, form) =>
            key === 'unit_size' || key === 'unit_uom' ? deriveBase(form) : undefined
          }
        />
      </div>
    </>
  )
}
