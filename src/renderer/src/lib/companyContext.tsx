import { createContext, useContext } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompanyRow = Record<string, any>

export interface CompanyContextValue {
  companies: CompanyRow[]
  companyId: number
  onCompanyChange: (id: string) => void
}

// Lets PageHeader (rendered separately by every single page) offer a company
// switcher without threading companies/companyId/onCompanyChange through
// every page's own props — App.tsx is the one place that actually holds
// this state; everything else just reads it.
const CompanyContext = createContext<CompanyContextValue>({
  companies: [],
  companyId: 0,
  onCompanyChange: () => {}
})

export const CompanyProvider = CompanyContext.Provider

export function useCompany(): CompanyContextValue {
  return useContext(CompanyContext)
}
