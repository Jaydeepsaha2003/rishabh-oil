import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

const fields: FieldDef[] = [
  { key: 'name', label: 'Bank name', type: 'text', required: true },
  { key: 'branch', label: 'Branch', type: 'text' },
  { key: 'account_no', label: 'Account no', type: 'text' },
  { key: 'ifsc', label: 'IFSC', type: 'text' },
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'active', label: 'Active', type: 'switch', default: true }
]

const columns: ColumnDef[] = [
  { key: 'name', label: 'Bank' },
  { key: 'branch', label: 'Branch' },
  { key: 'account_no', label: 'Account no' },
  { key: 'ifsc', label: 'IFSC' },
  { key: 'active', label: 'Active', type: 'switch' }
]

export function Banks(): React.JSX.Element {
  return (
    <>
      <PageHeader
        title="Manage Banks"
        subtitle="Your own business banks — the accounts you transact, open LCs and make repayments from"
        hint="An LC is opened at whichever of these banks is active on the Treasury page, and repayments go back out through it. Each bank carries its own sanctioned LC limit per company — set that on Treasury, where the limit and its utilisation are shown bank by bank. Renaming a bank here updates it everywhere, including on LCs already opened at it."
      />
      <div className="px-4 py-6">
        <EntityManager
          table="banks"
          title="Bank"
          fields={fields}
          columns={columns}
          readOnly={!canWrite(loadUser(), 'banks')}
        />
      </div>
    </>
  )
}
