import * as React from 'react'
import { DbStatus } from '@/components/DbStatus'
import { UpdateBadge } from '@/components/UpdateBadge'
import { InfoTip } from '@/components/ui/tooltip'

interface Props {
  title: string
  subtitle?: string
  hint?: string
  actions?: React.ReactNode
}

export function PageHeader({ title, subtitle, hint, actions }: Props): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-background/80 px-4 py-4 pr-20 backdrop-blur">
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {hint && <InfoTip text={hint} className="mt-0.5" />}
        </div>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <UpdateBadge />
        <DbStatus />
        {actions}
      </div>
    </div>
  )
}
