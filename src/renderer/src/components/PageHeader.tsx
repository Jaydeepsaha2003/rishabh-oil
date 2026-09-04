import * as React from 'react'
import { DbStatus } from '@/components/DbStatus'
import { UpdateBadge } from '@/components/UpdateBadge'
import { InfoTip } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCompany } from '@/lib/companyContext'

interface Props {
  title: string
  subtitle?: string
  hint?: string
  actions?: React.ReactNode
  // Sits to the LEFT of the title, before it — for a Back button on a form
  // page, where "back" belongs at the start of the line the eye reads first,
  // not filed among the actions on the right.
  leading?: React.ReactNode
}

// The active company, switchable from any page's header — not just the
// sidebar's own picker, which on mobile sits behind a tap to open the whole
// overlay. Reads from CompanyProvider (see App.tsx) instead of taking props,
// so every page that already renders <PageHeader> gets it for free.
function HeaderCompanySwitcher(): React.JSX.Element | null {
  const { companies, companyId, onCompanyChange } = useCompany()
  const active = companies.filter((c) => c.active)
  if (active.length <= 1) return null
  return (
    <Select value={String(companyId || '')} onValueChange={onCompanyChange}>
      <SelectTrigger className="h-8 w-auto min-w-[7rem] max-w-[10rem] gap-1.5 text-xs">
        <SelectValue placeholder="Company" />
      </SelectTrigger>
      <SelectContent>
        {active.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)}>{String(c.name)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PageHeader({ title, subtitle, hint, actions, leading }: Props): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-background/80 px-4 py-4 pr-20 backdrop-blur">
      {leading && <div className="flex shrink-0 items-center self-center">{leading}</div>}
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {hint && <InfoTip text={hint} className="mt-0.5" />}
        </div>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <UpdateBadge />
        <DbStatus dotOnly />
        <HeaderCompanySwitcher />
        {actions}
      </div>
    </div>
  )
}
