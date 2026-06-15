import * as React from 'react'

interface Props {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}

export function PageHeader({ title, subtitle, actions }: Props): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-background/80 px-8 py-5 backdrop-blur">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
