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

// The notification bell used to float over every page on `position: fixed`,
// which meant reserving a strip of padding in the header and hoping nothing
// grew into it. It now renders inside the header row like any other control;
// this carries the two things it needs from App without threading them
// through 26 pages.
export interface HeaderExtrasValue {
  bell?: React.ReactNode
}

const HeaderExtrasContext = createContext<HeaderExtrasValue>({})

export const HeaderExtrasProvider = HeaderExtrasContext.Provider

export function useHeaderExtras(): HeaderExtrasValue {
  return useContext(HeaderExtrasContext)
}
