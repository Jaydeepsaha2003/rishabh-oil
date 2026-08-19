import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { EntityManager, type ColumnDef, type FieldDef } from '@/components/EntityManager'
import { loadUser } from '@/lib/session'
import { canWrite } from '@/lib/modules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const baseFields: FieldDef[] = [
  { key: 'name', label: 'Bank name', type: 'text', required: true },
  // Options filled in below, from the companies master — a bank belongs to
  // whichever one is picked here, not necessarily whichever is active in the
  // sidebar right now.
  { key: 'company_id', label: 'Company', type: 'select', required: true, options: [] },
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
  const [companies, setCompanies] = useState<Row[]>([])

  useEffect(() => {
    window.api.data.list('companies').then(setCompanies).catch(() => {})
  }, [])

  const companyOptions = companies
    .filter((c) => c.active)
    .map((c) => ({ value: String(c.id), label: String(c.name) }))
  // Pre-selected to whichever company is active right now — still fully
  // changeable, so a bank can deliberately be added for a different one.
  const activeCompanyId = localStorage.getItem('companyId') || ''
  const fields = baseFields.map((f) =>
    f.key === 'company_id' ? { ...f, options: companyOptions, default: activeCompanyId } : f
  )

  return (
    <>
      <PageHeader
        title="Manage Banks"
        subtitle="Your own business banks — the accounts you transact, open LCs and make repayments from"
        hint="Each bank belongs to one company, picked when it's added — the list below only shows the company you're currently in, so a bank added for a different one won't appear here until you switch to it from the sidebar. An LC is opened at whichever of these banks is active on the Treasury page, and repayments go back out through it. Each bank carries its own sanctioned LC limit — set that on Treasury, where the limit and its utilisation are shown bank by bank. Renaming a bank here updates it everywhere, including on LCs already opened at it."
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
